import { Link, useNavigate } from "react-router-dom";
import { Canvas } from "@react-three/fiber";
import { useMemo, type ReactElement } from "react";
import * as THREE from "three";
import {
  AnimalCreature,
  PlantCreature,
  PredatorCreature,
  ApexCreature,
  HerbivoreCreature,
  DragonCreature,
  GoatCreature,
} from "@/game/Creature";
import type { Species, Traits } from "@/game/types";
import { useGame } from "@/game/store";

const baseTraits: Traits = {
  size: 1,
  speed: 1,
  sight: 1,
  carnivore: 0.5,
  defense: 0,
  coldResist: 0,
  heatResist: 0,
  color: [0.4, 0.7, 0.45],
  roots: 0,
  leaves: 0,
  spread: 0,
  pack: 0,
};

type Entry = {
  name: string;
  blurb: string;
  tag: string;
  tagColor: string;
  species: Species;
  render: () => ReactElement;
  camY?: number;
  camZ?: number;
};

const entries: Entry[] = [
  {
    name: "Forager",
    species: "forager",
    tag: "Animal",
    tagColor: "bg-emerald-500/20 text-emerald-300 border-emerald-400/30",
    blurb: "The default omnivore. Balanced stats, blinks, breathes, swings a tail.",
    render: () => <AnimalCreature traits={baseTraits} moving isPlayer />,
  },
  {
    name: "Sapling",
    species: "sapling",
    tag: "Plant",
    tagColor: "bg-lime-500/20 text-lime-300 border-lime-400/30",
    blurb: "Stationary photosynthesizer. Sways in the wind, grows thorns when threatened.",
    render: () => <PlantCreature traits={{ ...baseTraits, color: [0.3, 0.8, 0.4], leaves: 3, defense: 2 }} />,
    camY: 1.2,
    camZ: 4,
  },
  {
    name: "Stalker Wolf",
    species: "stalker",
    tag: "Predator",
    tagColor: "bg-red-500/20 text-red-300 border-red-400/30",
    blurb: "Lean, muscular, amber-eyed. Hunts in straight lines with bared fangs.",
    render: () => <PredatorCreature moving />,
  },
  {
    name: "Grizzly",
    species: "grizzly",
    tag: "Apex",
    tagColor: "bg-amber-500/20 text-amber-300 border-amber-400/30",
    blurb: "Massive brown bear with the iconic shoulder hump. Will charge anything that moves.",
    render: () => <ApexCreature moving />,
    camY: 1.8,
    camZ: 6,
  },
  {
    name: "Fawn",
    species: "fawn",
    tag: "Herbivore",
    tagColor: "bg-sky-500/20 text-sky-300 border-sky-400/30",
    blurb: "Soft, deer-like, big innocent eyes. Eats plants and flees from everything.",
    render: () => <HerbivoreCreature moving />,
  },
  {
    name: "Dragon",
    species: "dragon",
    tag: "Mythic",
    tagColor: "bg-orange-500/20 text-orange-300 border-orange-400/30",
    blurb: "Winged, scaled, with a glowing throat. Flaps in place, ready to scorch.",
    render: () => <DragonCreature moving />,
    camY: 1.6,
    camZ: 5.5,
  },
  {
    name: "Mountain Goat",
    species: "goat",
    tag: "Herbivore",
    tagColor: "bg-stone-500/20 text-stone-200 border-stone-400/30",
    blurb: "Sturdy and horned. Same role as the fawn, but built for cliffs and confrontation.",
    render: () => <GoatCreature moving />,
  },
  {
    name: "Armored Beast",
    species: "armored",
    tag: "Animal · Variant",
    tagColor: "bg-violet-500/20 text-violet-200 border-violet-400/30",
    blurb: "Same base animal, evolved with thick plates and cold-weather fur.",
    render: () => (
      <AnimalCreature
        traits={{ ...baseTraits, size: 1.3, defense: 4, coldResist: 1, color: [0.45, 0.5, 0.6] }}
        moving
      />
    ),
  },
  {
    name: "Fanged Hunter",
    species: "fanged",
    tag: "Animal · Variant",
    tagColor: "bg-rose-500/20 text-rose-300 border-rose-400/30",
    blurb: "Base animal silhouette pushed full carnivore — fangs out, deeper coloring.",
    render: () => (
      <AnimalCreature
        traits={{ ...baseTraits, carnivore: 1, size: 1.1, color: [0.55, 0.25, 0.25] }}
        moving
        hostile
      />
    ),
  },
  {
    name: "River Otter",
    species: "otter",
    tag: "Swimmer",
    tagColor: "bg-cyan-500/20 text-cyan-200 border-cyan-400/30",
    blurb: "Sleek and water-borne. The only creature that can swim out to the outer islets.",
    render: () => (
      <AnimalCreature
        traits={{ ...baseTraits, size: 0.8, speed: 5, carnivore: 0.6, color: [0.42, 0.28, 0.2] }}
        moving
      />
    ),
  },
];

