/**
 * mayhem — GTA Junior: guns, fire, buildings that go up, and the police.
 *
 * Vibe City already had the bones of a crime game: cars you can steal, bots
 * that crash, things that explode, a getaway kart. What it did not have was a
 * consequence. You could plough a monster truck down Main Street all
 * afternoon and nobody minded. This module is the part that minds.
 *
 * ## Heat
 *
 * One number, 0 to 5, shown as stars. Crashing into things, blowing things up
 * and shooting all add to it; the police forgive you 63 seconds after the last thing you did. At one star a
 * police car comes looking for you, and each star past that adds another, up
 * to five. Police do not arrest, they ram: a cruiser drives straight at
 * whatever you are standing in and keeps doing it. Police also go after the
 * getaway kart on their own whenever the heist is running, heat or no heat,
 * and if they reach it first the loot is theirs.
 *
 * ## Fire
 *
 * Trees burn. Any explosion within reach sets the trees around it alight, a
 * rifle round can too, and a burning tree spreads to its neighbours before it
 * falls over. Buildings do not burn down, but hit one hard enough and the
 * facade goes up in a fireball and keeps burning for a while. About a third
 * of the buildings (`volatile`) go up at a much lower speed than the rest,
 * so finding which ones is part of the game.
 *
 * ## Guns
 *
 * A rifle, hidden on a rooftop, and a Glock 19, lying on the plaza. Pick one
 * up by walking over it; R fires, G switches. Aim is assisted: the shot goes
 * to the best target inside a cone in front of you, because aiming a mouse at
 * a moving car while the camera follows your back is no fun at all. Both work
 * from behind the wheel too.
 *
 * Everything here is pure position maths plus instanced-free little meshes;
 * the city passes in the collision query and the callbacks, so this file
 * never needs to know about karts, avatars or React.
 */
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";
import type { CrashFx } from "@/city/crashFx";
import type { Smashables } from "@/city/smash";
import { buildCityCar, type Traffic } from "@/city/traffic";

export type GunKind = "rifle" | "glock";

export interface GunSpec {
  label: string;
  emoji: string;
  /** Seconds between shots while the trigger is held. */
  interval: number;
  damage: number;
  range: number;
  /** Chance a round that hits a tree sets it alight. */
  ignite: number;
}

export const GUNS: Record<GunKind, GunSpec> = {
  rifle: { label: "Rifle", emoji: "🎯", interval: 0.11, damage: 24, range: 95, ignite: 0.3 },
  glock: { label: "Glock 19", emoji: "🔫", interval: 0.24, damage: 17, range: 50, ignite: 0.06 },
};

export interface MayhemHud {
  stars: number;
  /** Whole seconds until the police forgive you, while you are wanted. */
  forgiveIn: number | null;
  cops: number;
  gun: GunKind | null;
  owned: GunKind[];
  /** Bad guys on the loose right now, out of `MAX_BAD`. */
  bads: number;
}

export interface MayhemCtx {
  /** The avatar's feet. */
  player: THREE.Vector3;
  /** Which way the avatar faces: forward is (sin yaw, cos yaw). */
  yaw: number;
  /** The vehicle being driven, if any. */
  driving: { x: number; y: number; z: number; yaw: number; speed: number } | null;
  /** Down on the city streets, where the police work. */
  inCity: boolean;
  /** The getaway kart, while the heist is running. */
  heist: THREE.Vector3 | null;
  /** Trigger held. */
  firing: boolean;
  /**
   * On your feet on the ground, not flying, falling or already knocked over.
   * A cruiser only knocks you down on a real bump at street level: being
   * batted out of the air the moment you jump out of a car is not a chase.
   */
  grounded: boolean;
  /** The bad guy whose roof you are riding on, by id, or null. */
  riding: number | null;
}

/** A bad guy's car, for seating a rider on its roof and finding it. */
export interface BadSeat {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  /** Still jumping down from the roof into his car. */
  boarding: boolean;
}

export interface MayhemOpts {
  scene: THREE.Scene;
  crashFx: CrashFx;
  smash: Smashables;
  traffic: Traffic;
  /** The city's buildings, for finding which one was hit. */
  boxes: WorldBox[];
  /** The city's collision query. Read lazily: it is built after this. */
  blocked: () => ((x: number, z: number, y: number) => boolean) | null;
  /** Street pitch (block + street) and the city's half span. */
  pitch: number;
  half: number;
  /** Where the avatar's hands are, to hold a gun. */
  hand: THREE.Object3D;
  /** Candidate spots for the Glock, first clear one wins. */
  glockSpots: Array<[number, number, number]>;
  /** Something rammed you. `byCop` false means you rammed a cop. */
  onContact(dx: number, dz: number, speed: number, byCop: boolean): void;
  /** An explosion went off here; hurt the player if they are close. */
  onBlast(x: number, z: number, r: number): void;
  /** Police reached the getaway kart. */
  onBust(): void;
  onHud(h: MayhemHud): void;
  onPickup(kind: GunKind): void;
  /** Gunshot / siren / boom hooks into the city's own sound, optional. */
  boom?(x: number, z: number): void;
  /** A bad guy's car went up. */
  onBadDown?(left: number): void;
  /** The bad guys' roof pad, if the city built one: [x, y, z]. */
  hideout?: [number, number, number];
  /** Where cruisers roll out of the police station: [x, z, yaw]. */
  garage?: [number, number, number];
  /** Cruisers parked outside the station: [x, z, yaw] each. */
  parked?: Array<[number, number, number]>;
}

export interface Mayhem {
  group: THREE.Group;
  /** Something illegal happened. `amount` is in stars. */
  crime(amount: number): void;
  /**
   * A vehicle hit a building at (x, z) going `impact` m/s, heading (fx, fz).
   * Returns true if the building went up.
   */
  wall(x: number, y: number, z: number, impact: number, fx: number, fz: number): boolean;
  /** Set the trees within `r` alight. */
  ignite(x: number, z: number, r: number): void;
  /** G: holster, rifle, Glock, round again (owned ones only). */
  cycle(): void;
  update(dt: number, ctx: MayhemCtx): void;
  /** For harnesses. */
  debug(): {
    heat: number;
    cops: Array<{ x: number; z: number; hp: number; target: string; speed: number }>;
    fires: number;
    gun: GunKind | null;
    owned: GunKind[];
    spots: Record<GunKind, [number, number, number] | null>;
    shots: number;
    hits: number;
    bads: Array<{ id: number; x: number; z: number; hp: number; speed: number; boarding: boolean; chasers: number }>;
  };
  setHeat(h: number): void;
  give(kind: GunKind): void;
  /**
   * Send a bad guy off the hideout roof into the nearest car. Returns what
   * happened: "ok", "full" at `MAX_BAD`, or "nocar" when no car is near.
   */
  summon(): "ok" | "full" | "nocar";
  /** The hideout pad on the roof, once placed: [x, y, z]. */
  hideout(): [number, number, number] | null;
  /** Every bad guy on the loose. The array is fresh each call. */
  bads(): BadSeat[];
  /** One bad guy by id, or null once he is gone. */
  seat(id: number): BadSeat | null;
  /** Hurt a bad guy's car (for a harness). At zero it blows up. */
  hurtBad(id: number, dmg: number): void;
  /**
   * The cruisers still running, for allies that fight them (the bodyguards in
   * `bodyguards.ts`). `i` is only good for the frame it was read in.
   */
  threats(): Array<{ i: number; x: number; z: number; yaw: number; speed: number }>;
  /**
   * Somebody on your side hurt cruiser `i`. Adds no heat: you did not do it.
   * True when that was the blow that wrecked it.
   */
  allyHit(i: number, dmg: number): boolean;
  dispose(): void;
}

const OWNED_KEY = "vibe.city.guns";
const MAX_STARS = 5;
const MAX_COPS = 5;
/** Bad guys on the loose at once. */
export const MAX_BAD = 3;
const BAD_HP = 100;
/** A little slower than a cruiser, so the police can catch him. */
const BAD_TOP = 23;
const MAX_FIRES = 18;
const COP_HP = 100;
/**
 * Seconds after your last bad act that the police let it go. Jack's number:
 * "about one minute and three seconds". They still go after the getaway kart.
 */
