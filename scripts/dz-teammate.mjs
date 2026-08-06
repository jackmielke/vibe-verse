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
 *   channel   `soaked-<NORMALISED-ROOM-CODE>`
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
 * USAGE
 *   node scripts/dz-teammate.mjs --room SPLASH-4B2 --name Claude --team blue
 *
 * FLAGS
 *   --room CODE      lobby to join (required; case/punctuation insensitive)
 *   --name NAME      display name                        [Claude]
 *   --team TEAM      squad id — same string = same squad [blue]
 *   --url URL        Supabase URL      [$VITE_SUPABASE_URL or .env]
 *   --key KEY        Supabase anon key [$VITE_SUPABASE_PUBLISHABLE_KEY or .env]
 *   --follow-dist M  how far behind a teammate to hold   [6]
 *   --zone x,z,r     safe-zone hint, if you know it (see "The downpour")
 *   --timescale N    simulated seconds per wall second   [1]
 *   --quiet          drop the movement/status chatter, keep chat + events
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

/** Dryness: how wet a splash within SPLASH_RADIUS makes us, and how fast we
 *  towel off again while nothing is hitting us. 0% dry = out of the match. */
const SPLASH_RADIUS = 3.2;
const SPLASH_SOAK = 9;
const DRY_REGEN = 1.4;
const DRY_REGEN_DELAY = 4;

/** How long a glue hit leaves us stumbling. */
const GLUE_STUMBLE = 3.5;

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
      "    --team TEAM      squad id — same string = same squad [blue]",
      "    --url URL        Supabase URL      [VITE_SUPABASE_URL / .env]",
      "    --key KEY        Supabase anon key [VITE_SUPABASE_PUBLISHABLE_KEY / .env]",
      "    --follow-dist M  how far behind a teammate to hold   [6]",
      "    --zone x,z,r     safe-zone hint, if you know it",
      "    --timescale N    simulated seconds per wall second   [1]",
      "    --quiet          drop movement chatter, keep chat + events",
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

const SUPABASE_URL = String(args.url || pick("VITE_SUPABASE_URL", "SUPABASE_URL"));
const SUPABASE_KEY = String(
  args.key ||
    pick(
      "VITE_SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_ANON_KEY",
      "SUPABASE_PUBLISHABLE_KEY",
    ),
);

