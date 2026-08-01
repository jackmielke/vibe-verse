/**
 * Vibe Kart — the three instruments: speedometer, position badge, minimap.
 *
 * All three are written from `useKartFrame` straight into refs. Not one of them
 * calls `setState` while the race is running: the needle, the charge arc, the
 * dots and the numerals are DOM writes on nodes React has already mounted, so
 * a 60 fps HUD costs a handful of attribute sets rather than a reconciliation.
 *
 * The exception is the position numeral, which *does* re-render — but only when
 * the place actually changes, which is what makes the pop animation replay.
 */
import { useRef } from "react";
import { TUNING, type CharacterPreset } from "../types";
import { useKartFrame, useRuntime, useSample } from "./runtime";
import { clamp, clamp01, damp, hex, ordinalSuffix, TIER_COLOR, TIER_NAME } from "./util";
import { playerOf, type MinimapView, type ModelsView, type PhysicsView, type RaceView, type TrackView } from "./views";

// ---------------------------------------------------------------------------
// Speedometer
// ---------------------------------------------------------------------------

const CX = 50;
const CY = 48;
const R = 36;
/** Sweep of the dial, degrees, centred on straight up. */
const SPAN = 240;
const START = -SPAN / 2;
/** Top of the scale in km/h — a boosted kart pins the needle and that is fine. */
const MAX_KMH = 150;

const MT_R = 25;
const ARC_LEN = (R * SPAN * Math.PI) / 180;
const MT_LEN = (MT_R * SPAN * Math.PI) / 180;

/** 0° is straight up, positive clockwise — the same convention as the minimap. */
function polar(radius: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [CX + radius * Math.sin(a), CY - radius * Math.cos(a)];
}

