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
 * Vertical framing is driven by the hole's own silhouette, not a constant. A
 * 1 m heightfield is sampled from the surfaces once per hole; every frame the
 * camera reads the highest ground across the visible span and places the
 * horizon so the play surface keeps ~45 % of the frame and the sky is capped
 * at ~2/3 — sky is the cheapest thing on screen and is the first thing
 * sacrificed. The frame bottom is held above the world floor so we never stare
 * through the underside of the terrain.
 *
 * Horizontal clamping uses the *geometry* span (the extreme surface points),
 * not `hole.bounds`, which is padded 6 m past the last polygon — clamping to
 * the padded bounds is what used to park a column of empty world at the screen
 * edge. Both axes handle the degenerate "view is bigger than the hole" case by
 * centring instead of falling through a crossed clamp.
 *
 * Finally there's a survey mode: a scripted pan that frames the hole end to
 * end and holds on the flag, so the player has actually seen the target before
 * being asked to plan a climb to it. It runs once when a hole loads, on
 * `golf:survey`, on Q/Tab, and whenever something outside this module pushes
 * `engine.zoom` down (a debug tool, a capture harness) — a request to see more
 * of the hole is answered with a real overview instead of a nudge that the
 * follow logic silently undoes on the next frame.
 */
import type { Hole, System, SystemFactory } from "../types";
import type { GolfEngine } from "./core";
import { BASE_VIEW_HEIGHT } from "./core";

export interface GolfCameraSystem extends System {
  attachEngine(e: GolfEngine): void;
}

// --- Framing tuning ---------------------------------------------------------

