/**
 * The interaction prompt and the detection pip.
 *
 * Both are small, both live just under the reticle, and both are pure
 * telemetry reads — the interaction system writes `promptKey`/`promptText`
 * when something is in range and clears them when it is not.
 *
 * The detection pip is the stealth read: a ring that fills while an enemy is
 * building awareness of you and snaps to a hard triangle the moment they are
 * certain. It sits above the prompt because in that moment it matters more.
 */
import { useRef } from "react";
import { hudTelemetry } from "../telemetry";
import { useUiFrame, setText, setAttr, approach } from "../raf";
import { useUiStore, keyFor } from "../uiStore";
import { keyGlyph } from "../format";
import { COLORS, cvdColor } from "../theme";

export default function Prompt() {
  const cvd = useUiStore((s) => s.settings.colorblind);
  const bindings = useUiStore((s) => s.bindings);

  const wrapRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const detectWrap = useRef<HTMLDivElement>(null);
  const detectArc = useRef<SVGCircleElement>(null);
  const anim = useRef({ vis: 0, det: 0 });

  useUiFrame((now, dt) => {
    const a = anim.current;
    const has = hudTelemetry.promptText.length > 0;
    a.vis = approach(a.vis, has ? 1 : 0, has ? 18 : 10, dt);
    if (wrapRef.current) {
      wrapRef.current.style.opacity = a.vis.toFixed(3);
      wrapRef.current.style.transform = `translate(-50%,${((1 - a.vis) * 6).toFixed(1)}px)`;
      wrapRef.current.style.visibility = a.vis < 0.01 ? "hidden" : "visible";
    }
    if (has) {
      // The prompt names the *player's* key, not a hard-coded one — this is
      // the payoff for having a rebinding screen at all.
      const code = hudTelemetry.promptKey
        ? keyFor(hudTelemetry.promptKey) || hudTelemetry.promptKey
        : bindings.interact;
      setText(keyRef.current, keyGlyph(code));
      setText(textRef.current, hudTelemetry.promptText.toUpperCase());
    }

    a.det = approach(a.det, hudTelemetry.detection, 12, dt);
    if (detectWrap.current) {
      detectWrap.current.style.opacity = a.det > 0.03 ? Math.min(1, a.det * 1.6).toFixed(3) : "0";
      const spotted = a.det > 0.985;
      detectWrap.current.style.transform = spotted
        ? `translate(-50%,0) scale(${(1.1 + 0.06 * Math.sin(now * 12)).toFixed(3)})`
        : "translate(-50%,0) scale(1)";
    }
    if (detectArc.current) {
      const r = 11;
      const c = 2 * Math.PI * r;
      setAttr(detectArc.current, "stroke-dasharray", `${(c * a.det).toFixed(1)} ${c.toFixed(1)}`);
      detectArc.current.style.stroke = a.det > 0.985 ? cvdColor("danger", cvd) : cvdColor("warn", cvd);
    }
  });

  return (
    <>
      <div
        ref={detectWrap}
        className="fixed"
        style={{ left: "50%", top: "calc(50% - 78px)", transform: "translate(-50%,0)", opacity: 0 }}
      >
        <svg width={28} height={28} viewBox="-14 -14 28 28">
          <circle r={11} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth={3.4} />
          <circle
            ref={detectArc}
            r={11}
            fill="none"
            stroke={COLORS.warn}
            strokeWidth={2.6}
            strokeLinecap="butt"
            transform="rotate(-90)"
          />
        </svg>
      </div>

      <div
        ref={wrapRef}
        className="fixed flex items-center gap-2.5"
        style={{
          left: "50%",
          top: "calc(50% + 62px)",
          transform: "translate(-50%,0)",
          opacity: 0,
          visibility: "hidden",
        }}
      >
        <span
          ref={keyRef}
          className="sf-display"
          style={{
            fontSize: 11,
            minWidth: 26,
            padding: "3px 7px",
            textAlign: "center",
            color: "#0b0500",
            background: COLORS.signal,
            borderRadius: 3,
            boxShadow: "0 2px 10px rgba(0,0,0,0.6)",
          }}
        >
          F
        </span>
        <span
          ref={textRef}
          className="sf-label sf-text-hard"
          style={{ fontSize: 11, letterSpacing: "0.2em", color: "#fff" }}
        />
      </div>
    </>
  );
}
