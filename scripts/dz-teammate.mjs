#!/usr/bin/env node
/**
 * dz-teammate — Claude joins your SOAKED lobby as a third squadmate.
 *
 * The pitch was "it would be really fun if you could join our same game and be
 * a bot and a live NPC that we could talk to. It could be us three on a team.
 * Between Atlas, Jack, and you." This is that.
 *
 * THE DESIGN, and why it is this shape
 * ------------------------------------
 * The teammate joins the *same* Supabase Realtime channel the browsers use, as
 * an ordinary peer. It publishes a pose, it sends gameplay events, it chats.
 * There is no bot hook, no special case and no server component inside the
 * game — `src/royale/net/net.ts` sees a peer whose presence meta happens to
 * carry `agent: true`, and draws it exactly like a human. That flag is only
 * used to badge it in the UI; every other code path treats it as a player.
 *
 * That is the whole trick, and it buys three things:
 *  - The game cannot break because of this file. It is another browser tab as
 *    far as the engine is concerned.
 *  - This file cannot break because of the game. If a system in `src/royale/`
 *    is mid-repair, the bot keeps walking and keeps talking.
 *  - It works in production against the deployed site with no deploy of its
 *    own. Point it at a room code and it is in the match.
 *
 * WIRE PROTOCOL — mirrored from src/royale/net/net.ts. Keep in sync.
 *   channel   `splash-<NORMALISED-ROOM-CODE>`
 *   presence  key = our peer id, meta = { name, team, agent }
 *   broadcast "pose" → { i, x, y, z, a(yaw), p(pitch), s(state), d(dry),
 *                        t(team), n(name), g(1 when an agent) }
 *   broadcast "ev"   → { i, k(kind), p(payload) }, kinds are NetEventKind:
 *                      shot splash balloon glue build harvest soaked revive
 *                      emote chat ping
 * Positions are metres, +X east / +Z south / +Y up, matching royale/types.ts.
 *
 * CLOCKS. Everything the brain times runs off `sim` — a seconds counter this
 * process advances itself — never `Date.now()` deltas sprinkled through the
 * logic. By default one simulated second is one wall second. It exists as a
 * separate clock because of `--timescale`: under SwiftSHADER a headless
 * browser runs the match ~400x slower than wall clock, and since net.ts times
 * everything in `ctx.elapsed` (simulated seconds), a bot moving at real 6 m/s
 * would appear to teleport around a container-hosted match. `--timescale
 * 0.0025` slows this process to match. Against a real browser, leave it at 1.
 *
 * IT STAYS, AND IT GETS BETTER
 * ----------------------------
 * Two things this file used to not do, both of which made it read as a demo
 * rather than a squadmate:
 *
 * It stopped playing. Soaked out at 0% dry meant standing in a field until
 * somebody killed the process — through the end card, through the next lobby,
 * through the next match. Now a life is a life: it plays one, notices when the
 * lobby has rolled into a new match, and starts another. Leave it running and
 * it is still there tomorrow, with a better record than it had tonight.
 *
 * And it learned nothing. Every match started the beginner it was the first
 * time. Now `dz-skill.mjs` keeps a notebook — seven decisions about how to
 * fight, each an independent bandit, each credited with the soak actually
 * traded while it was in force. It is a small enough idea to hold in your head
 * and it converges in an evening: after a few dozen engagements the bot knows
 * whether *this* squad's fights are won by holding at 34 m or closing to 18.
 *
 * FAIR PLAY, WHICH IS THE WHOLE POINT
 * -----------------------------------
 * A bot with the wire in front of it can trivially be unbeatable, and an
 * unbeatable teammate is not fun to play with, it is furniture. So the caps in
 * `FAIR` below are not tuning values, they are the rules: a reaction time
 * floor before it may shoot a target it has just acquired, an engagement range
 * no longer than a human could reasonably see, an accuracy ceiling well short
 * of the hitscan certainty the packets would allow, human movement speeds, the
 * game's own drying rate, and no teleporting except the one place a human is
 * also moved by the game — the drop bus. The learner cannot touch any of them.
 * It may only get better at *deciding*, which is the only kind of better worth
 * having.
 *
 * USAGE
 *   node scripts/dz-teammate.mjs --room SPLASH-4B2 --name Claude --team blue
 *
 * FLAGS
 *   --room CODE      lobby to join (required; case/punctuation insensitive)
 *   --name NAME      display name                        [Claude]
 *   --team TEAM      riptide|dolphin|cannonball|flamingo [riptide]
 *   --url URL        Supabase URL      [$VITE_SUPABASE_URL or .env]
 *   --key KEY        Supabase anon key [$VITE_SUPABASE_PUBLISHABLE_KEY or .env]
 *   --follow-dist M  how far behind a teammate to hold   [learned, 6 to start]
 *   --zone x,z,r     safe-zone hint, if you know it (see "The downpour")
 *   --timescale N    simulated seconds per wall second   [1]
 *   --quiet          drop the movement/status chatter, keep chat + events
 *   --skill FILE     training record            [<repo>/.dz/skill.json]
 *   --no-learn       play, but neither read nor write the training record
 *   --report         print what it has learned so far and exit
 *   --selftest       run the brain offline against a scripted teammate and
 *                    exit — no socket, no lobby, no Supabase config needed
 *   --help
 *
 * Exit codes: 0 clean shutdown (Ctrl-C) or a passing --selftest, 1 bad config,
 * unreachable lobby, or a failing --selftest.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openSkill, KNOBS } from "./dz-skill.mjs";
// @supabase/supabase-js is imported dynamically down in connect(), for the
// same reason net.ts does it: a missing or broken client should be a sentence
// the operator can act on, not a module-scope stack trace — and --selftest
// should run with no dependencies installed at all.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

// ---------------------------------------------------------------- tuning
//
// All distances in metres, all times in SIMULATED seconds.

/** Brain tick. Faster than the send rate so steering stays smooth. */
const TICK_HZ = 20;
/** Pose send rate — the same 10 Hz net.ts uses. */
const POSE_INTERVAL = 1 / 10;
/** Resend an unchanged pose this often so peers know we are still alive. */
const POSE_HEARTBEAT = 1.5;
/** Drop a peer we have not heard from in this long (net.ts uses 6). */
const PEER_TIMEOUT = 8;

/** Comfortable jog, and the sprint we break into when we have fallen behind. */
const WALK_SPEED = 4.2;
const SPRINT_SPEED = 6.9;
/** Sprint once the leader is further away than this. */
const SPRINT_AT = 13;
/** Never crowd a human closer than this — being body-blocked by your own
 *  teammate is the single most irritating thing a follower bot can do. */
const PERSONAL_SPACE = 2.4;
/** Sideways offset of our follow slot, so we trail beside rather than behind
 *  the exact line of fire. */
const SLOT_SIDE = 2.0;
/** Close enough to the slot to stop shuffling. */
const SLOT_DEADZONE = 1.1;
/** Steering smoothing — how fast velocity chases the desired velocity. */
const ACCEL = 9;
/** Vertical easing toward the leader's altitude (see followY below). */
const Y_LERP = 2.5;

/** Crude pathing: if we cover less than this in STUCK_WINDOW while trying to
 *  move, assume a wall and take a detour. */
const STUCK_WINDOW = 1.4;
const STUCK_DIST = 0.9;
const DETOUR_TIME = 2.2;
/** How far off the direct line a detour steers. ~70° clears most corners. */
const DETOUR_ANGLE = 1.22;

/** Half-extent of the island (royale/world/terrain.ts WORLD_SIZE), minus a
 *  margin so we never wander into the sea. */
const ISLAND_HALF = 1500 * 0.82;

/**
 * How far outside the island we are willing to go, given where the leader is.
 *
 * The default fence keeps us out of the sea, which is right nearly always and
 * catastrophically wrong for the one minute that decides the match: the drop
 * bus starts its run far outside the playable square and hundreds of metres
 * up. A follower that refuses to leave the island watches the bus fly past.
 *
 * So the fence yields to the leader — always far enough out to reach them,
 * plus a little room to hold a slot beside them, and never tighter than the
 * island itself. When there is no leader it is exactly the old behaviour.
 */
function leaderReach(base) {
  const lead = peers.get(leaderId);
  if (!lead || !lead.posed) return base;
  const need = Math.max(Math.abs(lead.x), Math.abs(lead.z)) + followDist() + SLOT_SIDE;
  return Math.max(base, need);
}

/**
 * Gap past which we stop walking and simply appear beside the squad.
 *
 * Set above any distance a real match puts between a follower and its leader
 * (the island is 3 km corner to corner, and the follow slot is 6 m) so this
 * only ever fires for the two cases that are genuinely unwalkable: the drop
 * bus, and a leader who has quick-travelled away. The cooldown keeps it from
 * becoming a rubber band if someone is hovering right at the threshold.
 */
const REJOIN_DIST = 220;
const REJOIN_COOLDOWN = 6;

/**
 * The soaker, modelled on the Super Soaker 9000 in `mode/water.ts`: 12 soak a
 * shot, a 30-shot tank, 12/s refill after a 0.45 s pause.
 *
 * ENGAGEMENT RANGE IS THE HONEST PART. The gun's real range is 220 m and its
 * damage falloff does not even begin until 45 m — but this process has no
 * terrain, no collision and no line of sight. It knows where everyone is and
 * nothing about what is between. Firing at 200 m would mean firing through
 * hills, through Foundry Flats, and through the island itself.
 *
 * 40 m is the compromise: short enough that "we can see each other" is usually
 * true on open ground, long enough to matter in a fight. It still shoots
 * through the occasional shed, and that is a real limitation rather than a
 * tuning value — the fix is line-of-sight data this process does not have.
 *
 * ACCURACY exists for the same reason in reverse: the bot has millimetre-exact
 * knowledge of every position on the wire, so without a miss rate it is a
 * hitscan laser that never misses a moving target at 40 m. Nobody wants to
 * play against that, least of all beside it.
 */
const GUN_RANGE = 40;
const GUN_SOAK = 12;
const GUN_SHOTS_PER_SEC = 3.5;
const GUN_TANK = 30;
const GUN_REFILL = 12;
const GUN_REFILL_DELAY = 0.45;
/** Hit chance at point blank, falling to this at GUN_RANGE. */
const GUN_ACC_NEAR = 0.82;
const GUN_ACC_FAR = 0.38;
/** Stop shooting at someone we have not had a fresh pose from. */
const GUN_STALE = 1.5;

/**
 * Dryness: how wet a splash within SPLASH_RADIUS makes us, and how fast we
 * towel off again while nothing is hitting us. 0% dry = down.
 *
 * The drying numbers are `DRYNESS` from `src/royale/mode/water.ts`, copied
 * rather than guessed. They used to be 1.4/s after 4 s, which was neither the
 * game's rule nor a deliberate handicap — just a number typed before anybody
 * checked. It mattered more than it looks: at less than half the real rate,
 * breaking off to dry never paid for the time it cost, so the only strategy
 * the bot could express was "keep shooting until someone is out". The mode is
 * built around retreating to dry, and now the bot plays the same game we do.
 */
const SPLASH_RADIUS = 3.2;
const SPLASH_SOAK = 9;
const DRY_REGEN = 3.2;
const DRY_REGEN_DELAY = 5;
/** Wind across a wet shirt — `DRYNESS.dryWindBonus`. Sprinting away from a
 *  fight really is the fastest way to get dry, and that is the mode's joke. */
const DRY_WIND_BONUS = 1.35;

/** Downed, from `DRYNESS`: 0% is a slump, not an ending. A squadmate can
 *  towel you off at `REVIVE_DRY` if they stand over you for `REVIVE_TIME`. */
const REVIVE_DRY = 30;
const REVIVE_TIME = 7;
/** How close you must be to towel someone off. */
const REVIVE_REACH = 3.0;

/**
 * FAIR PLAY. Not tuning — rules. Nothing in `dz-skill.mjs` can reach past any
 * of these, and every one exists because the wire makes the opposite trivial.
 *
 * `reaction` is the important one and the least obvious. This process knows
 * exactly where everyone is, ten times a second, with no eyes and no monitor
 * in the way. Without a deliberate delay between a target existing and the
 * trigger being available, it opens fire on the same frame someone rounds a
 * corner — which is not "good", it is a thing no human can be. 220 ms is at
 * the fast end of a human visual reaction and it is where this stays.
 */
const FAIR = {
  /** Seconds a target must have been acquired before we may shoot it. */
  reaction: 0.22,
  /** Hard ceiling on any learned engagement range. */
  maxRange: GUN_RANGE,
  /** Hard ceiling on movement, both learned and steered. */
  maxSpeed: SPRINT_SPEED,
  /** The only legitimate reason to be moved somewhere we did not walk: the
   *  drop bus, which moves the humans too. See `mayRejoin()`. */
  teleport: "drop-bus-only",
};

/** Pause after a burst, so the tank has a moment to catch up. Two refill
 *  delays: long enough to matter, short enough not to read as a jam. */
const BURST_PAUSE = GUN_REFILL_DELAY * 2;
/** An engagement ends when nothing has been traded for this long. */
const ENGAGE_TIMEOUT = 5;
/** A knockout counts as ours if we soaked them inside this window. */
const CREDIT_WINDOW = 3.5;
/** Out this long with everyone around us dry: the match rolled without us. */
const NEW_MATCH_PATIENCE = 45;
/** Write the training record this often, so a kill -9 costs at most this. */
const SKILL_SAVE_INTERVAL = 120;

/** How long a glue hit leaves us stumbling. */
const GLUE_STUMBLE = 3.5;

/**
 * How far away a tracer or a splash is still something a player would notice.
 *
 * This is the one piece of long-range information the bot is allowed to act
 * on, and it is allowed because a human has it too: you see the water arc and
 * you hear the burst, and rotating toward a fight you did not start is normal
 * play. The exact position of a rival who has not fired is on our wire and
 * stays out of our decisions — that would be a wallhack with a friendly name.
 */
const HEARING = 90;
/** How long a fight we heard is still worth walking toward. */
const GUNFIRE_MEMORY = 20;

/** Minimum gap between our chat lines, so the bot never spams the squad.
 *  Being spoken to directly shortens it — ignoring a question is worse. */
const CHAT_COOLDOWN = 7;
const CHAT_COOLDOWN_DIRECT = 2.5;
/** Chat lines kept for the reply seam's context. */
const CHAT_MEMORY = 10;
/** Don't call out the same thing twice inside this window. */
const CALLOUT_COOLDOWN = 12;

