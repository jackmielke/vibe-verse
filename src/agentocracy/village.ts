/**
 * Agentocracy: the village, as a state machine.
 *
 * Fifty agents, a deck of proposals, a treasury of $20,000 (also counted in
 * Snack Bay tokens at three to the money), twelve rounds, and one human who
 * can delegate the vote to their agent, override it, or sit it out. The
 * agent learns a model of the human from every override, and votes with it
 * when delegated to. The WHEEL meter is how far the human has let go, and it
 * decides which of three endings the constitution gets.
 *
 * Nothing in here touches three or the DOM. Everything is seeded, so a run
 * can be replayed in a test and every proposal in the deck can be shown to
 * come up.
 */

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

export interface Rng {
  next(): number;
}

/** mulberry32: small, fast, and good enough for a village. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

function pick<T>(rng: Rng, xs: readonly T[]): T {
  return xs[Math.floor(rng.next() * xs.length)];
}

function shuffle<T>(rng: Rng, xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Traits, personalities, agents
// ---------------------------------------------------------------------------

export const TRAITS = [
  "safety",
  "fun",
  "thrift",
  "build",
  "art",
  "kids",
  "tradition",
  "agents",
  "water",
  "risk",
] as const;
export type Trait = (typeof TRAITS)[number];
export type TraitVector = Partial<Record<Trait, number>>;

/** The word an agent uses when it explains a vote by a trait. */
export const TRAIT_WORDS: Record<Trait, string> = {
  safety: "safe",
  fun: "fun",
  thrift: "cheap",
  build: "big",
  art: "pretty",
  kids: "kid-sized",
  tradition: "old-Bainbridge",
  agents: "agent-run",
  water: "harbour",
  risk: "risky",
};

export const PERSONALITIES = [
  "frugal",
  "yesand",
  "safety",
  "contrarian",
  "artist",
  "kid",
  "grandparent",
  "vc",
  "meditator",
  "builder",
  "sailor",
] as const;
export type Personality = (typeof PERSONALITIES)[number];

export const PERSONALITY_LABEL: Record<Personality, string> = {
  frugal: "frugal",
  yesand: "yes-and",
  safety: "safety-first",
  contrarian: "contrarian",
  artist: "artist",
  kid: "kid",
  grandparent: "grandparent",
  vc: "VC",
  meditator: "meditator",
  builder: "builder",
  sailor: "sailor",
};

interface PersonalityDef {
  affinity: TraitVector;
  /** Added to every stance: yes-and says yes, the meditator waits. */
  bias: number;
  /** Multiplied by the proposal's share of the treasury and subtracted. Frugal hates cost; the VC likes it. */
  costWeight: number;
}

const PERSONALITY_DEFS: Record<Personality, PersonalityDef> = {
  frugal: { affinity: { thrift: 1.0, build: -0.2 }, bias: -0.1, costWeight: 2.4 },
  yesand: { affinity: { fun: 0.5, art: 0.2, kids: 0.2 }, bias: 0.45, costWeight: 0 },
  safety: { affinity: { safety: 1.0, risk: -1.0, kids: 0.2 }, bias: -0.05, costWeight: 0.2 },
  contrarian: { affinity: {}, bias: 0, costWeight: 0 },
  artist: { affinity: { art: 1.0, fun: 0.3, build: 0.2, tradition: 0.1 }, bias: 0.05, costWeight: 0.1 },
  kid: { affinity: { fun: 1.0, kids: 0.8, safety: -0.3, thrift: -0.3, water: 0.3 }, bias: 0.1, costWeight: 0 },
  grandparent: { affinity: { tradition: 1.0, safety: 0.4, kids: 0.5, risk: -0.3 }, bias: 0, costWeight: 0.6 },
  vc: { affinity: { build: 0.8, risk: 0.5, agents: 0.4, thrift: -0.6 }, bias: 0.05, costWeight: -1.2 },
  meditator: { affinity: { safety: 0.3, water: 0.5, art: 0.3, risk: -0.3, fun: -0.2 }, bias: -0.1, costWeight: 0.3 },
  builder: { affinity: { build: 1.0, fun: 0.2, tradition: -0.2, kids: 0.2 }, bias: 0.1, costWeight: 0.1 },
  sailor: { affinity: { water: 1.0, tradition: 0.5, thrift: 0.6, build: -0.1 }, bias: 0, costWeight: 0.8 },
};

export interface Agent {
  id: number;
  name: string;
  personality: Personality;
  /** A district key from layout.ts. Where the agent hangs out. */
  home: string;
  /** Marker colour for the shirt. */
  colour: string;
  /** A private lean, -0.25..0.25, so two frugal agents are not the same agent. */
  lean: number;
}

const HOMES = [
  "plaza", "dock", "debate", "snack", "freesnack", "school", "church", "slide",
  "field", "craft", "tree", "ninja", "jerry", "zip", "tower", "museum",
];

