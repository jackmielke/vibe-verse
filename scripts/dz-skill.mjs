#!/usr/bin/env node
/**
 * dz-skill — the part of the teammate that gets better.
 *
 * `dz-teammate.mjs` is legs, transport and a mouth. This is the notebook it
 * keeps between matches: which way of playing actually worked, how the last
 * session went compared to the one before, and every anomaly it noticed about
 * the game while it was out there.
 *
 * WHY THIS IS A BANDIT AND NOT A NEURAL NETWORK
 * ---------------------------------------------
 * The honest levers in a water fight are decisions, not reflexes — when to
 * open fire, when to break off and dry, whether to finish the wounded one or
 * the near one, how much to juke. There are seven of them here and each has a
 * handful of sensible settings. That is a few hundred combinations, evaluated
 * a few dozen times a match, with a reward you can read straight off the wire
 * (soak dealt minus soak taken). A bandit converges on that in an evening of
 * play and — this is the part that matters — every choice it makes can be
 * printed in one line a human can argue with. A policy network could not.
 *
 * Each knob is its own independent UCB1 bandit over its own settings. Credit
 * assignment across knobs is therefore crude: a good fight rewards every knob
 * that was set at the time, including the ones that had nothing to do with it.
 * With enough engagements the noise averages out and the knob that actually
 * mattered separates. That is a real limitation, written down rather than
 * hidden, and it is the right trade at this sample size — a joint bandit over
 * 3456 combinations would still be exploring when the humans went to bed.
 *
 * WHAT IT MAY NOT LEARN
 * ---------------------
 * There is nothing in here that can make the bot see further, react faster or
 * shoot straighter than the caps in `dz-teammate.mjs` allow. Those caps are
 * not knobs and are not in this file, on purpose: the set of things the
 * learner is allowed to touch is exactly the set of things a human player
 * could also decide to do differently tomorrow. Getting better has to mean
 * playing better.
 *
 * The file it writes is `.dz/skill.json` (gitignored — it is a local training
 * record, not source). Delete it and the bot is a beginner again.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Bump when the shape below changes incompatibly; older files are archived
 *  rather than migrated — a training record is cheap to rebuild and a silent
 *  half-migrated one is not. */
export const SKILL_VERSION = 1;

/**
 * The knobs, their settings, and why each one is a decision rather than a
 * cheat. Order is display order in the report.
 *
 * Every value here is inside what a human can do with the same soaker: the
 * engagement ranges are all at or under the gun's honest 40 m, the retreat
 * thresholds are judgement calls, and the juke speeds are strafe speeds.
 */
export const KNOBS = {
  /** Distance at which we start shooting rather than closing. Long means
   *  trading chip damage; short means committing to a duel. */
  engageRange: { values: [18, 26, 34, 40], unit: "m" },
  /** Own dryness above which we press a fight. Below it we break off and dry
   *  — the mechanic `mode/water.ts` is built around, and the one thing that
   *  most reliably separates a good player from a brave one. */
  pushDry: { values: [25, 40, 55, 70], unit: "%" },
  /** How far we back off to dry once we have broken. */
  breakDist: { values: [20, 32, 46], unit: "m" },
  /** How wide we slide sideways while engaged, in metres off the line to the
   *  target. 0 is a standing target; the steering speed cap still applies. */
  strafeAmp: { values: [0, 1.6, 2.8, 4.0], unit: "m" },
  /** Shots before we let the tank catch up. The soaker refills fastest from a
   *  pause, so trigger discipline is genuinely a skill. */
  burstLen: { values: [3, 6, 10, 30], unit: "shots" },
  /** Who to shoot when there is a choice. */
  focus: { values: ["nearest", "weakest", "threat"] },
  /** How far behind a squadmate we hold. Close is useful, far is safe from
   *  the splash that is aimed at them. */
  followDist: { values: [5, 8, 12], unit: "m" },
};

/** UCB1 exploration weight. 0.7 explores less than the textbook √2 because a
 *  bad setting here is not a lost bandit pull, it is a lost water fight in
 *  front of your friends. */
const UCB_C = 0.7;

/** Sessions kept in `history`, newest last. Enough to see a trend on one
 *  screen; not so many that the file grows without bound. */
const HISTORY_MAX = 24;
/** Distinct bug kinds kept. */
const BUGS_MAX = 40;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const now = () => new Date().toISOString();

/** A fresh, empty record. */
function blank() {
  return {
    version: SKILL_VERSION,
    created: now(),
    updated: now(),
    sessions: 0,
    totals: {
      lives: 0,
      matches: 0,
      wins: 0,
      engagements: 0,
      dealt: 0,
      taken: 0,
      knockouts: 0,
      deaths: 0,
      revives: 0,
      playSeconds: 0,
    },
    /** knob -> arm value (as a string key) -> { n, mean } */
    knobs: {},
    /** One entry per session that actually played. */
    history: [],
    /** Anomalies noticed on the field, deduped by kind. */
    bugs: [],
  };
}

