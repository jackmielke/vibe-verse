/**
 * What the bodyguards can be told, three ways round: as tool definitions for
 * the voice model, as a keyword parser that makes the same calls with no
 * model at all (typing, the sandbox, a missing key), and as the one function
 * that runs a call against the squad. Same shape as the Magician's
 * `tools.ts` + `spellbook.ts`, which is the point: the voice is optional,
 * the commands are not.
 */
import type { ToolDefinition } from "@/magician/tools";
import { GUARD_IDS, GUARD_ORDERS, type Bodyguards, type GuardId, type GuardOrder } from "./bodyguards";

export interface SquadCall {
  name: "hire_bodyguards" | "dismiss_bodyguards" | "command_bodyguards" | "squad_status";
  args: { who?: GuardId | "all"; order?: GuardOrder };
}

const WHO = { type: "string", enum: [...GUARD_IDS, "all"], description: "kenji, hana, goro, or all of them." };

export const SQUAD_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    name: "hire_bodyguards",
    description: "Call bodyguards to the player's side. They appear in a puff of smoke and follow. Use for 'I need backup', 'protect me', 'call Kenji', 'get the squad'.",
    parameters: { type: "object", properties: { who: WHO }, required: ["who"] },
  },
  {
    type: "function",
    name: "dismiss_bodyguards",
    description: "Send bodyguards home. Use for 'go home', 'you're dismissed', 'I'm fine alone'.",
    parameters: { type: "object", properties: { who: WHO }, required: ["who"] },
  },
  {
    type: "function",
    name: "command_bodyguards",
    description:
      "Give hired bodyguards an order. follow: stay close and defend the player (default). stay: hold the current spot and defend it. attack: go hunting police cruisers up to 70 m away. peace: follow but never fight. cheer: stop and celebrate. Hires them first if they are off duty.",
    parameters: {
      type: "object",
      properties: { who: WHO, order: { type: "string", enum: GUARD_ORDERS } },
      required: ["who", "order"],
    },
  },
  {
    type: "function",
    name: "squad_status",
    description: "Who is on duty, what each is doing, how many cruisers they have wrecked, and how close the police are. Call before answering a question about the fight.",
    parameters: { type: "object", properties: {} },
  },
];

export const SQUAD_VOICE_PROMPT = `You are the voice of the player's bodyguard squad in Vibe City, a bright toy-like city of streets, parks and skyscrapers where the police chase anybody who causes trouble. The squad is three samurai:
- Kenji, the leader: calm, loyal, dry humour, a katana. You speak as Kenji unless the moment belongs to another.
- Hana: a quick, teasing ninja who throws shuriken from a distance and keeps fighting from the car window.
- Goro: huge, gentle, slow, says very few words, swings a giant nodachi that takes a cruiser apart in three blows.
When you speak as Hana or Goro, say their name first ("Hana: on it!").

You change the world for real by calling tools: calling the squad, sending them home, giving orders (follow, stay, attack, peace, cheer). When the player asks for anything the squad can do, do it at once with a tool, then answer in one short line in character. Act first, talk second. Never say the word "tool". Never ask for permission.

Manner: short, punchy, in character, like a squad on a radio. One sentence, two at most. The player is probably mid-chase, so keep it brief. When told something happened in the world (a cruiser wrecked, police closing in), react in a few words.`;

export const SQUAD_BACKEND_PROMPT = `You control the bodyguard squad by calling tools. Map plain language to calls:
- "protect me", "backup", "call the squad", "I need help", "bodyguards" -> hire_bodyguards all. A name ("get Hana") -> just that one.
- "get them", "attack", "take out the cops", "fight", "charge" -> command_bodyguards attack (all unless named).
- "follow me", "come back", "regroup", "with me" -> command_bodyguards follow.
- "stay here", "hold this spot", "guard the car" -> command_bodyguards stay.
- "stand down", "no fighting", "chill", "hold fire" -> command_bodyguards peace.
- "celebrate", "dance", "cheer" -> command_bodyguards cheer.
- "go home", "dismissed", "leave" -> dismiss_bodyguards.
- Questions about the fight or the squad -> squad_status, then answer from it.
Several calls in one turn are fine. Keep any text output to one short line; the voice will read it.`;

export const SQUAD_REALTIME_PROMPT = `${SQUAD_VOICE_PROMPT}\n\nHow to act:\n${SQUAD_BACKEND_PROMPT}`;

export const SQUAD_GREETING =
  "As Kenji, greet the player in one short sentence: the squad is ready, and they can just say what they need. Under twelve words.";

// ---- The keyword parser ---------------------------------------------------