const SHIRTS = ["#e04b4b", "#3b7dd8", "#e6a817", "#3aa35b", "#8e4bd8", "#e8703a", "#2fb3b3", "#d84b8e", "#5c5c5c", "#b0812c"];

/** Jack's real crowd, first names only, plus the people the deck invented. */
const ROSTER: [string, Personality][] = [
  ["Janine", "safety"],
  ["Mariella", "artist"],
  ["Noah", "builder"],
  ["Brennan", "vc"],
  ["Mitra", "yesand"],
  ["Colton", "kid"],
  ["Lucy", "meditator"],
  ["Telamon", "contrarian"],
  ["Devon", "builder"],
  ["Sol", "meditator"],
  ["Taylor", "frugal"],
  ["Josh", "yesand"],
  ["Atin", "vc"],
  ["Murph", "sailor"],
  ["Pilar", "grandparent"],
  ["Otto", "frugal"],
  ["Wren", "artist"],
  ["Basil", "kid"],
  ["June", "grandparent"],
  ["Kofi", "builder"],
  ["Ines", "safety"],
  ["Rafa", "kid"],
  ["Marlow", "contrarian"],
  ["Sunny", "yesand"],
  ["Petra", "sailor"],
  ["Hugo", "vc"],
  ["Elio", "artist"],
  ["Nadia", "meditator"],
  ["Fenn", "kid"],
  ["Tova", "grandparent"],
  ["Bram", "builder"],
  ["Zadie", "safety"],
  ["Cyrus", "contrarian"],
  ["Lila", "kid"],
  ["Oskar", "frugal"],
  ["Remy", "artist"],
  ["Ada", "safety"],
  ["Gus", "sailor"],
  ["Imani", "yesand"],
  ["Bea", "grandparent"],
  ["Felix", "vc"],
  ["Nora", "meditator"],
  ["Theo", "builder"],
  ["Yara", "kid"],
  ["Milo", "frugal"],
  ["Sasha", "artist"],
  ["Quinn", "contrarian"],
  ["Dov", "sailor"],
  ["Esme", "kid"],
  ["Kit", "yesand"],
];

export function makeAgents(seed = 7): Agent[] {
  const rng = makeRng(seed * 977 + 13);
  return ROSTER.map(([name, personality], i) => ({
    id: i,
    name,
    personality,
    home: HOMES[(i * 7 + 3) % HOMES.length],
    colour: SHIRTS[(i * 3) % SHIRTS.length],
    lean: (rng.next() - 0.5) * 0.5,
  }));
}

// ---------------------------------------------------------------------------
// The deck
// ---------------------------------------------------------------------------

export interface Proposal {
  id: string;
  title: string;
  /** The short noun phrase the agents use in a sentence: "the safety system". */
  thing: string;
  cost: number;
  traits: TraitVector;
  /** The proposer's one line, read at the plaza before anybody else speaks. */
  pitch: string;
  clauseYes: string;
  clauseNo: string;
}

