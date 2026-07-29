/**
 * Directional damage.
 *
 * The crosshair carries a tight hit-direction arc for micro-corrections; this
 * is the macro version — a wide, soft wedge out near the edge of the frame
 * that tells you which way to turn before you have finished flinching.
 *
 * Sized in viewport units so it lands in the same place on a 16:10 laptop and
 * an ultrawide, and pooled so an ambush from four directions costs four
 * attribute writes rather than four mounts.
 */
import { useEffect, useRef, useState } from "react";
import { frame } from "../../state/store";
import { useUiFrame } from "../raf";
import { useUiStore } from "../uiStore";
import { cvdColor, rgba } from "../theme";

const SLOTS = 5;

interface Wedge {
  t: number;
  dir: number;
  weight: number;
}

export interface DamageHandle {
  damage(direction: number, amount: number): void;
}

export default function DamageIndicators({
  handleRef,
}: {
  handleRef?: { current: DamageHandle | null };
}) {
  const cvd = useUiStore((s) => s.settings.colorblind);
  const reduceFlash = useUiStore((s) => s.settings.reduceFlashing);
  const [size, setSize] = useState(() => ({
    w: typeof window === "undefined" ? 1920 : window.innerWidth,
    h: typeof window === "undefined" ? 1080 : window.innerHeight,
  }));

  const refs = useRef<(SVGPathElement | null)[]>([]);
  const state = useRef({
    wedges: Array.from({ length: SLOTS }, (): Wedge => ({ t: 0, dir: 0, weight: 0 })),
    head: 0,
  });

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (handleRef) {
    handleRef.current = {
      damage(direction: number, amount: number) {
        const s = state.current;
        const w = s.wedges[s.head];
        s.head = (s.head + 1) % SLOTS;
        w.t = 1;
        w.dir = direction;
        w.weight = Math.max(0.3, Math.min(1, amount / 35));
      },
    };
  }

  useUiFrame((_, dt) => {
    const s = state.current;
    const yaw = frame.yaw;
    for (let i = 0; i < SLOTS; i++) {
      const w = s.wedges[i];
      const el = refs.current[i];
      if (!el) continue;
      if (w.t <= 0) {
        if (el.style.opacity !== "0") el.style.opacity = "0";
        continue;
      }
      // Just over a second of life: long enough to act on, short enough that
      // a firefight does not paint the whole border red permanently.
      w.t = Math.max(0, w.t - dt * 0.8);
      const rel = ((w.dir - yaw) * 180) / Math.PI;
      // Ease-out on the tail; instant on the attack.
      const a = w.t * w.t;
      const peak = reduceFlash ? 0.45 : 0.85;
      el.style.opacity = (a * peak * (0.5 + 0.5 * w.weight)).toFixed(3);
      el.style.transform = `rotate(${rel.toFixed(1)}deg)`;
    }
  });

  const danger = cvdColor("danger", cvd);
  const cx = size.w / 2;
  const cy = size.h / 2;
  const r = Math.min(size.w, size.h) * 0.46;
  const d = wedgePath(r, r * 1.55, 62);

  return (
    <svg
      className="fixed inset-0 pointer-events-none"
      width={size.w}
      height={size.h}
      style={{ zIndex: 12 }}
      aria-hidden
    >
      <defs>
        <radialGradient id="sf-dmg-grad" cx="50%" cy="50%" r="50%">
          <stop offset="45%" stopColor={rgba(danger, 0)} />
          <stop offset="72%" stopColor={rgba(danger, 0.55)} />
          <stop offset="100%" stopColor={rgba(danger, 0)} />
        </radialGradient>
      </defs>
      <g transform={`translate(${cx},${cy})`}>
        {Array.from({ length: SLOTS }, (_, i) => (
          <path
            key={i}
            ref={(el) => (refs.current[i] = el)}
            d={d}
            fill="url(#sf-dmg-grad)"
            style={{ opacity: 0, transformOrigin: "0 0", filter: "blur(2px)" }}
          />
        ))}
      </g>
    </svg>
  );
}

/** An annular wedge centred on straight-up (screen "forward"). */
function wedgePath(rInner: number, rOuter: number, deg: number): string {
  const half = ((deg * 0.5) * Math.PI) / 180;
  const p = (a: number, r: number): [number, number] => [Math.sin(a) * r, -Math.cos(a) * r];
  const [x0, y0] = p(-half, rInner);
  const [x1, y1] = p(half, rInner);
  const [x2, y2] = p(half, rOuter);
  const [x3, y3] = p(-half, rOuter);
  return (
    `M ${x0.toFixed(1)} ${y0.toFixed(1)} ` +
    `A ${rInner.toFixed(1)} ${rInner.toFixed(1)} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)} ` +
    `L ${x2.toFixed(1)} ${y2.toFixed(1)} ` +
    `A ${rOuter.toFixed(1)} ${rOuter.toFixed(1)} 0 0 0 ${x3.toFixed(1)} ${y3.toFixed(1)} Z`
  );
}
