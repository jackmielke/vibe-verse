/**
 * Companions — the "Agent Lab", an experimental place to hatch your own
 * companion: name it, give it a one-line personality, pick a look.
 *
 * Persistence is hybrid: signed-in users' companions are real
 * `world_agents` rows in the dedicated `agent-lab` room (owner_id = you;
 * RLS fences user rows into that room so nothing can appear in the shared
 * city), which is the trunk both future homes — roaming a shared world or
 * a dedicated Agent Lab world — build on. Guests keep localStorage, and
 * their locally-hatched companions migrate into the account automatically
 * on the first signed-in visit.
 *
 * The `personality` line is stored as the agent `prompt`, so it reads
 * straight as the companion's system prompt when it comes alive.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";

interface Companion {
  id: string;
  name: string;
  personality: string;
  emoji: string;
  hue: number;
  createdAt: number;
}

const LOOKS = ["🐸", "🦊", "🐙", "🐛", "🦉", "🐢", "🐉", "👾", "🤖", "🦄", "🐝", "🦔", "🐧", "🐳", "🦎", "✨"];
const HUES = [160, 280, 200, 30, 340, 100, 250, 10];
const KEY = "vibeverse.companions:v1";

function load(): Companion[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Companion[]) : [];
  } catch {
    return [];
  }
}
function save(list: Companion[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode — the in-memory list still works for this session */
  }
}

