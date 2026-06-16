/**
 * WorldBuilder — guided form that turns a few choices into a paste-ready prompt
 * for any AI code editor (Cursor, Lovable, Claude, ChatGPT, etc.).
 *
 * Visual: glassmorphic cards layered over a dreamy cloud background. Cards keep
 * a consistent light-glass tint so the sky reads through but text stays legible.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Copy, Sparkles, Check, Plus, Github, PartyPopper, ExternalLink } from "lucide-react";
import confetti from "canvas-confetti";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

import bgImage from "@/assets/world-builder-bg.png";
import imgClubPenguin from "@/assets/aesthetic/club-penguin.jpg";
import imgMario from "@/assets/aesthetic/mario.jpg";
import imgAnimalCrossing from "@/assets/aesthetic/animal-crossing.jpg";
import imgWindWaker from "@/assets/aesthetic/wind-waker.jpg";
import imgGhibli from "@/assets/aesthetic/ghibli.jpg";
import imgMinecraft from "@/assets/aesthetic/minecraft.jpg";
import imgLowPoly from "@/assets/aesthetic/low-poly.jpg";
import imgPhotoreal from "@/assets/aesthetic/photoreal.jpg";
import imgVaporwave from "@/assets/aesthetic/vaporwave.jpg";
import imgCyberpunk from "@/assets/aesthetic/cyberpunk.jpg";
import imgCottagecore from "@/assets/aesthetic/cottagecore.jpg";
import imgY2K from "@/assets/aesthetic/y2k.jpg";
import imgPixel from "@/assets/aesthetic/pixel.jpg";
import imgPapercraft from "@/assets/aesthetic/papercraft.jpg";
import imgAnime from "@/assets/aesthetic/anime.jpg";
import imgDarkFantasy from "@/assets/aesthetic/dark-fantasy.jpg";
import imgDreamscape from "@/assets/aesthetic/dreamscape.jpg";

type Aesthetic = {
  id: string;
  label: string;
  prompt: string;
  image: string;
};

const AESTHETICS: Aesthetic[] = [
  { id: "club-penguin", label: "Club Penguin", prompt: "Club Penguin (chunky, cute, 2.5D cartoon)", image: imgClubPenguin },
  { id: "mario", label: "Super Mario", prompt: "Super Mario (bright, blocky, playful 3D)", image: imgMario },
  { id: "animal-crossing", label: "Animal Crossing", prompt: "Animal Crossing (soft pastel, cozy)", image: imgAnimalCrossing },
  { id: "wind-waker", label: "Wind Waker", prompt: "Zelda Wind Waker (cel-shaded cartoon)", image: imgWindWaker },
  { id: "ghibli", label: "Studio Ghibli", prompt: "Studio Ghibli (hand-painted, dreamy)", image: imgGhibli },
  { id: "minecraft", label: "Minecraft", prompt: "Minecraft (voxel, blocky)", image: imgMinecraft },
  { id: "low-poly", label: "Low-poly", prompt: "Low-poly flat-shaded 3D", image: imgLowPoly },
  { id: "photoreal", label: "Photorealistic", prompt: "Photorealistic (Unreal Engine 5 style)", image: imgPhotoreal },
  { id: "vaporwave", label: "Vaporwave", prompt: "Vaporwave / synthwave 80s", image: imgVaporwave },
  { id: "cyberpunk", label: "Cyberpunk", prompt: "Cyberpunk neon city", image: imgCyberpunk },
  { id: "cottagecore", label: "Cottagecore", prompt: "Cottagecore / cozy nature", image: imgCottagecore },
  { id: "y2k", label: "Y2K", prompt: "Y2K / early-2000s web (chrome, holographic)", image: imgY2K },
  { id: "pixel", label: "Pixel art", prompt: "16-bit pixel art", image: imgPixel },
  { id: "papercraft", label: "Papercraft", prompt: "Paper / cardboard craft diorama", image: imgPapercraft },
  { id: "anime", label: "Anime", prompt: "Anime cel-shaded (Makoto Shinkai style)", image: imgAnime },
  { id: "dark-fantasy", label: "Dark fantasy", prompt: "Dark fantasy / gothic", image: imgDarkFantasy },
  { id: "dreamscape", label: "Surreal dreamscape", prompt: "Surreal dreamscape with floating islands", image: imgDreamscape },
];

const VIBES = [
  "Cozy & welcoming",
  "Party & high-energy",
  "Mystical & magical",
  "Futuristic & sleek",
  "Wholesome & playful",
  "Eerie & mysterious",
  "Chill & meditative",
  "Adventurous & exploratory",
] as const;

const SOUND_MOODS = [
  "Lo-fi chill beats",
  "Synthwave",
  "Orchestral fantasy",
  "8-bit chiptune",
  "Ambient nature",
  "Jazz cafe",
  "EDM festival",
  "Silent / minimal sfx only",
] as const;

type Addon = { id: string; label: string; prompt: string };

const ADDONS: Addon[] = [
  { id: "day-night", label: "Day / night cycle", prompt: "A slow real-time day/night cycle that changes lighting and ambient sounds." },
  { id: "multiplayer", label: "See other visitors", prompt: "Lightweight multiplayer presence so visitors see each other moving around in real time." },
  { id: "npcs", label: "NPCs with dialogue", prompt: "Friendly NPCs scattered around with short clickable dialogue lines that match the world's tone." },
  { id: "mini-game", label: "A small mini-game", prompt: "One bite-sized mini-game (60 seconds or less) tucked into the world with a visible high-score." },
  { id: "collectibles", label: "Hidden collectibles", prompt: "5–10 hidden collectibles to discover, with a subtle counter in the corner of the HUD." },
  { id: "photo-mode", label: "Photo mode", prompt: "A photo mode (press P) that hides the HUD and lets the player frame and download a screenshot." },
  { id: "avatar", label: "Avatar customization", prompt: "A simple avatar customizer at spawn (color + one hat/accessory) so each visitor feels personal." },
  { id: "weather", label: "Weather changes", prompt: "Occasional weather shifts (rain, fog, sparkles) that change the mood without blocking gameplay." },
  { id: "vehicle", label: "A rideable thing", prompt: "Something fun the player can ride or pilot — a boat, glider, skateboard, hoverboard, whatever fits." },
  { id: "secret-area", label: "A secret area", prompt: "One hidden room or off-the-map area that rewards exploration with a small surprise." },
  { id: "music-player", label: "Diegetic music player", prompt: "A jukebox or radio object in the world that lets the player switch tracks." },
  { id: "guestbook", label: "Visitor guestbook", prompt: "A guestbook object visitors can sign — short messages persist for future visitors to read." },
];



export default function WorldBuilder() {
  // Identity
  const [worldName, setWorldName] = useState("");
  const [tagline, setTagline] = useState("");
  const [backstory, setBackstory] = useState("");
  const [showBackstory, setShowBackstory] = useState(false);

  // Aesthetic + vibe
  const [aestheticId, setAestheticId] = useState<string>("");
  const [aestheticOther, setAestheticOther] = useState("");
  const [vibe, setVibe] = useState<string>("");
  const [palette, setPalette] = useState("");

  // Locations
  const [locations, setLocations] = useState<LocationRow[]>([
    { name: "", what: "" },
    { name: "", what: "" },
    { name: "", what: "" },
  ]);

  // Sound
  const [sound, setSound] = useState<string>("");
  const [ambient, setAmbient] = useState("");

  // Optional add-ons (toggleable suggestions)
  const [selectedAddons, setSelectedAddons] = useState<Set<string>>(new Set());

  const [copied, setCopied] = useState(false);

  const toggleAddon = (id: string) =>
    setSelectedAddons((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const finalAesthetic = useMemo(() => {
    if (aestheticId === "__other__") return aestheticOther.trim();
    const found = AESTHETICS.find((a) => a.id === aestheticId);
    return found?.prompt ?? "";
  }, [aestheticId, aestheticOther]);

  const prompt = useMemo(() => {
    const lines: string[] = [];
    lines.push(
      `Build me an interactive 3D world I can walk around in, called "${
        worldName || "Untitled World"
      }".`,
    );
    if (tagline.trim()) lines.push(`Tagline: ${tagline.trim()}`);
    lines.push("");

    if (backstory.trim()) {
      lines.push("## Backstory");
      lines.push(backstory.trim());
      lines.push("");
    }

    lines.push("## Aesthetic & vibe");
    if (finalAesthetic) lines.push(`- Art style: ${finalAesthetic}`);
    if (vibe) lines.push(`- Overall vibe: ${vibe}`);
    if (palette.trim()) lines.push(`- Color palette / mood: ${palette.trim()}`);
    lines.push("- Match this aesthetic in every model, texture, lighting choice, UI font and color.");
    lines.push("");

    const liveLocations = locations.filter((l) => l.name.trim() || l.what.trim());
    if (liveLocations.length) {
      lines.push("## Key locations");
      liveLocations.forEach((l, i) => {
        const name = l.name.trim() || `Location ${i + 1}`;
        const what = l.what.trim();
        lines.push(`${i + 1}. **${name}**${what ? ` — ${what}` : ""}`);
      });
      lines.push("");
    }

    if (sound || ambient.trim()) {
      lines.push("## Soundtrack & ambience");
      if (sound) lines.push(`- Music style: ${sound}`);
      if (ambient.trim()) lines.push(`- Ambient sounds: ${ambient.trim()}`);
      lines.push("");
    }

    const liveAddons = ADDONS.filter((a) => selectedAddons.has(a.id));
    if (liveAddons.length) {
      lines.push("## Extra features to include");
      liveAddons.forEach((a) => lines.push(`- ${a.prompt}`));
      lines.push("");
    }

    lines.push("## Requirements");
    lines.push("- First-person or third-person controls (WASD + mouse / touch joystick on mobile).");
    lines.push("- A clear spawn point with a short intro nudge so new visitors know what to do.");
    lines.push("- Every location is reachable on foot within ~30 seconds of spawn.");
    lines.push("- Use the aesthetic above consistently — no generic placeholder assets.");
    lines.push("- Keep performance smooth on mid-range mobile (target 60fps).");
    lines.push("");
    lines.push(
      "Ask me clarifying questions only if something above is contradictory; otherwise pick tasteful defaults that match the aesthetic and build it.",
    );

    return lines.join("\n");
  }, [worldName, tagline, backstory, finalAesthetic, vibe, palette, locations, sound, ambient, selectedAddons]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      toast.success("Prompt copied — paste it into your AI editor");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy. Select the text and copy manually.");
    }
  };

  const updateLocation = (i: number, patch: Partial<LocationRow>) =>
    setLocations((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  // Shared style tokens for consistency across the page
  const inputGlass =
    "bg-white/25 border-white/40 backdrop-blur-md text-slate-900 placeholder:text-slate-500";

  return (
    <div className="relative min-h-screen text-slate-900 overflow-x-hidden">
      {/* Background image + soft tint + blobs */}
      <div
        className="fixed inset-0 -z-20 bg-cover bg-center"
        style={{ backgroundImage: `url(${bgImage})` }}
        aria-hidden
      />
      {/* Subtle warm-to-cool wash, never dark enough to hide the clouds */}
      <div
        className="fixed inset-0 -z-10 bg-gradient-to-b from-transparent via-sky-200/10 to-sky-900/25"
        aria-hidden
      />
      <div
        className="fixed -z-10 top-[-10%] left-[-10%] w-[40rem] h-[40rem] rounded-full blur-3xl opacity-25 bg-primary/40"
        aria-hidden
      />
      <div
        className="fixed -z-10 bottom-[-10%] right-[-10%] w-[35rem] h-[35rem] rounded-full blur-3xl opacity-25 bg-accent/40"
        aria-hidden
      />

      <div className="max-w-6xl mx-auto px-4 pt-6">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-800 hover:text-slate-900 transition-colors rounded-full px-3 py-1.5 bg-white/25 backdrop-blur-md border border-white/40"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
      </div>

      <main className="max-w-3xl mx-auto px-4 pt-6 pb-10">
        <div className="space-y-6">
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-white/25 backdrop-blur-md border border-white/40 text-slate-900">
              <Sparkles className="w-3.5 h-3.5 text-primary" /> Guided world builder
            </div>
            <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-slate-900 drop-shadow-[0_1px_2px_rgba(255,255,255,0.6)]">
              Dream up your world in a few clicks.
            </h1>
            <p className="text-slate-700 max-w-2xl">
              Pick a vibe, drop in a few details, and we'll spit out a clean
              prompt you can paste into any AI code editor — Lovable, Claude,
              Codex, Cursor, ChatGPT — to scaffold the whole thing.
            </p>
          </div>


          {/* Aesthetic — VISUAL */}
          <GlassCard>
            <SectionHeader
              step={1}
              title="Aesthetic"
              subtitle="Pick the visual style your world should match."
            />
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {AESTHETICS.map((a) => {
                const active = a.id === aestheticId;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setAestheticId(a.id)}
                    className={`group relative aspect-square rounded-xl overflow-hidden border transition-all text-left ${
                      active
                        ? "border-primary ring-2 ring-primary shadow-[0_0_30px_hsl(var(--primary)/0.5)] scale-[1.02]"
                        : "border-white/30 hover:border-white/60 hover:scale-[1.02]"
                    }`}
                  >
                    <img
                      src={a.image}
                      alt={a.label}
                      loading="lazy"
                      width={512}
                      height={512}
                      className="absolute inset-0 w-full h-full object-cover transition-transform group-hover:scale-105"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                    <div className="absolute bottom-2 left-2 right-2 text-xs font-semibold text-white drop-shadow">
                      {a.label}
                    </div>
                    {active && (
                      <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-primary text-primary-foreground inline-flex items-center justify-center shadow-lg">
                        <Check className="w-3.5 h-3.5" strokeWidth={3} />
                      </div>
                    )}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setAestheticId("__other__")}
                className={`aspect-square rounded-xl border-2 border-dashed transition-all flex flex-col items-center justify-center gap-1 text-xs font-medium ${
                  aestheticId === "__other__"
                    ? "border-primary text-primary bg-primary/10"
                    : "border-white/40 text-slate-700 hover:border-white/70 hover:text-slate-900"
                }`}
              >
                <Sparkles className="w-5 h-5" />
                Describe my own
              </button>
            </div>

            {aestheticId === "__other__" && (
              <Input
                className={`mt-4 ${inputGlass}`}
                value={aestheticOther}
                onChange={(e) => setAestheticOther(e.target.value)}
                placeholder="Describe the style in your own words"
                maxLength={160}
              />
            )}

            <div className="grid sm:grid-cols-2 gap-3 mt-5">
              <Field label="Overall vibe">
                <Select value={vibe} onValueChange={setVibe}>
                  <SelectTrigger className={inputGlass}>
                    <SelectValue placeholder="Pick a vibe…" />
                  </SelectTrigger>
                  <SelectContent>
                    {VIBES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Color palette (optional)">
                <Input
                  value={palette}
                  onChange={(e) => setPalette(e.target.value)}
                  placeholder="e.g. teal + magenta sunset"
                  maxLength={160}
                  className={inputGlass}
                />
              </Field>
            </div>
          </GlassCard>

          {/* Locations */}
          <GlassCard>
            <SectionHeader
              step={2}
              title="Key locations"
              subtitle="3–5 named spots people can visit. Skip rows you don't need."
            />
            <div className="space-y-2">
              {locations.map((loc, i) => (
                <div key={i} className="grid sm:grid-cols-[180px_1fr] gap-2">
                  <Input
                    value={loc.name}
                    onChange={(e) => updateLocation(i, { name: e.target.value })}
                    placeholder={`Location ${i + 1} name`}
                    maxLength={60}
                    className={inputGlass}
                  />
                  <Input
                    value={loc.what}
                    onChange={(e) => updateLocation(i, { what: e.target.value })}
                    placeholder="What's there? (one sentence)"
                    maxLength={200}
                    className={inputGlass}
                  />
                </div>
              ))}
              {locations.length < 5 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setLocations((rows) => [...rows, { name: "", what: "" }])}
                  className="hover:bg-white/20"
                >
                  + Add another location
                </Button>
              )}
            </div>
          </GlassCard>

          {/* Sound */}
          <GlassCard>
            <SectionHeader step={3} title="Sound & music" subtitle="What does it sound like?" />
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Music style">
                <Select value={sound} onValueChange={setSound}>
                  <SelectTrigger className={inputGlass}>
                    <SelectValue placeholder="Pick a soundtrack vibe…" />
                  </SelectTrigger>
                  <SelectContent>
                    {SOUND_MOODS.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Ambient sounds (optional)">
                <Input
                  value={ambient}
                  onChange={(e) => setAmbient(e.target.value)}
                  placeholder="e.g. waves, distant chatter"
                  maxLength={160}
                  className={inputGlass}
                />
              </Field>
            </div>
          </GlassCard>

          {/* Optional add-ons */}
          <GlassCard>
            <SectionHeader
              step={4}
              title="Add a little extra"
              subtitle="Optional ideas — tap any that sound fun and we'll bake them into the prompt."
            />
            <div className="flex flex-wrap gap-2">
              {ADDONS.map((a) => {
                const active = selectedAddons.has(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => toggleAddon(a.id)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-all ${
                      active
                        ? "bg-primary text-primary-foreground border-primary shadow-[0_0_20px_hsl(var(--primary)/0.4)]"
                        : "bg-white/25 text-slate-900 border-white/40 hover:bg-white/35 hover:border-white/60"
                    }`}
                  >
                    {active ? (
                      <Check className="w-3.5 h-3.5" strokeWidth={3} />
                    ) : (
                      <Plus className="w-3.5 h-3.5" />
                    )}
                    {a.label}
                  </button>
                );
              })}
            </div>
            {selectedAddons.size > 0 && (
              <p className="mt-3 text-xs text-slate-700">
                {selectedAddons.size} extra{selectedAddons.size === 1 ? "" : "s"} added to the prompt.
              </p>
            )}
          </GlassCard>

          {/* Step 5 — Name + Copy your prompt */}
          <GlassCard>
            <SectionHeader
              step={5}
              title="Name it & copy your prompt"
              subtitle="Give your world a name, then copy the prompt and paste it into your AI editor."
            />
            <div className="space-y-3">
              <Field label="World name">
                <Input
                  value={worldName}
                  onChange={(e) => setWorldName(e.target.value)}
                  placeholder="e.g. Neon Atoll"
                  maxLength={80}
                  className={inputGlass}
                />
              </Field>
              <Field label="One-line tagline (optional)">
                <Input
                  value={tagline}
                  onChange={(e) => setTagline(e.target.value)}
                  placeholder="e.g. A floating cafe where the moon never sets"
                  maxLength={160}
                  className={inputGlass}
                />
              </Field>
              {showBackstory ? (
                <Field label="Short backstory">
                  <Textarea
                    value={backstory}
                    onChange={(e) => setBackstory(e.target.value)}
                    placeholder="A sentence or two about why this place exists and who lives here."
                    rows={3}
                    maxLength={800}
                    className={inputGlass}
                    autoFocus
                  />
                </Field>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowBackstory(true)}
                  className="hover:bg-white/30 text-slate-700"
                >
                  + Add a backstory (optional)
                </Button>
              )}
            </div>

            <div className="mt-5 rounded-xl border border-white/40 bg-white/25 backdrop-blur-md p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold inline-flex items-center gap-2 text-slate-900">
                  <Sparkles className="w-4 h-4 text-primary" /> Your prompt
                </div>
                <Button size="sm" onClick={handleCopy} className="gap-1.5">
                  {copied ? (
                    <>
                      <Check className="w-4 h-4" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" /> Copy
                    </>
                  )}
                </Button>
              </div>
              <pre className="text-xs leading-relaxed whitespace-pre-wrap font-mono max-h-[40vh] overflow-auto rounded-lg bg-white/30 p-3 border border-white/30 text-slate-900">
{prompt}
              </pre>
              <p className="mt-2 text-[11px] text-slate-700">
                Paste into Lovable, Claude, Codex, Cursor, ChatGPT, or any AI code editor. It updates live as you edit the form above.
              </p>
            </div>
          </GlassCard>

          {/* Step 6 — Submit */}
          <SubmitCard />
        </div>
      </main>
    </div>
  );
}

function GlassCard({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/40 bg-white/25 backdrop-blur-2xl p-5 sm:p-6 shadow-[0_8px_40px_rgba(15,30,60,0.2)]">
      {children}
    </section>
  );
}

function SectionHeader({
  step,
  title,
  subtitle,
}: {
  step: number;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="shrink-0 w-7 h-7 rounded-full bg-primary text-primary-foreground text-xs font-bold inline-flex items-center justify-center shadow-[0_0_20px_hsl(var(--primary)/0.4)]">
        {step}
      </div>
      <div>
        <h2 className="text-lg font-semibold leading-tight text-slate-900">{title}</h2>
        {subtitle && <p className="text-sm text-slate-700 mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] uppercase tracking-wider text-slate-700 font-semibold">
        {label}
      </Label>
      {children}
    </div>
  );
}

function SubmitCard() {
  const [repoUrl, setRepoUrl] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fireConfetti = () => {
    const duration = 1800;
    const end = Date.now() + duration;
    const colors = ["#73ffb8", "#2dd4a8", "#a78bfa", "#67e8f9", "#fde68a"];
    (function frame() {
      confetti({
        particleCount: 4,
        angle: 60,
        spread: 70,
        startVelocity: 55,
        origin: { x: 0, y: 0.7 },
        colors,
      });
      confetti({
        particleCount: 4,
        angle: 120,
        spread: 70,
        startVelocity: 55,
        origin: { x: 1, y: 0.7 },
        colors,
      });
      if (Date.now() < end) requestAnimationFrame(frame);
    })();
    // one big burst from center
    confetti({
      particleCount: 120,
      spread: 100,
      startVelocity: 45,
      origin: { y: 0.6 },
      colors,
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const url = repoUrl.trim();
    const githubRegex = /^https?:\/\/(www\.)?github\.com\/[^/\s]+\/[^/\s]+\/?$/i;
    if (!githubRegex.test(url)) {
      setError("That doesn't look like a github.com repo URL. It should look like https://github.com/your-name/your-world");
      return;
    }
    setError(null);
    setSubmitted(true);
    fireConfetti();
  };

  if (submitted) {
    return (
      <section className="rounded-2xl border border-primary/60 bg-white/30 backdrop-blur-2xl p-6 sm:p-8 shadow-[0_8px_60px_hsl(var(--primary)/0.35)] text-center animate-scale-in">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-primary text-primary-foreground mb-3 shadow-[0_0_30px_hsl(var(--primary)/0.6)]">
          <PartyPopper className="w-7 h-7" />
        </div>
        <h2 className="text-2xl font-bold text-slate-900">Your world is in the queue.</h2>
        <p className="text-slate-700 mt-2 max-w-md mx-auto">
          We'll be adding this to the <span className="text-primary font-semibold">VibeVerse</span> soon.
          Keep an eye on your inbox if you signed in — we'll ping you when it goes live.
        </p>
        <div className="mt-4 inline-flex items-center gap-2 text-xs text-slate-600 bg-white/30 border border-white/40 rounded-full px-3 py-1.5">
          <Github className="w-3.5 h-3.5" />
          <span className="truncate max-w-[280px]">{repoUrl}</span>
        </div>
        <div className="mt-5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setSubmitted(false);
              setRepoUrl("");
            }}
            className="hover:bg-white/30"
          >
            Submit another world
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-white/40 bg-white/25 backdrop-blur-2xl p-5 sm:p-6 shadow-[0_8px_40px_rgba(15,30,60,0.2)]">
      <div className="mb-4 flex items-start gap-3">
        <div className="shrink-0 w-7 h-7 rounded-full bg-primary text-primary-foreground text-xs font-bold inline-flex items-center justify-center shadow-[0_0_20px_hsl(var(--primary)/0.4)]">
          6
        </div>
        <div>
          <h2 className="text-lg font-semibold leading-tight text-slate-900">Ship it to the VibeVerse</h2>
          <p className="text-sm text-slate-700 mt-0.5">
            Built your world? Drop in the public GitHub link and we'll add it to the map.
          </p>
        </div>
      </div>

      <ol className="space-y-2 text-sm text-slate-700 mb-4">
        <li className="flex gap-2">
          <span className="text-primary font-bold">1.</span>
          <span>
            In your Lovable project, open the <span className="font-semibold">+</span> menu (bottom-left of the chat) →{" "}
            <span className="font-semibold">GitHub</span> → <span className="font-semibold">Connect project</span>{" "}
            and create the repo.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="text-primary font-bold">2.</span>
          <span>
            On{" "}
            <a
              href="https://github.com"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2 inline-flex items-center gap-0.5"
            >
              github.com <ExternalLink className="w-3 h-3" />
            </a>
            , open the new repo → <span className="font-semibold">Settings</span> → scroll to{" "}
            <span className="font-semibold">Danger Zone</span> → <span className="font-semibold">Change visibility</span>{" "}
            → make it <span className="font-semibold">Public</span>.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="text-primary font-bold">3.</span>
          <span>Copy the repo URL from your browser bar and paste it below.</span>
        </li>
      </ol>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="relative">
          <Github className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
          <Input
            value={repoUrl}
            onChange={(e) => {
              setRepoUrl(e.target.value);
              if (error) setError(null);
            }}
            placeholder="https://github.com/your-name/your-world"
            className="pl-9 bg-white/25 border-white/40 backdrop-blur-md text-slate-900 placeholder:text-slate-500"
            aria-label="Public GitHub repository URL"
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button type="submit" size="lg" className="w-full gap-2">
          <PartyPopper className="w-4 h-4" />
          Submit to the VibeVerse
        </Button>
      </form>
    </section>
  );
}
