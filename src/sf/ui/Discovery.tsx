/**
 * Landmark discovery.
 *
 * Two jobs in one small module:
 *   1. Detect that the player has physically reached a landmark for the first
 *      time. This is a UI concern rather than a gameplay one — nothing in the
 *      simulation changes — and it is cheap: 22 squared-distance tests twice
 *      a second against `LANDMARKS`, the same table the meshes are built from.
 *   2. Show it properly. A discovery is one of the few moments this game
 *      stops to celebrate, so it gets a full centre-screen card, a real
 *      entrance, and the landmark's actual height and district.
 *
 * The store owns the discovered list, so reloading the page keeps whatever
 * the session has found, and other systems (achievements, the map's found
 * count) read the same array.
 */
import { useEffect, useRef, useState } from "react";
import { LANDMARKS, districtAt, type LandmarkDef } from "../geo/sfGeo";
import { frame, useSfStore } from "../state/store";
import { useUiFrame } from "./raf";
import { COLORS, rgba } from "./theme";

/** How close counts as "visited". Uses each landmark's own radius, which is
 *  authored for exactly this kind of proximity test, with a floor so the
 *  small ones are still reachable. */
function reachRadius(lm: LandmarkDef): number {
  return Math.max(45, lm.radius * 0.6);
}

interface Card {
  key: string;
  name: string;
  district: string;
  height: number;
  /** 1 → 0 life. */
  t: number;
}

export default function Discovery() {
  const discovered = useSfStore((s) => s.discovered);
  const discover = useSfStore((s) => s.discover);
  const notify = useSfStore((s) => s.notify);
  const addChaos = useSfStore((s) => s.addChaos);
  const [card, setCard] = useState<Card | null>(null);

  const acc = useRef(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const life = useRef(0);
  const discoveredRef = useRef<string[]>(discovered);
  discoveredRef.current = discovered;

  useUiFrame((_, dt) => {
    // --- detection (2 Hz) ---
    acc.current += dt;
    if (acc.current > 0.5) {
      acc.current = 0;
      const px = frame.position.x;
      const pz = frame.position.z;
      for (const lm of LANDMARKS) {
        if (discoveredRef.current.includes(lm.key)) continue;
        const dx = lm.x - px;
        const dz = lm.z - pz;
        const r = reachRadius(lm);
        if (dx * dx + dz * dz > r * r) continue;
        discover(lm.key);
        // Discovery is worth chaos: exploring San Francisco is a legitimate
        // way to play, and the score should say so.
        addChaos(75, `DISCOVERED ${lm.name.toUpperCase()}`);
        notify(lm.name, "unlock", 75);
        setCard({
          key: lm.key,
          name: lm.name,
          district: districtAt(lm.x, lm.z).name,
          height: lm.height,
          t: 1,
        });
        life.current = 1;
        break; // one at a time; two cards at once is a mess
      }
    }

    // --- card life ---
    if (life.current > 0) {
      life.current = Math.max(0, life.current - dt / 4.2);
      const el = cardRef.current;
      if (el) {
        const t = life.current;
        // Fast in over the first 12%, hold, then fade over the last 20%.
        const inA = Math.min(1, (1 - t) / 0.12);
        const outA = Math.min(1, t / 0.2);
        el.style.opacity = (inA * outA).toFixed(3);
        el.style.transform = `translate(-50%,-50%) scale(${(0.96 + 0.04 * inA).toFixed(3)})`;
      }
      if (life.current === 0) setCard(null);
    }
  });

  useEffect(() => {
    if (card) life.current = 1;
  }, [card]);

  if (!card) return null;

  return (
    <div
      ref={cardRef}
      className="fixed pointer-events-none"
      style={{
        left: "50%",
        top: "38%",
        transform: "translate(-50%,-50%)",
        zIndex: 32,
        opacity: 0,
        width: 420,
      }}
    >
      <div className="flex flex-col items-center text-center">
        <span className="sf-label" style={{ fontSize: 8, letterSpacing: "0.42em", color: COLORS.signal }}>
          LANDMARK DISCOVERED
        </span>

        <div
          className="my-3"
          style={{
            width: 260,
            height: 1,
            background: `linear-gradient(90deg, transparent, ${COLORS.signal}, transparent)`,
            boxShadow: `0 0 18px ${rgba(COLORS.signal, 0.8)}`,
          }}
        />

        <span
          className="sf-display sf-text-hard"
          style={{ fontSize: 34, lineHeight: 1.05, letterSpacing: "-0.02em" }}
        >
          {card.name}
        </span>

        <div className="flex items-center gap-3 mt-2">
          <span className="sf-label sf-text" style={{ fontSize: 9, letterSpacing: "0.24em" }}>
            {card.district.toUpperCase()}
          </span>
          <div style={{ width: 3, height: 3, background: "rgba(255,255,255,0.4)" }} />
          <span className="sf-num sf-text" style={{ fontSize: 10, color: "rgba(255,255,255,0.6)" }}>
            {`${Math.round(card.height)} M`}
          </span>
          <div style={{ width: 3, height: 3, background: "rgba(255,255,255,0.4)" }} />
          <span className="sf-num sf-text" style={{ fontSize: 10, color: COLORS.chaos }}>
            +75 CHAOS
          </span>
        </div>
      </div>
    </div>
  );
}
