/**
 * The shared half of fifteen homepages.
 *
 * `/homes` is a bake-off: fifteen genuinely different front doors, all of them
 * live, all of them showing the same real worlds, so choosing between them is a
 * design decision rather than a guess about which mock would survive contact
 * with fifty-odd cards and a real coin balance.
 *
 * ## What is shared and what is not
 *
 * Everything in this file is *content and physics* — which worlds exist, what
 * the balance is, how many days the paper is old, a handful of backgrounds that
 * are genuinely reusable. Nothing here has an opinion about how a page looks.
 *
 * Each theme owns its own layout, type, colour and card completely. That is the
 * point: a set of themes built by swapping tokens on one layout produces
 * fifteen versions of the same page, and looking at them tells you nothing you
 * could not have guessed. The variety has to be structural.
 *
 * ## Real data, always
 *
 * A theme that renders placeholder cards is a theme that has not been tested.
 * Every one of these pulls the actual registry, so a design that falls apart at
 * fifty-odd items falls apart here, in front of you, before it is chosen.
 */
import { useEffect, useMemo, useState } from "react";

import { artFor } from "@/worlds/art";
import { motionFor } from "@/worlds/motion";
import { WORLDS, type WorldEntry } from "@/worlds/registry";
import { sinceLabel, updatedAt } from "@/worlds/freshness";
import { passportProgress, readPassport } from "@/lib/passport";
import { loadCurrentIssue, type Issue } from "@/lib/vibeTimes";
import { useVibecoin } from "@/hooks/use-vibecoin";

export interface HomeData {
  /** Every world, registry order. */
  all: WorldEntry[];
  /** Featured first, for a hero rail. */
  featured: WorldEntry[];
  /** Everything that is not featured, for the long grid. */
  rest: WorldEntry[];
  counts: { worlds: number; playable: number };
  passport: { visited: number; total: number };
  /** Routes this visitor has actually stamped, for themes that show progress. */
  visited: Set<string>;
  /**
   * The balance, and whether there is one. A logged-out visitor's `display` is
   * an em-dash, and a lone em-dash in a nav corner reads as a rendering bug in
   * every one of these themes — so each of them shows a way in instead.
   */
  coin: { display: string; balance: number | null; signedIn: boolean };
  /** Today's paper, or null while it loads / if it never arrives. */
  issue: Issue | null;
  art: (key: string) => string | undefined;
  /** A few seconds of the world being played, for the handful that have one. */
  motion: (key: string) => string | undefined;
  freshness: (key: string) => string | null;
}

/**
 * One fetch of everything a front door needs.
 *
 * `useVibecoin` reference-counts a single request across consumers, so a theme
 * calling this costs the same as the current homepage does. The paper is
 * best-effort and its absence is a missing strip rather than a spinner — a
 * loading state above the fold on a page whose argument is that it opens
 * instantly is the one thing none of these can afford.
 */
export function useHomeData(): HomeData {
  const coin = useVibecoin();
  const [issue, setIssue] = useState<Issue | null>(null);

  useEffect(() => {
    let live = true;
    loadCurrentIssue()
      .then((d) => live && d && setIssue(d))
      .catch(() => {
        /* No paper today. Every theme is fine without it. */
      });
    return () => {
      live = false;
    };
  }, []);

  return useMemo(() => {
    const featured = WORLDS.filter((w) => w.featured);
    const rest = WORLDS.filter((w) => !w.featured);
    const progress = passportProgress();
    return {
      all: WORLDS,
      featured,
      rest,
      counts: {
        worlds: WORLDS.length,
        playable: WORLDS.filter((w) => /playable|open/i.test(w.status ?? "")).length,
      },
      passport: { visited: progress.visited, total: progress.total },
      visited: new Set(Object.keys(readPassport().stamps)),
      coin: { display: coin.display, balance: coin.balance, signedIn: coin.balance != null },
      issue,
      art: artFor,
      motion: motionFor,
      freshness: (key: string) => sinceLabel(updatedAt(key)),
    };
  }, [coin.display, coin.balance, issue]);
}

/* ------------------------------------------------------------------------- */
/* Backgrounds                                                                */
/*                                                                            */
/* Reusable because they are physics rather than taste: film grain is film     */
/* grain in any palette. Anything with an opinion lives in the theme.          */
/* ------------------------------------------------------------------------- */

/**
 * Film grain, as an inline SVG turbulence.
 *
 * A tiled PNG would be sharper and would also be a network request per theme;
 * this is one filter the browser renders once. `mixBlendMode: overlay` so it
 * darkens and lightens rather than fogging everything grey — grain laid on as
 * flat opacity is the single most common way a "filmic" page ends up looking
 * merely dirty.
 */
export function Grain({ opacity = 0.16 }: { opacity?: number }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[1]"
      style={{
        opacity,
        mixBlendMode: "overlay",
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='240' height='240' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E\")",
      }}
    />
  );
}

