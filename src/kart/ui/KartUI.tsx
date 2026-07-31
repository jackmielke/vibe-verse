/**
 * Vibe Kart — the presentation layer.
 *
 * One React tree over the canvas: loading, title, character select, the race
 * HUD, pause and results. It owns the screen state machine and nothing else —
 * every fact it draws is read live off `ctx.services`, and every service it
 * reads is allowed to be missing.
 *
 * Three things are worth knowing before editing this file.
 *
 * **It publishes `ctx.services.ui`.** The race system stands down from handling
 * the pause button the moment that handle exists, which is what turns Escape
 * from "freeze" into "menu". The handle also carries `tick`, which the minimap
 * system calls from inside the engine's `lateUpdate` — that is the heartbeat
 * every HUD component subscribes to through `useKartFrame`. A `requestAnimation
 * Frame` loop cannot do the job: the engine clears edge-triggered input before
 * rAF callbacks run, and the screenshot harness stops rAF entirely and steps
 * the engine by hand. rAF is kept only as a fallback for the case where the
 * minimap system failed to boot.
 *
 * **It claims the grid.** The race system starts its own lights 1.5 s after
 * boot unless something takes `autoStart` away from it. The title screen takes
 * it; confirming a character gives it back.
 *
 * **Everything is tagged `data-kart-hud`.** The screenshot harness hides that
 * attribute to photograph the world, and shows it to photograph the HUD, so a
 * root element without the tag is a root element that ruins every gallery shot.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isShotMode, type KartEngine } from "../engine/core";
import { RaceHud } from "./hud";
import { KartLogo } from "./logo";
import { PauseScreen } from "./pause";
import { ResultsScreen } from "./results";
import { RuntimeProvider, type UiRuntime } from "./runtime";
import { SelectScreen } from "./select";
import { applySettings, loadSettings, saveSettings, type KartSettings } from "./settings";
import { UI_CSS } from "./styles";
import { TitleScreen } from "./title";
import type { KartUiService, UiScreen } from "./types";
import type { AudioView, CameraView, InputView, ModelsView, PhysicsView, RaceView } from "./views";

export interface KartUIProps {
  engine: KartEngine;
  ready: boolean;
  progress: { stage: string; fraction: number };
}

/** How long the engine pump may go quiet before the rAF fallback takes over. */
const PUMP_TIMEOUT_MS = 250;