const NAME_WORDS: Array<[RegExp, GuardId]> = [
  [/\bkenji\b|\bleader\b|\bsword(sman)?\b|\bkatana\b/, "kenji"],
  [/\bhana\b|\bninja\b|\bshuriken\b|\bstars?\b/, "hana"],
  [/\bgoro\b|\bbig (guy|man|one)\b|\bgiant\b/, "goro"],
];

/** Which guard a sentence names, or all of them. */
export function whoIn(text: string): GuardId | "all" {
  const t = text.toLowerCase();
  const named = NAME_WORDS.filter(([re]) => re.test(t)).map(([, id]) => id);
  return named.length === 1 ? named[0] : "all";
}

/**
 * Plain words in, squad calls out. Deliberately dumb: the voice model does
 * the clever version, and this keeps typing working when the voice is down.
 * Returns an empty list for anything it does not recognise.
 */
export function parseSquadCommand(text: string): SquadCall[] {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ")} `;
  const who = whoIn(t);
  const order = (o: GuardOrder): SquadCall[] => [{ name: "command_bodyguards", args: { who, order: o } }];
  if (/\b(dismiss(ed)?|go home|you'?re fired|send (them|him|her|everyone|\w+) home|leave me( alone)?|bye|goodbye|go away)\b/.test(t)) {
    return [{ name: "dismiss_bodyguards", args: { who } }];
  }
  if (/\b(stand down|no fighting|stop fighting|hold (your )?fire|chill|calm down|peace|don'?t fight|be nice)\b/.test(t)) return order("peace");
  if (/\b(status|report|how (are|is) (you|everyone|the squad|it going)|where are (you|they)|sitrep)\b/.test(t)) {
    return [{ name: "squad_status", args: {} }];
  }
  if (/\b(attack|fight|charge|get (them|him|her|'?em|the cops|the police)|take (them|'?em|him|it) (out|down)|kill|destroy|smash (them|the cops)|go get|sic|wreck)\b/.test(t)) return order("attack");
  if (/\b(stay|wait( here)?|hold (this|the|your)? ?(spot|ground|position|line)|guard (this|the|here)|don'?t move|stop here)\b/.test(t)) return order("stay");
  if (/\b(cheer|celebrate|dance|victory|party|woo)\b/.test(t)) return order("cheer");
  if (/\b(follow|with me|come (back|here|on)|heel|regroup|fall back|back to me|on me)\b/.test(t)) return order("follow");
  if (/\b(hire|call|summon|bring|get me|need (help|backup|you)|backup|protect me|help( me)?|bodyguards?|squad|samurai|assemble)\b/.test(t)) {
    return [{ name: "hire_bodyguards", args: { who } }];
  }
  return [];
}

// ---- Running a call ---------------------------------------------------------

const list = (names: string[]) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** Do it, and say in plain words what happened, for the model to read back. */
export function runSquadCall(squad: Bodyguards, name: string, raw: unknown): string {
  const args = (raw ?? {}) as { who?: string; order?: string };
  const who = (args.who && (GUARD_IDS as string[]).includes(args.who) ? args.who : "all") as GuardId | "all";
  switch (name) {
    case "hire_bodyguards": {
      const names = squad.hire(who);
      return names.length ? `${list(names)} ${names.length === 1 ? "is" : "are"} at the player's side, following.` : "Nobody answered.";
    }
    case "dismiss_bodyguards": {
      const names = squad.dismiss(who);
      return names.length ? `${list(names)} went home.` : "Nobody was on duty.";
    }
    case "command_bodyguards": {
      const order = (GUARD_ORDERS as string[]).includes(args.order ?? "") ? (args.order as GuardOrder) : "follow";
      const onDuty = squad.roster().filter((g) => g.hired && (who === "all" || g.id === who));
      if (!onDuty.length) squad.hire(who);
      const names = squad.order(who, order);
      const what: Record<GuardOrder, string> = {
        follow: "following and defending the player",
        stay: "holding this spot",
        attack: "hunting police cruisers",
        peace: "following, weapons away",
        cheer: "celebrating",
      };
      return names.length ? `${list(names)}: ${what[order]}.` : "Nobody is on duty.";
    }
    case "squad_status":
      return squad.describe();
    default:
      return `Unknown command ${name}.`;
  }
}

/**
 * Typed (or no-voice) orders: parse and run. The guards answer in speech
 * bubbles on their own; the return value is the plain-words summary, or null
 * when the words meant nothing to the parser.
 */
export function runTypedOrder(squad: Bodyguards, text: string): string | null {
  const calls = parseSquadCommand(text);
  if (!calls.length) return null;
  let reply = "";
  for (const c of calls) reply = runSquadCall(squad, c.name, c.args);
  return reply;
}
