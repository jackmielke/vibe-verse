/**
 * Ammunition.
 *
 * Three reads, in the order a player wants them:
 *   - The magazine count, huge and tabular, so it never reflows while it
 *     counts down.
 *   - The magazine itself, as a strip of rounds. A number tells you "12"; the
 *     strip tells you "nearly empty" without being read.
 *   - The reserve, quiet, because it only matters between fights.
 *
 * Belt-fed weapons (200-round LMG) switch from discrete pips to a segmented
 * bar automatically — 200 pips is texture, not information.
 *
 * Ammo changes once per shot, which at 900 RPM is 15 store writes a second.
 * None of them are subscribed here: the store is polled non-reactively from
 * the shared rAF, and only the weapon *identity* drives a React render.
 */
import { useMemo, useRef } from "react";
import { sf, useSfStore } from "../../state/store";
import { hudTelemetry } from "../telemetry";
import { useUiFrame, setText, approach } from "../raf";
import { weaponUi } from "../weaponMeta";
import { useUiStore } from "../uiStore";
import { COLORS, cvdColor } from "../theme";

const PIP_W = 4;
const PIP_GAP = 2.6;
const BAR_SEGMENTS = 24;

export default function Ammo() {
  const weapon = useSfStore((s) => s.weapon);
  const cvd = useUiStore((s) => s.settings.colorblind);
  const meta = weaponUi(weapon);

  const magRef = useRef<HTMLSpanElement>(null);
  const resRef = useRef<HTMLSpanElement>(null);
  const pipRefs = useRef<(SVGRectElement | null)[]>([]);
  const reloadBar = useRef<HTMLDivElement>(null);
  const reloadWrap = useRef<HTMLDivElement>(null);
  const heatRef = useRef<HTMLDivElement>(null);
  const dryRef = useRef<HTMLDivElement>(null);
  const anim = useRef({ shown: 1, dry: 0, heat: 0 });

  // Discrete rounds while the magazine is small enough to count; a segmented
  // bar once it is not.
  const usePips = meta.pipLimit > 0 && meta.magazine <= meta.pipLimit;
  const cellCount = usePips ? Math.max(1, meta.magazine) : BAR_SEGMENTS;
  const stripW = cellCount * (PIP_W + PIP_GAP) - PIP_GAP;

  const cells = useMemo(
    () => Array.from({ length: cellCount }, (_, i) => i),
    [cellCount],
  );

  useUiFrame((now, dt) => {
    const s = sf();
    const store = s.ammo[weapon];
    // Telemetry wins when the weapon system is publishing it (it knows about
    // the chambered round mid-reload); the store is the fallback.
    const mag = hudTelemetry.magazine >= 0 ? hudTelemetry.magazine : store?.magazine ?? 0;
    const size =
      hudTelemetry.magazineSize > 0 ? hudTelemetry.magazineSize : meta.magazine;
    const reserve = hudTelemetry.reserve >= 0 ? hudTelemetry.reserve : store?.reserve ?? 0;
    const frac = size > 0 ? Math.max(0, Math.min(1, mag / size)) : 0;
    const a = anim.current;
    a.shown = approach(a.shown, frac, 22, dt);

    setText(magRef.current, String(Math.max(0, mag)));
    setText(resRef.current, String(Math.max(0, reserve)));

    const low = frac <= 0.25;
    const empty = mag <= 0;
    const hot = empty ? cvdColor("danger", cvd) : low ? cvdColor("warn", cvd) : "#ffffff";
    if (magRef.current) magRef.current.style.color = hot;

    // Empty-magazine blink. Fast enough to be urgent, slow enough to read.
    a.dry = empty && !s.reloading ? (Math.sin(now * 8) > 0 ? 1 : 0.25) : 0;
    if (dryRef.current) dryRef.current.style.opacity = a.dry.toFixed(2);

    for (let i = 0; i < cells.length; i++) {
      const el = pipRefs.current[i];
      if (!el) continue;
      const cellFrac = usePips
        ? (i < mag ? 1 : 0)
        : Math.max(0, Math.min(1, a.shown * BAR_SEGMENTS - i));
      // Pips near the end of the magazine warm up, so the last few rounds
      // are legible without reading the number.
      const nearEnd = usePips ? i < 3 : i < 4;
      const col = cellFrac <= 0.02 ? "rgba(255,255,255,0.10)" : nearEnd && low ? cvdColor("warn", cvd) : "#ffffff";
      el.style.fill = col;
      el.style.opacity = cellFrac <= 0.02 ? "1" : (0.55 + 0.45 * cellFrac).toFixed(2);
      if (!usePips) {
        el.style.transformOrigin = "center bottom";
        el.style.transform = `scaleY(${(0.3 + 0.7 * cellFrac).toFixed(3)})`;
      }
    }

    // Reload progress — a real bar under the magazine, not a spinner.
    const p = hudTelemetry.reloadProgress;
    const reloading = s.reloading && p > 0 && p < 1;
    if (reloadWrap.current) reloadWrap.current.style.opacity = reloading ? "1" : "0";
    if (reloadBar.current) reloadBar.current.style.width = `${(p * 100).toFixed(1)}%`;

    // Barrel heat — only visible once it matters.
    a.heat = approach(a.heat, hudTelemetry.weaponHeat, 10, dt);
    if (heatRef.current) {
      heatRef.current.style.opacity = a.heat > 0.12 ? Math.min(1, a.heat * 1.4).toFixed(2) : "0";
      heatRef.current.style.width = `${(a.heat * 100).toFixed(1)}%`;
    }
  });

  return (
    <div className="relative flex flex-col items-end" style={{ width: 240 }}>
      {/* Weapon identity */}
      <div className="flex items-center gap-2 mb-1">
        <span className="sf-label sf-text" style={{ fontSize: 9, letterSpacing: "0.24em" }}>
          {meta.cls.toUpperCase()}
        </span>
        <div className="h-px w-6" style={{ background: "rgba(255,255,255,0.2)" }} />
        <span
          className="sf-label sf-label-lit sf-text"
          style={{ fontSize: 10, letterSpacing: "0.2em", color: "rgba(255,255,255,0.9)" }}
        >
          {meta.name}
        </span>
        <svg width={18} height={18} viewBox="0 0 24 24" style={{ opacity: 0.7 }}>
          <path d={meta.icon} fill="#fff" />
        </svg>
      </div>

      {/* Counters */}
      <div className="flex items-end gap-2 relative">
        <div
          ref={dryRef}
          className="absolute sf-label"
          style={{
            right: 0,
            top: -14,
            fontSize: 9,
            letterSpacing: "0.3em",
            color: COLORS.danger,
            opacity: 0,
          }}
        >
          RELOAD
        </div>
        <span
          ref={magRef}
          className="sf-num sf-text-hard leading-none"
          style={{ fontSize: 46, fontWeight: 800, letterSpacing: "-0.05em" }}
        >
          30
        </span>
        <span
          className="sf-num sf-text leading-none pb-1.5"
          style={{ fontSize: 15, color: "rgba(255,255,255,0.34)" }}
        >
          /
        </span>
        <span
          ref={resRef}
          className="sf-num sf-text leading-none pb-1.5"
          style={{ fontSize: 19, fontWeight: 600, color: "rgba(255,255,255,0.62)" }}
        >
          120
        </span>
      </div>

      {/* Magazine strip */}
      <svg
        width={stripW}
        height={12}
        viewBox={`0 0 ${stripW} 12`}
        style={{ display: "block", marginTop: 6, filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.9))" }}
      >
        {cells.map((i) => (
          <rect
            key={i}
            ref={(el) => (pipRefs.current[i] = el)}
            x={i * (PIP_W + PIP_GAP)}
            y={0}
            width={PIP_W}
            height={12}
            rx={0.8}
          />
        ))}
      </svg>

      {/* Reload progress */}
      <div
        ref={reloadWrap}
        style={{
          width: stripW,
          height: 2,
          marginTop: 4,
          background: "rgba(255,255,255,0.12)",
          opacity: 0,
          transition: "opacity 120ms linear",
        }}
      >
        <div
          ref={reloadBar}
          style={{
            height: "100%",
            width: "0%",
            background: COLORS.signal,
            boxShadow: `0 0 10px ${COLORS.signal}`,
          }}
        />
      </div>

      {/* Barrel heat */}
      <div style={{ width: stripW, height: 2, marginTop: 3 }}>
        <div
          ref={heatRef}
          style={{
            height: "100%",
            width: "0%",
            opacity: 0,
            background: `linear-gradient(90deg, ${COLORS.warn}, ${COLORS.danger})`,
            transition: "opacity 160ms linear",
          }}
        />
      </div>
    </div>
  );
}
