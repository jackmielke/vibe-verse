/**
 * ORBIT — hold to climb out of the well, let go to fall back in.
 *
 * One button, one planet, and a chain of gates coming round the curve. It is
 * the game the vibeverse bets on, and every decision in here follows from that
 * one fact.
 *
 * ## Why it is built the way it is
 *
 * **Everyone in a round gets the same sky.** The gate field comes out of a
 * seeded generator, so ten people staking into the same round are attempting
 * the identical run. A wager on a game where the obstacles differ is not a
 * wager, it is a raffle.
 *
 * **Fixed timestep, always.** The simulation advances in 1/120 s steps no
 * matter what the display is doing. Variable-dt physics quietly hands the
 * advantage to whoever has the better monitor — at 144 Hz you get finer control
 * over the same thrust than someone on a 60 Hz laptop, and nobody can see why
 * they lost. Render as often as you like; the world only ever moves in whole
 * ticks.
 *
 * **Constant gravity.** Real orbital mechanics would be prettier and it would
 * be a worse game to bet on: inverse-square gravity means a small mistake high
 * up is unrecoverable and a small mistake low down barely registers, so the
 * skill you are measuring changes depending on where you are. Constant pull is
 * legible — you learn it in one run, and after that every death is yours.
 *
 * ## The frame
 *
 * Everything lives in polar coordinates around the planet, and the whole world
 * is drawn rotated so the probe sits at a fixed point on the right. That is the
 * trick that makes it readable: you are not tracking a dot around a circle, you
 * are watching gates sweep toward you while you move up and down. The planet
 * turning underneath is what sells the motion.
 */

/** Fixed simulation step. See the header — this is a fairness property. */
const STEP = 1 / 120;
/** Never simulate more than this much wall time in one frame (tab-switch guard). */
const MAX_CATCHUP = 0.25;

/** The band you fly in, in world units. Screen scale is derived from these. */
const R_SURFACE = 96;   // atmosphere — touch it and you burn up
const R_ESCAPE = 330;   // past this you are gone
const R_START = 190;

const GRAVITY = 300;    // inward acceleration, units/s²
const THRUST = 660;     // outward acceleration while held
const V_TERMINAL = 260; // clamp so a long fall stays recoverable

/** Where the probe sits on screen, in radians. 0 = due east of the planet. */
const PROBE_ANGLE = 0;

export interface OrbitRun {
  /** Advance by real elapsed time, then draw. */
  frame(ctx: CanvasRenderingContext2D, dt: number): void;
  /** The one input. */
  setThrust(on: boolean): void;
  readonly score: number;
  /**
   * Simulated time actually *flown*, in ms — which is not wall-clock since
   * launch, because the run sits armed until the first press. The server floors
   * an accepted score at what this much time allows, so counting the idle wait
   * would hand a player free headroom for nothing.
   */
  readonly elapsedMs: number;
  /** Non-null exactly once the run is over. */
  readonly done: { score: number; detail: string } | null;
  /** Sound hook: a gate cleared, a near miss, or the end. */
  cue?: (c: "gate" | "near" | "crash" | "milestone") => void;
}

// ---------------------------------------------------------------------------

