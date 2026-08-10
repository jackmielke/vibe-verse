/**
 * SOAKED — the commentator.
 *
 * A voice in the booth that calls the match: eliminations, the Downpour
 * closing, a squadmate going out, the win. It listens to the same engine
 * events the HUD already draws from, writes a line, and has
 * `supabase/functions/soaked-commentary` read it aloud.
 *
 * THREE RULES, IN ORDER OF HOW BADLY THEY WOULD HURT TO BREAK
 * -----------------------------------------------------------
 * 1. **It can never break the match.** Every call is fire-and-forget behind a
 *    try/catch, every failure is silence, and a project with no ElevenLabS key
 *    simply has no commentator. `disabled` latches on the first refusal so a
 *    missing secret costs one request per session, not one per elimination.
 *
 * 2. **It must never talk over itself.** One clip plays at a time and a new
 *    line arriving mid-sentence is dropped rather than queued: commentary that
 *    runs six seconds behind the fight is worse than no commentary. The
 *    exception is the win, which interrupts — nothing outranks the win.
 *
 * 3. **It must not narrate everything.** A cooldown plus a per-event
 *    importance floor keeps it to the moments worth a sentence. The single
 *    fastest way to make a voice unbearable is to give it every frame.
 *
 * WHY LINES ARE WRITTEN HERE AND NOT BY A MODEL
 * ----------------------------------------------
 * A commentator has to land inside the second the thing happened. A round trip
 * to a language model and then to TTS does not, and a beat that arrives four
 * seconds late describes a fight that is already over. These are templates
 * with the match's own numbers dropped in, which is what real play-by-play is.
 */
import type { System, SystemFactory, WorldCtx } from "../types";

/** Nothing new starts inside this window unless it outranks what is playing. */
const COOLDOWN = 4.5;

/** Below this, an event is not worth a sentence. */
const FLOOR = 2;

/** Importance, high wins. Used both to rank and to decide interruptions. */
const RANK = { victory: 10, selfSoaked: 6, mateSoaked: 4, elimination: 5, zone: 3, lowDry: 2 } as const;

interface Line {
  text: string;
  rank: number;
}

/** Pick one, avoiding the previous choice so a repeat never lands twice. */
function pick(options: readonly string[], last: string | null): string {
  if (options.length === 0) return "";
  if (options.length === 1) return options[0];
  let choice = options[Math.floor(Math.random() * options.length)];
  let guard = 0;
  while (choice === last && guard++ < 4) {
    choice = options[Math.floor(Math.random() * options.length)];
  }
  return choice;
}

const VICTORY = [
  "That's it! Last one dry, and not a drop on them!",
  "It's over — they walk off that island bone dry!",
  "Nobody left standing. That is a dry victory!",
];
const SELF_SOAKED = [
  "Oh, they're drenched! That's the run over!",
  "Soaked through! What a way to go out!",
  "And they're out — completely waterlogged!",
];
const MATE_SOAKED = [
  "Squadmate down! They're on their own now!",
  "That's a teammate soaked — the squad is thinning out!",
];
const ELIMINATION = [
  "Another one goes out soaked!",
  "That's one more off the board!",
  "Someone just got completely drenched!",
];
const ZONE = [
  "The Downpour is closing — get to dry ground!",
  "Rain's coming in! Move, move!",
];
const LOW_DRY = [
  "They are barely dry — one more hit does it!",
  "Running on nothing! One splash ends this!",
];

