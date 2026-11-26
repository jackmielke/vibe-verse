/**
 * Shared bits for the landmarks: collision helpers, world-scaled geometry,
 * canvas textures, and the elevator.
 *
 * Nothing in here knows which landmark it is building. The three buildings
 * (`empireState.ts`, `spaceNeedle.ts`, `eiffel.ts`) describe themselves with
 * these pieces and `index.ts` runs them.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WorldBox } from "@/components/city/cardboardIsland";

export type LandmarkKey = "needle" | "empire" | "eiffel";

/** Something the player can walk up to and press E at. */
export interface Station {
  id: string;
  /** Shown on the pill: "Ride to the top". */
  label: string;
  emoji: string;
  /** World position of the spot, at floor level. */
  pos: THREE.Vector3;
  /** Horizontal reach, metres. */
  radius: number;
  /** Vertical reach above `pos.y`. */
  height?: number;
  /** Return false to hide the prompt right now (a car that is away). */
  available?: () => boolean;
  act(): void;
}

/** A spot the camera can look out from. */
export interface Viewer {
  eye: THREE.Vector3;
  /** Which way it points when you step up to it, as a chase-camera yaw. */
  yaw: number;
}

export interface Glow {
  /** Day: 0, night: 1. Each landmark eases its own lights toward it. */
  set(night: boolean): void;
}

// ---- Collision -----------------------------------------------------------

/** Push one solid box: centre x/z, size w/d, from y0 to y1. */
export function solid(boxes: WorldBox[], cx: number, cz: number, w: number, d: number, y0: number, y1: number) {
  boxes.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2, base: y0, height: y1 });
}

/**
 * A round floor, out of boxes.
 *
 * Collision is axis-aligned boxes and nothing else, and one square slab under
 * a round deck holds the player up in mid-air off every corner. Strips across
 * the disc, each as wide as the circle is at that row, are close enough that
 * the gap between the drawn edge and the walkable one is under half a metre.
 */
export function discFloor(boxes: WorldBox[], cx: number, cz: number, r: number, y: number, strips = 10, thick = 0.4) {
  const step = (2 * r) / strips;
  for (let i = 0; i < strips; i++) {
    const z0 = -r + i * step;
    const z1 = z0 + step;
    // The strip is as wide as the circle at its widest row.
    const zm = z0 <= 0 && z1 >= 0 ? 0 : Math.min(Math.abs(z0), Math.abs(z1));
    const half = Math.sqrt(Math.max(0, r * r - zm * zm));
    boxes.push({ minX: cx - half, maxX: cx + half, minZ: cz + z0, maxZ: cz + z0 + step, base: y - thick, height: y });
  }
}

/**
 * A round railing: short boxes on a circle, with gaps where `open` says.
 * `open` takes the angle (radians, atan2(z, x)) of each segment's middle.
 */
export function ringWall(
  boxes: WorldBox[],
  cx: number,
  cz: number,
  r: number,
  y0: number,
  y1: number,
  segments = 24,
  thick = 0.5,
  open?: (a: number) => boolean,
) {
  for (let i = 0; i < segments; i++) {
    const a = ((i + 0.5) / segments) * Math.PI * 2;
    if (open?.(a)) continue;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    const chord = 2 * r * Math.sin(Math.PI / segments);
    // An AABB around a rotated plank: the long side projected onto each axis.
    const w = Math.abs(Math.sin(a)) * chord + thick;
    const d = Math.abs(Math.cos(a)) * chord + thick;
    solid(boxes, x, z, w, d, y0, y1);
  }
}

/** A square ring of floor: outer half-size `ho`, inner hole half-size `hi`. */
export function squareRing(boxes: WorldBox[], cx: number, cz: number, ho: number, hi: number, y: number, thick = 0.5) {
  const band = ho - hi;
  solid(boxes, cx, cz + hi + band / 2, ho * 2, band, y - thick, y);
  solid(boxes, cx, cz - hi - band / 2, ho * 2, band, y - thick, y);
  solid(boxes, cx + hi + band / 2, cz, band, hi * 2, y - thick, y);
  solid(boxes, cx - hi - band / 2, cz, band, hi * 2, y - thick, y);
}

/** Four walls round a square, `gap` metres open in the middle of the sides `doors` lists (0 +z, 1 -z, 2 +x, 3 -x). */
export function squareWall(
  boxes: WorldBox[],
  cx: number,
  cz: number,
  half: number,
  y0: number,
  y1: number,
  thick = 0.4,
  doors: number[] = [],
  gap = 2.4,
) {
  const sides: Array<[number, number, boolean]> = [
    [0, half, false],
    [0, -half, false],
    [half, 0, true],
    [-half, 0, true],
  ];
  sides.forEach(([ox, oz, alongZ], i) => {
    if (!doors.includes(i)) {
      if (alongZ) solid(boxes, cx + ox, cz, thick, half * 2 + thick, y0, y1);
      else solid(boxes, cx, cz + oz, half * 2 + thick, thick, y0, y1);
      return;
    }
    const seg = half - gap / 2;
    const mid = gap / 2 + seg / 2;
    if (alongZ) {
      solid(boxes, cx + ox, cz + mid, thick, seg + thick, y0, y1);
      solid(boxes, cx + ox, cz - mid, thick, seg + thick, y0, y1);
    } else {
      solid(boxes, cx + mid, cz + oz, seg + thick, thick, y0, y1);
      solid(boxes, cx - mid, cz + oz, seg + thick, thick, y0, y1);
    }
  });
}

