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
import { Suspense } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, LayoutGrid } from "lucide-react";

import { HOME_THEMES, stepTheme, themeById } from "@/home/themes";

/* -------------------------------------------------------------------------- */
/* One theme, full bleed                                                      */
/* -------------------------------------------------------------------------- */

export function HomeThemePage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const theme = themeById(id);
  const bare = params.has("bare");

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

export default function Homes() {
  return (
    <div className="min-h-[100dvh] w-full bg-background">
      <div className="mx-auto max-w-4xl px-5 pb-24 pt-16 sm:px-8 sm:pt-20">
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

        <ol className="mt-10 space-y-2.5">
          {HOME_THEMES.map((t, i) => (
            <li key={t.id}>
              <Link
                to={`/homes/${t.id}`}
                className="group flex items-center gap-4 rounded-2xl border border-border/50 bg-black/20 p-3.5 transition-colors hover:border-primary/50 hover:bg-black/40"
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
