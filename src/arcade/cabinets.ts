/**
 * The cabinets on the arcade floor.
 *
 * Every game in here is a 2D canvas and nothing else — no Three, no physics
 * engine, no assets. That is a deliberate constraint rather than a limitation:
 * the arcade is the first place a visitor spends real balance, and a cabinet
 * that takes six seconds to boot is a cabinet people abandon between paying and
 * playing. All three start on the frame after you press the button.
 *
 * ## The rule every cabinet follows
 *
 * A run reports a **score**, never an amount. `payout()` here is a *copy* of
 * the curve in the `vibe-economy` edge function, kept so the paytable on the
 * cabinet can be drawn from the same numbers the server will actually pay. The
 * server's copy is the authority and it clamps `score` to `maxScore` before it
 * applies the curve — which is why a modified client can lie about its score
 * and still not mint more than a perfect run is worth.
 *
 * If you change a curve here, change it there. `src/test/arcade.test.ts` checks
 * the two agree on every cabinet at every score, so the mistake fails a test
 * rather than a payroll.
 *
 * ## Adding a cabinet
 *
 * Add a `Cabinet` to `CABINETS`, mirror the spec into `ARCADE_SPECS` in
 * `supabase/functions/vibe-economy/index.ts`, and write a `create()` that
 * returns a `CabinetRun`. The floor, the paytable and the ledger labels are all
 * views of this list — there is no second list to update.
 */

export interface CabinetRun {
  /** Advance and draw one frame. `dt` is seconds, already clamped by the page. */
  frame(ctx: CanvasRenderingContext2D, dt: number): void;
  /**
   * The one input. A tap or click arrives with canvas coordinates; a key
   * arrives as a slot index (space is slot 0), so a cabinet with four pads can
   * be played on a keyboard and a cabinet with one button can ignore the
   * difference entirely.
   */
  press(p: { x: number; y: number } | { slot: number }): void;
  /** Non-null exactly once the run is over. The page settles on the transition. */
  done: { score: number; detail: string } | null;
  /** Optional cue for the page to play a sound: "good" | "bad" | "tick". */
  cue?: (c: "good" | "bad" | "tick" | "over") => void;
}

export interface Cabinet {
  /** Stable id. The server knows these strings; renaming one breaks payouts. */
  key: string;
  name: string;
  tagline: string;
  /** What you actually do, in one sentence, on the cabinet front. */
  howTo: string;
  /** The control line, printed under the screen like a real cabinet. */
  control: string;
  emoji: string;
  accent: string;
  /** Coins in. Debited before a single frame runs. */
  cost: number;
  /** The best a run can honestly report. The server clamps to this. */
  maxScore: number;
  /** Score → coins out. Mirrored server-side; see the note above. */
  payout: (score: number) => number;
  /** Word for one unit of score, for the "12 rows" line on the results card. */
  unit: string;
  create: (w: number, h: number) => CabinetRun;
}

// ---------------------------------------------------------------------------
// Shared drawing helpers. Neon-on-dark, matching the rest of the vibeverse.
// ---------------------------------------------------------------------------

