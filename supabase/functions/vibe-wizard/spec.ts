/**
 * The Wizard's world format: what a wish is allowed to become.
 *
 * A wish never becomes code. It becomes a list of ops on a list of things,
 * and a thing is a pile of coloured primitives with a little motion. That is
 * the whole reason a stranger's wish can be broadcast to everybody on the
 * island and drawn on their machine: there is nothing in it that runs.
 *
 * This file is pure and imported from both sides. The edge function sanitises
 * what the model wrote before it is stored, and the browser sanitises what it
 * reads back before it is drawn, because the database is a place anybody with
 * the service key can write to and the renderer should not have to trust it.
 *
 * Coordinates: the model writes `at` relative to the wisher (x right, y up,
 * z forward, metres) and `toWorld` turns that into absolute island
 * coordinates before anything is stored. Everything in the table is absolute.
 */

export const SHAPES = [
  "box", "sphere", "cylinder", "cone", "torus", "capsule", "pyramid", "gem", "icosa", "dodeca", "ring", "text",
] as const;
export type Shape = typeof SHAPES[number];

export const ANIMS = ["spin", "bob", "pulse", "sway", "orbit", "wander", "flap", "hover"] as const;
export type AnimKind = typeof ANIMS[number];

export const FX = ["sparkles", "fire", "smoke", "snow", "bubbles", "hearts", "rain", "confetti", "fireflies"] as const;
export type Fx = typeof FX[number];

export type Vec3 = [number, number, number];

export interface Anim {
  k: AnimKind;
  /** Cycles per second, roughly. */
  sp?: number;
  /** Metres for bob/orbit/wander, degrees for sway/flap, fraction for pulse. */
  amt?: number;
  ax?: "x" | "y" | "z";
}

export interface Part {
  s: Shape;
  /** Position inside the thing, metres. */
  p?: Vec3;
  /** Bounding size [w, h, d] in metres; every shape is scaled to fit it. */
  size?: Vec3;
  /** Rotation in degrees. */
  r?: Vec3;
  /** "#rrggbb". */
  c?: string;
  /** Glow, 0 to 3. */
  e?: number;
  /** Metalness 0 to 1. */
  m?: number;
  /** Opacity 0.1 to 1. */
  o?: number;
  a?: Anim;
  /** Only for s: "text". */
  t?: string;
}

export interface Thing {
  id: string;
  name: string;
  at: Vec3;
  /** Degrees about y. */
  yaw?: number;
  scale?: number;
  parts: Part[];
  a?: Anim;
  fx?: Fx;
  light?: { c?: string; i?: number; d?: number };
  /** Who wished it, for the label. */
  by?: string;
}

export type Op =
  | { op: "add"; thing: Thing }
  | { op: "remove"; id: string }
  | { op: "edit"; id: string; at?: Vec3; yaw?: number; scale?: number; tint?: string; a?: Anim | null; fx?: Fx | null };

export interface Here { x: number; y: number; z: number; /** Facing, radians; forward is (-sin yaw, -cos yaw) as in three. */ yaw: number }

export const LIMITS = {
  fast: { things: 6, parts: 70 },
  smart: { things: 12, parts: 160 },
  /** The world keeps this many things; older ones fade out first. */
  worldThings: 160,
  reach: 90,
  maxSize: 60,
  text: 40,
} as const;

const num = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : d;
  return Math.min(hi, Math.max(lo, n));
};
const vec = (v: unknown, lo: number, hi: number, d: Vec3): Vec3 => {
  if (!Array.isArray(v)) return [...d] as Vec3;
  return [num(v[0], lo, hi, d[0]), num(v[1], lo, hi, d[1]), num(v[2], lo, hi, d[2])];
};
const HEX = /^#[0-9a-fA-F]{6}$/;
const SHORT = /^#[0-9a-fA-F]{3}$/;
export function color(v: unknown, d = "#cccccc"): string {
  if (typeof v !== "string") return d;
  const s = v.trim();
  if (HEX.test(s)) return s.toLowerCase();
  if (SHORT.test(s)) return ("#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
  return d;
}
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | undefined =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined;

export function cleanId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || null;
}

