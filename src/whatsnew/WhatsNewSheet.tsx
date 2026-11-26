/**
 * What's New as an overlay, for places where leaving the page would throw the
 * visitor out of a world (Vibe Island). Lazy-imported by whoever opens it.
 */
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import WhatsNewList from "./WhatsNewList";
import { markAllSeen } from "./index";

export default function WhatsNewSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    markAllSeen();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Portalled to <body>: a HUD with backdrop-filter would otherwise become
  // the containing block for `fixed` and trap the sheet inside a pill.
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center"
      onClick={onClose}
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-label="What's New"
    >
      <div
        className="flex max-h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-white/10 bg-[#0b0f1f]/95 text-white shadow-2xl sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-white/10 px-5 py-4">
          <span className="text-2xl" aria-hidden>
            ✨
          </span>
          <div className="mr-auto">
            <h2 className="font-heading text-[17px] font-bold leading-tight">What's New</h2>
            <p className="text-[12px] text-white/55">Every update to the Vibe Verse, newest first</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-white/70 hover:bg-white/10 hover:text-white"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto overscroll-contain px-5 pb-6 pt-3">
          <WhatsNewList compact onNavigate={onClose} />
          <div className="mt-6 text-center">
            <Link to="/whats-new" onClick={onClose} className="text-[12px] text-white/55 underline-offset-2 hover:text-white hover:underline">
              Open the full page
            </Link>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
