/**
 * The house gets built here, and so does the block it stands on.
 *
 * Two rules run through the whole file:
 *
 * **Walls come with their colliders.** `wallX`/`wallZ` emit the geometry *and*
 * push the boxes the player collides against, from the same numbers, in the
 * same call. Keeping a separate collision list is how you end up with a wall
 * you can walk through on the second floor and a corridor you cannot enter at
 * all, and no compiler will ever tell you.
 *
 * **The house is lit by its own windows.** Every room owns one point light and
 * the glass of its windows; switching the room on drives both, so a light you
 * left burning upstairs is visible from the street. That is not decoration —
 * level 2 is entirely about which windows are lit when the van goes past.
 *
 * Perf: sixteen rooms means sixteen point lights, which is more than a phone
 * wants to shade per fragment. `cullLights` keeps only the handful nearest the
 * player switched on in the renderer's eyes, which is invisible in play
 * because you cannot see into a room from three rooms away anyway.
 */
import * as THREE from "three";
import {
  CEILING,
  CELLAR_STAIR,
  DOORWAYS,
  FLOOR,
  IN,
  MAIN_STAIR,
  NEIGHBOURS,
  PART_T,
  ROOMS,
  STAIR_VOIDS,
  STREET,
  STREETLIGHTS,
  TREEHOUSE,
  ZIP_END,
  ZIP_START,
  WALL_T,
  X,
  Z,
  type Doorway,
  type FloorName,
  type Ramp,
  type RoomId,
} from "./house";
import * as T from "./textures";

export interface Collider {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y0: number;
  y1: number;
}

export interface Slab {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y: number;
}

export interface RoomLight {
  room: RoomId;
  light: THREE.PointLight;
  /** Window glass belonging to this room, so the street can see it burning. */
  glass: THREE.MeshStandardMaterial[];
  on: boolean;
}

export interface DoorLeaf {
  pivot: THREE.Group;
  closed: number;
  open: number;
  /** 0 shut … 1 wide open. Animated by the engine. */
  t: number;
  target: number;
  kind: NonNullable<Doorway["leaf"]>;
  x: number;
  z: number;
  floor: FloorName;
}

