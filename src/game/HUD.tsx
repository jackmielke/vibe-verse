import { useGame } from "./store";
import { input } from "./input";


export function HUD() {
  const energy = useGame((s) => s.energy);
  const biomass = useGame((s) => s.biomass);
  const need = useGame((s) => s.biomassNeeded);
  const gen = useGame((s) => s.generation);
  const traits = useGame((s) => s.traits);
  const kind = useGame((s) => s.kind);
  const species = useGame((s) => s.species);
  const tod = useGame((s) => s.timeOfDay);
  const message = useGame((s) => s.message);
  const openEvolve = useGame((s) => s.openEvolve);
  const maxE = 150 + traits.size * 30;
  const canEvolve = biomass >= need;

  const isDay = tod > 0.2 && tod < 0.8;

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-4 font-mono text-sm text-white">
      <div className="flex items-start justify-between gap-4">
        <div className="rounded-lg border border-white/20 bg-black/50 p-3 backdrop-blur-sm">
          <div className="text-xs uppercase tracking-widest text-emerald-300">Generation {gen}</div>
          <div className="mt-1 text-base font-bold">{kind === "plant" ? "🌱 Plant" : "🦊 Animal"}</div>
          <div className="mt-2 w-48">
            <div className="flex justify-between text-[10px] uppercase">
              <span>Energy</span>
              <span>{Math.floor(energy)}/{Math.floor(maxE)}</span>
            </div>
            <div className="h-2 rounded bg-white/10">
              <div className="h-2 rounded bg-amber-400 transition-all" style={{ width: `${(energy / maxE) * 100}%` }} />
            </div>
          </div>
          <div className="mt-2 w-48">
            <div className="flex justify-between text-[10px] uppercase">
              <span>Biomass</span>
              <span>{Math.floor(biomass)}/{need}</span>
            </div>
            <div className="h-2 rounded bg-white/10">
              <div className="h-2 rounded bg-emerald-400 transition-all" style={{ width: `${Math.min(100, (biomass / need) * 100)}%` }} />
          </div>
          <button
            onClick={openEvolve}
            disabled={!canEvolve}
            className={`pointer-events-auto mt-3 w-48 rounded-md px-3 py-2 text-xs font-black uppercase tracking-widest transition ${
              canEvolve
                ? "animate-pulse bg-emerald-400 text-emerald-950 hover:bg-emerald-300"
                : "cursor-not-allowed bg-white/10 text-white/40"
            }`}
          >
            {canEvolve ? "⚡ Evolve Now" : `Evolve at ${need}`}
          </button>
        </div>
        </div>

        <div className="rounded-lg border border-white/20 bg-black/50 p-3 text-right backdrop-blur-sm">
          <div className="text-xs uppercase tracking-widest text-amber-300">{isDay ? "☀ Day" : "🌙 Night"}</div>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
            <span className="text-white/60">Size</span><span>{traits.size.toFixed(2)}</span>
            <span className="text-white/60">Defense</span><span>{traits.defense}</span>
            {kind === "animal" && (
              <>
                <span className="text-white/60">Speed</span><span>{traits.speed.toFixed(1)}</span>
                <span className="text-white/60">Sight</span><span>{traits.sight.toFixed(0)}</span>
                <span className="text-white/60">Carnivore</span><span>{(traits.carnivore * 100).toFixed(0)}%</span>
              </>
            )}
            {kind === "plant" && (
              <>
                <span className="text-white/60">Leaves</span><span>{traits.leaves}</span>
                <span className="text-white/60">Roots</span><span>{traits.roots}</span>
                <span className="text-white/60">Spread</span><span>{traits.spread}</span>
              </>
            )}
            <span className="text-white/60">Heat</span><span>{traits.heatResist}</span>
            <span className="text-white/60">Cold</span><span>{traits.coldResist}</span>
          </div>
        </div>
      </div>

      <div className="mx-auto mb-40 max-w-[90%] rounded-lg border border-white/20 bg-black/50 px-3 py-2 text-center text-[11px] backdrop-blur-sm sm:mb-0 sm:text-sm">
        {species === "dragon"
          ? "Drag to move. Tap 🔥 (or SPACE) to breathe fire."
          : kind === "animal"
            ? "Drag the joystick to move. Tan = food, Red = predators, Purple = APEX."
            : "Rooted. Evolve Seed Dispersal so grazers spread you instead of killing you."}
        {message && <span className="ml-2 text-emerald-300">— {message}</span>}
      </div>

      {species === "dragon" && (
        <button
          onPointerDown={(e) => {
            e.preventDefault();
            input.fire = true;
          }}
          className="pointer-events-auto absolute bottom-8 right-8 flex h-20 w-20 select-none items-center justify-center rounded-full border-2 border-orange-400/60 bg-gradient-to-br from-orange-500 to-red-600 text-3xl font-black text-white shadow-lg shadow-orange-900/50 active:scale-95"
          aria-label="Breathe fire"
        >
          🔥
        </button>
      )}
    </div>
  );
}
