import type { CSSProperties } from "react";

/**
 * Chamber OS scoped theme — light, warm, civic-modern "wine country".
 * The global VibeVerse app is dark navy/neon mint; we override every shadcn
 * CSS variable on the page root so tokens resolve to this palette instead.
 * NOTE: portaled components (Sheet/Dialog/Select) escape this scope, so the
 * chamber UI deliberately uses only non-portaled primitives.
 */
export const chamberThemeVars: CSSProperties = {
  "--background": "40 33% 96%", // cream #FAF7F2
  "--foreground": "150 28% 14%", // deep green ink
  "--card": "40 45% 99%",
  "--card-foreground": "150 28% 14%",
  "--popover": "40 45% 99%",
  "--popover-foreground": "150 28% 14%",
  "--primary": "152 34% 24%", // deep forest green
  "--primary-foreground": "40 33% 97%",
  "--secondary": "42 28% 90%",
  "--secondary-foreground": "150 28% 18%",
  "--muted": "42 24% 91%",
  "--muted-foreground": "150 10% 38%",
  "--accent": "342 48% 34%", // muted wine / burgundy
  "--accent-foreground": "40 33% 97%",
  "--destructive": "0 62% 44%",
  "--destructive-foreground": "40 33% 97%",
  "--border": "40 20% 84%",
  "--input": "40 20% 84%",
  "--ring": "152 34% 30%",
  "--radius": "0.75rem",
} as CSSProperties;

/**
 * Chart palette — validated with the dataviz six-checks script against the
 * cream surface #FAF7F2 (lightness band, chroma floor, CVD ΔE 23.1, ≥3:1).
 */
export const chart = {
  green: "#1F9D63", // series 1 / members
  wine: "#8C2950", // series 2 / non-members
  amber: "#B37019", // warning-ish accents
  blue: "#3B7DC4",
  grid: "#E7E0D4",
  axis: "#8A8474",
} as const;

/** Status colors — reserved for state, always paired with a label. */
export const status = {
  good: { dot: "#1F7A4D", bg: "#E3F0E8", text: "#1D5C3C", label: "Current" },
  warn: { dot: "#B37019", bg: "#F6ECD9", text: "#7A4E12", label: "Overdue" },
  bad: { dot: "#8C2950", bg: "#F3E2E8", text: "#6E2140", label: "Lapsed" },
} as const;

export const janeColor = (score: number): string =>
  score >= 75 ? "#1F7A4D" : score >= 50 ? "#B37019" : "#8C2950";

export const money = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
