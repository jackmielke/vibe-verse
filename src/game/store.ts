import { create } from "zustand";
import type { Ally, Biome, FoodItem, Kind, Mode, Mutation, Npc, NpcKind, Species, Traits } from "./types";
import { baseAnimal, basePlant, rollMutations } from "./mutations";
import { randIslandPos } from "./island";

export function speciesToKind(s: Species): Kind {
  return s === "sapling" ? "plant" : "animal";
}

export function speciesStartingTraits(s: Species): Traits {
  if (s === "sapling") return { ...basePlant };
  const base = { ...baseAnimal };
  switch (s) {
    case "stalker":
      return { ...base, size: 1.1, speed: 5.2, sight: 10, carnivore: 1, defense: 1, color: [0.45, 0.4, 0.38] };
    case "grizzly":
      return { ...base, size: 1.8, speed: 4.2, sight: 9, carnivore: 0.9, defense: 4, color: [0.35, 0.22, 0.15] };
    case "fawn":
      return { ...base, size: 0.7, speed: 5.5, sight: 9, carnivore: 0, defense: 0, color: [0.75, 0.55, 0.35] };
    case "dragon":
      return { ...base, size: 1.6, speed: 4.8, sight: 11, carnivore: 1, defense: 3, heatResist: 1, color: [0.55, 0.25, 0.2] };
    case "goat":
      return { ...base, size: 0.9, speed: 4.6, sight: 8, carnivore: 0, defense: 2, coldResist: 1, color: [0.85, 0.82, 0.78] };
    case "armored":
      return { ...base, size: 1.3, defense: 4, coldResist: 1, color: [0.45, 0.5, 0.6] };
    case "fanged":
      return { ...base, size: 1.1, carnivore: 1, color: [0.55, 0.25, 0.25] };
    case "otter":
      return { ...base, size: 0.8, speed: 5.0, sight: 8, carnivore: 0.6, defense: 1, color: [0.42, 0.28, 0.2] };
    case "forager":
    default:
      return base;
  }
}

const WORLD = 110;

function biomeAt(x: number, _z: number): Biome {
  if (x < -WORLD / 6) return "forest";
  if (x > WORLD / 6) return "desert";
  return "grassland";
}

function randPos(): [number, number, number] {
  return randIslandPos(5);
}

function spawnFood(count: number): FoodItem[] {
  const items: FoodItem[] = [];
  for (let i = 0; i < count; i++) {
    const pos = randPos();
    const b = biomeAt(pos[0], pos[2]);
    let type: FoodItem["type"];
    let value: number;
    const r = Math.random();
    if (b === "grassland") {
      type = r < 0.6 ? "berry" : r < 0.85 ? "seed" : "prey";
      value = type === "prey" ? 30 : type === "berry" ? 15 : 10;
    } else if (b === "forest") {
      type = r < 0.5 ? "berry" : r < 0.8 ? "nutrient" : "prey";
      value = type === "prey" ? 35 : type === "berry" ? 18 : 12;
    } else {
      type = r < 0.4 ? "water" : r < 0.8 ? "seed" : "prey";
      value = type === "water" ? 20 : type === "seed" ? 8 : 25;
    }
    items.push({ id: `f${i}-${Math.random().toString(36).slice(2, 7)}`, pos, type, value, alive: true });
  }
  return items;
}

