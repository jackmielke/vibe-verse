/**
 * The landmarks' HUD: the E prompt, the altitude readout on a ride, the
 * Empire State's express elevator, and the binocular mask.
 *
 * It polls the landmarks itself (eight times a second) instead of taking
 * props, so Vibe City's page does not re-render whenever an elevator moves.
 */
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { LandmarkUi, Landmarks } from "./index";

const EMPTY: LandmarkUi = { prompt: null, ride: null, express: null, viewing: false };

export function LandmarkHud({ system, compact }: { system: MutableRefObject<Landmarks | null>; compact?: boolean }) {
  const [ui, setUi] = useState<LandmarkUi>(EMPTY);
  const last = useRef("");
  useEffect(() => {
    const id = window.setInterval(() => {
      const next = system.current?.ui() ?? EMPTY;
      // The express ride needs its progress smooth, which the dial animates
      // itself; everything else only re-renders when it changes.
      const key = JSON.stringify({ ...next, express: next.express ? { up: next.express.up, p: Math.round(next.express.progress * 40) } : null });
      if (key !== last.current) {
        last.current = key;
        setUi(next);
      }
    }, 125);
    return () => window.clearInterval(id);
  }, [system]);

  const act = () => system.current?.act();

  return (
    <>
      {ui.viewing && <Binoculars onClose={act} />}
      {ui.express && <ExpressElevator up={ui.express.up} progress={ui.express.progress} />}
      {ui.ride && (
        <div className="pointer-events-none fixed left-1/2 top-20 z-30 -translate-x-1/2 rounded-full border border-white/15 bg-black/55 px-4 py-1.5 text-sm text-white backdrop-blur">
          <span className="mr-2">🛗 {ui.ride.name}</span>
          <span className="font-mono tabular-nums text-amber-300">
            {ui.ride.up ? "▲" : "▼"} {ui.ride.altitude} m
          </span>
        </div>
      )}
      {ui.prompt && !ui.express && (
        <button
          onClick={(e) => {
            act();
            e.currentTarget.blur();
          }}
          className={`fixed left-1/2 z-40 -translate-x-1/2 rounded-full border border-amber-300/40 bg-black/65 px-5 py-2.5 text-sm font-medium text-white shadow-lg backdrop-blur transition hover:bg-black/80 ${
            ui.viewing ? "bottom-8" : compact ? "bottom-[19rem]" : "bottom-28"
          }`}
          data-testid="landmark-prompt"
        >
          {ui.prompt.emoji} {ui.prompt.label}
          {!compact && <span className="ml-2 rounded bg-white/15 px-1.5 py-0.5 font-mono text-xs text-amber-200">E</span>}
        </button>
      )}
    </>
  );
}

/** Two overlapping circles of view, the rest dark: looking through a tower viewer. */
function Binoculars({ onClose }: { onClose: () => void }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-30" data-testid="landmark-binoculars">
      <div
        className="absolute inset-0"
        style={{
          WebkitMaskImage:
            "radial-gradient(circle at 36% 50%, transparent 0, transparent 27vmin, #000 28.5vmin), radial-gradient(circle at 64% 50%, transparent 0, transparent 27vmin, #000 28.5vmin)",
          WebkitMaskComposite: "source-in",
          maskImage:
            "radial-gradient(circle at 36% 50%, transparent 0, transparent 27vmin, #000 28.5vmin), radial-gradient(circle at 64% 50%, transparent 0, transparent 27vmin, #000 28.5vmin)",
          maskComposite: "intersect",
          backgroundColor: "#050505",
        }}
      />
      <div className="absolute left-1/2 top-6 -translate-x-1/2 rounded-full bg-black/60 px-4 py-1 text-xs tracking-wide text-white/80">
        Drag to look around
      </div>
      <button
        onClick={onClose}
        className="pointer-events-auto absolute right-5 top-5 rounded-full bg-white/15 px-3 py-1.5 text-sm text-white backdrop-blur hover:bg-white/25"
      >
        ✕
      </button>
    </div>
  );
}

/**
 * The Empire State's express car: brass doors, and the half-moon floor dial
 * over them sweeping from 1 to 86. Floors are a smoothstep of the ride's
 * progress, so it pulls away and slows into the top like an elevator.
 */
function ExpressElevator({ up, progress }: { up: boolean; progress: number }) {
  const [p, setP] = useState(progress);
  const target = useRef(progress);
  target.current = progress;
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setP((v) => v + (target.current - v) * 0.25);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const e = p * p * (3 - 2 * p);
  const floor = up ? Math.max(1, Math.round(1 + e * 85)) : Math.max(1, Math.round(86 - e * 85));
  // Doors: shut through the middle, open in the last 12 percent.
  const open = Math.max(0, Math.min(1, (p - 0.86) / 0.12));
  const angle = -90 + ((floor - 1) / 85) * 180;
  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center" style={{ background: `rgba(16,9,4,${0.96 - open * 0.9})` }} data-testid="landmark-express">
      <div className="relative flex h-[78vh] w-[min(88vw,560px)] flex-col items-center" style={{ opacity: 1 - open }}>
        <div className="relative mt-2 h-[22vh] w-[44vh] max-w-full overflow-hidden">
          <div className="absolute inset-x-0 bottom-0 mx-auto h-[22vh] w-[44vh] max-w-full rounded-t-full border-[6px] border-b-0 border-[#c99a3a] bg-[#1b120b]" />
          {Array.from({ length: 11 }, (_, i) => {
            const a = -90 + (i / 10) * 180;
            return (
              <div key={i} className="absolute bottom-0 left-1/2 h-[19vh] origin-bottom" style={{ transform: `translateX(-50%) rotate(${a}deg)` }}>
                <div className="h-3 w-1 bg-[#f6d27a]" />
              </div>
            );
          })}
          <div className="absolute bottom-0 left-1/2 h-[18vh] w-1.5 origin-bottom rounded bg-[#f6d27a] shadow-[0_0_12px_#f6d27a]" style={{ transform: `translateX(-50%) rotate(${angle}deg)` }} />
          <div className="absolute bottom-0 left-1/2 h-5 w-5 -translate-x-1/2 translate-y-1/2 rounded-full bg-[#c99a3a]" />
        </div>
        <div className="mt-3 font-serif text-5xl font-bold tabular-nums text-[#f6d27a] drop-shadow">{floor}</div>
        <div className="mt-1 text-xs uppercase tracking-[0.35em] text-[#e9e2cf]/70">{up ? "Express to the Observatory" : "Down to the Lobby"}</div>
        <div className="relative mt-6 flex w-full flex-1 overflow-hidden rounded-sm border-4 border-[#c99a3a]">
          {[0, 1].map((side) => (
            <div
              key={side}
              className="h-full w-1/2 border-x border-[#7a5a22]"
              style={{
                background: "linear-gradient(90deg, #8a6420, #e7c071 45%, #b8892f 55%, #7a5a22)",
                transform: `translateX(${(side ? 1 : -1) * open * 100}%)`,
              }}
            >
              <div className="mx-auto mt-[18%] h-[40%] w-[60%] border-2 border-[#5a3e10]/60" style={{ background: "repeating-linear-gradient(45deg, transparent 0 10px, rgba(90,62,16,0.35) 10px 12px)" }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