// --selftest never opens a socket, so it must run with no config at all.
if (!SELFTEST) {
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

const ROOM = normalizeRoomCode(args.room ?? args.r ?? (SELFTEST ? "SELFTEST" : ""));
if (!ROOM) {
  bail(
    "no room code. The teammate joins a lobby the humans are already in.",
    "e.g. node scripts/dz-teammate.mjs --room SPLASH-4B2 --name Claude --team blue",
  );
}

const NAME = String(args.name || "Claude").slice(0, 24);
const TEAM = String(args.team || "blue").slice(0, 24);
const FOLLOW_DIST = Math.max(2.5, Number(args["follow-dist"]) || 6);
const TIMESCALE = Number(args.timescale) > 0 ? Number(args.timescale) : 1;
const SELF_ID = `s-claude-${Math.random().toString(36).slice(2, 8)}`;

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
let detourSign = 1;

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

/** Humans on our squad, sorted nearest first. Agents are excluded so two
 *  copies of this bot in one lobby never end up orbiting each other. */
function squadmates() {
  const out = [];
  for (const p of peers.values()) {
    if (p.agent || !p.posed) continue;
    if (p.dry <= 0) continue; // already out — don't shadow a spectator
    if (TEAM && p.team && p.team !== TEAM) continue;
    out.push(p);
  }
  out.sort((a, b) => dist2(me.x, me.z, a.x, a.z) - dist2(me.x, me.z, b.x, b.z));
  return out;
}

/** Anyone at all, for callouts and win detection. */
function livingPeers(sameTeam) {
  const out = [];
  for (const p of peers.values()) {
    if (!p.posed || p.dry <= 0) continue;
    const mate = !!TEAM && p.team === TEAM;
    if (sameTeam === undefined || mate === sameTeam) out.push(p);
  }
  return out;
}

function sendEvent(kind, payload) {
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

  // First time we can see anyone, appear beside the squad rather than
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
      if (me.dry <= 0) return; // we're out; let the living talk
      const direct =
        new RegExp(`(^|\\W)@?${NAME}\\b`, "i").test(text) ||
        /\bclaude\b/i.test(text);
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
      const mate = !!TEAM && from?.team === TEAM;
      if (!mate && dMe < SPLASH_RADIUS && me.dry > 0) {
        const soak = Number.isFinite(payload.amount) ? payload.amount : SPLASH_SOAK;
        me.dry = clamp(me.dry - soak, 0, 100);
        lastSoakedAt = sim;
        log.event(`splashed by ${who} — ${Math.round(me.dry)}% dry`);
        if (me.dry <= 0 && !announcedOut) {
          announcedOut = true;
          me.state = "down";
          sendEvent("soaked", { id: SELF_ID, name: NAME, by: w.i });
          void consider({ kind: "self-soaked" }, true);
        }
        return;
      }
      if (!mate) maybeCallout(x, z, from);
      return;
    }

    case "shot": {
      // Tracers give the shooter's position away, which is exactly what a
      // callout is. Only interesting when it is near one of ours.
      const ox = payload.x ?? payload.ox;
      const oz = payload.z ?? payload.oz;
      if (![ox, oz].every(Number.isFinite)) return;
      if (TEAM && from?.team === TEAM) return;
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
      if (p) p.dry = 0;
      const name = p?.name ?? payload.name ?? who;
      log.event(`${name} is soaked`);
      const mate = !!TEAM && p?.team === TEAM;
      if (mate) void consider({ kind: "teammate-soaked", who: name }, true);
      // Nobody publishes a "victory" event, so infer it: our squad is still
      // dry and there is nobody left who isn't on it.
      if (me.dry > 0 && livingPeers(false).length === 0 && livingPeers(true).length > 0) {
        void consider({ kind: "victory" }, true);
      }
      return;
    }

    case "revive": {
      const id = payload.id ?? payload.target;
      const p = peers.get(id);
      if (p) p.dry = Math.max(p.dry, 25);
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
      return; // balloon / build / harvest / emote — nothing to say about those
  }
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

  channel = supabase.channel(`soaked-${ROOM}`, {
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

/**
 * Where we would like to be standing.
 *
 * Priority: the safe zone when the downpour has us outside it, otherwise a
 * slot behind and slightly beside whichever squadmate is nearest.
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

  const mates = squadmates();
  if (mates.length === 0) {
    // Nobody visible. Drift gently around where we are so we don't read as a
    // frozen mannequin, and stay well inside the island.
    return {
      x: me.x + Math.cos(sim * 0.23) * 2.2,
      z: me.z + Math.sin(sim * 0.19) * 2.2,
      urgent: false,
    };
  }

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
    x: lead.x - fx * FOLLOW_DIST + fz * SLOT_SIDE,
    z: lead.z - fz * FOLLOW_DIST - fx * SLOT_SIDE,
    urgent: false,
  };
}

/**
 * One brain tick.
 *
 * @param {number} dt simulated seconds since the last tick.
 */
function tick(dt) {
  // Soaked players don't move. Stay put, stay quiet, let the squad play.
  if (me.dry <= 0) {
    me.vx = 0;
    me.vz = 0;
    me.state = "down";
    return;
  }

  const goal = desiredPoint();
  let dx = goal.x - me.x;
  let dz = goal.z - me.z;
  let d = Math.hypot(dx, dz);

  // Crude pathing. We have no terrain or collision data out here — the whole
  // world lives in the browser — so "path around obstacles" can only mean:
  // notice we have stopped making progress, and try going around. Two seconds
  // of consistent sidestep clears most walls and rock faces; if it doesn't,
  // the next window picks a fresh side.
  const moved = dist2(me.x, me.z, anchor.x, anchor.z);
  if (sim - anchor.t > STUCK_WINDOW) {
    if (d > SLOT_DEADZONE && moved < STUCK_DIST && sim > detourUntil) {
      detourUntil = sim + DETOUR_TIME;
      detourSign = Math.random() < 0.5 ? -1 : 1;
      log.move("stuck — taking a detour");
    }
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
  // that stops the bot from being the thing that gets you soaked.
  for (const p of peers.values()) {
    if (!p.posed) continue;
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

  // Stay on the island whatever the steering says.
  me.x = clamp(me.x, -ISLAND_HALF, ISLAND_HALF);
  me.z = clamp(me.z, -ISLAND_HALF, ISLAND_HALF);

  // Altitude. We cannot sample the terrain from here, so we adopt the height
  // of whoever we are following — they are standing on ground we can't see,
  // and copying them is the difference between a teammate who walks the hills
  // with you and one who hovers through them.
  const lead = peers.get(leaderId);
  if (lead) me.y += (lead.y - me.y) * (1 - Math.exp(-Y_LERP * dt));

  // Face where we're going; when parked, face the same way the leader does.
  const moving = Math.hypot(me.vx, me.vz);
  const target = moving > 0.35 ? Math.atan2(me.vx, me.vz) : lead ? lead.yaw : me.yaw;
  me.yaw = turnToward(me.yaw, target, dt * 5);

  me.state = stumbling ? "stumble" : moving > WALK_SPEED * 1.1 ? "sprint" : "ground";

  // Towel off slowly once nothing has hit us for a moment. A soaked-out bot
  // stays out — 0% is elimination, and it does not come back on its own.
  if (me.dry > 0 && sim - lastSoakedAt > DRY_REGEN_DELAY) {
    me.dry = clamp(me.dry + DRY_REGEN * dt, 0, 100);
  }

  // Reap peers that stopped talking without a presence goodbye.
  for (const [id, p] of peers) {
    if (sim - p.lastSeen > PEER_TIMEOUT) {
      peers.delete(id);
      if (id === leaderId) leaderId = null;
      log.net(`lost ${p.name} (timed out)`);
    }
  }
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
  log.move(
    `pos ${q(me.x)},${q(me.z)}  y${q(me.y)}  ${me.state}  dry ${Math.round(me.dry)}%  ` +
      `following ${near}  peers ${peers.size}`,
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
  check("keeps up with a moving teammate", gap < FOLLOW_DIST + 6, `${gap.toFixed(1)} m behind`);
  check("does not body-block", gap > PERSONAL_SPACE * 0.8, `${gap.toFixed(1)} m > ${PERSONAL_SPACE} m`);
  check("stays on the island", Math.abs(me.x) < ISLAND_HALF && Math.abs(me.z) < ISLAND_HALF);
  check("adopts the teammate's altitude", Math.abs(me.y - jack.y) < 0.5, `y=${q(me.y)}`);
  check("publishes a live movement state", me.state === "ground" || me.state === "sprint", me.state);

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
  for (let i = 0; i < 20; i++) onEvent({ i: RIVAL, k: "splash", p: { x: me.x, y: me.y, z: me.z } });
  drive(3);
  check("bows out at 0% dry", me.dry === 0 && me.state === "down", `${me.dry}% / ${me.state}`);
  log.say = realLog;

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
}, Math.round(1000 / TICK_HZ));

// ---------------------------------------------------------------- shutdown

let leaving = false;
async function leave(code) {
  if (leaving) return;
  leaving = true;
  if (loop) clearInterval(loop);
  console.log("");
  log.info("leaving the lobby...");
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
});
