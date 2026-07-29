/**
 * Health, read as a shape before it is read as a number.
 *
 * A plain bar makes the player do arithmetic. This block encodes state three
 * ways at once so it can be parsed in peripheral vision mid-firefight:
 *   - COUNT: six slanted segments; you see how many are gone.
 *   - COLOUR: three banded states with short crossfades, not a smooth ramp.
 *   - SHAPE: below a third, the frame itself breaks — the outline goes
 *     jagged, the segments skew harder, and the whole block starts to breathe.
 *
 * Health also regenerates, so the numbers move constantly. Nothing here goes
 * through React: the store is read non-reactively inside the shared rAF.
 */
import { useRef } from "react";
import { PLAYER } from "../../config";
import { sf } from "../../state/store";
import { useUiFrame, setText, approach } from "../raf";
import { useUiStore } from "../uiStore";
import { healthColor, cvdColor, rgba } from "../theme";

const SEGMENTS = 6;

export default function Vitals() {
  const cvd = useUiStore((s) => s.settings.colorblind);

  const numRef = useRef<HTMLSpanElement>(null);
  const stateRef = useRef<HTMLSpanElement>(null);
  const frameRef = useRef<SVGGElement>(null);
  const regenRef = useRef<SVGRectElement>(null);
  const segRefs = useRef<(SVGRectElement | null)[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  const anim = useRef({ shown: 1, last: 1, regen: 0, pulse: 0 });

  useUiFrame((now, dt) => {
    const s = sf();
    const frac = Math.max(0, Math.min(1, s.health / Math.max(1, s.maxHealth)));
    const a = anim.current;

    // Damage snaps (you must feel it), healing eases (it should feel like
    // relief, not a jump-cut).
    a.shown = frac < a.shown ? approach(a.shown, frac, 26, dt) : approach(a.shown, frac, 7, dt);
    const rising = frac > a.last + 1e-4;
    a.regen = approach(a.regen, rising ? 1 : 0, 8, dt);
    a.last = frac;

    const col = healthColor(frac, cvd);
    const critical = frac <= 0.28;
    a.pulse = critical ? (Math.sin(now * 5.2) * 0.5 + 0.5) : 0;

    for (let i = 0; i < SEGMENTS; i++) {
      const el = segRefs.current[i];
      if (!el) continue;
      const fill = Math.max(0, Math.min(1, a.shown * SEGMENTS - i));
      // Segments empty from the right; the leading one drains continuously so
      // small hits still read.
      el.style.transformOrigin = "left center";
      el.style.transform = `scaleX(${fill.toFixed(3)})`;
      el.style.fill = col;
      el.style.opacity = fill > 0.02 ? "1" : "0";
    }

    if (frameRef.current) {
      // The frame skews and glows harder as the state degrades — the "shape"
      // channel of the read.
      const skew = critical ? -14 - a.pulse * 2.5 : -12;
      frameRef.current.style.transform = `skewX(${skew}deg)`;
      frameRef.current.style.filter = critical
        ? `drop-shadow(0 0 ${(6 + a.pulse * 10).toFixed(1)}px ${rgba(cvdColor("danger", cvd), 0.85)})`
        : "none";
    }

    if (regenRef.current) {
      regenRef.current.style.opacity = (a.regen * 0.9).toFixed(2);
      regenRef.current.style.transform = `translateX(${(a.shown * 186).toFixed(1)}px)`;
    }

    setText(numRef.current, String(Math.max(0, Math.ceil(s.health))));
    if (numRef.current) numRef.current.style.color = col;

    const label = frac <= 0.001 ? "DOWN" : critical ? "CRITICAL" : frac < 0.62 ? "WOUNDED" : "NOMINAL";
    setText(stateRef.current, label);
    if (stateRef.current) {
      stateRef.current.style.color = critical ? cvdColor("danger", cvd) : "rgba(255,255,255,0.5)";
    }

    if (rootRef.current) {
      // A tiny, low-frequency drift when critical. Enough to catch the eye,
      // not enough to make the number hard to read.
      rootRef.current.style.transform = critical
        ? `translateX(${(Math.sin(now * 11) * a.pulse * 1.1).toFixed(2)}px)`
        : "";
    }
  });

  return (
    <div ref={rootRef} className="relative" style={{ width: 214 }}>
      <div className="flex items-end gap-3 mb-1.5">
        <span
          ref={numRef}
          className="sf-num sf-text-hard leading-none"
          style={{ fontSize: 34, fontWeight: 800, letterSpacing: "-0.04em" }}
        >
          100
        </span>
        <div className="flex flex-col pb-1">
          <span className="sf-label sf-text" style={{ fontSize: 9, letterSpacing: "0.22em" }}>
            VITALS
          </span>
          <span ref={stateRef} className="sf-label sf-text" style={{ fontSize: 9 }}>
            NOMINAL
          </span>
        </div>
      </div>

      <svg width={214} height={16} viewBox="0 0 214 16" style={{ display: "block", overflow: "visible" }}>
        <g ref={frameRef} style={{ transformOrigin: "left center" }}>
          {/* Track. Slightly wider than the segments so the empty state still
              draws a shape rather than nothing. */}
          {Array.from({ length: SEGMENTS }, (_, i) => (
            <rect
              key={`t${i}`}
              x={i * 32}
              y={2}
              width={30}
              height={9}
              fill="rgba(0,0,0,0.55)"
              stroke="rgba(255,255,255,0.16)"
              strokeWidth={1}
            />
          ))}
          {Array.from({ length: SEGMENTS }, (_, i) => (
            <rect
              key={`s${i}`}
              ref={(el) => (segRefs.current[i] = el)}
              x={i * 32 + 1}
              y={3}
              width={28}
              height={7}
              style={{ transition: "none" }}
            />
          ))}
          {/* Regeneration edge — a bright leading sliver that only appears
              while health is actually climbing. */}
          <rect
            ref={regenRef}
            x={0}
            y={1}
            width={3}
            height={11}
            fill="#ffffff"
            style={{ opacity: 0 }}
          />
        </g>
      </svg>

      <div className="mt-1 flex items-center gap-2">
        <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.14)" }} />
        <span className="sf-label sf-text" style={{ fontSize: 8, letterSpacing: "0.24em" }}>
          {`REGEN ${PLAYER.regenRate}/S`}
        </span>
      </div>
    </div>
  );
}

