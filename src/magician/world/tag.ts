/**
 * Oni in the valley: infection tag round the village.
 *
 * The rules and the round-keeping are Oni's own (`src/oni/rules.ts`,
 * `src/oni/match.ts`), carried over the valley's channel as `g` messages, so
 * there is one room and one set of players whether you are casting spells or
 * running. Tag here is something you ask for (the HUD's button, or asking
 * Vibey): rounds are never announced on their own, because most of the time
 * people are here to wander.
 *
 * During a round the game is played inside a ring of light round the
 * village square, so a minute of tag does not become a minute of looking
 * for each other in two hundred metres of paddy.
 */
import * as THREE from "three";
import { createMatch, type Match } from "@/oni/match";
import type { OniRoom, OniWire, Peer } from "@/oni/net";
import { ROUND_MS, TAG_GRACE_MS, TAG_RADIUS, TAG_RADIUS_ONI, hash, type Phase, type Round } from "@/oni/rules";
import type { Hud, HudPlayer } from "@/oni/world/Oni";
import { createSfx } from "@/oni/world/sfx";
import type { PeerPresence, PresenceExtra, Room } from "../net";
import type { Peers } from "./peers";

/** The ring: round the village square, taking in the bridge. */
export const TAG_CENTRE = { x: 6, z: 0 };
export const TAG_RADIUS_M = 27;

export interface ValleyTag {
  handle(msg: OniWire): void;
  update(dt: number, time: number): void;
  isOni(id: string): boolean;
  phase(): Phase;
  /** An oni waits out the countdown. */
  frozen(): boolean;
  /** Everybody runs a little faster in a round, the oni a little faster still. */
  speed(): number;
  /** Keep a position inside the ring while a round is on. */
  clamp(p: THREE.Vector3): void;
  /** Start a round now. False if there is nobody to play with. */
  start(): boolean;
  presence(): PresenceExtra;
  hud(): Hud | null;
  dispose(): void;
}

export interface ValleyTagOptions {
  scene: THREE.Scene;
  myId: string;
  name(): string;
  char(): string;
  room(): Room | null;
  peerList(): PeerPresence[];
  peers: Peers;
  me(): THREE.Vector3;
  teleport(x: number, z: number, yaw: number): void;
  groundAt(x: number, z: number): number;
  onFeed(text: string): void;
  /** The round changed phase, for the voice to hear about. */
  onNotify?(text: string): void;
}

