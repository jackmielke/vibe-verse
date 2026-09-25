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
import { useCallback, useMemo, useState } from "react";
import { OniLobbyCard } from "@/oni/ui/LobbyCard";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ChevronDown, Search, X } from "lucide-react";
import { PLAYABLE, WORLDS, type WorldEntry } from "@/worlds/registry";
import {
  SORT_TABS,
  initialSort,
  rememberSort,
  sortWorlds,
  type WorldSort,
} from "@/worlds/sorting";
import { artFor } from "@/worlds/art";
import { motionFor } from "@/worlds/motion";
import { exactLabel, sinceLabel, updatedAt } from "@/worlds/freshness";
import { passportProgress, readPassport, type Stamp } from "@/lib/passport";
import VibeCoinMark from "@/components/VibeCoinMark";
import VibeMark from "@/components/VibeMark";
import VibeMarketChip from "@/components/VibeMarketChip";
import HomeHero, { readLook, type LookId } from "@/components/home/HomeHero";
import TwoCoins from "@/components/TwoCoins";
import StarField from "@/components/StarField";
import FeaturedCharacters from "@/components/shop/FeaturedCharacters";
import { WorldChangesPortal } from "@/components/WorldChanges";
import TodaysPaper from "@/components/TodaysPaper";
import { useVibecoin } from "@/hooks/use-vibecoin";

/**
 * Cards shown before the grid asks to be expanded.
 *
 * Eight because of how it divides: four across on a laptop is two clean rows,
 * two across on a phone is four. Anything that leaves a ragged half-row reads
 * as the page having run out rather than having been folded.
 */
const GRID_PREVIEW = 8;

/**
 * Whether this visitor should be shown a still instead of a recording.
 *
 * `prefers-reduced-motion` is the whole check, and it is a real one here rather
 * than a box-ticking one: a grid where a card starts playing a game under the
 * cursor is precisely the kind of thing that setting exists to turn off. Read
 * per card rather than cached — somebody can change it mid-session, and this is
 * one `matchMedia` call on a pointer event, not on a render.
 */
function stillPreferred(): boolean {
  if (typeof window === "undefined") return true;
  return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

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
function Card({
  world,
  index,
  onHistory,
}: {
  world: WorldEntry;
  index: number;
  onHistory: (w: WorldEntry) => void;
}) {
  const art = artFor(world.key);
  const iso = updatedAt(world.key);
  const updated = sinceLabel(iso);
  const exact = exactLabel(iso);

  /**
   * The moving card, on hover only.
   *
   * `hovering` gates the *mount*, not just the opacity: an `<img>` that is
   * rendered at `opacity: 0` has still been downloaded, so styling it hidden
   * would put a hundred and twenty kilobytes per animated card on the initial
   * load and defeat the whole arrangement. Once mounted it stays mounted —
   * moving off and back should not re-fetch or restart it.
   *
   * `motionReady` is separate so the first hover cross-fades in when the bytes
   * land rather than snapping from a half-drawn frame.
   */
  const [hovering, setHovering] = useState(false);
  const [everHovered, setEverHovered] = useState(false);
  const [motionReady, setMotionReady] = useState(false);
  /* Not `motion` — that is framer-motion's, and shadowing it turns every
     `<motion.div>` in this file into a property access on a string. */
  const clip = everHovered && !stillPreferred() ? motionFor(world.key) : undefined;

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
        onPointerEnter={(e) => {
          /* Fine pointers only. A touch "enter" fires on the tap that is
             already navigating away, so a phone would download the clip for a
             card it is in the middle of leaving. */
          if (e.pointerType !== "mouse") return;
          setEverHovered(true);
          setHovering(true);
        }}
        onPointerLeave={() => setHovering(false)}
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
          {/* A few seconds of the world actually being played, over the still.
              Mounted only once a pointer has been on the card, so the grid
              costs exactly what it did before — see `worlds/motion.ts` for why
              these cannot simply replace the stills. */}
          {clip && (
            <img
              src={clip}
              alt=""
              onLoad={() => setMotionReady(true)}
              className="absolute inset-0 h-full w-full object-cover transition-opacity duration-300"
              style={{ opacity: motionReady && hovering ? 1 : 0 }}
            />
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
              /* The date answers "when" and raises "what". Tapping it says
                 what. It sits inside the card's <Link>, so the navigation has
                 to be stopped by hand — otherwise opening the history also
                 opens the world behind it. */
              <button
                type="button"
                title={exact ? `Last updated ${exact} — tap to see what changed` : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onHistory(world);
                }}
                className="ml-auto shrink-0 rounded font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/55 underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary"
              >
                {updated}
              </button>
            )}
          </div>
        </div>
      </Link>
    </motion.div>
  );
}

