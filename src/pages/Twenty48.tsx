/**
 * NEON 2048 — the page.
 *
 * Thin, like every other world here, with one difference worth knowing: there
 * is no canvas. A grid of sixteen numbers is a thing the browser is already
 * extremely good at, and doing it in DOM means the digits are real text — crisp
 * on every display, selectable, readable by a screen reader, and legible at the
 * size a phone actually is. Everything that moves is a CSS transform, so it
 * still runs on the compositor. The rules live in `src/twenty48/game.ts` and
 * the colours in `src/twenty48/palette.ts`, which is BLOB's recipe applied to
 * squares.
 *
 * The only real trick here: tiles are absolutely positioned and keyed by a
 * stable id, so React keeps the same DOM node across a move and the browser
 * animates the transform for free. Nothing schedules an animation frame.
 */
import { reportArcadeScore } from "@/arcade/report";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  canMove, liveTiles, move, newGame, type Dir, type GameState,
} from "@/twenty48/game";
import { DISH_BG, skinFor } from "@/twenty48/palette";
import { useWorldStamp } from "@/hooks/use-world-stamp";

const SIZES = [4, 5] as const;
type Size = (typeof SIZES)[number];

const bestKey = (size: number) => `2048:best:${size}`;
const SIZE_KEY = "2048:size";

const readBest = (size: number): number => {
  try {
    return Number(localStorage.getItem(bestKey(size))) || 0;
  } catch {
    return 0;
  }
};

const readSize = (): Size => {
  try {
    return localStorage.getItem(SIZE_KEY) === "5" ? 5 : 4;
  } catch {
    return 4;
  }
};

const fmt = (n: number): string => n.toLocaleString();

/**
 * The board `?shot` opens on, for `scripts/route-shot.mjs`.
 *
 * Card art has to be a real frame of the real thing, and a fresh game is two
 * tiles on an empty grid — true, and a picture of nothing. This is a board
 * eighty-odd moves in: every colour on the ladder at once, which is what the
 * world actually looks like while you are playing it.
 *
 * The bottom row has to leave a legal move on the table. The first version of
 * this board was gridlocked, so the page did exactly what it should — dropped
 * the "board's full" scrim over it — and the card art was a screenshot of a
 * game-over screen.
 */
const SHOT_BOARD = [
  [2, 32, 128, 4],
  [8, 256, 1024, 64],
  [16, 512, 2048, 8],
  [4, 2, 2, 2],
];

function shotGame(): GameState {
  return {
    size: 4,
    tiles: SHOT_BOARD.flatMap((row, r) =>
      row.map((value, c) => ({ id: r * 10 + c + 1, value, r, c })),
    ),
    score: 21_364,
    gained: 0,
    top: 2048,
    moves: 843,
    over: false,
    // Deliberately not `won`: the board is the picture, and the win banner
    // would cover it with a scrim.
    won: false,
    nextId: 1000,
  };
}

const isShot = (): boolean =>
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

/** Arrow keys, WASD, and vim, because somebody always tries hjkl. */
const KEY_DIRS: Record<string, Dir> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  w: "up", s: "down", a: "left", d: "right",
  W: "up", S: "down", A: "left", D: "right",
  k: "up", j: "down", h: "left", l: "right",
};