// ---- Geometry --------------------------------------------------------------

/**
 * The four sides of a box, UV'd in world metres divided by `tile`.
 *
 * Three's BoxGeometry stretches one texture over each face whatever its size,
 * so a 100 m shaft and a 4 m crown would get the same number of windows. This
 * keeps a window the size of a window everywhere.
 */
export function prismSides(w: number, d: number, y0: number, y1: number, tileU: number, tileV: number, cx = 0, cz = 0) {
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const h = y1 - y0;
  const faces: Array<{ o: [number, number]; t: [number, number]; n: [number, number]; len: number }> = [
    { o: [-w / 2, d / 2], t: [1, 0], n: [0, 1], len: w },
    { o: [w / 2, d / 2], t: [0, -1], n: [1, 0], len: d },
    { o: [w / 2, -d / 2], t: [-1, 0], n: [0, -1], len: w },
    { o: [-w / 2, -d / 2], t: [0, 1], n: [-1, 0], len: d },
  ];
  for (const f of faces) {
    const b = pos.length / 3;
    const corners: Array<[number, number]> = [
      [0, 0],
      [f.len, 0],
      [f.len, h],
      [0, h],
    ];
    for (const [s, t] of corners) {
      pos.push(cx + f.o[0] + f.t[0] * s, y0 + t, cz + f.o[1] + f.t[1] * s);
      nrm.push(f.n[0], 0, f.n[1]);
      uv.push(s / tileU, (y0 + t) / tileV);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** An upward-facing rectangle at height y. */
export function flatTop(w: number, d: number, y: number, cx = 0, cz = 0, tile = 4) {
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  g.translate(cx, y, cz);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w) / tile, (uv.getY(i) * d) / tile);
  return g;
}

/** A straight member from a to b, `r` thick, `sides` faces round. */
export function beam(a: THREE.Vector3, b: THREE.Vector3, r: number, sides = 4, r2 = r) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r2, r, len, sides, 1, false);
  if (sides === 4) g.rotateY(Math.PI / 4);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return g;
}

/**
 * A flat quad through four points (counter-clockwise seen from the front),
 * UV'd in metres / tile so a lattice texture keeps its pitch as a face tapers.
 */
export function quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, tile: number) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([a, b, c, d].flatMap((v) => [v.x, v.y, v.z]), 3));
  const wBot = a.distanceTo(b);
  const wTop = d.distanceTo(c);
  const h = (a.y + b.y) / 2;
  const ht = (c.y + d.y) / 2;
  const off = (wBot - wTop) / 2;
  g.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute([0, h / tile, wBot / tile, h / tile, (off + wTop) / tile, ht / tile, off / tile, ht / tile], 2),
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

/** Merge and forget the parts. Returns null for an empty list. */
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // Every part has to agree on attributes before mergeGeometries will take
  // them; a CylinderGeometry and a hand-built quad do not, out of the box.
  const clean = parts.map((n) => {
    if (!n.attributes.uv) {
      n.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(n.attributes.position.count * 2), 2));
    }
    if (!n.attributes.normal) n.computeVertexNormals();
    for (const k of Object.keys(n.attributes)) if (!["position", "normal", "uv"].includes(k)) n.deleteAttribute(k);
    return n.index ? n.toNonIndexed() : n;
  });
  const m = mergeGeometries(clean, false) ?? new THREE.BufferGeometry();
  parts.forEach((g) => g.dispose());
  clean.forEach((g) => g.dispose());
  return m;
}

// ---- Textures --------------------------------------------------------------

export function canvas(w: number, h = w) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, x: c.getContext("2d")! };
}