function rng(seed: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Gate {
  /** Absolute angle the gate stands at. */
  theta: number;
  /** Centre of the gap, in world radius. */
  r: number;
  /** Half-height of the gap. */
  half: number;
  passed: boolean;
  /** 0..1 flash when cleared. */
  flash: number;
}

interface Star {
  x: number;
  y: number;
  size: number;
  /** Parallax depth: 0 far, 1 near. */
  depth: number;
  twinkle: number;
}

interface Spark {
  r: number;
  theta: number;
  vr: number;
  vt: number;
  life: number;
  hue: string;
}

export function createOrbit(w: number, h: number, seed: string): OrbitRun {
  const rand = rng(seed);
  const cx = w / 2;
  const cy = h / 2;
  /** World units → pixels. The escape ring should sit just off-frame. */
  const scale = (Math.min(w, h) / 2) / (R_ESCAPE * 0.92);

  // ---- world state -------------------------------------------------------
  let r = R_START;
  let vr = 0;
  let theta = 0;
  let thrusting = false;
  let score = 0;
  let alive = true;
  /**
   * Nothing moves until the first press.
   *
   * Without this the probe starts at rest at R_START and hits the atmosphere in
   * about eight tenths of a second — a first-time player is dead before they
   * have finished reading "hold to climb", and a returning one loses runs to
   * how long the tab took to paint. Arming also makes the fairness claim
   * honest: with a fixed timestep AND a fixed starting instant, two people on
   * different machines fly the identical sky, which is the whole premise of
   * betting on it.
   */
  let armed = true;
  let done: { score: number; detail: string } | null = null;
  let elapsed = 0;
  let acc = 0;
  /** Rises with score. The whole difficulty curve is this one number. */
  let omega = 0.62;

  const trail: Array<{ r: number; theta: number }> = [];
  const sparks: Spark[] = [];
  const gates: Gate[] = [];
  let nextGateTheta = 1.1;

  /* Gates are generated ahead of the probe and retired behind it, so a long
     run does not accumulate an unbounded array — and the generator is only
     ever advanced in order, which is what keeps the seed meaningful. */
  function spawnGatesUpTo(untilTheta: number) {
    while (nextGateTheta < untilTheta) {
      const t = Math.min(1, gates.length / 26);
      // Gaps narrow and wander further as you go. Both eased so the first
      // half-dozen gates are a tutorial you did not notice you were given.
      const half = 46 - 20 * t;
      const span = R_ESCAPE - R_SURFACE - half * 2 - 26;
      const centre = R_SURFACE + half + 13 + rand() * span;
      gates.push({ theta: nextGateTheta, r: centre, half, passed: false, flash: 0 });
      nextGateTheta += 0.86 - 0.3 * t + rand() * 0.16;
    }
  }
  spawnGatesUpTo(nextGateTheta + 8);

  // ---- starfield ---------------------------------------------------------
  const stars: Star[] = [];
  for (let i = 0; i < 190; i++) {
    stars.push({
      x: rand() * w,
      y: rand() * h,
      size: 0.4 + rand() * 1.7,
      depth: rand(),
      twinkle: rand() * Math.PI * 2,
    });
  }

  // ---- simulation --------------------------------------------------------
  function tick(dt: number) {
    if (!alive || armed) return;
    elapsed += dt;

    vr += (thrusting ? THRUST - GRAVITY : -GRAVITY) * dt;
    vr = Math.max(-V_TERMINAL, Math.min(V_TERMINAL, vr));
    r += vr * dt;

    const prevTheta = theta;
    theta += omega * dt;
    spawnGatesUpTo(theta + 9);

    if (r <= R_SURFACE) {
      alive = false;
      done = { score, detail: burnedDetail(score) };
      burst(R_SURFACE + 6, theta, "#ff9a6b", 26);
      run.cue?.("crash");
      return;
    }
    if (r >= R_ESCAPE) {
      alive = false;
      done = { score, detail: `Slipped the well at ${score} gate${score === 1 ? "" : "s"}. Nobody is coming.` };
      burst(R_ESCAPE - 6, theta, "#8fb4ff", 22);
      run.cue?.("crash");
      return;
    }

    for (const g of gates) {
      if (g.passed) continue;
      // Crossed this gate's plane during the step.
      if (prevTheta < g.theta && theta >= g.theta) {
        const miss = Math.abs(r - g.r);
        if (miss > g.half) {
          alive = false;
          done = { score, detail: `Clipped the ${ordinal(score + 1)} gate. ${score} cleared.` };
          burst(r, theta, "#ff7d9c", 24);
          run.cue?.("crash");
          return;
        }
        g.passed = true;
        g.flash = 1;
        score += 1;
        // Threading it dead centre is worth acknowledging even though it is
        // worth no points — the feedback is what teaches the line.
        const clean = miss < g.half * 0.28;
        burst(g.r, g.theta, clean ? "#7dffd4" : "#a8e6ff", clean ? 16 : 8);
        run.cue?.(score % 10 === 0 ? "milestone" : clean ? "near" : "gate");
        omega = Math.min(1.7, 0.62 + score * 0.028);
      }
    }

    // Retire gates well behind the probe.
    while (gates.length && gates[0].theta < theta - 1.2) gates.shift();

    trail.push({ r, theta });
    if (trail.length > 34) trail.shift();

    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.r += s.vr * dt;
      s.theta += s.vt * dt;
      s.vr *= 0.97;
      s.life -= dt;
      if (s.life <= 0) sparks.splice(i, 1);
    }
  }

  function burst(atR: number, atTheta: number, hue: string, n: number) {
    for (let i = 0; i < n; i++) {
      sparks.push({
        r: atR,
        theta: atTheta,
        vr: (rand() - 0.5) * 220,
        vt: (rand() - 0.5) * 1.9,
        life: 0.4 + rand() * 0.5,
        hue,
      });
    }
  }

  // ---- drawing -----------------------------------------------------------

  /** World polar → screen, with the whole field rotated so the probe is fixed. */
  function project(wr: number, wtheta: number): [number, number] {
    const a = wtheta - theta + PROBE_ANGLE;
    return [cx + Math.cos(a) * wr * scale, cy + Math.sin(a) * wr * scale];
  }

  function draw(ctx: CanvasRenderingContext2D) {
    // ---- sky -------------------------------------------------------------
    const sky = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.75);
    sky.addColorStop(0, "#0a1430");
    sky.addColorStop(0.45, "#070d1e");
    sky.addColorStop(1, "#03050c");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // A nebula, off-centre, so the frame is not perfectly symmetrical.
    const neb = ctx.createRadialGradient(w * 0.78, h * 0.22, 0, w * 0.78, h * 0.22, Math.min(w, h) * 0.7);
    neb.addColorStop(0, "rgba(120, 80, 220, 0.16)");
    neb.addColorStop(0.5, "rgba(60, 90, 200, 0.06)");
    neb.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = neb;
    ctx.fillRect(0, 0, w, h);

    // Stars drift with the rotation, the far ones barely at all.
    for (const s of stars) {
      const drift = (theta * s.depth * 26) % (w + 40);
      const x = (s.x - drift + w + 40) % (w + 40);
      const a = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(elapsed * 1.6 + s.twinkle));
      ctx.globalAlpha = a * (0.35 + s.depth * 0.65);
      ctx.fillStyle = s.depth > 0.75 ? "#dce9ff" : "#9fb6dd";
      ctx.fillRect(x, s.y, s.size, s.size);
    }
    ctx.globalAlpha = 1;

    // ---- the planet ------------------------------------------------------
    const rs = R_SURFACE * scale;

    // Atmosphere halo, outside the surface.
    const halo = ctx.createRadialGradient(cx, cy, rs * 0.9, cx, cy, rs * 1.5);
    halo.addColorStop(0, "rgba(90, 200, 255, 0.34)");
    halo.addColorStop(0.4, "rgba(70, 150, 255, 0.12)");
    halo.addColorStop(1, "rgba(60, 120, 255, 0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, rs * 1.5, 0, Math.PI * 2);
    ctx.fill();

    // Body, lit from the upper left.
    const body = ctx.createRadialGradient(
      cx - rs * 0.4, cy - rs * 0.45, rs * 0.1,
      cx, cy, rs,
    );
    body.addColorStop(0, "#2a6f8f");
    body.addColorStop(0.45, "#17415c");
    body.addColorStop(1, "#08182a");
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, rs, 0, Math.PI * 2);
    ctx.fill();

    // Surface bands, rotating with the world — this is what makes the planet
    // read as spinning rather than as a painted disc.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, rs, 0, Math.PI * 2);
    ctx.clip();
    for (let i = 0; i < 7; i++) {
      const bandA = -theta * (0.5 + i * 0.06) + i * 1.7;
      ctx.globalAlpha = 0.08 + (i % 3) * 0.03;
      ctx.fillStyle = i % 2 ? "#7fd8ff" : "#0a2438";
      ctx.beginPath();
      ctx.ellipse(
        cx + Math.cos(bandA) * rs * 0.35,
        cy - rs * 0.6 + i * rs * 0.22,
        rs * 1.1, rs * 0.09, 0, 0, Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // Terminator: the night side, so the light has a direction.
    const term = ctx.createLinearGradient(cx - rs, cy - rs, cx + rs, cy + rs);
    term.addColorStop(0, "rgba(0,0,0,0)");
    term.addColorStop(0.55, "rgba(0,0,0,0.25)");
    term.addColorStop(1, "rgba(0,0,0,0.66)");
    ctx.fillStyle = term;
    ctx.beginPath();
    ctx.arc(cx, cy, rs, 0, Math.PI * 2);
    ctx.fill();

    // The line you must not touch.
    ctx.strokeStyle = "rgba(120, 220, 255, 0.5)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, cy, rs, 0, Math.PI * 2);
    ctx.stroke();

    // ---- escape boundary -------------------------------------------------
    ctx.save();
    ctx.setLineDash([5, 9]);
    ctx.strokeStyle = "rgba(150, 175, 255, 0.22)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, R_ESCAPE * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // ---- gates -----------------------------------------------------------
    for (const g of gates) {
      const a = g.theta - theta + PROBE_ANGLE;
      // Fade in as they come round, so nothing pops into existence.
      const ahead = g.theta - theta;
      const alpha = ahead > 4 ? 0 : ahead > 2.6 ? (4 - ahead) / 1.4 : 1;
      if (alpha <= 0) continue;

      /* Hazard and target are deliberately different hues, not two weights of
         the same blue. The first version drew both in the UI's cyan and the
         whole spoke read as one unbroken line — you had to work out which part
         would kill you, at speed, with a stake on it. Coral is the wall, mint
         is the way through, and that reads before you have finished looking. */
      const wall = g.passed ? "rgba(125,255,212," : "rgba(255,138,116,";
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.lineCap = "round";

      const drawWall = (r0: number, r1: number) => {
        const [x0, y0] = project(r0, g.theta);
        const [x1, y1] = project(r1, g.theta);
        ctx.strokeStyle = `${wall}0.26)`;
        ctx.lineWidth = 10;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.strokeStyle = `${wall}0.92)`;
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      };
      drawWall(R_SURFACE + 2, g.r - g.half);
      drawWall(g.r + g.half, R_ESCAPE - 2);

      // The aperture: brightest in the middle, so the eye is pulled to the line
      // you want to fly rather than to the edges you want to miss.
      const [gx0, gy0] = project(g.r - g.half + 2, g.theta);
      const [gx1, gy1] = project(g.r + g.half - 2, g.theta);
      const grad = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
      grad.addColorStop(0, "rgba(125,255,212,0.05)");
      grad.addColorStop(0.5, "rgba(125,255,212,0.5)");
      grad.addColorStop(1, "rgba(125,255,212,0.05)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(gx0, gy0);
      ctx.lineTo(gx1, gy1);
      ctx.stroke();

      // Two posts marking where the gap actually begins and ends. Without them
      // a narrow late-game gate is a guess.
      ctx.fillStyle = "rgba(125,255,212,0.9)";
      for (const [px, py] of [
        project(g.r - g.half, g.theta),
        project(g.r + g.half, g.theta),
      ]) {
        ctx.beginPath();
        ctx.arc(px, py, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }

      if (g.flash > 0) {
        ctx.globalAlpha = g.flash * alpha;
        ctx.strokeStyle = "#7dffd4";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(cx, cy, g.r * scale, a - 0.14, a + 0.14);
        ctx.stroke();
        g.flash = Math.max(0, g.flash - 0.045);
      }
      ctx.restore();
    }

    // ---- trail -----------------------------------------------------------
    ctx.lineCap = "round";
    for (let i = 1; i < trail.length; i++) {
      const [x0, y0] = project(trail[i - 1].r, trail[i - 1].theta);
      const [x1, y1] = project(trail[i].r, trail[i].theta);
      const t = i / trail.length;
      ctx.strokeStyle = `rgba(125, 255, 212, ${t * 0.5})`;
      ctx.lineWidth = t * 3.4;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    // ---- sparks ----------------------------------------------------------
    for (const s of sparks) {
      const [x, y] = project(s.r, s.theta);
      ctx.globalAlpha = Math.max(0, Math.min(1, s.life * 1.6));
      ctx.fillStyle = s.hue;
      ctx.fillRect(x - 1.4, y - 1.4, 2.8, 2.8);
    }
    ctx.globalAlpha = 1;

    // ---- the probe -------------------------------------------------------
    if (alive) {
      const [px, py] = project(r, theta);

      if (thrusting) {
        // Plume, pointing back down the well.
        const [ix, iy] = project(r - 26, theta);
        const pl = ctx.createLinearGradient(px, py, ix, iy);
        pl.addColorStop(0, "rgba(255, 224, 150, 0.9)");
        pl.addColorStop(0.5, "rgba(255, 150, 90, 0.5)");
        pl.addColorStop(1, "rgba(255, 90, 60, 0)");
        ctx.strokeStyle = pl;
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(ix, iy);
        ctx.stroke();
      }

      /* The probe is the one thing on screen that must never be hunted for. It
         sits at a fixed angle while the world turns under it, which makes it
         easy to lose against a busy field — so it gets a halo, a hard white
         core, and a ring, in that order. */
      const halo = ctx.createRadialGradient(px, py, 0, px, py, 26);
      halo.addColorStop(0, "rgba(125,255,212,0.42)");
      halo.addColorStop(1, "rgba(125,255,212,0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(px, py, 26, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.shadowColor = "#7dffd4";
      ctx.shadowBlur = 20;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(px, py, 5.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = "rgba(125,255,212,0.95)";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(px, py, 10, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ---- score -----------------------------------------------------------
    // Only while flying. The results card sits over this canvas on a
    // translucent backdrop, so drawing the counter under it stacks two numbers
    // on top of each other and reads as a rendering fault.
    if (alive) {
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "800 46px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "rgba(234, 255, 248, 0.92)";
      ctx.shadowColor = "rgba(10, 24, 40, 0.9)";
      ctx.shadowBlur = 12;
      ctx.fillText(String(score), cx, cy - 4);
      ctx.font = "700 10px ui-monospace, monospace";
      ctx.fillStyle = "rgba(168, 230, 255, 0.6)";
      ctx.fillText("GATES", cx, cy + 24);
      ctx.restore();
    }

    if (armed) {
      // Held frame. The world is drawn and still, waiting to be started.
      ctx.save();
      ctx.textAlign = "center";
      ctx.globalAlpha = 0.65 + 0.35 * Math.sin(Date.now() / 380);
      ctx.font = "800 15px ui-monospace, monospace";
      ctx.fillStyle = "rgba(125,255,212,0.95)";
      ctx.fillText("HOLD TO LAUNCH", cx, h - 30);
      ctx.restore();
    } else if (score === 0 && alive && elapsed < 4.5) {
      ctx.save();
      ctx.textAlign = "center";
      ctx.globalAlpha = Math.max(0, 1 - elapsed / 4.5);
      ctx.font = "700 13px ui-monospace, monospace";
      ctx.fillStyle = "rgba(234,255,248,0.75)";
      ctx.fillText("HOLD TO CLIMB · RELEASE TO FALL", cx, h - 26);
      ctx.restore();
    }
  }

  const run: OrbitRun = {
    get score() {
      return score;
    },
    get elapsedMs() {
      return elapsed * 1000;
    },
    get done() {
      return done;
    },
    setThrust(on: boolean) {
      // The press that launches also thrusts — releasing it immediately is a
      // legitimate opening move, not a mis-click to be swallowed.
      if (on) armed = false;
      thrusting = on;
    },
    frame(ctx, dt) {
      acc += Math.min(MAX_CATCHUP, Math.max(0, dt));
      while (acc >= STEP) {
        tick(STEP);
        acc -= STEP;
      }
      draw(ctx);
    },
  };
  return run;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function burnedDetail(score: number): string {
  if (score === 0) return "Straight into the atmosphere. It happens.";
  if (score < 5) return `Burned up after ${score} gate${score === 1 ? "" : "s"}.`;
  if (score < 15) return `${score} gates, then the atmosphere got you.`;
  return `${score} gates. That is a real run.`;
}
