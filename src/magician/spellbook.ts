/**
 * The spellbook: plain words in, tool calls out, no model required.
 *
 * This exists for three reasons, in order of how often they matter:
 *
 *  1. Typing. Somebody on a train, or in a quiet room, can type "make it
 *     rain" into the HUD box and get rain. With a voice session up the text
 *     goes to the model instead (it can do far more), but the box still works
 *     with the session down.
 *  2. The sandbox. Nothing here can reach OpenAI, so this is how the whole
 *     tool → state → renderer pipeline gets exercised end to end before a
 *     human ever puts a headset on.
 *  3. Honesty. If the API key is missing or the account is out of credit, the
 *     magician is not dead — merely less eloquent.
 *
 * It is deliberately a dumb keyword matcher. It will never be clever, and it
 * does not need to be; the model is for that.
 */
import { PROP_KINDS, type PropKind } from "./state";

export interface SpellCall {
  name: string;
  args: Record<string, unknown>;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  dozen: 12, twenty: 20, thirty: 30, forty: 40, fifty: 50, few: 4, couple: 2, some: 5, several: 6, many: 20, lots: 25,
};

const KIND_WORDS: Array<[RegExp, PropKind]> = [
  [/\b(cherry|sakura|blossom)/, "sakura"],
  [/\bmaple/, "maple"],
  [/\bpine/, "pine"],
  [/\bbamboo/, "bamboo"],
  [/\blantern/, "lantern"],
  [/\btorii|\bgate\b/, "torii"],
  [/\bpagoda|\btemple\b/, "pagoda"],
  [/\bshrine/, "shrine"],
  [/\bhouse|\bhut|\bcottage|\bvillage/, "house"],
  [/\bboulder/, "boulder"],
  [/\brocks?\b|\bstones?\b/, "rock"],
  [/\bcampfire|\bbonfire|\bfire pit|\bfire\b(?!ball)/, "campfire"],
  [/\bflower|\bblossoms?\b(?! tree)/, "flowers"],
  [/\bcrystal|\bgem/, "crystal"],
  [/\bfox|\bkitsune/, "fox"],
  [/\bsnowman/, "snowman"],
  [/\bmushroom/, "mushroom"],
  [/\bwindmill/, "windmill"],
  [/\brocket|\bspaceship|\bspace ship/, "rocket"],
  [/\bufo|\bflying saucer|\balien ship/, "ufo"],
  [/\bballoon/, "balloon"],
  [/\bbirds?\b|\bflock|\bcrows?\b|\bcranes?\b/, "birds"],
  [/\bforest|\bwoods|\btrees?\b/, "tree"],
];