/** world_agents row (agent-lab room) → the Lab's Companion shape. */
interface CompanionRow {
  id: string;
  name: string;
  prompt: string | null;
  metadata: { emoji?: string; hue?: number } | null;
  created_at: string;
}
function fromRow(r: CompanionRow): Companion {
  return {
    id: r.id,
    name: r.name,
    personality: r.prompt ?? "",
    emoji: r.metadata?.emoji ?? LOOKS[0],
    hue: r.metadata?.hue ?? HUES[0],
    createdAt: Date.parse(r.created_at) || 0,
  };
}
const ROW_SELECT = "id, name, prompt, metadata, created_at";
function toInsert(c: Omit<Companion, "id" | "createdAt">, ownerId: string) {
  return {
    room_id: "agent-lab",
    agent_key: `companion-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
    name: c.name,
    prompt: c.personality || null,
    owner_id: ownerId,
    metadata: { emoji: c.emoji, hue: c.hue },
  };
}

export default function Companions() {
  const { user, loading: identityLoading } = useVibeIdentity();
  const [companions, setCompanions] = useState<Companion[]>([]);
  const [name, setName] = useState("");
  const [personality, setPersonality] = useState("");
  const [emoji, setEmoji] = useState(LOOKS[0]);
  const [hue, setHue] = useState(HUES[0]);

  useEffect(() => {
    if (identityLoading) return;
    if (!user) {
      setCompanions(load());
      return;
    }
    let cancelled = false;
    void (async () => {
      // One-time adoption: companions hatched as a guest move into the
      // account, so nothing is lost by signing in.
      const local = load();
      if (local.length) {
        const { error } = await supabase
          .from("world_agents")
          .insert(local.map((c) => toInsert(c, user.id)));
        if (!error) localStorage.removeItem(KEY);
      }
      const { data, error } = await supabase
        .from("world_agents")
        .select(ROW_SELECT)
        .eq("owner_id", user.id)
        .eq("room_id", "agent-lab")
        .order("created_at", { ascending: false });
      if (!cancelled && !error) setCompanions((data ?? []).map(fromRow));
    })();
    return () => { cancelled = true; };
  }, [identityLoading, user]);

  const canHatch = name.trim().length > 0;

  const hatch = () => {
    if (!canHatch) return;
    const draft = {
      name: name.trim().slice(0, 40),
      personality: personality.trim().slice(0, 160),
      emoji,
      hue,
    };
    if (user) {
      void supabase
        .from("world_agents")
        .insert(toInsert(draft, user.id))
        .select(ROW_SELECT)
        .single()
        .then(({ data, error }) => {
          if (!error && data) setCompanions((prev) => [fromRow(data as CompanionRow), ...prev]);
        });
    } else {
      const c: Companion = {
        id: crypto.randomUUID?.() ?? `c-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        ...draft,
        createdAt: Date.now(),
      };
      setCompanions((prev) => {
        const next = [c, ...prev];
        save(next);
        return next;
      });
    }
    setName("");
    setPersonality("");
    setEmoji(LOOKS[Math.floor(Math.random() * LOOKS.length)]);
    setHue(HUES[Math.floor(Math.random() * HUES.length)]);
  };

  const release = (id: string) => {
    setCompanions((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (!user) save(next);
      return next;
    });
    if (user) void supabase.from("world_agents").delete().eq("id", id).eq("owner_id", user.id);
  };

  return (
    <div className="min-h-screen w-full overflow-y-auto bg-background px-4 py-10">
      {/* Scoped: hatched companions gently bob so they feel alive. */}
      <style>{`@keyframes companionFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}`}</style>
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <header className="text-center space-y-1">
          <div className="text-xs uppercase tracking-[0.22em] text-muted-foreground">🧪 Experimental</div>
          <h1 className="font-heading text-3xl font-bold tracking-wide text-gradient-mint">Agent Lab</h1>
          <p className="text-sm text-muted-foreground">
            Hatch your own companion — name it, give it a spark, pick a look. It's yours.
          </p>
        </header>

        {/* Hatch form */}
        <section className="glass-panel rounded-2xl p-5 sm:p-6 space-y-5">
          <div className="flex items-center gap-4">
            <div
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-3xl"
              style={{ background: `hsl(${hue} 70% 55% / 0.18)`, boxShadow: `0 0 22px hsl(${hue} 80% 60% / 0.35)` }}
              aria-hidden
            >
              {emoji}
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-muted-foreground">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
                placeholder="Pip, Nimbus, Sir Wiggles…"
                data-testid="companion-name"
                className="w-full rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-sm focus:border-primary/60 focus:outline-none placeholder:text-muted-foreground/70"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wider text-muted-foreground">
              Personality — what's it like / what should it do for you?
            </label>
            <textarea
              value={personality}
              onChange={(e) => setPersonality(e.target.value)}
              maxLength={160}
              rows={2}
              placeholder="A chaotic-good gremlin who hypes me up and remembers my ideas."
              className="w-full resize-none rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-sm focus:border-primary/60 focus:outline-none placeholder:text-muted-foreground/70"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-[11px] uppercase tracking-wider text-muted-foreground">Look</label>
              <div className="flex flex-wrap gap-1.5">
                {LOOKS.map((e) => (
                  <button
                    key={e}
                    onClick={() => setEmoji(e)}
                    aria-pressed={emoji === e}
                    className={`flex h-9 w-9 items-center justify-center rounded-lg text-lg transition ${
                      emoji === e ? "bg-primary/25 ring-1 ring-primary/70" : "bg-background/40 hover:bg-background/70"
                    }`}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] uppercase tracking-wider text-muted-foreground">Aura</label>
              <div className="flex flex-wrap gap-2">
                {HUES.map((h) => (
                  <button
                    key={h}
                    onClick={() => setHue(h)}
                    aria-pressed={hue === h}
                    aria-label={`aura ${h}`}
                    className={`h-8 w-8 rounded-full transition ${hue === h ? "ring-2 ring-white/80 scale-110" : "opacity-80 hover:opacity-100"}`}
                    style={{ background: `hsl(${h} 70% 55%)` }}
                  />
                ))}
              </div>
            </div>
          </div>

          <button
            onClick={hatch}
            disabled={!canHatch}
            data-testid="hatch"
            className="w-full rounded-full bg-primary/90 px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-[0_0_22px_hsl(var(--primary)/0.5)] transition hover:bg-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            🥚 Hatch companion
          </button>
        </section>

        {/* Collection */}
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="font-heading text-lg font-semibold">Your companions</h2>
            <span className="text-xs text-muted-foreground" data-testid="companion-count">
              {companions.length} hatched
            </span>
          </div>

          {companions.length === 0 ? (
            <div className="glass-panel rounded-2xl p-8 text-center text-sm text-muted-foreground">
              No companions yet — hatch your first one above. 🥚
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {companions.map((c, i) => (
                <div
                  key={c.id}
                  data-testid="companion-card"
                  className="glass-panel group relative flex gap-3 rounded-2xl p-4"
                  style={{ boxShadow: `0 0 0 1px hsl(${c.hue} 60% 55% / 0.25), 0 6px 20px hsl(${c.hue} 60% 30% / 0.25)` }}
                >
                  <div
                    className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl text-2xl"
                    style={{ background: `hsl(${c.hue} 70% 55% / 0.2)` }}
                    aria-hidden
                  >
                    <span
                      className="inline-block"
                      style={{ animation: `companionFloat 3s ease-in-out ${(i % 5) * 0.4}s infinite` }}
                    >
                      {c.emoji}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-heading font-semibold">{c.name}</div>
                    <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted-foreground">
                      {c.personality || "a mystery, still finding itself."}
                    </div>
                  </div>
                  <button
                    onClick={() => release(c.id)}
                    aria-label={`release ${c.name}`}
                    className="absolute right-2 top-2 text-xs text-muted-foreground/60 opacity-0 transition group-hover:opacity-100 hover:text-foreground"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <footer className="pb-4 text-center text-xs text-muted-foreground">
          <p data-testid="storage-mode">
            {user
              ? "Saved to your account ✓ — soon they'll come alive in-world and message you."
              : "Saved on this device — sign in and they move to your account automatically."}
          </p>
          <Link to="/" className="mt-2 inline-block text-primary/80 hover:text-primary">
            ← back to the VibeVerse
          </Link>
        </footer>
      </div>
    </div>
  );
}
