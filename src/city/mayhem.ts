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
 * A rifle, hidden on a rooftop, is the one free find: walk over it. Everything
 * else is bought with Vibey Coins at Vibe Arms (the stall on the plaza) or the
 * Vibe Shop on the island, and lives in `vibe_inventory` like a hat does: the
 * Glock 19, the Super Soaker (almost no damage, but it slows whatever it hits
 * to a crawl), the Nova Blaster (fires as fast as you hold it) and pineapple
 * bombs, which stick to whatever they hit and hurt it until they pop. None of
 * them run out. R fires, G switches, X throws a pineapple. Aim is assisted: the shot goes
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

export type GunKind = "rifle" | "glock" | "water" | "blaster";
/** Guns you buy rather than find. Ids match `weapon:<id>` in the inventory. */
export const BOUGHT_GUNS: readonly GunKind[] = ["glock", "water", "blaster"];
const ALL_GUNS: readonly GunKind[] = ["rifle", "glock", "water", "blaster"];

export interface GunSpec {
  label: string;
  emoji: string;
  /** Seconds between shots while the trigger is held. */
  interval: number;
  damage: number;
  range: number;
  /** Chance a round that hits a tree sets it alight. */
  ignite: number;
  /** Seconds a hit slows its target to a crawl. Water only. */
  soak?: number;
  /** Tracer colour and thickness. */
  tracer: number;
  thick: number;
}

export const GUNS: Record<GunKind, GunSpec> = {
  rifle: { label: "Rifle", emoji: "🎯", interval: 0.11, damage: 24, range: 95, ignite: 0.3, tracer: 0xffe29a, thick: 1 },
  glock: { label: "Glock 19", emoji: "🔫", interval: 0.24, damage: 17, range: 50, ignite: 0.06, tracer: 0xffe29a, thick: 1 },
  water: { label: "Super Soaker", emoji: "💦", interval: 0.07, damage: 1.5, range: 32, ignite: 0, soak: 4, tracer: 0x6fd0ff, thick: 2.6 },
  blaster: { label: "Nova Blaster", emoji: "☄️", interval: 0.06, damage: 14, range: 90, ignite: 0.2, tracer: 0xff4a3a, thick: 2 },
};

/** Pineapple bombs: how many you carry, and how fast a spent one grows back. */
export const BOMB_PACK = 3;
const BOMB_REGROW = 6;
/** A stuck bomb ticks this much damage a second, then pops for BOMB_POP. */
const BOMB_DPS = 3;
const BOMB_POP = 45;
/** The longest a stuck bomb holds on. Jack's number: "about 27 seconds". */
export const BOMB_MAX_FUSE = 27;

/**
 * How long a thrown pineapple holds on before it pops: anywhere from an
 * instant to BOMB_MAX_FUSE, skewed short so most of them go off while you
 * are still watching. `r` is a uniform 0..1.
 */
export function bombFuse(r: number): number {
  return BOMB_MAX_FUSE * r * r;
}

