/**
 * WorldBuilder — guided form that turns a few choices into a paste-ready prompt
 * for any AI code editor (Cursor, Lovable, Claude, ChatGPT, etc.).
 *
 * Stack-agnostic: we never assume a target framework in the generated prompt.
 * The user pastes the result wherever they build.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Copy, Sparkles, Check } from "lucide-react";
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

const AESTHETICS = [
  "Club Penguin (chunky, cute, 2.5D)",
  "Super Mario (bright, blocky, playful)",
  "Animal Crossing (soft pastel, cozy)",
  "Zelda: Wind Waker (cel-shaded cartoon)",
  "Studio Ghibli (hand-painted, dreamy)",
  "Minecraft (voxel, blocky)",
  "Low-poly flat-shaded",
  "Photorealistic (Unreal-style)",
  "Vaporwave / synthwave",
  "Cyberpunk neon",
  "Cottagecore / cozy nature",
  "Y2K / early-2000s web",
  "Pixel art (16-bit)",
  "Paper / cardboard craft",
  "Anime cel-shaded",
  "Dark fantasy",
  "Surreal dreamscape",
] as const;

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

type LocationRow = { name: string; what: string };
type InteractionRow = { name: string; what: string };

export default function WorldBuilder() {
  // Identity
  const [worldName, setWorldName] = useState("");
  const [tagline, setTagline] = useState("");
  const [backstory, setBackstory] = useState("");

  // Aesthetic + vibe
  const [aesthetic, setAesthetic] = useState<string>("");
  const [aestheticOther, setAestheticOther] = useState("");
  const [vibe, setVibe] = useState<string>("");
  const [palette, setPalette] = useState("");

  // Locations
  const [locations, setLocations] = useState<LocationRow[]>([
    { name: "", what: "" },
    { name: "", what: "" },
    { name: "", what: "" },
  ]);

  // Interactions
  const [interactions, setInteractions] = useState<InteractionRow[]>([
    { name: "", what: "" },
    { name: "", what: "" },
  ]);

  // Sound
  const [sound, setSound] = useState<string>("");
  const [ambient, setAmbient] = useState("");

  const [copied, setCopied] = useState(false);

  const finalAesthetic =
    aesthetic === "__other__" ? aestheticOther.trim() : aesthetic;

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
    lines.push(
      "- Match this aesthetic in every model, texture, lighting choice, UI font and color.",
    );
    lines.push("");

    const liveLocations = locations.filter(
      (l) => l.name.trim() || l.what.trim(),
    );
    if (liveLocations.length) {
      lines.push("## Key locations");
      liveLocations.forEach((l, i) => {
        const name = l.name.trim() || `Location ${i + 1}`;
        const what = l.what.trim();
        lines.push(`${i + 1}. **${name}**${what ? ` — ${what}` : ""}`);
      });
      lines.push("");
    }

    const liveInteractions = interactions.filter(
      (i) => i.name.trim() || i.what.trim(),
    );
    if (liveInteractions.length) {
      lines.push("## Interactions");
      lines.push(
        "When the player walks up to one of these, trigger the described behavior:",
      );
      liveInteractions.forEach((it, i) => {
        const name = it.name.trim() || `Interaction ${i + 1}`;
        const what = it.what.trim();
        lines.push(`- **${name}**${what ? `: ${what}` : ""}`);
      });
      lines.push("");
    }

    if (sound || ambient.trim()) {
      lines.push("## Soundtrack & ambience");
      if (sound) lines.push(`- Music style: ${sound}`);
      if (ambient.trim()) lines.push(`- Ambient sounds: ${ambient.trim()}`);
      lines.push("");
    }

    lines.push("## Requirements");
    lines.push("- First-person or third-person controls (WASD + mouse / touch joystick on mobile).");
    lines.push("- A clear spawn point with a short intro nudge so new visitors know what to do.");
    lines.push("- Each location and interaction is reachable on foot within ~30 seconds of spawn.");
    lines.push("- Use the aesthetic above consistently — no generic placeholder assets.");
    lines.push("- Keep performance smooth on mid-range mobile (target 60fps).");
    lines.push("");
    lines.push(
      "Ask me clarifying questions only if something above is contradictory; otherwise pick tasteful defaults that match the aesthetic and build it.",
    );

    return lines.join("\n");
  }, [
    worldName,
    tagline,
    backstory,
    finalAesthetic,
    vibe,
    palette,
    locations,
    interactions,
    sound,
    ambient,
  ]);

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

  const updateLocation = (i: number, patch: Partial<LocationRow>) => {
    setLocations((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };
  const updateInteraction = (i: number, patch: Partial<InteractionRow>) => {
    setInteractions((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 backdrop-blur bg-background/80 border-b border-border/60">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </Link>
          <div className="inline-flex items-center gap-2 text-sm font-medium">
            <Sparkles className="w-4 h-4 text-primary" /> World Builder
          </div>
          <div className="w-12" />
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8 grid lg:grid-cols-[1fr_minmax(0,420px)] gap-8">
        {/* ---------------- Form ---------------- */}
        <div className="space-y-10">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
              Design your world in a few clicks
            </h1>
            <p className="mt-2 text-muted-foreground max-w-2xl">
              Answer a handful of questions and we'll generate a clean prompt
              you can paste into any AI code editor (Lovable, Cursor, Claude,
              ChatGPT) to scaffold your world.
            </p>
          </div>

          {/* Identity */}
          <Section title="1. Identity" subtitle="What is this world called?">
            <Field label="World name">
              <Input
                value={worldName}
                onChange={(e) => setWorldName(e.target.value)}
                placeholder="e.g. Neon Atoll"
                maxLength={80}
              />
            </Field>
            <Field label="One-line tagline (optional)">
              <Input
                value={tagline}
                onChange={(e) => setTagline(e.target.value)}
                placeholder="e.g. A floating cafe where the moon never sets"
                maxLength={160}
              />
            </Field>
            <Field label="Short backstory (optional)">
              <Textarea
                value={backstory}
                onChange={(e) => setBackstory(e.target.value)}
                placeholder="A sentence or two about why this place exists and who lives here."
                rows={3}
                maxLength={800}
              />
            </Field>
          </Section>

          {/* Aesthetic + vibe */}
          <Section title="2. Aesthetic & vibe" subtitle="The look and feel.">
            <Field label="Art style">
              <Select value={aesthetic} onValueChange={setAesthetic}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick an aesthetic…" />
                </SelectTrigger>
                <SelectContent>
                  {AESTHETICS.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                  <SelectItem value="__other__">Other / describe my own…</SelectItem>
                </SelectContent>
              </Select>
              {aesthetic === "__other__" && (
                <Input
                  className="mt-2"
                  value={aestheticOther}
                  onChange={(e) => setAestheticOther(e.target.value)}
                  placeholder="Describe the style in your own words"
                  maxLength={160}
                />
              )}
            </Field>
            <Field label="Overall vibe">
              <Select value={vibe} onValueChange={setVibe}>
                <SelectTrigger>
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
            <Field label="Color palette / mood (optional)">
              <Input
                value={palette}
                onChange={(e) => setPalette(e.target.value)}
                placeholder="e.g. teal + magenta sunset, or hex codes"
                maxLength={160}
              />
            </Field>
          </Section>

          {/* Locations */}
          <Section
            title="3. Key locations"
            subtitle="3–5 named spots people can visit. Skip rows you don't need."
          >
            {locations.map((loc, i) => (
              <div key={i} className="grid sm:grid-cols-[180px_1fr] gap-2">
                <Input
                  value={loc.name}
                  onChange={(e) => updateLocation(i, { name: e.target.value })}
                  placeholder={`Location ${i + 1} name`}
                  maxLength={60}
                />
                <Input
                  value={loc.what}
                  onChange={(e) => updateLocation(i, { what: e.target.value })}
                  placeholder="What's there? (one sentence)"
                  maxLength={200}
                />
              </div>
            ))}
            {locations.length < 5 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setLocations((rows) => [...rows, { name: "", what: "" }])
                }
              >
                + Add another location
              </Button>
            )}
          </Section>

          {/* Interactions */}
          <Section
            title="4. Interactions"
            subtitle="Things that happen when you walk up — mini-games, NPCs, shops, swings…"
          >
            {interactions.map((it, i) => (
              <div key={i} className="grid sm:grid-cols-[180px_1fr] gap-2">
                <Input
                  value={it.name}
                  onChange={(e) => updateInteraction(i, { name: e.target.value })}
                  placeholder={`Interaction ${i + 1}`}
                  maxLength={60}
                />
                <Input
                  value={it.what}
                  onChange={(e) => updateInteraction(i, { what: e.target.value })}
                  placeholder="What happens? (e.g. opens a snack shop with gem currency)"
                  maxLength={240}
                />
              </div>
            ))}
            {interactions.length < 6 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setInteractions((rows) => [...rows, { name: "", what: "" }])
                }
              >
                + Add another interaction
              </Button>
            )}
          </Section>

          {/* Sound */}
          <Section title="5. Sound & music" subtitle="What does it sound like?">
            <Field label="Music style">
              <Select value={sound} onValueChange={setSound}>
                <SelectTrigger>
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
                placeholder="e.g. waves, distant chatter, wind chimes"
                maxLength={160}
              />
            </Field>
          </Section>
        </div>

        {/* ---------------- Prompt preview ---------------- */}
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <div className="rounded-2xl border border-border/60 bg-card/60 backdrop-blur p-4 shadow-lg">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-semibold inline-flex items-center gap-2">
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
            <pre className="text-xs leading-relaxed whitespace-pre-wrap font-mono max-h-[60vh] overflow-auto rounded-lg bg-background/60 p-3 border border-border/40">
{prompt}
            </pre>
            <p className="mt-3 text-[11px] text-muted-foreground">
              Paste into Lovable, Cursor, Claude, ChatGPT, or any AI code
              editor. It updates live as you edit the form.
            </p>
          </div>
        </aside>
      </main>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {subtitle && (
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
