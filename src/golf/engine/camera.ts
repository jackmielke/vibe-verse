/**
 * Vibe Golf — camera.
 *
 * The engine's ortho frustum is derived from one number: `zoom` gives a view
 * *height* of `BASE_VIEW_HEIGHT / zoom` and the width falls out of the
 * viewport aspect. On a 430×932 phone the aspect is 0.46, so asking for a
 * fixed 34 m of height buys you a 15 m keyhole of width — the worst possible
 * split for a side-on golf game. So this system thinks in **view width**: it
 * picks the shot corridor it wants visible and solves back for the zoom the
 * engine needs (`zoom = BASE_VIEW_HEIGHT · aspect / width`).
 *
 * ## The safe rect
 *
 * The canvas is full-bleed but the *playfield* is not: a scorecard, hole map
 * and route chips own the top of the screen and a 280-ish px shot console owns
 * the bottom. Framing against the canvas therefore framed against a rectangle
 * the player cannot see — the ball landed dead-centre of the viewport, which is
 * the middle of the control panel, and the terrain was a 100 px letterbox
 * between two slabs of chrome.
 *
 * So the camera measures the chrome instead of guessing at it: once every
 * `INSET_MS` it walks the overlay DOM, collects every painted element welded to
 * the top or bottom edge, and grows a contiguous band from each edge. That
 * gives a **play safe-rect** — the band of screen that actually shows world —
 * and *every* framing decision here is expressed as a fraction of that band,
 * not of the viewport. The ball is anchored inside the band, the fit tests
 * measure the band, and the survey pan fits the hole to the band. The measure
 * falls back to sane fractions if the HUD hasn't mounted, is clamped so chrome
 * can never eat more than `1 - MIN_BAND` of the screen, and is smoothed so
 * toggling the hole map re-frames rather than snaps.
 *
 * ## Vertical framing
 *
 * A 1 m heightfield is sampled from the surfaces once per hole; every frame the
 * camera reads the highest ground across the visible span and places the
 * horizon so the skyline sits near the top of the safe rect — sky is the
 * cheapest thing on screen and is the first thing sacrificed. The frame bottom
 * is held above the terrain slab's floor, and that same floor caps how far we
 * may ever zoom out: a view taller than the world has solid ground for is how
 * a hole ends up as a 60 px ribbon of terrain floating in sky.
 *
 * ## Fitting, not guessing
 *
 * At address the corridor is fitted to the ball→pin span (padded), so on any
 * frame wide enough to hold the hole the flag is on screen instead of behind an
 * edge badge; it clamps only when the hole is genuinely longer than one screen,
 * and then biases forward so the visible half is the half you are playing into.
 * While a slingshot drag is live the predicted arc is integrated with the real
 * shot constants and the whole polyline is fitted inside the safe rect, so the
 * shot you are about to commit to can never run off the top or the side.
 *
 * Finally there's a survey mode: a scripted pan that frames the hole end to
 * end and holds on the flag. It runs once when a hole loads, on `golf:survey`,
 * on Q/Tab, and whenever something outside this module pushes `engine.zoom`
 * down (a debug tool, a capture harness).
 */
import type { Hole, System, SystemFactory } from "../types";
import type { GolfEngine } from "./core";
import { BASE_VIEW_HEIGHT } from "./core";

export interface GolfCameraSystem extends System {
  attachEngine(e: GolfEngine): void;
}

// --- Framing tuning ---------------------------------------------------------

/** Shot corridor visible at rest, in metres: portrait → landscape. */
const REST_WIDTH_TALL = 27;
const REST_WIDTH_WIDE = 56;
/** How much wider the corridor gets at full flight speed. */
const FLIGHT_WIDEN = 0.55;
/** Manual pinch range, as a multiplier on the corridor width. */
const USER_ZOOM_MIN = 0.5;
const USER_ZOOM_MAX = 2.2;
/** Where the focus sits inside the *safe rect*, measured up from its bottom. */
const ANCHOR_REST = 0.56;
const ANCHOR_FLIGHT = 0.52;
/**
 * The survey sits the hole low in the frame on purpose: in portrait the ortho
 * aspect turns every extra metre of hole into two and a bit metres of vertical,
 * and the only budget that buys width is the terrain slab under the skyline.
 * Spending it downward is what lets a phone hold a whole par 3 at once.
 */
