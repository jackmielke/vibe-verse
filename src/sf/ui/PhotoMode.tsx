/**
 * Photo mode.
 *
 * A free camera, a real lens, and an export that matches the preview.
 *
 * Three decisions worth stating:
 *   - The camera is flown with WASD/QE and mouse-drag look, written straight
 *     into `photoRig` (see photo.ts) and consumed inside the R3F tree by
 *     `PhotoCameraRig`. No React state is involved in camera motion.
 *   - Focus is a real lens: distance in metres and an f-number, handed to the
 *     post chain's DoF. Auto-focus taps the depth buffer under the centre of
 *     frame, exactly as a camera would.
 *   - Filters are CSS filter strings applied to the live canvas AND replayed
 *     through a 2D context at export, so the PNG is what you were looking at.
 *     A photo mode whose export does not match its preview is a bug, not a
 *     limitation.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { frame, useSfStore } from "../state/store";
import { postfx } from "../postfx/state";
import { useUiFrame, setText } from "./raf";
import { useUiStore } from "./uiStore";
import {
  PHOTO_FILTERS,
  applyPhotoLens,
  enterPhotoMode,
  exitPhotoMode,
  exportPhoto,
  photoRig,
} from "./photo";
import { COLORS, rgba } from "./theme";
import { clockTime12 } from "./format";

const ASPECTS = [
  { id: 0, label: "NATIVE" },
  { id: 16 / 9, label: "16:9" },
  { id: 2.39, label: "2.39" },
  { id: 1, label: "1:1" },
  { id: 4 / 5, label: "4:5" },
];

export default function PhotoMode() {
  const route = useUiStore((s) => s.route);
  const go = useUiStore((s) => s.go);
  const setPhase = useSfStore((s) => s.setPhase);
  const open = route === "photo";

  // Panel-visible state. These are user-facing knobs that change on a click,
  // not per frame, so React is the right owner.
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);
  const [aspect, setAspect] = useState(0);
  const [watermark, setWatermark] = useState(true);
  const [saved, setSaved] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  const posRef = useRef<HTMLSpanElement>(null);
  const focusRef = useRef<HTMLSpanElement>(null);

  /* --- lifecycle --------------------------------------------------- */
  useEffect(() => {
    if (!open) return;
    enterPhotoMode();
    setPhase("photo");
    document.exitPointerLock?.();
    applyPhotoLens();
    return () => {
      exitPhotoMode();
      setPhase("playing");
    };
  }, [open, setPhase]);

  /* --- camera input ------------------------------------------------ */
  useEffect(() => {
    if (!open) return;

    const down = new Set<string>();
    const apply = () => {
      photoRig.moveZ = (down.has("KeyW") ? 1 : 0) - (down.has("KeyS") ? 1 : 0);
      photoRig.moveX = (down.has("KeyD") ? 1 : 0) - (down.has("KeyA") ? 1 : 0);
      photoRig.moveY = (down.has("KeyE") ? 1 : 0) - (down.has("KeyQ") ? 1 : 0);
      photoRig.speed = down.has("ShiftLeft") ? 46 : down.has("AltLeft") ? 3 : 14;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === "Escape") {
        go("none");
        return;
      }
      if (e.code === "F2") {
        void doExport();
        return;
      }
      if (e.code === "Tab") {
        e.preventDefault();
        setPanelOpen((p) => !p);
        return;
      }
      down.add(e.code);
      apply();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      down.delete(e.code);
      apply();
    };
    const onBlur = () => {
      down.clear();
      apply();
    };

    let dragging = false;
    const onDown = (e: PointerEvent) => {
      // Only in the viewport, never over the panel.
      if ((e.target as HTMLElement)?.closest?.("[data-photo-panel]")) return;
      dragging = true;
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const sens = 0.0026;
      photoRig.yaw -= e.movementX * sens;
      photoRig.pitch -= e.movementY * sens;
      const lim = Math.PI * 0.499;
      photoRig.pitch = Math.max(-lim, Math.min(lim, photoRig.pitch));
    };
    const onUp = () => {
      dragging = false;
    };
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement)?.closest?.("[data-photo-panel]")) return;
      e.preventDefault();
      // Wheel is a zoom ring: it moves focal length, not position.
      photoRig.fov = Math.max(12, Math.min(115, photoRig.fov + e.deltaY * 0.02));
      rerender();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("wheel", onWheel);
      photoRig.moveX = photoRig.moveY = photoRig.moveZ = 0;
    };
  }, [open, go]);

  /* --- live readouts ----------------------------------------------- */
  useUiFrame(() => {
    setText(
      posRef.current,
      `${photoRig.x.toFixed(0)}, ${photoRig.y.toFixed(0)}, ${photoRig.z.toFixed(0)}`,
    );
    setText(
      focusRef.current,
      photoRig.autoFocus ? `${postfx.measuredFocus.toFixed(1)} M AUTO` : `${photoRig.focusDistance.toFixed(1)} M`,
    );
  }, open);

  const doExport = async () => {
    const ok = await exportPhoto({
      watermark,
      aspect: ASPECTS[aspect].id,
      vignette: 0.16,
    });
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    }
  };

  if (!open) return null;

  const grid = photoRig.grid;

  return (
    <div className="fixed inset-0" style={{ zIndex: 55, pointerEvents: "none" }}>
      {/* Composition guides */}
      {grid !== "none" && (
        <svg className="absolute inset-0 w-full h-full" style={{ opacity: 0.28 }}>
          {grid === "thirds" && (
            <>
              <line x1="33.333%" y1="0" x2="33.333%" y2="100%" stroke="#fff" strokeWidth={1} />
              <line x1="66.666%" y1="0" x2="66.666%" y2="100%" stroke="#fff" strokeWidth={1} />
              <line x1="0" y1="33.333%" x2="100%" y2="33.333%" stroke="#fff" strokeWidth={1} />
              <line x1="0" y1="66.666%" x2="100%" y2="66.666%" stroke="#fff" strokeWidth={1} />
            </>
          )}
          {grid === "golden" && (
            <>
              <line x1="38.2%" y1="0" x2="38.2%" y2="100%" stroke="#fff" strokeWidth={1} />
              <line x1="61.8%" y1="0" x2="61.8%" y2="100%" stroke="#fff" strokeWidth={1} />
              <line x1="0" y1="38.2%" x2="100%" y2="38.2%" stroke="#fff" strokeWidth={1} />
              <line x1="0" y1="61.8%" x2="100%" y2="61.8%" stroke="#fff" strokeWidth={1} />
            </>
          )}
          {grid === "centre" && (
            <>
              <line x1="50%" y1="0" x2="50%" y2="100%" stroke="#fff" strokeWidth={1} />
              <line x1="0" y1="50%" x2="100%" y2="50%" stroke="#fff" strokeWidth={1} />
            </>
          )}
        </svg>
      )}

      {/* Letterbox preview for the chosen export aspect */}
      {ASPECTS[aspect].id > 0 && <Letterbox aspect={ASPECTS[aspect].id} />}

      {/* Panel */}
      <div
        data-photo-panel=""
        className="absolute sf-pe sf-glass sf-scroll"
        style={{
          right: 24,
          top: 24,
          bottom: 24,
          width: 306,
          padding: 20,
          transform: panelOpen ? "translateX(0)" : "translateX(330px)",
          transition: "transform var(--sf-dur) var(--sf-ease)",
        }}
      >
        <div className="flex items-center gap-2 mb-4">
          <div style={{ width: 3, height: 20, background: COLORS.signal }} />
          <div className="flex flex-col">
            <span className="sf-display" style={{ fontSize: 13, letterSpacing: "0.04em" }}>
              PHOTO MODE
            </span>
            <span className="sf-label" style={{ fontSize: 7, letterSpacing: "0.26em" }}>
              WASD · Q/E · DRAG TO LOOK · TAB HIDES THIS
            </span>
          </div>
        </div>

        <Group label="LENS">
          <Row label="Focal length">
            <MiniSlider
              value={photoRig.fov}
              min={12}
              max={115}
              step={0.5}
              invert
              onChange={(v) => {
                photoRig.fov = v;
                rerender();
              }}
            />
            <Value>{`${fovToMm(photoRig.fov).toFixed(0)}MM`}</Value>
          </Row>
          <Row label="Aperture">
            <MiniSlider
              value={photoRig.aperture}
              min={0.95}
              max={22}
              step={0.05}
              onChange={(v) => {
                photoRig.aperture = v;
                applyPhotoLens();
                rerender();
              }}
            />
            <Value>{`f/${photoRig.aperture.toFixed(1)}`}</Value>
          </Row>
          <Row label="Focus">
            <MiniSlider
              value={photoRig.focusDistance}
              min={0.4}
              max={600}
              step={0.1}
              disabled={photoRig.autoFocus}
              onChange={(v) => {
                photoRig.focusDistance = v;
                photoRig.autoFocus = false;
                applyPhotoLens();
                rerender();
              }}
            />
            <Value>
              <span ref={focusRef}>—</span>
            </Value>
          </Row>
          <Row label="Blur amount">
            <MiniSlider
              value={photoRig.dofBlend}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => {
                photoRig.dofBlend = v;
                applyPhotoLens();
                rerender();
              }}
            />
            <Value>{`${Math.round(photoRig.dofBlend * 100)}%`}</Value>
          </Row>
          <div className="flex gap-1 mt-1">
            <button
              className="sf-chip"
              data-on={photoRig.autoFocus ? "1" : "0"}
              onClick={() => {
                photoRig.autoFocus = !photoRig.autoFocus;
                applyPhotoLens();
                rerender();
              }}
            >
              AUTOFOCUS
            </button>
            <button
              className="sf-chip"
              onClick={() => {
                photoRig.focusDistance = postfx.measuredFocus;
                photoRig.autoFocus = false;
                applyPhotoLens();
                rerender();
              }}
            >
              FOCUS HERE
            </button>
          </div>
        </Group>

        <Group label="CAMERA">
          <Row label="Dutch angle">
            <MiniSlider
              value={photoRig.roll}
              min={-0.6}
              max={0.6}
              step={0.005}
              onChange={(v) => {
                photoRig.roll = v;
                rerender();
              }}
            />
            <Value>{`${((photoRig.roll * 180) / Math.PI).toFixed(0)}°`}</Value>
          </Row>
          <Row label="Fly speed">
            <MiniSlider
              value={photoRig.speed}
              min={1}
              max={80}
              step={0.5}
              onChange={(v) => {
                photoRig.speed = v;
                rerender();
              }}
            />
            <Value>{`${photoRig.speed.toFixed(0)} M/S`}</Value>
          </Row>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="sf-label" style={{ fontSize: 7, letterSpacing: "0.2em" }}>
              POSITION
            </span>
            <span ref={posRef} className="sf-num" style={{ fontSize: 9, color: "rgba(255,255,255,0.6)" }} />
          </div>
        </Group>

        <Group label="WORLD">
          <Row label="Time of day">
            <MiniSlider
              value={frame.timeOfDay}
              min={0}
              max={24}
              step={0.05}
              onChange={(v) => {
                frame.timeOfDay = v;
                rerender();
              }}
            />
            <Value>{clockTime12(frame.timeOfDay)}</Value>
          </Row>
          <Row label="Fog">
            <MiniSlider
              value={frame.fogDensity}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => {
                frame.fogDensity = v;
                rerender();
              }}
            />
            <Value>{`${Math.round(frame.fogDensity * 100)}%`}</Value>
          </Row>
          <Row label="Exposure">
            <MiniSlider
              value={postfx.exposure}
              min={0.3}
              max={2.4}
              step={0.01}
              onChange={(v) => {
                postfx.exposure = v;
                rerender();
              }}
            />
            <Value>{`${postfx.exposure.toFixed(2)}×`}</Value>
          </Row>
          <div className="flex gap-1 mt-1 flex-wrap">
            {[
              ["Dawn", 6.4],
              ["Noon", 12.5],
              ["Golden", 18.6],
              ["Blue", 20.1],
              ["Night", 23.2],
            ].map(([l, h]) => (
              <button
                key={l as string}
                className="sf-chip"
                onClick={() => {
                  frame.timeOfDay = h as number;
                  rerender();
                }}
              >
                {l as string}
              </button>
            ))}
          </div>
        </Group>

        <Group label="LOOK">
          <div className="flex gap-1 flex-wrap">
            {PHOTO_FILTERS.map((f) => (
              <button
                key={f.id}
                className="sf-chip"
                data-on={photoRig.filter === f.id ? "1" : "0"}
                onClick={() => {
                  photoRig.filter = f.id;
                  applyPhotoLens();
                  rerender();
                }}
              >
                {f.name}
              </button>
            ))}
          </div>
        </Group>

        <Group label="FRAME">
          <div className="flex gap-1 flex-wrap mb-2">
            {ASPECTS.map((a, i) => (
              <button key={a.label} className="sf-chip" data-on={aspect === i ? "1" : "0"} onClick={() => setAspect(i)}>
                {a.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1 flex-wrap">
            {(["none", "thirds", "golden", "centre"] as const).map((gk) => (
              <button
                key={gk}
                className="sf-chip"
                data-on={photoRig.grid === gk ? "1" : "0"}
                onClick={() => {
                  photoRig.grid = gk;
                  rerender();
                }}
              >
                {gk.toUpperCase()}
              </button>
            ))}
          </div>
        </Group>

        <Group label="OUTPUT">
          <div className="flex gap-1 flex-wrap mb-3">
            <button className="sf-chip" data-on={watermark ? "1" : "0"} onClick={() => setWatermark((w) => !w)}>
              TITLE CARD
            </button>
            <button
              className="sf-chip"
              data-on={photoRig.hideHud ? "1" : "0"}
              onClick={() => {
                photoRig.hideHud = !photoRig.hideHud;
                rerender();
              }}
            >
              HIDE HUD
            </button>
          </div>
          <button className="sf-btn" data-primary="1" onClick={doExport} style={{ justifyContent: "center" }}>
            {saved ? "SAVED" : "CAPTURE · F2"}
          </button>
          <button className="sf-btn mt-1" onClick={() => go("none")} style={{ justifyContent: "center" }}>
            EXIT · ESC
          </button>
        </Group>
      </div>

      {/* Panel handle when collapsed */}
      {!panelOpen && (
        <button
          className="sf-chip sf-pe absolute"
          style={{ right: 24, top: 24 }}
          onClick={() => setPanelOpen(true)}
        >
          PHOTO
        </button>
      )}

      {saved && (
        <div
          className="absolute sf-anim-pop"
          style={{ left: "50%", top: 40, transform: "translateX(-50%)" }}
        >
          <span
            className="sf-label"
            style={{
              fontSize: 9,
              letterSpacing: "0.3em",
              color: "#0b0500",
              background: COLORS.signal,
              padding: "6px 14px",
            }}
          >
            PNG SAVED
          </span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Bits
 * ------------------------------------------------------------------ */

function Letterbox({ aspect }: { aspect: number }) {
  const [size, setSize] = useState(() => ({
    w: typeof window === "undefined" ? 1920 : window.innerWidth,
    h: typeof window === "undefined" ? 1080 : window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const native = size.w / size.h;
  const bar =
    native > aspect
      ? { left: (size.w - size.h * aspect) / 2, top: 0 }
      : { left: 0, top: (size.h - size.w / aspect) / 2 };
  return (
    <>
      {bar.top > 0 && (
        <>
          <div className="absolute left-0 right-0 top-0" style={{ height: bar.top, background: "#000" }} />
          <div className="absolute left-0 right-0 bottom-0" style={{ height: bar.top, background: "#000" }} />
        </>
      )}
      {bar.left > 0 && (
        <>
          <div className="absolute top-0 bottom-0 left-0" style={{ width: bar.left, background: "#000" }} />
          <div className="absolute top-0 bottom-0 right-0" style={{ width: bar.left, background: "#000" }} />
        </>
      )}
    </>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="flex items-center gap-2 mb-2">
        <span className="sf-label" style={{ fontSize: 7, letterSpacing: "0.3em" }}>
          {label}
        </span>
        <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.1)" }} />
      </div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-1.5">
      <span className="sf-text block" style={{ fontSize: 10, color: "rgba(255,255,255,0.62)" }}>
        {label}
      </span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function Value({ children }: { children: ReactNode }) {
  return (
    <span
      className="sf-num"
      style={{ fontSize: 10, color: COLORS.signal, minWidth: 56, textAlign: "right" }}
    >
      {children}
    </span>
  );
}

function MiniSlider({
  value,
  min,
  max,
  step,
  onChange,
  disabled,
  invert,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  invert?: boolean;
}) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <input
      className="sf-range"
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      style={
        {
          opacity: disabled ? 0.35 : 1,
          direction: invert ? "rtl" : "ltr",
          "--sf-fill": `${fill}%`,
        } as CSSProperties
      }
      onChange={(e) => onChange(parseFloat(e.target.value))}
    />
  );
}

/** Vertical FOV in degrees → 35 mm-equivalent focal length. Photographers
 *  think in millimetres, and photo mode should speak their language. */
function fovToMm(fovDeg: number): number {
  const halfRad = (fovDeg * 0.5 * Math.PI) / 180;
  return 12 / Math.tan(halfRad); // 24 mm full-frame sensor height
}

/** Rough inverse, kept for symmetry with `fovToMm`. */
export function mmToFov(mm: number): number {
  return (2 * Math.atan(12 / mm) * 180) / Math.PI;
}
