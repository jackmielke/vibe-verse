/**
 * The vehicle cluster.
 *
 * Appears only while the player is driving, sits low-centre where a
 * dashboard would be, and reads at a glance: an arc for speed because arcs
 * are how every car in the world reports speed, a gear the size of a road
 * sign, and two thin bars for the things that end a chase — structural
 * damage and fuel.
 *
 * Every value is 60 Hz telemetry, so nothing here touches React after mount.
 */
import { useRef, type RefObject } from "react";
import { frame } from "../../state/store";
import { hudTelemetry } from "../telemetry";
import { useUiFrame, setText, setAttr, approach } from "../raf";
import { useUiStore } from "../uiStore";
import { COLORS, cvdColor, rgba } from "../theme";

/** Arc geometry: a 220-degree sweep, opening downward, radius 78. */
const R = 78;
const SWEEP = 220;
const START = 90 + (360 - SWEEP) / 2; // degrees, clockwise from +X

function polar(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [Math.cos(a) * r, Math.sin(a) * r];
}

function arcPath(fromDeg: number, toDeg: number, r: number): string {
  const [x0, y0] = polar(fromDeg, r);
  const [x1, y1] = polar(toDeg, r);
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Top speeds per archetype, m/s — only used to scale the dial. */
const TOP_SPEED: Record<string, number> = {
  car: 78,
  bike: 82,
  truck: 42,
  boat: 34,
  heli: 75,
  plane: 130,
};

export default function VehicleHud() {
  const cvd = useUiStore((s) => s.settings.colorblind);
  const units = useUiStore((s) => s.settings.speedUnits);

  const wrapRef = useRef<HTMLDivElement>(null);
  const speedArc = useRef<SVGPathElement>(null);
  const needleRef = useRef<SVGGElement>(null);
  const speedNum = useRef<HTMLSpanElement>(null);
  const gearRef = useRef<HTMLSpanElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  const rpmArc = useRef<SVGPathElement>(null);
  const healthFill = useRef<HTMLDivElement>(null);
  const fuelFill = useRef<HTMLDivElement>(null);
  const boostFill = useRef<HTMLDivElement>(null);
  const critRef = useRef<HTMLDivElement>(null);
  const altRef = useRef<HTMLSpanElement>(null);

  const anim = useRef({ vis: 0, spd: 0, rpm: 0 });
  const trackLen = useRef((SWEEP / 360) * 2 * Math.PI * R);

  useUiFrame((now, dt) => {
    const v = hudTelemetry.vehicle;
    const a = anim.current;
    const active = v.active || frame.movement === "vehicle";
    a.vis = approach(a.vis, active ? 1 : 0, active ? 14 : 6, dt);
    if (wrapRef.current) {
      wrapRef.current.style.opacity = a.vis.toFixed(3);
      wrapRef.current.style.visibility = a.vis < 0.01 ? "hidden" : "visible";
      wrapRef.current.style.transform = `translateY(${((1 - a.vis) * 22).toFixed(1)}px)`;
    }
    if (!active && a.vis < 0.01) return;

    const top = TOP_SPEED[v.kind] ?? TOP_SPEED.car;
    // Fall back to the player's own speed when the vehicle system has not
    // published telemetry yet — better a true number than a frozen zero.
    const speed = v.speed > 0 ? v.speed : frame.speed;
    a.spd = approach(a.spd, speed, 12, dt);
    a.rpm = approach(a.rpm, v.rpm, 16, dt);

    const disp = units === "mph" ? a.spd * 2.23694 : a.spd * 3.6;
    setText(speedNum.current, String(Math.round(disp)));

    const f = Math.max(0, Math.min(1, a.spd / top));
    if (speedArc.current) {
      const len = trackLen.current;
      setAttr(speedArc.current, "stroke-dasharray", `${(len * f).toFixed(1)} ${len.toFixed(1)}`);
    }
    if (needleRef.current) {
      setAttr(needleRef.current, "transform", `rotate(${(START + SWEEP * f).toFixed(2)})`);
    }
    if (rpmArc.current) {
      const len = trackLen.current;
      const r = Math.max(0, Math.min(1, a.rpm));
      setAttr(rpmArc.current, "stroke-dasharray", `${(len * r).toFixed(1)} ${len.toFixed(1)}`);
      rpmArc.current.style.stroke = r > 0.88 ? cvdColor("danger", cvd) : COLORS.signal;
    }

    setText(
      gearRef.current,
      v.gear < 0 ? "R" : v.gear === 0 ? "N" : String(v.gear),
    );
    setText(nameRef.current, (v.name || "VEHICLE").toUpperCase());

    if (healthFill.current) {
      const h = Math.max(0, Math.min(1, v.health));
      healthFill.current.style.width = `${(h * 100).toFixed(1)}%`;
      healthFill.current.style.background =
        h < 0.25 ? cvdColor("danger", cvd) : h < 0.55 ? cvdColor("warn", cvd) : cvdColor("good", cvd);
    }
    if (fuelFill.current) fuelFill.current.style.width = `${(Math.max(0, v.fuel) * 100).toFixed(1)}%`;
    if (boostFill.current) {
      boostFill.current.style.width = `${(Math.max(0, v.boost) * 100).toFixed(1)}%`;
      boostFill.current.parentElement!.style.opacity = v.boost > 0.001 ? "1" : "0.2";
    }

    if (critRef.current) {
      const crit = v.critical || v.health < 0.18;
      critRef.current.style.opacity = crit ? (Math.sin(now * 9) > 0 ? "1" : "0.2") : "0";
    }

    // Aircraft get an altitude readout; ground vehicles do not need one.
    if (altRef.current) {
      const flying = v.kind === "heli" || v.kind === "plane";
      altRef.current.style.opacity = flying ? "1" : "0";
      if (flying) {
        const agl = v.altitude > 0 ? v.altitude : Math.max(0, frame.altitudeAGL);
        setText(altRef.current, `AGL ${Math.round(agl)}M`);
      }
    }
  });

  const danger = cvdColor("danger", cvd);

  return (
    <div
      ref={wrapRef}
      className="flex flex-col items-center"
      style={{ opacity: 0, visibility: "hidden", width: 260 }}
    >
      <div className="relative" style={{ width: 200, height: 118 }}>
        <svg width={200} height={118} viewBox="-100 -100 200 118" style={{ overflow: "visible" }}>
          {/* Track */}
          <path
            d={arcPath(START, START + SWEEP, R)}
            fill="none"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth={5}
            strokeLinecap="butt"
          />
          {/* Speed */}
          <path
            ref={speedArc}
            d={arcPath(START, START + SWEEP, R)}
            fill="none"
            stroke="#fff"
            strokeWidth={5}
            strokeLinecap="butt"
            style={{ filter: "drop-shadow(0 0 8px rgba(255,255,255,0.35))" }}
          />
          {/* RPM, inside */}
          <path
            ref={rpmArc}
            d={arcPath(START, START + SWEEP, R - 9)}
            fill="none"
            stroke={COLORS.signal}
            strokeWidth={2.5}
            strokeLinecap="butt"
          />
          {/* Graticules */}
          {Array.from({ length: 11 }, (_, i) => {
            const t = i / 10;
            const deg = START + SWEEP * t;
            const [ax, ay] = polar(deg, R + 5);
            const [bx, by] = polar(deg, R + (i % 5 === 0 ? 13 : 9));
            return (
              <line
                key={i}
                x1={ax}
                y1={ay}
                x2={bx}
                y2={by}
                stroke={i >= 9 ? danger : "rgba(255,255,255,0.4)"}
                strokeWidth={i % 5 === 0 ? 1.6 : 1}
              />
            );
          })}
          {/* Needle */}
          <g ref={needleRef}>
            <path d={`M ${R - 22} 0 L ${R - 4} -2.4 L ${R - 4} 2.4 Z`} fill={COLORS.signal} />
          </g>
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-end pb-1">
          <span
            ref={speedNum}
            className="sf-num sf-text-hard leading-none"
            style={{ fontSize: 42, fontWeight: 800, letterSpacing: "-0.05em" }}
          >
            0
          </span>
          <span className="sf-label sf-text" style={{ fontSize: 8, letterSpacing: "0.24em" }}>
            {units === "mph" ? "MPH" : "KM/H"}
          </span>
        </div>

        <div
          className="absolute"
          style={{ right: -6, bottom: 6, display: "flex", flexDirection: "column", alignItems: "center" }}
        >
          <span
            ref={gearRef}
            className="sf-display sf-text-hard"
            style={{ fontSize: 26, color: COLORS.signal, lineHeight: 1 }}
          >
            N
          </span>
          <span className="sf-label sf-text" style={{ fontSize: 7, letterSpacing: "0.2em" }}>
            GEAR
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 mt-1" style={{ width: 232 }}>
        <span ref={nameRef} className="sf-label sf-text" style={{ fontSize: 8, letterSpacing: "0.22em" }}>
          VEHICLE
        </span>
        <span
          ref={critRef}
          className="sf-label"
          style={{ fontSize: 8, letterSpacing: "0.22em", color: danger, opacity: 0 }}
        >
          ENGINE FIRE
        </span>
        <div className="flex-1" />
        <span ref={altRef} className="sf-num sf-text" style={{ fontSize: 9, opacity: 0, color: "rgba(255,255,255,0.6)" }} />
      </div>

      <div className="flex items-center gap-3 mt-1" style={{ width: 232 }}>
        <Bar label="HULL" fillRef={healthFill} color={cvdColor("good", cvd)} />
        <Bar label="FUEL" fillRef={fuelFill} color="rgba(255,255,255,0.75)" />
        <Bar label="NOS" fillRef={boostFill} color={COLORS.signal} />
      </div>
    </div>
  );
}

function Bar({
  label,
  fillRef,
  color,
}: {
  label: string;
  fillRef: RefObject<HTMLDivElement>;
  color: string;
}) {
  return (
    <div className="flex-1">
      <div style={{ height: 3, background: "rgba(255,255,255,0.10)" }}>
        <div
          ref={fillRef}
          style={{
            height: "100%",
            width: "100%",
            background: color,
            boxShadow: `0 0 8px ${rgba(color.startsWith("#") ? color : "#ffffff", 0.5)}`,
          }}
        />
      </div>
      <span
        className="sf-label sf-text"
        style={{ fontSize: 7, letterSpacing: "0.2em", display: "block", marginTop: 2 }}
      >
        {label}
      </span>
    </div>
  );
}
