/**
 * GlobalNav — top nav with World chips (left/center) + Vibe Profile (right).
 *
 * The chip row shows: 🌐 Worlds (opens the full picker) + a fixed set of
 * primary destinations + ⋯ More (everything else). Keep the order stable so
 * the nav feels like a map instead of a recents list.
 *
 * The Vibe Profile button sits in its OWN pill at top-right, with the
 * same height/glass treatment as the nav row so they line up perfectly
 * across the top edge.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import WorldPicker from "@/components/WorldPicker";
import LogInWithVibe from "@/components/vibe-auth/LogInWithVibe";
import VibeCoinChip from "@/components/VibeCoinChip";
import { WORLDS, type WorldEntry } from "@/worlds/registry";
import { VibeMark } from "@/components/HomeButton";

/**
 * Every hoppable destination, and the order of the chip row, both come from
 * `src/worlds/registry.ts`. The nav used to keep its own list, which is how it
 * ended up offering Vibe Star but not Vibe Golf or Vibe Kart.
 */
type Destination = WorldEntry;

const ALL_WORLDS: Destination[] = WORLDS.filter((w) => w.nav);

const VISIBLE = 5;

export default function GlobalNav() {
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // /start is the first sixty seconds of the VibeVerse — Vibey hosts it
  // full-bleed, so the world chips and profile pill stay out of frame.
  const onboarding = location.pathname === "/start";
  // Globetrotter is a full-bleed game — world chips floating over the
  // satellite view break the immersion, and the game carries its own
  // exit affordance in the HUD.
  const fullBleedGame = ["/globetrotter", "/geo"].includes(location.pathname);
  // ?embed=1 — another site is framing us as a broadcast (the studio's
  // VIBE TV tunes into /live). Pure picture, no chrome.
  const embedded = new URLSearchParams(location.search).get("embed") === "1";

  // Collapse the dropdown / picker on any navigation.
  useEffect(() => {
    setMoreOpen(false);
    setPickerOpen(false);
  }, [location.pathname, location.search]);

  const visible = useMemo<Destination[]>(() => {
    return ALL_WORLDS.slice(0, VISIBLE);
  }, []);

  const overflow = useMemo<Destination[]>(
    () => ALL_WORLDS.filter((w) => !visible.some((v) => v.key === w.key)),
    [visible]
  );

  const isActive = (d: Destination) => {
    const [path, query] = d.route.split("?");
    const pathHit =
      location.pathname === path || Boolean(d.aliases?.includes(location.pathname));
    if (!pathHit) return false;
    if (path === "/city") {
      const spawnOf = (s: string | undefined) =>
        s?.includes("spawn=moon")
          ? "moon"
          : s?.includes("spawn=island")
            ? "island"
            : s?.includes("spawn=ski")
              ? "ski"
              : "city";
      return spawnOf(query) === spawnOf(location.search);
    }
    return true;
  };

  const chipClass = (active: boolean) =>
    `group relative flex items-center gap-1.5 rounded-full px-2 sm:px-2.5 py-1.5 transition-all ${
      active
        ? "bg-primary/25 text-primary shadow-[0_0_18px_hsl(var(--primary)/0.35)]"
        : "text-foreground/75 hover:text-foreground hover:bg-muted/50"
    }`;

  const labelClass =
    "text-[10.5px] font-heading font-semibold tracking-wider uppercase leading-none hidden sm:inline";

  if (onboarding || embedded || fullBleedGame) return null;

  return (
    <>
      {/* World selector — own pill, top-left, mirrors the Vibe Profile pill. */}
      <div className="fixed top-3 left-3 z-40 pointer-events-auto">
        <div
          className="glass-panel rounded-full border border-border/60 px-1.5 py-1 flex items-center"
          style={{
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
          }}
        >
          {/* Points at /game, not at "/". The hub is beautiful and slow; this
              chip is the one people press when they want to *see what's here*,
              and that deserves the flat index that loads in a frame. */}
          <Link
            to="/game"
            className={chipClass(location.pathname === "/game")}
            title="Every world and game, on one page"
            aria-current={location.pathname === "/game" ? "page" : undefined}
          >
            {/* Same mark as the home button that stands in for this pill
                inside fullscreen worlds — one corner, one thing, everywhere. */}
            <VibeMark size={14} />
            <span className={labelClass}>Worlds</span>
          </Link>
        </div>
      </div>

      <nav
        className="fixed top-3 left-1/2 -translate-x-1/2 z-40 pointer-events-none"
        aria-label="Primary destinations"
      >
        <div className="relative pointer-events-auto">
          <div
            className="glass-panel rounded-full border border-border/60 px-1.5 py-1 flex items-center gap-1"
            style={{
              backdropFilter: "blur(10px)",
              WebkitBackdropFilter: "blur(10px)",
            }}
          >
            {visible.map((d) => {
              const active = isActive(d);
              return (
                <Link
                  key={d.key}
                  to={d.route}
                  className={chipClass(active)}
                  title={d.blurb}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="text-sm leading-none">{d.emoji}</span>
                  <span className={labelClass}>{d.name}</span>
                  {active && (
                    <span
                      className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary"
                      aria-hidden
                    />
                  )}
                </Link>
              );
            })}

            <button
              onClick={() => {
                setMoreOpen((v) => !v);
                setPickerOpen(false);
              }}
              className={chipClass(moreOpen || overflow.some(isActive))}
              title="More worlds"
              aria-expanded={moreOpen}
            >
              <span className="text-sm leading-none">⋯</span>
            </button>
          </div>

          {moreOpen && (
            <div className="absolute top-full right-0 mt-2 glass-panel rounded-2xl border border-border/60 p-1.5 flex flex-col gap-0.5 min-w-[12rem]">
              {overflow.map((d) => {
                const active = isActive(d);
                return (
                  <Link
                    key={d.key}
                    to={d.route}
                    className={`flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-xs transition-colors ${
                      active
                        ? "bg-primary/25 text-primary"
                        : "text-foreground/80 hover:text-foreground hover:bg-muted/50"
                    }`}
                  >
                    <span>{d.emoji}</span>
                    <span className="font-heading font-semibold tracking-wider uppercase text-[10.5px]">
                      {d.name}
                    </span>
                  </Link>
                );
              })}
              <button
                onClick={() => {
                  setPickerOpen(true);
                  setMoreOpen(false);
                }}
                className="flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-xs text-primary hover:bg-primary/10 transition-colors mt-0.5 border-t border-border/40 pt-2"
              >
                <span>🌐</span>
                <span className="font-heading font-semibold tracking-wider uppercase text-[10.5px]">
                  See all worlds
                </span>
              </button>
            </div>
          )}
        </div>

        <div className="pointer-events-auto">
          <WorldPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
        </div>
      </nav>

      {/* Wallet + Vibe Profile — one pill, top-right, height-matched to the
          nav row. The balance shares the profile's pill rather than taking a
          fourth corner: on a phone there are only two free corners at the top,
          and the currency belongs next to the identity that holds it. */}
      <div className="fixed top-3 right-3 z-40 pointer-events-auto">
        <div
          className="glass-panel rounded-full border border-border/60 px-1.5 py-1 flex items-center gap-1"
          style={{
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
          }}
        >
          <VibeCoinChip />
          <span className="h-4 w-px bg-border/60" aria-hidden />
          <LogInWithVibe />
        </div>
      </div>
    </>
  );
}
