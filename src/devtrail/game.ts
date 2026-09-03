/**
 * Developer Trail — the rules.
 *
 * Somebody at a table in Healdsburg this week said the thirty-page case study
 * of a nine-lot cottage project should be a game, "like Oregon Trail, with
 * developer chance cards — you know, hidden cavern under lot four, fifty-five
 * grand to fill." This is that game. You are a small developer. You have a
 * plan, some money, a town, and thirty-six months before the option on the
 * land runs out. Every month you pick a pace and something happens.
 *
 * Pure: no DOM, no time, one seeded random number generator, so a run can be
 * replayed and the test can play a thousand of them in a second. The page
 * draws whatever this says.
 */

export type DeveloperType = "Aspiring" | "Emerging" | "Developing" | "Mature" | "Supporting Cast";
export type Town = "Healdsburg" | "Bend" | "Bainbridge Island" | "Port Orchard";
export type Pace = "careful" | "steady" | "push";

/** The Path to Capital, then the part where you actually build. */
export const PHASES = [
  "Foundation",
  "Gap Analysis",
  "Assemble & Package",
  "Underwrite",
  "Capital Raise",
  "Entitlement",
  "Build",
  "Sell",
] as const;
export type Phase = (typeof PHASES)[number];

export const PHASE_BLURB: Record<Phase, string> = {
  Foundation: "Coaching, a plan on paper, and learning what you do not know.",
  "Gap Analysis": "Somebody honest reads the whole thing and tells you where the holes are.",
  "Assemble & Package": "Site, team, pro forma, drawings: the packet an investor can read in an hour.",
  Underwrite: "The lender's spreadsheet. Everything you assumed, checked.",
  "Capital Raise": "Investor circle, retail cheques, one angel. The money has to actually land.",
  Entitlement: "Permits, hearings, the neighbour with the lawyer.",
  Build: "Nine lots. Foundations, framing, finish. The ground has opinions.",
  Sell: "Cottages on the market. Price, timing, and how the town feels about you.",
};

export const LOTS = 9;
export const MONTHS = 36;

/** 0 dirt, 1 foundation, 2 framed, 3 finished, 4 sold. */
export type LotStage = 0 | 1 | 2 | 3 | 4;

export interface Card {
  id: string;
  title: string;
  text: string;
  /** Which phases it can fire in; empty = any. */
  phases?: Phase[];
  towns?: Town[];
  weight: number;
  cash?: number;
  energy?: number;
  goodwill?: number;
  /** Phase progress, in points (100 finishes a phase). */
  progress?: number;
  /** Months lost, on top of the one that passes anyway. */
  delay?: number;
  investors?: number;
  emoji: string;
}

