/**
 * The front door's lockup, in eleven styles.
 *
 * The homepage headline has been mint green since the first commit, which is
 * the accent the *play currency* uses everywhere else — so the loudest type on
 * the site was quietly saying "coins" rather than "vibeverse". Jack asked for
 * white, and for options rather than one guess, so this is the same words and
 * the same mark rendered six ways.
 *
 * Only the lockup is themed: the eyebrow, the wordmark, the tagline and the
 * pitch. Everything below — the chips, the paper, the grid — is shared, so the
 * looks are genuinely comparable and picking one is a one-line change to
 * `DEFAULT_LOOK` rather than a rewrite of the page.
 *
 * Choose at `/looks`. The choice is kept in `localStorage` because it is a
 * preview, not a preference we want to ship a settings screen for: when Jack
 * picks one, the rest get deleted and this file collapses to whichever won.
 */
import type { CSSProperties, ReactNode } from "react";

import VibeMark from "@/components/VibeMark";

export type LookId =
  | "mint" | "chrome" | "terminal" | "glass" | "poster" | "aurora"
  | "outline" | "slab" | "marquee" | "etched" | "split";

export interface Look {
  id: LookId;
  name: string;
  /** One line, for the chooser. What the style is *for*, not what it does. */
  note: string;
}

export const LOOKS: Look[] = [
  { id: "chrome", name: "Chrome", note: "Brushed white metal. Reads expensive and says nothing else." },
  { id: "outline", name: "Outline", note: "Hollow letters, one hairline thick. The starfield shows through." },
  { id: "slab", name: "Slab", note: "A white block with the name cut out of it. Loudest thing here." },
  { id: "marquee", name: "Marquee", note: "The name running past behind itself, like a cabinet attract screen." },
  { id: "etched", name: "Etched", note: "Carved into the page rather than printed on it. Quiet and expensive." },
  { id: "split", name: "Split", note: "VIBE solid, VERSE hollow. One word doing two jobs." },
  { id: "poster", name: "Poster", note: "Type as big as it goes. A gig flyer, not an app header." },
  { id: "terminal", name: "Terminal", note: "Monospace and a live caret. For people who like the machine." },
  { id: "glass", name: "Glass", note: "White on frosted glass with a soft bloom. Modern and calm." },
  { id: "aurora", name: "Aurora", note: "Light, wide, drifting colour behind white. Dreamy." },
  { id: "mint", name: "Mint (today)", note: "What is live now — green, and the same green as the coin." },
];

export const DEFAULT_LOOK: LookId = "chrome";

const KEY = "vibe.home.look";

export function readLook(): LookId {
  if (typeof localStorage === "undefined") return DEFAULT_LOOK;
  try {
    const v = localStorage.getItem(KEY) as LookId | null;
    return v && LOOKS.some((l) => l.id === v) ? v : DEFAULT_LOOK;
  } catch {
    return DEFAULT_LOOK;
  }
}

export function writeLook(id: LookId): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* Private browsing. The pick lasts for this page and no longer. */
  }
}

export interface HeroCopy {
  eyebrow: string;
  title: string;
  tagline: string;
  pitch: string;
}

/* ------------------------------------------------------------------ *
 * Shared pieces
 * ------------------------------------------------------------------ */

/** The mark. Hidden under `sm` in every look: at 390px the headline is the brand. */
function Mark({ size = 96, className = "" }: { size?: number; className?: string }) {
  return (
    <div className={`hidden shrink-0 sm:block ${className}`} aria-hidden>
      <VibeMark size={size} rotateSeconds={30} priority />
    </div>
  );
}

function Pitch({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`mt-3 hidden max-w-xl text-sm leading-relaxed text-muted-foreground sm:block ${className}`}>
      {children}
    </p>
  );
}

/* ------------------------------------------------------------------ *
 * The looks
 * ------------------------------------------------------------------ */

/**
 * Chrome — the wordmark as a milled object.
 *
 * A vertical gradient from white through a cool grey and back is the whole
 * trick: it reads as a curved metal face catching a sky above and a floor
 * below. It needs tight tracking and a heavy weight to work — at a light
 * weight the gradient bands are wider than the strokes and it just looks
 * washed out.
 */
