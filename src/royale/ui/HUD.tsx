/**
 * DROP ZERO — HUD. STUB: replaced by the HUD author.
 */
import type { Engine } from "../engine/core";

export default function HUD({ engine, locked }: { engine: Engine; locked: boolean }) {
  void engine;
  if (!locked) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20 select-none">
      <div className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/80" />
    </div>
  );
}
