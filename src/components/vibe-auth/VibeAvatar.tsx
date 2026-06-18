/**
 * VibeAvatar — the tiny Club-Penguin-style character avatar.
 *
 * Pure SVG so it scales, recolors instantly, and has zero asset cost.
 * Shape: a rounded blob (body), two eyes, a tiny smile. The color is
 * the only thing that changes between vibes — keeping the "simpler is
 * better" promise.
 */
import { cn } from "@/lib/utils";

export const VIBE_COLORS: { id: string; name: string; hex: string }[] = [
  { id: "teal", name: "Teal", hex: "#2dd4bf" },
  { id: "mint", name: "Mint", hex: "#5eead4" },
  { id: "sky", name: "Sky", hex: "#38bdf8" },
  { id: "blue", name: "Blue", hex: "#3b82f6" },
  { id: "navy", name: "Navy", hex: "#1e3a8a" },
  { id: "indigo", name: "Indigo", hex: "#4f46e5" },
  { id: "purple", name: "Purple", hex: "#8b5cf6" },
  { id: "lilac", name: "Lilac", hex: "#c4b5fd" },
  { id: "pink", name: "Pink", hex: "#ec4899" },
  { id: "rose", name: "Rose", hex: "#f43f5e" },
  { id: "salmon", name: "Salmon", hex: "#fb7185" },
  { id: "red", name: "Red", hex: "#dc2626" },
  { id: "orange", name: "Orange", hex: "#f97316" },
  { id: "amber", name: "Amber", hex: "#f59e0b" },
  { id: "gold", name: "Gold", hex: "#b45309" },
  { id: "yellow", name: "Yellow", hex: "#facc15" },
  { id: "lime", name: "Lime", hex: "#a3e635" },
  { id: "green", name: "Green", hex: "#22c55e" },
  { id: "emerald", name: "Emerald", hex: "#10b981" },
  { id: "forest", name: "Forest", hex: "#166534" },
  { id: "cyan", name: "Cyan", hex: "#06b6d4" },
  { id: "slate", name: "Slate", hex: "#64748b" },
  { id: "stone", name: "Stone", hex: "#a8a29e" },
  { id: "white", name: "Snow", hex: "#f8fafc" },
  { id: "black", name: "Black", hex: "#1f2937" },
];

export const DEFAULT_VIBE_COLOR = "purple";

export function colorHexById(id: string | null | undefined): string {
  return VIBE_COLORS.find((c) => c.id === id)?.hex ?? VIBE_COLORS[5].hex;
}

interface Props {
  colorId?: string | null;
  size?: number;
  className?: string;
  /** Wink animation; nice for hover states. */
  animated?: boolean;
}

export default function VibeAvatar({
  colorId,
  size = 96,
  className,
  animated = false,
}: Props) {
  const color = colorHexById(colorId);
  // Slightly darker outline for contrast on any background.
  const outline = "rgba(0,0,0,0.35)";
  return (
    <svg
      viewBox="0 0 100 120"
      width={size}
      height={size * 1.2}
      className={cn("select-none", animated && "vibe-bounce", className)}
      aria-hidden
    >
      {/* shadow */}
      <ellipse cx="50" cy="112" rx="26" ry="4" fill="rgba(0,0,0,0.25)" />
      {/* body */}
      <path
        d="M50 8c20 0 32 16 32 38 0 22-12 44-32 44S18 68 18 46 30 8 50 8z"
        fill={color}
        stroke={outline}
        strokeWidth="2.5"
      />
      {/* belly */}
      <ellipse cx="50" cy="62" rx="18" ry="22" fill="rgba(255,255,255,0.92)" />
      {/* eyes */}
      <ellipse cx="40" cy="38" rx="4.5" ry="5.5" fill="#fff" />
      <ellipse cx="60" cy="38" rx="4.5" ry="5.5" fill="#fff" />
      <circle cx="41" cy="39" r="2.2" fill="#111" />
      <circle cx="61" cy="39" r="2.2" fill="#111" />
      {/* beak */}
      <path d="M44 50 Q50 56 56 50 Q50 54 44 50z" fill="#f59e0b" stroke={outline} strokeWidth="1.2" />
      {/* feet */}
      <ellipse cx="38" cy="98" rx="8" ry="4" fill="#f59e0b" stroke={outline} strokeWidth="1.5" />
      <ellipse cx="62" cy="98" rx="8" ry="4" fill="#f59e0b" stroke={outline} strokeWidth="1.5" />
    </svg>
  );
}