/** Ids are prefixed per edit so two wishes for "dragon" never collide. */
export function scopedId(prefix: string, raw: unknown, i: number): string {
  return `${prefix}-${cleanId(raw) ?? "thing" + i}`.slice(0, 60);
}

export function cleanAnim(v: unknown): Anim | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const k = oneOf(ANIMS, o.k);
  if (!k) return undefined;
  const a: Anim = { k, sp: num(o.sp, 0, 6, 0.5), amt: num(o.amt, 0, 90, k === "sway" || k === "flap" ? 25 : 1) };
  const ax = oneOf(["x", "y", "z"] as const, o.ax);
  if (ax) a.ax = ax;
  return a;
}

export function cleanPart(v: unknown): Part | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const s = oneOf(SHAPES, o.s);
  if (!s) return null;
  const p: Part = {
    s,
    p: vec(o.p, -LIMITS.maxSize, LIMITS.maxSize, [0, 0, 0]),
    size: vec(o.size, 0.02, LIMITS.maxSize, [1, 1, 1]),
    c: color(o.c),
  };
  if (Array.isArray(o.r)) p.r = vec(o.r, -360, 360, [0, 0, 0]);
  if (typeof o.e === "number") p.e = num(o.e, 0, 3, 0);
  if (typeof o.m === "number") p.m = num(o.m, 0, 1, 0);
  if (typeof o.o === "number") p.o = num(o.o, 0.1, 1, 1);
  const a = cleanAnim(o.a);
  if (a) p.a = a;
  if (s === "text") {
    const t = typeof o.t === "string" ? o.t.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, LIMITS.text) : "";
    if (!t) return null;
    p.t = t;
  }
  return p;
}

export function cleanThing(v: unknown, maxParts: number = LIMITS.smart.parts): Thing | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = cleanId(o.id);
  if (!id) return null;
  const parts = (Array.isArray(o.parts) ? o.parts : []).slice(0, maxParts).map(cleanPart).filter(Boolean) as Part[];
  if (!parts.length) return null;
  const t: Thing = {
    id,
    name: typeof o.name === "string" ? o.name.trim().slice(0, 48) || id : id,
    at: vec(o.at, -100000, 100000, [0, 0, 0]),
    yaw: num(o.yaw, -720, 720, 0),
    scale: num(o.scale, 0.05, 20, 1),
    parts,
  };
  const a = cleanAnim(o.a);
  if (a) t.a = a;
  const fx = oneOf(FX, o.fx);
  if (fx) t.fx = fx;
  if (o.light && typeof o.light === "object") {
    const l = o.light as Record<string, unknown>;
    t.light = { c: color(l.c, "#fff2cc"), i: num(l.i, 0, 6, 1.5), d: num(l.d, 1, 60, 12) };
  }
  if (typeof o.by === "string") t.by = o.by.slice(0, 32);
  return t;
}

export function cleanOp(v: unknown, maxParts: number = LIMITS.smart.parts): Op | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.op === "add") {
    const thing = cleanThing(o.thing, maxParts);
    return thing ? { op: "add", thing } : null;
  }
  const id = typeof o.id === "string" ? o.id.slice(0, 60) : null;
  if (!id) return null;
  if (o.op === "remove") return { op: "remove", id };
  if (o.op === "edit") {
    const e: Op = { op: "edit", id };
    if (Array.isArray(o.at)) e.at = vec(o.at, -100000, 100000, [0, 0, 0]);
    if (typeof o.yaw === "number") e.yaw = num(o.yaw, -720, 720, 0);
    if (typeof o.scale === "number") e.scale = num(o.scale, 0.05, 20, 1);
    if (typeof o.tint === "string") e.tint = color(o.tint);
    if (o.a === null) e.a = null;
    else { const a = cleanAnim(o.a); if (a) e.a = a; }
    if (o.fx === null) e.fx = null;
    else { const fx = oneOf(FX, o.fx); if (fx) e.fx = fx; }
    return e;
  }
  return null;
}

