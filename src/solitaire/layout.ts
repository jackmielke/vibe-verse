/**
 * Where every card sits, as a pure function of the state and the table size.
 *
 * The page renders each card absolutely at the position this returns and lets
 * a CSS transition carry it when the position changes. Nothing here knows
 * about the DOM, which is what lets the same layout serve both games and lets
 * the hit testing for drops use exactly the rectangles that were drawn.
 */
import type { Card } from "./cards";
import type { BaseState } from "./rules";

export type GameKind = "klondike" | "freecell";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pos {
  x: number;
  y: number;
  z: number;
  pile: string;
  index: number;
}

export interface Layout {
  cw: number;
  ch: number;
  gap: number;
  slots: Record<string, { x: number; y: number }>;
  pileRects: Record<string, Rect>;
  positions: Map<number, Pos>;
  /** Where the deal comes from. */
  dealFrom: { x: number; y: number };
  /** Tableau keys, for the page's own use. */
  tableau: string[];
  top: string[];
}

const TOP: Record<GameKind, (string | null)[]> = {
  klondike: ["stock", "waste", null, "f0", "f1", "f2", "f3"],
  freecell: ["c0", "c1", "c2", "c3", "f0", "f1", "f2", "f3"],
};

const TAB: Record<GameKind, string[]> = {
  klondike: ["t0", "t1", "t2", "t3", "t4", "t5", "t6"],
  freecell: ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"],
};

export const CARD_RATIO = 1.42;

export function layoutTable(
  kind: GameKind,
  s: BaseState,
  W: number,
  H: number,
  opts: { draw?: 1 | 3 } = {},
): Layout {
  const top = TOP[kind];
  const tab = TAB[kind];
  const cols = tab.length;
  const gap = Math.max(4, Math.min(14, W * 0.012));
  const pad = gap;
  const byWidth = (W - 2 * pad - (cols - 1) * gap) / cols;
  const rowGapFor = (ch: number) => Math.max(gap * 1.5, ch * 0.16);
  // Height: the top row, a gap, then room for a decent fan below.
  const byHeight = (H - 2 * pad) / (3.6 + 0.16) / CARD_RATIO;
  const cw = Math.max(28, Math.floor(Math.min(byWidth, byHeight, 124)));
  const ch = Math.round(cw * CARD_RATIO);
  const rowGap = rowGapFor(ch);
  const totalW = cols * cw + (cols - 1) * gap;
  const left = Math.round((W - totalW) / 2);
  const colX = (i: number) => left + i * (cw + gap);
  const topY = pad;
  const tabY = Math.round(topY + ch + rowGap);

  const slots: Record<string, { x: number; y: number }> = {};
  top.forEach((k, i) => {
    if (k) slots[k] = { x: colX(i), y: topY };
  });
  tab.forEach((k, i) => (slots[k] = { x: colX(i), y: tabY }));

  const positions = new Map<number, Pos>();
  const pileRects: Record<string, Rect> = {};
  const order = Object.keys(slots);
  const put = (c: Card, x: number, y: number, pile: string, index: number) => {
    positions.set(c.id, { x, y, z: order.indexOf(pile) * 60 + index + 1, pile, index });
  };

  for (const k of top) {
    if (!k) continue;
    const pile = s.piles[k] ?? [];
    const { x, y } = slots[k];
    if (k === "waste") {
      const visible = opts.draw === 3 ? 3 : 1;
      const fanX = Math.min(cw * 0.32, (cw + gap) * 0.45);
      const firstFan = Math.max(0, pile.length - visible);
      pile.forEach((c, i) => {
        const fx = i >= firstFan ? (i - firstFan) * fanX : 0;
        put(c, x + fx, y, k, i);
      });
      const lastX = pile.length ? x + Math.max(0, Math.min(visible, pile.length) - 1) * fanX : x;
      pileRects[k] = { x, y, w: lastX - x + cw, h: ch };
    } else {
      pile.forEach((c, i) => put(c, x, y, k, i));
      pileRects[k] = { x, y, w: cw, h: ch };
    }
  }

  const avail = H - tabY - pad;
  // A tall table (a phone held upright) gets a more generous fan, so the
  // columns use the height instead of leaving half the screen empty.
  const roomy = (avail - ch) / 13;
  const baseUp = Math.min(ch * 0.46, Math.max(ch * 0.3, roomy));
  const baseDown = Math.min(ch * 0.2, Math.max(ch * 0.13, roomy * 0.45));
  for (const k of tab) {
    const pile = s.piles[k] ?? [];
    const { x, y } = slots[k];
    const nDown = pile.filter((c) => !c.up).length;
    const nUp = pile.length - nDown;
    let down = baseDown;
    let up = baseUp;
    const need = (d: number, u: number) => ch + nDown * d + Math.max(0, nUp - 1) * u - (nUp === 0 && nDown > 0 ? d : 0);
    if (pile.length > 1 && need(down, up) > avail) {
      // Squeeze the face-down cards first (nobody needs to read them), then
      // the face-up fan, which must keep enough of each card to read it.
      if (nDown > 0) {
        down = Math.max(ch * 0.05, (avail - ch - Math.max(0, nUp - 1) * up) / nDown);
      }
      if (need(down, up) > avail && nUp > 1) {
        up = Math.max(ch * 0.17, (avail - ch - nDown * down) / (nUp - 1));
      }
    }
    let cy = y;
    pile.forEach((c, i) => {
      put(c, x, cy, k, i);
      cy += c.up ? up : down;
    });
    const last = pile.length ? positions.get(pile[pile.length - 1].id)!.y : y;
    pileRects[k] = { x, y, w: cw, h: last - y + ch };
  }

  const dealFrom = kind === "klondike" ? slots.stock : { x: Math.round(W / 2 - cw / 2), y: H + ch };
  return { cw, ch, gap, slots, pileRects, positions, dealFrom, tableau: tab, top: top.filter(Boolean) as string[] };
}

export function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
