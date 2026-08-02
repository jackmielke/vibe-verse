/**
 * Tiny typed pub/sub used to decouple the Three.js simulation from React UI.
 * Systems emit; HUD/menus subscribe. Never import React from a game system —
 * emit an event instead.
 */

export interface GameEvents {
  "player:health": { health: number; shield: number; maxHealth: number; maxShield: number };
  "player:damaged": { amount: number; fromDirection: [number, number, number] };
  "player:died": { killerName: string };
  "player:respawn": Record<string, never>;
  "weapon:changed": { name: string; ammo: number; reserve: number; icon: string };
  "weapon:ammo": { ammo: number; reserve: number };
  "weapon:fired": { name: string };
  "weapon:reload": { duration: number };
  "combat:hit": { headshot: boolean; killed: boolean; targetName: string };
  "combat:kill": { targetName: string; weapon: string; headshot: boolean };
  "objective:changed": { text: string; sub?: string };
  "objective:complete": { text: string };
  "score:changed": { score: number; combo: number };
  "wave:started": { wave: number; enemies: number };
  "wave:cleared": { wave: number };
  "notify": { text: string; kind: "info" | "warn" | "good" };
  "subtitle": { speaker: string; text: string; duration: number };
  "perf:stats": { fps: number; ms: number; drawCalls: number; triangles: number; tier: string };
  "loading:progress": { phase: string; progress: number };
  "loading:done": Record<string, never>;
  "game:state": { state: "menu" | "select" | "loading" | "playing" | "paused" | "dead" };
  "interact:prompt": { text: string | null };
  "spectacle": { text: string };
}

type Handler<K extends keyof GameEvents> = (payload: GameEvents[K]) => void;

class Bus {
  private map = new Map<string, Set<(p: unknown) => void>>();

  on<K extends keyof GameEvents>(key: K, fn: Handler<K>): () => void {
    let set = this.map.get(key as string);
    if (!set) {
      set = new Set();
      this.map.set(key as string, set);
    }
    set.add(fn as (p: unknown) => void);
    return () => set!.delete(fn as (p: unknown) => void);
  }

  emit<K extends keyof GameEvents>(key: K, payload: GameEvents[K]): void {
    const set = this.map.get(key as string);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${String(key)}" threw`, err);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}

export const bus = new Bus();
