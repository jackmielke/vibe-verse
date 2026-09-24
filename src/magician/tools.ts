/**
 * Vibey's spells — the tools the voice agent can call, and what they do.
 *
 * Two halves, kept together on purpose so they cannot drift:
 *
 *  - `TOOL_DEFINITIONS` is the JSON-schema list handed to OpenAI. It is the
 *    only thing the model ever sees about the world, so every description is
 *    written for the model, not for us.
 *  - `runTool` executes one call against a `MagicianStore` and returns a short
 *    string the model reads back. Every tool returns *something*, because a
 *    silent tool is one the model will call again.
 *
 * The functions are pure over the store: they read state, produce a patch,
 * and the world eases toward it. Nothing here touches three.js, which is what
 * lets `src/test/magicianTools.test.ts` run all of it in node.
 */
import {
  applyPatch,
  describeState,
  DEFAULT_STATE,
  PLACES,
  PROP_KINDS,
  type Palette,
  type Patch,
  type Place,
  type Prop,
  type PropKind,
  type Season,
  type Weather,
  type WorldState,
} from "./state";
import { resolveCompanion } from "./companions";

export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Where things are in the valley, in metres. `heightAt` is applied by the renderer. */
export const LANDMARKS: Record<Exclude<Place, "here" | "around">, { x: number; z: number; yaw?: number }> = {
  village: { x: 0, z: 0 },
  bridge: { x: 22, z: -0.8, yaw: -1.1 },
  torii: { x: -30, z: -34 },
  shrine: { x: -46, z: -62, yaw: Math.PI },
  paddies: { x: 42, z: 30 },
  hilltop: { x: 70, z: -70 },
  lake: { x: 60, z: 56 },
};

/** What the tool runner needs from the outside world. */
export interface MagicianStore {
  get(): WorldState;
  patch(p: Patch): void;
  /** Where the player is standing right now, so "here" means something. */
  playerPosition(): { x: number; z: number; yaw: number };
  /** Move the player. */
  teleport(x: number, z: number, yaw?: number): void;
  /** Vibey plays a clip: Wave, Dance, Jump, Yes, No, ThumbsUp, Punch. */
  emote(clip: string): void;
  /** One-shot sound effects. */
  sound(name: "bell" | "thunder" | "gong" | "chime" | "whoosh"): void;
  /** Something visual and momentary: a flash, a burst of sparkles at a point. */
  burst(kind: "sparkle" | "smoke" | "flash", x?: number, z?: number): void;
  /** Swap the companion's body to a roster character id. */
  become(id: string): void;
  /** Throw food to the koi, walking to the bridge first if needed. */
  feedKoi?(): string;
  /** The game layer. */
  game: {
    start(mode: "siege" | "spirits" | "dragon"): void;
    stop(): void;
    active(): "siege" | "spirits" | "dragon" | null;
    status(): string;
    shield(): string;
    blast(): string;
  };
}

