import { useEffect, useRef, useState } from "react";

/**
 * Fullscreen arcade modal that embeds the deployed Esmeralda Jump
 * game (a separate Lovable project by Leo) inside an iframe with a
 * chunky retro CRT cabinet frame around it.
 *
 * The iframe URL points at the deployed app for project id
 * 8141ac0a-31e6-4d48-8829-28ac6924067a. The URL can be overridden by
 * setting `localStorage.esmeraldaJumpUrl` to a custom value — handy
 * if the published URL ever changes.
 */
const DEFAULT_URL = "https://esmeralda-jump.lovable.app/";

export function ArcadeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState<string>(DEFAULT_URL);

  // Allow runtime override so we don't have to redeploy if the
  // published URL of Esmeralda Jump moves.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const custom = localStorage.getItem("esmeraldaJumpUrl");
    if (custom) setUrl(custom);
  }, []);

  // ESC to close — and steal focus into the iframe so keyboard input
  // (the game's arrow keys / space) goes to the game, not the city
  // controls behind it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => iframeRef.current?.focus(), 120);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 backdrop-blur-md">
      {/* Cabinet shell */}
      <div className="relative w-[min(96vw,1280px)] h-[min(94vh,820px)] rounded-3xl border-2 border-fuchsia-400/40 bg-gradient-to-b from-zinc-900 via-zinc-950 to-black shadow-[0_0_80px_rgba(232,121,249,0.45)] p-3 flex flex-col">
        {/* Marquee */}
        <div className="flex items-center justify-between px-4 py-2 mb-2 rounded-2xl bg-gradient-to-r from-fuchsia-600/30 via-cyan-500/20 to-amber-400/30 border border-fuchsia-300/30">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🕹️</span>
            <div className="leading-tight">
              <div className="font-heading text-fuchsia-100 text-lg tracking-[0.2em]">
                ESMERALDA JUMP
              </div>
              <div className="text-[10px] uppercase tracking-[0.3em] text-cyan-200/80">
                Edge Island Arcade · by Leo
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-full px-4 py-1.5 text-xs uppercase tracking-widest bg-fuchsia-500/20 hover:bg-fuchsia-500/40 border border-fuchsia-300/40 text-fuchsia-50 transition-colors"
          >
            Exit ✕
          </button>
        </div>

        {/* Screen */}
        <div className="relative flex-1 rounded-2xl overflow-hidden border-4 border-zinc-800 bg-black shadow-[inset_0_0_60px_rgba(0,0,0,0.85)]">
          <iframe
            ref={iframeRef}
            src={url}
            title="Esmeralda Jump"
            className="absolute inset-0 w-full h-full"
            allow="autoplay; gamepad; fullscreen; clipboard-read; clipboard-write"
            // sandbox left permissive so the embedded game can run
            // its own scripts / store its own leaderboards.
          />
          {/* faint scanline overlay for arcade vibes */}
          <div
            className="pointer-events-none absolute inset-0 opacity-20 mix-blend-overlay"
            style={{
              backgroundImage:
                "repeating-linear-gradient(0deg, rgba(255,255,255,0.08) 0 1px, transparent 1px 3px)",
            }}
          />
        </div>

        {/* Coin slot footer */}
        <div className="flex items-center justify-between px-4 pt-2 text-[10px] uppercase tracking-[0.3em] text-zinc-400">
          <span>Insert Coin · ESC to exit</span>
          <span className="text-fuchsia-300/80">High scores live in the game</span>
        </div>
      </div>
    </div>
  );
}
