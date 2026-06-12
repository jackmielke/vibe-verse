import type { Mutation, Traits } from "./types";

export const baseAnimal: Traits = {
  size: 1,
  defense: 0,
  heatResist: 0,
  coldResist: 0,
  speed: 4,
  sight: 8,
  carnivore: 0,
  leaves: 0,
  roots: 0,
  spread: 0,
  pack: 0,
  color: [0.85, 0.55, 0.25],
};

export const basePlant: Traits = {
  size: 1,
  defense: 0,
  heatResist: 0,
  coldResist: 0,
  speed: 0,
  sight: 0,
  carnivore: 0,
  leaves: 1,
  roots: 1,
  spread: 0,
  pack: 0,
  color: [0.35, 0.7, 0.35],
};

const tweak = (t: Traits, patch: Partial<Traits>): Traits => ({ ...t, ...patch });

export const MUTATIONS: Mutation[] = [
  // ===== Animal =====
  {
    id: "long-legs",
    name: "Long Legs",
    desc: "+50% movement speed.",
    kinds: ["animal"],
    apply: (t) => tweak(t, { speed: t.speed * 1.5 }),
  },
  {
    id: "keen-eyes",
    name: "Keen Eyes",
    desc: "+50% sight range.",
    kinds: ["animal"],
    apply: (t) => tweak(t, { sight: t.sight * 1.5 }),
  },
  {
    id: "fangs",
    name: "Fangs",
    desc: "Hunt prey & predators for huge energy.",
    kinds: ["animal"],
    apply: (t) => tweak(t, { carnivore: Math.min(1, t.carnivore + 0.5) }),
  },
  {
    id: "omnivore",
    name: "Omnivore Diet",
    desc: "Eat both plants and small creatures. Survive lean times.",
    kinds: ["animal"],
    apply: (t) => tweak(t, { carnivore: Math.max(0.4, Math.min(0.7, t.carnivore + 0.3)) }),
  },
  {
    id: "pack-bond",
    name: "Pack Bond",
    desc: "Your kind gathers around you. +1 ally per evolution.",
    kinds: ["animal"],
    apply: (t) => tweak(t, { pack: t.pack + 1 }),
  },
  {
    id: "fur",
    name: "Insulating Fur",
    desc: "Survive cold nights and forest chill.",
    kinds: ["animal"],
    apply: (t) => tweak(t, { coldResist: t.coldResist + 1 }),
  },
  // ===== Shared =====
  {
    id: "thick-hide",
    name: "Thick Hide",
    desc: "+1 armor. Predators must work harder.",
    kinds: ["animal", "plant"],
    apply: (t) => tweak(t, { defense: t.defense + 1 }),
  },
  {
    id: "scales",
    name: "Heat Scales",
    desc: "Thrive in desert heat.",
    kinds: ["animal", "plant"],
    apply: (t) => tweak(t, { heatResist: t.heatResist + 1 }),
  },
  {
    id: "bigger",
    name: "Larger Body",
    desc: "Grow bigger. More storage, slightly slower. Big things eat small things.",
    kinds: ["animal", "plant"],
    apply: (t) => tweak(t, { size: t.size * 1.25, speed: t.speed * 0.9 }),
  },
  // ===== Plant =====
  {
    id: "broad-leaves",
    name: "Broad Leaves",
    desc: "Photosynthesize faster during the day.",
    kinds: ["plant"],
    apply: (t) => tweak(t, { leaves: t.leaves + 1 }),
  },
  {
    id: "deep-roots",
    name: "Deep Roots",
    desc: "Draw more water and nutrients.",
    kinds: ["plant"],
    apply: (t) => tweak(t, { roots: t.roots + 1 }),
  },
  {
    id: "thorns",
    name: "Thorns",
    desc: "Damage herbivores that try to graze you.",
    kinds: ["plant"],
    apply: (t) => tweak(t, { defense: t.defense + 2 }),
  },
  {
    id: "seeds",
    name: "Seed Dispersal",
    desc: "Grazers carry your seeds instead of killing you. Less damage, spawns new food.",
    kinds: ["plant"],
    apply: (t) => tweak(t, { spread: t.spread + 1 }),
  },
  {
    id: "symbiosis",
    name: "Symbiosis",
    desc: "Spawn an allied sapling each evolve. Decoys for predators.",
    kinds: ["plant"],
    apply: (t) => tweak(t, { pack: t.pack + 1, spread: Math.max(1, t.spread) }),
  },
  // ===== Animal extras =====
  {
    id: "swift-reflexes",
    name: "Swift Reflexes",
    desc: "+25% speed and +20% sight. Predators struggle to catch you.",
    kinds: ["animal"],
    apply: (t) => tweak(t, { speed: t.speed * 1.25, sight: t.sight * 1.2 }),
  },
  {
    id: "venom",
    name: "Venom Glands",
    desc: "Stronger bite — predators die faster to your attacks.",
    kinds: ["animal"],
    apply: (t) => tweak(t, { carnivore: Math.min(1, t.carnivore + 0.3), defense: t.defense + 1 }),
  },
  {
    id: "camouflage",
    name: "Camouflage",
    desc: "Predators detect you later. Lower aggression range.",
    kinds: ["animal"],
    apply: (t) => tweak(t, { defense: t.defense + 1, sight: t.sight * 1.1 }),
  },
  {
    id: "echolocation",
    name: "Echolocation",
    desc: "Massive sight boost — hunt and flee from far away.",
    kinds: ["animal"],
    apply: (t) => tweak(t, { sight: t.sight * 2 }),
  },
  {
    id: "burrow",
    name: "Burrowing Claws",
    desc: "Find hidden roots & water. Bonus to cold survival.",
    kinds: ["animal"],
    apply: (t) => tweak(t, { coldResist: t.coldResist + 1, roots: t.roots + 1 }),
  },
  {
    id: "endurance",
    name: "Endurance",
    desc: "Slower metabolism — store more energy from each meal.",
    kinds: ["animal"],
    apply: (t) => tweak(t, { size: t.size * 1.1, defense: t.defense + 1 }),
  },
  {
    id: "warm-blood",
    name: "Warm Blood",
    desc: "Active day or night. Boost to cold resist.",
    kinds: ["animal"],
    apply: (t) => tweak(t, { coldResist: t.coldResist + 2 }),
  },
  // ===== Plant extras =====
  {
    id: "waxy-coat",
    name: "Waxy Coat",
    desc: "Retain water. Survive desert heat.",
    kinds: ["plant"],
    apply: (t) => tweak(t, { heatResist: t.heatResist + 2 }),
  },
  {
    id: "bark",
    name: "Hard Bark",
    desc: "+2 defense. Grazers bounce off.",
    kinds: ["plant"],
    apply: (t) => tweak(t, { defense: t.defense + 2 }),
  },
  {
    id: "fruit",
    name: "Sweet Fruit",
    desc: "Animals eagerly carry your seeds far and wide.",
    kinds: ["plant"],
    apply: (t) => tweak(t, { spread: t.spread + 2 }),
  },
  {
    id: "canopy",
    name: "Towering Canopy",
    desc: "Grow tall. More photosynthesis, more presence.",
    kinds: ["plant"],
    apply: (t) => tweak(t, { size: t.size * 1.3, leaves: t.leaves + 1 }),
  },
  {
    id: "nitrogen",
    name: "Nitrogen Fixing",
    desc: "Enrich soil. Roots & leaves both gain.",
    kinds: ["plant"],
    apply: (t) => tweak(t, { roots: t.roots + 1, leaves: t.leaves + 1 }),
  },
  {
    id: "poison",
    name: "Poison Berries",
    desc: "Discourage casual grazers. +1 defense, +1 spread.",
    kinds: ["plant"],
    apply: (t) => tweak(t, { defense: t.defense + 1, spread: t.spread + 1 }),
  },
  // ===== Shared extras =====
  {
    id: "metabolism",
    name: "Efficient Metabolism",
    desc: "Convert food more efficiently. Larger size cap.",
    kinds: ["animal", "plant"],
    apply: (t) => tweak(t, { size: t.size * 1.15, defense: t.defense + 1 }),
  },
  {
    id: "adaptive",
    name: "Adaptive Pigment",
    desc: "Survive temperature swings. +1 heat & cold.",
    kinds: ["animal", "plant"],
    apply: (t) => tweak(t, { heatResist: t.heatResist + 1, coldResist: t.coldResist + 1 }),
  },
  {
    id: "regen",
    name: "Regeneration",
    desc: "Heal over time. Effectively more defense.",
    kinds: ["animal", "plant"],
    apply: (t) => tweak(t, { defense: t.defense + 2 }),
  },
  {
    id: "vivid",
    name: "Vivid Coloration",
    desc: "Attract kin. Spawn extra allies on evolve.",
    kinds: ["animal", "plant"],
    apply: (t) => tweak(t, { pack: t.pack + 1 }),
  },
];

export function rollMutations(kind: "plant" | "animal", count = 3): Mutation[] {
  const pool = MUTATIONS.filter((m) => m.kinds.includes(kind));
  const out: Mutation[] = [];
  const used = new Set<string>();
  while (out.length < count && used.size < pool.length) {
    const m = pool[Math.floor(Math.random() * pool.length)];
    if (used.has(m.id)) continue;
    used.add(m.id);
    out.push(m);
  }
  return out;
}
