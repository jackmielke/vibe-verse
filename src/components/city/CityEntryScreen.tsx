/**
 * CityEntryScreen — first-step landing for /city.
 *
 * Two-panel "pick a character + tweak your name" screen, modelled on
 * the IslandExplorer character selector. Everything is pre-filled so
 * a first-time visitor can just hit "Jet in" — no required typing.
 *
 *  - Character: auto-selected (defaults to the last picked one in
 *    localStorage, otherwise a random one from the roster).
 *  - Name: auto-generated fun name (e.g. "Neon Otter 042") if the
 *    visitor has never set a display name; otherwise their stored name.
 *
 * Uses the same 3D <CharacterPreview /> cards as the island selector.
 */
import { useMemo, useState } from "react";
import { CharacterPreview } from "@/island/CharacterPreview";
import type { CharacterOption } from "@/island/characters";

type CityChar = { name: string; url: string };

const ACCENTS = [
  "from-emerald-500/30 to-teal-700/30",
  "from-sky-400/30 to-indigo-700/30",
  "from-orange-400/30 to-rose-600/30",
  "from-fuchsia-500/30 to-violet-700/30",
  "from-amber-400/30 to-rose-500/30",
  "from-cyan-400/30 to-blue-700/30",
  "from-lime-400/30 to-emerald-700/30",
  "from-pink-400/30 to-purple-700/30",
];

function prettyName(raw: string): string {
  // "BlueSoldier_Male" -> "Blue Soldier"
  return raw.replace(/_/g, " ").replace(/\bMale\b|\bFemale\b/g, "").trim();
}

function toOption(c: CityChar, i: number): CharacterOption {
  return {
    id: c.name,
    name: prettyName(c.name) || c.name,
    description: "",
    url: c.url,
    scale: 1.0,
    yOffset: 0,
    previewDistance: 2.6,
    previewHeight: 1.55,
    previewTarget: 1.3,
    accent: ACCENTS[i % ACCENTS.length],
  };
}

const FUN_ADJ = [
  "Neon", "Cosmic", "Mellow", "Turbo", "Glitchy", "Lucid", "Vibey", "Plush",
  "Disco", "Solar", "Lunar", "Pixel", "Velvet", "Frosty", "Sparkly", "Drifty",
  "Cyber", "Holo", "Zesty", "Cozy", "Snappy", "Breezy", "Funky", "Radiant",
];
const FUN_NOUN = [
  "Otter", "Comet", "Jellyfish", "Falcon", "Beetle", "Sprout", "Phantom",
  "Pixie", "Mango", "Pegasus", "Koi", "Echo", "Rover", "Drifter", "Glider",
  "Sparrow", "Lynx", "Maple", "Quasar", "Nebula", "Pebble", "Lantern",
];

export function generateFunName(): string {
  const a = FUN_ADJ[Math.floor(Math.random() * FUN_ADJ.length)];
  const n = FUN_NOUN[Math.floor(Math.random() * FUN_NOUN.length)];
  const num = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  return `${a} ${n} ${num}`;
}

interface Props {
  characters: CityChar[];
  initialCharacter: string;
  initialName: string;
  onEnter: (pick: { character: string; name: string }) => void;
}

export default function CityEntryScreen({
  characters,
  initialCharacter,
  initialName,
  onEnter,
}: Props) {
  const options = useMemo(() => characters.map((c, i) => toOption(c, i)), [characters]);
  const [picked, setPicked] = useState<string>(initialCharacter);
  const [hovered, setHovered] = useState<string | null>(null);
  const [name, setName] = useState<string>(initialName);

  const currentOption = options.find((o) => o.id === picked) ?? options[0];

  return (
    <div className="absolute inset-0 z-20 overflow-y-auto bg-gradient-to-b from-[#0a0f1a] via-[#0b1424] to-[#0a0f1a]">
      {/* Subtle neon glow blobs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-32 -left-32 h-96 w-96 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-fuchsia-500/10 blur-3xl" />
        <div className="absolute top-1/3 right-1/4 h-72 w-72 rounded-full bg-emerald-400/10 blur-3xl" />
      </div>

      <div className="relative mx-auto flex max-w-6xl flex-col items-center px-4 py-10">
        <div className="mb-2 text-[11px] uppercase tracking-[0.4em] text-cyan-300/80">
          Welcome to Vibe City
        </div>
        <h1 className="font-heading mb-2 text-4xl font-bold tracking-wide text-primary drop-shadow-[0_0_24px_hsl(var(--primary)/0.45)] sm:text-5xl">
          Pick your vibe
        </h1>
        <p className="mb-6 max-w-md text-center text-sm text-muted-foreground">
          We picked one for you — tap any card to swap. Hover to make them spin.
        </p>

        {/* Name field — pre-filled with a fun auto-name */}
        <div className="mb-7 flex w-full max-w-md flex-col items-center gap-1.5">
          <label className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Your name in the city
          </label>
          <div className="flex w-full items-center gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 32))}
              maxLength={32}
              className="flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-center text-base text-foreground backdrop-blur-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/40"
              placeholder="Your name"
            />
            <button
              type="button"
              onClick={() => setName(generateFunName())}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-xs text-muted-foreground hover:bg-white/10 hover:text-foreground"
              title="Roll a new fun name"
            >
              🎲
            </button>
          </div>
        </div>

        {/* Character grid */}
        <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {options.map((c) => {
            const isPicked = c.id === picked;
            return (
              <button
                key={c.id}
                type="button"
                onMouseEnter={() => setHovered(c.id)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => setPicked(c.id)}
                className={`group relative flex flex-col items-stretch overflow-hidden rounded-2xl border bg-white/5 p-2 text-left backdrop-blur-sm transition-all ${
                  isPicked
                    ? "scale-[1.02] border-primary/80 bg-primary/10 shadow-[0_0_32px_hsl(var(--primary)/0.4)]"
                    : "border-white/10 hover:border-white/40 hover:bg-white/10"
                }`}
              >
                <div
                  className={`relative mb-2 h-40 w-full overflow-hidden rounded-xl bg-gradient-to-br ${c.accent} ring-1 ring-white/10 sm:h-44`}
                >
                  <CharacterPreview character={c} spinning={hovered === c.id || isPicked} />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/40 to-transparent" />
                  {isPicked && (
                    <div className="absolute right-2 top-2 rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary-foreground shadow-lg">
                      Picked
                    </div>
                  )}
                </div>
                <div className="px-1 pb-1 text-sm font-medium text-foreground">
                  {c.name}
                </div>
              </button>
            );
          })}
        </div>

        {/* Enter button */}
        <button
          onClick={() => {
            const cleanName = name.trim() || generateFunName();
            onEnter({ character: currentOption.id, name: cleanName });
          }}
          className="mt-8 rounded-full bg-primary px-8 py-3 font-heading text-sm font-bold uppercase tracking-[0.25em] text-primary-foreground shadow-[0_0_32px_hsl(var(--primary)/0.55)] transition-opacity hover:opacity-90"
        >
          ✨ Jet in as {currentOption.name}
        </button>

        <div className="mt-4 text-[11px] font-mono text-muted-foreground/80">
          WASD / arrows — move · Shift — run · Space — jetpack · drag — look
        </div>
      </div>
    </div>
  );
}
