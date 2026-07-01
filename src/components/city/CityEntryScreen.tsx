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
import { ArrowRight, Check, Copy, Dices, Shuffle } from "lucide-react";
import loginBg from "@/assets/island-explorer/new-login-bg.jpg";

type CityChar = {
  name: string;
  url: string;
  label?: string;
  blurb?: string;
  accent?: string;
};

const ACCENTS = [
  "#44d7a8",
  "#7dc9ff",
  "#f6b05f",
  "#f19adf",
  "#f3df79",
  "#8ce2f0",
  "#a6dc72",
  "#d7a4ff",
];

const FEATURED_CHARACTER_IDS = [
  "Pirate_Anne",
  "Wizard",
  "Ninja_Female",
  "Knight_Golden_Male",
  "BlueSoldier_Female",
  "Cowboy_Female",
  "Chef_Male",
  "Kimono_Female",
  "Pug",
  "Cow",
];

function prettyName(raw: string): string {
  return raw.replace(/_/g, " ").replace(/\bMale\b|\bFemale\b/g, "").trim();
}

function toOption(c: CityChar, i: number): CharacterOption {
  const accent = c.accent ?? ACCENTS[i % ACCENTS.length];
  return {
    id: c.name,
    name: c.label ?? (prettyName(c.name) || c.name),
    description: c.blurb ?? "Ready to explore the VibeVerse.",
    url: c.url,
    scale: 1.0,
    yOffset: 0,
    previewDistance: 2.6,
    previewHeight: 1.55,
    previewTarget: 1.3,
    accent: `from-white/20 to-white/5`,
    // Kept on the object for this component's inline card tint.
    // CharacterPreview only reads the scale/camera fields above.
    ...( { vibeAccent: accent } as unknown as { vibeAccent: string } ),
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
  /** Optional eyebrow/title overrides so the same screen can front
   *  /city, the lobby hub, or any other "pick a vibe" entry surface. */
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  ctaLabel?: string;
  /** If set, render a "Copy invite prompt for your agent" button
   *  pointing at this URL. The user will share the copied text with
   *  their agent so it can join the same world. */
  agentInviteUrl?: string;
}

export default function CityEntryScreen({
  characters,
  initialCharacter,
  initialName,
  onEnter,
  eyebrow = "Welcome to Vibe City",
  title = "Pick your vibe",
  subtitle = "We picked one for you — tap any name to swap.",
  ctaLabel,
  agentInviteUrl,
}: Props) {
  const options = useMemo(() => characters.map((c, i) => toOption(c, i)), [characters]);
  const [picked, setPicked] = useState<string>(initialCharacter);
  const [name, setName] = useState<string>(initialName);
  const [copied, setCopied] = useState(false);
  const [isRandomizing, setIsRandomizing] = useState(false);
  const [previewTick, setPreviewTick] = useState(0);

  const currentOption = options.find((o) => o.id === picked) ?? options[0];
  const currentAccent = ((currentOption as unknown as { vibeAccent?: string })?.vibeAccent ?? ACCENTS[0]);
  const featuredOptions = useMemo(() => {
    const byId = new Map(options.map((o) => [o.id, o]));
    const featured = FEATURED_CHARACTER_IDS.map((id) => byId.get(id)).filter(Boolean) as CharacterOption[];
    const seen = new Set(featured.map((o) => o.id));
    return [...featured, ...options.filter((o) => !seen.has(o.id))];
  }, [options]);

  function pickCharacter(character: CharacterOption) {
    setPicked(character.id);
    setName(generateCharacterName(character.name));
    setPreviewTick((tick) => tick + 1);
  }

  function randomizeCharacter() {
    if (!options.length) return;
    let next = options[Math.floor(Math.random() * options.length)];
    if (options.length > 1) {
      let guard = 0;
      while (next.id === picked && guard < 6) {
        next = options[Math.floor(Math.random() * options.length)];
        guard += 1;
      }
    }
    setIsRandomizing(true);
    pickCharacter(next);
    window.setTimeout(() => setIsRandomizing(false), 520);
  }

  async function copyAgentPrompt() {
    if (!agentInviteUrl) return;
    const who = name.trim() || "my friend";
    const prompt =
      `Hey! I just joined the VibeVerse as "${who}". ` +
      `Hop in and join me — open ${agentInviteUrl} in a browser, ` +
      `pick a character, give yourself a name, and walk over to say hi. ` +
      `It's a multiplayer 3D world; you'll see me running around.`;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Fallback: select-and-copy via a temp textarea
      const ta = document.createElement("textarea");
      ta.value = prompt;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      ta.remove();
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }

  return (
    <div
      className="absolute inset-0 z-20 overflow-y-auto text-white"
      style={{
        backgroundColor: "#b7dceb",
        backgroundImage: `linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.08)), url(${loginBg})`,
        backgroundPosition: "center",
        backgroundSize: "cover",
      }}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_16%,rgba(255,255,255,0.26),transparent_32%)]" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 pb-8 pt-24 sm:px-6 lg:pt-28">
        <div className="mx-auto mb-7 max-w-2xl text-center">
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.45em] text-white/85 drop-shadow">
            {eyebrow}
          </div>
          <h1 className="text-4xl font-light tracking-[-0.04em] text-white drop-shadow-xl sm:text-6xl">
            {title}
          </h1>
          <p className="mx-auto mt-3 max-w-lg text-sm font-medium text-white/80 drop-shadow">
            {subtitle}
          </p>
        </div>

        <section className="mb-8 rounded-3xl border border-white/40 bg-white/24 p-4 shadow-2xl backdrop-blur-xl lg:p-5">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            {currentOption && (
              <div
                className={`relative h-[390px] overflow-hidden rounded-2xl border border-white/40 bg-white/22 transition duration-500 sm:h-[460px] ${
                  isRandomizing ? "scale-[1.012] ring-4 ring-white/55" : ""
                }`}
                style={{
                  background: `linear-gradient(160deg, ${currentAccent}42, rgba(255,255,255,0.28) 58%, rgba(255,255,255,0.16))`,
                }}
              >
                <CharacterPreview key={`${currentOption.id}-${previewTick}`} character={currentOption} spinning />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-sky-950/26 to-transparent" />
                {isRandomizing && (
                  <div className="absolute left-4 top-4 rounded-full border border-white/50 bg-white/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-white shadow-lg backdrop-blur">
                    Rolling
                  </div>
                )}
                <div className="absolute bottom-4 left-4 right-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/72">
                    Selected character
                  </div>
                  <div className="truncate text-4xl font-light tracking-[-0.05em] text-white drop-shadow sm:text-5xl">
                    {currentOption.name}
                  </div>
                  <p className="mt-2 max-w-xl text-sm font-medium text-white/78">
                    {currentOption.description}
                  </p>
                </div>
              </div>
            )}

            <div className="flex flex-col justify-center">
              <label className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/75">
                Your name
              </label>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, 32))}
                  maxLength={32}
                  className="h-12 min-w-0 flex-1 rounded-2xl border border-white/35 bg-white/20 px-4 text-base font-semibold text-white shadow-inner outline-none placeholder:text-white/55 focus:border-white/80 focus:bg-white/28"
                  placeholder="Your name"
                />
                <button
                  type="button"
                  onClick={() => setName(generateCharacterName(currentOption?.name))}
                  className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/35 bg-white/18 text-white transition hover:bg-white/28"
                  title="Roll a new name"
                  aria-label="Roll a new name"
                >
                  <Dices className="h-5 w-5" />
                </button>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <select
                  value={picked}
                  onChange={(e) => {
                    const next = options.find((o) => o.id === e.target.value);
                    if (next) pickCharacter(next);
                  }}
                  className="h-11 min-w-0 appearance-none rounded-2xl border border-white/30 bg-slate-950/55 px-3 text-sm font-medium text-white shadow-inner outline-none backdrop-blur-md focus:border-white/80"
                  aria-label="All characters"
                >
                  {options.map((c) => (
                    <option key={c.id} value={c.id} className="text-slate-900">
                      {c.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={randomizeCharacter}
                  className={`inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-white/30 bg-white/18 px-3 text-sm font-semibold text-white transition hover:bg-white/28 ${
                    isRandomizing ? "scale-[1.03] bg-white/30" : ""
                  }`}
                >
                  <Shuffle className={`h-4 w-4 ${isRandomizing ? "animate-spin" : ""}`} />
                  Random
                </button>
              </div>

              <button
                onClick={() => {
                  const cleanName = name.trim() || generateCharacterName(currentOption?.name);
                  onEnter({ character: currentOption?.id ?? picked, name: cleanName });
                }}
                className="mt-5 inline-flex h-13 w-full items-center justify-center gap-2 rounded-2xl bg-white px-5 py-4 text-sm font-extrabold uppercase tracking-[0.2em] text-slate-900 shadow-[0_18px_50px_rgba(255,255,255,0.28)] transition hover:-translate-y-0.5 hover:bg-white/92"
              >
                {ctaLabel ?? `Enter Edge Island`}
                <ArrowRight className="h-4 w-4" />
              </button>

              {agentInviteUrl && (
                <button
                  onClick={copyAgentPrompt}
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-white/30 bg-white/14 px-5 py-3 text-xs font-semibold text-white transition-colors hover:bg-white/24"
                  title="Copies an invite prompt you can paste to your agent"
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? "Copied — paste it to your agent" : "Invite your agent to join"}
                </button>
              )}

              <div className="mt-4 text-center text-[11px] font-semibold uppercase tracking-[0.2em] text-white/65">
                Step 2 is the world. Default: Edge Island.
              </div>
            </div>
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-end justify-between gap-4">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/72">
                Browse characters
              </div>
              <div className="text-sm font-medium text-white/78">
                {featuredOptions.length} playable avatars
              </div>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {featuredOptions.map((c) => {
              const isPicked = c.id === picked;
              const accent = ((c as unknown as { vibeAccent?: string })?.vibeAccent ?? "#7dd3fc");
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => pickCharacter(c)}
                  className={`group rounded-2xl border p-3 text-left backdrop-blur-md transition duration-200 ${
                    isPicked
                      ? "scale-[1.015] border-white/90 bg-white/34 shadow-2xl"
                      : "border-white/35 bg-white/22 hover:-translate-y-1 hover:border-white/80 hover:bg-white/32 hover:shadow-xl"
                  }`}
                  style={{ boxShadow: isPicked ? `0 18px 60px ${accent}55` : undefined }}
                  >
                  <div
                    className="relative h-36 overflow-hidden rounded-xl border border-white/35 bg-white/18"
                    style={{
                      background: `linear-gradient(145deg, ${accent}40, rgba(255,255,255,0.22))`,
                    }}
                  >
                    <div className="flex h-full flex-col items-center justify-center px-5 text-center">
                      <div
                        className="mb-3 h-14 w-14 rounded-full border border-white/45 bg-white/18 shadow-lg"
                        style={{ boxShadow: `0 0 38px ${accent}55` }}
                      />
                      <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/78">
                        {isPicked ? "Current" : "Select"}
                      </div>
                      <div className="mt-1 line-clamp-2 text-2xl font-light tracking-[-0.04em] text-white">
                        {c.name}
                      </div>
                    </div>
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-sky-950/22 to-transparent" />
                  </div>
                  <div className="mt-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-lg font-semibold leading-tight text-white drop-shadow">
                        {c.name}
                      </div>
                      <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-sm leading-5 text-white/78">
                        {c.description}
                      </p>
                    </div>
                    <span
                      className={`mt-1 h-3 w-3 shrink-0 rounded-full border border-white/70 ${
                        isPicked ? "bg-white" : "bg-white/20"
                      }`}
                    />
                  </div>
                  <div className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/72 group-hover:text-white">
                    Play as {c.name}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
