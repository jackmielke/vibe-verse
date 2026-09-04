/**
 * Mars College, the rules.
 *
 * Ten weeks in the desert near the Salton Sea, January to March 2025, as a
 * state machine. Three day-parts to a day, seventy days, five meters, and a
 * handful of actions that each cost a chunk of the day. Nothing here imports
 * three, so the whole run can be played a few hundred times in a test.
 *
 * There is no death. The desert does not kill you; it just makes the ending
 * sadder. Every run reaches the teardown, and the last card reads your stats
 * back to you and says the line anyway, because he meant it.
 */

export type Part = "morning" | "afternoon" | "night";
export const PARTS: Part[] = ["morning", "afternoon", "night"];
export const WEEKS = 10;
export const DAYS = WEEKS * 7;

export type Action =
  | "sleep"
  | "water"
  | "parts"
  | "build"
  | "pullup"
  | "dinner"
  | "hug"
  | "research"
  | "run"
  | "nature"
  | "freeside"
  | "sunflower"
  | "poop";

export interface Stats {
  dinners: number;
  /** Kilometres on the unicycle, water runs included. */
  km: number;
  kmRun: number;
  storms: number;
  waterRuns: number;
  hugs: number;
  builds: number;
  runs: number;
  falls: number;
  scorpions: number;
  research: number;
  coldNights: number;
}

export interface DayCard {
  id: string;
  title: string;
  date: string;
  lines: string[];
}

export interface ColonyState {
  seed: number;
  /** RNG state. Advance it only through `roll`. */
  rng: number;
  day: number;
  part: Part;
  over: boolean;
  water: number;
  power: number;
  shelter: number;
  connection: number;
  purpose: number;
  parts: number;
  pullupBar: boolean;
  /** Days on which the brown wall arrives. Fixed at the start of the run. */
  stormDays: number[];
  storm: boolean;
  stormWarning: boolean;
  coldNight: boolean;
  socialToday: boolean;
  workToday: boolean;
  poopToday: boolean;
  metBrain: boolean;
  longRunDone: boolean;
  /** What the last action said. Replaced every call. */
  lines: string[];
  /** A day card raised by the last transition, or null. */
  card: DayCard | null;
  stats: Stats;
}

// ---------------------------------------------------------------------------
// The voice notes. These are the real ones, in the order he said them.
// ---------------------------------------------------------------------------

export const DAY_CARDS: DayCard[] = [
  {
    id: "day1",
    title: "Day one",
    date: "1/12/25",
    lines: [
      "Now that I'm on Mars, it's exciting. I feel a sense of unbounded freedom. Motivation to work and learn a lot. And definitely a deeper sense of mystery. It's good to be here.",
    ],
  },
  {
    id: "week5",
    title: "Week five",
    date: "2/16/25",
    lines: [
      "The emphasis on freedom means we can do literally anything we want.",
      "Things haven't felt to always just click quite as well as they did at Edge City for me. Regardless, there's no place I'd rather be right now than here.",
    ],
  },
  {
    id: "week10",
    title: "Raw reflections",
    date: "3/15/25",
    lines: [
      "I was attracted by friends.",
      "It gives me space to fully lean into the most weird, curious, and extraordinary parts of myself. The part of me that records conversations for my AI bot that doesn't even exist yet.",
      "We got really into running. We even ran over 25 kilometers one day.",
      "I'd rather just build the world that I want to live in.",
      "I'm going to miss this crazy desert era of my life.",
    ],
  },
  {
    id: "last",
    title: "Last day",
    date: "3/28/25",
    lines: [
      "It basically felt like an intellectual summer camp for adults.",
      "For the first month at least, I'd wake up every day, step out onto the desert sand to a cool sunrise, and remember, Oh my God, I'm actually doing this.",
      "Besides groceries, I didn't pay for anything throughout the month.",
      "Money becomes a useful tool once a group grows beyond about 10 people.",
      "But man, did I love it.",
    ],
  },
];

/** The verdict line. It is the same whatever the meters say. He meant it. */
export const VERDICT = "But man, did I love it.";

// ---------------------------------------------------------------------------
// RNG: mulberry32, so a seed is a whole run.
// ---------------------------------------------------------------------------

function mulberry(state: number): { value: number; next: number } {
  const t = (state + 0x6d2b79f5) | 0;
  let r = Math.imul(t ^ (t >>> 15), 1 | t);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
  return { value: ((r ^ (r >>> 14)) >>> 0) / 4294967296, next: t };
}