export function cleanOps(v: unknown, maxParts: number = LIMITS.smart.parts, maxOps = 40): Op[] {
  return (Array.isArray(v) ? v : []).slice(0, maxOps).map((o) => cleanOp(o, maxParts)).filter(Boolean) as Op[];
}

/**
 * Relative to the wisher → absolute. Forward is where the wisher faces, and
 * yaw 0 means "facing the wisher" (a statue you asked for looks at you).
 */
export function toWorld(rel: Vec3, here: Here): Vec3 {
  const [x, y, z] = rel;
  const s = Math.sin(here.yaw), c = Math.cos(here.yaw);
  // Forward (-sin, -cos); right (cos, -sin).
  const fx = -s, fz = -c, rx = c, rz = -s;
  const cx = Math.max(-LIMITS.reach, Math.min(LIMITS.reach, x));
  const cz = Math.max(-LIMITS.reach, Math.min(LIMITS.reach, z));
  const cy = Math.max(-20, Math.min(LIMITS.reach, y));
  return [
    round(here.x + rx * cx + fx * cz),
    round(here.y + cy),
    round(here.z + rz * cx + fz * cz),
  ];
}
/** Absolute → relative to the wisher, for describing what is nearby. */
export function toLocal(abs: Vec3, here: Here): Vec3 {
  const dx = abs[0] - here.x, dz = abs[2] - here.z;
  const s = Math.sin(here.yaw), c = Math.cos(here.yaw);
  return [round(dx * c - dz * s), round(abs[1] - here.y), round(-dx * s - dz * c)];
}
const round = (n: number) => Math.round(n * 100) / 100;

/** Yaw in degrees relative to the wisher → absolute degrees (0 faces the wisher). */
export function yawToWorld(relDeg: number, here: Here): number {
  return Math.round(((here.yaw * 180) / Math.PI + relDeg) * 10) / 10;
}

/** Model output (relative) → stored ops (absolute, scoped ids). */
export function placeOps(ops: Op[], here: Here, prefix: string, by: string, tier: "fast" | "smart", known: Set<string>): Op[] {
  const lim = LIMITS[tier];
  let adds = 0;
  const out: Op[] = [];
  ops.forEach((op, i) => {
    if (op.op === "add") {
      if (adds >= lim.things) return;
      adds++;
      const raw = op.thing.id;
      // A wish that names an existing id is replacing it ("make the dragon blue").
      const id = known.has(raw) ? raw : scopedId(prefix, raw, i);
      out.push({
        op: "add",
        thing: { ...op.thing, id, by, at: toWorld(op.thing.at, here), yaw: yawToWorld(op.thing.yaw ?? 0, here), parts: op.thing.parts.slice(0, lim.parts) },
      });
    } else if (known.has(op.id)) {
      if (op.op === "edit") {
        const e = { ...op };
        if (e.at) e.at = toWorld(e.at, here);
        if (typeof e.yaw === "number") e.yaw = yawToWorld(e.yaw, here);
        out.push(e);
      } else out.push(op);
    }
  });
  return out;
}

export interface EditRow { id: string | number; ops: unknown; undone?: boolean | null; created_at?: string }

export interface WorldState { things: Map<string, Thing> }

