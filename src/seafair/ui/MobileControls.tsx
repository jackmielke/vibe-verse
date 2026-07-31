import { useEffect, useRef } from "react";
import { touchBridge } from "../core/Input";

/**
 * Touch controls: left virtual stick for movement, right half of the screen as
 * a look pad with a tap-to-fire zone, plus action buttons. Multi-touch aware —
 * each pointer is tracked independently so you can move, look and shoot at
 * once.
 */

interface StickState {
  id: number;
  ox: number;
  oy: number;
}

export default function MobileControls() {
  const stickRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const moveTouch = useRef<StickState | null>(null);
  const lookTouch = useRef<{ id: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-btn]")) return;

      const isLeft = e.clientX < window.innerWidth * 0.42;
      if (isLeft && !moveTouch.current) {
        moveTouch.current = { id: e.pointerId, ox: e.clientX, oy: e.clientY };
        if (stickRef.current) {
          stickRef.current.style.left = `${e.clientX}px`;
          stickRef.current.style.top = `${e.clientY}px`;
          stickRef.current.style.opacity = "1";
        }
      } else if (!isLeft && !lookTouch.current) {
        lookTouch.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
      }
    };

    const onMove = (e: PointerEvent) => {
      if (moveTouch.current?.id === e.pointerId) {
        const dx = e.clientX - moveTouch.current.ox;
        const dy = e.clientY - moveTouch.current.oy;
        const max = 58;
        const len = Math.hypot(dx, dy);
        const cl = len > max ? max / len : 1;
        const nx = (dx * cl) / max;
        const ny = (dy * cl) / max;
        touchBridge.moveX = nx;
        touchBridge.moveY = -ny;
        touchBridge.sprint = len > max * 0.86 && -ny > 0.55;
        if (knobRef.current) {
          knobRef.current.style.transform = `translate(${dx * cl}px, ${dy * cl}px)`;
        }
      }
      if (lookTouch.current?.id === e.pointerId) {
        const dx = e.clientX - lookTouch.current.x;
        const dy = e.clientY - lookTouch.current.y;
        touchBridge.lookX += dx * 0.0042;
        touchBridge.lookY += dy * 0.0042;
        lookTouch.current.x = e.clientX;
        lookTouch.current.y = e.clientY;
      }
    };

    const onUp = (e: PointerEvent) => {
      if (moveTouch.current?.id === e.pointerId) {
        moveTouch.current = null;
        touchBridge.moveX = 0;
        touchBridge.moveY = 0;
        touchBridge.sprint = false;
        if (stickRef.current) stickRef.current.style.opacity = "0";
        if (knobRef.current) knobRef.current.style.transform = "translate(0,0)";
      }
      if (lookTouch.current?.id === e.pointerId) lookTouch.current = null;
    };

    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  const hold = (key: keyof typeof touchBridge) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation();
      (touchBridge[key] as boolean) = true;
    },
    onPointerUp: (e: React.PointerEvent) => {
      e.stopPropagation();
      (touchBridge[key] as boolean) = false;
    },
    onPointerLeave: () => {
      (touchBridge[key] as boolean) = false;
    },
  });

  const tap = (key: keyof typeof touchBridge) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation();
      (touchBridge[key] as boolean) = true;
    },
  });

  const btn =
    "pointer-events-auto flex items-center justify-center rounded-full border border-needle-300/40 bg-black/35 backdrop-blur-sm text-needle-100 text-[11px] tracking-[0.14em] active:bg-needle-500/40 active:border-needle-300";

  return (
    <div className="pointer-events-none absolute inset-0 z-20 touch-none">
      {/* floating move stick */}
      <div
        ref={stickRef}
        className="pointer-events-none absolute h-[124px] w-[124px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-needle-300/30 bg-black/20 opacity-0 transition-opacity"
      >
        <div
          ref={knobRef}
          className="absolute left-1/2 top-1/2 h-14 w-14 -translate-x-1/2 -translate-y-1/2 rounded-full border border-needle-300/60 bg-needle-500/25"
        />
      </div>

      {/* right-side action cluster */}
      <div className="absolute bottom-6 right-5 safe-b flex flex-col items-end gap-3">
        <div className="flex items-end gap-3">
          <button {...tap("swap")} data-btn className={`${btn} h-12 w-12`}>
            SWAP
          </button>
          <button {...tap("reload")} data-btn className={`${btn} h-14 w-14`}>
            RELOAD
          </button>
        </div>
        <div className="flex items-end gap-3">
          <button {...tap("grenade")} data-btn className={`${btn} h-14 w-14`}>
            NADE
          </button>
          <button {...hold("aim")} data-btn className={`${btn} h-16 w-16`}>
            AIM
          </button>
          <button
            {...hold("fire")}
            data-btn
            className={`${btn} h-24 w-24 border-2 !border-hydro-red/60 text-base font-semibold`}
          >
            FIRE
          </button>
        </div>
      </div>

      {/* left-side secondary */}
      <div className="absolute bottom-6 left-5 safe-b flex flex-col gap-3">
        <div className="flex gap-3">
          <button {...tap("jump")} data-btn className={`${btn} h-14 w-14`}>
            JUMP
          </button>
          <button {...hold("crouch")} data-btn className={`${btn} h-12 w-12`}>
            DUCK
          </button>
          <button {...tap("melee")} data-btn className={`${btn} h-12 w-12`}>
            MELEE
          </button>
        </div>
      </div>
    </div>
  );
}
