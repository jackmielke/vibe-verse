/**
 * TagHud — top-center HUD for the Tag mini-game.
 *
 * Shows the current streak, a short-lived toast naming the last person
 * you tagged, and a shrinking sliver bar showing how long you have
 * before the streak decays. Deliberately silent until you've tagged at
 * least one player — non-players never see it.
 */
import { useEffect, useState } from "react";
import type { TagGame, TagState } from "@/components/city/tagGame";

export function TagHud({ game }: { game: TagGame | null }) {
  const [state, setState] = useState<TagState | null>(null);
  const [now, setNow] = useState<number>(() => performance.now());

  useEffect(() => {
    if (!game) return;
    return game.subscribe(setState);
  }, [game]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(id);
  }, []);

  if (!state || state.streak <= 0 || !state.lastTagAt) return null;

  const sinceTag = now - state.lastTagAt;
  const timeLeft = Math.max(0, state.decayMs - sinceTag);
  const pct = timeLeft / state.decayMs;
  const toastOn = sinceTag < 2400;

  return (
    <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-1 animate-fade-in">
      <div className="glass-panel rounded-full border border-rose-400/50 px-4 py-1.5 shadow-[0_0_24px_rgba(244,63,94,0.35)] flex items-center gap-2">
        <span className="text-base leading-none">🏷️</span>
        <span className="font-heading text-sm font-bold tracking-widest text-rose-200">
          TAG · x{state.streak}
        </span>
        {state.bestStreak > state.streak && (
          <span className="text-[10px] uppercase tracking-widest text-rose-200/60">
            best {state.bestStreak}
          </span>
        )}
      </div>
      <div className="w-40 h-1 rounded-full bg-rose-900/40 overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-rose-400 to-fuchsia-400 transition-[width] duration-100"
          style={{ width: `${pct * 100}%` }}
        />
      </div>
      {toastOn && state.lastName && (
        <div className="mt-0.5 rounded-full bg-rose-500/20 border border-rose-300/40 px-2.5 py-0.5 text-[11px] font-semibold text-rose-100">
          Tagged {state.lastName}!
        </div>
      )}
    </div>
  );
}
