/**
 * GlobalNav — small top-center pill row of destination chips that
 * lives on every route so the user always has one-click access to
 * the village, lobby, outer-space, and about pages.
 *
 * Each chip shows an emoji + (on wider screens) a short label.
 * The current route is highlighted. On the village (`/`) we hide
 * the chip for `/` since BrandHeader already brands that page —
 * the rest stay so you can flip in from anywhere.
 *
 * Positioned at top-center so it doesn't collide with top-left
 * page headers (BrandHeader, back arrows) or top-right panels
 * (chat panels, menus).
 */
import { Link, useLocation } from "react-router-dom";

interface Destination {
  to: string;
  emoji: string;
  label: string;
  shortLabel?: string; // optional shorter mobile label
  matchPaths?: string[]; // additional paths that should highlight this dest
}

const DESTINATIONS: Destination[] = [
  { to: "/", emoji: "🗺️", label: "Village" },
  { to: "/lobby", emoji: "🏎️", label: "Lobby" },
  { to: "/space", emoji: "🌌", label: "Space", matchPaths: ["/unit7"] },
  { to: "/garden", emoji: "🌱", label: "Garden", matchPaths: ["/gallery"] },
  { to: "/vibe", emoji: "🪙", label: "VIBE" },
  { to: "/about", emoji: "✨", label: "About" },
];

export default function GlobalNav() {
  const location = useLocation();

  const isActive = (d: Destination) => {
    if (location.pathname === d.to) return true;
    if (d.matchPaths?.includes(location.pathname)) return true;
    return false;
  };

  return (
    <nav
      // top-center, non-blocking pointer-events on the wrapper so any
      // hidden background interactions (e.g. canvas hover) still work.
      className="fixed top-3 left-1/2 -translate-x-1/2 z-40 pointer-events-none"
      aria-label="Primary destinations"
    >
      <div
        className="glass-panel rounded-full border border-border/60 px-1.5 py-1 flex items-center gap-1 pointer-events-auto"
        style={{
          // Subtle gradient hint that this is the global navigator,
          // distinct from in-page panels.
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
        }}
      >
        {DESTINATIONS.map((d) => {
          const active = isActive(d);
          return (
            <Link
              key={d.to}
              to={d.to}
              className={`group relative flex items-center gap-1.5 rounded-full px-2 sm:px-2.5 py-1.5 transition-all ${
                active
                  ? "bg-primary/25 text-primary shadow-[0_0_18px_hsl(var(--primary)/0.35)]"
                  : "text-foreground/75 hover:text-foreground hover:bg-muted/50"
              }`}
              title={d.label}
              aria-current={active ? "page" : undefined}
            >
              <span className="text-sm leading-none">{d.emoji}</span>
              <span
                className={`text-[10.5px] font-heading font-semibold tracking-wider uppercase leading-none hidden sm:inline ${
                  active ? "" : ""
                }`}
              >
                {d.shortLabel ?? d.label}
              </span>
              {active && (
                <span
                  className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary"
                  aria-hidden
                />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
