/**
 * The post. Things that happen to a cloud city, and what you do about them.
 *
 * Most of this is Atin's pitch, told back as incidents: the lunar mass driver,
 * Jed and his two Falcon 9s, the Burning Man shade structure, the Habsburg
 * season, jazz, Mercury as the Saudi Arabia of planets, and the one idea that
 * makes Venus the right place to be reckless — a failed experiment falls into
 * a 462 °C oven and is gone.
 *
 * An event is data. `when` says whether it can come up, `choices` says what is
 * on offer, and each choice's `run` changes the sim and returns one line of
 * what happened.
 */
import type { VenusSim } from "./sim";
import type { Hex } from "./modules";
import { MODULES } from "./modules";

export interface EventChoiceDef {
  label: string;
  hint?: string;
  disabled?: boolean;
  run: (s: VenusSim) => string;
}

export interface EventDef {
  id: string;
  from: string | ((s: VenusSim) => string);
  title: string | ((s: VenusSim, tile?: Hex) => string);
  body: string | ((s: VenusSim, tile?: Hex) => string);
  /** Fired by a module's risk roll instead of the post. */
  trigger?: string;
  once?: boolean;
  cooldown?: number;
  weight?: number;
  when: (s: VenusSim) => boolean;
  choices: (s: VenusSim, tile?: Hex) => EventChoiceDef[];
}

const NEIGHBOURS = ["Ishtar", "Lakshmi", "Maxwell", "Cleopatra", "Aino", "Ovda", "Theia"];

const pick = <T,>(s: VenusSim, xs: T[]) => xs[Math.floor(s.random() * xs.length) % xs.length];

