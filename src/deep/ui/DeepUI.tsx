/**
 * The Midnight Zone — the presentation layer.
 *
 * One React tree over the canvas: loading, the dive briefing, the HUD, the
 * survey log, and the card that comes up when you find something new.
 *
 * It is pumped from *inside* the engine loop, not from `requestAnimationFrame`.
 * That is not a style choice: the engine clears edge-triggered input at the end
 * of every frame, and a rAF callback registered by React always runs after the
 * engine's — so React can never see a key edge. The camera system calls `tick`
 * from its `lateUpdate`, which is before the clear. A rAF fallback is kept for
 * the case where that system failed to boot, because a HUD that freezes is
 * worse than one that misses a keypress.
 *
 * Everything it draws is read live off `ctx.services`, and every service it
 * reads is allowed to be missing — a dive with no sound, no seafloor or no
 * post stack still renders a HUD.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isShotMode, type DeepEngine } from "../engine/core";
import type { CameraService } from "../engine/camera";
import type { ScanService } from "../play/scan";
import type { SoundService } from "../fx/sound";
import { SPECIES, SPECIES_BY_ID } from "../life/species";
import {
  FLOOR_DEPTH,
  ZONES,
  zoneAt,
  type LogService,
  type SubService,
  type Zone,
} from "../types";
import { DEEP_CSS } from "./styles";

type Screen = "brief" | "dive" | "log" | "paused";

export interface DeepUIProps {
  engine: DeepEngine;
  ready: boolean;
  progress: { stage: string; fraction: number };
}

/** How long the engine pump may go quiet before the rAF fallback takes over. */
const PUMP_TIMEOUT_MS = 250;

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