const chromeFace: CSSProperties = {
  backgroundImage:
    "linear-gradient(178deg, #ffffff 8%, #e8eef7 26%, #93a4bd 47%, #ffffff 58%, #cfd9e8 78%, #7d8ba3 100%)",
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
  WebkitTextFillColor: "transparent",
};

function Chrome({ copy }: { copy: HeroCopy }) {
  return (
    <>
      <div className="flex items-center gap-4 sm:gap-6">
        <Mark />
        <div className="min-w-0">
          <p className="font-heading text-[9px] font-bold uppercase tracking-[0.34em] text-white/45 sm:text-[10px] sm:tracking-[0.42em]">
            {copy.eyebrow}
          </p>
          <h1
            className="mt-1 font-heading text-[2.1rem] font-black leading-[0.92] tracking-[-0.045em] sm:mt-2 sm:text-[4.4rem]"
            style={chromeFace}
          >
            {copy.title}
          </h1>
          {/* A hairline under the wordmark, fading out. Metal wants an edge. */}
          <div
            className="mt-2 h-px w-full max-w-md"
            style={{ background: "linear-gradient(90deg, rgba(255,255,255,0.55), transparent)" }}
            aria-hidden
          />
        </div>
      </div>
      <p className="mt-2.5 font-heading text-[13px] font-semibold leading-snug text-white/90 sm:text-base">
        {copy.tagline}
      </p>
      <Pitch>{copy.pitch}</Pitch>
    </>
  );
}

/**
 * Poster — the wordmark at the largest size the column allows.
 *
 * `clamp` on the font size rather than breakpoints, because the whole point is
 * that it fills the measure at every width; a poster with a comfortable margin
 * is not a poster. Condensed by scaling X rather than by loading a condensed
 * face — one more webfont on the page whose argument is that it loads instantly
 * is a bad trade for a slightly better `E`.
 */
function Poster({ copy }: { copy: HeroCopy }) {
  return (
    <>
      <div className="flex items-baseline gap-3">
        <span className="font-heading text-[9px] font-bold uppercase tracking-[0.4em] text-white/50 sm:text-[10px]">
          {copy.eyebrow}
        </span>
        <span className="h-px flex-1 bg-white/20" aria-hidden />
      </div>
      <h1
        className="mt-2 font-heading font-black uppercase text-white"
        style={{
          fontSize: "clamp(2.6rem, 13vw, 7.2rem)",
          lineHeight: 0.82,
          letterSpacing: "-0.055em",
          transform: "scaleX(0.94)",
          transformOrigin: "left",
        }}
      >
        {copy.title}
      </h1>
      <div className="mt-3 h-[3px] w-full bg-white" aria-hidden />
      <div className="mt-3 flex items-start gap-4 sm:gap-6">
        <Mark size={72} />
        <div className="min-w-0">
          <p className="font-heading text-[13px] font-semibold uppercase leading-snug tracking-wide text-white sm:text-base">
            {copy.tagline}
          </p>
          <Pitch className="mt-2">{copy.pitch}</Pitch>
        </div>
      </div>
    </>
  );
}

/**
 * Terminal — the front door as a prompt.
 *
 * The caret is CSS rather than JS: a `steps(2)` opacity animation is one line
 * and costs nothing, where a state toggle would re-render the top of the page
 * twice a second forever. It stops under `prefers-reduced-motion` through the
 * global rule in `index.css`.
 */
function Terminal({ copy }: { copy: HeroCopy }) {
  return (
    <>
      <div className="flex items-center gap-4 sm:gap-6">
        <Mark size={84} />
        <div className="min-w-0 font-mono">
          <p className="text-[9.5px] uppercase tracking-[0.22em] text-white/40 sm:text-[11px]">
            [ {copy.eyebrow} ]
          </p>
          <h1 className="mt-1.5 text-2xl font-bold leading-none tracking-tight text-white sm:mt-2 sm:text-[3.4rem]">
            <span className="text-white/35">&gt;&nbsp;</span>
            {copy.title}
            <span className="vibe-caret ml-1 inline-block w-[0.5em] translate-y-[0.06em] border-b-[0.09em] border-white align-baseline" />
          </h1>
        </div>
      </div>
      <p className="mt-3 font-mono text-[12.5px] leading-snug text-white/85 sm:text-[15px]">
        {copy.tagline}
      </p>
      <p className="mt-3 hidden max-w-xl font-mono text-[12.5px] leading-relaxed text-white/45 sm:block">
        {copy.pitch}
      </p>
    </>
  );
}

