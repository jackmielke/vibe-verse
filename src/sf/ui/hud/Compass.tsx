/**
 * The compass strip.
 *
 * Every navpoint on it is a real San Francisco landmark at its real
 * coordinates, pulled straight from `LANDMARKS` in sfGeo — the same table the
 * world generator builds the meshes from. That is the whole point: the thing
 * on the horizon and the tick on the compass are the same fact, so the player
 * can navigate the city the way you actually navigate San Francisco, by
 * pointing at the Transamerica Pyramid.
 *
 * All of it is built once and then moved with transforms. A strip that
 * re-rendered its 40 children every frame would be the single most expensive
 * thing on screen.
 */
import { useMemo, useRef } from "react";
import { LANDMARKS, type LandmarkDef } from "../../geo/sfGeo";
import { frame, sf } from "../../state/store";
import { useUiFrame, setText } from "../raf";
import { useUiStore } from "../uiStore";
import { bearingTo, bearingDelta, cardinal, yawToBearing, distance as fmtDistance } from "../format";
import { COLORS, cvdColor } from "../theme";

/** Degrees of arc visible across the strip. 110 is the sweet spot: wide
 *  enough to plan a turn, tight enough that ticks do not crowd. */
const SPAN = 110;
const WIDTH = 560;
const PX_PER_DEG = WIDTH / SPAN;

interface Tick {
  bearing: number;
  major: boolean;
  label: string;
}

const TICKS: Tick[] = (() => {
  const out: Tick[] = [];
  for (let b = 0; b < 360; b += 15) {
    const c = b % 45 === 0;
    out.push({ bearing: b, major: c, label: c ? cardinal(b) : "" });
  }
  return out;
})();

const NAVPOINTS: LandmarkDef[] = LANDMARKS.filter((l) => l.navpoint);

