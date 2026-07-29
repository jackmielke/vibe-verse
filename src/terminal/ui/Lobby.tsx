/**
 * The Terminal's interface — reference 1 in `references/VISION.md`.
 *
 * A world carousel over a live 3D scene. The reference sheet showed four
 * palettes of the same screen; this is that screen, using the Vibeverse's own
 * colours rather than any one of the four moods.
 *
 * Two rules drive the implementation:
 *
 * 1. **The 3D scene is the background, and it must stay legible.** Everything
 *    here sits on a scrim or a blur, because white text over a bright blue sky
 *    is unreadable and this screen is bright by design.
 * 2. **Nothing in here re-renders per frame.** The focused index changes on
 *    input, not on a timer, so React only does work when the player does
 *    something. The scene behind it owns the frame budget.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GATES } from "../geo/terminalGeo";

export interface LobbyProps {
  focusedIndex: number;
  onFocus: (i: number) => void;
  /** Live count from the presence backend, if it is up. */
  online: number | null;
}

/** Cards visible either side of the focused one. */
const WING = 2;

export default function Lobby({ focusedIndex, onFocus, online }: LobbyProps) {
  const navigate = useNavigate();
  const [entering, setEntering] = useState(false);
  const touchStart = useRef<number | null>(null);

  const focused = GATES[focusedIndex];

  const move = useCallback(
    (delta: number) => {
      const n = GATES.length;
      onFocus(((focusedIndex + delta) % n + n) % n);
    },
    [focusedIndex, onFocus],
  );

  const enter = useCallback(() => {
    if (entering) return;
    setEntering(true);
    // Let the wipe cover the screen before the route swaps, so the transition
    // reads as travel rather than as a page load.
    window.setTimeout(() => navigate(focused.to), 620);
  }, [entering, focused.to, navigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "ArrowLeft" || e.code === "KeyA") move(-1);
      else if (e.code === "ArrowRight" || e.code === "KeyD") move(1);
      else if (e.code === "Enter" || e.code === "Space") {
        e.preventDefault();
        enter();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, enter]);

  // Swipe on the card strip. Deliberately scoped to the strip rather than the
  // whole screen so it never fights the 3D scene for the gesture.
  const onTouchStart = (e: React.TouchEvent) => {
    touchStart.current = e.touches[0].clientX;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStart.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStart.current;
    if (Math.abs(dx) > 42) move(dx < 0 ? 1 : -1);
    touchStart.current = null;
  };

  const visible = useMemo(() => {
    const out: { gate: (typeof GATES)[number]; offset: number; index: number }[] = [];
    for (let o = -WING; o <= WING; o++) {
      const n = GATES.length;
      const i = ((focusedIndex + o) % n + n) % n;
      out.push({ gate: GATES[i], offset: o, index: i });
    }
    return out;
  }, [focusedIndex]);

  const accent = `#${focused.accent.toString(16).padStart(6, "0")}`;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-10 select-none"
      style={{
        paddingTop: "max(env(safe-area-inset-top), 10px)",
        paddingBottom: "max(env(safe-area-inset-bottom), 10px)",
      }}
    >
      {/* Top bar */}
      <div className="pointer-events-auto flex items-center justify-between px-4 sm:px-7">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-white/15 text-sm backdrop-blur-md ring-1 ring-white/25">
            🌐
          </div>
          <span className="hidden text-[11px] font-bold uppercase tracking-[0.34em] text-white drop-shadow-lg sm:block">
            Vibeverse
          </span>
        </div>

        <nav className="hidden items-center gap-1 rounded-full bg-black/25 px-1.5 py-1 backdrop-blur-md ring-1 ring-white/20 sm:flex">
          {["Worlds", "People", "Events", "Create"].map((t, i) => (
            <button
              key={t}
              className={`rounded-full px-4 py-1.5 text-[12px] font-semibold transition ${
                i === 0 ? "bg-white text-slate-900" : "text-white/80 hover:text-white"
              }`}
            >
              {t}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-full bg-black/25 px-3 py-1.5 text-[11px] font-semibold text-white backdrop-blur-md ring-1 ring-white/20">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {online === null ? "—" : online} Online
          </span>
        </div>
      </div>

      {/* Title */}
      <div className="mt-4 text-center sm:mt-7">
        <h1
          className="text-[clamp(1.5rem,4.6vw,2.6rem)] font-black tracking-tight text-white"
          style={{ textShadow: "0 3px 24px rgba(0,40,90,.55)" }}
        >
          What kind of adventure do you want today?
        </h1>
        <p className="mt-1 text-[12px] font-medium text-white/80 drop-shadow sm:text-[13px]">
          Every builder grows the universe.
        </p>
      </div>

      {/* Carousel */}
      <div
        className="pointer-events-auto absolute inset-x-0 flex items-center justify-center gap-2 px-3 sm:gap-3"
        style={{ top: "clamp(160px, 26vh, 260px)" }}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <button
          onClick={() => move(-1)}
          aria-label="Previous world"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-black/30 text-white backdrop-blur-md ring-1 ring-white/25 transition active:scale-90 hover:bg-black/45"
        >
          ‹
        </button>

        <div className="flex items-end justify-center gap-2 sm:gap-3">
          {visible.map(({ gate, offset, index }) => {
            const isFocus = offset === 0;
            const dist = Math.abs(offset);
            return (
              <button
                key={gate.key}
                onClick={() => (isFocus ? enter() : onFocus(index))}
                className="relative shrink-0 overflow-hidden rounded-2xl text-left transition-all duration-300 ease-out"
                style={{
                  width: isFocus ? "clamp(150px, 30vw, 232px)" : `clamp(64px, ${17 - dist * 3}vw, ${132 - dist * 26}px)`,
                  opacity: isFocus ? 1 : 0.62 - dist * 0.16,
                  transform: `translateY(${isFocus ? -10 : dist * 7}px)`,
                  boxShadow: isFocus
                    ? `0 0 0 2.5px ${accent}, 0 18px 46px rgba(0,30,70,.45)`
                    : "0 8px 22px rgba(0,30,70,.3)",
                }}
              >
                <div
                  className="aspect-[3/4] w-full"
                  style={{
                    background: `linear-gradient(168deg, #${gate.accent
                      .toString(16)
                      .padStart(6, "0")}dd 0%, rgba(8,22,44,.94) 72%)`,
                  }}
                />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-2.5">
                  <div className={`font-bold text-white ${isFocus ? "text-[13px]" : "text-[10px]"}`}>
                    {gate.name}
                  </div>
                  {isFocus && (
                    <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-white/75">
                      {gate.blurb}
                    </p>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <button
          onClick={() => move(1)}
          aria-label="Next world"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-black/30 text-white backdrop-blur-md ring-1 ring-white/25 transition active:scale-90 hover:bg-black/45"
        >
          ›
        </button>
      </div>

      {/* Enter */}
      <div
        className="pointer-events-auto absolute inset-x-0 flex flex-col items-center gap-2"
        style={{ bottom: "max(env(safe-area-inset-bottom), 22px)" }}
      >
        <button
          onClick={enter}
          className="min-h-[52px] rounded-2xl px-10 text-[15px] font-black uppercase tracking-wide text-slate-900 shadow-xl transition active:scale-95"
          style={{ background: accent, WebkitTapHighlightColor: "transparent" }}
        >
          Enter {focused.name}
        </button>
        <p className="text-[10.5px] font-medium tracking-wide text-white/70 drop-shadow">
          Swipe or use A / D to explore
        </p>
      </div>

      {/* Customize + Emotes */}
      <div className="pointer-events-auto absolute bottom-5 left-4 hidden gap-2 sm:flex">
        {[
          ["🧍", "Customize"],
          ["✨", "Emotes"],
        ].map(([icon, label]) => (
          <button
            key={label}
            className="flex min-h-[44px] items-center gap-2 rounded-xl bg-black/30 px-3 text-[11px] font-semibold text-white/90 backdrop-blur-md ring-1 ring-white/20 transition hover:bg-black/45"
          >
            <span>{icon}</span>
            {label}
          </button>
        ))}
      </div>

      {/* Travel wipe */}
      <div
        className="pointer-events-none fixed inset-0 z-50 transition-opacity duration-500"
        style={{
          background: `radial-gradient(circle at 50% 55%, ${accent}00 0%, ${accent}dd 55%, #04101f 100%)`,
          opacity: entering ? 1 : 0,
        }}
      />
    </div>
  );
}
