/**
 * Vibey remembers you.
 *
 * One small record per device: your name, how many times you have come, when
 * you were last here, which spells you reach for, and how the valley looked
 * when you left. It lives in localStorage and nowhere else; nothing here is
 * sent anywhere except as words in Vibey's own instructions.
 *
 * What it buys is a friend rather than a remote control: "Welcome back, Jack.
 * Aurora again?", a relationship that deepens over visits (a stranger, then
 * somebody Vibey knows, then an old friend), and "like last time" putting the
 * valley back the way you had it.
 *
 * Everything that decides what Vibey says is pure over a `Memory`, so
 * `src/test/magicianMemory.test.ts` holds it without a browser.
 */
import type { Patch, WorldState } from "./state";

export interface Memory {
  name: string;
  visits: number;
  firstAt: number;
  lastAt: number;
  /** Spell label → how many times, across every visit. */
  spells: Record<string, number>;
  /** How the valley looked when you left it. */
  look: Patch | null;
}

const KEY = "magician.memory";

export function emptyMemory(): Memory {
  return { name: "", visits: 0, firstAt: 0, lastAt: 0, spells: {}, look: null };
}

export function readMemory(): Memory {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyMemory();
    const m = JSON.parse(raw) as Partial<Memory>;
    return {
      name: typeof m.name === "string" ? m.name.slice(0, 24) : "",
      visits: Number.isFinite(m.visits) ? Math.max(0, Number(m.visits)) : 0,
      firstAt: Number(m.firstAt) || 0,
      lastAt: Number(m.lastAt) || 0,
      spells: m.spells && typeof m.spells === "object" ? m.spells : {},
      look: m.look && typeof m.look === "object" ? m.look : null,
    };
  } catch {
    return emptyMemory();
  }
}

export function writeMemory(m: Memory): void {
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* private mode */ }
}

/** Arrive. Returns the memory as it was *before* this visit, which is what the greeting is about. */
export function arrive(prev: Memory, name: string, now = Date.now()): Memory {
  return { ...prev, name: name || prev.name, visits: prev.visits + 1, firstAt: prev.firstAt || now, lastAt: now };
}

/** The friendly name of a spell, or null for the ones not worth remembering (emotes, status). */
export function spellLabel(name: string, args: Record<string, unknown>): string | null {
  switch (name) {
    case "set_weather": return typeof args.weather === "string" ? ({ clear: "sunshine", cloudy: "clouds", rain: "rain", storm: "a storm", snow: "snow", fog: "fog" } as Record<string, string>)[args.weather] ?? null : null;
    case "set_time": {
      const h = Number(args.hour);
      if (!Number.isFinite(h)) return null;
      return h >= 17 && h < 20 ? "sunset" : h >= 20 || h < 5 ? "night" : h < 9 ? "dawn" : "daytime";
    }
    case "set_season": return typeof args.season === "string" ? args.season : null;
    case "sky_show": return Number(args.aurora) > 0 ? "aurora" : Number(args.meteors) > 0 ? "meteors" : Number(args.flood) > 0 ? "a flood" : null;
    case "spawn": return typeof args.kind === "string" ? ({ sakura: "cherry trees", balloon: "balloons", fox: "foxes", ufo: "UFOs", lantern: "lanterns", campfire: "campfires", snowman: "snowmen", rocket: "rockets", birds: "birds" } as Record<string, string>)[args.kind] ?? `${args.kind}s` : null;
    case "release_lantern": return args.sky === true ? "sky lanterns" : "wish lanterns";
    case "fireballs": return args.on === true || args.on === "true" ? "fireballs" : null;
    case "feed_koi": return "feeding the koi";
    case "become": return "shapeshifting";
    case "paint_sky": return "painting the sky";
    case "set_physics": return args.gravity === "moon" ? "moon gravity" : null;
    case "program_screen": return "the Magic Screen";
    case "start_game": return typeof args.mode === "string" ? (args.mode === "zombies" ? "zombie tag" : "games") : null;
    default: return null;
  }
}

export function recordSpell(m: Memory, label: string): Memory {
  return { ...m, spells: { ...m.spells, [label]: (m.spells[label] ?? 0) + 1 } };
}

