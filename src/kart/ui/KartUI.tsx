/**
 * Vibe Kart — the React presentation layer: title screen, character select,
 * in-race HUD, pause and results.
 *
 * STUB — owned by the UI agent, replaced wholesale during the build. Keep the
 * props shape: the page passes the live engine plus boot progress.
 */
import type { KartEngine } from "../engine/core";

export interface KartUIProps {
  engine: KartEngine;
  ready: boolean;
  progress: { stage: string; fraction: number };
}

export default function KartUI({ ready, progress }: KartUIProps) {
  if (ready) return null;
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#07101c]/90">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-amber-200/70">
        {progress.stage}… {Math.round(progress.fraction * 100)}%
      </p>
    </div>
  );
}
