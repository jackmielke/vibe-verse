/**
 * Vibe Golf — HUD and UI shell.
 *
 * Phone-first. The whole game is one drag gesture on the canvas, so the HUD's
 * first job is to *stay out of the way of that gesture* and its second is to
 * answer, at a glance: which hole, how many strokes, how hard am I hitting it,
 * and where am I going.
 *
 * Layout contract (430×932 is the design target):
 *   • top strip  — scorecard + hole profile map. Never touched by a thumb.
 *   • middle     — untouched. Every pixel of it belongs to the ball and the
 *                  slingshot drag; the only `pointer-events-auto` things there
 *                  are the modal cards, which appear when play has stopped.
 *   • bottom     — two thumb-reachable round buttons in the corners (ball bag
 *                  left, jetpack right) with the power dial between them.
 *                  Corners, not a full-width bar: a bar would sit under the
 *                  ball on a low lie and eat the drag.
 *
 * Perf contract: `golf:aim` and `golf:jetpackState` fire at frame rate, so
 * nothing they carry ever reaches `setState`. They land in refs; one shared
 * rAF loop draws the power dial (canvas), the minimap (canvas, throttled and
 * blitted from a pre-rendered static layer) and the fuel bar (one style
 * write). Only genuinely discrete things — hole changes, strokes, the bag,
 * cards, toasts — go through React.
 *
 * Everything is procedural: no images, no fonts, no assets.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { BASE_VIEW_HEIGHT, type GolfEngine } from "../engine/core";
import { BALL_TYPES, type BallType, type Hole, type SurfaceMaterial } from "../types";

// ---------------------------------------------------------------------------
// Tuning / palette
// ---------------------------------------------------------------------------

/** Bag order — matches the 1..8 keyboard order in `powerups.ts`. */
const ORDER: BallType[] = ["standard", "sticky", "ice", "nitro", "super", "multi", "ghost", "heavy"];

/** Backing resolution of the minimap. Drawn once, displayed at any CSS size. */
const MINI_W = 720;
const MINI_H = 190;
/** Minimap dynamic layer refresh, ms. 20 Hz is plenty for a 200 px strip. */
const MINI_HZ_MS = 50;

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
  const t = Math.max(0, Math.min(1, p));
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

interface AimState {
  aiming: boolean;
  power: number;
  angle: number;
}

interface JetState {
  active: boolean;
  fuel: number;
  dry: boolean;
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

  // --- per-frame state (refs — never setState from these) ------------------
  const aimRef = useRef<AimState>({ aiming: false, power: 0, angle: 0 });
  const aimDirty = useRef(true);
  const aimVis = useRef(0);
  const jetRef = useRef<JetState>({ active: false, fuel: 1, dry: false, x: 0, y: 0 });
  const jetDirty = useRef(true);

  const powerCv = useRef<HTMLCanvasElement | null>(null);
  const powerWrap = useRef<HTMLDivElement | null>(null);
  const fuelBar = useRef<HTMLDivElement | null>(null);
  const miniCv = useRef<HTMLCanvasElement | null>(null);
  const miniStatic = useRef<HTMLCanvasElement | null>(null);
  /** World→minimap transform, rebuilt on hole load. */
  const miniXf = useRef<{ x0: number; y0: number; sx: number; sy: number; padX: number; padY: number } | null>(null);
  const holeRef = useRef<Hole | null>(null);
  const miniAt = useRef(0);
  const miniLast = useRef({ bx: 1e9, by: 1e9, cx: 1e9 });

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