function roll(s: ColonyState): number {
  const { value, next } = mulberry(s.rng);
  s.rng = next;
  return value;
}

/**
 * Between two and six storms, none in the first three days, none in the last
 * week (the teardown wants a sky), at least four days apart.
 */
export function planStorms(seed: number): number[] {
  let rng = seed | 0;
  const draw = () => {
    const r = mulberry(rng);
    rng = r.next;
    return r.value;
  };
  const count = 2 + Math.floor(draw() * 5);
  const days: number[] = [];
  let guard = 0;
  while (days.length < count && guard++ < 400) {
    const d = 4 + Math.floor(draw() * (DAYS - 10));
    if (days.every((x) => Math.abs(x - d) >= 4)) days.push(d);
  }
  return days.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function newColony(seed = 7): ColonyState {
  const s: ColonyState = {
    seed,
    rng: seed | 0,
    day: 1,
    part: "morning",
    over: false,
    water: 70,
    power: 60,
    shelter: 0,
    connection: 45,
    purpose: 55,
    parts: 1,
    pullupBar: false,
    stormDays: planStorms(seed),
    storm: false,
    stormWarning: false,
    coldNight: true,
    socialToday: false,
    workToday: false,
    poopToday: false,
    metBrain: false,
    longRunDone: false,
    lines: [
      "Sunrise on the sand. Oh my God, I'm actually doing this.",
      "I'm also going to get some damn chapstick because my lips are frying off.",
      "I'm going to build a pull-up bar somewhere, if possible.",
    ],
    card: DAY_CARDS[0],
    stats: {
      dinners: 0,
      km: 0,
      kmRun: 0,
      storms: 0,
      waterRuns: 0,
      hugs: 0,
      builds: 0,
      runs: 0,
      falls: 0,
      scorpions: 0,
      research: 0,
      coldNights: 0,
    },
  };
  s.stormWarning = s.stormDays.includes(2);
  return s;
}

export function weekOf(day: number): number {
  return Math.min(WEEKS, Math.floor((day - 1) / 7) + 1);
}

export function partIndex(part: Part): number {
  return PARTS.indexOf(part);
}

const clamp = (v: number) => Math.max(0, Math.min(100, v));

function clone(s: ColonyState): ColonyState {
  return { ...s, stormDays: [...s.stormDays], lines: [], card: null, stats: { ...s.stats } };
}

/** Shelter halves the things the desert does to you at night and in a storm. */
function shelterFactor(s: ColonyState): number {
  return s.shelter >= 100 ? 0.5 : 1 - s.shelter / 400;
}

function pick<T>(s: ColonyState, list: T[]): T {
  return list[Math.floor(roll(s) * list.length) % list.length];
}

/** One day-part goes by. Passive drift only; the day roll happens in `newDay`. */
function passPart(s: ColonyState): void {
  const i = partIndex(s.part);
  // Water goes whatever you do. Dust storms get into the jerry cans.
  s.water = clamp(s.water - 2 - (s.storm ? 2 : 0) - (weekOf(s.day) >= 8 ? 1 : 0));
  // Solar: charges by day, the router and the fridge drain it all the time,
  // and a storm is a lid on the panels.
  if (s.storm) s.power = 0;
  else if (s.part === "morning") s.power = clamp(s.power + 12);
  else if (s.part === "afternoon") s.power = clamp(s.power + 14);
  else s.power = clamp(s.power - 12);
  if (i === PARTS.length - 1) {
    s.part = "morning";
    newDay(s);
  } else {
    s.part = PARTS[i + 1];
  }
}

function newDay(s: ColonyState): void {
  // The night that just ended.
  if (s.coldNight) {
    const hit = 4 * shelterFactor(s);
    s.purpose = clamp(s.purpose - hit);
    s.stats.coldNights++;
    s.lines.push(
      s.shelter >= 100
        ? "Cold night. The shelter held most of it. Bed sheets still gritty."
        : pick(s, [
            "Very cold night. Very cold. You slept in the down jacket and it was not enough.",
            "Cold enough in the trailer that the water bottle by the bed went stiff.",
            "You woke up at four with your feet gone. There is a reason people build walls.",
          ]),
    );
  }
  if (!s.socialToday) s.connection = clamp(s.connection - 4);
  if (!s.workToday && !s.socialToday) {
    s.purpose = clamp(s.purpose - 5);
    s.lines.push("A day went by and you were in the trailer for most of it.");
  }
  if (s.pullupBar) s.purpose = clamp(s.purpose + 1);

  s.day++;
  s.socialToday = false;
  s.workToday = false;
  s.poopToday = false;

  if (s.day > DAYS) {
    s.day = DAYS;
    s.over = true;
    s.storm = false;
    s.stormWarning = false;
    s.card = DAY_CARDS[3];
    s.lines.push("Week ten is over. Everything comes down today. Pallet racks, plywood, the table, the bar.");
    return;
  }

  const week = weekOf(s.day);
  // Cold nights are a January thing; by March the problem is the opposite.
  s.coldNight = roll(s) < (week <= 3 ? 0.7 : week <= 6 ? 0.4 : 0.1);
  if (week >= 8 && roll(s) < 0.5) {
    s.water = clamp(s.water - 3);
    s.lines.push("It is going to be white-hot by noon. Drink before you are thirsty.");
  }

  s.storm = s.stormDays.includes(s.day);
  s.stormWarning = s.stormDays.includes(s.day + 1);
  if (s.storm) {
    s.stats.storms++;
    s.power = 0;
    const f = shelterFactor(s);
    s.purpose = clamp(s.purpose - 3 * f);
    s.connection = clamp(s.connection - 2);
    s.water = clamp(s.water - 3 * f);
    s.lines.push(
      "Dust storm. The brown wall came in over the sea and now the whole world is inside it.",
      s.shelter >= 100
        ? "The shelter is holding. The bed sheets are not."
        : "Dust in the bed sheets, dust in the laptop, dust in the water. Highlight and lowlight.",
    );
  } else if (s.stormWarning) {
    s.lines.push("There is a brown line on the horizon over the sea. Tomorrow is going to be a dust day.");
  }

  if (s.day === 29) s.card = DAY_CARDS[1];
  else if (s.day === 64) s.card = DAY_CARDS[2];
  else if (s.day === 2) s.lines.push("Day two. Power drills from the first light. There will be power drills all day, every day, until March.");
  else if (s.day % 7 === 1) s.lines.push(`Week ${week}. ${pick(s, WEEK_LINES)}`);
}

const WEEK_LINES = [
  "Somebody is walking to breakfast with no clothes on and nobody has mentioned it.",
  "The porta potties have been rearranged again. It is officially an installation now.",
  "Two more unicycles arrived. The falling-off rate is going to go up.",
  "The dodecahedron has been repainted. Nobody will say by whom.",
  "Somebody's AI agent booked the dinner rota for the week without asking.",
  "Three people got up at five to run to the mountains and back. They want you next time.",
  "A parking lot of trailers and one very good table in the middle of it.",
  "Freeside has a hammock now. Nobody has seen the floor of Freeside since.",
  "The Mars Brain answered a question about scorpions with a poem.",
];

/** Advance the clock by n day-parts, no action attached. */
export function advance(s: ColonyState, n = 1): ColonyState {
  const next = clone(s);
  for (let i = 0; i < n && !next.over; i++) passPart(next);
  return next;
}

export interface Verdict {
  grade: string;
  line: string;
}

export function verdict(s: ColonyState): Verdict {
  const avg = (s.water + s.power + s.shelter + s.connection + s.purpose) / 5;
  const grade =
    avg >= 70
      ? "Crazy desert era, fully lived."
      : avg >= 50
        ? "A good winter in a trailer near a dead sea."
        : avg >= 30
          ? "You were there. Mostly in the trailer, but there."
          : "Ten weeks of sand and a lot of naps. Reintegrating will be easy.";
  return { grade, line: VERDICT };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const ACTIONS: Action[] = [
  "sleep",
  "water",
  "parts",
  "build",
  "pullup",
  "dinner",
  "hug",
  "research",
  "run",
  "nature",
  "freeside",
  "sunflower",
  "poop",
];

/** Does the action cost a day-part, and how many. Zero means it is free. */
export function costOf(a: Action): number {
  if (a === "water") return 2;
  if (a === "poop") return 0;
  return 1;
}

export function act(state: ColonyState, a: Action): ColonyState {
  if (state.over) return { ...clone(state), lines: ["It is over. Everything is coming down."] };
  const s = clone(state);
  let cost = costOf(a);

  switch (a) {
    case "sleep":
      s.lines.push(
        s.part === "night"
          ? pick(s, [
              "You sleep. There is dust on the sheets and the stars are absurd.",
              "Lights out. Somebody is still drilling. Somebody is always still drilling.",
              "Asleep by nine. The desert is loud in a way that has no sound in it.",
            ])
          : pick(s, [
              "A nap in the trailer. The drills carry on.",
              "You lie in the shade and let a chunk of the day go.",
              "You sit on the plywood step and watch the mountains not move.",
            ]),
      );
      break;

    case "water":
      s.water = 100;
      s.stats.waterRuns++;
      s.stats.km += 24;
      s.connection = clamp(s.connection + 3);
      s.lines.push(
        pick(s, [
          "Town. Twelve jerry cans, a bag of ice, chapstick. Half a day gone.",
          "The water run. Somebody rode along for the AC and the gas station burrito.",
          "Water, and a slow ride back along the sea with the music up.",
        ]),
      );
      break;

    case "parts":
      s.parts += 2;
      s.workToday = true;
      s.purpose = clamp(s.purpose + 2);
      s.lines.push(
        pick(s, [
          "Tool Camp. Two pallet-rack uprights, a sheet of plywood and a bag of screws, on a unicycle. Slowly.",
          "You help unload a truck of plywood and they let you take a sheet home.",
          "Tool Camp lends you the good drill on the condition that you bring it back today.",
        ]),
      );
      break;

    case "build":
      if (s.parts < 1) {
        s.lines.push("Nothing to build with. Tool Camp has plywood.");
        cost = 0;
        break;
      }
      if (s.power < 15) {
        s.lines.push("The drill battery is flat and so is the solar. Wait for sun, or build in the morning.");
        cost = 0;
        break;
      }
      s.parts--;
      s.power = clamp(s.power - 12);
      s.workToday = true;
      s.stats.builds++;
      if (roll(s) < 0.07) {
        s.stats.scorpions++;
        s.purpose = clamp(s.purpose - 3);
        s.lines.push(
          "You lift the plywood and there is a scorpion under it, tail up, extremely calm. You are not calm. That is the day gone.",
        );
        cost = PARTS.length - partIndex(s.part);
        break;
      }
      s.shelter = clamp(s.shelter + 20);
      s.purpose = clamp(s.purpose + 6);
      s.lines.push(
        s.shelter >= 100
          ? "The last sheet goes on. It is a box made of pallet racks and plywood and it is the best house you have ever built."
          : pick(s, [
              "Pallet rack up. Drill all afternoon. Everybody else is drilling too, so it is a choir.",
              "Plywood on the frame. Screws in the pocket, screws in the sand, screws in the shoe.",
              "A wall. Not a whole wall. Enough wall that the wind has to think about it.",
              "Shade cloth over the top. The trailer is a trailer again instead of an oven.",
            ]),
      );
      break;

    case "pullup":
      if (s.pullupBar) {
        s.lines.push("The pull-up bar is up. Use it.");
        cost = 0;
        break;
      }
      if (s.day > 7) {
        s.lines.push("The pull-up bar moment has passed. Build the shelter.");
        cost = 0;
        break;
      }
      s.pullupBar = true;
      s.workToday = true;
      s.purpose = clamp(s.purpose + 4);
      s.lines.push("A pull-up bar. Two uprights, one beam, and it does not wobble much. Small daily purpose, forever.");
      break;

    case "dinner":
      if (s.part !== "night") {
        s.lines.push("It is not dinner yet. The table only pulls after dark.");
        cost = 0;
        break;
      }
      s.stats.dinners++;
      s.socialToday = true;
      s.connection = clamp(s.connection + 10);
      s.purpose = clamp(s.purpose + 2);
      s.water = clamp(s.water - 2);
      s.lines.push(
        pick(s, [
          "Dinner for fourteen at the table in the middle. Atin calls it the gravity well.",
          "You cook for twelve. Somebody from Bodywork brought a lentil thing and a very long hug.",
          "The table is full, all six camps, which never happens anywhere else on Mars.",
          "Dinner under the string lights. Somebody from Mars Research explains the dodecahedron again.",
          "Rice, beans, three kinds of hot sauce, and a debate about whether AI can be naked.",
        ]),
      );
      break;

    case "hug":
      s.stats.hugs++;
      s.socialToday = true;
      s.connection = clamp(s.connection + 8);
      s.purpose = clamp(s.purpose + 1);
      s.lines.push(
        pick(s, [
          "Bodywork camp. Expect noticeably longer hugs. You were not warned enough.",
          "Somebody works on your shoulder for twenty minutes and finds the unicycle in it.",
          "Mindfulness under the shade cloth. You fall asleep and nobody minds.",
          "A hug that lasts long enough to become a conversation.",
        ]),
      );
      break;

    case "research":
      if (s.power < 10) {
        s.lines.push("The internet is down again and the Mars Brain is asleep. Sun first.");
        cost = 0;
        break;
      }
      s.power = clamp(s.power - 10);
      s.workToday = true;
      s.stats.research++;
      s.purpose = clamp(s.purpose + 8);
      if (!s.metBrain) {
        s.metBrain = true;
        s.lines.push(
          "Hey! I'm the Mars Brain, the collective consciousness of Mars College.",
          "Your wrists are shot from building it, so from now on you talk to it instead of clicking.",
        );
      } else {
        s.lines.push(
          pick(s, [
            "A session at Mars Research. The Brain has read every voice note and has opinions.",
            "You record a whole conversation for an AI bot that does not exist yet.",
            "Somebody's agent has been talking to the Mars Brain all night. They are friends now.",
            "Two hours of building, one hour of the internet dying, one good idea.",
          ]),
        );
      }
      break;

    case "run":
      if (s.water < 15) {
        s.lines.push("Too dry to run. Town first.");
        cost = 0;
        break;
      }
      s.stats.runs++;
      s.socialToday = true;
      s.workToday = true;
      s.water = clamp(s.water - 10);
      s.connection = clamp(s.connection + 6);
      s.purpose = clamp(s.purpose + 5);
      if (s.stats.runs >= 3 && !s.longRunDone) {
        s.longRunDone = true;
        s.stats.kmRun += 25;
        s.lines.push("The long one. Over 25 kilometres, to the mountains and back, out of water at 19, singing at 24.");
      } else {
        const km = 6 + Math.floor(roll(s) * 7);
        s.stats.kmRun += km;
        s.lines.push(`A run east with the running people. ${km} km, no shade, worth it.`);
      }
      break;

    case "nature":
      s.socialToday = true;
      s.purpose = clamp(s.purpose + 4);
      s.connection = clamp(s.connection + 2);
      s.lines.push(
        pick(s, [
          "Natural Intelligence. They show you what lives under the plywood. It is mostly scorpions.",
          "A walk to the sea with the naturalists. It smells of fish and it looks like mercury.",
          "They have a microscope, a telescope and a jar with something in it. The something is fine.",
          "Bird count at the shore: pelicans, a hundred grebes, and one drone.",
        ]),
      );
      break;

    case "freeside":
      s.socialToday = true;
      s.connection = clamp(s.connection + 6);
      s.purpose = clamp(s.purpose + 1);
      s.lines.push(
        pick(s, [
          "Freeside. Lifestyle design and co-living, which today means a hammock and a very long conversation about breakfast.",
          "Somebody at Freeside is naked and drawing a floor plan. Being naked is normal. The floor plan is good.",
          "They are designing a life. You sit in on it and come away with a new bedtime.",
          "Freeside has a whiteboard titled WHAT DO WE ACTUALLY WANT and it is full.",
        ]),
      );
      break;

    case "sunflower":
      s.socialToday = true;
      s.connection = clamp(s.connection + 6);
      s.purpose = clamp(s.purpose + 4);
      s.lines.push(
        pick(s, [
          "Sunflower Lab, Bombay Beach. Being healthy, happy and successful, here, not on Mars.",
          "They feed you and make you look at the sea for ten minutes without talking.",
          "Bombay Beach at golden hour. The art is a drive-in with no screen and a pyramid with no point.",
          "A Sunflower afternoon. Somebody has a sauna in a shed and the sea is the cold plunge.",
        ]),
      );
      break;

    case "poop":
      if (s.poopToday) {
        s.lines.push("Poop Mountain. Still there. Still an installation.");
        break;
      }
      s.poopToday = true;
      s.purpose = clamp(s.purpose + 2);
      s.connection = clamp(s.connection + 2);
      s.lines.push(
        pick(s, [
          "Poop Mountain. Four porta potties, a ramp, flags, and the best view of the sea on Mars.",
          "You ride up Poop Mountain with the music on. Somebody applauds from a roof.",
          "The porta potties became an art installation the day somebody put a flag on them.",
        ]),
      );
      break;
  }

  for (let i = 0; i < cost && !s.over; i++) passPart(s);
  return s;
}
