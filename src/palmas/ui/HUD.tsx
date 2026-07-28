/**
 * San Palmas — HUD.
 *
 * Subscribes to engine events and renders the combat overlay. Kept
 * deliberately minimal here; the HUD author replaces this with the full
 * chaos meter / weapon wheel / minimap treatment.
 *
 * STUB: placeholder implementation.
 */
import { useEffect, useState } from "react";
import type { Engine } from "../engine/core";

interface PlayerHudState {
  health: number;
  speed: number;
  altitude: number;
  state: string;
}

export default function HUD({ engine, locked }: { engine: Engine; locked: boolean }) {
  const [p, setP] = useState<PlayerHudState>({ health: 100, speed: 0, altitude: 0, state: "ground" });

  useEffect(() => engine.on("palmas:player", (v) => setP(v as PlayerHudState)), [engine]);

  if (!locked) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 select-none">
      {/* Crosshair */}
      <div className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/80 shadow-[0_0_4px_rgba(0,0,0,0.9)]" />

      {/* Health */}
      <div className="absolute bottom-8 left-8 w-56">
        <div className="mb-1 flex justify-between font-mono text-[10px] uppercase tracking-widest text-white/50">
          <span>Vitals</span>
          <span>{Math.round(p.health)}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-black/50">
          <div
            className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-teal-300 transition-[width] duration-200"
            style={{ width: `${p.health}%` }}
          />
        </div>
      </div>

      {/* Speed / state readout */}
      <div className="absolute bottom-8 right-8 text-right font-mono text-[10px] uppercase tracking-widest text-white/40">
        <div>{p.state}</div>
        <div className="text-2xl font-bold text-white/70">{Math.round(p.speed * 3.6)}<span className="ml-1 text-[10px]">km/h</span></div>
        <div>alt {Math.round(p.altitude)}m</div>
      </div>
    </div>
  );
}
