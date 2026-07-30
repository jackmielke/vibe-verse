/**
 * Traversal state: tethers, boost, canopy, and the flight instruments.
 *
 * Free fall over San Francisco is the game. When the player leaves the ground
 * the HUD changes character — two vertical tapes flank the reticle the way a
 * head-up display does, because at 90 m/s the only two numbers that matter
 * are how fast and how high, and both need to be readable without moving
 * your eyes off the horizon.
 *
 * The ground-proximity warning is deliberately unpleasant. It is driven by
 * time-to-impact, not by raw altitude: 40 m above a rooftop in level flight
 * is fine, 40 m in a vertical dive is four-tenths of a second from a crater,
 * and the HUD must be screaming by then.
 */
import { useRef, type RefObject } from "react";
import { GRAPPLE, WINGSUIT } from "../../config";
import { frame } from "../../state/store";
import { hudTelemetry } from "../telemetry";
import { useUiFrame, setText, approach } from "../raf";
import { useUiStore } from "../uiStore";
import { COLORS, cvdColor, rgba } from "../theme";

const TAPE_H = 232;

export default function Traversal() {
  const cvd = useUiStore((s) => s.settings.colorblind);
  const units = useUiStore((s) => s.settings.speedUnits);
  const reduceFlash = useUiStore((s) => s.settings.reduceFlashing);

  const wrapRef = useRef<HTMLDivElement>(null);
  const spdNum = useRef<HTMLSpanElement>(null);
  const spdFill = useRef<HTMLDivElement>(null);
  const altNum = useRef<HTMLSpanElement>(null);
  const altFill = useRef<HTMLDivElement>(null);
  const vsNum = useRef<HTMLSpanElement>(null);
  const vsBar = useRef<HTMLDivElement>(null);
  const warnRef = useRef<HTMLDivElement>(null);
  const warnText = useRef<HTMLSpanElement>(null);
  const edgeRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<HTMLSpanElement>(null);

  const tetherRefs = useRef<(HTMLDivElement | null)[]>([]);
  const boostFill = useRef<HTMLDivElement>(null);
  const boostWrap = useRef<HTMLDivElement>(null);
  const canopyWrap = useRef<HTMLDivElement>(null);
  const canopyFill = useRef<HTMLDivElement>(null);
  const rigRef = useRef<HTMLDivElement>(null);

  const anim = useRef({ vis: 0, spd: 0, alt: 0, vs: 0, warn: 0, boost: 1 });

  useUiFrame((now, dt) => {
    const a = anim.current;
    const mv = frame.movement;
    const aloft =
      mv === "airborne" || mv === "wingsuit" || mv === "parachute" || mv === "grappling";
    const inVehicle = mv === "vehicle" || hudTelemetry.vehicle.active;

    // The instruments fade in when they matter and get out of the way when
    // they do not. Landing should not leave two tapes hanging on screen.
    const want = aloft && !inVehicle ? 1 : 0;
    a.vis = approach(a.vis, want, want > 0 ? 12 : 5, dt);
    if (wrapRef.current) {
      wrapRef.current.style.opacity = a.vis.toFixed(3);
      wrapRef.current.style.visibility = a.vis < 0.01 ? "hidden" : "visible";
    }

    const agl = Math.max(0, frame.altitudeAGL);
    const airspeed = hudTelemetry.airspeed;
    const descent = hudTelemetry.descentRate;

    a.spd = approach(a.spd, airspeed, 10, dt);
    a.alt = approach(a.alt, agl, 12, dt);
    a.vs = approach(a.vs, descent, 8, dt);

    const spdDisplay = units === "mph" ? a.spd * 2.23694 : a.spd * 3.6;
    setText(spdNum.current, String(Math.round(spdDisplay)));
    if (spdFill.current) {
      // Scaled against the wingsuit's own maximum — the tape means something.
      const f = Math.min(1, a.spd / WINGSUIT.maxSpeed);
      spdFill.current.style.height = `${(f * 100).toFixed(1)}%`;
      const stall = a.spd < WINGSUIT.stallSpeed && mv === "wingsuit";
      spdFill.current.style.background = stall
        ? `linear-gradient(0deg, ${cvdColor("danger", cvd)}, ${cvdColor("warn", cvd)})`
        : `linear-gradient(0deg, ${COLORS.signalDeep}, ${COLORS.signal})`;
    }

    setText(altNum.current, a.alt >= 1000 ? `${(a.alt / 1000).toFixed(2)}K` : String(Math.round(a.alt)));
    if (altFill.current) {
      // Log-ish scale: the interesting range is 0-200 m, but 2 km must still
      // fit on the tape.
      const f = Math.min(1, Math.log10(1 + a.alt) / Math.log10(1 + 1200));
      altFill.current.style.height = `${(f * 100).toFixed(1)}%`;
    }

    setText(vsNum.current, `${a.vs >= 0 ? "-" : "+"}${Math.abs(Math.round(a.vs))}`);
    if (vsBar.current) {
      const f = Math.max(-1, Math.min(1, a.vs / 55));
      vsBar.current.style.transform = `translateY(${(f * 40).toFixed(1)}px) scaleY(${(0.4 + Math.abs(f)).toFixed(2)})`;
      vsBar.current.style.background = a.vs > 30 ? cvdColor("danger", cvd) : "#fff";
    }

    setText(modeRef.current, modeLabel(mv));

    // --- ground proximity ------------------------------------------
    // Time to impact with the terrain directly below at the current sink
    // rate. Grapples and level flight get out of it for free.
    const tti = descent > 1 ? agl / descent : Infinity;
    let severity = 0;
    if (aloft && mv !== "grappling") {
      const byTime = tti < 3.2 ? 1 - tti / 3.2 : 0;
      const byAlt = agl < WINGSUIT.pullWarning ? 1 - agl / WINGSUIT.pullWarning : 0;
      severity = Math.max(byTime, byAlt * 0.75);
      if (mv === "parachute") severity *= 0.35;
    }
    a.warn = approach(a.warn, severity, 18, dt);

    if (warnRef.current) {
      const blinkHz = 3 + a.warn * 6;
      const blink = reduceFlash ? 0.85 : Math.sin(now * blinkHz * Math.PI * 2) > -0.2 ? 1 : 0.22;
      warnRef.current.style.opacity = (a.warn * blink).toFixed(3);
      warnRef.current.style.transform = `translate(-50%,0) scale(${(1 + a.warn * 0.12).toFixed(3)})`;
    }
    setText(warnText.current, tti < 1.6 ? "PULL UP" : "TERRAIN");
    if (edgeRef.current) {
      const e = reduceFlash ? a.warn * 0.4 : a.warn;
      edgeRef.current.style.opacity = (e * 0.85).toFixed(3);
    }

    // --- rig: tethers, boost, canopy -------------------------------
    const tethers = hudTelemetry.tethers;
    for (let i = 0; i < GRAPPLE.maxTethers; i++) {
      const el = tetherRefs.current[i];
      if (!el) continue;
      const live = i < tethers;
      el.style.background = live ? COLORS.signal : "rgba(255,255,255,0.10)";
      el.style.boxShadow = live ? `0 0 10px ${rgba(COLORS.signal, 0.9)}` : "none";
      el.style.transform = live ? "scaleY(1)" : "scaleY(0.55)";
    }

    a.boost = approach(a.boost, hudTelemetry.boostFuel, 14, dt);
    if (boostWrap.current) {
      boostWrap.current.style.opacity = mv === "wingsuit" ? "1" : "0.28";
    }
    if (boostFill.current) {
      boostFill.current.style.width = `${(a.boost * 100).toFixed(1)}%`;
      boostFill.current.style.background =
        a.boost < 0.2 ? cvdColor("danger", cvd) : COLORS.signal;
    }

    if (canopyWrap.current) canopyWrap.current.style.opacity = mv === "parachute" ? "1" : "0";
    if (canopyFill.current) canopyFill.current.style.width = `${(hudTelemetry.canopy * 100).toFixed(1)}%`;

    if (rigRef.current) {
      rigRef.current.style.opacity = inVehicle ? "0" : "1";
    }
  });

  const danger = cvdColor("danger", cvd);

  return (
    <>
      {/* Flight tapes + warning live in their own fixed layer so they can sit
          around the reticle without disturbing the corner clusters. */}
      <div ref={wrapRef} className="fixed inset-0 pointer-events-none" style={{ opacity: 0 }}>
        {/* Airspeed, left of the reticle */}
        <div
          className="absolute"
          style={{ left: "calc(50% - 232px)", top: "50%", transform: "translateY(-50%)" }}
        >
          <Tape
            label={units === "mph" ? "MPH" : "KM/H"}
            valueRef={spdNum}
            fillRef={spdFill}
            align="right"
          />
        </div>

        {/* Altitude AGL, right of the reticle */}
        <div
          className="absolute"
          style={{ left: "calc(50% + 176px)", top: "50%", transform: "translateY(-50%)" }}
        >
          <Tape label="AGL·M" valueRef={altNum} fillRef={altFill} align="left" />
          {/* Vertical speed bug */}
          <div
            className="absolute"
            style={{ left: 62, top: "50%", width: 3, height: 26, marginTop: -13 }}
          >
            <div
              ref={vsBar}
              style={{
                width: 3,
                height: 22,
                background: "#fff",
                boxShadow: "0 0 6px rgba(0,0,0,0.9)",
              }}
            />
          </div>
          <span
            ref={vsNum}
            className="sf-num sf-text"
            style={{
              position: "absolute",
              left: 70,
              top: "50%",
              marginTop: -7,
              fontSize: 11,
              color: "rgba(255,255,255,0.7)",
            }}
          >
            0
          </span>
        </div>

        {/* Ground proximity */}
        <div
          ref={warnRef}
          className="absolute"
          style={{ left: "50%", top: "62%", opacity: 0, transform: "translate(-50%,0)" }}
        >
          <div className="flex flex-col items-center gap-1">
            <svg width={120} height={26} viewBox="0 0 120 26">
              <path d="M60 2 L74 20 L60 14 L46 20 Z" fill={danger} stroke="rgba(0,0,0,0.9)" strokeWidth={1.2} />
              <path d="M24 6 L34 20 L24 15.5 L14 20 Z" fill={danger} opacity={0.75} />
              <path d="M96 6 L106 20 L96 15.5 L86 20 Z" fill={danger} opacity={0.75} />
            </svg>
            <span
              ref={warnText}
              className="sf-display sf-text-hard"
              style={{
                fontSize: 26,
                color: danger,
                letterSpacing: "0.16em",
                textShadow: `0 0 22px ${rgba(danger, 0.9)}, 0 2px 3px rgba(0,0,0,1)`,
              }}
            >
              TERRAIN
            </span>
          </div>
        </div>

        {/* Screen-edge alarm */}
        <div
          ref={edgeRef}
          className="fixed inset-0 pointer-events-none"
          style={{ opacity: 0, boxShadow: `inset 0 0 160px 26px ${rgba(danger, 0.55)}` }}
        />
      </div>

      {/* The rig strip — tethers, boost, canopy — sits with the bottom-left
          cluster where the player's hands conceptually are. */}
      <div ref={rigRef} style={{ marginTop: 14, width: 214 }}>
        <div className="flex items-center gap-2">
          <span className="sf-label sf-text" style={{ fontSize: 8, letterSpacing: "0.24em" }}>
            RIG
          </span>
          <span ref={modeRef} className="sf-label sf-text" style={{ fontSize: 8, letterSpacing: "0.24em", color: COLORS.signal }}>
            GROUNDED
          </span>
          <div className="flex-1" />
          <div className="flex items-end gap-1" style={{ height: 14 }}>
            {Array.from({ length: GRAPPLE.maxTethers }, (_, i) => (
              <div
                key={i}
                ref={(el) => (tetherRefs.current[i] = el)}
                style={{
                  width: 9,
                  height: 14,
                  background: "rgba(255,255,255,0.10)",
                  transformOrigin: "bottom",
                  transition: "background 120ms linear, transform 120ms var(--sf-ease)",
                }}
              />
            ))}
          </div>
        </div>

        <div ref={boostWrap} style={{ marginTop: 5 }}>
          <div style={{ height: 3, background: "rgba(255,255,255,0.10)" }}>
            <div
              ref={boostFill}
              style={{ height: "100%", width: "100%", background: COLORS.signal }}
            />
          </div>
        </div>

        <div ref={canopyWrap} style={{ marginTop: 3, opacity: 0 }}>
          <div style={{ height: 2, background: "rgba(255,255,255,0.10)" }}>
            <div
              ref={canopyFill}
              style={{ height: "100%", width: "100%", background: cvdColor("good", cvd) }}
            />
          </div>
        </div>
      </div>
    </>
  );
}

