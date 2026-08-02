/**
 * What is happening behind you.
 *
 * The cabin is the second half of this game and the reason it is not simply a
 * flight simulator with a laugh track. A crisis arrives, it has two or three
 * answers, and every second you spend choosing is a second you are not looking
 * at the attitude indicator — which in a thunderstorm at two thousand feet is
 * a real cost, paid immediately, in altitude.
 *
 * That is the whole design: **the jokes are the difficulty**. Nothing back
 * there can crash the aeroplane on its own. What it can do is take your eyes
 * off the panel at the exact moment the panel needed them, and then the
 * aeroplane crashes it for you.
 *
 * ## Why the wrong answers are funny rather than punishing
 *
 * A crisis you get wrong costs nerve and a little passenger calm. It never
 * kills anyone, and it always produces a better line than the right answer
 * does. Players should want to find out what happens if you let the queue form
 * behind the hysterical woman — and the game should charge them a hundred feet
 * of altitude for the privilege rather than the flight.
 */
import type { Line, Speaker } from "./script";
import type { PlaneCtx, System } from "../types";
import type { AircraftService } from "./aircraft";

export interface CrisisChoice {
  /** What the button says. */
  label: string;
  /** What happens, in one line. Shown after you pick. */
  outcome: Line[];
  /** Nerve delta, as a fraction of the meter. */
  nerve: number;
  /** Passenger calm delta. */
  calm: number;
  /**
   * A shove to the airframe: 187 people all moving at once is worth several
   * tonnes of centre-of-gravity shift, and the aeroplane notices.
   */
  upset?: { pitch: number; roll: number; yaw: number };
  /** True on the choice that is actually correct, for the results screen. */
  best?: boolean;
}

export interface Crisis {
  id: string;
  /** Who brings it forward. */
  who: Speaker;
  /** The situation. */
  prompt: string;
  choices: CrisisChoice[];
  /** Seconds before it resolves itself, badly. */
  timeout: number;
  /** Only once per flight. */
  once?: boolean;
}

const say = (who: Speaker, text: string, hold?: number): Line => ({ who, text, hold });

/**
 * The deck.
 *
 * Drawn by preference for what has not been seen rather than in order — the
 * same crisis arriving at the same moment on every playthrough is the fastest
 * way to make a comedy stop being funny.
 */