export function tex(c: HTMLCanvasElement, repeat = true, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Deterministic little RNG so a landmark looks the same on every visit. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** A sign: text on a plate, for entrances. */
export function signTexture(lines: Array<{ text: string; size: number; color?: string; font?: string }>, bg: string, w = 1024, h = 256, border?: string) {
  const { c, x } = canvas(w, h);
  x.fillStyle = bg;
  x.fillRect(0, 0, w, h);
  if (border) {
    x.strokeStyle = border;
    x.lineWidth = 10;
    x.strokeRect(14, 14, w - 28, h - 28);
  }
  const total = lines.reduce((s, l) => s + l.size * 1.2, 0);
  let y = (h - total) / 2;
  x.textAlign = "center";
  x.textBaseline = "top";
  for (const l of lines) {
    x.fillStyle = l.color ?? "#fff";
    x.font = `${l.font ?? "700"} ${l.size}px "Georgia", "Times New Roman", serif`;
    x.fillText(l.text, w / 2, y);
    y += l.size * 1.2;
  }
  return tex(c, false);
}

// ---- The elevator ------------------------------------------------------------

/**
 * One elevator car on a path.
 *
 * The path is a polyline with a stop at each end; the car is drawn by the
 * landmark and moved here. A rider is not physically carried — there are no
 * moving collision boxes in this world — they are *locked*: every frame,
 * after the player's physics step, their feet are put back on the car floor.
 * That is the same trick the zeppelin deck uses, and the only one that
 * survives a slow frame in which the car moves several metres.
 */
export class Elevator {
  readonly id: string;
  readonly car: THREE.Object3D;
  /** In the car's parent's space. */
  readonly path: THREE.Vector3[];
  /** World position of that space's origin; the parent must not rotate. */
  readonly origin: THREE.Vector3;
  /** 0 at the bottom stop, 1 at the top. */
  at: 0 | 1;
  /** Where the car is along the path, metres. */
  s: number;
  private readonly lengths: number[];
  readonly total: number;
  private readonly speed: number;
  /** Heading of a car door, so a rider stepping out goes the right way. */
  readonly exits: [THREE.Vector3, THREE.Vector3];
  moving: 0 | 1 | -1 = 0;
  /** Seconds the doors stay shut before moving, and after arriving. */
  private dwell = 0;
  rider = false;
  onArrive: ((top: boolean, rider: boolean) => void) | null = null;
  onDepart: ((up: boolean, rider: boolean) => void) | null = null;
  private readonly tmp = new THREE.Vector3();

  constructor(opts: {
    id: string;
    car: THREE.Object3D;
    path: THREE.Vector3[];
    origin?: THREE.Vector3;
    /** Where a rider is put down at the bottom and at the top. */
    exits: [THREE.Vector3, THREE.Vector3];
    startAtTop?: boolean;
    speed?: number;
  }) {
    this.id = opts.id;
    this.car = opts.car;
    this.path = opts.path;
    this.origin = opts.origin ?? new THREE.Vector3();
    this.exits = opts.exits;
    this.lengths = [];
    let t = 0;
    for (let i = 1; i < this.path.length; i++) {
      const l = this.path[i].distanceTo(this.path[i - 1]);
      this.lengths.push(l);
      t += l;
    }
    this.total = t;
    this.speed = opts.speed ?? 9;
    this.at = opts.startAtTop ? 1 : 0;
    this.s = opts.startAtTop ? t : 0;
    this.place();
  }

  /** The car floor, in the parent's space, at path distance s. */
  pointAt(s: number, out = this.tmp) {
    let rem = THREE.MathUtils.clamp(s, 0, this.total);
    for (let i = 0; i < this.lengths.length; i++) {
      const l = this.lengths[i];
      if (rem <= l || i === this.lengths.length - 1) {
        return out.lerpVectors(this.path[i], this.path[i + 1], l > 0 ? Math.min(1, rem / l) : 1);
      }
      rem -= l;
    }
    return out.copy(this.path[this.path.length - 1]);
  }

  /** The car floor, in world space, now. */
  get floor() {
    return this.pointAt(this.s, this.world).add(this.origin);
  }
  private readonly world = new THREE.Vector3();

  /** 0..1 along the ride. */
  get progress() {
    return this.total > 0 ? this.s / this.total : 0;
  }

  private place() {
    this.car.position.copy(this.pointAt(this.s, this.tmp));
  }

  /** Send the car to the other end. `rider` says whether the player is aboard. */
  go(rider: boolean) {
    if (this.moving) return;
    this.rider = rider;
    this.moving = this.at === 0 ? 1 : -1;
    this.dwell = 0.9;
    this.onDepart?.(this.moving === 1, rider);
  }

  /** Is (x, y, z) standing in the car right now? */
  holds(p: THREE.Vector3, half = 1.3) {
    const f = this.floor;
    return Math.abs(p.x - f.x) < half && Math.abs(p.z - f.z) < half && p.y > f.y - 0.6 && p.y < f.y + 2.2;
  }

  update(dt: number) {
    if (!this.moving) return;
    if (this.dwell > 0) {
      this.dwell -= dt;
      return;
    }
    // Ease in and out: full speed in the middle, a third of it at the ends.
    const edge = Math.min(this.s, this.total - this.s);
    const v = this.speed * THREE.MathUtils.clamp(0.33 + edge / 12, 0.33, 1);
    this.s += this.moving * v * dt;
    if (this.s >= this.total || this.s <= 0) {
      this.s = THREE.MathUtils.clamp(this.s, 0, this.total);
      this.at = this.moving === 1 ? 1 : 0;
      this.moving = 0;
      const rider = this.rider;
      this.rider = false;
      this.place();
      this.onArrive?.(this.at === 1, rider);
      return;
    }
    this.place();
  }
}