export const CARDS: Card[] = [
  { id: "cavern", emoji: "🕳️", title: "Hidden cavern under Lot 4", text: "The excavator finds air where the footing should be. $55,000 to fill.", phases: ["Build"], weight: 3, cash: -55000, energy: -8 },
  { id: "rain", emoji: "🌧️", title: "Rain and 71", text: "Bring a jacket and pants. Framing waits a month for the mud to go.", phases: ["Build"], weight: 3, delay: 1 },
  { id: "airship", emoji: "🎈", title: "An airship passes overhead", text: "Four hundred feet of it, silent, over the East Bay. Everybody on site stops and looks up. Nobody minds.", weight: 2, energy: 12, goodwill: 3 },
  { id: "noshow", emoji: "🚪", title: "Your co-builder no-shows", text: "You go to his house for the meeting. The roommates have not seen him all day. Still no reply.", weight: 3, delay: 1, energy: -10 },
  { id: "rates", emoji: "📈", title: "Rates up 75 basis points", text: "The lender redoes the sheet. Your debt service just grew, and so did the equity gap.", phases: ["Underwrite", "Capital Raise"], weight: 3, cash: -30000, progress: -15 },
  { id: "circle", emoji: "🫶", title: "Retail investor circle", text: "Sixty people at ten thousand each say yes at the forum. It took two years of showing up.", phases: ["Capital Raise"], weight: 3, cash: 600000, investors: 60, goodwill: 6 },
  { id: "appeal", emoji: "⚖️", title: "A neighbour files an appeal", text: "Planning commission hearing in two months. She has a lawyer and a Facebook group.", phases: ["Entitlement"], weight: 4, delay: 2, goodwill: -8 },
  { id: "traffic", emoji: "🚦", title: "The county wants a traffic study", text: "For nine cottages. $18,000 and six weeks.", phases: ["Entitlement"], weight: 3, cash: -18000, delay: 1 },
  { id: "jacket", emoji: "🧥", title: "A signed leather jacket sells for a million", text: "Somebody at the auction was in a generous mood. An angel who saw your packet writes a cheque.", phases: ["Capital Raise"], weight: 1, cash: 250000, investors: 1 },
  { id: "smoke", emoji: "🔥", title: "Wildfire smoke week", text: "AQI 300. Nobody frames in that. Everybody checks the map every hour.", towns: ["Bend"], weight: 4, delay: 1, energy: -10 },
  { id: "ferry", emoji: "⛴️", title: "Ferry cancelled", text: "Wind in the Sound. The inspector is on the other side of it.", towns: ["Bainbridge Island"], weight: 4, delay: 1 },
  { id: "shopper", emoji: "🕵️", title: "Mystery shopper", text: "Somebody calls posing as a party planner to learn your pricing. It is definitely the other developer. You give her the real number anyway.", weight: 2, goodwill: 2 },
  { id: "wings", emoji: "✈️", title: "The airplane takes off without wings", text: "And you strap them on midway. It works. It costs you.", weight: 3, energy: -22, progress: 25 },
  { id: "ramekins", emoji: "🥣", title: "The pro forma double-counts the ramekins", text: "Gap analysis finds it. Small number, big lesson: every line gets read.", phases: ["Gap Analysis", "Assemble & Package"], weight: 3, cash: -4000, progress: 10 },
  { id: "kids", emoji: "🎮", title: "The kids vibe-code your project", text: "A seven-year-old builds a game about your cottages: ten worlds, fifty game modes. The local paper runs it.", weight: 2, goodwill: 10, energy: 8 },
  { id: "credits", emoji: "💳", title: "Credits ran out mid-demo", text: "In front of the whole investor circle. You finish the pitch on a whiteboard, which somehow goes better.", phases: ["Capital Raise", "Assemble & Package"], weight: 2, cash: -1200, goodwill: 3 },
  { id: "cheques", emoji: "💌", title: "Uncashed cheques", text: "The fractional CFO finds $9,000 in a drawer. Insurance refund, a client's deposit, a rebate from 2024.", weight: 2, cash: 9000 },
  { id: "monopoly", emoji: "🎲", title: "Monopoly Deal runs late", text: "Prawn biryani, a rubber duck on the robot, and a game that ends at two. Everybody is useless tomorrow.", weight: 2, energy: -8, goodwill: 4 },
  { id: "tree", emoji: "🌳", title: "Touch one tree a day", text: "Upgraded from touching grass. You measure grounded-ness before and after. It is better after.", weight: 3, energy: 15 },
  { id: "motown", emoji: "🕺", title: "Motown Monday", text: "You dance. The month passes anyway, but you come back a person.", weight: 2, energy: 20 },
  { id: "prep", emoji: "🥤", title: "Clear-liquid day", text: "Procedure prep. You get nothing done this week and nobody expects you to.", weight: 2, progress: -8, energy: 5 },
  { id: "inquiries", emoji: "💒", title: "Twelve wedding inquiries", text: "All for a different business. You forward them and lose an afternoon.", weight: 2, progress: -4 },
  { id: "forum", emoji: "🏛️", title: "The forum sells out in two weeks", text: "A small immersive event with the right people in the room. Two of them want in.", phases: ["Capital Raise", "Assemble & Package", "Underwrite"], weight: 3, investors: 2, cash: 80000, goodwill: 4 },
  { id: "hill", emoji: "⛰️", title: "Mile four", text: "You pushed too hard for too long. Salivating, hands on knees. Stop. Drink. Slow down.", weight: 2, energy: -18 },
  { id: "market", emoji: "🏠", title: "Rents up 23% year on year", text: "Vacancy at 2%. Small cottages near town are exactly what the market cannot find.", phases: ["Sell"], weight: 3, cash: 45000, goodwill: -2 },
  { id: "hangar", emoji: "🏗️", title: "The fryer was sized for the wrong party", text: "Kit did not match the job. You redo the equipment schedule before it happens on site.", phases: ["Build"], weight: 2, cash: -7000, progress: 8 },
  { id: "memory", emoji: "🧠", title: "Second brain", text: "You finally wire your notes, transcripts and the packet into one place. Every future month goes faster.", weight: 2, progress: 12, energy: 4 },
  { id: "soccer", emoji: "⚽", title: "Scrappy founders play soccer", text: "Seed to Series A, Monday at six. You are on the waitlist and then you are in. Cooked legs, clear head.", weight: 2, energy: 10, goodwill: 3 },
];