export interface MayhemHud {
  stars: number;
  /** Whole seconds until the police forgive you, while you are wanted. */
  forgiveIn: number | null;
  cops: number;
  gun: GunKind | null;
  owned: GunKind[];
  /** Pineapples in hand, or null if you have not bought the pack. */
  bombs: number | null;
  /** Standing at the Vibe Arms stall. */
  atStall: boolean;
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
  /** Throw key held (X). */
  throwing?: boolean;
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
  /** Candidate spots for the Vibe Arms stall, first clear one wins. */
  stallSpots: Array<[number, number, number]>;
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
  /** G: holster, then each owned gun, round again. */
  cycle(): void;
  /**
   * What the wardrobe says you have bought: `weapon:<id>` ids without the
   * prefix. Called whenever the inventory changes. A gun that is no longer
   * owned (a refund, a different account) is taken out of your hand.
   */
  setBought(ids: readonly string[]): void;
  /** Throw a pineapple now, if there is one. For harnesses and touch. */
  throwBomb(): void;
  update(dt: number, ctx: MayhemCtx): void;
  /** For harnesses. */
  debug(): {
    heat: number;
    cops: Array<{ x: number; z: number; hp: number; target: string; speed: number }>;
    fires: number;
    gun: GunKind | null;
    owned: GunKind[];
    spots: Record<GunKind, [number, number, number] | null>;
    stall: [number, number, number] | null;
    shots: number;
    hits: number;
    bombs: Array<{ x: number; y: number; z: number; stuck: string | null; fuse: number }>;
    pops: number;
    bads: Array<{ id: number; x: number; z: number; hp: number; speed: number; boarding: boolean; chasers: number }>;
  };
  setHeat(h: number): void;
  give(kind: GunKind): void;
  /** For harnesses: fire one round from here, along `yaw`. */
  shootFrom(kind: GunKind, x: number, y: number, z: number, yaw: number): void;
  /** For harnesses: throw a pineapple from here, along `yaw`, at `speed`. */
  throwFrom(x: number, y: number, z: number, yaw: number, speed?: number): void;
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

/** A chunky toy water gun: orange body, see-through blue tank on top. */
function buildSoaker(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0xff8a2a, roughness: 0.55 });
  const tank = new THREE.MeshStandardMaterial({ color: 0x4fb8ff, roughness: 0.15, transparent: true, opacity: 0.75 });
  const nozzle = new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.5 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(0.08, 0.1, 0.42), body, 0, 0, 0.05);
  add(new THREE.CylinderGeometry(0.06, 0.06, 0.26, 12).rotateX(Math.PI / 2), tank, 0, 0.1, 0.02);
  add(new THREE.CylinderGeometry(0.025, 0.03, 0.14, 8).rotateX(Math.PI / 2), nozzle, 0, 0.01, 0.32);
  add(new THREE.BoxGeometry(0.06, 0.14, 0.06), body, 0, -0.1, -0.06).rotation.x = -0.3;
  add(new THREE.BoxGeometry(0.05, 0.05, 0.12), nozzle, 0, -0.05, 0.16); // pump
  return g;
}

/**
 * The Nova Blaster: an original space pistol. White shell, orange stripe,
 * a black barrel with cooling rings and a glowing red emitter at the tip.
 */
function buildBlaster(): THREE.Group {
  const g = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: 0xeef0f3, roughness: 0.35, metalness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.4, metalness: 0.6 });
  const stripe = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.5 });
  const glow = new THREE.MeshBasicMaterial({ color: 0xff3b2e });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(0.07, 0.09, 0.24), shell, 0, 0.02, 0.02);
  add(new THREE.BoxGeometry(0.074, 0.025, 0.2), stripe, 0, 0.05, 0.03);
  add(new THREE.CylinderGeometry(0.022, 0.022, 0.24, 10).rotateX(Math.PI / 2), dark, 0, 0.02, 0.24);
  for (const z of [0.18, 0.23, 0.28]) {
    add(new THREE.CylinderGeometry(0.032, 0.032, 0.018, 12).rotateX(Math.PI / 2), dark, 0, 0.02, z);
  }
  add(new THREE.SphereGeometry(0.02, 8, 6), glow, 0, 0.02, 0.37);
  add(new THREE.BoxGeometry(0.05, 0.13, 0.06), dark, 0, -0.07, -0.04).rotation.x = -0.28;
  add(new THREE.BoxGeometry(0.03, 0.04, 0.09), dark, 0, 0.09, -0.02); // scope
  return g;
}

/** One pineapple: yellow body with a grid of darker diamonds and a green crown. */
function buildPineapple(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 10, 8).scale(1, 1.3, 1),
    new THREE.MeshStandardMaterial({ color: 0xe8b62c, roughness: 0.7, flatShading: true }),
  );
  g.add(body);
  const leaf = new THREE.MeshStandardMaterial({ color: 0x2f9e44, roughness: 0.7, flatShading: true });
  for (let i = 0; i < 5; i++) {
    const l = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.18, 4), leaf);
    const a = (i / 5) * Math.PI * 2;
    l.position.set(Math.cos(a) * 0.03, 0.22, Math.sin(a) * 0.03);
    l.rotation.set(Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4);
    g.add(l);
  }
  // The pin: it is a bomb, after all.
  const pin = new THREE.Mesh(
    new THREE.TorusGeometry(0.04, 0.008, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0xc0c4ca, metalness: 0.8, roughness: 0.3 }),
  );
  pin.position.set(0.12, 0.1, 0);
  pin.rotation.y = Math.PI / 2;
  g.add(pin);
  return g;
}

