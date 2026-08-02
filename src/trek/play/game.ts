/**
 * The captain's chair: orders in, consequences out, and the episode structure
 * that strings five of them together.
 *
 * Everything the player can actually *do* is in here, and there is not much of
 * it — a target, two weapons, an alert state, three power settings, a helm and
 * an evasive order. That is deliberate. The interesting decision in a Star
 * Trek battle is never "where do I point the mouse", it is "do I spend the
 * next twenty seconds running or fighting", and a small verb set is what
 * leaves room for that question to matter.
 *
 * The power triangle is the one system worth reading twice. Engines, shields
 * and weapons split a fixed budget three ways, and every one of them is
 * something you will want at the same moment: you need the engines to break
 * off, the shields to survive the pass, and the weapons to make the pass worth
 * anything. There is no correct setting, only a current one, and changing it
 * mid-fight is the closest this game gets to a conversation with Mr Scott.
 */
import { MISSIONS, type Mission, type MissionCtx } from "./missions";
import type { CrewService } from "./crew";
import { clamp, type AlertLevel, type GameService, type Ship, type System, type TrekCtx } from "../types";

export function createGame(ctx: TrekCtx): System {
  const fleet = ctx.services.fleet!;
  const crew = () => (ctx.services as Record<string, unknown>).crew as CrewService | undefined;
  const audio = () => ctx.services.audio;

  let missionIndex = 0;
  let mission: Mission = MISSIONS[0];
  let missionElapsed = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const state: Record<string, unknown> = {};
  let phaserBeamOn = false;
  let lastPowerCue = -99;

  const service: GameService = {
    alert: "normal",
    power: { engines: 0.34, shields: 0.33, weapons: 0.33 },
    targetId: null,
    mission: 0,
    missionTitle: MISSIONS[0].title,
    stardate: MISSIONS[0].stardate,
    objective: "",
    status: "briefing",
    evasiveUntil: 0,
    advance() {
      if (service.status === "briefing") beginMission();
      else if (service.status === "won") nextMission();
      else if (service.status === "lost") restartMission();
      else if (service.status === "complete") {
        missionIndex = 0;
        loadMission(0);
      }
    },
    restart() {
      restartMission();
    },
    goto(index) {
      // `service.mission` is a mirror of a module-local counter, so writing to
      // it does not move the campaign — it just makes the two disagree, which
      // is how the playthrough harness silently skipped episode one.
      loadMission(index);
    },
    say(line) {
      crew()?.say(line);
    },
  };
  ctx.services.game = service;

  // -------------------------------------------------------------------------
  // Mission lifecycle
  // -------------------------------------------------------------------------

  const missionCtx: MissionCtx = {
    ctx,
    fleet,
    elapsed: 0,
    say: (who, text, priority) => crew()?.say({ who, text, priority }),
    spawn: (spec) => fleet.spawn(spec),
    after: (seconds, fn) => timers.push({ at: missionElapsed + seconds, fn }),
    setObjective: (text) => {
      service.objective = text;
    },
    win: () => finish(true),
    lose: () => finish(false),
    state,
  };

  function loadMission(index: number): void {
    missionIndex = clamp(index, 0, MISSIONS.length - 1);
    mission = MISSIONS[missionIndex];
    service.mission = missionIndex;
    service.missionTitle = mission.title;
    service.stardate = mission.stardate;
    service.objective = "";
    service.status = "briefing";
    service.targetId = null;
    crew()?.clear();
    ctx.emit("trek:mission", { mission, index: missionIndex, status: "briefing" });
  }

  function beginMission(): void {
    fleet.clearAll();
    timers.length = 0;
    for (const key of Object.keys(state)) delete state[key];
    missionElapsed = 0;
    missionCtx.elapsed = 0;

    // Reset the ship. Between episodes the Enterprise gets a starbase and a
    // repair crew; within one she does not.
    const p = fleet.player;
    p.hull_ = 1;
    p.shields = [1, 1, 1, 1];
    p.alive = true;
    p.dyingFor = 0;
    p.velocity.set(0, 0, 0);
    p.angular.set(0, 0, 0);
    p.throttle = 0.25;
    p.phaserCharge = 1;
    p.cloakLevel = 0;
    p.object.visible = true;
    for (const key of Object.keys(p.systems)) {
      p.systems[key as keyof typeof p.systems] = 1;
    }

    ctx.services.space?.setScene(mission.scene);
    ctx.services.camera?.setMode("viewscreen");
    setAlert("normal");
    service.status = "playing";
    ctx.emit("trek:mission", { mission, index: missionIndex, status: "playing" });

    mission.setup(missionCtx);

    // The log is read over the first few seconds of the episode, which is
    // exactly where it goes on television.
    crew()?.say({ who: "CAPTAIN", text: mission.log, priority: 10, hold: Math.min(16, 3 + mission.log.length * 0.048) });

    // Starfleet addresses the person in the chair by name — read once at boot
    // from the hub's identity. It is one string and it is the difference
    // between a simulator and being somebody.
    const captain = (ctx.services as Record<string, unknown>).captain as string | undefined;
    if (captain && captain !== "Guest" && missionIndex === 0) {
      crew()?.say({
        who: "COMMAND",
        text: `Starfleet Command to Captain ${captain}. The Vibeverse is yours. Good hunting.`,
        priority: 9,
      });
    }
  }

  function finish(won: boolean): void {
    if (service.status !== "playing") return;
    service.status = won ? "won" : "lost";
    audio()?.setPhaserBeam(false);
    phaserBeamOn = false;
    setAlert("normal");
    audio()?.cue(won ? "victory" : "defeat");
    ctx.emit("trek:mission", { mission, index: missionIndex, status: service.status });
  }

  function nextMission(): void {
    if (missionIndex >= MISSIONS.length - 1) {
      service.status = "complete";
      ctx.emit("trek:mission", { mission, index: missionIndex, status: "complete" });
      audio()?.cue("fanfare");
      return;
    }
    // Warp to the next episode. The flash and the wind-up are the transition —
    // there is no loading screen anywhere in this world.
    audio()?.cue("warp");
    ctx.services.viewscreen?.disrupt(1);
    loadMission(missionIndex + 1);
  }

  function restartMission(): void {
    loadMission(missionIndex);
  }

  loadMission(0);

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  function setAlert(level: AlertLevel): void {
    if (service.alert === level) return;
    service.alert = level;
    ctx.services.bridge?.setAlert(level);
    audio()?.setAlert(level);
    const p = fleet.player;
    if (level === "red") {
      p.shieldsUp = true;
      audio()?.cue("bosun");
      crew()?.bark("redAlert", { cooldown: 3, priority: 9 });
    } else {
      p.shieldsUp = false;
      crew()?.bark("standDown", { cooldown: 3, priority: 6 });
    }
  }

  function hostiles(): Ship[] {
    return fleet.ships.filter(
      (s) => s.alive && s !== fleet.player && s.allegiance !== "starfleet" && s.allegiance !== "neutral",
    );
  }

  /**
   * How far the ship can see well enough to hold a lock.
   *
   * Twelve thousand kilometres in clear space; about three in the Mutara
   * Nebula. This one number is what turns the finale from a shooting gallery
   * into a hunt — without it, "sensors are useless in here" is a line of
   * dialogue over a targeting computer that works perfectly, and the episode
   * is over in half a minute. It also gives a damaged sensor array real teeth:
   * lose the array and you have to close to knife range to shoot at all.
   */
  function lockRange(): number {
    const interference = ctx.services.space?.interference ?? 0;
    return 12000 * (1 - 0.73 * interference) * (0.35 + 0.65 * fleet.player.systems.sensors);
  }

  function cycleTarget(): void {
    const max = lockRange();
    const list = hostiles()
      .filter((s) => s.cloakLevel < 0.6 && s.position.distanceTo(fleet.player.position) <= max)
      .sort(
        (a, b) =>
          a.position.distanceToSquared(fleet.player.position) - b.position.distanceToSquared(fleet.player.position),
      );
    if (!list.length) {
      service.targetId = null;
      audio()?.cue("deny");
      crew()?.bark("noTarget", { cooldown: 8, priority: 6 });
      return;
    }
    const at = list.findIndex((s) => s.id === service.targetId);
    const next = list[(at + 1) % list.length];
    service.targetId = next.id;
    fleet.player.targetId = next.id;
    audio()?.cue("lock");
    crew()?.bark("targetAcquired", { cooldown: 7, priority: 6 });
  }

  function shiftPower(to: number): void {
    const keys = ["engines", "shields", "weapons"] as const;
    const key = keys[to];
    const p = service.power;
    const take = 0.11;
    for (const k of keys) {
      if (k === key) continue;
      const give = Math.min(take / 2, Math.max(0, p[k] - 0.1));
      p[k] -= give;
      p[key] += give;
    }
    const total = p.engines + p.shields + p.weapons;
    p.engines /= total;
    p.shields /= total;
    p.weapons /= total;
    audio()?.cue("ack");
    if (ctx.elapsed - lastPowerCue > 6) {
      lastPowerCue = ctx.elapsed;
      crew()?.bark(to === 0 ? "powerEngines" : to === 1 ? "powerShields" : "powerWeapons", { cooldown: 6, priority: 4 });
    }
  }

  // -------------------------------------------------------------------------

  return {
    fixedUpdate(dt) {
      const p = fleet.player;
      if (service.status !== "playing" || !p.alive) return;

      // Helm. Player input drives the rates directly; evasive adds a jink on
      // top, which the AI's gunners genuinely struggle with.
      const power = service.power;
      const engineGain = 0.65 + power.engines * 1.05;
      const agility = p.agility * engineGain * (0.35 + 0.65 * p.systems.impulse);
      let yawCmd = -ctx.input.yaw;
      let pitchCmd = ctx.input.pitch;
      if (ctx.elapsed < service.evasiveUntil) {
        const t = ctx.elapsed * 2.4;
        yawCmd += Math.sin(t * 1.7) * 0.85;
        pitchCmd += Math.sin(t * 1.1 + 2) * 0.6;
      }
      const k = 1 - Math.exp(-5 * dt);
      p.angular.y += (yawCmd * agility - p.angular.y) * k;
      p.angular.x += (pitchCmd * agility - p.angular.x) * k;
      p.angular.z += (-yawCmd * agility * 1.6 + ctx.input.roll * agility - p.angular.z) * k;

      p.throttle = ctx.input.throttle;
      p.maxSpeed = 340 * (0.7 + power.engines * 0.95);
      // Slow. At the first pass's rate a facing came back from nothing in
      // twenty-six seconds, which combined with 92% absorption made the ship
      // effectively immune to sustained fire — a headless playthrough of the
      // Doomsday Machine finished on 100% hull without ever being in danger.
      // Halved, a stripped shield is a problem you have to solve by pointing
      // a different side at them, which is the whole point of having four.
      p.shieldRegen = 0.008 + power.shields * 0.03;
    },

    update(dt) {
      const p = fleet.player;
      const input = ctx.input;

      // -- Orders that work in any state -----------------------------------
      if (input.cycleCamera) {
        const mode = ctx.services.camera?.cycle();
        audio()?.cue("blip", { rate: 1.6 });
        ctx.emit("trek:camera", { mode });
      }
      if (input.cycleMagnification) {
        const mag = ctx.services.camera?.cycleMagnification();
        audio()?.cue("ack");
        if (mag && mag > 1) crew()?.say({ who: "SPOCK", text: `Magnification factor ${mag}.`, priority: 4 });
      }
      if (input.advance && service.status !== "playing") service.advance();

      if (service.status !== "playing") {
        if (phaserBeamOn) {
          audio()?.setPhaserBeam(false);
          phaserBeamOn = false;
        }
        return;
      }

      missionElapsed += dt;
      missionCtx.elapsed = missionElapsed;

      // -- Scheduled mission beats ------------------------------------------
      for (let i = timers.length - 1; i >= 0; i--) {
        if (missionElapsed >= timers[i].at) {
          const fn = timers[i].fn;
          timers.splice(i, 1);
          try {
            fn();
          } catch (err) {
            console.error("[Final Frontier] mission timer failed", err);
          }
        }
      }

      // -- Orders -----------------------------------------------------------
      if (input.toggleAlert) setAlert(service.alert === "red" ? "normal" : "red");
      if (input.nextTarget) cycleTarget();
      if (input.powerTo >= 0) shiftPower(input.powerTo);
      if (input.allStop) {
        input.throttle = 0;
        audio()?.cue("ack");
        crew()?.say({ who: "SULU", text: "All stop, aye.", priority: 4 });
      }
      if (input.evasive) {
        service.evasiveUntil = ctx.elapsed + 6;
        audio()?.cue("ack");
        crew()?.bark("evasive", { cooldown: 7, priority: 7 });
      }
      if (input.hail) {
        audio()?.cue("hail");
        crew()?.say({ who: "UHURA", text: "Hailing frequencies open, Captain.", priority: 6 });
        crew()?.bark("hailNoAnswer", { cooldown: 10, priority: 5 });
      }

      // -- Targeting --------------------------------------------------------
      const max = lockRange();
      let target = service.targetId != null ? fleet.byId(service.targetId) : undefined;
      if (target && (!target.alive || target.cloakLevel > 0.9)) {
        if (!target.alive) service.targetId = null;
        target = target.alive ? target : undefined;
      }
      // A lock is lost when the target outruns the sensors — with hysteresis,
      // so a ship sitting exactly on the edge does not strobe the HUD.
      if (target && target.position.distanceTo(p.position) > max * 1.3) {
        service.targetId = null;
        target = undefined;
        crew()?.say({ who: "SPOCK", text: "We have lost the target, Captain. It is beyond our sensor range.", priority: 7 });
      }
      // Acquire automatically when there is exactly one thing to shoot at and
      // it is close enough to see — making the player press a key to notice
      // the only enemy in the sector is bookkeeping, not tactics.
      if (!target) {
        const list = hostiles().filter(
          (s) => s.cloakLevel < 0.6 && s.position.distanceTo(p.position) <= max,
        );
        if (list.length === 1) {
          service.targetId = list[0].id;
          target = list[0];
        }
      }
      fleet.player.targetId = service.targetId;

      // -- Weapons ----------------------------------------------------------
      const weaponGain = 0.6 + service.power.weapons * 1.2;
      p.phaserCharge = clamp(p.phaserCharge + dt * 0.075 * weaponGain, 0, 1);
      p.phaserCooldown = Math.max(0, p.phaserCooldown - dt);
      p.torpedoCooldown = Math.max(0, p.torpedoCooldown - dt);

      let firing = false;
      if (input.firePhasers && target?.alive) {
        if (p.phaserCharge < 0.06) {
          crew()?.bark("phasersDepleted", { cooldown: 9, priority: 7 });
        } else if (p.systems.phasers < 0.15) {
          crew()?.say({ who: "CHEKOV", text: "Phaser banks are out, Captain — no response from fire control.", priority: 7 });
        } else if (p.phaserCooldown <= 0) {
          if (ctx.services.weapons?.firePhasers(p, target)) {
            p.phaserCooldown = 0.95;
            p.phaserCharge = Math.max(0, p.phaserCharge - 0.16);
            firing = true;
            crew()?.bark("phasersFired", { cooldown: 11, priority: 3 });
          }
        } else {
          firing = true;
        }
      }
      // Keep the beam sound running for as long as beams are actually alive.
      const wantBeam = firing && p.phaserCharge > 0.02;
      if (wantBeam !== phaserBeamOn) {
        audio()?.setPhaserBeam(wantBeam);
        phaserBeamOn = wantBeam;
      }

      if (input.fireTorpedo) {
        if (!target?.alive) {
          audio()?.cue("deny");
          crew()?.bark("noTarget", { cooldown: 8, priority: 6 });
        } else if (p.torpedoes <= 0) {
          audio()?.cue("deny");
          crew()?.bark("torpedoesEmpty", { cooldown: 9, priority: 7 });
        } else if (p.torpedoCooldown > 0) {
          audio()?.cue("deny");
        } else if (ctx.services.weapons?.fireTorpedo(p, target)) {
          p.torpedoCooldown = 2.1;
        }
      }

      // -- Shields ------------------------------------------------------------
      // Red alert is the only thing that raises them, so a captain who forgets
      // to call it fights the first pass naked. That is the correct penalty.
      if (service.alert === "red" && !p.shieldsUp) p.shieldsUp = true;

      // -- The episode --------------------------------------------------------
      try {
        mission.update(missionCtx, dt);
      } catch (err) {
        console.error("[Final Frontier] mission update failed", err);
      }

      if (p.hull_ <= 0.001 && service.status === "playing") finish(false);
    },

    dispose() {
      audio()?.setPhaserBeam(false);
      timers.length = 0;
    },
  };
}

export { MISSIONS };
export type { Mission };