function Tape({
  label,
  valueRef,
  fillRef,
  align,
}: {
  label: string;
  valueRef: RefObject<HTMLSpanElement>;
  fillRef: RefObject<HTMLDivElement>;
  align: "left" | "right";
}) {
  return (
    <div
      className="flex flex-col"
      style={{ alignItems: align === "right" ? "flex-end" : "flex-start", width: 56 }}
    >
      <div
        style={{
          position: "relative",
          width: 6,
          height: TAPE_H,
          background: "rgba(0,0,0,0.42)",
          border: "1px solid rgba(255,255,255,0.14)",
        }}
      >
        <div
          ref={fillRef}
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: "0%",
            background: COLORS.signal,
            transition: "none",
          }}
        />
        {/* Reference graticules every fifth of the tape. */}
        {[0.2, 0.4, 0.6, 0.8].map((f) => (
          <div
            key={f}
            style={{
              position: "absolute",
              left: -3,
              right: -3,
              bottom: `${f * 100}%`,
              height: 1,
              background: "rgba(255,255,255,0.25)",
            }}
          />
        ))}
      </div>
      <span
        ref={valueRef}
        className="sf-num sf-text-hard"
        style={{ fontSize: 22, fontWeight: 700, marginTop: 5, lineHeight: 1 }}
      >
        0
      </span>
      <span className="sf-label sf-text" style={{ fontSize: 8, letterSpacing: "0.2em" }}>
        {label}
      </span>
    </div>
  );
}

function modeLabel(mv: string): string {
  switch (mv) {
    case "wingsuit":
      return "WINGSUIT";
    case "parachute":
      return "CANOPY";
    case "grappling":
      return "TETHERED";
    case "airborne":
      return "FREE FALL";
    case "swimming":
      return "SWIMMING";
    case "vehicle":
      return "DRIVING";
    case "dead":
      return "—";
    default:
      return "GROUNDED";
  }
}
