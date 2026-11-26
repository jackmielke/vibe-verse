/**
 * traffic — the cars in Vibe City, and the rules they obey.
 *
 * ## What was here before
 *
 * `BoxGeometry(1.8, 1.25, 4.2)` in an InstancedMesh, sliding along street
 * centrelines at a constant speed and wrapping at the far edge. No wheels, no
 * lights, no collision, and cross traffic drove straight through itself at
 * every junction. The comment in `district.ts` defended it honestly: from any
 * altitude where you can see the grid, you cannot see that nobody is turning.
 *
 * That was true while the city was a thing you flew over. It stopped being true
 * the moment anybody stood on the pavement, which is where the boxes read as
 * exactly what they are.
 *
 * ## What it is now
 *
 * The bodies are **Vibe Kart's** — the same `buildKart` the racing game uses,
 * so the city gets that chassis, those wheels and those lights for free. That
 * was the cheap half: the builder only wants a `KartStyle` and a bag of
 * materials, so none of the race engine, its material desk, its livery baker or
 * its `KartCtx` has to come with it.
 *
 * The expensive half is that there are sixty of them. A dressed kart is about a
 * dozen draw calls, so sixty built individually would cost more than the entire
 * district. Instead each *model* is built exactly once and every car using it is
 * an instance: one `InstancedMesh` per material bucket per model, so the whole
 * fleet is about forty draws however many cars are in it. Wheels are instanced
 * across the fleet in two more, and they turn.
 *
 * ## The rules
 *
 * Cars keep right, brake for the car in front, stop at red lights, and — the
 * one that matters in a game where you can walk into the road — stand on the
 * brakes for the player. They are also **solid**: each car pushes a live
 * `WorldBox` into the world's collision array every frame, so you can be
 * stopped by one and can climb on one. `CollisionWorld` holds that array by
 * reference precisely so worlds can do this.
 *
 * Cars are axis-aligned by construction — they only ever drive along X or Z on
 * a grid — so an AABB is not an approximation of the body, it is exact.
 */
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";
import { buildKart, TYRE_BASE } from "@/kart/models/kart";
import { mergeAll } from "@/kart/models/geometry";
import type { CharacterKit, ModelQuality, RigMaterials } from "@/kart/models/materials";
import type { KartStyle } from "@/kart/models/roster";
import type { PropKind, Smashables } from "./smash";

// ---------------------------------------------------------------------------
// The fleet
// ---------------------------------------------------------------------------

interface CarModel {
  style: KartStyle;
  body: number;
  accent: number;
  trim: number;
  /** Relative frequency in the fleet. */
  weight: number;
}

function style(o: {
  scale: number;
  width: number;
  ride: number;
  nose: KartStyle["nose"];
  spoiler: KartStyle["spoiler"];
  engine: KartStyle["engine"];
  /** [frontRadius, rearRadius, frontWidth, rearWidth, spokes, twist] */
  wheels: [number, number, number, number, number, number];
}): KartStyle {
  const [fr, rr, fw, rw, spokes, twist] = o.wheels;
  return {
    scale: o.scale,
    width: o.width,
    ride: o.ride,
    nose: o.nose,
    spoiler: o.spoiler,
    engine: o.engine,
    // Always the hoop. The cage and the twin bars are racing kit and they are
    // the single loudest thing on the model — a commuter fleet wearing them
    // reads as a demolition derby that took a wrong turn.
    rollbar: "hoop",
    livery: "plate",
    wheels: { frontRadius: fr, rearRadius: rr, frontWidth: fw, rearWidth: rw, spokes, twist },
  };
}

/**
 * Four commuter models.
 *
 * Vibe Kart styles with the racing turned down: ducktails rather than double
 * wings, hoops rather than cages, and wheels near enough the same size front
 * and rear. Four rather than six because the count is a draw-call budget —
 * every model is ~10 instanced meshes whether one car uses it or twenty.
 *
 * The *proportions* are where a kart becomes a car, and they look wrong written
 * down. `scale` runs about 1.8 against the roster's 0.9–1.2, and `width` about
 * 0.54 against its 0.9–1.15 — but those two multiply into the body's length and
 * breadth separately, so what comes out is 4.2 m long and 1.8 m across instead
 * of the roster's 2.3 × 2.2 m go-kart. Wheels stay near 0.32 m radius because
 * that number is absolute rather than scaled, and 64 cm is a real car's wheel.
 * Set them to "sensible-looking" values and you get a saloon on trolley
 * castors.
 *
 * The colours are what say "city" rather than "circuit": municipal white, taxi
 * yellow, a dark saloon, and one red one because a street where every car is
 * grey reads as a car park.
 */
const MODELS: CarModel[] = [
  {
    style: style({ scale: 1.78, width: 0.54, ride: 0.8, nose: "snub", spoiler: "ducktail", engine: "boxer", wheels: [0.32, 0.32, 0.24, 0.26, 5, 0.2] }),
    body: 0xe8e9ea, accent: 0x9aa2ab, trim: 0x2c3138, weight: 4,
  },
  {
    style: style({ scale: 1.82, width: 0.55, ride: 0.84, nose: "snub", spoiler: "ducktail", engine: "boxer", wheels: [0.33, 0.33, 0.25, 0.27, 6, 0.1] }),
    body: 0xf2b418, accent: 0x25292e, trim: 0xf2f4f6, weight: 2,
  },
  {
    style: style({ scale: 1.92, width: 0.55, ride: 0.78, nose: "wedge", spoiler: "ducktail", engine: "twin", wheels: [0.32, 0.34, 0.24, 0.28, 8, 0.3] }),
    body: 0x272d36, accent: 0x3b444f, trim: 0xb9c0c8, weight: 4,
  },
  {
    style: style({ scale: 1.66, width: 0.53, ride: 0.76, nose: "bullet", spoiler: "fin", engine: "twin", wheels: [0.3, 0.32, 0.23, 0.27, 5, 0.45] }),
    body: 0xc0392b, accent: 0x2a2f36, trim: 0xe6e8ea, weight: 2,
  },
];

/**
 * Materials for one model.
 *
 * Deliberately not the race game's `MaterialDesk`. That wants a whole
 * `KartCtx` — services, a quality tier, an environment map to re-point every
 * frame — and pays for a per-character livery bake the city has no use for.
 * `buildKart` reads exactly seven of the kit's materials and four of the rig's;
 * the rest of both interfaces belongs to the driver, who is not coming.
 *
 * Those unread fields still have to be *present* to satisfy the types, and the
 * honest way to fill them is with a real material rather than a cast — except
 * `face` and `headTexture`, which are a baked atlas and its texture. Nothing
 * here can produce those and nothing here reads them, so they are cast, and
 * this paragraph is the record of why.
 */
function cityCarMaterials(m: CarModel): { kit: CharacterKit; rig: RigMaterials; owned: THREE.Material[] } {
  const owned: THREE.Material[] = [];
  const std = (p: THREE.MeshStandardMaterialParameters) => {
    const mat = new THREE.MeshStandardMaterial(p);
    owned.push(mat);
    return mat;
  };
  const unused = std({ color: 0x808080 });
  const kit: CharacterKit = {
    paint: std({ color: m.body, roughness: 0.36, metalness: 0.35 }),
    accent: std({ color: m.accent, roughness: 0.42, metalness: 0.3 }),
    trim: std({ color: m.trim, roughness: 0.5, metalness: 0.15 }),
    chrome: std({ color: 0xd6dbe0, roughness: 0.18, metalness: 1 }),
    rubber: std({ color: 0x16181c, roughness: 0.85, metalness: 0 }),
    dark: std({ color: 0x1b1f25, roughness: 0.68, metalness: 0.2 }),
    rim: std({ color: 0xb9c1c9, roughness: 0.3, metalness: 0.85 }),
    glass: std({ color: 0x9fc4d6, roughness: 0.1, metalness: 0 }),
    outfit: unused,
    gear: unused,
    cloth: unused,
    face: null as unknown as CharacterKit["face"],
  };
  const rig: RigMaterials = {
    head: unused as THREE.MeshStandardMaterial,
    headTexture: null as unknown as THREE.Texture,
    plate: std({ color: 0xe9e4d5, roughness: 0.7 }),
    // Brake lights are driven per car, so each model owns its own instance of
    // this material and the whole fleet of that model brakes together. That is
    // wrong, and it is the compromise instancing buys: the alternative is a
    // material per car, which is a draw call per car.
    brake: std({ color: 0x6d1512, emissive: 0xc9291c, emissiveIntensity: 0.55, roughness: 0.4 }),
    headlight: std({ color: 0xfff6dd, emissive: 0xfff0c8, emissiveIntensity: 0.9, roughness: 0.2 }),
    exhaust: std({ color: 0x40464e, roughness: 0.55, metalness: 0.6 }),
  };
  return { kit, rig, owned };
}

