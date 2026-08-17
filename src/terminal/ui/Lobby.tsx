/**
 * The Terminal's interface — reference 1 in `references/VISION.md`.
 *
 * A world carousel over a live 3D scene. The reference sheet showed four
 * palettes of the same screen; this is that screen, using the Vibeverse's own
 * colours rather than any one of the four moods.
 *
 * Three rules drive the implementation:
 *
 * 1. **The 3D scene is the background, and it must stay legible.** Everything
 *    here sits on a scrim or a blur, because white text over a bright blue sky
 *    is unreadable and this screen is bright by design. The first version of
 *    this file declared that rule and then put the headline in plain white over
 *    the clouds, where it could not be read at all.
 * 2. **The layout is a flex column, never a stack of absolutely-positioned
 *    pieces.** Those pieces were pinned with `top: clamp(...)` and
 *    `bottom: ...`, which happens to work at 16:9 and collides everywhere else:
 *    on a phone in landscape the Enter button sat directly on top of the card
 *    it was supposed to be about. A column cannot overlap itself.
 * 3. **Nothing in here re-renders per frame.** The focused index changes on
 *    input, not on a timer, so React only does work when the player does
 *    something. The scene behind it owns the frame budget.
 *
 * The way out is not in this file. `components/HomeButton.tsx` puts one button
 * in the top-left corner of every world in the vibeverse, this one included,
 * and the layout below leaves that corner clear for it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { GATES } from "../geo/terminalGeo";
import { artFor } from "@/worlds/art";

export interface LobbyProps {
  focusedIndex: number;
  onFocus: (i: number) => void;
  /** Live count from the presence backend, if it is up. */
  online: number | null;
}

/** Real destinations only. A button that does nothing is worse than no button. */
const LINKS: { label: string; to: string }[] = [
  { label: "Worlds", to: "/game" },
  { label: "People", to: "/agent-lobby" },
  { label: "News", to: "/times" },
  { label: "Create", to: "/world-builder" },
];

/**
 * How many cards sit either side of the focused one.
 *
 * Two only fits on a wide screen. At 360 px the five-card strip plus its two
 * arrows overflowed the viewport in both directions, so the outer cards were
 * clipped mid-word and the arrows were pushed off-screen entirely — on the one
 * device where the arrows are the easiest way to browse.
 */
const wingFor = (width: number) => (width < 560 ? 1 : 2);

