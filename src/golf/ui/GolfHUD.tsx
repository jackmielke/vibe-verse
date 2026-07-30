/**
 * Vibe Golf — HUD.
 *
 * Scorecard, power meter, ball picker. Phone-first: thumb-reachable, nothing
 * in the way of the drag gesture.
 *
 * STUB: placeholder. Replaced by the dedicated module author.
 */
import { useEffect, useState } from "react";
import type { GolfEngine } from "../engine/core";

export default function GolfHUD({ engine }: { engine: GolfEngine }) {
  const [hole, setHole] = useState<{ name: string; par: number; index: number } | null>(null);
  const [strokes, setStrokes] = useState(0);
  const [power, setPower] = useState(0);
  const [holed, setHoled] = useState<{ strokes: number; par: number } | null>(null);

  useEffect(() => {
    const offs = [
      engine.on("golf:hole", (p) => {
        const d = p as { hole: { name: string; par: number }; holeIndex: number };
        setHole({ name: d.hole.name, par: d.hole.par, index: d.holeIndex });
        setStrokes(0);
        setHoled(null);
      }),
      engine.on("golf:shot", (p) => setStrokes((p as { strokes: number }).strokes)),
      engine.on("golf:penalty", (p) => setStrokes((p as { strokes: number }).strokes)),
      engine.on("golf:aim", (p) => setPower((p as { power: number }).power)),
      engine.on("golf:holed", (p) => setHoled(p as { strokes: number; par: number })),
    ];
    return () => offs.forEach((f) => f());
  }, [engine]);

  const nextHole = () => {
    engine.ctx.services.course?.next();
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-20 select-none">
      <div className="absolute left-4 top-4 rounded-xl bg-black/40 px-3 py-2 font-mono text-[11px] uppercase tracking-widest text-white/80 backdrop-blur-sm">
        <div className="text-emerald-300">{hole ? `${hole.index + 1}. ${hole.name}` : "—"}</div>
        <div className="mt-0.5 flex gap-3 text-white/60">
          <span>Par {hole?.par ?? "-"}</span>
          <span>Strokes {strokes}</span>
        </div>
      </div>

      {power > 0 && (
        <div className="absolute bottom-8 left-1/2 h-2 w-56 -translate-x-1/2 overflow-hidden rounded-full bg-black/50">
          <div
            className="h-full rounded-full transition-[width] duration-75"
            style={{
              width: `${Math.round(power * 100)}%`,
              background: `linear-gradient(90deg, #34d399, #fbbf24 60%, #fb7185)`,
            }}
          />
        </div>
      )}

      {holed && (
        <div className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="rounded-2xl bg-[#0d3b52] px-8 py-6 text-center shadow-2xl">
            <div className="text-4xl font-black text-emerald-300">
              {scoreName(holed.strokes, holed.par)}
            </div>
            <div className="mt-1 font-mono text-xs uppercase tracking-widest text-white/60">
              {holed.strokes} strokes · par {holed.par}
            </div>
            <button
              onClick={nextHole}
              className="mt-5 rounded-full bg-emerald-400 px-8 py-3 text-xs font-bold uppercase tracking-widest text-slate-900 active:scale-95"
            >
              Next hole
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function scoreName(strokes: number, par: number): string {
  const d = strokes - par;
  if (strokes === 1) return "Hole in one!";
  if (d <= -3) return "Albatross";
  if (d === -2) return "Eagle";
  if (d === -1) return "Birdie";
  if (d === 0) return "Par";
  if (d === 1) return "Bogey";
  if (d === 2) return "Double bogey";
  return `+${d}`;
}