/**
 * Model detail.
 *
 * `frills: false` folds the third paint colour into the accent bucket and drops
 * the chrome hub caps — one fewer draw call per model for a difference nobody
 * sees on a car going past at 12 m/s. Shadows stay on: a car that does not put
 * a shadow on the road is a car hovering over it.
 */
const CAR_QUALITY: ModelQuality = {
  tier: "medium",
  faceCell: 64,
  liverySize: 64,
  plateSize: 64,
  livery: false,
  detail: 0.75,
  castShadows: true,
  frills: false,
};

/**
 * The greenhouse — roof, pillars and glass.
 *
 * This is the one part Vibe Kart cannot lend, because a kart does not have one.
 * `buildKart` builds an open cockpit, and an empty open-top kart rolling down a
 * high street at 12 m/s does not read as a car — it reads as a kart somebody
 * has lost.
 *
 * It is measured off the finished **body** panel rather than off the style
 * numbers or the whole assembly's bounds. Off the style numbers means
 * re-deriving the builder's own arithmetic, which produced a roof that floated
 * on the tall models. Off the whole assembly means measuring the roll hoop,
 * which stands 1.7 m up and would put the roof at the height of a transit van.
 * The painted shell tops out at the belt line, which is exactly the number a
 * cabin wants.
 *
 * Local space matches the kart: −Z is forward, y = 0 is the road.
 */
function buildCabin(body: THREE.Box3): {
  shell: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  roofY: number;
} {
  const halfW = Math.max(body.max.x, -body.min.x);
  const beltY = body.max.y;
  // 0.74 m of glasshouse over the belt clears the seat backs (which top out
  // around 1.43 m on the larger models) and lands the roof at about 1.5 m,
  // which is a saloon.
  const roofY = beltY + 0.74;
  const cw = halfW * 0.96;
  const cFront = body.min.z * 0.4;
  const cBack = body.max.z * 0.62;

  const shell: THREE.BufferGeometry[] = [];

  // Roof panel, inset from the pillars so the pillar tops are proud of it.
  const roof = new THREE.BoxGeometry(cw * 1.92, 0.075, cBack - cFront);
  roof.translate(0, roofY, (cFront + cBack) / 2);
  shell.push(roof);

  // A- and C-pillars. Thin, and raked — the front pair lean back over the
  // windscreen, which is most of what stops a cabin looking like a shed.
  for (const sx of [-1, 1]) {
    for (const [z, rake] of [[cFront + 0.06, -0.42], [cBack - 0.06, 0.26]] as const) {
      const h = roofY - beltY;
      const p = new THREE.BoxGeometry(0.08, h / Math.cos(rake), 0.11);
      p.rotateX(rake);
      p.translate(sx * (cw - 0.03), (beltY + roofY) / 2, z + Math.sin(rake) * h * 0.5);
      shell.push(p);
    }
  }

  // Glass: one inset box. A car's glasshouse seen from outside is a single dark
  // shape, and separate panes buy nothing at the distance these are seen from.
  const glass = new THREE.BoxGeometry(
    cw * 1.86,
    roofY - beltY - 0.05,
    (cBack - cFront) * 0.95,
  );
  glass.translate(0, (beltY + roofY) / 2 - 0.01, (cFront + cBack) / 2);

  return { shell: mergeAll(shell), glass, roofY };
}

// ---------------------------------------------------------------------------
// The simulation
// ---------------------------------------------------------------------------

interface Car {
  model: number;
  /** 0 = travels along Z (its lane is an X), 1 = travels along X. */
  axis: 0 | 1;
  dir: 1 | -1;
  /** The fixed cross-street coordinate of this car's lane. */
  lane: number;
  /** Index into `centrelines` of the street this car is driving down. */
  laneIndex: number;
  /** Position along the axis of travel. */
  t: number;
  speed: number;
  cruise: number;
  /** Radians of wheel rotation, so the tyres turn at the rate they roll. */
  spin: number;
  halfLong: number;
  halfWide: number;
  height: number;
  box: WorldBox;
  /** Slot in its model's instanced meshes. */
  slot: number;
  /**
   * Somebody is driving this one. It leaves the AI entirely: no lane queue, no
   * signals, no collision box, and its pose comes from `drive()` instead of
   * from `t`. A car cannot block its own driver.
   */
  driven: boolean;
  /**
   * Knocked out of its lane, and flying.
   *
   * Traffic is otherwise entirely lane-space: a car's position is `lane` and
   * `t`, its heading falls out of `axis` and `dir`, and it is level by
   * construction. That is why the fleet is cheap and why every car is always
   * exactly where it should be — and it is also why running into one used to
   * stop you dead against what was, as far as the physics was concerned, a
   * building. There is nowhere in lane-space to put "tumbling through the air
   * sideways".
   *
   * So a hit car leaves lane-space entirely for a few seconds and comes back.
   * Null for the ninety-odd cars that are behaving.
   */
  hit: {
    x: number; y: number; z: number;
    vx: number; vy: number; vz: number;
    yaw: number; pitch: number; roll: number;
    spinY: number; spinP: number; spinR: number;
    /** Seconds since the hit; it rejoins the road after settling. */
    t: number;
  } | null;
  /** Seconds until this car can bowl the player over again. */
  hitCool: number;
  /** 0 to 100. At 100 it goes up. See `explode`. */
  dmg: number;
  /**
   * Seconds since it was wrecked (burnt out or crushed), 0 for a working car.
   * A wreck stays where it stopped, solid and smoking, until nobody is
   * watching, and then it is towed: it rejoins the fleet as a fresh car.
   */
  wreck: number;
  /** Flattened by a monster truck. Squashes the pose and lowers the box. */
  crushed: boolean;
  /** Seconds until this car can trade another bump with a car. */
  bumpCool: number;
  /** Seconds left of a skid: a bot that lost it, sliding on low grip. */
  skid: number;
}

/** Something hit something. For sound and effects; nothing here needs an answer. */
export interface CrashEvent {
  kind: "car" | "wall" | "prop" | "explode" | "crush" | "skid";
  x: number;
  y: number;
  z: number;
  /** Roughly the closing speed, m/s. */
  strength: number;
  /** The car involved, when there is one. */
  id?: number;
  prop?: PropKind;
}

/** A car you can get into, or are already in. */
export interface TrafficRide {
  id: number;
  x: number;
  z: number;
  yaw: number;
  /** Half-extents and roof height, for seating a driver and aiming a camera. */
  halfLong: number;
  halfWide: number;
  roofY: number;
}

export interface Traffic {
  group: THREE.Group;
  /**
   * Drive the fleet.
   *
   * `player` is read for two things: cars brake for it, and a player who has
   * ended up *inside* a car is pushed back out — so the vector is MUTATED.
   * That is deliberate. Braking alone cannot cover every case (you can jetpack
   * down into a moving lane), and a player standing inside a solid box has
   * every direction blocked and cannot walk out. Pass null to skip both.
   */
  update(dt: number, player: THREE.Vector3 | null): void;
  /**
   * The nearest car close enough and slow enough to get into, or null.
   *
   * "Slow enough" is the interesting half. You cannot leap into a car doing
   * 12 m/s — but you never have to wait for a red light either, because cars
   * already brake for anybody standing in the road. Step off the kerb, the next
   * one stops for you, and now it is under the threshold. That flow was not
   * designed; it fell out of the braking rule.
   */
  nearestRidable(x: number, z: number, radius: number): TrafficRide | null;
  /** Take the wheel. The car leaves the fleet and stops colliding with you. */
  claim(id: number): TrafficRide | null;
  /**
   * The id of the car occupying this point, or -1.
   *
   * `CollisionWorld` can already say that something is in the way, but not
   * what — and a kart needs to know, because bouncing off a building and
   * bouncing off a Nissan should not be the same event.
   */
  carAt(x: number, z: number, y: number, pad?: number): number;
  /**
   * Knock a car out of its lane and into the air.
   *
   * `vx`/`vz` are the direction of the hit and are normalised here; `force` is
   * roughly the speed to send it away at. The car leaves the AI for a few
   * seconds, tumbles, lands, and rejoins the nearest lane on its own.
   */
  shove(id: number, vx: number, vz: number, force: number): void;
  /**
   * Called when a moving car catches a pedestrian.
   *
   * `dx`/`dz` is the car's direction of travel and `speed` is how fast it was
   * going. Registered rather than passed to `update` because the tick is
   * already wrapped by `district.update`, and threading a callback through two
   * signatures to reach one call site is worse than one setter.
   *
   * The alternative — traffic setting the player's velocity itself — would
   * mean this module knowing about jumping, coyote time and fall damage. It
   * knows about cars.
   */
  onPlayerHit(cb: (dx: number, dz: number, speed: number) => void): void;
  /**
   * Every car near a point, with whether it is currently airborne.
   *
   * For harnesses. A shove is a physics behaviour with no readable side
   * effect — the car looks the same, it is just somewhere else — so proving it
   * happened means watching a specific car's position over time, and there is
   * otherwise no way to ask about one.
   */
  debugNear(x: number, z: number, r: number): Array<{
    id: number; x: number; y: number; z: number; hit: boolean; speed: number;
    /** 0 = travelling along Z, 1 = along X. With `dir`, this is a heading. */
    axis: 0 | 1; dir: 1 | -1;
    dmg: number; wreck: boolean; crushed: boolean;
  }>;
  /**
   * Put the claimed car somewhere. The caller owns its pose until release.
   * `pitch`/`roll` default to level and are only ever non-zero for a car that
   * has left the road in a way it is not coming back from — sinking, so far.
   */
  drive(
    id: number, x: number, y: number, z: number, yaw: number,
    pitch?: number, roll?: number,
  ): void;
  /** Hand it back. It rejoins the lane nearest to where it was abandoned. */
  release(id: number): void;
  /** Hurt a car. At 100 it explodes. */
  damage(id: number, amount: number): void;
  /**
   * A car somebody was driving blows up under them. It leaves the driver,
   * stays exactly where it is (no snap to a lane), and burns as a wreck.
   * `yaw` is its heading in the fleet's own (−Z forward) convention.
   */
  detonate(id: number, yaw: number): void;
  /** Flatten a car under a monster truck. It becomes a wreck you can drive over. */
  crush(id: number): void;
  /** Throw every car near a point outward and hurt it. Chains, on purpose. */
  blast(x: number, z: number, r: number, force: number): void;
  /** Crashes, explosions and skids, as they happen. */
  onCrash(cb: (e: CrashEvent) => void): void;
  /** Wrecks still burning, for smoke. The array is reused. */
  burning(): ReadonlyArray<{ x: number; y: number; z: number; age: number }>;
  /** Bots sliding on the tarmac right now, for tyre smoke. The array is reused. */
  skidding(): ReadonlyArray<{ x: number; z: number; speed: number }>;
  /** Send a bot nearby into a skid right now. For harnesses. Returns its id or -1. */
  loseControl(near: { x: number; z: number } | null): number;
  /** How much has gone wrong so far. For harnesses. */
  stats(): { explosions: number; skids: number; wrecks: number; carCrashes: number; wallCrashes: number };
  dispose(): void;
}

