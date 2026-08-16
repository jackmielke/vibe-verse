/**
 * `/homes` — fifteen front doors, side by side, all of them live.
 *
 * Two surfaces in one file because they are one idea:
 *
 * - `/homes` lists every theme with a swatch and a sentence.
 * - `/homes/:id` renders one of them full-bleed, with a bar to step through
 *   the rest without going back to the list.
 *
 * ## Why they are live pages rather than screenshots
 *
 * A screenshot of a homepage is a picture of a homepage that has not been
 * tested. These render the real registry — fifty-three worlds, the real
 * balance, today's paper — so a layout that falls apart at real length falls
 * apart here, in front of you, before it is chosen. It also means the winner is
 * already built.
 *
 * ## The bar
 *
 * Fixed to the bottom and deliberately plain: it belongs to the picker, not to
 * the theme, and a chrome that tried to match fifteen different designs would
 * end up matching none of them. It hides on `?bare` so a theme can be looked at
 * — or photographed — without it.
 */
import { Suspense, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, LayoutGrid } from "lucide-react";

import { HOME_THEMES, stepTheme, themeById, type HomeTheme } from "@/home/themes";

/* -------------------------------------------------------------------------- */
/* One theme, full bleed                                                      */
/* -------------------------------------------------------------------------- */

export function HomeThemePage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const theme = themeById(id);
  const bare = params.has("bare");
  const nav = useNavigate();

  /* Walking fifteen designs one click at a time is the slow way to compare
     them; tapping a key and watching them flick past is the fast one.
     Deliberately NOT the arrow keys — Console drives its shelves with those,
     and a stepper bound to them would step and scroll on the same press.
     Above the `!theme` return because hooks cannot be conditional. */
  useEffect(() => {
    if (!theme) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && /input|textarea|select/i.test(t.tagName)) return;
      const dir = e.key === "[" ? -1 : e.key === "]" ? 1 : 0;
      if (!dir) return;
      nav(`/homes/${stepTheme(theme.id, dir).id}${bare ? "?bare" : ""}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bare, nav, theme]);

  if (!theme) {
    return (
      <div className="grid min-h-[100dvh] place-items-center bg-background px-6 text-center">
        <div>
          <p className="font-heading text-lg font-black">No front door called “{id}”.</p>
          <Link to="/homes" className="mt-3 inline-block text-primary hover:underline">
            See the fifteen that exist →
          </Link>
        </div>
      </div>
    );
  }

  const prev = stepTheme(theme.id, -1);
  const next = stepTheme(theme.id, 1);
  const Themed = theme.Component;

  return (
    <div className="relative">
      {/* Each theme owns the whole viewport, so the fallback has to as well —
          otherwise stepping between them flashes the page background. */}
      <Suspense fallback={<div className="min-h-[100dvh] w-full bg-[#05070d]" />}>
        <Themed />
      </Suspense>

      {!bare && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center p-3">
          <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/15 bg-black/80 p-1 pr-2 shadow-2xl backdrop-blur-xl">
            <Link
              to={`/homes/${prev.id}`}
              className="grid h-9 w-9 place-items-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              title={`Previous — ${prev.name}`}
              aria-label={`Previous look: ${prev.name}`}
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>

            <div className="px-2 text-center">
              <div className="font-heading text-[12.5px] font-bold leading-none text-white">
                {theme.name}
              </div>
              <div className="mt-0.5 font-heading text-[8.5px] uppercase tracking-[0.16em] text-white/45">
                {HOME_THEMES.findIndex((t) => t.id === theme.id) + 1} of {HOME_THEMES.length} ·{" "}
                {theme.mood}
                <span className="ml-1.5 hidden font-mono normal-case tracking-normal text-white/30 sm:inline">
                  [ ]
                </span>
              </div>
            </div>

            <Link
              to={`/homes/${next.id}`}
              className="grid h-9 w-9 place-items-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              title={`Next — ${next.name}`}
              aria-label={`Next look: ${next.name}`}
            >
              <ArrowRight className="h-4 w-4" />
            </Link>

            <span className="mx-1 h-5 w-px bg-white/15" aria-hidden />

            <Link
              to="/homes"
              className="flex items-center gap-1.5 rounded-full px-3 py-2 font-heading text-[10.5px] font-bold uppercase tracking-wider text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              All
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The list                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The preview pane.
 *
 * One iframe, never fifteen. Booting the whole app fifteen times over to draw a
 * contact sheet is half a gigabyte of memory to answer a question you can
 * answer with one frame at a time, and the tab that dies is the tab you were
 * choosing in. So the pane shows whichever row is under the cursor, and swaps.
 *
 * It renders at a real desktop width and is scaled down with a transform rather
 * than made small, because a homepage rendered into a 460px box is a homepage in
 * its phone layout — which is a picture of a different design than the one being
 * chosen. `ResizeObserver` keeps the scale honest at any pane width.
 *
 * The swap is debounced. Sweeping the cursor down the list otherwise mounts and
 * tears down a dozen apps in a second, and the pane spends the whole time
 * white.
 */
function Preview({ theme }: { theme: HomeTheme }) {
  const [shown, setShown] = useState(theme);
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.32);

  useEffect(() => {
    const t = setTimeout(() => setShown(theme), 220);
    return () => clearTimeout(t);
  }, [theme]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale(e.contentRect.width / FRAME_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="sticky top-8">
      <div
        ref={box}
        className="relative overflow-hidden rounded-2xl border border-border/60 bg-black shadow-2xl"
        style={{ height: FRAME_H * scale }}
      >
        <iframe
          key={shown.id}
          src={`/homes/${shown.id}?bare`}
          title={`${shown.name} preview`}
          loading="lazy"
          tabIndex={-1}
          className="absolute left-0 top-0 origin-top-left border-0"
          style={{ width: FRAME_W, height: FRAME_H, transform: `scale(${scale})` }}
        />
        {/* The frame is a picture, not a page. Clicks belong to the row. */}
        <div className="absolute inset-0" aria-hidden />
      </div>
      <div className="mt-3 flex items-baseline gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-heading text-[15px] font-bold">{theme.name}</h2>
          <p className="mt-0.5 font-heading text-[9px] uppercase tracking-[0.18em] text-muted-foreground/60">
            {theme.mood}
          </p>
        </div>
        <Link
          to={`/homes/${theme.id}`}
          className="ml-auto shrink-0 rounded-full bg-primary px-4 py-2 font-heading text-[11px] font-bold text-primary-foreground"
        >
          Open full size →
        </Link>
      </div>
    </div>
  );
}

/** The width the preview pretends to be, so themes render their desktop layout. */
const FRAME_W = 1440;
const FRAME_H = 900;

export default function Homes() {
  const [hover, setHover] = useState(HOME_THEMES[0]);

  return (
    <div className="min-h-[100dvh] w-full bg-background">
      <div className="mx-auto max-w-6xl px-5 pb-24 pt-16 sm:px-8 sm:pt-20">
        <header>
          <p className="font-heading text-[9px] font-bold uppercase tracking-[0.34em] text-muted-foreground sm:text-[10px]">
            Pick a front door
          </p>
          <h1 className="mt-2 font-heading text-4xl font-black leading-[1.04] tracking-tight sm:text-5xl">
            <span className="text-gradient-mint">{HOME_THEMES.length} homepages</span>
          </h1>
          <p className="mt-4 max-w-xl text-[14.5px] leading-relaxed text-muted-foreground">
            Every one is a whole design — its own layout, type and palette, not a
            skin over one page — and every one is live, showing the real worlds.
            Open one and use the arrows at the bottom to walk through the rest.
          </p>
          <p className="mt-2 max-w-xl text-[12.5px] leading-relaxed text-muted-foreground/70">
            Nothing here replaces the current front door. Add <code>?bare</code> to
            any of them to hide the stepper.
          </p>
        </header>

        {/* The preview gets the larger half. It is the thing being judged; the
            list is only how you point at it. */}
        <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
        <ol className="space-y-2.5">
          {HOME_THEMES.map((t, i) => (
            <li key={t.id}>
              <Link
                to={`/homes/${t.id}`}
                onMouseEnter={() => setHover(t)}
                onFocus={() => setHover(t)}
                className={`group flex items-center gap-4 rounded-2xl border p-3.5 transition-colors ${
                  hover.id === t.id
                    ? "border-primary/60 bg-black/45"
                    : "border-border/50 bg-black/20 hover:border-primary/50 hover:bg-black/40"
                }`}
              >
                {/* The swatch is three colours that genuinely appear on the
                    page. A screenshot would be prettier and would be wrong the
                    first time somebody edits a theme. */}
                <div className="flex h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-white/10">
                  {t.palette.map((c) => (
                    <span key={c} className="flex-1" style={{ background: c }} />
                  ))}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2.5">
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground/50">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <h2 className="font-heading text-[15px] font-bold">{t.name}</h2>
                    <span className="font-heading text-[9px] uppercase tracking-[0.16em] text-muted-foreground/60">
                      {t.mood}
                    </span>
                  </div>
                  <p className="mt-1 text-[12.5px] leading-snug text-muted-foreground">{t.note}</p>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-1 group-hover:text-primary" />
              </Link>
            </li>
          ))}
        </ol>

          {/* Hidden below `lg` rather than made small: a 320px-wide preview of
              a homepage is unreadable, and a row you have to scroll past to
              reach the next row is worse than no preview at all. On a phone the
              list is the right interface. */}
          <div className="hidden lg:block">
            <Preview theme={hover} />
          </div>
        </div>

        <footer className="mt-12 border-t border-border/40 pt-6 text-[11.5px] leading-relaxed text-muted-foreground">
          The live front door is still{" "}
          <Link to="/game" className="text-primary hover:underline">
            /game
          </Link>
          . These are candidates.
        </footer>
      </div>
    </div>
  );
}
