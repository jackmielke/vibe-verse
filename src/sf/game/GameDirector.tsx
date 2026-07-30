/**
 * game/GameDirector.tsx — the game layer's one component.
 *
 *   import GameDirector from "@/sf/game/GameDirector";
 *   …
 *   <GameDirector />        // inside the Canvas, after <CityAI />
 *
 * It renders nothing. What it does is own the *schedule*: which game-layer
 * system runs this frame and which one waits its turn.
 *
 * The budget
 * ----------
 * Not everything deserves 60 Hz, and pretending otherwise is how a game layer
 * quietly eats two milliseconds a frame doing arithmetic nobody can see.
 *
 *   every frame   chaos combo window, heat pressure field, mission objectives.
 *                 These are cheap (a few dozen distance checks) and they are
 *                 the ones a player can *feel* being late: a gate that only
 *                 registers 100 ms after you flew through it feels broken.
 *   10 Hz         discovery proximity. Nine grid cells; at wingsuit speed the
 *                 sampling is still finer than the smallest trigger radius.
 *   ~3 Hz each    the director, progression integration, and autosave, rotated
 *                 one-per-slow-tick so their costs never land on the same
 *                 frame. Each receives the real elapsed time since it last
 *                 ran, so running at a third of the rate changes nothing about
 *                 the numbers it produces.
 *
 * Ordering matters and is deliberate: chaos before heat (heat reads the chaos
 * rate), heat before the director (the director reads notoriety), missions
 * last so an objective completed this frame sees a settled world.
 *
 * The component must mount *after* `<CityAI />`, because the AI's own effect
 * installs the enemy/pedestrian kill callbacks and the chaos economy adopts
 * whatever it finds. If the order ever slips, `refreshChaosHooks()` on the
 * director tick re-adopts them within a third of a second.
 */
import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { frame, useSfStore } from "../state/store";
import { installShotHook } from "../debug/shotHook";
import { chaos, installChaosEconomy } from "./chaos";
import { director } from "./director";
import { discoveries } from "./discoveries";
import { gameHeat } from "./heat";
import { missions } from "./missions";
import { progression } from "./progression";
import { loadGame, saveGame, saveSystem } from "./save";

/** Slow-tick period, seconds. */
const SLOW_DT = 0.1;
/** Number of rotating slots inside the slow tick. */
const SLOTS = 3;

export interface GameDirectorProps {
  /** Load the save on mount. Off for a fresh-start / new-game flow. */
  autoLoad?: boolean;
  /** Master switch. The screenshot harness turns the whole layer off. */
  enabled?: boolean;
}

export default function GameDirector({ autoLoad = true, enabled }: GameDirectorProps) {
  // The offline capture harness must photograph a deterministic city: a
  // director that lights fires and rolls fog in would make every shot a
  // different scene. Default to off whenever a shot has been requested.
  const shot = installShotHook().request;
  const live = enabled ?? shot === null;

  const clock = useRef({ slow: 0, slot: 0, since: [0, 0, 0], notify: 0 });

  useEffect(() => {
    if (!live) return;

    // Order matters here too: the economy must be installed before anything
    // can award chaos, and progression must be listening before a mission can
    // complete.
    const offChaos = installChaosEconomy();
    const offMissions = missions.install();
    const offProgression = progression.install();
    const offDirector = director.install();
    const offSave = saveSystem.install();

    if (autoLoad) loadGame();

    // Death is a game-layer event as much as a player-system one: it ends
    // pursuits, costs a statistic, and fails missions that said it would.
    let wasDead = false;
    const unsub = useSfStore.subscribe((s) => {
      const dead = s.phase === "dead";
      if (dead && !wasDead) {
        progression.reportDeath();
        gameHeat.onPlayerDown();
        saveSystem.markDirty();
      }
      wasDead = dead;
    });

    const g = globalThis as Record<string, unknown>;
    g.__sfGame = {
      chaos,
      director,
      missions,
      progression,
      discoveries,
      heat: gameHeat,
      save: saveGame,
      stats: () => ({
        chaos: chaos.stats,
        director: director.stats,
        missions: missions.stats,
        heat: gameHeat.stats,
        discoveries: `${discoveries.found}/${discoveries.total}`,
      }),
    };

    return () => {
      // Write before tearing down, or a page navigation loses the session.
      saveGame("unmount");
      unsub();
      offSave();
      offDirector();
      offProgression();
      offMissions();
      offChaos();
      if (g.__sfGame) delete g.__sfGame;
    };
  }, [live, autoLoad]);

  useFrame((_, delta) => {
    if (!live) return;
    const dt = Math.min(delta, 1 / 20);
    const c = clock.current;

    /* ---- every frame: the things a player can feel being late ---- */
    chaos.tick(dt);
    gameHeat.tick(dt, frame.time);
    missions.tick(dt);

    /* ---- notification pruning, 5 Hz ---- */
    c.notify += dt;
    if (c.notify >= 0.2) {
      c.notify = 0;
      useSfStore.getState().pruneNotifications(frame.time);
    }

    /* ---- slow tick ---- */
    c.slow += dt;
    for (let i = 0; i < SLOTS; i++) c.since[i] += dt;
    if (c.slow < SLOW_DT) return;
    c.slow = 0;

    // 10 Hz for everyone: proximity is the one slow-tick job that must not be
    // rotated, because missing a trigger is a bug rather than a delay.
    discoveries.tick();

    const slot = c.slot;
    c.slot = (c.slot + 1) % SLOTS;
    const elapsed = c.since[slot];
    c.since[slot] = 0;

    switch (slot) {
      case 0:
        director.tick(elapsed);
        break;
      case 1:
        progression.tick(elapsed);
        break;
      case 2:
        saveSystem.tick(elapsed);
        break;
    }
  });

  return null;
}
