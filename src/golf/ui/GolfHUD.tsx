/**
 * Vibe Golf — HUD and UI shell.
 *
 * Phone-first (430×932 is the design target), and the governing rule is
 * **the playfield outranks the chrome**. Everything here is budgeted:
 *
 *   Top strip   ≈  56 px (one card: hole + score on line one, PIN / ELEV /
 *                  WIND merged onto line two — no separate chip band).
 *   Hole map    ≈  52 px, *collapsed by default*, opened by the MAP button
 *                  that sits next to it, docked as a content-width chip
 *                  rather than a full-bleed developer strip.
 *   Shot console ≈ 180 px (≈19% of a 932 px phone): POWER and AIM are each a
 *                  single 44 px row — label left, track between, value right —
 *                  and the cluster is capped at 560 px and centred so it never
 *                  becomes a 1500 px scrub bar on a desktop viewport. The
 *                  panel is full-bleed to the true viewport bottom, so no live
 *                  world leaks beneath it.
 *
 * Touch: both tracks are 44 px tall and tap-to-set anywhere along their
 * length, with a 28 px round knob so they read as grabbable. Nothing the
 * player must hit is smaller than 44 px.
 *
 * The canvas slingshot drag still works and drives the same numbers; while a
 * drag is live the console goes pointer-transparent so a drag that runs down
 * into the panel is never swallowed by it.
 *
 * One pin marker at a time: the world overlay draws an edge indicator *only*
 * when the cup is off screen (inset well clear of the viewport edge so it can
 * never be clipped), and stays silent when the real pin is visible.
 *
 * Perf contract: `golf:aim` and `golf:jetpackState` fire at frame rate, so
 * nothing they carry ever reaches `setState`. They land in refs; one shared
 * rAF loop drives the world overlay (canvas), the minimap (canvas, throttled,
 * blitted from a pre-rendered static layer), the slider fills and every live
 * numeric (one `textContent` write each). Only genuinely discrete things —
 * hole changes, strokes, the bag, cards, toasts — go through React.
 *
 * Everything is procedural: no images, no fonts, no assets.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as RPointerEvent,
} from "react";
import { BASE_VIEW_HEIGHT, type GolfEngine } from "../engine/core";
import { BALL_TYPES, type BallType, type Hole, type SurfaceMaterial } from "../types";

// ---------------------------------------------------------------------------
// Tuning / palette
// ---------------------------------------------------------------------------

/** Bag order — matches the 1..8 keyboard order in `powerups.ts`. */
const ORDER: BallType[] = ["standard", "sticky", "ice", "nitro", "super", "multi", "ghost", "heavy"];

/** Backing resolution of the minimap chip. Aspect matches its CSS box. */
const MINI_W = 600;
const MINI_H = 126;
/** Minimap dynamic layer refresh, ms. 20 Hz is plenty for a 52 px chip. */
const MINI_HZ_MS = 50;
/** Live numeric readouts refresh, ms. Text writes are the expensive bit. */
const TEXT_HZ_MS = 90;
/** Trajectory preview recompute, ms. Each one runs ~90 swept queries. */
const TRAJ_HZ_MS = 70;

/** Launch angle range the aim slider spans, radians. */
const ANG_MIN = -0.35;
const ANG_MAX = 2.09;

/** Chrome budget, CSS px — used to decide where the cup indicator may sit. */
const TOP_CHROME = 66;
const MAP_CHROME = 60;
const BOTTOM_CHROME = 196;

/** Horizontal inset of a slider knob's travel, CSS px. Half the knob + 1. */
const KNOB_PAD = 15;

/** Hole profile colours. Hazards are deliberately the loudest things on it. */
const MAT_COLOR: Record<SurfaceMaterial, string> = {
  fairway: "#3fae7a",
  green: "#5eead4",
  rough: "#2c7150",
  sand: "#e6c77d",
  stone: "#7c8ba1",
  metal: "#a7bacd",
  wood: "#b07a45",
  ice: "#a9e9ff",
  rubber: "#e879f9",
  water: "#38bdf8",
  lava: "#fb7185",
  outOfBounds: "#3c4a5c",
};
const HAZARD_MATS: Partial<Record<SurfaceMaterial, boolean>> = { water: true, lava: true };

/** Power ramp: safe green → committed amber → reckless red. */
const POWER_STOPS: Array<[number, [number, number, number]]> = [
  [0.0, [52, 211, 153]],
  [0.55, [251, 191, 36]],
  [1.0, [251, 113, 133]],
];

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

function scoreName(strokes: number, par: number): string {
  const d = strokes - par;
  if (strokes === 1) return "Hole in one!";
  if (d <= -3) return "Albatross";
  if (d === -2) return "Eagle";
  if (d === -1) return "Birdie";
  if (d === 0) return "Par";
  if (d === 1) return "Bogey";
  if (d === 2) return "Double bogey";
  return `+${d}`;
}

/** Score relative to par, golf-style: "E", "-2", "+3". */
function relToPar(d: number): string {
  if (d === 0) return "E";
  return d > 0 ? `+${d}` : `${d}`;
}

function relTone(d: number): string {
  if (d < 0) return "text-emerald-300";
  if (d === 0) return "text-amber-200";
  return "text-rose-300";
}

function powerColor(p: number): string {
  const t = clamp(p, 0, 1);
  let a = POWER_STOPS[0];
  let b = POWER_STOPS[POWER_STOPS.length - 1];
  for (let i = 0; i < POWER_STOPS.length - 1; i++) {
    if (t >= POWER_STOPS[i][0] && t <= POWER_STOPS[i + 1][0]) {
      a = POWER_STOPS[i];
      b = POWER_STOPS[i + 1];
      break;
    }
  }
  const k = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
  const r = Math.round(a[1][0] + (b[1][0] - a[1][0]) * k);
  const g = Math.round(a[1][1] + (b[1][1] - a[1][1]) * k);
  const bl = Math.round(a[1][2] + (b[1][2] - a[1][2]) * k);
  return `rgb(${r},${g},${bl})`;
}

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** `#rrggbb` → `rgba()` with a brightness scale. Used to tint the map body. */
function shade(c: string, k: number, a = 1): string {
  const n = parseInt(c.slice(1), 16);
  const r = Math.round(clamp(((n >> 16) & 255) * k, 0, 255));
  const g = Math.round(clamp(((n >> 8) & 255) * k, 0, 255));
  const b = Math.round(clamp((n & 255) * k, 0, 255));
  return `rgba(${r},${g},${b},${a})`;
}

const degOf = (rad: number) => Math.round((rad * 180) / Math.PI);

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

interface HoleInfo {
  name: string;
  par: number;
  index: number;
  count: number;
  hint?: string;
  courseName: string;
}

interface CardRow {
  index: number;
  name: string;
  par: number;
  strokes: number;
}

interface Toast {
  id: number;
  text: string;
  sub?: string;
  color: string;
}

interface JetState {
  active: boolean;
  fuel: number;
  dry: boolean;
  x: number;
  y: number;
}