const weatherEnum: Weather[] = ["clear", "cloudy", "rain", "storm", "snow", "fog"];
const seasonEnum: Season[] = ["spring", "summer", "autumn", "winter"];

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    name: "set_time",
    description:
      "Set the time of day in the valley. Hours 0-24: 5.5 dawn, 7 morning, 12 noon, 17.5 golden hour, 19 sunset, 21 dusk, 0 midnight. Use for 'make it night', 'sunset', 'morning', 'noon'.",
    parameters: {
      type: "object",
      properties: {
        hour: { type: "number", description: "Hour of day, 0-24, decimals allowed." },
        run_clock: { type: "boolean", description: "If true the day keeps passing on its own (a full day takes ten minutes). Default keeps the current setting." },
      },
      required: ["hour"],
    },
  },
  {
    type: "function",
    name: "set_weather",
    description:
      "Change the weather. Rain, storm and snow put out any fireballs in the air. 'storm' adds lightning and thunder. 'fog' is a thick marine layer.",
    parameters: {
      type: "object",
      properties: {
        weather: { type: "string", enum: weatherEnum },
        wind: { type: "number", description: "Optional wind strength 0-1." },
        fog: { type: "number", description: "Optional extra fog 0-1 on top of the weather." },
      },
      required: ["weather"],
    },
  },
  {
    type: "function",
    name: "set_season",
    description:
      "Change the season. Spring: cherry blossom and petals in the air. Summer: deep green, fireflies at night. Autumn: red maples and falling leaves. Winter: snow on the ground and bare trees.",
    parameters: { type: "object", properties: { season: { type: "string", enum: seasonEnum } }, required: ["season"] },
  },
  {
    type: "function",
    name: "spawn",
    description:
      "Conjure things into the world. On the ground: tree, sakura (cherry tree), maple, pine, bamboo, lantern (stone lantern, glows at night), torii (red gate), house (village house), shrine, rock, boulder, campfire, flowers, crystal (glowing), fox (kitsune statue), snowman, mushroom, pagoda, windmill. In the sky: rocket (launches from where it appears and climbs), ufo (hovers and spins with a beam), balloon (hot-air balloon drifting on the wind), birds (a circling flock). Anything not on this list: pick the closest kind and say so. Use count for 'a forest' (20-40) or 'a few' (3-5). 'around' scatters them around the player, 'here' puts them right in front.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: PROP_KINDS },
        count: { type: "integer", description: "How many, 1-60. Default 1." },
        place: { type: "string", enum: PLACES, description: "Where. Default 'here'." },
        spread: { type: "number", description: "Metres of scatter around the place, 0-80. Default depends on count." },
        scale: { type: "number", description: "Size multiplier 0.2-6. 1 is natural. 'giant' is 3, 'tiny' is 0.3." },
        color: { type: "string", description: "Optional CSS hex colour like #ff66aa to tint the thing (blossom, crystal glow, house walls...)." },
      },
      required: ["kind"],
    },
  },
  {
    type: "function",
    name: "remove",
    description: "Make conjured things vanish. kind 'all' clears everything that was spawned by magic. The village itself always stays.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", description: "A prop kind, or 'all'." },
        near_player_only: { type: "boolean", description: "Only remove ones within 25 metres of the player." },
      },
      required: ["kind"],
    },
  },
  {
    type: "function",
    name: "paint_sky",
    description:
      "Override the colours of the world for a mood: e.g. a purple dream, a blood-red sky, a candy world, a monochrome world. Pass 'natural' as sky to go back to the real colours.",
    parameters: {
      type: "object",
      properties: {
        sky: { type: "string", description: "Zenith colour as CSS hex, or 'natural' to reset." },
        horizon: { type: "string", description: "Horizon colour as CSS hex." },
        ground: { type: "string", description: "Tint multiplied into ground and trees as CSS hex. #ffffff leaves them alone." },
      },
      required: ["sky"],
    },
  },
  {
    type: "function",
    name: "set_lights",
    description: "Lanterns and fireflies. Each can be true, false, or 'auto' (lanterns follow dusk, fireflies come out on summer nights).",
    parameters: {
      type: "object",
      properties: {
        lanterns: { type: "string", enum: ["true", "false", "auto"] },
        fireflies: { type: "string", enum: ["true", "false", "auto"] },
        petals: { type: "number", description: "Petals/leaves in the air 0-1, or -1 for auto." },
      },
    },
  },
  {
    type: "function",
    name: "fireballs",
    description:
      "Turn the mountain's fireballs on or off. When on, fireballs fly at the player from the peak; each hit counts. Rain, storm or snow put them out mid-air. A fun 'attack me' or 'dragon' mode.",
    parameters: {
      type: "object",
      properties: {
        on: { type: "boolean" },
        rate: { type: "number", description: "Fireballs per second, 0.1-5. Default 0.6." },
      },
      required: ["on"],
    },
  },
  {
    type: "function",
    name: "set_physics",
    description: "Change how the player moves. gravity: normal, moon (huge floaty jumps), heavy. speed: walk speed multiplier 0.3-4. giant: scale of the world 0.4-2.5 (below 1 the player feels giant, above 1 tiny).",
    parameters: {
      type: "object",
      properties: {
        gravity: { type: "string", enum: ["normal", "moon", "heavy"] },
        speed: { type: "number" },
        giant: { type: "number" },
      },
    },
  },
  {
    type: "function",
    name: "sky_show",
    description: "Big sky effects. aurora 0-1 paints northern lights over the ridge (best at night). meteors 0-1 sends shooting stars. flood 0-1 raises the river until the valley is a lake.",
    parameters: {
      type: "object",
      properties: { aurora: { type: "number" }, meteors: { type: "number" }, flood: { type: "number" } },
    },
  },
  {
    type: "function",
    name: "teleport",
    description: "Take the player somewhere: village, shrine, bridge, torii, paddies, hilltop, lake.",
    parameters: { type: "object", properties: { place: { type: "string", enum: PLACES.filter((p) => p !== "here" && p !== "around") } }, required: ["place"] },
  },
  {
    type: "function",
    name: "write_sign",
    description: "Change what the wooden sign by the bridge says, and/or rename the place. Keep sign text under 40 characters.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" }, title: { type: "string", description: "A new name for the valley." } },
    },
  },
  {
    type: "function",
    name: "emote",
    description: "Do something with your body: Wave, Dance, Jump, Yes, No, ThumbsUp, Punch. Use when greeting, celebrating, agreeing, refusing.",
    parameters: { type: "object", properties: { clip: { type: "string", enum: ["Wave", "Dance", "Jump", "Yes", "No", "ThumbsUp", "Punch"] } }, required: ["clip"] },
  },
  {
    type: "function",
    name: "play_sound",
    description: "A one-shot sound: bell (temple bell), gong, thunder, chime, whoosh.",
    parameters: { type: "object", properties: { name: { type: "string", enum: ["bell", "gong", "thunder", "chime", "whoosh"] } }, required: ["name"] },
  },
  {
    type: "function",
    name: "start_game",
    description:
      "Start a game in the valley. 'siege': Oni Siege, five waves of oni attack the village; the visitor shoots bolts and you fight beside them, and weather is a weapon (rain drowns fire oni, snow slows, storm lightning strikes them, flood drowns). 'spirits': Spirit Lights, gather 30 lights in two minutes while a yurei hunts the visitor; fog hides them, lit lanterns repel it. 'dragon': Dragon's Breath, the mountain throws fireballs faster and faster while the visitor rings three bells (bridge, torii, shrine); rain buys time. Use when the visitor wants to play, fight, or a game.",
    parameters: { type: "object", properties: { mode: { type: "string", enum: ["siege", "spirits", "dragon"] } }, required: ["mode"] },
  },
  {
    type: "function",
    name: "end_game",
    description: "Stop the current game and go back to free play.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "game_status",
    description: "Read the state of the current game: objective, score, hearts, wave or timer, spell cooldowns. Call before commenting on how the fight is going.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "shield",
    description: "Cast a shield around the visitor: 12 seconds of immunity from oni and fireballs, 25 second cooldown. Only during a game. Use when asked to protect, shield, or save them.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "blast",
    description: "Cast a blast: every enemy within 9 metres of the visitor is destroyed, 30 second cooldown. Only during a game. Use when asked to blast, nuke, clear them out, or when the visitor is surrounded.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "become",
    description:
      "Change your own body to another character from the vibeverse roster: e.g. 'wizard', 'witch', 'pug', 'cow', 'knight', 'ninja', 'pirate', 'elf', 'goblin', 'viking', 'zombie', 'skeleton', 'shark', or 'vibey' / 'classic vibey' to go back. The hat stays on.",
    parameters: { type: "object", properties: { character: { type: "string", description: "Who to become, in plain words." } }, required: ["character"] },
  },
  {
    type: "function",
    name: "look_around",
    description: "Read the current state of the world: time, weather, season, what has been conjured, where the player is. Call this when asked what the world looks like or before undoing something.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "reset_world",
    description: "Put the valley back the way it was when the visitor arrived: golden afternoon, spring, clear, nothing conjured.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "release_lantern",
    description:
      "Set a glowing paper wish lantern (toro nagashi) on the river at the red drum bridge. It drifts downstream to the lake over a few minutes and everyone in the valley sees it. Use when the visitor makes a wish, remembers someone, or asks for lanterns on the water. Write their wish on it in a few words.",
    parameters: {
      type: "object",
      properties: {
        wish: { type: "string", description: "What is written on the lantern, a few words, in the visitor's language." },
        count: { type: "number", description: "How many lanterns, 1-8. Default 1." },
      },
      required: ["wish"],
    },
  },
  {
    type: "function",
    name: "feed_koi",
    description: "Scatter food on the river for the koi under the drum bridge; they race for it. Takes the visitor to the bridge first if they are not there.",
    parameters: { type: "object", properties: {} },
  },
];

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