  // -------------------------------------------------------------------------
  // Toasts
  // -------------------------------------------------------------------------
  const pushToast = useCallback((text: string, color: string, sub?: string) => {
    const id = ++toastId.current;
    // Something just happened — the intro card has had its moment, and the two
    // share the same slot under the scorecard.
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
    x0 -= 3; x1 += 3; y0 -= 2.5; y1 += 3.5;
    if (x1 - x0 < 1) x1 = x0 + 1;
    if (y1 - y0 < 1) y1 = y0 + 1;

    const padX = 14;
    const padY = 12;
    const sx = (MINI_W - padX * 2) / (x1 - x0);
    const sy = (MINI_H - padY * 2) / (y1 - y0);
    miniXf.current = { x0, y0, sx, sy, padX, padY };
    const px = (x: number) => padX + (x - x0) * sx;
    const py = (y: number) => MINI_H - padY - (y - y0) * sy;

    // Two passes: solid mass first (so the profile reads as *ground*, not a
    // squiggle at 150 px wide), then the surface line on top in its material
    // colour. At this scale everything is deliberately over-weighted — the
    // strip is displayed at roughly a fifth of the backing resolution.
    c.lineJoin = "round";
    c.lineCap = "round";
    for (const s of h.surfaces) {
      if (s.points.length < 2 || s.closed) continue;
      c.beginPath();
      c.moveTo(px(s.points[0].x), py(s.points[0].y));
      for (let i = 1; i < s.points.length; i++) c.lineTo(px(s.points[i].x), py(s.points[i].y));
      c.lineTo(px(s.points[s.points.length - 1].x), MINI_H);
      c.lineTo(px(s.points[0].x), MINI_H);
      c.closePath();
      c.fillStyle = HAZARD_MATS[s.material] ? MAT_COLOR[s.material] + "55" : "rgba(19,50,66,0.9)";
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
        c.fillStyle = MAT_COLOR[s.material] + (haz ? "aa" : "66");
        c.fill();
      }
      c.strokeStyle = MAT_COLOR[s.material];
      c.lineWidth = haz ? 13 : 8;
      c.globalAlpha = haz ? 1 : 0.95;
      c.stroke();
      c.globalAlpha = 1;
    }

    // Tee: a teal peg. Cup: an amber flag — the thing you're aiming at, so it
    // is the brightest, largest mark on the map.
    const tx = px(h.tee.x);
    const ty = py(h.tee.y);
    c.fillStyle = "#5eead4";
    c.beginPath();
    c.arc(tx, ty - 6, 8, 0, Math.PI * 2);
    c.fill();

    const cx = px(h.cup.x);
    const cy = py(h.cup.y);
    c.strokeStyle = "#fbbf24";
    c.lineWidth = 5;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx, cy - 46);
    c.stroke();
    c.fillStyle = "#fbbf24";
    c.shadowColor = "#fbbf24";
    c.shadowBlur = 16;
    c.beginPath();
    c.moveTo(cx, cy - 46);
    c.lineTo(cx + 30, cy - 35);
    c.lineTo(cx, cy - 24);
    c.closePath();
    c.fill();
    c.shadowBlur = 0;
  }, []);

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
      syncBag();
      const h = window.setTimeout(() => setIntro((cur) => (cur === info ? null : cur)), 4600);
      timers.current.push(h);
    });

    sub("golf:shot", (p) => {
      setStrokes((p as { strokes: number })?.strokes ?? 0);
      setBagOpen(false);
      syncBag();
    });

    sub("golf:ready", (p) => {
      setStrokes((p as { strokes: number })?.strokes ?? 0);
      syncBag();
    });

    sub("golf:ballType", () => syncBag());
    sub("golf:hazard", (p) => {
      lastHazard.current = (p as { material?: string })?.material ?? "";
    });

    sub("golf:penalty", (p) => {
      setStrokes((p as { strokes: number })?.strokes ?? 0);
      const m = lastHazard.current;
      const word = m === "water" ? "Splash" : m === "lava" ? "Scorched" : m === "outOfBounds" ? "Out of bounds" : "Hazard";
      pushToast(word, "#fb7185", "+1 stroke · replay the lie");
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

    // Per-frame channels — refs only.
    sub("golf:aim", (p) => {
      const d = p as { aiming?: boolean; power?: number; angle?: number };
      const a = aimRef.current;
      a.aiming = !!d?.aiming;
      a.power = d?.power ?? 0;
      a.angle = d?.angle ?? 0;
      aimDirty.current = true;
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
    }
    setStrokes(engine.ctx?.services?.rules?.strokes ?? 0);
    syncBag();

    return () => {
      offs.forEach((f) => f());
      timers.current.forEach((h) => window.clearTimeout(h));
      timers.current = [];
    };
  }, [engine, bakeMini, pushToast, syncBag]);

  // -------------------------------------------------------------------------
  // The single rAF loop. Power dial + minimap + fuel bar, all ref-driven.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    // Backing-store sizing happens once; CSS size is free to change (the
    // minimap expands to full width on tap without a redraw).
    const pc = powerCv.current;
    if (pc) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      pc.width = Math.round(190 * dpr);
      pc.height = Math.round(112 * dpr);
    }
    const mc = miniCv.current;
    if (mc) {
      mc.width = MINI_W;
      mc.height = MINI_H;
    }

    const drawPower = () => {
      const cv = powerCv.current;
      const wrap = powerWrap.current;
      if (!cv) return;
      const c = cv.getContext("2d");
      if (!c) return;
      const dpr = cv.width / 190;
      const a = aimRef.current;
      const w = 190;
      const h = 112;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h - 24;
      const r = 68;
      const p = Math.max(0, Math.min(1, a.power));

      // Track.
      c.lineCap = "round";
      c.lineWidth = 11;
      c.strokeStyle = "rgba(8,20,30,0.72)";
      c.beginPath();
      c.arc(cx, cy, r, Math.PI, Math.PI * 2);
      c.stroke();
      c.lineWidth = 9;
      c.strokeStyle = "rgba(255,255,255,0.13)";
      c.beginPath();
      c.arc(cx, cy, r, Math.PI, Math.PI * 2);
      c.stroke();

      // Ticks every 25% so the arc reads as a scale, not a blob.
      c.strokeStyle = "rgba(255,255,255,0.28)";
      c.lineWidth = 1.5;
      for (let i = 0; i <= 4; i++) {
        const ang = Math.PI + (i / 4) * Math.PI;
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        c.beginPath();
        c.moveTo(cx + ca * (r - 8), cy + sa * (r - 8));
        c.lineTo(cx + ca * (r + 8), cy + sa * (r + 8));
        c.stroke();
      }

      if (p > 0.001) {
        const col = powerColor(p);
        c.strokeStyle = col;
        c.lineWidth = 9;
        c.shadowColor = col;
        c.shadowBlur = 14;
        c.beginPath();
        c.arc(cx, cy, r, Math.PI, Math.PI + p * Math.PI);
        c.stroke();
        c.shadowBlur = 0;

        // Angle needle — world radians, canvas Y is flipped.
        const na = -a.angle;
        c.strokeStyle = "rgba(255,255,255,0.85)";
        c.lineWidth = 2.5;
        c.beginPath();
        c.moveTo(cx + Math.cos(na) * 12, cy + Math.sin(na) * 12);
        c.lineTo(cx + Math.cos(na) * (r - 14), cy + Math.sin(na) * (r - 14));
        c.stroke();
        c.fillStyle = "rgba(255,255,255,0.9)";
        c.beginPath();
        c.arc(cx, cy, 3.5, 0, Math.PI * 2);
        c.fill();

        c.textAlign = "center";
        c.fillStyle = col;
        c.font = "700 26px ui-monospace, SFMono-Regular, Menlo, monospace";
        c.fillText(`${Math.round(p * 100)}%`, cx, cy - 6);
        c.fillStyle = "rgba(255,255,255,0.62)";
        c.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
        c.fillText(`${Math.round((a.angle * 180) / Math.PI)}°`, cx, cy + 13);
      }

      if (wrap) wrap.style.opacity = aimVis.current.toFixed(3);
    };

    const drawMini = () => {
      const cv = miniCv.current;
      const stat = miniStatic.current;
      const xf = miniXf.current;
      if (!cv || !stat || !xf) return;
      const c = cv.getContext("2d");
      if (!c) return;

      const px = (x: number) => xf.padX + (x - xf.x0) * xf.sx;
      const py = (y: number) => MINI_H - xf.padY - (y - xf.y0) * xf.sy;

      const ball = engine.ctx?.services?.physics?.balls?.find((b) => b.active) ?? null;
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

      // Camera window — where you're actually looking right now.
      const zoom = engine.zoom || 1;
      const aspect = window.innerWidth / Math.max(1, window.innerHeight);
      const halfW = (BASE_VIEW_HEIGHT / 2 / zoom) * aspect;
      const wx0 = px(camX - halfW);
      const wx1 = px(camX + halfW);
      c.fillStyle = "rgba(255,255,255,0.09)";
      c.fillRect(wx0, 0, Math.max(3, wx1 - wx0), MINI_H);
      c.strokeStyle = "rgba(255,255,255,0.3)";
      c.lineWidth = 3;
      c.strokeRect(wx0, 2, Math.max(3, wx1 - wx0), MINI_H - 4);

      // Golfer, while he's out scouting.
      const j = jetRef.current;
      if (j.active) {
        c.fillStyle = "rgba(251,191,36,0.9)";
        c.beginPath();
        c.arc(px(j.x), py(j.y), 9, 0, Math.PI * 2);
        c.fill();
      }

      if (ball) {
        const tint = BALL_TYPES[ball.type]?.tint ?? 0xffffff;
        const col = hex(tint);
        c.fillStyle = "rgba(2,10,16,0.85)";
        c.beginPath();
        c.arc(px(bx), py(by), 16, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = col;
        c.shadowColor = col;
        c.shadowBlur = 18;
        c.beginPath();
        c.arc(px(bx), py(by), 11, 0, Math.PI * 2);
        c.fill();
        c.shadowBlur = 0;
      }
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      // Power dial: ease the whole widget in/out so a released shot doesn't
      // pop. Redraw while it's visible or one last time as it lands on zero.
      const want = aimRef.current.aiming ? 1 : 0;
      const prev = aimVis.current;
      aimVis.current += (want - prev) * Math.min(1, dt * 14);
      if (Math.abs(want - aimVis.current) < 0.004) aimVis.current = want;
      if (aimDirty.current || aimVis.current !== prev) {
        aimDirty.current = false;
        drawPower();
      }

      if (jetDirty.current) {
        jetDirty.current = false;
        const bar = fuelBar.current;
        if (bar) {
          const f = Math.max(0, Math.min(1, jetRef.current.fuel));
          bar.style.transform = `scaleX(${f.toFixed(3)})`;
          bar.style.background = f < 0.22 ? "#fb7185" : f < 0.5 ? "#fbbf24" : "#2dd4bf";
        }
      }

      if (now - miniAt.current >= MINI_HZ_MS) {
        miniAt.current = now;
        drawMini();
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  // Re-bake when the map is expanded so nothing is stale behind the overlay.
  useEffect(() => {
    miniLast.current = { bx: 1e9, by: 1e9, cx: 1e9 };
  }, [mapBig]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  const pickBall = useCallback((t: BallType) => {
    engine.emit?.("golf:selectBall", { type: t });
    setBallType(t);
    setBagOpen(false);
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

  const cur = BALL_TYPES[ballType] ?? BALL_TYPES.standard;
  const holeLabel = hole ? `${hole.index + 1}${hole.count ? `/${hole.count}` : ""}` : "—";

  return (
    <div className="pointer-events-none absolute inset-0 z-20 select-none font-sans text-white">
      <style>{`
        @keyframes gh-pop { 0% { transform: scale(.82) translateY(14px); opacity: 0 }
          60% { transform: scale(1.03) translateY(0); opacity: 1 }
          100% { transform: scale(1) translateY(0); opacity: 1 } }
        @keyframes gh-slide { from { transform: translateY(-10px); opacity: 0 }
          to { transform: translateY(0); opacity: 1 } }
        @keyframes gh-toast { from { transform: translateY(8px) scale(.96); opacity: 0 }
          to { transform: translateY(0) scale(1); opacity: 1 } }
        @keyframes gh-shine { from { background-position: -200% 0 } to { background-position: 200% 0 } }
        .gh-pop { animation: gh-pop .42s cubic-bezier(.2,1.3,.4,1) both }
        .gh-slide { animation: gh-slide .3s ease-out both }
        .gh-toast { animation: gh-toast .22s ease-out both }
        .gh-shine { background-size: 200% 100%; animation: gh-shine 2.4s linear infinite }
        .gh-scroll::-webkit-scrollbar { display: none }
      `}</style>

      {/* ------------------------------------------------------------------ */}
      {/* Top strip — scorecard + hole profile                                */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 px-3"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 10px)" }}
      >
        <div className="gh-slide pointer-events-none rounded-2xl border border-white/10 bg-[#04121b]/70 px-3 py-2 shadow-lg shadow-black/40 backdrop-blur-md">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-300/90">
              {holeLabel}
            </span>
            <span className="max-w-[38vw] truncate text-[13px] font-bold leading-none text-white/95 sm:max-w-none">
              {hole?.name ?? "Loading"}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em]">
            <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-white/70">Par {hole?.par ?? "-"}</span>
            <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-white/70">
              <span className="text-white">{strokes}</span> shot{strokes === 1 ? "" : "s"}
            </span>
            {card.length > 0 && (
              <span className={`rounded-md bg-white/10 px-1.5 py-0.5 font-bold ${relTone(played.rel)}`}>
                {relToPar(played.rel)}
              </span>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setMapBig((v) => !v)}
          aria-label="Hole overview"
          className="pointer-events-auto shrink-0 overflow-hidden rounded-xl border border-white/10 bg-[#04121b]/70 shadow-lg shadow-black/40 backdrop-blur-md active:scale-95"
        >
          <canvas
            ref={miniCv}
            className="block h-[54px] w-[172px] sm:h-[70px] sm:w-[256px]"
            style={{ imageRendering: "auto" }}
          />
        </button>
      </div>

      {/* Expanded hole overview */}
      {mapBig && (
        <div
          className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
          onClick={() => setMapBig(false)}
        >
          <div className="gh-pop w-full max-w-2xl rounded-2xl border border-white/10 bg-[#04121b]/90 p-3 shadow-2xl">
            <div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-white/50">
              <span>{hole?.name ?? "Hole"}</span>
              <span>Par {hole?.par ?? "-"} · tap to close</span>
            </div>
            {/* Same backing canvas, larger CSS box — no redraw needed. */}
            <div className="overflow-hidden rounded-xl bg-black/40">
              <MiniMirror source={miniCv} />
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
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 88px)" }}
          onClick={() => setIntro(null)}
        >
          <div className="gh-pop max-w-sm rounded-2xl border border-emerald-300/20 bg-gradient-to-b from-[#0a2a3c]/95 to-[#061722]/95 px-5 py-4 text-center shadow-2xl shadow-black/60 backdrop-blur-md">
            <div className="font-mono text-[9px] uppercase tracking-[0.4em] text-emerald-300/70">
              Hole {intro.index + 1}
              {intro.courseName ? ` · ${intro.courseName}` : ""}
            </div>
            <div className="mt-1.5 text-2xl font-black leading-tight tracking-tight text-white">
              {intro.name}
            </div>
            <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-amber-200/80">
              Par {intro.par}
            </div>
            {intro.hint && (
              <p className="mt-2.5 text-[12px] leading-relaxed text-emerald-50/60">{intro.hint}</p>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Toasts                                                              */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="pointer-events-none absolute inset-x-0 flex flex-col items-center gap-1.5 px-6"
        style={{ top: "calc(env(safe-area-inset-top, 0px) + 92px)" }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="gh-toast flex items-center gap-2 rounded-full border border-white/10 bg-[#04121b]/85 py-1.5 pl-2.5 pr-4 shadow-lg shadow-black/50 backdrop-blur-md"
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: t.color, boxShadow: `0 0 10px ${t.color}` }}
            />
            <span className="text-[12px] font-bold leading-none" style={{ color: t.color }}>
              {t.text}
            </span>
            {t.sub && <span className="text-[11px] leading-none text-white/50">{t.sub}</span>}
          </div>
        ))}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Bottom dock — bag (left), power dial (centre), jetpack (right)      */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="absolute inset-x-0 bottom-0 flex items-end justify-between px-4"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 14px)" }}
      >
        {/* Bag */}
        <button
          type="button"
          onClick={() => setBagOpen((v) => !v)}
          aria-label="Ball bag"
          className="pointer-events-auto relative flex h-[62px] w-[62px] shrink-0 flex-col items-center justify-center rounded-full border border-white/15 bg-[#04121b]/80 shadow-lg shadow-black/50 backdrop-blur-md transition active:scale-95"
        >
          <span
            className="h-6 w-6 rounded-full"
            style={{
              background: `radial-gradient(circle at 32% 30%, #fff, ${hex(cur.tint)} 62%, rgba(0,0,0,.55))`,
              boxShadow: `0 0 14px ${hex(cur.tint)}aa`,
            }}
          />
          <span className="mt-1 max-w-[54px] truncate font-mono text-[8px] uppercase tracking-[0.12em] text-white/60">
            {cur.name}
          </span>
          {ballType !== "standard" && (
            <span className="absolute -right-0.5 -top-0.5 rounded-full bg-amber-300 px-1.5 py-0.5 font-mono text-[9px] font-black leading-none text-slate-900">
              {counts[ballType] ?? 0}
            </span>
          )}
        </button>

        {/* Power dial — pure canvas, ref-driven, no React per frame. */}
        <div
          ref={powerWrap}
          className="pointer-events-none mb-1 flex-1"
          style={{ opacity: 0, transition: "none" }}
        >
          <canvas ref={powerCv} className="mx-auto block h-[112px] w-[190px]" />
        </div>

        {/* Jetpack */}
        <div className="pointer-events-none flex shrink-0 flex-col items-center gap-1.5">
          {flying && (
            <div className="gh-slide flex w-[62px] flex-col items-center">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/60 ring-1 ring-white/10">
                <div
                  ref={fuelBar}
                  className="h-full w-full origin-left rounded-full"
                  style={{ background: "#2dd4bf", transform: "scaleX(1)" }}
                />
              </div>
              <span className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.14em] text-white/45">
                {dryTank ? "refuel" : "fuel"}
              </span>
            </div>
          )}
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
            className={`pointer-events-auto flex h-[62px] w-[62px] items-center justify-center rounded-full border shadow-lg shadow-black/50 backdrop-blur-md transition active:scale-95 ${
              flying
                ? "border-amber-300/50 bg-amber-400/20 text-amber-200"
                : "border-white/15 bg-[#04121b]/80 text-white/70"
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3c2.2 2.3 3.2 5 3.2 8.2V16H8.8v-4.8C8.8 8 9.8 5.3 12 3Z" />
              <path d="M8.8 16 7 19M15.2 16 17 19" />
              <path d="M12 18.5v2.5" />
            </svg>
          </button>
          <span className="font-mono text-[8px] uppercase tracking-[0.16em] text-white/40">
            {flying ? "hold" : "fly"}
          </span>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Ball bag tray                                                       */}
      {/* ------------------------------------------------------------------ */}
      {bagOpen && (
        <div
          className="pointer-events-auto absolute inset-0 z-30 flex items-end bg-black/45 backdrop-blur-[2px]"
          onClick={() => setBagOpen(false)}
        >
          <div
            className="gh-pop w-full rounded-t-3xl border-t border-white/10 bg-[#04121b]/95 px-3 pt-3 shadow-2xl"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-2.5 h-1 w-10 rounded-full bg-white/20" />
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-emerald-300/70">
                Ball bag
              </span>
              <button
                type="button"
                onClick={() => setBagOpen(false)}
                className="rounded-full bg-white/10 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-white/60 active:scale-95"
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
                        <span className="truncate text-[13px] font-bold text-white/95">{props.name}</span>
                        <span className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-widest text-amber-200/80">
                          {infinite ? "∞" : `×${n}`}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] leading-snug text-white/45">
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
              <div className="relative font-mono text-[9px] uppercase tracking-[0.45em] text-emerald-300/60">
                Hole {holed ? (hole?.index ?? 0) + 1 : ""} complete
              </div>
              <div
                className="gh-shine relative mt-2 bg-gradient-to-r from-emerald-200 via-amber-200 to-emerald-200 bg-clip-text text-[40px] font-black leading-none tracking-tight text-transparent"
              >
                {scoreName(holed.strokes, holed.par)}
              </div>
              <div className="relative mt-3 flex items-center justify-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em]">
                <span className="rounded-lg bg-white/10 px-2 py-1 text-white/70">
                  {holed.strokes} strokes
                </span>
                <span className="rounded-lg bg-white/10 px-2 py-1 text-white/70">Par {holed.par}</span>
                <span className={`rounded-lg bg-white/10 px-2 py-1 font-black ${relTone(holed.strokes - holed.par)}`}>
                  {relToPar(holed.strokes - holed.par)}
                </span>
              </div>
              <div className="relative mt-4 flex items-center justify-center gap-6 border-t border-white/10 pt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
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
                className="mt-6 w-full rounded-full bg-gradient-to-r from-emerald-300 to-teal-300 py-3.5 text-[12px] font-black uppercase tracking-[0.22em] text-slate-900 shadow-[0_0_36px_rgba(52,211,153,.4)] transition active:scale-95"
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
        <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-[#020a10]/88 px-5 backdrop-blur-md">
          <div className="gh-pop flex w-full max-w-sm flex-col overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-[#0b3348] to-[#061722] shadow-[0_30px_80px_rgba(0,0,0,.7)]">
            <div className="px-6 pb-3 pt-7 text-center">
              <div className="font-mono text-[9px] uppercase tracking-[0.45em] text-amber-300/70">
                Round complete
              </div>
              <div className="mt-1.5 text-2xl font-black tracking-tight text-white">{done.courseName}</div>
              <div className="mt-2 flex items-center justify-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em]">
                <span className="rounded-lg bg-white/10 px-2 py-1 text-white/70">{played.strokes} strokes</span>
                <span className="rounded-lg bg-white/10 px-2 py-1 text-white/70">Par {played.par}</span>
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
                    <span className="w-5 shrink-0 font-mono text-[10px] text-white/35">{r.index + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-white/80">{r.name}</span>
                    <span className="shrink-0 font-mono text-[10px] text-white/35">par {r.par}</span>
                    <span className="w-6 shrink-0 text-right font-mono text-[12px] font-bold text-white">
                      {r.strokes}
                    </span>
                    <span className={`w-7 shrink-0 text-right font-mono text-[11px] font-black ${relTone(d)}`}>
                      {relToPar(d)}
                    </span>
                  </div>
                );
              })}
              {card.length === 0 && (
                <div className="px-2 py-6 text-center font-mono text-[11px] uppercase tracking-widest text-white/30">
                  No holes recorded
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => setDone(null)}
              className="m-4 rounded-full bg-gradient-to-r from-amber-300 to-emerald-300 py-3.5 text-[12px] font-black uppercase tracking-[0.22em] text-slate-900 transition active:scale-95"
            >
              Nice round
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The expanded hole overview reuses the minimap's *backing store* rather than
 * a second render pass: one `drawImage` per frame of the already-drawn canvas
 * into a bigger CSS box. Cheaper than baking a second static layer, and it can
 * never disagree with the strip in the corner.
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
