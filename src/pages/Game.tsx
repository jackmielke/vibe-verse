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
import { byFreshest, exactLabel, sinceLabel, updatedAt } from "@/worlds/freshness";
import { passportProgress } from "@/lib/passport";
import VibeCoinMark from "@/components/VibeCoinMark";
import VibeWink from "@/components/VibeWink";
import { useVibecoin } from "@/hooks/use-vibecoin";

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

/**
 * One card. Every card is the same size, on every breakpoint.
 *
 * Featured worlds used to span two columns from `md:` up, which left ragged
 * gaps in the grid and made the list read as a ranking instead of an index.
 * The order in `src/worlds/registry.ts` already says what leads; the cards
 * only have to be scannable, so they share one aspect ratio and one height
 * (`auto-rows-fr` on the grid, image fixed, body flexed).
 */
function Card({ world, index }: { world: WorldEntry; index: number }) {
  const art = artFor(world.key);
  const iso = updatedAt(world.key);
  const updated = sinceLabel(iso);
  const exact = exactLabel(iso);
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      /* Capped so the last card of a long list does not arrive a second late. */
      transition={{ delay: Math.min(index, 12) * 0.03, duration: 0.32 }}
      className="h-full"
    >
      <Link
        to={world.route}
        className="group flex h-full flex-col overflow-hidden rounded-2xl border border-border/50 bg-background/40 transition-colors hover:border-transparent"
        style={{ boxShadow: `inset 0 0 0 1px ${world.accent}22` }}
      >
        <div className="relative aspect-video shrink-0 overflow-hidden bg-black/50">
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
            /* "Playable — five episodes, desktop and phone" does not fit on a
               170 px card, and a pill reading "PLAYABLE — FIVE EPISOD…" is
               worse than one reading "PLAYABLE". The phone gets the part before
               the dash; everything wider gets the sentence. */
            <span
              className="absolute bottom-1.5 left-1.5 max-w-[calc(100%-0.75rem)] truncate rounded-full px-2 py-0.5 text-[8.5px] font-bold uppercase tracking-[0.12em] text-black sm:bottom-2 sm:left-2 sm:px-2.5 sm:py-1 sm:text-[9px]"
              style={{ background: world.accent }}
            >
              <span className="sm:hidden">{world.status.split("—")[0].trim()}</span>
              <span className="hidden sm:inline">{world.status}</span>
            </span>
          )}
        </div>
        <div className="flex flex-1 flex-col p-2.5 sm:p-3.5">
          <div className="flex items-baseline gap-1.5">
            <span className="text-sm leading-none sm:text-base">{world.emoji}</span>
            <h3 className="font-heading text-[12.5px] font-semibold leading-tight tracking-wide sm:text-sm">
              {world.name}
            </h3>
          </div>
          {/* Two lines on a phone, four on a desktop. A card is a promise, not
              an essay, and at 170 px wide the blurb otherwise runs to eight. */}
          <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground sm:line-clamp-3 sm:text-[11.5px]">
            {world.blurb}
          </p>
          {/* Where the code lives, and when it last moved. The path is a laptop
              luxury; the date earns its place on a phone too — in a collection
              this size, "still being worked on" is most of what you want to
              know before clicking. */}
          <div className="mt-auto flex items-baseline gap-2 pt-2">
            <p className="hidden min-w-0 flex-1 truncate font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/45 sm:block">
              {world.source}
            </p>
            {updated && (
              <p
                title={exact ? `Last updated ${exact}` : undefined}
                className="ml-auto shrink-0 font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/55"
              >
                {updated}
              </p>
            )}
          </div>
        </div>
      </Link>
    </motion.div>
  );
}