let nextPropId = 1;
export function resetPropIds(): void { nextPropId = 1; }

function num(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : fallback;
}

function hex(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return ("#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
  const named: Record<string, string> = {
    red: "#e0342c", pink: "#ff8ac8", purple: "#8a4fff", violet: "#8a4fff", blue: "#3d7bff", cyan: "#3de0ff",
    green: "#3fbf5a", yellow: "#ffd43b", gold: "#ffc24a", orange: "#ff8c2b", white: "#ffffff", black: "#101010",
    grey: "#8a8a8a", gray: "#8a8a8a", teal: "#2ec4b6", magenta: "#ff3dd6", lavender: "#c7a6ff", crimson: "#b8102e",
  };
  return named[s.toLowerCase()];
}

function bool3(v: unknown): boolean | "auto" | undefined {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  if (v === "auto") return "auto";
  return undefined;
}

/** A deterministic-enough scatter that reads as natural rather than gridded. */
function scatter(cx: number, cz: number, count: number, spread: number, rnd: () => number): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const r = spread * Math.sqrt(rnd());
    out.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r });
  }
  return out;
}

export function resolvePlace(place: Place | undefined, store: MagicianStore): { x: number; z: number; yaw: number } {
  const p = store.playerPosition();
  if (!place || place === "here") {
    // Three metres in front of where the player is looking.
    return { x: p.x - Math.sin(p.yaw) * 4, z: p.z - Math.cos(p.yaw) * 4, yaw: p.yaw };
  }
  if (place === "around") return { x: p.x, z: p.z, yaw: p.yaw };
  const l = LANDMARKS[place];
  return { x: l.x, z: l.z, yaw: l.yaw ?? 0 };
}