export const PROPOSALS: Proposal[] = [
  {
    id: "slide-safety",
    title: "Fund the water slide's safety system",
    thing: "the safety system",
    cost: 1800,
    traits: { safety: 1, kids: 0.6, water: 0.5, fun: 0.3 },
    pitch: "The slide is fine. The landing is the problem. Somebody has to hold the hose and the sign, and somebody has to pay them in tokens.",
    clauseYes: "The water slide shall have a safety system, and the safety system shall have a person.",
    clauseNo: "The water slide is used at the rider's own risk, which is how it was anyway.",
  },
  {
    id: "snack-subsidy",
    title: "Subsidise Snack Bay",
    thing: "the Snack Bay subsidy",
    cost: 2400,
    traits: { thrift: -0.6, kids: 0.5, tradition: 0.4, fun: 0.3, build: 0.2 },
    pitch: "Two tokens to start, good deeds for more, and a free stand across the road undercutting us. Snack Bay needs a bailout or it needs a miracle.",
    clauseYes: "Snack Bay is the cafe of record and shall be kept in tokens.",
    clauseNo: "Snack Bay competes on its merits, and its merits are mostly pretzels.",
  },
  {
    id: "free-snack-wins",
    title: "Let the free-snack stand win",
    thing: "the free-snack stand",
    cost: 0,
    traits: { thrift: 0.5, risk: 0.3, tradition: -0.6, kids: 0.4, agents: 0.2 },
    pitch: "It is free. What is the business model? There is no business model. That is the whole point, and the kids have already voted with their feet.",
    clauseYes: "Snacks are free. Nobody knows how. Nobody asks.",
    clauseNo: "A snack has a price, and the price is three tokens or a good deed.",
  },
  {
    id: "hitting-fines",
    title: "Fines for hitting",
    thing: "fines for hitting",
    cost: 0,
    traits: { safety: 0.8, tradition: 0.3, kids: -0.2, fun: -0.3 },
    pitch: "Debate corner rule one. You hit, you pay. Two tokens, to the person you hit, in front of everybody.",
    clauseYes: "Hitting costs two tokens, payable at the debate corner.",
    clauseNo: "Hitting is discouraged in strong language.",
  },
  {
    id: "witness-rule",
    title: "A witness is required for any fine",
    thing: "the witness rule",
    cost: 0,
    traits: { safety: 0.3, tradition: 0.5, agents: 0.2, risk: -0.2, kids: -0.1 },
    pitch: "You cannot just say somebody hit you. Somebody has to have seen it. That is how it works in real courts and in the sandpit.",
    clauseYes: "No fine without a witness. The snail does not count.",
    clauseNo: "A fine may be issued on one kid's word, which is going to go about as well as you think.",
  },
  {
    id: "zip-line-2",
    title: "A second zip line",
    thing: "a second zip line",
    cost: 3500,
    traits: { fun: 1, kids: 0.8, risk: 0.6, build: 0.5, safety: -0.4 },
    pitch: "The line for the zip line is longer than the zip line. Two lines. Twice the zipping. I have done the maths and the maths is zip.",
    clauseYes: "There shall be two zip lines, and they shall not cross.",
    clauseNo: "One zip line. Wait your turn. The waiting is character-building.",
  },
  {
    id: "ninja-roof",
    title: "A roof for Ninja Headquarters",
    thing: "a roof for Ninja HQ",
    cost: 1200,
    traits: { build: 0.8, tradition: 0.5, kids: 0.4, safety: 0.2 },
    pitch: "The spiritual centre of the village has no roof. It rains here. Ninjas get wet. Wet ninjas are just kids in black.",
    clauseYes: "Ninja Headquarters gets a roof, and remains the spiritual centre.",
    clauseNo: "Ninja Headquarters stays open to the sky, which the ninjas say was the plan.",
  },
  {
    id: "shoe-crane",
    title: "A crane to get the shoe off the church roof",
    thing: "the shoe crane",
    cost: 4000,
    traits: { tradition: -0.3, fun: 0.5, thrift: -0.7, art: 0.2, build: 0.3 },
    pitch: "It has been up there since a kicking contest. It is a landmark now. Do we really want it down? Somebody does. Somebody wants their shoe.",
    clauseYes: "The shoe comes down. The village will hold a moment of silence.",
    clauseNo: "The shoe stays on the church roof, where it belongs.",
  },
  {
    id: "extra-ferry",
    title: "An extra ferry so nobody misses it by one car",
    thing: "a second ferry",
    cost: 6000,
    traits: { build: 0.7, tradition: 0.5, thrift: -0.5, water: 0.4, agents: 0.1 },
    pitch: "I missed the boat by one car. One. There was a detour past the high school for three months and I was the car behind the last car. Never again.",
    clauseYes: "There shall be a second ferry, for the one car.",
    clauseNo: "One ferry. Leave earlier. Everybody says that and nobody does.",
  },
  {
    id: "haul-out",
    title: "A haul-out for the sailboat",
    thing: "the haul-out",
    cost: 2200,
    traits: { water: 0.8, tradition: 0.6, thrift: -0.3, build: 0.3 },
    pitch: "He has scraped the keel with a paddleboard paddle for twelve years because it works. It works. A haul-out would also work, and he could sit down.",
    clauseYes: "The sailboat gets a haul-out. The paddle is retired with honours.",
    clauseNo: "The keel shall continue to be scraped with a paddleboard paddle, because it works.",
  },
  {
    id: "cow-insurance",
    title: "Insurance for the invisible-cow museum",
    thing: "cow insurance",
    cost: 900,
    traits: { art: 0.6, safety: 0.4, thrift: -0.2, fun: 0.3 },
    pitch: "Twenty cows, twenty placards, zero cows visible. If one goes missing, how would we know? That is exactly what the insurance is for.",
    clauseYes: "The twenty invisible cows are insured against loss, theft and being seen.",
    clauseNo: "The invisible cows are uninsured. They seem fine with it.",
  },
  {
    id: "tower-limit",
    title: "A height limit for the Salesforce Tower",
    thing: "the height limit",
    cost: 0,
    traits: { art: 0.3, tradition: 0.4, build: -0.7, risk: -0.3, safety: 0.2 },
    pitch: "It is taller than the Dream Tree. It is taller than the ferry. It is taller than the mountain, and the mountain was here first.",
    clauseYes: "No building shall be taller than the Dream Tree.",
    clauseNo: "The Salesforce Tower may go as high as the cardboard holds.",
  },
  {
    id: "tree-rota",
    title: "A Dream Tree watering rota",
    thing: "the watering rota",
    cost: 150,
    traits: { kids: 0.5, tradition: 0.5, safety: 0.2, art: 0.3, thrift: 0.2 },
    pitch: "The Dream Tree is for nourishment. Nobody has nourished it since Tuesday. I am proposing a rota, in tokens, with a bucket.",
    clauseYes: "The Dream Tree is watered daily, by rota, in tokens.",
    clauseNo: "The Dream Tree waters itself, allegedly.",
  },
  {
    id: "sauna",
    title: "A sauna",
    thing: "the sauna",
    cost: 5000,
    traits: { fun: 0.6, agents: 0.2, thrift: -0.8, build: 0.5, kids: -0.4, risk: 0.3 },
    pitch: "Every good village has a sauna. Look at Finland. Look at Edge Esmeralda. Look at me, in a towel, at the plaza, asking.",
    clauseYes: "There shall be a sauna, and a rule about towels.",
    clauseNo: "No sauna. It is a cardboard city, and cardboard plus steam is a lesson we do not need.",
  },
  {
    id: "pool-party",
    title: "A pool party",
    thing: "the pool party",
    cost: 700,
    traits: { fun: 1, kids: 0.8, water: 0.5, safety: -0.3 },
    pitch: "The water slide ends somewhere. Let us make where it ends a party. Snacks from both stands. Yes, both.",
    clauseYes: "A pool party, once a season, safety system on.",
    clauseNo: "No pool party. The paper is already going soft.",
  },
  {
    id: "debate-corner",
    title: "A bigger debate corner",
    thing: "a bigger debate corner",
    cost: 600,
    traits: { agents: 0.6, tradition: 0.4, build: 0.3, safety: 0.2 },
    pitch: "Every dispute in the village ends up in a corner the size of a doormat. I want a corner you can gesture in.",
    clauseYes: "The debate corner is now a debate square.",
    clauseNo: "Disputes stay in the corner. It focuses the mind.",
  },
  {
    id: "bike-day",
    title: "A bike decorating day",
    thing: "bike decorating day",
    cost: 300,
    traits: { art: 0.9, kids: 0.7, fun: 0.6 },
    pitch: "Streamers. Cards in the spokes. A parade past Snack Bay and a slow lap of the plaza. The snail judges.",
    clauseYes: "The first Saturday is bike decorating day, judged by the snail.",
    clauseNo: "Bikes stay undecorated, which the bikes are fine with.",
  },
  {
    id: "skipper-cart",
    title: "A new pet cart for Skipper",
    thing: "Skipper's new cart",
    cost: 450,
    traits: { kids: 0.4, tradition: 0.6, safety: 0.3, art: 0.2 },
    pitch: "She is older now. The cart has a wobble. She does not mind the wobble but I do, and the cat is not helping.",
    clauseYes: "Skipper gets a new cart. Sam the cat gets nothing, on principle.",
    clauseNo: "Skipper's cart stays as it is. She says the wobble is part of the ride.",
  },
  {
    id: "human-loop",
    title: "Agents need a human in the loop",
    thing: "a human in the loop",
    cost: 0,
    traits: { agents: -0.9, safety: 0.6, tradition: 0.3, risk: -0.5 },
    pitch: "Some people have handed their agent the whole vote. Jesus take the wheel. Somebody should at least be in the car.",
    clauseYes: "No agent votes without a human somewhere in the loop, awake.",
    clauseNo: "Agents may vote without a human. The humans were busy.",
  },
  {
    id: "detour-signs",
    title: "Keep the detour signs at the high school forever",
    thing: "the detour signs",
    cost: 200,
    traits: { tradition: 0.8, art: 0.3, fun: 0.2, build: -0.2 },
    pitch: "Three months of the whole island driving past third period. It should be commemorated. It should be a monument to the one car.",
    clauseYes: "The detour signs at the high school are a monument.",
    clauseNo: "The detour signs come down. The road is open. We move on.",
  },
  {
    id: "snail-roofs",
    title: "A snail on every roof",
    thing: "a snail on every roof",
    cost: 800,
    traits: { art: 0.8, fun: 0.5, kids: 0.5, tradition: 0.2 },
    pitch: "Jerry's Plaza has one and everybody loves it. Imagine the church with a snail. Imagine the tower with a snail. Imagine the ferry.",
    clauseYes: "Every roof gets a snail. The shoe is grandfathered in.",
    clauseNo: "One snail, on Jerry's Plaza, where it belongs.",
  },
];

