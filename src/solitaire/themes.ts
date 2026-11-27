/**
 * The looks. Each is a table, a card face, a card back and a palette, and
 * nothing else: the layout, motion and rules are the same under all of them.
 *
 * Backgrounds are CSS strings so a theme is pure data. The win cascade draws
 * cards on a canvas, so a theme also carries plain colours it can read.
 */

export interface Theme {
  id: string;
  name: string;
  emoji: string;
  /** The table, as a CSS background. */
  table: string;
  /** Text and icons on the table. */
  ink: string;
  inkSoft: string;
  /** Empty pile outlines. */
  slot: string;
  /** Card face. */
  face: string;
  /** Plain face colour for the canvas. */
  faceFill: string;
  faceEdge: string;
  red: string;
  black: string;
  /** Court-card badge ring. */
  court: string;
  /** Card back, as a CSS background, plus the emblem drawn in the middle. */
  back: string;
  backEdge: string;
  emblem: string;
  emblemInk: string;
  /** Highlights: hints, drop targets, the win. */
  accent: string;
  /** Colours the win confetti and cascade pick from. */
  burst: string[];
  /** Plain fill the canvas uses for the back. */
  backFill: string;
  font: string;
  /** Cards glow a little in the dark themes. */
  glow?: string;
}

const ROUNDED = `"Nunito", "SF Pro Rounded", ui-rounded, system-ui, -apple-system, "Segoe UI", sans-serif`;
const SERIF = `"Playfair Display", Georgia, "Times New Roman", serif`;