/** Favourite spells, most cast first. */
export function favourites(m: Memory, n = 3): string[] {
  return Object.entries(m.spells).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

/** The part of the world worth putting back: how it looked, not what was in it. */
export function lookOf(s: WorldState): Patch {
  return {
    weather: s.weather, season: s.season, timeOfDay: s.timeOfDay, aurora: s.aurora, meteors: s.meteors,
    palette: s.palette, fireflies: s.fireflies, lanternsLit: s.lanternsLit, wind: s.wind, fog: s.fog,
  };
}

/** Where the friendship is. Visits count; a long absence is missed, not forgotten. */
export type Bond = "stranger" | "acquaintance" | "friend" | "old friend";
export function bond(visits: number): Bond {
  return visits <= 1 ? "stranger" : visits <= 3 ? "acquaintance" : visits <= 9 ? "friend" : "old friend";
}

const DAY = 86_400_000;

function ago(ms: number): string {
  if (ms < 3_600_000) return "a few minutes ago";
  if (ms < DAY) return "earlier today";
  if (ms < 2 * DAY) return "yesterday";
  if (ms < 7 * DAY) return `${Math.round(ms / DAY)} days ago`;
  if (ms < 30 * DAY) return `${Math.round(ms / (7 * DAY))} week${ms < 14 * DAY ? "" : "s"} ago`;
  return "a long while ago";
}

/** What an ask sounds like for a favourite: "Aurora again?" */
function again(label: string): string {
  const cap = label.charAt(0).toUpperCase() + label.slice(1);
  return `${cap} again?`;
}

/**
 * The first thing Vibey says, as a caption. `prev` is the memory before this
 * visit; `name` is who is here now. Deterministic given `pick`, for the tests.
 */
export function greeting(prev: Memory, name: string, now = Date.now(), pick: (n: number) => number = (n) => Math.floor(Math.random() * n)): string {
  const who = name.trim() || prev.name;
  const hi = who ? `, ${who}` : "";
  if (prev.visits === 0) {
    const opens = [`Oh! A new face${hi}. Welcome to Hoshimura.`, `Welcome to Hoshimura${hi}. Wish for anything.`, `Hello${hi}! I'm Vibey. The valley listens to wishes.`];
    return opens[pick(opens.length)];
  }
  const fav = favourites(prev, 1)[0];
  const away = now - prev.lastAt;
  if (away < 10 * 60_000) return `Back already${hi}? ${fav ? again(fav) : "Where were we?"}`;
  if (away > 14 * DAY) return `${who ? `${who}!` : "You!"} It's been ${ago(away).replace(" ago", "")}. I kept the valley for you.`;
  const b = bond(prev.visits + 1);
  if (b === "old friend") return `My old friend${hi}. ${fav ? again(fav) : "What shall we make today?"}`;
  if (b === "friend") return `Welcome back${hi}! ${fav ? again(fav) : "Good to see you."}`;
  return `Welcome back${hi}. ${fav ? again(fav) : "Wish for anything."}`;
}

/** Words for the voice model, so it can remember too. Empty for a first visit. */
export function memoryPrompt(prev: Memory, name: string, now = Date.now()): string {
  const who = name.trim() || prev.name;
  if (prev.visits === 0) {
    return `This is ${who ? `${who}'s` : "the visitor's"} first visit to Hoshimura. You have never met. Be warm and a little curious about them.`;
  }
  const favs = favourites(prev, 3);
  const b = bond(prev.visits + 1);
  return [
    `You remember this visitor${who ? `: ${who}` : ""}. This is visit number ${prev.visits + 1}; you last saw them ${ago(now - prev.lastAt)}. To you they are ${b === "old friend" ? "an old friend" : `a ${b}`}, and you speak to them that way${b === "acquaintance" ? " (friendly, still getting to know them)" : ""}.`,
    favs.length ? `Their favourite spells: ${favs.join(", ")}. You may tease them about it or offer one.` : "",
    prev.look ? `If they ask for "like last time" or "the usual", call like_last_time.` : "",
    "Never recite this memory as a list; let it show the way a friend's would.",
  ].filter(Boolean).join(" ");
}

/** The greeting instruction for the voice's first response, memory-aware. */
export function greetingPrompt(prev: Memory, name: string, now = Date.now()): string {
  const line = greeting(prev, name, now, () => 0);
  return `Greet the visitor in one warm sentence as Vibey the magician and wave. Something like: "${line}" Keep it under fifteen words and say it in your own way.`;
}

/**
 * A small arc inside one visit: a few things Vibey says unprompted as the
 * spells pile up. Returns a line when `count` (spells this visit) hits one.
 */
export function milestone(count: number, name: string): string | null {
  const n = name ? `, ${name}` : "";
  switch (count) {
    case 3: return `You're good at this${n}.`;
    case 8: return `We make a good team${n}.`;
    case 15: return "I have never seen the valley like this.";
    case 30: return `Best day in Hoshimura for a hundred years${n}.`;
    default: return null;
  }
}
