/**
 * The galaxy behind the front door.
 *
 * `/game` is the page whose entire argument is that it paints in a frame, so
 * the background it sits on has to be nearly free. Three ways to draw a
 * starfield and only one of them is:
 *
 * - **WebGL** is out on principle. Browsers cap live contexts at around
 *   sixteen, this repo already loses worlds to that ceiling, and spending one
 *   of them on wallpaper — on the page people open *before* opening a world —
 *   is the cheapest possible way to break the next thing they click.
 * - **CSS `box-shadow` dots** is the usual trick and it is a trap: six hundred
 *   shadows on one element is a single enormous paint the compositor redoes on
 *   every scroll, and it lands as jank on exactly the phones that need help.
 * - **A canvas, painted once**, is what this is. No `requestAnimationFrame`, no
 *   timer, no state. It draws when it mounts and when the window changes size,
 *   and then it is a picture the GPU holds and never thinks about again.
 *
 * ## It holds still, on purpose
 *
 * Twinkle and parallax drift both looked good for about a minute. `VibeWink`
 * already learned this one and wrote it down: a thing moving in the corner of
 * your eye is charming exactly once and then it is on every page forever. The
 * depth here comes from three star sizes and two nebula washes, which read as
 * distance without anything having to move.
 *
 * ## The seed
 *
 * Star positions come from a fixed seed rather than `Math.random()`, so the sky
 * is the same sky on every visit and every resize. A background that reshuffles
 * when you rotate your phone is a background you notice, and noticing the
 * background is the one thing it must not do.
 */
import { useEffect, useRef } from "react";

/** Small deterministic PRNG — same sky every time, no dependency. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Props {
  /** Stars per million CSS pixels — density, so a laptop and a phone match. */
  density?: number;
  /** Change it for a different sky. Stable across renders and resizes. */
  seed?: number;
  className?: string;
}

export default function StarField({ density = 190, seed = 0x5eed, className = "" }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const paint = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      /* Capped at 2: beyond that a starfield is paying four times the pixels
         to render dots that are already sub-pixel. */
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const rand = mulberry32(seed);
      const count = Math.round((w * h * density) / 1_000_000);

      for (let i = 0; i < count; i++) {
        const x = rand() * w;
        const y = rand() * h;
        const roll = rand();
        /* Three populations, not a continuum. A handful of bright ones give
           the eye something to land on; the rest are dust. */
        const r = roll > 0.985 ? 1.5 : roll > 0.9 ? 1 : 0.6;
        const alpha = roll > 0.985 ? 0.85 : roll > 0.9 ? 0.5 : 0.22;
        /* Cool white drifting to mint or violet, matching the two washes the
           page already lays over this. */
        const tint = rand();
        const color =
          tint > 0.88
            ? `rgba(160, 255, 220, ${alpha})`
            : tint > 0.76
              ? `rgba(196, 178, 255, ${alpha})`
              : `rgba(226, 236, 255, ${alpha})`;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    paint();

    /* Only a size change matters, and ResizeObserver fires on the element
       rather than on every window event the page might see. */
    const ro =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => paint());
    ro?.observe(canvas);
    if (!ro) window.addEventListener("resize", paint);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", paint);
    };
  }, [density, seed]);

  return (
    <canvas
      ref={ref}
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
      aria-hidden
    />
  );
}