export const CRISES: Crisis[] = [
  {
    id: "fish",
    who: "ELAINE",
    prompt: "Dinner service. There is fish, and there is steak. Everyone who had the fish is on the floor.",
    timeout: 18,
    once: true,
    choices: [
      {
        label: "The steak. Obviously the steak.",
        outcome: [say("STRIKER", "I'll have the steak."), say("ELAINE", "Good. Everyone who had the fish is unconscious.")],
        nerve: 0.12,
        calm: 0.1,
        best: true,
      },
      {
        label: "I'm not hungry.",
        outcome: [say("RUMACK", "You should eat something. It's going to be a long night.", 3.6)],
        nerve: 0.02,
        calm: 0,
      },
      {
        label: "The fish.",
        outcome: [
          say("ELAINE", "…the fish."),
          say("RUMACK", "Well, that's it then. Nobody is flying this plane.", 4),
          say("STRIKER", "I'm going to be fine. I'm going to be absolutely fine.", 3.6),
        ],
        nerve: -0.3,
        calm: -0.1,
      },
    ],
  },
  {
    id: "hysteria",
    who: "CABIN",
    prompt: "A woman in row 12 has begun screaming. A queue is forming behind her. Several people are holding tools.",
    timeout: 15,
    choices: [
      {
        label: "Elaine — calm her down.",
        outcome: [
          say("ELAINE", "Ma'am, you have to get a hold of yourself."),
          say("CABIN", "She has got a hold of herself. The queue is dispersing.", 3.4),
        ],
        nerve: 0.12,
        calm: 0.22,
        best: true,
      },
      {
        label: "Let the queue do its work.",
        outcome: [
          say("CABIN", "The queue has grown. There is now a man with an anchor.", 3.4),
          say("RUMACK", "I'd like to point out that this is not standard procedure.", 4),
        ],
        nerve: -0.05,
        calm: -0.12,
        upset: { pitch: 0.02, roll: 0.05, yaw: 0.01 },
      },
      {
        label: "On the PA: everything is fine.",
        outcome: [
          say("PA", "There is no cause for alarm. Please return to your seats."),
          say("CABIN", "Nobody believes you. Two more people are screaming.", 3.4),
        ],
        nerve: -0.08,
        calm: -0.06,
      },
    ],
  },
  {
    id: "lisa",
    who: "ELAINE",
    prompt: "The little girl in 14 — her IV has come out. The nun's guitar knocked it loose.",
    timeout: 14,
    once: true,
    choices: [
      {
        label: "Get Rumack to her. Now.",
        outcome: [
          say("RUMACK", "I've got it back in. She's stable."),
          say("ELAINE", "She wants to know how long until Chicago.", 3.4),
        ],
        nerve: 0.18,
        calm: 0.2,
        best: true,
      },
      {
        label: "Take the nun's guitar away first.",
        outcome: [
          say("CABIN", "The nun has surrendered the guitar. The girl is worse.", 3.6),
          say("RUMACK", "Priorities, Striker.", 2.6),
        ],
        nerve: -0.16,
        calm: -0.12,
      },
    ],
  },
  {
    id: "jive",
    who: "ELAINE",
    prompt: "Two passengers in the back are trying to tell you something and nobody can understand a word of it.",
    timeout: 14,
    once: true,
    choices: [
      {
        label: "Page Mrs. Cleaver. She speaks jive.",
        outcome: [
          say("CABIN", "A woman in row 8 has stepped forward and is translating fluently.", 4),
          say("CABIN", "They say the man in 22 has been dead since Denver.", 3.8),
        ],
        nerve: 0.1,
        calm: 0.12,
        best: true,
      },
      {
        label: "Nod, and hope.",
        outcome: [say("CABIN", "You have agreed to something. Nobody knows what.", 3.4)],
        nerve: -0.06,
        calm: -0.05,
      },
    ],
  },
  {
    id: "otto",
    who: "SYSTEM",
    prompt: "Otto has a slow leak. He is down to half pressure and beginning to sag over the yoke.",
    timeout: 12,
    once: true,
    choices: [
      {
        label: "Re-inflate him. There's a hose.",
        outcome: [
          say("ELAINE", "…I'll do it."),
          say("SYSTEM", "Otto is back up to pressure. He is holding altitude again.", 4),
        ],
        nerve: 0.1,
        calm: 0.05,
        best: true,
      },
      {
        label: "Leave him. Fly it yourself.",
        outcome: [say("SYSTEM", "Otto has gone flat across the centre pedestal. You have the aeroplane.", 4.2)],
        nerve: -0.05,
        calm: 0,
      },
    ],
  },
  {
    id: "leaflet",
    who: "CABIN",
    prompt: "Someone has got up the aisle to the flight deck door and would like to talk to you about a leaflet.",
    timeout: 12,
    choices: [
      {
        label: "Not now. Genuinely, not now.",
        outcome: [
          say("STRIKER", "I haven't got time for your damn hobbies."),
          say("CABIN", "He has moved on to row 6.", 2.8),
        ],
        nerve: 0.06,
        calm: 0.04,
        best: true,
      },
      {
        label: "Take the leaflet.",
        outcome: [say("CABIN", "Four more of them have appeared. You have eleven leaflets.", 3.6)],
        nerve: -0.06,
        calm: -0.03,
      },
    ],
  },
  {
    id: "coffee",
    who: "ELAINE",
    prompt: "Elaine is in the doorway with a pot of coffee and a very particular expression.",
    timeout: 11,
    choices: [
      {
        label: "Yes. Please.",
        outcome: [say("ELAINE", "There. You've got some colour back."), say("STRIKER", "Thanks, Elaine.", 2.4)],
        nerve: 0.16,
        calm: 0.04,
        best: true,
      },
      {
        label: "Not while I'm flying.",
        outcome: [say("ELAINE", "That's the first sensible thing you've said all night.", 3.2)],
        nerve: 0.08,
        calm: 0.02,
      },
      {
        label: "Something stronger.",
        outcome: [
          say("ELAINE", "Ted."),
          say("SYSTEM", "You have thrown it at your own face. This has happened before.", 4),
        ],
        nerve: -0.2,
        calm: -0.04,
      },
    ],
  },
  {
    id: "turbulence",
    who: "CABIN",
    prompt: "The cabin has hit the worst of it. Half the passengers are out of their seats and moving forward.",
    timeout: 10,
    choices: [
      {
        label: "Seatbelt sign. Everybody down.",
        outcome: [
          say("PA", "Cabin crew, take your seats."),
          say("CABIN", "They're strapped in. She feels lighter on the controls.", 4),
        ],
        nerve: 0.1,
        calm: 0.18,
        best: true,
      },
      {
        label: "No time. Fly the aeroplane.",
        outcome: [say("CABIN", "A hundred and eighty people have all moved forward at once.", 3.6)],
        nerve: -0.04,
        calm: -0.14,
        upset: { pitch: -0.05, roll: 0.02, yaw: 0 },
      },
    ],
  },
  {
    id: "boy",
    who: "CABIN",
    prompt: "A small boy has got onto the flight deck and is asking you an escalating series of questions.",
    timeout: 12,
    choices: [
      {
        label: "Send him back to his seat.",
        outcome: [say("CABIN", "He has gone. He was not satisfied with your answers.", 3.2)],
        nerve: 0.04,
        calm: 0.06,
        best: true,
      },
      {
        label: "Answer honestly.",
        outcome: [
          say("STRIKER", "…yes. I have been in a Turkish prison. Go and sit down."),
          say("CABIN", "His mother would like a word with you after we land.", 3.6),
        ],
        nerve: -0.04,
        calm: -0.02,
      },
    ],
  },
  {
    id: "fuel",
    who: "KRAMER",
    prompt: "Kramer wants a number, and he wants it now. What is your fuel state?",
    timeout: 10,
    choices: [
      {
        label: "Read it off the gauge.",
        outcome: [say("KRAMER", "Good. That's enough for one approach and no second chances.", 4.4)],
        nerve: 0.12,
        calm: 0.02,
        best: true,
      },
      {
        label: "Guess.",
        outcome: [
          say("KRAMER", "Striker. Do not guess at me."),
          say("MCCROSKEY", "Looks like I picked the wrong week to quit sniffing glue.", 3.4),
        ],
        nerve: -0.1,
        calm: 0,
      },
    ],
  },
];