export const FORGIVE_AFTER = 63;
const COP_TOP = 27;
const COP_ACCEL = 15;

// ---- Little models -------------------------------------------------------

function buildRifle(): THREE.Group {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.45, metalness: 0.7 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x3b3f2a, roughness: 0.8 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(0.07, 0.1, 0.5), metal, 0, 0, 0.05); // receiver
  add(new THREE.CylinderGeometry(0.018, 0.018, 0.42, 8).rotateX(Math.PI / 2), metal, 0, 0.02, 0.5); // barrel
  add(new THREE.BoxGeometry(0.06, 0.12, 0.3), wood, 0, -0.02, -0.33); // stock
  add(new THREE.BoxGeometry(0.05, 0.18, 0.08), metal, 0, -0.12, 0.1).rotation.x = 0.25; // magazine
  add(new THREE.BoxGeometry(0.04, 0.12, 0.05), wood, 0, -0.09, -0.08).rotation.x = -0.3; // grip
  add(new THREE.BoxGeometry(0.03, 0.05, 0.16), metal, 0, 0.08, 0.06); // sight rail
  return g;
}

function buildGlock(): THREE.Group {
  const g = new THREE.Group();
  const slide = new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.4, metalness: 0.6 });
  const frame = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.85 });
  const s = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.2), slide);
  s.position.set(0, 0.03, 0.05);
  g.add(s);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.13, 0.06), frame);
  grip.position.set(0, -0.05, -0.02);
  grip.rotation.x = -0.25;
  g.add(grip);
  return g;
}

export interface CopMesh {
  group: THREE.Group;
  /** The two halves of the light bar, both blue, strobing in turn. */
  a: THREE.MeshBasicMaterial;
  b: THREE.MeshBasicMaterial;
  /** Burnt out: every panel goes dark. */
  char(): void;
  dispose(): void;
}

const CHARRED = new THREE.MeshStandardMaterial({ color: 0x1f1d1b, roughness: 0.9 });

/**
 * A police cruiser: the city's own dark saloon, in black, with a blue light
 * bar on the roof. Nothing else marks it, which is the point: it looks like
 * any other car on the street until you notice the lights.
 */
export function buildCruiser(): CopMesh {
  const car = buildCityCar({ body: 0x0c0d0f, accent: 0x15171a, trim: 0xd9dde2 });
  const a = new THREE.MeshBasicMaterial({ color: 0x2a6bff });
  const b = new THREE.MeshBasicMaterial({ color: 0x2a6bff });
  const base = new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.5 });
  const barGeo = new THREE.BoxGeometry(1.3, 0.08, 0.32);
  const lampGeo = new THREE.BoxGeometry(0.55, 0.16, 0.3);
  const bar = new THREE.Mesh(barGeo, base);
  bar.position.set(0, car.roofY + 0.05, 0);
  const la = new THREE.Mesh(lampGeo, a);
  la.position.set(-0.33, car.roofY + 0.16, 0);
  const lb = new THREE.Mesh(lampGeo, b);
  lb.position.set(0.33, car.roofY + 0.16, 0);
  car.group.add(bar, la, lb);
  return {
    group: car.group,
    a,
    b,
    char() {
      car.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m !== la && m !== lb) m.material = CHARRED;
      });
      a.color.set(0x050a18);
      b.color.set(0x050a18);
    },
    dispose() {
      car.dispose();
      barGeo.dispose();
      lampGeo.dispose();
      base.dispose();
      a.dispose();
      b.dispose();
    },
  };
}

function glintSprite(color: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  s.scale.setScalar(1.6);
  return s;
}

// ---- Pure helpers (tested) ----------------------------------------------

/** Stars shown for a heat value: nothing until there is some, then rounded up. */
export function starsFor(heat: number): number {
  return heat < 0.05 ? 0 : Math.min(MAX_STARS, Math.ceil(heat - 0.001));
}

/** How many cruisers a heat level puts on the street. */
export function copsFor(heat: number, heistLoose: boolean): number {
  const byHeat = heat < 1 ? 0 : Math.min(MAX_COPS, Math.floor(heat) + (heat >= 3 ? 1 : 0));
  return Math.max(byHeat, heistLoose ? 2 : 0);
}

/** Whether a building is one of the ones that goes up easily. Stable per box. */
export function isVolatile(b: { minX: number; minZ: number }): boolean {
  const h = Math.imul(Math.round(b.minX * 10) | 0, 73856093) ^ Math.imul(Math.round(b.minZ * 10) | 0, 19349663);
  return ((h >>> 0) % 3) === 0;
}

/** The impact speed, m/s, that sets a building off. */
export function blastThreshold(volatile: boolean): number {
  return volatile ? 9 : 19;
}

/**
 * Pick what an assisted shot hits: the candidate with the smallest angle off
 * the aim line, inside `cone` radians and `range` metres, nearer ones winning
 * ties. Returns the index or -1.
 */
export function pickTarget(
  ox: number, oz: number, yaw: number, range: number, cone: number,
  cands: ReadonlyArray<{ x: number; z: number; weight?: number }>,
): number {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < cands.length; i++) {
    const dx = cands[i].x - ox;
    const dz = cands[i].z - oz;
    const d = Math.hypot(dx, dz);
    if (d < 0.5 || d > range) continue;
    const cos = (dx * fx + dz * fz) / d;
    const ang = Math.acos(THREE.MathUtils.clamp(cos, -1, 1));
    if (ang > cone) continue;
    const score = ang + (d / range) * 0.25 - (cands[i].weight ?? 0);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

// ---- The module ----------------------------------------------------------

/** Anything that drives itself round the grid: a cruiser or a bad guy. */
interface Driver {
  x: number;
  z: number;
  yaw: number;
  speed: number;
  wpX: number;
  wpZ: number;
  repath: number;
  stuck: number;
  reverse: number;
}

interface Cop extends Driver {
  mesh: CopMesh;
  hp: number;
  /** 0 while running; seconds since it was wrecked. */
  dead: number;
  ramCool: number;
  target: "player" | "heist" | "leave" | "bad";
  /** The bad guy it is after, by id, when `target` is "bad". */
  prey: number;
  /** Seconds since it last had any reason to be here. */
  idle: number;
}

interface Bad extends Driver {
  id: number;
  /** The traffic car he took. */
  car: number;
  hp: number;
  roofY: number;
  /** Seconds into the jump off the roof; past `JUMP_T` he is driving. */
  jump: number;
  from: THREE.Vector3;
  /** The junction he last left, so he does not double straight back. */
  prevX: number;
  prevZ: number;
  ramCool: number;
  figure: THREE.Group;
  tag: THREE.Sprite;
}

/** Seconds from the roof to the driver's seat. */
const JUMP_T = 1.6;

/** A man in black with a red mask. Feet at the origin, facing +Z. */
function buildBadGuy(): THREE.Group {
  const g = new THREE.Group();
  const black = new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.7 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xd9a77e, roughness: 0.8 });
  const red = new THREE.MeshStandardMaterial({ color: 0xd7262e, roughness: 0.5 });
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };
  add(new THREE.BoxGeometry(0.5, 0.65, 0.3), black, 0, 1.05, 0);
  for (const sx of [-0.13, 0.13]) add(new THREE.BoxGeometry(0.18, 0.7, 0.22), black, sx, 0.36, 0);
  for (const sx of [-0.33, 0.33]) add(new THREE.BoxGeometry(0.14, 0.58, 0.16), black, sx, 1.06, 0);
  add(new THREE.SphereGeometry(0.2, 14, 10), skin, 0, 1.58, 0);
  add(new THREE.BoxGeometry(0.43, 0.1, 0.43), red, 0, 1.6, 0.01);
  add(new THREE.CylinderGeometry(0.24, 0.24, 0.06, 14), black, 0, 1.74, 0);
  add(new THREE.CylinderGeometry(0.15, 0.17, 0.2, 14), black, 0, 1.86, 0);
  return g;
}