function makeNpc(kind: NpcKind): Npc {
  const size = kind === "apex" ? 1.8 : kind === "herbivore" ? 0.7 : 1;
  const hp = kind === "apex" ? 6 : kind === "predator" ? 2 : 1;
  return {
    id: `n-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    pos: randPos(),
    vel: [0, 0],
    hp,
    alive: true,
    size,
  };
}

function spawnNpcs(playerKind: Kind): Npc[] {
  const out: Npc[] = [];
  const preds = playerKind === "plant" ? 4 : 6;
  const apex = 1;
  const herb = playerKind === "plant" ? 10 : 8;
  for (let i = 0; i < preds; i++) out.push(makeNpc("predator"));
  for (let i = 0; i < apex; i++) out.push(makeNpc("apex"));
  for (let i = 0; i < herb; i++) out.push(makeNpc("herbivore"));
  return out;
}

function makeAlly(near: [number, number, number]): Ally {
  const a = Math.random() * Math.PI * 2;
  const r = 2 + Math.random() * 3;
  return {
    id: `a-${Math.random().toString(36).slice(2, 8)}`,
    pos: [near[0] + Math.cos(a) * r, 0, near[2] + Math.sin(a) * r],
    vel: [0, 0],
    alive: true,
    hp: 3,
  };
}

interface GameState {
  openEvolve: () => void;
  mode: Mode;
  kind: Kind;
  traits: Traits;
  energy: number;
  biomass: number;
  biomassNeeded: number;
  generation: number;
  pos: [number, number, number];
  food: FoodItem[];
  npcs: Npc[];
  allies: Ally[];
  timeOfDay: number;
  mutations: Mutation[];
  message: string;
  worldSize: number;

  species: Species;
  start: (kind: Kind, biome: Biome, species?: Species) => void;
  setPos: (pos: [number, number, number]) => void;
  consume: (foodId: string) => void;
  killNpc: (id: string) => void;
  eatNpc: (id: string) => void;
  damage: (amount: number) => void;
  damageAlly: (id: string, amount: number) => void;
  addEnergy: (amount: number) => void;
  spawnSeedFood: (pos: [number, number, number]) => void;
  tick: (dt: number) => void;
  chooseMutation: (m: Mutation) => void;
  reset: () => void;
}

export const useGame = create<GameState>((set, get) => ({
  mode: "menu",
  kind: "animal",
  species: "forager",
  traits: baseAnimal,
  energy: 100,
  biomass: 0,
  biomassNeeded: 50,
  generation: 1,
  pos: [0, 0, 0],
  food: [],
  npcs: [],
  allies: [],
  timeOfDay: 0.25,
  mutations: [],
  message: "",
  worldSize: WORLD,

  openEvolve: () => {
    const s = get();
    if (s.biomass < s.biomassNeeded || s.mode !== "playing") return;
    set({ mode: "evolve", mutations: rollMutations(s.kind, 6) });
  },

  start: (kind, biome, species) => {
    let startX = 0;
    if (biome === "forest") startX = -WORLD / 3;
    if (biome === "desert") startX = WORLD / 3;
    const sp: Species = species ?? (kind === "plant" ? "sapling" : "forager");
    const realKind: Kind = speciesToKind(sp);
    set({
      mode: "playing",
      kind: realKind,
      species: sp,
      traits: speciesStartingTraits(sp),
      energy: 100,
      biomass: 0,
      biomassNeeded: 50,
      generation: 1,
      pos: [startX, 0, 0],
      food: spawnFood(140),
      npcs: spawnNpcs(realKind),
      allies: [],
      timeOfDay: 0.25,
      message: realKind === "plant" ? "Rooted. Evolve to attract pollinators." : "Find food. Beware the apex.",
    });
  },

  setPos: (pos) => set({ pos }),

  consume: (foodId) => {
    const s = get();
    const f = s.food.find((x) => x.id === foodId);
    if (!f || !f.alive) return;
    f.alive = false;
    const gain = f.value;
    set({
      food: [...s.food],
      energy: Math.min(150 + s.traits.size * 30, s.energy + gain * 0.7),
      biomass: s.biomass + gain * 0.5,
    });
  },

  killNpc: (id) => {
    const s = get();
    const n = s.npcs.find((x) => x.id === id);
    if (!n || !n.alive) return;
    n.hp -= 1;
    if (n.hp <= 0) {
      n.alive = false;
      const reward = n.kind === "apex" ? 60 : n.kind === "predator" ? 25 : 12;
      set({
        npcs: [...s.npcs],
        biomass: s.biomass + reward,
        message: n.kind === "apex" ? "APEX SLAIN!" : n.kind === "predator" ? "Predator slain!" : "Caught prey!",
      });
    } else {
      set({ npcs: [...s.npcs] });
    }
  },

  eatNpc: (id) => {
    // Used when player simply consumes a herbivore on contact (carnivore enough)
    const s = get();
    const n = s.npcs.find((x) => x.id === id);
    if (!n || !n.alive) return;
    n.alive = false;
    const gain = n.kind === "herbivore" ? 35 : n.kind === "predator" ? 45 : 80;
    set({
      npcs: [...s.npcs],
      energy: Math.min(150 + s.traits.size * 30, s.energy + gain * 0.8),
      biomass: s.biomass + gain * 0.6,
      message: `Devoured ${n.kind}!`,
    });
  },

  damage: (amount) => {
    const s = get();
    const e = s.energy - amount;
    if (e <= 0) {
      set({ energy: 0, mode: "gameover", message: "You went extinct." });
    } else {
      set({ energy: e });
    }
  },

  damageAlly: (id, amount) => {
    const s = get();
    const a = s.allies.find((x) => x.id === id);
    if (!a || !a.alive) return;
    a.hp -= amount;
    if (a.hp <= 0) {
      a.alive = false;
      set({ allies: [...s.allies], message: "An ally fell." });
    } else {
      set({ allies: [...s.allies] });
    }
  },

  addEnergy: (amount) =>
    set((s) => ({ energy: Math.max(0, Math.min(150 + s.traits.size * 30, s.energy + amount)) })),

  spawnSeedFood: (pos) => {
    const s = get();
    const f: FoodItem = {
      id: `seed-${Math.random().toString(36).slice(2, 7)}`,
      pos,
      type: "seed",
      value: 12,
      alive: true,
    };
    set({ food: [...s.food, f], biomass: s.biomass + 4 });
  },

  tick: (dt) => {
    const s = get();
    if (s.mode !== "playing") return;

    const tod = (s.timeOfDay + dt / 90) % 1;
    const isDay = tod > 0.2 && tod < 0.8;
    const biome = biomeAt(s.pos[0], s.pos[2]);

    let energy = s.energy;
    let biomass = s.biomass;

    const meta = s.kind === "plant" ? 0.6 : 1.2 + s.traits.size * 0.3;
    energy -= meta * dt;

    if (s.kind === "plant") {
      if (isDay) energy += s.traits.leaves * 2.2 * dt;
      const soil = biome === "desert" ? 0.2 : biome === "forest" ? 1 : 0.8;
      energy += s.traits.roots * 0.8 * soil * dt;
      biomass += s.traits.leaves * 0.4 * dt * (isDay ? 1 : 0.1);
    }

    if (biome === "desert" && s.traits.heatResist < 1) energy -= (1 - s.traits.heatResist) * 0.8 * dt;
    if (biome === "forest" && !isDay && s.traits.coldResist < 1)
      energy -= (1 - s.traits.coldResist) * 0.6 * dt;

    const mode: Mode = s.mode;
    const mutations = s.mutations;
    // cap biomass at need; player presses Evolve to open menu
    if (biomass > s.biomassNeeded) biomass = s.biomassNeeded;

    let food = s.food;
    const alive = food.filter((f) => f.alive).length;
    if (alive < 110 && Math.random() < dt * 0.9) {
      food = [...food, ...spawnFood(10)];
    }

    // Top up NPCs if depleted
    let npcs = s.npcs;
    const aliveNpcs = npcs.filter((n) => n.alive);
    if (aliveNpcs.filter((n) => n.kind === "herbivore").length < 4 && Math.random() < dt * 0.3) {
      npcs = [...npcs, makeNpc("herbivore")];
    }
    if (aliveNpcs.filter((n) => n.kind === "predator").length < 3 && Math.random() < dt * 0.15) {
      npcs = [...npcs, makeNpc("predator")];
    }
    if (aliveNpcs.filter((n) => n.kind === "apex").length < 1 && Math.random() < dt * 0.05) {
      npcs = [...npcs, makeNpc("apex")];
    }

    energy = Math.min(150 + s.traits.size * 30, Math.max(0, energy));

    if (energy <= 0) {
      set({ mode: "gameover", energy: 0, message: "You went extinct." });
      return;
    }

    set({ energy, biomass, timeOfDay: tod, food, npcs, mode, mutations });
  },

  chooseMutation: (m) => {
    const s = get();
    const traits = m.apply(s.traits);
    let pos = s.pos;
    if (s.kind === "plant" && traits.spread > 0 && Math.random() < 0.4) {
      pos = randPos();
    }

    // Pack: allies arrive after gen 3, or whenever pack trait was just gained
    const nextGen = s.generation + 1;
    const allies = s.allies.filter((a) => a.alive);
    const shouldSpawnAllies =
      (s.kind === "animal" && nextGen >= 3) ||
      (s.kind === "plant" && (traits.pack > s.traits.pack || traits.spread > 0));
    if (shouldSpawnAllies) {
      const baseCount = s.kind === "animal" ? 1 : 0;
      const bonus = traits.pack;
      const total = baseCount + bonus + (m.id === "pack-bond" ? 1 : 0);
      for (let i = 0; i < total; i++) allies.push(makeAlly(pos));
    }

    set({
      traits,
      pos,
      allies,
      mode: "playing",
      generation: nextGen,
      biomass: 0,
      biomassNeeded: Math.floor(s.biomassNeeded * 1.4),
      energy: Math.min(150 + traits.size * 30, s.energy + 30),
      mutations: [],
      message: `Generation ${nextGen}: ${m.name}${shouldSpawnAllies && allies.length > s.allies.filter((a) => a.alive).length ? " — kin joined you!" : ""}`,
    });
  },

  reset: () => set({ mode: "menu", message: "", allies: [], npcs: [] }),
}));

export { biomeAt, WORLD };