interface Pt {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------

export default function GolfHUD({ engine }: { engine: GolfEngine }) {
  // --- discrete state (React) ---------------------------------------------
  const [hole, setHole] = useState<HoleInfo | null>(null);
  const [strokes, setStrokes] = useState(0);
  const [ballType, setBallType] = useState<BallType>("standard");
  const [counts, setCounts] = useState<Partial<Record<BallType, number>>>({});
  const [bagOpen, setBagOpen] = useState(false);
  const [flying, setFlying] = useState(false);
  const [dryTank, setDryTank] = useState(false);
  const [holed, setHoled] = useState<{ strokes: number; par: number; total: number } | null>(null);
  const [done, setDone] = useState<{ courseName: string } | null>(null);
  const [intro, setIntro] = useState<HoleInfo | null>(null);
  const [card, setCard] = useState<CardRow[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [mapBig, setMapBig] = useState(false);
  /** Collapsed by default: the map is a reference, not a permanent band. */
  const [mapOpen, setMapOpen] = useState(false);

  // --- per-frame state (refs — never setState from these) ------------------
  /** The single source of truth for the next shot. Drag and sliders both write here. */
  const shot = useRef({ power: 0.6, angle: 0.62, dragging: false });
  const shotDirty = useRef(true);
  const jetRef = useRef<JetState>({ active: false, fuel: 1, dry: false, x: 0, y: 0 });
  const jetDirty = useRef(true);

  const overlayCv = useRef<HTMLCanvasElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const powFill = useRef<HTMLDivElement | null>(null);
  const powKnob = useRef<HTMLDivElement | null>(null);
  const powTxt = useRef<HTMLSpanElement | null>(null);
  const angFill = useRef<HTMLDivElement | null>(null);
  const angKnob = useRef<HTMLDivElement | null>(null);
  const angTxt = useRef<HTMLSpanElement | null>(null);
  const swingBtn = useRef<HTMLButtonElement | null>(null);
  const swingTxt = useRef<HTMLSpanElement | null>(null);
  const pinTxt = useRef<HTMLSpanElement | null>(null);
  const elevTxt = useRef<HTMLSpanElement | null>(null);
  const windTxt = useRef<HTMLSpanElement | null>(null);
  const fuelBar = useRef<HTMLDivElement | null>(null);
  const miniCv = useRef<HTMLCanvasElement | null>(null);
  const miniStatic = useRef<HTMLCanvasElement | null>(null);
  /** World→minimap transform, rebuilt on hole load. */
  const miniXf = useRef<{ x0: number; y0: number; sx: number; sy: number; padX: number; padY: number } | null>(null);
  const holeRef = useRef<Hole | null>(null);
  const miniAt = useRef(0);
  const miniLast = useRef({ bx: 1e9, by: 1e9, cx: 1e9 });
  const textAt = useRef(0);
  const trajAt = useRef(0);
  const traj = useRef<{ pts: Pt[]; hit: Pt | null }>({ pts: [], hit: null });
  /** Live top-chrome height, so the overlay can read it without a rAF restart. */
  const chromeTop = useRef(TOP_CHROME);
  /** Cleared on hole load so the first frame re-aims at the new cup. */
  const autoAimed = useRef(false);

  const toastId = useRef(0);
  const timers = useRef<number[]>([]);
  const lastHazard = useRef<string>("");

  // -------------------------------------------------------------------------
  // Derived scorecard maths
  // -------------------------------------------------------------------------
  const played = useMemo(() => {
    let s = 0;
    let p = 0;
    for (const r of card) {
      s += r.strokes;
      p += r.par;
    }
    return { strokes: s, par: p, rel: s - p };
  }, [card]);

  // Timers are owned by the component, not by the subscription effect: a
  // resubscribe must never cancel a card that is still on screen.
  useEffect(() => () => {
    timers.current.forEach((h) => window.clearTimeout(h));
    timers.current = [];
  }, []);

  /** The intro card dismisses itself, so its lifetime is tied to its own state. */
  useEffect(() => {
    if (!intro) return;
    const h = window.setTimeout(() => setIntro(null), 4600);
    return () => window.clearTimeout(h);
  }, [intro]);

  // -------------------------------------------------------------------------
  // Toasts
  // -------------------------------------------------------------------------
  const pushToast = useCallback((text: string, color: string, sub?: string) => {
    const id = ++toastId.current;
    // Something just happened — the intro card has had its moment, and the two
    // share the same slot under the top strip.
    setIntro(null);
    setToasts((t) => [...t.slice(-2), { id, text, sub, color }]);
    const h = window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2300);
    timers.current.push(h);
  }, []);

  // -------------------------------------------------------------------------
  // Inventory sync — pulled, never pushed. Rules owns the numbers.
  // -------------------------------------------------------------------------
  const syncBag = useCallback(() => {
    const rules = engine.ctx?.services?.rules;
    if (!rules) return;
    setBallType(rules.ballType ?? "standard");
    setCounts((prev) => {
      const next = rules.inventory ?? {};
      let same = true;
      for (const t of ORDER) {
        if (t === "standard") continue;
        if ((prev[t] ?? 0) !== (next[t] ?? 0)) { same = false; break; }
      }
      return same ? prev : { ...next };
    });
  }, [engine]);

  // -------------------------------------------------------------------------
  // Minimap: bake the hole profile once into an offscreen canvas.
  //
  // Styled to the game's own material palette with a rim light along every
  // ground edge, so the chip reads as a slice of the world rather than a
  // debug overlay. The horizontal slack is tight, so the content fills the
  // chip instead of floating in dead margins.
  // -------------------------------------------------------------------------
  const bakeMini = useCallback((h: Hole | null) => {
    holeRef.current = h;
    miniLast.current = { bx: 1e9, by: 1e9, cx: 1e9 };
    let stat = miniStatic.current;
    if (!stat) {
      stat = document.createElement("canvas");
      stat.width = MINI_W;
      stat.height = MINI_H;
      miniStatic.current = stat;
    }
    const c = stat.getContext("2d");
    if (!c) return;
    c.clearRect(0, 0, MINI_W, MINI_H);
    if (!h) { miniXf.current = null; return; }

    // Sky: the same deep teal→navy the world sits in, so the chip has depth.
    const sky = c.createLinearGradient(0, 0, 0, MINI_H);
    sky.addColorStop(0, "rgba(28,74,102,0.85)");
    sky.addColorStop(0.6, "rgba(12,42,62,0.85)");
    sky.addColorStop(1, "rgba(5,20,30,0.9)");
    c.fillStyle = sky;
    c.fillRect(0, 0, MINI_W, MINI_H);

    // Vertical extent from the geometry, not `bounds` — bounds carry a 34 m
    // camera ceiling that would squash the profile into a hairline.
    let x0 = Math.min(h.tee.x, h.cup.x);
    let x1 = Math.max(h.tee.x, h.cup.x);
    let y0 = Math.min(h.tee.y, h.cup.y);
    let y1 = Math.max(h.tee.y, h.cup.y);
    for (const s of h.surfaces) {
      for (const q of s.points) {
        if (q.x < x0) x0 = q.x;
        if (q.x > x1) x1 = q.x;
        if (q.y < y0) y0 = q.y;
        if (q.y > y1) y1 = q.y;
      }
    }
    // Just enough slack to breathe. The camera window is clamped into the
    // widget separately, so it no longer has to be paid for in dead space.
    const slack = BASE_VIEW_HEIGHT * 0.12;
    x0 -= slack; x1 += slack; y0 -= 2; y1 += 3.5;
    if (x1 - x0 < 1) x1 = x0 + 1;
    if (y1 - y0 < 1) y1 = y0 + 1;

    const padX = 8;
    const padY = 20;
    const sx = (MINI_W - padX * 2) / (x1 - x0);
    const sy = (MINI_H - padY * 2) / (y1 - y0);
    miniXf.current = { x0, y0, sx, sy, padX, padY };
    const px = (x: number) => padX + (x - x0) * sx;
    const py = (y: number) => MINI_H - padY - (y - y0) * sy;

    // Two passes: solid mass first (so the profile reads as *ground*, not a
    // squiggle), then a rim-lit surface line on top — the same read as the
    // lit grass edge in world.
    c.lineJoin = "round";
    c.lineCap = "round";
    for (const s of h.surfaces) {
      if (s.points.length < 2 || s.closed) continue;
      const haz = !!HAZARD_MATS[s.material];
      c.beginPath();
      c.moveTo(px(s.points[0].x), py(s.points[0].y));
      for (let i = 1; i < s.points.length; i++) c.lineTo(px(s.points[i].x), py(s.points[i].y));
      c.lineTo(px(s.points[s.points.length - 1].x), MINI_H);
      c.lineTo(px(s.points[0].x), MINI_H);
      c.closePath();
      c.fillStyle = haz ? shade(MAT_COLOR[s.material], 0.9, 0.5) : shade(MAT_COLOR[s.material], 0.5, 0.95);
      c.fill();
    }
    for (const s of h.surfaces) {
      if (!s.points.length) continue;
      const haz = !!HAZARD_MATS[s.material];
      c.beginPath();
      c.moveTo(px(s.points[0].x), py(s.points[0].y));
      for (let i = 1; i < s.points.length; i++) c.lineTo(px(s.points[i].x), py(s.points[i].y));
      if (s.closed) {
        c.closePath();
        c.fillStyle = shade(MAT_COLOR[s.material], 0.8, haz ? 0.8 : 0.55);
        c.fill();
      }
      // Body line, then a thin brighter rim on top of it.
      c.strokeStyle = shade(MAT_COLOR[s.material], 0.85, 1);
      c.lineWidth = haz ? 7 : 5;
      c.stroke();
      c.strokeStyle = shade(MAT_COLOR[s.material], 1.5, 0.95);
      c.lineWidth = 2;
      c.stroke();
    }

    // Chasms: any horizontal gap between the open ground strips is a hole in
    // the world, and it is exactly the thing that eats balls. Call it out.
    const spans: Array<[number, number]> = [];
    for (const s of h.surfaces) {
      if (s.closed || s.points.length < 2) continue;
      let a = Infinity;
      let b = -Infinity;
      for (const q of s.points) { if (q.x < a) a = q.x; if (q.x > b) b = q.x; }
      if (a < b) spans.push([a, b]);
    }
    spans.sort((u, v) => u[0] - v[0]);
    const merged: Array<[number, number]> = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1] + 0.05) last[1] = Math.max(last[1], s[1]);
      else merged.push([s[0], s[1]]);
    }
    for (let i = 0; i < merged.length - 1; i++) {
      const g0 = px(merged[i][1]);
      const g1 = px(merged[i + 1][0]);
      if (g1 - g0 < 5) continue;
      c.save();
      c.beginPath();
      c.rect(g0, 0, g1 - g0, MINI_H);
      c.clip();
      c.fillStyle = "rgba(251,113,133,0.1)";
      c.fillRect(g0, 0, g1 - g0, MINI_H);
      c.strokeStyle = "rgba(251,113,133,0.4)";
      c.lineWidth = 2;
      for (let d = -MINI_H; d < g1 - g0 + MINI_H; d += 14) {
        c.beginPath();
        c.moveTo(g0 + d, MINI_H);
        c.lineTo(g0 + d + MINI_H, 0);
        c.stroke();
      }
      c.restore();
    }

