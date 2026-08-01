/**
 * /game — every playable thing in the vibeverse, on one page.
 *
 * The hub at `/` is a 3D carousel: gorgeous, but it shows you one world at a
 * time and it costs a WebGL context to look at. This is the flat, fast,
 * linkable index — the page you send someone when they ask "what is in there?"
 * It loads in a frame, works on a phone, and every card is a real capture from
 * the world behind it.
 *
 * It renders `src/worlds/registry.ts` and holds no list of its own. A world
 * added to the registry appears here, in the nav, in the picker and in the
 * passport at the same moment, which is the entire reason the registry exists.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  PLAYABLE,
  WORLDS,
  featuredFirst,
  type WorldEntry,
  type WorldKind,
} from "@/worlds/registry";
import { artFor } from "@/worlds/art";
import { passportProgress } from "@/lib/passport";

/** Filter tabs. `all` is not a kind, so it is spelled out here. */
const TABS: { id: WorldKind | "all"; label: string; hint: string }[] = [
  { id: "all", label: "Everything", hint: "every door in the vibeverse" },
  { id: "game", label: "Games", hint: "a goal, a score, or something shooting back" },
  { id: "world", label: "Worlds", hint: "places to walk, fly and drive around" },
  { id: "hangout", label: "Hangouts", hint: "somewhere to be, with other people" },
  { id: "tool", label: "The App", hint: "the parts that are not the fiction" },
];

/**
 * The panel a card falls back to when a world has no honest capture yet.
 * Deliberately a drawn thing — a skyline in the world's own accent — so nobody
 * mistakes it for a screenshot.
 */
function DrawnPanel({ accent }: { accent: string }) {
  return (
    <div
      className="absolute inset-0"
      style={{
        background:
          `radial-gradient(120% 90% at 18% 0%, ${accent}55, transparent 62%),` +
          "linear-gradient(178deg, #11151d 0%, #080a0f 70%)",
      }}
    >
      <svg
        viewBox="0 0 160 60"
        preserveAspectRatio="none"
        className="absolute inset-x-0 bottom-0 h-1/2 w-full opacity-30"
        aria-hidden
      >
        <path
          d="M0 60V44h9V33h7v11h6V26h8v18h5V36h9v8h7V20h8v24h6V31h10v13h7V38h8v6h6V28h9v16h7v-9h8v9h6V33h9v11h7V41h8v19z"
          fill={accent}
        />
      </svg>
    </div>
  );
}

function Card({ world, index, wide }: { world: WorldEntry; index: number; wide: boolean }) {
  const art = artFor(world.key);
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      /* Capped so the last card of a long list does not arrive a second late. */
      transition={{ delay: Math.min(index, 12) * 0.035, duration: 0.35 }}
      className={wide ? "sm:col-span-2 lg:col-span-2" : ""}
    >
      <Link
        to={world.route}
        className="group block h-full overflow-hidden rounded-2xl border border-border/50 bg-background/40 transition-colors hover:border-transparent"
        style={{ boxShadow: `inset 0 0 0 1px ${world.accent}22` }}
      >
        <div className={`relative overflow-hidden bg-black/50 ${wide ? "aspect-[16/8]" : "aspect-video"}`}>
          {art ? (
            <img
              src={art}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
            />
          ) : (
            <DrawnPanel accent={world.accent} />
          )}
          {/* Scrim: the captures are bright, and the status pill has to stay
              readable over a white sky as well as a night city. */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent" />
          {world.status && (
            <span
              className="absolute bottom-2 left-2 rounded-full px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.14em] text-black"
              style={{ background: world.accent }}
            >
              {world.status}
            </span>
          )}
        </div>
        <div className="p-3.5">
          <div className="flex items-baseline gap-2">
            <span className="text-base leading-none">{world.emoji}</span>
            <h3 className="font-heading text-sm font-semibold tracking-wide">{world.name}</h3>
          </div>
          <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">{world.blurb}</p>
          <p className="mt-2 font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/45">
            {world.source}
          </p>
        </div>
      </Link>
    </motion.div>
  );
}

