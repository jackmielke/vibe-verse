/**
 * What it is actually like outside, right now, in the real San Francisco.
 *
 * The whole point of this chip is that it is checkable. A game that decides
 * it is foggy today has made a mood; a game that is foggy *because it is
 * foggy* has made a claim, and a claim is only worth anything if the player
 * can look out of a window and hold it to account. So this says the
 * temperature and the wind, not just "FOGGY" — the two numbers somebody can
 * disagree with.
 *
 * And when the report could not be fetched — offline, blocked, a dead API —
 * it says so, in as many words. The world still gets a plausible sky from the
 * month and the hour, which is a good deal better than a permanent noon, but
 * presenting climatology as an observation would be the one thing that makes
 * the honest version worthless.
 *
 * Sits under the minimap: the same corner already answers "where am I", and
 * this is the other half of the same question.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { frame } from "../../state/store";
import { currentReport, subscribeWeather } from "../../weather/service";
import { describeWeather, isFogCode, weatherDetail, worldWeather } from "../../weather/report";
import { clockTime12 } from "../format";
import { subscribeUiFrame, setText } from "../raf";
import { COLORS } from "../theme";
import { useUiStore } from "../uiStore";

/* ------------------------------------------------------------------ *
 * Glyphs
 * ------------------------------------------------------------------ */

/**
 * Drawn, not typed. The obvious implementation is a weather emoji, and it is
 * wrong for the same reason the wave emote had to grow a fallback: a font with
 * ☁ in colour is not something you get to assume, and a glyph that silently
 * fails to render leaves an empty box where the whole point of the component
 * was. Four paths cost nothing and look like the rest of this HUD.
 */
function Glyph({ kind, color }: { kind: "sun" | "cloud" | "fog" | "rain"; color: string }) {
  const common = {
    width: 15, height: 15, viewBox: "0 0 24 24", fill: "none",
    stroke: color, strokeWidth: 1.7, strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (kind === "sun") {
    return (
      <svg {...common} aria-hidden>
        <circle cx="12" cy="12" r="4.4" />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
          <line
            key={a}
            x1={12 + Math.cos((a * Math.PI) / 180) * 7.2}
            y1={12 + Math.sin((a * Math.PI) / 180) * 7.2}
            x2={12 + Math.cos((a * Math.PI) / 180) * 9.6}
            y2={12 + Math.sin((a * Math.PI) / 180) * 9.6}
          />
        ))}
      </svg>
    );
  }
  if (kind === "fog") {
    return (
      <svg {...common} aria-hidden>
        <line x1="3" y1="7.5" x2="21" y2="7.5" />
        <line x1="5" y1="12" x2="19" y2="12" />
        <line x1="3.5" y1="16.5" x2="20.5" y2="16.5" />
      </svg>
    );
  }
  const cloud = <path d="M7.2 17.5a4 4 0 0 1 .5-8 5.6 5.6 0 0 1 10.6 1.4 3.3 3.3 0 0 1-.7 6.6z" />;
  if (kind === "cloud") return <svg {...common} aria-hidden>{cloud}</svg>;
  return (
    <svg {...common} aria-hidden>
      {cloud}
      <line x1="9" y1="20" x2="8" y2="22.5" />
      <line x1="13" y1="20" x2="12" y2="22.5" />
      <line x1="17" y1="20" x2="16" y2="22.5" />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * The chip
 * ------------------------------------------------------------------ */

export default function WeatherChip() {
  const show = useUiStore((s) => s.settings.showMinimap);

  /* `useSyncExternalStore` rather than a `useState` in an effect: the report
     can land before this component mounts — the fetch starts inside the Canvas
     and the HUD is a sibling — and a subscribe-then-set would miss it and show
     nothing until the ten-minute refresh. */
  const report = useSyncExternalStore(subscribeWeather, currentReport, () => null);

  // The clock ticks 30× faster than real time, so it needs its own tick. Via
  // `setText` on a ref, like everything else in this HUD: this must not
  // re-render React 30 times a second.
  const [clockEl, setClockEl] = useState<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!clockEl) return;
    let acc = 0;
    return subscribeUiFrame((_, dt) => {
      acc += dt;
      if (acc < 0.5) return;
      acc = 0;
      setText(clockEl, clockTime12(frame.timeOfDay));
    });
  }, [clockEl]);

  if (!show || !report) return null;

  const w = worldWeather(report);
  const label = describeWeather(report, w);
  const foggy = w.groundFog > 0.35 || isFogCode(report.code);
  const kind = w.rain > 0.12 ? "rain" : foggy ? "fog" : w.cloud > 0.45 ? "cloud" : "sun";
  const tint =
    kind === "rain" ? COLORS.info : kind === "fog" ? COLORS.muted
    : kind === "sun" ? COLORS.warn : "rgba(255,255,255,0.8)";

  return (
    <div
      style={{ marginTop: 8, width: 178 }}
      title={
        report.source === "live"
          ? "Live conditions in San Francisco"
          : "Estimated from the season — the forecast could not be reached"
      }
    >
      <div className="flex items-center gap-2">
        <Glyph kind={kind} color={tint} />
        <span
          className="sf-label sf-text"
          style={{
            fontSize: 9,
            letterSpacing: "0.16em",
            color: "rgba(255,255,255,0.95)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {label.toUpperCase()}
        </span>
        <div className="flex-1" />
        {/* In-world time, which runs at 30× and is not the wall clock — but it
            started at the real hour in San Francisco, so early in a session it
            is both. */}
        <span
          ref={setClockEl}
          className="sf-num sf-text"
          style={{ fontSize: 9, color: COLORS.signal, whiteSpace: "nowrap" }}
        />
      </div>
      <span
        className="sf-label sf-text block"
        style={{
          fontSize: 8,
          letterSpacing: "0.2em",
          color: report.source === "live" ? "rgba(255,255,255,0.55)" : COLORS.mutedDim,
          whiteSpace: "nowrap",
        }}
      >
        {weatherDetail(report)}
        {report.source === "estimate" ? " · ESTIMATED" : ""}
      </span>
    </div>
  );
}
