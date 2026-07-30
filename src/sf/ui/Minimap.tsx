/**
 * The minimap.
 *
 * A round, player-centred window onto the same vector map the full screen
 * uses — same coastline, same grid, same landmark glyphs — so switching
 * between them requires no re-learning.
 *
 * Redrawn on a throttled tick rather than every frame. Nothing on a 176 px
 * disc changes meaningfully at 120 Hz, and the canvas work (a few hundred
 * line segments) is worth doing 30 times a second, not 120.
 */
import { useEffect, useRef, useState } from "react";
import { frame, sf } from "../state/store";
import { hudTelemetry } from "./telemetry";
import { subscribeUiFrame, setText } from "./raf";
import { useUiStore } from "./uiStore";
import {
  MINIMAP_STYLE,
  drawBaseMap,
  drawHeat,
  drawPin,
  drawPinAt,
  drawPlayer,
  w2s,
  type MapView,
} from "./map/mapRender";
import { COLORS, cvdColor, rgba } from "./theme";
import { cardinal, yawToBearing, distance as fmtDistance } from "./format";
import { districtAt } from "../geo/sfGeo";

const SIZE = 178;
/** Metres per pixel at each zoom step. Index 1 is the default. */
const ZOOMS = [0.46, 0.28, 0.15, 0.075];
const REDRAW_HZ = 30;