export const EVENTS: EventDef[] = [
  /* ------------------------------------------------------------- Jed */
  {
    id: "jed",
    once: true,
    weight: 4,
    from: "Jed · owns a spaceflight company",
    title: "Two Falcon 9s, one opinion",
    body:
      "\"I've got two launches booked next year and I hear you want one for Venus. Respectfully: no. The atmosphere is too intense. Four hundred and sixty degrees, ninety bar. It crushed the Soviets.\"",
    when: (s) => s.s.t > 45,
    choices: () => [
      {
        label: "\"No, man. Let me tell you.\"",
        hint: "Explain the altitude thing",
        run: (s) => {
          s.give({ carbon: 90 });
          s.sendPeople(20);
          s.s.flags.jed = 1;
          return "You explain: fifty kilometres up it is one bar; by fifty-four it is thirty degrees; the gravity is 0.9 g. Jed goes quiet for a long time. Then he books both launches. +90 carbon, 20 people on the way.";
        },
      },
      {
        label: "\"Fair. Try Mars.\"",
        run: (s) => {
          s.s.flags.jedMars = s.s.t;
          return "Jed flies to Mars. You have a feeling you will hear from him.";
        },
      },
    ],
  },
  {
    id: "jed-returns",
    once: true,
    weight: 6,
    from: "Jed · Mars, apparently",
    title: "\"The bones thing is real\"",
    body:
      "\"Point three eight g. My physio says my femurs are 'doing their best'. Everybody here does squats in the tent. Is the offer still open?\"",
    when: (s) => !!s.s.flags.jedMars && s.s.t - s.s.flags.jedMars > 300,
    choices: () => [
      {
        label: "\"Come on up. Well, down. Sunward.\"",
        run: (s) => {
          s.give({ carbon: 140 });
          s.sendPeople(35);
          return "Jed arrives with 35 people and a very long apology. Falling toward the Sun is cheap: Venus is downhill from everywhere out there. +140 carbon.";
        },
      },
    ],
  },

  /* ------------------------------------------------- the lunar mass driver */
  {
    id: "mass-driver",
    cooldown: 300,
    weight: 3,
    from: "Lunar Mass Driver · Mare Imbrium",
    title: "Capsule inbound",
    body: (s) =>
      `A maglev rail on the Moon throws a satellite into solar orbit every five seconds, for the price of electricity. Every thousandth launch is a capsule for Venus.${s.count("skyport") ? " Your Skyport has it on approach." : " Without a Skyport you will have to catch it with a net."}`,
    when: (s) => s.s.t > 80,
    choices: (s) => [
      {
        label: s.count("skyport") ? "Bring it in" : "Catch it with a net",
        run: (s2) => {
          const port = s2.count("skyport") > 0;
          s2.give({ carbon: port ? 110 : 55, air: 30 });
          s2.sendPeople(port ? 18 : 6);
          s2.push({ kind: "shipment" });
          return port
            ? "Textbook. The capsule kisses the pad. +110 carbon, +30 air, 18 people."
            : "Mostly caught. +55 carbon, +30 air, and six slightly dizzy people.";
        },
      },
    ],
  },
  {
    id: "sticker",
    once: true,
    from: "Dome 2 print shop",
    title: "MY OTHER CAR IS A LUNAR MASS DRIVER",
    body:
      "Somebody has started printing bumper stickers. There are no cars on Venus. Almost nobody gets the joke.",
    when: (s) => s.s.t > 220 && s.count("dome") >= 2,
    choices: () => [
      {
        label: "Put one on the Spire",
        run: (s) => {
          s.give({ culture: 20 });
          return "Almost nobody gets it. The people who do get it are the cool people, and now they know where each other live. +20 culture.";
        },
      },
      {
        label: "Order a thousand",
        run: (s) => {
          s.give({ carbon: -20, culture: 30 });
          return "They sell out in an afternoon, to people with no cars. -20 carbon, +30 culture.";
        },
      },
    ],
  },

  /* ---------------------------------------------------------- the biolab */
  {
    id: "outbreak",
    trigger: "biolab",
    from: (s) => "Biolab",
    title: "Something is growing",
    body:
      "It is growing faster than the model said it would. It is also, somehow, purple, and it has found the air ducts. The lab is on its own tether.",
    when: () => false,
    choices: (s, tile) => [
      {
        label: "Cut it loose",
        hint: "Lose the module. Gain the science.",
        run: (s2) => {
          if (tile) s2.cutLoose(tile.q, tile.r);
          s2.give({ science: 30 });
          return "The tether parts. The lab falls fifty kilometres into 462 °C and ninety bar. Instant sterilization: the planet cleans up the mess. You kept the notes. +30 science.";
        },
      },
      {
        label: "Contain it",
        hint: "40 power, 30 carbon, and a gamble",
        disabled: s.s.res.power < 40 || s.s.res.carbon < 30,
        run: (s2) => {
          s2.give({ power: -40, carbon: -30 });
          if (s2.random() < 0.65) {
            s2.give({ science: 60 });
            return "It was a new extremophile, and it is now a paper. +60 science.";
          }
          s2.s.integrity = Math.max(0.2, s2.s.integrity - 0.3);
          s2.s.pop = Math.max(12, s2.s.pop * 0.88);
          return "It got into the hydroponics. Nobody is hurt, but a dome had to be vented and some people have gone to stay with a neighbour city until it blows over. Hull -30%.";
        },
      },
    ],
  },
  {
    id: "nanofab",
    trigger: "nanofab",
    from: "Nanofab",
    title: "It has started making more Nanofab",
    body:
      "Quietly, and very well. The tether is holding three times its rated load and the new growth has a sense of humour about it.",
    when: () => false,
    choices: (s, tile) => [
      {
        label: "Cut it loose",
        run: (s2) => {
          if (tile) s2.cutLoose(tile.q, tile.r);
          s2.give({ carbon: 60 });
          return "Down it goes. Whatever it was making, it is making it at the surface now, briefly. +60 carbon from the bits that fell off first.";
        },
      },
      {
        label: "Negotiate",
        hint: "It seems reasonable",
        run: (s2) => {
          if (s2.random() < 0.5) {
            s2.give({ carbon: 220 });
            return "It agrees to a four-day week. Output triples, briefly. +220 carbon.";
          }
          s2.s.flags.extraMass = 240;
          s2.s.flags.extraMassUntil = s2.s.t + 90;
          return "It agrees in principle and keeps going in practice. 240 tonnes of grey sludge on the deck until it sets. You are going to sink for a minute and a half.";
        },
      },
    ],
  },

  /* -------------------------------------------------------- the neighbours */
  {
    id: "homies",
    cooldown: 300,
    weight: 3,
    from: "A neighbouring city",
    title: (s) => `${pick(s, NEIGHBOURS)} is drifting alongside`,
    body:
      "Same altitude, same wind, a hundred kilometres an hour and dead calm on deck. You're homies. They have more than they need, which is the normal state of affairs up here.",
    when: (s) => s.s.t > 140,
    choices: () => [
      {
        label: "Tie up and trade",
        hint: "Carbon and air",
        run: (s) => {
          s.give({ carbon: 70, air: 50 });
          return "There is no scarcity when the building material is the sky. +70 carbon, +50 air.";
        },
      },
      {
        label: "Throw a rim party",
        hint: "Culture, and everyone happier",
        run: (s) => {
          s.give({ culture: 35 });
          s.s.flags.joy = 0.12;
          s.s.flags.joyUntil = s.s.t + 120;
          s.s.stats.parties++;
          s.push({ kind: "party" });
          return "Two cities, one sunset, both bands playing. +35 culture, and everybody is in a better mood for a while.";
        },
      },
    ],
  },

  /* ------------------------------------------------------------------ Mars */
  {
    id: "mars-mail",
    cooldown: 360,
    weight: 2,
    from: "Mars Colony One",
    title: "Quick question",
    body:
      "\"Is it true you have 0.9 g? Asking for our femurs. Also: is it true you can go outside in a coat? We have been in this tent for four hundred days.\"",
    when: (s) => s.s.pop >= 70,
    choices: (s) => [
      {
        label: "\"Come on down. Sunward is downhill.\"",
        run: (s2) => {
          s2.sendPeople(25);
          return "Twenty-five Martians book passage. They will need somewhere to live.";
        },
      },
      {
        label: "Send them a recording of the jazz",
        disabled: s.count("jazz") === 0,
        run: (s2) => {
          s2.give({ culture: 25 });
          s2.sendPeople(10);
          return "It is the most-played file on Mars within a day. +25 culture, and ten people who just want to hear it live.";
        },
      },
    ],
  },
  {
    id: "exodus",
    once: true,
    weight: 8,
    from: "Mars Colony One · all of it",
    title: "Mars votes to move",
    body:
      "Two hundred and twelve people, unanimous, one abstention (the abstention is a cat). They have seen the pictures. They would like to live somewhere they can stand up straight.",
    when: (s) => s.s.pop >= 850,
    choices: () => [
      {
        label: "Make room",
        run: (s) => {
          s.sendPeople(212);
          return "They are on the way. It is the largest migration in the history of the solar system, and it is to the planet everybody wrote off.";
        },
      },
    ],
  },

  /* ---------------------------------------------------------------- culture */
  {
    id: "habsburg",
    cooldown: 240,
    weight: 4,
    from: "The Ballroom",
    title: "The Season opens",
    body:
      "For one month the whole city is in character as the Habsburg court. Nobody on Venus is rich — the building material is the sky — so status comes from how well you play it.",
    when: (s) => s.count("ballroom") > 0,
    choices: () => [
      {
        label: "Play Maria Theresa, properly",
        run: (s) => {
          s.give({ culture: 90 });
          return "Sixteen children, a war of succession, and a standing ovation. +90 culture.";
        },
      },
      {
        label: "Play Franz Joseph, badly",
        run: (s) => {
          s.give({ culture: 55 });
          s.s.flags.joy = 0.1;
          s.s.flags.joyUntil = s.s.t + 120;
          return "The sideburns are glued on crooked and everyone loves it. +55 culture, and a good mood.";
        },
      },
    ],
  },
  {
    id: "jam",
    cooldown: 320,
    weight: 3,
    from: "The house band",
    title: "Sunrise set",
    body:
      "They want to play on the rim as the city comes round into the light. Nobody knows what they are going to play, including them. That is the point.",
    when: (s) => s.count("jazz") > 0,
    choices: () => [
      {
        label: "Let them play",
        run: (s) => {
          s.give({ culture: 40 });
          s.s.stats.parties++;
          s.push({ kind: "party" });
          return "An AI could have written a better tune. It could not have played this one, here, once. +40 culture.";
        },
      },
    ],
  },
  {
    id: "shade",
    once: true,
    weight: 3,
    from: "The Founder",
    title: "The shade structure",
    body:
      "\"Remember Burning Man? If your shade structure can't stay up, your social structure wasn't strong enough. Same here, only the shade structure is the city.\" People are getting restless. There is nothing to do up here but work.",
    when: (s) => s.s.pop >= 50 && s.count("jazz") === 0 && s.d.happiness < 0.8,
    choices: () => [
      {
        label: "Throw a party on the rim",
        hint: "20 power",
        run: (s) => {
          s.give({ power: -20, culture: 30 });
          s.s.flags.joy = 0.1;
          s.s.flags.joyUntil = s.s.t + 150;
          s.push({ kind: "party" });
          return "It helps. A Jazz Club would help for longer. +30 culture.";
        },
      },
    ],
  },
  {
    id: "lando",
    once: true,
    from: "The Mayor's office",
    title: "People have started calling the mayor Lando",
    body: "It is the cloud city. It was always going to happen.",
    when: (s) => s.s.pop >= 180,
    choices: () => [
      {
        label: "Lean in. Get the cape.",
        run: (s) => {
          s.give({ culture: 30 });
          return "The cape is carbon fibre and gold. +30 culture.";
        },
      },
      { label: "Absolutely not the cape", run: () => "Nobody listens. Somebody makes a cape anyway." },
    ],
  },

  /* ------------------------------------------------------------ the planet */
  {
    id: "venera",
    once: true,
    from: "Survey drone",
    title: "Found it",
    body:
      "Venera 13, on the plains fifty-four kilometres below. The Soviets landed it in 1982. It was designed to last thirty-two minutes and it lasted 127, taking colour photographs of a 462 °C afternoon. That is what everybody pictures when you say Venus.",
    when: (s) => s.s.t > 300,
    choices: () => [
      {
        label: "Dip the lights",
        run: (s) => {
          s.give({ culture: 25 });
          return "Every dome in the city goes dark for a minute. +25 culture.";
        },
      },
    ],
  },
  {
    id: "squall",
    cooldown: 260,
    weight: 2,
    from: "Weather desk",
    title: "Acid squall",
    body:
      "A thick band of cloud is coming through the altitude. The stills could fill up in minutes. Remember that water is ballast: a tonne a unit.",
    when: (s) => s.count("still") > 0,
    choices: () => [
      {
        label: "Open the stills",
        run: (s) => {
          s.give({ water: 60 });
          return "Tanks full. You are heavier now; watch the altimeter.";
        },
      },
      { label: "Close up and wait", run: () => "It passes. The canopies need a wipe." },
    ],
  },
  {
    id: "mercury",
    once: true,
    weight: 2,
    from: "Inner System Works",
    title: "Mercury, for parts",
    body:
      "\"We are taking Mercury apart to build AI satellites. It is the Saudi Arabia of planets: too close to the Sun to live on, perfect to mine. Want some metal? We can drop it downhill to you.\"",
    when: (s) => s.s.t > 560,
    choices: (s) => [
      {
        label: "Trade science for metal",
        hint: "-40 science, +240 carbon-equivalent",
        disabled: s.s.res.science < 40,
        run: (s2) => {
          s2.give({ science: -40, carbon: 240 });
          return "A crate of Mercury arrives, still warm. +240 carbon.";
        },
      },
      {
        label: "Ask them to keep Venus off the list",
        run: (s2) => {
          s2.give({ culture: 20 });
          return "\"Oh, we'd never. You're the one that works.\" +20 culture.";
        },
      },
    ],
  },
  {
    id: "earth-press",
    once: true,
    weight: 5,
    from: "Earth · a journalist",
    title: "\"How did nobody notice?\"",
    body:
      "Everyone raced to the Moon, then to Mars. The Moon has a railgun. Mars has a tent. You have five hundred people, a jazz scene and a sunset every nine days. What is the secret?",
    when: (s) => s.s.pop >= 480,
    choices: () => [
      {
        label: "\"Everybody looked at the surface.\"",
        run: (s) => {
          s.give({ culture: 40 });
          s.sendPeople(40);
          return "The article goes everywhere. Forty people sign up before it has finished loading. +40 culture.";
        },
      },
      {
        label: "\"Please don't tell anyone.\"",
        run: (s) => {
          s.give({ culture: 60 });
          return "Which, naturally, makes it the coolest place in the solar system. +60 culture.";
        },
      },
    ],
  },
];

/** For the build card: what a module is heavy with. */
export function netLift(id: keyof typeof MODULES): number {
  const m = MODULES[id];
  return m.lift - m.mass;
}