export interface ToolResult {
  /** What the model reads. */
  output: string;
  /** For the HUD: a short human line, or null for silent reads. */
  toast: string | null;
}

export function runTool(name: string, rawArgs: unknown, store: MagicianStore, rnd: () => number = Math.random): ToolResult {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const s = store.get();
  switch (name) {
    case "set_time": {
      const hour = num(args.hour, s.timeOfDay);
      const patch: Patch = { timeOfDay: hour };
      if (typeof args.run_clock === "boolean") patch.clockRunning = args.run_clock;
      store.patch(patch);
      store.burst("sparkle");
      const label = hour < 5 ? "deep night" : hour < 8 ? "dawn" : hour < 12 ? "morning" : hour < 16 ? "afternoon" : hour < 19 ? "golden hour" : hour < 21 ? "dusk" : "night";
      return { output: `Time set to ${hour.toFixed(1)}h (${label}).`, toast: `time → ${label}` };
    }
    case "set_weather": {
      const w = weatherEnum.includes(args.weather as Weather) ? (args.weather as Weather) : null;
      if (!w) return { output: `Unknown weather. Use one of ${weatherEnum.join(", ")}.`, toast: null };
      const patch: Patch = { weather: w };
      if (args.wind !== undefined) patch.wind = num(args.wind, s.wind);
      if (args.fog !== undefined) patch.fog = num(args.fog, s.fog);
      store.patch(patch);
      if (w === "storm") store.sound("thunder");
      else store.sound("whoosh");
      const fizz = s.fireballs.on && (w === "rain" || w === "storm" || w === "snow") ? " The fireballs are hissing out in the wet." : "";
      return { output: `Weather is now ${w}.${fizz}`, toast: `weather → ${w}` };
    }
    case "set_season": {
      const season = seasonEnum.includes(args.season as Season) ? (args.season as Season) : null;
      if (!season) return { output: `Unknown season. Use one of ${seasonEnum.join(", ")}.`, toast: null };
      store.patch({ season });
      store.burst("sparkle");
      return { output: `Season is now ${season}.`, toast: `season → ${season}` };
    }
    case "spawn": {
      const kind = PROP_KINDS.includes(args.kind as PropKind) ? (args.kind as PropKind) : null;
      if (!kind) return { output: `Unknown kind. Use one of ${PROP_KINDS.join(", ")}.`, toast: null };
      const count = Math.round(Math.min(60, Math.max(1, num(args.count, 1))));
      const place = (PLACES.includes(args.place as Place) ? args.place : "here") as Place;
      const at = resolvePlace(place, store);
      const defaultSpread = count === 1 ? 0 : place === "around" ? 10 + count * 0.6 : 4 + count * 0.5;
      const spread = Math.min(80, Math.max(0, num(args.spread, defaultSpread)));
      const scale = Math.min(6, Math.max(0.2, num(args.scale, 1)));
      const color = hex(args.color);
      const points = scatter(at.x, at.z, count, spread, rnd);
      const props: Prop[] = points.map((p) => ({
        id: nextPropId++, kind, x: p.x, z: p.z, scale: scale * (0.85 + rnd() * 0.3), yaw: rnd() * Math.PI * 2, color,
      }));
      store.patch({ props: [...s.props, ...props] });
      store.burst("sparkle", at.x, at.z);
      store.sound("chime");
      return { output: `Conjured ${count} ${kind}${count > 1 ? "s" : ""} at ${place}${color ? ` in ${color}` : ""}.`, toast: `+${count} ${kind}` };
    }
    case "remove": {
      const kind = String(args.kind ?? "all");
      const nearOnly = args.near_player_only === true;
      const p = store.playerPosition();
      const keep = s.props.filter((prop) => {
        const matches = kind === "all" || prop.kind === kind;
        if (!matches) return true;
        if (nearOnly) {
          const d = Math.hypot(prop.x - p.x, prop.z - p.z);
          return d > 25;
        }
        return false;
      });
      const removed = s.props.length - keep.length;
      store.patch({ props: keep });
      if (removed > 0) { store.burst("smoke"); store.sound("whoosh"); }
      return { output: `Removed ${removed} ${kind === "all" ? "things" : kind + "(s)"}.`, toast: removed ? `−${removed} ${kind}` : null };
    }
    case "paint_sky": {
      if (args.sky === "natural" || args.sky === "reset") {
        store.patch({ palette: null });
        return { output: "Sky back to natural colours.", toast: "sky → natural" };
      }
      const sky = hex(args.sky);
      if (!sky) return { output: "Give sky as a CSS hex colour like #6a2cff, or 'natural'.", toast: null };
      const palette: Palette = {
        sky,
        horizon: hex(args.horizon) ?? sky,
        ground: hex(args.ground) ?? "#ffffff",
      };
      store.patch({ palette });
      store.burst("flash");
      return { output: `Painted the sky ${palette.sky} over ${palette.horizon}, ground tint ${palette.ground}.`, toast: "sky painted" };
    }
    case "set_lights": {
      const patch: Patch = {};
      const l = bool3(args.lanterns); if (l !== undefined) patch.lanternsLit = l;
      const f = bool3(args.fireflies); if (f !== undefined) patch.fireflies = f;
      if (args.petals !== undefined) { const v = num(args.petals, -1); patch.petals = v < 0 ? "auto" : v; }
      store.patch(patch);
      return { output: `Lights updated: lanterns ${patch.lanternsLit ?? s.lanternsLit}, fireflies ${patch.fireflies ?? s.fireflies}, petals ${patch.petals ?? s.petals}.`, toast: "lights" };
    }
    case "fireballs": {
      const on = args.on === true || args.on === "true";
      const rate = num(args.rate, s.fireballs.rate);
      store.patch({ fireballs: { on, rate } });
      if (on) store.sound("gong");
      const wet = s.weather === "rain" || s.weather === "storm" || s.weather === "snow";
      return {
        output: on ? `Fireballs ON at ${rate}/s.${wet ? " Note: the weather is wet, so they will fizzle before they land." : ""}` : "Fireballs off.",
        toast: on ? "🔥 fireballs" : "fireballs off",
      };
    }
    case "set_physics": {
      const patch: Patch = {};
      if (["normal", "moon", "heavy"].includes(args.gravity as string)) patch.gravity = args.gravity as WorldState["gravity"];
      if (args.speed !== undefined) patch.speed = num(args.speed, s.speed);
      if (args.giant !== undefined) patch.giant = num(args.giant, s.giant);
      store.patch(patch);
      return { output: `Physics: gravity ${patch.gravity ?? s.gravity}, speed x${patch.speed ?? s.speed}, world scale x${patch.giant ?? s.giant}.`, toast: "physics" };
    }
    case "sky_show": {
      const patch: Patch = {};
      if (args.aurora !== undefined) patch.aurora = num(args.aurora, s.aurora);
      if (args.meteors !== undefined) patch.meteors = num(args.meteors, s.meteors);
      if (args.flood !== undefined) patch.flood = num(args.flood, s.flood);
      store.patch(patch);
      store.burst("sparkle");
      return { output: `Sky show: aurora ${patch.aurora ?? s.aurora}, meteors ${patch.meteors ?? s.meteors}, flood ${patch.flood ?? s.flood}.`, toast: "sky show" };
    }
    case "teleport": {
      const place = args.place as Place;
      if (!(place in LANDMARKS)) return { output: `Unknown place. Use one of ${Object.keys(LANDMARKS).join(", ")}.`, toast: null };
      const at = resolvePlace(place, store);
      store.teleport(at.x, at.z, at.yaw);
      store.sound("whoosh");
      store.burst("flash");
      return { output: `The player is now at the ${place}.`, toast: `→ ${place}` };
    }
    case "write_sign": {
      const patch: Patch = {};
      if (typeof args.text === "string") patch.sign = args.text.slice(0, 48);
      if (typeof args.title === "string" && args.title.trim()) patch.title = args.title.trim().slice(0, 40);
      store.patch(patch);
      return { output: `Sign now reads "${patch.sign ?? s.sign}"; place is called ${patch.title ?? s.title}.`, toast: patch.title ? `named ${patch.title}` : "sign written" };
    }
    case "emote": {
      const clip = String(args.clip ?? "Wave");
      store.emote(clip);
      return { output: `Played ${clip}.`, toast: null };
    }
    case "play_sound": {
      const n = String(args.name ?? "chime") as Parameters<MagicianStore["sound"]>[0];
      store.sound(n);
      return { output: `Played ${n}.`, toast: null };
    }
    case "start_game": {
      const mode = args.mode as "siege" | "spirits" | "dragon";
      if (!["siege", "spirits", "dragon"].includes(mode)) return { output: "Unknown mode. Use siege, spirits or dragon.", toast: null };
      store.game.start(mode);
      return { output: `Started ${mode}. ${store.game.status()}`, toast: null };
    }
    case "end_game": {
      const was = store.game.active();
      store.game.stop();
      return { output: was ? `Stopped ${was}. Back to free play.` : "No game was running.", toast: was ? "free play" : null };
    }
    case "game_status":
      return { output: store.game.status(), toast: null };
    case "shield":
      return { output: store.game.shield(), toast: null };
    case "blast":
      return { output: store.game.blast(), toast: null };
    case "become": {
      const { match, suggest } = resolveCompanion(String(args.character ?? ""));
      if (!match) return { output: `No such character. Try one of: ${suggest.join(", ")}.`, toast: null };
      store.become(match.id);
      store.burst("flash");
      store.sound("chime");
      return { output: `You are now ${match.label}.${suggest.length ? ` (Also close: ${suggest.join(", ")}.)` : ""}`, toast: `became ${match.label}` };
    }
    case "look_around": {
      const p = store.playerPosition();
      return { output: `${describeState(s)}\nPlayer at x=${p.x.toFixed(0)} z=${p.z.toFixed(0)}.`, toast: null };
    }
    case "reset_world": {
      // Lanterns already on the water are other people's wishes; they stay.
      store.patch({ ...DEFAULT_STATE, props: [], wishes: store.get().wishes });
      store.burst("flash");
      store.sound("gong");
      return { output: "The valley is back to how it was.", toast: "reset" };
    }
    case "release_lantern": {
      const text = String(args.wish ?? "").trim().slice(0, 60) || "a wish";
      const n = Math.max(1, Math.min(8, Math.round(Number(args.count ?? 1)) || 1));
      const now = Date.now();
      const made = Array.from({ length: n }, (_, i) => ({ id: Math.floor(rnd() * 1e9), text, born: now + i * 2500 }));
      store.patch({ wishes: [...store.get().wishes, ...made] });
      store.sound("chime");
      return { output: `${n === 1 ? "A lantern is" : `${n} lanterns are`} on the river at the bridge, reading "${text}". ${n === 1 ? "It drifts" : "They drift"} down to the lake over the next few minutes.`, toast: `🏮 "${text}"` };
    }
    case "feed_koi": {
      if (!store.feedKoi) return { output: "There are no koi here.", toast: null };
      return { output: store.feedKoi(), toast: "🐟 feeding the koi" };
    }
    default:
      return { output: `Unknown tool ${name}.`, toast: null };
  }
}

/** Reset the state wholesale, used by `reset_world` and tests. */
export function freshState(): WorldState {
  return applyPatch(DEFAULT_STATE, { props: [] });
}