/**
 * Glass — white type on a frosted slab.
 *
 * The bloom is a `text-shadow`, not a `filter: blur` on a duplicate: a filtered
 * copy costs a compositor layer the size of the headline on the page that has
 * to paint fastest, and at this size the two are indistinguishable.
 */
function Glass({ copy }: { copy: HeroCopy }) {
  return (
    <div className="rounded-[1.75rem] border border-white/12 bg-white/[0.045] p-5 backdrop-blur-xl sm:p-7">
      <div className="flex items-center gap-4 sm:gap-6">
        <Mark size={88} />
        <div className="min-w-0">
          <p className="font-heading text-[9px] font-bold uppercase tracking-[0.32em] text-white/50 sm:text-[10px]">
            {copy.eyebrow}
          </p>
          <h1
            className="mt-1 font-heading text-3xl font-black leading-none tracking-tight text-white sm:mt-2 sm:text-[3.9rem]"
            style={{ textShadow: "0 0 42px rgba(190,220,255,0.45), 0 2px 26px rgba(0,0,0,0.5)" }}
          >
            {copy.title}
          </h1>
        </div>
      </div>
      <p className="mt-3 font-heading text-[13px] font-semibold leading-snug text-white/90 sm:text-base">
        {copy.tagline}
      </p>
      <Pitch className="text-white/55">{copy.pitch}</Pitch>
    </div>
  );
}

/**
 * Aurora — light, wide, and drifting.
 *
 * The colour is behind the type rather than in it: a slow-moving wash clipped
 * to the headline's box, with the letters in flat white on top. Tinting the
 * letters themselves at this weight makes them illegible against the starfield,
 * which is the mistake the mint version already makes at small sizes.
 */
function Aurora({ copy }: { copy: HeroCopy }) {
  return (
    <>
      {/* `isolate` matters. The wash sat at `-z-10` inside a plain `relative`
          parent, which does not create a stacking context — so it went behind
          the page's own `z-0` fixed starfield and was invisible. Isolating the
          lockup keeps the negative layer local to it. */}
      <div className="relative isolate">
        <div
          /* Blur has to stay well under the band's own height or the colour
             is diluted into the background: at 64px on a 168px-tall element
             the wash was computed, animated, and invisible. */
          className="vibe-aurora pointer-events-none absolute -inset-x-6 -inset-y-10 -z-10 rounded-[40%] blur-2xl"
          aria-hidden
        />
        <div className="relative flex items-center gap-4 sm:gap-6">
          <Mark />
          <div className="min-w-0">
            <p className="font-heading text-[9px] font-medium uppercase tracking-[0.42em] text-white/55 sm:text-[10px]">
              {copy.eyebrow}
            </p>
            <h1 className="mt-1.5 font-heading text-[1.9rem] font-light uppercase leading-none tracking-[0.14em] text-white sm:mt-2.5 sm:text-[3.6rem] sm:tracking-[0.16em]">
              {copy.title}
            </h1>
          </div>
        </div>
      </div>
      <p className="mt-3.5 font-heading text-[13px] font-normal leading-snug tracking-wide text-white/85 sm:text-base">
        {copy.tagline}
      </p>
      <Pitch>{copy.pitch}</Pitch>
    </>
  );
}

/** What is live today, kept so the chooser is a real before-and-after. */
function Mint({ copy }: { copy: HeroCopy }) {
  return (
    <>
      <div className="flex items-center gap-4 sm:gap-6">
        <Mark />
        <div className="min-w-0">
          <p className="font-heading text-[9px] font-bold uppercase tracking-[0.3em] text-muted-foreground sm:text-[10px] sm:tracking-[0.36em]">
            {copy.eyebrow}
          </p>
          <h1 className="mt-1 font-heading text-3xl font-black tracking-tight sm:mt-2 sm:text-6xl">
            <span className="text-gradient-mint">{copy.title}</span>
          </h1>
        </div>
      </div>
      <p className="mt-1.5 font-heading text-[13px] font-semibold leading-snug text-foreground/85 sm:mt-2 sm:text-base">
        {copy.tagline}
      </p>
      <Pitch>{copy.pitch}</Pitch>
    </>
  );
}

