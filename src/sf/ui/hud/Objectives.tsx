/**
 * Objective tracker.
 *
 * The list itself is React — objectives change when the mission changes,
 * which is rarely. The *distances* are not: they change every frame, so each
 * row's readout is a ref the shared rAF writes into. This is the pattern used
 * throughout the HUD: React owns structure, rAF owns numbers.
 *
 * The tracked objective (the one the compass and the world marker point at)
 * is the player's pin if they set one, otherwise the first incomplete
 * objective. Clicking a row re-pins.
 */
import { useRef } from "react";
import { frame, useSfStore } from "../../state/store";
import { useUiFrame, setText } from "../raf";
import { useUiStore } from "../uiStore";
import { distance as fmtDistance } from "../format";
import { COLORS, cvdColor, rgba } from "../theme";

export default function Objectives() {
  const objectives = useSfStore((s) => s.objectives);
  const tracked = useUiStore((s) => s.trackedObjective);
  const trackObjective = useUiStore((s) => s.trackObjective);
  const cvd = useUiStore((s) => s.settings.colorblind);
  const waypoint = useUiStore((s) => s.waypoint);

  const distRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const wpDist = useRef<HTMLSpanElement>(null);
  const acc = useRef(0);

  useUiFrame((_, dt) => {
    // 6 Hz is plenty for a distance in metres; anything faster is pure churn.
    acc.current += dt;
    if (acc.current < 1 / 6) return;
    acc.current = 0;
    const px = frame.position.x;
    const pz = frame.position.z;
    for (const o of objectives) {
      const el = distRefs.current[o.id];
      if (!el) continue;
      setText(el, fmtDistance(Math.hypot(o.x - px, o.z - pz)));
    }
    if (waypoint) {
      setText(wpDist.current, fmtDistance(Math.hypot(waypoint.x - px, waypoint.z - pz)));
    }
  });

  const active = objectives.filter((o) => !o.complete);
  const done = objectives.filter((o) => o.complete).slice(-2);
  if (active.length === 0 && done.length === 0 && !waypoint) return null;

  const trackedId = tracked ?? active[0]?.id ?? null;

  return (
    <div style={{ width: 268 }}>
      <div className="flex items-center gap-2 mb-2">
        <div className="h-px w-4" style={{ background: COLORS.signal }} />
        <span className="sf-label sf-text" style={{ fontSize: 8, letterSpacing: "0.3em" }}>
          OBJECTIVES
        </span>
        <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.12)" }} />
      </div>

      <div className="flex flex-col gap-1.5">
        {active.map((o, i) => {
          const isTracked = o.id === trackedId;
          return (
            <button
              key={o.id}
              className="sf-pe text-left relative sf-anim-right"
              style={{
                animationDelay: `${i * 40}ms`,
                padding: "6px 9px 6px 11px",
                background: isTracked ? rgba(COLORS.signal, 0.09) : "rgba(0,0,0,0.34)",
                borderLeft: `2px solid ${isTracked ? COLORS.signal : "rgba(255,255,255,0.18)"}`,
                backdropFilter: "blur(6px)",
                WebkitBackdropFilter: "blur(6px)",
                cursor: "pointer",
                transition: "background var(--sf-dur-fast) var(--sf-ease)",
              }}
              onClick={() => trackObjective(isTracked ? null : o.id)}
            >
              <div className="flex items-baseline gap-2">
                <span
                  className="sf-display sf-text"
                  style={{
                    fontSize: 11,
                    color: isTracked ? "#fff" : "rgba(255,255,255,0.82)",
                    letterSpacing: "0.06em",
                  }}
                >
                  {o.title}
                </span>
                <div className="flex-1" />
                <span
                  ref={(el) => (distRefs.current[o.id] = el)}
                  className="sf-num sf-text"
                  style={{ fontSize: 10, color: isTracked ? COLORS.signal : "rgba(255,255,255,0.5)" }}
                >
                  —
                </span>
              </div>
              {o.detail && (
                <div
                  className="sf-text"
                  style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginTop: 2, lineHeight: 1.35 }}
                >
                  {o.detail}
                </div>
              )}
              {o.progress > 0 && o.progress < 1 && (
                <div style={{ height: 2, background: "rgba(255,255,255,0.12)", marginTop: 5 }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${(o.progress * 100).toFixed(1)}%`,
                      background: COLORS.signal,
                      transition: "width var(--sf-dur) var(--sf-ease)",
                    }}
                  />
                </div>
              )}
            </button>
          );
        })}

        {waypoint && (
          <div
            className="flex items-baseline gap-2 sf-anim-right"
            style={{
              padding: "5px 9px 5px 11px",
              background: "rgba(0,0,0,0.34)",
              borderLeft: `2px solid ${cvdColor("info", cvd)}`,
            }}
          >
            <span className="sf-label sf-text" style={{ fontSize: 9, color: cvdColor("info", cvd) }}>
              WAYPOINT
            </span>
            <span className="sf-text" style={{ fontSize: 10, color: "rgba(255,255,255,0.6)" }}>
              {waypoint.label}
            </span>
            <div className="flex-1" />
            <span ref={wpDist} className="sf-num sf-text" style={{ fontSize: 10, color: cvdColor("info", cvd) }}>
              —
            </span>
          </div>
        )}

        {done.map((o) => (
          <div
            key={o.id}
            className="flex items-center gap-2"
            style={{ padding: "3px 9px 3px 11px", opacity: 0.42 }}
          >
            <svg width={10} height={10} viewBox="0 0 10 10">
              <path
                d="M1 5 L4 8 L9 1"
                fill="none"
                stroke={cvdColor("good", cvd)}
                strokeWidth={1.8}
                strokeLinecap="round"
              />
            </svg>
            <span
              className="sf-display sf-text"
              style={{ fontSize: 10, textDecoration: "line-through", letterSpacing: "0.06em" }}
            >
              {o.title}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