const ANCHOR_SURVEY_TALL = 0.26;
/** A landscape frame has slack to spare, so it centres the hole instead. */
const ANCHOR_SURVEY_WIDE = 0.45;
/** The focus is never pushed outside this slice of the safe rect. */
const BAND_KEEP_HIGH = 0.94;
const BAND_KEEP_LOW = 0.08;
/** Sky is never more (or less) than this share of the whole frame. */
const SKY_MAX = 0.45;
const SKY_MIN = 0.04;
/**
 * Metres of terrain slab under `bounds.min` we may show. `render.ts` extrudes
 * the ground 90 m below the hole floor; stay inside that and the frame bottom
 * is always solid world instead of a window into the backdrop.
 */
const SLAB_USABLE = 76;
/** Share of the frame / safe rect a fitted subject is allowed to fill. */
const SIDE_FILL = 0.86;
const BAND_FILL = 0.82;
/** Address fit ceiling as a multiple of the rest corridor (portrait → wide). */
const ADDRESS_SCALE_TALL = 1.85;
const ADDRESS_SCALE_WIDE = 3.4;
/** Corridor when the pin is out of reach of any sane zoom, same units. */
const CRUISE_SCALE_TALL = 1.15;
const CRUISE_SCALE_WIDE = 1.6;
/** Survey width ceiling, same units — normally the terrain slab binds first. */
const SURVEY_SCALE_TALL = 4.5;
const SURVEY_SCALE_WIDE = 5;
/** When the pin will not fit, push this far past the ball toward it. */
const FORWARD_BIAS = 0.24;

// --- Safe rect tuning -------------------------------------------------------

/** Used until the HUD has mounted and can be measured. */
const DEFAULT_TOP_FRAC = 0.22;
const DEFAULT_BOTTOM_FRAC = 0.3;
/** Hard ceilings on measured chrome, and the floor on what's left for play. */
const TOP_LIMIT = 0.3;
const BOTTOM_LIMIT = 0.38;
const MIN_BAND = 0.3;
/** How often the chrome is re-measured, ms. */
const INSET_MS = 260;

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

// --- Ground silhouette ------------------------------------------------------

/** A 1 m-per-column sample of the highest solid thing at each x. */
interface Field {
  x0: number;
  x1: number;
  n: number;
  top: Float32Array;
  /** Extremes of the authored geometry (not the padded play bounds). */
  loY: number;
  hiY: number;
}

/**
 * Rasterise every surface edge into columns, keeping the maximum y. Closed
 * shapes contribute their lid, ground strips their profile; the result is the
 * skyline the camera has to frame.
 */
function buildField(hole: Hole): Field | null {
  let x0 = Infinity;
  let x1 = -Infinity;
  let loY = Infinity;
  let hiY = -Infinity;
  for (const s of hole.surfaces) {
    for (const p of s.points) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < loY) loY = p.y;
      if (p.y > hiY) hiY = p.y;
    }
  }
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 - x0 < 1e-3) return null;

  const n = Math.max(2, Math.min(2048, Math.ceil(x1 - x0) + 1));
  const top = new Float32Array(n);
  top.fill(-Infinity);
  const span = x1 - x0;
  const put = (x: number, y: number): void => {
    const i = Math.round(((x - x0) / span) * (n - 1));
    if (i >= 0 && i < n && y > top[i]) top[i] = y;
  };

  for (const s of hole.surfaces) {
    const pts = s.points;
    const m = pts.length;
    if (m < 2) continue;
    const edges = s.closed ? m : m - 1;
    for (let i = 0; i < edges; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % m];
      const steps = Math.max(1, Math.ceil(Math.abs(b.x - a.x)));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        put(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      }
    }
  }
  return { x0, x1, n, top, loY, hiY };
}