/**
 * The low-health screen state.
 *
 * Separate from the block above because it is a full-viewport treatment and
 * because photosensitive players need to be able to damp it independently
 * (settings.reduceFlashing). It never animates faster than ~1 Hz, and the
 * pulse amplitude is halved when flashing is reduced.
 */
export function LowHealthOverlay() {
  const cvd = useUiStore((s) => s.settings.colorblind);
  const reduceFlash = useUiStore((s) => s.settings.reduceFlashing);
  const ref = useRef<HTMLDivElement>(null);
  const pulseRef = useRef<HTMLDivElement>(null);

  useUiFrame((now) => {
    const s = sf();
    const frac = Math.max(0, Math.min(1, s.health / Math.max(1, s.maxHealth)));
    // Ramps in below 45%, saturates at 8%.
    const k = Math.max(0, Math.min(1, (0.45 - frac) / 0.37));
    if (ref.current) ref.current.style.opacity = k.toFixed(3);
    if (pulseRef.current) {
      // A heartbeat, not a strobe: 1.1 Hz, shallow, and shallower still when
      // the player has asked for reduced flashing.
      const amp = reduceFlash ? 0.16 : 0.42;
      const beat = 0.5 + 0.5 * Math.sin(now * 6.9);
      pulseRef.current.style.opacity = (k * (0.35 + amp * beat * beat)).toFixed(3);
    }
  });

  const danger = cvdColor("danger", cvd);

  return (
    <>
      <div
        ref={ref}
        className="fixed inset-0 pointer-events-none"
        style={{
          opacity: 0,
          background: `radial-gradient(ellipse 130% 100% at 50% 50%, transparent 24%, ${rgba(danger, 0.14)} 62%, ${rgba(danger, 0.42)} 100%)`,
          mixBlendMode: "screen",
        }}
      />
      <div
        ref={pulseRef}
        className="fixed inset-0 pointer-events-none"
        style={{
          opacity: 0,
          boxShadow: `inset 0 0 220px 40px ${rgba(danger, 0.5)}`,
        }}
      />
    </>
  );
}
