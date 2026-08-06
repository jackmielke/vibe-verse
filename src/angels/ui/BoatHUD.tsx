/**
 * The hydroplane's instruments.
 *
 * Deliberately nothing like the jet's. A fighter HUD exists to keep a pilot's
 * eyes outside while it tells them about a three-dimensional problem; a race
 * boat has a two-dimensional problem and four numbers worth knowing — how fast,
 * which lap, what place, and what that lap took. Anything else is a distraction
 * from the only thing on screen that matters, which is the water.
 *
 * The one thing borrowed from the jet is the mechanism: React draws it once and
 * a requestAnimationFrame loop writes through refs, because sixty state updates
 * a second would spend longer in the reconciler than the lake spends rendering.
 */
import { useEffect, useRef } from "react";
import type { Engine } from "../engine/core";
import { RACE_LAPS, type HydroService } from "../play/hydro";

const AMBER = "#ffcc33";

/** Seconds as a lap time. */
function lap(t: number): string {
  if (t <= 0) return "—";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, "0")}` : s.toFixed(1);
}

export default function BoatHUD({ engine, visible }: { engine: Engine; visible: boolean }) {
  const mph = useRef<HTMLSpanElement>(null);
  const lapNo = useRef<HTMLSpanElement>(null);
  const pos = useRef<HTMLSpanElement>(null);
  const cur = useRef<HTMLSpanElement>(null);
  const best = useRef<HTMLSpanElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const warn = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const h = engine.ctx.services.hydro as HydroService | undefined;
      if (!h) return;
      const s = h.state;
      // Miles per hour, because that is the unit every hydroplane record has
      // ever been quoted in and nobody at Seafair has said "metres per second".
      if (mph.current) mph.current.textContent = String(Math.round(s.speed * 2.23694));
      if (lapNo.current) lapNo.current.textContent = `${Math.min(RACE_LAPS, h.laps + 1)}/${RACE_LAPS}`;
      if (pos.current) pos.current.textContent = `${h.place}/${h.field}`;
      if (cur.current) cur.current.textContent = lap(h.lapTime);
      if (best.current) best.current.textContent = lap(h.bestLap);
      if (bar.current) bar.current.style.width = `${Math.round(h.progress.t * 100)}%`;
      if (warn.current) {
        // The blowover warning. `lift` is how close the air under the hull is
        // to winning; showing it is the difference between an accident that
        // feels random and one you can hear coming and back off.
        const near = Math.max(0, (s.lift - 0.42) / 0.58);
        warn.current.style.opacity = String(Math.min(1, near));
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, visible]);

  if (!visible) return null;

  return (
    <>
      <div
        data-angels-hud="boat"
        className="pointer-events-none fixed inset-x-0 z-30 flex justify-center"
        style={{ top: "max(12px, env(safe-area-inset-top))" }}
      >
        <div
          className="overflow-hidden rounded-2xl border border-white/10"
          style={{ background: "rgba(4,10,24,0.62)", backdropFilter: "blur(6px)" }}
        >
          <div className="flex items-stretch divide-x divide-white/10">
            <Cell label="MPH">
              <span ref={mph} className="text-[26px] font-black leading-none text-white">
                0
              </span>
            </Cell>
            <Cell label="Lap">
              <span ref={lapNo} className="text-[20px] font-black leading-none text-amber-200">
                1/{RACE_LAPS}
              </span>
            </Cell>
            <Cell label="Place">
              <span ref={pos} className="text-[20px] font-black leading-none text-amber-200">
                1/7
              </span>
            </Cell>
            <Cell label="This lap">
              <span ref={cur} className="font-mono text-[15px] leading-none text-white/85">
                0.0
              </span>
            </Cell>
            <Cell label="Best">
              <span ref={best} className="font-mono text-[15px] leading-none text-sky-200/80">
                —
              </span>
            </Cell>
          </div>
          {/* Where you are round the oval. A lap counter tells you which lap;
              this tells you how much of it is left, which is the thing you
              actually want to know coming out of the last corner. */}
          <div className="h-[3px] w-full bg-white/10">
            <div ref={bar} className="h-full bg-gradient-to-r from-sky-300 to-amber-300" style={{ width: 0 }} />
          </div>
        </div>
      </div>

      <div
        ref={warn}
        data-angels-hud="blowover"
        className="pointer-events-none fixed inset-x-0 z-30 flex justify-center"
        style={{ opacity: 0, top: "max(96px, calc(env(safe-area-inset-top) + 88px))" }}
      >
        <span
          className="rounded-full px-4 py-1.5 font-mono text-[12px] font-bold uppercase tracking-[0.3em]"
          style={{ background: "rgba(60,10,6,0.8)", color: AMBER }}
        >
          Nose up — ease off
        </span>
      </div>
    </>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-[64px] flex-col items-center gap-1 px-3.5 py-2">
      {children}
      <span className="font-mono text-[8.5px] uppercase tracking-[0.22em] text-sky-300/50">
        {label}
      </span>
    </div>
  );
}