function signTexture(text: string, bg: string, fg: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const x = c.getContext("2d")!;
  x.fillStyle = bg;
  x.fillRect(0, 0, 512, 128);
  x.strokeStyle = fg;
  x.lineWidth = 6;
  x.strokeRect(8, 8, 496, 112);
  x.fillStyle = fg;
  x.font = "bold 64px system-ui, sans-serif";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText(text, 256, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Vibe Arms: a street stall with a striped awning, a counter, and the stock
 * turning slowly on top. The Vibe Shop counter, down in town.
 */
function buildStall(): { group: THREE.Group; display: THREE.Group } {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.8 });
  const top = new THREE.MeshStandardMaterial({ color: 0x7dffd4, roughness: 0.4, emissive: 0x0f3a2c });
  const counter = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.05, 1.1), wood);
  counter.position.y = 0.52;
  g.add(counter);
  const slab = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.08, 1.2), top);
  slab.position.y = 1.08;
  g.add(slab);
  for (const sx of [-1.6, 1.6]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3, 8), wood);
    post.position.set(sx, 1.5, -0.45);
    g.add(post);
  }
  // Striped awning.
  for (let i = 0; i < 7; i++) {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.52, 0.06, 1.6),
      new THREE.MeshStandardMaterial({ color: i % 2 ? 0xf4f5f7 : 0xff4f7a, roughness: 0.7 }),
    );
    stripe.position.set(-1.56 + i * 0.52, 2.95, 0.15);
    stripe.rotation.x = 0.22;
    g.add(stripe);
  }
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(3, 0.75),
    new THREE.MeshBasicMaterial({ map: signTexture("VIBE ARMS", "#0c1118", "#7dffd4") }),
  );
  sign.position.set(0, 3.55, -0.45);
  g.add(sign);
  const back = sign.clone();
  back.rotation.y = Math.PI;
  back.position.z = -0.46;
  g.add(back);
  const display = new THREE.Group();
  display.position.y = 1.45;
  const items = [buildGlock(), buildSoaker(), buildBlaster(), buildPineapple()];
  items.forEach((m, i) => {
    m.scale.setScalar(2.2);
    m.position.x = -1.2 + i * 0.8;
    display.add(m);
  });
  g.add(display);
  return { group: g, display };
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
  /** Seconds of water-gun slowdown left. */
  soaked: number;
}

interface Bomb {
  mesh: THREE.Group;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** What it is stuck to, if anything. A stuck bomb rides along with it. */
  stuck: { kind: "cop"; cop: Cop } | { kind: "car"; id: number } | { kind: "ground" } | null;
  /** Offset from what it is stuck to. */
  ox: number; oy: number; oz: number;
  /** Seconds left once stuck. */
  fuse: number;
  /** Seconds since thrown, so a bomb in flight that never lands still goes off. */
  age: number;
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
  // The rifle is a find and is remembered on this device. Everything else is
  // bought, and `setBought` is told about it from the wardrobe. The old key
  // also held "glock" from when it lay free on the plaza; that is ignored now
  // that it is sold.
  const owned = new Set<GunKind>();
  try {
    const raw = JSON.parse(localStorage.getItem(OWNED_KEY) || "[]");
    if (Array.isArray(raw) && raw.includes("rifle")) owned.add("rifle");
  } catch {
    /* fresh start */
  }
  const saveOwned = () => {
    try {
      localStorage.setItem(OWNED_KEY, JSON.stringify(owned.has("rifle") ? ["rifle"] : []));
    } catch {
      /* private window */
    }
  };
  let gun: GunKind | null = owned.has("rifle") ? "rifle" : null;
  let hasBombs = false;
  let bombsInHand = BOMB_PACK;
  let regrow = 0;
  let throwCool = 0;

  const inHand: Record<GunKind, THREE.Group> = {
    rifle: buildRifle(), glock: buildGlock(), water: buildSoaker(), blaster: buildBlaster(),
  };
  inHand.rifle.position.set(-0.28, 1.05, 0.3);
  inHand.glock.position.set(-0.3, 1.05, 0.38);
  inHand.water.position.set(-0.28, 1.05, 0.32);
  inHand.blaster.position.set(-0.3, 1.05, 0.36);
  for (const k of ALL_GUNS) {
    inHand[k].visible = false;
    opts.hand.add(inHand[k]);
  }

