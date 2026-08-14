/**
 * Recording a world playing itself, as an animated GIF.
 *
 * A build-time tool, not part of the app — nothing imports this, the same way
 * nothing imports `characterShot.ts`. `scripts/route-gif.mjs` opens the dev
 * server, drives a route, and calls the function this file hangs on `window`.
 *
 * ## Why a GIF, when a GIF is the worst video codec
 *
 * Because the card is an `<img>`. `src/worlds/art.ts` maps a world key to an
 * image URL and eleven surfaces draw it; a `<video>` would mean touching all of
 * them, and a WebM would mean deciding what iOS 16 sees. A GIF is a drop-in
 * replacement for the JPEG that is already there, which is the difference
 * between "the cards can move now" and a refactor.
 *
 * The cost is real and it is why `Card` keeps the still as a poster and only
 * fetches this on hover: a GIF of gameplay is a third of a megabyte, and
 * fifty-two of them on the front door would be indefensible.
 *
 * ## Why the frames are captured in the page
 *
 * The obvious version is `page.screenshot()` in a loop, and it does not work
 * here for two reasons. It is slow enough that the frame interval wobbles —
 * gameplay recorded at "12fps" arrives at 7 to 14 — and every frame comes back
 * as a PNG that something then has to decode, which needs a decoder this
 * container does not have. Reading the game's own canvas with `getImageData`
 * skips both: raw RGBA, no encode/decode round trip, and a capture loop that
 * rides the same `requestAnimationFrame` the game does.
 *
 * ## One palette, not one per frame
 *
 * `quantize` per frame is the usual way and it shimmers: each frame picks its
 * own best 128 colours, so a background that is not moving still crawls,
 * because its exact greys changed. The palette here is computed once from
 * pixels sampled across the whole recording, and every frame is mapped into it.
 * Slightly worse on any single frame, much better on all of them.
 */
import { GIFEncoder, applyPalette, quantize } from "gifenc";

export interface GifOptions {
  /** How long to record, in ms. */
  ms?: number;
  /** Frames per second. GIF delays are centisecond-quantised — 12.5 and 20 are exact. */
  fps?: number;
  /** Output width. Height follows the source aspect ratio. */
  width?: number;
  /** Palette size, 2–256. Fewer colours is a smaller file and more banding. */
  colors?: number;
}

/** Progress, so a capture that takes twenty seconds is not a blank terminal. */
declare global {
  interface Window {
    __recordGif?: (opts?: GifOptions) => Promise<string>;
    __gifProgress?: { phase: string; done: number; total: number };
  }
}

/** The canvas the world is drawing into — the biggest one on the page. */
function gameCanvas(): HTMLCanvasElement | null {
  const all = [...document.querySelectorAll("canvas")];
  if (!all.length) return null;
  return all.reduce((best, c) =>
    c.clientWidth * c.clientHeight > best.clientWidth * best.clientHeight ? c : best,
  );
}

