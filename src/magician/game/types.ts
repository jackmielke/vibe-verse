/**
 * The game layer's contracts.
 *
 * A mode is a small object with `start`, `update`, `stop` and a `hud()` the
 * page reads every frame. It gets a `GameContext` with everything it may
 * touch: the enemies, the bolts, the world state (which it may read *and*
 * change, because the world's rules are the weapons), the player, Vibey.
 *
 * The one design rule: a mode never renders anything itself beyond what the
 * shared systems draw. Enemies come from `enemies.ts`, shots from
 * `bolts.ts`, effects from the world's bursts. That keeps each mode about a
 * hundred and fifty lines of rules.
 */
import type * as THREE from "three";
import type { Patch, WorldState } from "../state";
import type { Enemies } from "./enemies";
import type { Bolts } from "./bolts";

export type GameModeId = "siege" | "spirits" | "dragon";

export interface GameHud {
  mode: GameModeId | null;
  title: string;
  /** One line: what to do right now. */
  objective: string;
  score: number;
  hearts: number;
  maxHearts: number;
  wave?: number;
  waves?: number;
  /** Seconds left, if the mode is timed. */
  timer?: number | null;
  /** Extra line for the HUD (houses standing, lights collected…). */
  detail?: string;
  over: boolean;
  won: boolean;
  /** Cooldowns for Vibey's big spells, seconds remaining. */
  shield: number;
  blast: number;
}

export interface GameContext {
  scene: THREE.Scene;
  state(): WorldState;
  patch(p: Patch): void;
  player: { position: THREE.Vector3; yaw(): number };
  heightAt(x: number, z: number): number;
  enemies: Enemies;
  bolts: Bolts;
  /** Vibey's position, so allies can shoot from the right place. */
  vibey(): THREE.Vector3;
  burst(kind: "sparkle" | "smoke" | "flash", x: number, y: number, z: number): void;
  sound(name: "bell" | "gong" | "thunder" | "chime" | "whoosh" | "hit" | "fizz" | "roar" | "pop"): void;
  /** Tell the voice what just happened. Rate-limited by the caller. */
  notify(text: string): void;
  toast(text: string): void;
  caption(text: string): void;
  emote(clip: string): void;
  /** Move the player. */
  teleport(x: number, z: number, yaw?: number): void;
  /** The village houses, for modes that defend them. The runner owns hp and alive. */
  houses: Array<{ x: number; z: number; group: THREE.Group; hp: number; alive: boolean }>;
  /** Whether the storm's lightning struck this frame (0–1). */
  lightning(): number;
  /** Where the player currently is, as a landmark name or null. */
  time(): number;
}

export interface GameMode {
  id: GameModeId;
  title: string;
  blurb: string;
  start(ctx: GameContext): void;
  update(dt: number): void;
  stop(): void;
  hud(): GameHud;
  /** The player pressed the action button aimed somewhere: a bolt was fired. */
  onBolt?(): void;
  /** A bolt hit the ground or an object at this point. */
  onBoltLand?(x: number, y: number, z: number): void;
  /** An enemy died. */
  onKill?(kind: string): void;
  /** The player was hit. Returns true if the mode absorbed it (a shield). */
  onPlayerHit?(): boolean;
}

export const MODE_INFO: Record<GameModeId, { title: string; emoji: string; blurb: string; tip: string }> = {
  siege: {
    title: "Oni Siege",
    emoji: "👹",
    blurb: "Five waves of oni march on the village. Defend the houses with your bolts; Vibey fights beside you. Rain drowns the fire oni, snow slows them all, a storm's lightning picks them off, and a flood ends the argument.",
    tip: "Click, tap or pull the trigger to shoot. Ask Vibey for rain, a storm, a shield, or a blast.",
  },
  spirits: {
    title: "Spirit Lights",
    emoji: "🏮",
    blurb: "Thirty spirit lights are loose in the valley and a hungry yurei is loose with them. Gather the lights in two minutes. It cannot see you in fog, it will not cross the glow of a lit lantern, and Vibey can make you fast.",
    tip: "Walk into the lights. Ask Vibey for fog, lanterns, speed, or moon gravity.",
  },
  dragon: {
    title: "Dragon's Breath",
    emoji: "🐉",
    blurb: "The mountain wakes and the fireballs come faster every minute. Ring the three bells, at the bridge, the torii and the shrine, to put it back to sleep. Rain puts the fire out, but the dragon boils the rain off in a few seconds.",
    tip: "Reach each bell and hit it. Ask Vibey for rain when it gets hot, and for a shield.",
  },
};
