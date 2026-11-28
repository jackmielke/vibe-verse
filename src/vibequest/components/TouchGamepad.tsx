import { useEffect, useRef } from 'react';

export interface TouchState {
  left: boolean;
  right: boolean;
  jump: boolean;
  shoot: boolean;
}

interface TouchGamepadProps {
  onChange: (state: TouchState) => void;
}

/**
 * On-screen gamepad for mobile play.
 * Left side: D-pad (left/right). Right side: Jump + Shoot.
 * Uses pointer events so multi-touch works (move + jump/shoot at once).
 */
export const TouchGamepad = ({ onChange }: TouchGamepadProps) => {
  const stateRef = useRef<TouchState>({ left: false, right: false, jump: false, shoot: false });

  const set = (key: keyof TouchState, value: boolean) => {
    if (stateRef.current[key] === value) return;
    stateRef.current = { ...stateRef.current, [key]: value };
    onChange(stateRef.current);
  };

  useEffect(() => {
    const reset = () => {
      stateRef.current = { left: false, right: false, jump: false, shoot: false };
      onChange(stateRef.current);
    };
    window.addEventListener('blur', reset);
    return () => window.removeEventListener('blur', reset);
  }, [onChange]);

  const bind = (key: keyof TouchState) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      set(key, true);
    },
    onPointerUp: (e: React.PointerEvent) => {
      e.preventDefault();
      set(key, false);
    },
    onPointerCancel: () => set(key, false),
    onPointerLeave: (e: React.PointerEvent) => {
      if (e.buttons === 0) set(key, false);
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });

  const btn =
    'select-none touch-none flex items-center justify-center rounded-full font-bold text-white shadow-lg active:scale-95 active:brightness-125 transition-transform';

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-between px-4 pb-6"
      style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
    >
      {/* D-pad */}
      <div className="pointer-events-auto flex items-end gap-3">
        <button
          aria-label="Move left"
          {...bind('left')}
          className={`${btn} h-16 w-16 bg-white/25 backdrop-blur-md border border-white/40 text-3xl`}
        >
          ◀
        </button>
        <button
          aria-label="Move right"
          {...bind('right')}
          className={`${btn} h-16 w-16 bg-white/25 backdrop-blur-md border border-white/40 text-3xl`}
        >
          ▶
        </button>
      </div>

      {/* Action buttons */}
      <div className="pointer-events-auto flex items-end gap-3">
        <button
          aria-label="Shoot"
          {...bind('shoot')}
          className={`${btn} h-16 w-16 bg-gradient-to-br from-red-500 to-orange-600 border border-white/40 text-xl`}
        >
          💥
        </button>
        <button
          aria-label="Jump"
          {...bind('jump')}
          className={`${btn} h-20 w-20 bg-gradient-to-br from-green-500 to-emerald-600 border border-white/40 text-2xl`}
        >
          JUMP
        </button>
      </div>
    </div>
  );
};