/** Shot corridor visible at rest, in metres: portrait → landscape. */
const REST_WIDTH_TALL = 28;
const REST_WIDTH_WIDE = 60;
/** How much wider the corridor gets at full flight speed. */
const FLIGHT_WIDEN = 0.55;
/** Manual pinch range, as a multiplier on the corridor width. */
const USER_ZOOM_MIN = 0.5;
const USER_ZOOM_MAX = 2.2;
/** Where the ball sits, measured up from the bottom of the frame. */
const ANCHOR_REST = 0.42;
const ANCHOR_FLIGHT = 0.46;
/** The ground silhouette never gets less than this share of the frame… */
const GROUND_MIN = 0.34;
/** …and the anchor is never pushed outside this band. */
const ANCHOR_LOW = 0.11;
const ANCHOR_HIGH = 0.86;
/** Metres of solid world under `bounds.min` we may reveal before it reads bad. */
const FLOOR_SLACK = 18;
/** Survey width as a multiple of the rest corridor (portrait / landscape). */
const SURVEY_SCALE_TALL = 1.35;
const SURVEY_SCALE_WIDE = 2.6;

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
        if (engine.zoom < lastZoomOut * 0.95) {
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
      if (survey && (override || (ball && Math.hypot(ball.vel.x, ball.vel.y) > 8))) survey = null;
      if (survey) {
        survey.t += raw;
        if (survey.t > survey.life) survey = null;
      }

      userZoom = clamp(userZoom + ctx.input.zoomDelta, USER_ZOOM_MIN, USER_ZOOM_MAX);

      // --- Corridor → zoom -------------------------------------------------
      const vw = Math.max(1, window.innerWidth);
      const vh = Math.max(1, window.innerHeight);
      const aspect = vw / vh;
      // Tall phone frames get a tight corridor, wide ones a generous one:
      // width and height are locked together by the aspect, so a 60 m corridor
      // on a 0.46 frame would mean 130 m of mostly-empty vertical.
      const wide = smoothstep((aspect - 0.55) / 0.9);
      const restW = REST_WIDTH_TALL + (REST_WIDTH_WIDE - REST_WIDTH_TALL) * wide;

      const speed = ball && !ball.resting ? Math.hypot(ball.vel.x, ball.vel.y) : 0;
      let wantW = (restW * (1 + Math.min(FLIGHT_WIDEN, speed / 100))) / userZoom;
      if (survey) {
        const fitW =
          (Math.max(hole.cup.x, hole.tee.x, field ? field.x1 : hole.bounds.max.x) -
            Math.min(hole.cup.x, hole.tee.x, field ? field.x0 : hole.bounds.min.x)) *
          1.1;
        const cap = restW * (SURVEY_SCALE_TALL + (SURVEY_SCALE_WIDE - SURVEY_SCALE_TALL) * wide);
        wantW = Math.min(fitW, cap);
      }
      const wantZoom = clamp((BASE_VIEW_HEIGHT * aspect) / Math.max(4, wantW), 0.04, 6);

      if (survey && !survey.framed) {
        // Take the whole framing on the first frame: easing a pull-back that a
        // slow device might only get two frames of just loses the overview.
        survey.framed = true;
        zoom = wantZoom;
      } else {
        zoom += (wantZoom - zoom) * (1 - Math.exp(-dt * (survey ? 4.6 : 3.4)));
      }
      if (!Number.isFinite(zoom) || zoom <= 0) zoom = wantZoom;

      const halfH = BASE_VIEW_HEIGHT / 2 / zoom;
      const halfW = halfH * aspect;
      const viewH = halfH * 2;
      const viewW = halfW * 2;

      // --- Where we want to be ---------------------------------------------
      let wantX: number;
      let wantY: number;
      let anchorFrac = ANCHOR_REST;

      if (survey) {
        const p = smoothstep((survey.t - survey.delay) / survey.travel);
        wantX = survey.from + (survey.to - survey.from) * p;
        const g = field ? topOver(field, wantX - 3, wantX + 3) : NaN;
        wantY = Number.isFinite(g) ? g : (hole.tee.y + hole.cup.y) * 0.5;
        anchorFrac = 0.38;
        // A survey is a cut, not a chase: don't drag the follow spring along.
        const sk = 1 - Math.exp(-dt * 6);
        tx += (wantX - tx) * sk;
        ty += (wantY - ty) * sk;
      } else if (override) {
        // Someone else owns the framing (the jetpack, a cutscene).
        wantX = override.x;
        wantY = override.y;
        anchorFrac = 0.5;
      } else if (ball && !ball.resting) {
        // Lead the ball so you can see where it's going, not where it was.
        wantX = ball.pos.x + clamp(ball.vel.x * 0.32, -viewW * 0.22, viewW * 0.22);
        wantY = ball.pos.y + clamp(ball.vel.y * 0.18, -viewH * 0.12, viewH * 0.12);
        anchorFrac = ANCHOR_FLIGHT;
      } else if (ball) {
        // At rest: lean toward the cup, but only as far as the frame allows —
        // a raw blend with a cup 80 m away shoves the ball off the screen.
        wantX = ball.pos.x + clamp(hole.cup.x - ball.pos.x, -viewW * 0.2, viewW * 0.2);
        wantY = ball.pos.y;
      } else {
        wantX = hole.cup.x;
        wantY = hole.cup.y;
      }

      if (!survey) {
        // Critically-damped-ish follow: fast enough to keep up, smooth enough
        // not to jitter on bounces.
        const k = 1 - Math.exp(-dt * 5.2);
        tx += (wantX - tx) * k;
        ty += (wantY - ty) * k;
      }

      // --- Horizontal: clamp to the geometry, not the padded bounds --------
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

      // --- Vertical: framed off the ground silhouette ----------------------
      const sample = field ? topOver(field, cx - halfW, cx + halfW) : NaN;
      const target = Number.isFinite(sample) ? sample : ty;
      if (!Number.isFinite(groundY)) groundY = target;
      groundY += (target - groundY) * (1 - Math.exp(-dt * 3));

      let cy = ty + (0.5 - anchorFrac) * viewH;
      // Cap the sky: the skyline keeps at least GROUND_MIN of the frame.
      cy = Math.min(cy, groundY + (0.5 - GROUND_MIN) * viewH);
      // Don't drop below the world — under the terrain there is nothing to see.
      const floorY = Math.min(hole.bounds.min.y, field ? field.loY : hole.bounds.min.y) - FLOOR_SLACK;
      cy = Math.max(cy, floorY + halfH);
      // …but the ball beats the scenery in both directions.
      cy = Math.min(cy, ty + (0.5 - ANCHOR_LOW) * viewH);
      cy = Math.max(cy, ty - (ANCHOR_HIGH - 0.5) * viewH);

      if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;

      engine.zoom = zoom;
      lastZoomOut = zoom;
      engine.target.set(cx, cy);
    },
  };
  return sys;
};

export default createCamera;
