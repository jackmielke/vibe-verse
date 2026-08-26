/**
 * Peers.tsx — everybody else, in the world.
 *
 * One component owns the whole of multiplayer from the level's point of view:
 *
 *   <Peers mode="online" room="sf" name={displayName} charId={charId} />
 *
 * It opens the transport, states our position nine times a second, folds
 * everybody else's into a `PeerTable`, and reconciles a pool of character rigs
 * against the result every frame.
 *
 * Remote players load through `@/lib/characterRig`, the same door the local
 * `Avatar` and the lobby use, which is the entire reason a stranger can turn
 * up as any of the cast — including the half of it that has no `.glb` and is
 * assembled in code on a synchronous path a naïve `loader.load` never touches.
 * See the note at the top of `characterRig.ts`; /city learned that one the
 * hard way.
 *
 * Two budgets, both deliberate:
 *
 *  • **Rigs are capped and distance-sorted.** A skinned mesh per person is the
 *    expensive part, and forty-eight of them in a city that is already
 *    streaming would be the thing that finally tips a laptop over. The nearest
 *    `MAX_RIGS` get bodies; anybody further away is still tracked, still in the
 *    roster, and simply not drawn yet — they get a body as you walk toward
 *    them.
 *
 *  • **Rig loads are not cancelled on the frame a peer moves out of range.**
 *    Somebody walking back and forth across the cap boundary would otherwise
 *    thrash the loader. A body, once built, is kept until its peer is gone.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { loadCharacterRig, type CharacterRig } from "@/lib/characterRig";
import { findCharacter } from "@/lib/characters";
import { PLAYER } from "../config";
import { frame } from "../state/store";
import { clamp01, damp } from "../math/rng";
import { PeerTable, type PeerPose } from "./peers";
import {
  CAR_ORIGIN_Y,
  MOTION_IDLE,
  MOTION_RUN,
  MOTION_WALK,
  SEND_INTERVAL_MS,
  cm,
  type Motion,
  type NetTransport,
  type StateMsg,
} from "./protocol";
import { openTransport, type NetMode } from "./transport";
import { makeNameTag } from "./nameTag";
import { propGeometry } from "../world/street/streetFurniture";
import { getMaterial } from "../materials";
import { getShotHook } from "../debug/shotHook";

export interface PeersProps {
  mode: NetMode;
  /** Everybody in the same room sees each other. */
  room?: string;
  /** Our display name, from `useVibeIdentity`. */
  name: string;
  /** Our character id. */
  charId: string;
  /** Called when the peer list changes, for the roster chip. */
  onRoster?: (names: string[]) => void;
}

/** How many remote players get a real body at once. */
const MAX_RIGS = 12;
/** Name tags stop being legible long before this and start being clutter. */
const TAG_RANGE = 70;

/** One drawn peer. */
interface Body {
  group: THREE.Group;
  rig: CharacterRig | null;
  /** Shown instead of the body while this peer is driving. */
  car: THREE.Mesh | null;
  tag: THREE.Sprite | null;
  tagName: string;
  /** Smoothed gait, so a peer crossing a packet boundary does not twitch. */
  locomotion: number;
  disposed: boolean;
}

/**
 * The car a remote driver is seen in.
 *
 * The kerbside prop mesh, not the driveable fleet's renderer: this needs one
 * shared geometry and one shared material for anybody who happens to be
 * driving, and the hero rig is a per-vehicle allocation with damage state,
 * wheels and a physics body behind it that a *remote* car has no use for.
 * Everybody driving looks like a saloon. That is a trade, and it is invisible
 * next to the alternative, which is a person in a seated pose skating down
 * Market at fifty kilometres an hour.
 *
 * Built lazily and shared: `propGeometry` caches, and `getMaterial` caches.
 */
let carGeo: THREE.BufferGeometry | null = null;
function peerCarMesh(): THREE.Mesh {
  if (!carGeo) carGeo = propGeometry("car-sedan");
  const mat = getMaterial("car-paint", { vertexColors: true, name: "sf/peer-car" });
  const mesh = new THREE.Mesh(carGeo, mat);
  mesh.name = "sf-peer-car";
  // The prop is modelled nose along +X; a peer's yaw uses the player
  // convention, which faces −Z. One quarter turn reconciles them.
  mesh.rotation.y = -Math.PI / 2;
  return mesh;
}

/** Our own id for this tab. Stable across re-renders, unique across tabs. */
function makeId(): string {
  const rand = Math.floor(Math.random() * 0x7fffffff).toString(36);
  return `${Date.now().toString(36)}-${rand}`;
}

