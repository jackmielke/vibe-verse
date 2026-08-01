/**
 * Vibe Kart — the icon set, drawn as inline SVG.
 *
 * Every item in the game has a hand-built piece of art here. No emoji, no
 * glyph fonts, no sprite sheet: a fourteen-item HUD slot has to read at a
 * glance from the corner of a player's eye, and the only way to guarantee that
 * across platforms is to draw the shapes.
 *
 * The rules that keep them looking like one set:
 *   · One 64×64 box, one silhouette, filling ~90% of it.
 *   · A single dark outline (`INK`) at a constant 3.2 units on every shape —
 *     the sticker rim that lets any of them sit on a bright sky.
 *   · Flat fills plus one white gloss at 30–45% opacity, top-left. No
 *     gradients: they cost a paint, they wash out at 40 px, and flat colour is
 *     what makes an item legible in a rear-view mirror.
 *   · Hue separation before detail. A green shell and a red shell are the same
 *     drawing; the player is reading colour, so the colours are as far apart as
 *     the palette allows.
 */
import type { ReactElement } from "react";
import type { ItemKind } from "../types";

const INK = "#141d2c";

/** Shared sticker outline. Individual shapes opt out with `stroke="none"`. */
const OUTLINE = {
  stroke: INK,
  strokeWidth: 3.2,
  strokeLinejoin: "round" as const,
  strokeLinecap: "round" as const,
};

const GLOSS = "rgba(255,255,255,0.42)";

function Banana() {
  return (
    <g {...OUTLINE}>
      <path
        d="M12 47 C7 27 22 9 44 6 C49 5.4 51 11 46.5 13 C31 17 21.5 31 23.5 45 C24.6 52.5 16.5 53.5 12 47 Z"
        fill="#ffd83d"
      />
      <path d="M45 6.5 L50 3.5 L52.5 8.5 L47 11 Z" fill="#8a6a2f" />
      <path d="M13.5 48.5 C11 46 10 43 10.4 40" fill="none" stroke="#8a6a2f" strokeWidth={3.4} />
      <path d="M18 41 C15.5 27 25 15 39 11" fill="none" stroke={GLOSS} strokeWidth={4} />
    </g>
  );
}

function Shell({ body, dark, rim }: { body: string; dark: string; rim: string }) {
  return (
    <g {...OUTLINE}>
      <path d="M32 9 C47 9 58 20.5 58 34 L6 34 C6 20.5 17 9 32 9 Z" fill={body} />
      <path d="M22 34 C22 20 26 11 32 9.4 C38 11 42 20 42 34 Z" fill={dark} stroke="none" opacity={0.55} />
      <path d="M6 34 h52 a5 5 0 0 1 -1.5 8.4 C50 49 41 53 32 53 C23 53 14 49 7.5 42.4 A5 5 0 0 1 6 34 Z" fill={rim} />
      <ellipse cx={21} cy={19} rx={7} ry={4.4} fill={GLOSS} stroke="none" transform="rotate(-32 21 19)" />
    </g>
  );
}

function BlueShell() {
  return (
    <g {...OUTLINE}>
      <path d="M6 30 L1.5 22 L11 22.5 Z" fill="#ffd44d" />
      <path d="M58 30 L62.5 22 L53 22.5 Z" fill="#ffd44d" />
      <path d="M32 7 C47 7 58 19 58 33 L6 33 C6 19 17 7 32 7 Z" fill="#2f7bff" />
      <path d="M32 7 L27 33 h10 Z" fill="#0b47b8" stroke="none" opacity={0.7} />
      <path d="M6 33 h52 a5 5 0 0 1 -1.5 8.4 C50 48 41 52 32 52 C23 52 14 48 7.5 41.4 A5 5 0 0 1 6 33 Z" fill="#eef4ff" />
      <path d="M32 3.5 L35.5 10 h-7 Z" fill="#ffd44d" />
      <ellipse cx={20} cy={18} rx={6.5} ry={4} fill={GLOSS} stroke="none" transform="rotate(-32 20 18)" />
    </g>
  );
}

