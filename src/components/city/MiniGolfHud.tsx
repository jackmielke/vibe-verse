import type { GolfUi } from "@/city/miniGolf";

/**
 * MiniGolfHud — Vibe Links' scorecard, power meter and the phone's PUTT
 * button. The button sets `holdRef` while it is pressed, which the page
 * reads as "winding up", exactly like holding W.
 */
export function MiniGolfHud({
  ui,
  touch,
  onHold,
  onQuit,
  onCloseCard,
}: {
  ui: GolfUi | null;
  touch: boolean;
  onHold: (on: boolean) => void;
  onQuit: () => void;
  onCloseCard: () => void;
}) {
  if (!ui) return null;
  const diff = (n: number) => (n === 0 ? "E" : n > 0 ? `+${n}` : String(n));
  return (
    <>
      {ui.playing && (
        <div className="pointer-events-none fixed left-1/2 top-16 z-[60] -translate-x-1/2 text-white" data-golf-hole={ui.hole}>
          <div className="pointer-events-auto flex items-center gap-4 rounded-2xl border border-emerald-300/60 bg-black/55 px-4 py-2 backdrop-blur-md">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-white/50">Hole {ui.hole}/{ui.holes}</div>
              <div className="text-base font-black">{ui.name}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-white/50">Par</div>
              <div className="text-lg font-black">{ui.par}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-white/50">Strokes</div>
              <div className="text-lg font-black text-emerald-200">{ui.strokes}</div>
            </div>
            <button onClick={onQuit} className="rounded-full border border-white/25 px-3 py-1 text-xs text-white/80 hover:bg-white/10">
              Leave
            </button>
          </div>
          {!ui.rolling && (
            <div className="mx-auto mt-2 w-64">
              <div className="h-3 overflow-hidden rounded-full border border-white/30 bg-black/50">
                <div className="h-full rounded-full" style={{ width: `${Math.round(ui.power * 100)}%`, background: `hsl(${120 - ui.power * 120} 90% 55%)` }} />
              </div>
              <div className="mt-1 text-center text-[11px] text-white/70">
                {touch ? "Stick to aim, hold PUTT and let go" : "A / D to aim, hold W and let go to putt"}
              </div>
            </div>
          )}
        </div>
      )}
      {ui.playing && touch && !ui.rolling && (
        <button
          className="fixed bottom-28 right-6 z-[60] h-24 w-24 select-none rounded-full border-4 border-white/80 bg-emerald-500/80 text-lg font-black text-white shadow-xl active:scale-95"
          style={{ touchAction: "none" }}
          onPointerDown={(e) => {
            e.preventDefault();
            onHold(true);
          }}
          onPointerUp={() => onHold(false)}
          onPointerCancel={() => onHold(false)}
          onPointerLeave={() => onHold(false)}
        >
          PUTT
        </button>
      )}
      {ui.done && !ui.playing && (
        <div className="fixed left-1/2 top-20 z-[60] w-[min(92vw,420px)] -translate-x-1/2 rounded-3xl border-2 border-emerald-300/70 bg-[#0b2414]/90 p-5 text-center text-white backdrop-blur-md" data-golf-done={ui.done.total}>
          <div className="text-4xl">⛳</div>
          <div className="mt-1 text-xl font-black">Vibe Links scorecard</div>
          <div className="mt-3 flex justify-center gap-1.5">
            {ui.card.map((s, i) => (
              <div key={i} className="w-10 rounded-lg bg-white/10 py-1">
                <div className="text-[10px] text-white/50">{ui.holes - ui.card.length + i + 1}</div>
                <div className="font-black">{s}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 text-lg font-black">
            {ui.done.total} strokes, {diff(ui.done.total - ui.done.par)}
          </div>
          <div className="text-yellow-200">+{ui.done.coins} ✦</div>
          <button onClick={onCloseCard} className="mt-3 rounded-full border border-white/25 px-5 py-1.5 text-sm hover:bg-white/10">
            Nice
          </button>
        </div>
      )}
    </>
  );
}