    // Tee: a small teal peg. Cup: the pin silhouette itself — pole, pennant
    // and the cup mouth — the same shape the player sees in world.
    const tx = px(h.tee.x);
    const ty = py(h.tee.y);
    c.fillStyle = "#5eead4";
    c.beginPath();
    c.arc(tx, ty - 5, 5, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "rgba(3,12,18,0.85)";
    c.lineWidth = 2;
    c.stroke();

    const cx = px(h.cup.x);
    const cy = py(h.cup.y);
    // Cup mouth: a small dark ellipse seated on the ground line.
    c.fillStyle = "rgba(3,12,18,0.75)";
    c.beginPath();
    c.ellipse(cx, cy + 1, 5, 2.2, 0, 0, Math.PI * 2);
    c.fill();
    // Pole.
    c.strokeStyle = "rgba(3,12,18,0.8)";
    c.lineWidth = 5;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx, cy - 34);
    c.stroke();
    c.strokeStyle = "#f8fafc";
    c.lineWidth = 2.2;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx, cy - 34);
    c.stroke();
    // Pennant: a tapered, slightly furled triangle rather than a rectangle.
    c.fillStyle = "#f43f5e";
    c.strokeStyle = "rgba(3,12,18,0.8)";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(cx + 1, cy - 34);
    c.quadraticCurveTo(cx + 13, cy - 32, cx + 20, cy - 27);
    c.quadraticCurveTo(cx + 11, cy - 25, cx + 1, cy - 21);
    c.closePath();
    c.fill();
    c.stroke();
    c.fillStyle = "rgba(255,255,255,0.35)";
    c.beginPath();
    c.moveTo(cx + 1, cy - 34);
    c.lineTo(cx + 12, cy - 31.5);
    c.lineTo(cx + 1, cy - 29);
    c.closePath();
    c.fill();
  }, []);

  // -------------------------------------------------------------------------
  // Aim helpers
  // -------------------------------------------------------------------------
  const liveBall = useCallback(() => {
    return engine.ctx?.services?.physics?.balls?.find((b) => b.active) ?? null;
  }, [engine]);

  /** Point the console at the cup with a sane loft, sized to the distance. */
  const autoAim = useCallback(() => {
    const h = holeRef.current;
    const b = liveBall();
    if (!h || !b) return;
    const dx = h.cup.x - b.pos.x;
    const dy = h.cup.y - b.pos.y;
    const d = Math.hypot(dx, dy);
    const base = Math.atan2(dy, dx);
    shot.current.angle = clamp(base + 0.45, 0.12, 1.25);
    shot.current.power = clamp(0.22 + d / 78, 0.18, 1);
    shotDirty.current = true;
    autoAimed.current = true;
  }, [liveBall]);

  // -------------------------------------------------------------------------
  // Engine subscriptions. Every handler is cheap and discrete.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!engine) return;
    const offs: Array<() => void> = [];
    const sub = (name: string, fn: (p: unknown) => void) => {
      const off = engine.on?.(name, fn);
      if (off) offs.push(off);
    };

    sub("golf:hole", (p) => {
      const d = p as {
        hole: Hole;
        holeIndex: number;
        course?: { name?: string; holes?: unknown[] };
      };
      if (!d?.hole) return;
      const info: HoleInfo = {
        name: d.hole.name,
        par: d.hole.par,
        index: d.holeIndex ?? 0,
        count: d.course?.holes?.length ?? 0,
        hint: d.hole.hint,
        courseName: d.course?.name ?? "",
      };
      setHole(info);
      setStrokes(0);
      setHoled(null);
      setDone(null);
      setBagOpen(false);
      setIntro(info);
      bakeMini(d.hole);
      autoAimed.current = false;
      autoAim();
      syncBag();
    });

    sub("golf:shot", (p) => {
      setStrokes((p as { strokes: number })?.strokes ?? 0);
      setBagOpen(false);
      syncBag();
    });

    sub("golf:ready", (p) => {
      setStrokes((p as { strokes: number })?.strokes ?? 0);
      autoAim();
      syncBag();
    });

    sub("golf:ballType", () => { shotDirty.current = true; syncBag(); });
    sub("golf:hazard", (p) => {
      lastHazard.current = (p as { material?: string })?.material ?? "";
    });

    sub("golf:penalty", (p) => {
      setStrokes((p as { strokes: number })?.strokes ?? 0);
      const m = lastHazard.current;
      const word = m === "water" ? "Splash" : m === "lava" ? "Scorched" : m === "outOfBounds" ? "Out of bounds" : "Hazard";
      pushToast(word, "#fb7185", "+1 stroke · replay the lie");
      autoAim();
      syncBag();
    });

    sub("golf:pickup", (p) => {
      const d = p as { name?: string; count?: number; tint?: number };
      pushToast(`${d?.name ?? "Ball"} picked up`, hex(d?.tint ?? 0xfbbf24), `${d?.count ?? 1} in the bag`);
      syncBag();
    });

    sub("golf:portal", () => pushToast("Portal", "#2dd4bf", "momentum preserved"));
    sub("golf:cannon", () => pushToast("Cannon", "#fbbf24", "hold on"));
    sub("golf:stick", () => pushToast("Stuck", "#9ae66e", "sticky ball holds"));

    sub("golf:holed", (p) => {
      const d = p as { strokes: number; par: number; total: number };
      setHoled(d);
      setBagOpen(false);
      setCard((rows) => {
        const idx = engine.ctx?.services?.course?.holeIndex ?? rows.length;
        if (rows.some((r) => r.index === idx)) return rows;
        const cur = engine.ctx?.services?.course?.current;
        return [...rows, { index: idx, name: cur?.name ?? `Hole ${idx + 1}`, par: d.par, strokes: d.strokes }];
      });
    });

    sub("golf:courseComplete", (p) => {
      const d = p as { course?: { name?: string } };
      setHoled(null);
      setDone({ courseName: d?.course?.name ?? "the course" });
    });

    // Per-frame channel — refs only. The canvas slingshot drives exactly the
    // same power/angle the console shows, so the two can never disagree.
    sub("golf:aim", (p) => {
      const d = p as { aiming?: boolean; power?: number; angle?: number };
      const s = shot.current;
      s.dragging = !!d?.aiming;
      if (d?.aiming) {
        s.power = clamp(d.power ?? 0, 0, 1);
        s.angle = d.angle ?? s.angle;
      }
      shotDirty.current = true;
    });

    sub("golf:jetpackState", (p) => {
      const d = p as { active?: boolean; fuel?: number; dry?: boolean; x?: number; y?: number };
      const j = jetRef.current;
      const wasActive = j.active;
      const wasDry = j.dry;
      j.active = !!d?.active;
      j.fuel = d?.fuel ?? 0;
      j.dry = !!d?.dry;
      j.x = d?.x ?? 0;
      j.y = d?.y ?? 0;
      jetDirty.current = true;
      // Only the *discrete* transitions are allowed through to React.
      if (j.active !== wasActive) setFlying(j.active);
      if (j.dry !== wasDry) setDryTank(j.dry);
    });

    // Cold-start: the hole may already be live when the HUD mounts.
    const cur = engine.ctx?.services?.course?.current ?? null;
    if (cur) {
      const co = engine.ctx?.services?.course;
      setHole({
        name: cur.name,
        par: cur.par,
        index: co?.holeIndex ?? 0,
        count: co?.courses?.[co?.courseIndex ?? 0]?.holes?.length ?? 0,
        hint: cur.hint,
        courseName: co?.courses?.[co?.courseIndex ?? 0]?.name ?? "",
      });
      bakeMini(cur);
      autoAimed.current = false;
      autoAim();
    }
    setStrokes(engine.ctx?.services?.rules?.strokes ?? 0);
    syncBag();

    return () => {
      offs.forEach((f) => f());
    };
  }, [engine, bakeMini, pushToast, syncBag, autoAim]);

  // -------------------------------------------------------------------------
  // The single rAF loop: world overlay + minimap + console numerics + fuel.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let raf = 0;

    const sizeOverlay = () => {
      const cv = overlayCv.current;
      if (!cv) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // Measure the element, not the window: the overlay must agree with its
      // own CSS box or every world-space mark drifts toward the edges.
      const w = cv.clientWidth || window.innerWidth;
      const h = cv.clientHeight || window.innerHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
    };
    sizeOverlay();
    window.addEventListener("resize", sizeOverlay);

    /** World metres → CSS pixels in the canvas viewport. */
    const w2s = (wx: number, wy: number, w: number, h: number): Pt => {
      const zoom = engine.zoom || 1;
      const halfH = BASE_VIEW_HEIGHT / 2 / zoom;
      const halfW = halfH * (w / Math.max(1, h));
      const tx = engine.target?.x ?? 0;
      const ty = engine.target?.y ?? 0;
      return { x: ((wx - tx) / halfW) * (w / 2) + w / 2, y: h / 2 - ((wy - ty) / halfH) * (h / 2) };
    };

    /**
     * Run the candidate shot through the *real* physics constants and stop it
     * on the first swept contact, so the preview lands where the ball lands.
     */
    const computeTraj = () => {
      const phys = engine.ctx?.services?.physics;
      const ball = liveBall();
      traj.current = { pts: [], hit: null };
      if (!phys || !ball) return;
      const props = BALL_TYPES[ball.type] ?? BALL_TYPES.standard;
      const s = shot.current;
      const speed = 6 + clamp(s.power, 0, 1) * 46 * props.power;
      const dirx = Math.cos(s.angle);
      const diry = Math.sin(s.angle);
      const g = phys.gravity ?? { x: 0, y: -22 };
      const wind = phys.wind ?? { x: 0, y: 0 };
      const windScale = props.drag > 1.3 ? 0.15 : 1;
      const step = 1 / 40;
      let px = ball.pos.x + dirx * ball.radius * 1.4;
      let py = ball.pos.y + diry * ball.radius * 1.4;
      let vx = dirx * speed;
      let vy = diry * speed;
      const pts: Pt[] = [{ x: px, y: py }];
      let hit: Pt | null = null;
      const floor = (holeRef.current?.bounds?.min?.y ?? -1e4) - 30;
      for (let i = 0; i < 96; i++) {
        vx += g.x * step + wind.x * step * windScale * 0.6;
        vy += g.y * step + wind.y * step * windScale * 0.6;
        const sp = Math.hypot(vx, vy);
        const air = Math.exp(-0.055 * props.drag * step * Math.max(1, sp * 0.06));
        vx *= air;
        vy *= air;
        const nx = px + vx * step;
        const ny = py + vy * step;
        // The first couple of steps skip the sweep: the ball is resting *on*
        // a surface and would otherwise report an instant self-collision.
        if (i > 1) {
          let h2: { point: Pt } | null = null;
          try {
            h2 = phys.sweep?.({ x: px, y: py }, { x: nx, y: ny }, ball.radius) ?? null;
          } catch { h2 = null; }
          if (h2?.point) {
            hit = { x: h2.point.x, y: h2.point.y };
            pts.push(hit);
            break;
          }
        }
        px = nx;
        py = ny;
        pts.push({ x: px, y: py });
        if (py < floor) break;
      }
      traj.current = { pts, hit };
    };

    /** Can the player swing right now? Checked every frame; it gates a lot. */
    const canNow = () => !!engine.ctx?.services?.rules?.canShoot && !!liveBall();

    /**
     * The swing affordance is edge-driven, not polled at the text rate: going
     * live a tenth of a second late reads as an unresponsive button.
     */
    let lastCan: boolean | null = null;
    const syncSwing = () => {
      const can = canNow();
      if (can === lastCan) return;
      lastCan = can;
      const btn = swingBtn.current;
      if (btn) {
        btn.style.opacity = can ? "1" : "0.4";
        btn.style.filter = can ? "none" : "saturate(0.2)";
      }
      if (swingTxt.current) swingTxt.current.textContent = can ? "Swing" : "In play";
    };

    /**
     * While a slingshot drag is live the console must not exist as far as the
     * pointer is concerned: the natural gesture is back-and-down, straight
     * into the panel, and it must not be swallowed halfway through.
     */
    let lastDrag: boolean | null = null;
    const syncDrag = () => {
      const d = shot.current.dragging;
      if (d === lastDrag) return;
      lastDrag = d;
      const p = panelRef.current;
      if (p) p.dataset.drag = d ? "1" : "0";
    };

    /** A dotted polyline that survives being drawn over grass *and* sky. */
    const dottedPath = (c: CanvasRenderingContext2D, pts: Pt[], col: string, w: number, h: number) => {
      if (pts.length < 2) return;
      c.lineJoin = "round";
      c.lineCap = "round";
      c.setLineDash([2, 12]);
      c.lineWidth = 9;
      c.strokeStyle = "rgba(2,10,16,0.62)";
      c.beginPath();
      let started = false;
      for (const p of pts) {
        const s = w2s(p.x, p.y, w, h);
        if (!started) { c.moveTo(s.x, s.y); started = true; } else c.lineTo(s.x, s.y);
      }
      c.stroke();
      c.lineWidth = 4.5;
      c.strokeStyle = col;
      c.stroke();
      c.setLineDash([]);
    };

    const drawOverlay = () => {
      const cv = overlayCv.current;
      if (!cv) return;
      const c = cv.getContext("2d");
      if (!c) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = cv.width / dpr;
      const h = cv.height / dpr;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);

      const ball = liveBall();
      const hh = holeRef.current;
      const s = shot.current;
      const atRest = canNow() && !holed && !done;

      // --- cup awareness ----------------------------------------------------
      // Exactly one pin mark on screen at a time. When the real pin is in
      // frame the HUD stays out of the way entirely — the distance already
      // lives in the PIN readout at the top. Only when the cup is off screen
      // does an edge chip appear, inset by its own radius plus a clear margin
      // so it can never be sliced by the viewport edge.
      if (hh && ball) {
        const cup = w2s(hh.cup.x, hh.cup.y, w, h);
        const dist = Math.hypot(hh.cup.x - ball.pos.x, hh.cup.y - ball.pos.y);
        const R = 20;
        const mX = R + 22;
        const topY = chromeTop.current + R + 12;
        const botY = h - BOTTOM_CHROME - R - 12;
        const off = cup.x < mX || cup.x > w - mX || cup.y < topY || cup.y > Math.max(topY + 1, botY);
        if (off) {
          const ex = clamp(cup.x, mX, w - mX);
          const ey = clamp(cup.y, topY, Math.max(topY + 1, botY));
          const ang = Math.atan2(cup.y - h / 2, cup.x - w / 2);
          c.save();
          c.translate(ex, ey);
          c.fillStyle = "rgba(4,18,27,0.9)";
          c.strokeStyle = "rgba(244,63,94,0.85)";
          c.lineWidth = 2;
          c.beginPath();
          c.arc(0, 0, R, 0, Math.PI * 2);
          c.fill();
          c.stroke();
          c.save();
          c.rotate(ang);
          c.fillStyle = "#f43f5e";
          c.beginPath();
          c.moveTo(R - 2, 0);
          c.lineTo(R - 12, -8);
          c.lineTo(R - 12, 8);
          c.closePath();
          c.fill();
          c.restore();
          c.fillStyle = "#fde68a";
          c.font = "800 12px ui-monospace, SFMono-Regular, Menlo, monospace";
          c.textAlign = "center";
          c.textBaseline = "middle";
          c.fillText(`${Math.round(dist)}`, -2, -2);
          c.fillStyle = "rgba(255,255,255,0.5)";
          c.font = "700 7px ui-monospace, SFMono-Regular, Menlo, monospace";
          c.fillText("PIN m", -2, 9);
          c.restore();
          c.textBaseline = "alphabetic";
        }
      }

      if (!atRest) return;

      // --- aim arc anchored to the ball ------------------------------------
      const b = w2s(ball.pos.x, ball.pos.y, w, h);
      const col = powerColor(s.power);
      const r = 58;

      c.strokeStyle = "rgba(2,10,16,0.5)";
      c.lineWidth = 11;
      c.beginPath();
      c.arc(b.x, b.y, r, -ANG_MAX, -ANG_MIN);
      c.stroke();
      c.strokeStyle = "rgba(255,255,255,0.34)";
      c.lineWidth = 6;
      c.beginPath();
      c.arc(b.x, b.y, r, -ANG_MAX, -ANG_MIN);
      c.stroke();
      // Filled portion = chosen angle. Ticks every 30°.
      c.strokeStyle = col;
      c.lineWidth = 6;
      c.beginPath();
      c.arc(b.x, b.y, r, -s.angle, -ANG_MIN);
      c.stroke();
      c.strokeStyle = "rgba(255,255,255,0.5)";
      c.lineWidth = 2;
      for (let d = 0; d <= 180; d += 30) {
        const a = (d * Math.PI) / 180;
        if (a < ANG_MIN || a > ANG_MAX) continue;
        c.beginPath();
        c.moveTo(b.x + Math.cos(-a) * (r - 8), b.y + Math.sin(-a) * (r - 8));
        c.lineTo(b.x + Math.cos(-a) * (r + 8), b.y + Math.sin(-a) * (r + 8));
        c.stroke();
      }
      // Ball collar + launch arrow.
      c.strokeStyle = "rgba(2,10,16,0.6)";
      c.lineWidth = 6;
      c.beginPath();
      c.arc(b.x, b.y, 15, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = "rgba(255,255,255,0.85)";
      c.lineWidth = 2.5;
      c.beginPath();
      c.arc(b.x, b.y, 15, 0, Math.PI * 2);
      c.stroke();
      const al = 26 + s.power * 46;
      const ax = b.x + Math.cos(-s.angle) * al;
      const ay = b.y + Math.sin(-s.angle) * al;
      c.strokeStyle = "rgba(2,10,16,0.6)";
      c.lineWidth = 9;
      c.beginPath();
      c.moveTo(b.x + Math.cos(-s.angle) * 16, b.y + Math.sin(-s.angle) * 16);
      c.lineTo(ax, ay);
      c.stroke();
      c.strokeStyle = col;
      c.lineWidth = 4;
      c.stroke();

      // --- trajectory preview ----------------------------------------------
      const t = traj.current;
      dottedPath(c, t.pts, "rgba(255,255,255,0.96)", w, h);
      if (t.hit) {
        const p = w2s(t.hit.x, t.hit.y, w, h);
        c.strokeStyle = "rgba(2,10,16,0.65)";
        c.lineWidth = 6;
        c.beginPath();
        c.arc(p.x, p.y, 11, 0, Math.PI * 2);
        c.stroke();
        c.strokeStyle = col;
        c.lineWidth = 2.5;
        c.beginPath();
        c.arc(p.x, p.y, 11, 0, Math.PI * 2);
        c.stroke();
        c.fillStyle = col;
        c.beginPath();
        c.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
        c.fill();
      }

      // Power/angle at the ball *only while dragging* — that is the one moment
      // the thumb is off the console and the numbers there are unreadable.
      // The rest of the time the console owns the readout, so the frame keeps
      // a single copy of every number.
      if (s.dragging) {
        c.font = "800 15px ui-monospace, SFMono-Regular, Menlo, monospace";
        c.textAlign = "left";
        const label = `${Math.round(s.power * 100)}%  ${degOf(s.angle)}°`;
        const lx = b.x + 20;
        const ly = b.y - 24;
        c.lineWidth = 5;
        c.strokeStyle = "rgba(2,10,16,0.82)";
        c.strokeText(label, lx, ly);
        c.fillStyle = col;
        c.fillText(label, lx, ly);
      }
    };

    const drawMini = () => {
      const cv = miniCv.current;
      const stat = miniStatic.current;
      const xf = miniXf.current;
      if (!cv || !stat || !xf) return;
      const c = cv.getContext("2d");
      if (!c) return;

      const px = (x: number) => clamp(xf.padX + (x - xf.x0) * xf.sx, 5, MINI_W - 5);
      const py = (y: number) => clamp(MINI_H - xf.padY - (y - xf.y0) * xf.sy, 8, MINI_H - 8);

      const ball = liveBall();
      const bx = ball ? ball.pos.x : NaN;
      const by = ball ? ball.pos.y : NaN;
      const camX = engine.target?.x ?? 0;
      const l = miniLast.current;
      if (Math.abs((bx || 0) - l.bx) < 0.12 && Math.abs((by || 0) - l.by) < 0.12 && Math.abs(camX - l.cx) < 0.4) {
        return;
      }
      l.bx = bx || 0;
      l.by = by || 0;
      l.cx = camX;

      c.clearRect(0, 0, MINI_W, MINI_H);
      c.drawImage(stat, 0, 0);

      // Camera window — where you're actually looking right now. Clamped into
      // the widget so it can never be sliced off against the edge.
      const zoom = engine.zoom || 1;
      const aspect = window.innerWidth / Math.max(1, window.innerHeight);
      const halfW = (BASE_VIEW_HEIGHT / 2 / zoom) * aspect;
      const wx0 = clamp(xf.padX + (camX - halfW - xf.x0) * xf.sx, 2, MINI_W - 8);
      const wx1 = clamp(xf.padX + (camX + halfW - xf.x0) * xf.sx, wx0 + 6, MINI_W - 2);
      c.fillStyle = "rgba(255,255,255,0.06)";
      c.fillRect(wx0, 0, wx1 - wx0, MINI_H);
      c.strokeStyle = "rgba(253,230,138,0.55)";
      c.lineWidth = 2;
      c.strokeRect(wx0 + 1, 1, wx1 - wx0 - 2, MINI_H - 2);

      // Golfer, while he's out scouting.
      const j = jetRef.current;
      if (j.active) {
        c.fillStyle = "rgba(251,191,36,0.95)";
        c.beginPath();
        c.arc(px(j.x), py(j.y), 6, 0, Math.PI * 2);
        c.fill();
      }

      if (ball) {
        // A white dot in a dark halo, ringed in the ball's own tint. Reads on
        // grass, on water and on the dark chip alike.
        const tint = BALL_TYPES[ball.type]?.tint ?? 0xffffff;
        const col = hex(tint);
        const dx = px(bx);
        const dy = py(by);
        c.fillStyle = "rgba(2,10,16,0.9)";
        c.beginPath();
        c.arc(dx, dy, 11, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = col;
        c.lineWidth = 3;
        c.beginPath();
        c.arc(dx, dy, 8.5, 0, Math.PI * 2);
        c.stroke();
        c.fillStyle = "#ffffff";
        c.shadowColor = "rgba(255,255,255,0.9)";
        c.shadowBlur = 10;
        c.beginPath();
        c.arc(dx, dy, 6, 0, Math.PI * 2);
        c.fill();
        c.shadowBlur = 0;
      }
    };

    const drawText = () => {
      const ball = liveBall();
      const hh = holeRef.current;
      const s = shot.current;

      const pf = clamp(s.power, 0, 1);
      const col = powerColor(pf);
      if (powFill.current) {
        powFill.current.style.width = `${(pf * 100).toFixed(1)}%`;
        powFill.current.style.background = col;
      }
      if (powKnob.current) {
        powKnob.current.style.left = `${(pf * 100).toFixed(1)}%`;
        powKnob.current.style.borderColor = col;
      }
      if (powTxt.current) powTxt.current.textContent = `${Math.round(pf * 100)}%`;

      const af = clamp((s.angle - ANG_MIN) / (ANG_MAX - ANG_MIN), 0, 1);
      if (angFill.current) angFill.current.style.width = `${(af * 100).toFixed(1)}%`;
      if (angKnob.current) angKnob.current.style.left = `${(af * 100).toFixed(1)}%`;
      if (angTxt.current) angTxt.current.textContent = `${degOf(s.angle)}°`;

      if (hh && ball) {
        const dx = hh.cup.x - ball.pos.x;
        const dy = hh.cup.y - ball.pos.y;
        if (pinTxt.current) pinTxt.current.textContent = `${Math.round(Math.hypot(dx, dy))} m`;
        if (elevTxt.current) {
          const e = Math.round(dy);
          elevTxt.current.textContent = e === 0 ? "level" : `${e > 0 ? "+" : ""}${e} m`;
        }
      }
      const wind = engine.ctx?.services?.physics?.wind;
      if (windTxt.current) {
        const ws = wind ? Math.hypot(wind.x, wind.y) : 0;
        windTxt.current.textContent =
          ws < 0.15 ? "calm" : `${wind.x >= 0 ? "→" : "←"} ${ws.toFixed(1)}`;
      }
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);

      if (shotDirty.current || now - trajAt.current >= TRAJ_HZ_MS) {
        if (shotDirty.current || engine.ctx?.services?.rules?.canShoot) {
          shotDirty.current = false;
          trajAt.current = now;
          computeTraj();
        }
      }

      drawOverlay();
      syncSwing();
      syncDrag();

      if (jetDirty.current) {
        jetDirty.current = false;
        const bar = fuelBar.current;
        if (bar) {
          const f = clamp(jetRef.current.fuel, 0, 1);
          bar.style.transform = `scaleX(${f.toFixed(3)})`;
          bar.style.background = f < 0.22 ? "#fb7185" : f < 0.5 ? "#fbbf24" : "#2dd4bf";
        }
      }

      if (now - miniAt.current >= MINI_HZ_MS) {
        miniAt.current = now;
        drawMini();
      }
      if (now - textAt.current >= TEXT_HZ_MS) {
        textAt.current = now;
        // A hole can load before the ball exists; re-aim as soon as it does.
        if (!autoAimed.current && liveBall()) autoAim();
        drawText();
      }
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", sizeOverlay);
    };
  }, [engine, liveBall, autoAim, holed, done]);

  // The map chip mounts and unmounts with `mapOpen`, so its backing store has
  // to be (re)sized here — and the overlay needs the new chrome height.
  useEffect(() => {
    const mc = miniCv.current;
    if (mc) {
      mc.width = MINI_W;
      mc.height = MINI_H;
    }
    miniLast.current = { bx: 1e9, by: 1e9, cx: 1e9 };
    chromeTop.current = TOP_CHROME + (mapOpen ? MAP_CHROME : 0);
  }, [mapOpen, mapBig]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  const pickBall = useCallback((t: BallType) => {
    engine.emit?.("golf:selectBall", { type: t });
    setBallType(t);
    setBagOpen(false);
    shotDirty.current = true;
    syncBag();
  }, [engine, syncBag]);

  const toggleJet = useCallback(() => {
    engine.emit?.("golf:jetpack");
  }, [engine]);

  const thrust = useCallback((on: boolean) => {
    engine.emit?.("golf:jetpackThrust", { on });
  }, [engine]);

  const nextHole = useCallback(() => {
    setHoled(null);
    engine.ctx?.services?.course?.next?.();
  }, [engine]);

  /** The button the whole game was missing: commit the console's shot. */
  const swing = useCallback(() => {
    const rules = engine.ctx?.services?.rules;
    if (!rules?.canShoot) return;
    const s = shot.current;
    const p = clamp(s.power, 0.08, 1);
    rules.takeShot({ x: Math.cos(s.angle), y: Math.sin(s.angle) }, p);
    shotDirty.current = true;
  }, [engine]);

  /**
   * Shared slider drag. The whole 44 px track is the hit area and a tap
   * anywhere along it sets the value, so the knob never has to be caught.
   * The mapped range is inset by half a knob at each end so the knob's centre
   * always lands under the finger.
   */
  const trackFrac = (el: HTMLElement, clientX: number) => {
    const r = el.getBoundingClientRect();
    const usable = Math.max(1, r.width - KNOB_PAD * 2);
    return clamp((clientX - r.left - KNOB_PAD) / usable, 0, 1);
  };
  const setPower = useCallback((f: number) => {
    shot.current.power = clamp(f, 0, 1);
    shotDirty.current = true;
  }, []);
  const setAngle = useCallback((f: number) => {
    shot.current.angle = ANG_MIN + clamp(f, 0, 1) * (ANG_MAX - ANG_MIN);
    shotDirty.current = true;
  }, []);
  const trackProps = (apply: (f: number) => void) => ({
    onPointerDown: (e: RPointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      apply(trackFrac(e.currentTarget, e.clientX));
    },
    onPointerMove: (e: RPointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
      apply(trackFrac(e.currentTarget, e.clientX));
    },
    onPointerUp: (e: RPointerEvent<HTMLDivElement>) => {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    },
  });

  const cur = BALL_TYPES[ballType] ?? BALL_TYPES.standard;
  const holeLabel = hole ? `${hole.index + 1}${hole.count ? `/${hole.count}` : ""}` : "—";
  const cardTop = `calc(env(safe-area-inset-top, 0px) + ${mapOpen ? 132 : 74}px)`;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 select-none font-sans text-white">
      <style>{`
        @keyframes gh-pop { 0% { transform: scale(.82) translateY(14px); opacity: 0 }
          60% { transform: scale(1.03) translateY(0); opacity: 1 }
          100% { transform: scale(1) translateY(0); opacity: 1 } }
        @keyframes gh-slide { from { transform: translateY(-10px); opacity: 0 }
          to { transform: translateY(0); opacity: 1 } }
        @keyframes gh-rise { from { transform: translateY(16px); opacity: 0 }
          to { transform: translateY(0); opacity: 1 } }
        @keyframes gh-toast { from { transform: translateY(8px) scale(.96); opacity: 0 }
          to { transform: translateY(0) scale(1); opacity: 1 } }
        @keyframes gh-shine { from { background-position: -200% 0 } to { background-position: 200% 0 } }
        @keyframes gh-breathe { 0%,100% { box-shadow: 0 0 0 0 rgba(52,211,153,.42) }
          50% { box-shadow: 0 0 0 10px rgba(52,211,153,0) } }
        .gh-pop { animation: gh-pop .42s cubic-bezier(.2,1.3,.4,1) both }
        .gh-slide { animation: gh-slide .3s ease-out both }
        .gh-rise { animation: gh-rise .34s cubic-bezier(.2,1,.4,1) both }
        .gh-toast { animation: gh-toast .22s ease-out both }
        .gh-shine { background-size: 200% 100%; animation: gh-shine 2.4s linear infinite }
        .gh-breathe { animation: gh-breathe 2.6s ease-out infinite }
        .gh-scroll::-webkit-scrollbar { display: none }
        /* A slingshot drag out of the ball owns the whole screen while it is
           live — the console cannot intercept the second half of the gesture. */
        .gh-panel { transition: opacity .16s ease-out }
        .gh-panel[data-drag="1"] { opacity: .38 }
        .gh-panel[data-drag="1"], .gh-panel[data-drag="1"] * { pointer-events: none !important }
      `}</style>

      {/* World-space overlay: aim arc, trajectory, cup indicator. Never eats
          a pointer — the slingshot drag has to pass straight through it. */}
      <canvas
        ref={overlayCv}
        className="pointer-events-none absolute inset-0 h-full w-full"
      />

      {/* ------------------------------------------------------------------ */}
      {/* Top strip — one card: hole + score, then pin / elev / wind          */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="absolute inset-x-0 top-0 px-2.5"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 8px)" }}
      >
        <div className="flex items-start gap-2">
          <div className="gh-slide pointer-events-none min-w-0 flex-1 rounded-2xl border border-white/10 bg-[#04121b]/80 px-2.5 py-1.5 shadow-lg shadow-black/40 backdrop-blur-md">
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 font-mono text-[11px] font-black uppercase tracking-[0.12em] text-emerald-300">
                {holeLabel}
              </span>
              <span className="min-w-0 flex-1 truncate text-[14px] font-black leading-tight text-white">
                {hole?.name ?? "Loading"}
              </span>
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-white/40">
                Par <span className="font-black text-white/85">{hole?.par ?? "-"}</span>
                <span className="px-1 text-white/20">·</span>
                <span className="font-black text-white">{strokes}</span>
                <span className="pl-0.5">sh</span>
              </span>
              {card.length > 0 && (
                <span className={`shrink-0 font-mono text-[11px] font-black ${relTone(played.rel)}`}>
                  {relToPar(played.rel)}
                </span>
              )}
            </div>
            {/* Route readouts live on the card's own second line — they used to
                cost a separate 35 px band across the frame. */}
            <div className="mt-[3px] flex items-center gap-2.5 font-mono text-[10px] uppercase tracking-[0.1em]">
              <span className="text-white/35">
                Pin <span ref={pinTxt} className="font-black text-amber-200">— m</span>
              </span>
              <span className="text-white/35">
                Elev <span ref={elevTxt} className="font-black text-sky-200">— m</span>
              </span>
              <span className="truncate text-white/35">
                Wind <span ref={windTxt} className="font-black text-emerald-200">calm</span>
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setMapOpen((v) => !v)}
            aria-label={mapOpen ? "Hide hole map" : "Show hole map"}
            className={`pointer-events-auto flex h-[46px] w-[52px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-2xl border shadow-lg shadow-black/40 backdrop-blur-md transition active:scale-95 ${
              mapOpen
                ? "border-emerald-300/50 bg-emerald-300/15 text-emerald-200"
                : "border-white/10 bg-[#04121b]/80 text-white/70"
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7.5 9 5l6 2.5L21 5v11.5L15 19l-6-2.5L3 19Z" />
              <path d="M9 5v11.5M15 7.5V19" />
            </svg>
            <span className="font-mono text-[8.5px] font-bold uppercase tracking-[0.12em]">Map</span>
          </button>
        </div>

        {/* Hole map — a content-width chip, opened on demand, styled in the
            game's own materials rather than as a debug strip. */}
        {mapOpen && (
          <button
            type="button"
            onClick={() => setMapBig(true)}
            aria-label="Expand hole overview"
            className="gh-slide pointer-events-auto mt-1.5 ml-auto block w-[min(64vw,250px)] overflow-hidden rounded-2xl border border-white/10 bg-[#04121b]/70 shadow-lg shadow-black/40 backdrop-blur-md active:scale-[0.98]"
          >
            <canvas ref={miniCv} className="block h-[52px] w-full" />
          </button>
        )}
      </div>

      {/* Expanded hole overview */}
      {mapBig && (
        <div
          className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
          onClick={() => setMapBig(false)}
        >
          <div className="gh-pop w-full max-w-2xl rounded-2xl border border-white/10 bg-[#04121b]/90 p-3 shadow-2xl">
            <div className="mb-2 flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.18em] text-white/50">
              <span>{hole?.name ?? "Hole"}</span>
              <span>Par {hole?.par ?? "-"} · tap to close</span>
            </div>
            {/* Same backing canvas, larger CSS box — no redraw needed. */}
            <div className="overflow-hidden rounded-xl bg-black/40">
              <MiniMirror source={miniCv} />
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-white/50">
              <Legend color="#f43f5e" label="Cup" />
              <Legend color="#5eead4" label="Tee / green" />
              <Legend color="#3fae7a" label="Fairway" />
              <Legend color="#2c7150" label="Rough" />
              <Legend color="#e6c77d" label="Sand" />
              <Legend color="#38bdf8" label="Water" />
              <Legend color="#fb7185" label="Chasm / lava" />
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Hole intro card                                                     */}
      {/* ------------------------------------------------------------------ */}
      {intro && !holed && !done && (
        <div
          className="pointer-events-auto absolute inset-x-0 flex justify-center px-6"
          style={{ top: cardTop }}
          onClick={() => setIntro(null)}
        >
          <div className="gh-pop max-w-sm rounded-2xl border border-emerald-300/20 bg-gradient-to-b from-[#0a2a3c]/95 to-[#061722]/95 px-5 py-3.5 text-center shadow-2xl shadow-black/60 backdrop-blur-md">
            <div className="font-mono text-[10px] uppercase tracking-[0.36em] text-emerald-300/75">
              Hole {intro.index + 1}
              {intro.courseName ? ` · ${intro.courseName}` : ""}
            </div>
            <div className="mt-1 text-xl font-black leading-tight tracking-tight text-white">
              {intro.name}
            </div>
            <div className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.18em] text-amber-200/80">
              Par {intro.par}
            </div>
            {intro.hint && (
              <p className="mt-2 text-[12.5px] leading-relaxed text-emerald-50/70">{intro.hint}</p>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Toasts                                                              */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="pointer-events-none absolute inset-x-0 flex flex-col items-center gap-1.5 px-6"
        style={{ top: cardTop }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="gh-toast flex items-center gap-2 rounded-full border border-white/10 bg-[#04121b]/80 py-1.5 pl-2.5 pr-4 shadow-lg shadow-black/50 backdrop-blur-md"
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: t.color, boxShadow: `0 0 10px ${t.color}` }}
            />
            <span className="text-[13px] font-bold leading-none" style={{ color: t.color }}>
              {t.text}
            </span>
            {t.sub && <span className="text-[12px] leading-none text-white/50">{t.sub}</span>}
          </div>
        ))}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Shot console — thumb arc, ~19% of a 932 px phone, anchored to the   */}
      {/* true viewport bottom so no live world leaks beneath it.             */}
      {/* ------------------------------------------------------------------ */}
      <div ref={panelRef} data-drag="0" className="gh-panel absolute inset-x-0 bottom-0">
        {/* A short fade so the world dissolves into the console instead of
            ending on a hard floating card edge. */}
        <div className="pointer-events-none h-5 w-full bg-gradient-to-t from-[#04121b]/85 to-transparent" />
        <div
          className="gh-rise border-t border-white/10 bg-[#04121b]/88 px-3 pt-1.5 shadow-[0_-12px_36px_rgba(0,0,0,0.45)] backdrop-blur-md"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 10px)" }}
        >
          <div className="mx-auto w-full max-w-[560px]">
            {/* The hint sits above the controls, where it is readable — not
                hairline text pinned to the bottom edge of the screen. */}
            <div className="text-center font-mono text-[9.5px] uppercase tracking-[0.16em] text-white/55">
              Drag back from the ball, or set power &amp; aim
            </div>

            {/* Power — one row: label, track, value. */}
            <div className="mt-1 flex items-center gap-2">
              <span className="w-[38px] shrink-0 font-mono text-[9.5px] font-bold uppercase tracking-[0.12em] text-white/45">
                Power
              </span>
              <div
                className="pointer-events-auto relative h-[44px] min-w-0 flex-1 touch-none rounded-xl border border-white/10 bg-black/40"
                {...trackProps(setPower)}
              >
                <div className="absolute inset-y-0" style={{ left: KNOB_PAD, right: KNOB_PAD }}>
                  <div className="absolute top-1/2 h-[9px] w-full -translate-y-1/2 overflow-hidden rounded-full bg-white/10">
                    <div ref={powFill} className="h-full rounded-full" style={{ width: "60%", background: "#fbbf24" }} />
                  </div>
                  <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-center justify-between">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <span key={i} className="h-[13px] w-[2px] rounded bg-white/20" />
                    ))}
                  </div>
                  <div
                    ref={powKnob}
                    className="pointer-events-none absolute top-1/2 h-[28px] w-[28px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] bg-white shadow-[0_2px_8px_rgba(0,0,0,.6)]"
                    style={{ left: "60%", borderColor: "#fbbf24" }}
                  />
                </div>
              </div>
              <span ref={powTxt} className="w-[42px] shrink-0 text-right font-mono text-[15px] font-black tabular-nums text-white">
                60%
              </span>
            </div>

            {/* Aim — same row shape, so the pair reads as one control block. */}
            <div className="mt-1.5 flex items-center gap-2">
              <span className="w-[38px] shrink-0 font-mono text-[9.5px] font-bold uppercase tracking-[0.12em] text-white/45">
                Aim
              </span>
              <div
                className="pointer-events-auto relative h-[44px] min-w-0 flex-1 touch-none rounded-xl border border-white/10 bg-black/40"
                {...trackProps(setAngle)}
              >
                <div className="absolute inset-y-0" style={{ left: KNOB_PAD, right: KNOB_PAD }}>
                  <div className="absolute top-1/2 h-[9px] w-full -translate-y-1/2 overflow-hidden rounded-full bg-white/10">
                    <div
                      ref={angFill}
                      className="h-full rounded-full bg-gradient-to-r from-sky-400/60 to-emerald-300/80"
                      style={{ width: "40%" }}
                    />
                  </div>
                  <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-center justify-between">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <span key={i} className="h-[13px] w-[2px] rounded bg-white/20" />
                    ))}
                  </div>
                  <div
                    ref={angKnob}
                    className="pointer-events-none absolute top-1/2 h-[28px] w-[28px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-emerald-200 bg-white shadow-[0_2px_8px_rgba(0,0,0,.6)]"
                    style={{ left: "40%" }}
                  />
                </div>
              </div>
              <span ref={angTxt} className="w-[42px] shrink-0 text-right font-mono text-[15px] font-black tabular-nums text-white">
                36°
              </span>
            </div>

            {/* Bag · Swing · Jetpack */}
            <div className="mt-1.5 flex items-stretch gap-2">
              <button
                type="button"
                onClick={() => setBagOpen((v) => !v)}
                aria-label="Ball bag"
                className="pointer-events-auto relative flex h-[52px] w-[52px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-2xl border border-white/10 bg-white/[0.06] transition active:scale-95"
              >
                <span
                  className="h-[20px] w-[20px] rounded-full"
                  style={{
                    background: `radial-gradient(circle at 32% 30%, #fff, ${hex(cur.tint)} 62%, rgba(0,0,0,.55))`,
                    boxShadow: `0 0 12px ${hex(cur.tint)}aa`,
                  }}
                />
                <span className="max-w-[48px] truncate font-mono text-[8px] font-bold uppercase leading-none tracking-[0.06em] text-white/65">
                  {cur.name}
                </span>
                {ballType !== "standard" && (
                  <span className="absolute -right-1 -top-1 rounded-full bg-amber-300 px-1.5 py-0.5 font-mono text-[9px] font-black leading-none text-slate-900">
                    {counts[ballType] ?? 0}
                  </span>
                )}
              </button>

              <button
                ref={swingBtn}
                type="button"
                onClick={swing}
                aria-label="Swing"
                className="gh-breathe pointer-events-auto flex h-[52px] flex-1 items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-300 to-teal-300 text-slate-900 transition active:scale-95"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 20c4-1 7-3.5 9-7.5" />
                  <path d="M13 12.5 19 3" />
                  <circle cx="6.5" cy="18.5" r="1.6" fill="currentColor" />
                </svg>
                <span ref={swingTxt} className="text-[15px] font-black uppercase tracking-[0.18em]">
                  Swing
                </span>
              </button>

              <div className="pointer-events-none relative flex w-[52px] shrink-0 flex-col items-center justify-center">
                <button
                  type="button"
                  onClick={toggleJet}
                  onPointerDown={(e) => {
                    if (!flying) return;
                    e.preventDefault();
                    thrust(true);
                  }}
                  onPointerUp={() => flying && thrust(false)}
                  onPointerCancel={() => flying && thrust(false)}
                  onPointerLeave={() => flying && thrust(false)}
                  aria-label={flying ? "Thrust" : "Jetpack"}
                  className={`pointer-events-auto flex h-[52px] w-[52px] flex-col items-center justify-center gap-0.5 rounded-2xl border transition active:scale-95 ${
                    flying
                      ? "border-amber-300/60 bg-amber-400/25 text-amber-200"
                      : "border-white/10 bg-white/[0.06] text-white/75"
                  }`}
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3c2.2 2.3 3.2 5 3.2 8.2V16H8.8v-4.8C8.8 8 9.8 5.3 12 3Z" />
                    <path d="M8.8 16 7 19M15.2 16 17 19" />
                    <path d="M12 18.5v2.5" />
                  </svg>
                  <span className="font-mono text-[8px] font-bold uppercase leading-none tracking-[0.08em]">
                    {flying ? "Hold" : "Fly"}
                  </span>
                </button>
                {flying && (
                  <div className="gh-slide absolute -top-2.5 flex w-[48px] flex-col items-center">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/70 ring-1 ring-white/10">
                      <div
                        ref={fuelBar}
                        className="h-full w-full origin-left rounded-full"
                        style={{ background: "#2dd4bf", transform: "scaleX(1)" }}
                      />
                    </div>
                    <span className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.14em] text-white/50">
                      {dryTank ? "refuel" : "fuel"}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Ball bag tray                                                       */}
      {/* ------------------------------------------------------------------ */}
      {bagOpen && (
        <div
          className="pointer-events-auto absolute inset-0 z-30 flex items-end bg-black/40 backdrop-blur-[2px]"
          onClick={() => setBagOpen(false)}
        >
          <div
            className="gh-pop w-full rounded-t-3xl border-t border-white/10 bg-[#04121b]/95 px-3 pt-3 shadow-2xl"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-2.5 h-1 w-10 rounded-full bg-white/20" />
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="font-mono text-[11px] uppercase tracking-[0.26em] text-emerald-300/80">
                Ball bag
              </span>
              <button
                type="button"
                onClick={() => setBagOpen(false)}
                className="rounded-full bg-white/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-white/70 active:scale-95"
              >
                Close
              </button>
            </div>
            <div className="gh-scroll grid max-h-[46vh] grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2" style={{ scrollbarWidth: "none" }}>
              {ORDER.map((t) => {
                const props = BALL_TYPES[t];
                const infinite = t === "standard";
                const n = infinite ? Infinity : counts[t] ?? 0;
                const out = !infinite && n <= 0;
                const active = t === ballType;
                return (
                  <button
                    key={t}
                    type="button"
                    disabled={out}
                    onClick={() => !out && pickBall(t)}
                    className={`flex items-center gap-3 rounded-2xl border px-3 py-2.5 text-left transition active:scale-[0.985] ${
                      active
                        ? "border-emerald-300/60 bg-emerald-300/10"
                        : out
                          ? "border-white/5 bg-white/[0.02] opacity-40"
                          : "border-white/10 bg-white/[0.05]"
                    }`}
                  >
                    <span
                      className="h-8 w-8 shrink-0 rounded-full"
                      style={{
                        background: `radial-gradient(circle at 32% 30%, #fff, ${hex(props.tint)} 60%, rgba(0,0,0,.6))`,
                        boxShadow: out ? "none" : `0 0 12px ${hex(props.tint)}99`,
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[14px] font-bold text-white/95">{props.name}</span>
                        <span className="shrink-0 font-mono text-[11px] font-bold uppercase tracking-widest text-amber-200/80">
                          {infinite ? "∞" : `×${n}`}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-[12px] leading-snug text-white/50">
                        {props.blurb}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Hole complete — the reward beat                                     */}
      {/* ------------------------------------------------------------------ */}
      {holed && !done && (
        <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-[#020a10]/75 px-6 backdrop-blur-md">
          <div className="gh-pop w-full max-w-sm overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-[#0b3348] to-[#061722] shadow-[0_30px_80px_rgba(0,0,0,.7)]">
            <div className="relative px-7 pb-6 pt-8 text-center">
              <div
                className="pointer-events-none absolute inset-x-0 top-0 h-32 opacity-60"
                style={{
                  background:
                    "radial-gradient(120% 80% at 50% -10%, rgba(52,211,153,.35), transparent 70%)",
                }}
              />
              <div className="relative font-mono text-[10px] uppercase tracking-[0.42em] text-emerald-300/70">
                Hole {holed ? (hole?.index ?? 0) + 1 : ""} complete
              </div>
              <div
                className="gh-shine relative mt-2 bg-gradient-to-r from-emerald-200 via-amber-200 to-emerald-200 bg-clip-text text-[40px] font-black leading-none tracking-tight text-transparent"
              >
                {scoreName(holed.strokes, holed.par)}
              </div>
              <div className="relative mt-3 flex items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em]">
                <span className="rounded-lg bg-white/10 px-2 py-1 text-white/75">
                  {holed.strokes} strokes
                </span>
                <span className="rounded-lg bg-white/10 px-2 py-1 text-white/75">Par {holed.par}</span>
                <span className={`rounded-lg bg-white/10 px-2 py-1 font-black ${relTone(holed.strokes - holed.par)}`}>
                  {relToPar(holed.strokes - holed.par)}
                </span>
              </div>
              <div className="relative mt-4 flex items-center justify-center gap-6 border-t border-white/10 pt-4 font-mono text-[11px] uppercase tracking-[0.12em] text-white/50">
                <span>
                  Round <span className="text-white/80">{holed.total}</span>
                </span>
                <span>
                  Vs par <span className={`font-black ${relTone(played.rel)}`}>{relToPar(played.rel)}</span>
                </span>
              </div>
              <button
                type="button"
                onClick={nextHole}
                className="mt-6 w-full rounded-full bg-gradient-to-r from-emerald-300 to-teal-300 py-3.5 text-[13px] font-black uppercase tracking-[0.22em] text-slate-900 shadow-[0_0_36px_rgba(52,211,153,.4)] transition active:scale-95"
              >
                Next hole
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Course complete — the full round                                    */}
      {/* ------------------------------------------------------------------ */}
      {done && (
        <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-[#020a10]/90 px-5 backdrop-blur-md">
          <div className="gh-pop flex w-full max-w-sm flex-col overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-[#0b3348] to-[#061722] shadow-[0_30px_80px_rgba(0,0,0,.7)]">
            <div className="px-6 pb-3 pt-7 text-center">
              <div className="font-mono text-[10px] uppercase tracking-[0.42em] text-amber-300/75">
                Round complete
              </div>
              <div className="mt-1.5 text-2xl font-black tracking-tight text-white">{done.courseName}</div>
              <div className="mt-2 flex items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em]">
                <span className="rounded-lg bg-white/10 px-2 py-1 text-white/75">{played.strokes} strokes</span>
                <span className="rounded-lg bg-white/10 px-2 py-1 text-white/75">Par {played.par}</span>
                <span className={`rounded-lg bg-white/10 px-2 py-1 font-black ${relTone(played.rel)}`}>
                  {relToPar(played.rel)}
                </span>
              </div>
            </div>
            <div className="gh-scroll max-h-[44vh] overflow-y-auto px-3 pb-2" style={{ scrollbarWidth: "none" }}>
              {card.map((r) => {
                const d = r.strokes - r.par;
                return (
                  <div
                    key={r.index}
                    className="flex items-center gap-3 border-b border-white/5 px-2 py-2 last:border-0"
                  >
                    <span className="w-5 shrink-0 font-mono text-[11px] text-white/40">{r.index + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-white/80">{r.name}</span>
                    <span className="shrink-0 font-mono text-[11px] text-white/40">par {r.par}</span>
                    <span className="w-6 shrink-0 text-right font-mono text-[13px] font-bold text-white">
                      {r.strokes}
                    </span>
                    <span className={`w-7 shrink-0 text-right font-mono text-[12px] font-black ${relTone(d)}`}>
                      {relToPar(d)}
                    </span>
                  </div>
                );
              })}
              {card.length === 0 && (
                <div className="px-2 py-6 text-center font-mono text-[12px] uppercase tracking-widest text-white/30">
                  No holes recorded
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => setDone(null)}
              className="m-4 rounded-full bg-gradient-to-r from-amber-300 to-emerald-300 py-3.5 text-[13px] font-black uppercase tracking-[0.22em] text-slate-900 transition active:scale-95"
            >
              Nice round
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One swatch in the expanded map's legend. */
function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

/**
 * The expanded hole overview reuses the minimap's *backing store* rather than
 * a second render pass: one `drawImage` per frame of the already-drawn canvas
 * into a bigger CSS box. Cheaper than baking a second static layer, and it can
 * never disagree with the chip at the top of the frame.
 */
function MiniMirror({ source }: { source: MutableRefObject<HTMLCanvasElement | null> }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const cv = ref.current;
    if (cv) {
      cv.width = MINI_W;
      cv.height = MINI_H;
    }
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dst = ref.current;
      const src = source.current;
      if (!dst || !src) return;
      const c = dst.getContext("2d");
      if (!c) return;
      c.clearRect(0, 0, MINI_W, MINI_H);
      c.drawImage(src, 0, 0);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [source]);
  return <canvas ref={ref} className="block h-auto w-full" />;
}
