import { useEffect, useRef, useState } from "react";
import { input } from "./input";
import { useGame } from "./store";

/**
 * On-screen virtual joystick for touch devices.
 * Uses Pointer Events + pointer capture: the browser guarantees that a
 * captured pointer ALWAYS delivers pointerup / pointercancel /
 * lostpointercapture to this element, so the stick can never get stuck.
 */
export function TouchControls() {
  const kind = useGame((s) => s.kind);
  const mode = useGame((s) => s.mode);
  const baseRef = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState(false);
  const pointerId = useRef<number | null>(null);
  const center = useRef({ x: 0, y: 0 });
  const RADIUS = 55;

  const release = () => {
    pointerId.current = null;
    setActive(false);
    setKnob({ x: 0, y: 0 });
    input.x = 0;
    input.z = 0;
  };

  // Safety net for everything pointer capture can't see:
  // window losing focus, tab hidden, or all fingers leaving the screen.
  useEffect(() => {
    const hardStop = () => release();
    const onWinTouchEnd = (e: TouchEvent) => {
      // No fingers left on the screen at all -> nothing can be steering.
      if (e.touches.length === 0) release();
    };
    const onWinPointerUp = (e: PointerEvent) => {
      if (pointerId.current !== null && e.pointerId === pointerId.current) release();
    };
    window.addEventListener("blur", hardStop);
    document.addEventListener("visibilitychange", hardStop);
    window.addEventListener("touchend", onWinTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onWinTouchEnd, { passive: true });
    window.addEventListener("pointerup", onWinPointerUp);
    window.addEventListener("pointercancel", onWinPointerUp);
    return () => {
      window.removeEventListener("blur", hardStop);
      document.removeEventListener("visibilitychange", hardStop);
      window.removeEventListener("touchend", onWinTouchEnd);
      window.removeEventListener("touchcancel", onWinTouchEnd);
      window.removeEventListener("pointerup", onWinPointerUp);
      window.removeEventListener("pointercancel", onWinPointerUp);
      input.x = 0;
      input.z = 0;
    };
     
  }, []);

  // Reset when leaving play mode or switching kingdom
  useEffect(() => {
    if (kind !== "animal" || mode !== "playing") release();
     
  }, [kind, mode]);

  // Only animals need movement controls
  if (kind !== "animal" || mode !== "playing") return null;

  const updateFromPoint = (px: number, py: number) => {
    let dx = px - center.current.x;
    let dy = py - center.current.y;
    const len = Math.hypot(dx, dy);
    const clamped = Math.min(len, RADIUS);
    if (len > 0) {
      dx = (dx / len) * clamped;
      dy = (dy / len) * clamped;
    }
    setKnob({ x: dx, y: dy });
    input.x = dx / RADIUS;
    input.z = dy / RADIUS;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (pointerId.current !== null) return; // already steering with another finger
    pointerId.current = e.pointerId;
    baseRef.current?.setPointerCapture(e.pointerId);
    const rect = baseRef.current!.getBoundingClientRect();
    center.current = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
    setActive(true);
    updateFromPoint(e.clientX, e.clientY);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerId !== pointerId.current) return;
    updateFromPoint(e.clientX, e.clientY);
  };

  const onPointerEnd = (e: React.PointerEvent) => {
    if (e.pointerId !== pointerId.current) return;
    release();
  };

  return (
    <div
      ref={baseRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onContextMenu={(e) => e.preventDefault()}
      className="pointer-events-auto fixed bottom-6 left-6 z-30 h-36 w-36 touch-none select-none rounded-full border-2 border-white/30 bg-black/30 backdrop-blur-sm"
      style={{ WebkitTapHighlightColor: "transparent" }}
    >
      <div
        className={`absolute left-1/2 top-1/2 h-16 w-16 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-emerald-300/80 bg-emerald-400/60 shadow-lg transition-colors ${
          active ? "bg-emerald-300/80" : ""
        }`}
        style={{ transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))` }}
      />
    </div>
  );
}