/**
 * Featured / Updated / Played.
 *
 * One pill with a highlight that slides between the options, rather than three
 * loose buttons under a caption reading "Recently played" that stayed put
 * whichever one you pressed — it described the first tab, so on the other two
 * the page carried a heading that contradicted the order it was in.
 */
function SortTabs({
  sort,
  onChange,
  tabs,
}: {
  sort: WorldSort;
  onChange: (s: WorldSort) => void;
  tabs: typeof SORT_TABS;
}) {
  return (
    <div
      role="tablist"
      aria-label="Order the worlds"
      /* `self-start` so the pill hugs its two or three words on a phone. In a
         column flex it otherwise stretches the full width and reads as a bar
         with the labels stranded at one end of it. */
      className="flex shrink-0 self-start items-center gap-0.5 rounded-full border border-border/50 bg-background/50 p-0.5 sm:self-auto"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={sort === t.id}
          title={t.hint}
          onClick={() => onChange(t.id)}
          className={`relative rounded-full px-3 py-1.5 font-heading text-[10px] font-bold uppercase tracking-wider transition-colors sm:px-3.5 ${
            sort === t.id ? "text-primary" : "text-muted-foreground/60 hover:text-foreground"
          }`}
        >
          {sort === t.id && (
            <motion.span
              layoutId="sort-pill"
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
              className="absolute inset-0 rounded-full bg-primary/15"
              aria-hidden
            />
          )}
          <span className="relative">{t.label}</span>
        </button>
      ))}
    </div>
  );
}