export const THEMES: Theme[] = [
  {
    id: "felt",
    name: "Card Club",
    emoji: "🟢",
    table:
      "radial-gradient(120% 90% at 50% 0%, #2f8f5b 0%, #1d6b42 45%, #0f4429 100%)",
    ink: "#f3fbf5",
    inkSoft: "rgba(243,251,245,0.62)",
    slot: "rgba(255,255,255,0.22)",
    face: "linear-gradient(160deg, #ffffff 0%, #f6f3ea 100%)",
    faceFill: "#fbf8f0",
    faceEdge: "rgba(0,0,0,0.18)",
    red: "#d3263b",
    black: "#17202b",
    court: "#c9a227",
    back:
      "repeating-linear-gradient(45deg, rgba(255,255,255,0.10) 0 2px, transparent 2px 9px), repeating-linear-gradient(-45deg, rgba(255,255,255,0.10) 0 2px, transparent 2px 9px), linear-gradient(160deg, #1f3d8a, #142a63)",
    backEdge: "#f3f0e6",
    emblem: "radial-gradient(circle at 35% 30%, #ffe27a, #e0a915 70%)",
    emblemInk: "#5a3d00",
    accent: "#ffd84a",
    burst: ["#ffd84a", "#ffffff", "#ff6b6b", "#6be0ff"],
    backFill: "#1b357a",
    font: ROUNDED,
  },
  {
    id: "neon",
    name: "Neon Night",
    emoji: "🌃",
    table:
      "radial-gradient(90% 70% at 20% 0%, rgba(255,60,200,0.22), transparent 60%), radial-gradient(90% 70% at 90% 100%, rgba(60,220,255,0.20), transparent 60%), linear-gradient(180deg, #0c0620, #05030f)",
    ink: "#f2e9ff",
    inkSoft: "rgba(242,233,255,0.55)",
    slot: "rgba(160,120,255,0.38)",
    face: "linear-gradient(160deg, #1d1438 0%, #120c26 100%)",
    faceFill: "#181030",
    faceEdge: "rgba(190,150,255,0.45)",
    red: "#ff4fb8",
    black: "#4fe3ff",
    court: "#b98bff",
    back:
      "linear-gradient(rgba(255,79,184,0.35) 1px, transparent 1px) 0 0 / 10px 10px, linear-gradient(90deg, rgba(79,227,255,0.35) 1px, transparent 1px) 0 0 / 10px 10px, linear-gradient(160deg, #2a0f4d, #12062a)",
    backEdge: "#ff4fb8",
    emblem: "radial-gradient(circle at 35% 30%, #ffffff, #ff4fb8 55%, #7a1fd1)",
    emblemInk: "#ffffff",
    accent: "#4fe3ff",
    burst: ["#ff4fb8", "#4fe3ff", "#b98bff", "#fff36b"],
    backFill: "#2a0f4d",
    font: ROUNDED,
    glow: "0 0 10px rgba(185,139,255,0.35)",
  },
  {
    id: "sunset",
    name: "Island Sunset",
    emoji: "🌅",
    table:
      "radial-gradient(60% 40% at 50% 108%, rgba(255,230,140,0.9), transparent 70%), linear-gradient(180deg, #3b2a7a 0%, #b4489a 42%, #ff7a5c 78%, #ffb35c 100%)",
    ink: "#fff7ef",
    inkSoft: "rgba(255,247,239,0.7)",
    slot: "rgba(255,255,255,0.38)",
    face: "linear-gradient(160deg, #fffdf8 0%, #fff1e2 100%)",
    faceFill: "#fff7ee",
    faceEdge: "rgba(120,40,60,0.20)",
    red: "#e8384f",
    black: "#2b2350",
    court: "#ff8a3d",
    back:
      "radial-gradient(circle at 50% 120%, #ffd36b 0 22%, transparent 23%), repeating-radial-gradient(circle at 50% 120%, rgba(255,255,255,0.16) 0 3px, transparent 3px 9px), linear-gradient(180deg, #ff7a5c, #b4489a 70%, #3b2a7a)",
    backEdge: "#fff6ea",
    emblem: "radial-gradient(circle at 35% 30%, #fff3b0, #ffb347 70%)",
    emblemInk: "#7a2a12",
    accent: "#fff36b",
    burst: ["#ffd36b", "#ff7a5c", "#ffffff", "#b4489a"],
    backFill: "#d65d7a",
    font: ROUNDED,
  },
  {
    id: "postcard",
    name: "Airmail",
    emoji: "✉️",
    table:
      "radial-gradient(120% 80% at 50% 0%, #fbf4e4 0%, #efe3c8 70%, #e3d3b0 100%)",
    ink: "#2b2a33",
    inkSoft: "rgba(43,42,51,0.6)",
    slot: "rgba(60,50,30,0.28)",
    face: "linear-gradient(160deg, #fffefa 0%, #faf5e8 100%)",
    faceFill: "#fdf9ef",
    faceEdge: "rgba(60,50,30,0.25)",
    red: "#c8302c",
    black: "#1f2c5c",
    court: "#1f2c5c",
    back:
      "repeating-linear-gradient(-45deg, #c8302c 0 7px, #fffefa 7px 14px, #1f2c5c 14px 21px, #fffefa 21px 28px)",
    backEdge: "#fffefa",
    emblem: "radial-gradient(circle at 35% 30%, #fffefa, #f1e6cc 75%)",
    emblemInk: "#c8302c",
    accent: "#c8302c",
    burst: ["#c8302c", "#1f2c5c", "#e8b34a", "#ffffff"],
    backFill: "#e9dcc0",
    font: SERIF,
  },
  {
    id: "space",
    name: "Deep Space",
    emoji: "🪐",
    table:
      "radial-gradient(1px 1px at 12% 18%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 68% 32%, #fff 50%, transparent 51%), radial-gradient(1.5px 1.5px at 34% 72%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 86% 82%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 52% 52%, #cfe 50%, transparent 51%), radial-gradient(1.5px 1.5px at 92% 12%, #fff 50%, transparent 51%), radial-gradient(70% 50% at 80% 10%, rgba(90,110,255,0.35), transparent 70%), radial-gradient(60% 50% at 10% 90%, rgba(255,120,80,0.22), transparent 70%), linear-gradient(180deg, #070b1f, #020308)",
    ink: "#e8eeff",
    inkSoft: "rgba(232,238,255,0.55)",
    slot: "rgba(150,170,255,0.32)",
    face: "linear-gradient(160deg, #f4f7ff 0%, #d9e1f5 100%)",
    faceFill: "#e8edfa",
    faceEdge: "rgba(30,40,90,0.35)",
    red: "#e0384a",
    black: "#1a2350",
    court: "#6f7dff",
    back:
      "radial-gradient(ellipse 48% 14% at 50% 50%, transparent 60%, rgba(255,214,150,0.9) 62%, transparent 68%), radial-gradient(circle at 50% 50%, #ff9a5a 0 18%, transparent 19%), radial-gradient(1px 1px at 20% 20%, #fff 50%, transparent 51%) 0 0 / 14px 14px, linear-gradient(160deg, #1a2160, #070b1f)",
    backEdge: "#aeb9ff",
    emblem: "none",
    emblemInk: "transparent",
    accent: "#8fa2ff",
    burst: ["#8fa2ff", "#ff9a5a", "#ffffff", "#ffd696"],
    backFill: "#141a4a",
    font: ROUNDED,
    glow: "0 0 12px rgba(143,162,255,0.25)",
  },
];

export const themeById = (id: string | null | undefined): Theme =>
  THEMES.find((t) => t.id === id) ?? THEMES[0];