export async function recordGif(opts: GifOptions = {}): Promise<string> {
  const ms = opts.ms ?? 3000;
  const fps = opts.fps ?? 12.5;
  const outW = opts.width ?? 400;
  const colors = opts.colors ?? 128;

  const src = gameCanvas();
  if (!src) throw new Error("no canvas on this page");

  const aspect = src.clientHeight / src.clientWidth || 9 / 16;
  const w = Math.round(outW / 2) * 2;
  const h = Math.round((outW * aspect) / 2) * 2;

  const scratch = document.createElement("canvas");
  scratch.width = w;
  scratch.height = h;
  /* `willReadFrequently` — without it Chrome keeps the surface on the GPU and
     every `getImageData` is a stall that costs more than the frame interval. */
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");

  /**
   * Sampled faster than the output rate, then deduplicated.
   *
   * A fixed clock assumes the world renders at least as fast as we ask, and
   * under software rendering it does not: at 12.5fps COIL gave nineteen frames
   * of which seven were distinct, because three captures in a row landed on the
   * same painted frame. Those duplicates are not free — they are full frames in
   * the file — and they encode a lie about timing, since the GIF then claims
   * motion happened during a gap where nothing did.
   *
   * So: sample at twice the requested rate, and when a frame is identical to
   * the one before it, extend that frame's delay instead of writing another.
   * The result is fewer frames, a smaller file, and delays that describe what
   * actually happened rather than what was asked for.
   */
  const grabbed: { data: Uint8ClampedArray; t: number }[] = [];
  let lastKey = -1;

  window.__gifProgress = { phase: "capture", done: 0, total: Math.round(ms) };

  const t0 = performance.now();
  let elapsed = 0;
  while (elapsed < ms) {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const now = performance.now();
    elapsed = now - t0;

    ctx.drawImage(src, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    /**
     * The red channel of every pixel.
     *
     * This was every *sixteenth* pixel, which is plenty to notice a scene
     * change and nowhere near enough to notice a snake moving two pixels — so
     * genuinely different frames were being merged as duplicates and a
     * seventeen-frame-per-second recording came out at five. A full readback
     * costs about 5ms here and this loop adds under one; the sparse version was
     * saving nothing and losing the animation.
     */
    let key = 0;
    for (let p = 0; p < data.length; p += 4) key = (key * 31 + data[p]) >>> 0;

    // A repeat means the world did not repaint; there is nothing new to store.
    if (key !== lastKey) {
      grabbed.push({ data, t: now });
      lastKey = key;
    }
    window.__gifProgress = { phase: "capture", done: Math.round(elapsed), total: Math.round(ms) };
  }

  if (grabbed.length < 2) throw new Error("nothing on this page moved");

  /**
   * Real delays, measured, and `fps` as a ceiling rather than a clock.
   *
   * Capturing on every animation frame and timestamping is the only way to get
   * this right: asking for frames on a fixed schedule assumes the world can
   * keep up, and a GIF whose delays say 80ms over content that advanced 140ms
   * plays in slow motion — the most common way these come out wrong.
   *
   * If the world turned out to be faster than the requested rate, frames are
   * dropped evenly and their time is given to the frames that remain, so the
   * clip still lasts exactly as long as it did in life.
   */
  const spanMs = grabbed[grabbed.length - 1].t - grabbed[0].t;
  const maxFrames = Math.max(2, Math.round((spanMs / 1000) * fps));
  const step = Math.max(1, Math.ceil(grabbed.length / maxFrames));

  const frames: { data: Uint8ClampedArray; delay: number }[] = [];
  for (let i = 0; i < grabbed.length; i += step) {
    const next = grabbed[Math.min(i + step, grabbed.length - 1)];
    const delay = i + step >= grabbed.length
      ? spanMs / Math.max(1, Math.floor(grabbed.length / step))
      : next.t - grabbed[i].t;
    frames.push({ data: grabbed[i].data, delay });
  }

  /* One palette for the whole clip. Sampled from a spread of frames rather
     than all of them — quantizing a megabyte of pixels is slow and the answer
     does not improve after the first few thousand distinct colours. */
  window.__gifProgress = { phase: "palette", done: 0, total: 1 };
  const sampleStride = Math.max(1, Math.floor(frames.length / 8));
  const sample: number[] = [];
  for (let i = 0; i < frames.length; i += sampleStride) {
    const f = frames[i].data;
    // Every 4th pixel of every sampled frame: enough to see the palette.
    for (let p = 0; p < f.length; p += 16) {
      sample.push(f[p], f[p + 1], f[p + 2], 255);
    }
  }
  const palette = quantize(new Uint8ClampedArray(sample), colors, { format: "rgb565" });

  const gif = GIFEncoder();
  for (let i = 0; i < frames.length; i++) {
    const index = applyPalette(frames[i].data, palette, "rgb565");
    /* Centiseconds, and never below 2: every browser silently rewrites a delay
       of 0 or 1 to 10cs, so a frame that asks for 1 plays ten times too slow —
       the one GIF quirk that makes a correct encoder look broken. */
    const delay = Math.max(2, Math.round(frames[i].delay / 10)) * 10;
    gif.writeFrame(index, w, h, { palette: i === 0 ? palette : undefined, delay });
    window.__gifProgress = { phase: "encode", done: i + 1, total: frames.length };
  }
  gif.finish();

  const bytes = gif.bytes();
  /* Chunked — `String.fromCharCode(...bytes)` on a 400 KB array blows the
     argument limit and throws, which reads as "the encoder failed". */
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  window.__gifProgress = { phase: "done", done: 1, total: 1 };
  return `data:image/gif;base64,${btoa(binary)}`;
}

if (typeof window !== "undefined") window.__recordGif = recordGif;
