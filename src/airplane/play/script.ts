/**
 * The radio, the cabin, and everybody talking over each other.
 *
 * A queue of lines with speakers and durations, plus the database of what
 * anyone in this aeroplane ever says. Kept apart from `game.ts` for one
 * reason: the game logic is about altitude and nerve and where the wheels
 * touch, and the writing is about a man who picked the wrong week to quit
 * sniffing glue. Mixing them makes both harder to change.
 *
 * ## The rule the whole script is written to
 *
 * **Nobody ever tells you something is funny, and nobody ever stops the
 * aeroplane to make a joke.** Every line here is either an instruction you
 * need, an answer to something you did, or a piece of the cabin falling apart
 * behind you — the comedy is that all three arrive at once while you are
 * trying to intercept a glideslope. A gag that pauses the game to be a gag is
 * a gag that gets skipped the second time somebody plays this.
 *
 * Which is also why the tower's instructions are *real*. When Kramer tells you
 * to descend to two thousand and turn left onto a heading of zero-six-zero,
 * that is a heading that works, computed from where you actually are. The
 * jokes only land if the flying underneath them is straight.
 */

export type Speaker =
  | "STRIKER"
  | "ELAINE"
  | "RUMACK"
  | "KRAMER"
  | "MCCROSKEY"
  | "JOHNNY"
  | "OTTO"
  | "TOWER"
  | "CABIN"
  | "PA"
  | "SYSTEM";

export interface Line {
  who: Speaker;
  text: string;
  /** Seconds on screen. Defaults to something proportional to the length. */
  hold?: number;
  /** Radio lines get the crackle and the filter; cabin lines do not. */
  radio?: boolean;
  /** Show a "press SPACE" prompt and wait for it. */
  reply?: string;
}

export const SPEAKER_NAMES: Record<Speaker, string> = {
  STRIKER: "Striker",
  ELAINE: "Elaine",
  RUMACK: "Dr. Rumack",
  KRAMER: "Rex Kramer",
  MCCROSKEY: "McCroskey",
  JOHNNY: "Johnny",
  OTTO: "Otto",
  TOWER: "Chicago Approach",
  CABIN: "Cabin",
  PA: "Cabin address",
  SYSTEM: "",
};

export const SPEAKER_COLORS: Record<Speaker, string> = {
  STRIKER: "#cfe6ff",
  ELAINE: "#ffd0e4",
  RUMACK: "#d8f0d0",
  KRAMER: "#ffd08a",
  MCCROSKEY: "#ffb0a0",
  JOHNNY: "#e8c8ff",
  OTTO: "#fff3b0",
  TOWER: "#a8e0ff",
  CABIN: "#e0dccf",
  PA: "#e0dccf",
  SYSTEM: "#8fa0b0",
};

/** How long a line stays up: reading speed, with a floor and a ceiling. */
export function holdFor(line: Line): number {
  if (line.hold !== undefined) return line.hold;
  return Math.min(7.5, Math.max(1.9, 1.0 + line.text.length / 22));
}

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

const l = (who: Speaker, text: string, extra: Partial<Line> = {}): Line => ({ who, text, ...extra });

/** The cold open. Elaine comes forward; there is nobody flying the aeroplane. */
export const OPENING: Line[] = [
  l("PA", "Ladies and gentlemen, this is your stewardess speaking. We regret any inconvenience the sudden cabin movement might have caused.", { hold: 5 }),
  l("PA", "This is due to a slight power failure, but we've now regained full power. Thank you.", { hold: 4.5 }),
  l("RUMACK", "The life of everybody on board depends upon just one thing: finding someone back there who can not only fly this plane, but who didn't have fish for dinner.", { hold: 6.5 }),
  l("ELAINE", "Ted. You flew in the war."),
  l("STRIKER", "That was a different kind of flying, altogether."),
  l("ELAINE", "It's the same kind of flying. Get in the seat."),
];

/** Sitting down. This is where the panel gets introduced, once, quickly. */
export const TAKE_SEAT: Line[] = [
  l("RUMACK", "Can you fly this plane, and land it?"),
  l("STRIKER", "Surely you can't be serious."),
  l("RUMACK", "I am serious. And don't call me Shirley."),
  l("SYSTEM", "OTTO is flying. He is an inflatable man and he is doing a better job than you would.", { hold: 4.5 }),
  l("SYSTEM", "Attitude in the middle. Airspeed left, altitude right. Everything you need is those three.", { hold: 5.5 }),
];

