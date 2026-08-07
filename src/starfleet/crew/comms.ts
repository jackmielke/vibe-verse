/**
 * The comm channel — one conversation with one person.
 *
 * The interesting decision in here is the failure path, and it is the reason
 * the file is longer than a fetch wrapper needs to be.
 *
 * A conversational NPC that says "sorry, I'm having trouble connecting right
 * now" has done more damage to the world than one that never spoke at all: the
 * player is no longer talking to a Klingon councillor, they are talking to a
 * web app. So **there is no error state**. If the edge function is missing, the
 * key is unset, the request times out, or the machine is on a plane, the
 * character keeps talking — out of `bank` in `characters.ts`, matched on
 * keywords, in the same voice. The seam is invisible from the outside, which is
 * the whole requirement.
 *
 * `mode` is exposed only so the UI can put a small dot next to the channel
 * name, because *we* want to know which brain answered even though the fiction
 * does not.
 *
 * The other decision: history is capped at twelve turns and trimmed from the
 * front. Long conversations with a strong persona drift — the model starts
 * agreeing with the captain about everything, which is exactly what a Romulan
 * senator must never do. Twelve turns is about four minutes of talking and the
 * persona is re-sent every time.
 */
import { supabase } from "@/integrations/supabase/client";
import { COMMS_PREAMBLE, type Character } from "./characters";

export type Turn = { role: "user" | "assistant"; content: string };
export type Brain = "live" | "local";

/** Longest we will make a player wait before the character answers anyway. */
const TIMEOUT_MS = 12000;
const HISTORY_TURNS = 12;

export interface Channel {
  character: Character;
  history: Turn[];
  /** Which brain answered the most recent line. */
  brain: Brain;
  /** True while a request is in flight, so the UI can show the ellipsis. */
  pending: boolean;
}

export function openChannel(character: Character): Channel {
  return { character, history: [], brain: "local", pending: false };
}

/** The opening line. Never generated — a hail has to connect instantly, and a
 *  greeting written by hand is better than one waited four seconds for. */
export function hail(ch: Channel): string {
  const g = pick(ch.character.greeting);
  ch.history.push({ role: "assistant", content: g });
  return g;
}

/**
 * Say something, and get an answer. Never rejects.
 */
export async function say(ch: Channel, text: string): Promise<{ reply: string; brain: Brain }> {
  const clean = text.trim().slice(0, 600);
  if (!clean) return { reply: "", brain: ch.brain };

  ch.history.push({ role: "user", content: clean });
  ch.pending = true;

  let reply = "";
  let brain: Brain = "local";
  try {
    const live = await withTimeout(request(ch.character, ch.history), TIMEOUT_MS);
    if (live) {
      reply = live;
      brain = "live";
    }
  } catch {
    /* Falls through to the bank. Deliberately silent — a console error per
       turn on a machine with no network is noise, not information. */
  }

  if (!reply) reply = localReply(ch.character, clean, ch.history);

  ch.history.push({ role: "assistant", content: reply });
  trim(ch);
  ch.pending = false;
  ch.brain = brain;
  return { reply, brain };
}

function trim(ch: Channel): void {
  if (ch.history.length > HISTORY_TURNS) {
    ch.history.splice(0, ch.history.length - HISTORY_TURNS);
  }
}

/* --- the live brain -------------------------------------------------------- */

async function request(c: Character, history: Turn[]): Promise<string | null> {
  const { data, error } = await supabase.functions.invoke("trek-comms", {
    body: {
      // The persona travels with every request rather than living on the
      // server. One function serves sixteen characters, and adding a
      // seventeenth is a client-side edit — no redeploy, no drift between the
      // character the surface renders and the character the model plays.
      persona: `${COMMS_PREAMBLE}\n\n${c.persona}`,
      name: c.name,
      history: history.slice(0, -1).slice(-HISTORY_TURNS),
      text: history[history.length - 1]?.content ?? "",
    },
  });
  if (error) return null;
  const say = (data as { say?: string } | null)?.say;
  if (typeof say !== "string") return null;
  const trimmed = say.trim();
  return trimmed ? trimmed : null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

/* --- the local brain ------------------------------------------------------- */

/**
 * Keyword match against the character's own bank, then their own deflections.
 *
 * Two small rules do most of the work of making this not feel like a lookup
 * table: a line already said in this conversation is skipped in favour of the
 * next one in its pool, and the deflections rotate. Repetition is what gives a
 * canned brain away, so repetition is what this spends its effort avoiding.
 */
export function localReply(c: Character, text: string, history: Turn[] = []): string {
  const q = text.toLowerCase();
  const said = new Set(history.filter((h) => h.role === "assistant").map((h) => h.content));

  let best: { entry: (typeof c.bank)[number]; score: number } | null = null;
  for (const entry of c.bank) {
    let score = 0;
    for (const k of entry.on) if (q.includes(k)) score += k.length;
    if (score > 0 && (!best || score > best.score)) best = { entry, score };
  }

  const pool = best ? best.entry.say : c.deflect;
  const fresh = pool.filter((s) => !said.has(s));
  return pick(fresh.length ? fresh : pool);
}

function pick<T>(xs: T[]): T {
  return xs[Math.floor(Math.random() * xs.length)];
}

/* --- voice ----------------------------------------------------------------- */

/**
 * Speak a line through the browser's own synthesiser.
 *
 * Same reasoning as the rest of this world's audio: nothing is downloaded, and
 * nothing anybody owns is shipped. Per-character pitch and rate is not
 * impersonation, it is only enough that a Klingon and a Ferengi are not the
 * same voice. Every line is captioned as well, because this synthesiser is not
 * present on every platform and is not good on any of them.
 */
let voiceOn = true;

export function setVoice(on: boolean): void {
  voiceOn = on;
  if (!on) stopVoice();
}

export function voiceEnabled(): boolean {
  return voiceOn;
}

export function stopVoice(): void {
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* no synthesiser here */
  }
}

export function speak(c: Character, line: string): void {
  if (!voiceOn || typeof window === "undefined" || !window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(line.slice(0, 400));
    u.pitch = c.voice.pitch;
    u.rate = c.voice.rate;
    u.volume = 0.85;
    window.speechSynthesis.speak(u);
  } catch {
    /* the tab may forbid it until a gesture; not worth reporting */
  }
}