/**
 * Outline — the wordmark as a hairline, with the sky inside it.
 *
 * `-webkit-text-stroke` rather than a duplicated shadow ring: it is the only
 * thing that gives an even stroke on every curve, and it is supported
 * everywhere that matters. It only works big — at the phone size the stroke is
 * a third of the counter width and the letters fill in — so the small
 * breakpoint keeps a solid fill and the outline starts at `sm`.
 */
function Outline({ copy }: { copy: HeroCopy }) {
  return (
    <>
      <div className="flex items-center gap-4 sm:gap-6">
        <Mark />
        <div className="min-w-0">
          <p className="font-heading text-[9px] font-bold uppercase tracking-[0.36em] text-white/45 sm:text-[10px]">
            {copy.eyebrow}
          </p>
          <h1
            className="mt-1 font-heading text-3xl font-black uppercase leading-none tracking-tight text-white sm:mt-2 sm:text-[4.2rem] sm:text-transparent"
            style={{
              WebkitTextStroke: "1.4px rgba(255,255,255,0.92)",
              letterSpacing: "-0.03em",
            }}
          >
            {copy.title}
          </h1>
        </div>
      </div>
      <p className="mt-3 font-heading text-[13px] font-semibold leading-snug text-white/90 sm:text-base">
        {copy.tagline}
      </p>
      <Pitch>{copy.pitch}</Pitch>
    </>
  );
}

/**
 * Slab — the name knocked out of a white block.
 *
 * The one look that inverts. It is the loudest thing that can go on this page,
 * which is the point: everything else here is white-on-dark, so a solid white
 * mass is the only move left that changes the *shape* of the page rather than
 * the treatment of the type.
 *
 * The block is `inline-block` and shrink-wraps the word — a full-width bar
 * would read as a broken layout on a wide screen, where the wordmark is a
 * third of the column.
 */
function Slab({ copy }: { copy: HeroCopy }) {
  return (
    <>
      <p className="font-heading text-[9px] font-bold uppercase tracking-[0.36em] text-white/45 sm:text-[10px]">
        {copy.eyebrow}
      </p>
      <div className="mt-2 flex items-center gap-4 sm:gap-6">
        <Mark size={84} />
        <h1
          className="inline-block bg-white px-3 py-1 font-heading text-[1.9rem] font-black uppercase leading-[0.95] tracking-tight text-[#05070f] sm:px-4 sm:py-1.5 sm:text-[3.5rem]"
          style={{ letterSpacing: "-0.045em" }}
        >
          {copy.title}
        </h1>
      </div>
      <p className="mt-3 font-heading text-[13px] font-semibold leading-snug text-white sm:text-base">
        {copy.tagline}
      </p>
      <Pitch>{copy.pitch}</Pitch>
    </>
  );
}

/**
 * Marquee — the name running past behind itself.
 *
 * An arcade attract screen, which is what this place is. The moving band is
 * `aria-hidden` and duplicated so the loop has no seam; the crisp copy on top
 * is the real heading, so a screen reader gets the word once rather than
 * fourteen times.
 *
 * `translate3d` on the track rather than animating `left`, so it runs on the
 * compositor and never touches layout on the page that has to paint fastest.
 */
function Marquee({ copy }: { copy: HeroCopy }) {
  const run = `${copy.title} ✦ `.repeat(6);
  return (
    <>
      <div className="relative isolate">
        {/* The band. Masked to fade at both ends so it reads as passing
            through rather than as a strip that stops. */}
        <div
          className="pointer-events-none absolute inset-x-0 top-[38%] -z-10 overflow-hidden py-1 opacity-[0.16]"
          style={{
            maskImage: "linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent)",
            WebkitMaskImage: "linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent)",
          }}
          aria-hidden
        >
          <div className="vibe-marquee flex w-max whitespace-nowrap font-heading text-[2.2rem] font-black uppercase tracking-tight text-white sm:text-[4rem]">
            <span>{run}</span>
            <span>{run}</span>
          </div>
        </div>

        <div className="relative flex items-center gap-4 sm:gap-6">
          <Mark />
          <div className="min-w-0">
            <p className="font-heading text-[9px] font-bold uppercase tracking-[0.34em] text-white/50 sm:text-[10px]">
              {copy.eyebrow}
            </p>
            <h1
              className="mt-1 font-heading text-3xl font-black uppercase leading-none tracking-tight text-white sm:mt-2 sm:text-[4rem]"
              style={{ textShadow: "0 2px 30px rgba(0,0,0,0.85)" }}
            >
              {copy.title}
            </h1>
          </div>
        </div>
      </div>
      <p className="mt-3 font-heading text-[13px] font-semibold leading-snug text-white/90 sm:text-base">
        {copy.tagline}
      </p>
      <Pitch>{copy.pitch}</Pitch>
    </>
  );
}

