/**
 * The way back out.
 *
 * `/sf` is one world inside the Vibeverse, and a player who wanders in should
 * always be able to wander back. But an exit affordance that sits on screen
 * during a firefight is a bug: it competes with the HUD, it is one mis-click
 * from ending the session, and it breaks the fiction.
 *
 * So the rule is simple — this is visible whenever the game is NOT being
 * played (menu, pause, death, loading, or with the HUD deliberately hidden),
 * and it is completely absent the rest of the time. It also fades itself in
 * for the first few seconds after arrival, which is exactly when a new
 * visitor wants to know they can leave.
 */
import { useEffect, useState } from "react";
import { useSfStore } from "../state/store";
import { useUiStore } from "./uiStore";
import { COLORS, rgba } from "./theme";

/** Sibling worlds worth surfacing. Kept short on purpose: this is a doorway,
 *  not a navigation bar. */
const WORLDS: { href: string; label: string; blurb: string }[] = [
  { href: "/", label: "HUB", blurb: "Every world" },
  { href: "/city", label: "LIVE CITY", blurb: "The original" },
  { href: "/island", label: "ISLAND", blurb: "Explorer" },
  { href: "/space", label: "UNIT 7", blurb: "Orbital" },
];

export default function VibeverseChrome() {
  const phase = useSfStore((s) => s.phase);
  const route = useUiStore((s) => s.route);
  const [expanded, setExpanded] = useState(false);
  const [grace, setGrace] = useState(true);

  // A short welcome window. After it lapses the chrome obeys the normal rule.
  useEffect(() => {
    const id = setTimeout(() => setGrace(false), 5200);
    return () => clearTimeout(id);
  }, []);

  const playing = phase === "playing" && route === "none";
  const visible = !playing || grace;

  if (phase === "loading") return null;

  return (
    <div
      className="fixed"
      style={{
        left: 0,
        bottom: 0,
        zIndex: 15,
        pointerEvents: visible ? "auto" : "none",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(10px)",
        transition: "opacity var(--sf-dur) var(--sf-ease), transform var(--sf-dur) var(--sf-ease)",
      }}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
    >
      <div
        className="flex items-end"
        style={{
          padding: "10px 14px",
          background: "linear-gradient(0deg, rgba(4,5,8,0.9), rgba(4,5,8,0))",
        }}
      >
        <a
          href="/"
          className="sf-pe flex items-center gap-2"
          style={{ textDecoration: "none" }}
          title="Back to the Vibeverse"
        >
          <svg width={14} height={14} viewBox="0 0 14 14" style={{ flexShrink: 0 }}>
            {/* A small mark: three orbits, one signal dot. */}
            <circle cx={7} cy={7} r={6} fill="none" stroke={rgba(COLORS.signal, 0.55)} strokeWidth={1} />
            <ellipse cx={7} cy={7} rx={6} ry={2.4} fill="none" stroke={rgba(COLORS.signal, 0.35)} strokeWidth={1} />
            <circle cx={7} cy={7} r={1.8} fill={COLORS.signal} />
          </svg>
          <span
            className="sf-label"
            style={{ fontSize: 8, letterSpacing: "0.28em", color: "rgba(255,255,255,0.62)" }}
          >
            VIBEVERSE
          </span>
        </a>

        <div
          className="flex items-center gap-1 overflow-hidden"
          style={{
            marginLeft: expanded ? 12 : 0,
            maxWidth: expanded ? 420 : 0,
            opacity: expanded ? 1 : 0,
            transition:
              "max-width var(--sf-dur-slow) var(--sf-ease), opacity var(--sf-dur) var(--sf-ease), margin var(--sf-dur) var(--sf-ease)",
          }}
        >
          <div style={{ width: 1, height: 14, background: "rgba(255,255,255,0.16)", marginRight: 8 }} />
          {WORLDS.map((w) => (
            <a
              key={w.href}
              href={w.href}
              className="sf-chip sf-pe"
              style={{ textDecoration: "none", whiteSpace: "nowrap" }}
              title={w.blurb}
            >
              {w.label}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