/** Soft drifting cloud banks. Two layers at different speeds reads as depth. */
export function Clouds({
  tint = "rgba(190,205,235,0.30)",
  still = false,
}: {
  tint?: string;
  still?: boolean;
}) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="absolute inset-x-[-40%] h-[60%]"
          style={{
            top: i ? "30%" : "8%",
            background: `radial-gradient(60% 60% at 30% 50%, ${tint}, transparent 70%),
                         radial-gradient(50% 50% at 70% 45%, ${tint}, transparent 72%)`,
            filter: "blur(28px)",
            animation: still ? undefined : `vv-drift ${i ? 150 : 110}s linear infinite`,
            animationDelay: i ? "-40s" : undefined,
          }}
        />
      ))}
      <style>{`@keyframes vv-drift{from{transform:translateX(-6%)}to{transform:translateX(6%)}}`}</style>
    </div>
  );
}

/** A big pale planet, low and cropped. The mood-board moon. */
export function Moon({
  size = 620,
  x = "62%",
  y = "-8%",
  glow = "rgba(226,236,255,0.9)",
}: {
  size?: number;
  x?: string;
  y?: string;
  glow?: string;
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute rounded-full"
      style={{
        width: size,
        height: size,
        left: x,
        top: y,
        background: `radial-gradient(38% 38% at 38% 32%, ${glow}, rgba(150,168,200,0.55) 55%, rgba(70,86,120,0.35) 78%, transparent 80%)`,
        filter: "blur(0.4px)",
      }}
    />
  );
}

/** Topographic contour lines. Outdoors without a photograph. */
export function Topo({ color = "rgba(255,255,255,0.07)" }: { color?: string }) {
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none">
      <defs>
        <pattern id="vv-topo" width="180" height="120" patternUnits="userSpaceOnUse">
          {[0, 1, 2, 3].map((i) => (
            <path
              key={i}
              d={`M0 ${18 + i * 28} q45 -${14 + i * 3} 90 0 t90 0`}
              fill="none"
              stroke={color}
              strokeWidth="1"
            />
          ))}
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#vv-topo)" />
    </svg>
  );
}

/** CRT scanlines. Cheap, and the one effect that has to be subtle to work. */
export function Scanlines({ opacity = 0.25 }: { opacity?: number }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[1]"
      style={{
        opacity,
        backgroundImage:
          "repeating-linear-gradient(to bottom, rgba(0,0,0,0.5) 0px, rgba(0,0,0,0.5) 1px, transparent 1px, transparent 3px)",
      }}
    />
  );
}

/** Wide, slow bands of colour. The aurora, done with gradients. */
export function AuroraWash({ colors = ["#7dffd4", "#8fb4ff", "#c4b2ff"] }: { colors?: string[] }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {colors.map((c, i) => (
        <div
          key={c}
          className="absolute h-[70%] w-[70%] rounded-full"
          style={{
            left: `${8 + i * 26}%`,
            top: `${-18 + i * 9}%`,
            background: `radial-gradient(circle, ${c}44, transparent 62%)`,
            filter: "blur(70px)",
            animation: `vv-aurora ${60 + i * 18}s ease-in-out infinite alternate`,
          }}
        />
      ))}
      <style>{`@keyframes vv-aurora{from{transform:translate3d(-4%,-2%,0) scale(1)}to{transform:translate3d(5%,3%,0) scale(1.12)}}`}</style>
    </div>
  );
}

/** A ruled paper grid, for the technical looks. */
export function BlueprintGrid({
  color = "rgba(140,190,255,0.16)",
  size = 26,
}: {
  color?: string;
  size?: number;
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage: `linear-gradient(${color} 1px, transparent 1px), linear-gradient(90deg, ${color} 1px, transparent 1px)`,
        backgroundSize: `${size}px ${size}px`,
      }}
    />
  );
}

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/**
 * The world count, in words.
 *
 * Three of these themes set the number as part of a headline, where a numeral
 * reads as a statistic and a word reads as a sentence. They each spelled it out
 * by hand, and then a world was added and all three said "fifty-three" beside a
 * grid of fifty-four. That is the same failure the registry exists to prevent —
 * a second copy of a fact that nobody remembers to update — so there should not
 * be a spelled number anywhere in this directory that is not this function.
 *
 * Falls back to the numeral above ninety-nine, by which point a headline saying
 * "one hundred and forty-two worlds" has other problems.
 */
export function spellCount(n: number, cap = false): string {
  let out: string;
  if (n < 0 || n > 99 || !Number.isInteger(n)) out = String(n);
  else if (n < 20) out = ONES[n];
  else out = TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  return cap ? out[0].toUpperCase() + out.slice(1) : out;
}

/** Format a world's status for a badge — the part before the dash. */
export function shortStatus(status?: string): string | null {
  if (!status) return null;
  return status.split("—")[0].trim();
}