export default function Game() {
  const [tab, setTab] = useState<WorldKind | "all">("all");
  const [query, setQuery] = useState("");

  /* Read once per mount. The passport is localStorage, and re-reading it every
     render to draw one line of text is not worth a subscription. */
  const progress = useMemo(() => passportProgress(), []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = tab === "all" ? WORLDS : WORLDS.filter((w) => w.kind === tab);
    const hit = q
      ? base.filter((w) =>
          `${w.name} ${w.blurb} ${w.status ?? ""} ${w.source}`.toLowerCase().includes(q),
        )
      : base;
    return featuredFirst(hit);
  }, [tab, query]);

  const counts = useMemo(
    () => ({
      playable: PLAYABLE.length,
      games: WORLDS.filter((w) => w.kind === "game").length,
    }),
    [],
  );

  return (
    <div className="min-h-[100dvh] w-full bg-background">
      {/* Aurora behind the header — cheap, static, and it makes a flat index
          page feel like it belongs to the same universe as the 3D hub. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[70vh]"
        style={{
          background:
            "radial-gradient(70% 55% at 22% 0%, hsl(160 80% 50% / 0.16), transparent 68%)," +
            "radial-gradient(60% 50% at 82% 6%, hsl(266 85% 62% / 0.16), transparent 70%)",
        }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-6xl px-4 pb-20 pt-20 sm:px-6 sm:pt-24">
        <motion.header
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <p className="font-heading text-[10px] font-bold uppercase tracking-[0.42em] text-muted-foreground">
            Every builder grows the universe
          </p>
          <h1 className="mt-2 font-heading text-4xl font-black tracking-tight sm:text-6xl">
            <span className="text-gradient-mint">VIBEVERSE</span>
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
            {counts.playable} worlds and games, all in one browser tab. No install, no
            account, no launcher — pick a card and you are in it in a few seconds.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-2 text-[11px]">
            <Link
              to="/terminal"
              className="rounded-full bg-primary px-4 py-2 font-heading font-semibold uppercase tracking-wider text-primary-foreground transition-transform hover:scale-[1.03]"
            >
              🛫 Start at the Terminal
            </Link>
            <Link
              to="/"
              className="rounded-full border border-border/60 px-4 py-2 font-heading font-semibold uppercase tracking-wider text-foreground/80 transition-colors hover:text-foreground"
            >
              🪐 The 3D hub
            </Link>
            <span className="rounded-full border border-border/40 px-3 py-2 text-muted-foreground">
              Passport: {progress.visited}/{progress.total} stamped
            </span>
          </div>
        </motion.header>

        {/* Filters + search. One row on desktop, two on a phone. */}
        <div className="sticky top-0 z-10 -mx-4 mt-8 bg-background/80 px-4 py-3 backdrop-blur-xl sm:-mx-6 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  title={t.hint}
                  className={`rounded-full px-3 py-1.5 font-heading text-[10.5px] font-semibold uppercase tracking-wider transition-colors ${
                    active
                      ? "bg-primary/25 text-primary shadow-[0_0_18px_hsl(var(--primary)/0.3)]"
                      : "text-foreground/60 hover:bg-muted/50 hover:text-foreground"
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="ml-auto w-full rounded-full border border-border/60 bg-background/50 px-4 py-1.5 text-xs placeholder:text-muted-foreground/60 focus:border-primary/60 focus:outline-none sm:w-52"
            />
          </div>
        </div>

        <p className="mt-3 text-[11px] text-muted-foreground/70">
          {TABS.find((t) => t.id === tab)?.hint} · {shown.length} shown
        </p>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 sm:gap-4">
          {shown.map((w, i) => (
            <Card key={w.key} world={w} index={i} wide={Boolean(w.featured) && !query} />
          ))}
        </div>

        {shown.length === 0 && (
          <p className="mt-10 text-center text-sm text-muted-foreground">
            Nothing matches “{query}”. The vibeverse is big but it is not that big yet.
          </p>
        )}

        <footer className="mt-16 border-t border-border/40 pt-6 text-[11px] text-muted-foreground">
          Built something?{" "}
          <Link to="/submit-world" className="text-primary hover:underline">
            Submit a world
          </Link>{" "}
          and it lands here next to everything else. Or start from{" "}
          <Link to="/world-builder" className="text-primary hover:underline">
            the world builder
          </Link>
          .
        </footer>
      </div>
    </div>
  );
}