export function createValleyTag(o: ValleyTagOptions): ValleyTag {
  const sfx = createSfx();
  const resume = () => sfx.resume();
  window.addEventListener("pointerdown", resume);
  window.addEventListener("keydown", resume);

  const names = new Map<string, string>();
  const nameOf = (id: string) => (id === o.myId ? "you" : names.get(id) ?? "someone");
  const NameOf = (id: string) => { const n = nameOf(id); return n === "you" ? "You" : n; };

  const peerList = (): Peer[] => o.peerList().map((p) => {
    names.set(p.id, p.name);
    return { id: p.id, name: p.name, char: p.char ?? "", x: p.x, y: p.y, z: p.z, yaw: p.yaw, vx: 0, vz: 0, oni: !!p.oni, round: p.round ?? "", at: p.at };
  });
  const oniRoom: OniRoom = {
    get id() { return o.myId; },
    get connected() { return !!o.room()?.connected; },
    send: (m) => o.room()?.game(m),
    setPresence: () => {},
    flush: () => {},
    peers: peerList,
    close: () => {},
  };

  let lastCount = -1;
  let lastPhase: Phase = "lobby";
  const lastClaim = new Map<string, number>();
  const match: Match = createMatch({
    me: o.myId,
    room: () => oniRoom,
    peers: peerList,
    auto: false,
    events: {
      onRound(r: Round) {
        lastClaim.clear();
        lastCount = -1;
        // Oni by the middle, runners out toward the ring.
        const h = hash(o.myId + r.id);
        const oni = r.first.includes(o.myId);
        const a = ((h % 3600) / 3600) * Math.PI * 2;
        const rad = oni ? 3 : 12 + ((h >>> 12) % 60) / 10;
        const x = TAG_CENTRE.x + Math.cos(a) * rad, z = TAG_CENTRE.z + Math.sin(a) * rad;
        o.teleport(x, z, Math.atan2(x - TAG_CENTRE.x, z - TAG_CENTRE.z) + (oni ? Math.PI : 0));
        o.onFeed(`Zombie tag! ${r.first.map(NameOf).join(" and ")} ${r.first.length > 1 ? "are" : "is"} the zombie 🧟`);
      },
      onTag(t) {
        const close = t.victim === o.myId || t.by === o.myId;
        sfx.tag(close);
        if (t.victim === o.myId) { try { navigator.vibrate?.([80, 40, 160]); } catch { /* none */ } }
        const by = t.by && t.by !== "?" ? NameOf(t.by) : null;
        o.onFeed(by ? `${by} bit ${nameOf(t.victim)} 🧟` : `${NameOf(t.victim)} turned zombie 🧟`);
      },
      onEmote(id, e) { o.peers.emote(id, e); sfx.honk(); },
      onOver(_r, res) {
        sfx.drum(false);
        sfx.fanfare();
        const line = res.lastStanding ? `${NameOf(res.lastStanding.id)} ${res.lastStanding.id === o.myId ? "were" : "was"} the last one standing!`
          : res.survivors.length ? `Time! ${res.survivors.map(NameOf).join(", ")} survived` : "Round over";
        o.onFeed(line);
        o.onNotify?.(`A game of zombie tag in the village just ended: ${line}. Congratulate them in one short line.`);
      },
    },
  });

  // Newcomers ask whether a round is on.
  let helloed = false;

  // ---- the ring of light ---------------------------------------------------
  const ringTex = (() => {
    const c = document.createElement("canvas");
    c.width = 4; c.height = 128;
    const g = c.getContext("2d")!;
    const gr = g.createLinearGradient(0, 0, 0, 128);
    gr.addColorStop(0, "rgba(255,255,255,0)");
    gr.addColorStop(0.55, "rgba(255,255,255,0.35)");
    gr.addColorStop(0.8, "rgba(255,255,255,0.9)");
    gr.addColorStop(1, "rgba(255,255,255,0.2)");
    g.fillStyle = gr; g.fillRect(0, 0, 4, 128);
    const t = new THREE.CanvasTexture(c);
    return t;
  })();
  const ringMat = new THREE.MeshBasicMaterial({ map: ringTex, color: "#5cff4a", transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
  const ringGeo = new THREE.CylinderGeometry(TAG_RADIUS_M, TAG_RADIUS_M, 14, 128, 1, true);
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.set(TAG_CENTRE.x, o.groundAt(TAG_CENTRE.x, TAG_CENTRE.z) - 3, TAG_CENTRE.z);
  ring.visible = false;
  ring.renderOrder = 5;
  o.scene.add(ring);

  let lastHud: Hud | null = null;
  let hudAt = 0;

  function checkTags(now: number) {
    const tags = match.tags();
    const me = o.me();
    const meOni = match.isOni(o.myId);
    const inGrace = (id: string) => { const t = tags.get(id); return !!t && now - t.at < TAG_GRACE_MS; };
    for (const p of o.peers.positions()) {
      const pOni = match.isOni(p.id);
      if (pOni === meOni) continue;
      if (Math.abs(p.y - me.y) > 1.4) continue;
      const d = Math.hypot(p.x - me.x, p.z - me.z);
      const oniId = meOni ? o.myId : p.id, runner = meOni ? p.id : o.myId;
      if (inGrace(oniId)) continue;
      if (d > (meOni ? TAG_RADIUS_ONI : TAG_RADIUS)) continue;
      if (now - (lastClaim.get(runner) ?? 0) < 400) continue;
      lastClaim.set(runner, now);
      match.claim(runner, oniId);
    }
  }

  return {
    handle(msg) { match.handle(msg); },
    update(dt, time) {
      const now = Date.now();
      const room = o.room();
      if (room?.connected && !helloed) { helloed = true; room.game({ t: "hi", id: o.myId }); }
      // A lost tag heals from presence: somebody saying they have horns has them.
      const round = match.round();
      if (round) for (const p of o.peerList()) if (p.oni && p.round === round.id && !match.isOni(p.id)) match.handle({ t: "p", id: p.id, n: p.name, c: p.char ?? "", x: p.x, y: p.y, z: p.z, yaw: p.yaw, vx: 0, vz: 0, o: 1, r: round.id });
      match.update(now);
      const phase = match.phase(now);
      const meOni = match.isOni(o.myId);
      if (round && phase === "countdown") {
        const n = Math.ceil((round.start - now) / 1000);
        if (n !== lastCount && n <= 3) { lastCount = n; sfx.count(n); }
      }
      if (phase === "play" && lastPhase === "countdown") { sfx.gong(); o.onFeed(meOni ? "Go! You're the zombie: get them!" : "Go! Run!"); }
      if (phase === "play" && round) {
        const left = (round.end - now) / 1000;
        sfx.drum(true, left < 20 ? 1 - left / 20 : 0);
        checkTags(now);
      } else sfx.drum(false);
      lastPhase = phase;
      const on = phase === "countdown" || phase === "play";
      ring.visible = on || ringMat.opacity > 0.01;
      ringMat.opacity += ((on ? 0.55 + Math.sin(time * 3) * 0.1 : 0) - ringMat.opacity) * Math.min(1, dt * 3);
      ringTex.offset.y = (time * 0.2) % 1;
      if (now - hudAt > 180) { hudAt = now; lastHud = buildHud(now, phase, round); }
    },
    isOni: (id) => match.isOni(id),
    phase: () => match.phase(),
    frozen: () => match.phase() === "countdown" && match.isOni(o.myId),
    speed() {
      const p = match.phase();
      if (p !== "countdown" && p !== "play") return 1;
      return match.isOni(o.myId) && p === "play" ? 1.6 : 1.45;
    },
    clamp(p) {
      const ph = match.phase();
      if (ph !== "countdown" && ph !== "play") return;
      const dx = p.x - TAG_CENTRE.x, dz = p.z - TAG_CENTRE.z;
      const d = Math.hypot(dx, dz);
      const max = TAG_RADIUS_M - 0.5;
      if (d > max) { p.x = TAG_CENTRE.x + (dx / d) * max; p.z = TAG_CENTRE.z + (dz / d) * max; }
    },
    start() {
      if (match.players().length < 2) return false;
      sfx.resume();
      match.announce();
      return true;
    },
    presence() {
      const r = match.round();
      return { c: o.char(), o: match.isOni(o.myId) ? 1 : 0, r: r?.id ?? "" };
    },
    hud: () => lastHud,
    dispose() {
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
      sfx.dispose();
      o.scene.remove(ring);
      ringGeo.dispose(); ringMat.dispose(); ringTex.dispose();
    },
  };

  function buildHud(now: number, phase: Phase, round: Round | null): Hud | null {
    // Nothing on screen unless a round is on or has just finished.
    const ended = match.endedAt();
    if (!round || (phase === "over" && ended !== null && now - ended > 15_000)) return null;
    const players: HudPlayer[] = [{ id: o.myId, name: o.name(), char: o.char(), oni: match.isOni(o.myId), me: true, bot: false }];
    for (const p of o.peerList()) players.push({ id: p.id, name: p.name, char: p.char ?? "", oni: match.isOni(p.id), me: false, bot: false });
    const res = match.result();
    return {
      phase,
      connected: !!o.room()?.connected,
      left: Math.max(0, (Math.min(round.end, round.start + ROUND_MS) - now) / 1000),
      countdown: Math.max(0, (round.start - now) / 1000),
      nextIn: null,
      me: { id: o.myId, oni: match.isOni(o.myId) },
      players,
      runners: players.filter((p) => !p.oni).length,
      onis: players.filter((p) => p.oni).length,
      result: res && phase === "over" ? {
        lastStanding: res.lastStanding ? NameOf(res.lastStanding.id) : null,
        survived: res.lastStanding ? res.lastStanding.survived / 1000 : 0,
        survivors: res.survivors.map(NameOf),
        topOni: res.topOni ? NameOf(res.topOni.id) : null,
        topCount: res.topOni?.count ?? 0,
      } : null,
      inVR: false,
    };
  }
}