/** Viewport size, sampled on resize rather than read during render. */
function useViewport() {
  const [size, setSize] = useState(() => ({
    w: typeof window === "undefined" ? 1280 : window.innerWidth,
    h: typeof window === "undefined" ? 720 : window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);
  return size;
}

export default function Lobby({ focusedIndex, onFocus, online }: LobbyProps) {
  const navigate = useNavigate();
  const [entering, setEntering] = useState(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const { w, h } = useViewport();

  const narrow = w < 560;
  /** A phone in landscape. There is no room for a headline; the cards win. */
  const short = h < 520;
  const wing = wingFor(w);

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
      else if (e.code === "Escape") navigate("/game");
      else if (e.code === "Enter" || e.code === "Space") {
        e.preventDefault();
        enter();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, enter, navigate]);

  /* Swipe on the card strip. Scoped to the strip rather than the whole screen
     so it never fights the 3D scene for the gesture, and ignored when the
     gesture is mostly vertical — a downward flick on a phone is somebody
     trying to scroll, not trying to change worlds. */
  const onTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy)) move(dx < 0 ? 1 : -1);
  };

  const visible = useMemo(() => {
    const out: { gate: (typeof GATES)[number]; offset: number; index: number }[] = [];
    for (let o = -wing; o <= wing; o++) {
      const n = GATES.length;
      const i = ((focusedIndex + o) % n + n) % n;
      out.push({ gate: GATES[i], offset: o, index: i });
    }
    return out;
  }, [focusedIndex, wing]);

  /* How tall the strip actually got, measured rather than guessed. The cards
     have to fit two budgets at once — the height flex handed them, and the
     width left over after the arrows — and only one of those is knowable from
     the viewport alone. */
  const stripRef = useRef<HTMLDivElement>(null);
  const [stripH, setStripH] = useState(0);
  useEffect(() => {
    const el = stripRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setStripH(entry.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Relative size of a card by how far it sits from the focused one. */
  const scaleAt = (dist: number) => [1, 0.74, 0.58][dist] ?? 0.5;

  /**
   * The focused card's size, in pixels.
   *
   * Height first: whatever room the flex row was given, minus nothing. Then
   * capped by width — but only loosely on a phone, because the neighbours are
   * *meant* to run off both edges there. Fitting the whole strip inside 390 px
   * is what made the cards postage stamps; letting them peek out of a clipped
   * row is both the normal mobile carousel idiom and three times the size.
   */
  const card = useMemo(() => {
    const fromHeight = (stripH || h * 0.34) * 0.75; // cards are 3:4
    const fromWidth = narrow ? w * 0.6 : (w - 2 * 56) / (1 + 2 * scaleAt(1) + 2 * scaleAt(2));
    const width = Math.max(84, Math.min(fromHeight, fromWidth, 232));
    return { width, height: width * (4 / 3) };
  }, [w, h, narrow, stripH]);

  const accent = `#${focused.accent.toString(16).padStart(6, "0")}`;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-10 flex select-none flex-col"
      style={{
        paddingTop: "max(env(safe-area-inset-top), 10px)",
        paddingBottom: "max(env(safe-area-inset-bottom), 10px)",
      }}
    >
      {/* Scrims. The sky here is mostly bright cumulus, and white text on white
          cloud is not a style choice, it is an unreadable screen. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-40"
        style={{ background: "linear-gradient(180deg, rgba(3,26,54,.55) 0%, rgba(3,26,54,0) 100%)" }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-44"
        style={{ background: "linear-gradient(0deg, rgba(3,26,54,.58) 0%, rgba(3,26,54,0) 100%)" }}
        aria-hidden
      />

      {/* Top bar. No exit of its own: the global home button sits in the
          top-left corner of every world, this one included, and two ways out
          in the same corner is the disunity it was built to end. The corner is
          left clear for it. */}
      <div className="pointer-events-auto relative flex shrink-0 items-center justify-between gap-2 pl-[var(--vv-home-clear)] pr-3 sm:pr-7">
        <span className="hidden text-[11px] font-bold uppercase tracking-[0.34em] text-white/90 drop-shadow-lg sm:block">
          Vibeverse
        </span>

        <nav className="hidden items-center gap-1 rounded-full bg-black/30 px-1.5 py-1 backdrop-blur-md ring-1 ring-white/20 lg:flex">
          {LINKS.map((l, i) => (
            <Link
              key={l.label}
              to={l.to}
              className={`rounded-full px-4 py-1.5 text-[12px] font-semibold transition ${
                i === 0 ? "bg-white text-slate-900" : "text-white/85 hover:text-white"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        {/* Only when there is a number. "— Online" told nobody anything. */}
        {online !== null && (
          <span className="flex items-center gap-1.5 rounded-full bg-black/30 px-3 py-1.5 text-[11px] font-semibold text-white backdrop-blur-md ring-1 ring-white/20">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {online} online
          </span>
        )}
      </div>

      {/* Title. Dropped entirely on a phone in landscape, where the honest
          answer is that there is no room for it and the cards matter more. */}
      {!short && (
        <div className="relative mt-3 shrink-0 px-4 text-center sm:mt-6">
          <h1
            className="mx-auto max-w-[18ch] text-[clamp(1.25rem,3.6vw,2.4rem)] font-black leading-tight tracking-tight text-white sm:max-w-none"
            style={{ textShadow: "0 2px 18px rgba(2,20,44,.85)" }}
          >
            What kind of adventure do you want today?
          </h1>
          <p
            className="mt-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-white/85 sm:text-[12px]"
            style={{ textShadow: "0 2px 12px rgba(2,20,44,.9)" }}
          >
            Every builder grows the universe
          </p>
        </div>
      )}

      {/* Carousel. Takes whatever vertical room is left and sizes the cards off
          its own height, so the strip shrinks in landscape instead of growing
          down through the button below it. */}
      <div
        ref={stripRef}
        className="pointer-events-auto relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        style={{ touchAction: "pan-y" }}
      >
        {/* The arrows float over the strip rather than sitting beside it. As
            flex siblings they ate 96 px of a 390 px screen, which is a quarter
            of the phone spent on two chevrons. */}
        <button
          onClick={() => move(-1)}
          aria-label="Previous world"
          className="absolute left-2 top-1/2 z-20 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white backdrop-blur-md ring-1 ring-white/25 transition hover:bg-black/55 active:scale-90 sm:left-4"
        >
          ‹
        </button>

        <div className="flex items-center justify-center gap-2 sm:gap-3">
          {visible.map(({ gate, offset, index }) => {
            const isFocus = offset === 0;
            const dist = Math.abs(offset);
            const art = artFor(gate.key);
            const s = scaleAt(dist);
            return (
              <button
                key={gate.key}
                onClick={() => (isFocus ? enter() : onFocus(index))}
                aria-label={isFocus ? `Enter ${gate.name}` : `Focus ${gate.name}`}
                className="relative shrink-0 overflow-hidden rounded-2xl text-left transition-all duration-300 ease-out"
                style={{
                  /* Explicit pixels, both axes. Sizing off `height: 100%` and
                     an aspect ratio looks equivalent until flex shrinks the
                     width to make the row fit and the ratio quietly loses —
                     which turned every card into a tall sliver on a phone. */
                  width: card.width * s,
                  height: card.height * s,
                  opacity: isFocus ? 1 : 0.66 - dist * 0.14,
                  boxShadow: isFocus
                    ? `0 0 0 2.5px ${accent}, 0 18px 46px rgba(0,30,70,.45)`
                    : "0 8px 22px rgba(0,30,70,.3)",
                }}
              >
                <div className="relative h-full w-full overflow-hidden bg-slate-900">
                  {art ? (
                    <img
                      src={art}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div
                      className="h-full w-full"
                      style={{
                        background: `linear-gradient(168deg, #${gate.accent
                          .toString(16)
                          .padStart(6, "0")}dd 0%, rgba(8,22,44,.94) 72%)`,
                      }}
                    />
                  )}
                  {/* A wash of the world's accent keeps the strip reading as one
                      set rather than ten unrelated photographs. */}
                  <div
                    className="absolute inset-0 mix-blend-soft-light"
                    style={{
                      background: `#${gate.accent.toString(16).padStart(6, "0")}`,
                      opacity: isFocus ? 0.24 : 0.42,
                    }}
                  />
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-2 sm:p-2.5">
                    <div className={`font-bold text-white ${isFocus ? "text-[13px]" : "text-[10px]"}`}>
                      {gate.name}
                    </div>
                    {/* The blurb only on the focused card, and only when the
                        card is tall enough to hold it without clipping. */}
                    {isFocus && !short && (
                      <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-white/80">
                        {gate.blurb}
                      </p>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <button
          onClick={() => move(1)}
          aria-label="Next world"
          className="absolute right-2 top-1/2 z-20 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white backdrop-blur-md ring-1 ring-white/25 transition hover:bg-black/55 active:scale-90 sm:right-4"
        >
          ›
        </button>
      </div>

      {/* Enter */}
      <div className="pointer-events-auto relative mt-2 flex shrink-0 flex-col items-center gap-1.5 px-4">
        <button
          onClick={enter}
          className="min-h-[52px] w-full max-w-sm rounded-2xl px-8 text-[15px] font-black uppercase tracking-wide text-slate-900 shadow-xl transition active:scale-95"
          style={{ background: accent, WebkitTapHighlightColor: "transparent" }}
        >
          Enter {focused.name}
        </button>
        <div className="flex items-center gap-3">
          <p
            className="text-[10.5px] font-medium tracking-wide text-white/85"
            style={{ textShadow: "0 1px 8px rgba(2,20,44,.9)" }}
          >
            {narrow ? "Swipe to explore" : "Swipe or use A / D to explore · Esc to leave"}
          </p>
          <Link
            to="/character-select"
            className="rounded-full bg-black/30 px-3 py-1 text-[10.5px] font-semibold text-white/90 backdrop-blur-md ring-1 ring-white/20 transition hover:bg-black/45"
          >
            🧍 Customize
          </Link>
        </div>
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