  // The pickups. Where they lie is decided once the collision exists, on
  // the first update, because a spot inside a wall is no spot at all.
  const spots: Record<GunKind, [number, number, number] | null> = { rifle: null, glock: null, water: null, blaster: null };
  const rifleUp = new THREE.Group();
  {
    const r = buildRifle();
    r.scale.setScalar(2.2);
    rifleUp.add(r);
    rifleUp.add(glintSprite("rgba(255,200,90,0.9)"));
    rifleUp.visible = false;
    group.add(rifleUp);
  }
  const stall = buildStall();
  stall.group.visible = false;
  group.add(stall.group);
  let stallAt: [number, number, number] | null = null;
  let atStall = false;
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
    // Vibe Arms goes where the free Glock used to lie.
    for (const s of opts.stallSpots) {
      if (!blocked(s[0], s[2], s[1] + 0.8) && !blocked(s[0] + 1.6, s[2], s[1] + 0.8) && !blocked(s[0] - 1.6, s[2], s[1] + 0.8)) {
        stallAt = [s[0], s[1], s[2]];
        break;
      }
    }
    if (stallAt) {
      stall.group.position.set(stallAt[0], stallAt[1], stallAt[2]);
      // Face the middle of the plaza.
      stall.group.rotation.y = Math.atan2(-stallAt[0], -stallAt[2]);
      stall.group.visible = true;
    }
    if (spots.rifle) {
      rifleUp.position.set(spots.rifle[0], spots.rifle[1], spots.rifle[2]);
      rifleUp.visible = !owned.has("rifle");
    }
  };

  // Tracers and the muzzle flash.
  const tracerMat = new THREE.MeshBasicMaterial({
    color: 0xffe29a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const tracerMats: Record<GunKind, THREE.MeshBasicMaterial> = {
    rifle: tracerMat,
    glock: tracerMat,
    water: new THREE.MeshBasicMaterial({ color: GUNS.water.tracer, transparent: true, opacity: 0.7, depthWrite: false }),
    blaster: new THREE.MeshBasicMaterial({
      color: GUNS.blaster.tracer, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  };
  const tracerGeo = new THREE.BoxGeometry(0.05, 0.05, 1).translate(0, 0, 0.5);
  const tracers: Tracer[] = [];
  for (let i = 0; i < 16; i++) {
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
    if (kind === "blaster") {
      // Pew: a saw that falls an octave and a half in a tenth of a second.
      const o = a.createOscillator();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(1500, a.currentTime);
      o.frequency.exponentialRampToValueAtTime(320, a.currentTime + 0.12);
      const g = a.createGain();
      g.gain.setValueAtTime(0.09, a.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.14);
      o.connect(g).connect(a.destination);
      o.start();
      o.stop(a.currentTime + 0.15);
      return;
    }
    if (kind === "water") {
      // Pssh: bright, quiet noise.
      const src = a.createBufferSource();
      src.buffer = noise;
      src.playbackRate.value = 1.6;
      const f = a.createBiquadFilter();
      f.type = "highpass";
      f.frequency.value = 3200;
      const g = a.createGain();
      g.gain.value = 0.05;
      src.connect(f).connect(g).connect(a.destination);
      src.start();
      src.stop(a.currentTime + 0.12);
      return;
    }
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
      owned: ALL_GUNS.filter((k) => owned.has(k)),
      bads: bads.length,
      bombs: hasBombs ? bombsInHand : null,
      atStall,
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
        target: "player", prey: -1, idle: 0, soaked: 0,
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
      wpX: px, wpZ: pz, repath: 0, ramCool: 1, stuck: 0, reverse: 0, target: "player", prey: -1, idle: 0, soaked: 0,
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
    steer(blocked, c, dt, c.soaked > 0 ? COP_TOP * 0.3 : COP_TOP, (d) => hurtCop(c, d, false));
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
          if (spec.soak) traffic.soak(id, spec.soak);
          else traffic.shove(id, ax, az, 1.5);
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
        const c = cops[t.ref];
        hurtCop(c, spec.damage);
        if (spec.soak) c.soaked = Math.min(8, Math.max(c.soaked, spec.soak));
        crime(spec.soak ? 0.05 : 0.3);
        if (!spec.soak) crashFx.sparks(ex, 1, ez, -ax, -az, 8);
      } else if (t.kind === "bad") {
        hurtBad(bads[t.ref], spec.damage);
        if (spec.soak) bads[t.ref].speed *= 0.4;
        crashFx.sparks(ex, 0.9, ez, -ax, -az, 8);
      } else if (t.kind === "car") {
        traffic.damage(t.ref, spec.damage);
        if (spec.soak) traffic.soak(t.ref, spec.soak);
        else traffic.shove(t.ref, ax, az, 1.5);
        crime(spec.soak ? 0.02 : 0.12);
        if (!spec.soak) crashFx.sparks(ex, 0.9, ez, -ax, -az, 8);
      } else if (spec.soak) {
        // Water puts a burning tree out.
        for (let i = fires.length - 1; i >= 0; i--) {
          const f = fires[i];
          if (f.tree && Math.hypot(f.x - t.x, f.z - t.z) < 1) f.life = Math.min(f.life, f.t + 1.5);
        }
      } else {
        crashFx.leaves(t.x, 3, t.z, 6);
        if (Math.random() < spec.ignite) ignite(t.x, t.z, 0.6);
      }
    } else if (wall && !spec.soak) {
      crashFx.sparks(ex, ey, ez, -ax, -az, 5);
      crashFx.debris(ex, ey, ez, 1, 0x9aa2ab, 2);
    }
    if (spec.soak && Math.random() < 0.3) crashFx.debris(ex, ey, ez, 2, 0x8fd8ff, 3);
    // Shooting in town is noticed. Water much less so.
    if (cands.some((c) => c.kind !== "tree")) crime(spec.soak ? 0.005 : 0.03);
    const tr = tracers[tracerNext];
    tracerNext = (tracerNext + 1) % tracers.length;
    tr.t = 0;
    tr.mesh.visible = true;
    tr.mesh.material = tracerMats[kind];
    tr.mesh.position.set(ox, oy, oz);
    tr.mesh.scale.set(spec.thick, spec.thick, Math.max(0.5, Math.hypot(ex - ox, ey - oy, ez - oz)));
    tr.mesh.lookAt(ex, ey, ez);
    if (!spec.soak) {
      flash.position.set(ox, oy, oz);
      flash.visible = true;
      flashT = 0;
    }
    bang(kind);
  };

  // ---- Pineapple bombs -------------------------------------------------
  //
  // Thrown in an arc. The first moving thing it touches (a cruiser or a car)
  // it sticks to, and it rides along hurting it a little every second until
  // the fuse runs out and it pops. Anything else it lands on, it sits on.
  // Neither the tick nor the pop is a one-shot by design: a fresh cruiser
  // survives a short fuse, a long one finishes it.
  const bombs: Bomb[] = [];
  let pops = 0;
  let lastCtx: MayhemCtx | null = null;
  const MAX_BOMBS = 9;

  const throwBomb = () => {
    const ctx = lastCtx;
    if (!ctx || !hasBombs || bombsInHand <= 0 || throwCool > 0 || bombs.length >= MAX_BOMBS) return;
    throwCool = 0.45;
    bombsInHand--;
    if (regrow <= 0) regrow = BOMB_REGROW;
    const d = ctx.driving;
    const yaw = d ? d.yaw : ctx.yaw;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const ox = d ? d.x + fx * 2.6 : ctx.player.x + fx * 0.6;
    const oy = d ? d.y + 1.6 : ctx.player.y + 1.5;
    const oz = d ? d.z + fz * 2.6 : ctx.player.z + fz * 0.6;
    const carry = d ? Math.max(0, d.speed) : 0;
    const mesh = buildPineapple();
    mesh.scale.setScalar(1.6);
    group.add(mesh);
    bombs.push({
      mesh, x: ox, y: oy, z: oz,
      vx: fx * (14 + carry), vy: 6.5, vz: fz * (14 + carry),
      stuck: null, ox: 0, oy: 0, oz: 0,
      fuse: bombFuse(Math.random()), age: 0,
    });
    crime(0.05);
  };

  const removeBomb = (i: number) => {
    const b = bombs[i];
    group.remove(b.mesh);
    b.mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
    bombs.splice(i, 1);
  };

  const pop = (b: Bomb) => {
    pops++;
    crashFx.explode(b.x, b.y, b.z, 1, 0xffc23d);
    crashFx.debris(b.x, b.y, b.z, 8, 0xe8b62c, 6);
    crashFx.kick(0.25);
    traffic.blast(b.x, b.z, 5, 9);
    smash.blast(b.x, b.z, 4, 9);
    opts.onBlast(b.x, b.z, 4);
    opts.boom?.(b.x, b.z);
    const st = b.stuck;
    if (st?.kind === "cop") hurtCop(st.cop, BOMB_POP);
    else if (st?.kind === "car") traffic.damage(st.id, BOMB_POP);
    for (const c of cops) {
      if (c.dead > 0 || (st?.kind === "cop" && st.cop === c)) continue;
      const d = Math.hypot(c.x - b.x, c.z - b.z);
      if (d < 5) hurtCop(c, 25 * (1 - d / 5));
    }
    crime(0.4);
  };

  const carPos = (id: number, x: number, z: number) =>
    traffic.debugNear(x, z, 12).find((c) => c.id === id) ?? null;

  const updateBombs = (dt: number, blocked: (x: number, z: number, y: number) => boolean, ctx: MayhemCtx) => {
    const floor = ctx.inCity ? 0 : ctx.player.y;
    for (let i = bombs.length - 1; i >= 0; i--) {
      const b = bombs[i];
      b.age += dt;
      const st = b.stuck;
      if (!st) {
        b.vy -= 20 * dt;
        const nx = b.x + b.vx * dt;
        const ny = b.y + b.vy * dt;
        const nz = b.z + b.vz * dt;
        // Something moving to stick to?
        let hit = false;
        for (const c of cops) {
          if (c.dead > 0) continue;
          if (Math.hypot(c.x - nx, c.z - nz) < 1.9 && ny < 2.2) {
            b.stuck = { kind: "cop", cop: c };
            b.ox = nx - c.x;
            b.oy = Math.max(0.9, Math.min(1.6, ny));
            b.oz = nz - c.z;
            hit = true;
            break;
          }
        }
        if (!hit) {
          // Generous on purpose: a lobbed pineapple that clips a bonnet
          // should stick, not bounce off a box a hand's width too small.
          let car: { id: number; x: number; y: number; z: number } | null = null;
          let best = 2.2;
          for (const c of traffic.debugNear(nx, nz, 4)) {
            if (c.wreck || ny > c.y + 2) continue;
            const d = Math.hypot(c.x - nx, c.z - nz);
            if (d < best) {
              best = d;
              car = c;
            }
          }
          if (car) {
            const id = car.id;
            b.stuck = { kind: "car", id };
            b.ox = nx - car.x;
            b.oy = Math.max(0.9, ny - car.y);
            b.oz = nz - car.z;
            hit = true;
          }
        }
        if (!hit) {
          if (blocked(nx, nz, ny)) {
            // A wall: drop down it.
            b.vx *= -0.2;
            b.vz *= -0.2;
          } else {
            b.x = nx;
            b.z = nz;
          }
          b.y = ny;
          if (b.y <= floor + 0.15) {
            b.y = floor + 0.15;
            b.stuck = { kind: "ground" };
          } else if (b.age > 6) {
            b.stuck = { kind: "ground" };
          }
        }
        b.mesh.rotation.x += dt * 9;
        b.mesh.rotation.z += dt * 5;
      } else {
        // Ride along, and hurt.
        if (st.kind === "cop") {
          const c = st.cop;
          if (!cops.includes(c) || c.dead > 0) {
            b.stuck = { kind: "ground" };
            b.y = floor + 0.15;
          } else {
            b.x = c.x + b.ox;
            b.y = b.oy;
            b.z = c.z + b.oz;
            hurtCop(c, BOMB_DPS * dt);
          }
        } else if (st.kind === "car") {
          const car = carPos(st.id, b.x, b.z);
          if (!car || car.wreck) {
            b.stuck = { kind: "ground" };
            b.y = floor + 0.15;
          } else {
            b.x = car.x + b.ox;
            b.y = car.y + b.oy;
            b.z = car.z + b.oz;
            traffic.damage(st.id, BOMB_DPS * dt);
          }
        }
        b.fuse -= dt;
        // Blinks faster as it gets close.
        const blink = b.fuse < 3 ? 14 : 4;
        b.mesh.scale.setScalar(1.6 * (1 + 0.12 * Math.max(0, Math.sin(clock * blink))));
      }
      b.mesh.position.set(b.x, b.y, b.z);
      if (b.stuck && b.fuse <= 0) {
        pop(b);
        removeBomb(i);
      }
    }
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
      const order: Array<GunKind | null> = [null, "glock", "water", "blaster", "rifle"];
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

      lastCtx = ctx;
      // The rifle spins, bobs, and gets collected.
      {
        const p = rifleUp;
        const s = spots.rifle;
        if (p.visible && s) {
          p.rotation.y += dt * 1.6;
          p.position.y = s[1] + Math.sin(clock * 2.2) * 0.15;
          const sprite = p.children[p.children.length - 1] as THREE.Sprite;
          sprite.scale.setScalar(1.4 + Math.sin(clock * 4) * 0.4);
          const dy = Math.abs(ctx.player.y + 0.9 - s[1]);
          if (!ctx.driving && dy < 2.2 && Math.hypot(ctx.player.x - s[0], ctx.player.z - s[2]) < 2.2) {
            owned.add("rifle");
            saveOwned();
            p.visible = false;
            gun = "rifle";
            opts.onPickup("rifle");
          }
        }
      }
      // The stall: its stock turns, and standing at it opens the counter.
      if (stallAt) {
        stall.display.children.forEach((m, i) => {
          m.rotation.y = clock * 1.2 + i;
        });
        atStall = !ctx.driving && Math.abs(ctx.player.y - stallAt[1]) < 3 &&
          Math.hypot(ctx.player.x - stallAt[0], ctx.player.z - stallAt[2]) < 6;
      }

      // Pineapples.
      throwCool = Math.max(0, throwCool - dt);
      if (hasBombs && bombsInHand < BOMB_PACK) {
        regrow -= dt;
        if (regrow <= 0) {
          bombsInHand++;
          regrow = bombsInHand < BOMB_PACK ? BOMB_REGROW : 0;
        }
      }
      if (ctx.throwing) throwBomb();
      updateBombs(dt, blocked, ctx);

      // The gun in your hand, and the trigger.
      for (const k of ALL_GUNS) inHand[k].visible = gun === k && !ctx.driving;
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
        if (t.t > (t.mesh.material === tracerMats.blaster ? 0.09 : 0.06)) t.mesh.visible = false;
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
        if (c.soaked > 0) c.soaked -= dt;
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
        stall: stallAt,
        shots,
        hits,
        bombs: bombs.map((b) => ({
          x: b.x, y: b.y, z: b.z, fuse: b.fuse,
          stuck: b.stuck ? (b.stuck.kind === "car" ? `car:${b.stuck.id}` : b.stuck.kind) : null,
        })),
        pops,
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
      if (kind === "rifle") {
        saveOwned();
        rifleUp.visible = false;
      }
      gun = kind;
      hud();
    },
    setBought(ids) {
      for (const k of BOUGHT_GUNS) {
        if (ids.includes(k)) owned.add(k);
        else owned.delete(k);
      }
      if (gun && !owned.has(gun)) gun = null;
      const had = hasBombs;
      hasBombs = ids.includes("pineapple");
      if (hasBombs && !had) bombsInHand = BOMB_PACK;
      hud();
    },
    throwBomb,
    shootFrom(kind, x, y, z, yaw) {
      const blocked = opts.blocked();
      if (blocked) shoot(blocked, kind, x, y, z, yaw);
    },
    throwFrom(x, y, z, yaw, speed = 14) {
      const mesh = buildPineapple();
      mesh.scale.setScalar(1.6);
      group.add(mesh);
      bombs.push({
        mesh, x, y, z, vx: Math.sin(yaw) * speed, vy: 4, vz: Math.cos(yaw) * speed,
        stuck: null, ox: 0, oy: 0, oz: 0, fuse: bombFuse(Math.random()), age: 0,
      });
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
      while (bombs.length) removeBomb(bombs.length - 1);
      for (const k of ALL_GUNS) opts.hand.remove(inHand[k]);
      tracerGeo.dispose();
      tracerMat.dispose();
      tracerMats.water.dispose();
      tracerMats.blaster.dispose();
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
