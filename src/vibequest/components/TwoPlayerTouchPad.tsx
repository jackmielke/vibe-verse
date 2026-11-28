import { useEffect, useRef, useState } from 'react';

/**
 * Two players, one phone. Player 1 holds the left edge of the screen and
 * Player 2 the right, each with their own move pad and action buttons.
 *
 * The two-player engines already read the keyboard (WASD + Space for
 * Player 1, arrows + Enter for Player 2), so each button simply presses
 * and releases that key. Every engine therefore gets touch play without
 * a second input path that could drift from the keyboard one.
 */

export type ExtraAction = 'dash' | 'shield' | 'duck';

type Action = 'left' | 'right' | 'jump' | 'shoot' | ExtraAction;

const KEYS: Record<1 | 2, Record<Action, string>> = {
  1: { left: 'KeyA', right: 'KeyD', jump: 'KeyW', shoot: 'Space', duck: 'KeyS', dash: 'ShiftLeft', shield: 'KeyQ' },
  2: { left: 'ArrowLeft', right: 'ArrowRight', jump: 'ArrowUp', shoot: 'Enter', duck: 'ArrowDown', dash: 'ShiftRight', shield: 'Slash' },
};

const LABEL: Record<ExtraAction, string> = { dash: '⚡', shield: '🛡️', duck: '⬇' };
const NAME: Record<ExtraAction, string> = { dash: 'Dash', shield: 'Shield', duck: 'Duck' };

const press = (code: string, down: boolean) => {
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));
};

/** True on phones and tablets, where there is no keyboard to fall back on. */
export const useIsTouch = () => {
  const [isTouch, setIsTouch] = useState(false);
  useEffect(() => {
    setIsTouch(
      typeof window !== 'undefined' &&
        ('ontouchstart' in window || window.matchMedia('(pointer: coarse)').matches),
    );
  }, []);
  return isTouch;
};

