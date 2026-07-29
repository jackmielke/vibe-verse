/**
 * The reticle.
 *
 * This is the single most-looked-at element in the game, and it is also the
 * one that must never cost a React render: the arms move with the live cone
 * every frame. So the SVG is built once per weapon and every subsequent
 * change is a direct attribute write from the shared rAF driver.
 *
 * What it communicates, in priority order:
 *   1. Where the bullet goes (centre).
 *   2. How wide the cone is *right now* — the gap is the true projected cone
 *      at the screen centre, not a decorative approximation.
 *   3. Whether the last round connected (hit / crit / kill markers).
 *   4. Where you are being shot from (direction arcs on the same ring).
 */
import { useMemo, useRef } from "react";
import { frame, useSfStore } from "../../state/store";
import { hudTelemetry } from "../telemetry";
import { useUiFrame, setAttr, approach } from "../raf";
import { weaponUi, spreadToPixels } from "../weaponMeta";
import { useUiStore } from "../uiStore";
import { cvdColor, COLORS } from "../theme";

/** Hit feedback slots. Small, fixed pool — allocation-free. */
const MAX_ARCS = 6;

interface ArcSlot {
  /** 1 → 0 life. */
  t: number;
  /** World bearing of the shooter, radians. */
  dir: number;
  /** 0..1 severity, scales the arc's thickness. */
  weight: number;
}

export interface CrosshairHandle {
  /** Called by the HUD root when a hit event is drained. */
  hit(crit: boolean): void;
  kill(): void;
  damage(direction: number, amount: number): void;
}