export default function Game() {
  const [tab, setTab] = useState<WorldKind | "all">("all");
  const [query, setQuery] = useState("");
  /* Two orders, and neither is a ranking. "Featured" is the hand-tuned order in
     the registry — the one to open on, because someone arriving cold should
     meet the best door first. "Recent" answers the other question people
     actually have about a collection this size: what is still being worked on? */
  const [sort, setSort] = useState<"featured" | "recent">("featured");

  /* Read once per mount. The passport is localStorage, and re-reading it every
     render to draw one line of text is not worth a subscription. */
  const progress = useMemo(() => passportProgress(), []);

  /* The wallet, for the chip below the headline. Shares the nav's fetch — see
     `use-vibecoin`, which reference-counts a single request per page. */
  const coin = useVibecoin();

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = tab === "all" ? WORLDS : WORLDS.filter((w) => w.kind === tab);
    const hit = q
      ? base.filter((w) =>
          `${w.name} ${w.blurb} ${w.status ?? ""} ${w.source}`.toLowerCase().includes(q),
        )
      : base;
    return sort === "recent"
      ? [...hit].sort((a, b) => byFreshest(a.key, b.key))
      : featuredFirst(hit);
  }, [tab, query, sort]);

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

      {/* The header is deliberately short on a phone. This page is the front
          door, and a front door's job is to show you the room — every line of
          hero copy above the fold is a game the visitor did not see. */}
      <div className="relative mx-auto max-w-6xl px-3 pb-20 pt-16 sm:px-6 sm:pt-24">
        <motion.header
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          {/* A lockup, not wallpaper. The wink first sat behind the top-right
              corner at 70% opacity, where a spinning glass object is edge-on
              often enough to read as a scratch on the screen. Beside the
              wordmark it is doing the job a mark is for. Phones lose it — at
              390 px the headline is the brand. */}
          <div className="flex items-center gap-4 sm:gap-6">
            <div className="hidden shrink-0 sm:block" aria-hidden>
              <VibeWink size={96} speed={0.7} />
            </div>
            <div className="min-w-0">
              <p className="font-heading text-[9px] font-bold uppercase tracking-[0.36em] text-muted-foreground sm:text-[10px] sm:tracking-[0.42em]">
                Every builder grows the universe
              </p>
              <h1 className="mt-1 font-heading text-3xl font-black tracking-tight sm:mt-2 sm:text-6xl">
                <span className="text-gradient-mint">VIBEVERSE</span>
              </h1>
            </div>
          </div>
          {/* Not "by Jack Mielke and friends" any more. The point of the place
              is that anybody can add a door to it, and a byline quietly says
              the opposite — the eyebrow above already names the invitation. */}
          <p className="mt-1.5 font-heading text-[13px] font-semibold leading-snug text-foreground/85 sm:mt-2 sm:text-base">
            A massive collection of AI-coded games.
          </p>
          {/* The full pitch is desktop-only; the phone gets the one-line
              version in the row of chips below. */}
          <p className="mt-3 hidden max-w-xl text-sm leading-relaxed text-muted-foreground sm:block">
            {/* The total, not the playable count — this sentence sits directly
                above a grid of every door, and saying 36 over 45 cards reads
                as a miscount. The chip below carries the "how many work" nuance. */}
            {WORLDS.length} worlds and games, all in one browser tab. No install, no
            account, no launcher — pick a card and you are in it in a few seconds.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10.5px] sm:mt-5 sm:gap-2 sm:text-[11px]">
            <Link
              to="/terminal"
              className="rounded-full bg-primary px-3 py-1.5 font-heading font-semibold uppercase tracking-wider text-primary-foreground transition-transform hover:scale-[1.03] sm:px-4 sm:py-2"
            >
              🛫 Start at the Terminal
            </Link>
            <Link
              to="/lobby-3d"
              className="rounded-full border border-border/60 px-3 py-1.5 font-heading font-semibold uppercase tracking-wider text-foreground/80 transition-colors hover:text-foreground sm:px-4 sm:py-2"
            >
              🪐 The 3D hub
            </Link>
            {/* The currency, on the front door. The balance is already in the
                corner on every page, but the corner does not say what it is
                for — this chip is the one that tells a first-time visitor the
                vibeverse has money in it and points at where to spend it. */}
            <Link
              to="/arcade"
              title="Vibecoin — the currency of the vibeverse. Earn it in the worlds, spend it in the arcade."
              className="flex items-center gap-1.5 rounded-full border border-[#7dffd4]/35 bg-[#7dffd4]/[0.07] px-3 py-1.5 font-heading font-semibold uppercase tracking-wider text-[#7dffd4] transition-colors hover:border-[#7dffd4]/60 sm:px-4 sm:py-2"
            >
              <VibeCoinMark size={13} />
              <span className="tabular-nums">{coin.display}</span>
              <span className="opacity-70">Vibecoin</span>
            </Link>
            <span className="rounded-full border border-border/40 px-3 py-1.5 text-muted-foreground sm:py-2">
              {counts.playable} playable · passport {progress.visited}/{progress.total}
            </span>
          </div>
        </motion.header>

        {/* Filters + search. The tabs scroll horizontally on a phone rather
            than wrapping to a second row and pushing the grid further down. */}
        <div className="sticky top-0 z-10 -mx-3 mt-5 bg-background/85 px-3 py-2.5 backdrop-blur-xl sm:-mx-6 sm:mt-8 sm:px-6 sm:py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="order-2 flex items-center gap-2 overflow-x-auto sm:order-1 sm:contents [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  title={t.hint}
                  className={`shrink-0 rounded-full px-3 py-1.5 font-heading text-[10.5px] font-semibold uppercase tracking-wider transition-colors ${
                    active
                      ? "bg-primary/25 text-primary shadow-[0_0_18px_hsl(var(--primary)/0.3)]"
                      : "text-foreground/60 hover:bg-muted/50 hover:text-foreground"
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
            </div>
            {/* On a phone this sits above the tabs instead of after them. As the
                last item of a horizontally-scrolling row it was simply off the
                right-hand edge of the screen, which is a search box nobody can
                find. */}
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${WORLDS.length} worlds…`}
              className="order-1 w-full rounded-full border border-border/60 bg-background/50 px-3 py-1.5 text-xs placeholder:text-muted-foreground/60 focus:border-primary/60 focus:outline-none sm:order-2 sm:ml-auto sm:w-52 sm:px-4"
            />
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 sm:mt-3">
          <p className="text-[10.5px] text-muted-foreground/70 sm:text-[11px]">
            {TABS.find((t) => t.id === tab)?.hint} · {shown.length} shown
          </p>
          <div className="ml-auto flex items-center gap-1">
            {(
              [
                ["featured", "Featured"],
                ["recent", "Recently updated"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setSort(id)}
                className={`rounded-full px-2.5 py-1 font-heading text-[9.5px] font-semibold uppercase tracking-wider transition-colors ${
                  sort === id
                    ? "bg-primary/20 text-primary"
                    : "text-muted-foreground/60 hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Two across on a phone, always. Seeing several games at once is the
            entire job of this page. */}
        <div className="mt-3 grid auto-rows-fr grid-cols-2 gap-2.5 sm:mt-4 sm:gap-4 md:grid-cols-3 lg:grid-cols-4">
          {shown.map((w, i) => (
            <Card key={w.key} world={w} index={i} />
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
