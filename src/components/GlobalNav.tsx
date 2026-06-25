/**
 * GlobalNav — top nav with World chips (left/center) + Vibe Profile (right).
 *
 * The chip row shows: 🌐 Worlds (opens the full picker) + the 4 most
 * recently visited worlds + ⋯ More (everything else). Visiting any world
 * promotes it to the front of the recents list, so the row is always
 * "the worlds you actually hop between".
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

// Every hoppable world. Order = default recents seed (most-loved first).
const ALL_WORLDS: Destination[] = [
  { to: "/world", emoji: "🛋️", label: "VIBE World", matchPaths: ["/agent-lobby"] },
  { to: "/city", emoji: "🏙️", label: "City" },
  { to: "/edm-town", emoji: "🪩", label: "EDM Town" },
  { to: "/space", emoji: "🌌", label: "Space", matchPaths: ["/unit7"] },
  { to: "/evolve", emoji: "🧬", label: "Evolve", matchPaths: ["/bestiary"] },
  { to: "/garden", emoji: "🌱", label: "Garden", matchPaths: ["/gallery"] },
  { to: "/city?spawn=island", emoji: "🏝️", label: "Island" },
  { to: "/city?spawn=moon", emoji: "🌙", label: "Moon" },
  { to: "/hub", emoji: "🪐", label: "Hub" },
  { to: "/lobby", emoji: "🏎️", label: "Lobby" },
  { to: "/museum", emoji: "🖼️", label: "Museum" },
  { to: "/ninja", emoji: "🍉", label: "Fruit Ninja" },
  { to: "/coin", emoji: "🪙", label: "VIBE" },
  { to: "/about", emoji: "✨", label: "About" },
];

const RECENTS_KEY = "vibe.nav.recents";
const VISIBLE = 4;

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveRecents(list: string[]) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 12)));
  } catch {}
}

export default function GlobalNav() {
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => loadRecents());

  // Promote the current route to the front of the recents list whenever
  // it matches a known world.
  useEffect(() => {
    const currentKey =
      location.pathname === "/city" && location.search.includes("spawn=island")
        ? "/city?spawn=island"
        : location.pathname === "/city" && location.search.includes("spawn=moon")
          ? "/city?spawn=moon"
          : location.pathname;
    const isWorld = ALL_WORLDS.some((w) => w.to === currentKey);
    if (!isWorld) return;
    setRecents((prev) => {
      const next = [currentKey, ...prev.filter((k) => k !== currentKey)];
      saveRecents(next);
      return next;
    });
  }, [location.pathname, location.search]);

  // Collapse the dropdown / picker on any navigation.
  useEffect(() => {
    setMoreOpen(false);
    setPickerOpen(false);
  }, [location.pathname, location.search]);

  // Resolve recents → ordered list of Destinations, padded with the
  // default seed so we always show VISIBLE chips.
  const visible = useMemo<Destination[]>(() => {
    const byKey = new Map(ALL_WORLDS.map((w) => [w.to, w]));
    const ordered: Destination[] = [];
    const seen = new Set<string>();
    for (const key of recents) {
      const w = byKey.get(key);
      if (w && !seen.has(key)) {
        ordered.push(w);
        seen.add(key);
        if (ordered.length >= VISIBLE) break;
      }
    }
    for (const w of ALL_WORLDS) {
      if (ordered.length >= VISIBLE) break;
      if (!seen.has(w.to)) {
        ordered.push(w);
        seen.add(w.to);
      }
    }
    return ordered;
  }, [recents]);

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
      const wants = query?.includes("spawn=moon")
        ? "moon"
        : query?.includes("spawn=island")
          ? "island"
          : "city";
      const at = location.search.includes("spawn=moon")
        ? "moon"
        : location.search.includes("spawn=island")
          ? "island"
          : "city";
      return wants === at;
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
