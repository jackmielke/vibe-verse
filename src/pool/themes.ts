/**
 * The looks. A theme is the room, the cloth, the rails and the cue, and
 * nothing else: the balls are always the colours a pool player expects, and
 * the physics and rules never change.
 */

export interface PoolTheme {
  id: string;
  name: string;
  emoji: string;
  /** The room behind the table, as a CSS background. */
  room: string;
  /** Plain colour for the browser chrome while loading. */
  roomFill: string;
  cloth: string;
  clothLight: string;
  clothDark: string;
  cushion: string;
  /** Rail gradient, outer to inner. */
  rail: [string, string, string];
  railLine: string;
  diamond: string;
  pocket: string;
  pocketRim: string;
  /** Text and chrome on the page. */
  ink: string;
  inkSoft: string;
  panel: string;
  accent: string;
  guide: string;
  cue: { butt: string; buttDark: string; ring: string; shaft: string; wrap: string };
  /** Sprinkles on the cloth: stars, sparkles, nothing. */
  sparkle?: string;
  /** Glow on the rail line. */
  glow?: string;
}

export const THEMES: PoolTheme[] = [
  {
    id: "club",
    name: "Club Room",
    emoji: "🟢",
    room: "radial-gradient(90% 70% at 50% 40%, #3b2a1d 0%, #1c130c 55%, #0c0805 100%)",
    roomFill: "#1c130c",
    cloth: "#1f7d4b",
    clothLight: "#2c9a60",
    clothDark: "#14593a",
    cushion: "#18693f",
    rail: ["#3a1f0f", "#6b3a1d", "#8a4f2a"],
    railLine: "rgba(255,220,170,0.35)",
    diamond: "#f2e6c9",
    pocket: "#0b0a08",
    pocketRim: "#c9a227",
    ink: "#f8f1e4",
    inkSoft: "rgba(248,241,228,0.62)",
    panel: "rgba(20,12,6,0.72)",
    accent: "#ffd166",
    guide: "rgba(255,255,255,0.85)",
    cue: { butt: "#5a2a12", buttDark: "#2a1206", ring: "#e8d8a8", shaft: "#e9d3a6", wrap: "#1b1b1b" },
  },
  {
    id: "neon",
    name: "Neon Night",
    emoji: "🌃",
    room: "radial-gradient(80% 60% at 20% 0%, rgba(255,60,200,0.25), transparent 60%), radial-gradient(80% 60% at 90% 100%, rgba(60,220,255,0.22), transparent 60%), linear-gradient(180deg, #0c0620, #05030f)",
    roomFill: "#07041a",
    cloth: "#2a1a63",
    clothLight: "#3b278a",
    clothDark: "#170d3d",
    cushion: "#22144f",
    rail: ["#07050f", "#151127", "#1f1a38"],
    railLine: "#3cf0ff",
    diamond: "#ff4fd8",
    pocket: "#020108",
    pocketRim: "#ff4fd8",
    ink: "#f2e9ff",
    inkSoft: "rgba(242,233,255,0.6)",
    panel: "rgba(14,8,40,0.75)",
    accent: "#3cf0ff",
    guide: "rgba(120,250,255,0.95)",
    cue: { butt: "#18122e", buttDark: "#0a0716", ring: "#ff4fd8", shaft: "#d9e7ff", wrap: "#3cf0ff" },
    glow: "#3cf0ff",
  },
  {
    id: "sunset",
    name: "Island Sunset",
    emoji: "🌅",
    room: "linear-gradient(180deg, #ff9a5a 0%, #f2617a 38%, #7a3b8f 72%, #2a1f4f 100%)",
    roomFill: "#f2617a",
    cloth: "#0f8b8d",
    clothLight: "#22a9a6",
    clothDark: "#0a6366",
    cushion: "#0c7779",
    rail: ["#8a5a2b", "#c99a5b", "#e8c385"],
    railLine: "rgba(255,255,255,0.5)",
    diamond: "#fff4d6",
    pocket: "#1a0f12",
    pocketRim: "#ffb35c",
    ink: "#fff8f0",
    inkSoft: "rgba(255,248,240,0.7)",
    panel: "rgba(60,20,50,0.55)",
    accent: "#ffe066",
    guide: "rgba(255,255,255,0.9)",
    cue: { butt: "#c96b2b", buttDark: "#7a3a12", ring: "#ffe066", shaft: "#f4dfb4", wrap: "#2a7f7d" },
  },
  {
    id: "space",
    name: "Deep Space",
    emoji: "🪐",
    room: "radial-gradient(60% 50% at 75% 20%, rgba(120,80,255,0.25), transparent 70%), radial-gradient(50% 40% at 15% 85%, rgba(0,180,255,0.18), transparent 70%), #04040c",
    roomFill: "#04040c",
    cloth: "#121a3d",
    clothLight: "#1d2a5e",
    clothDark: "#0a0f26",
    cushion: "#0f1634",
    rail: ["#3d4352", "#9aa3b5", "#d8dde8"],
    railLine: "rgba(255,255,255,0.7)",
    diamond: "#9be7ff",
    pocket: "#000000",
    pocketRim: "#9be7ff",
    ink: "#eef3ff",
    inkSoft: "rgba(238,243,255,0.6)",
    panel: "rgba(8,10,30,0.72)",
    accent: "#9be7ff",
    guide: "rgba(190,240,255,0.95)",
    cue: { butt: "#2b3350", buttDark: "#141a2e", ring: "#c9d2e6", shaft: "#e6ecf7", wrap: "#6b5bff" },
    sparkle: "#ffffff",
  },
  {
    id: "garage",
    name: "Mort's Garage",
    emoji: "🔧",
    room: "repeating-linear-gradient(135deg, rgba(255,255,255,0.03) 0 12px, transparent 12px 24px), linear-gradient(180deg, #2b2b2e 0%, #161618 100%)",
    roomFill: "#1f1f22",
    cloth: "#a8232e",
    clothLight: "#c4343f",
    clothDark: "#7a141d",
    cushion: "#8e1b25",
    rail: ["#3a3c40", "#7d8187", "#b4b8be"],
    railLine: "rgba(255,210,0,0.6)",
    diamond: "#ffd200",
    pocket: "#0a0a0a",
    pocketRim: "#ffd200",
    ink: "#f5f5f5",
    inkSoft: "rgba(245,245,245,0.6)",
    panel: "rgba(20,20,22,0.78)",
    accent: "#ffd200",
    guide: "rgba(255,255,255,0.9)",
    cue: { butt: "#222", buttDark: "#000", ring: "#ffd200", shaft: "#e8d6b0", wrap: "#a8232e" },
  },
];

export const themeById = (id: string | null | undefined): PoolTheme =>
  THEMES.find((t) => t.id === id) ?? THEMES[0];

/** The balls. The colours every pool player reads without thinking. */
export const BALL_COLORS: Record<number, string> = {
  0: "#f7f4ea",
  1: "#f5c518",
  2: "#1f4fd1",
  3: "#e02a2f",
  4: "#6a2fb0",
  5: "#f27318",
  6: "#13894a",
  7: "#8a1c26",
  8: "#141414",
  9: "#f5c518",
  10: "#1f4fd1",
  11: "#e02a2f",
  12: "#6a2fb0",
  13: "#f27318",
  14: "#13894a",
  15: "#8a1c26",
};