/**
 * Open (or create) a training record.
 *
 * Never throws: a corrupt or unreadable file is a reason to start a fresh
 * notebook and say so, not a reason to keep the bot out of the lobby.
 *
 * @param {object}  opts
 * @param {string}  opts.file      where to persist
 * @param {boolean} opts.enabled   false = learn nothing, remember nothing
 * @param {(msg: string) => void} [opts.warn]
 */
export function openSkill({ file, enabled = true, warn = () => {} }) {
  let data = blank();
  let dirty = false;

  if (enabled) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (raw && raw.version === SKILL_VERSION) {
        data = { ...blank(), ...raw, totals: { ...blank().totals, ...raw.totals } };
      } else if (raw) {
        warn(`skill file is version ${raw.version}, this is ${SKILL_VERSION} — starting fresh`);
      }
    } catch (err) {
      // ENOENT on the first ever run is the normal path, not a problem.
      if (err?.code !== "ENOENT") warn(`could not read ${file} (${err?.message ?? err}) — starting fresh`);
    }
  }

  // ---- the bandit ------------------------------------------------------

  const cell = (knob, arm) => {
    const k = (data.knobs[knob] ??= {});
    return (k[String(arm)] ??= { n: 0, mean: 0.5 });
  };

  /** Total pulls across a knob's arms — the `t` in UCB1. */
  const pulls = (knob) =>
    Object.values(data.knobs[knob] ?? {}).reduce((sum, c) => sum + c.n, 0);

  /**
   * Choose a setting for every knob: a *plan*, held for one life.
   *
   * Per life rather than per engagement because a plan is a way of playing —
   * "hold them at range and break early" is a stance you take, and judging it
   * on a single trade would mostly be measuring who shot first.
   */
  function plan() {
    const out = {};
    for (const [knob, spec] of Object.entries(KNOBS)) {
      const t = pulls(knob);
      let best = spec.values[0];
      let bestScore = -Infinity;
      for (const v of spec.values) {
        const c = cell(knob, v);
        // Anything untried wins outright — cover the ground before optimising.
        const score = c.n === 0 ? Infinity : c.mean + UCB_C * Math.sqrt(Math.log(t + 1) / c.n);
        if (score > bestScore) {
          bestScore = score;
          best = v;
        }
      }
      out[knob] = best;
    }
    return out;
  }

  /**
   * Credit a plan with how an engagement went.
   *
   * Reward is soak traded, in [0,1] with 0.5 as "broke even", plus a nudge for
   * the two outcomes that are worth more than the arithmetic: taking someone
   * out, and being taken out. A fight you lose 40-to-90 and survive is still
   * better than one you lose 40-to-100 and don't.
   */
  function engagement(currentPlan, { dealt = 0, taken = 0, knockout = 0, died = false } = {}) {
    const trade = clamp((dealt - taken) / 120, -1, 1);
    const reward = clamp(0.5 + trade * 0.5 + knockout * 0.12 - (died ? 0.2 : 0), 0, 1);
    for (const [knob, arm] of Object.entries(currentPlan)) {
      if (!(knob in KNOBS)) continue;
      const c = cell(knob, arm);
      c.n += 1;
      // Running mean, so an arm's value is the average of everything it ever
      // scored rather than a recency-biased blur. Play does not drift that
      // fast, and a stable number is one a human can sanity-check.
      c.mean += (reward - c.mean) / c.n;
    }
    data.totals.engagements += 1;
    data.totals.dealt += dealt;
    data.totals.taken += taken;
    data.totals.knockouts += knockout;
    if (died) data.totals.deaths += 1;
    dirty = true;
    return reward;
  }

  // ---- the scoreboard --------------------------------------------------

  const bump = (key, by = 1) => {
    data.totals[key] = (data.totals[key] ?? 0) + by;
    dirty = true;
  };

  /**
   * Note something that looked like a bug in the *game*, not in the bot.
   *
   * Deduped by kind and counted, because the interesting signal is "this
   * happened 300 times tonight", and a log line that scrolls past at 20 Hz is
   * not a bug report anyone will ever read.
   */
  function bug(kind, detail = "") {
    const found = data.bugs.find((b) => b.kind === kind);
    if (found) {
      found.count += 1;
      found.last = now();
      if (detail) found.detail = String(detail).slice(0, 200);
    } else if (data.bugs.length < BUGS_MAX) {
      data.bugs.push({ kind, detail: String(detail).slice(0, 200), count: 1, first: now(), last: now() });
    }
    dirty = true;
    return found ? found.count : 1;
  }

  /** Everything this session added, for the sign-off line. */
  const session = {
    lives: 0,
    engagements: 0,
    dealt: 0,
    taken: 0,
    knockouts: 0,
    deaths: 0,
    revives: 0,
    wins: 0,
    matches: 0,
    seconds: 0,
  };

  /** Ratio helper that reads as a number a human would say out loud. */
  const kd = (t) => (t.deaths > 0 ? t.knockouts / t.deaths : t.knockouts);

  /**
   * What the bot has actually learned, as a paragraph rather than a JSON dump.
   * Printed on the way out — the only moment anybody is going to read it.
   */
  function report() {
    const t = data.totals;
    const lines = [];
    lines.push(
      `career: ${t.lives} lives across ${data.sessions} session(s) — ` +
        `${t.knockouts} soaked, ${t.deaths} times soaked out (${kd(t).toFixed(2)} K/D), ` +
        `${t.wins}/${t.matches} matches won`,
    );

    // The trend is the whole point of the file, so lead with it when there is
    // one: this session against the average of everything before it.
    const prior = data.history.slice(0, -1);
    if (prior.length > 0 && session.engagements > 0) {
      const before = prior.reduce(
        (a, h) => ({ dealt: a.dealt + h.dealt, taken: a.taken + h.taken }),
        { dealt: 0, taken: 0 },
      );
      const beforeRatio = before.taken > 0 ? before.dealt / before.taken : before.dealt;
      const nowRatio = session.taken > 0 ? session.dealt / session.taken : session.dealt;
      const dir = nowRatio > beforeRatio ? "up from" : nowRatio < beforeRatio ? "down from" : "level with";
      lines.push(
        `tonight: dealt ${Math.round(session.dealt)} took ${Math.round(session.taken)} ` +
          `(${nowRatio.toFixed(2)}× — ${dir} ${beforeRatio.toFixed(2)}× before)`,
      );
    } else if (session.engagements > 0) {
      lines.push(
        `tonight: ${session.engagements} engagement(s), dealt ${Math.round(session.dealt)}, took ${Math.round(session.taken)} — first session, no trend yet`,
      );
    }

    for (const [knob, spec] of Object.entries(KNOBS)) {
      const arms = data.knobs[knob] ?? {};
      const tried = Object.entries(arms).filter(([, c]) => c.n > 0);
      if (tried.length === 0) continue;
      tried.sort((a, b) => b[1].mean - a[1].mean);
      const [armValue, c] = tried[0];
      const unit = spec.unit ? ` ${spec.unit}` : "";
      lines.push(
        `  ${knob.padEnd(12)} best ${String(armValue)}${unit}` +
          ` (${c.mean.toFixed(2)} over ${c.n})` +
          (tried.length < spec.values.length ? `  — ${spec.values.length - tried.length} untried` : ""),
      );
    }

    if (data.bugs.length > 0) {
      lines.push(`bugs noticed on the field (${data.bugs.length}):`);
      for (const b of [...data.bugs].sort((a, b2) => b2.count - a.count).slice(0, 8)) {
        lines.push(`  ×${String(b.count).padEnd(5)} ${b.kind}${b.detail ? ` — ${b.detail}` : ""}`);
      }
    }
    return lines.join("\n");
  }

  /** Close the session out and write. Safe to call twice. */
  let closed = false;
  function close(seconds = 0) {
    if (!enabled || closed) return;
    closed = true;
    session.seconds = seconds;
    data.totals.playSeconds += seconds;
    data.sessions += 1;
    data.updated = now();
    if (session.engagements > 0 || session.lives > 0) {
      data.history.push({ at: now(), ...session });
      while (data.history.length > HISTORY_MAX) data.history.shift();
    }
    save();
  }

  function save() {
    if (!enabled) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(data, null, 2));
      dirty = false;
    } catch (err) {
      warn(`could not write ${file}: ${err?.message ?? err}`);
    }
  }

  return {
    file,
    enabled,
    data,
    plan,
    /** Record an engagement against the plan that was in force. */
    engagement(currentPlan, outcome) {
      const r = engagement(currentPlan, outcome);
      session.engagements += 1;
      session.dealt += outcome?.dealt ?? 0;
      session.taken += outcome?.taken ?? 0;
      session.knockouts += outcome?.knockout ?? 0;
      if (outcome?.died) session.deaths += 1;
      return r;
    },
    life() {
      bump("lives");
      session.lives += 1;
    },
    revive() {
      bump("revives");
      session.revives += 1;
    },
    match(won) {
      bump("matches");
      session.matches += 1;
      if (won) {
        bump("wins");
        session.wins += 1;
      }
    },
    bug,
    report,
    close,
    save,
    get dirty() {
      return dirty;
    },
    /** For the selftest: the plan the bandit currently believes in. */
    best() {
      const out = {};
      for (const [knob, spec] of Object.entries(KNOBS)) {
        const arms = Object.entries(data.knobs[knob] ?? {}).filter(([, c]) => c.n > 0);
        if (arms.length === 0) {
          out[knob] = null;
          continue;
        }
        arms.sort((a, b) => b[1].mean - a[1].mean);
        const raw = arms[0][0];
        // JSON object keys are strings; hand back the typed value the caller
        // put in, so `best().engageRange` is a number you can do maths with.
        out[knob] = spec.values.find((v) => String(v) === raw) ?? raw;
      }
      return out;
    },
  };
}