function Mushroom({ cap = "#ff4747", spot = "#fff4e2" }: { cap?: string; spot?: string }) {
  return (
    <g {...OUTLINE}>
      <path d="M22 36 h20 v10 c0 6.5 -4.4 9.5 -10 9.5 S22 52.5 22 46 Z" fill="#ffeccd" />
      <path d="M32 7 C49 7 59 20 59 31 C59 35.5 55 38 48.5 38 H15.5 C9 38 5 35.5 5 31 C5 20 15 7 32 7 Z" fill={cap} />
      <ellipse cx={20} cy={22} rx={7.5} ry={6} fill={spot} stroke="none" />
      <ellipse cx={43} cy={19} rx={6} ry={5} fill={spot} stroke="none" />
      <ellipse cx={32} cy={32} rx={5} ry={3.6} fill={spot} stroke="none" />
      <path d="M27 45.5 a2.6 2.6 0 1 1 0 0.1" fill={INK} stroke="none" />
      <path d="M37 45.5 a2.6 2.6 0 1 1 0 0.1" fill={INK} stroke="none" />
    </g>
  );
}

function TripleMushroom() {
  return (
    <g>
      <g transform="translate(4 24) scale(0.52)">
        <Mushroom />
      </g>
      <g transform="translate(28 24) scale(0.52)">
        <Mushroom />
      </g>
      <g transform="translate(16 -1) scale(0.56)">
        <Mushroom />
      </g>
    </g>
  );
}

const STAR_D =
  "M32 5 L39.4 22 L57.7 23.7 L43.6 35.9 L47.7 53.6 L32 44.2 L16.3 53.6 L20.4 35.9 L6.3 23.7 L24.6 22 Z";

function Star() {
  return (
    <g {...OUTLINE}>
      <path d={STAR_D} fill="#ffd93b" />
      <path d="M32 5 L39.4 22 L32 26 L24.6 22 Z" fill="#fff4b0" stroke="none" />
      <ellipse cx={24} cy={26} rx={4.6} ry={3} fill={GLOSS} stroke="none" transform="rotate(-24 24 26)" />
    </g>
  );
}

function Bobomb() {
  return (
    <g {...OUTLINE}>
      <path d="M30 17 C28 9 34 4 40 6" fill="none" stroke="#c8a25f" strokeWidth={4} />
      <path d="M41.5 2 l3 4 l4.5 -1.5 l-2 4.8 l4 3 l-5.2 0.6 l-0.8 4.8 l-3.3 -3.8 l-4.6 2 l1.6 -4.7 l-3.4 -3.6 l5 -0.4 Z" fill="#ffd93b" />
      <circle cx={32} cy={38} r={20} fill="#242b3d" />
      <ellipse cx={26.5} cy={35} rx={5} ry={6} fill="#fdfdff" />
      <ellipse cx={38} cy={35} rx={5} ry={6} fill="#fdfdff" />
      <circle cx={27.5} cy={36} r={2.3} fill={INK} stroke="none" />
      <circle cx={37} cy={36} r={2.3} fill={INK} stroke="none" />
      <path d="M20 54 h9 v3.5 h-9 Z" fill="#ffb03a" />
      <path d="M35 54 h9 v3.5 h-9 Z" fill="#ffb03a" />
      <ellipse cx={22} cy={28} rx={5} ry={3.4} fill="rgba(255,255,255,0.28)" stroke="none" transform="rotate(-30 22 28)" />
    </g>
  );
}

function Lightning() {
  return (
    <g {...OUTLINE}>
      <path d="M38 3 L13 33 H27 L23 61 L51 27 H35 Z" fill="#ffd41f" />
      <path d="M35 8 L19 30 H28 Z" fill="#fff6b8" stroke="none" />
    </g>
  );
}

function Boo() {
  return (
    <g {...OUTLINE}>
      <path
        d="M32 6 C46.5 6 55 17 55 32 C55 42 53 50 53 56 C48.5 51.5 46 56 42 58 C38.5 53.5 34.5 57.5 32 57.5 C29.5 57.5 25.5 53.5 22 58 C18 56 15.5 51.5 11 56 C11 50 9 42 9 32 C9 17 17.5 6 32 6 Z"
        fill="#fbfdff"
      />
      <ellipse cx={24} cy={28} rx={4.6} ry={6.2} fill={INK} stroke="none" />
      <ellipse cx={40} cy={28} rx={4.6} ry={6.2} fill={INK} stroke="none" />
      <path d="M24 40 C27 46 37 46 40 40 C37 44 27 44 24 40 Z" fill={INK} stroke="none" />
      <path d="M27 42 C29 48 35 48 37 42 Z" fill="#ff7d9e" stroke="none" />
      <ellipse cx={20} cy={17} rx={6} ry={4} fill="rgba(160,190,220,0.5)" stroke="none" transform="rotate(-28 20 17)" />
    </g>
  );
}