export interface DevState {
  type: DeveloperType;
  town: Town;
  month: number;
  cash: number;
  energy: number;
  goodwill: number;
  investors: number;
  phase: number;
  progress: number;
  lots: LotStage[];
  /** Cash spent building, for the profit line at the end. */
  spent: number;
  revenue: number;
  log: LogEntry[];
  /** The card that fired this month, for the page to show. */
  card: Card | null;
  over: null | { won: boolean; title: string; text: string };
  seed: number;
}

export interface LogEntry {
  month: number;
  text: string;
  kind: "phase" | "card" | "build" | "sell" | "money" | "end" | "note";
}

const TYPE_START: Record<DeveloperType, { cash: number; skill: number; goodwill: number; energy: number; blurb: string }> = {
  Aspiring: { cash: 120000, skill: 0.75, goodwill: 55, energy: 100, blurb: "First project. Savings, a plan, and the coaching track. Everything is new and everything takes longer." },
  Emerging: { cash: 350000, skill: 0.95, goodwill: 50, energy: 92, blurb: "One project done, badly. You know what the gap analysis will say and you are doing it anyway." },
  Developing: { cash: 800000, skill: 1.1, goodwill: 48, energy: 85, blurb: "A few in the ground. Investors return your calls. Your calendar does not." },
  Mature: { cash: 1800000, skill: 1.25, goodwill: 40, energy: 70, blurb: "The town knows your name and half of it has opinions. Money is not the problem. Time is." },
  "Supporting Cast": { cash: 220000, skill: 0.9, goodwill: 72, energy: 95, blurb: "Architect, builder, lender: you are doing this from the side. Everybody likes you. Nobody thinks you can pull it off." },
};

const TOWN: Record<Town, { land: number; price: number; buildCost: number; blurb: string }> = {
  Healdsburg: { land: 900000, price: 1350000, buildCost: 420000, blurb: "Wine country, an hour north. Expensive dirt, buyers with money, a design review board that reads." },
  Bend: { land: 380000, price: 720000, buildCost: 300000, blurb: "High desert. Cheap land, fast market, smoke in August. Your partner flies in from here." },
  "Bainbridge Island": { land: 650000, price: 1100000, buildCost: 380000, blurb: "A ferry from Seattle. Where you grew up. Everybody on the island will have a view of the cottages, and of you." },
  "Port Orchard": { land: 240000, price: 560000, buildCost: 270000, blurb: "Across the water from the shipyard. Cheap, slow, honest. Your dad is retiling the bathroom for $150." },
};

export const TYPE_BLURB = (t: DeveloperType) => TYPE_START[t].blurb;
export const TOWN_BLURB = (t: Town) => TOWN[t].blurb;