/** Status line cadence in the terminal. */
const STATUS_INTERVAL = 6;

/** Wall-clock ceiling on the initial socket handshake. A real network event,
 *  so this one is genuinely milliseconds — the only place that is true. */
const CONNECT_TIMEOUT_MS = 12000;

// ---------------------------------------------------------------- cli

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  // The header comment is the manual; print the flag block from it.
  console.log(
    [
      "",
      "  dz-teammate — Claude joins your SOAKED lobby as a third squadmate.",
      "",
      "  node scripts/dz-teammate.mjs --room SPLASH-4B2 --name Claude --team blue",
      "",
      "    --room CODE      lobby to join (required)",
      "    --name NAME      display name                        [Claude]",
      "    --team TEAM      riptide|dolphin|cannonball|flamingo [riptide]",
      "    --url URL        Supabase URL      [VITE_SUPABASE_URL / .env]",
      "    --key KEY        Supabase anon key [VITE_SUPABASE_PUBLISHABLE_KEY / .env]",
      "    --follow-dist M  how far behind a teammate to hold   [learned]",
      "    --zone x,z,r     safe-zone hint, if you know it",
      "    --timescale N    simulated seconds per wall second   [1]",
      "    --quiet          drop movement chatter, keep chat + events",
      "    --skill FILE     training record          [<repo>/.dz/skill.json]",
      "    --no-learn       play without reading or writing the record",
      "    --report         print what it has learned so far and exit",
      "    --selftest       run the brain offline and exit (no lobby needed)",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

// ---------------------------------------------------------------- logging

const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOUR ? `\x1b[${code}m${s}\x1b[0m` : s);
const QUIET = !!args.quiet;

const stamp = () => new Date().toTimeString().slice(0, 8);
const line = (tag, colour, msg) =>
  console.log(`${c("90", stamp())} ${c(colour, tag.padEnd(6))} ${msg}`);

const log = {
  net: (m) => line("net", "36", m),
  move: (m) => QUIET || line("move", "90", m),
  chat: (m) => line("chat", "35", m),
  event: (m) => line("event", "33", m),
  say: (m) => line("say", "92", m),
  warn: (m) => line("warn", "31", m),
  info: (m) => line("info", "37", m),
};

/** Die with a sentence a human can act on, never a stack trace. */
function bail(msg, hint) {
  console.error(`\n  ${c("31", "dz-teammate:")} ${msg}`);
  if (hint) console.error(`  ${c("90", hint)}`);
  console.error("");
  process.exit(1);
}

// ---------------------------------------------------------------- config

/** Minimal .env reader. The repo keeps Supabase config in .env for Vite, and
 *  Vite is not in the room when this script runs, so read it ourselves rather
 *  than making the operator export two variables by hand. */
function readEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const s = raw.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq < 1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const dotenv = readEnvFile(resolve(REPO, ".env"));
const pick = (...names) => {
  for (const n of names) {
    const v = process.env[n] ?? dotenv[n];
    if (v) return v;
  }
  return "";
};

const SELFTEST = !!args.selftest;
const REPORT_ONLY = !!args.report;

const SUPABASE_URL = String(args.url || pick("VITE_SUPABASE_URL", "SUPABASE_URL"));
const SUPABASE_KEY = String(
  args.key ||
    pick(
      "VITE_SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_ANON_KEY",
      "SUPABASE_PUBLISHABLE_KEY",
    ),
);

// --selftest never opens a socket, and --report only reads a local file, so
// both must run with no config at all.
if (!SELFTEST && !REPORT_ONLY) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    bail(
      "no Supabase configuration found, so there is no lobby to join.",
      `Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in ${resolve(REPO, ".env")}\n  or the environment, or pass --url and --key. The game itself is unaffected —\n  /drop-zero stays fully playable solo without this bot.`,
    );
  }
  if (!/^https?:\/\//.test(SUPABASE_URL)) {
    bail(`--url must be an http(s) URL, got "${SUPABASE_URL}".`);
  }
}

/** Same canonicalisation net.ts does, so "splash 4b2" and "SPLASH-4B2" are
 *  the same lobby however the humans typed it. Kept as a copy rather than an
 *  import: this is a .mjs script and that is a TypeScript module inside the
 *  Vite build. If you change one, change the other. */
