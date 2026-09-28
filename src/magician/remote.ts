/**
 * The valley from a phone: a spell remote.
 *
 * A projector shows the valley (`/magician?show`), everybody in the room
 * scans its code and gets `/magician?remote`: a grid of big buttons, no
 * three.js at all. A button runs the same tool the voice would, against a
 * store with no world behind it: `get` and `patch` are real (the phone keeps
 * the state it hears from the room, so a patch that appends a prop appends
 * it to the right list), and everything that would need a body or a screen
 * does nothing. The patch goes to the room like anybody's; a `c` message
 * after it signs it, so the valley can say "Maya made it snow".
 *
 * Pure apart from the room it is handed, so `src/test/magicianRemote.test.ts`
 * runs it in node.
 */
import { castSpell } from "./spellbook";
import { applyPatch, DEFAULT_STATE, type Patch, type WorldState } from "./state";
import { runTool, type MagicianStore } from "./tools";

export interface RemoteSpell {
  id: string;
  emoji: string;
  label: string;
  /** How the credit reads: "Maya {did}". */
  did: string;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}

/** Where a phone's spells happen: the village square, which is what the projector frames. */
export const REMOTE_SPOT = { x: 4, z: -2 };

export const REMOTE_SPELLS: RemoteSpell[] = [
  { id: "sun", emoji: "☀️", label: "Sunshine", did: "brought out the sun", calls: [{ name: "set_weather", args: { weather: "clear" } }, { name: "sky_show", args: { flood: 0 } }] },
  { id: "rain", emoji: "🌧️", label: "Rain", did: "made it rain", calls: [{ name: "set_weather", args: { weather: "rain" } }] },
  { id: "storm", emoji: "⛈️", label: "Storm", did: "summoned a storm", calls: [{ name: "set_weather", args: { weather: "storm" } }] },
  { id: "snow", emoji: "❄️", label: "Snow", did: "made it snow", calls: [{ name: "set_weather", args: { weather: "snow" } }] },
  { id: "fog", emoji: "🌫️", label: "Fog", did: "rolled in the fog", calls: [{ name: "set_weather", args: { weather: "fog" } }] },
  { id: "morning", emoji: "🌄", label: "Morning", did: "made it morning", calls: [{ name: "set_time", args: { hour: 8 } }] },
  { id: "sunset", emoji: "🌅", label: "Sunset", did: "painted a sunset", calls: [{ name: "set_time", args: { hour: 18.8 } }] },
  { id: "night", emoji: "🌙", label: "Night", did: "brought the night", calls: [{ name: "set_time", args: { hour: 22.5 } }] },
  { id: "aurora", emoji: "🌌", label: "Aurora", did: "lit the northern lights", calls: [{ name: "set_time", args: { hour: 22.5 } }, { name: "sky_show", args: { aurora: 1 } }] },
  { id: "meteors", emoji: "☄️", label: "Meteors", did: "started a meteor shower", calls: [{ name: "set_time", args: { hour: 23 } }, { name: "sky_show", args: { meteors: 1 } }] },
  { id: "lanterns", emoji: "🏮", label: "Sky lanterns", did: "released sky lanterns", calls: [{ name: "release_lantern", args: { count: 10, sky: true } }] },
  { id: "fireflies", emoji: "✨", label: "Fireflies", did: "let the fireflies out", calls: [{ name: "set_lights", args: { fireflies: true } }] },
  { id: "sakura", emoji: "🌸", label: "Cherry trees", did: "planted cherry trees", calls: [{ name: "spawn", args: { kind: "sakura", count: 5, place: "here", spread: 9 } }] },
  { id: "balloons", emoji: "🎈", label: "Balloons", did: "let go of the balloons", calls: [{ name: "spawn", args: { kind: "balloon", count: 8, place: "here", spread: 10 } }] },
  { id: "foxes", emoji: "🦊", label: "Foxes", did: "summoned foxes", calls: [{ name: "spawn", args: { kind: "fox", count: 4, place: "here", spread: 7 } }] },
  { id: "ufo", emoji: "🛸", label: "UFO", did: "called a UFO", calls: [{ name: "spawn", args: { kind: "ufo", count: 1, place: "here", scale: 1.6 } }] },
  { id: "autumn", emoji: "🍁", label: "Autumn", did: "turned it to autumn", calls: [{ name: "set_season", args: { season: "autumn" } }] },
  { id: "spring", emoji: "🌷", label: "Spring", did: "brought the spring", calls: [{ name: "set_season", args: { season: "spring" } }] },
];

/** Seconds a phone waits between spells: enough that a room of thirty is a conversation, not a strobe. */
export const REMOTE_COOLDOWN_S = 3;

/** A store with no world behind it: state is what the room told us, and a patch goes back to the room. */
export function headlessStore(get: () => WorldState, set: (s: WorldState) => void, send: (p: Patch) => void): MagicianStore {
  const noop = () => {};
  return {
    get,
    patch(p) {
      // Prop ids are a per-tab counter, so a phone's first tree would share an
      // id with somebody's first lantern. Give ours ids nobody else will pick.
      if (p.props) {
        const known = new Set(get().props.map((x) => x.id));
        p = { ...p, props: p.props.map((x) => (known.has(x.id) ? x : { ...x, id: 1e6 + Math.floor(Math.random() * 1e9) })) };
      }
      set(applyPatch(get(), p));
      send(p);
    },
    playerPosition: () => ({ ...REMOTE_SPOT, yaw: 0 }),
    teleport: noop,
    emote: noop,
    sound: noop,
    burst: noop,
    become: noop,
    game: { start: noop, stop: noop, active: () => null, status: () => "No game from a phone.", shield: () => "", blast: () => "" },
  };
}

export interface RemoteCast { did: string; emoji: string; landed: number }

/** Run one button (or a typed wish) against a store. How many tools actually did something is `landed`. */
export function castRemote(spell: RemoteSpell | string, store: MagicianStore, who: string): RemoteCast {
  if (typeof spell === "string") {
    const text = spell.trim().slice(0, 80);
    const calls = castSpell(text).filter((c) => SAFE_TOOLS.has(c.name));
    let landed = 0;
    for (const c of calls) if (runTool(c.name, c.args, store).toast) landed++;
    return { did: `cast "${text}"`, emoji: "✨", landed };
  }
  let landed = 0;
  for (const c of spell.calls) {
    const args = c.name === "release_lantern" ? { ...c.args, wish: `${who}'s wish` } : c.args;
    if (runTool(c.name, args, store).toast) landed++;
  }
  return { did: spell.did, emoji: spell.emoji, landed };
}

/** What a phone may do by typing: the world's look, never somebody's body, game or screen. */
const SAFE_TOOLS = new Set(["set_time", "set_weather", "set_season", "spawn", "paint_sky", "set_lights", "sky_show", "write_sign", "release_lantern", "turn_dial", "set_physics", "fireballs"]);

/** One line for the phone's header: what the valley is doing now. */
export function nowLine(s: WorldState): string {
  const w = { clear: "☀️ clear", cloudy: "☁️ cloudy", rain: "🌧️ rain", storm: "⛈️ storm", snow: "❄️ snow", fog: "🌫️ fog" }[s.weather];
  const h = s.timeOfDay;
  const t = h < 5 || h >= 21 ? "night" : h < 8 ? "dawn" : h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  return `${w} · ${t} · ${s.season}${s.aurora > 0.5 ? " · 🌌" : ""}`;
}

export const REMOTE_START: WorldState = applyPatch(DEFAULT_STATE, {});