/**
 * One city car as an ordinary group rather than an instance, in whatever
 * paint you like. The police use it: their cruisers are the same saloon as
 * everybody else, in black, so they read as part of the street until the
 * lights come on. Forward is +Z here (the fleet's own model faces −Z, so it
 * is turned round once inside), and y = 0 is the road.
 */
export function buildCityCar(paint: { body: number; accent: number; trim: number }, modelIndex = 2): {
  group: THREE.Group;
  roofY: number;
  halfLong: number;
  dispose(): void;
} {
  const model = { ...MODELS[modelIndex % MODELS.length], ...paint };
  const { kit, rig, owned } = cityCarMaterials(model);
  const asm = buildKart({ style: model.style, kit, rig, quality: CAR_QUALITY });
  const bodyBounds = new THREE.Box3();
  {
    const v = new THREE.Vector3();
    const src = asm.meshes.find((m) => m.name === "kart.body") ?? asm.meshes[0];
    const pos = src.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) bodyBounds.expandByPoint(v.fromBufferAttribute(pos, i));
  }
  // No roll hoop on a saloon; see the note where the fleet is built.
  for (const m of asm.meshes) if (m.name === "kart.chrome") m.removeFromParent();
  const cabin = buildCabin(bodyBounds);
  const glassMat = kit.glass as THREE.MeshStandardMaterial;
  glassMat.transparent = true;
  glassMat.opacity = 0.72;
  glassMat.color.set(0x1e2a33);
  asm.group.add(new THREE.Mesh(cabin.shell, kit.paint), new THREE.Mesh(cabin.glass, glassMat));
  asm.group.rotation.y = Math.PI;
  asm.group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });
  const group = new THREE.Group();
  group.add(asm.group);
  return {
    group,
    roofY: cabin.roofY,
    halfLong: asm.footprint.z + 0.2,
    dispose() {
      for (const g of asm.geometries) g.dispose();
      cabin.shell.dispose();
      cabin.glass.dispose();
      asm.tyres.dispose();
      asm.rims.dispose();
      asm.hubs?.dispose();
      for (const m of owned) m.dispose();
    },
  };
}

/** Signal cycle, seconds: axis 0 gets the first half, axis 1 the second. */
const CYCLE = 18;
const AMBER = 2.2;
/** Comfortable braking, m/s². Also what the following model plans against. */
const DECEL = 7;