/** Highest ground between two world x, or NaN where the hole has a hole in it. */
function topOver(f: Field, a: number, b: number): number {
  const span = f.x1 - f.x0;
  const lo = Math.max(0, Math.floor(((Math.min(a, b) - f.x0) / span) * (f.n - 1)));
  const hi = Math.min(f.n - 1, Math.ceil(((Math.max(a, b) - f.x0) / span) * (f.n - 1)));
  let best = -Infinity;
  for (let i = lo; i <= hi; i++) if (f.top[i] > best) best = f.top[i];
  return Number.isFinite(best) ? best : NaN;
}

// --- HUD chrome measurement -------------------------------------------------

interface Insets {
  top: number;
  bottom: number;
}

/** Alpha of a computed `background-color`, in every syntax CSS may hand back. */
function bgAlpha(color: string): number {
  if (!color || color === "transparent" || color === "none") return 0;
  const open = color.indexOf("(");
  if (open < 0) return color.charAt(0) === "#" ? 1 : 0;
  const body = color.slice(open + 1, color.length - 1);
  const parts = body.split(/[\s,/]+/).filter((s) => s.length > 0);
  if (parts.length < 4) return 1;
  const raw = parts[3] ?? "1";
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return 1;
  return raw.indexOf("%") >= 0 ? v / 100 : v;
}

/**
 * Walk the overlay DOM and report how much opaque chrome is welded to the top
 * and bottom edges of the viewport.
 *
 * Deliberately structural rather than selector-driven: the HUD is owned by
 * another module and its class names are not an interface. Anything painted,
 * not full-screen, and touching an edge (allowing a small gap, so a panel with
 * a margin still counts) grows that edge's band. Full-screen elements are
 * containers — descend into them; painted elements are leaves — whatever they
 * contain is already hidden.
 */
function measureChrome(vw: number, vh: number): Insets | null {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return null;
  const body = document.body;
  if (!body) return null;

  const bands: Array<{ top: number; bottom: number }> = [];
  const queue: Array<{ el: Element; depth: number }> = [{ el: body, depth: 0 }];
  let budget = 420;

  while (queue.length > 0 && budget > 0) {
    const node = queue.shift();
    if (!node) break;
    const kids = node.el.children;
    for (let i = 0; i < kids.length && budget > 0; i++) {
      const el = kids[i] as HTMLElement;
      budget--;
      const tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "CANVAS" || tag === "svg") continue;
      let r: DOMRect | null = null;
      try {
        r = el.getBoundingClientRect();
      } catch {
        r = null;
      }
      // A wrapper holding nothing but fixed-position children measures zero
      // high — reject it as *chrome*, never as a branch to walk, or the whole
      // HUD disappears behind a collapsed React root.
      const solid = !!r && r.width >= 24 && r.height >= 6 && r.bottom > 0 && r.top < vh;
      if (solid && r) {
        const cs = getComputedStyle(el);
        if (cs.display === "none") continue;
        const op = parseFloat(cs.opacity);
        const shown = cs.visibility !== "hidden" && !(Number.isFinite(op) && op < 0.3);
        const painted =
          bgAlpha(cs.backgroundColor) >= 0.2 ||
          (cs.backgroundImage !== "none" && cs.backgroundImage !== "");
        const container = r.width >= vw * 0.9 && r.height >= vh * 0.7;
        if (shown && painted && !container) {
          // Painted, edge-hugging, not full-bleed: this is chrome. Whatever it
          // contains is already hidden, so stop here.
          bands.push({ top: r.top, bottom: r.bottom });
          continue;
        }
        if (!shown) continue;
      }
      if (node.depth < 9 && el.children.length > 0) queue.push({ el, depth: node.depth + 1 });
    }
  }
  if (bands.length === 0) return null;

  // Grow one contiguous band down from y=0 and one up from y=vh. A stack of
  // separate cards (scorecard, hole map, route chips) reads as one inset;
  // something floating in the middle of the playfield does not.
  const GAP = 18;
  let top = 0;
  let bottom = 0;
  for (let pass = 0; pass < 5; pass++) {
    let grew = false;
    for (const b of bands) {
      if (b.top <= top + GAP && b.bottom > top) {
        top = b.bottom;
        grew = true;
      }
      const up = vh - b.top;
      if (b.bottom >= vh - bottom - GAP && up > bottom) {
        bottom = up;
        grew = true;
      }
    }
    if (!grew) break;
  }
  return { top, bottom };
}

