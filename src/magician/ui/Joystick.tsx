/**
 * A thumb stick for phones.
 *
 * One pointer, a base and a knob. The knob follows the finger up to the
 * base's radius and reports a unit vector (x right, y forward) through
 * `onMove`; lifting the finger snaps it back and reports zero. Pointer
 * events, so it also works with a mouse for testing, and `touch-action:
 * none` so the page never scrolls under it.
 */
import { useCallback, useRef, useState } from "react";

interface Props {
  onMove(x: number, y: number): void;
  size?: number;
  className?: string;
}

export function Joystick({ onMove, size = 112, className = "" }: Props) {
  const baseRef = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const activeId = useRef<number | null>(null);
  const radius = size / 2 - 14;

  const track = useCallback((clientX: number, clientY: number) => {
    const el = baseRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let dx = clientX - (r.left + r.width / 2);
    let dy = clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > radius) { dx = (dx / d) * radius; dy = (dy / d) * radius; }
    setKnob({ x: dx, y: dy });
    onMove(dx / radius, -dy / radius);
  }, [onMove, radius]);

  const onDown = (e: React.PointerEvent) => {
    if (activeId.current !== null) return;
    activeId.current = e.pointerId;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    track(e.clientX, e.clientY);
  };
  const onMovePtr = (e: React.PointerEvent) => { if (e.pointerId === activeId.current) track(e.clientX, e.clientY); };
  const onUp = (e: React.PointerEvent) => {
    if (e.pointerId !== activeId.current) return;
    activeId.current = null;
    setKnob({ x: 0, y: 0 });
    onMove(0, 0);
  };

  return (
    <div
      ref={baseRef}
      data-ui="1"
      onPointerDown={onDown}
      onPointerMove={onMovePtr}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      className={`relative select-none rounded-full border border-white/25 bg-black/30 backdrop-blur-sm ${className}`}
      style={{ width: size, height: size, touchAction: "none" }}
    >
      <div
        className="absolute left-1/2 top-1/2 h-12 w-12 rounded-full bg-white/70 shadow-lg"
        style={{ transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))`, transition: activeId.current === null ? "transform 120ms" : "none" }}
      />
    </div>
  );
}
