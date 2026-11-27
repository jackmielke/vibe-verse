/**
 * The win: every card leaps off the foundations one after another and
 * bounces across the table, leaving a trail of itself behind.
 *
 * It is a canvas that is never cleared, so each frame stamps every live card
 * on top of the last frame. That is the whole trick, and it is why it looks
 * like it does. Cards are painted once each into small offscreen canvases.
 */
import { isRed, RANK_LABEL, SUIT_GLYPH, type Card } from "./cards";
import type { Theme } from "./themes";

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function paintCard(card: Pick<Card, "rank" | "suit">, w: number, h: number, theme: Theme, dpr: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.ceil(w * dpr);
  c.height = Math.ceil(h * dpr);
  const ctx = c.getContext("2d")!;
  ctx.scale(dpr, dpr);
  const r = w * 0.09;
  roundRect(ctx, 0.5, 0.5, w - 1, h - 1, r);
  ctx.fillStyle = theme.faceFill;
  ctx.fill();
  ctx.strokeStyle = theme.faceEdge;
  ctx.lineWidth = 1;
  ctx.stroke();
  const col = isRed(card.suit) ? theme.red : theme.black;
  ctx.fillStyle = col;
  ctx.textBaseline = "top";
  ctx.font = `800 ${w * 0.3}px ${theme.font}`;
  ctx.fillText(RANK_LABEL[card.rank], w * 0.08, h * 0.05);
  ctx.font = `${w * 0.26}px ${theme.font}`;
  ctx.fillText(SUIT_GLYPH[card.suit], w * 0.08, h * 0.05 + w * 0.32);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${w * 0.55}px ${theme.font}`;
  ctx.fillText(SUIT_GLYPH[card.suit], w * 0.56, h * 0.62);
  return c;
}

export interface CascadeStart {
  x: number;
  y: number;
  cards: Card[];
}

/**
 * Run the cascade. Returns a stop function. `onDone` fires once every card
 * has left the screen (or after a hard time limit).
 */
export function runCascade(
  canvas: HTMLCanvasElement,
  theme: Theme,
  starts: CascadeStart[],
  cardW: number,
  cardH: number,
  onDone: () => void,
): () => void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  // Kings first, round the foundations, like the cards are being dealt off.
  const queue: { img: HTMLCanvasElement; x: number; y: number }[] = [];
  const maxLen = Math.max(...starts.map((s) => s.cards.length));
  for (let i = maxLen - 1; i >= 0; i--) {
    for (const s of starts) {
      const c = s.cards[i];
      if (c) queue.push({ img: paintCard(c, cardW, cardH, theme, dpr), x: s.x, y: s.y });
    }
  }

  const scale = Math.max(0.7, Math.min(1.6, W / 700));
  type Live = { img: HTMLCanvasElement; x: number; y: number; vx: number; vy: number };
  const live: Live[] = [];
  let next = 0;
  let launchAt = 0;
  let raf = 0;
  let last = performance.now();
  let stopped = false;
  const started = last;

  const frame = (now: number) => {
    if (stopped) return;
    const dt = Math.min(2.5, (now - last) / 16.67);
    last = now;
    if (next < queue.length && now >= launchAt) {
      const q = queue[next++];
      const dir = Math.random() < 0.5 ? -1 : 1;
      live.push({ img: q.img, x: q.x, y: q.y, vx: dir * (2.5 + Math.random() * 4.5) * scale, vy: -(Math.random() * 6) * scale });
      launchAt = now + 140;
    }
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i];
      p.vy += 0.55 * scale * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.y + cardH > H) {
        p.y = H - cardH;
        p.vy = -Math.abs(p.vy) * (0.72 + Math.random() * 0.1);
      }
      ctx.drawImage(p.img, p.x, p.y, cardW, cardH);
      if (p.x < -cardW - 4 || p.x > W + 4) live.splice(i, 1);
    }
    if ((next >= queue.length && live.length === 0) || now - started > 30000) {
      stopped = true;
      onDone();
      return;
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
}