// ---------------------------------------------------------------------------

export interface ActiveCrisis {
  crisis: Crisis;
  remaining: number;
  /** −1 until a choice is made; the panel then shows the outcome. */
  chosen: number;
}

export interface CabinService {
  active: ActiveCrisis | null;
  /** Bumped when `active` changes, so React re-renders without deep compares. */
  revision: number;
  /** 0..1 — how calm it is behind you. */
  calm: number;
  handled: number;
  handledWell: number;
  /** Raise a specific crisis by id, or a random eligible one. */
  raise(id?: string): boolean;
  choose(index: number): CrisisChoice | null;
  /** Stop drawing new crises — set once the wheels are on the ground. */
  closed: boolean;
}

export function createCabin(ctx: PlaneCtx): System {
  const seen = new Set<string>();

  const service: CabinService = {
    active: null,
    revision: 0,
    calm: 0.75,
    handled: 0,
    handledWell: 0,
    closed: false,

    raise(id) {
      if (service.active || service.closed) return false;
      let crisis: Crisis | undefined;
      if (id) {
        crisis = CRISES.find((c) => c.id === id);
      } else {
        const pool = CRISES.filter((c) => !(c.once && seen.has(c.id)));
        // Prefer what has not been seen at all, so one flight covers more of
        // the deck than an unweighted draw would.
        const fresh = pool.filter((c) => !seen.has(c.id));
        if (!pool.length) return false;
        crisis = ctx.rng.pick(fresh.length ? fresh : pool);
      }
      if (!crisis) return false;
      seen.add(crisis.id);
      service.active = { crisis, remaining: crisis.timeout, chosen: -1 };
      service.revision++;
      ctx.emit("crisis", { id: crisis.id });
      return true;
    },

    choose(index) {
      const a = service.active;
      if (!a || a.chosen >= 0) return null;
      const choice = a.crisis.choices[index];
      if (!choice) return null;
      a.chosen = index;
      a.remaining = 0.65;
      service.revision++;

      service.calm = Math.max(0, Math.min(1, service.calm + choice.calm));
      service.handled++;
      if (choice.best) service.handledWell++;

      const air = ctx.services.flight as AircraftService | undefined;
      if (choice.upset && air) air.gust(choice.upset.pitch, choice.upset.roll, choice.upset.yaw);

      ctx.emit("crisisResolved", {
        id: a.crisis.id,
        choice: index,
        nerve: choice.nerve,
        outcome: choice.outcome,
        best: !!choice.best,
      });
      return choice;
    },
  };
  ctx.services.crises = service;

  return {
    update(dt, c) {
      const a = service.active;
      if (!a) return;
      a.remaining -= dt;

      if (a.chosen < 0 && c.input.choicePressed > 0) {
        service.choose(c.input.choicePressed - 1);
        return;
      }

      if (a.remaining <= 0) {
        if (a.chosen < 0) {
          // Ignored. The cabin resolves it for you, badly — which is the point
          // of the timer: doing nothing is a choice, it is never the best one,
          // and it is never fatal either.
          service.calm = Math.max(0, service.calm - 0.16);
          service.handled++;
          c.emit("crisisResolved", {
            id: a.crisis.id,
            choice: -1,
            nerve: -0.12,
            outcome: [
              { who: "CABIN" as Speaker, text: "Nobody came. It got worse on its own.", hold: 3.2 },
            ],
            best: false,
          });
        }
        service.active = null;
        service.revision++;
      }
    },
    dispose() {
      delete ctx.services.crises;
    },
  };
}
