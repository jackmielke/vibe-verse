/**
 * The head-up display.
 *
 * Laid out the way a real fighter HUD is laid out, because that layout is the
 * product of sixty years of arguing about what a pilot's eyes should find
 * without moving: velocity vector in the middle, speed on the left, altitude
 * on the right, heading across the top, G below the speed.
 *
 * The symbol that matters most is the **velocity vector** — the little winged
 * circle. It shows where the aeroplane is actually going, which at high angle
 * of attack is emphatically not where the nose is pointing. The gap between it
 * and the fixed waterline cross *is* your angle of attack, drawn to scale. Once
 * you notice that gap you cannot fly without it, and it is the single thing
 * that turns "steering a model" into flying.
 *
 * ## The combiner
 * Everything is laid out inside an explicit box rather than against the edges
 * of the window, and the pitch ladder is clipped to it. A real HUD is a piece
 * of glass about twenty degrees across; drawing the ladder edge to edge — which
 * is what the first version did — buries the world under a green net and makes
 * a phone unplayable. The box is also what keeps the instruments out from
 * under the touch controls, which own the bottom third in portrait and the
 * outer thirds in landscape.
 *
 * ## No re-renders
 * React draws the SVG once and a requestAnimationFrame loop writes attributes
 * through refs. Sixty state updates a second across thirty components would
 * spend more time in the reconciler than the whole world spends rendering.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Engine } from "../engine/core";
import type { FleetService } from "../play/fleet";
import type { CourseService } from "../play/courses";
import type { InputService } from "../engine/input";
import { FEET_PER_METER, KNOTS_PER_MPS } from "../flight/atmosphere";
import { trueToMagnetic } from "../world/geo";

const GREEN = "#7dffb0";
const AMBER = "#ffcc33";
const RED = "#ff5555";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

interface Props {
  engine: Engine;
  visible: boolean;
}

/** Where every symbol goes, for one window size. */
interface Layout {
  w: number;
  h: number;
  portrait: boolean;
  /** The combiner: the box the ladder is clipped to and everything hangs off. */
  box: { x: number; y: number; w: number; h: number };
  cx: number;
  cy: number;
  pxPerDeg: number;
  rungHalf: number;
  /** Left instrument column. */
  leftX: number;
  /** Right instrument column. */
  rightX: number;
  scale: number;
}

function computeLayout(w: number, h: number): Layout {
  const portrait = h > w;
  const scale = Math.max(0.72, Math.min(1.25, Math.min(w, h) / 620));

  // In portrait the touch controls own the bottom ~38%, so the combiner sits
  // in the upper-middle. In landscape it is centred but kept clear of the
  // outer columns where the stick and the throttle live.
  const cy = portrait ? h * 0.36 : h * 0.47;
  const boxW = Math.min(w * (portrait ? 0.66 : 0.46), 520 * scale);
  const boxH = Math.min(h * (portrait ? 0.30 : 0.44), 340 * scale);
  const cx = w / 2;

  // Degrees of pitch per pixel. A real HUD runs about 5° per 30 px at 1080p;
  // this keeps three or four rungs in the box at any window size.
  const pxPerDeg = boxH / 26;

  const colW = 96 * scale;
  const leftX = Math.max(6, cx - boxW / 2 - colW - 6 * scale);
  const rightX = Math.min(w - colW - 6, cx + boxW / 2 + 6 * scale);

  return {
    w,
    h,
    portrait,
    box: { x: cx - boxW / 2, y: cy - boxH / 2, w: boxW, h: boxH },
    cx,
    cy,
    pxPerDeg,
    rungHalf: boxW * 0.34,
    leftX,
    rightX,
    scale,
  };
}