function Bullet() {
  return (
    <g {...OUTLINE}>
      <path d="M12 24 C6 26 2 30 2 32 C2 34 6 38 12 40 Z" fill="#ff9c2a" stroke="none" />
      <path d="M12 20 H36 C48 20 57 25 57 32 C57 39 48 44 36 44 H12 C9 44 7.5 42.5 7.5 40 V24 C7.5 21.5 9 20 12 20 Z" fill="#2b3247" />
      <ellipse cx={38} cy={30} rx={5} ry={6} fill="#fdfdff" />
      <ellipse cx={48} cy={30} rx={4.4} ry={5.4} fill="#fdfdff" />
      <circle cx={38.5} cy={31} r={2.2} fill={INK} stroke="none" />
      <circle cx={48} cy={31} r={2} fill={INK} stroke="none" />
      <path d="M22 44 v7 h7 v-7 Z" fill="#2b3247" />
      <ellipse cx={24} cy={26} rx={7} ry={3} fill="rgba(255,255,255,0.26)" stroke="none" />
    </g>
  );
}

function Coin({ face = "#ffd02e", edge = "#e08a12" }: { face?: string; edge?: string }) {
  return (
    <g {...OUTLINE}>
      <circle cx={32} cy={32} r={25} fill={face} />
      <ellipse cx={32} cy={32} rx={14} ry={19} fill="none" stroke={edge} strokeWidth={3.6} />
      <ellipse cx={23} cy={20} rx={5.4} ry={3.4} fill={GLOSS} stroke="none" transform="rotate(-32 23 20)" />
    </g>
  );
}

function FireFlower() {
  return (
    <g {...OUTLINE}>
      <path d="M32 34 V54" fill="none" stroke="#3fa63a" strokeWidth={6.5} />
      <path d="M32 44 C24 44 19 49 19 55 C27 55 32 51 32 44 Z" fill="#4fc148" />
      <path d="M32 40 C40 40 45 45 45 51 C37 51 32 47 32 40 Z" fill="#4fc148" />
      <circle cx={32} cy={11} r={9.5} fill="#ff8a1f" />
      <circle cx={14} cy={24} r={9.5} fill="#ff8a1f" />
      <circle cx={50} cy={24} r={9.5} fill="#ff8a1f" />
      <circle cx={22} cy={38} r={8.5} fill="#ff8a1f" />
      <circle cx={42} cy={38} r={8.5} fill="#ff8a1f" />
      <circle cx={32} cy={25} r={12} fill="#fff0c9" />
      <ellipse cx={27} cy={23} rx={2.6} ry={3.6} fill={INK} stroke="none" />
      <ellipse cx={37} cy={23} rx={2.6} ry={3.6} fill={INK} stroke="none" />
      <path d="M28 31 C30.5 33.5 33.5 33.5 36 31" fill="none" stroke={INK} strokeWidth={2.6} />
    </g>
  );
}

function Blooper() {
  return (
    <g {...OUTLINE}>
      <path d="M18 38 C15 46 12 50 8 54 C14 55 19 51 22 44 Z" fill="#eef4fb" />
      <path d="M46 38 C49 46 52 50 56 54 C50 55 45 51 42 44 Z" fill="#eef4fb" />
      <path d="M26 39 C25 48 24 53 22 58 C27 58 30 52 31 41 Z" fill="#f7fbff" />
      <path d="M38 39 C39 48 40 53 42 58 C37 58 34 52 33 41 Z" fill="#f7fbff" />
      <path d="M32 5 C45 5 53 16 53 28 C53 36 45 41 32 41 C19 41 11 36 11 28 C11 16 19 5 32 5 Z" fill="#fbfdff" />
      <ellipse cx={24} cy={24} rx={5.6} ry={7.4} fill={INK} stroke="none" />
      <ellipse cx={41} cy={24} rx={5.6} ry={7.4} fill={INK} stroke="none" />
      <circle cx={22} cy={21} r={2} fill="#fff" stroke="none" />
      <circle cx={39} cy={21} r={2} fill="#fff" stroke="none" />
      <ellipse cx={20} cy={13} rx={6} ry={3.6} fill="rgba(150,185,220,0.45)" stroke="none" transform="rotate(-28 20 13)" />
    </g>
  );
}

