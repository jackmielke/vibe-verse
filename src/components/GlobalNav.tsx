/**
 * GlobalNav — top-center pill row of destination chips on every route.
 *
 * Kept deliberately uncrowded: a 🌐 Worlds chip (opens the full
 * world-picker gallery), five hero destinations, and a ⋯ chip that
 * expands the rest in a dropdown. Add new worlds to MORE (or the
 * picker) — PRIMARY stays capped so the bar never scrunches again.
 *
 * The Island chip is a shortcut into Vibe City with ?spawn=island —
 * same world, lands you straight on the Cardboard Island lawn.
 *
 * Positioned at top-center so it doesn't collide with top-left
 * page headers (BrandHeader, back arrows) or top-right panels
 * (chat panels, menus).
 */
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import WorldPicker from "@/components/WorldPicker";

interface Destination {
  to: string;
  emoji: string;
  label: string;
  matchPaths?: string[]; // additional paths that should highlight this dest
}

const PRIMARY: Destination[] = [
  { to: "/space", emoji: "🌌", label: "Space", matchPaths: ["/unit7"] },
  { to: "/evolve", emoji: "🧬", label: "Evolve", matchPaths: ["/bestiary"] },
  { to: "/garden", emoji: "🌱", label: "Garden", matchPaths: ["/gallery"] },
  { to: "/city", emoji: "🏙️", label: "City" },
  { to: "/city?spawn=island", emoji: "🏝️", label: "Island" },
  { to: "/city?spawn=moon", emoji: "🌙", label: "Moon" },
];

const MORE: Destination[] = [
  { to: "/edm-town", emoji: "🪩", label: "EDM Town" },
  { to: "/hub", emoji: "🪐", label: "Hub" },
  { to: "/hub-old", emoji: "🌠", label: "Hub Old" },
  { to: "/", emoji: "🗺️", label: "Village" },
  { to: "/lobby", emoji: "🏎️", label: "Lobby" },
  { to: "/museum", emoji: "🖼️", label: "Museum" },
  { to: "/ninja", emoji: "🍉", label: "Fruit Ninja" },
  { to: "/vibe", emoji: "🪙", label: "VIBE" },
  { to: "/about", emoji: "✨", label: "About" },
];

export default function GlobalNav() {
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Navigating anywhere collapses the dropdown and the picker.
  useEffect(() => {
    setMoreOpen(false);
    setPickerOpen(false);
  }, [location.pathname, location.search]);

  const isActive = (d: Destination) => {
    const [path, query] = d.to.split("?");
    const pathHit = location.pathname === path || !!d.matchPaths?.includes(location.pathname);
    if (!pathHit) return false;
    // City, Island and Moon all share /city — the spawn query decides.
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
          <Link
            to="/"
            className={chipClass(location.pathname === "/")}
            title="All worlds"
            aria-current={location.pathname === "/" ? "page" : undefined}
          >
            <span className="text-sm leading-none">🌐</span>
            <span className={labelClass}>Worlds</span>
          </Link>


          {PRIMARY.map((d) => {
            const active = isActive(d);
            return (
              <Link key={d.to} to={d.to} className={chipClass(active)} title={d.label}
                aria-current={active ? "page" : undefined}>
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
            className={chipClass(moreOpen || MORE.some(isActive))}
            title="More worlds"
            aria-expanded={moreOpen}
          >
            <span className="text-sm leading-none">⋯</span>
          </button>
        </div>

        {moreOpen && (
          <div className="absolute top-full right-0 mt-2 glass-panel rounded-2xl border border-border/60 p-1.5 flex flex-col gap-0.5 min-w-[10rem]">
            {MORE.map((d) => {
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
          </div>
        )}
      </div>

      <div className="pointer-events-auto">
        <WorldPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
      </div>
    </nav>
  );
}