/** A floating label so you can find him from down the street. */
function badTag(): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 96;
  const x = c.getContext("2d")!;
  x.fillStyle = "rgba(160,16,24,0.88)";
  x.beginPath();
  x.roundRect(8, 14, 240, 68, 30);
  x.fill();
  x.fillStyle = "#fff";
  x.font = "bold 38px system-ui, sans-serif";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText("🦹 BAD GUY", 128, 50);
  const t = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false, transparent: true }));
  s.scale.set(3.2, 1.2, 1);
  return s;
}

interface Fire {
  x: number;
  y: number;
  z: number;
  t: number;
  life: number;
  tree: boolean;
  fallen: boolean;
  nextSpread: number;
}

interface Tracer {
  mesh: THREE.Mesh;
  t: number;
}

/** 1 next to you, 0 a block and a half away: how hard a far crash shakes the camera. */
function earshotish(x: number, z: number, mx: number, mz: number): number {
  return Math.max(0, 1 - Math.hypot(x - mx, z - mz) / 60);
}

export function createMayhem(opts: MayhemOpts): Mayhem {
  const { crashFx, smash, traffic } = opts;
  const group = new THREE.Group();
  group.name = "mayhem";
  opts.scene.add(group);

  let heat = 0;
  let quiet = 0;
  let shots = 0;
  let hits = 0;
  const cops: Cop[] = [];
  const bads: Bad[] = [];
  let nextBadId = 1;
  const fires: Fire[] = [];
  let spawnCool = 0;
  let wallCool = 0;
  let fireCool = 0;
  /** Seconds before a cruiser may knock you over on foot again. */
  let footCool = 0;

  // ---- Guns ----------------------------------------------------------
  const owned = new Set<GunKind>();
  try {
    const raw = JSON.parse(localStorage.getItem(OWNED_KEY) || "[]");
    if (Array.isArray(raw)) for (const k of raw) if (k === "rifle" || k === "glock") owned.add(k);
  } catch {
    /* fresh start */
  }
  const saveOwned = () => {
    try {
      localStorage.setItem(OWNED_KEY, JSON.stringify([...owned]));
    } catch {
      /* private window */
    }
  };
  let gun: GunKind | null = owned.has("rifle") ? "rifle" : owned.has("glock") ? "glock" : null;

  const inHand: Record<GunKind, THREE.Group> = { rifle: buildRifle(), glock: buildGlock() };
  inHand.rifle.position.set(-0.28, 1.05, 0.3);
  inHand.glock.position.set(-0.3, 1.05, 0.38);
  for (const k of ["rifle", "glock"] as const) {
    inHand[k].visible = false;
    opts.hand.add(inHand[k]);
  }

  // The pickups. Where they lie is decided once the collision exists, on
  // the first update, because a spot inside a wall is no spot at all.
  const spots: Record<GunKind, [number, number, number] | null> = { rifle: null, glock: null };
  const pickups: Record<GunKind, THREE.Group> = { rifle: new THREE.Group(), glock: new THREE.Group() };
  {
    const r = buildRifle();
    r.scale.setScalar(2.2);
    pickups.rifle.add(r);
    const gl = buildGlock();
    gl.scale.setScalar(3.4);
    pickups.glock.add(gl);
    pickups.rifle.add(glintSprite("rgba(255,200,90,0.9)"));
    pickups.glock.add(glintSprite("rgba(120,220,255,0.9)"));
    for (const k of ["rifle", "glock"] as const) {
      pickups[k].visible = false;
      group.add(pickups[k]);
    }
  }
  const parkedMeshes: CopMesh[] = [];
  for (const [x, z, yaw] of opts.parked ?? []) {
    const m = buildCruiser();
    m.group.position.set(x, 0, z);
    m.group.rotation.y = yaw;
    m.a.color.set(0x0a1a44);
    m.b.color.set(0x0a1a44);
    group.add(m.group);
    parkedMeshes.push(m);
  }
  let placed = false;
  const place = (blocked: (x: number, z: number, y: number) => boolean) => {
    placed = true;
    // The rifle: on the roof of a mid-height building near the middle of
    // town. You can see the glint from the street, and you need the jetpack.
    let best: WorldBox | null = null;
    let bestD = Infinity;
    for (const b of opts.boxes) {
      const w = b.maxX - b.minX;
      const d = b.maxZ - b.minZ;
      if (b.base !== 0 || b.height < 14 || b.height > 30 || w < 8 || d < 8) continue;
      if (Math.abs(b.minX) > opts.half || Math.abs(b.minZ) > opts.half) continue;
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      const dist = Math.hypot(cx - 46, cz + 38);
      if (dist < bestD) {
        bestD = dist;
        best = b;
      }
    }
    if (best) {
      spots.rifle = [(best.minX + best.maxX) / 2, best.base + best.height + 1.1, (best.minZ + best.maxZ) / 2];
    }
    // The bad guys' hideout: the roof of a low building right by the middle
    // of town, low enough to jetpack up to and close enough to find.
    let hq: WorldBox | null = null;
    let hqD = Infinity;
    for (const b of opts.boxes) {
      if (b === best) continue;
      const w = b.maxX - b.minX;
      const d = b.maxZ - b.minZ;
      if (b.base !== 0 || b.height < 7 || b.height > 22 || w < 8 || d < 8) continue;
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      const dist = Math.hypot(cx - 40, cz - 40);
      if (dist < hqD) {
        hqD = dist;
        hq = b;
      }
    }
    if (opts.hideout) {
      hideoutAt = opts.hideout;
      buildHideout(hideoutAt);
    } else if (hq) {
      hideoutAt = [(hq.minX + hq.maxX) / 2, hq.base + hq.height, (hq.minZ + hq.maxZ) / 2];
      buildHideout(hideoutAt);
    }
    for (const s of opts.glockSpots) {
      if (!blocked(s[0], s[2], s[1] + 0.8)) {
        spots.glock = [s[0], s[1] + 0.9, s[2]];
        break;
      }
    }
    for (const k of ["rifle", "glock"] as const) {
      const s = spots[k];
      if (!s) continue;
      pickups[k].position.set(s[0], s[1], s[2]);
      pickups[k].visible = !owned.has(k);
    }
  };

  // Tracers and the muzzle flash.
  const tracerMat = new THREE.MeshBasicMaterial({
    color: 0xffe29a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const tracerGeo = new THREE.BoxGeometry(0.05, 0.05, 1).translate(0, 0, 0.5);
  const tracers: Tracer[] = [];
  for (let i = 0; i < 10; i++) {
    const m = new THREE.Mesh(tracerGeo, tracerMat);
    m.visible = false;
    group.add(m);
    tracers.push({ mesh: m, t: 1 });
  }
  let tracerNext = 0;
  const flash = glintSprite("rgba(255,180,60,1)");
  flash.scale.setScalar(0.9);
  flash.visible = false;
  group.add(flash);
  let flashT = 1;

  // ---- Sound: its own tiny graph, started by the first keypress ----------
  let actx: AudioContext | null = null;
  let noise: AudioBuffer | null = null;
  let siren: { osc: OscillatorNode; gain: GainNode } | null = null;
  const audio = () => {
    if (actx) return actx;
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      actx = new AC();
      noise = actx.createBuffer(1, actx.sampleRate * 0.3, actx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
    } catch {
      actx = null;
    }
    return actx;
  };
  const bang = (kind: GunKind) => {
    const a = audio();
    if (!a || !noise) return;
    const src = a.createBufferSource();
    src.buffer = noise;
    const f = a.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = kind === "rifle" ? 2600 : 1800;
    const g = a.createGain();
    g.gain.value = kind === "rifle" ? 0.32 : 0.26;
    src.connect(f).connect(g).connect(a.destination);
    src.start();
    src.stop(a.currentTime + 0.3);
  };
  const sirenTo = (level: number, t: number) => {
    if (level <= 0.01 && !siren) return;
    const a = audio();
    if (!a) return;
    if (!siren) {
      const osc = a.createOscillator();
      osc.type = "triangle";
      const gain = a.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(a.destination);
      osc.start();
      siren = { osc, gain };
    }
    siren.osc.frequency.setTargetAtTime(Math.sin(t * Math.PI * 1.6) > 0 ? 960 : 700, a.currentTime, 0.03);
    siren.gain.gain.setTargetAtTime(level * 0.06, a.currentTime, 0.1);
  };

  // ---- HUD -------------------------------------------------------------
  let lastHud = "";
  const hud = () => {
    const h: MayhemHud = {
      stars: starsFor(heat),
      forgiveIn: starsFor(heat) > 0 ? Math.max(0, Math.ceil(FORGIVE_AFTER - quiet)) : null,
      cops: cops.filter((c) => c.dead === 0).length,
      gun,
      owned: (["rifle", "glock"] as const).filter((k) => owned.has(k)),
      bads: bads.length,
    };
    const key = JSON.stringify(h);
    if (key !== lastHud) {
      lastHud = key;
      opts.onHud(h);
    }
  };

  const crime = (amount: number) => {
    heat = Math.min(MAX_STARS, heat + amount);
    quiet = 0;
  };

  // ---- Fire ------------------------------------------------------------
  const burningAt = (x: number, z: number) =>
    fires.some((f) => f.tree && Math.abs(f.x - x) < 0.3 && Math.abs(f.z - z) < 0.3);
  const ignite = (x: number, z: number, r: number) => {
    for (const t of smash.standing(x, z, r, "tree")) {
      if (fires.length >= MAX_FIRES) break;
      if (burningAt(t.x, t.z)) continue;
      fires.push({ x: t.x, y: 3, z: t.z, t: Math.random() * 0.6, life: 15 + Math.random() * 5, tree: true, fallen: false, nextSpread: 3 });
    }
  };
  const boom = (x: number, y: number, z: number, power: number, byPlayer = true) => {
    crashFx.explode(x, y, z, power, 0xff8a3d);
    crashFx.kick(0.5);
    traffic.blast(x, z, 12, 18);
    smash.blast(x, z, 9, 16);
    ignite(x, z, 15);
    opts.onBlast(x, z, 10);
    opts.boom?.(x, z);
    for (const c of cops) {
      if (c.dead > 0) continue;
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < 11) hurtCop(c, 90 * (1 - d / 11), byPlayer);
    }
    for (const b of bads) {
      const d = Math.hypot(b.x - x, b.z - z);
      if (b.jump >= JUMP_T && d < 11 && d > 0.5) hurtBad(b, 70 * (1 - d / 11));
    }
  };

  // ---- Cops --------------------------------------------------------------
  const hurtCop = (c: Cop, dmg: number, byPlayer = true) => {
    if (c.dead > 0) return;
    c.hp -= dmg;
    if (c.hp > 0) return;
    c.dead = 1e-3;
    c.speed *= 0.3;
    c.mesh.char();
    if (byPlayer) crime(0.8);
    boom(c.x, 0.9, c.z, 1.6, byPlayer);
    crashFx.debris(c.x, 1.2, c.z, 10, 0xf4f5f7, 8);
  };

  const streets = () => {
    const out: number[] = [];
    for (let v = -opts.half; v <= opts.half + 0.01; v += opts.pitch) out.push(v);
    return out;
  };
  const LINES = streets();

  const clear = (blocked: (x: number, z: number, y: number) => boolean, ax: number, az: number, bx: number, bz: number) => {
    const d = Math.hypot(bx - ax, bz - az);
    const n = Math.ceil(d / 2.5);
    for (let i = 1; i < n; i++) {
      const k = i / n;
      if (blocked(ax + (bx - ax) * k, az + (bz - az) * k, 0.9)) return false;
    }
    return true;
  };

  const spawnCop = (px: number, pz: number) => {
    // Out of the station garage when the station is within a few blocks and
    // nobody is already sitting in the doorway.
    const g = opts.garage;
    if (g && Math.hypot(g[0] - px, g[1] - pz) < 230 && Math.random() < 0.6 &&
      !cops.some((c) => Math.hypot(c.x - g[0], c.z - g[1]) < 6)) {
      const mesh = buildCruiser();
      group.add(mesh.group);
      cops.push({
        mesh, x: g[0], z: g[1], yaw: g[2], speed: 4, hp: COP_HP, dead: 0,
        wpX: g[0] + Math.sin(g[2]) * 8, wpZ: g[1] + Math.cos(g[2]) * 8, repath: 0.6, ramCool: 1, stuck: 0, reverse: 0,
        target: "player", prey: -1, idle: 0,
      });
      return;
    }
    // A junction 70 to 120 m away, picked at random among the ones that fit.
    const choices: Array<[number, number]> = [];
    for (const x of LINES) {
      for (const z of LINES) {
        const d = Math.hypot(x - px, z - pz);
        if (d > 70 && d < 125) choices.push([x, z]);
      }
    }
    if (!choices.length) return;
    const [x, z] = choices[Math.floor(Math.random() * choices.length)];
    const mesh = buildCruiser();
    group.add(mesh.group);
    cops.push({
      mesh, x, z, yaw: Math.atan2(px - x, pz - z), speed: 6, hp: COP_HP, dead: 0,
      wpX: px, wpZ: pz, repath: 0, ramCool: 1, stuck: 0, reverse: 0, target: "player", prey: -1, idle: 0,
    });
  };

  const removeCop = (i: number) => {
    const c = cops[i];
    group.remove(c.mesh.group);
    c.mesh.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    c.mesh.dispose();
    cops.splice(i, 1);
  };

  const route = (
    blocked: (x: number, z: number, y: number) => boolean, c: Cop, tx: number, tz: number,
  ) => {
    if (clear(blocked, c.x, c.z, tx, tz)) {
      c.wpX = tx;
      c.wpZ = tz;
      return;
    }
    // Junctions within reach, scored by how close they get us to the target,
    // with a big bonus for one that can see it.
    let bx = c.wpX;
    let bz = c.wpZ;
    let best = Infinity;
    for (const x of LINES) {
      if (Math.abs(x - c.x) > opts.pitch * 1.2) continue;
      for (const z of LINES) {
        if (Math.abs(z - c.z) > opts.pitch * 1.2) continue;
        const dHere = Math.hypot(x - c.x, z - c.z);
        if (dHere < 5) continue;
        if (!clear(blocked, c.x, c.z, x, z)) continue;
        let s = Math.hypot(tx - x, tz - z) + dHere * 0.2;
        if (clear(blocked, x, z, tx, tz)) s -= 25;
        if (s < best) {
          best = s;
          bx = x;
          bz = z;
        }
      }
    }
    c.wpX = bx;
    c.wpZ = bz;
  };

  const driveCop = (
    blocked: (x: number, z: number, y: number) => boolean, c: Cop, dt: number,
    tx: number, tz: number,
  ) => {
    c.repath -= dt;
    if (c.repath <= 0) {
      c.repath = 0.35;
      if (c.target === "leave") {
        c.wpX = c.x + Math.sin(c.yaw) * 40;
        c.wpZ = c.z + Math.cos(c.yaw) * 40;
        route(blocked, c, c.wpX, c.wpZ);
      } else {
        route(blocked, c, tx, tz);
      }
    }
    steer(blocked, c, dt, COP_TOP, (d) => hurtCop(c, d, false));
  };

  /**
   * Drive toward the current waypoint: turn, throttle, and deal with whatever
   * is in the way. Bot cars get barged aside, walls bounce you, and being
   * stuck for a second backs you out.
   */
  const steer = (
    blocked: (x: number, z: number, y: number) => boolean, c: Driver, dt: number,
    top: number, hurtSelf: (dmg: number) => void,
  ) => {
    const dx = c.wpX - c.x;
    const dz = c.wpZ - c.z;
    const dist = Math.hypot(dx, dz);
    let dyaw = Math.atan2(dx, dz) - c.yaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    if (c.reverse > 0) {
      c.reverse -= dt;
      c.speed = Math.max(c.speed - COP_ACCEL * dt, -8);
      c.yaw -= Math.sign(dyaw || 1) * 1.6 * dt;
    } else {
      const turn = 2.8 * THREE.MathUtils.clamp(Math.abs(c.speed) / 8, 0.3, 1);
      c.yaw += THREE.MathUtils.clamp(dyaw, -turn * dt, turn * dt);
      void dist;
      const want = top * Math.max(0.3, Math.cos(dyaw));
      c.speed += THREE.MathUtils.clamp(want - c.speed, -COP_ACCEL * 1.5 * dt, COP_ACCEL * dt);
    }
    const fx = Math.sin(c.yaw);
    const fz = Math.cos(c.yaw);
    const sign = Math.sign(c.speed || 1);
    const nx = c.x + fx * c.speed * dt;
    const nz = c.z + fz * c.speed * dt;
    const probe = (x: number, z: number) => blocked(x + fx * 2.1 * sign, z + fz * 2.1 * sign, 0.9);
    if (!probe(nx, nz)) {
      c.x = nx;
      c.z = nz;
      c.stuck = Math.max(0, c.stuck - dt);
    } else {
      // A bot car in the way gets barged, like the player does it.
      const id = traffic.carAt(nx + fx * 2.1 * sign, nz + fz * 2.1 * sign, 0.9, 1);
      if (id >= 0) {
        traffic.shove(id, fx * sign, fz * sign, 4 + Math.abs(c.speed) * 0.7);
        traffic.damage(id, Math.abs(c.speed) * 1.5);
        hurtSelf(Math.abs(c.speed) * 0.5);
        crashFx.sparks(nx, 0.7, nz, fx, fz, 8);
        c.x = nx;
        c.z = nz;
        c.speed *= 0.7;
      } else if (!probe(nx, c.z)) {
        c.x = nx;
        c.speed *= 0.9;
      } else if (!probe(c.x, nz)) {
        c.z = nz;
        c.speed *= 0.9;
      } else {
        if (Math.abs(c.speed) > 10) {
          crashFx.sparks(c.x + fx * 2, 0.7, c.z + fz * 2, -fx, -fz, 6);
          hurtSelf(Math.abs(c.speed) * 1.1);
        }
        c.speed *= -0.2;
        c.stuck += dt * 2;
      }
    }
    if (c.stuck > 1 && c.reverse <= 0) {
      c.reverse = 0.9;
      c.stuck = 0;
    }
    // Trees and lamp posts in the way go over, as they do for anybody.
    if (Math.abs(c.speed) > 4) smash.hit(c.x + fx * 1.8, c.z + fz * 1.8, 1, fx, fz, Math.abs(c.speed));
    // Never leave the city.
    const lim = opts.half + 6;
    c.x = THREE.MathUtils.clamp(c.x, -lim, lim);
    c.z = THREE.MathUtils.clamp(c.z, -lim, lim);
  };

  // ---- Bad guys ------------------------------------------------------------
  /**
   * A bad guy is a traffic car with somebody else at the wheel. He takes it
   * from the fleet with `claim`, so it stops being a bot and is posed by
   * `drive` every frame, and when his health runs out it is handed back with
   * `detonate`, which is the same explosion a car you were driving gets.
   * Nobody arrests him. The only way out is up.
   */
  let hideoutAt: [number, number, number] | null = null;
  const hideoutGroup = new THREE.Group();
  group.add(hideoutGroup);
  const hideoutGeos: THREE.BufferGeometry[] = [];
  const hideoutMats: THREE.Material[] = [];
  let hideoutBeacon: THREE.Mesh | null = null;
  const buildHideout = ([x, y, z]: [number, number, number]) => {
    hideoutGroup.position.set(x, y + 0.03, z);
    const padMat = new THREE.MeshBasicMaterial({ color: 0xc81e2a, transparent: true, opacity: 0.85, depthWrite: false });
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false });
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xff3344, transparent: true, opacity: 0.22, depthWrite: false });
    hideoutMats.push(padMat, ringMat, beamMat);
    const pad = new THREE.CircleGeometry(2.6, 32).rotateX(-Math.PI / 2);
    const ring = new THREE.RingGeometry(2.6, 2.95, 40).rotateX(-Math.PI / 2);
    const beam = new THREE.CylinderGeometry(0.5, 0.5, 40, 12, 1, true).translate(0, 20, 0);
    hideoutGeos.push(pad, ring, beam);
    hideoutGroup.add(new THREE.Mesh(pad, padMat), new THREE.Mesh(ring, ringMat));
    hideoutBeacon = new THREE.Mesh(beam, beamMat);
    hideoutGroup.add(hideoutBeacon);
    // The sign: a bad guy standing on the pad, waiting.
    const boss = buildBadGuy();
    boss.scale.setScalar(1.15);
    hideoutGroup.add(boss);
    const sign = badTag();
    sign.position.set(0, 3.2, 0);
    hideoutGroup.add(sign);
  };

  const hurtBad = (b: Bad, dmg: number) => {
    if (b.hp <= 0 || dmg <= 0) return;
    b.hp -= dmg;
    if (b.hp > 0) return;
    // He goes up with the car. Do it after this frame's loop so the array is
    // not shrinking under somebody iterating it.
    deadBads.push(b);
  };
  const deadBads: Bad[] = [];
  const removeBad = (b: Bad) => {
    const i = bads.indexOf(b);
    if (i < 0) return;
    bads.splice(i, 1);
    group.remove(b.figure, b.tag);
    b.figure.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
    b.tag.material.map?.dispose();
    b.tag.material.dispose();
  };
  const blowBad = (b: Bad) => {
    if (b.jump >= JUMP_T) traffic.detonate(b.car, b.yaw + Math.PI);
    else traffic.release(b.car);
    boom(b.x, 1, b.z, 1.4, false);
    crashFx.debris(b.x, 1.4, b.z, 12, 0x2b2d31, 9);
    removeBad(b);
    opts.onBadDown?.(bads.length);
  };

  /** Which way to run next: the junction that is ahead, clear, and furthest from the police. */
  const flee = (blocked: (x: number, z: number, y: number) => boolean, b: Bad) => {
    let bx = b.wpX;
    let bz = b.wpZ;
    let best = -Infinity;
    const fx = Math.sin(b.yaw);
    const fz = Math.cos(b.yaw);
    for (const x of LINES) {
      if (Math.abs(x - b.x) > opts.pitch * 1.2) continue;
      for (const z of LINES) {
        if (Math.abs(z - b.z) > opts.pitch * 1.2) continue;
        const d = Math.hypot(x - b.x, z - b.z);
        if (d < 6) continue;
        if (!clear(blocked, b.x, b.z, x, z)) continue;
        let s = ((x - b.x) * fx + (z - b.z) * fz) / d * 14 + Math.random() * 18;
        if (Math.abs(x - b.prevX) < 1 && Math.abs(z - b.prevZ) < 1) s -= 30;
        let cop = 140;
        for (const c of cops) if (c.dead === 0) cop = Math.min(cop, Math.hypot(c.x - x, c.z - z));
        s += cop * 0.35;
        if (s > best) {
          best = s;
          bx = x;
          bz = z;
        }
      }
    }
    b.prevX = b.wpX;
    b.prevZ = b.wpZ;
    b.wpX = bx;
    b.wpZ = bz;
  };

  const summon = (): "ok" | "full" | "nocar" => {
    if (bads.length >= MAX_BAD) return "full";
    if (!hideoutAt) return "nocar";
    const [hx, hy, hz] = hideoutAt;
    const near = traffic
      .debugNear(hx, hz, 90)
      .filter((c) => !c.wreck && !c.hit && !c.crushed && !bads.some((b) => b.car === c.id))
      .sort((a, b) => Math.hypot(a.x - hx, a.z - hz) - Math.hypot(b.x - hx, b.z - hz));
    for (const c of near) {
      const ride = traffic.claim(c.id);
      if (!ride) continue;
      const figure = buildBadGuy();
      const tag = badTag();
      figure.position.set(hx, hy, hz);
      group.add(figure, tag);
      const yaw = ride.yaw - Math.PI;
      bads.push({
        id: nextBadId++, car: c.id, hp: BAD_HP, roofY: ride.roofY,
        x: ride.x, z: ride.z, yaw, speed: 0,
        wpX: ride.x + Math.sin(yaw) * 20, wpZ: ride.z + Math.cos(yaw) * 20,
        repath: 0, stuck: 0, reverse: 0,
        jump: 0, from: new THREE.Vector3(hx, hy, hz),
        prevX: Infinity, prevZ: Infinity, ramCool: 0, figure, tag,
      });
      return "ok";
    }
    return "nocar";
  };

  const updateBads = (dt: number, blocked: (x: number, z: number, y: number) => boolean, ctx: MayhemCtx) => {
    const me = ctx.driving ?? ctx.player;
    for (const b of bads) {
      b.ramCool = Math.max(0, b.ramCool - dt);
      if (b.jump < JUMP_T) {
        // Off the roof in one arc, into the car, which waits for him.
        b.jump += dt;
        const k = Math.min(1, b.jump / JUMP_T);
        const tx = b.x + Math.cos(b.yaw) * -0.4;
        const tz = b.z - Math.sin(b.yaw) * -0.4;
        b.figure.position.set(
          b.from.x + (tx - b.from.x) * k,
          b.from.y + (0.6 - b.from.y) * k + Math.sin(k * Math.PI) * 5,
          b.from.z + (tz - b.from.z) * k,
        );
        b.figure.rotation.set(k * Math.PI * 2, Math.atan2(tx - b.from.x, tz - b.from.z), 0);
        traffic.drive(b.car, b.x, 0, b.z, b.yaw + Math.PI);
        b.tag.position.set(b.figure.position.x, b.figure.position.y + 2.6, b.figure.position.z);
        continue;
      }
      // Driving. Pick the next junction when this one is reached or lost.
      b.repath -= dt;
      if (b.repath <= 0 || Math.hypot(b.wpX - b.x, b.wpZ - b.z) < 6) {
        b.repath = 2.5;
        if (Math.hypot(b.wpX - b.x, b.wpZ - b.z) < 6 || !clear(blocked, b.x, b.z, b.wpX, b.wpZ)) flee(blocked, b);
      }
      steer(blocked, b, dt, BAD_TOP, (d) => hurtBad(b, d * 0.6));
      traffic.drive(b.car, b.x, 0, b.z, b.yaw + Math.PI);
      // He sits in the driver's seat; the label floats over the roof.
      const lx = Math.cos(b.yaw) * 0.38;
      const lz = -Math.sin(b.yaw) * 0.38;
      b.figure.position.set(b.x + lx, 0.15, b.z + lz);
      b.figure.rotation.set(0, b.yaw, 0);
      b.figure.scale.setScalar(0.82);
      b.tag.position.set(b.x, b.roofY + 2.2 + Math.sin(clock * 3 + b.id) * 0.15, b.z);
      // Hurt: smoke, then fire.
      if (b.hp < 65) {
        const hurt = (65 - b.hp) / 65;
        crashFx.smoulder(dt, b.x + Math.sin(b.yaw) * 1.5, 1.1, b.z + Math.cos(b.yaw) * 1.5, hurt, b.hp < 30 ? hurt : 0);
      }
      // You, in something, ramming him.
      if (b.id !== ctx.riding && b.ramCool <= 0) {
        const d = Math.hypot(me.x - b.x, me.z - b.z);
        if (d < (ctx.driving ? 3 : 2.4)) {
          const nx = (me.x - b.x) / (d || 1);
          const nz = (me.z - b.z) / (d || 1);
          const into = Math.max(0, b.speed * (Math.sin(b.yaw) * nx + Math.cos(b.yaw) * nz));
          const meInto = ctx.driving
            ? Math.max(0, ctx.driving.speed * -(Math.sin(ctx.driving.yaw) * nx + Math.cos(ctx.driving.yaw) * nz))
            : 0;
          if (meInto > 3) {
            hurtBad(b, meInto * 2.2);
            opts.onContact(-nx, -nz, meInto, false);
            crashFx.sparks((me.x + b.x) / 2, 0.8, (me.z + b.z) / 2, nx, nz, 10);
            b.ramCool = 1;
          } else if (into > 4 && (ctx.driving || (ctx.grounded && ctx.player.y < 1.2))) {
            opts.onContact(nx, nz, into + 3, true);
            b.speed *= 0.5;
            b.ramCool = 1.5;
          }
          const push = (ctx.driving ? 3 : 2.4) - d;
          b.x -= nx * push;
          b.z -= nz * push;
        }
      }
    }
    while (deadBads.length) blowBad(deadBads.pop()!);
  };

  const seatOf = (b: Bad): BadSeat => ({
    id: b.id,
    x: b.x,
    y: b.jump >= JUMP_T ? b.roofY : b.figure.position.y,
    z: b.z,
    yaw: b.yaw,
    speed: b.speed,
    boarding: b.jump < JUMP_T,
  });

  // ---- Shooting ----------------------------------------------------------
  let shotCool = 0;
  const cands: Array<{ x: number; z: number; weight: number; kind: "cop" | "car" | "tree" | "bad"; ref: number }> = [];
  /** The bad guy you are riding with, so you do not shoot your own ride. */
  let riding: number | null = null;
  const shoot = (
    blocked: (x: number, z: number, y: number) => boolean, kind: GunKind,
    ox: number, oy: number, oz: number, yaw: number,
  ) => {
    const spec = GUNS[kind];
    shots++;
    cands.length = 0;
    cops.forEach((c, i) => {
      if (c.dead === 0) cands.push({ x: c.x, z: c.z, weight: 0.35, kind: "cop", ref: i });
    });
    bads.forEach((b, i) => {
      if (b.jump >= JUMP_T && b.id !== riding) cands.push({ x: b.x, z: b.z, weight: 0.4, kind: "bad", ref: i });
    });
    for (const car of traffic.debugNear(ox, oz, spec.range)) {
      if (!car.wreck) cands.push({ x: car.x, z: car.z, weight: 0.1, kind: "car", ref: car.id });
    }
    for (const t of smash.standing(ox, oz, Math.min(spec.range, 40), "tree")) {
      cands.push({ x: t.x, z: t.z, weight: 0, kind: "tree", ref: -1 });
    }
    const pick = pickTarget(ox, oz, yaw, spec.range, 0.32, cands);
    let ax = Math.sin(yaw);
    let az = Math.cos(yaw);
    let len = spec.range;
    let ty = oy;
    if (pick >= 0) {
      const t = cands[pick];
      len = Math.hypot(t.x - ox, t.z - oz);
      ax = (t.x - ox) / len;
      az = (t.z - oz) / len;
      ty = t.kind === "tree" ? 2.6 : 0.9;
    }
    // Walk the line; the first wall stops the round.
    let end = len;
    let wall = false;
    for (let s = 1.5; s < len; s += 1.2) {
      const y = oy + (ty - oy) * (s / len);
      if (blocked(ox + ax * s, oz + az * s, y)) {
        const id = traffic.carAt(ox + ax * s, oz + az * s, y, 0.6);
        if (id >= 0) {
          traffic.damage(id, spec.damage);
          traffic.shove(id, ax, az, 1.5);
          crime(0.12);
          hits++;
          crashFx.sparks(ox + ax * s, y, oz + az * s, -ax, -az, 6);
          end = s;
          wall = false;
          len = -1;
        } else {
          end = s;
          wall = true;
        }
        break;
      }
    }
    const ex = ox + ax * end;
    const ez = oz + az * end;
    const ey = oy + (ty - oy) * Math.min(1, end / Math.max(1, Math.abs(len)));
    if (len >= 0 && !wall && pick >= 0) {
      const t = cands[pick];
      hits++;
      if (t.kind === "cop") {
        hurtCop(cops[t.ref], spec.damage);
        crime(0.3);
        crashFx.sparks(ex, 1, ez, -ax, -az, 8);
      } else if (t.kind === "bad") {
        hurtBad(bads[t.ref], spec.damage);
        crashFx.sparks(ex, 0.9, ez, -ax, -az, 8);
      } else if (t.kind === "car") {
        traffic.damage(t.ref, spec.damage);
        traffic.shove(t.ref, ax, az, 1.5);
        crime(0.12);
        crashFx.sparks(ex, 0.9, ez, -ax, -az, 8);
      } else {
        crashFx.leaves(t.x, 3, t.z, 6);
        if (Math.random() < spec.ignite) ignite(t.x, t.z, 0.6);
      }
    } else if (wall) {
      crashFx.sparks(ex, ey, ez, -ax, -az, 5);
      crashFx.debris(ex, ey, ez, 1, 0x9aa2ab, 2);
    }
    // Shooting in town is noticed.
    if (cands.some((c) => c.kind !== "tree")) crime(0.03);
    const tr = tracers[tracerNext];
    tracerNext = (tracerNext + 1) % tracers.length;
    tr.t = 0;
    tr.mesh.visible = true;
    tr.mesh.position.set(ox, oy, oz);
    tr.mesh.scale.set(1, 1, Math.max(0.5, Math.hypot(ex - ox, ey - oy, ez - oz)));
    tr.mesh.lookAt(ex, ey, ez);
    flash.position.set(ox, oy, oz);
    flash.visible = true;
    flashT = 0;
    bang(kind);
  };

  let clock = 0;

  const api: Mayhem = {
    group,
    crime,
    ignite,
    wall(x, y, z, impact, fx, fz) {
      if (wallCool > 0 || impact < 6) {
        if (impact > 4) crime(0.08);
        return false;
      }
      let hit: WorldBox | null = null;
      for (const b of opts.boxes) {
        if (x < b.minX - 2 || x > b.maxX + 2 || z < b.minZ - 2 || z > b.maxZ + 2) continue;
        if (y < b.base - 1 || y > b.base + b.height) continue;
        hit = b;
        break;
      }
      const volatile = hit ? isVolatile(hit) : false;
      crime(impact > 12 ? 0.4 : 0.2);
      if (!hit || impact < blastThreshold(volatile)) return false;
      wallCool = 1.2;
      const bx = x - fx * 0.6;
      const bz = z - fz * 0.6;
      boom(bx, y + 1.4, bz, volatile ? 1.8 : 1.5);
      crashFx.debris(bx, y + 3, bz, 14, 0x8a8f98, 9);
      crime(1.1);
      // The facade keeps burning: one fire at the hole and one up the wall.
      for (const h of [1.2, 4.5]) {
        if (fires.length < MAX_FIRES + 4) {
          fires.push({ x: bx, y: y + h, z: bz, t: 0, life: 22, tree: false, fallen: true, nextSpread: 99 });
        }
      }
      return true;
    },
    cycle() {
      const order: Array<GunKind | null> = [null, "rifle", "glock"];
      for (let i = 1; i <= order.length; i++) {
        const next = order[(order.indexOf(gun) + i) % order.length];
        if (next === null || owned.has(next)) {
          gun = next;
          break;
        }
      }
      hud();
    },
    update(dt, ctx) {
      clock += dt;
      const blocked = opts.blocked();
      if (!blocked) return;
      if (!placed) place(blocked);
      wallCool = Math.max(0, wallCool - dt);
      footCool = Math.max(0, footCool - dt);

      // Pickups spin, bob, and get collected.
      for (const k of ["rifle", "glock"] as const) {
        const p = pickups[k];
        const s = spots[k];
        if (!p.visible || !s) continue;
        p.rotation.y += dt * 1.6;
        p.position.y = s[1] + Math.sin(clock * 2.2) * 0.15;
        const sprite = p.children[p.children.length - 1] as THREE.Sprite;
        sprite.scale.setScalar(1.4 + Math.sin(clock * 4) * 0.4);
        const dy = Math.abs(ctx.player.y + 0.9 - s[1]);
        if (!ctx.driving && dy < 2.2 && Math.hypot(ctx.player.x - s[0], ctx.player.z - s[2]) < 2.2) {
          owned.add(k);
          saveOwned();
          p.visible = false;
          gun = k;
          opts.onPickup(k);
        }
      }

      // The gun in your hand, and the trigger.
      inHand.rifle.visible = gun === "rifle" && !ctx.driving;
      inHand.glock.visible = gun === "glock" && !ctx.driving;
      shotCool = Math.max(0, shotCool - dt);
      if (gun && ctx.firing && shotCool <= 0) {
        shotCool = GUNS[gun].interval;
        if (ctx.driving) {
          const d = ctx.driving;
          shoot(blocked, gun, d.x + Math.sin(d.yaw) * 2.4, d.y + 1.1, d.z + Math.cos(d.yaw) * 2.4, d.yaw);
        } else {
          const p = ctx.player;
          shoot(blocked, gun, p.x + Math.sin(ctx.yaw) * 0.8, p.y + 1.15, p.z + Math.cos(ctx.yaw) * 0.8, ctx.yaw);
        }
      }
      for (const t of tracers) {
        if (!t.mesh.visible) continue;
        t.t += dt;
        if (t.t > 0.06) t.mesh.visible = false;
      }
      flashT += dt;
      flash.visible = flashT < 0.05;

      // Keep your nose clean for FORGIVE_AFTER seconds and it is forgotten.
      quiet += dt;
      if (quiet >= FORGIVE_AFTER) heat = Math.max(0, heat - dt * 4);
      if (!ctx.inCity) heat = Math.max(0, heat - dt * 0.5);

      // Who should be out there.
      const me = ctx.driving ?? ctx.player;
      const heistLoose = !!ctx.heist && ctx.inCity;
      riding = ctx.riding;
      updateBads(dt, blocked, ctx);
      const loose = bads.filter((b) => b.jump >= JUMP_T);
      const forMe = ctx.inCity ? copsFor(heat, heistLoose) : 0;
      // Every bad guy on the loose draws two cruisers of his own.
      const want = Math.min(MAX_COPS + 2, forMe + loose.length * 2);
      const alive = cops.filter((c) => c.dead === 0 && c.target !== "leave").length;
      spawnCool -= dt;
      if (alive < want && spawnCool <= 0 && cops.length < MAX_COPS + 4) {
        spawnCool = 2.2;
        if (alive < forMe || !loose.length) spawnCop(me.x, me.z);
        else {
          const b = loose[alive % loose.length];
          spawnCop(b.x, b.z);
        }
      }

      let nearest = Infinity;
      for (let i = cops.length - 1; i >= 0; i--) {
        const c = cops[i];
        if (c.dead > 0) {
          c.dead += dt;
          c.speed *= Math.max(0, 1 - dt * 2);
          c.x += Math.sin(c.yaw) * c.speed * dt;
          c.z += Math.cos(c.yaw) * c.speed * dt;
          crashFx.smoulder(dt, c.x, 1.2, c.z, 1, c.dead < 8 ? 1 : 0.2);
          c.mesh.group.position.set(c.x, 0, c.z);
          if (c.dead > 16) removeCop(i);
          continue;
        }
        // Pick a target: the getaway kart when it is loose and either nobody
        // is wanted or it is the closer of the two.
        const dMe = Math.hypot(me.x - c.x, me.z - c.z);
        const dHeist = heistLoose ? Math.hypot(ctx.heist!.x - c.x, ctx.heist!.z - c.z) : Infinity;
        const aliveRank = cops.filter((o) => o.dead === 0).indexOf(c);
        if (heistLoose && (heat < 1 || dHeist < dMe || aliveRank >= copsFor(heat, false))) c.target = "heist";
        else if (heat >= 0.5 && ctx.inCity && aliveRank < Math.max(1, copsFor(heat, false))) c.target = "player";
        else if (loose.length) {
          // Off duty for you, so after the nearest bad guy instead.
          c.target = "bad";
          let bd = Infinity;
          for (const b of loose) {
            const d = Math.hypot(b.x - c.x, b.z - c.z);
            if (d < bd) {
              bd = d;
              c.prey = b.id;
            }
          }
        } else c.target = "leave";
        const prey = c.target === "bad" ? loose.find((b) => b.id === c.prey) ?? null : null;
        const tx = c.target === "heist" ? ctx.heist!.x : prey ? prey.x : me.x;
        const tz = c.target === "heist" ? ctx.heist!.z : prey ? prey.z : me.z;
        driveCop(blocked, c, dt, tx, tz);
        if (c.dead > 0) continue;
        if (c.hp < 65) {
          const hurt = (65 - c.hp) / 65;
          crashFx.smoulder(dt, c.x + Math.sin(c.yaw) * 1.5, 1.1, c.z + Math.cos(c.yaw) * 1.5, hurt, c.hp < 30 ? hurt : 0);
        }
        c.ramCool = Math.max(0, c.ramCool - dt);
        if (c.target === "leave") {
          c.idle += dt;
          if (c.idle > 25 || (dMe > 140 && !loose.length)) {
            removeCop(i);
            continue;
          }
        } else {
          c.idle = 0;
        }
        nearest = Math.min(nearest, dMe);

        // Contact.
        if (prey && c.ramCool <= 0 && Math.hypot(prey.x - c.x, prey.z - c.z) < 3.1) {
          const d = Math.hypot(prey.x - c.x, prey.z - c.z) || 1;
          const nx = (prey.x - c.x) / d;
          const nz = (prey.z - c.z) / d;
          const into = Math.max(0, c.speed * (Math.sin(c.yaw) * nx + Math.cos(c.yaw) * nz));
          hurtBad(prey, into * 1.3 + 5);
          hurtCop(c, into * 0.4, false);
          prey.x += nx * 0.6;
          prey.z += nz * 0.6;
          prey.yaw += (Math.random() - 0.5) * 0.4;
          c.speed *= 0.4;
          c.ramCool = 1.1;
          crashFx.sparks((prey.x + c.x) / 2, 0.8, (prey.z + c.z) / 2, nx, nz, 10);
          crashFx.kick(0.15 * earshotish(c.x, c.z, me.x, me.z));
          const push = 3.1 - d;
          c.x -= nx * push;
          c.z -= nz * push;
        }
        if (c.target === "heist" && dHeist < 2.8) {
          opts.onBust();
          c.speed *= 0.2;
        } else if (
          dMe < (ctx.driving ? 2.9 : 2.4) && c.ramCool <= 0 &&
          (ctx.driving || (ctx.grounded && footCool <= 0 && ctx.player.y < 1.2))
        ) {
          const nx = (me.x - c.x) / (dMe || 1);
          const nz = (me.z - c.z) / (dMe || 1);
          const copInto = Math.max(0, c.speed * (Math.sin(c.yaw) * nx + Math.cos(c.yaw) * nz));
          const meInto = ctx.driving
            ? Math.max(0, ctx.driving.speed * -(Math.sin(ctx.driving.yaw) * nx + Math.cos(ctx.driving.yaw) * nz))
            : 0;
          if (meInto > copInto + 2) {
            // You rammed it.
            hurtCop(c, meInto * 2.6);
            c.speed = -meInto * 0.4;
            opts.onContact(-nx, -nz, meInto, false);
            crime(0.3);
          } else if (copInto > 3 && c.target === "player") {
            opts.onContact(nx, nz, copInto + 4, true);
            if (!ctx.driving) footCool = 3;
            // Ramming is not free for the ram either.
            hurtCop(c, copInto * 0.9, false);
            c.speed *= 0.3;
          }
          crashFx.sparks((me.x + c.x) / 2, 0.8, (me.z + c.z) / 2, nx, nz, 10);
          c.ramCool = 1.1;
          // Never stay inside each other.
          const push = (ctx.driving ? 2.9 : 2.4) - dMe;
          c.x -= nx * push;
          c.z -= nz * push;
        }
      }
      // Keep the cruisers out of each other.
      for (let i = 0; i < cops.length; i++) {
        for (let j = i + 1; j < cops.length; j++) {
          const a = cops[i];
          const b = cops[j];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const d = Math.hypot(dx, dz);
          if (d > 0.01 && d < 3.2) {
            const k = (3.2 - d) / 2 / d;
            a.x -= dx * k;
            a.z -= dz * k;
            b.x += dx * k;
            b.z += dz * k;
          }
        }
      }
      // Pose and strobe.
      const strobe = Math.sin(clock * 18) > 0;
      for (const c of cops) {
        c.mesh.group.position.set(c.x, 0, c.z);
        c.mesh.group.rotation.y = c.yaw;
        if (c.dead === 0) {
          c.mesh.a.color.set(strobe ? 0x3d7bff : 0x061230);
          c.mesh.b.color.set(strobe ? 0x061230 : 0x3d7bff);
        }
      }
      sirenTo(nearest < 120 ? (1 - nearest / 120) : 0, clock);
      if (hideoutBeacon) (hideoutBeacon.material as THREE.MeshBasicMaterial).opacity = 0.16 + Math.sin(clock * 2.5) * 0.08;

      // Fire.
      fireCool -= dt;
      for (let i = fires.length - 1; i >= 0; i--) {
        const f = fires[i];
        f.t += dt;
        const k = Math.min(1, f.t / 1.5) * Math.min(1, (f.life - f.t) / 3);
        if (f.t >= f.life) {
          fires.splice(i, 1);
          continue;
        }
        const j = f.tree && !f.fallen ? 1.4 : 0.6;
        crashFx.smoulder(dt, f.x + (Math.random() - 0.5) * j, f.y, f.z + (Math.random() - 0.5) * j, 0.8, Math.max(0, k));
        if (f.tree && !f.fallen && f.t > f.nextSpread) {
          f.nextSpread = f.t + 1.2;
          for (const t of smash.standing(f.x, f.z, 7, "tree")) {
            if (fires.length >= MAX_FIRES) break;
            if (!burningAt(t.x, t.z) && Math.random() < 0.3) {
              fires.push({ x: t.x, y: 3, z: t.z, t: 0, life: 15 + Math.random() * 5, tree: true, fallen: false, nextSpread: 3 });
            }
          }
        }
        if (f.tree && !f.fallen && f.t > 10) {
          // Burnt through: over it goes, still burning on the ground.
          f.fallen = true;
          const a = Math.random() * Math.PI * 2;
          smash.hit(f.x, f.z, 0.6, Math.cos(a), Math.sin(a), 6);
          crashFx.leaves(f.x, 2.5, f.z, 10);
          f.y = 0.7;
        }
      }
      hud();
    },
    debug() {
      return {
        heat,
        cops: cops.map((c) => ({ x: c.x, z: c.z, hp: c.hp, target: c.dead > 0 ? "wreck" : c.target, speed: c.speed })),
        fires: fires.length,
        gun,
        owned: [...owned],
        spots,
        shots,
        hits,
        bads: bads.map((b) => ({
          id: b.id, x: b.x, z: b.z, hp: b.hp, speed: b.speed, boarding: b.jump < JUMP_T,
          chasers: cops.filter((c) => c.dead === 0 && c.target === "bad" && c.prey === b.id).length,
        })),
      };
    },
    setHeat(h) {
      heat = THREE.MathUtils.clamp(h, 0, MAX_STARS);
      quiet = 0;
    },
    summon,
    hideout: () => hideoutAt,
    bads: () => bads.map(seatOf),
    seat(id) {
      const b = bads.find((o) => o.id === id);
      return b ? seatOf(b) : null;
    },
    hurtBad(id, dmg) {
      const b = bads.find((o) => o.id === id);
      if (b) hurtBad(b, dmg);
    },
    threats() {
      const out: Array<{ i: number; x: number; z: number; yaw: number; speed: number }> = [];
      cops.forEach((c, i) => {
        if (c.dead === 0) out.push({ i, x: c.x, z: c.z, yaw: c.yaw, speed: c.speed });
      });
      return out;
    },
    allyHit(i, dmg) {
      const c = cops[i];
      if (!c || c.dead > 0) return false;
      hurtCop(c, dmg, false);
      crashFx.sparks(c.x, 1, c.z, 0, 1, 6);
      return c.dead > 0;
    },
    give(kind) {
      owned.add(kind);
      saveOwned();
      pickups[kind].visible = false;
      gun = kind;
      hud();
    },
    dispose() {
      while (cops.length) removeCop(cops.length - 1);
      for (const m of parkedMeshes) m.dispose();
      while (bads.length) {
        const b = bads[0];
        traffic.release(b.car);
        removeBad(b);
      }
      hideoutGeos.forEach((g) => g.dispose());
      hideoutMats.forEach((m) => m.dispose());
      opts.scene.remove(group);
      for (const k of ["rifle", "glock"] as const) opts.hand.remove(inHand[k]);
      tracerGeo.dispose();
      tracerMat.dispose();
      try {
        siren?.osc.stop();
        void actx?.close();
      } catch {
        /* already gone */
      }
    },
  };
  return api;
}
