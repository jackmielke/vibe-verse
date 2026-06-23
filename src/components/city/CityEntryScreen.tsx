/**
 * CityEntryScreen — first-step landing for /city.
 *
 * Big single 3D preview of the currently picked character + a compact
 * name grid to swap. Uses ONE WebGL canvas total (the preview) so we
 * don't blow past the browser's WebGL context limit — there are 50+
 * characters in the roster and rendering a Canvas per card kills the
 * main scene's GL context.
 *
 * Name is pre-filled with a fun auto-name so visitors can just hit
 * "Jet in".
 */
import { useMemo, useState } from "react";
import { CharacterPreview } from "@/island/CharacterPreview";
import type { CharacterOption } from "@/island/characters";
import { generateCharacterName } from "@/lib/character-naming";

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

/**
 * Back-compat shim — still used by City.tsx for the first-time seed.
 * Delegates to the shared character-aware namer so a roll without
 * context still feels like the rest of the app.
 */
export function generateFunName(label?: string): string {
  return generateCharacterName(label);
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
  const [name, setName] = useState<string>(initialName);

  const currentOption = options.find((o) => o.id === picked) ?? options[0];
  const accent = currentOption?.accent ?? ACCENTS[0];

  return (
    <div className="absolute inset-0 z-20 overflow-y-auto bg-gradient-to-b from-[#0a0f1a] via-[#0b1424] to-[#0a0f1a]">
      {/* Subtle neon glow blobs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-32 -left-32 h-96 w-96 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-fuchsia-500/10 blur-3xl" />
      </div>

      <div className="relative mx-auto flex max-w-5xl flex-col items-center px-4 py-8">
        <div className="mb-2 text-[11px] uppercase tracking-[0.4em] text-cyan-300/80">
          Welcome to Vibe City
        </div>
        <h1 className="font-heading mb-1 text-4xl font-bold tracking-wide text-primary drop-shadow-[0_0_24px_hsl(var(--primary)/0.45)] sm:text-5xl">
          Pick your vibe
        </h1>
        <p className="mb-5 max-w-md text-center text-sm text-muted-foreground">
          We picked one for you — tap any name to swap.
        </p>

        {/* Single shared 3D preview of the picked character */}
        {currentOption && (
          <div
            className={`relative mb-5 h-64 w-full max-w-md overflow-hidden rounded-2xl border border-white/15 bg-gradient-to-br ${accent} shadow-[0_0_40px_rgba(0,0,0,0.4)]`}
          >
            <CharacterPreview character={currentOption} spinning />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/50 to-transparent" />
            <div className="absolute bottom-2 left-0 right-0 text-center text-sm font-medium text-white drop-shadow">
              {currentOption.name}
            </div>
          </div>
        )}

        {/* Name field — pre-filled with a fun auto-name */}
        <div className="mb-5 flex w-full max-w-md flex-col items-center gap-1.5">
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
              onClick={() => setName(generateCharacterName(currentOption?.name))}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-xs text-muted-foreground hover:bg-white/10 hover:text-foreground"
              title="Roll a new fun name"
            >
              🎲
            </button>
          </div>
        </div>

        {/* Character name grid — scrollable, lightweight, no per-card canvas */}
        <div className="mb-6 w-full max-w-3xl">
          <div className="max-h-56 overflow-y-auto rounded-2xl border border-white/10 bg-white/[0.03] p-2 backdrop-blur-sm">
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
              {options.map((c) => {
                const isPicked = c.id === picked;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setPicked(c.id)}
                    className={`truncate rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                      isPicked
                        ? "bg-primary/25 text-primary ring-1 ring-primary/60"
                        : "text-foreground/75 hover:bg-white/10 hover:text-foreground"
                    }`}
                    title={c.name}
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <button
          onClick={() => {
            const cleanName = name.trim() || generateFunName();
            onEnter({ character: currentOption?.id ?? picked, name: cleanName });
          }}
          className="rounded-full bg-primary px-8 py-3 font-heading text-sm font-bold uppercase tracking-[0.25em] text-primary-foreground shadow-[0_0_32px_hsl(var(--primary)/0.55)] transition-opacity hover:opacity-90"
        >
          ✨ Jet in{currentOption ? ` as ${currentOption.name}` : ""}
        </button>

        <div className="mt-4 text-[11px] font-mono text-muted-foreground/80">
          WASD / arrows — move · Shift — run · Space — jetpack · drag — look
        </div>
      </div>
    </div>
  );
}
