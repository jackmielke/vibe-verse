/**
 * PhotoGalleryModal — holographic photo gallery that floats above the
 * cardboard TV. Players walk up to the TV, press the prompt, and a
 * scan-lined holo-frame pops up showing each gallery photo full-size
 * with caption + residency. Left/right keys or buttons sort through.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

export type GalleryPhoto = {
  url: string;
  title?: string | null;
  description?: string | null;
  residency?: string | null;
};

export function PhotoGalleryModal({
  open,
  photos,
  onClose,
}: {
  open: boolean;
  photos: GalleryPhoto[];
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const count = photos.length;

  const go = useCallback(
    (delta: number) => {
      if (!count) return;
      setIdx((i) => (i + delta + count) % count);
    },
    [count],
  );

  useEffect(() => {
    if (!open) return;
    setIdx(0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, go, onClose]);

  const current = photos[idx];
  const thumbWindow = useMemo(() => {
    if (!count) return [] as GalleryPhoto[];
    const span = 7;
    const half = Math.floor(span / 2);
    const start = Math.max(0, Math.min(count - span, idx - half));
    return photos.slice(start, start + span).map((p, i) => ({ ...p, _i: start + i } as GalleryPhoto & { _i: number }));
  }, [photos, idx, count]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      style={{ background: "radial-gradient(circle at center, rgba(8,18,28,0.78), rgba(2,6,12,0.95))" }}
      onClick={onClose}
    >
      {/* Scan-line / grid floor for that holo feel */}
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(45,212,168,0.05) 0px, rgba(45,212,168,0.05) 1px, transparent 1px, transparent 3px)",
        }}
      />

      <div
        className="relative w-full max-w-5xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Holo frame */}
        <div
          className="relative overflow-hidden rounded-3xl border border-cyan-300/40"
          style={{
            background:
              "linear-gradient(180deg, rgba(11,28,40,0.85), rgba(7,18,26,0.92))",
            boxShadow:
              "0 0 80px rgba(45,212,168,0.35), inset 0 0 60px rgba(122,240,255,0.15)",
          }}
        >
          {/* Corner brackets */}
          {[
            "top-2 left-2 border-t-2 border-l-2 rounded-tl-lg",
            "top-2 right-2 border-t-2 border-r-2 rounded-tr-lg",
            "bottom-2 left-2 border-b-2 border-l-2 rounded-bl-lg",
            "bottom-2 right-2 border-b-2 border-r-2 rounded-br-lg",
          ].map((c) => (
            <div key={c} className={`pointer-events-none absolute ${c} h-6 w-6 border-cyan-300/80`} />
          ))}

          {/* Header */}
          <div className="flex items-center justify-between border-b border-cyan-400/20 px-5 py-3">
            <div className="flex items-center gap-3">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-cyan-300 shadow-[0_0_10px_rgba(122,240,255,0.9)]" />
              <span className="text-xs uppercase tracking-[0.3em] text-cyan-200/90">
                Holo Gallery · {count ? `${idx + 1} / ${count}` : "no photos"}
              </span>
            </div>
            <button
              onClick={onClose}
              className="rounded-full p-1.5 text-cyan-100/80 hover:bg-cyan-300/10 hover:text-cyan-50"
              aria-label="Close gallery"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Photo stage */}
          <div className="relative flex aspect-[16/10] items-center justify-center bg-black/40">
            {current ? (
              <img
                key={current.url}
                src={current.url}
                alt={current.title ?? "Gallery photo"}
                className="max-h-full max-w-full object-contain animate-fade-in"
                style={{
                  filter:
                    "drop-shadow(0 0 18px rgba(122,240,255,0.35)) drop-shadow(0 0 40px rgba(45,212,168,0.25))",
                }}
                draggable={false}
              />
            ) : (
              <div className="text-cyan-200/70">No photos yet — check back soon.</div>
            )}

            {/* Subtle scanline overlay on the photo */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(0deg, rgba(122,240,255,0.05) 0px, rgba(122,240,255,0.05) 1px, transparent 1px, transparent 4px)",
                mixBlendMode: "screen",
              }}
            />

            {count > 1 && (
              <>
                <button
                  onClick={() => go(-1)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full border border-cyan-300/40 bg-black/40 p-2 text-cyan-100 backdrop-blur hover:bg-cyan-300/20"
                  aria-label="Previous photo"
                >
                  <ChevronLeft className="h-6 w-6" />
                </button>
                <button
                  onClick={() => go(1)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full border border-cyan-300/40 bg-black/40 p-2 text-cyan-100 backdrop-blur hover:bg-cyan-300/20"
                  aria-label="Next photo"
                >
                  <ChevronRight className="h-6 w-6" />
                </button>
              </>
            )}
          </div>

          {/* Caption */}
          <div className="border-t border-cyan-400/20 px-5 py-4">
            <div className="flex items-baseline justify-between gap-4">
              <div className="min-w-0">
                <div className="truncate text-lg font-medium text-cyan-50">
                  {current?.title || "Untitled"}
                </div>
                {current?.residency && (
                  <div className="text-xs uppercase tracking-wider text-cyan-300/80">
                    {current.residency}
                  </div>
                )}
              </div>
              <div className="shrink-0 text-[10px] uppercase tracking-[0.25em] text-cyan-200/60">
                ← → to browse · Esc to close
              </div>
            </div>
            {current?.description && (
              <div className="mt-2 text-sm leading-relaxed text-cyan-100/85">
                {current.description}
              </div>
            )}
          </div>

          {/* Thumbnail strip */}
          {count > 1 && (
            <div className="border-t border-cyan-400/20 bg-black/30 px-3 py-3">
              <div className="flex justify-center gap-2">
                {thumbWindow.map((p) => {
                  const i = (p as GalleryPhoto & { _i: number })._i;
                  const active = i === idx;
                  return (
                    <button
                      key={`${p.url}-${i}`}
                      onClick={() => setIdx(i)}
                      className={`relative h-14 w-20 overflow-hidden rounded-md border transition ${
                        active
                          ? "border-cyan-300 shadow-[0_0_16px_rgba(122,240,255,0.7)]"
                          : "border-cyan-300/20 opacity-60 hover:opacity-100"
                      }`}
                    >
                      <img src={p.url} alt="" className="h-full w-full object-cover" draggable={false} />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Faux holo beam underneath */}
        <div
          className="pointer-events-none mx-auto mt-2 h-3 w-3/4 rounded-full"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(122,240,255,0.55), rgba(45,212,168,0) 70%)",
            filter: "blur(2px)",
          }}
        />
      </div>
    </div>
  );
}
