/**
 * Vibe Kart — structural views of the services the UI reads.
 *
 * The UI is a consumer of nine subsystems and imports none of them. What it
 * knows about them is exactly this file: the shared contract from `../types`,
 * widened with the extras each system publishes on top of it, all optional.
 *
 * Optional is the point. `race.bestLapOf` is not in the contract, so the HUD
 * has to survive a build where it is missing — call it through `?.` and fall
 * back. A missing method means a slightly plainer HUD; it must never mean a
 * blank screen.
 */
import type {
  ItemKind,
  ItemService,
  MinimapService,
  PhysicsService,
  RaceService,
  RacerState,
  Standing,
  TrackService,
} from "../types";

export interface RaceView extends RaceService {
  phaseTime?: number;
  finalLap?: boolean;
  paused?: boolean;
  autoStart?: boolean;
  mode?: string;
  setMode?(mode: string): void;
  setPaused?(paused: boolean): void;
  lapOf?(id: number): number;
  lapsOf?(id: number): number[];
  bestLapOf?(id: number): number;
  gapOf?(id: number): number;
  wrongWay?(id?: number): boolean;
  startGradeOf?(id: number): string;
  rocket?: { hold: number; flooded: boolean; grade: string };
  results?(): Standing[] | null;
  record?: { lap: number; total: number; characterId?: string; name?: string } | null;
  lastRun?: { lap: number; total: number } | null;
}

export interface ItemsView extends ItemService {
  display?(racerId: number): { kind: ItemKind | null; count: number; rolling: boolean; face: ItemKind | null };
  starOf?(racerId: number): number;
  inkOf?(racerId: number): number;
  bulletOf?(racerId: number): number;
  coinBonusOf?(racerId: number): number;
}

export interface TrackView extends TrackService {
  sections?: Array<{ id: string; label: string; start: number; end: number }>;
}

export interface MinimapView extends MinimapService {
  project?(x: number, z: number): { x: number; y: number };
  heading?(forward: { x: number; y: number; z: number }): number;
  roadWidth?: number;
  startLine?: { x1: number; y1: number; x2: number; y2: number };
  baked?: boolean;
}

export interface InputView {
  source?: "keyboard" | "gamepad" | "touch";
  gamepad?: boolean;
  setTouchVisible?(visible: boolean | null): void;
  rumble?(strength: number, ms?: number): void;
}

export interface CameraView {
  mode?: string;
  setMode?(mode: string, opts?: { snap?: boolean }): void;
  scenicTo?(index: number): void;
  scenicMark?: number;
  release?(): void;
  follow?(racerId: number): void;
}

export interface AudioView {
  play?(id: string, position?: unknown, opts?: { volume?: number; rate?: number }): void;
  music?(track: "menu" | "race" | "finalLap" | "results" | null): void;
  setMuted?(muted: boolean): void;
  unlock?(): void;
  muted?: boolean;
}

export interface ModelsView {
  roster?: Array<import("../types").CharacterPreset>;
  destroyRacer?(racerId: number): void;
  preset?(characterId: string): import("../types").CharacterPreset;
}

export type PhysicsView = PhysicsService & { playerAi?: boolean };

/** The player, or a plausible stand-in so the HUD can render without physics. */
export function playerOf(physics: PhysicsView | undefined): RacerState | undefined {
  return physics?.player ?? physics?.racers?.[0];
}
