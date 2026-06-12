import { useState } from "react";
import { Link } from "react-router-dom";
import { useGame } from "./store";
import type { Biome, Kind } from "./types";

export function StartScreen() {
  const start = useGame((s) => s.start);
  const [kind, setKind] = useState<Kind>("animal");
  const [biome, setBiome] = useState<Biome>("grassland");

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-gradient-to-br from-emerald-950 via-stone-900 to-amber-950 p-6">
      <div className="w-full max-w-2xl rounded-2xl border border-emerald-500/20 bg-black/60 p-8 backdrop-blur-md">
        <h1 className="text-center text-5xl font-black tracking-tight text-emerald-300">EVOLVE</h1>
        <p className="mt-2 text-center text-sm uppercase tracking-[0.3em] text-amber-300/70">A 3D evolution simulator</p>

        <div className="mt-8">
          <div className="mb-2 text-xs uppercase tracking-widest text-white/60">Choose your kingdom</div>
          <div className="grid grid-cols-2 gap-3">
            {(["plant", "animal"] as Kind[]).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`rounded-xl border-2 p-5 text-left transition ${
                  kind === k
                    ? "border-emerald-400 bg-emerald-400/10"
                    : "border-white/10 bg-white/5 hover:border-white/30"
                }`}
              >
                <div className="text-3xl">{k === "plant" ? "🌱" : "🦊"}</div>
                <div className="mt-1 text-lg font-bold capitalize text-white">{k}</div>
                <div className="text-xs text-white/60">
                  {k === "plant"
                    ? "Stationary. Photosynthesize. Grow roots, leaves, thorns."
                    : "Mobile. Hunt or graze. Develop speed, fangs, fur."}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6">
          <div className="mb-2 text-xs uppercase tracking-widest text-white/60">Starting biome</div>
          <div className="grid grid-cols-3 gap-3">
            {(
              [
                { id: "forest" as Biome, label: "Forest", hint: "Rich, cold", emoji: "🌲" },
                { id: "grassland" as Biome, label: "Grassland", hint: "Balanced", emoji: "🌾" },
                { id: "desert" as Biome, label: "Desert", hint: "Harsh, hot", emoji: "🏜" },
              ]
            ).map((b) => (
              <button
                key={b.id}
                onClick={() => setBiome(b.id)}
                className={`rounded-xl border-2 p-3 text-center transition ${
                  biome === b.id
                    ? "border-amber-400 bg-amber-400/10"
                    : "border-white/10 bg-white/5 hover:border-white/30"
                }`}
              >
                <div className="text-2xl">{b.emoji}</div>
                <div className="text-sm font-semibold text-white">{b.label}</div>
                <div className="text-[10px] text-white/50">{b.hint}</div>
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={() => start(kind, biome)}
          className="mt-8 w-full rounded-xl bg-emerald-500 px-6 py-4 text-lg font-black uppercase tracking-widest text-emerald-950 transition hover:bg-emerald-400"
        >
          Begin Evolution →
        </button>
        <Link
          to="/bestiary"
          className="mt-3 block w-full rounded-xl border border-white/15 bg-white/5 px-6 py-3 text-center text-sm font-semibold uppercase tracking-widest text-white/80 transition hover:border-emerald-400/50 hover:bg-emerald-400/10 hover:text-emerald-200"
        >
          📖 Browse Bestiary
        </Link>
      </div>
    </div>
  );
}

export function EvolveModal() {
  const mutations = useGame((s) => s.mutations);
  const choose = useGame((s) => s.chooseMutation);
  const gen = useGame((s) => s.generation);
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-3xl rounded-2xl border border-emerald-500/30 bg-stone-950 p-8">
        <div className="text-center text-xs uppercase tracking-[0.3em] text-amber-300">Generation {gen} → {gen + 1}</div>
        <h2 className="mt-2 text-center text-4xl font-black text-emerald-300">EVOLVE</h2>
        <p className="mt-2 text-center text-sm text-white/60">Choose one mutation to pass to your offspring.</p>
        <div className="mt-6 grid gap-3 md:grid-cols-3 sm:grid-cols-2 max-h-[60vh] overflow-y-auto pr-1">
          {mutations.map((m) => (
            <button
              key={m.id}
              onClick={() => choose(m)}
              className="group rounded-xl border-2 border-white/10 bg-white/5 p-5 text-left transition hover:border-emerald-400 hover:bg-emerald-400/10"
            >
              <div className="text-lg font-bold text-emerald-300 group-hover:text-emerald-200">{m.name}</div>
              <p className="mt-2 text-sm text-white/70">{m.desc}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function GameOver() {
  const reset = useGame((s) => s.reset);
  const gen = useGame((s) => s.generation);
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/80">
      <div className="rounded-2xl border border-red-500/40 bg-stone-950 p-10 text-center">
        <h2 className="text-5xl font-black text-red-400">EXTINCT</h2>
        <p className="mt-3 text-white/70">Your lineage ended at generation {gen}.</p>
        <button
          onClick={reset}
          className="mt-6 rounded-xl bg-emerald-500 px-6 py-3 font-bold uppercase tracking-widest text-emerald-950 hover:bg-emerald-400"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