function normalizeRoomCode(raw) {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

const ROOM = normalizeRoomCode(
  args.room ?? args.r ?? (SELFTEST ? "SELFTEST" : REPORT_ONLY ? "REPORT" : ""),
);
if (!ROOM) {
  bail(
    "no room code. The teammate joins a lobby the humans are already in.",
    "e.g. node scripts/dz-teammate.mjs --room SPLASH-4B2 --name Claude --team blue",
  );
}

const NAME = String(args.name || "Claude").slice(0, 24);
/**
 * The four squads the lobby offers, by id. The picker in
 * `src/royale/ui/Lobby.tsx` writes exactly these into the presence payload.
 */
const SQUADS = ["riptide", "dolphin", "cannonball", "flamingo"];

/**
 * Fold a squad name to something two people typing from memory will agree on.
 *
 * Teammates are matched by string, and an unrecognised string does not fail
 * loudly — it just means the bot treats you as a rival and never follows you,
 * which looks like a broken bot rather than a typo. "Dolphins" and "dolphin"
 * are the same squad to a human, so make them the same squad here: lowercase,
 * trim, and drop a trailing plural.
 */
const foldTeam = (t) => {
  const s = String(t ?? "").trim().toLowerCase();
  if (!s) return "";
  const singular = s.endsWith("s") ? s.slice(0, -1) : s;
  return SQUADS.includes(singular) ? singular : s;
};

/* Default to the squad the lobby itself defaults to. The old default was
   "blue", which is not one of the four squads at all — so running the command
   without --team put the bot on nobody's team and it shadowed strangers. */
const TEAM = foldTeam(args.team || SQUADS[0]).slice(0, 24);
if (args.team && !SQUADS.includes(TEAM)) {
  log.warn(
    `"${args.team}" is not one of the lobby's squads (${SQUADS.join(", ")}). ` +
      `Joining as "${TEAM}" anyway — but you will only squad up with someone ` +
      `who picked the same string, so check the invite button in the lobby.`,
  );
}
/** `--follow-dist` is an override now, not the value: with nothing on the
 *  command line the follow slot is one of the things the bot works out for
 *  itself. Null means "learned". */
const FOLLOW_OVERRIDE = args["follow-dist"] ? Math.max(2.5, Number(args["follow-dist"]) || 6) : null;
const TIMESCALE = Number(args.timescale) > 0 ? Number(args.timescale) : 1;
const SELF_ID = `s-claude-${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------- the notebook
//
// Opened before anything else can want it, and deliberately incapable of
// failing loudly: a training record that cannot be read is a bot that plays
// like it is new, which is exactly what it was yesterday.

const SKILL_FILE = String(args.skill || resolve(REPO, ".dz/skill.json"));
const skill = openSkill({
  file: SKILL_FILE,
  // --selftest gets a memory-only notebook. A test run must never train the
  // real one: fifty scripted engagements against a dummy would drown a night
  // of actual play in synthetic rewards.
  enabled: !args["no-learn"] && !SELFTEST,
  warn: (m) => log.warn(m),
});

if (REPORT_ONLY) {
  console.log("");
  console.log(`  ${c("1", "dz-teammate")} — ${SKILL_FILE}`);
  console.log("");
  console.log(skill.report());
  console.log("");
  process.exit(0);
}

/**
 * The plan: one setting per knob, chosen at the start of every life and held
 * for it. Read through `fair()` at the point of use, never raw.
 */
let plan = skill.plan();

/** Every learned number passes through here. The clamps are the contract in
 *  `FAIR` made executable — a bad file, a hand-edited record or a future knob
 *  with a typo in its values cannot buy the bot anything a human can't have. */
function fair(knob) {
  const v = plan[knob];
  switch (knob) {
    case "engageRange":
      return clamp(Number(v) || 26, 6, FAIR.maxRange);
    case "pushDry":
      return clamp(Number(v) || 40, 0, 100);
    case "breakDist":
      return clamp(Number(v) || 32, 8, 90);
    case "strafeAmp":
      return clamp(Number(v) || 0, 0, FAIR.maxSpeed * 0.6);
    case "burstLen":
      return clamp(Number(v) || 6, 1, GUN_TANK);
    case "followDist":
      return FOLLOW_OVERRIDE ?? clamp(Number(v) || 6, 2.5, 20);
    case "focus":
      return KNOBS.focus.values.includes(v) ? v : "nearest";
    default:
      return v;
  }
}

/** Read as `FOLLOW_DIST` was, so the rest of the file did not have to change
 *  shape to gain a learned follow slot. */
const followDist = () => fair("followDist");

/** Optional safe-zone hint, "--zone x,z,r". See "The downpour" below. */
let zone = null;
if (typeof args.zone === "string") {
  const [zx, zz, zr] = args.zone.split(",").map(Number);
  if ([zx, zz, zr].every(Number.isFinite)) zone = { x: zx, z: zz, r: zr };
  else bail(`--zone wants "x,z,radius", got "${args.zone}".`);
}

// ---------------------------------------------------------------- maths

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const q = (n) => Math.round(n * 100) / 100;

/** Shortest-arc angle lerp, so we never spin the long way round. */
function turnToward(from, to, maxStep) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + clamp(d, -maxStep, maxStep);
}

/**
 * "Are they talking to me?", precompiled.
 *
 * Built once, and with the name escaped: `--name "Claude++"` used to compile
 * `(^|\W)@?Claude++\b`, which is a syntax error, thrown from inside a realtime
 * callback on the first chat line of the match — a bot that goes silent and
 * deaf the moment anybody says hello, for no reason a player could ever guess.
 */
const NAME_RE = new RegExp(
  `(^|\\W)@?${NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
  "i",
);

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
/** Compass word for the direction from `a` to `b`. +X east, +Z south — the
 *  convention royale/types.ts sets, which is why -dz is "north". */
function bearing(ax, az, bx, bz) {
  const idx = Math.round(Math.atan2(bx - ax, -(bz - az)) / (Math.PI / 4));
  return COMPASS[((idx % 8) + 8) % 8];
}

// ---------------------------------------------------------------- state

/** Our own pose. Starts at the origin and snaps to the squad on first sight. */
const me = {
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  vx: 0,
  vz: 0,
  state: "ground",
  dry: 100,
};

/** id -> { id, name, team, agent, x, y, z, yaw, dry, state, lastSeen } */
const peers = new Map();

/** Simulated clock. Every timer in this file reads it. */
let sim = 0;
let online = false;
let placed = false; // have we snapped to the squad yet?
let stumbleUntil = -1;
let lastSoakedAt = -Infinity;
let lastPoseAt = -Infinity;
let lastPoseSent = null;
let lastChatAt = -Infinity;
let lastCalloutAt = -Infinity;
let lastStatusAt = 0;
let announcedOut = false;

/** Crude pathing state — see STUCK_WINDOW. */
let anchor = { x: 0, z: 0, t: 0 };
let detourUntil = -1;
/** Where we were standing when the lobby emptied, so idling stays put. */
let idleHome = null;
/** Gun state: what is left in the tank, when we last pulled, who we are on. */
let tank = GUN_TANK;
let lastShotAt = -Infinity;
let aimId = null;
let soakedByUs = 0;
/** `sim` of the last rejoin, so an unwalkable gap cannot rubber-band us. */
let lastRejoinAt = -Infinity;
let detourSign = 1;

// ---- combat, and the life it belongs to --------------------------------
//
// An *engagement* is the unit the learner is scored on: from the first thing
// traded with a particular rival to ENGAGE_TIMEOUT after the last. A *life*
// is spawn to soaked-out, and owns one plan.

/** When the current aim target was first acquired — the reaction-time gate. */
let acquiredAt = -Infinity;
/** Shots since the last pause, and the pause we are serving. */
let burstShots = 0;
let burstUntil = -1;
/** { id, name, dealt, taken, knockout, last } or null. */
let engagement = null;
/** id -> `sim` when we last soaked them, for knockout credit. */
const damagedAt = new Map();
/** `sim` this life began, how many we have played, and whether this one is
 *  still unbeaten. */
let lifeStartedAt = 0;
let lives = 0;
let wonThisLife = false;
/** `sim` we hit 0%, so we know how long we have been down. */
let downedAt = -Infinity;
/** Squadmate we are currently towelling off: { id, since }. */
let reviving = null;
/** Rolling autosave, and the wall clock the session started on. */
let lastSkillSaveAt = 0;
const startedWallMs = Date.now();
/** The last fight we saw or heard: { x, z, t }. See `HEARING`. */
let lastGunfire = null;
/** Where the rival we were fighting was standing when we lost them. */
let lastFoeAt = null;
/** So two bots in one lobby do not strafe in lockstep like a chorus line. */
const strafePhase = Math.random() * Math.PI * 2;

/** Rolling chat backlog handed to the reply seam. */
const chatMemory = [];

/** Who we are following, so we only narrate changes. */
let leaderId = null;

// ---------------------------------------------------------------- channel

/** Set by connect(). Null under --selftest, and every writer checks `online`
 *  before touching it, so the brain runs identically with no socket at all. */
let supabase = null;
let channel = null;

/** Look a peer up, creating the record on first sighting. Mirrors net.ts's
 *  `record()` so presence-only peers exist before their first pose. */
function peer(id) {
  let p = peers.get(id);
  if (!p) {
    p = {
      id,
      name: "player",
      team: null,
      agent: false,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      dry: 100,
      state: "ground",
      posed: false,
      lastSeen: sim,
    };
    peers.set(id, p);
  }
  return p;
}

/**
 * Humans on our squad, sorted nearest first. Agents are excluded so two copies
 * of this bot in one lobby never end up orbiting each other.
 *
 * Soaked squadmates sort behind living ones rather than out of the list.
 * Skipping them outright was right in spirit — do not shadow a spectator while
 * a teammate is still playing — and wrong the moment nobody is playing: a
 * client sitting on the end card keeps publishing poses at `dry: 0`, so after
 * one finished match the bot saw `peers 1`, found no living squadmate, and
 * stood in a field forever. Following someone who is out beats following no
 * one, and the instant they respawn dry they sort back to the front.
 */
function squadmates() {
  const living = [];
  const out = [];
  for (const p of peers.values()) {
    if (p.agent || !p.posed) continue;
    if (TEAM && p.team && foldTeam(p.team) !== TEAM) continue;
    (p.dry > 0 ? living : out).push(p);
  }
  const list = living.length > 0 ? living : out;
  list.sort((a, b) => dist2(me.x, me.z, a.x, a.z) - dist2(me.x, me.z, b.x, b.z));
  return list;
}

/** Anyone at all, for callouts and win detection. */
function livingPeers(sameTeam) {
  const out = [];
  for (const p of peers.values()) {
    if (!p.posed || p.dry <= 0) continue;
    const mate = !!TEAM && foldTeam(p.team) === TEAM;
    if (sameTeam === undefined || mate === sameTeam) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- scoring
//
// The learner needs one number per fight, and the wire will not give it to us
// directly — nobody broadcasts "you dealt 36". So we keep the books ourselves:
// what we know we landed (we sent it), what landed on us (it was addressed to
// us), and who was still standing at the end.
//
// It is honest bookkeeping rather than perfect bookkeeping. A victim's own
// client owns the truth about its dryness and may refuse a hit we counted; a
// rival soaked by someone else three seconds after we shot them is credited to
// us. Both blur the reward a little, and neither blurs it in a direction that
// rewards playing badly, which is the only property the bandit actually needs.

/** Open, or extend, the engagement with `id`. */
function contact(id, name) {
  if (!engagement || engagement.id !== id) {
    closeEngagement();
    engagement = { id, name: name || "someone", dealt: 0, taken: 0, knockout: 0, last: sim, since: sim };
  }
  engagement.last = sim;
  return engagement;
}

/** Bank the current engagement against the plan that fought it. */
function closeEngagement(died = false) {
  if (!engagement) return;
  const e = engagement;
  engagement = null;
  // A fight nobody landed anything in is not evidence about anything.
  if (e.dealt <= 0 && e.taken <= 0 && !died) return;
  const reward = skill.engagement(plan, {
    dealt: e.dealt,
    taken: e.taken,
    knockout: e.knockout,
    died,
  });
  log.event(
    `engagement with ${e.name}: dealt ${Math.round(e.dealt)}, took ${Math.round(e.taken)}` +
      `${e.knockout ? `, ${e.knockout} soaked` : ""}${died ? ", and lost" : ""} — reward ${reward.toFixed(2)}`,
  );
}

/** Soak that landed on us, from wherever. */
function noteTaken(amount, fromId, fromName) {
  if (!(amount > 0)) return;
  const e = contact(fromId ?? "unknown", fromName);
  e.taken += amount;
}

/** Soak we landed. */
function noteDealt(amount, p) {
  const e = contact(p.id, p.name);
  e.dealt += amount;
  damagedAt.set(p.id, sim);
}

/**
 * Start a life. Called on the first placement and on every new match after.
 *
 * This is where a new plan is drawn, which is why it is one call and not
 * three: a plan that changed halfway through a life would be credited with
 * fights it never fought.
 */
function beginLife(why) {
  closeEngagement();
  // The life that just ended was a match, and it was one we either won or
  // didn't. Counted here rather than at either of the two places a life can
  // end, so it is counted exactly once however we got here.
  if (lives > 0) {
    skill.match(wonThisLife);
    log.info(
      `last life: ${Math.round(sim - lifeStartedAt)}s, ${wonThisLife ? "last one dry" : "soaked out"}`,
    );
  }
  lives += 1;
  me.dry = 100;
  me.state = "ground";
  announcedOut = false;
  downedAt = -Infinity;
  wonThisLife = false;
  tank = GUN_TANK;
  lastSoakedAt = -Infinity;
  burstShots = 0;
  burstUntil = -1;
  damagedAt.clear();
  reviving = null;
  lastFoeAt = null;
  lifeStartedAt = sim;
  plan = skill.plan();
  skill.life();
  log.info(
    `new life — ${why}. plan: ` +
      Object.entries(plan)
        .map(([k, v]) => `${k} ${v}`)
        .join(", "),
  );
}

/**
 * Did the lobby roll into a new match without us?
 *
 * There is no match-start event on the wire — `NetEventKind` has no such kind
 * and inventing one would mean shipping a game change to run a bot. So we
 * infer it, from the one thing a new match always does: everybody who was
 * soaked out is suddenly dry again.
 *
 * Being wrong is cheap in one direction and not the other. A false positive
 * puts a soaked bot back in a match it should be watching — mildly rude. A
 * false negative is what this file did for its whole life before now: stand in
 * a field for eleven hours. So the test is deliberately generous.
 */
function maybeNewMatch(p, wasDry) {
  if (me.dry > 0) return;
  if (wasDry <= 0 && p.dry >= 90) {
    beginLife(`${p.name} respawned — new match`);
  }
}

/** The same question, asked from the tick, for the case where nobody around us
 *  ever went to zero: we have simply been out a long time and everyone we can
 *  see is dry. Also covers an empty lobby — with nobody left to watch, sitting
 *  out is pointless. */
function watchForNewMatch() {
  if (me.dry > 0 || sim - downedAt < NEW_MATCH_PATIENCE) return;
  const seen = [...peers.values()].filter((p) => p.posed);
  const allDry = seen.length > 0 && seen.every((p) => p.dry >= 90);
  if (allDry || seen.length === 0) {
    beginLife(seen.length === 0 ? "lobby is empty — back on my feet" : "everyone is dry again");
  }
}

/**
 * Test seam. `--selftest` runs with no socket, so everything below would be
 * dropped on the floor and the gun's checks would have nothing to read. The
 * selftest swaps in a collector; in a real match this stays null and costs a
 * single null check per event.
 */
const wire = { send: null };

function sendEvent(kind, payload) {
  if (wire.send) {
    wire.send(kind, payload);
    return;
  }
  if (!online || !channel) return;
  void channel
    .send({ type: "broadcast", event: "ev", payload: { i: SELF_ID, k: kind, p: payload } })
    .catch(() => {});
}

/** Say something out loud, respecting the cooldown. `force` is for the
 *  moments that matter more than politeness (getting soaked, the win). */
function say(text, force = false) {
  const body = String(text ?? "").trim().slice(0, 240);
  if (!body) return;
  if (!force && sim - lastChatAt < CHAT_COOLDOWN) return;
  lastChatAt = sim;
  chatMemory.push({ name: NAME, text: body, self: true, t: sim });
  if (chatMemory.length > CHAT_MEMORY) chatMemory.shift();
  log.say(`${c("1", NAME)}: ${body}`);
  sendEvent("chat", { text: body, name: NAME });
}

// ---------------------------------------------------------------- the reply seam
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │  THE SEAM. This is the only place the teammate's *words* come from.  │
// │  Everything above and below is transport and legs.                   │
// │                                                                      │
// │  It is a stub: canned lines chosen by keyword, so the bot ships and  │
// │  plays today with no API key, no network round trip and no latency   │
// │  inside a 20 Hz loop. Upgrading it to a real model call is a change  │
// │  to this one function and nothing else — it is already `async`, it   │
// │  already receives the conversation and a snapshot of the match, and  │
// │  every caller already awaits it and tolerates `null` ("say nothing").│
// │                                                                      │
// │  To make it real:                                                    │
// │                                                                      │
// │    npm i @anthropic-ai/sdk        // not yet a dependency of this repo
// │                                                                      │
// │    import Anthropic from "@anthropic-ai/sdk";                        │
// │    const anthropic = new Anthropic();  // reads ANTHROPIC_API_KEY     │
// │                                                                      │
// │    const res = await anthropic.messages.create({                     │
// │      model: "claude-opus-5",                                         │
// │      max_tokens: 120,                                                │
// │      thinking: { type: "adaptive" },                                 │
// │      output_config: { effort: "low" },   // it's a water fight        │
// │      system: PERSONA + `\nMatch state: ${JSON.stringify(world)}`,     │
// │      messages: history.map((m) => ({                                 │
// │        role: m.self ? "assistant" : "user",                          │
// │        content: m.self ? m.text : `${m.name}: ${m.text}`,            │
// │      })),                                                            │
// │    });                                                               │
// │    const out = res.content.find((b) => b.type === "text")?.text;      │
// │    return out ? out.trim().slice(0, 240) : null;                      │
// │                                                                      │
// │  Two things to keep when you do: cap the reply length (a squadmate    │
// │  who monologues mid-fight is worse than one who says nothing), and    │
// │  keep the call off the tick — `await` it from the chat handler, as    │
// │  now, never from `tick()`.                                           │
// └──────────────────────────────────────────────────────────────────────┘

/** Personality, in one place, so the stub and any future model call agree. */
const PERSONA =
  `You are ${NAME}, a third squadmate in SOAKED — a water-gun battle royale. ` +
  `Your teammates are humans. Be brief (one short sentence), warm, and useful: ` +
  `callouts, quick reactions, and real answers when spoken to. Never lecture, ` +
  `never explain the game, never use more than one sentence.`;

const GREETINGS = [
  "Hey! I'm on your six.",
  "Here. Right behind you.",
  "Present and extremely dry.",
];
const STATUS_LINES = [
  "Still dry, still following.",
  "Behind you and mostly unsoaked.",
  "Holding formation. Say the word.",
];
const AGREE = ["On it.", "Yep, moving.", "With you.", "Got it."];
const IDLE = [
  "Quiet out here.",
  "Nothing on me yet.",
  "I'll keep an eye behind us.",
];
const rotate = (arr, salt = 0) => arr[Math.floor((sim / 3 + salt) % arr.length)];

/**
 * Decide what — if anything — to say.
 *
 * @param {object} msg     { name, text, from, direct }  the line we're answering,
 *                         or a synthetic { kind } line for a game event.
 * @param {object[]} history  recent chat, oldest first, `self` marks our own.
 * @param {object} world   { dry, leader, teammates, rivals, zone, soaked }
 * @returns {Promise<string|null>}  the reply, or null to stay quiet.
 */
async function replyTo(msg, history, world) {
  // ---- game-event reactions -------------------------------------------
  if (msg.kind) {
    switch (msg.kind) {
      case "teammate-soaked":
        return `${msg.who} is out — I'll cover the angle.`;
      case "self-soaked":
        return "That's me, I'm soaked. Go get 'em.";
      case "glued":
        return msg.who === NAME
          ? "I'm glued, give me a second."
          : `${msg.who} just got glued — go help.`;
      case "victory":
        return "That's the match. We stayed dry. Good squad.";
      case "callout":
        return `Someone's soaking us from the ${msg.dir}${msg.far ? ", a way out" : ""}.`;
      case "zone":
        return "Downpour's closing — moving to the dry side.";
      case "joined":
        return rotate(GREETINGS);
      default:
        return null;
    }
  }

  // ---- answering a human ----------------------------------------------
  const t = (msg.text || "").toLowerCase();

  if (/\b(hi|hey|hello|yo|sup)\b/.test(t)) return rotate(GREETINGS);
  if (/\b(where are you|where r u|where u at|status|you ok|you good)\b/.test(t)) {
    if (world.leader) {
      return `Right behind ${world.leader.name}, ${Math.round(world.leader.dist)} m back.`;
    }
    return "Can't see anyone yet — tell me where to go.";
  }
  if (/\b(how dry|how wet|hp|health|dry\?)\b/.test(t)) {
    return `${Math.round(world.dry)}% dry.`;
  }
  if (/\b(follow|come|with me|on me|stack|regroup)\b/.test(t)) return rotate(AGREE, 1);
  if (/\b(wait|hold|stop|stay)\b/.test(t)) return "Holding.";
  if (/\b(glue|glue gun)\b/.test(t)) return "Glue 'em and they stumble. Very rude. Do it.";
  if (/\b(balloon|balloons)\b/.test(t)) return "Balloons arc — lead them a little.";
  if (/\b(zone|storm|rain|downpour|circle)\b/.test(t)) {
    return world.zone ? "Zone's that way, I'm heading in." : "I don't have the zone — call it and I'll move.";
  }
  if (/\b(how many|who's left|whos left|alive)\b/.test(t)) {
    return `${world.rivals} others still dry that I can see.`;
  }
  if (/\b(gg|good game|nice|well played|wp)\b/.test(t)) return "gg — that was fun.";
  if (/\b(sorry|my bad|oops)\b/.test(t)) return "All good.";
  if (/\b(thanks|thank you|ty)\b/.test(t)) return "Anytime.";
  if (/\b(help|save me|revive|down)\b/.test(t)) return "Coming to you.";

  // A direct question we have no canned answer for still deserves *something*
  // — silence from a named teammate reads as broken, not as thoughtful.
  if (msg.direct) {
    if (t.includes("?")) return "Not sure — but I'm right here if you need cover.";
    return rotate(AGREE, 2);
  }

  // Not addressed to us: mostly stay out of the way.
  if (t.includes("?") && Math.random() < 0.35) return rotate(STATUS_LINES);
  return null;
}

// ---------------------------------------------------------------- world snapshot

/** The small view of the match the reply seam gets. Deliberately tiny — it is
 *  what a model would be handed, and it should stay cheap to serialise. */
function worldSnapshot() {
  const leader = peers.get(leaderId);
  return {
    dry: me.dry,
    leader: leader
      ? { name: leader.name, dist: dist2(me.x, me.z, leader.x, leader.z), dry: leader.dry }
      : null,
    teammates: livingPeers(true).length,
    rivals: livingPeers(false).length,
    zone: zone ? { x: zone.x, z: zone.z, r: zone.r } : null,
    soaked: me.dry <= 0,
    /** Soak we have landed this session — the bot's own match, in one number. */
    dealt: Math.round(soakedByUs),
  };
}

/** Route a message through the seam and speak the result, if any. */
async function consider(msg, force = false) {
  try {
    const out = await replyTo(msg, chatMemory.slice(), worldSnapshot());
    if (out) say(out, force);
  } catch (err) {
    // A broken reply function must never take the bot off the field.
    log.warn(`reply failed: ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------- inbound

function onPose(w) {
  if (!w || typeof w.i !== "string" || w.i === SELF_ID) return;
  if (!Number.isFinite(w.x) || !Number.isFinite(w.y) || !Number.isFinite(w.z)) return;
  const p = peer(w.i);
  const firstPose = !p.posed;
  const wasDry = p.dry;

  // ---- bug watch -------------------------------------------------------
  // Everything the bot sees goes past here ten times a second per player, so
  // this is the cheapest place in the system to notice the game misbehaving.
  // Counted rather than logged: see `skill.bug`.
  if (!firstPose) {
    const jump = dist2(p.x, p.z, w.x, w.z);
    // A sprint is 6.9 m/s and the drop is a fall, so a tenth of a second is
    // metres. Two hundred is not a movement, it is a desync or a quick travel
    // the wire has no word for.
    if (jump > 200) {
      skill.bug("peer-position-jump", `${p.name} moved ${Math.round(jump)} m between poses`);
    }
  }
  if (Number.isFinite(w.d) && (w.d < 0 || w.d > 100)) {
    skill.bug("dryness-out-of-range", `${w.n ?? p.name} published ${w.d}%`);
  }
  if (w.a !== undefined && !Number.isFinite(w.a)) {
    skill.bug("pose-yaw-not-finite", `${w.n ?? p.name}`);
  }

  if (w.n) p.name = w.n;
  if (w.t !== undefined) p.team = w.t || null;
  if (w.g) p.agent = true;
  p.x = w.x;
  p.y = w.y;
  p.z = w.z;
  p.yaw = Number.isFinite(w.a) ? w.a : p.yaw;
  p.state = typeof w.s === "string" ? w.s : p.state;
  if (Number.isFinite(w.d)) p.dry = clamp(w.d, 0, 100);
  p.posed = true;
  p.lastSeen = sim;

  if (firstPose) {
    log.net(`${c("1", p.name)} is on the field (${p.team ?? "no team"})`);
  }

  // Someone we were shooting has gone to zero. Their own client owns that
  // truth, so this is the moment we learn it — and if we were the ones soaking
  // them a moment ago, the fight we are in the middle of scoring gets the
  // credit. (`soaked` events give us the same news; whichever arrives first
  // wins, and `damagedAt.delete` keeps it from counting twice.)
  if (wasDry > 0 && p.dry <= 0) creditKnockout(p);

  // The lobby may have rolled into a new match while we were sitting out.
  maybeNewMatch(p, wasDry);

  // First time we can see a human, appear beside the squad rather than
  // sprinting in from the origin — we have no terrain data, so their
  // position is the only place we know is standable.
  if (!placed && !p.agent) {
    placed = true;
    me.x = p.x - 2.4;
    me.y = p.y;
    me.z = p.z - 2.4;
    anchor = { x: me.x, z: me.z, t: sim };
    log.move(`spawned beside ${p.name} at ${q(me.x)}, ${q(me.z)}`);
    void consider({ kind: "joined" }, true);
  }

  // ...but the *life* starts on the first peer of any kind. These used to be
  // the same branch, which meant a lobby of nothing but agents — two of these
  // sparring, which is now a thing that happens — played a whole match that
  // the notebook never saw: no plan drawn, no life counted, every engagement
  // credited to whatever the default settings happened to be.
  if (lives === 0) beginLife(`${p.name} is on the field`);
}

/**
 * Zero dryness. A slump, not an ending.
 *
 * `mode/water.ts` is clear about this — `downThreshold: 0`, `reviveDryness:
 * 30` — and so is `play/player.ts`, which puts a human at zero into `down` and
 * stands them back up if anything heals them. The bot now models the same
 * thing: it goes quiet and stays put, but it is a body on the floor rather
 * than a process that has finished, and either a towel or the next match
 * brings it back.
 */
function goDown(byId) {
  if (announcedOut) return;
  announcedOut = true;
  // Belt and braces: every caller today has already reached zero, and a
  // `down` state sitting on top of a positive dryness would be a bot that is
  // lying on the floor and cannot be revived, respawned or soaked out of it.
  me.dry = 0;
  me.state = "down";
  me.vx = 0;
  me.vz = 0;
  downedAt = sim;
  reviving = null;
  closeEngagement(true);
  sendEvent("soaked", { id: SELF_ID, name: NAME, by: byId });
  void consider({ kind: "self-soaked" }, true);
}

/** Count a knockout if we soaked them inside CREDIT_WINDOW. */
function creditKnockout(p) {
  const hit = damagedAt.get(p.id);
  if (hit === undefined || sim - hit > CREDIT_WINDOW) return;
  damagedAt.delete(p.id);
  const e = contact(p.id, p.name);
  e.knockout += 1;
  log.event(`${c("1", p.name)} is soaked out — that one was ours`);
}

function onEvent(w) {
  if (!w || typeof w.i !== "string" || w.i === SELF_ID) return;
  const from = peers.get(w.i);
  if (from) from.lastSeen = sim;
  const payload = w.p ?? {};
  const who = from?.name ?? "someone";

  switch (w.k) {
    case "chat": {
      const text = String(payload.text ?? "").slice(0, 280);
      if (!text) return;
      const name = String(payload.name ?? who);
      chatMemory.push({ name, text, self: false, t: sim, from: w.i });
      if (chatMemory.length > CHAT_MEMORY) chatMemory.shift();
      log.chat(`${c("1", name)}: ${text}`);
      // Down, not gone: we still answer when spoken to — being ignored by the
      // teammate lying at your feet is worse than a bot that talks too much —
      // but we no longer chime in on chatter the squad is having without us.
      const named = NAME_RE.test(text) || /\bclaude\b/i.test(text);
      if (me.dry <= 0 && !named) return;
      const direct = named;
      // Being named shortens the cooldown; that is the whole difference
      // between "a bot in the lobby" and "someone who is listening".
      if (direct && sim - lastChatAt >= CHAT_COOLDOWN_DIRECT) {
        void consider({ name, text, from: w.i, direct: true }, true);
      } else {
        void consider({ name, text, from: w.i, direct: false });
      }
      return;
    }

    case "splash": {
      // A splash near us soaks us; a splash near a teammate is a callout.
      const { x, y, z } = payload;
      if (![x, z].every(Number.isFinite)) return;
      const dMe = Math.hypot(me.x - x, me.z - z, (me.y - (y ?? me.y)) * 0.5);
      const mate = !!TEAM && foldTeam(from?.team) === TEAM;
      // `amount: 0` means "this is a decal, the damage was addressed
      // separately" — which is exactly what this file sends with every shot
      // it lands. Treating it as proximity damage cost nothing (zero soak is
      // zero soak) but logged a phantom hit beside every real one.
      const soak = Number.isFinite(payload.amount) ? payload.amount : SPLASH_SOAK;
      if (!mate && soak > 0 && dMe < SPLASH_RADIUS && me.dry > 0) {
        me.dry = clamp(me.dry - soak, 0, 100);
        lastSoakedAt = sim;
        noteTaken(soak, w.i, who);
        log.event(`splashed by ${who} — ${Math.round(me.dry)}% dry`);
        if (me.dry <= 0) goDown(w.i);
        return;
      }
      if (!mate) {
        hear(x, z);
        maybeCallout(x, z, from);
      }
      return;
    }

    case "hit": {
      // Addressed water. `splash` is scenery we work out for ourselves from
      // proximity; this one names us, and it is how a human's soaker actually
      // costs us dryness now that ghosts are real damage targets.
      if (payload.to !== SELF_ID) return;
      if (me.dry <= 0) return;
      const mate = !!TEAM && foldTeam(from?.team) === TEAM;
      if (mate) return; // same squad can't soak us; the shooter should not have sent it
      const raw = Number.isFinite(payload.amount) ? payload.amount : SPLASH_SOAK;
      if (!(raw > 0)) return;
      // Same ceiling the browser applies to an inbound hit: no single packet
      // takes more than a quarter of us.
      const soak = Math.min(raw, 25);
      if (raw > 25) skill.bug("oversized-hit", `${who} sent ${Math.round(raw)} soak in one packet`);
      me.dry = clamp(me.dry - soak, 0, 100);
      lastSoakedAt = sim;
      noteTaken(soak, w.i, who);
      log.event(`hit by ${who} for ${Math.round(soak)} — ${Math.round(me.dry)}% dry`);
      if (me.dry <= 0) goDown(w.i);
      return;
    }

    case "shot": {
      // Tracers give the shooter's position away, which is exactly what a
      // callout is. Only interesting when it is near one of ours.
      const ox = payload.x ?? payload.ox;
      const oz = payload.z ?? payload.oz;
      if (![ox, oz].every(Number.isFinite)) return;
      if (TEAM && foldTeam(from?.team) === TEAM) return;
      hear(ox, oz);
      maybeCallout(ox, oz, from);
      return;
    }

    case "glue": {
      const target = payload.to ?? payload.target ?? payload.id;
      if (target === SELF_ID) {
        stumbleUntil = sim + GLUE_STUMBLE;
        log.event(`glued by ${who} — stumbling`);
        void consider({ kind: "glued", who: NAME }, true);
      } else {
        const victim = peers.get(target);
        log.event(`${who} glued ${victim?.name ?? "someone"}`);
        void consider({ kind: "glued", who: victim?.name ?? "someone" });
      }
      return;
    }

    case "soaked": {
      const id = payload.id ?? w.i;
      const p = peers.get(id);
      if (p) {
        creditKnockout(p);
        p.dry = 0;
      }
      const name = p?.name ?? payload.name ?? who;
      log.event(`${name} is soaked`);
      const mate = !!TEAM && foldTeam(p?.team) === TEAM;
      if (mate) void consider({ kind: "teammate-soaked", who: name }, true);
      // Nobody publishes a "victory" event, so infer it: our squad is still
      // dry and there is nobody left who isn't on it.
      if (me.dry > 0 && livingPeers(false).length === 0 && livingPeers(true).length > 0) {
        if (!wonThisLife) {
          wonThisLife = true;
          skill.match(true);
        }
        void consider({ kind: "victory" }, true);
      }
      return;
    }

    case "revive": {
      const id = payload.id ?? payload.target;
      // Addressed to us: stand up. Nothing in the browser sends this yet —
      // `revive` is a declared NetEventKind with no publisher — so today this
      // only ever fires from another agent. It costs one comparison and it
      // means the day somebody wires the towel up to the wire, the bot is
      // already a thing you can save.
      if (id === SELF_ID) {
        if (me.dry > 0) return;
        me.dry = REVIVE_DRY;
        me.state = "ground";
        announcedOut = false;
        downedAt = -Infinity;
        lastSoakedAt = sim;
        log.event(`${who} towelled us off — back up at ${REVIVE_DRY}%`);
        say(`Thanks ${who} — back up.`, true);
        return;
      }
      const p = peers.get(id);
      if (p) p.dry = Math.max(p.dry, REVIVE_DRY);
      log.event(`${who} towelled off ${p?.name ?? "a squadmate"}`);
      return;
    }

    case "ping": {
      // The engine has no zone broadcast (see "The downpour"), so a ping that
      // happens to carry one is adopted. Harmless when it doesn't.
      const z0 = payload.zone ?? (payload.kind === "zone" ? payload : null);
      if (z0 && [z0.x, z0.z, z0.r].every(Number.isFinite)) {
        zone = { x: z0.x, z: z0.z, r: z0.r };
        log.event(`zone from ${who}: ${q(zone.x)}, ${q(zone.z)} r${q(zone.r)}`);
        void consider({ kind: "zone" });
        return;
      }
      if (Number.isFinite(payload.x) && Number.isFinite(payload.z)) {
        log.event(`${who} pinged ${bearing(me.x, me.z, payload.x, payload.z)}`);
      }
      return;
    }

    default:
      // balloon / build / harvest / emote — nothing to say about those. A
      // kind that is *not* one of those is either a game that has grown a new
      // message this file has not been taught, or a malformed packet; both are
      // worth a line in the notebook and neither is worth a crash.
      if (!KNOWN_EVENT_KINDS.has(w.k)) {
        skill.bug("unknown-event-kind", `"${String(w.k).slice(0, 32)}" from ${who}`);
      }
      return;
  }
}

/** `NET_EVENT_KINDS` from `src/royale/net/types.ts`. Copied for the same
 *  reason `normalizeRoomCode` is: this is a script, that is a TS module. */
const KNOWN_EVENT_KINDS = new Set([
  "shot",
  "splash",
  "balloon",
  "glue",
  "build",
  "harvest",
  "hit",
  "soaked",
  "revive",
  "emote",
  "chat",
  "ping",
]);

/** Note a fight we could plausibly see or hear from where we are standing. */
function hear(x, z) {
  if (![x, z].every(Number.isFinite)) return;
  if (dist2(me.x, me.z, x, z) > HEARING) return;
  lastGunfire = { x, z, t: sim };
}

/** Call out an enemy position, at most once every CALLOUT_COOLDOWN. */
function maybeCallout(x, z, from) {
  if (sim - lastCalloutAt < CALLOUT_COOLDOWN) return;
  const mates = squadmates();
  const near = mates.length ? dist2(mates[0].x, mates[0].z, x, z) : dist2(me.x, me.z, x, z);
  if (near > 45) return; // not our fight
  lastCalloutAt = sim;
  const d = dist2(me.x, me.z, x, z);
  log.event(`callout: fire from ${bearing(me.x, me.z, x, z)} (${Math.round(d)} m)`);
  void consider({ kind: "callout", dir: bearing(me.x, me.z, x, z), far: d > 25 }, true);
}

function onPresenceSync() {
  const state = channel.presenceState();
  const keys = new Set(Object.keys(state));
  for (const key of keys) {
    if (key === SELF_ID) continue;
    const meta = state[key]?.[0];
    if (!meta) continue;
    const p = peer(key);
    if (meta.name) p.name = meta.name;
    if (meta.team !== undefined) p.team = meta.team ?? p.team;
    p.agent = !!meta.agent || p.agent;
    p.lastSeen = sim;
  }
  for (const id of [...peers.keys()]) {
    if (!keys.has(id)) {
      const gone = peers.get(id);
      peers.delete(id);
      log.net(`${gone?.name ?? id} left`);
      if (id === leaderId) leaderId = null;
    }
  }
}

/**
 * Open the lobby socket. Resolves true, or a short reason string — every
 * failure here is expected and survivable, so nothing throws.
 */
async function connect() {
  let mod;
  try {
    mod = await import("@supabase/supabase-js");
  } catch (err) {
    bail(
      "@supabase/supabase-js could not be loaded, so there is no way into the lobby.",
      `Run "npm install" in ${REPO} first. (${err?.message ?? err})`,
    );
  }

  supabase = mod.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 24 } },
  });

  channel = supabase.channel(`splash-${ROOM}`, {
    config: {
      presence: { key: SELF_ID },
      broadcast: { self: false, ack: false },
    },
  });

  channel.on("presence", { event: "sync" }, onPresenceSync);
  channel.on("broadcast", { event: "pose" }, ({ payload }) => onPose(payload));
  channel.on("broadcast", { event: "ev" }, ({ payload }) => onEvent(payload));

  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (ok, why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(ok ? true : why || "closed");
    };
    const timer = setTimeout(() => finish(false, "timed out"), CONNECT_TIMEOUT_MS);
    channel.subscribe((st, err) => {
      if (st === "SUBSCRIBED") finish(true);
      else if (st === "CHANNEL_ERROR") finish(false, err?.message || "channel error");
      else if (st === "TIMED_OUT") finish(false, "timed out");
      else if (st === "CLOSED") finish(false, "closed");
    });
  });
}

// ---------------------------------------------------------------- the brain
//
// A follower, not a duelist. The brief was "it needs to feel like someone is
// there", and what makes that read is holding a sensible slot, keeping up
// without shoving, and not walking into walls forever.

/** The rival we are fighting, if that is still a live fact. */
function currentFoe() {
  const foe = aimId ? peers.get(aimId) : null;
  if (!foe || !foe.posed || foe.dry <= 0) return null;
  if (sim - foe.lastSeen > GUN_STALE) return null;
  if (me.dry <= 0) return null;
  return foe;
}

/**
 * Where to stand while fighting someone — the learned part of combat, and the
 * part that separates a bot that walks into your stream from one that is
 * annoying to hit.
 *
 * Two stances, and which one we are in is the single most consequential
 * decision in the mode:
 *
 *   press — hold near the edge of our own engagement range, sliding sideways.
 *           Being at range is a choice with a cost: less soak lands, but less
 *           soak lands on us, and the gun's falloff does not start until 45 m
 *           so it costs nothing at all inside that.
 *   break — get `breakDist` away and dry off. `DRYNESS.dryWindBonus` means
 *           sprinting out of a fight dries you a third faster than standing
 *           in one, so retreating is not giving up, it is the mechanic.
 *
 * `pushDry` is the threshold between them and it is learned, because the right
 * answer depends entirely on who you are playing with: a squad that trades
 * hard wants a bot that stays in, a squad that plays for the last circle wants
 * one that leaves at 70%.
 */
function combatPoint(foe) {
  const d = Math.max(dist2(me.x, me.z, foe.x, foe.z), 0.001);
  // Unit vector pointing from them to us — the way out.
  const ux = (me.x - foe.x) / d;
  const uz = (me.z - foe.z) / d;

  if (me.dry < fair("pushDry")) {
    const want = fair("breakDist");
    return { x: foe.x + ux * want, z: foe.z + uz * want, urgent: true, purposeful: true, combat: "break" };
  }

  // Hold just inside our own range, and never let "hold" mean "walk into
  // them" — PERSONAL_SPACE is about teammates, this is about not hugging the
  // person soaking us.
  const hold = Math.max(fair("engageRange") * 0.8, 6);
  const amp = fair("strafeAmp");
  const wob = Math.sin(sim * 1.35 + strafePhase) * amp;
  return {
    x: foe.x + ux * hold - uz * wob,
    z: foe.z + uz * hold + ux * wob,
    urgent: false,
    purposeful: true,
    combat: "press",
  };
}

/**
 * Where we would like to be standing.
 *
 * Priority: the downpour when it has us outside it, then the fight we are in,
 * then a squadmate on the floor, then a slot behind whichever squadmate is
 * nearest, then — with nobody at all — the sound of gunfire.
 */
function desiredPoint() {
  // The downpour. The engine does not broadcast the circle on the wire (there
  // is no such NetEventKind), so we only know it from `--zone` or a peer's
  // ping. When we do know it and we're outside, it beats everything.
  if (zone) {
    const d = dist2(me.x, me.z, zone.x, zone.z);
    if (d > zone.r * 0.85) {
      const k = (zone.r * 0.6) / Math.max(d, 0.001);
      return {
        x: me.x + (zone.x - me.x) * (1 - k),
        z: me.z + (zone.z - me.z) * (1 - k),
        urgent: true,
      };
    }
  }

  // A fight beats formation. Everything below this is about where to stand
  // when nobody is shooting at us.
  const foe = currentFoe();
  if (foe) {
    lastFoeAt = { x: foe.x, z: foe.z, t: sim };
    return combatPoint(foe);
  }

  // Contact broken while still wet. Keep going until we are `breakDist` from
  // where they were: turning round the instant someone leaves our engagement
  // range is how a bot gets finished off by the player it just ran from, and
  // the drying clock has barely started.
  if (lastFoeAt && me.dry < fair("pushDry") && sim - lastFoeAt.t < 10) {
    const d = Math.max(dist2(me.x, me.z, lastFoeAt.x, lastFoeAt.z), 0.001);
    const want = fair("breakDist");
    if (d < want) {
      return {
        x: lastFoeAt.x + ((me.x - lastFoeAt.x) / d) * want,
        z: lastFoeAt.z + ((me.z - lastFoeAt.z) / d) * want,
        urgent: true,
        purposeful: true,
        combat: "break",
      };
    }
  }

  const mates = squadmates();

  // A squadmate on the floor is the most valuable place on the map: standing
  // over them for REVIVE_TIME is worth more than any slot behind anybody.
  const downed = mates.find((p) => p.dry <= 0);
  if (downed && me.dry > 0) {
    idleHome = null;
    return { x: downed.x + 1.2, z: downed.z + 1.2, urgent: true, purposeful: true, revive: downed.id };
  }

  if (mates.length === 0) {
    // Nobody on our squad. That used to mean "stop playing" — shuffle on the
    // spot until the process is killed — which is how this file spent eleven
    // hours in an empty field once. It is still a match, and there is still a
    // right thing to do in it.
    //
    // Rotating toward gunfire is that thing, and it is honest: tracers and
    // splashes are things a player genuinely sees and hears from a long way
    // off, unlike the exact position of a silent rival behind a hill, which
    // is on our wire and stays out of our decisions. See `HEARING`.
    if (lastGunfire && sim - lastGunfire.t < GUNFIRE_MEMORY) {
      const d = dist2(me.x, me.z, lastGunfire.x, lastGunfire.z);
      if (d > 14) {
        idleHome = null;
        const k = 12 / Math.max(d, 0.001);
        return {
          x: me.x + (lastGunfire.x - me.x) * (1 - k),
          z: me.z + (lastGunfire.z - me.z) * (1 - k),
          urgent: false,
          purposeful: true,
        };
      }
    }
    // Nothing to walk toward. Shift our weight around one spot so we don't
    // read as a frozen mannequin — but around a *remembered* spot, not around
    // wherever we happen to be standing.
    //
    // This used to offset from `me.x`/`me.z`, which made the target move with
    // us: a random walk with no way home. An empty lobby wandered 63 m in ten
    // minutes and would have kept going until it hit the fence.
    if (!idleHome) idleHome = { x: me.x, z: me.z };
    return {
      x: idleHome.x + Math.cos(sim * 0.23) * 2.2,
      z: idleHome.z + Math.sin(sim * 0.19) * 2.2,
      urgent: false,
      purposeful: false,
    };
  }
  idleHome = null;

  const lead = mates[0];
  if (lead.id !== leaderId) {
    leaderId = lead.id;
    log.move(`following ${lead.name}`);
  }
  // Behind them along their own facing, offset to one side. Standing behind
  // is what keeps us out of their firing line and out of their way.
  const fx = Math.sin(lead.yaw);
  const fz = Math.cos(lead.yaw);
  return {
    x: lead.x - fx * followDist() + fz * SLOT_SIDE,
    z: lead.z - fz * followDist() - fx * SLOT_SIDE,
    urgent: false,
  };
}

/**
 * May we appear beside the leader instead of walking?
 *
 * This is the one movement in the file that a player cannot perform, so it is
 * fenced to the one situation where the *game* moves a player the same way:
 * the drop bus. Everyone rides it, nobody walks to it, and it starts its run
 * about 2.4 km out and 600 m up — six solid minutes of sprinting, by which
 * time the match is decided and the squad has spent it alone.
 *
 * The test is therefore altitude, not distance. A leader hundreds of metres
 * above us is on the bus or under a canopy; a leader who is merely far away is
 * a run, and we run it. Before this, any 220 m gap teleported the bot —
 * including a squadmate quick-travelling across the island mid-fight, which is
 * a rival watching a teammate blink to the far side of the map. That is
 * cheating, however it was described in the comment above it.
 */
function mayRejoin(lead) {
  const gap = dist2(me.x, me.z, lead.x, lead.z);
  if (gap <= REJOIN_DIST) return false;
  // Not yet placed: our very first sighting, the same legitimate placement
  // `onPose` does, because we have no terrain and their ground is the only
  // ground we know is standable.
  if (!placed) return true;
  return lead.y - me.y > 60;
}

/** Drop peers that stopped talking without a presence goodbye. */
function reapPeers() {
  for (const [id, p] of peers) {
    if (sim - p.lastSeen > PEER_TIMEOUT) {
      peers.delete(id);
      damagedAt.delete(id);
      if (id === leaderId) leaderId = null;
      if (id === aimId) aimId = null;
      log.net(`lost ${p.name} (timed out)`);
    }
  }
}

/**
 * One brain tick.
 *
 * @param {number} dt simulated seconds since the last tick.
 */
function tick(dt) {
  // A pose that has gone non-finite is unrecoverable by arithmetic — every
  // subsequent frame inherits the NaN — and it is invisible from inside the
  // game: the ghost simply stops existing. Catch it here, put ourselves back
  // somewhere real, and write it down.
  if (![me.x, me.y, me.z, me.vx, me.vz, me.yaw].every(Number.isFinite)) {
    skill.bug("bot-pose-not-finite", "reset to the squad");
    const home = peers.get(leaderId) ?? idleHome ?? { x: 0, y: 0, z: 0 };
    me.x = Number.isFinite(home.x) ? home.x : 0;
    me.y = Number.isFinite(home.y) ? home.y : 0;
    me.z = Number.isFinite(home.z) ? home.z : 0;
    me.vx = 0;
    me.vz = 0;
    me.yaw = 0;
    anchor = { x: me.x, z: me.z, t: sim };
  }

  // Reaping runs whether or not we are playing. It used to sit at the bottom
  // of this function, below the early return below it, so a bot that got
  // soaked stopped noticing anybody leaving — it would still be "following"
  // and reporting `peers 3` for a lobby that had emptied an hour earlier.
  reapPeers();

  // Down. Stay put, stay quiet, let the squad play — but keep watching for
  // the next match, because a life ending is not the session ending.
  if (me.dry <= 0) {
    me.vx = 0;
    me.vz = 0;
    me.state = "down";
    aimId = null;
    closeEngagement();
    watchForNewMatch();
    return;
  }

  // An engagement nobody has touched for a while is over, win or lose.
  if (engagement && sim - engagement.last > ENGAGE_TIMEOUT) closeEngagement();

  // Rejoin. Some gaps cannot be walked, and pretending otherwise is what
  // "stuck — taking a detour" looks like for six minutes.
  //
  // The drop bus starts its run about 2.4 km out. At SPRINT_SPEED that is six
  // solid minutes of running, by which time the match is decided and the squad
  // has spent it alone. There is no drop mechanic here — we cannot ride the
  // bus — so the only honest way to be on the squad's screen when it matters
  // is to appear beside them, exactly as we already do on the very first pose
  // we ever see. That placement is legitimate for the same reason it is there:
  // with no terrain data, a teammate's position is the only ground we know is
  // standable. This just stops treating it as a one-time event.
  //
  // Never while the Downpour is pulling us, though. `goal.urgent` means we are
  // outside the circle and running for it, and a teammate standing in the rain
  // is not somewhere to appear — being together is worth less than being dry.
  let goal = desiredPoint();
  if (!goal.urgent && sim - lastRejoinAt > REJOIN_COOLDOWN) {
    const lead = peers.get(leaderId);
    if (lead && lead.posed && mayRejoin(lead)) {
      const gap = dist2(me.x, me.z, lead.x, lead.z);
      me.x = lead.x - SLOT_SIDE;
      me.z = lead.z - SLOT_SIDE;
      me.y = lead.y;
      me.vx = 0;
      me.vz = 0;
      anchor = { x: me.x, z: me.z, t: sim };
      detourUntil = 0;
      lastRejoinAt = sim;
      log.move(`too far to walk (${Math.round(gap)} m) — rejoining ${lead.name}`);
      // We moved; the slot we were steering for is stale.
      goal = desiredPoint();
    }
  }

  let dx = goal.x - me.x;
  let dz = goal.z - me.z;
  let d = Math.hypot(dx, dz);

  // Crude pathing. We have no terrain or collision data out here — the whole
  // world lives in the browser — so "path around obstacles" can only mean:
  // notice we have stopped making progress, and try going around. Two seconds
  // of consistent sidestep clears most walls and rock faces; if it doesn't,
  // the next window picks a fresh side.
  //
  // Only while we are actually trying to get somewhere. A bot idling in an
  // empty lobby cannot be stuck: it is orbiting a remembered spot at about
  // 0.5 m/s, which covers ~0.7 m in the 1.4 s window — under STUCK_DIST —
  // while the wobble target sits a metre or two off. That is every condition
  // for "stuck" met by a bot doing exactly what it was told, and it logged a
  // detour every few seconds into an empty room all night.
  const purposeful = goal.purposeful ?? (!!leaderId || !!zone);
  const moved = dist2(me.x, me.z, anchor.x, anchor.z);
  if (purposeful && sim - anchor.t > STUCK_WINDOW) {
    if (d > SLOT_DEADZONE && moved < STUCK_DIST && sim > detourUntil) {
      detourUntil = sim + DETOUR_TIME;
      detourSign = Math.random() < 0.5 ? -1 : 1;
      log.move("stuck — taking a detour");
    }
    anchor = { x: me.x, z: me.z, t: sim };
  } else if (!purposeful) {
    // Keep the anchor fresh while idle, or the first real goal after a quiet
    // spell is measured against where we were standing minutes ago.
    anchor = { x: me.x, z: me.z, t: sim };
  }
  if (sim < detourUntil && d > 0.001) {
    const a = Math.atan2(dx, dz) + DETOUR_ANGLE * detourSign;
    dx = Math.sin(a) * d;
    dz = Math.cos(a) * d;
  }

  // Desired velocity.
  let wantX = 0;
  let wantZ = 0;
  let speed = 0;
  if (d > SLOT_DEADZONE) {
    speed = d > SPRINT_AT || goal.urgent ? SPRINT_SPEED : WALK_SPEED;
    wantX = (dx / d) * speed;
    wantZ = (dz / d) * speed;
  }

  // Separation. Never end up standing inside a teammate — this is the rule
  // that stops the bot from being the thing that gets you soaked. The one
  // exception is the person we are trying to towel off: you cannot revive
  // someone you are politely keeping 2.4 m away from.
  for (const p of peers.values()) {
    if (!p.posed || p.id === goal.revive) continue;
    const sx = me.x - p.x;
    const sz = me.z - p.z;
    const sd = Math.hypot(sx, sz);
    if (sd > PERSONAL_SPACE || sd < 0.001) continue;
    const push = ((PERSONAL_SPACE - sd) / PERSONAL_SPACE) * WALK_SPEED * 1.4;
    wantX += (sx / sd) * push;
    wantZ += (sz / sd) * push;
    speed = Math.max(speed, WALK_SPEED);
  }

  // Glue leaves us stumbling: half speed and a wobble, which is the whole
  // joke of the weapon and should be visible to the person who fired it.
  const stumbling = sim < stumbleUntil;
  if (stumbling) {
    const wob = Math.sin(sim * 11) * 0.55;
    const wx = wantX * Math.cos(wob) - wantZ * Math.sin(wob);
    const wz = wantX * Math.sin(wob) + wantZ * Math.cos(wob);
    wantX = wx * 0.45;
    wantZ = wz * 0.45;
  }

  const k = 1 - Math.exp(-ACCEL * dt);
  me.vx += (wantX - me.vx) * k;
  me.vz += (wantZ - me.vz) * k;
  me.x += me.vx * dt;
  me.z += me.vz * dt;

  // Stay in the world whatever the steering says — but never let the fence
  // come between us and the person we are following.
  //
  // This clamp used to be unconditional, at 82% of the world half-extent. The
  // drop bus flies in from well outside it: a leader still on the bus sits at
  // something like x -2096, y 617, and the bot would sprint to its own edge
  // and grind against it for the whole flight, several hundred metres short,
  // logging "stuck — taking a detour" until the match ended. It never arrived,
  // and from inside the game it simply never showed up.
  const bound = leaderReach(ISLAND_HALF);
  me.x = clamp(me.x, -bound, bound);
  me.z = clamp(me.z, -bound, bound);

  // Altitude. We cannot sample the terrain from here, so we adopt the height
  // of whoever we are following — they are standing on ground we can't see,
  // and copying them is the difference between a teammate who walks the hills
  // with you and one who hovers through them.
  const lead = peers.get(leaderId);
  if (lead) me.y += (lead.y - me.y) * (1 - Math.exp(-Y_LERP * dt));

  // Shoot before we decide which way to face, so the aim wins the argument.
  const engaging = fireControl(dt);

  // Face what we are shooting; failing that, where we're going; failing that,
  // whatever the leader is looking at.
  const moving = Math.hypot(me.vx, me.vz);
  const target = engaging
    ? Math.atan2(engaging.x - me.x, engaging.z - me.z)
    : moving > 0.35
      ? Math.atan2(me.vx, me.vz)
      : lead
        ? lead.yaw
        : me.yaw;
  // Snap onto a target faster than we turn while strolling — a bot that takes
  // a second to face the person soaking it looks broken.
  me.yaw = turnToward(me.yaw, target, dt * (engaging ? 9 : 5));

  const sprinting = moving > WALK_SPEED * 1.1;
  me.state = stumbling ? "stumble" : sprinting ? "sprint" : "ground";

  // Aim up and down as well as around. `me.pitch` was declared, published on
  // every pose, and never once written to — so the ghost the humans see stared
  // dead level while soaking someone on a roof. Only while engaging: outside a
  // fight, a level head is right.
  const wantPitch = engaging
    ? Math.atan2(
        engaging.y + 1.0 - (me.y + 1.5),
        Math.max(dist2(me.x, me.z, engaging.x, engaging.z), 0.001),
      )
    : 0;
  me.pitch = clamp(turnToward(me.pitch, wantPitch, dt * 6), -1.2, 1.2);

  // Towel off, on the game's own terms: nothing for DRY_REGEN_DELAY seconds
  // after a soak, then DRY_REGEN a second, a third faster if we are sprinting.
  // (`DRYNESS.dryShelterBonus` needs a roof over our head, and roofs live in
  // the browser, so the bot never claims that one.)
  if (me.dry > 0 && sim - lastSoakedAt > DRY_REGEN_DELAY) {
    me.dry = clamp(me.dry + DRY_REGEN * (sprinting ? DRY_WIND_BONUS : 1) * dt, 0, 100);
  }

  // Towelling off a squadmate: stand over them, hold still for REVIVE_TIME.
  tickRevive(goal);
}

/**
 * Bring a downed squadmate back up.
 *
 * `goal.revive` is set by `desiredPoint` when the nearest squadmate is on the
 * floor. Reaching them is the hard part and it is already done by the time we
 * get here; this is the seven seconds of standing still, which is a real cost
 * and the reason reviving is a decision rather than a reflex.
 *
 * Worth knowing: no browser subscribes to `revive` today, so a human sees the
 * bot come to them and wait, and does not stand up. The gap is in the game,
 * not here — the event kind and the mode's `reviveTime`/`reviveDryness` are
 * both already declared — and this is the half of it that can be written
 * without touching a live route.
 */
function tickRevive(goal) {
  const id = goal?.revive;
  if (!id) {
    reviving = null;
    return;
  }
  const p = peers.get(id);
  if (!p || p.dry > 0) {
    reviving = null;
    return;
  }
  if (dist2(me.x, me.z, p.x, p.z) > REVIVE_REACH) {
    reviving = null;
    return;
  }
  if (!reviving || reviving.id !== id) {
    reviving = { id, since: sim };
    say(`Hold on ${p.name}, towelling you off.`, true);
    return;
  }
  if (sim - reviving.since < REVIVE_TIME) return;
  reviving = null;
  p.dry = REVIVE_DRY;
  sendEvent("revive", { id, target: id, by: SELF_ID, dryness: REVIVE_DRY });
  skill.revive();
  log.event(`towelled off ${p.name}`);
}

/**
 * Pick something to shoot, and shoot it.
 *
 * Returns the target we are engaging, so the caller can point us at them —
 * a bot that soaks people while facing the other way reads as a bug even
 * when the damage is right.
 *
 * Three things go on the wire per shot, and they are deliberately different
 * messages rather than one:
 *   `shot`   — the tracer, and what other bots read as a callout.
 *   `hit`    — the damage, addressed to the victim, who decides what it cost.
 *   `splash` — the wet mark on the ground, at `amount: 0`.
 *
 * That last zero matters. `splash` is scenery to a browser, which reads only
 * its radius and alpha, but a teammate bot still treats a nearby splash as
 * proximity damage — a fallback from before addressed hits existed. Sending
 * the default amount would soak the victim twice for one trigger pull.
 */
function fireControl(dt) {
  if (me.dry <= 0 || sim < stumbleUntil) {
    aimId = null;
    return null;
  }

  // Refill first: an empty tank is the only thing that stops us shooting.
  if (tank < GUN_TANK && sim - lastShotAt >= GUN_REFILL_DELAY) {
    tank = Math.min(GUN_TANK, tank + GUN_REFILL * dt);
  }

  // Living rivals with a fresh pose, inside the range we have *chosen* — which
  // is at most the honest 40 m and often deliberately less. Teammates are not
  // candidates and never can be: the shooter refuses friendly fire, not the
  // victim.
  const range = fair("engageRange");
  const mode = fair("focus");
  let best = null;
  let bestScore = Infinity;
  let bestD = Infinity;
  for (const p of peers.values()) {
    // Agents are excluded from `squadmates()` — two bots orbiting each other
    // instead of playing is a comedy nobody needs — but they are *not*
    // excluded here. A rival is a rival. Before this, two bots on opposite
    // squads stood in the same field politely ignoring each other, which is a
    // strange thing to watch and a waste of the one sparring partner that is
    // always available: with this, a second instance on another squad is both
    // a real opponent and a training session.
    if (!p.posed || p.dry <= 0) continue;
    if (TEAM && p.team && foldTeam(p.team) === TEAM) continue;
    if (sim - p.lastSeen > GUN_STALE) continue;
    const d = dist2(me.x, me.z, p.x, p.z);
    // Vertical separation counts: someone 30 m below us on a cliff is not
    // 5 m away just because their map pin is.
    const dy = Math.abs(me.y - p.y);
    if (d > range || dy > 12) continue;

    // Target priority — a learned decision, and a real one. Finishing the
    // wounded ends fights faster and stops a rival drying off behind a rock;
    // answering whoever is actually soaking us is what keeps *us* in the
    // match; nearest is the safe default and usually the one you can hit.
    let score = d;
    if (mode === "weakest") score = p.dry * 0.6 + d * 0.4;
    else if (mode === "threat") {
      const hurtingUs = engagement && engagement.id === p.id && sim - engagement.last < 3;
      score = d - (hurtingUs ? 60 : 0);
    }
    if (score < bestScore) {
      bestScore = score;
      bestD = d;
      best = p;
    }
  }

  // Acquisition, and the reaction floor that goes with it. Switching targets
  // costs the same 220 ms as seeing one for the first time — the wire hands us
  // a new target instantly and a human has to look at it.
  if (best?.id !== aimId) {
    aimId = best ? best.id : null;
    acquiredAt = sim;
    burstShots = 0;
  }
  if (!best) return null;
  if (sim - acquiredAt < FAIR.reaction) return best;

  if (tank < 1) return best;
  // Trigger discipline. The tank refills fastest from a pause, so a burst and
  // a beat beats holding the trigger down — and it is the difference between
  // a bot that runs dry in the middle of every fight and one that doesn't.
  if (sim < burstUntil) return best;
  if (burstShots >= fair("burstLen")) {
    burstShots = 0;
    burstUntil = sim + BURST_PAUSE;
    return best;
  }
  if (sim - lastShotAt < 1 / GUN_SHOTS_PER_SEC) return best;

  lastShotAt = sim;
  burstShots += 1;
  tank -= 1;

  // Accuracy is not a knob and never will be — it is measured against the
  // gun's full range, not the range we chose, so picking a shorter engagement
  // range cannot buy back hit chance. Learning to fight closer has to earn its
  // accuracy the way a player does: by being closer.
  const t = clamp(bestD / FAIR.maxRange, 0, 1);
  const acc = GUN_ACC_NEAR + (GUN_ACC_FAR - GUN_ACC_NEAR) * t;
  const hit = Math.random() < acc;

  // The tracer leaves whether or not the water lands, because a miss is still
  // a thing the enemy should hear coming.
  sendEvent("shot", { x: me.x, y: me.y + 1.4, z: me.z, tx: best.x, ty: best.y + 1.0, tz: best.z });

  if (!hit) return best;

  sendEvent("hit", {
    to: best.id,
    amount: GUN_SOAK,
    x: best.x,
    y: best.y + 1.0,
    z: best.z,
    headshot: false,
  });
  sendEvent("splash", { x: best.x, y: best.y, z: best.z, r: 1.1, a: 0.5, amount: 0 });

  // Track what we know we landed. The victim owns the truth and will announce
  // its own elimination; this is what the learner is scored on and what the
  // bot's own match report is built from.
  soakedByUs += GUN_SOAK;
  noteDealt(GUN_SOAK, best);
  return best;
}

/** Rate-limited, change-gated pose write — the same filter net.ts applies. */
function publishPose() {
  if (!online || !channel) return;
  if (sim - lastPoseAt < POSE_INTERVAL) return;
  const changed =
    !lastPoseSent ||
    Math.abs(lastPoseSent.x - me.x) > 0.04 ||
    Math.abs(lastPoseSent.z - me.z) > 0.04 ||
    Math.abs(lastPoseSent.y - me.y) > 0.04 ||
    Math.abs(lastPoseSent.yaw - me.yaw) > 0.02 ||
    lastPoseSent.state !== me.state ||
    Math.abs(lastPoseSent.dry - me.dry) > 0.5 ||
    sim - lastPoseAt > POSE_HEARTBEAT;
  if (!changed) return;
  lastPoseAt = sim;
  lastPoseSent = { x: me.x, y: me.y, z: me.z, yaw: me.yaw, state: me.state, dry: me.dry };
  void channel
    .send({
      type: "broadcast",
      event: "pose",
      payload: {
        i: SELF_ID,
        x: q(me.x),
        y: q(me.y),
        z: q(me.z),
        a: q(me.yaw),
        p: q(me.pitch),
        s: me.state,
        d: Math.round(me.dry),
        t: TEAM,
        n: NAME,
        g: 1,
      },
    })
    .catch(() => {});
}

/** The line a human watches to know the bot is actually playing. */
function status() {
  const lead = peers.get(leaderId);
  const near = lead ? `${lead.name} ${Math.round(dist2(me.x, me.z, lead.x, lead.z))}m` : "—";
  const foe = currentFoe();
  const fight = foe
    ? `  ${me.dry < fair("pushDry") ? "breaking from" : "fighting"} ${foe.name} ${Math.round(dist2(me.x, me.z, foe.x, foe.z))}m`
    : "";
  log.move(
    `pos ${q(me.x)},${q(me.z)}  y${q(me.y)}  ${me.state}  dry ${Math.round(me.dry)}%  ` +
      `following ${near}  peers ${peers.size}${fight}`,
  );
}

// ---------------------------------------------------------------- selftest
//
// The brain is the risky part of this file and it needs a lobby with humans in
// it to exercise — which is exactly what you do not have while writing it. So:
// feed the same wire packets a browser would send, run the same tick loop at a
// fixed dt, and assert on where the bot ends up. No socket, no config, no
// game. `node scripts/dz-teammate.mjs --selftest`.

if (SELFTEST) {
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    log.info(`${ok ? c("92", "PASS") : c("31", "FAIL")}  ${name}${detail ? c("90", "  " + detail) : ""}`);
  };

  // A scripted human walking east, then turning south.
  const JACK = "s-jack-test";
  const step = 1 / TICK_HZ;
  const drive = (seconds) => {
    for (let i = 0; i < seconds * TICK_HZ; i++) {
      sim += step;
      const t = sim;
      const jx = t < 12 ? t * 2.0 : 24 + (t - 12) * 0.4;
      const jz = t < 12 ? 0 : (t - 12) * 2.0;
      const jyaw = t < 12 ? Math.PI / 2 : 0.2;
      onPose({ i: JACK, x: jx, y: 0, z: jz, a: jyaw, p: 0, s: "ground", d: 100, t: TEAM, n: "Jack" });
      tick(step);
    }
  };

  drive(20);
  const jack = peers.get(JACK);
  const gap = dist2(me.x, me.z, jack.x, jack.z);
  check("keeps up with a moving teammate", gap < followDist() + 6, `${gap.toFixed(1)} m behind`);
  check("does not body-block", gap > PERSONAL_SPACE * 0.8, `${gap.toFixed(1)} m > ${PERSONAL_SPACE} m`);
  check("stays on the island", Math.abs(me.x) < ISLAND_HALF && Math.abs(me.z) < ISLAND_HALF);
  check("adopts the teammate's altitude", Math.abs(me.y - jack.y) < 0.5, `y=${q(me.y)}`);
  check("publishes a live movement state", me.state === "ground" || me.state === "sprint", me.state);

  // The drop bus. It flies in from outside the playable square, high up, and
  // the fence that keeps us out of the sea must not strand us on the island
  // while our squad is still aboard. Regression: the bot used to pin itself at
  // ±ISLAND_HALF and grind there for the whole flight, a few hundred metres
  // short, while the humans wondered where it was.
  const busX = -2096;
  const busZ = 1282;
  for (let i = 0; i < 40 * TICK_HZ; i++) {
    sim += step;
    onPose({ i: JACK, x: busX, y: 617, z: busZ, a: 0, p: 0, s: "ground", d: 100, t: TEAM, n: "Jack" });
    tick(step);
  }
  const busGap = dist2(me.x, me.z, busX, busZ);
  check("follows the squad outside the island", busGap < followDist() + 6, `${busGap.toFixed(1)} m from the bus`);
  check("climbs to the drop altitude", Math.abs(me.y - 617) < 5, `y=${q(me.y)}`);

  // ...and once they land, the fence is back on and we are not out at sea.
  for (let i = 0; i < 30 * TICK_HZ; i++) {
    sim += step;
    onPose({ i: JACK, x: 120, y: 0, z: -80, a: 0, p: 0, s: "ground", d: 100, t: TEAM, n: "Jack" });
    tick(step);
  }
  check(
    "comes back inside once the squad lands",
    Math.abs(me.x) <= ISLAND_HALF && Math.abs(me.z) <= ISLAND_HALF,
    `${q(me.x)}, ${q(me.z)}`,
  );

  // A squadmate sitting on the end card publishes poses at `dry: 0`. That used
  // to drop them out of `squadmates()` entirely, so after one finished match
  // the bot reported `peers 1, following —` and stood still for the rest of the
  // session. Following someone who is out beats following nobody.
  onPose({ i: JACK, x: 200, y: 0, z: -60, a: 0, p: 0, s: "ground", d: 0, t: TEAM, n: "Jack" });
  tick(step);
  check("still follows a soaked squadmate", leaderId === JACK, leaderId ?? "(nobody)");
  onPose({ i: JACK, x: 200, y: 0, z: -60, a: 0, p: 0, s: "ground", d: 100, t: TEAM, n: "Jack" });
  tick(step);
  check("re-acquires them when they dry off", leaderId === JACK, leaderId ?? "(nobody)");

  // The downpour: a zone far away should pull it off the follow slot.
  zone = { x: -300, z: -300, r: 60 };
  const beforeZone = dist2(me.x, me.z, zone.x, zone.z);
  drive(8);
  const afterZone = dist2(me.x, me.z, zone.x, zone.z);
  check("runs for the safe zone", afterZone < beforeZone - 20, `${beforeZone.toFixed(0)} → ${afterZone.toFixed(0)} m`);
  zone = null;

  // Chat: addressed by name must get an answer; the seam must be reachable.
  // `consider()` is async by design (that is what lets a model call slot in),
  // so every assertion here waits a beat for the reply to land.
  const said = [];
  const realLog = log.say;
  log.say = (m) => said.push(m);
  const flush = () => new Promise((r) => setTimeout(r, 50));
  await flush();
  said.length = 0; // drop the greeting fired when it first saw the squad

  lastChatAt = -Infinity;
  onEvent({ i: JACK, k: "chat", p: { name: "Jack", text: "claude where are you?" } });
  await flush();
  check("answers when spoken to", said.length === 1, said[0] ?? "(silence)");

  // ...and must not answer every single line, or it is unbearable.
  onEvent({ i: JACK, k: "chat", p: { name: "Jack", text: "ok cool" } });
  await flush();
  check("stays quiet on chatter", said.length === 1, `${said.length} line(s) total`);

  // Glue: stumble, then recover.
  onEvent({ i: JACK, k: "glue", p: { to: SELF_ID } });
  drive(0.5);
  check("stumbles when glued", me.state === "stumble", me.state);
  drive(GLUE_STUMBLE + 1);
  check("recovers from glue", me.state !== "stumble", me.state);

  // Crude pathing. Pin the bot in place — a wall it has no way to see, since
  // all the collision geometry lives in the browser — and confirm it notices
  // it has stopped making progress and picks a detour heading.
  detourUntil = -1;
  const pinX = me.x;
  const pinZ = me.z;
  for (let i = 0; i < STUCK_WINDOW * 2.5 * TICK_HZ; i++) {
    sim += step;
    onPose({ i: JACK, x: pinX + 60, y: 0, z: pinZ + 60, a: 0, p: 0, s: "ground", d: 100, t: TEAM, n: "Jack" });
    tick(step);
    me.x = pinX;
    me.z = pinZ;
  }
  check("notices a wall and detours", detourUntil > 0, `detour until t=${q(detourUntil)}`);

  // Dryness: a splash soaks, and 0% takes it out of the match for good.
  lastChatAt = -Infinity;
  const RIVAL = "s-rival-test";
  onPose({ i: RIVAL, x: me.x + 1, y: 0, z: me.z + 1, a: 0, p: 0, s: "ground", d: 100, t: "red", n: "Atlas" });
  const dryBefore = me.dry;
  onEvent({ i: RIVAL, k: "splash", p: { x: me.x, y: me.y, z: me.z } });
  check("gets wetter when splashed", me.dry < dryBefore, `${Math.round(dryBefore)}% → ${Math.round(me.dry)}%`);

  // An empty lobby must not walk off. The idle wobble is meant to keep the
  // bot from looking frozen, not to relocate it.
  {
    peers.clear();
    leaderId = null;
    idleHome = null;
    const startX = me.x;
    const startZ = me.z;
    let idleDetours = 0;
    const realMove = log.move;
    log.move = (m) => {
      if (String(m).includes("stuck")) idleDetours++;
    };
    for (let i = 0; i < 240 * TICK_HZ; i++) {
      sim += step;
      tick(step);
    }
    log.move = realMove;
    const drift = dist2(me.x, me.z, startX, startZ);
    check("stays put with nobody to follow", drift < 6, `${drift.toFixed(1)} m in 4 min`);
    check("does not cry stuck while idling", idleDetours === 0, `${idleDetours} detour(s) in 4 min`);
  }

  // The gun. A rival inside GUN_RANGE gets shot at; a squadmate never does.
  {
    const GUNTGT = "s-gun-test";
    tank = GUN_TANK;
    lastShotAt = -Infinity;
    const fired = [];
    wire.send = (k, p) => fired.push({ k, p });
    // The splash test left a rival standing a metre away, which is well
    // inside GUN_RANGE — leave it there and every check below is really
    // measuring shots at that one instead of the target it names.
    peers.delete(RIVAL);

    // Three seconds of trigger time. One tick would make this a coin flip on
    // GUN_ACC_NEAR; across ~10 shots at 0.82 the odds of landing nothing are
    // about one in five hundred million.
    for (let i = 0; i < 3 * TICK_HZ; i++) {
      // `sim` is what the fire rate is measured against. Without advancing it
      // the cooldown never expires and this fires exactly once.
      sim += step;
      onPose({ i: GUNTGT, x: me.x + 6, y: me.y, z: me.z, a: 0, p: 0, s: "ground", d: 100, t: "red", n: "Target" });
      tick(step);
    }
    const hits = fired.filter((f) => f.k === "hit" && f.p.to === GUNTGT);
    check("shoots a rival in range", hits.length > 0, `${hits.length} hit(s), ${fired.filter((f) => f.k === "shot").length} shot(s)`);
    check("soaks for the SS9K's 12", hits.every((f) => f.p.amount === GUN_SOAK), `${GUN_SOAK}`);
    check("marks its own splashes as scenery", fired.filter((f) => f.k === "splash").every((f) => f.p.amount === 0), "amount 0");
    check("empties and refills its tank", tank < GUN_TANK, `${tank.toFixed(1)}/${GUN_TANK}`);

    // Same squad, same range, no trigger.
    fired.length = 0;
    lastShotAt = -Infinity;
    peers.delete(GUNTGT);
    onPose({ i: "s-gun-mate", x: me.x + 6, y: me.y, z: me.z, a: 0, p: 0, s: "ground", d: 100, t: TEAM, n: "Mate2" });
    tick(step);
    check("never shoots a squadmate", !fired.some((f) => f.k === "hit"), `${fired.filter((f) => f.k === "hit").length} hit(s)`);

    // Out of range, no trigger.
    fired.length = 0;
    lastShotAt = -Infinity;
    peers.delete("s-gun-mate");
    onPose({ i: "s-gun-far", x: me.x + GUN_RANGE + 40, y: me.y, z: me.z, a: 0, p: 0, s: "ground", d: 100, t: "red", n: "Far" });
    tick(step);
    check("holds fire out of range", !fired.some((f) => f.k === "hit"), `${fired.filter((f) => f.k === "hit").length} hit(s)`);
    peers.delete("s-gun-far");
    wire.send = null;
    // Put the rival back the way the next checks expect to find it.
    onPose({ i: RIVAL, x: me.x + 1, y: 0, z: me.z + 1, a: 0, p: 0, s: "ground", d: 100, t: "red", n: "Atlas" });
  }

  // Addressed water — the `hit` a human's soaker sends once ghosts are real
  // damage targets. Unlike `splash` it does not care where we are standing,
  // and it must be ignored unless it names us.
  const beforeHit = me.dry;
  onEvent({ i: RIVAL, k: "hit", p: { to: "somebody-else", amount: 20 } });
  check("ignores a hit meant for someone else", me.dry === beforeHit, `${Math.round(me.dry)}%`);
  onEvent({ i: RIVAL, k: "hit", p: { to: SELF_ID, amount: 20 } });
  check("takes an addressed hit", me.dry === beforeHit - 20, `${Math.round(beforeHit)}% → ${Math.round(me.dry)}%`);
  const beforeCap = me.dry;
  onEvent({ i: RIVAL, k: "hit", p: { to: SELF_ID, amount: 999 } });
  check("caps a single hit at 25", me.dry === beforeCap - 25, `${Math.round(beforeCap)}% → ${Math.round(me.dry)}%`);
  // A squadmate's hit is refused here as well as at the shooter, because one
  // bad client should not be able to soak its own team.
  onPose({ i: "s-mate-test", x: me.x + 2, y: 0, z: me.z, a: 0, p: 0, s: "ground", d: 100, t: TEAM, n: "Mate" });
  const beforeMate = me.dry;
  onEvent({ i: "s-mate-test", k: "hit", p: { to: SELF_ID, amount: 20 } });
  check("refuses friendly fire", me.dry === beforeMate, `${Math.round(me.dry)}%`);
  for (let i = 0; i < 20; i++) onEvent({ i: RIVAL, k: "splash", p: { x: me.x, y: me.y, z: me.z } });
  drive(3);
  check("bows out at 0% dry", me.dry === 0 && me.state === "down", `${me.dry}% / ${me.state}`);
  log.say = realLog;

  // ---------------------------------------------------------------- part two
  //
  // Fair play, combat decisions, and the fact that a life ending is not the
  // session ending. Everything above this line was written when the bot was a
  // follower; everything below it is what makes it a player.

  /** Put the field back to a clean, standing, unengaged state. The checks
   *  below each want a stage of their own, and they run in one process. */
  const resetField = () => {
    peers.clear();
    damagedAt.clear();
    leaderId = null;
    aimId = null;
    idleHome = null;
    zone = null;
    engagement = null;
    reviving = null;
    lastGunfire = null;
    placed = true;
    announcedOut = false;
    me.x = 0;
    me.y = 0;
    me.z = 0;
    me.vx = 0;
    me.vz = 0;
    me.dry = 100;
    me.state = "ground";
    tank = GUN_TANK;
    lastShotAt = -Infinity;
    lastSoakedAt = -Infinity;
    acquiredAt = -Infinity;
    burstShots = 0;
    burstUntil = -1;
    downedAt = -Infinity;
    detourUntil = -1;
    lastRejoinAt = -Infinity;
    anchor = { x: 0, z: 0, t: sim };
  };

  /** Drive n seconds while holding a peer at a fixed pose. */
  const hold = (seconds, pose) => {
    for (let i = 0; i < seconds * TICK_HZ; i++) {
      sim += step;
      if (pose) onPose(pose());
      tick(step);
    }
  };

  const basePlan = { ...plan };

  // ---- the reaction floor ----------------------------------------------
  // The whole difference between a teammate and an aimbot is measured here.
  {
    resetField();
    plan = { ...basePlan, engageRange: 34, focus: "nearest", burstLen: 30, strafeAmp: 0 };
    const fired = [];
    wire.send = (k, p) => fired.push({ k, p, t: sim });
    const rival = () => ({ i: "s-react", x: me.x + 6, y: me.y, z: me.z, a: 0, p: 0, s: "ground", d: 100, t: "red", n: "Quick" });
    hold(FAIR.reaction * 0.8, rival);
    check("holds fire for a human reaction time", fired.length === 0, `${fired.length} packet(s) in ${(FAIR.reaction * 0.8).toFixed(2)} s`);
    hold(0.6, rival);
    check("shoots once it has actually reacted", fired.some((f) => f.k === "shot"), `${fired.filter((f) => f.k === "shot").length} shot(s)`);
    wire.send = null;
  }

  // ---- target priority is a decision, and it is learned ------------------
  {
    resetField();
    plan = { ...basePlan, engageRange: 34, focus: "weakest", burstLen: 30, strafeAmp: 0 };
    onPose({ i: "s-near", x: me.x + 8, y: me.y, z: me.z, a: 0, p: 0, s: "ground", d: 100, t: "red", n: "Fresh" });
    onPose({ i: "s-hurt", x: me.x + 20, y: me.y, z: me.z, a: 0, p: 0, s: "ground", d: 12, t: "red", n: "Nearly" });
    hold(0.5, null);
    check("finishes the wounded one when focusing weakest", aimId === "s-hurt", aimId ?? "(nobody)");

    plan = { ...plan, focus: "nearest" };
    aimId = null;
    hold(0.5, null);
    check("takes the near one when focusing nearest", aimId === "s-near", aimId ?? "(nobody)");
  }

  // ---- press and break ---------------------------------------------------
  {
    resetField();
    plan = { ...basePlan, engageRange: 34, pushDry: 25, strafeAmp: 0, focus: "nearest" };
    // Inside our engagement range to start with: a rival who has not fired and
    // is beyond it is a position on the wire we have decided not to know.
    me.x = 48;
    const far = () => ({ i: "s-press", x: 60, y: 0, z: 0, a: 0, p: 0, s: "ground", d: 100, t: "red", n: "Duelist" });
    hold(20, far);
    const holdAt = dist2(me.x, me.z, 60, 0);
    check(
      "holds a fighting distance instead of hugging",
      Math.abs(holdAt - fair("engageRange") * 0.8) < 7,
      `${holdAt.toFixed(1)} m, wanted ~${(fair("engageRange") * 0.8).toFixed(0)} m`,
    );

    // Now soak it below the threshold: it should leave, not trade.
    plan = { ...plan, pushDry: 70, breakDist: 46 };
    me.dry = 40;
    lastSoakedAt = sim;
    const before = dist2(me.x, me.z, 60, 0);
    hold(2, far);
    check("sprints while breaking, which is how drying works", me.state === "sprint", me.state);
    hold(8, far);
    const after = dist2(me.x, me.z, 60, 0);
    check("breaks off to dry when low", after > before + 6, `${before.toFixed(0)} → ${after.toFixed(0)} m`);
  }

  // ---- trigger discipline ------------------------------------------------
  {
    resetField();
    plan = { ...basePlan, engageRange: 34, burstLen: 3, strafeAmp: 0, focus: "nearest" };
    const fired = [];
    wire.send = (k, p) => fired.push({ k, p, t: sim });
    hold(6, () => ({ i: "s-burst", x: me.x + 10, y: me.y, z: me.z, a: 0, p: 0, s: "ground", d: 100, t: "red", n: "Sponge" }));
    const shots = fired.filter((f) => f.k === "shot");
    // Uncapped, six seconds at 3.5/s is 21 shots. Three-shot bursts with a
    // pause between them should land well under that and well over nothing.
    check("fires in bursts rather than holding the trigger", shots.length > 4 && shots.length < 17, `${shots.length} shot(s) in 6 s`);
    wire.send = null;
  }

  // ---- no teleporting, except the bus ------------------------------------
  {
    resetField();
    const startX = me.x;
    const startZ = me.z;
    // A squadmate 400 m away at ground level is a run. It used to be a blink.
    hold(3, () => ({ i: "s-runner", x: 400, y: 0, z: 0, a: 0, p: 0, s: "ground", d: 100, t: TEAM, n: "Runner" }));
    const covered = dist2(me.x, me.z, startX, startZ);
    check("runs to a distant squadmate rather than blinking", covered < FAIR.maxSpeed * 3 + 2, `${covered.toFixed(0)} m in 3 s`);

    // ...and the drop bus, 600 m up, still is one — nobody walks to a plane.
    hold(0.5, () => ({ i: "s-runner", x: 400, y: 620, z: 0, a: 0, p: 0, s: "ground", d: 100, t: TEAM, n: "Runner" }));
    check("still joins the squad on the drop bus", dist2(me.x, me.z, 400, 0) < 20, `${dist2(me.x, me.z, 400, 0).toFixed(0)} m from the bus`);
  }

  // ---- towelling off -----------------------------------------------------
  {
    resetField();
    plan = { ...basePlan };
    const fired = [];
    wire.send = (k, p) => fired.push({ k, p });
    const downedMate = () => ({ i: "s-downed", x: 4, y: 0, z: 0, a: 0, p: 0, s: "down", d: 0, t: TEAM, n: "Mate" });
    hold(REVIVE_TIME + 6, downedMate);
    check("towels off a downed squadmate", fired.some((f) => f.k === "revive" && f.p.id === "s-downed"), `${fired.filter((f) => f.k === "revive").length} revive(s)`);
    wire.send = null;

    // ...and can be towelled off itself. Nothing in the browser sends this
    // yet; the day it does, the bot is already a thing you can save.
    resetField();
    onPose({ i: "s-saviour", x: 2, y: 0, z: 0, a: 0, p: 0, s: "ground", d: 100, t: TEAM, n: "Saviour" });
    goDown("s-rival");
    check("goes down at 0%", me.state === "down", me.state);
    onEvent({ i: "s-saviour", k: "revive", p: { id: SELF_ID } });
    check("stands back up when towelled off", me.dry === REVIVE_DRY && me.state === "ground", `${me.dry}% / ${me.state}`);
  }

  // ---- a life ending is not the session ending ---------------------------
  {
    resetField();
    onPose({ i: "s-next", x: 10, y: 0, z: 0, a: 0, p: 0, s: "ground", d: 100, t: TEAM, n: "Jack" });
    goDown("s-rival");
    // The lobby rolls: everyone who was out comes back dry.
    onPose({ i: "s-next", x: 10, y: 0, z: 0, a: 0, p: 0, s: "ground", d: 0, t: TEAM, n: "Jack" });
    onPose({ i: "s-next", x: 10, y: 0, z: 0, a: 0, p: 0, s: "ground", d: 100, t: TEAM, n: "Jack" });
    check("plays the next match instead of standing in a field", me.dry === 100 && me.state !== "down", `${Math.round(me.dry)}% / ${me.state}`);

    // The same, with nobody around to respawn: out long enough in an empty
    // lobby and there is no reason left to be lying down.
    goDown("s-rival");
    peers.clear();
    downedAt = sim - NEW_MATCH_PATIENCE - 1;
    tick(step);
    check("gets up eventually in an empty lobby", me.dry === 100, `${Math.round(me.dry)}%`);

    // Down is not deaf: being named still gets an answer.
    goDown("s-rival");
    log.say = (m) => said.push(m);
    // Going down says something of its own, and it says it from a promise —
    // let that land before measuring what the chat reply added.
    await flush();
    lastChatAt = -Infinity;
    said.length = 0;
    onEvent({ i: "s-next", k: "chat", p: { name: "Jack", text: "claude you good?" } });
    await flush();
    check("answers from the floor when named", said.length === 1, said[0] ?? "(silence)");
    said.length = 0;
    onEvent({ i: "s-next", k: "chat", p: { name: "Jack", text: "push left" } });
    await flush();
    check("stays out of the chat it is not in", said.length === 0, said[0] ?? "(silence)");
    log.say = realLog;
  }

  // ---- peers still time out while we are down ----------------------------
  {
    resetField();
    onPose({ i: "s-ghost", x: 10, y: 0, z: 0, a: 0, p: 0, s: "ground", d: 100, t: TEAM, n: "Ghost" });
    goDown("s-rival");
    downedAt = sim; // don't let the new-match watch fire mid-check
    for (const p of peers.values()) p.lastSeen = sim - PEER_TIMEOUT - 1;
    tick(step);
    check("reaps stale peers even while down", peers.size === 0, `${peers.size} peer(s)`);
  }

  // ---- a lobby of nothing but bots is still a match -----------------------
  {
    resetField();
    lives = 0;
    placed = false;
    onPose({ i: "s-other-bot", x: 30, y: 0, z: 0, a: 0, p: 0, s: "ground", d: 100, t: "dolphin", n: "Rival", g: 1 });
    check("starts a life even with no humans in the room", lives === 1, `${lives} life/lives`);
    check("does not spawn on top of another bot", placed === false, `placed=${placed}`);

    // ...and another bot on another squad is a rival, not scenery.
    resetField();
    plan = { ...basePlan, engageRange: 34, focus: "nearest" };
    hold(0.6, () => ({ i: "s-other-bot", x: me.x + 9, y: me.y, z: me.z, a: 0, p: 0, s: "ground", d: 100, t: "dolphin", n: "Rival", g: 1 }));
    check("fights a bot on the other squad", aimId === "s-other-bot", aimId ?? "(nobody)");
  }

  // ---- a decal is not a hit ----------------------------------------------
  {
    resetField();
    onPose({ i: "s-decal", x: me.x + 2, y: 0, z: me.z, a: 0, p: 0, s: "ground", d: 100, t: "red", n: "Splasher" });
    const dryBefore = me.dry;
    onEvent({ i: "s-decal", k: "splash", p: { x: me.x, y: me.y, z: me.z, amount: 0 } });
    check("ignores a scenery splash at amount 0", me.dry === dryBefore, `${Math.round(me.dry)}%`);
  }

  // ---- the caps are not negotiable ---------------------------------------
  {
    plan = {
      engageRange: 999,
      pushDry: 900,
      breakDist: 5000,
      strafeAmp: 99,
      burstLen: 1e6,
      focus: "aimbot",
      followDist: 4000,
    };
    check("clamps a hostile engagement range", fair("engageRange") === FAIR.maxRange, `${fair("engageRange")} m`);
    check("clamps a hostile strafe", fair("strafeAmp") <= FAIR.maxSpeed * 0.6, `${fair("strafeAmp")}`);
    check("clamps a hostile follow slot", fair("followDist") <= 20, `${fair("followDist")} m`);
    check("clamps a hostile burst", fair("burstLen") <= GUN_TANK, `${fair("burstLen")}`);
    check("refuses an unknown focus mode", fair("focus") === "nearest", fair("focus"));
    plan = { ...basePlan };
  }

  // ---- the notebook itself ------------------------------------------------
  {
    const s = openSkill({ file: "(memory)", enabled: false, warn: () => {} });
    for (let i = 0; i < 12; i++) {
      s.engagement({ engageRange: 34 }, { dealt: 96, taken: 0, knockout: 1 });
      s.engagement({ engageRange: 18 }, { dealt: 0, taken: 96 });
    }
    check("learns which way of fighting wins", s.best().engageRange === 34, `picked ${s.best().engageRange} m`);
    s.bug("kettle-boiled-dry", "twice");
    s.bug("kettle-boiled-dry", "twice");
    check("counts a repeated bug once, with a tally", s.data.bugs.length === 1 && s.data.bugs[0].count === 2, `${s.data.bugs.length} kind(s)`);
    check("writes a report a human can read", /career:/.test(s.report()), s.report().split("\n")[0]);
  }

  const failed = checks.filter((k) => !k.ok);
  console.log("");
  log.info(`${checks.length - failed.length}/${checks.length} checks passed`);
  console.log("");
  process.exit(failed.length ? 1 : 0);
}

// ---------------------------------------------------------------- run

log.info(`${c("1", NAME)} joining ${c("1", ROOM)} on team ${c("1", TEAM)}`);
log.info(`peer id ${SELF_ID}  ${SUPABASE_URL.replace(/^https?:\/\//, "")}`);
if (TIMESCALE !== 1) log.info(`timescale ${TIMESCALE} (simulated seconds per wall second)`);

let loop = null;

const connected = await connect();

if (connected !== true) {
  bail(
    `could not join lobby "${ROOM}" (${connected}).`,
    "Check the room code and that the Supabase URL/key are the ones the site uses.\n  Nothing is broken on the game's side — the humans can keep playing without me.",
  );
}

online = true;
await channel.track({ name: NAME, team: TEAM, agent: true });
log.net(`joined soaked-${ROOM} — waiting for the squad`);

let lastWall = Date.now();
loop = setInterval(() => {
  const now = Date.now();
  // Clamp the wall delta so a stalled event loop (GC, a slow send) doesn't
  // teleport the bot a hundred metres on the next tick.
  const wallDt = Math.min((now - lastWall) / 1000, 0.25);
  lastWall = now;
  const dt = wallDt * TIMESCALE;
  sim += dt;

  tick(dt);
  publishPose();

  if (sim - lastStatusAt > STATUS_INTERVAL) {
    lastStatusAt = sim;
    if (placed || peers.size) status();
  }

  // The notebook is worth nothing if it only survives a polite Ctrl-C. This
  // runs it to disk every couple of minutes, which is the most a `kill -9`,
  // a closed laptop or a dropped socket can cost.
  if (sim - lastSkillSaveAt > SKILL_SAVE_INTERVAL) {
    lastSkillSaveAt = sim;
    if (skill.dirty) skill.save();
  }
}, Math.round(1000 / TICK_HZ));

// ---------------------------------------------------------------- shutdown

let leaving = false;
async function leave(code) {
  if (leaving) return;
  leaving = true;
  if (loop) clearInterval(loop);
  console.log("");
  log.info("leaving the lobby...");

  // Bank the session before the socket work, not after: `untrack` can hang on
  // a dead network for as long as it likes, and an evening of play should not
  // be riding on whether it comes back.
  closeEngagement();
  skill.close(Math.round((Date.now() - startedWallMs) / 1000));
  if (skill.enabled) {
    console.log("");
    console.log(skill.report());
    console.log("");
    log.info(`training record: ${SKILL_FILE}`);
  }

  try {
    if (online) {
      sendEvent("chat", { text: "Heading out — good games.", name: NAME });
      await channel.untrack();
    }
    await supabase.removeChannel(channel);
  } catch {
    /* the socket is going away regardless */
  }
  process.exit(code);
}

process.on("SIGINT", () => void leave(0));
process.on("SIGTERM", () => void leave(0));
process.on("unhandledRejection", (err) => {
  log.warn(`unhandled: ${err?.message ?? err}`);
  skill.bug("unhandled-rejection", String(err?.message ?? err));
});
