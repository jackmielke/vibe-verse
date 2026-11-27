import { payoutFor, type RaceUi } from "@/city/kartRace";

/**
 * KartRaceHud — the Vibe Kart GP's board and its race readout.
 *
 * The board opens at the kiosk on the plaza: pick a stake (or race for
 * free) and go. During a race it is a lap counter, your place, the clock,
 * and a big 3, 2, 1, GO over the grid. Afterwards, the result card.
 */
const BETS = [0, 10, 25, 50, 100];

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
};
const ordinal = (n: number) => (n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);

export function KartRaceHud({
  ui,
  lobby,
  balance,
  onStart,
  onClose,
}: {
  ui: RaceUi | null;
  lobby: boolean;
  balance: number;
  onStart: (bet: number) => void;
  onClose: () => void;
}) {
  return (
    <>
      {lobby && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
          <div className="w-full max-w-sm rounded-3xl border-2 border-cyan-300/70 bg-[#0d0820]/95 p-5 text-white shadow-[0_0_40px_rgba(56,232,255,0.4)]">
            <div className="text-center text-4xl">🏁</div>
            <h2 className="mt-1 text-center text-xl font-black tracking-wide">VIBE KART GP</h2>
            <p className="mt-1 text-center text-sm text-white/70">
              Three laps of real city streets against Mad Mort, Linda and Vibey. Drive through every glowing gate. Traffic does not stop for you.
            </p>
            {ui?.best ? <p className="mt-2 text-center text-xs text-cyan-200">Your best: {fmt(ui.best)}</p> : null}
            <div className="mt-4 text-xs font-bold uppercase tracking-widest text-white/50">Your stake</div>
            <div className="mt-2 grid grid-cols-5 gap-2">
              {BETS.map((b) => {
                const can = b <= balance;
                return (
                  <button
                    key={b}
                    disabled={!can}
                    onClick={() => onStart(b)}
                    className="rounded-xl border border-white/15 bg-white/5 py-2 text-sm font-bold hover:border-cyan-300 hover:bg-cyan-400/15 disabled:opacity-30"
                  >
                    {b === 0 ? "Free" : `${b} ✦`}
                  </button>
                );
              })}
            </div>
            <p className="mt-3 text-center text-[11px] text-white/50">
              Win and a stake pays three times over. Second gets it back. Free races still pay a little: {payoutFor(1, 0)} ✦ for a win. Winnings top out at 400 ✦ a day.
            </p>
            <p className="mt-1 text-center text-[11px] text-white/40">You have {Math.max(0, Math.floor(balance))} ✦</p>
            <button onClick={onClose} className="mt-3 w-full rounded-full border border-white/20 py-2 text-sm text-white/70 hover:bg-white/10">
              Not now
            </button>
          </div>
        </div>
      )}

      {ui && (ui.phase === "countdown" || ui.phase === "racing") && (
        <div className="pointer-events-none fixed left-1/2 top-16 z-[60] -translate-x-1/2 text-center text-white" data-kart-race={ui.phase}>
          <div className="flex items-center gap-4 rounded-2xl border border-cyan-300/50 bg-black/55 px-4 py-2 backdrop-blur-md">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-white/50">Lap</div>
              <div className="text-lg font-black">
                {ui.lap}/{ui.laps}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-white/50">Place</div>
              <div className="text-lg font-black text-cyan-200">
                {ordinal(ui.place)}
                <span className="text-xs text-white/50">/{ui.field}</span>
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-white/50">Time</div>
              <div className="font-mono text-lg font-black tabular-nums">{fmt(ui.time)}</div>
            </div>
            {ui.phase === "racing" && (
              <div>
                <div className="text-[10px] uppercase tracking-widest text-white/50">Gate</div>
                <div className="text-lg font-black tabular-nums">{Math.round(ui.nextGateDist)} m</div>
              </div>
            )}
            {ui.bet > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-widest text-white/50">Stake</div>
                <div className="text-lg font-black text-yellow-200">{ui.bet} ✦</div>
              </div>
            )}
          </div>
          {ui.count && (
            <div className="mt-10 text-8xl font-black" style={{ textShadow: "0 0 30px #38e8ff" }}>
              {ui.count}
            </div>
          )}
        </div>
      )}

      {ui?.result && ui.phase === "finished" && (
        <div className="pointer-events-none fixed left-1/2 top-24 z-[60] -translate-x-1/2 rounded-3xl border-2 border-yellow-300/70 bg-black/70 px-8 py-5 text-center text-white backdrop-blur-md" data-kart-result={ui.result.place}>
          <div className="text-5xl">{ui.result.place === 1 ? "🏆" : ui.result.place === 2 ? "🥈" : ui.result.place === 3 ? "🥉" : "🏁"}</div>
          <div className="mt-1 text-2xl font-black">{ordinal(ui.result.place)} place</div>
          <div className="font-mono text-lg">{fmt(ui.result.time)}{ui.result.best ? "  new best!" : ""}</div>
          <div className="mt-1 text-yellow-200">{ui.result.payout > 0 ? `+${ui.result.payout} ✦` : ui.bet > 0 ? `Lost the ${ui.bet} ✦ stake` : ""}</div>
        </div>
      )}
    </>
  );
}