function arcPath(radius: number): string {
  const [x0, y0] = polar(radius, START);
  const [x1, y1] = polar(radius, START + SPAN);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${radius} ${radius} 0 ${SPAN > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const DIAL = arcPath(R);
const MT_DIAL = arcPath(MT_R);

const TICKS = Array.from({ length: 13 }, (_, i) => {
  const deg = START + (i / 12) * SPAN;
  const major = i % 3 === 0;
  const outer = R + 5.5;
  const inner = R + (major ? 0.5 : 2.5);
  const [x0, y0] = polar(inner, deg);
  const [x1, y1] = polar(outer, deg);
  return { x0, y0, x1, y1, major, key: i };
});

export function Speedometer() {
  const rt = useRuntime();
  const needle = useRef<SVGGElement | null>(null);
  const fill = useRef<SVGPathElement | null>(null);
  const glow = useRef<SVGPathElement | null>(null);
  const charge = useRef<SVGPathElement | null>(null);
  const readout = useRef<HTMLDivElement | null>(null);
  const word = useRef<HTMLDivElement | null>(null);
  // The needle is a mass on a spring, not a readout: it lags the sim slightly
  // and that lag is most of what makes a gauge feel mechanical.
  const shown = useRef(0);
  const tierShown = useRef(-1);

  useKartFrame((dt) => {
    const physics = rt.ctx.services.physics as PhysicsView | undefined;
    const racer = playerOf(physics);
    const kmh = racer ? Math.abs(racer.speed) * 3.6 : 0;
    shown.current = damp(shown.current, kmh, 12, dt);
    const frac = clamp01(shown.current / MAX_KMH);

    if (needle.current) needle.current.setAttribute("transform", `rotate(${(START + frac * SPAN).toFixed(2)} ${CX} ${CY})`);
    if (fill.current) fill.current.style.strokeDashoffset = String(ARC_LEN * (1 - frac));

    const boosting = (racer?.boost ?? 0) > 0;
    if (fill.current) fill.current.style.stroke = boosting ? "#ffe27a" : "#ffcc22";
    if (glow.current) {
      glow.current.style.strokeDashoffset = String(ARC_LEN * (1 - frac));
      glow.current.style.opacity = boosting ? "0.85" : "0.3";
    }

    if (readout.current) readout.current.textContent = String(Math.round(shown.current));

    // Mini-turbo: the ring fills toward the next tier and holds full at purple.
    const tier = racer?.driftTier ?? 0;
    const chargeFrac = racer?.drifting ? clamp01(tier >= 3 ? 1 : racer.driftCharge) : 0;
    if (charge.current) {
      charge.current.style.strokeDashoffset = String(MT_LEN * (1 - chargeFrac));
      charge.current.style.stroke = TIER_COLOR[clamp(tier, 0, 3)];
      charge.current.style.opacity = racer?.drifting ? "1" : "0";
    }
    if (word.current && tierShown.current !== tier) {
      tierShown.current = tier;
      word.current.textContent = TIER_NAME[clamp(tier, 0, 3)];
      word.current.style.color = TIER_COLOR[clamp(tier, 0, 3)];
      word.current.style.opacity = tier > 0 ? "1" : "0";
    }
  });

  return (
    <div className="vk-speedo">
      <svg viewBox="0 0 100 72" aria-hidden="true">
        {/* Dial face: a dark slab so the arc reads over any sky. */}
        <path
          d={DIAL}
          fill="none"
          stroke="rgba(6,12,22,0.72)"
          strokeWidth={13}
          strokeLinecap="round"
        />
        <path d={DIAL} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={7.5} strokeLinecap="round" />

        <g stroke="rgba(255,247,230,0.5)" strokeLinecap="round">
          {TICKS.map((t) => (
            <line
              key={t.key}
              x1={t.x0}
              y1={t.y0}
              x2={t.x1}
              y2={t.y1}
              strokeWidth={t.major ? 2.4 : 1.2}
              opacity={t.major ? 0.85 : 0.45}
            />
          ))}
        </g>

        <path
          ref={glow}
          d={DIAL}
          fill="none"
          stroke="#ffcc22"
          strokeWidth={13}
          strokeLinecap="round"
          strokeOpacity={0.32}
          style={{ strokeDasharray: ARC_LEN, strokeDashoffset: ARC_LEN, opacity: 0.3 }}
        />
        <path
          ref={fill}
          d={DIAL}
          fill="none"
          stroke="#ffcc22"
          strokeWidth={7.5}
          strokeLinecap="round"
          style={{ strokeDasharray: ARC_LEN, strokeDashoffset: ARC_LEN }}
        />

        {/* Mini-turbo charge, nested inside the speed arc. */}
        <path d={MT_DIAL} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={4} strokeLinecap="round" />
        <path
          ref={charge}
          d={MT_DIAL}
          fill="none"
          stroke={TIER_COLOR[1]}
          strokeWidth={4}
          strokeLinecap="round"
          style={{ strokeDasharray: MT_LEN, strokeDashoffset: MT_LEN, opacity: 0, transition: "opacity 0.12s linear" }}
        />

        <g ref={needle} transform={`rotate(${START} ${CX} ${CY})`}>
          <path
            d={`M${CX - 3.4} ${CY} L${CX} ${CY - R + 3} L${CX + 3.4} ${CY} L${CX} ${CY + 7} Z`}
            fill="#fff2c4"
            stroke="#0a1120"
            strokeWidth={1.6}
            strokeLinejoin="round"
          />
        </g>
        <circle cx={CX} cy={CY} r={5} fill="#16233a" stroke="#0a1120" strokeWidth={2} />
        <circle cx={CX} cy={CY} r={1.8} fill="#ffcc22" />
      </svg>

      <div className="vk-mt-word vk-ink-edge" ref={word} />
      <div className="vk-speedo-read">
        <div className="vk-speedo-n vk-num vk-ink-edge" ref={readout}>
          0
        </div>
        <div className="vk-speedo-u">km / h</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

/** Gold, silver, bronze, then the house cream. */
const PLACE_FACE = ["#ffd34d", "#e6f0ff", "#ffab5e", "#fff7e6"];
const PLACE_EDGE = ["#a35c00", "#4a6b91", "#8a3d0d", "#20304a"];

export function PlaceBadge() {
  const rt = useRuntime();
  const place = useSample(() => {
    const race = rt.ctx.services.race as RaceView | undefined;
    const physics = rt.ctx.services.physics as PhysicsView | undefined;
    const fromRace = race?.playerStanding?.().place;
    return clamp(fromRace ?? playerOf(physics)?.place ?? 1, 1, 12);
  });
  const total = useSample(() => {
    const physics = rt.ctx.services.physics as PhysicsView | undefined;
    return physics?.racers?.length ?? TUNING.fieldSize;
  });

  const face = PLACE_FACE[Math.min(place - 1, 3)] ?? PLACE_FACE[3];
  const edge = PLACE_EDGE[Math.min(place - 1, 3)] ?? PLACE_EDGE[3];

  return (
    <div className="vk-place">
      {/* The key remounts the node on every change, replaying the pop. */}
      <svg key={place} className="vk-place--pop" viewBox="0 0 100 68" aria-label={`Position ${place} of ${total}`}>
        <text
          x={4}
          y={57}
          textAnchor="start"
          style={{ fontFamily: "inherit", fontWeight: 900, fontSize: 62, letterSpacing: "-0.03em" }}
          fill={face}
          stroke="#0a1120"
          strokeWidth={11}
          strokeLinejoin="round"
          paintOrder="stroke"
        >
          {place}
        </text>
        <text
          x={4}
          y={57}
          textAnchor="start"
          style={{ fontFamily: "inherit", fontWeight: 900, fontSize: 62, letterSpacing: "-0.03em" }}
          fill={face}
        >
          {place}
        </text>
        <text
          x={place >= 10 ? 78 : 46}
          y={30}
          style={{ fontFamily: "inherit", fontWeight: 900, fontSize: 24, letterSpacing: "0.02em" }}
          fill={face}
          stroke="#0a1120"
          strokeWidth={7}
          strokeLinejoin="round"
          paintOrder="stroke"
        >
          {ordinalSuffix(place)}
        </text>
        <text
          x={place >= 10 ? 78 : 46}
          y={30}
          style={{ fontFamily: "inherit", fontWeight: 900, fontSize: 24 }}
          fill={face}
        >
          {ordinalSuffix(place)}
        </text>
        <text
          x={place >= 10 ? 80 : 48}
          y={57}
          style={{ fontFamily: "inherit", fontWeight: 900, fontSize: 17, letterSpacing: "0.08em" }}
          fill={edge}
          stroke="#0a1120"
          strokeWidth={5}
          strokeLinejoin="round"
          paintOrder="stroke"
          opacity={0.95}
        >
          {`/ ${total}`}
        </text>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Minimap
// ---------------------------------------------------------------------------

interface Dot {
  id: number;
  color: string;
  isPlayer: boolean;
}

function rosterColor(models: ModelsView | undefined, characterId: string, fallback: string): string {
  const preset: CharacterPreset | undefined =
    models?.preset?.(characterId) ?? models?.roster?.find((p) => p.id === characterId);
  return preset ? hex(preset.colors.body) : fallback;
}

const FALLBACK_DOTS = ["#ff5d7a", "#3ad9ff", "#8ff05a", "#ffb03a", "#b57bff", "#ff8ad4", "#5ce0c0", "#ffe066"];

export function MinimapPanel() {
  const rt = useRuntime();
  const minimap = rt.ctx.services.minimap as MinimapView | undefined;
  const track = rt.ctx.services.track as TrackView | undefined;
  const nodes = useRef(new Map<number, SVGGElement | null>());

  // The dot list only changes when the field does, so it is sampled, not framed.
  const dots = useSample<Dot[]>(
    () => {
      const physics = rt.ctx.services.physics as PhysicsView | undefined;
      const models = rt.ctx.services.models as ModelsView | undefined;
      const racers = physics?.racers ?? [];
      return racers.map((r, i) => ({
        id: r.id,
        isPlayer: r.isPlayer,
        color: rosterColor(models, r.characterId, FALLBACK_DOTS[i % FALLBACK_DOTS.length]),
      }));
    },
    (a, b) => a.length === b.length && a.every((d, i) => d.id === b[i].id && d.color === b[i].color),
  );

  const forward = useRef({ x: 0, y: 0, z: 0 });

  useKartFrame(() => {
    const physics = rt.ctx.services.physics as PhysicsView | undefined;
    const map = rt.ctx.services.minimap as MinimapView | undefined;
    if (!physics || !map) return;
    for (const racer of physics.racers) {
      const node = nodes.current.get(racer.id);
      if (!node) continue;
      const p = map.toMinimap(racer.position);
      let deg = 0;
      if (racer.isPlayer && map.heading) {
        // -Z is the kart's forward; rotate it by the body quaternion by hand
        // rather than allocating a Vector3 every frame for every racer.
        const q = racer.quaternion;
        forward.current.x = -2 * (q.x * q.z + q.w * q.y);
        forward.current.y = -2 * (q.y * q.z - q.w * q.x);
        forward.current.z = -(1 - 2 * (q.x * q.x + q.y * q.y));
        deg = (map.heading(forward.current) * 180) / Math.PI;
      }
      node.setAttribute(
        "transform",
        `translate(${p.x.toFixed(4)} ${p.y.toFixed(4)})${racer.isPlayer ? ` rotate(${deg.toFixed(1)})` : ""}`,
      );
      node.style.opacity = racer.finished ? "0.45" : "1";
    }
  });

  const road = minimap?.roadWidth ?? 0.055;
  const line = minimap?.startLine;

  return (
    <div className="vk-map">
      <svg viewBox="0 0 1 1" aria-label="Course map">
        {minimap?.path ? (
          <g>
            <path
              d={minimap.path}
              fill="none"
              stroke="#0a1424"
              strokeWidth={road * 1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <path
              d={minimap.path}
              fill="none"
              stroke="#8fa6c4"
              strokeWidth={road}
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={0.92}
            />
            <path
              d={minimap.path}
              fill="none"
              stroke="#fff3cf"
              strokeWidth={road * 0.12}
              strokeDasharray={`${road * 0.5} ${road * 0.7}`}
              opacity={0.6}
            />
          </g>
        ) : null}

        {line ? (
          <line
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            stroke="#ffcc22"
            strokeWidth={road * 0.34}
            strokeLinecap="round"
          />
        ) : null}

        {dots.map((d) =>
          d.isPlayer ? (
            <g
              key={d.id}
              ref={(el) => nodes.current.set(d.id, el)}
              style={{ transition: "opacity 0.2s linear" }}
            >
              <circle r={road * 0.72} fill="#ffffff" opacity={0.35} />
              <path
                d={`M0 ${(-road * 0.62).toFixed(4)} L${(road * 0.44).toFixed(4)} ${(road * 0.5).toFixed(4)} L0 ${(road * 0.24).toFixed(4)} L${(-road * 0.44).toFixed(4)} ${(road * 0.5).toFixed(4)} Z`}
                fill="#fff7e6"
                stroke="#0a1120"
                strokeWidth={road * 0.1}
                strokeLinejoin="round"
              />
            </g>
          ) : (
            <g key={d.id} ref={(el) => nodes.current.set(d.id, el)} style={{ transition: "opacity 0.2s linear" }}>
              <circle r={road * 0.42} fill={d.color} stroke="#0a1120" strokeWidth={road * 0.12} />
            </g>
          ),
        )}
      </svg>
      <div className="vk-map-name">{track?.name ?? "Sunset Bluff"}</div>
    </div>
  );
}