export default function Minimap() {
  const show = useUiStore((s) => s.settings.showMinimap);
  const rotate = useUiStore((s) => s.settings.minimapRotates);
  const cvd = useUiStore((s) => s.settings.colorblind);
  const go = useUiStore((s) => s.go);
  const [zoom, setZoom] = useState(1);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const districtRef = useRef<HTMLSpanElement>(null);
  const northRef = useRef<HTMLDivElement>(null);
  const objRef = useRef<HTMLSpanElement>(null);
  const view = useRef<MapView>({ cx: 0, cz: 0, ppm: ZOOMS[1], rot: 0, w: SIZE, h: SIZE });

  useEffect(() => {
    if (!show) return;
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = SIZE * dpr;
    cv.height = SIZE * dpr;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    let acc = 0;
    const period = 1 / REDRAW_HZ;
    let slow = 0;

    return subscribeUiFrame((_, dt) => {
      acc += dt;
      if (acc < period) return;
      acc = 0;

      const v = view.current;
      v.cx = frame.position.x;
      v.cz = frame.position.z;
      v.ppm = ZOOMS[zoom];
      v.rot = rotate ? frame.yaw : 0;

      ctx.save();
      ctx.beginPath();
      ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2);
      ctx.clip();
      ctx.clearRect(0, 0, SIZE, SIZE);

      drawBaseMap(ctx, v, MINIMAP_STYLE);

      const s = sf();

      // Heat: the search area the police are working, centred on the last
      // place they saw you. Until the AI publishes that, the player's own
      // position is the honest approximation.
      if (s.heat > 0) {
        drawHeat(ctx, v, frame.position.x, frame.position.z, 120 + s.heat * 130, Math.min(1, s.heat / 3));
      }

      // Contacts.
      const contacts = hudTelemetry.contacts;
      for (let i = 0; i < hudTelemetry.contactCount; i++) {
        const c = contacts[i];
        if (!c) continue;
        const col =
          c.kind === "police"
            ? cvdColor("info", cvd)
            : c.kind === "enemy"
              ? cvdColor("danger", cvd)
              : c.kind === "pickup"
                ? cvdColor("good", cvd)
                : "rgba(255,255,255,0.45)";
        drawPin(ctx, v, c.x, c.z, col, "contact", c.alert > 0.6 ? (frame.time * 1.6) % 1 : 0);
      }

      // Objectives + waypoint, clamped to the rim so they never leave.
      const ui = useUiStore.getState();
      for (const o of s.objectives) {
        if (o.complete) continue;
        drawEdgeClamped(ctx, v, o.x, o.z, COLORS.signal, "objective");
      }
      if (ui.waypoint) {
        drawEdgeClamped(ctx, v, ui.waypoint.x, ui.waypoint.z, cvdColor("info", cvd), "waypoint");
      }

      drawPlayer(ctx, v, frame.position.x, frame.position.z, frame.yaw);
      ctx.restore();

      // Text chrome, at reading speed.
      slow += period;
      if (slow > 0.3) {
        slow = 0;
        const d = districtAt(frame.position.x, frame.position.z);
        setText(districtRef.current, d.name.toUpperCase());
        const tracked =
          s.objectives.find((o) => o.id === ui.trackedObjective && !o.complete) ??
          s.objectives.find((o) => !o.complete);
        const target = tracked
          ? { x: tracked.x, z: tracked.z }
          : ui.waypoint
            ? { x: ui.waypoint.x, z: ui.waypoint.z }
            : null;
        setText(
          objRef.current,
          target
            ? fmtDistance(Math.hypot(target.x - frame.position.x, target.z - frame.position.z))
            : "",
        );
      }

      if (northRef.current) {
        const b = rotate ? -yawToBearing(frame.yaw) : 0;
        northRef.current.style.transform = `rotate(${b.toFixed(1)}deg)`;
      }
    });
  }, [show, zoom, rotate, cvd]);

  if (!show) return null;

  return (
    <div className="relative" style={{ width: SIZE }}>
      <div
        className="relative"
        style={{
          width: SIZE,
          height: SIZE,
          borderRadius: "50%",
          overflow: "hidden",
          background: COLORS.waterDeep,
          border: "1px solid rgba(255,255,255,0.18)",
          boxShadow:
            "0 0 0 1px rgba(0,0,0,0.6), 0 14px 40px -14px rgba(0,0,0,0.9), inset 0 0 40px -12px rgba(0,0,0,0.9)",
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: SIZE, height: SIZE, display: "block" }}
          aria-hidden
        />

        {/* Inner graticule ring — cheap, and it makes the disc read as an
            instrument rather than as a cropped picture. */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            borderRadius: "50%",
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.07), inset 0 0 26px 6px rgba(0,0,0,0.55)",
          }}
        />

        {/* Rotating cardinal ring */}
        <div ref={northRef} className="absolute inset-0 pointer-events-none">
          {(["N", "E", "S", "W"] as const).map((c, i) => (
            <span
              key={c}
              className="sf-display sf-text-hard absolute"
              style={{
                fontSize: 9,
                color: i === 0 ? COLORS.signal : "rgba(255,255,255,0.55)",
                left: "50%",
                top: "50%",
                transform: `rotate(${i * 90}deg) translateY(-${SIZE / 2 - 10}px) translateX(-50%) rotate(${-i * 90}deg)`,
                transformOrigin: "0 0",
              }}
            >
              {c}
            </span>
          ))}
        </div>
      </div>

      {/* Footer rail */}
      <div className="flex items-center gap-2 mt-1.5" style={{ width: SIZE }}>
        <span
          ref={districtRef}
          className="sf-label sf-text"
          style={{ fontSize: 8, letterSpacing: "0.2em", color: "rgba(255,255,255,0.78)" }}
        >
          —
        </span>
        <div className="flex-1" />
        <span ref={objRef} className="sf-num sf-text" style={{ fontSize: 9, color: COLORS.signal }} />
      </div>

      <div className="flex items-center gap-1 mt-1">
        <button
          className="sf-chip"
          style={{ padding: "2px 6px", fontSize: 8 }}
          onClick={() => setZoom((z) => Math.max(0, z - 1))}
          title="Zoom out"
        >
          −
        </button>
        <button
          className="sf-chip"
          style={{ padding: "2px 6px", fontSize: 8 }}
          onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}
          title="Zoom in"
        >
          +
        </button>
        <button
          className="sf-chip"
          style={{ padding: "2px 8px", fontSize: 8 }}
          onClick={() => go("map")}
          title="Open the full map"
        >
          MAP
        </button>
        <div className="flex-1" />
        <span className="sf-label sf-text" style={{ fontSize: 7, letterSpacing: "0.18em" }}>
          {`${Math.round(SIZE / 2 / ZOOMS[zoom])}M`}
        </span>
      </div>
    </div>
  );
}

/**
 * Draw a pin, pulling it back to the rim of the disc if it falls outside.
 * A minimap that silently drops the objective marker is worse than useless.
 */
function drawEdgeClamped(
  ctx: CanvasRenderingContext2D,
  v: MapView,
  x: number,
  z: number,
  color: string,
  kind: "objective" | "waypoint",
): void {
  const p = w2s(v, x, z);
  const cx = v.w / 2;
  const cy = v.h / 2;
  let px = p.x;
  let py = p.y;
  const dx = px - cx;
  const dy = py - cy;
  const d = Math.hypot(dx, dy);
  const rim = v.w / 2 - 12;
  if (d > rim) {
    px = cx + (dx / d) * rim;
    py = cy + (dy / d) * rim;
    // Halo so a clamped pin reads as "this way", not "it is here".
    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, 9, 0, Math.PI * 2);
    ctx.fillStyle = rgba(color, 0.18);
    ctx.fill();
    ctx.restore();
  }
  drawPinAt(ctx, px, py, color, kind);
}