function countIn(text: string): number | null {
  if (/\bforest|\bwoods|\bgrove|\borchard/.test(text)) return 30;
  const m = text.match(/\b(\d{1,3})\b/);
  if (m) return parseInt(m[1], 10);
  for (const [w, n] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${w}\\b`).test(text)) return n;
  }
  return null;
}

function colorIn(text: string): string | undefined {
  const m = text.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/i);
  if (m) return m[0];
  const names = ["red", "pink", "purple", "violet", "blue", "cyan", "green", "yellow", "gold", "orange", "white", "black", "teal", "magenta", "lavender", "crimson"];
  for (const n of names) if (new RegExp(`\\b${n}\\b`).test(text)) return n;
  return undefined;
}

/** Turn a sentence into zero or more tool calls. */
export function castSpell(input: string): SpellCall[] {
  const t = input.toLowerCase().trim();
  if (!t) return [];
  const calls: SpellCall[] = [];

  if (/\breset\b|\bstart over\b|\bundo everything\b/.test(t)) return [{ name: "reset_world", args: {} }];

  // Games
  if (/\bzombies?\b|\bplay tag\b|\btag game\b/.test(t)) return [{ name: "start_game", args: { mode: "zombies" } }];
  if (/\b(oni|siege)\b/.test(t)) return [{ name: "start_game", args: { mode: "siege" } }];
  if (/\bspirit lights?\b|\bspirits\b|\blights game\b/.test(t)) return [{ name: "start_game", args: { mode: "spirits" } }];
  if (/\bdragon'?s? breath\b|\bdragon game\b|\bbells? game\b/.test(t)) return [{ name: "start_game", args: { mode: "dragon" } }];
  if (/\b(stop|end|quit) (the )?game\b|\bfree play\b/.test(t)) return [{ name: "end_game", args: {} }];
  if (/\bshield\b|\bprotect me\b/.test(t)) return [{ name: "shield", args: {} }];
  if (/\bblast\b|\bnuke\b|\bkill them all\b/.test(t)) return [{ name: "blast", args: {} }];

  // The river: wish lanterns and koi. Checked before anything that would
  // read "lantern" as the stone kind or as the village lights.
  if (/\bfeed (the )?(koi|fish)\b|\bkoi\b.*\bfood\b/.test(t)) return [{ name: "feed_koi", args: {} }];
  if (/\bsky lanterns?|\blanterns? (in|into|to) the sky|\blanterns? (rise|float up|fly)/.test(t)) {
    const w = input.match(/\b(?:reading|that says|for)\s+(.+)$/i);
    return [{ name: "release_lantern", args: { wish: w?.[1]?.trim() ?? "a wish", count: countIn(t) ?? 12, sky: true } }];
  }
  const wish = input.match(/\b(?:wish(?:ing)?(?: for| that)?|lanterns? (?:for|reading|that says))\s+(.+)$/i);
  if (wish || /\bfloat(ing)? (a |some )?lanterns?|\blanterns? (on|down) the (river|water)|\btoro nagashi|\bwish lanterns?/.test(t)) {
    return [{ name: "release_lantern", args: { wish: wish?.[1]?.trim() ?? "a wish", count: countIn(t) ?? 1 } }];
  }

  // The Magic Screen: anything said about the screen or the TV is for it.
  if (/\b(go|take me|teleport|travel|send me|bring me|walk me)\b.*\b(screen|tv)\b/.test(t)) return [{ name: "teleport", args: { place: "screen" } }];
  if (/\b(on|to|onto) the (magic |big )?(screen|tv|telly)\b|\b(screen|tv) (show|play)|\btelevision\b/.test(t)) {
    const change = /\b(make it|change it|make the|faster|slower|bigger|smaller|instead|add a|add some|more)\b/.test(t) && !/\bput\b/.test(t);
    return [{ name: "program_screen", args: { request: input.trim(), change } }];
  }

  // Time
  if (/\bmidnight\b/.test(t)) calls.push({ name: "set_time", args: { hour: 0 } });
  else if (/\bdawn\b|\bsunrise\b/.test(t)) calls.push({ name: "set_time", args: { hour: 5.6 } });
  else if (/\bmorning\b/.test(t)) calls.push({ name: "set_time", args: { hour: 8 } });
  else if (/\bnoon\b|\bmidday\b/.test(t)) calls.push({ name: "set_time", args: { hour: 12 } });
  else if (/\bgolden hour\b/.test(t)) calls.push({ name: "set_time", args: { hour: 17.5 } });
  else if (/\bsunset\b|\bevening\b/.test(t)) calls.push({ name: "set_time", args: { hour: 18.8 } });
  else if (/\bdusk\b/.test(t)) calls.push({ name: "set_time", args: { hour: 20 } });
  else if (/\bnight\b|\bdark\b/.test(t)) calls.push({ name: "set_time", args: { hour: 22.5 } });
  else if (/\bday(time)?\b|\bbright\b/.test(t) && !/\bday keeps|run/.test(t)) calls.push({ name: "set_time", args: { hour: 13 } });
  const hm = t.match(/\b(\d{1,2})\s*(am|pm|o'?clock)\b/);
  if (hm) {
    let h = parseInt(hm[1], 10) % 12;
    if (hm[2] === "pm") h += 12;
    calls.push({ name: "set_time", args: { hour: h } });
  }
  if (/\b(run|start) the (clock|day|time)\b|\btime (pass|flow)/.test(t)) calls.push({ name: "set_time", args: { hour: NaN, run_clock: true } });
  if (/\b(stop|freeze) (the )?(clock|time)\b/.test(t)) calls.push({ name: "set_time", args: { hour: NaN, run_clock: false } });

  // Weather
  // "Stop the rain" names rain, so the stopping has to be heard first.
  if (/\b(stop|end|no more|enough) (the |this )?(rain|snow|storm|thunder|fog|drizzle)\b|\bclear (the )?(sky|skies|weather)\b/.test(t)) calls.push({ name: "set_weather", args: { weather: "clear" } });
  else if (/\bthunder|\bstorm|\blightning/.test(t)) calls.push({ name: "set_weather", args: { weather: "storm" } });
  else if (/\bsnow(ing|y)?\b|\bblizzard/.test(t) && !/\bsnowman/.test(t)) calls.push({ name: "set_weather", args: { weather: "snow" } });
  else if (/\brain|\bdrizzle|\bpour/.test(t)) calls.push({ name: "set_weather", args: { weather: "rain" } });
  else if (/\bfog|\bmist|\bhaze/.test(t)) calls.push({ name: "set_weather", args: { weather: "fog" } });
  else if (/\bcloud/.test(t)) calls.push({ name: "set_weather", args: { weather: "cloudy" } });
  else if (/\bclear\b|\bsunny\b|\bstop (the )?(rain|snow|storm)\b|\bsunshine\b/.test(t)) calls.push({ name: "set_weather", args: { weather: "clear" } });
  if (/\bwindy|\bstrong wind|\bgale/.test(t)) calls.push({ name: "set_weather", args: { weather: calls.find((c) => c.name === "set_weather")?.args.weather ?? "cloudy", wind: 0.9 } });
  if (/\bcalm\b|\bstill air|\bno wind/.test(t)) calls.push({ name: "set_weather", args: { weather: calls.find((c) => c.name === "set_weather")?.args.weather ?? "clear", wind: 0 } });

  // Season
  for (const s of ["spring", "summer", "autumn", "winter"] as const) {
    if (new RegExp(`\\b${s}\\b`).test(t)) calls.push({ name: "set_season", args: { season: s } });
  }
  if (/\bfall\b/.test(t) && !/\bfall(s|ing)? (down|over)/.test(t)) calls.push({ name: "set_season", args: { season: "autumn" } });

  // Fireballs
  if (/\bfireball|\battack|\bdragon\b|\bshoot me/.test(t)) {
    const off = /\bstop\b|\boff\b|\bno more\b|\benough\b/.test(t);
    calls.push({ name: "fireballs", args: { on: !off, rate: /\bmore\b|\bfaster\b|\bharder\b/.test(t) ? 2 : 0.6 } });
  }

  // Sky effects
  if (/\baurora|\bnorthern lights/.test(t)) calls.push({ name: "sky_show", args: { aurora: /\boff\b|\bstop\b/.test(t) ? 0 : 1 } });
  if (/\bmeteor|\bshooting star/.test(t)) calls.push({ name: "sky_show", args: { meteors: /\boff\b|\bstop\b/.test(t) ? 0 : 1 } });
  if (/\bflood|\bdrown|\bwater rise/.test(t)) calls.push({ name: "sky_show", args: { flood: /\bdrain|\bstop\b|\bback\b/.test(t) ? 0 : 1 } });

  // Physics
  if (/\bmoon gravity|\blow gravity|\bfloaty|\bjump high/.test(t)) calls.push({ name: "set_physics", args: { gravity: "moon" } });
  if (/\bnormal gravity/.test(t)) calls.push({ name: "set_physics", args: { gravity: "normal" } });
  if (/\bheavy gravity/.test(t)) calls.push({ name: "set_physics", args: { gravity: "heavy" } });
  if (/\bfaster\b|\bspeed (me )?up|\brun fast/.test(t) && !/fireball/.test(t)) calls.push({ name: "set_physics", args: { speed: 2.2 } });
  if (/\bslower\b|\bslow (me )?down/.test(t)) calls.push({ name: "set_physics", args: { speed: 0.5 } });
  if (/\bmake me (a )?giant|\btiny world|\bshrink the world/.test(t)) calls.push({ name: "set_physics", args: { giant: 0.5 } });
  if (/\bmake me tiny|\bgiant world|\bhuge world/.test(t)) calls.push({ name: "set_physics", args: { giant: 2 } });

  // Palette
  if (/\bnatural colou?rs|\bnormal colou?rs|\bnormal sky/.test(t)) calls.push({ name: "paint_sky", args: { sky: "natural" } });
  else if (/\b(sky|world|everything)\b.*\b(purple|violet)\b|\b(purple|violet)\b.*\b(sky|world)\b/.test(t)) calls.push({ name: "paint_sky", args: { sky: "#3a0d7a", horizon: "#b56aff", ground: "#d9c2ff" } });
  else if (/\b(sky|world)\b.*\b(red|blood)\b|\b(red|blood)\b.*\bsky\b/.test(t)) calls.push({ name: "paint_sky", args: { sky: "#3d0000", horizon: "#ff3b1f", ground: "#ffb0a0" } });
  else if (/\bcandy|\bpastel|\bpink sky/.test(t)) calls.push({ name: "paint_sky", args: { sky: "#ff9ad5", horizon: "#fff1a8", ground: "#ffd6f0" } });
  else if (/\bgreen sky|\btoxic/.test(t)) calls.push({ name: "paint_sky", args: { sky: "#0b3d1d", horizon: "#7dff8a", ground: "#c8ffc8" } });

  // Lights
  if (/\blanterns?\b/.test(t) && !/\bspawn|\badd|\bmake|\bput|\bconjure|\bcreate/.test(t)) calls.push({ name: "set_lights", args: { lanterns: /\boff\b|\bout\b|\bdark/.test(t) ? "false" : "true" } });
  if (/\bfirefl/.test(t)) calls.push({ name: "set_lights", args: { fireflies: /\boff\b|\bno\b|\bstop/.test(t) ? "false" : "true" } });
  if (/\bpetals?\b|\bblossoms? (in the air|falling|everywhere)/.test(t)) calls.push({ name: "set_lights", args: { petals: /\bstop\b|\bno\b|\boff\b/.test(t) ? 0 : 1 } });

  // Teleport
  const tp = t.match(/\b(go|take me|teleport|travel|send me|bring me)\b.*\b(village|shrine|bridge|torii|gate|paddies|paddy|hilltop|hill|lake)\b/);
  if (tp) {
    const w = tp[2];
    const place = w === "gate" ? "torii" : w === "paddy" ? "paddies" : w === "hill" ? "hilltop" : w;
    calls.push({ name: "teleport", args: { place } });
  }

  // Sign / title
  const sign = t.match(/\bsign (say|read)s?\s+"?([^"]+)"?$/) ?? input.match(/\bsign (?:say|read)s?\s+"?([^"]+)"?$/i);
  if (sign) calls.push({ name: "write_sign", args: { text: (sign[2] ?? sign[1]).trim() } });
  const name = input.match(/\b(?:call|name) (?:this|the) (?:place|valley|world|village)\s+"?([^"]+)"?$/i);
  if (name) calls.push({ name: "write_sign", args: { title: name[1].trim() } });

  // Remove
  if (/\b(remove|delete|clear|vanish|get rid of|destroy)\b/.test(t)) {
    const kind = KIND_WORDS.find(([re]) => re.test(t))?.[1] ?? "all";
    calls.push({ name: "remove", args: { kind: /\beverything|\ball\b/.test(t) ? "all" : kind } });
  }
  // Spawn
  else if (/\b(spawn|add|make|put|conjure|create|plant|build|grow|summon|give me|i want|place)\b/.test(t) || (countIn(t) !== null && KIND_WORDS.some(([re]) => re.test(t)))) {
    const hit = KIND_WORDS.find(([re]) => re.test(t));
    if (hit && !/\bsnow(ing|y)?\b(?!man)/.test(t) && !(hit[1] === "campfire" && /fireball/.test(t))) {
      const count = countIn(t) ?? 1;
      const place = /\baround\b|\beverywhere\b|\bforest\b/.test(t) ? "around" : /\bshrine\b/.test(t) && hit[1] !== "shrine" ? "shrine" : /\bvillage\b/.test(t) && hit[1] !== "house" ? "village" : "here";
      const scale = /\bgiant|\bhuge|\bmassive|\benormous/.test(t) ? 3 : /\btiny|\bsmall|\blittle/.test(t) ? 0.4 : 1;
      calls.push({ name: "spawn", args: { kind: hit[1], count, place, scale, color: colorIn(t) } });
    }
  }

  // Emotes
  if (/\bdance\b/.test(t)) calls.push({ name: "emote", args: { clip: "Dance" } });
  if (/\bwave\b|\bhello\b|\bhi\b/.test(t)) calls.push({ name: "emote", args: { clip: "Wave" } });
  if (/\bjump\b/.test(t) && !/jump high/.test(t)) calls.push({ name: "emote", args: { clip: "Jump" } });
  if (/\bbell\b|\bgong\b/.test(t)) calls.push({ name: "play_sound", args: { name: /\bgong\b/.test(t) ? "gong" : "bell" } });
  if (/\bwhat (does|do) (it|the world|things) look like|\bdescribe/.test(t)) calls.push({ name: "look_around", args: {} });

  // Deduplicate set_time NaN calls where hour was not given
  return calls.map((c) => (c.name === "set_time" && Number.isNaN(c.args.hour as number) ? { ...c, args: { ...c.args, hour: undefined } } : c));
}

/** True when the words plainly want a thing the spellbook knows. Used to route typed text. */
export function spellbookKnows(input: string): boolean {
  return castSpell(input).length > 0;
}

export { PROP_KINDS };