// --- Survey -----------------------------------------------------------------

interface Survey {
  t: number;
  from: number;
  to: number;
  /** Seconds before the pan starts, and how long it takes. */
  delay: number;
  travel: number;
  /** Auto-exit time; Infinity for a survey the player owns. */
  life: number;
  /** False until the pull-back has been applied — a survey cuts, not eases. */
  framed: boolean;
}

/** Live slingshot state, published by `aim.ts` for the whole drag. */
interface AimState {
  from: { x: number; y: number };
  dir: { x: number; y: number };
  power: number;
}

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const createCamera: SystemFactory = (ctx) => {
  let engine: GolfEngine | null = null;
  let zoom = 1;
  let tx = 0;
  let ty = 0;
  let userZoom = 1;
  /** What we last wrote to the engine, so an outside write is detectable. */
  let lastZoomOut = -1;
  /** Smoothed skyline height, so new terrain entering frame doesn't snap. */
  let groundY = NaN;
  let field: Field | null = null;
  let holeRef: Hole | null = null;
  let survey: Survey | null = null;
  /** Smoothed HUD chrome, in CSS px, and when it was last measured. */
  let insetTop = -1;
  let insetBottom = -1;
  let insetAt = 0;
  /**
   * The engine clamps `dt` to 1/20 s, so on a machine dropping frames the sim
   * clock crawls behind the wall clock. Framing is presentation, not
   * simulation: it runs on real seconds so a pan takes as long as it says it
   * does and the follow never lags a struggling frame rate.
   */
  let lastNow = 0;

  /**
   * An override target, published by the jetpack system while the player is
   * flying the golfer around. Cleared by emitting null.
   */
  let override: { x: number; y: number } | null = null;
  const offTarget = ctx.on("golf:cameraTarget", (p) => {
    override = p && typeof p === "object" ? (p as { x: number; y: number }) : null;
  });

  let aim: AimState | null = null;
  let arc: Box | null = null;
  let arcAt = 0;
  const offAim = ctx.on("golf:aim", (p) => {
    const d = p as
      | { aiming?: boolean; power?: number; from?: { x: number; y: number }; dir?: { x: number; y: number } }
      | null;
    if (!d || !d.aiming || !d.from || !d.dir) {
      aim = null;
      arc = null;
      return;
    }
    aim = { from: { x: d.from.x, y: d.from.y }, dir: { x: d.dir.x, y: d.dir.y }, power: d.power ?? 0 };
  });

  /** Frame the whole hole: pan from `from` to `to` and hold there. */
  function startSurvey(from: number, to: number, life: number): void {
    survey = { t: 0, from, to, delay: 0.15, travel: 1.1, life, framed: false };
  }

  const offSurvey = ctx.on("golf:survey", (p) => {
    if (p === null || p === false) {
      survey = null;
      return;
    }
    const hole = ctx.services.course?.current;
    if (!hole) return;
    const ball = ctx.services.physics?.balls.find((b) => b.active);
    startSurvey(ball ? ball.pos.x : hole.tee.x, hole.cup.x, Infinity);
  });

  /**
   * Integrate the candidate shot with the real launch constants and return the
   * box the preview polyline will occupy. Terminates on the skyline rather than
   * asking physics for a swept query — this runs while the player is dragging
   * and only needs to know how much room the arc wants.
   */
  function predictArc(a: AimState, gy: number, floorY: number): Box {
    const speed = 6 + clamp(a.power, 0, 1) * 46;
    let px = a.from.x;
    let py = a.from.y;
    let vx = a.dir.x * speed;
    let vy = a.dir.y * speed;
    const box: Box = { x0: px, x1: px, y0: py, y1: py };
    const step = 1 / 30;
    for (let i = 0; i < 90; i++) {
      vy += gy * step;
      const sp = Math.hypot(vx, vy);
      const air = Math.exp(-0.055 * step * Math.max(1, sp * 0.06));
      vx *= air;
      vy *= air;
      px += vx * step;
      py += vy * step;
      if (!Number.isFinite(px) || !Number.isFinite(py)) break;
      if (px < box.x0) box.x0 = px;
      if (px > box.x1) box.x1 = px;
      if (py < box.y0) box.y0 = py;
      if (py > box.y1) box.y1 = py;
      if (py < floorY) break;
      if (i > 2 && field) {
        const g = topOver(field, px - 0.5, px + 0.5);
        if (Number.isFinite(g) && py <= g) break;
      }
    }
    return box;
  }

  const sys: GolfCameraSystem = {
    name: "camera",
    attachEngine(e) {
      engine = e;
      tx = e.target.x;
      ty = e.target.y;
    },
    dispose() {
      offTarget();
      offSurvey();
      offAim();
    },
    update(simDt) {
      if (!engine) return;
      const phys = ctx.services.physics;
      const hole = ctx.services.course?.current;
      if (!phys || !hole) return;

      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const raw = lastNow > 0 ? Math.min((now - lastNow) / 1000, 1) : Math.max(simDt, 0.001);
      // Springs get a bounded step so a hitch can't fling the camera; the
      // scripted pan gets the honest one so it always runs to time.
      const dt = clamp(raw, 0.001, 0.2);
      lastNow = now;

      // --- Hole changes: resample the skyline, then show the player the flag.
      if (hole !== holeRef) {
        holeRef = hole;
        groundY = NaN;
        try {
          field = buildField(hole);
        } catch {
          field = null;
        }
        startSurvey(hole.cup.x, hole.tee.x, 2.3);
        tx = hole.cup.x;
        ty = hole.cup.y;
      }

      const ball = phys.balls.find((b) => b.active);

      // --- Survey requests -------------------------------------------------
      // Anything outside this module writing `engine.zoom` is asking to see
      // more (or less) of the hole; a bare zoom nudge would be overwritten
      // below, so honour it as an explicit overview instead.
      if (lastZoomOut >= 0 && Math.abs(engine.zoom - lastZoomOut) > 1e-6) {
        // The framing here is fitted, not fixed, so an outside writer has no
        // idea what our current zoom means — the *act* of writing is the
        // request, and the only framing we can offer on demand is the overview.
        // Only an unmistakable close-up (far tighter than we chose) is read the
        // other way, as "stop showing me the hole".
        if (engine.zoom < lastZoomOut * 1.5) {
          startSurvey(ball ? ball.pos.x : hole.tee.x, hole.cup.x, Infinity);
        } else {
          survey = null;
        }
      }
      if (ctx.input.pressed.has("KeyQ") || ctx.input.pressed.has("Tab")) {
        if (survey) survey = null;
        else startSurvey(ball ? ball.pos.x : hole.tee.x, hole.cup.x, Infinity);
      }
      // The player took a shot, or something else grabbed the camera. A ball
      // still settling onto its tee is not a shot — only real speed cuts away.
      if (survey && (override || aim || (ball && Math.hypot(ball.vel.x, ball.vel.y) > 8))) survey = null;
      if (survey) {
        survey.t += raw;
        if (survey.t > survey.life) survey = null;
      }

      userZoom = clamp(userZoom + ctx.input.zoomDelta, USER_ZOOM_MIN, USER_ZOOM_MAX);

      // --- The safe rect ---------------------------------------------------
      const vw = Math.max(1, window.innerWidth);
      const vh = Math.max(1, window.innerHeight);
      const aspect = vw / vh;

      if (insetTop < 0) {
        insetTop = vh * DEFAULT_TOP_FRAC;
        insetBottom = vh * DEFAULT_BOTTOM_FRAC;
      }
      if (now - insetAt > INSET_MS) {
        insetAt = now;
        let m: Insets | null = null;
        try {
          m = measureChrome(vw, vh);
        } catch {
          m = null;
        }
        // A measure that finds no top chrome at all is a HUD that hasn't
        // mounted yet, not a full-bleed playfield — keep the defaults.
        const wantTop = m && m.top > vh * 0.04 ? m.top : vh * DEFAULT_TOP_FRAC;
        const wantBottom = m && m.bottom > vh * 0.06 ? m.bottom : vh * DEFAULT_BOTTOM_FRAC;
        const ease = 1 - Math.exp(-((INSET_MS / 1000) * 4));
        insetTop += (clamp(wantTop, 0, vh * TOP_LIMIT) - insetTop) * ease;
        insetBottom += (clamp(wantBottom, 0, vh * BOTTOM_LIMIT) - insetBottom) * ease;
      }
      let topF = clamp(insetTop / vh, 0, TOP_LIMIT);
      let botF = clamp(insetBottom / vh, 0, BOTTOM_LIMIT);
      if (1 - topF - botF < MIN_BAND) {
        // Chrome is claiming more than the playfield can spare — shrink both
        // insets proportionally rather than let the band collapse.
        const k = (1 - MIN_BAND) / Math.max(1e-3, topF + botF);
        topF *= k;
        botF *= k;
      }
      const bandF = Math.max(MIN_BAND, 1 - topF - botF);
      const bandMidF = topF + bandF * 0.5;

      // Tall phone frames get a tight corridor, wide ones a generous one:
      // width and height are locked together by the aspect, so a 60 m corridor
      // on a 0.46 frame would mean 130 m of mostly-empty vertical.
      const wide = smoothstep((aspect - 0.55) / 0.9);
      const restW = REST_WIDTH_TALL + (REST_WIDTH_WIDE - REST_WIDTH_TALL) * wide;
      const mix = (a: number, b: number): number => a + (b - a) * wide;

      // --- Choose the subject ----------------------------------------------
      // A teed ball is never flagged `resting` — it is still micro-settling on
      // the turf — so "in play" is a speed question, not a flag question.
      const speed = ball ? Math.hypot(ball.vel.x, ball.vel.y) : 0;
      const moving = !!ball && !ball.resting && speed > 1.2;
      const flying = moving && !survey && !override;
      const aiming = !!aim && !!ball && !moving && !survey && !override;

      if (aiming && aim && (now - arcAt > 90 || !arc)) {
        arcAt = now;
        const floorY = (field ? Math.min(field.loY, hole.bounds.min.y) : hole.bounds.min.y) - SLAB_USABLE;
        try {
          arc = predictArc(aim, phys.gravity?.y ?? -22, floorY);
        } catch {
          arc = null;
        }
      }
      if (!aiming) arc = null;

      /** Subject the frame is built around, and how tall it needs the band. */
      let wantW = restW / userZoom;
      let needH = 0;
      let anchor = ANCHOR_REST;
      let focusX = ball ? ball.pos.x : hole.tee.x;
      let focusY = ball ? ball.pos.y : hole.tee.y;
      let leanX = focusX;

      if (survey) {
        // The survey exists to show the hole, so it fits the hole: end to end,
        // inside the safe rect, with margin. It only falls back to panning when
        // the terrain slab genuinely cannot back a frame that wide.
        const p = smoothstep((survey.t - survey.delay) / survey.travel);
        const panX = survey.from + (survey.to - survey.from) * p;
        const hx0 = Math.min(hole.cup.x, hole.tee.x, field ? field.x0 : hole.bounds.min.x);
        const hx1 = Math.max(hole.cup.x, hole.tee.x, field ? field.x1 : hole.bounds.max.x);
        const cap = restW * mix(SURVEY_SCALE_TALL, SURVEY_SCALE_WIDE);
        const need = (hx1 - hx0) / SIDE_FILL;
        wantW = Math.min(need, cap);
        const whole = wantW >= need - 1e-3;
        focusX = whole ? (hx0 + hx1) * 0.5 : panX;
        const g = field ? topOver(field, focusX - (whole ? (hx1 - hx0) * 0.5 : 3), focusX + (whole ? (hx1 - hx0) * 0.5 : 3)) : NaN;
        focusY = Number.isFinite(g) ? g : (hole.tee.y + hole.cup.y) * 0.5;
        needH = Math.abs(hole.cup.y - hole.tee.y) + 4;
        leanX = focusX;
        anchor = mix(ANCHOR_SURVEY_TALL, ANCHOR_SURVEY_WIDE);
      } else if (override) {
        // Someone else owns the framing (the jetpack, a cutscene).
        focusX = override.x;
        focusY = override.y;
        leanX = override.x;
        anchor = 0.5;
      } else if (aiming && arc && ball) {
        // The whole predicted shot has to live inside the safe rect: fit the
        // arc box, centre it in the band, and let the ball fall where it may.
        const bx0 = Math.min(arc.x0, ball.pos.x);
        const bx1 = Math.max(arc.x1, ball.pos.x);
        const by0 = Math.min(arc.y0, ball.pos.y);
        const by1 = Math.max(arc.y1, ball.pos.y);
        wantW = Math.max(restW * 0.75, (bx1 - bx0 + 4) / SIDE_FILL) / userZoom;
        needH = by1 - by0 + 3;
        focusX = (bx0 + bx1) * 0.5;
        focusY = (by0 + by1) * 0.5;
        leanX = focusX;
        anchor = 0.5;
      } else if (flying && ball) {
        // Lead the ball so you can see where it's going, not where it was.
        wantW = (restW * (1 + Math.min(FLIGHT_WIDEN, speed / 100))) / userZoom;
        focusX = ball.pos.x;
        focusY = ball.pos.y;
        leanX = ball.pos.x + ball.vel.x * 0.32;
        anchor = ANCHOR_FLIGHT;
      } else if (ball) {
        // At address: fit the ball→pin corridor instead of a fixed zoom, so on
        // any frame that can hold the hole the flag is on screen.
        const span = Math.abs(hole.cup.x - ball.pos.x);
        const need = (span + 9) / SIDE_FILL;
        const cap = restW * mix(ADDRESS_SCALE_TALL, ADDRESS_SCALE_WIDE);
        const fits = need <= cap;
        // Widening only pays for itself if it actually buys the flag. When the
        // pin is beyond any sane zoom, spend the pixels on a readable corridor
        // and let the HUD's edge pointer carry the distance instead.
        wantW = clamp(fits ? Math.max(restW, need) : restW * mix(CRUISE_SCALE_TALL, CRUISE_SCALE_WIDE), 4, 4000) / userZoom;
        focusX = ball.pos.x;
        focusY = ball.pos.y;
        if (fits) {
          needH = Math.abs(hole.cup.y - ball.pos.y) + 3;
          leanX = (ball.pos.x + hole.cup.x) * 0.5;
        } else {
          // Hole is longer than one screen: spend the frame on the half being
          // played into rather than centring the ball in it.
          leanX = ball.pos.x + Math.sign(hole.cup.x - ball.pos.x) * wantW * FORWARD_BIAS;
        }
      } else {
        focusX = hole.cup.x;
        focusY = hole.cup.y;
        leanX = hole.cup.x;
      }

      // --- Corridor → zoom, then cap it against the world we actually have --
      const anchorF = topF + bandF * (1 - anchor);
      let wantH = Math.max(wantW / Math.max(0.05, aspect), needH / Math.max(0.08, bandF * BAND_FILL));
      const skylineNow = Number.isFinite(groundY) ? groundY : focusY;
      const floorY = (field ? Math.min(field.loY, hole.bounds.min.y) : hole.bounds.min.y) - SLAB_USABLE;
      // Everything under the subject line has to be solid terrain, or the hole
      // becomes a ribbon floating in backdrop. That, not the hole length, is
      // what limits how far we may pull back.
      const under = Math.max(8, skylineNow - floorY);
      wantH = Math.min(wantH, under / Math.max(0.2, 1 - anchorF + 0.02));
      const wantZoom = clamp(BASE_VIEW_HEIGHT / Math.max(4, wantH), 0.04, 6);

      if (survey && !survey.framed) {
        // Take the whole framing on the first frame: easing a pull-back that a
        // slow device might only get two frames of just loses the overview.
        survey.framed = true;
        zoom = wantZoom;
      } else {
        zoom += (wantZoom - zoom) * (1 - Math.exp(-dt * (survey ? 4.6 : aiming ? 5.5 : 3.4)));
      }
      if (!Number.isFinite(zoom) || zoom <= 0) zoom = wantZoom;

      const halfH = BASE_VIEW_HEIGHT / 2 / zoom;
      const halfW = halfH * aspect;
      const viewH = halfH * 2;
      const viewW = halfW * 2;

      // --- Follow ------------------------------------------------------------
      const wantX = leanX;
      const wantY = focusY;
      const k = 1 - Math.exp(-dt * (survey ? 6 : aiming ? 8 : 5.2));
      tx += (wantX - tx) * k;
      ty += (wantY - ty) * k;
      // The subject leads the spring but never leaves with it.
      tx = clamp(tx, focusX - viewW * 0.3, focusX + viewW * 0.3);

      // --- Horizontal: clamp to the geometry, not the padded bounds ---------
      const gx0 = field ? field.x0 : hole.bounds.min.x;
      const gx1 = field ? field.x1 : hole.bounds.max.x;
      let cx: number;
      if (viewW >= gx1 - gx0) {
        // The view is wider than the hole — centre it rather than let a
        // crossed clamp pin the camera to one edge and reveal the void.
        cx = (gx0 + gx1) * 0.5;
      } else {
        cx = clamp(tx, gx0 + halfW, gx1 - halfW);
      }

      // --- Vertical: everything measured against the safe rect --------------
      const sample = field ? topOver(field, cx - halfW, cx + halfW) : NaN;
      const target = Number.isFinite(sample) ? sample : ty;
      if (!Number.isFinite(groundY)) groundY = target;
      groundY += (target - groundY) * (1 - Math.exp(-dt * 3));

      /** Camera y that lands `worldY` at screen fraction `f` (0 = top). */
      const centreFor = (worldY: number, f: number): number => worldY + (f - 0.5) * viewH;

      let cy = centreFor(ty, anchorF);
      // Keep the skyline high in the frame: sky is capped hard, but we also
      // never bury it above the top edge and stare at a wall of slab. A survey
      // is the one frame allowed real sky — it is showing you a whole hole, and
      // squeezing that into the bottom third is the point of the cap, not a
      // violation of it.
      cy = Math.min(cy, centreFor(groundY, survey ? 0.74 : SKY_MAX));
      cy = Math.max(cy, centreFor(groundY, SKY_MIN));
      // Don't drop below the modelled terrain slab.
      cy = Math.max(cy, floorY + halfH);
      // …but the subject beats the scenery: it stays inside the play band.
      cy = Math.min(cy, centreFor(focusY, topF + bandF * (1 - BAND_KEEP_LOW)));
      cy = Math.max(cy, centreFor(focusY, topF + bandF * (1 - BAND_KEEP_HIGH)));

      if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;

      engine.zoom = zoom;
      lastZoomOut = zoom;
      engine.target.set(cx, cy);
    },
  };
  return sys;
};

export default createCamera;