export const createCommentarySystem: SystemFactory = (ctx: WorldCtx): System => {
  // Classic DROP ZERO has its own announcer language and no water in it;
  // this booth only calls the water fight.
  const water = ctx.mode === "water";

  let disabled = !water;
  /**
   * Consecutive failures before the booth closes for the session.
   *
   * Latching on the first one is wrong: a single dropped request at match
   * start would mean no commentary for the whole session even on a project
   * where everything is configured. Latching never is also wrong: an
   * unconfigured project would then pay a round trip per elimination forever.
   * Three strikes covers a blip and still costs almost nothing when the
   * answer is permanent.
   */
  let strikes = 0;
  const MAX_STRIKES = 3;
  let audio: HTMLAudioElement | null = null;
  let playingRank = 0;
  let lastAt = -Infinity;
  let lastText: string | null = null;
  let elapsed = 0;
  /** Previous dryness fraction, so "getting low" fires on the way down only. */
  let lastDryFrac = 1;
  const offs: Array<() => void> = [];

  /** True when we should let this line through. */
  function admits(rank: number): boolean {
    if (disabled || rank < FLOOR) return false;
    // Something is talking: only a bigger moment gets to cut in.
    if (audio && !audio.ended && rank <= playingRank) return false;
    if (elapsed - lastAt < COOLDOWN && rank < RANK.victory) return false;
    return true;
  }

  async function speak(line: Line): Promise<void> {
    if (!admits(line.rank)) return;
    lastAt = elapsed;
    lastText = line.text;
    playingRank = line.rank;

    try {
      // Imported lazily so a build that never enters SOAKED does not pull the
      // Supabase client into the engine bundle.
      const { supabase } = await import("@/integrations/supabase/client");
      const { data, error } = await supabase.functions.invoke("soaked-commentary", {
        body: { text: line.text },
      });
      if (error) {
        // The common permanent cases are a 503 (no ELEVENLABS_API_KEY) and a
        // function that was never deployed. Both answer the same way every
        // time, so the strike count closes the booth quickly.
        if (++strikes >= MAX_STRIKES) disabled = true;
        return;
      }

      const blob =
        data instanceof Blob ? data : data instanceof ArrayBuffer ? new Blob([data], { type: "audio/mpeg" }) : null;
      if (!blob) {
        if (++strikes >= MAX_STRIKES) disabled = true;
        return;
      }
      strikes = 0;

      const url = URL.createObjectURL(blob);
      audio?.pause();
      const el = new Audio(url);
      el.volume = 0.9;
      audio = el;
      el.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
      // Autoplay can still be refused if the player has not clicked yet. That
      // is not worth disabling the booth over — the next line will land.
      await el.play().catch(() => {});
    } catch {
      // Network, bundler, decode — none of it is a reason to touch the match.
      if (++strikes >= MAX_STRIKES) disabled = true;
    }
  }

  function say(options: readonly string[], rank: number): void {
    if (!admits(rank)) return;
    void speak({ text: pick(options, lastText), rank });
  }

  if (water) {
    offs.push(ctx.on("dz:victory", () => say(VICTORY, RANK.victory)));
    offs.push(ctx.on("dz:soaked", () => say(SELF_SOAKED, RANK.selfSoaked)));
    // `dz:eliminated` is the placement card for a death `dz:soaked` already
    // called. Saying both is saying it twice, so it is deliberately unbound.
    offs.push(
      ctx.on("dz:in-storm", (p) => {
        const inside = typeof p === "boolean" ? p : !!(p as { inStorm?: boolean } | undefined)?.inStorm;
        if (inside) say(ZONE, RANK.zone);
      }),
    );
    offs.push(
      ctx.on("dz:health", (p) => {
        const h = (p ?? {}) as { dry?: number; health?: number; maxHealth?: number };
        const max = h.maxHealth && h.maxHealth > 0 ? h.maxHealth : 100;
        const level = h.dry ?? h.health;
        if (typeof level !== "number") return;
        // Only on the way down past the line, and only while still alive.
        const frac = level / max;
        const wasAbove = lastDryFrac > 0.18;
        lastDryFrac = frac;
        if (frac > 0 && frac <= 0.18 && wasAbove) say(LOW_DRY, RANK.lowDry);
      }),
    );
  }

  /**
   * Other people going out arrives on the wire, not on an engine event —
   * `soaked` is broadcast by whoever it happened to. Bound late because `net`
   * may boot after us and may never boot at all.
   */
  let netBound = false;
  function bindNet(): void {
    if (netBound || !water) return;
    const net = ctx.services.net;
    if (!net || typeof net.on !== "function") return;
    netBound = true;
    try {
      offs.push(
        net.on("soaked", (from) => {
          const peer = net.peers.get(from);
          const mine = net.selfTeam;
          const mate = !!mine && !!peer?.team && mine.toLowerCase() === peer.team.toLowerCase();
          say(mate ? MATE_SOAKED : ELIMINATION, mate ? RANK.mateSoaked : RANK.elimination);
        }),
      );
    } catch {
      netBound = false;
    }
  }

  return {
    name: "commentary",

    update(dt: number) {
      elapsed += dt;
      if (!netBound) bindNet();
    },

    dispose() {
      for (const off of offs) {
        try {
          off();
        } catch {
          /* a listener that will not detach is not worth a crash on teardown */
        }
      }
      offs.length = 0;
      audio?.pause();
      audio = null;
    },
  };
};

export default createCommentarySystem;
