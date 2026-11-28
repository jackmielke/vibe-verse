import { useEffect, useState } from "react";
import { PRIZES, onTicketsChanged, ownedPrizes, redeem, tickets } from "@/arcade/tickets";
import { ARCADE_GAMES, formatScore } from "@/arcade/games";
import type { Board } from "@/arcade/board";

/**
 * The Vibe Arcade's prize counter: trade tickets for prizes, and the whole
 * high score wall in a readable list (the one on the wall is a long way up
 * on a phone).
 */
export function PrizeCounter({
  open,
  onClose,
  board,
  wornHat,
  onWear,
}: {
  open: boolean;
  onClose: () => void;
  board: Board | null;
  wornHat: string | null;
  onWear: (id: string | null) => void;
}) {
  const [tab, setTab] = useState<"prizes" | "scores">("prizes");
  const [bal, setBal] = useState(tickets);
  const [owned, setOwned] = useState(ownedPrizes);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => {
      setBal(tickets());
      setOwned(ownedPrizes());
    };
    sync();
    return onTicketsChanged(sync);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      data-prize-counter
    >
      <div className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border-2 border-[#ff3fd1] bg-[#0b0620] text-white shadow-[0_0_40px_#ff3fd188] sm:rounded-3xl">
        <div className="flex items-center gap-3 border-b border-white/10 px-5 py-3">
          <div className="flex-1">
            <div className="text-lg font-black uppercase tracking-[0.2em]" style={{ textShadow: "0 0 14px #ff3fd1" }}>Prize Counter</div>
            <div className="text-xs text-white/55">Every game in the arcade pays tickets. Kept on this device.</div>
          </div>
          <div className="rounded-full bg-[#ff5f7a] px-3 py-1 font-mono text-lg font-black text-black" data-ticket-balance>🎟️ {bal}</div>
          <button onClick={onClose} className="rounded-full px-3 py-1 text-white/60 hover:bg-white/10 hover:text-white" aria-label="Close">✕</button>
        </div>
        <div className="flex gap-2 px-5 pt-3">
          {(["prizes", "scores"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-full px-4 py-1.5 text-sm font-bold ${tab === t ? "bg-[#ff3fd1] text-black" : "bg-white/10 text-white/70"}`}
            >
              {t === "prizes" ? "Prizes" : "High scores"}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {tab === "prizes" ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {PRIZES.map((p) => {
                const has = owned.includes(p.id);
                const short = bal < p.cost;
                return (
                  <div
                    key={p.id}
                    className={`flex flex-col rounded-2xl border p-3 ${has ? "border-[#ffe14d] bg-[#ffe14d]/10" : "border-white/15 bg-white/5"}`}
                  >
                    <div className="text-4xl">{p.emoji}</div>
                    <div className="mt-1 font-bold leading-tight">{p.name}</div>
                    <div className="mt-0.5 flex-1 text-xs text-white/55">{p.blurb}</div>
                    {has ? (
                      p.kind === "hat" ? (
                        <button
                          onClick={() => onWear(wornHat === p.id ? null : p.id)}
                          className="mt-2 rounded-lg bg-[#ffe14d] px-2 py-1.5 text-sm font-black text-black"
                        >
                          {wornHat === p.id ? "Take it off" : "Wear it"}
                        </button>
                      ) : (
                        <div className="mt-2 text-center text-xs font-bold text-[#ffe14d]">On your shelf ✓</div>
                      )
                    ) : (
                      <button
                        disabled={short}
                        onClick={() => {
                          if (redeem(p.id)) {
                            setFlash(p.id);
                            window.setTimeout(() => setFlash(null), 1800);
                            if (p.kind === "hat") onWear(p.id);
                          }
                        }}
                        className="mt-2 rounded-lg bg-[#ff3fd1] px-2 py-1.5 text-sm font-black text-black disabled:bg-white/10 disabled:text-white/40"
                      >
                        🎟️ {p.cost}
                      </button>
                    )}
                    {flash === p.id && <div className="mt-1 text-center text-xs font-bold text-[#7cff6b]">Yours! {p.kind === "hat" ? "You're wearing it." : "Look at the shelf."}</div>}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="text-xs text-white/55 sm:col-span-2">
                {board?.live ? "Live, for everybody in the Vibe Verse." : "Showing this device's wall (the arcade is offline)."} Gold is you.
              </div>
              {ARCADE_GAMES.map((g) => {
                const b = board?.games[g.key];
                return (
                  <div key={g.key} className="rounded-2xl border border-white/10 bg-white/5 p-3">
                    <div className="mb-1 text-sm font-black uppercase tracking-[0.18em] text-[#38e8ff]">{g.title}</div>
                    <ol className="font-mono text-sm">
                      {(b?.top ?? []).map((r, i) => (
                        <li key={i} className={`flex justify-between ${r.mine ? "text-[#ffe14d]" : r.house ? "text-white/45" : ""}`}>
                          <span>{i + 1}. {r.initials}</span>
                          <span className="tabular-nums">{formatScore(g, r.score)}</span>
                        </li>
                      ))}
                    </ol>
                    <div className="mt-1 text-xs text-[#ff3fd1]">
                      {b?.today ? `Today's champ: ${b.today.initials} ${formatScore(g, b.today.score)}` : "Nobody has set today's score yet."}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
