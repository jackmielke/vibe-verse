/**
 * The full-screen map.
 *
 * Same renderer as the minimap, given a bigger canvas, a pan/zoom camera and
 * the labels the small one cannot afford. Everything on it is real: the
 * coastline is `LANDMASSES`, the grid is the same two-grids-meeting-at-Market
 * plan the city is generated from, the relief is sampled from `terrainHeight`,
 * and the landmark list is `LANDMARKS` sorted by true distance.
 *
 * Interaction is deliberately mouse-native rather than console-native,
 * because this runs in a browser: drag to pan, wheel to zoom about the
 * cursor, click to drop a waypoint, right-click to clear it.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DISTRICTS, LANDMARKS, WORLD, districtAt, worldToLatLon } from "../geo/sfGeo";
import { frame, sf, useSfStore } from "../state/store";
import { hudTelemetry } from "./telemetry";
import { subscribeUiFrame, setText } from "./raf";
import { useUiStore } from "./uiStore";
import {
  FULLMAP_STYLE,
  drawBaseMap,
  drawHeat,
  drawPin,
  drawPlayer,
  s2w,
  w2s,
  type MapView,
} from "./map/mapRender";
import { buildHillshade, getHillshade, hillshadeProgress } from "./map/hillshade";
import { COLORS, cvdColor, rgba } from "./theme";
import { distance as fmtDistance, cardinal, bearingTo } from "./format";
import { useScreen } from "@/lib/screen";

const MIN_PPM = 0.028;
const MAX_PPM = 1.1;

export default function MapScreen() {
  const route = useUiStore((s) => s.route);
  const open = route === "map";
  const back = useUiStore((s) => s.back);
  const waypoint = useUiStore((s) => s.waypoint);
  const setWaypoint = useUiStore((s) => s.setWaypoint);
  const trackObjective = useUiStore((s) => s.trackObjective);
  const cvd = useUiStore((s) => s.settings.colorblind);
  const mapCenter = useUiStore((s) => s.mapCenter);
  const mapZoom = useUiStore((s) => s.mapZoom);
  const setMapView = useUiStore((s) => s.setMapView);
  const objectives = useSfStore((s) => s.objectives);
  const discovered = useSfStore((s) => s.discovered);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const reliefRef = useRef<HTMLSpanElement>(null);
  const [relief, setRelief] = useState(true);
  const [hover, setHover] = useState<{ x: number; z: number } | null>(null);
  /* A phone stacks the map over the list instead of putting them side by
     side, and loses the readouts and the legend: 393 px is not wide enough
     for a sidebar, and the legend was three words in seven-point type. */
  const screen = useScreen();
  const phone = screen.phone;
  const touch = screen.touch;
  /* Upright, the list goes under the map; on its side there is width for the
     sidebar and no height for a stack — one landmark showed. */
  const stack = phone && screen.portrait;
  const SIDEBAR = phone ? 250 : 300;
  const HEADER = phone ? 52 : 70;
  const FOOTER = 46;
  /* The landmark you tapped last. On a phone there is no double-click; the
     second tap on the same name is the waypoint. */
  const lastTap = useRef<string | null>(null);

  // The live camera. Kept in a ref so dragging does not re-render React 60
  // times a second; the store is only written when the gesture ends.
  const view = useRef<MapView>({
    cx: mapCenter.x,
    cz: mapCenter.z,
    ppm: mapZoom,
    rot: 0,
    w: 100,
    h: 100,
  });
  const dirty = useRef(true);

  // Opening the map on the player is almost always what you want; the stored
  // camera is only honoured if it is still within a couple of blocks.
  useEffect(() => {
    if (!open) return;
    const far =
      Math.hypot(view.current.cx - frame.position.x, view.current.cz - frame.position.z) > 900;
    if (far || (view.current.cx === 0 && view.current.cz === 0)) {
      view.current.cx = frame.position.x;
      view.current.cz = frame.position.z;
      if (view.current.ppm < MIN_PPM) view.current.ppm = 0.18;
    }
    dirty.current = true;
    buildHillshade();
  }, [open]);

  // Persist the camera when the map closes.
  useEffect(() => {
    if (open) return;
    setMapView(view.current.cx, view.current.cz, view.current.ppm);
  }, [open, setMapView]);

  const redraw = useCallback(() => {
    const cv = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(64, Math.round(rect.width));
    const h = Math.max(64, Math.round(rect.height));
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr;
      cv.height = h * dpr;
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
    }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const v = view.current;
    v.w = w;
    v.h = h;
    v.ppm = Math.max(MIN_PPM, Math.min(MAX_PPM, v.ppm));
    // Never let the player pan the city off the screen entirely.
    const pad = 1200;
    v.cx = Math.max(WORLD.minX - pad, Math.min(WORLD.maxX + pad, v.cx));
    v.cz = Math.max(WORLD.minZ - pad, Math.min(WORLD.maxZ + pad, v.cz));

    ctx.clearRect(0, 0, w, h);
    FULLMAP_STYLE.hillshade = relief ? getHillshade() : null;
    drawBaseMap(ctx, v, FULLMAP_STYLE);

    const s = sf();

    if (s.heat > 0) {
      drawHeat(ctx, v, frame.position.x, frame.position.z, 140 + s.heat * 160, Math.min(1, s.heat / 3));
    }

    const contacts = hudTelemetry.contacts;
    for (let i = 0; i < hudTelemetry.contactCount; i++) {
      const c = contacts[i];
      if (!c) continue;
      const col =
        c.kind === "police"
          ? cvdColor("info", cvd)
          : c.kind === "enemy"
            ? cvdColor("danger", cvd)
            : "rgba(255,255,255,0.4)";
      drawPin(ctx, v, c.x, c.z, col, "contact");
    }

    for (const o of s.objectives) {
      if (o.complete) continue;
      drawPin(ctx, v, o.x, o.z, COLORS.signal, "objective", (frame.time * 0.8) % 1);
    }

    const wp = useUiStore.getState().waypoint;
    if (wp) {
      drawPin(ctx, v, wp.x, wp.z, cvdColor("info", cvd), "waypoint");
      // A hairline from the player to the pin: the map's job is to answer
      // "which way", and a line answers it instantly.
      const a = w2s(v, frame.position.x, frame.position.z);
      const ax = a.x;
      const ay = a.y;
      const b = w2s(v, wp.x, wp.z);
      ctx.save();
      ctx.strokeStyle = rgba(cvdColor("info", cvd), 0.5);
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }

    drawPlayer(ctx, v, frame.position.x, frame.position.z, frame.yaw);
  }, [cvd, relief]);

  // Redraw loop: cheap, throttled, and only while the map is on screen.
  useEffect(() => {
    if (!open) return;
    let acc = 0;
    return subscribeUiFrame((_, dt) => {
      acc += dt;
      // 12 Hz is plenty for a map; the player arrow is the only moving part.
      if (acc < 1 / 12 && !dirty.current) return;
      acc = 0;
      dirty.current = false;
      redraw();
      const p = hillshadeProgress();
      setText(reliefRef.current, p >= 1 ? "RELIEF" : `RELIEF ${Math.round(p * 100)}%`);
    });
  }, [open, redraw]);

  // --- gestures -----------------------------------------------------
  useEffect(() => {
    if (!open) return;
    const wrap = wrapRef.current;
    if (!wrap) return;

    /* Every pointer that is down, by id. One finger pans; two pinch — the
       zoom is about the midpoint and the midpoint's drift pans, which is the
       gesture every map on a phone has taught everybody. A mouse is one
       pointer and gets the pan. */
    const pointers = new Map<number, { x: number; y: number }>();
    let moved = 0;
    let pinchDist = 0;
    let pinchMidX = 0;
    let pinchMidY = 0;

    const zoomAbout = (sx: number, sy: number, k: number) => {
      const before = s2w(view.current, sx, sy);
      const bx = before.x;
      const bz = before.z;
      view.current.ppm = Math.max(MIN_PPM, Math.min(MAX_PPM, view.current.ppm * k));
      // Keep the world point under the cursor pinned — the only zoom that
      // does not feel like fighting the map.
      const after = s2w(view.current, sx, sy);
      view.current.cx += bx - after.x;
      view.current.cz += bz - after.z;
      dirty.current = true;
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (pointers.size === 0) moved = 0;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      wrap.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        pinchMidX = (a.x + b.x) / 2;
        pinchMidY = (a.y + b.y) / 2;
      }
    };
    const onMove = (e: PointerEvent) => {
      const rect = wrap.getBoundingClientRect();
      const p = s2w(view.current, e.clientX - rect.left, e.clientY - rect.top);
      if (e.pointerType === "mouse") setHover({ x: p.x, z: p.z });
      const t = pointers.get(e.pointerId);
      if (!t) return;
      const dx = e.clientX - t.x;
      const dy = e.clientY - t.y;
      t.x = e.clientX;
      t.y = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        if (pinchDist > 0) zoomAbout(midX - rect.left, midY - rect.top, dist / pinchDist);
        view.current.cx -= (midX - pinchMidX) / view.current.ppm;
        view.current.cz -= (midY - pinchMidY) / view.current.ppm;
        pinchDist = dist;
        pinchMidX = midX;
        pinchMidY = midY;
        dirty.current = true;
        return;
      }
      view.current.cx -= dx / view.current.ppm;
      view.current.cz -= dy / view.current.ppm;
      dirty.current = true;
    };
    const onUp = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const wasPinch = pointers.size >= 2;
      pointers.delete(e.pointerId);
      wrap.releasePointerCapture?.(e.pointerId);
      if (pointers.size > 0) {
        // The other finger carries on as a pan from where it is now.
        pinchDist = 0;
        return;
      }
      // A click or a tap, not a drag or a pinch: drop a waypoint there.
      if (moved < 5 && !wasPinch) {
        const rect = wrap.getBoundingClientRect();
        const p = s2w(view.current, e.clientX - rect.left, e.clientY - rect.top);
        const d = districtAt(p.x, p.z);
        setWaypoint({ x: p.x, z: p.z, label: d.name });
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      zoomAbout(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0016));
    };
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      setWaypoint(null);
    };

    wrap.addEventListener("pointerdown", onDown);
    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerup", onUp);
    wrap.addEventListener("pointercancel", onUp);
    wrap.addEventListener("wheel", onWheel, { passive: false });
    wrap.addEventListener("contextmenu", onContext);
    return () => {
      wrap.removeEventListener("pointerdown", onDown);
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerup", onUp);
      wrap.removeEventListener("pointercancel", onUp);
      wrap.removeEventListener("wheel", onWheel);
      wrap.removeEventListener("contextmenu", onContext);
    };
  }, [open, setWaypoint]);

  if (!open) return null;

  const px = frame.position.x;
  const pz = frame.position.z;
  const sortedLandmarks = LANDMARKS.map((l) => ({
    lm: l,
    d: Math.hypot(l.x - px, l.z - pz),
  })).sort((a, b) => a.d - b.d);

  const here = districtAt(px, pz);
  const ll = worldToLatLon(px, pz);

  return (
    <div
      className="fixed inset-0 sf-pe sf-anim-fade"
      style={{
        zIndex: 60,
        background: "radial-gradient(ellipse at 30% 0%, #0d1117 0%, #05060a 70%)",
      }}
    >
      {/* Header */}
      <div
        className="absolute left-0 right-0 top-0 flex items-center gap-4"
        style={{
          height: HEADER,
          borderBottom: "1px solid rgba(255,255,255,0.09)",
          // Past the home button, which keeps its corner over this screen.
          paddingLeft: phone ? "calc(max(env(safe-area-inset-left), 8px) + var(--vv-home-clear, 56px))" : 32,
          paddingRight: phone ? "max(env(safe-area-inset-right), 14px)" : 32,
        }}
      >
        <div className="flex items-center gap-3">
          <div style={{ width: 3, height: 26, background: COLORS.signal }} />
          <div className="flex flex-col">
            <span className="sf-display" style={{ fontSize: phone ? 14 : 17, letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
              SAN FRANCISCO
            </span>
            <span className="sf-label" style={{ fontSize: 8, letterSpacing: "0.32em", whiteSpace: "nowrap" }}>
              TACTICAL MAP
            </span>
          </div>
        </div>

        <div className="flex-1" />

        {phone ? (
          <Readout label="DISTRICT" value={here.name} />
        ) : (
          <div className="flex items-center gap-4">
            <Readout label="DISTRICT" value={here.name} />
            <Readout label="POSITION" value={`${ll.lat.toFixed(4)}, ${ll.lon.toFixed(4)}`} />
            <Readout label="ALT" value={`${Math.round(frame.position.y)} M`} />
          </div>
        )}

        <button className="sf-chip" onClick={back} style={{ marginLeft: 12, minHeight: phone ? 36 : undefined }}>
          CLOSE
        </button>
      </div>

      {/* Canvas */}
      <div
        ref={wrapRef}
        className="absolute"
        style={
          stack
            ? { left: 0, right: 0, top: HEADER, height: "46%", cursor: "crosshair", touchAction: "none" }
            : { left: 0, right: SIDEBAR, top: HEADER, bottom: FOOTER, cursor: "crosshair", touchAction: "none" }
        }
      >
        <canvas ref={canvasRef} style={{ display: "block" }} />

        {/* Scale bar */}
        <div className="absolute left-6 bottom-6 flex items-center gap-2 pointer-events-none">
          <div
            style={{
              width: Math.round(500 * view.current.ppm),
              height: 6,
              borderLeft: "1px solid rgba(255,255,255,0.7)",
              borderRight: "1px solid rgba(255,255,255,0.7)",
              borderBottom: "1px solid rgba(255,255,255,0.7)",
            }}
          />
          <span className="sf-label sf-text" style={{ fontSize: 8 }}>
            500 M
          </span>
        </div>

        {/* Cursor readout */}
        {hover && (
          <div className="absolute right-6 bottom-6 pointer-events-none text-right">
            <span ref={readoutRef} className="sf-num sf-text" style={{ fontSize: 10, opacity: 0.7 }}>
              {`${districtAt(hover.x, hover.z).name.toUpperCase()} · ${fmtDistance(
                Math.hypot(hover.x - px, hover.z - pz),
              )} ${cardinal(bearingTo(px, pz, hover.x, hover.z))}`}
            </span>
          </div>
        )}
      </div>

      {/* Sidebar */}
      <div
        className="absolute right-0 sf-scroll sf-pe"
        style={
          stack
            ? {
                left: 0,
                top: `calc(${HEADER}px + 46%)`,
                bottom: FOOTER,
                borderTop: "1px solid rgba(255,255,255,0.09)",
                background: "rgba(6,8,12,0.72)",
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
                padding: "12px 16px",
                overflowY: "auto",
                WebkitOverflowScrolling: "touch",
              }
            : {
                top: HEADER,
                bottom: FOOTER,
                width: SIDEBAR,
                overflowY: "auto",
                WebkitOverflowScrolling: "touch",
                borderLeft: "1px solid rgba(255,255,255,0.09)",
                background: "rgba(6,8,12,0.6)",
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
                padding: "18px 20px",
              }
        }
      >
        <SectionLabel>WAYPOINT</SectionLabel>
        {waypoint ? (
          <div className="flex items-center gap-2 mb-4">
            <div style={{ width: 8, height: 8, background: cvdColor("info", cvd), transform: "rotate(45deg)" }} />
            <span className="sf-text" style={{ fontSize: 12 }}>
              {waypoint.label}
            </span>
            <div className="flex-1" />
            <span className="sf-num" style={{ fontSize: 11, color: cvdColor("info", cvd) }}>
              {fmtDistance(Math.hypot(waypoint.x - px, waypoint.z - pz))}
            </span>
            <button className="sf-chip" style={{ padding: "1px 6px", fontSize: 8 }} onClick={() => setWaypoint(null)}>
              ✕
            </button>
          </div>
        ) : (
          <p className="sf-text mb-4" style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", lineHeight: 1.5 }}>
            {touch
              ? "Tap the map to drop a waypoint. Tap a landmark twice to send it there."
              : "Click anywhere on the map to drop a waypoint. Right-click to clear it."}
          </p>
        )}

        {objectives.filter((o) => !o.complete).length > 0 && (
          <>
            <SectionLabel>OBJECTIVES</SectionLabel>
            <div className="flex flex-col gap-1 mb-4">
              {objectives
                .filter((o) => !o.complete)
                .map((o) => (
                  <button
                    key={o.id}
                    className="sf-btn"
                    style={{ padding: "7px 10px", fontSize: 10 }}
                    onClick={() => {
                      view.current.cx = o.x;
                      view.current.cz = o.z;
                      dirty.current = true;
                      trackObjective(o.id);
                    }}
                  >
                    <span style={{ color: COLORS.signal }}>▲</span>
                    <span style={{ letterSpacing: "0.1em" }}>{o.title}</span>
                    <div className="flex-1" />
                    <span className="sf-num" style={{ fontSize: 10 }}>
                      {fmtDistance(Math.hypot(o.x - px, o.z - pz))}
                    </span>
                  </button>
                ))}
            </div>
          </>
        )}

        <SectionLabel>{`LANDMARKS · ${discovered.length}/${LANDMARKS.length} FOUND`}</SectionLabel>
        <div className="flex flex-col gap-0.5 mb-4">
          {sortedLandmarks.map(({ lm, d }) => {
            const found = discovered.includes(lm.key);
            return (
              <button
                key={lm.key}
                className="flex items-center gap-2 sf-pe text-left"
                style={{
                  padding: touch ? "9px 6px" : "5px 6px",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  opacity: found ? 1 : 0.5,
                }}
                onClick={() => {
                  view.current.cx = lm.x;
                  view.current.cz = lm.z;
                  view.current.ppm = Math.max(view.current.ppm, 0.32);
                  dirty.current = true;
                  // The second tap on the same name is the waypoint — the
                  // touch equivalent of the double-click below.
                  if (touch && lastTap.current === lm.key) setWaypoint({ x: lm.x, z: lm.z, label: lm.name });
                  lastTap.current = lm.key;
                }}
                onDoubleClick={() => setWaypoint({ x: lm.x, z: lm.z, label: lm.name })}
              >
                <div
                  style={{
                    width: 6,
                    height: 6,
                    background: found ? "#fff" : "rgba(255,255,255,0.35)",
                    transform: "rotate(45deg)",
                    flexShrink: 0,
                  }}
                />
                <span className="sf-text" style={{ fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {lm.name}
                </span>
                <div className="flex-1" />
                <span className="sf-num" style={{ fontSize: 10, color: "rgba(255,255,255,0.45)" }}>
                  {fmtDistance(d)}
                </span>
              </button>
            );
          })}
        </div>

        <SectionLabel>DISTRICTS</SectionLabel>
        <div className="flex flex-wrap gap-1">
          {DISTRICTS.map((d) => (
            <button
              key={d.key}
              className="sf-chip"
              style={{ padding: "3px 7px", fontSize: 8 }}
              data-on={d.key === here.key ? "1" : "0"}
              onClick={() => {
                view.current.cx = d.x;
                view.current.cz = d.z;
                view.current.ppm = 0.24;
                dirty.current = true;
              }}
            >
              {d.name}
            </button>
          ))}
        </div>
      </div>

      {/* Footer toolbar */}
      <div
        className="absolute left-0 right-0 bottom-0 flex items-center gap-2 sf-pe"
        style={{
          height: FOOTER,
          borderTop: "1px solid rgba(255,255,255,0.09)",
          paddingLeft: phone ? "max(env(safe-area-inset-left), 12px)" : 32,
          paddingRight: phone ? "max(env(safe-area-inset-right), 12px)" : 32,
          whiteSpace: "nowrap",
          overflowX: phone ? "auto" : undefined,
        }}
      >
        <button
          className="sf-chip"
          onClick={() => {
            view.current.cx = frame.position.x;
            view.current.cz = frame.position.z;
            view.current.ppm = 0.22;
            dirty.current = true;
          }}
        >
          RECENTRE
        </button>
        <button
          className="sf-chip"
          onClick={() => {
            view.current.cx = (WORLD.minX + WORLD.maxX) / 2;
            view.current.cz = (WORLD.minZ + WORLD.maxZ) / 2;
            view.current.ppm = MIN_PPM * 2.2;
            dirty.current = true;
          }}
        >
          WHOLE CITY
        </button>
        <button className="sf-chip" data-on={relief ? "1" : "0"} onClick={() => { setRelief((r) => !r); dirty.current = true; }}>
          <span ref={reliefRef}>RELIEF</span>
        </button>
        {phone ? (
          <>
            <div className="flex-1" />
            {waypoint && (
              <button className="sf-chip" onClick={() => setWaypoint(null)}>
                CLEAR PIN
              </button>
            )}
          </>
        ) : (
          <>
            <div className="flex-1" />
            <Legend color={COLORS.signal} label="OBJECTIVE" />
            <Legend color={cvdColor("info", cvd)} label="WAYPOINT" />
            <Legend color={cvdColor("danger", cvd)} label="HOSTILE" />
            <Legend color={COLORS.roadBoulevard} label="BOULEVARD" />
            <div className="flex-1" />
            <span className="sf-label" style={{ fontSize: 8, letterSpacing: "0.2em" }}>
              {touch ? "DRAG PAN · PINCH ZOOM · TAP WAYPOINT" : "DRAG PAN · WHEEL ZOOM · CLICK WAYPOINT"}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2 mt-1">
      <span className="sf-label" style={{ fontSize: 8, letterSpacing: "0.26em", whiteSpace: "nowrap" }}>
        {children}
      </span>
      <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.1)" }} />
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-end">
      <span className="sf-label" style={{ fontSize: 7, letterSpacing: "0.24em" }}>
        {label}
      </span>
      <span className="sf-num" style={{ fontSize: 11, color: "rgba(255,255,255,0.85)" }}>
        {value}
      </span>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div style={{ width: 7, height: 7, background: color, borderRadius: 1 }} />
      <span className="sf-label" style={{ fontSize: 7, letterSpacing: "0.2em" }}>
        {label}
      </span>
    </div>
  );
}