/** True while a phone is held upright, where two sets of thumbs do not fit. */
export const usePortrait = () => {
  const [portrait, setPortrait] = useState(false);
  useEffect(() => {
    const check = () => setPortrait(window.innerHeight > window.innerWidth);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  return portrait;
};

const PlayerPad = ({
  player,
  extras,
  held,
  compact,
}: {
  player: 1 | 2;
  extras: ExtraAction[];
  held: React.MutableRefObject<Set<string>>;
  compact: boolean;
}) => {
  const keys = KEYS[player];
  const set = (action: Action, down: boolean) => {
    const code = keys[action];
    if (down === held.current.has(code)) return;
    if (down) held.current.add(code);
    else held.current.delete(code);
    press(code, down);
  };

  const bind = (action: Action) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      set(action, true);
    },
    onPointerUp: (e: React.PointerEvent) => {
      e.preventDefault();
      set(action, false);
    },
    onPointerCancel: () => set(action, false),
    onLostPointerCapture: () => set(action, false),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });

  const tint =
    player === 1
      ? 'border-yellow-300/70 bg-yellow-400/25'
      : 'border-cyan-300/70 bg-cyan-400/25';
  const btn = `select-none touch-none flex items-center justify-center rounded-full font-bold text-white shadow-lg backdrop-blur-md border-2 active:scale-90 active:brightness-150 transition-transform ${tint}`;
  const size = compact ? 'h-12 w-12 text-xl' : 'h-14 w-14 text-2xl';

  const move = (
    <div className="flex items-end gap-2">
      <button aria-label={`Player ${player} left`} {...bind('left')} className={`${btn} ${size}`}>◀</button>
      <button aria-label={`Player ${player} right`} {...bind('right')} className={`${btn} ${size}`}>▶</button>
    </div>
  );

  const actions = (
    <div className="flex flex-col items-center gap-2">
      {extras.length > 0 && (
        <div className="flex gap-2">
          {extras.map((x) => (
            <button
              key={x}
              aria-label={`Player ${player} ${NAME[x]}`}
              {...bind(x)}
              className={`${btn} ${compact ? 'h-10 w-10 text-base' : 'h-11 w-11 text-lg'}`}
            >
              {LABEL[x]}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <button
          aria-label={`Player ${player} shoot`}
          {...bind('shoot')}
          className={`${btn} ${size} !bg-red-500/60`}
        >
          💥
        </button>
        <button
          aria-label={`Player ${player} jump`}
          {...bind('jump')}
          className={`${btn} ${size} !bg-green-500/60 text-xs`}
        >
          JUMP
        </button>
      </div>
    </div>
  );

  // Movement sits on the outside edge, actions toward the middle, so each
  // player's thumbs mirror the other's and nobody reaches across.
  return (
    <div className={`pointer-events-auto flex items-end gap-3 ${compact ? 'w-full justify-between' : ''}`}>
      <div className={`absolute -top-6 ${compact ? 'left-1/2 -translate-x-1/2' : player === 1 ? 'right-0' : 'left-0'} text-[11px] font-bold tracking-wide ${player === 1 ? 'text-yellow-300' : 'text-cyan-300'}`}>
        PLAYER {player}
      </div>
      {player === 1 || compact ? (
        <>
          {move}
          {actions}
        </>
      ) : (
        <>
          {actions}
          {move}
        </>
      )}
    </div>
  );
};

export const TwoPlayerTouchPad = ({ extras = [] }: { extras?: ExtraAction[] }) => {
  const held = useRef<Set<string>>(new Set());
  // Upright, the two pads do not fit side by side, so Player 2's row sits
  // above Player 1's. Sideways is still the better way to play.
  const compact = usePortrait();

  useEffect(() => {
    const releaseAll = () => {
      held.current.forEach((code) => press(code, false));
      held.current.clear();
    };
    window.addEventListener('blur', releaseAll);
    return () => {
      window.removeEventListener('blur', releaseAll);
      releaseAll();
    };
  }, []);

  return (
    <div
      className={`pointer-events-none fixed inset-x-0 bottom-0 z-40 flex px-3 ${compact ? 'flex-col-reverse gap-8' : 'items-end justify-between'}`}
      style={{
        paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
        paddingLeft: 'max(0.75rem, env(safe-area-inset-left))',
        paddingRight: 'max(0.75rem, env(safe-area-inset-right))',
      }}
    >
      <div className="relative">
        <PlayerPad player={1} extras={extras} held={held} compact={compact} />
      </div>
      <div className="relative">
        <PlayerPad player={2} extras={extras} held={held} compact={compact} />
      </div>
    </div>
  );
};

/** Shown in portrait: two players need the phone on its side. */
export const RotateHint = () => (
  <div className="pointer-events-none fixed inset-x-0 top-4 z-30 flex justify-center pl-24 pr-4">
    <div className="rounded-full bg-black/70 px-4 py-2 text-center text-sm font-bold text-white backdrop-blur">
      📱↻ Turn your phone sideways so both players have room
    </div>
  </div>
);

/** Touch version of the controls card on the start screens. */
export const TouchControlsGuide = ({ extras = [] }: { extras?: ExtraAction[] }) => (
  <div className="grid grid-cols-2 gap-3 text-left text-sm text-white/80">
    <div className="rounded-xl bg-yellow-500/20 p-3">
      <p className="mb-1 font-bold text-yellow-400">Player 1, left thumb side</p>
      <p>◀ ▶ move, JUMP, 💥 shoot</p>
      {extras.map((x) => (
        <p key={x}>
          {LABEL[x]} {NAME[x].toLowerCase()}
        </p>
      ))}
    </div>
    <div className="rounded-xl bg-cyan-500/20 p-3">
      <p className="mb-1 font-bold text-cyan-400">Player 2, right thumb side</p>
      <p>◀ ▶ move, JUMP, 💥 shoot</p>
      {extras.map((x) => (
        <p key={x}>
          {LABEL[x]} {NAME[x].toLowerCase()}
        </p>
      ))}
    </div>
  </div>
);
