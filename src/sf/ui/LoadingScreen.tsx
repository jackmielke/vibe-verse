/**
 * The loading screen.
 *
 * Real progress, real art direction. The skyline is not stock art: it is
 * generated from the same seeded RNG the world uses, with the actual
 * landmark heights from `LANDMARKS` punched into it at their true relative
 * positions, so the silhouette you stare at while it loads is the silhouette
 * you are about to fly through. Behind it, three parallax bands of Karl the
 * Fog, because that is what San Francisco looks like most mornings.
 *
 * Progress comes from `useSfStore.loadProgress` — if a loader publishes
 * nothing, the bar stays honest and does not fake motion. A lying progress
 * bar is worse than no progress bar.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { WORLD_SEED } from "../config";
import { LANDMARKS, WORLD } from "../geo/sfGeo";
import { useSfStore } from "../state/store";
import { makeRng } from "../math/rng";
import { useUiFrame, setText } from "./raf";
import { COLORS, rgba } from "./theme";

/* ------------------------------------------------------------------ *
 * Tips
 * ------------------------------------------------------------------ */

const TIPS: { title: string; body: string }[] = [
  {
    title: "TWO TETHERS",
    body: "You have two grapples. Anchoring both to the same rooftop and reeling turns a fall into a slingshot.",
  },
  {
    title: "MARKET STREET",
    body: "The grid changes angle at Market. If the streets suddenly line up differently, you have crossed it.",
  },
  {
    title: "STALL SPEED",
    body: "The wingsuit needs airspeed to make lift. Trade altitude for speed early, not late.",
  },
  {
    title: "THE HILLS ARE THE LEVEL",
    body: "Twin Peaks is 282 metres. Everything downhill of it is a wingsuit run.",
  },
  {
    title: "HEAT DECAYS",
    body: "Break contact for twenty seconds and the city stops looking for you. Keep shooting and it escalates instead.",
  },
  {
    title: "FOG IS COVER",
    body: "The marine layer rolls in off the Pacific most afternoons. It cuts sightlines both ways.",
  },
  {
    title: "HIJACK ANYTHING",
    body: "Grapple a moving vehicle and reel in. Landing on the roof counts as an entrance.",
  },
  {
    title: "PULL UP",
    body: "The ground-proximity warning is driven by time to impact, not altitude. If it is screaming, you have under a second.",
  },
  {
    title: "CHAOS IS A CURRENCY",
    body: "Every destroyed generator, tanker and billboard pays out. Heat is the interest rate.",
  },
  {
    title: "LOOK FOR THE PYRAMID",
    body: "The Transamerica Pyramid is visible from most of the city. When you are lost, it is 260 metres of compass.",
  },
  {
    title: "DISCOVERY PAYS",
    body: "Twenty-two landmarks, all at their true coordinates. Reaching one for the first time is worth chaos.",
  },
  {
    title: "PARACHUTE OVER WATER",
    body: "The bay will not kill you, but Alcatraz is a long swim. Deploy early and steer.",
  },
];

/* ------------------------------------------------------------------ *
 * Skyline
 * ------------------------------------------------------------------ */

interface Block {
  x: number;
  w: number;
  h: number;
  /** 0 = far band, 2 = near band. */
  band: number;
  /** Deterministic window lighting seed. */
  lit: number;
  landmark?: string;
}

/**
 * Build the silhouette once. Seeded from `WORLD_SEED`, so the loading screen
 * is byte-identical on every machine — which also means the screenshot
 * harness gets a stable image.
 */
function buildSkyline(): Block[] {
  const rng = makeRng(`${WORLD_SEED}:loading-skyline`);
  const blocks: Block[] = [];

  // Filler blocks per band, back to front.
  for (let band = 0; band < 3; band++) {
    let x = -4;
    const maxH = band === 0 ? 26 : band === 1 ? 40 : 62;
    const minH = band === 0 ? 8 : band === 1 ? 12 : 16;
    while (x < 104) {
      const w = rng.range(2.2, 7.5);
      const h = rng.range(minH, maxH) * (0.7 + 0.3 * Math.sin(x * 0.11 + band));
      blocks.push({ x, w, h, band, lit: rng.next() });
      x += w + rng.range(0.4, 2.2);
    }
  }

  // The real skyline, placed by true world position so the Transamerica
  // Pyramid and Salesforce Tower stand where they actually stand.
  const spanX = WORLD.maxX - WORLD.minX;
  for (const lm of LANDMARKS) {
    if (lm.height < 55) continue;
    const t = (lm.x - WORLD.minX) / spanX;
    blocks.push({
      x: 4 + t * 92,
      w: Math.max(2.4, Math.min(9, lm.radius * 0.03)),
      h: 16 + (lm.height / 326) * 74,
      band: 2,
      lit: 0.9,
      landmark: lm.key,
    });
  }

  return blocks.sort((a, b) => a.band - b.band);
}

