/**
 * `/play/:slug` — a game somebody else wrote, running inside the vibeverse.
 *
 * This page is the whole third-party story made visible. It draws four things
 * around a rectangle it does not control:
 *
 *   1. **Who made this.** A game in a frame is indistinguishable from a game
 *      in the codebase unless somebody says otherwise, and the person who
 *      wrote it should get their name on it.
 *   2. **What it can pay.** The budgets are not a secret to be discovered by
 *      hitting them. "12 a round, 120 left for you today" up front is both
 *      more honest and better play.
 *   3. **A way out.** Always. A game cannot navigate the player anywhere — the
 *      sandbox sees to that — so the only exit is one we draw.
 *   4. **The balance moving.** The point of the whole feature is that coins
 *      earned in a stranger's game are the same coins as everywhere else, and
 *      the way to say that is to have the number in the corner tick up.
 *
 * What it deliberately does NOT do is hand the frame anything. See
 * `src/portal/host.ts` — the session id lives in a closure here and never
 * crosses the boundary.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";

import VibeCoinMark from "@/components/VibeCoinMark";
import { applyLocalDelta, currentOwner, refreshVibecoin, VIBECOIN_GLYPH } from "@/lib/vibecoin";
import {
  closePortalSession,
  closePortalSessionBeacon,
  openPortalSession,
  type PortalSession,
} from "@/portal/api";
import { FRAME_ALLOW, FRAME_SANDBOX, startBridge } from "@/portal/host";

export default function PortalPlay() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  /* No passport stamp here. The passport records the places in the vibeverse
     you have been, and `/play/:slug` is a window onto somewhere that is not
     one — a stamp per third-party game would be the passport claiming credit
     for other people's worlds. `/build`, which IS ours, carries the stamp. */

  const [session, setSession] = useState<PortalSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [earned, setEarned] = useState(0);
  const [headroom, setHeadroom] = useState<number | null>(null);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /* The session id, again, in a ref: the bridge is started from an effect that
     must not re-run when a payout arrives and moves state. */
  const sessionRef = useRef<PortalSession | null>(null);

  const goBack = useCallback(() => navigate("/arcade"), [navigate]);

  // --- open the session -----------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setSession(null);
    setError(null);
    setReady(false);
    setEarned(0);

    void (async () => {
      try {
        const owner = await currentOwner();
        const s = await openPortalSession(slug, owner.kind, owner.ref);
        if (cancelled) return;
        sessionRef.current = s;
        setSession(s);
        setHeadroom(s.headroom);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();

    return () => {
      cancelled = true;
      const open = sessionRef.current;
      sessionRef.current = null;
      if (open) void closePortalSession(open.sessionId).catch(() => {});
    };
  }, [slug]);

  // --- close it when the tab goes, too --------------------------------------
  useEffect(() => {
    const onHide = () => {
      const open = sessionRef.current;
      if (open) closePortalSessionBeacon(open.sessionId);
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  // --- the bridge -----------------------------------------------------------
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !session) return;

    const bridge = startBridge(frame, session, {
      onReady: () => setReady(true),
      onExit: goBack,
      onAward: (r) => {
        setHeadroom(r.headroom);
        if (r.amount <= 0) return;
        setEarned((v) => v + r.amount);
        // Move the chip on this frame rather than after a round trip, then let
        // the authoritative number land behind it.
        applyLocalDelta(r.amount);
        void refreshVibecoin();
        toast.success(`+${r.amount} ${VIBECOIN_GLYPH}`, {
          description: r.capped ? "That is everything this game had for you today." : session.game.title,
        });
      },
    });
    return () => bridge.stop();
  }, [session, goBack]);

  const game = session?.game;

  return (
    <div className="fixed inset-0 flex flex-col bg-[#05080f]">
      {/* The bar. Thin on purpose — it is a frame around somebody else's work,
          not a competing interface. */}
      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 bg-[#070c16]/95 px-3 py-2 backdrop-blur">
        <button
          onClick={goBack}
          className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 font-heading text-[10px] font-bold uppercase tracking-wider text-foreground/70 transition-colors hover:bg-white/10 hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Arcade
        </button>

        <div className="min-w-0 flex-1">
          <div className="truncate font-heading text-[13px] font-bold leading-tight text-foreground">
            {game?.title ?? "…"}
          </div>
          {game?.author && (
            <div className="truncate text-[10px] leading-tight text-muted-foreground">
              by{" "}
              {game.authorUrl ? (
                <a
                  href={game.authorUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                >
                  {game.author}
                  <ExternalLink className="ml-0.5 inline h-2.5 w-2.5" />
                </a>
              ) : (
                game.author
              )}
            </div>
          )}
        </div>

        {/* Two numbers, and they mean different things: what this visit has
            paid, and what is left in it. Showing only the first makes a game
            that has run dry feel broken. */}
        <div className="flex shrink-0 items-center gap-2.5">
          <div className="text-right">
            <div className="flex items-center justify-end gap-1 font-heading text-sm font-black leading-none tabular-nums text-[#7dffd4]">
              <VibeCoinMark size={14} />+{earned}
            </div>
            <div className="mt-0.5 text-[9px] leading-none text-muted-foreground">
              {headroom == null ? " " : `${headroom} left today`}
            </div>
          </div>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="font-heading text-sm text-foreground">That game is not open.</p>
            <p className="max-w-sm text-xs text-muted-foreground">{error}</p>
            <Link
              to="/arcade"
              className="mt-1 rounded-full border border-border/60 px-4 py-2 font-heading text-[10px] font-bold uppercase tracking-wider text-foreground/80 hover:text-foreground"
            >
              Back to the arcade
            </Link>
          </div>
        ) : (
          <>
            {game && (
              <iframe
                ref={frameRef}
                key={game.slug}
                src={game.embedUrl}
                title={game.title}
                sandbox={FRAME_SANDBOX}
                allow={FRAME_ALLOW}
                /* No `referrerPolicy` default: a third-party game has no
                   business knowing which page in the vibeverse sent the
                   player, and several of those routes are unlisted. */
                referrerPolicy="no-referrer"
                className="h-full w-full border-0 bg-black"
              />
            )}
            {/* The frame is black until the game says hello, and a black
                rectangle with no explanation reads as broken. */}
            {!ready && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#05080f]">
                <Loader2 className="h-5 w-5 animate-spin text-[#7dffd4]" />
                <p className="font-heading text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  {game ? `Loading ${game.title}` : "Opening the portal"}
                </p>
                {game && (
                  <p className="max-w-xs px-6 text-center text-[10px] leading-relaxed text-muted-foreground/60">
                    {game.origin === "self" ? (
                      <>Made here. </>
                    ) : (
                      <>
                        Runs on {new URL(game.embedUrl, window.location.origin).host}, sandboxed.
                        It is never told who you are.{" "}
                      </>
                    )}
                    It can pay you up to {game.maxAward} {VIBECOIN_GLYPH} at a time, out of an
                    allowance the vibeverse holds.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