export default function KartUI({ engine, ready, progress }: KartUIProps) {
  const ctx = engine.ctx;
  const shot = useMemo(() => isShotMode(), []);

  const [screen, setScreen] = useState<UiScreen>(() => (shot ? "race" : "title"));
  const screenRef = useRef(screen);
  screenRef.current = screen;

  const [settings, setSettings] = useState<KartSettings>(loadSettings);

  // -- the frame bus --------------------------------------------------------
  const subs = useRef(new Set<(dt: number) => void>());
  const pumpedAt = useRef(0);
  const pauseLatch = useRef(false);

  const runtime = useMemo<UiRuntime>(
    () => ({
      engine,
      ctx,
      shot,
      onFrame(fn) {
        subs.current.add(fn);
        return () => {
          subs.current.delete(fn);
        };
      },
    }),
    [engine, ctx, shot],
  );

  const openPause = useCallback(() => {
    if (screenRef.current !== "race") return;
    const race = ctx.services.race as RaceView | undefined;
    if (race?.setPaused) race.setPaused(true);
    else ctx.emit("ui:pause");
    setScreen("paused");
  }, [ctx]);

  const resume = useCallback(() => {
    const race = ctx.services.race as RaceView | undefined;
    if (race?.setPaused) race.setPaused(false);
    else ctx.emit("ui:resume");
    (ctx.services.audio as AudioView | undefined)?.play?.("unpause", undefined, { volume: 0.7 });
    setScreen("race");
  }, [ctx]);

  /** One engine frame: fan out to the HUD, then read the edges nobody else can. */
  const runFrame = useCallback(
    (dt: number) => {
      for (const fn of Array.from(subs.current)) {
        try {
          fn(dt);
        } catch (err) {
          // One broken widget must not take the rest of the HUD with it.
          subs.current.delete(fn);
          console.error("[Vibe Kart/ui] a HUD frame callback threw and was dropped:", err);
        }
      }

      const pressed = ctx.input.pausePressed;
      if (pressed && !pauseLatch.current) {
        if (screenRef.current === "race") openPause();
        else if (screenRef.current === "paused") resume();
      }
      pauseLatch.current = pressed;

      // Backstop for the results screen: the race publishes an event, but a
      // listener that missed it would otherwise strand the player in the HUD.
      if (screenRef.current === "race") {
        const race = ctx.services.race as RaceView | undefined;
        if (race?.phase === "results") setScreen("results");
      }
    },
    [ctx, openPause, resume],
  );

  // The engine-side pump. Published synchronously with the rest of the handle.
  useEffect(() => {
    const service: KartUiService = {
      get screen() {
        return screenRef.current;
      },
      setScreen: (next) => setScreen(next),
      tick: (dt) => {
        pumpedAt.current = performance.now();
        runFrame(dt);
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
    let last = performance.now();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (now - pumpedAt.current > PUMP_TIMEOUT_MS) runFrame(dt);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [runFrame]);

  // -- settings -------------------------------------------------------------
  const patch = useCallback((next: Partial<KartSettings>) => {
    setSettings((cur) => ({ ...cur, ...next }));
  }, []);

  // Persisting and applying are the same commit: whatever the player can see on
  // the segmented controls is what is on disk and what the services are running.
  useEffect(() => {
    if (!ready) return;
    saveSettings(settings);
    applySettings(ctx, settings);
  }, [ctx, ready, settings]);

  // The driving overlay belongs to the input system; menus hide it so a thumb
  // stick never floats over a settings row.
  useEffect(() => {
    const input = ctx.services.input as InputView | undefined;
    input?.setTouchVisible?.(screen === "race" || screen === "paused" ? null : false);
  }, [ctx, screen]);

  // -- transitions ----------------------------------------------------------
  useEffect(() => {
    const off = ctx.on("race:results", (() => setScreen("results")) as (p: never) => void);
    const offPause = ctx.on("ui:pause", (() => {
      if (screenRef.current === "race") setScreen("paused");
    }) as (p: never) => void);
    const offResume = ctx.on("ui:resume", (() => {
      if (screenRef.current === "paused") setScreen("race");
    }) as (p: never) => void);
    return () => {
      off();
      offPause();
      offResume();
    };
  }, [ctx]);

  /** Hand the grid back to the race system and drop the flag. */
  const startRace = useCallback(() => {
    const race = ctx.services.race as RaceView | undefined;
    const camera = ctx.services.camera as CameraView | undefined;
    const physics = ctx.services.physics as PhysicsView | undefined;
    const audio = ctx.services.audio as AudioView | undefined;

    audio?.unlock?.();
    if (physics?.player) camera?.follow?.(physics.player.id);
    camera?.setMode?.(settings.camera, { snap: true });

    if (race) {
      race.autoStart = true;
      race.restart();
    }
    setScreen("race");
  }, [ctx, settings.camera]);

  /**
   * Put the player in the chosen kart. `spawn` on an existing id is the physics
   * system's own restart path — same object identity, new stats — and dropping
   * the rig makes the model system rebuild it in the new livery on the next
   * pose. Both are optional: without them you simply race the default grid.
   */
  const confirmCharacter = useCallback(
    (characterId: string) => {
      const physics = ctx.services.physics as PhysicsView | undefined;
      const models = ctx.services.models as ModelsView | undefined;
      const player = physics?.player;
      if (physics && player && characterId && player.characterId !== characterId) {
        const slot = Math.max(0, physics.racers.findIndex((r) => r.id === player.id));
        try {
          physics.spawn({ id: player.id, name: player.name, characterId, isPlayer: true, slot });
          models?.destroyRacer?.(player.id);
        } catch (err) {
          console.error("[Vibe Kart/ui] could not swap the player's kart:", err);
        }
      }
      startRace();
    },
    [ctx, startRace],
  );

  const toTitle = useCallback(() => {
    (ctx.services.audio as AudioView | undefined)?.music?.("menu");
    setScreen("title");
  }, [ctx]);

  const toSelect = useCallback(() => {
    const race = ctx.services.race as RaceView | undefined;
    race?.setPaused?.(false);
    setScreen("select");
  }, [ctx]);

  const restartRace = useCallback(() => {
    const race = ctx.services.race as RaceView | undefined;
    if (race) {
      race.autoStart = true;
      race.restart();
    }
    setScreen("race");
  }, [ctx]);

  // -------------------------------------------------------------------------
  return (
    <RuntimeProvider value={runtime}>
      <div className="vk-root" data-kart-hud="root">
        <style>{UI_CSS}</style>

        {!ready ? (
          <div className="vk-load" data-kart-hud="loading">
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{ width: "46vmin", opacity: 0.95 }}>
                <KartLogo />
              </div>
              <div className="vk-load-bar" style={{ marginTop: "3vmin" }}>
                <div className="vk-load-fill" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
              </div>
              <div className="vk-load-stage">{progress.stage}</div>
            </div>
          </div>
        ) : null}

        {ready && (screen === "race" || screen === "paused") ? <RaceHud /> : null}

        {ready && screen === "title" ? (
          <TitleScreen settings={settings} patch={patch} onStart={() => setScreen("select")} />
        ) : null}

        {ready && screen === "select" ? <SelectScreen onConfirm={confirmCharacter} onBack={toTitle} /> : null}

        {ready && screen === "paused" ? (
          <PauseScreen
            settings={settings}
            patch={patch}
            onResume={resume}
            onRestart={restartRace}
            onSelect={toSelect}
          />
        ) : null}

        {ready && screen === "results" ? (
          <ResultsScreen onAgain={restartRace} onSelect={toSelect} onTitle={toTitle} />
        ) : null}
      </div>
    </RuntimeProvider>
  );
}
