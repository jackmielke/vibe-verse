/**
 * Vibe Kart — the physics system.
 *
 * Publishes `ctx.services.physics` synchronously, then fills the grid, then
 * runs the field at a fixed 120 Hz. The per-racer step is:
 *
 *   probe        four corners against `track.surfaceAt`
 *   land         detect touchdown and bill it
 *   drive        throttle, grip, steering, drift, tricks   (drive.ts)
 *   suspend      springs, dampers, bump stops               (suspension.ts)
 *   align        up-vector spring, attitude, quaternion     (suspension.ts)
 *   integrate    substepped sweep with wall resolution      (collide.ts)
 *   locate       reproject, remember the last safe spot
 *   react        boost panels, off-road, drowning, the void
 *
 * and then, once for the whole field, kart-on-kart contact and slipstream.
 *
 * Two invariants are load-bearing:
 *
 *   **Determinism.** No Math.random, no wall clock, no iteration over a Map.
 *   Given the same inputs the same frames come out, because the screenshot
 *   harness steps this at a fixed dt and diffs the result.
 *
 *   **No NaNs.** Every step ends with a finiteness check, and a racer that has
 *   gone numerically wrong is quietly put back on the road rather than being
 *   allowed to poison the scene graph — a NaN transform in Three.js is an
 *   invisible mesh and an afternoon of debugging.
 *
 * Every service this module reads is optional. Without a track the karts drive
 * on an infinite plane; without a model system they are invisible but the race
 * still runs. A missing system costs its own feature and nothing else.
 */
import * as THREE from "three";
import {
  SURFACES,
  TUNING,
  type BoostSource,
  type CharacterPreset,
  type KartCtx,
  type ModelsService,
  type PhysicsService,
  type System,
  type TrackService,
} from "../types";
import { clamp, clamp01, damp, finite, hash01 } from "./math";
import { BASE_MASS, FALLBACK_ROSTER, PHYS, statsOf } from "./tuning";
import { makeRacer, makeSim, type KartRacer, type Sim } from "./state";
import { alignBody, applySuspension, probeWheels, writeCompression } from "./suspension";
import { cancelDrift, stepDrive, surfaceEffects } from "./drive";
import { integrate, resolveKartPairs, type SimWorld } from "./collide";

/**
 * The published handle. `PhysicsService` is the contract; the extras are
 * additive and every consumer is free to ignore them. Declared here rather
 * than in types.ts because this module does not get to edit shared law.
 */
export interface KartPhysicsService extends PhysicsService {
  racers: KartRacer[];
  player: KartRacer;
  /** Live normalised arc position of a racer, or 0 if it does not exist. */
  arcOf(id: number): number;
  /** Last progress at which the racer was safely on the road. */
  safeArcOf(id: number): number;
  /** Look a racer up by id. */
  get(id: number): KartRacer | undefined;
  /** Fixed steps simulated since boot — a deterministic clock. */
  steps: number;
  /** Set while an attract mode wants the AI to drive the player's kart. */
  playerAi: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, -1);

/** Names for the fallback grid, in case the model roster never arrived. */
const GRID_NAMES = ["You", "Bolt", "Marina", "Gus", "Hex", "Tundra", "Pip", "Rook", "Nova", "Cinder", "Wisp", "Kite"];

