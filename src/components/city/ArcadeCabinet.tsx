import { useCallback, useEffect, useRef, useState } from "react";
import { ARCADE_SCORE_MESSAGE, type ArcadeScoreMessage } from "@/arcade/report";
import { arcadeGame, cleanInitials, formatScore } from "@/arcade/games";
import { addTickets } from "@/arcade/tickets";
import { isTodaysBest, lastInitials, rankOf, submitScore, type Board } from "@/arcade/board";

/**
 * ArcadeCabinet — one of the Vibe Arcade's games, open over the city.
 *
 * The game is its own route, framed with `?embed=1` so the global nav stays
 * out of it, and drawn inside a neon cabinet bezel. Same origin, so the game
 * sees the same saved character, coins and sign-in as everywhere else.
 *
 * It opens the way an old CRT switches on (a line of light that blooms into
 * the picture) at the end of the camera's dive into the screen, and closes
 * the way one switches off.
 *
 * When a run ends the game posts its score (`src/arcade/report.ts`); the
 * cabinet pays the tickets and, for a score that makes the wall, asks for
 * three initials.
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

interface Result {
  score: number;
  won: boolean;
  tickets: number;
  rank: number | null;
  today: boolean;
  signed?: "live" | "local";
}

const CRT_CSS = `
@keyframes arcade-crt-on {
  0% { transform: scale(0.92, 0.004); filter: brightness(6) saturate(0); opacity: 1; }
  35% { transform: scale(1, 0.006); filter: brightness(5) saturate(0); }
  70% { transform: scale(1, 1.02); filter: brightness(1.8); }
  100% { transform: scale(1, 1); filter: none; }
}
@keyframes arcade-crt-off {
  0% { transform: scale(1, 1); filter: none; opacity: 1; }
  45% { transform: scale(1, 0.006); filter: brightness(5) saturate(0); opacity: 1; }
  100% { transform: scale(0, 0.004); filter: brightness(8); opacity: 0; }
}
@keyframes arcade-scan { from { background-position: 0 0; } to { background-position: 0 6px; } }
@keyframes arcade-pop { 0% { transform: translateY(16px) scale(0.96); opacity: 0; } 100% { transform: none; opacity: 1; } }
`;

export function ArcadeCabinet({
  game,
  onClose,
  board,
  onBoardChanged,
}: {
  game: CabinetGame | null;
  onClose: () => void;
  board?: Board | null;
  onBoardChanged?: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [closing, setClosing] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [initials, setInitials] = useState("");
  const boardRef = useRef(board);
  boardRef.current = board;
  const lastMsg = useRef(0);

  const close = useCallback(() => {
    setClosing((c) => {
      if (!c) window.setTimeout(onClose, 280);
      return true;
    });
  }, [onClose]);

  useEffect(() => {
    setLoaded(false);
    setClosing(false);
    setResult(null);
    if (!game) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => frameRef.current?.focus(), 200);
    // Watch for the game navigating away from itself.
    const watch = window.setInterval(() => {
      try {
        const path = frameRef.current?.contentWindow?.location.pathname;
        if (path && path !== "blank" && path !== game.route && !path.startsWith(game.route + "/")) close();
      } catch {
        /* cross-origin: leave it be */
      }
    }, 500);
    // A run ended inside the frame.
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frameRef.current?.contentWindow) return;
      const m = e.data as ArcadeScoreMessage;
      if (!m || m.type !== ARCADE_SCORE_MESSAGE || m.game !== game.key) return;
      const now = performance.now();
      if (now - lastMsg.current < 2500) return;
      lastMsg.current = now;
      const g = arcadeGame(game.key);
      if (!g) return;
      const score = Math.max(0, Math.min(g.max, Math.round(m.score)));
      const tickets = g.tickets(score, !!m.won);
      addTickets(tickets);
      const b = boardRef.current;
      const worth = score > 0;
      setResult({
        score, won: !!m.won, tickets,
        rank: b && worth ? rankOf(b, game.key, score) : null,
        today: !!b && worth && isTodaysBest(b, game.key, score),
      });
      setInitials(lastInitials());
    };
    window.addEventListener("message", onMsg);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMsg);
      window.clearTimeout(t);
      window.clearInterval(watch);
    };
  }, [game, close]);

  if (!game) return null;
  const src = `${game.route}?embed=1&from=arcade`;
  const g = arcadeGame(game.key);
  const canSign = !!result && (result.rank !== null || result.today) && !result.signed;
  const sign = async () => {
    if (!result || !cleanInitials(initials)) return;
    const r = await submitScore(game.key, initials, result.score);
    if (!r.ok) return;
    setResult({ ...result, signed: r.live ? "live" : "local" });
    onBoardChanged?.();
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      data-arcade-cabinet={game.key}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <style>{CRT_CSS}</style>
      <div
        className="relative flex h-[100dvh] w-screen flex-col overflow-hidden bg-[#07040f] sm:h-[min(94dvh,960px)] sm:w-[min(96vw,1500px)] sm:rounded-[28px] sm:border-[3px]"
        style={{
          borderColor: game.accent,
          boxShadow: `0 0 40px ${game.accent}88, inset 0 0 24px ${game.accent}33`,
          animation: closing ? "arcade-crt-off 280ms ease-in forwards" : "arcade-crt-on 520ms cubic-bezier(.2,.8,.2,1) both",
        }}
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
            <div className="hidden text-[11px] text-white/55 sm:block">Vibe Arcade, Vibe City. Every run pays tickets. Esc to step away.</div>
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
            onClick={close}
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
                  if (e.key === "Escape" && !e.defaultPrevented) close();
                });
              } catch {
                /* cross-origin */
              }
            }}
            allow="autoplay; fullscreen; gamepad; clipboard-write"
            className="absolute inset-0 h-full w-full border-0"
            style={{ opacity: loaded ? 1 : 0, transition: "opacity 300ms" }}
          />
          {/* A faint CRT texture over the glass. Pointer events pass through. */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background: "repeating-linear-gradient(0deg, rgba(0,0,0,0.10) 0 1px, transparent 1px 3px)",
              mixBlendMode: "multiply",
              animation: "arcade-scan 0.4s linear infinite",
            }}
          />
          <div className="pointer-events-none absolute inset-0" style={{ boxShadow: "inset 0 0 80px rgba(0,0,0,0.55)" }} />
          {result && (
            <div className="absolute inset-x-0 bottom-0 flex justify-center p-3" data-arcade-result>
              <div
                className="pointer-events-auto w-full max-w-md rounded-2xl border-2 bg-[#0b0620]/95 p-4 text-white shadow-2xl"
                style={{ borderColor: game.accent, boxShadow: `0 0 30px ${game.accent}77`, animation: "arcade-pop 300ms ease-out both" }}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-xs font-black uppercase tracking-[0.25em]" style={{ color: game.accent }}>
                    {result.rank === 1 ? "New record!" : result.rank ? `High score #${result.rank}` : result.today ? "Today's best!" : "Run over"}
                  </div>
                  <button onClick={() => setResult(null)} className="text-xs text-white/50 hover:text-white">Dismiss</button>
                </div>
                <div className="mt-1 flex items-end justify-between gap-3">
                  <div className="font-mono text-3xl font-black tabular-nums">{formatScore(g, result.score)}</div>
                  <div className="rounded-full bg-[#ff5f7a] px-3 py-1 text-sm font-black text-black">+{result.tickets} 🎟️</div>
                </div>
                {canSign && (
                  <form
                    className="mt-3 flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void sign();
                    }}
                  >
                    <input
                      autoFocus
                      value={initials}
                      onChange={(e) => setInitials(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3))}
                      onKeyDown={(e) => e.stopPropagation()}
                      placeholder="AAA"
                      maxLength={3}
                      aria-label="Your initials"
                      className="w-24 rounded-lg border border-white/25 bg-black/60 px-3 py-2 text-center font-mono text-2xl font-black uppercase tracking-[0.3em] text-white outline-none focus:border-white"
                    />
                    <button
                      type="submit"
                      disabled={!cleanInitials(initials)}
                      className="flex-1 rounded-lg px-3 py-2.5 text-sm font-black uppercase tracking-wider text-black disabled:opacity-40"
                      style={{ background: game.accent }}
                    >
                      Sign the wall
                    </button>
                  </form>
                )}
                {result.signed && (
                  <div className="mt-2 text-sm text-white/75">
                    {result.signed === "live" ? "You're on the wall. Everybody in the arcade can see it." : "Saved on the wall on this device. It goes up for everybody once the arcade is back online."}
                  </div>
                )}
                {!canSign && !result.signed && (
                  <div className="mt-2 text-xs text-white/55">Tickets go to the Prize Counter by the door. Play again to chase the wall.</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