/** Chicago, on the radio, once you are in the seat. */
export const FIRST_CONTACT: Line[] = [
  l("TOWER", "Trans American two-oh-nine, Chicago Center. Say your intentions.", { radio: true, reply: "Answer the radio" }),
  l("STRIKER", "Chicago, two-oh-nine. Uh… our crew is incapacitated. I have some flight experience.", { radio: true }),
  l("MCCROSKEY", "Some flight experience. Looks like I picked the wrong week to quit smoking.", { hold: 4 }),
  l("MCCROSKEY", "Get me Rex Kramer.", { hold: 2.4 }),
];

/** Kramer arriving in the tower. He is the only competent person in the film. */
export const KRAMER_ARRIVES: Line[] = [
  l("KRAMER", "Two-oh-nine, this is Rex Kramer. I'm going to talk you down.", { radio: true }),
  l("KRAMER", "Flying a plane is no different from riding a bicycle. Just a lot harder to keep up the darn thing.", { radio: true, hold: 5.5 }),
  l("KRAMER", "Chicago's socked in. Ceiling one thousand, heavy rain, wind two-four-zero at eighteen gusting thirty.", { radio: true, hold: 6 }),
  l("KRAMER", "You'll be flying the ILS to runway nine. Do exactly what I tell you, when I tell you.", { radio: true, hold: 5.5 }),
];

/** The descent. Every instruction here is a real one and every number works. */
export const DESCENT: Line[] = [
  l("KRAMER", "Two-oh-nine, descend and maintain five thousand. Reduce speed to two-one-zero.", { radio: true, hold: 5 }),
  l("SYSTEM", "Push the nose over and bring the thrust levers back. Watch the vertical speed — a thousand down is plenty.", { hold: 6 }),
];

export const CONFIGURE: Line[] = [
  l("KRAMER", "Flaps to fourteen. Then twenty-five. Slow her down, Striker.", { radio: true, hold: 4.5 }),
  l("KRAMER", "Gear down. You'll feel it. If you don't feel it, it isn't down.", { radio: true, hold: 5 }),
];

export const INTERCEPT: Line[] = [
  l("KRAMER", "Two-oh-nine, you're cleared for the ILS runway nine approach. Call the field in sight.", { radio: true, hold: 5.5 }),
  l("SYSTEM", "The magenta bars on the attitude indicator are the beam. Fly towards them.", { hold: 5 }),
];

export const SHORT_FINAL: Line[] = [
  l("KRAMER", "Two-oh-nine, you're on course, on glidepath. Right where you want to be.", { radio: true, hold: 4.5 }),
  l("ELAINE", "Ted — the girl in fourteen. Her heart. How long?"),
];

export const BREAKOUT: Line[] = [
  l("SYSTEM", "Runway in sight. Fly the lights. Two white two red on the PAPI is the slope.", { hold: 5 }),
  l("KRAMER", "You're at two hundred feet. Get the nose up and close the throttles at fifty.", { radio: true, hold: 5 }),
];

export const TOUCHDOWN_GOOD: Line[] = [
  l("KRAMER", "That's it. Brakes. Get on the brakes.", { radio: true, hold: 3 }),
  l("MCCROSKEY", "He did it. Son of a gun, he did it."),
  l("RUMACK", "Nice landing.", { hold: 2.4 }),
];

export const TOUCHDOWN_ROUGH: Line[] = [
  l("KRAMER", "…That was one of the worst landings in the history of this airport.", { radio: true, hold: 5 }),
  l("KRAMER", "But some of us like it that way. Brakes, Striker.", { radio: true, hold: 4 }),
];

/** Fired when the nerve meter empties. */
export const FLASHBACKS: Line[][] = [
  [
    l("STRIKER", "…Macho Grande. I'll never get over Macho Grande.", { hold: 4 }),
    l("SYSTEM", "You have let go of the yoke. Take it back.", { hold: 3 }),
  ],
  [
    l("STRIKER", "It was a rough time for me. I was drinking heavily.", { hold: 4 }),
    l("SYSTEM", "Fly the aeroplane, Ted.", { hold: 2.6 }),
  ],
  [
    l("STRIKER", "Six men went down over the Channel and I was the one who came back.", { hold: 5 }),
    l("RUMACK", "Striker. Look at me. Fly the plane.", { hold: 3 }),
  ],
];

/** Rumack, restoring your nerve. Fired when the meter comes back off the floor. */
export const RUMACK_STEADY: Line[] = [
  l("RUMACK", "You're doing fine. Just keep the wings level and the nose where it is."),
];

