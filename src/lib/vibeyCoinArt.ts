/**
 * The Vibey Coin's face, drawn on a 2D canvas.
 *
 * The same coin as `VibeCoinMark` (the chip in the corner): a dark teal face,
 * a mint-to-sky rim, and a raised ✦. Worlds that scatter coins to pick up draw
 * this, so the thing you grab and the counter it lands in look like one coin.
 * `vibeyCoin3d.ts` wraps it as a texture for three.js; canvas worlds draw it
 * directly.
 */

/** Draw a Vibey Coin face centred on (cx, cy) with radius r. */
export function drawVibeyCoin(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const s = r / 15; // VibeCoinMark is authored on a 32 box with a radius of 15

  const rim = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  rim.addColorStop(0, "#eafff8");
  rim.addColorStop(0.38, "#7dffd4");
  rim.addColorStop(0.62, "#59b8ff");
  rim.addColorStop(1, "#0d6b5c");
  ctx.fillStyle = rim;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  const fr = 12.4 * s;
  const face = ctx.createRadialGradient(cx - 0.16 * 2 * fr, cy - 0.24 * 2 * fr, 0, cx - 0.16 * 2 * fr, cy - 0.24 * 2 * fr, fr * 1.6);
  face.addColorStop(0, "#1d6f60");
  face.addColorStop(0.55, "#0d4a41");
  face.addColorStop(1, "#06251f");
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.arc(cx, cy, fr, 0, Math.PI * 2);
  ctx.fill();

  // Milled edge.
  ctx.strokeStyle = "rgba(4,50,43,0.35)";
  ctx.lineWidth = 1.4 * s;
  ctx.lineCap = "round";
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 12.9 * s, cy + Math.sin(a) * 12.9 * s);
    ctx.lineTo(cx + Math.cos(a) * 14.5 * s, cy + Math.sin(a) * 14.5 * s);
    ctx.stroke();
  }

  // The ✦, as a path rather than a glyph so it never depends on a font.
  const star = (ox: number, oy: number, fill: string) => {
    const R = 8.6 * s;
    const k = 0.26;
    ctx.fillStyle = fill;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 4;
      const rr = i % 2 === 0 ? R : R * k;
      const x = cx + ox + Math.cos(a) * rr;
      const y = cy + oy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  };
  star(0, 1.3 * s, "rgba(2,32,27,0.85)");
  star(0, 0, "#9dffe0");

  // Specular sweep.
  ctx.save();
  ctx.translate(cx - 4 * s, cy - 5.5 * s);
  ctx.rotate((-28 * Math.PI) / 180);
  const shine = ctx.createLinearGradient(0, -4.6 * s, 0, 4.6 * s);
  shine.addColorStop(0, "rgba(255,255,255,0.28)");
  shine.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = shine;
  ctx.beginPath();
  ctx.ellipse(0, 0, 7.5 * s, 4.6 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

const cached = new Map<number, HTMLCanvasElement>();

/** A square canvas holding one coin face, shared by everybody who asks. */
export function vibeyCoinCanvas(size = 256): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const hit = cached.get(size);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  drawVibeyCoin(ctx, size / 2, size / 2, size / 2 - 1);
  cached.set(size, c);
  return c;
}

/** The coin face as a PNG data URL, for worlds that load sprites by URL. */
export function vibeyCoinDataUrl(size = 128): string {
  const c = vibeyCoinCanvas(size);
  return c ? c.toDataURL("image/png") : "";
}
