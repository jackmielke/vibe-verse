import type { ReactNode } from "react";

export type WorldId = "island" | "esmeralda" | "skyisland";

export type World = {
  id: WorldId;
  name: string;
  tagline: string;
  description: string;
  // Visual accent for the picker card (tailwind gradient classes).
  accent: string;
  // Where the character spawns and which way they look (yaw radians).
  spawn: { x: number; y: number; z: number; yaw: number };
  // Height of the ground at (x, z). Used by character physics.
  heightAt: (x: number, z: number) => number;
  // Sky/fog/lighting + scene contents.
  Scene: () => ReactNode;
  // Whether this world has shells to collect.
  hasShells: boolean;
  // Theme color for the HUD top bar (matches reference vibes).
  hudAccent: string;
};
