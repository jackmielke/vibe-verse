/**
 * CharacterDashboardModal — the Character Studio's "see everything at once"
 * view. The pedestal's ◀ ▶ arrows are fine for browsing three or four bodies
 * and miserable for sixty, so this is the other door: one searchable grid of
 * the whole roster, click to become.
 *
 * Deliberately presentational — it takes the active character id and an
 * `onPick`, and the page it lives on owns the actual swap (hologram, model
 * load, persistence). That keeps this usable from anywhere else that wants
 * the same dashboard later.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CHARACTERS, type CharSpec } from "@/lib/characters";

export default function CharacterDashboardModal({
  activeId,
  onPick,
  onClose,
}: {
  activeId: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      e.stopPropagation(); // don't drive the player while typing
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CHARACTERS;
    return CHARACTERS.filter(
      (c: CharSpec) =>
        c.label.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        (c.blurb ?? "").toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="glass-panel w-full max-w-4xl max-h-[86vh] flex flex-col rounded-2xl border border-cyan-300/40 bg-cyan-950/40 shadow-[0_0_60px_rgba(122,240,255,0.35)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-cyan-300/20">
          <div className="min-w-0">
            <div className="text-[9px] uppercase tracking-[0.3em] text-cyan-300/70">
              Character Studio
            </div>
            <div className="font-heading text-cyan-100 text-base leading-tight">
              All characters · {CHARACTERS.length}
            </div>
          </div>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name…"
            className="ml-auto w-40 sm:w-72 rounded-full bg-black/30 border border-cyan-300/30 px-4 py-2 text-sm text-cyan-100 placeholder:text-cyan-300/50 focus:outline-none focus:border-cyan-300/80"
          />
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-9 h-9 shrink-0 rounded-full bg-cyan-500/15 hover:bg-cyan-500/30 text-cyan-100 transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto p-4">
          <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-2.5">
            {filtered.map((c) => {
              const active = c.id === activeId;
              return (
                <button
                  key={c.id}
                  type="button"
                  title={c.blurb ?? c.label}
                  onClick={() => {
                    onPick(c.id);
                    onClose();
                  }}
                  className={`aspect-square rounded-xl flex flex-col items-center justify-center gap-1 border p-1 transition-all ${
                    active
                      ? "border-cyan-300 bg-cyan-400/20 scale-[1.03] shadow-[0_0_18px_rgba(122,240,255,0.6)]"
                      : "border-cyan-300/20 bg-black/25 hover:border-cyan-300/60 hover:bg-cyan-400/10"
                  }`}
                >
                  <span className="text-2xl" aria-hidden>
                    {c.emoji ?? "🧍"}
                  </span>
                  <span className="text-[9px] leading-tight text-cyan-100/80 text-center line-clamp-2 px-0.5">
                    {c.label}
                  </span>
                  {active && (
                    <span className="text-[8px] uppercase tracking-widest text-cyan-300">
                      equipped
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {filtered.length === 0 && (
            <p className="py-10 text-center text-sm text-cyan-200/70">
              Nobody here is called “{query}”.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
