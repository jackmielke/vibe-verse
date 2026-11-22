/**
 * The three cover-art looks for the front door, in the order the switcher
 * shows them. Postcard leads: the one a first visit opens on, and the only
 * one phones get.
 */
import { lazy } from "react";

export const DIRECTIONS = [
  {
    id: "postcard",
    name: "Postcard",
    note: "The serif half of the cover: warm paper, the art as a postcard, calm and personal.",
    Component: lazy(() => import("@/redesign/Postcard")),
  },
  {
    id: "arcade",
    name: "Arcade",
    note: "The pixel half of the cover: a title screen, a game HUD, cards like cartridges.",
    Component: lazy(() => import("@/redesign/Arcade")),
  },
  {
    id: "sky",
    name: "Sky",
    note: "The cover, taken literally: blue sky, pixel wordmark, the islands along the bottom.",
    Component: lazy(() => import("@/redesign/Sky")),
  },
] as const;

export type DirectionId = (typeof DIRECTIONS)[number]["id"];

export const DEFAULT_DIRECTION: DirectionId = "postcard";