export default function Crosshair({ handleRef }: { handleRef?: { current: CrosshairHandle | null } }) {
  const weapon = useSfStore((s) => s.weapon);
  const reloading = useSfStore((s) => s.reloading);
  const cvd = useUiStore((s) => s.settings.colorblind);
  const show = useUiStore((s) => s.settings.showCrosshair);
  const highContrast = useUiStore((s) => s.settings.highContrastHud);
  const meta = weaponUi(weapon);

  const armTop = useRef<SVGGElement>(null);
  const armBottom = useRef<SVGGElement>(null);
  const armLeft = useRef<SVGGElement>(null);
  const armRight = useRef<SVGGElement>(null);
  const ring = useRef<SVGCircleElement>(null);
  const bracketG = useRef<SVGGElement>(null);
  const centre = useRef<SVGGElement>(null);
  const hitG = useRef<SVGGElement>(null);
  const critG = useRef<SVGGElement>(null);
  const killG = useRef<SVGGElement>(null);
  const rootG = useRef<SVGGElement>(null);
  const reloadArc = useRef<SVGCircleElement>(null);
  const arcRefs = useRef<(SVGPathElement | null)[]>([]);

  const state = useRef({
    gap: 14,
    hit: 0,
    crit: 0,
    kill: 0,
    arcs: Array.from({ length: MAX_ARCS }, (): ArcSlot => ({ t: 0, dir: 0, weight: 0 })),
    arcHead: 0,
  });

  // The imperative handle the HUD root pumps events into.
  if (handleRef) {
    handleRef.current = {
      hit(crit: boolean) {
        if (crit) state.current.crit = 1;
        else state.current.hit = 1;
      },
      kill() {
        state.current.kill = 1;
        state.current.hit = 1;
      },
      damage(direction: number, amount: number) {
        const s = state.current;
        const slot = s.arcs[s.arcHead];
        s.arcHead = (s.arcHead + 1) % MAX_ARCS;
        slot.t = 1;
        slot.dir = direction;
        slot.weight = Math.min(1, 0.35 + amount / 45);
      },
    };
  }

  const ink = highContrast ? "#ffffff" : "rgba(255,255,255,0.94)";
  const hostileColor = cvdColor("danger", cvd);
  const critColor = cvdColor("warn", cvd);

  // Arc path for the damage indicator: a 46-degree sector on r=64, drawn once
  // and reused by every slot with only a rotation and opacity changing.
  const arcPath = useMemo(() => sectorPath(64, 78, 46), []);

  useUiFrame((_, dt) => {
    const s = state.current;
    const h = window.innerHeight;

    // --- cone → gap -------------------------------------------------
    const spread = hudTelemetry.spreadDegrees > 0 ? hudTelemetry.spreadDegrees : 1.4;
    const px = spreadToPixels(spread, frame.fov, h);
    // A floor keeps the reticle readable on a laser-accurate sniper; the
    // ceiling stops a shotgun mid-sprint from filling the screen.
    const target = Math.max(6, Math.min(168, px + 5));
    s.gap = approach(s.gap, target, 24, dt);
    const gap = s.gap;

    // Fade out under a scope: the optic reticle takes over, and leaving both
    // on screen at once is the classic amateur tell.
    const ads = hudTelemetry.ads;
    const scopeFade = meta.reticle === "scope" ? 1 - Math.min(1, Math.max(0, (ads - 0.35) / 0.35)) : 1;
    const hostile = hudTelemetry.aimHostile;
    if (rootG.current) {
      rootG.current.style.opacity = String(scopeFade * (reloading ? 0.45 : 1));
      const c = hostile ? hostileColor : ink;
      if (rootG.current.getAttribute("stroke") !== c) rootG.current.setAttribute("stroke", c);
      if (rootG.current.getAttribute("fill") !== c) rootG.current.setAttribute("fill", c);
    }

    setAttr(armTop.current, "transform", `translate(0,${(-gap).toFixed(1)})`);
    setAttr(armBottom.current, "transform", `translate(0,${gap.toFixed(1)})`);
    setAttr(armLeft.current, "transform", `translate(${(-gap).toFixed(1)},0)`);
    setAttr(armRight.current, "transform", `translate(${gap.toFixed(1)},0)`);

    if (ring.current) {
      const r = Math.max(7, gap);
      setAttr(ring.current, "r", r.toFixed(1));
      // Four equal arcs with equal gaps, independent of radius.
      const c = 2 * Math.PI * r;
      const seg = c / 8;
      setAttr(ring.current, "stroke-dasharray", `${seg.toFixed(1)} ${seg.toFixed(1)}`);
    }
    if (bracketG.current) {
      const sc = Math.max(0.5, gap / 20);
      setAttr(bracketG.current, "transform", `scale(${sc.toFixed(3)})`);
    }

    // --- reload ring ------------------------------------------------
    if (reloadArc.current) {
      const p = hudTelemetry.reloadProgress;
      const active = reloading && p > 0 && p < 1;
      const r = 30;
      const c = 2 * Math.PI * r;
      reloadArc.current.style.opacity = active ? "0.95" : "0";
      if (active) {
        setAttr(reloadArc.current, "stroke-dasharray", `${(c * p).toFixed(1)} ${c.toFixed(1)}`);
      }
    }

    // --- hit / crit / kill -----------------------------------------
    s.hit = Math.max(0, s.hit - dt * 3.6);
    s.crit = Math.max(0, s.crit - dt * 3.0);
    s.kill = Math.max(0, s.kill - dt * 1.9);
    applyMarker(hitG.current, s.hit, 1.0);
    applyMarker(critG.current, s.crit, 1.25);
    applyMarker(killG.current, s.kill, 1.5);

    // --- damage direction arcs -------------------------------------
    const camBearing = frame.yaw;
    for (let i = 0; i < MAX_ARCS; i++) {
      const slot = s.arcs[i];
      const el = arcRefs.current[i];
      if (!el) continue;
      if (slot.t <= 0) {
        if (el.style.opacity !== "0") el.style.opacity = "0";
        continue;
      }
      slot.t = Math.max(0, slot.t - dt * 0.55);
      // Relative bearing: where the shot came from, in screen terms.
      const rel = ((slot.dir - camBearing) * 180) / Math.PI;
      // Fast attack, long tail — the arc must be visible instantly and then
      // linger long enough to be acted on.
      const a = slot.t > 0.85 ? (1 - slot.t) / 0.15 : slot.t / 0.85;
      el.style.opacity = (a * (0.5 + 0.5 * slot.weight)).toFixed(3);
      setAttr(el, "transform", `rotate(${rel.toFixed(1)})`);
      setAttr(el, "stroke-width", (3 + slot.weight * 6).toFixed(1));
    }
  }, show);

  if (!show) return null;

  const armLen = 11;
  const armW = 2.0;

  return (
    <div
      className="sf-cluster pointer-events-none"
      data-anchor="c"
      aria-hidden
      style={{ width: 400, height: 400, marginLeft: -0, marginTop: -0 }}
    >
      <svg
        width={400}
        height={400}
        viewBox="-200 -200 400 400"
        style={{ display: "block", overflow: "visible" }}
      >
        {/* Damage-direction arcs sit outside the reticle proper and keep
            their own colour — they are a different message. */}
        <g fill="none" stroke={hostileColor} strokeLinecap="butt">
          {Array.from({ length: MAX_ARCS }, (_, i) => (
            <path
              key={i}
              ref={(el) => (arcRefs.current[i] = el)}
              d={arcPath}
              style={{ opacity: 0, filter: "drop-shadow(0 0 6px rgba(0,0,0,0.9))" }}
            />
          ))}
        </g>

        <g
          ref={rootG}
          fill={ink}
          stroke={ink}
          style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.95))" }}
        >
          {/* Reload progress ring — a quiet, precise read of "not yet". */}
          <circle
            ref={reloadArc}
            r={30}
            fill="none"
            stroke={COLORS.signal}
            strokeWidth={2}
            transform="rotate(-90)"
            style={{ opacity: 0, transition: "opacity 120ms linear" }}
          />

          {(meta.reticle === "cross" ||
            meta.reticle === "duplex" ||
            meta.reticle === "scope") && (
            <>
              <g ref={armTop}>
                <rect x={-armW / 2} y={-armLen} width={armW} height={armLen} rx={0.6} stroke="rgba(0,0,0,0.85)" strokeWidth={1.4} paintOrder="stroke" />
              </g>
              <g ref={armBottom}>
                <rect x={-armW / 2} y={0} width={armW} height={armLen} rx={0.6} stroke="rgba(0,0,0,0.85)" strokeWidth={1.4} paintOrder="stroke" />
              </g>
              <g ref={armLeft}>
                <rect x={-armLen} y={-armW / 2} width={armLen} height={armW} rx={0.6} stroke="rgba(0,0,0,0.85)" strokeWidth={1.4} paintOrder="stroke" />
              </g>
              <g ref={armRight}>
                <rect x={0} y={-armW / 2} width={armLen} height={armW} rx={0.6} stroke="rgba(0,0,0,0.85)" strokeWidth={1.4} paintOrder="stroke" />
              </g>
            </>
          )}

          {meta.reticle === "pellet" && (
            <circle
              ref={ring}
              r={20}
              fill="none"
              strokeWidth={2.4}
              strokeLinecap="butt"
              transform="rotate(45)"
            />
          )}

          {meta.reticle === "bracket" && (
            <g ref={bracketG} fill="none" strokeWidth={2.2} strokeLinecap="square">
              <path d="M -20 -12 L -20 -20 L -12 -20" />
              <path d="M 12 -20 L 20 -20 L 20 -12" />
              <path d="M 20 12 L 20 20 L 12 20" />
              <path d="M -12 20 L -20 20 L -20 12" />
            </g>
          )}

          {meta.reticle === "lob" && (
            <g fill="none" strokeWidth={1.8} strokeLinecap="round" opacity={0.9}>
              <path d="M -22 10 Q 0 -14 22 10" strokeDasharray="3 4" />
              <path d="M 22 10 l -4 -4 M 22 10 l -5 1" />
            </g>
          )}

          {/* Centre dot: present on every reticle except the plain cross,
              where it would sit inside the bullet's own impact. */}
          {(meta.reticle === "duplex" ||
            meta.reticle === "scope" ||
            meta.reticle === "bracket" ||
            meta.reticle === "lob" ||
            meta.reticle === "pellet") && (
            <g ref={centre}>
              <circle r={1.5} stroke="rgba(0,0,0,0.85)" strokeWidth={1.2} paintOrder="stroke" />
            </g>
          )}
        </g>

        {/* Hit markers. Four diagonal ticks, the universal language. */}
        <g ref={hitG} stroke="#ffffff" strokeWidth={2.2} strokeLinecap="round" style={{ opacity: 0 }}>
          <path d="M -13 -13 L -7 -7" />
          <path d="M 13 -13 L 7 -7" />
          <path d="M -13 13 L -7 7" />
          <path d="M 13 13 L 7 7" />
        </g>
        <g ref={critG} stroke={critColor} strokeWidth={2.8} strokeLinecap="round" style={{ opacity: 0 }}>
          <path d="M -17 -17 L -8 -8" />
          <path d="M 17 -17 L 8 -8" />
          <path d="M -17 17 L -8 8" />
          <path d="M 17 17 L 8 8" />
        </g>
        {/* Kill: the ticks close into an X and go hot. */}
        <g ref={killG} stroke={hostileColor} strokeWidth={3} strokeLinecap="round" style={{ opacity: 0 }}>
          <path d="M -14 -14 L 14 14" />
          <path d="M 14 -14 L -14 14" />
        </g>
      </svg>
    </div>
  );
}

/** Scale + fade a marker group from its 1→0 life value. */
function applyMarker(el: SVGGElement | null, t: number, scale: number) {
  if (!el) return;
  if (t <= 0) {
    if (el.style.opacity !== "0") el.style.opacity = "0";
    return;
  }
  // Punch out then settle: reads as impact rather than as a fade.
  const s = scale * (1.35 - 0.35 * t);
  el.style.opacity = Math.min(1, t * 1.6).toFixed(3);
  el.style.transform = `scale(${s.toFixed(3)})`;
  el.style.transformOrigin = "center";
}

/** An annular sector centred on straight-up, spanning `deg` degrees. */
function sectorPath(rInner: number, rOuter: number, deg: number): string {
  const half = ((deg * 0.5) * Math.PI) / 180;
  const rMid = (rInner + rOuter) * 0.5;
  const x0 = Math.sin(-half) * rMid;
  const y0 = -Math.cos(-half) * rMid;
  const x1 = Math.sin(half) * rMid;
  const y1 = -Math.cos(half) * rMid;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${rMid.toFixed(2)} ${rMid.toFixed(2)} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