function clearTo(ctx: CanvasRenderingContext2D, w: number, h: number, tint: string) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, tint);
  g.addColorStop(1, "#05070d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function glowRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  glow = 18,
) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = glow;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function centreText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
  weight = "800",
) {
  ctx.save();
  ctx.font = `${weight} ${size}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// STACKER — the one everybody already knows how to play
// ---------------------------------------------------------------------------

const STACK_COLS = 7;
const STACK_ROWS = 12;

function createStacker(w: number, h: number): CabinetRun {
  const cell = Math.min(w / (STACK_COLS + 1.4), h / (STACK_ROWS + 1.6));
  const boardW = cell * STACK_COLS;
  const originX = (w - boardW) / 2;
  const originY = h - cell * 0.6;

  /* Placed rows, bottom-first. `left` is in columns and may be fractional —
     the moving row slides continuously, so an overlap can land mid-column and
     the trim has to be honest about it rather than snapping and gifting the
     player half a block they did not earn. */
  const placed: { left: number; width: number }[] = [];
  let width = 3;
  let pos = 0;
  let dir = 1;
  let flash = 0;
  /* The sliver the last press shaved off, drawn falling away — the feedback
     that teaches the game. Without it a trimmed row just looks like a bug. */
  let debris: { left: number; width: number; row: number; t: number } | null = null;

  const run: CabinetRun = {
    done: null,
    frame(ctx, dt) {
      if (!this.done) {
        const speed = 3.0 + placed.length * 0.55; // columns/second
        pos += dir * speed * dt;
        if (pos <= 0) {
          pos = 0;
          dir = 1;
        } else if (pos + width >= STACK_COLS) {
          pos = STACK_COLS - width;
          dir = -1;
        }
      }
      flash = Math.max(0, flash - dt * 3);
      if (debris) {
        debris.t += dt;
        if (debris.t > 0.8) debris = null;
      }

      clearTo(ctx, w, h, "#0a1a2e");

      // Column guides, so the trim reads as a grid and not as a slide.
      ctx.strokeStyle = "rgba(125,255,212,0.07)";
      ctx.lineWidth = 1;
      for (let c = 0; c <= STACK_COLS; c++) {
        ctx.beginPath();
        ctx.moveTo(originX + c * cell, originY - STACK_ROWS * cell);
        ctx.lineTo(originX + c * cell, originY);
        ctx.stroke();
      }

      const rowY = (row: number) => originY - (row + 1) * cell;

      placed.forEach((r, i) => {
        // Hue climbs with the tower: mint at the bottom, violet at the top.
        const t = i / STACK_ROWS;
        const color = `hsl(${165 + t * 110} 90% ${58 - t * 8}%)`;
        glowRect(ctx, originX + r.left * cell + 1, rowY(i) + 1, r.width * cell - 2, cell - 2, color, 10);
      });

      if (debris) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - debris.t / 0.8);
        ctx.fillStyle = "#ff6b8b";
        ctx.fillRect(
          originX + debris.left * cell + 1,
          rowY(debris.row) + 1 + debris.t * debris.t * 900,
          debris.width * cell - 2,
          cell - 2,
        );
        ctx.restore();
      }

      if (!this.done) {
        glowRect(
          ctx,
          originX + pos * cell + 1,
          rowY(placed.length) + 1,
          width * cell - 2,
          cell - 2,
          flash > 0 ? "#ffffff" : "#7dffd4",
          22,
        );
      }

      centreText(ctx, `${placed.length} / ${STACK_ROWS}`, w / 2, 22, 15, "rgba(255,255,255,0.6)");
      if (placed.length === 0) {
        /* Under the counter, not above the tower. At the bottom of the board it
           sat directly on the first sliding row — the one thing the hint is
           pointing at. */
        centreText(ctx, "TAP TO LOCK THE ROW", w / 2, 46, 12, "rgba(255,255,255,0.45)", "700");
      }
    },
    press() {
      if (this.done) return;
      const below = placed.length === 0
        ? { left: 0, width: STACK_COLS } // The floor. The first row cannot miss.
        : placed[placed.length - 1];

      const left = Math.max(pos, below.left);
      const right = Math.min(pos + width, below.left + below.width);
      const overlap = right - left;

      if (overlap <= 0.02) {
        // A clean miss. The tower stands at whatever it reached.
        this.done = {
          score: placed.length,
          detail:
            placed.length === 0
              ? "Missed the base entirely."
              : `Tower fell at ${placed.length} row${placed.length === 1 ? "" : "s"}.`,
        };
        run.cue?.("over");
        return;
      }

      const shaved = width - overlap;
      if (shaved > 0.02) {
        debris = {
          left: pos < left ? pos : right,
          width: shaved,
          row: placed.length,
          t: 0,
        };
      }

      placed.push({ left, width: overlap });
      width = overlap;
      pos = left;
      flash = 1;
      run.cue?.(shaved > 0.02 ? "tick" : "good");

      if (placed.length >= STACK_ROWS) {
        this.done = { score: STACK_ROWS, detail: "Topped out. The whole tower." };
        run.cue?.("good");
        return;
      }
      if (width < 0.35) {
        // Nothing left to stack with — end it rather than let them press at a
        // sliver they cannot see.
        this.done = { score: placed.length, detail: `Down to a sliver at ${placed.length} rows.` };
        run.cue?.("over");
      }
    },
  };
  return run;
}

// ---------------------------------------------------------------------------
// PATTERN — four pads, a growing sequence
// ---------------------------------------------------------------------------

const PAD_COLORS = ["#7dffd4", "#8fb4ff", "#ffb86b", "#ff8fd0"];
const PATTERN_ROUNDS = 14;

function createPattern(w: number, h: number): CabinetRun {
  const size = Math.min(w, h) * 0.78;
  const ox = (w - size) / 2;
  const oy = (h - size) / 2 + 6;
  const half = size / 2;
  const gap = size * 0.035;

  const padRect = (i: number) => ({
    x: ox + (i % 2) * half + gap / 2,
    y: oy + Math.floor(i / 2) * half + gap / 2,
    w: half - gap,
    h: half - gap,
  });

  let seq: number[] = [];
  let phase: "show" | "input" | "pause" = "pause";
  let showIdx = 0;
  let showT = 0;
  let inputIdx = 0;
  let lit: number | null = null;
  let litT = 0;
  let pauseT = 0.6;
  let cleared = 0;

  function nextRound() {
    seq = [...seq, Math.floor(Math.random() * 4)];
    phase = "show";
    showIdx = 0;
    showT = 0;
    lit = null;
  }

  const run: CabinetRun = {
    done: null,
    frame(ctx, dt) {
      // ---- state machine -------------------------------------------------
      if (!this.done) {
        if (phase === "pause") {
          pauseT -= dt;
          if (pauseT <= 0) nextRound();
        } else if (phase === "show") {
          // Playback quickens as the sequence grows, which is what makes round
          // 12 hard rather than merely long.
          const on = Math.max(0.17, 0.38 - seq.length * 0.012);
          const off = Math.max(0.07, 0.16 - seq.length * 0.005);
          showT += dt;
          if (showT < on) {
            if (lit !== seq[showIdx]) {
              lit = seq[showIdx];
              run.cue?.("tick");
            }
          } else if (showT < on + off) {
            lit = null;
          } else {
            showT = 0;
            showIdx += 1;
            if (showIdx >= seq.length) {
              phase = "input";
              inputIdx = 0;
              lit = null;
            }
          }
        }
      }
      litT = Math.max(0, litT - dt * 4);

      // ---- draw ----------------------------------------------------------
      clearTo(ctx, w, h, "#14092a");
      for (let i = 0; i < 4; i++) {
        const r = padRect(i);
        const active = lit === i;
        ctx.save();
        ctx.globalAlpha = active ? 1 : 0.26;
        ctx.shadowColor = PAD_COLORS[i];
        ctx.shadowBlur = active ? 34 : 0;
        ctx.fillStyle = PAD_COLORS[i];
        ctx.beginPath();
        ctx.roundRect(r.x, r.y, r.w, r.h, 16);
        ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = PAD_COLORS[i];
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(r.x, r.y, r.w, r.h, 16);
        ctx.stroke();
        ctx.restore();
        // Keyboard legend, so this is playable without a touchscreen.
        centreText(ctx, String(i + 1), r.x + r.w - 14, r.y + 14, 11, "rgba(0,0,0,0.5)");
      }

      centreText(
        ctx,
        this.done ? "" : phase === "input" ? "REPEAT IT" : "WATCH",
        w / 2,
        18,
        13,
        "rgba(255,255,255,0.55)",
      );
      centreText(ctx, `ROUND ${Math.max(1, seq.length)}`, w / 2, h - 14, 12, "rgba(255,255,255,0.4)", "700");
    },
    press(p) {
      if (this.done || phase !== "input") return;
      let pad = -1;
      if ("slot" in p) {
        pad = p.slot >= 1 && p.slot <= 4 ? p.slot - 1 : -1;
      } else {
        for (let i = 0; i < 4; i++) {
          const r = padRect(i);
          if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) pad = i;
        }
      }
      if (pad < 0) return;

      lit = pad;
      litT = 1;

      if (pad !== seq[inputIdx]) {
        run.cue?.("over");
        this.done = {
          score: cleared,
          detail:
            cleared === 0
              ? "Fumbled the first sequence."
              : `Held ${cleared} round${cleared === 1 ? "" : "s"} before the slip.`,
        };
        return;
      }
      run.cue?.("tick");
      inputIdx += 1;
      if (inputIdx >= seq.length) {
        cleared += 1;
        run.cue?.("good");
        if (cleared >= PATTERN_ROUNDS) {
          this.done = { score: PATTERN_ROUNDS, detail: "Fourteen rounds. Nobody does fourteen." };
          return;
        }
        phase = "pause";
        pauseT = 0.55;
      }
    },
  };
  return run;
}

// ---------------------------------------------------------------------------
// REFLEX — eight rings, eight windows
// ---------------------------------------------------------------------------

const REFLEX_ROUNDS = 8;

function createReflex(w: number, h: number): CabinetRun {
  const cx = w / 2;
  const cy = h / 2;
  const target = Math.min(w, h) * 0.19;

  let round = 0;
  let t = 0;
  let dur = 1.55;
  let score = 0;
  let banner = "";
  let bannerT = 0;
  let bannerColor = "#7dffd4";
  let perfects = 0;

  function startRound() {
    round += 1;
    t = 0;
    dur = Math.max(0.8, 1.55 - (round - 1) * 0.1);
  }
  startRound();

  function judge(r: number): { pts: number; label: string; color: string } {
    const err = Math.abs(r - target) / target;
    if (err < 0.05) return { pts: 3, label: "PERFECT", color: "#7dffd4" };
    if (err < 0.13) return { pts: 2, label: "GREAT", color: "#8fb4ff" };
    if (err < 0.26) return { pts: 1, label: "OK", color: "#ffd77d" };
    return { pts: 0, label: "MISS", color: "#ff7d9c" };
  }

  const run: CabinetRun = {
    done: null,
    frame(ctx, dt) {
      if (!this.done) {
        t += dt;
        if (t >= dur) {
          // Let it collapse past the target and time out — a missed window is
          // a zero, not a free retry.
          banner = "MISS";
          bannerColor = "#ff7d9c";
          bannerT = 0.5;
          run.cue?.("bad");
          if (round >= REFLEX_ROUNDS) {
            this.done = {
              score,
              detail: `${score}/${REFLEX_ROUNDS * 3} points · ${perfects} perfect`,
            };
          } else startRound();
        }
      }
      bannerT = Math.max(0, bannerT - dt);

      clearTo(ctx, w, h, "#0d1030");

      // The window you are aiming for.
      ctx.save();
      ctx.strokeStyle = "rgba(125,255,212,0.85)";
      ctx.lineWidth = 3;
      ctx.shadowColor = "#7dffd4";
      ctx.shadowBlur = 20;
      ctx.beginPath();
      ctx.arc(cx, cy, target, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = "rgba(125,255,212,0.14)";
      ctx.lineWidth = target * 0.26; // the tolerance band, drawn honestly
      ctx.beginPath();
      ctx.arc(cx, cy, target, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      if (!this.done) {
        const r = target * 2.6 * (1 - t / dur);
        ctx.save();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2.5;
        ctx.shadowColor = "#ffffff";
        ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      if (bannerT > 0) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, bannerT * 2.5);
        centreText(ctx, banner, cx, cy, 26, bannerColor);
        ctx.restore();
      }

      centreText(ctx, `${Math.min(round, REFLEX_ROUNDS)} / ${REFLEX_ROUNDS}`, w / 2, 20, 14, "rgba(255,255,255,0.55)");
      centreText(ctx, `${score} PTS`, w / 2, h - 16, 13, "rgba(125,255,212,0.75)");
    },
    press() {
      if (this.done) return;
      const r = target * 2.6 * (1 - t / dur);
      const j = judge(r);
      score += j.pts;
      if (j.pts === 3) perfects += 1;
      banner = j.label;
      bannerColor = j.color;
      bannerT = 0.5;
      run.cue?.(j.pts >= 2 ? "good" : j.pts === 1 ? "tick" : "bad");

      if (round >= REFLEX_ROUNDS) {
        this.done = { score, detail: `${score}/${REFLEX_ROUNDS * 3} points · ${perfects} perfect` };
      } else startRound();
    },
  };
  return run;
}

// ---------------------------------------------------------------------------
// The floor
// ---------------------------------------------------------------------------

export const CABINETS: Cabinet[] = [
  {
    key: "stacker",
    name: "Stacker",
    tagline: "Twelve rows. Every miss narrows the next one.",
    howTo:
      "A row slides across the top of the tower. Lock it, and anything hanging over the edge is shaved off for good. Reach the twelfth row and the whole cabinet is yours.",
    control: "Tap the screen · or press SPACE",
    emoji: "🧱",
    accent: "#7dffd4",
    cost: 10,
    maxScore: STACK_ROWS,
    unit: "row",
    payout: (s) => (s <= 0 ? 0 : s * 4 + (s >= STACK_ROWS ? 40 : 0)),
    create: createStacker,
  },
  {
    key: "pattern",
    name: "Pattern",
    tagline: "It plays a sequence. You play it back. It gets longer.",
    howTo:
      "Four pads light in order, then it is your turn. Each round adds one more and the playback speeds up. The payout curves upward — round twelve is worth more than the first eight put together.",
    control: "Tap the pads · or press 1 2 3 4",
    emoji: "🎛️",
    accent: "#8fb4ff",
    cost: 8,
    maxScore: PATTERN_ROUNDS,
    unit: "round",
    payout: (s) => (s < 3 ? 0 : Math.round(s * s * 0.6)),
    create: createPattern,
  },
  {
    key: "reflex",
    name: "Reflex",
    tagline: "Eight rings. Eight windows. Twenty seconds.",
    howTo:
      "A ring collapses toward the marker. Hit it dead on the line for three points, close for two, near for one. Miss the window entirely and the round is a zero — there is no retry.",
    control: "Tap anywhere · or press SPACE",
    emoji: "◎",
    accent: "#ffb86b",
    cost: 6,
    maxScore: REFLEX_ROUNDS * 3,
    unit: "point",
    payout: (s) => Math.round(s * 2.4),
    create: createReflex,
  },
];

export const cabinetByKey = (key: string): Cabinet | undefined =>
  CABINETS.find((c) => c.key === key);

/**
 * What a cabinet pays at its best. Printed on the front, because a machine that
 * does not tell you the top prize before you pay is a machine you should not
 * put a coin in.
 */
export const topPrize = (c: Cabinet): number => c.payout(c.maxScore);