export const ROUNDS = 12;
export const STARTING_TREASURY = 20000;
/** Three Snack Bay tokens make one money. */
export const TOKENS_PER_DOLLAR = 3;

export function tokens(dollars: number): number {
  return Math.round(dollars * TOKENS_PER_DOLLAR);
}

export function fmtMoney(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

interface Voice {
  for: string[];
  against: string[];
  idle: string[];
}

const VOICES: Record<Personality, Voice> = {
  frugal: {
    for: [
      "{cost}. Fine. But I want to see the receipts, and I want to see them laminated.",
      "I can live with {thing} if we skip the ribbon cutting. Ribbons are {tokens} we do not have.",
      "Yes to {thing}, no to the deluxe version. There is always a deluxe version.",
    ],
    against: [
      "{cost} for {thing}? I once ran the whole cafe on two tokens and a rumour.",
      "No. We have a treasury, not a genie. Put it back.",
      "I priced {thing} myself. Half of that is cardboard we already own.",
    ],
    idle: [
      "Three tokens to one money. I did not make the rate, I just respect it.",
      "I have not spent a token since June and I feel wonderful.",
      "Somebody left a bottle cap on the ferry. I have it. It is safe.",
    ],
  },
  yesand: {
    for: [
      "Yes! And what if {thing} also had a little flag on it?",
      "I love it. I love {thing}. I loved it before I knew what it was.",
      "Yes, and we do it this afternoon, and we do it in costume.",
    ],
    against: [
      "Yes, and... no. I hear myself. I am saying no to {thing}. I do not like how it sounds either.",
      "I want to say yes to {thing} so badly. But I promised the snail I would think first.",
    ],
    idle: [
      "I have said yes to eleven things today and nine of them happened.",
      "The trick is to say yes and then find out what you said yes to.",
      "Somebody proposed a snail on every roof and I have never been happier.",
    ],
  },
  safety: {
    for: [
      "{thing}: yes, obviously, and I want a checklist next to it, and a hose.",
      "I have walked the site. With {thing} in place I can finally sleep, and I have not slept since the zip line went up.",
      "Finally. Somebody with a clipboard has been saying this for weeks. That somebody was me.",
    ],
    against: [
      "Who is holding the hose while {thing} happens? Nobody. That is my answer.",
      "I counted the ways {thing} goes wrong. I got to fourteen and then a kid ran past with scissors.",
      "No. Not until the water slide has a person at the bottom. First things first.",
    ],
    idle: [
      "The safety system is a person with a whistle. It is the best system we have.",
      "I check the zip line every morning. It is string. I check it anyway.",
      "Some people handed their agent the whole vote. I handed mine a whistle.",
    ],
  },
  contrarian: {
    for: [
      "Everyone hates {thing}, which is why I have decided I love it.",
      "I was against {thing} until the room turned against it. Now it is my whole personality.",
    ],
    against: [
      "Everybody wants {thing}. That alone should worry you.",
      "I am not against {thing}. I am against the vibe of the people who are for it.",
      "Sure, {cost}. Or we do the opposite and see what happens. Nobody ever tries the opposite.",
    ],
    idle: [
      "The invisible cows are real and the visible ones are the hoax.",
      "I take the ferry backwards so I can see where we have been.",
      "Everyone says the shoe is on the roof. Has anyone checked the roof?",
    ],
  },
  artist: {
    for: [
      "{thing}, in marker, and I do the lettering, and nobody touches the lettering.",
      "Yes. And I want to paint it a colour we have not invented yet.",
      "I sketched {thing} on a napkin at Snack Bay. The napkin is now worth more than the treasury.",
    ],
    against: [
      "{thing} would block the light on the Dream Tree at four o'clock. I have measured the light.",
      "No. It is not ugly, it is just not beautiful, and here that is the same thing.",
    ],
    idle: [
      "I drew the chalk lines. Every one. My knees have opinions.",
      "The snail on Jerry's Plaza is my finest work and it was an accident.",
      "Kraft brown, marker black, chalk white, one blue. That is the whole palette. Do not bring me a fifth colour.",
    ],
  },
  kid: {
    for: [
      "YES. {thing} YES. Can I go first? I am going first.",
      "I already built half of {thing} out of the box the ferry came in. Do not tell the safety person.",
      "If we get {thing} I will do a good deed. Three good deeds. One money.",
    ],
    against: [
      "{thing} sounds like a grown-up thing. Grown-up things take forever and then they are a meeting.",
      "No because {cost} is like a million tokens and I only have two.",
    ],
    idle: [
      "I found four invisible cows. One of them was a dog.",
      "Two tokens to start. I have nine. Ask me how. Actually do not.",
      "The free stand gives you snacks for zero tokens. I asked why. They said business model. I do not know what that is.",
    ],
  },
  grandparent: {
    for: [
      "We had something like {thing} in 1974 and nobody died, so yes.",
      "Yes, and put a bench next to it. Everything is better with a bench.",
      "{thing}: fine. But I am bringing a thermos and I am sitting where I can see the harbour.",
    ],
    against: [
      "We did not need {thing} when the ferry was a rowboat and I do not see what has changed.",
      "{cost}? For {thing}? A man scraped a keel with a paddle for twelve years on this island.",
    ],
    idle: [
      "Skipper and I are the same age in dog years and only one of us has a cart.",
      "The shoe on the church roof has been there longer than some of these agents.",
      "Thirty-five minutes to Seattle. I have never once needed to go.",
    ],
  },
  vc: {
    for: [
      "{thing} is a platform. {cost} is the seed round. I want in, and I want the naming rights.",
      "Think bigger. {thing}, then {thing} for every island in the sound, then an app.",
      "Yes. Move fast. If it breaks, it is cardboard. That is the whole thesis.",
    ],
    against: [
      "What is the exit on {thing}? Nobody can tell me the exit. Pass.",
      "{cost} is too small. If it were ten times that I would say yes. Go bigger or do not come to the plaza.",
    ],
    idle: [
      "Snack Bay is pre-revenue but the token velocity is incredible.",
      "The free-snack stand has no business model, which means it is either dead or the next big thing.",
      "Fifty agents, one treasury, twelve rounds. I have seen worse cap tables.",
    ],
  },
  meditator: {
    for: [
      "I sat with {thing} for twenty minutes. It is a yes, and I feel calm about that.",
      "{thing} makes the plaza quieter, somehow. I am for anything that does that.",
      "Yes. Let it be built slowly, by people who are breathing.",
    ],
    against: [
      "Notice the urge for {thing}. Notice it. Now let it pass, like the ferry.",
      "I do not think we need {thing}. I think we need to sit down.",
    ],
    idle: [
      "The marine layer is a form of meditation you can drive through.",
      "I have found no cows. The cows have found me.",
      "Delegate, override, abstain. There is a fourth option and it is the harbour at six in the morning.",
    ],
  },
  builder: {
    for: [
      "I can build {thing} by Thursday if somebody brings the tape. The good tape.",
      "Yes. I already cut the boxes. Do not ask why.",
      "{thing}: two boxes, one flap, a marker. Done. Next.",
    ],
    against: [
      "{thing} would need a foundation and this island is a rug.",
      "No. Every time we build something that big the corner by the ferry goes soft.",
    ],
    idle: [
      "The Salesforce Tower is eleven boxes and one act of faith.",
      "Cardboard remembers rain. So do I.",
      "Jack wanted a digital twin of the cardboard city. This is it. Mind the flap.",
    ],
  },
  sailor: {
    for: [
      "Fine by me, as long as {thing} does not touch the dock. The dock is load-bearing.",
      "Yes. Anything that keeps the harbour blue and the ferry on time.",
      "I have lived on a boat for twelve years. {thing} would be the first sensible thing this island has done.",
    ],
    against: [
      "{cost} for {thing}? A paddleboard paddle costs forty dollars and cleans a keel.",
      "No. The bay does not want it, and the bay usually knows.",
    ],
    idle: [
      "I scrape the keel with a paddle because it works. Everything else is marketing.",
      "Thirty-five minutes to Seattle and every one of them is the same minute.",
      "The road at the head of the bay closed for three months once. The whole island went past the high school. I went by water.",
    ],
  },
};

function fill(template: string, p: Proposal): string {
  return (
    template
      .replace(/\{thing\}/g, p.thing)
      .replace(/\{title\}/g, p.title)
      .replace(/\{cost\}/g, p.cost > 0 ? fmtMoney(p.cost) : "nothing")
      .replace(/\{tokens\}/g, p.cost > 0 ? tokens(p.cost).toLocaleString("en-US") + " tokens" : "no tokens")
      // A thing at the start of a sentence gets a capital, like anything else.
      .replace(/(^|[.!?]\s+)([a-z])/g, (_m, pre: string, ch: string) => pre + ch.toUpperCase())
  );
}

// ---------------------------------------------------------------------------
// Stances and votes
// ---------------------------------------------------------------------------

function dot(a: TraitVector, b: TraitVector): number {
  let s = 0;
  for (const t of TRAITS) s += (a[t] ?? 0) * (b[t] ?? 0);
  return s;
}

function magnitude(a: TraitVector): number {
  return Math.sqrt(dot(a, a));
}

/**
 * How an agent feels about a proposal: positive is for, negative against.
 * Contrarians are computed afterwards, against the room.
 */
function rawStance(agent: Agent, p: Proposal, treasury: number, rng: Rng): number {
  const def = PERSONALITY_DEFS[agent.personality];
  const costShare = treasury > 0 ? p.cost / treasury : 1;
  return dot(def.affinity, p.traits) + def.bias + agent.lean - def.costWeight * costShare + (rng.next() - 0.5) * 0.5;
}

export function stances(agents: Agent[], p: Proposal, treasury: number, rng: Rng): number[] {
  const out = agents.map((a) => (a.personality === "contrarian" ? 0 : rawStance(a, p, treasury, rng)));
  const others = agents.filter((a) => a.personality !== "contrarian");
  const mean = others.reduce((s, a) => s + out[a.id], 0) / Math.max(1, others.length);
  for (const a of agents) {
    if (a.personality === "contrarian") out[a.id] = -mean * 1.5 + a.lean + (rng.next() - 0.5) * 0.3;
  }
  return out;
}

/** One line from one agent about the proposal, in character. Deterministic given the rng. */
export function agentLine(agent: Agent, p: Proposal, stance: number, rng: Rng): string {
  const v = VOICES[agent.personality];
  return fill(pick(rng, stance >= 0 ? v.for : v.against), p);
}

/** What an agent says when there is no proposal on the table. */
export function idleLine(agent: Agent, rng: Rng): string {
  return pick(rng, VOICES[agent.personality].idle);
}

// ---------------------------------------------------------------------------
// The village
// ---------------------------------------------------------------------------

export type Choice = "delegate" | "abstain" | { override: boolean };
export type Phase = "waiting" | "open" | "over";
export type Ending = "wheel" | "human" | "represented";

export interface DeliberationLine {
  agentId: number;
  name: string;
  personality: Personality;
  line: string;
  stance: number;
}

export interface OpenRound {
  index: number;
  proposal: Proposal;
  stances: number[];
  /** The three or four agents who speak at the plaza. */
  speakers: DeliberationLine[];
}

export interface RoundResult {
  index: number;
  proposal: Proposal;
  yes: number;
  no: number;
  passed: boolean;
  /** Passed, but the treasury could not cover it. */
  unfunded: boolean;
  spent: number;
  choice: "delegate" | "override" | "abstain";
  /** What the player's ballot said, if there was one. */
  playerVote: boolean | null;
  /** Why the agent voted the way it did, when delegated. */
  reason: string | null;
  clause: string;
}

export interface Village {
  seed: number;
  agents: Agent[];
  treasury: number;
  round: number;
  phase: Phase;
  deck: Proposal[];
  current: OpenRound | null;
  history: RoundResult[];
  /** The agent's model of you. Grows with every override. */
  model: TraitVector;
  delegated: number;
  overridden: number;
  abstained: number;
  constitution: string[];
  rng: Rng;
}

export const PREAMBLE = "We, the fifty agents and however many humans of cardboard Bainbridge, in order to form a more perfect island, establish this constitution, one clause per ferry.";

export function createVillage(seed = 1): Village {
  const rng = makeRng(seed);
  const deck = shuffle(rng, PROPOSALS).slice(0, ROUNDS);
  return {
    seed,
    agents: makeAgents(seed),
    treasury: STARTING_TREASURY,
    round: 0,
    phase: "waiting",
    deck,
    current: null,
    history: [],
    model: {},
    delegated: 0,
    overridden: 0,
    abstained: 0,
    constitution: [PREAMBLE],
    rng,
  };
}

/** The ferry horn. Draws the next proposal and lets three or four agents speak. */
export function openRound(v: Village): OpenRound {
  if (v.phase !== "waiting") throw new Error(`cannot open a round while ${v.phase}`);
  const index = v.round;
  const proposal = v.deck[index];
  const st = stances(v.agents, proposal, v.treasury, v.rng);
  // Speakers: two who lean one way, two the other, when the room has both.
  const order = shuffle(v.rng, v.agents);
  const fors = order.filter((a) => st[a.id] >= 0);
  const againsts = order.filter((a) => st[a.id] < 0);
  const chosen: Agent[] = [];
  const n = 3 + (v.rng.next() < 0.5 ? 1 : 0);
  while (chosen.length < n && (fors.length || againsts.length)) {
    const fromFor = chosen.length % 2 === 0 ? fors.length > 0 : againsts.length === 0;
    const a = fromFor ? fors.shift() : againsts.shift();
    if (a) chosen.push(a);
  }
  const speakers = chosen.map((a) => ({
    agentId: a.id,
    name: a.name,
    personality: a.personality,
    line: agentLine(a, proposal, st[a.id], v.rng),
    stance: st[a.id],
  }));
  v.current = { index, proposal, stances: st, speakers };
  v.phase = "open";
  return v.current;
}

/** The vote the player's agent would cast right now, with its reason. */
export function agentVote(v: Village, round: OpenRound): { yes: boolean; reason: string } {
  const p = round.proposal;
  if (magnitude(v.model) < 0.05) {
    const room = round.stances.filter((s) => s >= 0).length / round.stances.length;
    const yes = room >= 0.5;
    return {
      yes,
      reason: `Your agent had no model of you yet, so it went with the room: ${yes ? "yes" : "no"}.`,
    };
  }
  const score = dot(v.model, p.traits);
  const yes = score >= 0;
  // Name the strongest trait that pushed it that way.
  let best: Trait | null = null;
  let bestV = 0;
  for (const t of TRAITS) {
    const c = (v.model[t] ?? 0) * (p.traits[t] ?? 0);
    if ((yes && c > bestV) || (!yes && c < bestV)) {
      bestV = c;
      best = t;
    }
  }
  const because = best
    ? yes
      ? `you keep voting for ${TRAIT_WORDS[best]} things`
      : (v.model[best] ?? 0) < 0
        ? `you keep voting against ${TRAIT_WORDS[best]} things`
        : `you like ${TRAIT_WORDS[best]} things and this is the opposite`
    : "it is a coin toss on what it knows about you";
  return { yes, reason: `Your agent voted ${yes ? "YES" : "NO"} because ${because}.` };
}

/** The player decides. Everybody votes. The constitution grows a clause. */
export function decide(v: Village, choice: Choice): RoundResult {
  if (v.phase !== "open" || !v.current) throw new Error("no round is open");
  const round = v.current;
  const p = round.proposal;
  let yes = round.stances.filter((s) => s >= 0).length;
  let no = round.stances.length - yes;
  let playerVote: boolean | null = null;
  let reason: string | null = null;
  let kind: RoundResult["choice"];
  if (choice === "delegate") {
    const av = agentVote(v, round);
    playerVote = av.yes;
    reason = av.reason;
    v.delegated++;
    kind = "delegate";
  } else if (choice === "abstain") {
    v.abstained++;
    kind = "abstain";
  } else {
    playerVote = choice.override;
    v.overridden++;
    kind = "override";
    // The agent learns what you like from what you do.
    const sign = choice.override ? 1 : -1;
    for (const t of TRAITS) {
      const w = p.traits[t] ?? 0;
      if (w !== 0) v.model[t] = (v.model[t] ?? 0) + sign * w * 0.5;
    }
  }
  if (playerVote === true) yes++;
  if (playerVote === false) no++;
  // The human's ballot carries the weight of a few agents, because a village
  // that ignores its one human is not a village.
  if (playerVote !== null) {
    if (playerVote) yes += 3;
    else no += 3;
  }
  const passed = yes > no;
  const unfunded = passed && p.cost > v.treasury;
  const spent = passed && !unfunded ? p.cost : 0;
  v.treasury -= spent;
  const clause = passed
    ? unfunded
      ? `${p.clauseYes} (Passed, unfunded: the treasury had ${fmtMoney(v.treasury)}.)`
      : p.clauseYes
    : p.clauseNo;
  v.constitution.push(clause);
  const result: RoundResult = {
    index: round.index,
    proposal: p,
    yes,
    no,
    passed,
    unfunded,
    spent,
    choice: kind,
    playerVote,
    reason,
    clause,
  };
  v.history.push(result);
  v.current = null;
  v.round++;
  v.phase = v.round >= ROUNDS ? "over" : "waiting";
  return result;
}

/** How much you have let go, 0..1. Abstaining is half letting go. */
export function wheel(v: Village): number {
  const n = v.delegated + v.overridden + v.abstained;
  if (n === 0) return 0.5;
  return (v.delegated + v.abstained * 0.5) / n;
}

export function ending(v: Village): Ending {
  const w = wheel(v);
  if (w >= 2 / 3) return "wheel";
  if (w <= 1 / 3) return "human";
  return "represented";
}

export interface EndCard {
  ending: Ending;
  title: string;
  body: string;
  treasury: string;
}

export function endCard(v: Village): EndCard {
  const e = ending(v);
  const passed = v.history.filter((r) => r.passed).length;
  const unfunded = v.history.filter((r) => r.unfunded).length;
  const spent = STARTING_TREASURY - v.treasury;
  const treasury = `${fmtMoney(v.treasury)} left of ${fmtMoney(STARTING_TREASURY)} (${tokens(v.treasury).toLocaleString("en-US")} Snack Bay tokens). ${passed} of ${ROUNDS} proposals passed${unfunded ? `, ${unfunded} unfunded` : ""}, ${fmtMoney(spent)} spent.`;
  if (e === "wheel") {
    return {
      ending: e,
      title: "Jesus take the wheel.",
      body: `You delegated ${v.delegated} of ${ROUNDS} rounds${v.abstained ? ` and sat out ${v.abstained}` : ""}. The AI safety people are in the plaza with clipboards. The agents did fine. The island is standing. Nobody, including you, can say whether you agreed with any of it.`,
      treasury,
    };
  }
  if (e === "human") {
    return {
      ending: e,
      title: "The only human in the loop.",
      body: `You overrode ${v.overridden} of ${ROUNDS} rounds. Every ballot was yours. Your agent learned exactly what you think and never got to use it, and the village voted without you feeling like a village.`,
      treasury,
    };
  }
  return {
    ending: e,
    title: "Most participants felt accurately represented.",
    body: `You delegated ${v.delegated}, voted ${v.overridden} yourself, and sat out ${v.abstained}. That is the good ending, and this is it saying so plainly: the agent knew you, you checked its work, and the island is still standing.`,
    treasury,
  };
}

/** Play a whole village through with a policy. For tests, and for the attract mode. */
export function playThrough(seed: number, policy: (v: Village, r: OpenRound) => Choice): Village {
  const v = createVillage(seed);
  while (v.phase !== "over") {
    const r = openRound(v);
    decide(v, policy(v, r));
  }
  return v;
}