export function buildTraffic(opts: {
  seed: string;
  grid: number;
  block: number;
  street: number;
  /** The world's live collision array. Cars add and update their own boxes. */
  boxes: WorldBox[];
  /** Fewer cars, lighter models, no shadows. */
  lowDetail?: boolean;
  /** Street furniture a flying car knocks over. */
  smash?: Smashables;
}): Traffic {
  const { grid, block, street, boxes, lowDetail = false, smash } = opts;
  const pitch = block + street;
  const centre = (grid - 1) / 2;
  const span = grid * pitch;
  const half = span / 2;

  // Deterministic, like the rest of the district.
  let seed = 0;
  for (let i = 0; i < opts.seed.length; i++) seed = (seed * 31 + opts.seed.charCodeAt(i)) >>> 0;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const group = new THREE.Group();
  group.name = "city/traffic";
  const trash: Array<{ dispose(): void }> = [];

  /** Street centrelines, shared by both axes. */
  const centrelines: number[] = [];
  for (let g = 1; g < grid; g++) centrelines.push((g - centre - 0.5) * pitch);

  const quality: ModelQuality = lowDetail
    ? { ...CAR_QUALITY, detail: 0.6, castShadows: false }
    : CAR_QUALITY;

  // -- the fleet, decided before anything is built --------------------------
  // Each model needs its instance count up front, and a car needs to know
  // which model it is before it can be given a size.

  const bag: number[] = [];
  MODELS.forEach((m, i) => {
    for (let k = 0; k < m.weight; k++) bag.push(i);
  });

  const cars: Car[] = [];
  /*
   * Cars per direction per street. Six over a 360 m street is one every 60 m,
   * which is a quiet weekday — two (where this started) is one every 180 m and
   * reads as a city that has been evacuated.
   */
  const perDir = lowDetail ? 3 : 6;
  centrelines.forEach((lane, laneIndex) => {
    for (const axis of [0, 1] as const) {
      for (const dir of [1, -1] as const) {
        for (let i = 0; i < perDir; i++) {
          cars.push({
            model: bag[Math.floor(rnd() * bag.length)],
            axis,
            dir,
            laneIndex,
            /*
             * Keep right. Facing along `dir`, the right-hand side is the offset
             * below — and it flips with the axis as well as the direction,
             * because "right" comes out of a cross product, not a sign. The old
             * traffic used `dir * 2.6` on both axes, which put one axis
             * permanently on the wrong side of its own road.
             */
            lane: lane + (axis === 0 ? -dir : dir) * (street * 0.22),
            t: rnd() * span - half,
            speed: 8 + rnd() * 4,
            cruise: 9.5 + rnd() * 4.5,
            spin: rnd() * Math.PI * 2,
            halfLong: 2,
            halfWide: 1,
            height: 1.3,
            box: { minX: 0, maxX: 0, minZ: 0, maxZ: 0, base: 0, height: 0 },
            slot: 0,
            driven: false,
            hit: null,
            hitCool: 0,
            dmg: 0,
            wreck: 0,
            crushed: false,
            bumpCool: 0,
            skid: 0,
          });
        }
      }
    }
  });

  // -- build one rig per model, instance it per car -------------------------

  interface Built {
    parts: THREE.InstancedMesh[];
    tyres: THREE.InstancedMesh;
    rims: THREE.InstancedMesh;
    wheels: Array<{ x: number; y: number; z: number; radius: number; width: number }>;
    cars: Car[];
  }

  const built: Built[] = MODELS.map((model, mi) => {
    const mine = cars.filter((c) => c.model === mi);
    const { kit, rig, owned } = cityCarMaterials(model);
    owned.forEach((m) => trash.push(m));
    const asm = buildKart({ style: model.style, kit, rig, quality });

    const count = Math.max(1, mine.length);
    const parts: THREE.InstancedMesh[] = [];
    const bodyBounds = new THREE.Box3();
    {
      const v = new THREE.Vector3();
      const src = asm.meshes.find((m) => m.name === "kart.body") ?? asm.meshes[0];
      const pos = src.geometry.getAttribute("position");
      for (let i = 0; i < pos.count; i++) bodyBounds.expandByPoint(v.fromBufferAttribute(pos, i));
    }

    for (const mesh of asm.meshes) {
      /*
       * The chrome bucket is the roll hoop, and the roll hoop stands 1.7 m up —
       * a third of a metre through the roof of any cabin a car would have. It
       * also carries the exhaust stacks, which a saloon does not have either.
       * Dropping the whole bucket is one fewer draw call and the only way to
       * get a closed roof out of an open-cockpit model.
       */
      if (mesh.name === "kart.chrome") continue;
      // Every bucket's geometry is already in kart-local space with the mesh
      // itself at the origin, so the instance matrix is the car's transform
      // and nothing else has to be baked in.
      const im = new THREE.InstancedMesh(mesh.geometry, mesh.material as THREE.Material, count);
      im.castShadow = mesh.castShadow;
      im.receiveShadow = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false; // one mesh, spread over the whole district
      parts.push(im);
      group.add(im);
    }

    // The greenhouse, fitted to the body that actually came out of the builder.
    const cabin = buildCabin(bodyBounds);
    {
      const glassMat = kit.glass as THREE.MeshStandardMaterial;
      glassMat.transparent = true;
      glassMat.opacity = 0.72;
      glassMat.color.set(0x1e2a33);
      glassMat.roughness = 0.1;
      glassMat.metalness = 0.2;
      for (const [geo, mat, shadow] of [
        [cabin.shell, kit.paint, true],
        [cabin.glass, glassMat, false],
      ] as const) {
        const im = new THREE.InstancedMesh(geo, mat, count);
        im.castShadow = shadow && quality.castShadows;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.frustumCulled = false;
        parts.push(im);
        group.add(im);
        trash.push(geo);
      }
    }

    // Four wheels per car in one mesh each for tyre and rim, so the fleet's
    // 400-odd wheels are two draw calls and can still turn.
    const tyres = new THREE.InstancedMesh(asm.tyres.geometry, kit.rubber, count * 4);
    const rims = new THREE.InstancedMesh(asm.rims.geometry, kit.rim, count * 4);
    for (const w of [tyres, rims]) {
      w.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      w.castShadow = quality.castShadows;
      w.receiveShadow = false;
      w.frustumCulled = false;
      group.add(w);
    }

    // The assembly's own group is thrown away — we only wanted its geometry —
    // but its wheel meshes hold instance buffers we never used.
    asm.tyres.dispose();
    asm.rims.dispose();
    asm.hubs?.dispose();
    for (const g of asm.geometries) trash.push(g);

    // `footprint` is the builder's half-extents of the shell; the wheels stand
    // slightly proud of it and the box has to cover them, or you can stand
    // inside a front wing. The height is the roof — measured, not guessed,
    // because that is the surface you land on when you jump onto a car.
    const halfWide = asm.footprint.x + 0.12;
    const halfLong = asm.footprint.z + 0.2;
    const height = cabin.roofY + 0.04;
    for (const c of mine) {
      c.halfWide = halfWide;
      c.halfLong = halfLong;
      c.height = height;
    }

    return { parts, tyres, rims, wheels: asm.wheels, cars: mine };
  });

  built.forEach((b) =>
    b.cars.forEach((c, i) => {
      c.slot = i;
      boxes.push(c.box);
    }),
  );
  /** Our own boxes, so a flying car does not bounce off itself or the fleet. */
  const carBoxes = new Set<WorldBox>(cars.map((c) => c.box));

  /*
   * Per-car tint, so one car can burn without the rest of its model doing so.
   * The colour buffer has to exist before the first compile — three only
   * switches a material to instance colours if it is there when it builds the
   * program — so every slot starts white, which is the identity.
   */
  const WHITE = new THREE.Color(1, 1, 1);
  const BURNT = new THREE.Color(0.16, 0.14, 0.13);
  const CRUSHED = new THREE.Color(0.55, 0.53, 0.52);
  for (const b of built) {
    for (const part of b.parts) for (let i = 0; i < part.count; i++) part.setColorAt(i, WHITE);
    for (const w of [b.tyres, b.rims]) for (let i = 0; i < w.count; i++) w.setColorAt(i, WHITE);
  }
  const tint = (car: Car, c: THREE.Color) => {
    const b = built[car.model];
    for (const part of b.parts) {
      part.setColorAt(car.slot, c);
      if (part.instanceColor) part.instanceColor.needsUpdate = true;
    }
  };

  // -- traffic signals -------------------------------------------------------

  /**
   * Which axis has a green at a junction, right now. −1 is amber, which counts
   * as "do not enter" for whichever axis is losing its green — that is what
   * stops a car committing to a junction it cannot clear.
   *
   * Every junction gets its own phase. A city where all sixty-four lights
   * change on the same beat does not read as a network, it reads as a fault.
   */
  const phaseOf = (i: number, j: number) => ((i * 7 + j * 13) % 9) * (CYCLE / 9);
  const greenAxis = (clock: number, i: number, j: number): 0 | 1 | -1 => {
    const t = (clock + phaseOf(i, j)) % CYCLE;
    if (t < CYCLE / 2 - AMBER) return 0;
    if (t < CYCLE / 2) return -1;
    if (t < CYCLE - AMBER) return 1;
    return -1;
  };

  const JUNCTIONS: Array<{ x: number; z: number; i: number; j: number }> = [];
  centrelines.forEach((x, i) => centrelines.forEach((z, j) => JUNCTIONS.push({ x, z, i, j })));

  /*
   * A signal is three lamps in a stack, not one lamp that changes colour.
   *
   * The single-lamp version was cheaper and read as a floating dot: at street
   * level you cannot tell a small red sphere from a small green one until you
   * are close enough that it no longer matters. Three lamps give it a shape, so
   * which one is lit is legible from the far end of the block — position is a
   * far stronger signal than hue, which is also why real ones are stacked.
   */
  const POLE_H = 4.6;
  const HEAD_Y = 3.9;
  const poleGeo = new THREE.CylinderGeometry(0.075, 0.1, POLE_H, 6);
  const poleMat = new THREE.MeshStandardMaterial({ color: "#333940", roughness: 0.6, metalness: 0.45 });
  const headGeo = new THREE.BoxGeometry(0.4, 1.15, 0.34);
  const lampGeo = new THREE.SphereGeometry(0.13, 10, 7);
  // `toneMapped: false` so a green light is the green it was authored as rather
  // than whatever ACES makes of it. These are read as signals, not lit as
  // surfaces.
  const lampMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  const poles = new THREE.InstancedMesh(poleGeo, poleMat, JUNCTIONS.length);
  const heads = new THREE.InstancedMesh(headGeo, poleMat, JUNCTIONS.length * 2);
  const lamps = new THREE.InstancedMesh(lampGeo, lampMat, JUNCTIONS.length * 2 * 3);
  poles.castShadow = quality.castShadows;
  heads.castShadow = quality.castShadows;
  lamps.frustumCulled = false;
  group.add(poles, heads, lamps);
  trash.push(poleGeo, poleMat, headGeo, lampGeo, lampMat);
  {
    const M = new THREE.Matrix4();
    const P = new THREE.Vector3();
    const Q = new THREE.Quaternion();
    const ONE = new THREE.Vector3(1, 1, 1);
    const UP = new THREE.Vector3(0, 1, 0);
    JUNCTIONS.forEach((j, n) => {
      // On the corner of the pavement, out of the carriageway.
      const cx = j.x + street * 0.44;
      const cz = j.z + street * 0.44;
      M.compose(P.set(cx, POLE_H / 2, cz), Q.identity(), ONE);
      poles.setMatrixAt(n, M);
      for (const axis of [0, 1] as const) {
        // The head on each axis faces the traffic it is stopping. Signals hang
        // on the far side of the junction from the driver, which is why they
        // face back down the road the car is arriving on.
        const yaw = axis === 0 ? 0 : Math.PI / 2;
        const ox = axis === 0 ? 0 : -0.22;
        const oz = axis === 0 ? -0.22 : 0;
        Q.setFromAxisAngle(UP, yaw);
        M.compose(P.set(cx, HEAD_Y, cz), Q, ONE);
        heads.setMatrixAt(n * 2 + axis, M);
        // Red on top, amber, green — the order everybody already knows.
        for (let k = 0; k < 3; k++) {
          M.compose(P.set(cx + ox, HEAD_Y + 0.36 - k * 0.36, cz + oz), Q, ONE);
          lamps.setMatrixAt((n * 2 + axis) * 3 + k, M);
        }
      }
    });
    poles.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    lamps.instanceMatrix.needsUpdate = true;
  }
  /** Lit and unlit, per aspect. An unlit lens is dark, not absent. */
  const LIT = [new THREE.Color(0xf0402e), new THREE.Color(0xf7ad18), new THREE.Color(0x36dd6e)];
  const DIM = [new THREE.Color(0x3a1512), new THREE.Color(0x3a2c10), new THREE.Color(0x123a1e)];

  // -- driving ---------------------------------------------------------------

  const M = new THREE.Matrix4();
  const P = new THREE.Vector3();
  const Q = new THREE.Quaternion();
  const ONE = new THREE.Vector3(1, 1, 1);
  const SQUASH = new THREE.Vector3(1.08, 0.42, 1.04);
  const WSCALE = new THREE.Vector3();
  const WQ = new THREE.Quaternion();
  const WE = new THREE.Euler();
  const WP = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  /** Only used by a car that is not level — see `pose`. */
  const PE = new THREE.Euler();
  const SIG = new THREE.Color();

  /** Wrap a signed along-axis delta into (−half, +half]. */
  const wrap = (d: number) => (d > half ? d - span : d < -half ? d + span : d);

  /*
   * Cars grouped by the lane they are in, so a car only ever looks at the
   * handful it could actually run into.
   *
   * The obvious version compares every car with every other one, which at 192
   * cars is 37,000 comparisons a frame for an answer that can only ever come
   * from one of five. Bucketing is a one-line build and turns the per-frame
   * cost from quadratic into linear.
   */
  const laneKey = (c: Car) => `${c.axis}:${c.dir}:${c.laneIndex}`;
  const lanes = new Map<string, Car[]>();
  for (const c of cars) {
    const k = laneKey(c);
    const list = lanes.get(k);
    if (list) list.push(c);
    else lanes.set(k, [c]);
  }

  /** Clear distance from this car's nose to whatever is in front of it. */
  const clearAhead = (car: Car, player: THREE.Vector3 | null): number => {
    let best = Infinity;
    for (const other of lanes.get(laneKey(car)) ?? []) {
      // A driven car's `t` is stale — its real position comes from `drive()`.
      // Other cars still brake for it, through the `player` check below, which
      // is the same point in space while somebody is at the wheel.
      // A knocked car's `t` is as stale as a driven one's — it is off in the
      // air somewhere — so queueing behind where it used to be would leave a
      // line of cars stopped for nothing in the middle of an empty street.
      if (other === car || other.driven || other.hit) continue;
      const d = wrap((other.t - car.t) * car.dir) - car.halfLong - other.halfLong;
      if (d > -0.5 && d < best) best = d;
    }
    // Wrecks and cars in the air, where they really are. Without this a
    // pile-up never ends: every car down the street drives into the wreck.
    for (const other of flying) {
      // A car in this list can have rejoined the road earlier this frame.
      const h = other.hit;
      if (other === car || !h) continue;
      const along = car.axis === 0 ? h.z : h.x;
      const across = car.axis === 0 ? h.x : h.z;
      if (Math.abs(across - car.lane) > 2.6) continue;
      const d = wrap((along - car.t) * car.dir) - car.halfLong - other.halfLong;
      if (d > -0.5 && d < best) best = d;
    }
    if (player) {
      const along = car.axis === 0 ? player.z : player.x;
      const across = car.axis === 0 ? player.x : player.z;
      // Only while they are actually down in the road — not on a rooftop above
      // it, and not on the island 120 m up.
      if (Math.abs(across - car.lane) < 2.3 && player.y > -3 && player.y < 3) {
        const d = wrap((along - car.t) * car.dir) - car.halfLong - 0.6;
        if (d > -0.5 && d < best) best = d;
      }
    }
    return best;
  };

  /** Clear distance from the nose to the next stop line the car must obey. */
  const clearToStopLine = (car: Car, clock: number): number => {
    let nearest = Infinity;
    let nearestIdx = -1;
    for (let k = 0; k < centrelines.length; k++) {
      const d = wrap((centrelines[k] - car.t) * car.dir);
      if (d <= 0) continue;
      if (d < nearest) {
        nearest = d;
        nearestIdx = k;
      }
    }
    if (nearestIdx < 0) return Infinity;
    const [i, j] = car.axis === 0 ? [car.laneIndex, nearestIdx] : [nearestIdx, car.laneIndex];
    if (greenAxis(clock, i, j) === car.axis) return Infinity;
    // Stop short of the junction box rather than in it.
    return nearest - (street / 2 + car.halfLong + 0.7);
  };

  let clock = 0;

  /** Set by `onPlayerHit`. Null until somebody cares about being run over. */
  let onPlayerHit: ((dx: number, dz: number, speed: number) => void) | null = null;
  let onCrash: ((e: CrashEvent) => void) | null = null;
  const emit = (e: CrashEvent) => onCrash?.(e);
  const counts = { explosions: 0, skids: 0, wrecks: 0, carCrashes: 0, wallCrashes: 0 };
  /** Cars currently out of lane-space: knocked, skidding or wrecked. Rebuilt every frame. */
  const flying: Car[] = [];
  const burningOut: Array<{ x: number; y: number; z: number; age: number }> = [];
  const skidOut: Array<{ x: number; z: number; speed: number }> = [];
  /** Seconds until the next bot loses it. */
  let nextSkid = 6 + rnd() * 6;

  const headingYaw = (car: Car) =>
    car.axis === 0 ? (car.dir > 0 ? Math.PI : 0) : car.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
  const laneXZ = (car: Car) => ({
    x: car.axis === 0 ? car.lane : car.t,
    z: car.axis === 0 ? car.t : car.lane,
  });

  /** Into free physics with this velocity. Adds to a flight already under way. */
  const launch = (
    car: Car, vx: number, vy: number, vz: number,
    spinY: number, spinP: number, spinR: number,
  ) => {
    if (car.hit) {
      const h = car.hit;
      h.vx += vx; h.vy += vy; h.vz += vz;
      h.spinY += spinY; h.spinP += spinP; h.spinR += spinR;
      return;
    }
    const { x, z } = laneXZ(car);
    car.hit = { x, y: 0, z, vx, vy, vz, yaw: headingYaw(car), pitch: 0, roll: 0, spinY, spinP, spinR, t: 0 };
    car.speed = 0;
    car.t = THREE.MathUtils.clamp(car.axis === 0 ? z : x, -half, half);
  };

  const explode = (car: Car) => {
    if (car.wreck > 0) return;
    const id = cars.indexOf(car);
    car.wreck = 1e-3;
    car.dmg = 100;
    counts.explosions++;
    counts.wrecks++;
    tint(car, BURNT);
    // Up it goes, end over end.
    launch(car, (rnd() - 0.5) * 3, 7.5, (rnd() - 0.5) * 3, (rnd() - 0.5) * 3, (rnd() - 0.5) * 4, (rnd() - 0.5) * 5);
    const h = car.hit!;
    emit({ kind: "explode", x: h.x, y: h.y + 0.8, z: h.z, strength: 30, id });
    blastAt(h.x, h.z, 9, 16, car);
    smash?.blast(h.x, h.z, 8, 14);
  };

  const hurt = (car: Car, amount: number) => {
    if (car.driven || car.wreck > 0 || amount <= 0) return;
    car.dmg += amount;
    if (car.dmg >= 100) explode(car);
  };

  const blastAt = (x: number, z: number, r: number, force: number, except: Car | null) => {
    for (const c of cars) {
      if (c === except || c.driven) continue;
      const p = c.hit ?? laneXZ(c);
      const dx = p.x - x;
      const dz = p.z - z;
      const d = Math.hypot(dx, dz);
      if (d > r) continue;
      const k = 1 - d / r;
      const nx = d > 0.01 ? dx / d : 1;
      const nz = d > 0.01 ? dz / d : 0;
      launch(c, nx * force * k, 3 + 6 * k, nz * force * k, (rnd() - 0.5) * 3 * k, (rnd() - 0.5) * 3 * k, (rnd() - 0.5) * 4 * k);
      // Chains, but each link is weaker than the last: a car next to the blast
      // takes 45, one at the edge barely anything.
      hurt(c, 45 * k);
    }
  };

  /**
   * A flying car meets a building. Back out along whichever axis it came in
   * on, bounce with most of the speed gone, and hurt.
   */
  const hitWalls = (car: Car, h: NonNullable<Car["hit"]>, px: number, pz: number) => {
    const r = Math.min(car.halfWide, car.halfLong) + 0.25;
    for (const b of boxes) {
      if (carBoxes.has(b)) continue;
      if (h.y >= b.height - 0.3 || h.y + car.height <= b.base) continue;
      if (h.x < b.minX - r || h.x > b.maxX + r || h.z < b.minZ - r || h.z > b.maxZ + r) continue;
      const wasInX = px >= b.minX - r && px <= b.maxX + r;
      let impact: number;
      if (!wasInX) {
        impact = Math.abs(h.vx);
        h.x = px;
        h.vx = -h.vx * 0.3;
      } else {
        impact = Math.abs(h.vz);
        h.z = pz;
        h.vz = -h.vz * 0.3;
      }
      h.vx *= 0.7;
      h.vz *= 0.7;
      if (impact > 2.5) {
        h.spinY += (rnd() - 0.5) * impact * 0.25;
        h.spinR += (rnd() - 0.5) * impact * 0.12;
        counts.wallCrashes++;
        emit({ kind: "wall", x: h.x, y: h.y + 0.6, z: h.z, strength: impact, id: cars.indexOf(car) });
        hurt(car, (impact - 2.5) * 9);
      }
      return;
    }
  };

  /** A flying car meets another car. Momentum is shared and both get hurt. */
  const hitCars = (car: Car, h: NonNullable<Car["hit"]>) => {
    if (car.bumpCool > 0) return;
    const sp = Math.hypot(h.vx, h.vz);
    if (sp < 2.5) return;
    const r = Math.min(car.halfWide, car.halfLong);
    for (const o of cars) {
      if (o === car || o.driven || o.bumpCool > 0) continue;
      const b = o.box;
      if (b.height < 0) continue;
      if (h.y > b.height) continue;
      if (h.x < b.minX - r || h.x > b.maxX + r || h.z < b.minZ - r || h.z > b.maxZ + r) continue;
      launch(o, h.vx * 0.65, 1.5 + sp * 0.12, h.vz * 0.65, (rnd() - 0.5) * sp * 0.2, sp * 0.03, (rnd() - 0.5) * sp * 0.08);
      h.vx *= 0.4;
      h.vz *= 0.4;
      h.spinY += (rnd() - 0.5) * sp * 0.2;
      car.bumpCool = o.bumpCool = 0.45;
      counts.carCrashes++;
      const oh = o.hit!;
      emit({ kind: "car", x: (h.x + oh.x) / 2, y: 0.8, z: (h.z + oh.z) / 2, strength: sp, id: cars.indexOf(o) });
      hurt(o, sp * 4.5);
      hurt(car, sp * 3);
      return;
    }
  };

  const update = (dt: number, player: THREE.Vector3 | null) => {
    clock += dt;

    // Lamps first. They read the same `greenAxis` the cars do, so what you see
    // is what they are obeying — a signal that disagrees with the traffic is
    // worse than no signal.
    JUNCTIONS.forEach((j, n) => {
      const g = greenAxis(clock, j.i, j.j);
      for (const axis of [0, 1] as const) {
        // Amber belongs to whichever axis is losing its green; the other one is
        // still on red and stays there.
        const aspect = g === axis ? 2 : g === -1 && greenAxis(clock - AMBER - 0.01, j.i, j.j) === axis ? 1 : 0;
        for (let k = 0; k < 3; k++) {
          SIG.copy(k === aspect ? LIT[k] : DIM[k]);
          lamps.setColorAt((n * 2 + axis) * 3 + k, SIG);
        }
      }
    });
    if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;

    flying.length = 0;
    burningOut.length = 0;
    skidOut.length = 0;
    for (const c of cars) {
      if (c.hit && !c.driven) flying.push(c);
      if (c.bumpCool > 0) c.bumpCool -= dt;
    }

    /*
     * Somebody loses it.
     *
     * Every so often a bot near the player overcooks it: it slews sideways
     * across the road on next to no grip and keeps going until something stops
     * it. That is a building, a lamp post, a row of trees or the car in the
     * next lane, which is how the city gets crashes you did not cause. Only
     * near the player, because a pile-up three blocks away is a pile-up
     * nobody sees.
     */
    nextSkid -= dt;
    if (nextSkid <= 0) {
      nextSkid = 7 + rnd() * 8;
      if (player && player.y < 6 && player.y > -3) loseControl(player);
    }

    for (const car of cars) {
      // A driven car is nobody's business but its driver's: `drive()` writes
      // its transform and its box stays collapsed.
      if (car.driven) continue;

      /**
       * Airborne after a hit: free physics, not lane physics.
       *
       * Everything below this block reads `lane`/`t` and writes a level,
       * axis-aligned pose. A car that has just been rammed is doing none of
       * those things, so it runs its own integration here and rejoins the
       * fleet when it has stopped moving.
       */
      if (car.hit) {
        const h = car.hit;
        h.t += dt;
        h.vy -= 22 * dt;
        const px = h.x;
        const pz = h.z;
        h.x += h.vx * dt;
        h.y += h.vy * dt;
        h.z += h.vz * dt;
        if (car.skid > 0) car.skid -= dt;
        if (car.wreck > 0) car.wreck += dt;
        hitWalls(car, h, px, pz);
        hitCars(car, h);
        if (smash && h.y < 1.6) {
          const sp = Math.hypot(h.vx, h.vz);
          if (sp > 3) {
            const fell = smash.hit(h.x, h.z, car.halfWide + 0.3, h.vx, h.vz, sp);
            if (fell.length) {
              h.vx *= 0.82;
              h.vz *= 0.82;
              hurt(car, 6 * fell.length);
              emit({ kind: "prop", x: fell[0].x, y: 1, z: fell[0].z, strength: sp, prop: fell[0].kind });
            }
          }
        }
        if (car.skid > 0 && h.y < 0.3) skidOut.push({ x: h.x, z: h.z, speed: Math.hypot(h.vx, h.vz) });
        if (car.wreck > 0 && car.wreck < 16 && !car.crushed) {
          burningOut.push({ x: h.x, y: h.y, z: h.z, age: car.wreck });
        }
        h.yaw += h.spinY * dt;
        h.pitch += h.spinP * dt;
        h.roll += h.spinR * dt;
        if (h.y <= 0) {
          // Down. Bounces once or twice, scrubbing hard — a car is not a ball.
          h.y = 0;
          h.vy = h.vy < -3 ? -h.vy * 0.28 : 0;
          // A skid is the same flight on next to no grip: it slides.
          const grip = Math.pow(car.skid > 0 ? 0.4 : 0.02, dt);
          h.vx *= grip;
          h.vz *= grip;
          // Rocks flat rather than stopping mid-roll, which would leave a car
          // parked at forty degrees in the middle of a junction.
          h.spinY *= Math.pow(0.05, dt);
          h.spinP *= Math.pow(0.002, dt);
          h.spinR *= Math.pow(0.002, dt);
          h.pitch *= Math.pow(0.02, dt);
          h.roll *= Math.pow(0.02, dt);
        }
        const still =
          Math.hypot(h.vx, h.vz) < 0.4 && Math.abs(h.vy) < 0.4 &&
          Math.abs(h.pitch) < 0.06 && Math.abs(h.roll) < 0.06;
        // Held a moment after it settles so it does not snap back to a lane
        // the instant it stops rolling, which reads as a glitch rather than as
        // the driver restarting and pulling away.
        /*
         * A wreck waits to be towed: long enough to be looked at, and then
         * only once you have driven away, with a deadline so parking next to
         * one forever does not keep it there forever.
         */
        const far = !player || Math.hypot(player.x - h.x, player.z - h.z) > 40;
        const towed = car.wreck === 0 || (car.wreck > 14 && (far || car.wreck > 60));
        const ready = towed && car.skid <= 0;
        if (still && h.t > 2.2) {
          if (ready) {
            car.lane = car.axis === 0 ? h.x : h.z;
            car.t = car.axis === 0 ? h.z : h.x;
            if (car.wreck > 0) {
              car.wreck = 0;
              car.crushed = false;
              tint(car, WHITE);
            }
            car.dmg = 0;
            rejoin(car);
            continue;
          }
        }
        pose(car, h.x, h.y, h.z, h.yaw, h.pitch, h.roll);
        const hx0 = car.axis === 0 ? car.halfWide : car.halfLong;
        const hz0 = car.axis === 0 ? car.halfLong : car.halfWide;
        car.box.minX = h.x - hx0;
        car.box.maxX = h.x + hx0;
        car.box.minZ = h.z - hz0;
        car.box.maxZ = h.z + hz0;
        car.box.base = 0;
        car.box.height = car.crushed ? car.height * 0.42 : car.height;
        continue;
      }
      /*
       * Target speed.
       *
       * `sqrt(2 · a · d)` is the speed from which you can still stop in `d`
       * metres at deceleration `a` — so a car approaching a queue or a red
       * light eases off early and rolls up to it, instead of running at cruise
       * until a fixed trigger distance and then stamping. A minus-one-metre
       * cushion keeps a stopped car a bonnet's length off the one in front.
       */
      const clear = Math.max(0, Math.min(clearAhead(car, player), clearToStopLine(car, clock)) - 1);
      const target = Math.min(car.cruise, Math.sqrt(2 * DECEL * clear));
      const rate = target > car.speed ? 4 : DECEL * 1.6;
      car.speed = Math.max(0, car.speed + THREE.MathUtils.clamp(target - car.speed, -rate * dt, rate * dt));

      car.t += car.speed * car.dir * dt;
      if (car.t > half) car.t -= span;
      else if (car.t < -half) car.t += span;

      // Too late to stop: something came down right in front of it.
      if (car.speed > 4 && car.bumpCool <= 0 && flying.length) {
        const cx = car.axis === 0 ? car.lane : car.t;
        const cz = car.axis === 0 ? car.t : car.lane;
        for (const o of flying) {
          const b = o.box;
          if (!o.hit || b.height < 0 || o.hit.y > b.height) continue;
          const r = car.halfWide;
          if (cx < b.minX - r || cx > b.maxX + r || cz < b.minZ - r || cz > b.maxZ + r) continue;
          const sp = car.speed;
          const hx = car.axis === 0 ? 0 : car.dir;
          const hz = car.axis === 0 ? car.dir : 0;
          launch(o, hx * sp * 0.6, 1.2, hz * sp * 0.6, (rnd() - 0.5) * 2, 0.3, (rnd() - 0.5) * 1);
          launch(car, hx * sp * 0.3, 1.6, hz * sp * 0.3, (rnd() - 0.5) * 3, sp * 0.04, (rnd() - 0.5) * 1.5);
          car.bumpCool = o.bumpCool = 0.45;
          counts.carCrashes++;
          emit({ kind: "car", x: cx, y: 0.8, z: cz, strength: sp, id: cars.indexOf(car) });
          hurt(car, sp * 4);
          hurt(o, sp * 3);
          break;
        }
        if (car.hit) continue;
      }
      // Rolling, not sliding: the tyre turns once per its own circumference.
      car.spin += (car.speed * dt) / 0.32;

      const x = car.axis === 0 ? car.lane : car.t;
      const z = car.axis === 0 ? car.t : car.lane;
      // Kart local space is −Z forward, so a car heading toward +z is turned
      // through 180°, not left at zero.
      const yaw =
        car.axis === 0
          ? car.dir > 0 ? Math.PI : 0
          : car.dir > 0 ? -Math.PI / 2 : Math.PI / 2;

      Q.setFromAxisAngle(UP, yaw);
      P.set(x, 0, z);
      M.compose(P, Q, ONE);
      const b = built[car.model];
      for (const part of b.parts) part.setMatrixAt(car.slot, M);

      for (let w = 0; w < b.wheels.length; w++) {
        const spec = b.wheels[w];
        WE.set(car.spin, 0, 0);
        WQ.setFromEuler(WE).premultiply(Q);
        WP.set(spec.x, spec.y, spec.z).applyQuaternion(Q).add(P);
        WSCALE.set(
          spec.width / TYRE_BASE.width,
          spec.radius / TYRE_BASE.radius,
          spec.radius / TYRE_BASE.radius,
        );
        M.compose(WP, WQ, WSCALE);
        b.tyres.setMatrixAt(car.slot * 4 + w, M);
        b.rims.setMatrixAt(car.slot * 4 + w, M);
      }

      // Collision. The long and wide half-extents swap with the axis of travel.
      const hx = car.axis === 0 ? car.halfWide : car.halfLong;
      const hz = car.axis === 0 ? car.halfLong : car.halfWide;
      car.box.minX = x - hx;
      car.box.maxX = x + hx;
      car.box.minZ = z - hz;
      car.box.maxZ = z + hz;
      car.box.base = 0;
      car.box.height = car.height;

      /*
       * Eject a player who is inside this car.
       *
       * Braking covers the common case, but not a player who jetpacks down
       * into a moving lane or backs into a car's flank. A body inside a solid
       * box has every direction blocked and cannot walk out, so the car pushes
       * them to the nearest face — sideways if it can, because being shoved
       * out of the road is the answer a player expects and being shoved along
       * it is how you end up carried across the district.
       */
      if (car.hitCool > 0) car.hitCool -= dt;
      if (player && player.y < car.height && player.y > -1.2) {
        const dx = player.x - x;
        const dz = player.z - z;
        const pushX = hx + 0.45 - Math.abs(dx);
        const pushZ = hz + 0.45 - Math.abs(dz);
        if (pushX > 0 && pushZ > 0) {
          /**
           * Fast enough to hurt: launch, do not nudge.
           *
           * The gentle push below is right for a car crawling in a queue —
           * it is what lets you step off the kerb, have the next one stop for
           * you, and climb in. It is absurd for one doing twelve metres a
           * second, which used to slide you politely out of its way. Now that
           * a kart can send a car twenty-four metres down the street, being
           * the only object in the city that traffic cannot move is the odd
           * one out.
           *
           * Cooldown so this fires once per contact rather than every frame
           * of the several the overlap lasts, which would stack the impulses
           * and fire you into orbit.
           */
          if (car.speed > 4.5 && onPlayerHit && car.hitCool <= 0) {
            onPlayerHit(car.axis === 0 ? 0 : car.dir, car.axis === 0 ? car.dir : 0, car.speed);
            car.hitCool = 1.4;
          } else {
            // Prefer the across-the-car axis unless the along axis is much closer.
            const acrossIsX = car.axis === 1;
            const preferX = acrossIsX ? pushX <= pushZ + 1.2 : pushX + 1.2 < pushZ;
            if (preferX) player.x += Math.sign(dx || 1) * pushX;
            else player.z += Math.sign(dz || 1) * pushZ;
          }
        }
      }
    }

    for (const b of built) {
      for (const part of b.parts) part.instanceMatrix.needsUpdate = true;
      b.tyres.instanceMatrix.needsUpdate = true;
      b.rims.instanceMatrix.needsUpdate = true;
    }
  };

  /**
   * Put a car back on the road from wherever it has ended up.
   *
   * Shared by `release` (a driver got out) and by a car settling after being
   * knocked out of its lane. Both leave `lane` and `t` holding a world
   * position, which for a car sitting on a pavement or upside down in a plaza
   * is not a lane at all — so it snaps to the nearest centreline for its own
   * axis, keeps the offset that puts it on the right-hand side, and carries
   * on. The snap is a jump of a few metres and reads as the driver getting
   * back in and pulling out. The alternative is a car permanently abandoned
   * wherever it stopped, which drains the fleet one at a time.
   */
  const rejoin = (car: Car) => {
    let bestI = 0;
    for (let k = 1; k < centrelines.length; k++) {
      if (Math.abs(centrelines[k] - car.lane) < Math.abs(centrelines[bestI] - car.lane)) bestI = k;
    }
    car.laneIndex = bestI;
    car.lane = centrelines[bestI] + (car.axis === 0 ? -car.dir : car.dir) * (street * 0.22);
    car.t = THREE.MathUtils.clamp(car.t, -half, half);
    car.speed = 0;
    car.hit = null;
  };

  /**
   * Write one car's transform into its model's instanced meshes.
   *
   * `pitch` and `roll` are zero for every car on the road — traffic is
   * axis-aligned and flat by construction — and exist for the one case that is
   * neither: a car sinking in the bay, which noses over and rolls as it goes
   * down. Applied in YXZ so the yaw is a heading and the pitch tips the nose,
   * rather than the two fighting over which one happens in world space.
   */
  const pose = (
    car: Car, x: number, y: number, z: number, yaw: number,
    pitch = 0, roll = 0,
  ) => {
    const b = built[car.model];
    if (pitch === 0 && roll === 0) Q.setFromAxisAngle(UP, yaw);
    else Q.setFromEuler(PE.set(pitch, yaw, roll, "YXZ"));
    P.set(x, y, z);
    // Flattened: the roof comes down to the wheel tops.
    const sq = car.crushed ? 0.42 : 1;
    M.compose(P, Q, sq === 1 ? ONE : SQUASH);
    for (const part of b.parts) part.setMatrixAt(car.slot, M);
    for (let w = 0; w < b.wheels.length; w++) {
      const spec = b.wheels[w];
      WE.set(car.spin, 0, 0);
      WQ.setFromEuler(WE).premultiply(Q);
      WP.set(spec.x * (sq === 1 ? 1 : 1.12), spec.y * sq, spec.z).applyQuaternion(Q).add(P);
      WSCALE.set(
        spec.width / TYRE_BASE.width,
        spec.radius / TYRE_BASE.radius,
        spec.radius / TYRE_BASE.radius,
      );
      M.compose(WP, WQ, WSCALE);
      b.tyres.setMatrixAt(car.slot * 4 + w, M);
      b.rims.setMatrixAt(car.slot * 4 + w, M);
    }
    for (const part of b.parts) part.instanceMatrix.needsUpdate = true;
    b.tyres.instanceMatrix.needsUpdate = true;
    b.rims.instanceMatrix.needsUpdate = true;
  };

  const rideOf = (car: Car, id: number): TrafficRide => ({
    id,
    x: car.axis === 0 ? car.lane : car.t,
    z: car.axis === 0 ? car.t : car.lane,
    // Kart local space is −Z forward; this is the same mapping the AI uses.
    yaw: car.axis === 0 ? (car.dir > 0 ? Math.PI : 0) : car.dir > 0 ? -Math.PI / 2 : Math.PI / 2,
    halfLong: car.halfLong,
    halfWide: car.halfWide,
    roofY: car.height,
  });

  function loseControl(near: { x: number; z: number } | null): number {
    const pick: Car[] = [];
    for (const c of cars) {
      if (c.driven || c.hit || c.speed < 6.5) continue;
      if (near) {
        const p = laneXZ(c);
        const d = Math.hypot(p.x - near.x, p.z - near.z);
        if (d < 18 || d > 95) continue;
      }
      pick.push(c);
    }
    if (!pick.length) return -1;
    const car = pick[Math.floor(rnd() * pick.length)];
    const hx = car.axis === 0 ? 0 : car.dir;
    const hz = car.axis === 0 ? car.dir : 0;
    const side = rnd() < 0.5 ? -1 : 1;
    const sp = Math.max(car.speed, 10) * 1.3;
    launch(car, hx * sp - hz * side * sp * 0.5, 0.3, hz * sp + hx * side * sp * 0.5, side * (1.4 + rnd() * 1.4), 0, side * 0.15);
    car.skid = 2.6;
    counts.skids++;
    const h = car.hit!;
    emit({ kind: "skid", x: h.x, y: 0, z: h.z, strength: sp, id: cars.indexOf(car) });
    return cars.indexOf(car);
  }

  const nearestRidable = (x: number, z: number, radius: number): TrafficRide | null => {
    let best: TrafficRide | null = null;
    let bestD = radius * radius;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (car.driven) continue;
      // Not one that is currently cartwheeling down the street. Its `speed` is
      // zero and its `lane`/`t` are stale, so without this it looks like the
      // most inviting car on the block from wherever it used to be.
      if (car.hit) continue;
      // Crawling counts. A car stopped in a queue or held at a red is the one
      // you want, and 3.5 m/s is walking pace — you can catch it.
      if (car.speed > 3.5) continue;
      const cx = car.axis === 0 ? car.lane : car.t;
      const cz = car.axis === 0 ? car.t : car.lane;
      const d = (x - cx) ** 2 + (z - cz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = rideOf(car, i);
      }
    }
    return best;
  };

  return {
    group,
    update,
    nearestRidable,

    claim(id) {
      const car = cars[id];
      // `nearestRidable` already refuses to offer an airborne car, but the id
      // it offered a moment ago can be acted on later — the button holds it in
      // React state, and a car can be sent flying between the render and the
      // click. Taking the wheel of one mid-cartwheel would strand it there:
      // `drive` writes its pose from then on and its flight is never resolved.
      if (!car || car.driven || car.hit) return null;
      const ride = rideOf(car, id);
      car.driven = true;
      car.speed = 0;
      // Collapse the box rather than removing it: the array is held live by
      // `CollisionWorld` and by whoever else has a reference, and splicing it
      // mid-frame would shift every index after it.
      car.box.minX = car.box.maxX = car.box.minZ = car.box.maxZ = 0;
      car.box.height = -1000;
      return ride;
    },

    drive(id, x, y, z, yaw, pitch = 0, roll = 0) {
      const car = cars[id];
      if (!car || !car.driven) return;
      // Wheels turn off the distance covered, same as the AI's.
      car.spin += Math.hypot(x - (car.axis === 0 ? car.lane : car.t), z - (car.axis === 0 ? car.t : car.lane)) / 0.32;
      if (car.axis === 0) {
        car.lane = x;
        car.t = z;
      } else {
        car.lane = z;
        car.t = x;
      }
      pose(car, x, y, z, yaw, pitch, roll);
    },

    release(id) {
      const car = cars[id];
      if (!car || !car.driven) return;
      rejoin(car);
      car.driven = false;
    },

    onPlayerHit(cb) {
      onPlayerHit = cb;
    },

    onCrash(cb) {
      onCrash = cb;
    },

    damage(id, amount) {
      const car = cars[id];
      if (car) hurt(car, amount);
    },

    detonate(id, yaw) {
      const car = cars[id];
      if (!car || !car.driven) return;
      const x = car.axis === 0 ? car.lane : car.t;
      const z = car.axis === 0 ? car.t : car.lane;
      car.driven = false;
      car.hit = { x, y: 0, z, vx: 0, vy: 0, vz: 0, yaw, pitch: 0, roll: 0, spinY: 0, spinP: 0, spinR: 0, t: 0 };
      car.speed = 0;
      car.dmg = 0;
      explode(car);
    },

    crush(id) {
      const car = cars[id];
      if (!car || car.driven || car.crushed) return;
      if (!car.hit) launch(car, 0, 0, 0, 0, 0, 0);
      const h = car.hit!;
      // Pinned flat where it was. No bounce: something very heavy is on it.
      h.vx = h.vz = 0;
      h.vy = Math.min(h.vy, 0);
      h.spinY = h.spinP = h.spinR = 0;
      h.pitch = h.roll = 0;
      car.crushed = true;
      car.dmg = 100;
      if (car.wreck === 0) {
        car.wreck = 1e-3;
        counts.wrecks++;
      }
      tint(car, CRUSHED);
      emit({ kind: "crush", x: h.x, y: 0.5, z: h.z, strength: 20, id });
    },

    blast(x, z, r, force) {
      blastAt(x, z, r, force, null);
    },

    burning() {
      return burningOut;
    },

    skidding() {
      return skidOut;
    },

    loseControl,

    stats() {
      return { ...counts };
    },

    debugNear(x, z, r) {
      const out: ReturnType<Traffic["debugNear"]> = [];
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        const cx = c.hit ? c.hit.x : c.axis === 0 ? c.lane : c.t;
        const cz = c.hit ? c.hit.z : c.axis === 0 ? c.t : c.lane;
        if (Math.hypot(cx - x, cz - z) > r) continue;
        out.push({
          id: i, x: cx, y: c.hit ? c.hit.y : 0, z: cz,
          hit: !!c.hit, speed: c.speed, axis: c.axis, dir: c.dir,
          dmg: c.dmg, wreck: c.wreck > 0, crushed: c.crushed,
        });
      }
      return out;
    },

    carAt(x, z, y, pad = 0.3) {
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        if (c.driven) continue;
        const b = c.box;
        if (y > b.height + 0.4) continue;
        if (x >= b.minX - pad && x <= b.maxX + pad && z >= b.minZ - pad && z <= b.maxZ + pad) {
          return i;
        }
      }
      return -1;
    },

    shove(id, vx, vz, force) {
      const car = cars[id];
      if (!car || car.driven) return;
      const x = car.hit ? car.hit.x : car.axis === 0 ? car.lane : car.t;
      const z = car.hit ? car.hit.z : car.axis === 0 ? car.t : car.lane;
      const y = car.hit ? car.hit.y : 0;
      const yaw = car.hit
        ? car.hit.yaw
        : car.axis === 0
          ? car.dir > 0 ? Math.PI : 0
          : car.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      const len = Math.hypot(vx, vz) || 1;
      const nx = vx / len;
      const nz = vz / len;
      const f = Math.max(0, force);
      // Lifted as well as pushed. A car shunted purely horizontally slides
      // like a hockey puck; the little bit of air under it is what makes it
      // read as having been HIT.
      car.hit = {
        x, y, z,
        vx: (car.hit?.vx ?? 0) + nx * f,
        vy: (car.hit?.vy ?? 0) + Math.min(7, 1.5 + f * 0.28),
        vz: (car.hit?.vz ?? 0) + nz * f,
        yaw,
        pitch: car.hit?.pitch ?? 0,
        roll: car.hit?.roll ?? 0,
        // Spun about all three, scaled to the hit and signed off which side of
        // the nose it landed on, so a glancing blow slews and a square one
        // barrel-rolls.
        spinY: (car.hit?.spinY ?? 0) + (nx * 0.6 + nz * 0.6) * f * 0.16,
        spinP: (car.hit?.spinP ?? 0) + f * 0.06,
        spinR: (car.hit?.spinR ?? 0) + (nz - nx) * f * 0.09,
        t: 0,
      };
      car.speed = 0;
      // Out of the lane queue immediately: leaving it in means the cars behind
      // brake for a phantom at its old `t` while the real one is in the air.
      car.t = THREE.MathUtils.clamp(car.axis === 0 ? z : x, -half, half);
    },

    dispose() {
      for (const t of trash) t.dispose();
      for (const b of built) {
        for (const p of b.parts) p.dispose();
        b.tyres.dispose();
        b.rims.dispose();
      }
      poles.dispose();
      heads.dispose();
      lamps.dispose();
      // Take our boxes back out of the world's collision array — it outlives
      // us, and a stale box is an invisible wall in the middle of a street.
      for (const c of cars) {
        const i = boxes.indexOf(c.box);
        if (i >= 0) boxes.splice(i, 1);
      }
    },
  };
}