export default function DeepUI({ engine, ready, progress }: DeepUIProps) {
  const ctx = engine.ctx;
  const shot = useMemo(() => isShotMode(), []);

  const [screen, setScreen] = useState<Screen>(() => (shot ? "dive" : "brief"));
  const screenRef = useRef(screen);
  screenRef.current = screen;

  const [muted, setMuted] = useState(false);
  // One state object per frame beats six useStates: the HUD is a single
  // snapshot of the sub, and tearing between its fields would show.
  const [hud, setHud] = useState({ depth: 0, power: 1, hull: 1, speed: 0, lights: true });
  const [scanState, setScanState] = useState<{ name: string; latin: string; progress: number; known: boolean } | null>(null);
  const [found, setFound] = useState<string[]>([]);
  const [card, setCard] = useState<{ id: string; repeat: boolean } | null>(null);
  const [zone, setZone] = useState<Zone | null>(null);
  const [landed, setLanded] = useState(false);

  const subs = useRef(new Set<(dt: number) => void>());
  const pumpedAt = useRef(0);
  const lastZone = useRef<string>("");
  const cardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -- the frame bus --------------------------------------------------------
  const runFrame = useCallback(() => {
    const sub = ctx.services.sub as SubService | undefined;
    const scan = ctx.services.scan as ScanService | undefined;
    const log = ctx.services.log as LogService | undefined;

    if (sub) {
      setHud((cur) => {
        // Only re-render when something visible actually moved. Depth to the
        // metre, bars to the percent — otherwise this is 60 setStates a second
        // over a tree that would look identical.
        const depth = Math.round(sub.depth);
        const power = Math.round(sub.power * 100) / 100;
        const hull = Math.round(sub.hull * 100) / 100;
        const speed = Math.round(sub.speed * 10) / 10;
        if (
          cur.depth === depth && cur.power === power && cur.hull === hull &&
          cur.speed === speed && cur.lights === sub.lightsOn
        ) {
          return cur;
        }
        return { depth, power, hull, speed, lights: sub.lightsOn };
      });

      const z = zoneAt(sub.depth);
      if (z.id !== lastZone.current) {
        lastZone.current = z.id;
        // Not on the first frame — arriving at the surface is not a crossing.
        if (screenRef.current === "dive") setZone(z);
      }
    }

    if (scan) {
      const t = scan.target;
      const species = t ? SPECIES_BY_ID.get(t.speciesId) : undefined;
      setScanState((cur) => {
        if (!species) return cur === null ? cur : null;
        const p = Math.round(scan.progress * 50) / 50;
        const known = !!log?.has(species.id);
        if (cur && cur.name === species.name && cur.progress === p && cur.known === known) return cur;
        return { name: species.name, latin: species.latin, progress: p, known };
      });
    }

    if (log) {
      setFound((cur) => (cur.length === log.found.length ? cur : [...log.found]));
    }

    if (ctx.input.pausePressed) {
      if (screenRef.current === "dive") setScreen("paused");
      else if (screenRef.current === "paused") setScreen("dive");
    }
  }, [ctx]);

  // The engine-side pump.
  useEffect(() => {
    const service = {
      tick: (dt: number) => {
        pumpedAt.current = performance.now();
        for (const fn of Array.from(subs.current)) {
          try {
            fn(dt);
          } catch (err) {
            subs.current.delete(fn);
            console.error("[The Deep/ui] a HUD callback threw and was dropped:", err);
          }
        }
        runFrame();
      },
    };
    ctx.services.ui = service;
    return () => {
      if (ctx.services.ui === service) delete ctx.services.ui;
    };
  }, [ctx, runFrame]);

  // Fallback pump: only runs when the engine-side one has gone quiet.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (performance.now() - pumpedAt.current > PUMP_TIMEOUT_MS) runFrame();
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [runFrame]);

  // -- events ---------------------------------------------------------------
  useEffect(() => {
    const show = (id: string, repeat: boolean) => {
      setCard({ id, repeat });
      if (cardTimer.current) clearTimeout(cardTimer.current);
      cardTimer.current = setTimeout(() => setCard(null), repeat ? 2200 : 6000);
    };
    const offNew = ctx.on("scan:new", ((p: { speciesId: string }) => show(p.speciesId, false)) as (p: never) => void);
    const offAgain = ctx.on("scan:again", ((p: { speciesId: string }) => show(p.speciesId, true)) as (p: never) => void);
    const offLand = ctx.on("sub:landed", (() => setLanded(true)) as (p: never) => void);
    return () => {
      offNew();
      offAgain();
      offLand();
      if (cardTimer.current) clearTimeout(cardTimer.current);
    };
  }, [ctx]);

  useEffect(() => {
    if (!zone) return;
    const t = setTimeout(() => setZone(null), 6500);
    return () => clearTimeout(t);
  }, [zone]);

  // -- actions --------------------------------------------------------------
  const dive = useCallback(() => {
    const sound = ctx.services.sound as SoundService | undefined;
    sound?.unlock?.();
    (ctx.services.camera as CameraService | undefined)?.setMode?.("chase", { snap: true });
    setScreen("dive");
  }, [ctx]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      (ctx.services.sound as SoundService | undefined)?.setMuted?.(!m);
      return !m;
    });
  }, [ctx]);

  // Menus hide the touch overlay so a thumb stick never floats over a button.
  useEffect(() => {
    const input = ctx.services.input as { setTouchVisible?(v: boolean): void } | undefined;
    if (screen !== "dive") input?.setTouchVisible?.(false);
  }, [ctx, screen]);

  const depthPct = Math.min(1, hud.depth / FLOOR_DEPTH);
  const here = zoneAt(hud.depth);

  return (
    <div className="dp-root" data-deep-hud="root">
      <style>{DEEP_CSS}</style>

      {!ready ? (
        <div className="dp-load" data-deep-hud="loading">
          <div style={{ textAlign: "center" }}>
            <div className="dp-title" style={{ fontSize: "5vmin" }}>The Midnight Zone</div>
            <div className="dp-load-bar">
              <div className="dp-load-fill" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
            </div>
            <div className="dp-load-stage">{progress.stage}</div>
          </div>
        </div>
      ) : null}

      {/* -- the HUD ------------------------------------------------------- */}
      {ready && (screen === "dive" || screen === "paused") ? (
        <>
          <div className="dp-gauge" data-deep-hud="gauge">
            <div className="dp-depth">
              <span className="dp-depth-n dp-mono">{hud.depth.toLocaleString()}</span>
              <span className="dp-depth-u">m</span>
            </div>
            <div className="dp-gauge-track">
              <div className="dp-gauge-fill" style={{ height: `${depthPct * 100}%` }} />
            </div>
            {ZONES.map((z) => (
              <div
                key={z.id}
                className="dp-zone-tick"
                data-here={z.id === here.id ? "1" : "0"}
                style={{ top: `${(z.from / FLOOR_DEPTH) * 100}%` }}
              >
                <i />
                <span>{z.name.replace(" Zone", "")}</span>
              </div>
            ))}
            <div className="dp-gauge-sub" style={{ top: `${depthPct * 100}%` }}>
              🛟
            </div>
          </div>

          <div className="dp-stack" data-deep-hud="readouts">
            <div className="dp-panel dp-chip">
              <span className="dp-label">Lamps</span>
              <span style={{ color: hud.lights ? "var(--dp-cyan)" : "rgba(160,214,235,0.4)", fontWeight: 900, fontSize: "1.5vmin" }}>
                {hud.lights ? "ON" : "OFF"}
              </span>
            </div>
            <div className="dp-panel dp-chip">
              <span className="dp-label">Power</span>
              <span className="dp-bar">
                <i style={{ width: `${hud.power * 100}%`, background: hud.power < 0.2 ? "#ff9a5a" : "#6fe0ff" }} />
              </span>
            </div>
            <div className="dp-panel dp-chip">
              <span className="dp-label">Hull</span>
              <span className="dp-bar">
                <i style={{ width: `${hud.hull * 100}%`, background: hud.hull < 0.5 ? "#ff5a6a" : "#8ff0c0" }} />
              </span>
            </div>
            <div className="dp-panel dp-chip">
              <span className="dp-label">Log</span>
              <span className="dp-mono" style={{ fontWeight: 900, fontSize: "1.5vmin" }}>
                {found.length}/{SPECIES.length}
              </span>
            </div>
          </div>

          {/* Scan reticle. Only drawn when there is something in it. */}
          {scanState ? (
            <>
              <div className="dp-reticle" data-deep-hud="reticle">
                <svg viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(127,240,255,0.18)" strokeWidth="0.7" />
                  <circle
                    cx="50" cy="50" r="44" fill="none"
                    stroke={scanState.known ? "#8fa8b8" : "#7ff0ff"}
                    strokeWidth="1.6" strokeLinecap="round"
                    strokeDasharray={`${scanState.progress * 276.5} 276.5`}
                    transform="rotate(-90 50 50)"
                    style={{ filter: "drop-shadow(0 0 1.2px rgba(127,240,255,0.9))" }}
                  />
                  {[0, 90, 180, 270].map((a) => (
                    <line
                      key={a} x1="50" y1="4" x2="50" y2="11"
                      stroke="rgba(127,240,255,0.5)" strokeWidth="1"
                      transform={`rotate(${a} 50 50)`}
                    />
                  ))}
                </svg>
              </div>
              <div className="dp-scan-name" data-deep-hud="scanname">
                <b>{scanState.name}</b>
                <i>{scanState.latin}</i>
                <span className="dp-label dp-pulse" style={{ display: "block", marginTop: "0.7vmin" }}>
                  {scanState.known ? "already logged · hold F" : "hold F to survey"}
                </span>
              </div>
            </>
          ) : null}

          {zone ? (
            <div className="dp-zone-card" data-deep-hud="zonecard">
              <b>{zone.name}</b>
              <span>{zone.epigraph}</span>
            </div>
          ) : null}

          {card ? (
            <div className="dp-panel dp-find" data-deep-hud="find">
              <div className="dp-find-tag">
                {card.repeat ? "Already in the log" : "New species logged"}
              </div>
              {(() => {
                const s = SPECIES_BY_ID.get(card.id);
                if (!s) return null;
                return (
                  <>
                    <div className="dp-find-name">
                      <span className="dp-dot" style={{ background: hex(s.glow), boxShadow: `0 0 1.4vmin ${hex(s.glow)}` }} />
                      {s.name}
                    </div>
                    <div className="dp-find-latin">{s.latin}</div>
                    {!card.repeat ? <div className="dp-find-note">{s.note}</div> : null}
                  </>
                );
              })()}
            </div>
          ) : null}

          {landed && screen === "dive" ? (
            <div className="dp-panel dp-find" style={{ bottom: "26vmin" }} data-deep-hud="bottom">
              <div className="dp-find-tag">Bottom</div>
              <div className="dp-find-name">{FLOOR_DEPTH.toLocaleString()} m</div>
              <div className="dp-find-note">
                You are on the floor of the trench, in the dark, next to a chimney venting water at
                four hundred degrees. Nothing here has ever needed the sun.
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {/* -- briefing ------------------------------------------------------ */}
      {ready && screen === "brief" ? (
        <div className="dp-layer" data-deep-hud="brief">
          <div className="dp-scrim" />
          <div className="dp-sheet">
            <div className="dp-title">The Midnight Zone</div>
            <div className="dp-sub">A descent to {FLOOR_DEPTH.toLocaleString()} metres</div>
            <p className="dp-blurb">
              Your submersible is trimmed slightly heavy, so it sinks on its own. Below a
              kilometre no sunlight has ever reached, and every light you see from there down was
              made by something living. Find them, survey them, and keep going until the floor.
            </p>
            <div className="dp-keys">
              <span className="dp-key"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> steer</span>
              <span className="dp-key"><kbd>Space</kbd> rise</span>
              <span className="dp-key"><kbd>Shift</kbd> dive</span>
              <span className="dp-key"><kbd>F</kbd> survey</span>
              <span className="dp-key"><kbd>L</kbd> lamps</span>
              <span className="dp-key">drag to look</span>
            </div>
            <div className="dp-row">
              <button type="button" className="dp-btn dp-btn--go" onClick={dive}>
                Begin the dive
              </button>
              <button type="button" className="dp-btn" onClick={() => setScreen("log")}>
                Survey log · {found.length}/{SPECIES.length}
              </button>
            </div>
          </div>
          <div className="dp-foot">
            <span>The Midnight Zone — everything in it is real</span>
            <a href="/">← back to the vibeverse</a>
          </div>
        </div>
      ) : null}

      {/* -- pause --------------------------------------------------------- */}
      {ready && screen === "paused" ? (
        <div className="dp-layer" data-deep-hud="paused">
          <div className="dp-scrim" />
          <div className="dp-sheet">
            <div className="dp-title" style={{ fontSize: "4.6vmin" }}>Holding</div>
            <div className="dp-sub">{here.name} · {hud.depth.toLocaleString()} m</div>
            <div className="dp-row">
              <button type="button" className="dp-btn dp-btn--go" onClick={() => setScreen("dive")}>
                Resume
              </button>
              <button type="button" className="dp-btn" onClick={() => setScreen("log")}>
                Survey log
              </button>
              <button type="button" className="dp-btn" onClick={toggleMute}>
                {muted ? "Sound off" : "Sound on"}
              </button>
              <a className="dp-btn" href="/" style={{ textDecoration: "none" }}>
                Surface
              </a>
            </div>
          </div>
        </div>
      ) : null}

      {/* -- the log ------------------------------------------------------- */}
      {ready && screen === "log" ? (
        <div className="dp-layer" data-deep-hud="log">
          <div className="dp-scrim" />
          <div className="dp-sheet">
            <div className="dp-title" style={{ fontSize: "4vmin" }}>Survey Log</div>
            <div className="dp-sub">
              {found.length} of {SPECIES.length} species
            </div>
            <div className="dp-log">
              {SPECIES.map((s) => {
                const has = found.includes(s.id);
                return (
                  <div key={s.id} className="dp-log-card" data-found={has ? "1" : "0"}>
                    <b>
                      <span
                        className="dp-dot"
                        style={{ background: hex(s.glow), boxShadow: has ? `0 0 1.2vmin ${hex(s.glow)}` : "none" }}
                      />
                      {has ? s.name : "Unidentified"}
                    </b>
                    <i>{has ? s.latin : "—"}</i>
                    {has ? <p>{s.note}</p> : null}
                    <div className="dp-log-depth">
                      {s.from.toLocaleString()}–{s.to.toLocaleString()} m
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="dp-row">
              <button
                type="button"
                className="dp-btn dp-btn--go"
                onClick={() => setScreen(hud.depth > 20 ? "dive" : "brief")}
              >
                Back
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