export default function createPhysics(ctx: KartCtx): System {
  const sims: Sim[] = [];
  const racers: KartRacer[] = [];
  const byId = new Map<number, Sim>();
  let pairClock = new Float32Array(0);
  /** Fixed steps simulated — the module's only clock, and a deterministic one. */
  let steps = 0;

  const scratchDelta = new THREE.Vector3();
  const scratchVec = new THREE.Vector3();

  const track = (): TrackService | undefined => ctx.services.track as TrackService | undefined;
  const models = (): ModelsService | undefined => ctx.services.models as ModelsService | undefined;

  // -------------------------------------------------------------------------
  // The world handed to the sub-modules
  // -------------------------------------------------------------------------
  const world: SimWorld = {
    emit: (event, payload) => ctx.emit(event, payload),
    applyBoost: (sim, seconds, source) => grantBoost(sim, seconds, source),
    applyHit: (sim, kind, seconds) => hit(sim, kind, seconds),
    get track() {
      return track();
    },
    paused: false,
  };

  function grantBoost(sim: Sim, seconds: number, source: BoostSource): void {
    if (!(seconds > 0)) return;
    const r = sim.racer;
    // Boosts refresh rather than stack: two mushrooms in a second should not
    // bank six seconds of top speed.
    r.boost = Math.max(r.boost, seconds);
    r.boostSource = source;
    ctx.emit("kart:boost", { racer: r.id, source, duration: seconds });
  }

  function hit(sim: Sim, kind: "spin" | "squash" | "shock" | "bump", seconds?: number): void {
    const r = sim.racer;
    if (r.respawning || r.finished) return;
    // A bump always lands — it is the physical consequence of a shove, not an
    // item. Everything else respects mercy frames and star power.
    if (kind !== "bump" && (r.invuln > 0 || r.star > 0)) return;

    cancelDrift(sim, world);
    if (kind !== "bump") {
      r.boost = 0;
      r.boostSource = null;
      r.draft = 0;
    }
    switch (kind) {
      case "spin":
        r.stun = Math.max(r.stun, seconds ?? TUNING.spinTime);
        // Deterministic, but not the same way every time: hashed off the step
        // counter so a chain of hits does not pirouette identically.
        sim.spinDir = hash01(steps + r.id * 7919) < 0.5 ? -1 : 1;
        sim.spinAngle = 0;
        r.invuln = Math.max(r.invuln, 0.25);
        break;
      case "squash":
        r.stun = Math.max(r.stun, seconds ?? PHYS.squashTime);
        r.velocity.multiplyScalar(0.45);
        break;
      case "shock":
        r.stun = Math.max(r.stun, seconds ?? PHYS.shockTime);
        r.velocity.multiplyScalar(0.3);
        // A little pop, so the whole field visibly jolts at once.
        r.velocity.addScaledVector(sim.up, 1.6);
        break;
      case "bump":
        r.stun = Math.max(r.stun, seconds ?? PHYS.bumpTime);
        break;
    }
    r.stunKind = kind;
  }

  // -------------------------------------------------------------------------
  // Respawn
  // -------------------------------------------------------------------------
  function beginRespawn(sim: Sim): void {
    const r = sim.racer;
    if (r.respawning) return;
    const t = track();
    r.respawning = true;
    sim.respawnTimer = 0;
    sim.respawnFrom.copy(r.position);
    sim.respawnSlot = t
      ? t.respawnAt(sim.safeT, sim.safeLane)
      : { position: new THREE.Vector3(0, 1, 0), quaternion: new THREE.Quaternion() };
    r.velocity.set(0, 0, 0);
    r.yawRate = 0;
    r.boost = 0;
    r.boostSource = null;
    r.draft = 0;
    r.stun = 0;
    r.stunKind = null;
    sim.drownTimer = 0;
    sim.trickArmed = false;
    sim.trickTimer = 0;
    r.trick = 0;
    cancelDrift(sim, world);
    ctx.emit("race:respawn", { racer: r.id });
  }

  /**
   * The respawn is choreographed rather than a teleport: lift out of wherever
   * you died, carry across to the centreline, and drop back in facing forwards.
   * A hard cut would read as a bug the first time it happened in front of the
   * camera.
   */
  function stepRespawn(sim: Sim, dt: number): void {
    const r = sim.racer;
    const slot = sim.respawnSlot;
    if (!slot) {
      r.respawning = false;
      return;
    }
    sim.respawnTimer += dt;
    const lift = PHYS.respawnLift;
    const hang = PHYS.respawnHang;
    const drop = sim.respawnTimer - lift - hang;

    scratchVec.copy(slot.position).addScaledVector(UP, PHYS.respawnHeight);

    if (sim.respawnTimer < lift) {
      const k = clamp01(sim.respawnTimer / lift);
      r.position.copy(sim.respawnFrom).addScaledVector(UP, 3.2 * k * (2 - k));
    } else if (drop < 0) {
      const k = clamp01((sim.respawnTimer - lift) / hang);
      const ease = k * k * (3 - 2 * k);
      r.position.copy(sim.respawnFrom).addScaledVector(UP, 3.2).lerp(scratchVec, ease);
      r.quaternion.slerp(slot.quaternion, clamp01(dt * 9));
    } else {
      // Down you go, with a shove forwards so the restart is not from a
      // standing start in the middle of the pack.
      r.position.copy(scratchVec);
      r.quaternion.copy(slot.quaternion);
      orientFromQuaternion(sim, slot.quaternion);
      r.velocity.copy(sim.forward).multiplyScalar(PHYS.respawnSpeed);
      r.respawning = false;
      r.invuln = Math.max(r.invuln, PHYS.respawnInvuln);
      sim.upVel.set(0, 0, 0);
      sim.coyote = 0;
      sim.hopMute = 0;
    }

    for (let i = 0; i < 4; i++) {
      sim.wheels[i].compression = damp(sim.wheels[i].compression, 0, 10, dt);
      r.wheelCompression[i] = sim.wheels[i].compression;
    }
    r.grounded = false;
    r.airTime = 0;
    r.speed = 0;
    r.rpm = damp(r.rpm, 0.2, 5, dt);
  }

  function orientFromQuaternion(sim: Sim, q: THREE.Quaternion): void {
    sim.forward.copy(FWD).applyQuaternion(q).normalize();
    sim.up.copy(UP).applyQuaternion(q).normalize();
    sim.right.crossVectors(sim.forward, sim.up).normalize();
    sim.upVel.set(0, 0, 0);
  }

  /** Last resort when the numbers have gone wrong: park it, silently. */
  function hardReset(sim: Sim): void {
    const r = sim.racer;
    const t = track();
    const slot = t
      ? t.respawnAt(Number.isFinite(sim.safeT) ? sim.safeT : 0, 0)
      : { position: new THREE.Vector3(0, 1, 0), quaternion: new THREE.Quaternion() };
    r.position.copy(slot.position).addScaledVector(UP, 0.5);
    r.velocity.set(0, 0, 0);
    r.quaternion.copy(slot.quaternion);
    orientFromQuaternion(sim, slot.quaternion);
    r.yawRate = 0;
    r.speed = 0;
    r.respawning = false;
    r.invuln = Math.max(r.invuln, 1);
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------
  function presetFor(characterId: string): CharacterPreset | undefined {
    const roster = models()?.roster;
    const list = roster && roster.length ? roster : FALLBACK_ROSTER;
    return list.find((p) => p.id === characterId) ?? list[0];
  }

  function place(sim: Sim, slotIndex: number): void {
    const r = sim.racer;
    const t = track();
    const slot = t
      ? t.gridSlot(slotIndex)
      : {
          position: new THREE.Vector3((slotIndex % 2 === 0 ? -1 : 1) * 3.7, 0.5, Math.floor(slotIndex / 2) * 7.5),
          quaternion: new THREE.Quaternion(),
        };
    r.position.copy(slot.position).addScaledVector(UP, 0.15);
    r.quaternion.copy(slot.quaternion);
    orientFromQuaternion(sim, slot.quaternion);
    r.velocity.set(0, 0, 0);
    r.yawRate = 0;
    r.speed = 0;
    r.rpm = 0;
    sim.hint = t ? t.project(r.position).t : 0;
    sim.safeT = sim.hint;
    sim.safeLane = 0;
    sim.travel = 0;
    r.t = sim.hint;
  }

  const service: KartPhysicsService = {
    racers,
    // Replaced the moment the grid is filled; a non-null placeholder keeps the
    // type honest for anything that reads `player` between now and then.
    player: undefined as unknown as KartRacer,
    paused: false,
    steps: 0,
    playerAi: false,

    spawn(spec) {
      let sim = byId.get(spec.id);
      if (!sim) {
        const racer = makeRacer(spec);
        sim = makeSim(racer, statsOf(presetFor(spec.characterId)));
        byId.set(spec.id, sim);
        sims.push(sim);
        racers.push(racer);
        pairClock = new Float32Array(sims.length * sims.length);
      } else {
        // Re-spawning an existing id is how a restart works: keep the object
        // identity so every consumer's captured reference stays valid.
        sim.racer.name = spec.name;
        sim.racer.characterId = spec.characterId;
        sim.racer.isPlayer = spec.isPlayer;
        sim.stats = statsOf(presetFor(spec.characterId));
        resetRacer(sim);
      }
      place(sim, spec.slot);
      if (spec.isPlayer) service.player = sim.racer;
      return sim.racer;
    },

    setControls(id, controls) {
      const sim = byId.get(id);
      if (!sim) return;
      sim.controls.accel = clamp01(controls.accel);
      sim.controls.brake = clamp01(controls.brake);
      sim.controls.steer = clamp(controls.steer, -1, 1);
      sim.controls.drift = !!controls.drift;
    },

    applyBoost(id, seconds, source) {
      const sim = byId.get(id);
      if (sim) grantBoost(sim, seconds, source);
    },

    applyHit(id, kind, seconds) {
      const sim = byId.get(id);
      if (sim) hit(sim, kind, seconds);
    },

    applyImpulse(id, impulse) {
      const sim = byId.get(id);
      if (!sim || !finite(impulse)) return;
      // Read as a velocity change for a medium kart, scaled by weight class, so
      // callers can think in m/s and a heavy still shrugs off a blast wave.
      const scale = BASE_MASS / Math.max(1, sim.stats.mass);
      sim.racer.velocity.addScaledVector(impulse, scale);
      if (impulse.dot(sim.up) > 0.5) {
        sim.coyote = 0;
        sim.hopMute = PHYS.hopMute;
        sim.racer.grounded = false;
      }
    },

    respawn(id) {
      const sim = byId.get(id);
      if (sim) beginRespawn(sim);
    },

    arcOf(id) {
      return byId.get(id)?.racer.t ?? 0;
    },

    safeArcOf(id) {
      return byId.get(id)?.safeT ?? 0;
    },

    get(id) {
      return byId.get(id)?.racer;
    },
  };

  // Published before anything can throw: later systems must find a handle here
  // even if filling the grid goes wrong.
  ctx.services.physics = service;

  function resetRacer(sim: Sim): void {
    const r = sim.racer;
    r.boost = 0;
    r.boostSource = null;
    r.draft = 0;
    r.stun = 0;
    r.stunKind = null;
    r.invuln = 0;
    r.star = 0;
    r.drifting = false;
    r.driftDir = 0;
    r.driftCharge = 0;
    r.driftTier = 0;
    r.trick = 0;
    r.squash = 1;
    r.hop = 0;
    r.bodyRoll = 0;
    r.bodyPitch = 0;
    r.steerAngle = 0;
    r.respawning = false;
    r.finished = false;
    r.airTime = 0;
    r.grounded = true;
    sim.controls.accel = 0;
    sim.controls.brake = 0;
    sim.controls.steer = 0;
    sim.controls.drift = false;
    sim.prevDrift = false;
    sim.steerSmoothed = 0;
    sim.driftTime = 0;
    sim.driftRamp = 0;
    sim.hopping = false;
    sim.hopLeft = false;
    sim.pendingDir = 0;
    sim.trickArmed = false;
    sim.trickTimer = 0;
    sim.airPitch = 0;
    sim.drownTimer = 0;
    sim.respawnSlot = null;
    sim.upVel.set(0, 0, 0);
  }

  // -------------------------------------------------------------------------
  // Fill the grid
  // -------------------------------------------------------------------------
  {
    const roster = models()?.roster;
    const list = roster && roster.length ? roster : FALLBACK_ROSTER;
    const field = Math.max(1, TUNING.fieldSize);
    // Mid-pack: rivals ahead to chase and rivals behind to worry about, which
    // is also the most interesting thing for a camera to look at.
    const playerSlot = Math.min(field - 1, 3);
    for (let i = 0; i < field; i++) {
      const preset = list[i % list.length];
      service.spawn({
        id: i,
        name: i === playerSlot ? GRID_NAMES[0] : preset.name || GRID_NAMES[(i % (GRID_NAMES.length - 1)) + 1],
        characterId: preset.id,
        isPlayer: i === playerSlot,
        slot: i,
      });
    }
    if (!service.player) service.player = racers[0];
  }

  // -------------------------------------------------------------------------
  // Player input, with edge latching
  // -------------------------------------------------------------------------
  // `fixedUpdate` can run several times per rendered frame while the engine
  // clears the edge flags only once, so a single button press would otherwise
  // be seen — and acted on — two or three times.
  let driftLatch = false;
  let trickLatch = false;

  function gatherControls(sim: Sim): { drift: boolean; trick: 0 | 1 | -1 } {
    const r = sim.racer;
    let driftEdge = false;
    let trickEdge: 0 | 1 | -1 = 0;

    if (r.isPlayer && !service.playerAi) {
      const inp = ctx.input;
      sim.controls.accel = clamp01(inp.accel);
      sim.controls.brake = clamp01(inp.brake);
      sim.controls.steer = clamp(inp.steer, -1, 1);
      sim.controls.drift = !!inp.drift;
      if (inp.driftPressed && !driftLatch) {
        driftEdge = true;
        driftLatch = true;
      } else if (!inp.driftPressed) {
        driftLatch = false;
      }
      if (inp.trick !== 0 && !trickLatch) {
        trickEdge = inp.trick;
        trickLatch = true;
      } else if (inp.trick === 0) {
        trickLatch = false;
      }
    }

    // A rising edge on the held state covers the AI, and catches a player press
    // that the frame-level flag missed.
    if (sim.controls.drift && !sim.prevDrift) driftEdge = true;
    sim.prevDrift = sim.controls.drift;
    return { drift: driftEdge, trick: trickEdge };
  }

  // -------------------------------------------------------------------------
  // The step
  // -------------------------------------------------------------------------
  function stepRacer(sim: Sim, dt: number): void {
    const r = sim.racer;
    const edges = gatherControls(sim);

    if (r.respawning) {
      stepRespawn(sim, dt);
      return;
    }

    const wasAir = r.grounded ? 0 : r.airTime;
    probeWheels(sim, track(), dt);

    // Touchdown. Measured before the springs get a chance to push back, which
    // is the only moment the real closing speed exists.
    if (r.grounded && wasAir > 0.12) {
      const impact = Math.max(0, -r.velocity.dot(sim.contactNormal));
      sim.landImpact = impact;
      if (impact > PHYS.landSoft) {
        const harshness = clamp01((impact - PHYS.landSoft) / (PHYS.landHard - PHYS.landSoft));
        // Landing flat costs you; landing on the nose costs you more.
        const along = r.velocity.dot(sim.forward);
        r.velocity.addScaledVector(sim.forward, -along * PHYS.landSpeedLoss * harshness);
      }
      ctx.emit("kart:land", { racer: r.id, impact });
    } else if (sim.landImpact > 0) {
      sim.landImpact = Math.max(0, sim.landImpact - dt * 40);
    }

    const out = stepDrive(sim, world, dt, edges.drift, edges.trick);
    applySuspension(sim, dt);
    alignBody(sim, dt, out.airPitch);
    integrate(sim, world, dt);
    locate(sim);
    surfaceEffects(sim, world, dt);
    checkFall(sim);
    writeCompression(sim, out.aLong, out.aLat, dt);
    writeVisuals(sim, out.aLat, dt);

    if (!finite(r.position) || !finite(r.velocity) || Math.abs(r.position.y) > 6000) hardReset(sim);
    r.quaternion.normalize();
  }

  /** Reproject onto the centreline and remember the last honest place to be. */
  function locate(sim: Sim): void {
    const t = track();
    const r = sim.racer;
    if (!t) return;
    const pr = t.project(r.position, sim.hint);
    sim.hint = pr.t;
    sim.roadHeight = pr.height;
    r.t = pr.t;
    r.lateral = pr.lateral;
    const props = SURFACES[r.surface] ?? SURFACES.road;
    if (r.grounded && !props.lethal && r.surface !== "water" && sim.contacts > 0) {
      sim.safeT = pr.t;
      // respawnAt takes a lane in [-1,1] and puts you 3.4 m off the centreline,
      // so preserve roughly which side of the road the racer was on.
      sim.safeLane = clamp(pr.lateral / 3.4, -1, 1);
    }
  }

  function checkFall(sim: Sim): void {
    const r = sim.racer;
    if (r.respawning) return;
    // Actually at the bottom of the drop, rather than merely sailing over it —
    // the gap jump reports void the whole way across.
    if (r.surface === "void" && sim.voidDepth < 3) {
      beginRespawn(sim);
      return;
    }
    if (sim.drownTimer > 0.8) {
      beginRespawn(sim);
      return;
    }
    // A long way under the road plane, on ground the course never classified as
    // lethal — the backstop for falling off the bluff itself.
    if (track()) {
      if (sim.roadHeight - r.position.y > 26) beginRespawn(sim);
    } else if (r.position.y < -40) {
      beginRespawn(sim);
    }
  }

  /** Everything the model rig and the HUD read but the simulation does not. */
  function writeVisuals(sim: Sim, aLat: number, dt: number): void {
    const r = sim.racer;
    r.wheelSpin = (r.wheelSpin + (r.speed / TUNING.wheelRadius) * dt) % (Math.PI * 2);

    const steerTarget = r.drifting
      ? clamp(r.driftDir * 0.34 + sim.steerSmoothed * 0.34, -1, 1)
      : sim.steerSmoothed;
    r.steerAngle = damp(r.steerAngle, steerTarget * PHYS.steerVisual, 15, dt);

    // Positive roll lifts the kart's right-hand side. In a right-hand drift the
    // kart leans away from the corner and hangs its inside wheels, which is
    // both what a real kart does and what reads best from the chase camera.
    const rollTarget = r.drifting
      ? r.driftDir * (0.15 + 0.09 * r.driftCharge)
      : clamp(aLat / 26, -1, 1) * 0.1;
    r.bodyRoll = damp(r.bodyRoll, r.grounded ? rollTarget : rollTarget * 0.4, 8, dt);
  }

  // -------------------------------------------------------------------------
  // Slipstream
  // -------------------------------------------------------------------------
  function updateDraft(dt: number): void {
    const n = sims.length;
    const minSpeed = TUNING.topSpeed * PHYS.draftMinSpeedFrac;
    const cone = Math.cos(PHYS.draftCone);
    for (let i = 0; i < n; i++) {
      const a = sims[i];
      const r = a.racer;
      if (a.draftCooldown > 0) {
        a.draftCooldown = Math.max(0, a.draftCooldown - dt);
        r.draft = 0;
        continue;
      }
      if (r.respawning || r.speed < minSpeed || !r.grounded) {
        r.draft = Math.max(0, r.draft - (dt * PHYS.draftDecay) / TUNING.draftChargeTime);
        continue;
      }
      let best = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const b = sims[j];
        if (b.racer.respawning) continue;
        scratchDelta.subVectors(b.racer.position, r.position);
        const d = scratchDelta.length();
        if (d > TUNING.draftDistance || d < 1.6) continue;
        // Directly behind, and pointing the same way: a tow, not a near miss.
        if (scratchDelta.dot(a.forward) / d < cone) continue;
        if (a.forward.dot(b.forward) < 0.7) continue;
        const closeness = 1 - d / TUNING.draftDistance;
        if (closeness > best) best = closeness;
      }
      if (best > 0) {
        r.draft = clamp01(r.draft + (dt * (0.5 + 0.5 * best)) / TUNING.draftChargeTime);
        if (r.draft >= 1) {
          r.draft = 0;
          a.draftCooldown = PHYS.draftRefractory;
          grantBoost(a, TUNING.draftBoost, "slipstream");
        }
      } else {
        r.draft = Math.max(0, r.draft - (dt * PHYS.draftDecay) / TUNING.draftChargeTime);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Visual rig binding
  // -------------------------------------------------------------------------
  let modelWarned = false;

  function syncModels(dt: number): void {
    const m = models();
    for (let i = 0; i < sims.length; i++) {
      const r = sims[i].racer;
      if (!r.object && m?.createRacer) {
        try {
          const obj = m.createRacer(r);
          if (obj) {
            r.object = obj;
            if (!obj.parent) ctx.scene.add(obj);
          }
        } catch (err) {
          if (!modelWarned) {
            modelWarned = true;
            console.error("[Vibe Kart] model rig failed to build:", err);
          }
        }
      }
      if (r.object) {
        r.object.position.copy(r.position);
        r.object.quaternion.copy(r.quaternion);
      }
      if (m?.poseRacer) {
        try {
          m.poseRacer(r, dt);
        } catch {
          /* a broken rig must not stop the race */
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // System
  // -------------------------------------------------------------------------
  const offPause = ctx.on("ui:pause", (() => {
    service.paused = true;
  }) as (p: never) => void);
  const offResume = ctx.on("ui:resume", (() => {
    service.paused = false;
  }) as (p: never) => void);

  return {
    fixedUpdate(dt) {
      steps++;
      service.steps = steps;
      world.paused = service.paused;
      for (let i = 0; i < sims.length; i++) stepRacer(sims[i], dt);
      resolveKartPairs(sims, world, pairClock, dt);
      updateDraft(dt);
    },

    lateUpdate(dt) {
      syncModels(dt);
    },

    dispose() {
      offPause();
      offResume();
      for (const sim of sims) {
        const obj = sim.racer.object;
        // The rig belongs to the model system; unparenting is as far as this
        // module's ownership goes.
        if (obj?.parent === ctx.scene) ctx.scene.remove(obj);
        sim.racer.object = undefined;
      }
      sims.length = 0;
      racers.length = 0;
      byId.clear();
      pairClock = new Float32Array(0);
      if (ctx.services.physics === service) delete ctx.services.physics;
    },
  };
}

/** Re-exported so sibling modules and tests can talk about a racer precisely. */
export type { KartRacer } from "./state";
export { PHYS, statsOf } from "./tuning";