/** Every edit, oldest first, folded into what is standing now. */
export function fold(rows: EditRow[]): WorldState {
  const things = new Map<string, Thing>();
  for (const row of rows) {
    if (row.undone) continue;
    for (const op of cleanOps(row.ops, LIMITS.smart.parts, 400)) {
      if (op.op === "add") {
        things.delete(op.thing.id); // re-insert so it counts as newest
        things.set(op.thing.id, op.thing);
      } else if (op.op === "remove") {
        things.delete(op.id);
      } else {
        const t = things.get(op.id);
        if (!t) continue;
        const n: Thing = { ...t };
        if (op.at) n.at = op.at;
        if (typeof op.yaw === "number") n.yaw = op.yaw;
        if (typeof op.scale === "number") n.scale = op.scale;
        if (op.tint) n.parts = n.parts.map((p) => (p.s === "text" ? p : { ...p, c: op.tint }));
        if (op.a === null) delete n.a; else if (op.a) n.a = op.a;
        if (op.fx === null) delete n.fx; else if (op.fx) n.fx = op.fx;
        things.set(op.id, n);
      }
    }
  }
  while (things.size > LIMITS.worldThings) {
    const oldest = things.keys().next().value as string;
    things.delete(oldest);
  }
  return { things };
}

/** A world flattened back into one edit, for a fork's first row. */
export function snapshotOps(state: WorldState): Op[] {
  return [...state.things.values()].map((thing) => ({ op: "add", thing }));
}

export const WISH_SCHEMA_HELP = `
Reply with ONE JSON object and nothing else:
{
  "verdict": "grant" | "refuse" | "escalate",
  "say": "what the Wizard says out loud, one or two short sentences, in character",
  "ops": [ ...operations, only when verdict is "grant" ]
}

Operations:
  {"op":"add","thing":THING}       make something new (reuse an existing id to replace that thing)
  {"op":"edit","id":"<existing id>","at":[x,y,z]?,"yaw":deg?,"scale":n?,"tint":"#hex"?,"a":ANIM|null?,"fx":FX|null?}
  {"op":"remove","id":"<existing id>"}

THING:
  {"id":"short-kebab-name","name":"Shown Name","at":[x,y,z],"yaw":deg,"scale":1,
   "parts":[PART,...], "a":ANIM?, "fx":FX?, "light":{"c":"#hex","i":0-6,"d":metres}?}
  "at" is relative to the person wishing, in metres: x = to their right, y = up from their feet, z = forward.
  Put new things 5 to 12 m forward (z) unless asked otherwise, y = 0 on the ground. Big things further away.
  yaw 0 means the thing faces the person.

PART (one primitive; the thing is a pile of these, built around its own origin with y=0 at its base):
  {"s":SHAPE,"p":[x,y,z],"size":[w,h,d],"r":[rx,ry,rz]deg?,"c":"#rrggbb","e":0-3 glow?,"m":0-1 metal?,"o":0.1-1 opacity?,"a":ANIM?}
  SHAPE: box sphere cylinder cone torus capsule pyramid gem icosa dodeca ring text
  "size" is the bounding box of the part; a sphere of size [2,2,2] has radius 1. Parts sit centred on "p",
  so a 2 m tall box resting on the ground has p y = 1. Inside a thing, its front (face, eyes, door, sign)
  points toward +z and +x is the thing's left-to-right as the person sees it.
  text: {"s":"text","t":"WORDS (max 40 chars)","p":[...],"size":[width,height,0.1],"c":"#hex"} a flat sign.
ANIM: {"k":"spin"|"bob"|"pulse"|"sway"|"orbit"|"wander"|"flap"|"hover","sp":cycles per second,"amt":amount,"ax":"x"|"y"|"z"}
  spin/sway/flap rotate (amt in degrees for sway/flap), bob/hover move up and down (metres), orbit circles the
  thing's origin (metres), wander strolls around (metres), pulse breathes in size (fraction). On a part it
  moves just that part (flap a wing, spin a propeller); on the thing it moves the whole thing.
  Parts that share an identical spin turn together about their middle (windmill sails, propeller blades),
  and a flapping or swaying part off to one side hinges at its inner edge, mirrored on the other side (wings).
FX: sparkles fire smoke snow bubbles hearts rain confetti fireflies (an effect around the thing)

Detail sells it: a creature or a building is usually 15 to 50 parts, not 5. Make things charming and recognisable: several parts with distinct colours, a face or details where it helps,
a light or glow for magic. Stay within the part budget you were given.
`;
