export type Kind = "plant" | "animal";
export type Biome = "grassland" | "desert" | "forest";
export type Mode = "menu" | "playing" | "evolve" | "gameover";
export type NpcKind = "predator" | "apex" | "herbivore";
export type Species =
  | "forager"
  | "sapling"
  | "stalker"
  | "grizzly"
  | "fawn"
  | "dragon"
  | "goat"
  | "armored"
  | "fanged"
  | "otter";

export interface Traits {
  // shared
  size: number;
  defense: number;
  heatResist: number;
  coldResist: number;
  // animal
  speed: number;
  sight: number;
  carnivore: number; // 0 herb .. 1 carn (>=0.3 = omnivore-ish, can eat prey)
  // plant
  leaves: number;
  roots: number;
  spread: number; // seed dispersal — helps survive grazers
  // social
  pack: number; // bonus allies per evolve
  color: [number, number, number];
}

export interface Mutation {
  id: string;
  name: string;
  desc: string;
  apply: (t: Traits) => Traits;
  kinds: Kind[];
}

export interface FoodItem {
  id: string;
  pos: [number, number, number];
  type: "berry" | "seed" | "prey" | "water" | "nutrient";
  value: number;
  alive: boolean;
}

export interface Npc {
  id: string;
  kind: NpcKind;
  pos: [number, number, number];
  vel: [number, number];
  hp: number;
  alive: boolean;
  size: number;
  seeded?: boolean; // herbivore carrying a plant seed
  seedTimer?: number;
}

export interface Ally {
  id: string;
  pos: [number, number, number];
  vel: [number, number];
  alive: boolean;
  hp: number;
}
