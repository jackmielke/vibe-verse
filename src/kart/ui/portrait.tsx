/**
 * Vibe Kart — character badges for the select screen and the results table.
 *
 * A select screen wants a portrait, and the only portrait that exists is a 3-D
 * rig the UI has no camera on. Rendering eight offscreen thumbnails would cost
 * eight render targets at boot, on a software rasteriser, for a screen the
 * player sees once — so instead the badge is *built from the same numbers the
 * rig is*: `preset.colors` paints the kart, `preset.driver` paints the driver,
 * and a hash of the character id picks one of eight head silhouettes. Put the
 * badge next to the kart in-game and it reads as the same character, because
 * the palette is literally shared.
 *
 * Everything is flat colour with one dark outline, matching `icons.tsx` — the
 * two sets have to sit on the same card without arguing.
 */
import type { CharacterPreset } from "../types";
import { hex } from "./util";

const INK = "#131c2b";

/** Stable per-character silhouette pick — the same id always gets the same head. */
function hash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 8;
}

function Headgear({ kind, hat, accent }: { kind: number; hat: string; accent: string }) {
  const dome = "M33 44 a17 17 0 0 1 34 0 Z";
  switch (kind) {
    case 0: // peaked cap
      return (
        <g>
          <path d={dome} fill={hat} />
          <path d="M64 44 h13 a3 3 0 0 1 0 6 H64 Z" fill={hat} />
        </g>
      );
    case 1: // full helmet with a visor
      return (
        <g>
          <path d="M31 46 a19 19 0 0 1 38 0 Z" fill={hat} />
          <path d="M34 44 h32 v7 a4 4 0 0 1 -4 4 H38 a4 4 0 0 1 -4 -4 Z" fill="#8fe8ff" opacity={0.9} />
        </g>
      );
    case 2: // bowl
      return <path d="M31 45 a19 15 0 0 1 38 0 Z" fill={hat} />;
    case 3: // antenna
      return (
        <g>
          <path d={dome} fill={hat} />
          <path d="M50 27 V16" stroke={hat} strokeWidth={3} fill="none" />
          <circle cx={50} cy={13} r={4.5} fill={accent} />
        </g>
      );
    case 4: // crest
      return (
        <g>
          <path d={dome} fill={hat} />
          <path d="M50 12 L60 40 H40 Z" fill={accent} />
        </g>
      );
    case 5: // swirl
      return (
        <g>
          <path d={dome} fill={hat} />
          <circle cx={50} cy={26} r={8} fill={accent} />
          <circle cx={50} cy={26} r={3.4} fill={hat} />
        </g>
      );
    case 6: // aviator goggles pushed up
      return (
        <g>
          <path d={dome} fill={hat} />
          <rect x={32} y={36} width={36} height={9} rx={4.5} fill="#2b3247" />
          <circle cx={41} cy={40.5} r={5} fill="#8fe8ff" />
          <circle cx={59} cy={40.5} r={5} fill="#8fe8ff" />
        </g>
      );
    default: // spiked crown
      return (
        <g>
          <path d={dome} fill={hat} />
          <path d="M32 44 L38 26 L44 38 L50 22 L56 38 L62 26 L68 44 Z" fill={accent} />
        </g>
      );
  }
}

export function CharacterPortrait({ preset }: { preset: CharacterPreset }) {
  const body = hex(preset.colors.body);
  const accent = hex(preset.colors.accent);
  const trim = hex(preset.colors.trim);
  const skin = hex(preset.driver.skin);
  const outfit = hex(preset.driver.outfit);
  const hat = hex(preset.driver.hat);
  const kind = hash(preset.id);
  const id = `vk-por-${preset.id}`;

  return (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor={accent} stopOpacity={0.85} />
          <stop offset="0.55" stopColor={trim} />
          <stop offset="1" stopColor="#0a1120" />
        </linearGradient>
      </defs>

      <rect x={0} y={0} width={100} height={100} fill={`url(#${id})`} />
      {/* Speed wisps behind the driver — motion, cheaply. */}
      <g stroke="#ffffff" strokeOpacity={0.16} strokeWidth={4} strokeLinecap="round">
        <path d="M6 22 h26" />
        <path d="M2 34 h18" />
        <path d="M70 18 h26" />
        <path d="M80 30 h18" />
      </g>
      <circle cx={50} cy={48} r={30} fill="#ffffff" opacity={0.12} />

      <g stroke={INK} strokeWidth={2.6} strokeLinejoin="round">
        {/* Kart, cropped by the badge so the driver stays the subject. */}
        <rect x={12} y={78} width={16} height={14} rx={5} fill="#20263a" />
        <rect x={72} y={78} width={16} height={14} rx={5} fill="#20263a" />
        <path d="M20 70 h60 a7 7 0 0 1 7 7 v9 H13 v-9 a7 7 0 0 1 7 -7 Z" fill={body} />
        <path d="M13 80 h74 v5 H13 Z" fill={accent} stroke="none" />

        {/* Driver */}
        <path d="M34 72 c0 -9 7 -14 16 -14 s16 5 16 14 Z" fill={outfit} />
        <circle cx={50} cy={44} r={17} fill={skin} />
        <Headgear kind={kind} hat={hat} accent={accent} />
        <ellipse cx={43} cy={49} rx={2.6} ry={3.4} fill={INK} stroke="none" />
        <ellipse cx={57} cy={49} rx={2.6} ry={3.4} fill={INK} stroke="none" />
        <path d="M46 56 c2 2.4 6 2.4 8 0" fill="none" stroke={INK} strokeWidth={2.4} strokeLinecap="round" />
      </g>

      {/* Chequered footer strip: the badge always reads as a racing card. */}
      <g>
        <rect x={0} y={92} width={100} height={8} fill="#0a1120" />
        {Array.from({ length: 10 }, (_, i) => (
          <rect key={i} x={i * 10} y={i % 2 ? 96 : 92} width={10} height={4} fill="#fdfdff" opacity={0.9} />
        ))}
      </g>
    </svg>
  );
}

export default CharacterPortrait;
