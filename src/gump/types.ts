/**
 * The contract between the engine and a chapter.
 *
 * Six beats of a life is six different games, and the only way that stays
 * sane is if the engine knows nothing about any of them. It owns the renderer,
 * the clock, the input and the camera; a chapter is handed a `THREE.Group` to
 * fill and a `ChapterCtx` to read, and it hands back a `ChapterHud` every frame
 * saying how it is going. Nothing else crosses the line.
 */
import type * as THREE from "three";
import type { GumpAudio } from "./audio";

export type ChapterId =
  | "greenbow"
  | "football"
  | "vietnam"
  | "pingpong"
  | "shrimp"
  | "america";

/**
 * One frame of intent, already normalised across keyboard, touch and gamepad.
 * A chapter never asks what device it is on.
 */
export interface GumpInput {
  /** -1 (left) … +1 (right). Analogue: a drag halfway across is half a lean. */
  steer: number;
  /** Held. */
  jump: boolean;
  /** True only on the frame the jump went down. */
  jumpPressed: boolean;
  /** Held — the sprint key, and the "swing hard" modifier in ping-pong. */
  boost: boolean;
  /** True only on the frame the action button went down. */
  actionPressed: boolean;
}

export interface ChapterCtx {
  /** The chapter's own subtree. Empty it and you have torn the chapter down. */
  root: THREE.Group;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  audio: GumpAudio;
  input: GumpInput;
  /** Deterministic per-run, so a chapter looks the same twice in a row. */
  rng: () => number;
  /** Sets the scene fog + background for this chapter. */
  setSky(top: number, bottom: number, fog: number, fogDensity: number): void;
  /** Fires the HUD's toast line. */
  say(line: string): void;
  /**
   * A test seam, and only that. The screenshot harness has to reach the beat
   * at 80% of a five-kilometre chapter to check that it renders; it plays like
   * a cat on the keyboard and would be dead in forty metres otherwise. It is
   * never set by anything a player can reach.
   */
  debug: { immortal: boolean };
}

export type Outcome = "running" | "won" | "lost";

export interface ChapterHud {
  /** 0 … 1 along the chapter's goal. Drives the bar under the timeline. */
  progress: number;
  /** Big readout — "2.4 MI", "RALLY 18". */
  stat: string;
  statLabel: string;
  /** Second readout, when the chapter has one — buddies, dollars, chocolates. */
  extra?: string;
  extraLabel?: string;
  /**
   * The thing behind you, in metres. Kept separate from `extra` because they
   * are different questions — "how many have I got" and "how close is it" —
   * and the jungle asks both at once. Folding them into one field meant the
   * chapter about carrying four men out did not show you how many you had.
   */
  danger?: string;
  dangerLabel?: string;
  /** Chances left, when the chapter counts them. */
  lives?: number;
  maxLives?: number;
  outcome: Outcome;
  /** Dollars earned in this chapter, folded into the run total when it ends. */
  earned?: number;
  /** Chocolates picked up in this chapter. */
  chocolates?: number;
  /** Ground covered in this chapter, for the run total. */
  metres?: number;
  /** How hard the screen should shake, 0 … 1. The engine applies it. */
  shake?: number;
}

export interface Chapter {
  update(dt: number): ChapterHud;
  /** Everything the chapter allocated that the engine cannot free for it. */
  dispose(): void;
}

/** What the page renders. One object, replaced every frame. */
export interface GumpSnapshot {
  phase: "bench" | "card" | "playing" | "beat" | "over" | "finale";
  /** Index into CHAPTERS. */
  chapter: number;
  hud: ChapterHud;
  /** Totals across the whole run. */
  chocolates: number;
  money: number;
  miles: number;
  toast: string | null;
  /** Set on "beat" / "over" / "finale" — the line Vibey says about it. */
  narration: string | null;
  /** Chapters cleared this run, for the timeline ticks. */
  cleared: number;
  muted: boolean;
}
