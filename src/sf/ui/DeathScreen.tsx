/**
 * Death and respawn.
 *
 * The failure state should feel like a hard stop, not a menu. So: the world
 * desaturates behind a heavy scrim, the type is enormous, and there is a
 * mandatory beat before the respawn control becomes live — long enough to
 * register what happened, short enough not to punish.
 *
 * Respawn puts the player back at a real San Francisco spawn point from
 * `SPAWNS`, and lets them pick which one. Choosing where to re-enter the city
 * is part of the sandbox, not an inconvenience.
 */
import { useEffect, useRef, useState } from "react";
import { SPAWNS, terrainHeight } from "../geo/sfGeo";
import { frame, resetFrame, sf, useSfStore } from "../state/store";
import { resetPostFx } from "../postfx/state";
import { useUiFrame } from "./raf";
import { useUiStore } from "./uiStore";
import { clearHudEvents, resetTelemetry } from "./telemetry";
import { COLORS, rgba } from "./theme";
import { compact } from "./format";

/** Seconds before the respawn control unlocks. */
const HOLD = 1.6;

export default function DeathScreen() {
  const phase = useSfStore((s) => s.phase);
  const respawn = useSfStore((s) => s.respawn);
  const chaos = useSfStore((s) => s.chaos);
  const heat = useSfStore((s) => s.heat);
  const [ready, setReady] = useState(false);
  const [spawn, setSpawn] = useState<string>(SPAWNS[0].key);
  const t = useRef(0);
  const barRef = useRef<HTMLDivElement>(null);

  const open = phase === "dead";

  useEffect(() => {
    if (!open) {
      t.current = 0;
      setReady(false);
      return;
    }
    // Freeze the sim while dead; the player is not driving anything.
    frame.paused = true;
    document.exitPointerLock?.();
    return () => {
      frame.paused = false;
    };
  }, [open]);

  useUiFrame((_, dt) => {
    if (!open) return;
    t.current += dt;
    if (barRef.current) {
      barRef.current.style.width = `${Math.min(100, (t.current / HOLD) * 100).toFixed(1)}%`;
    }
    if (!ready && t.current >= HOLD) setReady(true);
  }, open);

  const doRespawn = () => {
    if (!ready) return;
    const sp = SPAWNS.find((s) => s.key === spawn) ?? SPAWNS[0];
    resetFrame(sp.x, terrainHeight(sp.x, sp.z) + sp.yOffset, sp.z, sp.heading);
    resetTelemetry();
    clearHudEvents();
    resetPostFx();
    useUiStore.getState().go("none");
    respawn();
    frame.paused = false;
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "Enter") {
        e.preventDefault();
        doRespawn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!open) return null;

  const state = sf();

  return (
    <div
      className="fixed inset-0 sf-pe sf-anim-fade"
      style={{
        zIndex: 62,
        background:
          "radial-gradient(ellipse at 50% 40%, rgba(40,4,0,0.55) 0%, rgba(2,2,4,0.94) 62%, #000 100%)",
        backdropFilter: "grayscale(0.85) blur(3px)",
        WebkitBackdropFilter: "grayscale(0.85) blur(3px)",
      }}
    >
      <div
        className="absolute"
        style={{ left: "50%", top: "36%", transform: "translate(-50%,-50%)", textAlign: "center" }}
      >
        <span
          className="sf-display"
          style={{
            fontSize: 92,
            lineHeight: 0.9,
            letterSpacing: "-0.05em",
            color: "#fff",
            textShadow: `0 0 80px ${rgba(COLORS.danger, 0.55)}, 0 6px 30px rgba(0,0,0,1)`,
          }}
        >
          YOU DIED
        </span>
        <div
          className="mt-4 mx-auto"
          style={{
            width: 240,
            height: 1,
            background: `linear-gradient(90deg, transparent, ${COLORS.danger}, transparent)`,
          }}
        />
        <div className="flex items-center justify-center gap-8 mt-5">
          <Stat label="CHAOS" value={compact(chaos)} tint={COLORS.chaos} />
          <Stat label="HEAT AT DEATH" value={String(Math.round(heat))} tint={COLORS.heat} />
          <Stat label="DISCOVERED" value={`${state.discovered.length}`} tint="#fff" />
        </div>
      </div>

      <div
        className="absolute"
        style={{ left: "50%", bottom: 84, transform: "translateX(-50%)", width: 620 }}
      >
        <div className="flex items-center gap-2 mb-3">
          <span className="sf-label" style={{ fontSize: 8, letterSpacing: "0.3em" }}>
            RE-ENTRY POINT
          </span>
          <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.14)" }} />
        </div>

        <div className="flex flex-wrap gap-1.5 mb-5">
          {SPAWNS.map((s) => (
            <button
              key={s.key}
              className="sf-chip"
              data-on={s.key === spawn ? "1" : "0"}
              onClick={() => setSpawn(s.key)}
              title={s.blurb}
            >
              {s.name}
            </button>
          ))}
        </div>

        <p
          className="sf-text mb-4"
          style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", minHeight: 16 }}
        >
          {SPAWNS.find((s) => s.key === spawn)?.blurb}
        </p>

        <button
          className="sf-btn"
          data-primary={ready ? "1" : "0"}
          disabled={!ready}
          onClick={doRespawn}
          style={{ justifyContent: "center", position: "relative", overflow: "hidden" }}
        >
          {ready ? "REDEPLOY  ·  SPACE" : "STAND BY"}
          {!ready && (
            <div
              ref={barRef}
              style={{
                position: "absolute",
                left: 0,
                bottom: 0,
                height: 2,
                width: "0%",
                background: COLORS.signal,
              }}
            />
          )}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, tint }: { label: string; value: string; tint: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className="sf-num" style={{ fontSize: 22, fontWeight: 700, color: tint }}>
        {value}
      </span>
      <span className="sf-label" style={{ fontSize: 7, letterSpacing: "0.26em" }}>
        {label}
      </span>
    </div>
  );
}