export default function Compass() {
  const show = useUiStore((s) => s.settings.showCompass);
  const cvd = useUiStore((s) => s.settings.colorblind);

  const tickRefs = useRef<(HTMLDivElement | null)[]>([]);
  const markRefs = useRef<(HTMLDivElement | null)[]>([]);
  const objRef = useRef<HTMLDivElement>(null);
  const objLabel = useRef<HTMLSpanElement>(null);
  const wayRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLSpanElement>(null);
  const cardinalRef = useRef<HTMLSpanElement>(null);
  const nearRef = useRef<HTMLSpanElement>(null);

  const signal = COLORS.signal;
  const objColor = cvdColor("info", cvd);

  // Distance labels only update at reading speed, not frame rate.
  const slow = useRef(0);

  const markers = useMemo(() => NAVPOINTS, []);

  useUiFrame((_, dt) => {
    const bearing = yawToBearing(frame.yaw);
    setText(headingRef.current, `${Math.round(bearing).toString().padStart(3, "0")}°`);
    setText(cardinalRef.current, cardinal(bearing));

    for (let i = 0; i < TICKS.length; i++) {
      const el = tickRefs.current[i];
      if (!el) continue;
      const d = bearingDelta(bearing, TICKS[i].bearing);
      if (Math.abs(d) > SPAN * 0.55) {
        if (el.style.opacity !== "0") el.style.opacity = "0";
        continue;
      }
      const x = d * PX_PER_DEG;
      // Fade at the edges so ticks arrive and leave rather than popping.
      const fade = 1 - Math.min(1, Math.abs(d) / (SPAN * 0.5));
      el.style.transform = `translateX(${x.toFixed(1)}px)`;
      el.style.opacity = (fade * (TICKS[i].major ? 1 : 0.55)).toFixed(3);
    }

    slow.current += dt;
    const refreshText = slow.current > 0.25;
    if (refreshText) slow.current = 0;

    const px = frame.position.x;
    const pz = frame.position.z;
    let nearestName = "";
    let nearestDist = Infinity;

    for (let i = 0; i < markers.length; i++) {
      const el = markRefs.current[i];
      if (!el) continue;
      const lm = markers[i];
      const b = bearingTo(px, pz, lm.x, lm.z);
      const d = bearingDelta(bearing, b);
      const dist = Math.hypot(lm.x - px, lm.z - pz);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestName = lm.name;
      }
      if (Math.abs(d) > SPAN * 0.52) {
        if (el.style.opacity !== "0") el.style.opacity = "0";
        continue;
      }
      const centred = 1 - Math.min(1, Math.abs(d) / 14);
      el.style.transform = `translateX(${(d * PX_PER_DEG).toFixed(1)}px)`;
      el.style.opacity = (0.42 + 0.58 * (1 - Math.min(1, Math.abs(d) / (SPAN * 0.5)))).toFixed(3);
      // Names only appear for the landmark you are actually facing; showing
      // all of them turns the strip into a wall of text.
      const label = el.querySelector<HTMLElement>("[data-label]");
      if (label) {
        label.style.opacity = centred.toFixed(3);
        if (refreshText && centred > 0.05) {
          setText(label, `${lm.name.toUpperCase()}  ${fmtDistance(dist)}`);
        }
      }
    }
    if (refreshText) {
      setText(nearRef.current, nearestName ? `NEAREST · ${nearestName.toUpperCase()}` : "");
    }

    // Tracked objective.
    const s = sf();
    const tracked =
      s.objectives.find((o) => o.id === useUiStore.getState().trackedObjective && !o.complete) ??
      s.objectives.find((o) => !o.complete);
    if (objRef.current) {
      if (!tracked) {
        objRef.current.style.opacity = "0";
      } else {
        const b = bearingTo(px, pz, tracked.x, tracked.z);
        const d = bearingDelta(bearing, b);
        const clamped = Math.max(-SPAN * 0.5, Math.min(SPAN * 0.5, d));
        objRef.current.style.opacity = "1";
        objRef.current.style.transform = `translateX(${(clamped * PX_PER_DEG).toFixed(1)}px)`;
        if (refreshText) {
          const dist = Math.hypot(tracked.x - px, tracked.z - pz);
          setText(objLabel.current, `${tracked.title.toUpperCase()} · ${fmtDistance(dist)}`);
        }
      }
    }

    // Player waypoint.
    const wp = useUiStore.getState().waypoint;
    if (wayRef.current) {
      if (!wp) {
        wayRef.current.style.opacity = "0";
      } else {
        const b = bearingTo(px, pz, wp.x, wp.z);
        const d = bearingDelta(bearing, b);
        const clamped = Math.max(-SPAN * 0.5, Math.min(SPAN * 0.5, d));
        wayRef.current.style.opacity = "1";
        wayRef.current.style.transform = `translateX(${(clamped * PX_PER_DEG).toFixed(1)}px)`;
      }
    }
  }, show);

  if (!show) return null;

  return (
    <div className="relative flex flex-col items-center" style={{ width: WIDTH }}>
      {/* Heading readout */}
      <div className="flex items-baseline gap-2 mb-1">
        <span
          ref={cardinalRef}
          className="sf-display sf-text-hard"
          style={{ fontSize: 15, letterSpacing: "0.1em" }}
        >
          N
        </span>
        <span
          ref={headingRef}
          className="sf-num sf-text"
          style={{ fontSize: 11, color: "rgba(255,255,255,0.55)" }}
        >
          000°
        </span>
      </div>

      <div
        className="relative"
        style={{
          width: WIDTH,
          height: 34,
          overflow: "hidden",
          maskImage: "linear-gradient(90deg, transparent 0%, #000 14%, #000 86%, transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(90deg, transparent 0%, #000 14%, #000 86%, transparent 100%)",
        }}
      >
        {/* Baseline rule */}
        <div
          className="absolute left-0 right-0"
          style={{ top: 12, height: 1, background: "rgba(255,255,255,0.16)" }}
        />

        {TICKS.map((t, i) => (
          <div
            key={t.bearing}
            ref={(el) => (tickRefs.current[i] = el)}
            className="absolute left-1/2 top-0 flex flex-col items-center"
            style={{ width: 0, opacity: 0, willChange: "transform" }}
          >
            <div
              style={{
                width: 1,
                height: t.major ? 12 : 6,
                background: t.major ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.45)",
                marginTop: t.major ? 0 : 6,
                boxShadow: "0 0 3px rgba(0,0,0,0.9)",
              }}
            />
            {t.major && (
              <span
                className="sf-display sf-text-hard"
                style={{ fontSize: 11, marginTop: 2, whiteSpace: "nowrap" }}
              >
                {t.label}
              </span>
            )}
          </div>
        ))}

        {/* Landmark navpoints */}
        {markers.map((lm, i) => (
          <div
            key={lm.key}
            ref={(el) => (markRefs.current[i] = el)}
            className="absolute left-1/2 flex flex-col items-center"
            style={{ top: 15, width: 0, opacity: 0, willChange: "transform" }}
          >
            <div
              style={{
                width: 5,
                height: 5,
                background: "rgba(255,255,255,0.92)",
                transform: "rotate(45deg)",
                boxShadow: "0 0 4px rgba(0,0,0,0.9)",
              }}
            />
            <span
              data-label=""
              className="sf-label sf-text-hard"
              style={{
                fontSize: 8,
                marginTop: 4,
                whiteSpace: "nowrap",
                color: "rgba(255,255,255,0.82)",
                opacity: 0,
              }}
            />
          </div>
        ))}

        {/* Waypoint */}
        <div
          ref={wayRef}
          className="absolute left-1/2 flex flex-col items-center"
          style={{ top: 4, width: 0, opacity: 0 }}
        >
          <svg width={13} height={13} viewBox="0 0 13 13">
            <path d="M6.5 0 L13 6.5 L6.5 13 L0 6.5 Z" fill={objColor} stroke="rgba(0,0,0,0.8)" strokeWidth={1} />
          </svg>
        </div>

        {/* Tracked objective */}
        <div
          ref={objRef}
          className="absolute left-1/2 flex flex-col items-center"
          style={{ top: 2, width: 0, opacity: 0 }}
        >
          <svg width={14} height={14} viewBox="0 0 14 14">
            <path d="M7 0 L14 12 L0 12 Z" fill={signal} stroke="rgba(0,0,0,0.85)" strokeWidth={1} />
          </svg>
          <span
            ref={objLabel}
            className="sf-label sf-text-hard"
            style={{ fontSize: 8, marginTop: 1, whiteSpace: "nowrap", color: signal }}
          />
        </div>

        {/* Centre bug */}
        <div
          className="absolute left-1/2 top-0"
          style={{
            width: 1,
            height: 20,
            marginLeft: -0.5,
            background: signal,
            boxShadow: `0 0 8px ${signal}`,
          }}
        />
      </div>

      <span
        ref={nearRef}
        className="sf-label sf-text"
        style={{ fontSize: 8, letterSpacing: "0.22em", marginTop: 2, opacity: 0.7 }}
      />
    </div>
  );
}