export interface BuiltWorld {
  root: THREE.Group;
  colliders: Collider[];
  /**
   * What the camera boom is allowed to pass through, which is not the same
   * list as what the player is.
   *
   * A window is a hole in a wall that the player can never walk through, so it
   * carries no collider — and the first build of the camera happily posted the
   * lens straight out of the staircase window and rendered the back of the
   * front wall. Glass stops light; it has to stop the camera too.
   */
  camBlockers: Collider[];
  slabs: Slab[];
  ramps: Ramp[];
  roomLights: Map<RoomId, RoomLight>;
  doors: DoorLeaf[];
  fire: THREE.PointLight;
  treeLights: THREE.PointLight[];
  snow: THREE.Points;
  van: THREE.Group;
  /** The zipline rope, hidden until the last level needs it. */
  zip: THREE.Line;
  porchLight: THREE.PointLight;
  cullLights(px: number, py: number, pz: number): void;
  setRoomLight(room: RoomId, on: boolean): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ *
 * Windows. Exterior only — the holes in the shell, and the glass in them.
 * ------------------------------------------------------------------ */

interface Win {
  along: "x" | "z";
  at: number;
  centre: number;
  width: number;
  height: number;
  sill: number;
  floor: FloorName;
  room: RoomId;
  /** Two-storey bay window at the front of the living room. */
  bay?: boolean;
}

const WINDOWS: Win[] = [
  /* ground, front (south) */
  { along: "x", at: Z.S, centre: -5.2, width: 1.3, height: 1.5, sill: 0.95, floor: "ground", room: "den" },
  { along: "x", at: Z.S, centre: -2.6, width: 1.0, height: 1.3, sill: 1.35, floor: "ground", room: "stairbay" },
  { along: "x", at: Z.S, centre: 4.4, width: 2.6, height: 1.7, sill: 0.7, floor: "ground", room: "living", bay: true },
  /* ground, back (north) */
  { along: "x", at: Z.N, centre: 5.6, width: 1.4, height: 1.2, sill: 1.25, floor: "ground", room: "kitchen" },
  { along: "x", at: Z.N, centre: 0.4, width: 1.2, height: 1.2, sill: 1.25, floor: "ground", room: "kitchen" },
  /* ground, sides */
  { along: "z", at: X.E, centre: 3.0, width: 1.4, height: 1.5, sill: 0.95, floor: "ground", room: "living" },
  { along: "z", at: X.E, centre: -1.0, width: 1.4, height: 1.5, sill: 0.95, floor: "ground", room: "dining" },
  { along: "z", at: X.E, centre: -3.8, width: 1.2, height: 1.2, sill: 1.25, floor: "ground", room: "kitchen" },
  { along: "z", at: X.W, centre: 3.0, width: 1.4, height: 1.5, sill: 0.95, floor: "ground", room: "den" },
  { along: "z", at: X.W, centre: -1.6, width: 1.4, height: 1.5, sill: 0.95, floor: "ground", room: "family" },
  { along: "z", at: X.W, centre: -3.2, width: 1.0, height: 1.1, sill: 1.3, floor: "ground", room: "backhall" },
  /* upper, front */
  { along: "x", at: Z.S, centre: -5.2, width: 1.2, height: 1.4, sill: 0.9, floor: "upper", room: "bathroom" },
  { along: "x", at: Z.S, centre: 0.4, width: 1.4, height: 1.5, sill: 0.8, floor: "upper", room: "kevin" },
  { along: "x", at: Z.S, centre: 4.6, width: 1.5, height: 1.5, sill: 0.8, floor: "upper", room: "parents" },
  /* upper, back */
  { along: "x", at: Z.N, centre: 4.0, width: 1.4, height: 1.4, sill: 0.9, floor: "upper", room: "buzz" },
  { along: "x", at: Z.N, centre: -3.0, width: 1.4, height: 1.4, sill: 0.9, floor: "upper", room: "guest" },
  /* upper, sides */
  { along: "z", at: X.E, centre: 3.0, width: 1.3, height: 1.4, sill: 0.9, floor: "upper", room: "parents" },
  { along: "z", at: X.E, centre: -3.4, width: 1.3, height: 1.4, sill: 0.9, floor: "upper", room: "buzz" },
  { along: "z", at: X.W, centre: 3.0, width: 1.2, height: 1.3, sill: 1.0, floor: "upper", room: "bathroom" },
  { along: "z", at: X.W, centre: -3.4, width: 1.3, height: 1.4, sill: 0.9, floor: "upper", room: "guest" },
];

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

/**
 * How bright one room's bulb is.
 *
 * three.js has been physically-based since r155: a point light's intensity is
 * candela and its falloff is a real 1/d^decay, with none of the old fudge. A
 * value that looked like a lamp under the legacy model renders a black room
 * under this one, which is exactly how the first build of this house came out
 * — every interior shot was an unlit rectangle. Thirty-two is a bare 60 W
 * bulb at two and a half metres.
 */
const ROOM_LUX = 21;

export function buildWorld(scene: THREE.Scene): BuiltWorld {
  const root = new THREE.Group();
  scene.add(root);

  const colliders: Collider[] = [];
  const camBlockers: Collider[] = [];
  const slabs: Slab[] = [];
  const roomLights = new Map<RoomId, RoomLight>();
  const doors: DoorLeaf[] = [];
  const treeLights: THREE.PointLight[] = [];
  /** The fireplace. Assigned when the living room is built, a few hundred
   *  lines below — finding it again afterwards by matching a colour hex was
   *  one careless palette tweak away from returning a streetlight. */
  let fire: THREE.PointLight | null = null;
  const disposables: Array<{ dispose(): void }> = [];

  const track = <M extends THREE.Material | THREE.BufferGeometry>(m: M) => {
    disposables.push(m);
    return m;
  };

  /* ---- shared materials ------------------------------------------- */
  const M = {
    trimGreen: track(new THREE.MeshStandardMaterial({ color: 0x21382c, roughness: 0.6 })),
    door: track(new THREE.MeshStandardMaterial({ map: T.doorPanel("#5c3c1e"), roughness: 0.55 })),
    frontDoor: track(new THREE.MeshStandardMaterial({ map: T.doorPanel("#1f4030"), roughness: 0.45 })),
    oak: track(new THREE.MeshStandardMaterial({ color: 0x6a4526, roughness: 0.62 })),
    darkOak: track(new THREE.MeshStandardMaterial({ color: 0x4a2e17, roughness: 0.6 })),
    brass: track(new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.28, metalness: 0.85 })),
    white: track(new THREE.MeshStandardMaterial({ color: 0xefeade, roughness: 0.7 })),
    steel: track(new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.35, metalness: 0.7 })),
    black: track(new THREE.MeshStandardMaterial({ color: 0x18181c, roughness: 0.8 })),
    red: track(new THREE.MeshStandardMaterial({ color: 0x8e1f28, roughness: 0.7 })),
    green: track(new THREE.MeshStandardMaterial({ color: 0x1e4227, roughness: 0.9 })),
    snowCap: track(new THREE.MeshStandardMaterial({ color: 0xe6edf8, roughness: 0.62 })),
    trim: track(new THREE.MeshStandardMaterial({ color: 0xe9e4d6, roughness: 0.68 })),
    fabric: track(new THREE.MeshStandardMaterial({ color: 0x6c4b3a, roughness: 0.98 })),
  };

  /* ------------------------------------------------------------------ *
   * Texture scale is per METRE, not per box.
   *
   * A BoxGeometry's UVs run 0…1 on every face regardless of how big the box
   * is, so one shared wall material gives a 5-metre wall and a 1-metre wall
   * the same number of bricks — which is the single most reliable way to make
   * a building look like a game. `surface()` fixes it: ask for a kind and the
   * real world size of the face, get back a material whose texture repeats at
   * a fixed number of metres per tile. Sizes are rounded to 25 cm so the cache
   * stays small (a few dozen materials for the whole house).
   * ------------------------------------------------------------------ */

  type Kind =
    | "brick" | "trim" | "roof" | "snow" | "street" | "wood" | "ktile"
    | "concrete" | "ceiling" | "stone" | "carpet" | `paper${number}`;

  /** Metres per texture tile, per kind. Brick is the one worth getting right. */
  const SCALE: Record<string, [number, number]> = {
    brick: [1.55, 1.2], trim: [1.4, 1.4], roof: [2.4, 2.4], snow: [3.0, 3.0],
    street: [4.0, 4.0], wood: [2.1, 2.1], ktile: [1.15, 1.15], concrete: [2.2, 2.2],
    ceiling: [2.4, 2.4], stone: [1.6, 1.6], carpet: [1.6, 1.6], paper: [0.92, 0.92],
  };

  const baseTex = (kind: string, tint?: string): THREE.Texture => {
    if (kind.startsWith("paper")) return T.wallpaper(Number(kind.slice(5)) || 0);
    switch (kind) {
      case "brick": return T.brick();
      case "trim": return T.clapboard(tint ?? "#efece2");
      case "roof": return T.shingles();
      case "snow": return T.snow();
      case "street": return T.street();
      case "wood": return T.hardwood();
      case "ktile": return T.wallpaper(2);
      case "ceiling": return T.ceilingPlaster();
      case "stone": return T.stone();
      case "carpet": return T.carpet(tint ?? "#6a5c4a");
      default: return T.ceilingPlaster();
    }
  };

  const CONCRETE = track(new THREE.MeshStandardMaterial({ color: 0x5f5c57, roughness: 1 }));
  const surfaces = new Map<string, THREE.MeshStandardMaterial>();
  function surface(kind: Kind, w: number, h: number, tint?: string): THREE.MeshStandardMaterial {
    if (kind === "concrete") return CONCRETE;
    const q = (v: number) => Math.max(0.25, Math.round(Math.abs(v) * 4) / 4);
    const key = `${kind}|${tint ?? ""}|${q(w)}|${q(h)}`;
    const hit = surfaces.get(key);
    if (hit) return hit;
    const per = SCALE[kind.startsWith("paper") ? "paper" : kind] ?? [2, 2];
    const t2 = baseTex(kind, tint).clone();
    t2.needsUpdate = true;
    t2.wrapS = t2.wrapT = THREE.RepeatWrapping;
    t2.repeat.set(Math.max(0.25, q(w) / per[0]), Math.max(0.25, q(h) / per[1]));
    disposables.push(t2);
    const rough =
      kind === "wood" ? 0.5 : kind === "ktile" ? 0.42 : kind === "carpet" ? 1 : kind === "trim" ? 0.7 : 0.93;
    const m = track(
      new THREE.MeshStandardMaterial({
        map: t2,
        roughness: rough,
        color: kind === "snow" ? 0xe2eaf6 : 0xffffff,
      }),
    );
    surfaces.set(key, m);
    return m;
  }

  /* ---- primitives -------------------------------------------------- */

  const BOX = track(new THREE.BoxGeometry(1, 1, 1));

  function box(
    mat: THREE.Material | THREE.Material[],
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    solid = true,
    parent: THREE.Object3D = root,
  ) {
    const m = new THREE.Mesh(BOX, mat);
    m.position.set(x, y + h / 2, z);
    m.scale.set(w, h, d);
    m.castShadow = false;
    m.receiveShadow = true;
    parent.add(m);
    if (solid) {
      colliders.push({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2, y0: y, y1: y + h });
    }
    return m;
  }

  /** A box that is furniture: collides, and reads as an obstacle to route round. */
  const prop = (mat: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number) =>
    box(mat, x, y, z, w, h, d, true);
  /** A box that is decoration: no collision, because clipping a lamp is fine. */
  const deco = (mat: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number) =>
    box(mat, x, y, z, w, h, d, false);

  /* ---- walls ------------------------------------------------------- */

  interface Hole {
    centre: number;
    width: number;
    bottom: number;
    top: number;
  }

  function holesFor(along: "x" | "z", at: number, floor: FloorName, lo: number, hi: number): Hole[] {
    const fy = FLOOR[floor];
    const out: Hole[] = [];
    for (const d of DOORWAYS) {
      if (d.along !== along || d.floor !== floor || Math.abs(d.at - at) > 0.02) continue;
      if (d.centre < lo - 0.01 || d.centre > hi + 0.01) continue;
      out.push({ centre: d.centre, width: d.width, bottom: fy, top: fy + d.height });
    }
    for (const w of WINDOWS) {
      if (w.along !== along || w.floor !== floor || Math.abs(w.at - at) > 0.02) continue;
      if (w.centre < lo - 0.01 || w.centre > hi + 0.01) continue;
      out.push({ centre: w.centre, width: w.width, bottom: fy + w.sill, top: fy + w.sill + w.height });
    }
    return out.sort((a, b) => a.centre - b.centre);
  }

  /**
   * A wall running along one axis, with the doorways and windows on that line
   * subtracted from it. Segments between holes go full height; a lintel spans
   * above each hole and an apron below each window.
   */
  function wall(
    along: "x" | "z",
    at: number,
    lo: number,
    hi: number,
    floor: FloorName,
    faces: { neg: Kind; pos: Kind; negTint?: string; posTint?: string },
    t = PART_T,
    heightOverride?: number,
  ) {
    const fy = FLOOR[floor];
    const h = heightOverride ?? CEILING[floor];
    const holes = holesFor(along, at, floor, lo, hi);
    const place = (a0: number, a1: number, y0: number, y1: number) => {
      if (a1 - a0 < 0.01 || y1 - y0 < 0.01) return;
      const mid = (a0 + a1) / 2;
      const len = a1 - a0;
      const half = t / 2;
      // Two faces, so a room sees its own paper and the street sees brick.
      // `neg` is the -x / -z side; `pos` is the other. Naming them for the axis
      // rather than "inside"/"outside" is not pedantry — the first cut of this
      // had the hall's wallpaper facing Lincoln Avenue for exactly that reason.
      const mNeg = surface(faces.neg, len, y1 - y0, faces.negTint);
      const mPos = surface(faces.pos, len, y1 - y0, faces.posTint);
      if (along === "x") {
        box(mNeg, mid, y0, at - half / 2, len, y1 - y0, half, false);
        box(mPos, mid, y0, at + half / 2, len, y1 - y0, half, false);
        colliders.push({ x0: a0, x1: a1, z0: at - half, z1: at + half, y0, y1 });
      } else {
        box(mNeg, at - half / 2, y0, mid, half, y1 - y0, len, false);
        box(mPos, at + half / 2, y0, mid, half, y1 - y0, len, false);
        colliders.push({ x0: at - half, x1: at + half, z0: a0, z1: a1, y0, y1 });
      }
    };
    let cursor = lo;
    for (const hole of holes) {
      const h0 = hole.centre - hole.width / 2;
      const h1 = hole.centre + hole.width / 2;
      place(cursor, h0, fy, fy + h);
      if (hole.bottom > fy + 0.01) place(h0, h1, fy, hole.bottom); // apron under a window
      if (hole.top < fy + h - 0.01) place(h0, h1, hole.top, fy + h); // lintel over the hole
      cursor = h1;
    }
    place(cursor, hi, fy, fy + h);
  }

  /* ---- shell ------------------------------------------------------- */

  /* The brick shell. Brick faces the street on all four sides — which means
     the +Z wall wants brick on its `pos` face and the -Z wall on its `neg`. */
  for (const floor of ["ground", "upper"] as FloorName[]) {
    wall("x", Z.S, X.W, X.E, floor, { neg: "paper0", pos: "brick" }, WALL_T);
    wall("x", Z.N, X.W, X.E, floor, { neg: "brick", pos: "paper0" }, WALL_T);
    wall("z", X.W, Z.N, Z.S, floor, { neg: "brick", pos: "paper0" }, WALL_T);
    wall("z", X.E, Z.N, Z.S, floor, { neg: "paper0", pos: "brick" }, WALL_T);
  }
  // Basement: poured concrete, no openings.
  const CON = { neg: "concrete" as Kind, pos: "concrete" as Kind };
  wall("x", Z.S, X.W, 1.15, "basement", CON, WALL_T, CEILING.basement);
  wall("x", Z.N, X.W, 1.15, "basement", CON, WALL_T, CEILING.basement);
  wall("z", X.W, Z.N, Z.S, "basement", CON, WALL_T, CEILING.basement);
  wall("z", 1.15, Z.N, Z.S, "basement", CON, WALL_T, CEILING.basement);

  /* ---- interior partitions ----------------------------------------- */
  const P = (kind: number) => `paper${kind}` as Kind;

  // ground
  wall("z", X.w2, Z.m, IN.S, "ground", { neg: P(0), pos: P(0) }); // stairbay | hall
  wall("z", X.e1, Z.m, IN.S, "ground", { neg: P(0), pos: P(0) }); // hall | living
  wall("z", X.w1, Z.m, IN.S, "ground", { neg: P(1), pos: P(0) }); // den | stairbay
  wall("x", Z.m, IN.W, IN.E, "ground", { neg: P(0), pos: P(0) }); // front half | back half
  wall("z", X.e1, Z.n1, Z.m, "ground", { neg: P(0), pos: P(1) }); // midhall | dining
  wall("z", X.w2, Z.n1, Z.m, "ground", { neg: P(3), pos: P(0) }); // family | midhall
  wall("x", Z.n1, IN.W, IN.E, "ground", { neg: "ktile", pos: P(0) }); // kitchen row
  wall("z", X.w2, IN.N, Z.n1, "ground", { neg: "ktile", pos: "ktile" }); // backhall | kitchen
  wall("z", -2.1, -5.35, -3.9, "ground", { neg: "ktile", pos: "ktile" }); // cellar doorway wall

  // upper
  wall("x", 0.4, IN.W, IN.E, "upper", { neg: P(0), pos: P(0) });
  wall("x", -1.2, IN.W, IN.E, "upper", { neg: P(0), pos: P(0) });
  wall("z", X.w1, 0.4, IN.S, "upper", { neg: "ktile", pos: P(0) }); // bathroom | stairwell
  wall("z", X.w2, 0.4, IN.S, "upper", { neg: P(0), pos: P(3) }); // stairwell | Kevin
  wall("z", 2.2, 0.4, IN.S, "upper", { neg: P(3), pos: P(1) }); // Kevin | parents
  wall("z", 1.0, IN.N, -1.2, "upper", { neg: P(1), pos: P(3) }); // guest | Buzz

  /* ---- floors and ceilings ------------------------------------------ */

  function slabFor(
    floor: FloorName, x0: number, x1: number, z0: number, z1: number,
    kind: Kind, y: number, tint?: string,
  ) {
    const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    const m = new THREE.Mesh(g, surface(kind, x1 - x0, z1 - z0, tint));
    disposables.push(g);
    m.rotation.x = -Math.PI / 2;
    m.position.set((x0 + x1) / 2, y + 0.001, (z0 + z1) / 2);
    m.receiveShadow = true;
    root.add(m);
    slabs.push({ x0, x1, z0, z1, y });
    void floor;
  }

  for (const room of Object.values(ROOMS)) {
    const y = FLOOR[room.floor];
    const kind: Kind =
      room.ground === "wood" ? "wood"
      : room.ground === "tile" ? "ktile"
      : room.ground === "concrete" ? "concrete"
      : "carpet";
    // Cut the stair voids out of the slab by splitting it into strips.
    const voids = STAIR_VOIDS.filter(
      (v) => v.floor === room.floor && v.x0 < room.x1 && v.x1 > room.x0 && v.z0 < room.z1 && v.z1 > room.z0,
    );
    if (!voids.length) {
      slabFor(room.floor, room.x0, room.x1, room.z0, room.z1, kind, y, room.carpetColor);
    } else {
      const v = voids[0];
      const cx0 = Math.max(room.x0, v.x0);
      const cx1 = Math.min(room.x1, v.x1);
      const cz0 = Math.max(room.z0, v.z0);
      const cz1 = Math.min(room.z1, v.z1);
      if (room.z0 < cz0) slabFor(room.floor, room.x0, room.x1, room.z0, cz0, kind, y, room.carpetColor);
      if (cz1 < room.z1) slabFor(room.floor, room.x0, room.x1, cz1, room.z1, kind, y, room.carpetColor);
      if (room.x0 < cx0) slabFor(room.floor, room.x0, cx0, cz0, cz1, kind, y, room.carpetColor);
      if (cx1 < room.x1) slabFor(room.floor, cx1, room.x1, cz0, cz1, kind, y, room.carpetColor);
    }
    // Ceiling.
    const cg = new THREE.PlaneGeometry(room.x1 - room.x0, room.z1 - room.z0);
    disposables.push(cg);
    const cm = new THREE.Mesh(cg, surface("ceiling", room.x1 - room.x0, room.z1 - room.z0));
    cm.rotation.x = Math.PI / 2;
    cm.position.set((room.x0 + room.x1) / 2, y + CEILING[room.floor] - 0.01, (room.z0 + room.z1) / 2);
    root.add(cm);
  }

  /* ---- stairs -------------------------------------------------------- */

  function flight(r: Ramp, tread: THREE.Material, riser: THREE.Material) {
    const len = r.axis === "z" ? r.z1 - r.z0 : r.x1 - r.x0;
    const wide = r.axis === "z" ? r.x1 - r.x0 : r.z1 - r.z0;
    for (let i = 0; i < r.steps; i++) {
      const f0 = i / r.steps;
      const f1 = (i + 1) / r.steps;
      // `dir` is which way it climbs; step i sits at the height of its top edge.
      const yA = r.yLow + (r.yHigh - r.yLow) * (r.dir === 1 ? f1 : 1 - f0);
      const a0 = (r.axis === "z" ? r.z0 : r.x0) + len * f0;
      const stepLen = len / r.steps;
      const mid = a0 + stepLen / 2;
      const rise = (r.yHigh - r.yLow) / r.steps;
      if (r.axis === "z") {
        const m = new THREE.Mesh(BOX, tread);
        m.position.set((r.x0 + r.x1) / 2, yA - 0.03, mid);
        m.scale.set(wide, 0.06, stepLen + 0.06);
        m.receiveShadow = true;
        root.add(m);
        const rz = new THREE.Mesh(BOX, riser);
        rz.position.set((r.x0 + r.x1) / 2, yA - rise / 2, mid + (r.dir === 1 ? -stepLen / 2 : stepLen / 2));
        rz.scale.set(wide, rise, 0.05);
        root.add(rz);
      } else {
        const m = new THREE.Mesh(BOX, tread);
        m.position.set(mid, yA - 0.03, (r.z0 + r.z1) / 2);
        m.scale.set(stepLen + 0.06, 0.06, wide);
        m.receiveShadow = true;
        root.add(m);
        const rz = new THREE.Mesh(BOX, riser);
        rz.position.set(mid + (r.dir === 1 ? -stepLen / 2 : stepLen / 2), yA - rise / 2, (r.z0 + r.z1) / 2);
        rz.scale.set(0.05, rise, wide);
        root.add(rz);
      }
    }
  }

  const runner = surface("carpet", 1.1, 5.5, "#7a2b2b");
  flight(MAIN_STAIR, runner, M.oak);
  flight(CELLAR_STAIR, CONCRETE, CONCRETE);

  // Banister down the open side of the main flight, and round the landing.
  for (let i = 0; i <= 12; i++) {
    const f = i / 12;
    const z = MAIN_STAIR.z1 - (MAIN_STAIR.z1 - MAIN_STAIR.z0) * f;
    const y = FLOOR.ground + (FLOOR.upper - FLOOR.ground) * f;
    deco(M.white, MAIN_STAIR.x1 - 0.08, y, z, 0.06, 0.92, 0.06);
  }
  {
    // The rail itself: one long box, rotated to the pitch of the flight.
    const run = MAIN_STAIR.z1 - MAIN_STAIR.z0;
    const rise = MAIN_STAIR.yHigh - MAIN_STAIR.yLow;
    const rail = new THREE.Mesh(BOX, M.darkOak);
    rail.position.set(MAIN_STAIR.x1 - 0.08, (FLOOR.ground + FLOOR.upper) / 2 + 0.96, (MAIN_STAIR.z0 + MAIN_STAIR.z1) / 2);
    rail.scale.set(0.11, 0.11, Math.hypot(run, rise));
    rail.rotation.x = Math.atan2(rise, run);
    root.add(rail);
  }
  // Landing rail, so you cannot walk off the second floor into the hall.
  colliders.push({ x0: X.w2 - 0.14, x1: X.w2, z0: 0.4, z1: IN.S, y0: FLOOR.upper, y1: FLOOR.upper + 1.0 });
  for (let i = 0; i <= 5; i++) deco(M.white, X.w2 - 0.07, FLOOR.upper, 0.6 + i * 0.42, 0.06, 0.92, 0.06);
  deco(M.darkOak, X.w2 - 0.07, FLOOR.upper + 0.92, 1.6, 0.11, 0.11, 2.5);

  /* ---- doorway leaves and casings ------------------------------------ */

  for (const d of DOORWAYS) {
    const fy = FLOOR[d.floor];
    // Casing.
    const cw = 0.09;
    if (d.along === "x") {
      deco(M.white, d.centre - d.width / 2 - cw / 2, fy, d.at, cw, d.height, PART_T + 0.06);
      deco(M.white, d.centre + d.width / 2 + cw / 2, fy, d.at, cw, d.height, PART_T + 0.06);
      deco(M.white, d.centre, fy + d.height, d.at, d.width + cw * 2, cw, PART_T + 0.06);
    } else {
      deco(M.white, d.at, fy, d.centre - d.width / 2 - cw / 2, PART_T + 0.06, d.height, cw);
      deco(M.white, d.at, fy, d.centre + d.width / 2 + cw / 2, PART_T + 0.06, d.height, cw);
      deco(M.white, d.at, fy + d.height, d.centre, PART_T + 0.06, cw, d.width + cw * 2);
    }
    // A hung door stops the boom. Cased openings do not — the camera backing
    // through an archway into the next room is fine and often wanted; the
    // camera backing out of the front door onto the porch is not.
    if (d.leaf && d.leaf !== "none") {
      if (d.along === "x")
        camBlockers.push({
          x0: d.centre - d.width / 2, x1: d.centre + d.width / 2,
          z0: d.at - 0.14, z1: d.at + 0.14, y0: fy, y1: fy + d.height,
        });
      else
        camBlockers.push({
          x0: d.at - 0.14, x1: d.at + 0.14,
          z0: d.centre - d.width / 2, z1: d.centre + d.width / 2, y0: fy, y1: fy + d.height,
        });
    }
    if (!d.leaf || d.leaf === "none") continue;

    const pivot = new THREE.Group();
    const hingeSign = (d.swing ?? 1) > 0 ? -1 : 1;
    if (d.along === "x") pivot.position.set(d.centre + (hingeSign * d.width) / 2, fy, d.at);
    else pivot.position.set(d.at, fy, d.centre + (hingeSign * d.width) / 2);
    root.add(pivot);

    const mat = d.leaf === "front" ? M.frontDoor : M.door;
    const leaf = new THREE.Mesh(BOX, mat);
    const off = (-hingeSign * d.width) / 2;
    if (d.along === "x") {
      leaf.position.set(off, d.height / 2, 0);
      leaf.scale.set(d.width, d.height, 0.06);
    } else {
      leaf.position.set(0, d.height / 2, off);
      leaf.scale.set(0.06, d.height, d.width);
      pivot.rotation.y = Math.PI / 2;
      leaf.position.set(off, d.height / 2, 0);
      leaf.scale.set(d.width, d.height, 0.06);
    }
    leaf.castShadow = true;
    pivot.add(leaf);
    // Knob.
    const knob = new THREE.Mesh(BOX, M.brass);
    knob.position.set(off * 1.62, d.height * 0.46, 0.07);
    knob.scale.set(0.09, 0.09, 0.09);
    pivot.add(knob);
    if (d.leaf === "front") {
      // Fanlight over the front door — the shot everybody knows from outside.
      const fan = new THREE.Mesh(BOX, M.white);
      fan.position.set(off, d.height + 0.24, 0);
      fan.scale.set(d.width + 0.2, 0.42, 0.07);
      pivot.add(fan);
    }
    const base = d.along === "x" ? 0 : Math.PI / 2;
    doors.push({
      pivot,
      closed: base,
      open: base + (d.swing ?? 1.5),
      t: 0,
      target: 0,
      kind: d.leaf,
      x: d.along === "x" ? d.centre : d.at,
      z: d.along === "x" ? d.at : d.centre,
      floor: d.floor,
    });
  }

  /* ---- window glass --------------------------------------------------- */

  const roomLightOf = (id: RoomId): RoomLight => {
    let rl = roomLights.get(id);
    if (!rl) {
      const room = ROOMS[id];
      // See ROOM_LUX. Distance is deliberately short — a bulb that reaches
      // seven metres lights the room below it through the floor.
      const light = new THREE.PointLight(0xffd9a0, 0, 7.0, 1.85);
      light.position.set((room.x0 + room.x1) / 2, FLOOR[room.floor] + CEILING[room.floor] - 0.72, (room.z0 + room.z1) / 2);
      root.add(light);
      rl = { room: id, light, glass: [], on: false };
      roomLights.set(id, rl);
    }
    return rl;
  };
  for (const id of Object.keys(ROOMS) as RoomId[]) roomLightOf(id);

  for (const w of WINDOWS) {
    const fy = FLOOR[w.floor];
    const glassMat = track(
      new THREE.MeshStandardMaterial({
        map: T.darkWindow(Math.round(w.centre * 7 + w.at * 3)),
        emissiveMap: T.litWindow(Math.round(w.centre * 5 + w.at * 2)),
        emissive: new THREE.Color(0xffc98a),
        emissiveIntensity: 0,
        roughness: 0.3,
        metalness: 0.1,
      }),
    );
    roomLightOf(w.room).glass.push(glassMat);
    // One pane, facing out, front-side only. From the street it is a lit
    // curtain; from the room it is backface-culled and you look straight
    // through the hole at the snow, which is the whole point of a window and
    // is what a second inward-facing pane was quietly destroying — every
    // interior shot had a glowing orange rectangle in it.
    const g = new THREE.PlaneGeometry(w.width, w.height);
    disposables.push(g);
    glassMat.side = THREE.FrontSide;
    const outward = w.along === "x" ? Math.sign(w.at) : Math.sign(w.at);
    const m = new THREE.Mesh(g, glassMat);
    if (w.along === "x") {
      m.position.set(w.centre, fy + w.sill + w.height / 2, w.at + outward * 0.02);
      m.rotation.y = outward > 0 ? 0 : Math.PI;
    } else {
      m.position.set(w.at + outward * 0.02, fy + w.sill + w.height / 2, w.centre);
      m.rotation.y = outward > 0 ? Math.PI / 2 : -Math.PI / 2;
    }
    root.add(m);
    if (w.along === "x")
      camBlockers.push({
        x0: w.centre - w.width / 2, x1: w.centre + w.width / 2,
        z0: w.at - 0.12, z1: w.at + 0.12,
        y0: fy + w.sill, y1: fy + w.sill + w.height,
      });
    else
      camBlockers.push({
        x0: w.at - 0.12, x1: w.at + 0.12,
        z0: w.centre - w.width / 2, z1: w.centre + w.width / 2,
        y0: fy + w.sill, y1: fy + w.sill + w.height,
      });
    // Sill and surround, outside face.
    if (w.along === "x") {
      deco(M.trim, w.centre, fy + w.sill - 0.08, w.at + Math.sign(w.at) * 0.13, w.width + 0.34, 0.09, 0.3);
      deco(M.trim, w.centre, fy + w.sill + w.height, w.at + Math.sign(w.at) * 0.1, w.width + 0.4, 0.16, 0.16);
      deco(M.snowCap, w.centre, fy + w.sill - 0.02, w.at + Math.sign(w.at) * 0.2, w.width + 0.3, 0.05, 0.18);
    } else {
      deco(M.trim, w.at + Math.sign(w.at) * 0.13, fy + w.sill - 0.08, w.centre, 0.3, 0.09, w.width + 0.34);
      deco(M.trim, w.at + Math.sign(w.at) * 0.1, fy + w.sill + w.height, w.centre, 0.16, 0.16, w.width + 0.4);
      deco(M.snowCap, w.at + Math.sign(w.at) * 0.2, fy + w.sill - 0.02, w.centre, 0.18, 0.05, w.width + 0.3);
    }
  }

  /* ---- roof, porch, chimney -------------------------------------------- */

  const roofBase = FLOOR.upper + CEILING.upper;
  {
    // Hipped roof: four sloped quads, built as a scaled pyramid-ish prism.
    const ridge = 2.7;
    const geo = new THREE.BufferGeometry();
    const hx = X.E + 0.5;
    const nx = X.W - 0.5;
    const hz = Z.S + 0.5;
    const nz = Z.N - 0.5;
    const ry = roofBase + ridge;
    const r0 = [nx + 3.2, ry, 0];
    const r1 = [hx - 3.2, ry, 0];
    const v = [
      // south slope
      nx, roofBase, hz, hx, roofBase, hz, ...r1, nx, roofBase, hz, ...r1, ...r0,
      // north slope
      hx, roofBase, nz, nx, roofBase, nz, ...r0, hx, roofBase, nz, ...r0, ...r1,
      // west hip
      nx, roofBase, nz, nx, roofBase, hz, ...r0,
      // east hip
      hx, roofBase, hz, hx, roofBase, nz, ...r1,
    ];
    geo.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
    geo.computeVertexNormals();
    const uv: number[] = [];
    for (let i = 0; i < v.length / 3; i++) uv.push((v[i * 3] + 10) / 4, (v[i * 3 + 2] + 10) / 4);
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    disposables.push(geo);
    const roof = new THREE.Mesh(geo, surface("roof", 4, 4));
    roof.castShadow = true;
    roof.receiveShadow = true;
    root.add(roof);
    // Eaves.
    deco(M.trim, 0, roofBase - 0.22, Z.S + 0.42, X.E - X.W + 1.4, 0.26, 0.32);
    deco(M.trim, 0, roofBase - 0.22, Z.N - 0.42, X.E - X.W + 1.4, 0.26, 0.32);
  }
  // Chimney.
  deco(surface("brick", 1.15, 3.6), X.E - 1.6, roofBase - 0.4, -1.2, 1.15, 3.6, 1.15);
  deco(M.snowCap, X.E - 1.6, roofBase + 3.2, -1.2, 1.3, 0.12, 1.3);

  // Front porch: two columns, a pediment, three stone steps.
  {
    const pz = Z.S + 1.35;
    prop(surface("stone", 3.6, 1.1), 0.4, -0.02, Z.S + 0.55, 3.6, 0.16, 1.1);
    prop(surface("stone", 3.9, 0.55), 0.4, -0.18, Z.S + 1.15, 3.9, 0.18, 0.55);
    prop(surface("stone", 4.2, 0.55), 0.4, -0.34, Z.S + 1.6, 4.2, 0.18, 0.55);
    for (const s of [-1, 1]) {
      deco(M.trim, 0.4 + s * 1.5, 0, pz, 0.24, 2.9, 0.24);
      colliders.push({ x0: 0.4 + s * 1.5 - 0.15, x1: 0.4 + s * 1.5 + 0.15, z0: pz - 0.15, z1: pz + 0.15, y0: 0, y1: 2.9 });
    }
    deco(M.trim, 0.4, 2.9, pz - 0.1, 3.5, 0.34, 1.9);
    deco(M.snowCap, 0.4, 3.24, pz - 0.1, 3.6, 0.14, 2.0);
    deco(M.trimGreen, 0.4, 2.6, Z.S + 0.05, 3.4, 0.3, 0.12);
  }
  const porchLight = new THREE.PointLight(0xffbb66, 24, 11, 1.6);
  porchLight.position.set(0.4 + 1.05, 2.35, Z.S + 0.35);
  root.add(porchLight);
  deco(M.brass, 0.4 + 1.05, 2.2, Z.S + 0.3, 0.16, 0.3, 0.16);

  // The roof carries its own snow, in the shingle texture. A slab of white
  // across the footprint at eaves height only ever hid the ridge.

  /* ------------------------------------------------------------------ *
   * FURNITURE
   * ------------------------------------------------------------------ */

  /* Living room: fireplace, sofa, the tree. */
  {
    deco(surface("brick", 2.4, 2.5), IN.E - 0.35, 0, 3.0, 0.7, 2.5, 2.4);
    colliders.push({ x0: IN.E - 0.7, x1: IN.E, z0: 1.8, z1: 4.2, y0: 0, y1: 2.5 });
    deco(M.black, IN.E - 0.68, 0.15, 3.0, 0.12, 1.05, 1.25);
    deco(M.darkOak, IN.E - 0.62, 1.3, 3.0, 0.36, 0.14, 1.9); // mantel
    const hearth = new THREE.PointLight(0xff8a3c, 26, 9.5, 1.7);
    hearth.position.set(IN.E - 0.9, 0.6, 3.0);
    root.add(hearth);
    fire = hearth;
    const emberMat = track(new THREE.MeshBasicMaterial({ color: 0xff7a28 }));
    deco(emberMat, IN.E - 0.72, 0.16, 3.0, 0.06, 0.5, 1.0);

    prop(M.fabric, 3.6, 0, 1.5, 2.4, 0.78, 0.95); // sofa
    deco(M.fabric, 3.6, 0.7, 1.15, 2.4, 0.5, 0.3);
    prop(M.fabric, 5.6, 0, 2.6, 0.9, 0.8, 0.9); // armchair
    prop(M.darkOak, 3.6, 0, 2.9, 1.2, 0.42, 0.6); // coffee table
    // The television, playing Angels with Filthy Souls at nobody.
    prop(M.black, 2.7, 0, 4.6, 1.0, 0.75, 0.6);
    const tvMat = track(new THREE.MeshBasicMaterial({ color: 0x8fb8d8 }));
    deco(tvMat, 2.7, 0.18, 4.28, 0.78, 0.5, 0.03);

    // Christmas tree. Six stacked cones and a hundred lights, and it is the
    // single most load-bearing prop in the house — a dark living room with a
    // lit tree in it *is* the movie.
    const tree = new THREE.Group();
    tree.position.set(5.6, 0, 4.6);
    root.add(tree);
    const needle = track(new THREE.MeshStandardMaterial({ color: 0x1d3a22, roughness: 1 }));
    for (let i = 0; i < 7; i++) {
      const f = i / 7;
      const cg = new THREE.ConeGeometry(1.0 - f * 0.78, 0.62, 9, 1);
      disposables.push(cg);
      const c = new THREE.Mesh(cg, needle);
      c.position.y = 0.55 + f * 1.9;
      c.rotation.y = i * 0.5;
      tree.add(c);
    }
    deco(M.darkOak, 5.6, 0, 4.6, 0.22, 0.55, 0.22);
    const bulbGeo = new THREE.SphereGeometry(0.045, 6, 5);
    disposables.push(bulbGeo);
    const bulbMats = [0xff5a4a, 0xffd257, 0x5ad4ff, 0x76e06a, 0xff8ad4].map((c) =>
      track(new THREE.MeshBasicMaterial({ color: c })),
    );
    for (let i = 0; i < 96; i++) {
      const f = i / 96;
      const y = 0.45 + f * 2.15;
      const rad = (1.0 - f * 0.9) * 0.92;
      const a = i * 2.2;
      const b = new THREE.Mesh(bulbGeo, bulbMats[i % bulbMats.length]);
      b.position.set(Math.cos(a) * rad, y, Math.sin(a) * rad);
      tree.add(b);
    }
    const star = new THREE.Mesh(bulbGeo, track(new THREE.MeshBasicMaterial({ color: 0xfff2b0 })));
    star.position.set(0, 2.72, 0);
    star.scale.setScalar(2.2);
    tree.add(star);
    for (const [ty, ti] of [[0.8, 11], [1.9, 8]] as const) {
      const tl = new THREE.PointLight(0xffd08a, ti, 6.5, 1.8);
      tl.position.set(5.6, ty, 4.6);
      root.add(tl);
      treeLights.push(tl);
    }
    // Presents.
    for (let i = 0; i < 5; i++) {
      const s = 0.25 + (i % 3) * 0.12;
      deco(i % 2 ? M.red : M.green, 5.0 + (i % 3) * 0.55, 0, 3.6 + Math.floor(i / 3) * 0.5, s, s, s);
    }
  }

  /* Dining room. */
  prop(M.darkOak, 4.6, 0.68, -1.0, 2.4, 0.08, 1.15);
  for (const [dx, dz] of [[-1.0, -0.45], [1.0, -0.45], [-1.0, 0.45], [1.0, 0.45]] as const)
    deco(M.darkOak, 4.6 + dx, 0, -1.0 + dz, 0.09, 0.68, 0.09);
  for (let i = 0; i < 6; i++) {
    const cx = 4.6 + (i % 3) * 0.85 - 0.85;
    const cz = -1.0 + (i < 3 ? -0.85 : 0.85);
    deco(M.darkOak, cx, 0, cz, 0.42, 0.46, 0.42);
    deco(M.darkOak, cx, 0.46, cz + (i < 3 ? -0.18 : 0.18), 0.42, 0.55, 0.06);
  }
  prop(M.darkOak, IN.E - 0.3, 0, 0.0, 0.55, 1.0, 1.6); // sideboard

  /* Kitchen: counters round three walls, the table Kevin eats at. */
  prop(M.white, 1.4, 0, IN.N + 0.32, 5.4, 0.9, 0.62);
  deco(M.darkOak, 1.4, 0.9, IN.N + 0.32, 5.5, 0.05, 0.66);
  prop(M.white, IN.E - 0.32, 0, -4.0, 0.62, 0.9, 2.2);
  deco(M.darkOak, IN.E - 0.32, 0.9, -4.0, 0.66, 0.05, 2.2);
  prop(M.steel, 5.9, 0, -3.0, 0.8, 1.8, 0.72); // fridge
  deco(M.black, 5.48, 0.4, -3.0, 0.05, 0.7, 0.06);
  prop(M.white, -0.6, 0, IN.N + 0.32, 0.75, 0.92, 0.62); // stove
  deco(M.black, -0.6, 0.93, IN.N + 0.32, 0.6, 0.03, 0.5);
  prop(M.white, 2.0, 0.72, -3.1, 1.5, 0.07, 0.9); // table
  for (const [dx, dz] of [[-0.62, -0.34], [0.62, -0.34], [-0.62, 0.34], [0.62, 0.34]] as const)
    deco(M.white, 2.0 + dx, 0, -3.1 + dz, 0.07, 0.72, 0.07);

  /* Family room and den. */
  prop(M.fabric, -4.2, 0, -0.2, 2.2, 0.75, 0.9);
  prop(M.black, -4.2, 0, -2.2, 1.1, 0.72, 0.5);
  prop(M.darkOak, -5.6, 0, 3.4, 0.7, 0.78, 1.6); // the den desk
  deco(M.darkOak, -5.6, 0.78, 3.4, 0.8, 0.06, 1.7);
  prop(M.darkOak, IN.W + 0.3, 0, 1.6, 0.5, 2.1, 1.8); // bookcase

  /* Back hall: washer, dryer, the laundry chute the iron goes down. */
  prop(M.white, IN.W + 0.5, 0, -3.0, 0.72, 0.92, 0.72);
  prop(M.white, IN.W + 1.35, 0, -3.0, 0.72, 0.92, 0.72);
  deco(M.steel, -1.9, 1.05, IN.N + 0.2, 0.6, 0.6, 0.16); // chute hatch

  /* Basement: the furnace, and it is the only thing down there. */
  {
    const y = FLOOR.basement;
    prop(M.steel, -1.3, y, -2.0, 1.3, 2.0, 1.1);
    deco(M.black, -1.3, y + 0.35, -1.42, 0.6, 0.55, 0.06);
    const glow = track(new THREE.MeshBasicMaterial({ color: 0xff5a1e }));
    deco(glow, -1.3, y + 0.42, -1.38, 0.44, 0.38, 0.02);
    const fl = new THREE.PointLight(0xff4a12, 16, 6.5, 1.9);
    fl.position.set(-1.4, y + 0.6, -1.3);
    root.add(fl);
    // Ducts overhead — the reason a basement reads as a basement.
    for (const dz of [-4.0, -2.6]) deco(M.steel, -3.6, y + 2.05, dz, 5.4, 0.3, 0.3);
    prop(M.darkOak, -5.6, y, -1.9, 0.5, 1.9, 1.4); // shelving
  }

  /* Bedrooms. */
  const bed = (x: number, z: number, w: number, quiltHex: string) => {
    prop(M.darkOak, x, FLOOR.upper, z, w, 0.42, 2.0);
    deco(track(new THREE.MeshStandardMaterial({ color: new THREE.Color(quiltHex), roughness: 1 })), x, FLOOR.upper + 0.42, z, w + 0.06, 0.22, 2.0);
    deco(M.white, x, FLOOR.upper + 0.6, z - 0.72, w - 0.3, 0.14, 0.42);
    deco(M.darkOak, x, FLOOR.upper + 0.42, z - 1.02, w, 0.7, 0.08);
  };
  bed(0.2, 3.4, 1.0, "#2f5a8a"); // Kevin
  bed(4.6, 3.2, 1.5, "#6a4a6e"); // Mom & Dad
  bed(4.4, -3.4, 1.0, "#3c5a3a"); // Buzz
  bed(-3.2, -3.4, 1.0, "#7a6a4a"); // guest
  prop(M.darkOak, 1.7, FLOOR.upper, 1.2, 0.5, 1.4, 0.9); // Kevin's dresser
  prop(M.darkOak, 6.2, FLOOR.upper, 1.4, 0.5, 1.3, 1.4);
  prop(M.white, IN.W + 0.6, FLOOR.upper, 4.6, 0.9, 0.6, 1.7); // bathtub
  prop(M.white, -4.4, FLOOR.upper, 1.1, 0.6, 0.8, 0.5); // basin

  /* ------------------------------------------------------------------ *
   * OUTSIDE
   * ------------------------------------------------------------------ */

  {
    const g = new THREE.PlaneGeometry(220, 220, 1, 1);
    disposables.push(g);
    const ground = new THREE.Mesh(g, surface("snow", 220, 220));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    root.add(ground);
    /*
     * The *visual* plane runs under the house; the walkable slab must not.
     *
     * `groundAt` takes the highest surface beneath you, and a snow plane at
     * -0.02 spanning the whole world is higher than every step of the cellar
     * flight. With one big slab you walk out of the back hall, through the
     * open stairwell, and land on the lawn — inside the house, on the ground
     * floor, two metres above the basement you were trying to reach. So the
     * outside is four strips around the footprint and the house owns its own
     * floors.
     */
    // Exactly the footprint, not a metre outside it. An over-wide exclusion
    // leaves a ring of no-floor hugging the walls — step off the porch or out
    // of a ground-floor window and you fall out of the world.
    const HX0 = X.W, HX1 = X.E, HZ0 = Z.N, HZ1 = Z.S;
    slabs.push({ x0: -110, x1: 110, z0: -110, z1: HZ0, y: -0.02 });
    slabs.push({ x0: -110, x1: 110, z0: HZ1, z1: 110, y: -0.02 });
    slabs.push({ x0: -110, x1: HX0, z0: HZ0, z1: HZ1, y: -0.02 });
    slabs.push({ x0: HX1, x1: 110, z0: HZ0, z1: HZ1, y: -0.02 });
  }
  {
    const g = new THREE.PlaneGeometry(200, 7.5);
    disposables.push(g);
    const road = new THREE.Mesh(g, surface("street", 200, 7.5));
    road.rotation.x = -Math.PI / 2;
    road.position.set(4, 0.01, STREET.centre);
    root.add(road);
    slabs.push({ x0: -96, x1: 104, z0: STREET.centre - 3.75, z1: STREET.centre + 3.75, y: 0.005 });
    // Kerb ridge of ploughed snow, which is what a Chicago street looks like.
    for (const s of [-1, 1]) deco(M.snowCap, 4, 0, STREET.centre + s * 4.1, 190, 0.42, 0.9);
    // Pavement.
    const pg = new THREE.PlaneGeometry(200, 1.8);
    disposables.push(pg);
    const pave = new THREE.Mesh(pg, M.snowCap);
    pave.rotation.x = -Math.PI / 2;
    pave.position.set(4, 0.03, STREET.kerb - 2.6);
    root.add(pave);
  }
  // Front walk from the porch to the pavement.
  {
    // Shovelled, with the banks of snow either side doing the work. A bright
    // path reads as a garden feature; this one reads as somebody cleared it.
    const walkLen = STREET.kerb - Z.S - 2.4;
    const walk = track(new THREE.MeshStandardMaterial({ color: 0x6f7480, roughness: 0.9 }));
    deco(walk, 0.4, 0.02, (Z.S + STREET.kerb) / 2 + 0.6, 1.5, 0.03, walkLen);
    for (const sx of [-1, 1]) deco(M.snowCap, 0.4 + sx * 0.95, 0.0, (Z.S + STREET.kerb) / 2 + 0.6, 0.5, 0.22, walkLen);
  }

  /* Neighbour houses — boxes with lit windows. From the street they only ever
     need to be a silhouette and a row of warm rectangles. */
  const litMat = track(new THREE.MeshBasicMaterial({ map: T.litWindow(3) }));
  const coldMat = track(new THREE.MeshBasicMaterial({ map: T.darkWindow(3) }));
  for (const n of NEIGHBOURS) {
    const grp = new THREE.Group();
    grp.position.set(n.x, 0, n.z);
    grp.rotation.y = n.rot;
    root.add(grp);
    const body = new THREE.Mesh(BOX, track(new THREE.MeshStandardMaterial({ color: new THREE.Color(n.hue), roughness: 0.95 })));
    const hgt = n.storeys * 3.1 + 0.6;
    body.position.y = hgt / 2;
    body.scale.set(n.w, hgt, n.d);
    grp.add(body);
    const roofG = new THREE.ConeGeometry(Math.max(n.w, n.d) * 0.78, 2.6, 4);
    disposables.push(roofG);
    const rf = new THREE.Mesh(roofG, surface("roof", 4, 4));
    rf.position.y = hgt + 1.3;
    rf.rotation.y = Math.PI / 4;
    grp.add(rf);
    const wg = new THREE.PlaneGeometry(1.1, 1.4);
    disposables.push(wg);
    for (let s = 0; s < n.storeys; s++) {
      for (let i = 0; i < 4; i++) {
        const lit = ((i * 7 + s * 3) % 10) / 10 < n.lit;
        for (const face of [1, -1]) {
          const m = new THREE.Mesh(wg, lit ? litMat : coldMat);
          m.position.set(-n.w / 2 + 1.6 + i * ((n.w - 3.2) / 3), 1.3 + s * 3.1, (face * n.d) / 2 + face * 0.02);
          m.rotation.y = face > 0 ? 0 : Math.PI;
          grp.add(m);
        }
      }
      if (n.lit > 0.45) {
        const gl = new THREE.PointLight(0xffb066, 14, 16, 1.6);
        gl.position.set(0, 1.6 + s * 3.1, n.d / 2 + 1.2);
        grp.add(gl);
      }
    }
    // Snow on their roofs too.
    const cap = new THREE.Mesh(roofG, M.snowCap);
    cap.position.y = hgt + 1.42;
    cap.rotation.y = Math.PI / 4;
    cap.scale.set(0.97, 0.45, 0.97);
    grp.add(cap);
  }

  /* Bare winter trees. Trunk plus a scribble of branches, and a snow cap. */
  const bark = track(new THREE.MeshStandardMaterial({ color: 0x372c22, roughness: 1 }));
  const treeSeed = (i: number) => Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
  const TREE_SPOTS: Array<[number, number]> = [
    [-11.5, 8.5], [12.0, 8.0], [-16.0, 9.5], [17.5, 9.0], [28.0, 8.0], [-27.0, 9.0],
    [-12.0, -9.0], [11.0, -10.5], [-19.0, -6.0], [20.0, -8.0], [-5.0, -13.0], [6.5, -14.0],
    [-24.0, 19.0], [8.0, 20.0], [26.0, 20.0], [-8.0, 21.0],
  ];
  for (let i = 0; i < TREE_SPOTS.length; i++) {
    const [tx, tz] = TREE_SPOTS[i];
    const h = 5.5 + treeSeed(i) * 4;
    deco(bark, tx, 0, tz, 0.42, h, 0.42);
    colliders.push({ x0: tx - 0.3, x1: tx + 0.3, z0: tz - 0.3, z1: tz + 0.3, y0: 0, y1: h });
    for (let b = 0; b < 9; b++) {
      const a = b * 1.9 + treeSeed(i + b) * 2;
      const len = 1.4 + treeSeed(i * 3 + b) * 1.8;
      const by = h * (0.5 + (b / 9) * 0.45);
      const br = new THREE.Mesh(BOX, bark);
      br.position.set(tx + (Math.cos(a) * len) / 2, by, tz + (Math.sin(a) * len) / 2);
      br.scale.set(len, 0.14, 0.14);
      br.rotation.y = -a;
      br.rotation.z = 0.5 + treeSeed(i + b * 5) * 0.4;
      root.add(br);
      const snowline = new THREE.Mesh(BOX, M.snowCap);
      snowline.position.copy(br.position);
      snowline.position.y += 0.09;
      snowline.scale.set(len, 0.05, 0.16);
      snowline.rotation.copy(br.rotation);
      root.add(snowline);
    }
  }

  /* Streetlights: sodium orange, the only light on the street. */
  for (const s of STREETLIGHTS) {
    deco(M.black, s.x, 0, s.z, 0.16, 5.4, 0.16);
    deco(M.black, s.x + 0.6, 5.3, s.z, 1.3, 0.12, 0.12);
    const head = new THREE.Mesh(BOX, track(new THREE.MeshBasicMaterial({ color: 0xffe3bc })));
    head.position.set(s.x + 1.2, 5.18, s.z);
    head.scale.set(0.42, 0.18, 0.34);
    root.add(head);
    const l = new THREE.PointLight(0xffbf7e, 46, 26, 1.5);
    l.position.set(s.x + 1.2, 5.0, s.z);
    root.add(l);
  }

  /* Picket fence along the back of the lot, and the treehouse. */
  for (let i = 0; i < 44; i++) {
    const fx = -22 + i * 1.0;
    deco(M.trim, fx, 0, -21.0, 0.12, 1.05, 0.08);
  }
  const tree = new THREE.Group();
  tree.position.set(TREEHOUSE.x, 0, TREEHOUSE.z);
  root.add(tree);
  {
    deco(bark, TREEHOUSE.x, 0, TREEHOUSE.z, 0.85, TREEHOUSE.deckY + 2.2, 0.85);
    colliders.push({
      x0: TREEHOUSE.x - 0.5, x1: TREEHOUSE.x + 0.5,
      z0: TREEHOUSE.z - 0.5, z1: TREEHOUSE.z + 0.5,
      // Stops below the deck: a trunk that carries on through it shoves
      // anyone standing on the deck sideways off it.
      y0: 0, y1: TREEHOUSE.deckY - 0.25,
    });
    const deck = box(M.oak, TREEHOUSE.x, TREEHOUSE.deckY, TREEHOUSE.z, 3.4, 0.16, 3.4, false);
    deck.receiveShadow = true;
    slabs.push({
      x0: TREEHOUSE.x - 1.7, x1: TREEHOUSE.x + 1.7,
      z0: TREEHOUSE.z - 1.7, z1: TREEHOUSE.z + 1.7,
      y: TREEHOUSE.deckY + 0.16,
    });
    for (const [ox, oz, w, d] of [[0, -1.7, 3.4, 0.12], [-1.7, 0, 0.12, 3.4], [1.7, 0, 0.12, 3.4]] as const)
      box(M.oak, TREEHOUSE.x + ox, TREEHOUSE.deckY + 0.16, TREEHOUSE.z + oz, w, 1.5, d, true);
    deco(surface("roof", 3.8, 3.8), TREEHOUSE.x, TREEHOUSE.deckY + 1.7, TREEHOUSE.z, 3.8, 0.2, 3.8);
    deco(M.snowCap, TREEHOUSE.x, TREEHOUSE.deckY + 1.9, TREEHOUSE.z, 3.9, 0.08, 3.9);
  }

  /* The zipline. Hidden until the last level asks for it. */
  const zipGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(ZIP_START.x, ZIP_START.y, ZIP_START.z),
    new THREE.Vector3(ZIP_END.x, ZIP_END.y, ZIP_END.z),
  ]);
  disposables.push(zipGeo);
  const zipMat = track(new THREE.LineBasicMaterial({ color: 0x8d7f6d }));
  const zip = new THREE.Line(zipGeo, zipMat);
  zip.visible = false;
  root.add(zip);

  /* The van. Parked down the block until the burglars need it. */
  const van = new THREE.Group();
  van.position.set(-16, 0, STREET.centre - 1.2);
  van.rotation.y = Math.PI / 2;
  root.add(van);
  {
    const body = new THREE.Mesh(BOX, track(new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.62, metalness: 0.3 })));
    body.position.set(0, 1.35, 0);
    body.scale.set(2.1, 1.65, 5.0);
    van.add(body);
    const cab = new THREE.Mesh(BOX, track(new THREE.MeshStandardMaterial({ color: 0x1b2733, roughness: 0.2, metalness: 0.4 })));
    cab.position.set(0, 1.75, 2.15);
    cab.scale.set(2.0, 0.85, 0.9);
    van.add(cab);
    for (const [wx, wz] of [[-1.02, 1.7], [1.02, 1.7], [-1.02, -1.7], [1.02, -1.7]] as const) {
      const w = new THREE.Mesh(BOX, M.black);
      w.position.set(wx, 0.52, wz);
      w.scale.set(0.28, 1.02, 1.02);
      van.add(w);
    }
    const plate = new THREE.Mesh(BOX, track(new THREE.MeshBasicMaterial({ color: 0xe8e2cc })));
    plate.position.set(0, 0.9, -2.55);
    plate.scale.set(0.7, 0.22, 0.04);
    van.add(plate);
  }

  /* Falling snow. One Points cloud, recycled through a box around the camera —
     the engine moves it, so it always snows wherever you are. */
  const FLAKES = 2600;
  const pos = new Float32Array(FLAKES * 3);
  for (let i = 0; i < FLAKES; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 90;
    pos[i * 3 + 1] = Math.random() * 30;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 90;
  }
  const snowGeo = new THREE.BufferGeometry();
  snowGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  disposables.push(snowGeo);
  const snowMat = track(
    new THREE.PointsMaterial({
      map: T.softDot(),
      size: 0.14,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      sizeAttenuation: true,
      blending: THREE.NormalBlending,
    }),
  );
  const snowPts = new THREE.Points(snowGeo, snowMat);
  snowPts.frustumCulled = false;
  root.add(snowPts);

  /* ------------------------------------------------------------------ */

  const allRoomLights = [...roomLights.values()];

  function setRoomLight(room: RoomId, on: boolean) {
    const rl = roomLights.get(room);
    if (!rl) return;
    rl.on = on;
    for (const g of rl.glass) g.emissiveIntensity = on ? 1.15 : 0;
  }

  /**
   * Sixteen point lights is more than a phone will shade happily, and you can
   * never see more than a few rooms at once anyway. Keep the six nearest lit
   * rooms actually enabled and zero the rest — `on` stays true so the windows
   * still glow from the street, which is the part that matters at a distance.
   */
  function cullLights(px: number, py: number, pz: number) {
    const scored = allRoomLights
      .filter((r) => r.on)
      .map((r) => ({
        r,
        d: (r.light.position.x - px) ** 2 + ((r.light.position.y - py) * 2.2) ** 2 + (r.light.position.z - pz) ** 2,
      }))
      .sort((a, b) => a.d - b.d);
    for (const r of allRoomLights) r.light.intensity = 0;
    for (let i = 0; i < Math.min(6, scored.length); i++) {
      const { r, d } = scored[i];
      r.light.intensity = d > 900 ? 0 : ROOM_LUX;
    }
  }

  function dispose() {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const d of disposables) d.dispose();
    scene.remove(root);
  }

  return {
    root,
    colliders,
    // The camera is stopped by everything the player is, plus the glass.
    camBlockers: [...colliders, ...camBlockers],
    slabs,
    ramps: [MAIN_STAIR, CELLAR_STAIR],
    roomLights,
    doors,
    fire: fire!,
    treeLights,
    snow: snowPts,
    van,
    zip,
    porchLight,
    cullLights,
    setRoomLight,
    dispose,
  };
}