export default function Game() {
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<WorldEntry | null>(null);

  /* Read once per mount. The passport is localStorage, and re-reading it every
     render to draw one line of text is not worth a subscription. */
  const progress = useMemo(() => passportProgress(), []);
  /** route → last arrival, from the passport. Empty for a first-time visitor. */
  const lastPlayed = useMemo(() => {
    const stamps = readPassport().stamps;
    const map: Record<string, number> = {};
    for (const st of Object.values(stamps) as Stamp[]) map[st.route] = st.last;
    return map;
  }, []);
  const hasPlays = Object.keys(lastPlayed).length > 0;

  /* Featured for anyone arriving cold; whatever they last chose for anyone who
     has chosen. "Played" is not offered until there is something in it — a tab
     that can only ever show you the same order under a different name is a
     control that teaches you not to trust the controls. */
  const [sort, setSort] = useState<WorldSort>(() => initialSort(hasPlays));
  const tabs = useMemo(
    () => SORT_TABS.filter((t) => t.id !== "played" || hasPlays),
    [hasPlays],
  );
  const chooseSort = useCallback((s: WorldSort) => {
    setSort(s);
    rememberSort(s);
  }, []);

  /* The wallet, for the chip below the headline. Shares the nav's fetch — see
     `use-vibecoin`, which reference-counts a single request per page. */
  const coin = useVibecoin();

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = q
      ? WORLDS.filter((w) =>
          `${w.name} ${w.blurb} ${w.status ?? ""} ${w.source}`.toLowerCase().includes(q),
        )
      : WORLDS;
    return sortWorlds(hit, sort, lastPlayed);
  }, [query, sort, lastPlayed]);

  const counts = useMemo(
    () => ({
      playable: PLAYABLE.length,
      games: WORLDS.filter((w) => w.kind === "game").length,
    }),
    [],
  );

  /**
   * How much of the grid is on screen before somebody asks for the rest.
   *
   * A search is never collapsed. Typing three letters and being shown eight of
   * the eleven matches — behind a button — is the control lying about its own
   * result, and it is the moment a visitor stops trusting the search box.
   */
  const [expanded, setExpanded] = useState(false);
  /* Which hero treatment. `?look=poster` previews one without saving, which
     is what a link to somebody else should do; anything else uses the pick
     made at `/looks`. Read once — it cannot change while the page is open. */
  const [look] = useState<LookId>(() => {
    const want = new URLSearchParams(window.location.search).get("look") as LookId | null;
    return want || readLook();
  });

  const collapsed = !expanded && !query.trim() && shown.length > GRID_PREVIEW;
  const visible = collapsed ? shown.slice(0, GRID_PREVIEW) : shown;

  /* No `overflow-hidden` on the root, however much a full-bleed background
     wants it: it would make this a scroll container, and the sort/search bar
     below sticks to the page rather than to this div. The sky is `fixed` and
     cannot overflow anything anyway. */
  return (
    <div className="relative min-h-[100dvh] w-full bg-background">
      {/* The sky. Fixed rather than absolute so the stars stay put while the
          grid scrolls over them — the whole page reads as one window onto the
          same galaxy instead of a header decoration that scrolls away.

          It is one canvas, painted once. See `StarField` for why it is not
          WebGL and why nothing on it moves. */}
      <div className="pointer-events-none fixed inset-0 z-0" aria-hidden>
        <StarField />
        {/* Two nebula washes over the stars, which is the order that reads as
            depth: gas in front of the far ones, and the bright few punching
            through it. Behind the stars they just tint the whole field. */}
        <div
          className="absolute inset-x-0 top-0 h-[80vh]"
          style={{
            background:
              "radial-gradient(70% 55% at 22% 0%, hsl(160 80% 50% / 0.17), transparent 68%)," +
              "radial-gradient(60% 50% at 82% 6%, hsl(266 85% 62% / 0.18), transparent 70%)",
          }}
        />
        {/* And a floor, so the cards at the bottom of a long scroll are not
            sitting on bare starfield with nothing under them. */}
        <div
          className="absolute inset-x-0 bottom-0 h-[45vh]"
          style={{
            background:
              "linear-gradient(to top, hsl(var(--background)) 12%, transparent 100%)",
          }}
        />
      </div>

      {/* The header is deliberately short on a phone. This page is the front
          door, and a front door's job is to show you the room — every line of
          hero copy above the fold is a game the visitor did not see. */}
      <div className="relative mx-auto max-w-6xl px-3 pb-20 pt-16 sm:px-6 sm:pt-20">
        {/* Hero and paper share a row on a wide screen.
            Stacked, they cost 558px before the first card — so at 1440×800 you
            could not see one whole card without scrolling, on the page whose
            entire job is showing you the room. And the hero only ever filled
            the left half, so the fix and the empty space were the same problem:
            the paper goes in the gap.

            Below `lg` this grid collapses to nothing and both children are
            block-level again, which is the order they were already in. */}
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)] lg:items-start lg:gap-10">
        <motion.header
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          {/* A lockup, not wallpaper. The wink first sat behind the top-right
              corner at 70% opacity, where a spinning glass object is edge-on
              often enough to read as a scratch on the screen. Beside the
              wordmark it is doing the job a mark is for. Phones lose it — at
              390 px the headline is the brand.

              `VibeMark` rather than `VibeWink`: the flat render paints in the
              first frame off the image cache, and the real geometry fades in
              over it once three.js has arrived in the background. This is the
              page whose entire argument is that it loads instantly, so the
              renderer is not allowed on the critical path — and it is not. The
              import does not begin until the mark is on screen, and by then
              the picture is already there. */}
          {/* The lockup — mark, eyebrow, wordmark, tagline, pitch — in
              whichever of six styles is chosen at `/looks`. It was mint green
              from the first commit, which is the accent the play *currency*
              uses everywhere else: the loudest type on the site was quietly
              saying "coins". See `HomeHero`; picking a winner is a one-line
              change to `DEFAULT_LOOK` and a delete of the others.

              `VibeMark` rather than `VibeWink` inside it: the flat render
              paints in the first frame off the image cache and the real
              geometry fades in once three.js has arrived. This is the page
              whose entire argument is that it loads instantly, so the renderer
              is not allowed on the critical path. */}
          <HomeHero
            look={look}
            copy={{
              eyebrow: "Powered by creators, owned by players",
              title: "VIBEVERSE",
              tagline: "A massive collection of AI-coded games ;)",
              /* The total, not the playable count — this sentence sits
                 directly above a grid of every door, and saying 36 over 45
                 cards reads as a miscount. The chip below carries the "how
                 many work" nuance. */
              pitch: `${WORLDS.length} worlds and games, all in one browser tab. No install, no account, no launcher — pick a card and you are in it in a few seconds.`,
            }}
          />

          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10.5px] sm:mt-5 sm:gap-2 sm:text-[11px]">
            {/* "Start at the Terminal" and "The 3D hub" used to lead here —
                two buttons nobody pressed, pointing at two surfaces nobody
                used, occupying the most valuable row on the front door. The
                paper below answers the same question ("what is going on in
                here?") and is different every day. Both routes still exist and
                are still in the world list; they just do not open the page. */}
            {/* The currency, on the front door. The balance is already in the
                corner on every page, but the corner does not say what it is
                for — this chip is the one that tells a first-time visitor the
                vibeverse has money in it and points at where to spend it. */}
            <Link
              to="/arcade"
              title="Vibey Coins — the play currency of the vibeverse. Earn them in the worlds, spend them in the arcade."
              className="flex items-center gap-1.5 rounded-full border border-[#7dffd4]/35 bg-[#7dffd4]/[0.07] px-3 py-1.5 font-heading font-semibold uppercase tracking-wider text-[#7dffd4] transition-colors hover:border-[#7dffd4]/60 sm:px-4 sm:py-2"
            >
              <VibeCoinMark size={13} />
              <span className="tabular-nums">{coin.display}</span>
              {/* It says "Vibey" because that is what this number is. It read
                  "Vibecoin" for months while showing the play balance, which
                  is the one place in the app that actively taught the
                  confusion the panel at the bottom of this page exists to
                  clear up. */}
              <span className="opacity-70">Vibey</span>
            </Link>

            {/* The token's market cap. A number that moves is the cheapest
                proof that the other half of this is not a metaphor. */}
            <VibeMarketChip />
            {/* Was a grey span for months: the one record spanning every
                world in here, rendered as five words you could not click. */}
            <Link
              to="/passport"
              title="Your passport — a badge for every world, and what is left to find."
              className="flex items-center gap-1.5 rounded-full border border-border/40 px-3 py-1.5 text-muted-foreground transition-colors hover:border-[#8fb4ff]/60 hover:text-[#8fb4ff] sm:py-2"
            >
              <span>passport</span>
              <span className="tabular-nums">
                {progress.visited}/{progress.total}
              </span>
            </Link>
          </div>
        </motion.header>

          <TodaysPaper className="lg:mt-0" />
        </div>

        {/* The room game, before the grid: at an event the front door's job is
            to get a roomful of phones into one square, and this card is the
            whole lobby. */}
        <OniLobbyCard className="mt-5 sm:mt-8" />

        {/* One bar: how the list is ordered on the left, how to narrow it on
            the right. It used to be two stacked rows — a right-aligned search
            field, then a right-aligned caption and three loose buttons — which
            read as three separate controls that happened to be near each other.
            The count only appears while a search is narrowing something, where
            it answers a question somebody is actually asking. */}
        {/* Parked below the nav rather than at `top-0`. The global nav is fixed
            at `top-3` with a 36px pill, so a bar that sticks flush to the top
            slides underneath it and the first sort tab spends the whole scroll
            behind the Worlds pill — which is what it did. */}
        <div className="sticky top-[52px] z-10 -mx-3 mt-5 flex flex-col gap-2 px-3 py-2.5 backdrop-blur-xl sm:-mx-6 sm:mt-8 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-3">
          <SortTabs sort={sort} onChange={chooseSort} tabs={tabs} />

          <div className="flex min-w-0 items-center gap-2 sm:justify-end">
            {query.trim() && (
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/50">
                {shown.length}/{WORLDS.length}
              </span>
            )}
            <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50"
                aria-hidden
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={`Search ${WORLDS.length} worlds`}
                placeholder="Search worlds…"
                /* `appearance-none` kills WebKit's own round clear button,
                   which draws itself on top of ours and in the wrong grey. */
                className="w-full appearance-none rounded-full border border-border/50 bg-background/50 py-1.5 pl-8 pr-8 text-xs placeholder:text-muted-foreground/50 focus:border-primary/60 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground/50 transition-colors hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Two across on a phone, always. Seeing several games at once is the
            entire job of this page. */}
        <div className="mt-1 grid auto-rows-fr grid-cols-2 gap-2.5 sm:mt-2 sm:gap-4 md:grid-cols-3 lg:grid-cols-4">
          {visible.map((w, i) => (
            <Card key={w.key} world={w} index={i} onHistory={setHistory} />
          ))}
        </div>

        {/* The grid is the page, and it was also a wall: fifty-two cards meant
            nothing underneath it was ever reached, so the characters and the
            currency may as well not have been on the page. Eight is two rows on
            a laptop and four on a phone — enough to prove there is a lot here,
            short enough that scrolling past it is a decision rather than a
            journey.

            The count is on the button because collapsing must not be able to
            make the place look small. */}
        {collapsed && (
          <div className="mt-5 flex justify-center sm:mt-7">
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="group flex items-center gap-2 rounded-full border border-border/50 bg-background/40 px-5 py-2.5 font-heading text-[11px] font-bold uppercase tracking-wider text-foreground/80 backdrop-blur transition-colors hover:border-primary/60 hover:text-primary"
            >
              Show all <span className="tabular-nums">{shown.length}</span> worlds
              <ChevronDown className="h-3.5 w-3.5 transition-transform group-hover:translate-y-0.5" />
            </button>
          </div>
        )}

        {shown.length === 0 && (
          <p className="mt-10 text-center text-sm text-muted-foreground">
            Nothing matches “{query}”. The vibeverse is big but it is not that big yet.
          </p>
        )}

        {/* Who you play as, after what you play. Only when nothing is being
            searched: a query is a question about worlds, and answering it with
            a row of characters underneath is noise on top of a filtered list. */}
        {!query.trim() && <FeaturedCharacters />}

        {/* The band that was here said "Vibey Coins" and described one of the
            two currencies as though it were the only one. That is the exact
            confusion worth spending a panel on, so this replaces it with both
            of them side by side — see `TwoCoins`. Same `!query.trim()` guard:
            a search is a question about worlds, and a currency explainer under
            a filtered list is noise. */}
        {!query.trim() && <TwoCoins />}

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
          {/* This grid is the present tense — every world, flattened, with no
              sense of which came first or how fast they arrived. The Chronicle
              is the same list with time put back into it, and it is worth one
              line here because there is nowhere else anybody would think to
              look for it. */}
          <br />
          <span className="mt-2 inline-block">
            {WORLDS.length} worlds and counting —{" "}
            <Link to="/chronicle" className="text-[#c4b2ff] hover:underline">
              see them in the order they appeared
            </Link>
            .
          </span>
        </footer>
      </div>

      <WorldChangesPortal world={history} onClose={() => setHistory(null)} />
    </div>
  );
}