/**
 * Etched — carved into the page rather than printed on it.
 *
 * A bright hairline along the top edge and a dark one below is the whole
 * illusion, and the order matters: light above and shadow below reads as
 * raised, the reverse reads as cut in. This is cut in, which is why the fill
 * is slightly *under* white — a pure white face with an inner shadow reads as
 * embossed plastic instead of engraved metal.
 */
function Etched({ copy }: { copy: HeroCopy }) {
  return (
    <>
      <div className="flex items-center gap-4 sm:gap-6">
        <Mark />
        <div className="min-w-0">
          <p className="font-heading text-[9px] font-bold uppercase tracking-[0.4em] text-white/35 sm:text-[10px]">
            {copy.eyebrow}
          </p>
          <h1
            className="mt-1 font-heading text-3xl font-black uppercase leading-none sm:mt-2 sm:text-[4.1rem]"
            style={{
              color: "#c3ccdb",
              letterSpacing: "-0.035em",
              textShadow:
                "0 -1px 0 rgba(0,0,0,0.85), 0 1.5px 0 rgba(255,255,255,0.5), 0 3px 8px rgba(0,0,0,0.5)",
            }}
          >
            {copy.title}
          </h1>
        </div>
      </div>
      <p className="mt-3 font-heading text-[13px] font-semibold leading-snug text-white/80 sm:text-base">
        {copy.tagline}
      </p>
      <Pitch>{copy.pitch}</Pitch>
    </>
  );
}

/**
 * Split — one word doing two jobs.
 *
 * VIBE solid, VERSE hollow, butted together with no space so it still reads as
 * a single word. It is the only look that says something about the *name*
 * rather than about the page, which is why it earns a place next to five that
 * are purely typographic.
 */
function Split({ copy }: { copy: HeroCopy }) {
  /* Split on the natural seam when there is one, rather than at a hard-coded
     index — the copy is a prop and a hard four would silently mangle it the
     day the wordmark changes. */
  const seam = copy.title.toUpperCase().indexOf("VERSE");
  const head = seam > 0 ? copy.title.slice(0, seam) : copy.title;
  const tail = seam > 0 ? copy.title.slice(seam) : "";

  return (
    <>
      <div className="flex items-center gap-4 sm:gap-6">
        <Mark />
        <div className="min-w-0">
          <p className="font-heading text-[9px] font-bold uppercase tracking-[0.36em] text-white/45 sm:text-[10px]">
            {copy.eyebrow}
          </p>
          <h1
            className="mt-1 font-heading text-3xl uppercase leading-none tracking-tight sm:mt-2 sm:text-[4.2rem]"
            style={{ letterSpacing: "-0.035em" }}
          >
            <span className="font-black text-white">{head}</span>
            {tail && (
              <span
                className="font-light text-white sm:text-transparent"
                style={{ WebkitTextStroke: "1.3px rgba(255,255,255,0.85)" }}
              >
                {tail}
              </span>
            )}
          </h1>
        </div>
      </div>
      <p className="mt-3 font-heading text-[13px] font-semibold leading-snug text-white/90 sm:text-base">
        {copy.tagline}
      </p>
      <Pitch>{copy.pitch}</Pitch>
    </>
  );
}

const RENDERERS: Record<LookId, (p: { copy: HeroCopy }) => JSX.Element> = {
  chrome: Chrome,
  outline: Outline,
  slab: Slab,
  marquee: Marquee,
  etched: Etched,
  split: Split,
  poster: Poster,
  terminal: Terminal,
  glass: Glass,
  aurora: Aurora,
  mint: Mint,
};

export default function HomeHero({ look, copy }: { look: LookId; copy: HeroCopy }) {
  const Render = RENDERERS[look] ?? Mint;
  return <Render copy={copy} />;
}