export default function Peers({ mode, room = "sf", name, charId, onRoster }: PeersProps) {
  const root = useRef<THREE.Group>(null);
  const table = useMemo(() => new PeerTable(), []);
  const selfId = useMemo(makeId, []);
  const bodies = useMemo(() => new Map<string, Body>(), []);
  const net = useRef<NetTransport | null>(null);

  // Live copies of the identity, read inside the frame loop. Kept in refs so a
  // name change does not tear the socket down and rejoin.
  const ident = useRef({ name, charId });
  ident.current.name = name;
  ident.current.charId = charId;

  const clock = useRef({ sendAt: 0, pruneAt: 0, rosterAt: 0 });

  /* ---------------- the socket ---------------- */
  useEffect(() => {
    table.selfId = selfId;
    let live = true;
    let handle: NetTransport | null = null;

    void openTransport(mode, room).then((t) => {
      if (!live) {
        t?.close();
        return;
      }
      if (!t) return; // Stayed single player. Not an error.
      handle = t;
      net.current = t;
      t.receive((msg) => table.ingest(msg, performance.now()));
    });

    // Closing a tab does not run React cleanup. Without this, every departure
    // is a six-second statue on everybody else's street — which is the most
    // common way anyone leaves, since almost nobody navigates out of a game
    // deliberately. `pagehide` rather than `beforeunload`: it is the one that
    // fires reliably on mobile Safari, and it also covers the back/forward
    // cache, where the tab is frozen and equally unable to keep talking.
    const bye = () => {
      try {
        handle?.send({ t: "q", i: selfId });
      } catch {
        /* going away regardless */
      }
    };
    window.addEventListener("pagehide", bye);

    return () => {
      live = false;
      window.removeEventListener("pagehide", bye);
      // Say goodbye before dropping the socket, so nobody stands looking at a
      // statue of us for the length of the timeout.
      if (handle) {
        bye();
        handle.close();
      }
      net.current = null;
      table.clear();
      for (const [, b] of bodies) disposeBody(b);
      bodies.clear();
      onRoster?.([]);
    };
    // `name`/`charId` deliberately absent: they travel in every packet and
    // must not cause a rejoin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, room, selfId, table, bodies]);

  /* ---------------- debug surface ---------------- *
   * "Is anybody else here" is not answerable from a screenshot: an empty
   * street and a street full of people whose rigs failed to load look the
   * same. `sf-two.mjs` drives two pages against these. */
  useEffect(() => {
    const hook = getShotHook();
    hook.peerBodies = () => bodies.size;
    hook.peerPositions = () => {
      const out: [number, number, number][] = [];
      for (const [, b] of bodies) {
        out.push([b.group.position.x, b.group.position.y, b.group.position.z]);
      }
      return out;
    };
    hook.peerInfo = () =>
      [...bodies].map(([, b]) => ({
        name: b.tagName,
        x: b.group.position.x,
        y: b.group.position.y,
        z: b.group.position.z,
        driving: !!b.car?.visible && !(b.rig?.object.visible ?? false),
        rig: !!b.rig,
      }));
    return () => {
      delete hook.peerBodies;
      delete hook.peerPositions;
      delete hook.peerInfo;
    };
  }, [bodies]);

  /* ---------------- the frame ---------------- */
  useFrame(() => {
    const g = root.current;
    if (!g) return;
    const now = performance.now();

    /* ---- say where we are ---- */
    const t = net.current;
    if (t && now >= clock.current.sendAt) {
      clock.current.sendAt = now + SEND_INTERVAL_MS;
      t.send(localState(selfId, ident.current.name, ident.current.charId));
    }

    /* ---- forget the departed ---- */
    if (now >= clock.current.pruneAt) {
      clock.current.pruneAt = now + 1000;
      for (const id of table.prune(now)) {
        const b = bodies.get(id);
        if (b) {
          disposeBody(b);
          bodies.delete(id);
        }
      }
    }

    /* ---- draw everybody else ---- */
    // Collected first so the rig budget can be spent on the nearest people
    // rather than on whoever happened to be iterated first.
    const seen = _seen;
    seen.length = 0;
    table.forEach(now, (p) => {
      const dx = p.x - frame.position.x;
      const dz = p.z - frame.position.z;
      seen.push({ ...p, d2: dx * dx + dz * dz });
    });
    seen.sort((a, b) => a.d2 - b.d2);

    for (let i = 0; i < seen.length; i++) {
      const p = seen[i];
      let body = bodies.get(p.id);
      if (!body) {
        // Past the budget and not yet built: leave them for when they are
        // closer. They are still tracked and still in the roster.
        if (i >= MAX_RIGS) continue;
        body = makeBody(g, p, bodies);
      }
      placeBody(body, p, Math.sqrt(p.d2));
    }

    /* ---- the roster ---- */
    if (onRoster && now >= clock.current.rosterAt) {
      clock.current.rosterAt = now + 1500;
      onRoster(table.names());
    }
  });

  return <group ref={root} name="sf-peers" />;
}

/* ------------------------------------------------------------------ *
 * Local state
 * ------------------------------------------------------------------ */

const _seen: (PeerPose & { d2: number })[] = [];

/** What we look like from outside, right now. */
function localState(id: string, name: string, char: string): StateMsg {
  const speed = Math.hypot(frame.velocity.x, frame.velocity.z);
  let motion: Motion = MOTION_IDLE;
  if (speed > PLAYER.walkSpeed * 1.15) motion = MOTION_RUN;
  else if (speed > 0.35) motion = MOTION_WALK;

  // `frame.position` is the capsule centre on foot and the *vehicle chassis*
  // while driving — the driving system copies the car into it so the rest of
  // the game can read one place. The wire wants neither: it wants the ground,
  // so the receiver can drop one group and have a rig and a car both sit in it
  // correctly. Correct here, where we know which we are.
  const driving = frame.vehicleId !== null;
  const groundY = frame.position.y - (driving ? CAR_ORIGIN_Y : PLAYER.height * 0.5);

  const msg: StateMsg = {
    t: "s",
    i: id,
    n: name,
    c: char,
    p: [cm(frame.position.x), cm(groundY), cm(frame.position.z)],
    a: Math.round(frame.yaw * 1000) / 1000,
    m: motion,
  };
  if (driving) msg.v = "car";
  return msg;
}

/* ------------------------------------------------------------------ *
 * Bodies
 * ------------------------------------------------------------------ */

function makeBody(
  parent: THREE.Group,
  p: PeerPose,
  bodies: Map<string, Body>,
): Body {
  const group = new THREE.Group();
  group.name = `sf-peer-${p.id}`;
  parent.add(group);

  const body: Body = {
    group,
    rig: null,
    car: null,
    tag: null,
    tagName: "",
    locomotion: 0,
    disposed: false,
  };
  bodies.set(p.id, body);

  const spec = findCharacter(p.char);
  void loadCharacterRig(
    { url: spec.url, id: spec.id },
    { height: PLAYER.height, center: false, castShadow: false, walkSpeed: PLAYER.walkSpeed },
  )
    .then((rig) => {
      // The peer may have left, or the whole component unmounted, while this
      // was in flight.
      if (body.disposed) {
        rig.dispose();
        return;
      }
      body.rig = rig;
      group.add(rig.object);
    })
    .catch(() => {
      /* A character that will not load leaves an invisible person rather than
         taking the city down. They are still there; you just cannot see them. */
    });

  return body;
}

function placeBody(body: Body, p: PeerPose, distance: number): void {
  body.group.position.set(p.x, p.y, p.z);
  body.group.rotation.y = p.yaw;

  /* ---- driving, or on foot ---- */
  const driving = p.vehicle !== null;
  if (driving && !body.car) {
    body.car = peerCarMesh();
    body.group.add(body.car);
  }
  if (body.car) body.car.visible = driving;
  if (body.rig) body.rig.object.visible = !driving;

  if (body.rig && !driving) {
    const want =
      p.motion === MOTION_RUN ? 1.25 : p.motion === MOTION_WALK ? 0.85 : 0;
    // A fixed blend rate rather than a dt-scaled one: this runs off whatever
    // frame rate the viewer has, and the gait only has to look unstartled.
    body.locomotion = damp(body.locomotion, want, 9, 1 / 60);
    body.rig.setLocomotion(clamp01(body.locomotion));
    body.rig.update(1 / 60);
  }

  /* ---- name ---- */
  const wantTag = distance < TAG_RANGE;
  if (wantTag && (!body.tag || body.tagName !== p.name)) {
    if (body.tag) {
      body.group.remove(body.tag);
      disposeTag(body.tag);
    }
    body.tag = makeNameTag(p.name);
    body.tagName = p.name;
    body.tag.position.y = PLAYER.height + 0.34;
    body.group.add(body.tag);
  }
  if (body.tag) {
    body.tag.visible = wantTag;
    // A name sits above a head or above a roof, and those are not the same
    // height. Without this, a driver's name hangs inside their own car.
    body.tag.position.y = driving ? 1.9 : PLAYER.height + 0.34;
    // Tags belong to the viewer, not to the world, so they do not turn with
    // the body they are labelling.
    body.tag.rotation.y = -p.yaw;
  }
}

function disposeBody(b: Body): void {
  b.disposed = true;
  if (b.rig) {
    b.group.remove(b.rig.object);
    b.rig.dispose();
    b.rig = null;
  }
  if (b.car) {
    b.group.remove(b.car);
    // Geometry and material are both shared caches; disposing either here
    // would take the car out from under every other peer who is driving.
    b.car = null;
  }
  if (b.tag) {
    b.group.remove(b.tag);
    disposeTag(b.tag);
    b.tag = null;
  }
  b.group.removeFromParent();
}

function disposeTag(tag: THREE.Sprite): void {
  const mat = tag.material as THREE.SpriteMaterial;
  mat.map?.dispose();
  mat.dispose();
}