export default function Twenty48() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/2048", "Neon 2048");

  const [size, setSize] = useState<Size>(readSize);
  const [game, setGame] = useState<GameState>(() => (isShot() ? shotGame() : newGame(readSize())));
  const [best, setBest] = useState<number>(() => (isShot() ? 24_120 : readBest(readSize())));
  /**
   * The board again, in a ref.
   *
   * Not redundant: a held-down arrow key fires faster than React commits, and
   * `setGame(fn)` cannot be the place a move is computed — the updater has to
   * stay pure, and this one needs to write the best score and fire a haptic.
   * So the ref is the authority during input and the state is what renders.
   */
  const gameRef = useRef<GameState>(game);
  /** One step of undo. Enough to fix a fat-fingered swipe, not enough to cheat. */
  const undoRef = useRef<GameState | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  /** You reached 2048 and said keep going, so stop showing you the banner. */
  const [dismissedWin, setDismissedWin] = useState(false);
  /** The "+48" that floats off the score. Cleared by a timer. */
  const [pop, setPop] = useState<{ n: number; key: number } | null>(null);
  const popTimer = useRef<number | null>(null);

  const start = useCallback((n: Size) => {
    undoRef.current = null;
    setCanUndo(false);
    setDismissedWin(false);
    setPop(null);
    const fresh = newGame(n);
    gameRef.current = fresh;
    setGame(fresh);
  }, []);

  const swipe = useCallback((dir: Dir) => {
    const current = gameRef.current;
    if (current.over) return;
    const { state, moved } = move(current, dir);
    if (!moved) return;

    gameRef.current = state;
    // Snapshot without the previous move's ghosts. They are invisible (they sit
    // under the tile that replaced them) but restoring them would put spent
    // tiles back in the DOM, and an undo should hand back a board, not a scene.
    undoRef.current = { ...current, tiles: liveTiles(current) };
    setCanUndo(true);
    setGame(state);

    if (state.gained > 0) {
      setPop({ n: state.gained, key: state.moves });
      // A merge is the one thing worth a buzz. Guarded: desktop Safari and
      // every iPhone say no, and saying no must not throw.
      try {
        navigator.vibrate?.(state.gained >= 128 ? 24 : 10);
      } catch {
        /* no haptics here, and that is fine */
      }
    }
    if (state.score > readBest(current.size)) {
      try {
        localStorage.setItem(bestKey(current.size), String(state.score));
      } catch {
        /* private mode — the run still counts, it just is not remembered */
      }
      setBest(state.score);
    }
  }, []);

  const undo = useCallback(() => {
    const prev = undoRef.current;
    if (!prev) return;
    undoRef.current = null;
    setCanUndo(false);
    setPop(null);
    gameRef.current = prev;
    setGame(prev);
  }, []);

  // --- input: keyboard -------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const dir = KEY_DIRS[e.key];
      if (dir) {
        // Arrows scroll the page otherwise, which on a short viewport reads as
        // the board twitching every time you move.
        e.preventDefault();
        swipe(dir);
        return;
      }
      if (e.key === "r" || e.key === "R") start(size);
      if (e.key === "u" || e.key === "U" || (e.key === "z" && !e.shiftKey)) undo();
    };
    window.addEventListener("keydown", onKey, { passive: false });
    return () => window.removeEventListener("keydown", onKey);
  }, [swipe, start, undo, size]);

  // --- input: touch and mouse drag ------------------------------------------
  const dragRef = useRef<{ x: number; y: number; id: number } | null>(null);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  }, []);
  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      // 22px is roughly the shortest deliberate flick on a phone; below it,
      // a tap on the board would pick a direction at random.
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 22) return;
      swipe(
        Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up",
      );
    },
    [swipe],
  );

  // The floating "+48" clears itself; the timer is cleaned up so a fast exit
  // does not leave a setState pointed at an unmounted page.
  useEffect(() => {
    if (!pop) return;
    if (popTimer.current) window.clearTimeout(popTimer.current);
    popTimer.current = window.setTimeout(() => setPop(null), 700);
    return () => {
      if (popTimer.current) window.clearTimeout(popTimer.current);
    };
  }, [pop]);

  const chooseSize = (n: Size) => {
    if (n === size) return;
    setSize(n);
    try {
      localStorage.setItem(SIZE_KEY, String(n));
    } catch {
      /* fine */
    }
    setBest(readBest(n));
    start(n);
  };

  const tiles = game.tiles;
  const unit = 100 / game.size;
  const cells = useMemo(
    () => Array.from({ length: game.size * game.size }, (_, i) => i),
    [game.size],
  );
  const stuck = game.over || !canMove(game);
  const showWin = game.won && !dismissedWin && !stuck;
  // The Vibe Arcade hears about a finished board once.
  const reportedRef = useRef<GameState | null>(null);
  useEffect(() => {
    if (!stuck || reportedRef.current === game || game.score <= 0) return;
    reportedRef.current = game;
    reportArcadeScore("2048", game.score, game.won);
  }, [stuck, game]);

  return (
    <div
      className="relative flex min-h-[100dvh] w-full flex-col items-center overflow-hidden text-white"
      style={{ background: DISH_BG }}
    >
      <style>{`
        @keyframes t48-pop { 0% { transform: scale(0.1); opacity: 0 } 60% { transform: scale(1.08) } 100% { transform: scale(1); opacity: 1 } }
        @keyframes t48-merge { 0% { transform: scale(0.72) } 55% { transform: scale(1.14) } 100% { transform: scale(1) } }
        @keyframes t48-float { 0% { transform: translateY(0); opacity: 1 } 100% { transform: translateY(-28px); opacity: 0 } }
        @keyframes t48-drift { 0% { transform: translate(0,0) } 50% { transform: translate(6vw,-4vh) } 100% { transform: translate(0,0) } }
        @media (prefers-reduced-motion: reduce) {
          .t48-tile, .t48-face { transition: none !important; animation: none !important }
          .t48-drift { animation: none !important }
        }
      `}</style>

      {/* The dish behind the board: two out-of-focus cells drifting, and the
          same faint grid BLOB rules over its arena. Pure CSS, no frame loop. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="t48-drift absolute -left-24 top-10 h-[46vmin] w-[46vmin] rounded-full opacity-40 blur-3xl"
          style={{
            background: "radial-gradient(circle, hsla(194,95%,58%,0.55), transparent 70%)",
            animation: "t48-drift 18s ease-in-out infinite",
          }}
        />
        <div
          className="t48-drift absolute -right-20 bottom-0 h-[52vmin] w-[52vmin] rounded-full opacity-35 blur-3xl"
          style={{
            background: "radial-gradient(circle, hsla(298,95%,60%,0.5), transparent 70%)",
            animation: "t48-drift 24s ease-in-out infinite reverse",
          }}
        />
        <div
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(120,200,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(120,200,255,0.6) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }}
        />
      </div>

      <div className="relative z-10 flex w-full max-w-[560px] flex-1 flex-col gap-4 px-4 pb-6 pt-5 sm:pt-8">
        {/* Header ---------------------------------------------------------- */}
        {/* The way-home puck lives in the top-left corner of every world, so
            the title starts to the right of it until the column is wide enough
            to be centred clear of it. Without this, on a phone, the world is
            called "48". */}
        <header className="flex items-end justify-between gap-3 pl-[var(--vv-home-clear)] md:pl-0">
          <div>
            <h1
              className="text-[34px] font-black leading-none tracking-tight sm:text-[42px]"
              style={{
                background: "linear-gradient(120deg, #7df2ff 0%, #8f9bff 45%, #ff6ad5 100%)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
                filter: "drop-shadow(0 0 18px rgba(93,200,255,0.35))",
              }}
            >
              2048
            </h1>
            {/* nowrap: wrapped onto two lines it grows the header by a line,
                and on a phone that is the line that pushes the footer under
                the fold. */}
            <p className="mt-1 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-200/60">
              petri-dish edition
            </p>
          </div>

          <div className="flex items-stretch gap-2">
            <div className="relative min-w-[74px] rounded-xl border border-white/10 bg-white/[0.06] px-3 py-1.5 text-center backdrop-blur">
              <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/45">
                score
              </div>
              <div className="text-lg font-bold tabular-nums leading-tight">{fmt(game.score)}</div>
              {pop && (
                <span
                  key={pop.key}
                  className="pointer-events-none absolute -top-1 left-0 right-0 text-center text-sm font-bold text-emerald-300"
                  style={{ animation: "t48-float 700ms ease-out forwards" }}
                >
                  +{pop.n}
                </span>
              )}
            </div>
            <div className="min-w-[74px] rounded-xl border border-white/10 bg-white/[0.06] px-3 py-1.5 text-center backdrop-blur">
              <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/45">
                best
              </div>
              <div className="text-lg font-bold tabular-nums leading-tight text-cyan-200">
                {fmt(best)}
              </div>
            </div>
          </div>
        </header>

        {/* Controls -------------------------------------------------------- */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => start(size)}
            className="rounded-lg border border-emerald-300/30 bg-emerald-400/15 px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-emerald-200 transition hover:bg-emerald-400/25 active:scale-95"
          >
            new game
          </button>
          <button
            type="button"
            onClick={undo}
            disabled={!canUndo}
            className="rounded-lg border border-white/15 bg-white/[0.06] px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-white/75 transition hover:bg-white/[0.12] active:scale-95 disabled:opacity-30"
          >
            undo
          </button>
          <div className="ml-auto flex overflow-hidden rounded-lg border border-white/15">
            {SIZES.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => chooseSize(n)}
                className={`px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition ${
                  n === size ? "bg-cyan-400/25 text-cyan-100" : "bg-white/[0.04] text-white/50 hover:bg-white/[0.1]"
                }`}
              >
                {n}×{n}
              </button>
            ))}
          </div>
        </div>

        {/* Board ----------------------------------------------------------- */}
        <div
          className="relative mx-auto w-full select-none"
          style={{
            aspectRatio: "1 / 1",
            // A square that only obeys the width is a square that runs off the
            // bottom of a landscape phone, taking the D-pad with it.
            maxWidth: "min(100%, 58vh)",
            touchAction: "none",
          }}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (dragRef.current = null)}
        >
          <div
            className="absolute inset-0 rounded-2xl border border-white/10"
            style={{
              background: "rgba(255,255,255,0.035)",
              boxShadow: "inset 0 0 60px rgba(80,180,255,0.06), 0 24px 60px rgba(0,0,0,0.45)",
            }}
          />

          {/* Empty wells, drawn once. */}
          <div
            className="absolute inset-0 grid p-[2.2%]"
            style={{
              gridTemplateColumns: `repeat(${game.size}, 1fr)`,
              gap: "2.2%",
            }}
          >
            {cells.map((i) => (
              <div key={i} className="rounded-xl bg-white/[0.045]" />
            ))}
          </div>

          {/* Tiles. Absolute, keyed by id, moved with a transform — the browser
              animates between renders because the DOM node survives. */}
          <div className="absolute inset-0 p-[2.2%]">
            <div className="relative h-full w-full">
              {tiles.map((t) => {
                const skin = skinFor(t.value);
                return (
                  <div
                    key={t.id}
                    className="t48-tile absolute left-0 top-0 p-[3.6%]"
                    style={{
                      width: `${unit}%`,
                      height: `${unit}%`,
                      transform: `translate(${t.c * 100}%, ${t.r * 100}%)`,
                      transition: "transform 110ms cubic-bezier(0.2, 0.7, 0.3, 1)",
                      zIndex: t.ghost ? 1 : 2 + Math.min(9, Math.log2(t.value) | 0),
                    }}
                  >
                    <div
                      className="t48-face flex h-full w-full items-center justify-center rounded-xl border font-black tabular-nums"
                      style={{
                        background: skin.background,
                        borderColor: skin.border,
                        boxShadow: skin.shadow,
                        color: skin.color,
                        fontSize: skin.fontSize,
                        animation:
                          t.born ? "t48-pop 150ms ease-out"
                          : t.merged ? "t48-merge 170ms ease-out"
                          : undefined,
                      }}
                    >
                      {t.value}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Endgame ------------------------------------------------------- */}
          {(stuck || showWin) && (
            <div
              className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 rounded-2xl px-6 text-center"
              style={{
                background:
                  "radial-gradient(ellipse at center, rgba(6,11,20,0.93) 0%, rgba(6,11,20,0.86) 60%, rgba(6,11,20,0.6) 100%)",
                backdropFilter: "blur(3px)",
                WebkitBackdropFilter: "blur(3px)",
              }}
            >
              <div className="text-3xl font-black tracking-tight sm:text-4xl">
                {stuck ? "board's full" : "2048"}
              </div>
              <p className="max-w-[30ch] text-sm text-white/70">
                {stuck
                  ? `No move left. You got to ${fmt(game.top)} in ${game.moves} moves, for ${fmt(game.score)}.`
                  : "You made the green one. Keep going — the board is nowhere near done."}
              </p>
              <div className="mt-1 flex gap-2">
                <button
                  type="button"
                  onClick={() => (stuck ? start(size) : setDismissedWin(true))}
                  className="rounded-lg border border-emerald-300/40 bg-emerald-400/20 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-emerald-100 transition hover:bg-emerald-400/30 active:scale-95"
                >
                  {stuck ? "play again" : "keep playing"}
                </button>
                {stuck && canUndo && (
                  <button
                    type="button"
                    onClick={undo}
                    className="rounded-lg border border-white/20 bg-white/[0.08] px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-white/80 transition hover:bg-white/[0.15] active:scale-95"
                  >
                    take that back
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Phone D-pad. Swiping is the real control, but a thumb resting on the
            bottom of a 6" screen cannot reach the middle of the board, and this
            is also the only way to play it one-handed on a bus. */}
        <div className="grid grid-cols-3 gap-2 sm:hidden" aria-hidden>
          <div />
          <PadButton dir="up" onPress={swipe} label="▲" />
          <div />
          <PadButton dir="left" onPress={swipe} label="◀" />
          <PadButton dir="down" onPress={swipe} label="▼" />
          <PadButton dir="right" onPress={swipe} label="▶" />
        </div>

        <footer className="mt-auto flex items-center justify-between gap-3 pt-2 text-[11px] text-white/45">
          <span className="font-mono uppercase tracking-widest">
            <span className="hidden sm:inline">arrows / wasd · </span>
            <span className="sm:hidden">swipe · </span>
            {liveTiles(game).length}/{game.size * game.size}
          </span>
          <Link
            to="/"
            className="font-mono uppercase tracking-widest text-cyan-300/80 transition hover:text-cyan-200"
          >
            ← the vibeverse
          </Link>
        </footer>
      </div>
    </div>
  );
}

function PadButton({
  dir,
  label,
  onPress,
}: {
  dir: Dir;
  label: string;
  onPress: (d: Dir) => void;
}) {
  return (
    <button
      type="button"
      onPointerDown={(e) => {
        // Pointer-down, not click: the board is listening for pointer-up to
        // read a swipe, and a click here would arrive a beat late anyway.
        e.preventDefault();
        e.stopPropagation();
        onPress(dir);
      }}
      className="rounded-xl border border-white/10 bg-white/[0.06] py-2.5 text-base text-white/70 transition active:scale-95 active:bg-cyan-400/20"
    >
      {label}
    </button>
  );
}
