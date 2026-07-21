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

interface Destination {
  to: string;
  emoji: string;
  label: string;
  matchPaths?: string[];
}

// Every hoppable world. Order = stable header order.
const ALL_WORLDS: Destination[] = [
  { to: "/character-select", emoji: "🧍", label: "Characters", matchPaths: ["/characters", "/profile", "/lobby"] },
  { to: "/city?spawn=island", emoji: "🏝️", label: "Island" },
  { to: "/city?spawn=ski", emoji: "⛷️", label: "Ski" },
  { to: "/world", emoji: "🛋️", label: "VIBE World", matchPaths: ["/agent-lobby"] },
  { to: "/city", emoji: "🏙️", label: "City" },
  { to: "/space", emoji: "🌌", label: "Space", matchPaths: ["/unit7"] },
  { to: "/edm-town", emoji: "🪩", label: "EDM Town" },
  { to: "/evolve", emoji: "🧬", label: "Evolve", matchPaths: ["/bestiary"] },
  { to: "/garden", emoji: "🌱", label: "Garden", matchPaths: ["/gallery"] },
  { to: "/go", emoji: "🧭", label: "Vibe GO" },
  { to: "/city?spawn=vibestar", emoji: "⭐", label: "Vibe Star" },
  { to: "/city?spawn=moon", emoji: "🌙", label: "Moon" },
  { to: "/hub", emoji: "🪐", label: "Hub" },
  { to: "/lobby", emoji: "🏎️", label: "Lobby" },
  { to: "/museum", emoji: "🖼️", label: "Museum" },
  { to: "/ninja", emoji: "🍉", label: "Fruit Ninja" },
  { to: "/coin", emoji: "🪙", label: "VIBE" },
  { to: "/about", emoji: "✨", label: "About" },
];

const VISIBLE = 5;

export default function GlobalNav() {
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // /start is the first sixty seconds of the VibeVerse — Vibey hosts it
  // full-bleed, so the world chips and profile pill stay out of frame.
  const onboarding = location.pathname === "/start";
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
    () => ALL_WORLDS.filter((w) => !visible.some((v) => v.to === w.to)),
    [visible]
  );

  const isActive = (d: Destination) => {
    const [path, query] = d.to.split("?");
    const pathHit =
      location.pathname === path || !!d.matchPaths?.includes(location.pathname);
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

  if (onboarding || embedded) return null;

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
          <Link
            to="/"
            className={chipClass(location.pathname === "/")}
            title="World selector"
            aria-current={location.pathname === "/" ? "page" : undefined}
          >
            <span className="text-sm leading-none">🌐</span>
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
                  key={d.to}
                  to={d.to}
                  className={chipClass(active)}
                  title={d.label}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="text-sm leading-none">{d.emoji}</span>
                  <span className={labelClass}>{d.label}</span>
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
                    key={d.to}
                    to={d.to}
                    className={`flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-xs transition-colors ${
                      active
                        ? "bg-primary/25 text-primary"
                        : "text-foreground/80 hover:text-foreground hover:bg-muted/50"
                    }`}
                  >
                    <span>{d.emoji}</span>
                    <span className="font-heading font-semibold tracking-wider uppercase text-[10.5px]">
                      {d.label}
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

      {/* Vibe Profile — own pill, top-right, height-matched to the nav row. */}
      <div className="fixed top-3 right-3 z-40 pointer-events-auto">
        <div
          className="glass-panel rounded-full border border-border/60 px-1.5 py-1 flex items-center"
          style={{
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
          }}
        >
          <LogInWithVibe />
        </div>
      </div>
    </>
  );
}