/** Park–Miller. Tiny, and enough. */
export function rng(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function newGame(type: DeveloperType, town: Town, seed = Date.now() % 2147483647): DevState {
  const t = TYPE_START[type];
  return {
    type,
    town,
    month: 0,
    cash: t.cash,
    energy: t.energy,
    goodwill: t.goodwill,
    investors: 0,
    phase: 0,
    progress: 0,
    lots: Array.from({ length: LOTS }, () => 0 as LotStage),
    spent: 0,
    revenue: 0,
    log: [
      {
        month: 0,
        text: `${type} developer. Nine lots in ${town}. Thirty-six months on the option. ${t.blurb}`,
        kind: "note",
      },
    ],
    card: null,
    over: null,
    seed,
  };
}

function pickCard(state: DevState, rand: () => number): Card | null {
  const phase = PHASES[state.phase];
  const pool = CARDS.filter(
    (c) => (!c.phases || c.phases.includes(phase)) && (!c.towns || c.towns.includes(state.town)),
  );
  // No repeats of the last three cards, which is what makes a deck feel like a deck.
  const recent = new Set(state.log.filter((l) => l.kind === "card").slice(-3).map((l) => l.text.split("|")[0]));
  const fresh = pool.filter((c) => !recent.has(c.id));
  const list = fresh.length ? fresh : pool;
  const total = list.reduce((a, c) => a + c.weight, 0);
  let r = rand() * total;
  for (const c of list) {
    r -= c.weight;
    if (r <= 0) return c;
  }
  return list[list.length - 1] ?? null;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * One month. The pace is the whole decision: careful protects the body and
 * the neighbours, push gets the phase done. In Build and Sell the phase
 * progress is the lots themselves.
 */
export function step(prev: DevState, pace: Pace): DevState {
  if (prev.over) return prev;
  const s: DevState = { ...prev, lots: [...prev.lots], log: [...prev.log], card: null };
  const rand = rng(s.seed + s.month * 7919 + 1);
  const skill = TYPE_START[s.type].skill;
  const town = TOWN[s.town];
  s.month += 1;
  const say = (text: string, kind: LogEntry["kind"]) => s.log.push({ month: s.month, text, kind });

  const paceMul = pace === "push" ? 1.5 : pace === "careful" ? 0.7 : 1;
  const energyCost = pace === "push" ? 12 : pace === "careful" ? 0 : 3;
  const tiredMul = s.energy < 20 ? 0.6 : s.energy < 40 ? 0.85 : 1;
  const goodwillMul = s.goodwill < 30 ? 0.75 : s.goodwill > 70 ? 1.15 : 1;

  // Monthly overhead: you have to eat, and so does the option.
  const overhead = 6000 + (s.phase >= 5 ? 9000 : 0);
  s.cash -= overhead;
  s.spent += overhead;
  s.energy = clamp(s.energy - energyCost + (pace === "careful" ? 9 : 0), 0, 100);
  if (pace === "push") s.goodwill = clamp(s.goodwill - 1, 0, 100);
  if (pace === "careful") s.goodwill = clamp(s.goodwill + 1, 0, 100);

  const phase = PHASES[s.phase];
  let delay = 0;

  const trySell = (listings: number, chance: number) => {
    let sold = 0;
    for (let i = 0; i < s.lots.length && sold < listings; i++) {
      if (s.lots[i] !== 3) continue;
      // Push sells faster and cheaper. Goodwill is the town's word of mouth.
      const priceMul = (pace === "push" ? 0.93 : pace === "careful" ? 1.04 : 1) * (0.9 + s.goodwill / 500);
      if (rand() < chance * goodwillMul) {
        const price = Math.round(town.price * priceMul * (0.96 + rand() * 0.08));
        s.lots[i] = 4;
        s.cash += price;
        s.revenue += price;
        sold++;
        say(`Lot ${i + 1} sold for $${(price / 1000).toFixed(0)}k.`, "sell");
      }
    }
    if (s.lots.every((l) => l === 4)) {
      const profit = s.revenue - s.spent - town.land;
      s.over = {
        won: true,
        title: profit > 0 ? "Sold out" : "Sold out, at a loss",
        text:
          profit > 0
            ? `Nine cottages in ${s.month} months. $${(profit / 1000).toFixed(0)}k after the land, ${s.investors} investors paid back, and the town still talks to you (${s.goodwill}). Somebody should write the case study.`
            : `Nine cottages in ${s.month} months, and $${(-profit / 1000).toFixed(0)}k short after the land. Everybody got a home. You got a lesson, and a thirty-page case study.`,
      };
      say(s.over.title, "end");
    }
  };

  // The card.
  if (rand() < 0.55) {
    const card = pickCard(s, rand);
    if (card) {
      s.card = card;
      say(`${card.id}|${card.title}`, "card");
      if (card.cash) {
        s.cash += card.cash;
        if (card.cash < 0) s.spent -= card.cash;
      }
      if (card.energy) s.energy = clamp(s.energy + card.energy, 0, 100);
      if (card.goodwill) s.goodwill = clamp(s.goodwill + card.goodwill, 0, 100);
      if (card.progress) s.progress += card.progress;
      if (card.investors) s.investors += card.investors;
      if (card.delay) delay += card.delay;
    }
  }

  // The work.
  if (phase === "Build") {
    // Building costs money per stage per lot. Steady moves four stage-steps
    // a month across the site: nine lots, three stages each, about seven
    // months if the money holds.
    const steps = pace === "push" ? 7 : pace === "careful" ? 3 : 5;
    let moved = 0;
    for (let i = 0; i < s.lots.length && moved < steps; i++) {
      while (s.lots[i] < 3 && moved < steps) {
        const cost = town.buildCost / 3;
        if (s.cash < cost) {
          if (moved === 0) say("Not enough cash to pour the next foundation. The site sits.", "money");
          moved = steps;
          break;
        }
        if (delay > 0) {
          moved = steps;
          break;
        }
        s.cash -= cost;
        s.spent += cost;
        s.lots[i] = (s.lots[i] + 1) as LotStage;
        moved++;
        if (s.lots[i] === 3) say(`Lot ${i + 1} finished. ${s.lots.filter((l) => l >= 3).length} of nine.`, "build");
      }
    }
    // Pre-sales: a finished cottage can sell while the next one is framing,
    // and that is the only reason the cash lasts.
    trySell(pace === "push" ? 2 : 1, 0.6);
    if (s.lots.every((l) => l >= 3)) {
      s.phase += 1;
      s.progress = 0;
      say("All nine finished. Now somebody has to want them.", "phase");
    }
  } else if (phase === "Sell") {
    trySell(pace === "push" ? 4 : pace === "careful" ? 2 : 3, pace === "careful" ? 0.55 : pace === "push" ? 0.9 : 0.75);
  } else {
    // Path to Capital: progress points toward 100.
    const base =
      phase === "Foundation" || phase === "Gap Analysis"
        ? 46
        : phase === "Capital Raise"
          ? 28
          : phase === "Entitlement"
            ? 30
            : 38;
    const gain = delay > 0 ? 0 : base * paceMul * skill * tiredMul * goodwillMul * (0.85 + rand() * 0.3);
    s.progress += gain;
    // Capital Raise also brings money in as it progresses.
    if (phase === "Capital Raise" && gain > 0) {
      const raised = Math.round(gain * 9000 * (0.8 + s.goodwill / 200));
      s.cash += raised;
      s.investors += Math.round(gain / 12);
      say(`Raised $${(raised / 1000).toFixed(0)}k this month.`, "money");
    }
    if (s.progress >= 100) {
      s.progress = 0;
      s.phase += 1;
      const next = PHASES[s.phase];
      if (next === "Build") {
        s.cash -= town.land;
        s.spent += town.land;
        say(`Entitled. You close on the land: $${(town.land / 1000).toFixed(0)}k. The excavator arrives Monday.`, "phase");
      } else say(`${phase} done. Next: ${next}.`, "phase");
    }
  }

  if (delay > 0) {
    s.month += delay;
    s.cash -= overhead * delay;
    s.spent += overhead * delay;
    say(`${delay} month${delay > 1 ? "s" : ""} lost.`, "note");
  }

  // Endings.
  if (!s.over) {
    if (s.cash < -60000) {
      s.over = { won: false, title: "You have died of dysentery", text: "Kidding. You ran out of money, which is the same thing in this game. The bank has nine lots and you have a story." };
    } else if (s.energy <= 0) {
      s.over = { won: false, title: "Burnout", text: "The airplane took off without wings and this time you did not get them on. You stop answering the phone. Somebody else finishes the cottages." };
    } else if (s.goodwill <= 0) {
      s.over = { won: false, title: "The town said no", text: "Appeal after appeal. The planning commission tables it indefinitely. You should have gone to more potlucks." };
    } else if (s.month >= MONTHS) {
      s.over = { won: false, title: "The option expired", text: `Thirty-six months. The landowner sells to somebody with a bigger truck. You got as far as ${PHASES[s.phase]}.` };
    }
    if (s.over) say(s.over.title, "end");
  }

  return s;
}

/** What a phase is worth on the way to the finish, for a progress bar. */
export function overallProgress(s: DevState): number {
  if (s.over?.won) return 1;
  const phase = PHASES[s.phase];
  if (phase === "Build") return (5 + s.lots.filter((l) => l >= 3).length / LOTS) / 7;
  if (phase === "Sell") return (6 + s.lots.filter((l) => l === 4).length / LOTS) / 7;
  return (s.phase + s.progress / 100) / 7;
}

export const TOWNS: Town[] = ["Healdsburg", "Bend", "Bainbridge Island", "Port Orchard"];
export const TYPES: DeveloperType[] = ["Aspiring", "Emerging", "Developing", "Mature", "Supporting Cast"];
