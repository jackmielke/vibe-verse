/**
 * The escalation read: CHAOS earned, HEAT brought down on you.
 *
 * This is the Just Cause loop rendered as two numbers. Chaos is a score that
 * only goes up and is therefore quiet and gold; heat is a threat that comes
 * and goes and is therefore loud and red. They sit together because the
 * player's whole strategic decision — "keep going or break line of sight" —
 * is the relationship between them.
 *
 * The chaos bar fills toward the *next heat threshold*, not toward some
 * abstract level, so the meter answers the question the player is actually
 * asking: how much more of this before the helicopters?
 */
import { useRef } from "react";
import { CHAOS } from "../../config";
import { sf } from "../../state/store";
import { hudTelemetry } from "../telemetry";
import { useUiFrame, setText, approach } from "../raf";
import { useUiStore } from "../uiStore";
import { COLORS, cvdColor, rgba } from "../theme";

const MAX_HEAT = CHAOS.heatThresholds.length - 1;

export default function ChaosHeat() {
  const cvd = useUiStore((s) => s.settings.colorblind);

  const chaosNum = useRef<HTMLSpanElement>(null);
  const chaosBar = useRef<HTMLDivElement>(null);
  const nextLabel = useRef<HTMLSpanElement>(null);
  const comboRef = useRef<HTMLDivElement>(null);
  const comboNum = useRef<HTMLSpanElement>(null);
  const heatRefs = useRef<(SVGGElement | null)[]>([]);
  const heatLabel = useRef<HTMLSpanElement>(null);
  const heatWrap = useRef<HTMLDivElement>(null);
  const gainRef = useRef<HTMLDivElement>(null);

  const anim = useRef({ shownChaos: 0, bar: 0, lastChaos: 0, gain: 0, heatShown: 0 });

  useUiFrame((now, dt) => {
    const s = sf();
    const a = anim.current;

    // Count the headline number up rather than snapping — a score that ticks
    // is a reward; a score that jumps is a notification.
    a.shownChaos = approach(a.shownChaos, s.chaos, 6, dt);
    if (Math.abs(a.shownChaos - s.chaos) < 1) a.shownChaos = s.chaos;
    setText(chaosNum.current, formatScore(a.shownChaos));

    // Flash on gain.
    if (s.chaos > a.lastChaos) a.gain = 1;
    a.lastChaos = s.chaos;
    a.gain = Math.max(0, a.gain - dt * 2.2);
    if (gainRef.current) gainRef.current.style.opacity = (a.gain * 0.85).toFixed(3);

    // Progress toward the next threshold.
    const heat = Math.max(0, Math.min(MAX_HEAT, Math.round(s.heat)));
    const lo = CHAOS.heatThresholds[Math.min(heat, MAX_HEAT)];
    const hi = CHAOS.heatThresholds[Math.min(heat + 1, MAX_HEAT)];
    const span = Math.max(1, hi - lo);
    const p = heat >= MAX_HEAT ? 1 : Math.max(0, Math.min(1, (s.chaos - lo) / span));
    a.bar = approach(a.bar, p, 8, dt);
    if (chaosBar.current) chaosBar.current.style.width = `${(a.bar * 100).toFixed(2)}%`;
    setText(
      nextLabel.current,
      heat >= MAX_HEAT ? "MAXIMUM ALERT" : `${Math.max(0, Math.ceil(hi - s.chaos))} TO HEAT ${heat + 1}`,
    );

    // Heat pips.
    a.heatShown = approach(a.heatShown, heat, 12, dt);
    const danger = cvdColor("heat", cvd);
    for (let i = 0; i < MAX_HEAT; i++) {
      const el = heatRefs.current[i];
      if (!el) continue;
      const on = i < heat;
      const leading = i === heat - 1;
      const pulse = leading ? 0.6 + 0.4 * (Math.sin(now * 6.5) * 0.5 + 0.5) : 1;
      el.style.opacity = on ? pulse.toFixed(3) : "0.16";
      el.style.fill = on ? danger : "rgba(255,255,255,0.85)";
      el.style.transform = on ? `scale(${(1 + (leading ? 0.09 * pulse : 0.03)).toFixed(3)})` : "scale(0.9)";
      el.style.transformOrigin = "center";
    }
    if (heatWrap.current) {
      heatWrap.current.style.filter =
        heat >= 4 ? `drop-shadow(0 0 ${(6 + 6 * Math.sin(now * 7)).toFixed(1)}px ${rgba(danger, 0.8)})` : "none";
    }
    setText(
      heatLabel.current,
      heat === 0 ? "CLEAR" : heat >= MAX_HEAT ? "MILITARY" : heat >= 3 ? "SWAT" : "SFPD",
    );
    if (heatLabel.current) {
      heatLabel.current.style.color = heat === 0 ? "rgba(255,255,255,0.4)" : danger;
    }

    // Combo multiplier — only present while it is doing something.
    const mult = hudTelemetry.comboMultiplier;
    if (comboRef.current) {
      comboRef.current.style.opacity = mult > 1.05 ? "1" : "0";
      comboRef.current.style.transform = `translateY(${mult > 1.05 ? 0 : -4}px)`;
    }
    setText(comboNum.current, `×${mult.toFixed(1)}`);
  });

  return (
    <div className="flex flex-col items-end" style={{ width: 260 }}>
      {/* CHAOS */}
      <div className="flex items-center gap-2">
        <span className="sf-label sf-text" style={{ fontSize: 9, letterSpacing: "0.3em" }}>
          CHAOS
        </span>
        <div className="h-px w-8" style={{ background: "rgba(255,255,255,0.18)" }} />
      </div>

      <div className="relative flex items-baseline gap-2">
        <div
          ref={gainRef}
          className="absolute inset-0 pointer-events-none"
          style={{
            opacity: 0,
            background: `radial-gradient(ellipse at 80% 50%, ${rgba(COLORS.chaos, 0.55)}, transparent 70%)`,
            filter: "blur(10px)",
          }}
        />
        <div
          ref={comboRef}
          className="sf-num"
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: COLORS.signal,
            opacity: 0,
            transition: "opacity 150ms var(--sf-ease), transform 150ms var(--sf-ease)",
          }}
        >
          <span ref={comboNum}>×1.0</span>
        </div>
        <span
          ref={chaosNum}
          className="sf-num sf-text-hard leading-none"
          style={{ fontSize: 32, fontWeight: 800, color: COLORS.chaos, letterSpacing: "-0.035em" }}
        >
          0
        </span>
      </div>

      <div
        style={{
          width: 240,
          height: 3,
          marginTop: 5,
          background: "rgba(255,255,255,0.10)",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          ref={chaosBar}
          style={{
            height: "100%",
            width: "0%",
            background: `linear-gradient(90deg, ${COLORS.signalDeep}, ${COLORS.chaos})`,
            boxShadow: `0 0 12px ${rgba(COLORS.chaos, 0.8)}`,
          }}
        />
      </div>
      <span
        ref={nextLabel}
        className="sf-label sf-text"
        style={{ fontSize: 8, letterSpacing: "0.2em", marginTop: 4 }}
      >
        250 TO HEAT 1
      </span>

      {/* HEAT */}
      <div className="flex items-center gap-2.5 mt-3">
        <span ref={heatLabel} className="sf-label sf-text" style={{ fontSize: 9, letterSpacing: "0.26em" }}>
          CLEAR
        </span>
        <div ref={heatWrap}>
          <svg width={MAX_HEAT * 19} height={17} viewBox={`0 0 ${MAX_HEAT * 19} 17`}>
            {Array.from({ length: MAX_HEAT }, (_, i) => (
              <g
                key={i}
                ref={(el) => (heatRefs.current[i] = el)}
                transform={`translate(${i * 19 + 8},9)`}
                style={{ opacity: 0.16 }}
              >
                {/* A chevron, not a star: this is a threat scale, not a rating. */}
                <path
                  d="M 0 -7 L 6.5 3 L 0 0.6 L -6.5 3 Z"
                  stroke="rgba(0,0,0,0.8)"
                  strokeWidth={1}
                  paintOrder="stroke"
                />
              </g>
            ))}
          </svg>
        </div>
      </div>
    </div>
  );
}

/** Local score formatter — grouped with thin separators, never abbreviated
 *  below a million so the player can watch every point land. */
function formatScore(n: number): string {
  const v = Math.round(n);
  const s = Math.abs(v).toString();
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return v < 0 ? `-${out}` : out;
}
