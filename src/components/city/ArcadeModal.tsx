import { useEffect, useRef, useState } from "react";

/**
 * Fullscreen arcade modal that embeds the deployed Esmeralda Jump
 * game (a separate Lovable project by Leo) inside an iframe with a
 * chunky retro CRT cabinet frame around it.
 */
const DEFAULT_URL = "https://esmeralda-jump.lovable.app/";

export function ArcadeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string>(DEFAULT_URL);
  const [expanded, setExpanded] = useState(false);
  const [isFs, setIsFs] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const custom = localStorage.getItem("esmeraldaJumpUrl");
    if (custom) setUrl(custom);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.fullscreenElement) onClose();
    };
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => iframeRef.current?.focus(), 120);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [open, onClose]);

  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleNativeFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await containerRef.current?.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (e) {
      console.warn("fullscreen failed", e);
    }
  };

  if (!open) return null;

  const sizeClasses = expanded
    ? "w-screen h-screen rounded-none border-0"
    : "w-[min(98vw,1600px)] h-[min(97vh,1000px)] rounded-3xl border-2";

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 backdrop-blur-md">
      <div
        ref={containerRef}
        className={`relative ${sizeClasses} border-fuchsia-400/40 bg-gradient-to-b from-zinc-900 via-zinc-950 to-black shadow-[0_0_80px_rgba(232,121,249,0.45)] p-3 flex flex-col`}
      >
        {/* Marquee */}
        <div className="flex items-center justify-between px-4 py-2 mb-2 rounded-2xl bg-gradient-to-r from-fuchsia-600/30 via-cyan-500/20 to-amber-400/30 border border-fuchsia-300/30">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🕹️</span>
            <div className="leading-tight">
              <div className="font-heading text-fuchsia-100 text-lg tracking-[0.2em]">
                ESMERALDA JUMP
              </div>
              <div className="text-[10px] uppercase tracking-[0.3em] text-cyan-200/80">
                Vibe Island Arcade · by Leo
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setExpanded((v) => !v)}
              className="rounded-full px-3 py-1.5 text-xs uppercase tracking-widest bg-cyan-500/20 hover:bg-cyan-500/40 border border-cyan-300/40 text-cyan-50 transition-colors"
              title={expanded ? "Shrink" : "Expand"}
            >
              {expanded ? "Shrink ⤓" : "Expand ⤢"}
            </button>
            <button
              onClick={toggleNativeFullscreen}
              className="rounded-full px-3 py-1.5 text-xs uppercase tracking-widest bg-amber-500/20 hover:bg-amber-500/40 border border-amber-300/40 text-amber-50 transition-colors"
              title="Toggle browser fullscreen"
            >
              {isFs ? "Exit FS" : "Fullscreen ⛶"}
            </button>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="rounded-full px-3 py-1.5 text-xs uppercase tracking-widest bg-emerald-500/20 hover:bg-emerald-500/40 border border-emerald-300/40 text-emerald-50 transition-colors"
            >
              Open ↗
            </a>
            <button
              onClick={onClose}
              className="rounded-full px-4 py-1.5 text-xs uppercase tracking-widest bg-fuchsia-500/20 hover:bg-fuchsia-500/40 border border-fuchsia-300/40 text-fuchsia-50 transition-colors"
            >
              Exit ✕
            </button>
          </div>
        </div>

        {/* Screen */}
        <div className="relative flex-1 rounded-2xl overflow-hidden border-4 border-zinc-800 bg-black shadow-[inset_0_0_60px_rgba(0,0,0,0.85)]">
          <iframe
            ref={iframeRef}
            src={url}
            title="Esmeralda Jump"
            className="absolute inset-0 w-full h-full"
            allow="autoplay; gamepad; fullscreen; clipboard-read; clipboard-write"
            allowFullScreen
          />
          <div
            className="pointer-events-none absolute inset-0 opacity-20 mix-blend-overlay"
            style={{
              backgroundImage:
                "repeating-linear-gradient(0deg, rgba(255,255,255,0.08) 0 1px, transparent 1px 3px)",
            }}
          />
        </div>

        <div className="flex items-center justify-between px-4 pt-2 text-[10px] uppercase tracking-[0.3em] text-zinc-400">
          <span>Insert Coin · ESC to exit</span>
          <span className="text-fuchsia-300/80">Tip: Expand or Fullscreen for the full view</span>
        </div>
      </div>
    </div>
  );
}