/** Johnny, in the tower, being no help at all. Fired on a timer, rarely. */
export const JOHNNY_LINES: Line[] = [
  l("JOHNNY", "Johnny, what can you make of this?"),
  l("JOHNNY", "This? Why, I can make a hat, or a brooch, or a pterodactyl…", { hold: 4.5 }),
  l("MCCROSKEY", "Johnny."),
  l("JOHNNY", "The tower? The tower! Rapunzel, Rapunzel!", { hold: 3.5 }),
];

/** The tower's ambience, fired between other things so the frequency is alive. */
export const CHATTER: Line[][] = [
  [l("TOWER", "The white zone is for immediate loading and unloading of passengers only. There is no stopping in the red zone.", { radio: true, hold: 5.5 })],
  [l("TOWER", "The red zone is for immediate loading and unloading of passengers only. There is no stopping in the white zone.", { radio: true, hold: 5.5 })],
  [l("MCCROSKEY", "Looks like I picked the wrong week to quit drinking.", { hold: 3.4 })],
  [l("MCCROSKEY", "Looks like I picked the wrong week to quit amphetamines.", { hold: 3.4 })],
  [l("MCCROSKEY", "Looks like I picked the wrong week to quit sniffing glue.", { hold: 3.4 })],
  [l("ELAINE", "Would you like some coffee?"), l("RUMACK", "No thank you. I take it black. Like my men.", { hold: 3.6 })],
  [l("CABIN", "Row nineteen has started a conga line. Nobody knows why.", { hold: 3.6 })],
  [l("CABIN", "The nun has produced a guitar. This is not going to help.", { hold: 3.8 })],
];

/** Otto, on the two occasions he says anything. */
export const OTTO_ON = [l("OTTO", "Otto is flying. Otto has never crashed. Otto has also never landed.", { hold: 4.2 })];
export const OTTO_DEFLATING = [
  l("SYSTEM", "Otto is going soft. He is not holding altitude any more.", { hold: 4 }),
  l("ELAINE", "Ted — the autopilot. He's losing air."),
];
export const OTTO_GONE = [
  l("SYSTEM", "Otto has deflated completely. You have the aeroplane.", { hold: 4 }),
  l("STRIKER", "…I have the aeroplane."),
];

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

export interface ActiveLine extends Line {
  /** Seconds remaining. */
  remaining: number;
  /** Set once the player has answered a `reply` prompt. */
  answered: boolean;
}

/**
 * The dialogue queue.
 *
 * One line at a time, because two lines on screen at once is unreadable in a
 * cockpit that is also showing you eleven instruments. Priority lines jump the
 * queue and clear whatever ambience was in it — when the tower tells you to
 * descend, it must not wait behind a joke about the white zone.
 */
export class Radio {
  private queue: Line[] = [];
  active: ActiveLine | null = null;
  /** Everything said so far, newest last. The UI shows the last few. */
  readonly log: Line[] = [];
  /** Bumped whenever `active` changes, so React can re-render cheaply. */
  revision = 0;

  say(lines: Line[] | Line, opts: { priority?: boolean } = {}): void {
    const arr = Array.isArray(lines) ? lines : [lines];
    if (opts.priority) {
      // Drop pending ambience, but never interrupt a line mid-sentence.
      this.queue = arr.concat(this.queue.filter((q) => q.reply !== undefined));
    } else {
      this.queue.push(...arr);
    }
    if (!this.active) this.advance();
  }

  /** True when there is nothing left to say — used to gate phase changes. */
  get idle(): boolean {
    return !this.active && this.queue.length === 0;
  }

  /** The player pressed the reply key. */
  answer(): boolean {
    if (!this.active?.reply || this.active.answered) return false;
    this.active.answered = true;
    this.active.remaining = Math.min(this.active.remaining, 0.35);
    this.revision++;
    return true;
  }

  clear(): void {
    this.queue.length = 0;
    this.active = null;
    this.revision++;
  }

  update(dt: number): void {
    if (!this.active) {
      this.advance();
      return;
    }
    // A line that wants an answer waits for one — but not for ever. Nobody
    // should be able to park the game by not pressing a key at four hundred
    // feet, so the timer runs anyway once it has been up long enough.
    const waiting = this.active.reply && !this.active.answered;
    this.active.remaining -= waiting ? dt * 0.25 : dt;
    if (this.active.remaining <= 0) {
      this.log.push(this.active);
      if (this.log.length > 40) this.log.shift();
      this.active = null;
      this.revision++;
      this.advance();
    }
  }

  private advance(): void {
    const next = this.queue.shift();
    if (!next) return;
    this.active = { ...next, remaining: holdFor(next), answered: false };
    this.revision++;
  }
}