function Preview({ entry }: { entry: Entry }) {
  const camPos = useMemo<[number, number, number]>(
    () => [3, entry.camY ?? 1.4, entry.camZ ?? 4.5],
    [entry.camY, entry.camZ],
  );
  return (
    <Canvas
      shadows
      camera={{ position: camPos, fov: 38 }}
      gl={{ antialias: true }}
      onCreated={({ scene }) => {
        scene.background = new THREE.Color("#0b0f0d");
        scene.fog = new THREE.Fog("#0b0f0d", 8, 18);
      }}
    >
      <ambientLight intensity={0.55} />
      <directionalLight position={[5, 8, 4]} intensity={1.1} castShadow />
      <directionalLight position={[-4, 3, -2]} intensity={0.35} color="#88aaff" />
      {/* ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[6, 32]} />
        <meshStandardMaterial color="#1a2218" />
      </mesh>
      <group rotation={[0, -0.5, 0]}>{entry.render()}</group>
    </Canvas>
  );
}

export default function Bestiary() {
  const start = useGame((s) => s.start);
  const navigate = useNavigate();
  const playAs = (species: Species) => {
    const kind = species === "sapling" ? "plant" : "animal";
    start(kind, "grassland", species);
    navigate("/evolve");
  };
  return (
    <main className="min-h-screen bg-gradient-to-br from-emerald-950 via-stone-950 to-amber-950 text-white">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-white/10 bg-black/60 px-6 py-4 backdrop-blur-md">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-emerald-300">Bestiary</h1>
          <p className="text-xs uppercase tracking-[0.25em] text-amber-300/70">Pick a creature to play as</p>
        </div>
        <Link
          to="/evolve"
          className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-4 py-2 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-400/20"
        >
          ← Back to game
        </Link>
      </header>

      <section className="mx-auto max-w-7xl px-6 py-8">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((e) => (
            <article
              key={e.name}
              className="overflow-hidden rounded-2xl border border-white/10 bg-black/40 shadow-lg shadow-black/40 transition hover:border-emerald-400/40"
            >
              <div className="h-64 w-full">
                <Preview entry={e} />
              </div>
              <div className="border-t border-white/10 p-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-lg font-bold text-white">{e.name}</h2>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${e.tagColor}`}>
                    {e.tag}
                  </span>
                </div>
                <p className="mt-1.5 text-sm text-white/65">{e.blurb}</p>
                <button
                  onClick={() => playAs(e.species)}
                  className="mt-3 w-full rounded-lg bg-emerald-500 px-4 py-2 text-sm font-black uppercase tracking-widest text-emerald-950 transition hover:bg-emerald-400"
                >
                  ▶ Play as {e.name}
                </button>
              </div>
            </article>
          ))}
        </div>

        <p className="mt-10 text-center text-xs text-white/40">
          Variants share base attributes with their parent species — only the design differs.
        </p>
      </section>
    </main>
  );
}