const ART: Record<ItemKind, () => ReactElement> = {
  banana: Banana,
  greenShell: () => <Shell body="#3fbf4a" dark="#1f8a2c" rim="#f4fff0" />,
  redShell: () => <Shell body="#ff4747" dark="#c41f27" rim="#fff2ef" />,
  blueShell: BlueShell,
  mushroom: () => <Mushroom />,
  tripleMushroom: TripleMushroom,
  star: Star,
  bobomb: Bobomb,
  lightning: Lightning,
  boo: Boo,
  bullet: Bullet,
  coin: () => <Coin />,
  fireflower: FireFlower,
  blooper: Blooper,
};

/** The one entry point the HUD uses. Unknown kinds draw nothing, never throw. */
export function ItemArt({ kind }: { kind: ItemKind }) {
  const Draw = ART[kind];
  if (!Draw) return null;
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <Draw />
    </svg>
  );
}

/** Every kind, in roulette order — the spin cycles this list. */
export const ROULETTE: ItemKind[] = [
  "banana",
  "greenShell",
  "mushroom",
  "redShell",
  "star",
  "bobomb",
  "coin",
  "boo",
  "fireflower",
  "lightning",
  "blooper",
  "tripleMushroom",
  "bullet",
  "blueShell",
];

// ---------------------------------------------------------------------------
// HUD glyphs
// ---------------------------------------------------------------------------

export function CoinGlyph() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <Coin />
    </svg>
  );
}

export function UTurnGlyph() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <g fill="none" stroke="#fff" strokeWidth={7} strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 52 V28 a12 12 0 0 1 24 0 v18" />
      </g>
      <path d="M42 58 L31 40 h22 Z" fill="#fff" />
    </svg>
  );
}

export function FlagGlyph() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect x={12} y={8} width={5} height={48} rx={2.5} fill="#e9eef7" />
      <g fill="#0e1726">
        <rect x={17} y={10} width={10} height={9} />
        <rect x={37} y={10} width={10} height={9} />
        <rect x={27} y={19} width={10} height={9} />
        <rect x={47} y={19} width={5} height={9} />
        <rect x={17} y={28} width={10} height={9} />
        <rect x={37} y={28} width={10} height={9} />
      </g>
      <g fill="#fdfdff">
        <rect x={27} y={10} width={10} height={9} />
        <rect x={47} y={10} width={5} height={9} />
        <rect x={17} y={19} width={10} height={9} />
        <rect x={37} y={19} width={10} height={9} />
        <rect x={27} y={28} width={10} height={9} />
        <rect x={47} y={28} width={5} height={9} />
      </g>
      <rect x={17} y={10} width={35} height={27} fill="none" stroke={INK} strokeWidth={2.6} />
    </svg>
  );
}

export function TrophyGlyph() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <g {...OUTLINE}>
        <path d="M16 8 h32 v14 c0 10 -7 17 -16 17 S16 32 16 22 Z" fill="#ffd02e" />
        <path d="M16 12 H8 v6 c0 6 4 9 9 9" fill="none" stroke="#e08a12" strokeWidth={4} />
        <path d="M48 12 h8 v6 c0 6 -4 9 -9 9" fill="none" stroke="#e08a12" strokeWidth={4} />
        <path d="M27 39 h10 v7 h-10 Z" fill="#e6a11c" />
        <path d="M19 46 h26 a3 3 0 0 1 3 3 v5 H16 v-5 a3 3 0 0 1 3 -3 Z" fill="#ffd02e" />
      </g>
    </svg>
  );
}

export function SoundGlyph({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <path d="M12 24 h10 L36 12 v40 L22 40 H12 Z" fill="currentColor" />
      {on ? (
        <g fill="none" stroke="currentColor" strokeWidth={4.5} strokeLinecap="round">
          <path d="M43 24 a12 12 0 0 1 0 16" />
          <path d="M50 18 a20 20 0 0 1 0 28" />
        </g>
      ) : (
        <g stroke="currentColor" strokeWidth={5} strokeLinecap="round">
          <path d="M44 24 L58 40" />
          <path d="M58 24 L44 40" />
        </g>
      )}
    </svg>
  );
}
