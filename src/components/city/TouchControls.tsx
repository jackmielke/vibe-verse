/**
 * TouchControls — virtual joystick + jetpack button for phones.
 *
 * Renders only on coarse-pointer devices. Writes straight into the
 * refs the City render loop reads every frame — no React state in the
 * movement path, so the joystick is as responsive as the keyboard.
 *
 * Left thumb: joystick (camera-relative move; full deflection = run).
 * Right thumb: hold the rocket to fire the jetpack.
 * The rest of the screen still orbits the camera via the canvas drag.
 */
import { useRef, useState } from "react";
import { Rocket } from "lucide-react";

export interface TouchMove {
  x: number; // -1..1 strafe
  y: number; // -1..1 forward(-) / back(+), screen-space like a thumbstick
}

const RADIUS = 48; // joystick travel in px

// setPointerCapture throws for pointers that are already gone (fast
// taps, synthetic events) — capture is an optimization, not a must.
function safeCapture(el: HTMLElement, pointerId: number) {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* fine without capture */
  }
}

export default function TouchControls({
  moveRef,
  jetRef,
}: {
  moveRef: React.MutableRefObject<TouchMove>;
  jetRef: React.MutableRefObject<boolean>;
}) {
  const baseRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState({ x: 0, y: 0 });
  const [jetDown, setJetDown] = useState(false);
  const activePointer = useRef<number | null>(null);

  const updateFromPointer = (clientX: number, clientY: number) => {
    const base = baseRef.current;
    if (!base) return;
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const len = Math.hypot(dx, dy);
    if (len > RADIUS) {
      dx = (dx / len) * RADIUS;
      dy = (dy / len) * RADIUS;
    }
    setThumb({ x: dx, y: dy });
    moveRef.current = { x: dx / RADIUS, y: dy / RADIUS };
  };

  const release = () => {
    activePointer.current = null;
    setThumb({ x: 0, y: 0 });
    moveRef.current = { x: 0, y: 0 };
  };

  return (
    <>
      {/* Joystick */}
      <div
        ref={baseRef}
        className="absolute bottom-24 left-6 z-20 w-32 h-32 rounded-full border border-border/50 bg-card/30 backdrop-blur-sm touch-none select-none"
        onPointerDown={(e) => {
          e.stopPropagation();
          activePointer.current = e.pointerId;
          safeCapture(e.currentTarget as HTMLElement, e.pointerId);
          updateFromPointer(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (activePointer.current !== e.pointerId) return;
          e.stopPropagation();
          updateFromPointer(e.clientX, e.clientY);
        }}
        onPointerUp={release}
        onPointerCancel={release}
      >
        <div
          className="absolute w-14 h-14 rounded-full bg-primary/40 border border-primary/70 shadow-[0_0_16px_hsl(var(--primary)/0.4)]"
          style={{
            left: `calc(50% - 28px + ${thumb.x}px)`,
            top: `calc(50% - 28px + ${thumb.y}px)`,
          }}
        />
      </div>

      {/* Jetpack button */}
      <button
        className={`absolute bottom-24 right-6 z-20 w-20 h-20 rounded-full border touch-none select-none flex items-center justify-center transition-colors ${
          jetDown
            ? "bg-primary/60 border-primary shadow-[0_0_28px_hsl(var(--primary)/0.6)]"
            : "bg-card/30 border-border/50 backdrop-blur-sm"
        }`}
        onPointerDown={(e) => {
          e.stopPropagation();
          safeCapture(e.currentTarget as HTMLElement, e.pointerId);
          jetRef.current = true;
          setJetDown(true);
        }}
        onPointerUp={() => {
          jetRef.current = false;
          setJetDown(false);
        }}
        onPointerCancel={() => {
          jetRef.current = false;
          setJetDown(false);
        }}
        aria-label="Jetpack"
      >
        <Rocket className={`w-8 h-8 ${jetDown ? "text-primary-foreground" : "text-primary"}`} />
      </button>
    </>
  );
}
