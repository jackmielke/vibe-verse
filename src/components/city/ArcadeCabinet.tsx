import { useEffect, useRef, useState } from "react";

/**
 * ArcadeCabinet — one of the Vibe Arcade's games, open over the city.
 *
 * The game is its own route, framed with `?embed=1` so the global nav stays
 * out of it, and drawn inside a neon cabinet bezel. Same origin, so the game
 * sees the same saved character, coins and sign-in as everywhere else.
 *
 * A game's own "back to the hub" link would load the whole front page inside
 * the cabinet. So the frame is watched: the moment it leaves the game's
 * route, the cabinet closes and you are back on the arcade floor instead.
 */
export interface CabinetGame {
  key: string;
  title: string;
  emoji: string;
  route: string;
  accent: string;
}

export function ArcadeCabinet({ game, onClose }: { game: CabinetGame | null; onClose: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
    if (!game) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => frameRef.current?.focus(), 200);
    // Watch for the game navigating away from itself.
    const watch = window.setInterval(() => {
      try {
        const path = frameRef.current?.contentWindow?.location.pathname;
        if (path && path !== "blank" && path !== game.route && !path.startsWith(game.route + "/")) onClose();
      } catch {
        /* cross-origin: leave it be */
      }
    }, 500);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
      window.clearInterval(watch);
    };
  }, [game, onClose]);

  if (!game) return null;
  const src = `${game.route}?embed=1&from=arcade`;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      data-arcade-cabinet={game.key}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="relative flex h-[100dvh] w-screen flex-col overflow-hidden bg-[#07040f] sm:h-[min(94dvh,960px)] sm:w-[min(96vw,1500px)] sm:rounded-[28px] sm:border-[3px]"
        style={{ borderColor: game.accent, boxShadow: `0 0 40px ${game.accent}88, inset 0 0 24px ${game.accent}33` }}
      >
        <div
          className="flex shrink-0 items-center gap-3 px-4 py-2"
          style={{ background: `linear-gradient(90deg, ${game.accent}33, transparent 60%)` }}
        >
          <span className="text-2xl leading-none">{game.emoji}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-black uppercase tracking-[0.18em] text-white" style={{ textShadow: `0 0 12px ${game.accent}` }}>
              {game.title}
            </div>
            <div className="hidden text-[11px] text-white/55 sm:block">Vibe Arcade, Vibe City. Esc to step away from the cabinet.</div>
          </div>
          <a
            href={game.route}
            target="_blank"
            rel="noreferrer"
            className="hidden rounded-full border border-white/20 px-3 py-1 text-xs text-white/70 hover:bg-white/10 sm:inline-block"
          >
            Open full screen ↗
          </a>
          <button
            onClick={onClose}
            className="rounded-full px-4 py-1.5 text-sm font-bold text-black"
            style={{ background: game.accent }}
          >
            Back to the arcade
          </button>
        </div>
        <div className="relative min-h-0 flex-1">
          {!loaded && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/70">
              <div className="animate-pulse text-6xl">{game.emoji}</div>
              <div className="text-xs uppercase tracking-[0.3em]">Inserting coin</div>
            </div>
          )}
          <iframe
            ref={frameRef}
            key={game.key}
            src={src}
            title={game.title}
            onLoad={() => {
              setLoaded(true);
              // Keys go to the game once it has focus, so Escape is heard
              // inside the frame too, unless the game used it for itself.
              try {
                frameRef.current?.contentWindow?.addEventListener("keydown", (e) => {
                  if (e.key === "Escape" && !e.defaultPrevented) onClose();
                });
              } catch {
                /* cross-origin */
              }
            }}
            allow="autoplay; fullscreen; gamepad; clipboard-write"
            className="absolute inset-0 h-full w-full border-0"
            style={{ opacity: loaded ? 1 : 0, transition: "opacity 300ms" }}
          />
        </div>
      </div>
    </div>
  );
}