export default function LoadingScreen() {
  const phase = useSfStore((s) => s.phase);
  const progress = useSfStore((s) => s.loadProgress);
  const label = useSfStore((s) => s.loadLabel);
  const open = phase === "loading";

  const [tip, setTip] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  const pctRef = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
  const fogRefs = useRef<(HTMLDivElement | null)[]>([]);

  const skyline = useMemo(buildSkyline, []);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setTip((t) => (t + 1) % TIPS.length), 6500);
    return () => clearInterval(id);
  }, [open]);

  useUiFrame((now, dt) => {
    // Ease toward the true value. Never ahead of it — the bar may lag, it may
    // never lead.
    const target = Math.max(0, Math.min(1, progress));
    shown.current += (target - shown.current) * Math.min(1, dt * 5);
    if (target - shown.current < 0.002) shown.current = target;
    if (barRef.current) barRef.current.style.width = `${(shown.current * 100).toFixed(2)}%`;
    setText(pctRef.current, `${Math.floor(shown.current * 100)}`);

    // Fog drift. Three bands, different speeds — the cheapest convincing
    // parallax there is.
    for (let i = 0; i < 3; i++) {
      const el = fogRefs.current[i];
      if (!el) continue;
      const speed = 6 + i * 9;
      el.style.transform = `translateX(${(((now * speed) % 200) - 100).toFixed(2)}px)`;
    }
  }, open);

  if (!open) return null;

  const t = TIPS[tip];

  return (
    <div
      className="fixed inset-0 sf-pe"
      style={{
        zIndex: 70,
        background:
          "linear-gradient(180deg, #1a1410 0%, #2c1d16 22%, #533022 44%, #8a4a2b 62%, #0a0c11 100%)",
      }}
    >
      {/* Sun — low, warm, doing the work of the whole palette. */}
      <div
        className="absolute"
        style={{
          left: "68%",
          top: "44%",
          width: 460,
          height: 460,
          transform: "translate(-50%,-50%)",
          borderRadius: "50%",
          background: `radial-gradient(circle, ${rgba("#ffb46a", 0.85)} 0%, ${rgba(COLORS.signal, 0.35)} 34%, transparent 68%)`,
          filter: "blur(6px)",
        }}
      />

      {/* Skyline */}
      <svg
        className="absolute left-0 right-0"
        style={{ bottom: 0, width: "100%", height: "58%" }}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        {[0, 1, 2].map((band) => (
          <g key={band} opacity={band === 0 ? 0.32 : band === 1 ? 0.55 : 1}>
            {skyline
              .filter((b) => b.band === band)
              .map((b, i) => (
                <rect
                  key={`${band}-${i}`}
                  x={b.x}
                  y={100 - b.h}
                  width={b.w}
                  height={b.h}
                  fill={band === 0 ? "#2a2118" : band === 1 ? "#161310" : "#080809"}
                />
              ))}
          </g>
        ))}
      </svg>

      {/* Fog bands */}
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          ref={(el) => (fogRefs.current[i] = el)}
          className="absolute"
          style={{
            left: "-20%",
            right: "-20%",
            bottom: `${6 + i * 9}%`,
            height: `${16 + i * 5}%`,
            background: `linear-gradient(90deg, transparent, ${rgba("#cbd5e1", 0.1 + i * 0.05)} 30%, ${rgba("#cbd5e1", 0.05)} 62%, transparent)`,
            filter: `blur(${18 + i * 10}px)`,
            pointerEvents: "none",
          }}
        />
      ))}

      {/* Vignette + grain */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ boxShadow: "inset 0 0 320px 60px rgba(0,0,0,0.8)" }}
      />

      {/* Title block */}
      <div className="absolute" style={{ left: 72, top: 88 }}>
        <div className="flex items-center gap-3 mb-3">
          <div style={{ width: 44, height: 2, background: COLORS.signal }} />
          <span className="sf-label" style={{ fontSize: 9, letterSpacing: "0.44em", color: COLORS.signal }}>
            VIBEVERSE
          </span>
        </div>
        <h1
          className="sf-display"
          style={{
            fontSize: 74,
            lineHeight: 0.86,
            letterSpacing: "-0.045em",
            textShadow: "0 6px 40px rgba(0,0,0,0.8)",
          }}
        >
          SAN
          <br />
          FRANCISCO
        </h1>
        <div className="flex items-baseline gap-3 mt-2">
          <span
            className="sf-display"
            style={{ fontSize: 26, letterSpacing: "0.2em", color: COLORS.signal }}
          >
            FREE FALL
          </span>
        </div>
      </div>

      {/* Tip */}
      <div
        key={tip}
        className="absolute sf-anim-rise"
        style={{ left: 72, bottom: 168, maxWidth: 420 }}
      >
        <span className="sf-label" style={{ fontSize: 8, letterSpacing: "0.3em", color: COLORS.signal }}>
          {t.title}
        </span>
        <p
          className="sf-text mt-2"
          style={{ fontSize: 13, lineHeight: 1.6, color: "rgba(255,255,255,0.78)" }}
        >
          {t.body}
        </p>
      </div>

      {/* Progress */}
      <div className="absolute" style={{ left: 72, right: 72, bottom: 68 }}>
        <div className="flex items-baseline gap-3 mb-2">
          <span
            className="sf-num"
            style={{ fontSize: 13, color: "rgba(255,255,255,0.9)", letterSpacing: "0.04em" }}
          >
            <span ref={pctRef}>0</span>
            <span style={{ color: "rgba(255,255,255,0.35)" }}>%</span>
          </span>
          <span className="sf-label" style={{ fontSize: 9, letterSpacing: "0.24em" }}>
            {label}
          </span>
          <div className="flex-1" />
          <span className="sf-label" style={{ fontSize: 8, letterSpacing: "0.24em", opacity: 0.5 }}>
            {`${LANDMARKS.length} LANDMARKS · 24 DISTRICTS · 9.8 KM²`}
          </span>
        </div>
        <div
          className="sf-sweep"
          style={{ height: 2, background: "rgba(255,255,255,0.12)", position: "relative" }}
        >
          <div
            ref={barRef}
            style={{
              height: "100%",
              width: "0%",
              background: `linear-gradient(90deg, ${COLORS.signalDeep}, ${COLORS.signalBright})`,
              boxShadow: `0 0 16px ${rgba(COLORS.signal, 0.9)}`,
              position: "relative",
              zIndex: 1,
            }}
          />
        </div>
      </div>
    </div>
  );
}