export default function FlightHUD({ engine, visible }: Props) {
  const [size, setSize] = useState({ w: 1280, h: 720 });
  const L = useMemo(() => computeLayout(size.w, size.h), [size]);

  const ladder = useRef<SVGGElement>(null);
  const vv = useRef<SVGGElement>(null);
  const bankPtr = useRef<SVGGElement>(null);
  const headingTape = useRef<SVGGElement>(null);
  const speedText = useRef<SVGTextElement>(null);
  const machText = useRef<SVGTextElement>(null);
  const altText = useRef<SVGTextElement>(null);
  const raltText = useRef<SVGTextElement>(null);
  const vsText = useRef<SVGTextElement>(null);
  const gText = useRef<SVGTextElement>(null);
  const gMaxText = useRef<SVGTextElement>(null);
  const aoaBar = useRef<SVGRectElement>(null);
  const aoaText = useRef<SVGTextElement>(null);
  const fuelBar = useRef<SVGRectElement>(null);
  const pwrText = useRef<SVGTextElement>(null);
  const headingText = useRef<SVGTextElement>(null);
  const warnText = useRef<SVGTextElement>(null);
  const gearText = useRef<SVGTextElement>(null);
  const targetRing = useRef<SVGGElement>(null);
  const stickRing = useRef<SVGGElement>(null);
  const stickDot = useRef<SVGGElement>(null);
  const aimRing = useRef<SVGGElement>(null);
  const aimLine = useRef<SVGLineElement>(null);
  const levelTag = useRef<SVGTextElement>(null);
  const greyVeil = useRef<HTMLDivElement>(null);
  const redVeil = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onResize = () =>
      setSize({ w: window.innerWidth, h: Math.max(1, window.innerHeight) });
    onResize();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    let maxG = 1;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const fleet = engine.ctx.services.fleet as FleetService | undefined;
      const courses = engine.ctx.services.courses as CourseService | undefined;
      if (!fleet) return;
      const s = fleet.player.state;
      const spec = fleet.player.spec;
      const { cx, cy, pxPerDeg, w, h } = L;

      const bankDeg = (s.bank * 180) / Math.PI;
      const pitchDeg = (s.pitchAttitude * 180) / Math.PI;

      if (ladder.current) {
        ladder.current.setAttribute(
          "transform",
          `translate(${cx} ${cy}) rotate(${-bankDeg}) translate(0 ${pitchDeg * pxPerDeg})`,
        );
      }

      // The velocity vector's offset from centre *is* the difference between
      // where the nose points and where the jet goes: angle of attack
      // vertically, sideslip laterally.
      if (vv.current) {
        const aoaDeg = (s.alpha * 180) / Math.PI;
        const betaDeg = (s.beta * 180) / Math.PI;
        const lim = L.box.w * 0.42;
        const vx = Math.max(-lim, Math.min(lim, -betaDeg * pxPerDeg));
        const vy = Math.max(-L.box.h * 0.44, Math.min(L.box.h * 0.44, aoaDeg * pxPerDeg));
        vv.current.setAttribute("transform", `translate(${cx + vx} ${cy + vy})`);
        vv.current.dataset.x = String(vx);
        vv.current.dataset.y = String(vy);
        vv.current.setAttribute("stroke", s.stalled ? RED : s.liftDemand > 0.88 ? AMBER : GREEN);
      }

      const kias = s.ias * KNOTS_PER_MPS;
      if (speedText.current) speedText.current.textContent = String(Math.round(kias));
      if (machText.current) machText.current.textContent = `M ${s.mach.toFixed(2)}`;
      if (altText.current) altText.current.textContent = String(Math.round(s.altitude * FEET_PER_METER));
      if (raltText.current) {
        const ralt = Math.round(s.radarAltitude * FEET_PER_METER);
        raltText.current.textContent = ralt < 5000 ? `R ${ralt}` : "";
        raltText.current.setAttribute("fill", ralt < 400 ? AMBER : GREEN);
      }
      if (vsText.current) {
        const vs = Math.round((s.climb * FEET_PER_METER * 60) / 50) * 50;
        vsText.current.textContent = `${vs > 0 ? "+" : ""}${vs}`;
      }

      const hdgMag = trueToMagnetic((s.heading * 180) / Math.PI);
      if (headingTape.current) {
        headingTape.current.setAttribute("transform", `translate(${cx - hdgMag * 4} 0)`);
      }
      if (headingText.current) {
        headingText.current.textContent = String(Math.round(hdgMag)).padStart(3, "0");
      }

      maxG = Math.max(maxG, s.gLoad);
      if (gText.current) {
        gText.current.textContent = `${s.gLoad.toFixed(1)}G`;
        gText.current.setAttribute(
          "fill",
          s.gLoad > spec.gLimit.positive * 0.94 || s.gLoad < spec.gLimit.negative * 0.9
            ? RED
            : s.gLoad > spec.gLimit.positive * 0.72
              ? AMBER
              : GREEN,
        );
      }
      if (gMaxText.current) gMaxText.current.textContent = `MAX ${maxG.toFixed(1)}`;

      if (aoaBar.current && aoaText.current) {
        const frac = Math.max(0, Math.min(1, s.liftDemand));
        const barH = L.box.h * 0.5;
        aoaBar.current.setAttribute("height", String(barH * frac));
        aoaBar.current.setAttribute("y", String(cy + barH / 2 - barH * frac));
        aoaBar.current.setAttribute("fill", frac > 0.92 ? RED : frac > 0.8 ? AMBER : GREEN);
        aoaText.current.textContent = `${((s.alpha * 180) / Math.PI).toFixed(0)}°`;
      }

      if (pwrText.current) {
        const ab = s.power > 1.02;
        pwrText.current.textContent = ab
          ? `AB ${Math.round((s.power - 1) * 100)}`
          : `PWR ${Math.round(s.power * 100)}`;
        pwrText.current.setAttribute("fill", ab ? AMBER : GREEN);
      }
      if (fuelBar.current) {
        const frac = Math.max(0, Math.min(1, s.fuel / (spec.mass * 0.18)));
        fuelBar.current.setAttribute("width", String(56 * L.scale * frac));
        fuelBar.current.setAttribute("fill", frac < 0.15 ? RED : frac < 0.3 ? AMBER : GREEN);
      }

      if (bankPtr.current) {
        bankPtr.current.setAttribute("transform", `translate(${cx} ${cy}) rotate(${-bankDeg})`);
      }

      if (warnText.current) {
        let msg = "";
        if (s.stalled) msg = "STALL";
        else if (s.radarAltitude < 90 && s.climb < -8 && !s.onGround) msg = "PULL UP";
        else if (s.fuel < spec.mass * 0.02) msg = "FUEL";
        else if (s.gLoad > spec.gLimit.positive * 0.98) msg = "OVER G";
        warnText.current.textContent = msg;
        warnText.current.setAttribute("opacity", msg && Math.floor(Date.now() / 300) % 2 ? "1" : "0");
      }
      if (gearText.current) {
        gearText.current.textContent =
          s.gearPos > 0.99 ? "GEAR DOWN" : s.gearPos > 0.01 ? "GEAR ↕" : "";
        gearText.current.setAttribute("fill", s.gearPos > 0.99 ? GREEN : AMBER);
      }

      if (targetRing.current) {
        const hoop = courses?.active ? courses.hoops[courses.next] : null;
        if (!hoop) {
          targetRing.current.setAttribute("opacity", "0");
        } else {
          const cam = engine.ctx.camera;
          const p = hoop.position.clone().project(cam);
          const onScreen = p.z < 1 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1;
          if (onScreen) {
            targetRing.current.setAttribute("opacity", "0.95");
            targetRing.current.setAttribute(
              "transform",
              `translate(${((p.x + 1) / 2) * w} ${((1 - p.y) / 2) * h})`,
            );
          } else {
            // Off screen: pin an arrow to the edge of the combiner, pointing
            // the way you have to turn.
            const ang = Math.atan2(-p.y, p.x) * (p.z > 1 ? -1 : 1);
            targetRing.current.setAttribute("opacity", "0.5");
            targetRing.current.setAttribute(
              "transform",
              `translate(${cx + Math.cos(ang) * L.box.w * 0.55} ${cy + Math.sin(ang) * L.box.h * 0.6})`,
            );
          }
        }
      }

      // ---- the mouse stick -------------------------------------------------
      // Drawn so the control explains itself: a ring showing how far the
      // cursor has to travel for full deflection, and a line to where the
      // stick currently is. Without it the first thirty seconds of mouse
      // flight are a guess about how sensitive the thing is.
      const inputSvc = engine.ctx.services.input as InputService | undefined;
      const st = inputSvc?.stick;
      if (stickRing.current && stickDot.current) {
        if (st?.active && st.radius > 0) {
          // Neutral is wherever the input layer put it, not the middle of the
          // screen — it re-anchors under the cursor when a menu closes, and a
          // ring drawn in the wrong place is worse than no ring at all.
          stickRing.current.setAttribute("opacity", "0.30");
          stickRing.current.setAttribute("transform", `translate(${st.cx} ${st.cy})`);
          (stickRing.current.firstElementChild as SVGCircleElement)?.setAttribute(
            "r",
            String(st.radius),
          );
          const mag = Math.hypot(st.x, st.y);
          stickDot.current.setAttribute("opacity", String(0.25 + Math.min(1, mag) * 0.6));
          stickDot.current.setAttribute(
            "transform",
            `translate(${st.cx + st.x * st.radius} ${st.cy + st.y * st.radius})`,
          );
        } else {
          stickRing.current.setAttribute("opacity", "0");
          stickDot.current.setAttribute("opacity", "0");
        }
      }

      // ---- the pursuit ring ------------------------------------------------
      // The single most important symbol in the "point where you want to go"
      // scheme, because it *is* the control. Drawn with a line back to the
      // velocity vector so the relationship is stated rather than inferred:
      // that is where you are going, this is where you asked to go, and the
      // jet is closing the gap between them.
      const av = inputSvc?.aim;
      if (aimRing.current && aimLine.current) {
        if (av?.active) {
          aimRing.current.setAttribute("opacity", "0.95");
          aimRing.current.setAttribute("transform", `translate(${av.px} ${av.py})`);
          const vvx = cx + Number(vv.current?.dataset.x ?? 0);
          const vvy = cy + Number(vv.current?.dataset.y ?? 0);
          const far = Math.hypot(av.px - vvx, av.py - vvy) > 26;
          aimLine.current.setAttribute("opacity", far ? "0.4" : "0");
          aimLine.current.setAttribute("x1", String(vvx));
          aimLine.current.setAttribute("y1", String(vvy));
          aimLine.current.setAttribute("x2", String(av.px));
          aimLine.current.setAttribute("y2", String(av.py));
        } else {
          aimRing.current.setAttribute("opacity", "0");
          aimLine.current.setAttribute("opacity", "0");
        }
      }

      if (levelTag.current) {
        const on = fleet.levelling > 0;
        levelTag.current.setAttribute("opacity", on ? "1" : "0");
        levelTag.current.textContent = on ? "RECOVERING" : "";
      }

      if (greyVeil.current) greyVeil.current.style.opacity = String(fleet.greyout.grey * 0.94);
      if (redVeil.current) redVeil.current.style.opacity = String(fleet.greyout.red * 0.8);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, L, visible]);

  if (!visible) return null;

  const { w, h, cx, cy, box, pxPerDeg, rungHalf, leftX, rightX, scale, portrait } = L;
  const fs = (n: number) => Math.round(n * scale);

  // Pitch ladder rungs. Positive rungs are solid, negative are dashed with
  // downward ticks, and both are canted toward the horizon — the cant is how
  // you know which way is up when the ladder is the only thing you can see.
  const rungs: JSX.Element[] = [];
  for (let deg = -90; deg <= 90; deg += 5) {
    if (deg === 0) continue;
    const y = deg * pxPerDeg;
    const negative = deg < 0;
    const cant = Math.sign(deg) * Math.min(10, Math.abs(deg) * 0.14);
    const half = rungHalf * (Math.abs(deg) > 45 ? 0.6 : 1);
    rungs.push(
      <g key={deg} transform={`translate(0 ${-y})`} opacity={Math.abs(deg) > 85 ? 0.5 : 0.92}>
        <line
          x1={-half}
          y1={cant}
          x2={-half * 0.3}
          y2={0}
          stroke={GREEN}
          strokeWidth={1.8}
          strokeDasharray={negative ? "6 5" : undefined}
        />
        <line
          x1={half * 0.3}
          y1={0}
          x2={half}
          y2={-cant}
          stroke={GREEN}
          strokeWidth={1.8}
          strokeDasharray={negative ? "6 5" : undefined}
        />
        <line x1={-half} y1={cant} x2={-half} y2={cant + (negative ? -7 : 7)} stroke={GREEN} strokeWidth={1.8} />
        <line x1={half} y1={-cant} x2={half} y2={-cant + (negative ? -7 : 7)} stroke={GREEN} strokeWidth={1.8} />
        <text x={-half - 6} y={cant + 4} fill={GREEN} fontSize={fs(11)} textAnchor="end" fontFamily={MONO}>
          {Math.abs(deg)}
        </text>
        <text x={half + 6} y={-cant + 4} fill={GREEN} fontSize={fs(11)} fontFamily={MONO}>
          {Math.abs(deg)}
        </text>
      </g>,
    );
  }

  // Heading tape: every five degrees, labelled every ten, repeated either side
  // of the wrap so it never runs out of tape at north.
  const headingTicks: JSX.Element[] = [];
  for (let deg = -70; deg <= 430; deg += 5) {
    const x = deg * 4;
    const major = ((deg % 10) + 10) % 10 === 0;
    headingTicks.push(
      <g key={deg}>
        <line x1={x} y1={0} x2={x} y2={major ? 9 : 5} stroke={GREEN} strokeWidth={1.5} />
        {major && (
          <text x={x} y={fs(22)} fill={GREEN} fontSize={fs(10)} textAnchor="middle" fontFamily={MONO}>
            {String(((deg % 360) + 360) % 360).padStart(3, "0")}
          </text>
        )}
      </g>,
    );
  }

  const tapeY = portrait ? Math.max(46, box.y - fs(58)) : Math.max(40, box.y - fs(52));
  const tapeHalf = Math.min(box.w * 0.62, w * 0.36);
  const colTop = cy - box.h * 0.5;

  return (
    <>
      {/* G veils sit under the symbology: you lose the world before the HUD. */}
      <div
        ref={greyVeil}
        data-angels-hud="grey"
        className="pointer-events-none fixed inset-0 z-20"
        style={{
          opacity: 0,
          background:
            "radial-gradient(circle at 50% 44%, rgba(0,0,0,0) 12%, rgba(0,0,0,0.55) 42%, rgba(0,0,0,0.98) 78%)",
          transition: "opacity 90ms linear",
        }}
      />
      <div
        ref={redVeil}
        data-angels-hud="red"
        className="pointer-events-none fixed inset-0 z-20"
        style={{ opacity: 0, background: "rgba(150,10,10,0.55)", transition: "opacity 90ms linear" }}
      />

      <svg
        data-angels-hud="flight"
        className="pointer-events-none fixed inset-0 z-20"
        width="100%"
        height="100%"
        viewBox={`0 0 ${w} ${h}`}
        style={{ filter: "drop-shadow(0 0 3px rgba(0,255,140,0.4))" }}
      >
        <defs>
          <clipPath id="hudCombiner">
            <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={10} />
          </clipPath>
          <clipPath id="hudHeading">
            <rect x={cx - tapeHalf} y={tapeY - 2} width={tapeHalf * 2} height={fs(30)} />
          </clipPath>
        </defs>

        {/* pitch ladder + horizon, clipped to the combiner */}
        <g clipPath="url(#hudCombiner)">
          <g ref={ladder}>
            <line x1={-w} y1={0} x2={-rungHalf * 1.35} y2={0} stroke={GREEN} strokeWidth={2} />
            <line x1={rungHalf * 1.35} y1={0} x2={w} y2={0} stroke={GREEN} strokeWidth={2} />
            {rungs}
          </g>
        </g>

        {/* fixed waterline — where the nose points */}
        <g transform={`translate(${cx} ${cy})`}>
          <line x1={fs(-30)} y1={0} x2={fs(-11)} y2={0} stroke={GREEN} strokeWidth={2.2} />
          <line x1={fs(11)} y1={0} x2={fs(30)} y2={0} stroke={GREEN} strokeWidth={2.2} />
          <line x1={fs(-11)} y1={0} x2={0} y2={fs(7)} stroke={GREEN} strokeWidth={2.2} />
          <line x1={fs(11)} y1={0} x2={0} y2={fs(7)} stroke={GREEN} strokeWidth={2.2} />
        </g>

        {/* velocity vector — where the jet is actually going */}
        <g ref={vv} stroke={GREEN} strokeWidth={2.2} fill="none">
          <circle cx={0} cy={0} r={fs(8)} />
          <line x1={fs(-8)} y1={0} x2={fs(-21)} y2={0} />
          <line x1={fs(8)} y1={0} x2={fs(21)} y2={0} />
          <line x1={0} y1={fs(-8)} x2={0} y2={fs(-17)} />
        </g>

        {/* bank scale, on the top arc of the combiner */}
        <g ref={bankPtr}>
          <polygon
            points={`0,${-box.h * 0.42 - 12} ${-6},${-box.h * 0.42} ${6},${-box.h * 0.42}`}
            fill={GREEN}
          />
        </g>
        <g transform={`translate(${cx} ${cy})`} opacity={0.75}>
          {[-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60].map((a) => (
            <line
              key={a}
              x1={0}
              y1={-box.h * 0.42 - 14}
              x2={0}
              y2={-box.h * 0.42 - (a === 0 ? 26 : 21)}
              stroke={GREEN}
              strokeWidth={a === 0 ? 2.4 : 1.5}
              transform={`rotate(${a})`}
            />
          ))}
        </g>

        {/* heading tape */}
        <g clipPath="url(#hudHeading)">
          <g ref={headingTape} transform={`translate(${cx} 0)`}>
            <g transform={`translate(0 ${tapeY})`}>{headingTicks}</g>
          </g>
        </g>
        <polygon
          points={`${cx},${tapeY - 2} ${cx - 6},${tapeY - 11} ${cx + 6},${tapeY - 11}`}
          fill={GREEN}
        />
        <text
          ref={headingText}
          x={cx}
          y={tapeY - 15}
          fill={GREEN}
          fontSize={fs(14)}
          textAnchor="middle"
          fontFamily={MONO}
          fontWeight="bold"
        >
          000
        </text>

        {/* ---- left column: speed, mach, AOA, G, fuel ---- */}
        <g transform={`translate(${leftX} ${colTop})`}>
          <rect x={0} y={0} width={fs(76)} height={fs(30)} fill="rgba(0,22,12,0.35)" stroke={GREEN} strokeWidth={1.4} rx={3} />
          <text ref={speedText} x={fs(69)} y={fs(22)} fill={GREEN} fontSize={fs(21)} textAnchor="end" fontFamily={MONO} fontWeight="bold">
            0
          </text>
          <text x={0} y={fs(44)} fill={GREEN} fontSize={fs(10)} fontFamily={MONO} opacity={0.7}>
            KIAS
          </text>
          <text ref={machText} x={fs(76)} y={fs(44)} fill={GREEN} fontSize={fs(11)} textAnchor="end" fontFamily={MONO}>
            M 0.00
          </text>
          <text ref={gText} x={0} y={fs(74)} fill={GREEN} fontSize={fs(19)} fontFamily={MONO} fontWeight="bold">
            1.0G
          </text>
          <text ref={gMaxText} x={0} y={fs(90)} fill={GREEN} fontSize={fs(10)} fontFamily={MONO} opacity={0.65}>
            MAX 1.0
          </text>
          <rect x={0} y={fs(97)} width={fs(56)} height={fs(5)} fill="none" stroke={GREEN} strokeWidth={1} opacity={0.5} />
          <rect ref={fuelBar} x={0} y={fs(97)} width={fs(56)} height={fs(5)} fill={GREEN} />
          <text x={fs(60)} y={fs(102)} fill={GREEN} fontSize={fs(9)} fontFamily={MONO} opacity={0.65}>
            FUEL
          </text>
        </g>

        {/* AOA bracket, just inboard of the speed box */}
        <g>
          <rect
            x={leftX + fs(84)}
            y={cy - box.h * 0.25}
            width={fs(6)}
            height={box.h * 0.5}
            fill="none"
            stroke={GREEN}
            strokeWidth={1.1}
            opacity={0.55}
          />
          <rect ref={aoaBar} x={leftX + fs(84)} y={cy} width={fs(6)} height={0} fill={GREEN} />
          <text
            ref={aoaText}
            x={leftX + fs(87)}
            y={cy + box.h * 0.25 + fs(13)}
            fill={GREEN}
            fontSize={fs(10)}
            textAnchor="middle"
            fontFamily={MONO}
          >
            0°
          </text>
        </g>

        {/* ---- right column: altitude, radar alt, VS, power ---- */}
        <g transform={`translate(${rightX} ${colTop})`}>
          <rect x={0} y={0} width={fs(90)} height={fs(30)} fill="rgba(0,22,12,0.35)" stroke={GREEN} strokeWidth={1.4} rx={3} />
          <text ref={altText} x={fs(83)} y={fs(22)} fill={GREEN} fontSize={fs(21)} textAnchor="end" fontFamily={MONO} fontWeight="bold">
            0
          </text>
          <text x={0} y={fs(44)} fill={GREEN} fontSize={fs(10)} fontFamily={MONO} opacity={0.7}>
            FT
          </text>
          <text ref={raltText} x={fs(90)} y={fs(44)} fill={GREEN} fontSize={fs(11)} textAnchor="end" fontFamily={MONO}>
            R 0
          </text>
          <text ref={vsText} x={fs(90)} y={fs(60)} fill={GREEN} fontSize={fs(11)} textAnchor="end" fontFamily={MONO} opacity={0.8}>
            0
          </text>
          <text ref={pwrText} x={0} y={fs(84)} fill={GREEN} fontSize={fs(13)} fontFamily={MONO} fontWeight="bold">
            PWR 75
          </text>
          <text ref={gearText} x={0} y={fs(100)} fill={GREEN} fontSize={fs(10)} fontFamily={MONO} />
        </g>

        {/* mouse stick: the box, and where the stick is in it */}
        <g ref={stickRing} opacity={0} fill="none" stroke={GREEN} strokeWidth={1.2}>
          <circle cx={0} cy={0} r={200} strokeDasharray="3 9" />
          {/* neutral, marked: the ring says how far, this says from where */}
          <line x1={-7} y1={0} x2={7} y2={0} />
          <line x1={0} y1={-7} x2={0} y2={7} />
        </g>
        <g ref={stickDot} opacity={0}>
          <circle cx={0} cy={0} r={fs(5)} fill="none" stroke={GREEN} strokeWidth={2} />
          <circle cx={0} cy={0} r={1.6} fill={GREEN} />
        </g>

        {/* the pursuit ring: where you asked to go */}
        <line
          ref={aimLine}
          x1={0}
          y1={0}
          x2={0}
          y2={0}
          stroke={AMBER}
          strokeWidth={1.4}
          strokeDasharray="4 7"
          opacity={0}
        />
        <g ref={aimRing} opacity={0} fill="none" stroke={AMBER} strokeWidth={2.2}>
          <circle cx={0} cy={0} r={fs(15)} />
          <line x1={fs(-24)} y1={0} x2={fs(-19)} y2={0} />
          <line x1={fs(19)} y1={0} x2={fs(24)} y2={0} />
          <line x1={0} y1={fs(-24)} x2={0} y2={fs(-19)} />
          <line x1={0} y1={fs(19)} x2={0} y2={fs(24)} />
          <circle cx={0} cy={0} r={2} fill={AMBER} />
        </g>

        <text
          ref={levelTag}
          x={cx}
          y={box.y + box.h + fs(26)}
          fill={AMBER}
          fontSize={fs(13)}
          textAnchor="middle"
          fontFamily={MONO}
          fontWeight="bold"
          opacity={0}
        />

        {/* next hoop */}
        <g ref={targetRing} opacity={0}>
          <circle cx={0} cy={0} r={fs(24)} fill="none" stroke={AMBER} strokeWidth={2} strokeDasharray="6 6" />
          <circle cx={0} cy={0} r={3} fill={AMBER} />
        </g>

        {/* warnings, inside the combiner where the eye already is */}
        <text
          ref={warnText}
          x={cx}
          y={box.y + box.h - fs(12)}
          fill={RED}
          fontSize={fs(22)}
          textAnchor="middle"
          fontFamily={MONO}
          fontWeight="bold"
          opacity={0}
        />
      </svg>
    </>
  );
}
