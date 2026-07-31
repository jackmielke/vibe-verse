/**
 * Vibe Kart — karts, drivers and the roster.
 *
 * Publishes `ctx.services.models` synchronously, before any building happens,
 * so the physics system can call `createRacer` the instant it boots.
 *
 * What this file owns, beyond the contract:
 *
 * · **One rig per racer**, built on demand and cached. If a racer turns up in
 *   `physics.racers` without anyone having asked for a rig, we build one — a
 *   spawn path that forgets to call us should cost nobody a visible kart.
 *
 * · **The contact shadows for the whole field in a single draw call.** Eight
 *   soft blobs are one InstancedMesh whose per-instance colour is repurposed as
 *   alpha, projected onto the road via `track.surfaceAt` when that service
 *   exists and onto a flat guess when it does not. Shadow maps alone leave a
 *   kart looking like it is hovering; this does the last centimetre.
 *
 * · **The tick.** `poseRacer` is part of the contract and other systems may
 *   call it, but we also drive it ourselves in `update()` behind a
 *   pose-once-per-frame guard, so the field animates whether or not anything
 *   else is alive.
 *
 * Measured budget at `high`: ~19 draw calls and ~16k triangles per racer, so a
 * full grid of eight is ~150 draws and ~127k triangles, plus one shadow draw
 * for the lot. At `low` the third paint colour, the chrome hub caps, the
 * contrast pass and the scarves are dropped, which takes it to ~14 draws.
 */
import * as THREE from "three";
import { TUNING, type CharacterPreset, type KartCtx, type ModelsService, type RacerState, type System } from "../types";
import { clamp01 } from "./math";
import { buildKart } from "./kart";
import { buildDriver } from "./driver";
import { createMaterialDesk } from "./materials";
import { bakeBlobShadow } from "./textures";
import { LOOKS, ROSTER, lookOf, type RacerLook } from "./roster";
import { makePoseState, poseRacer, type RacerRig } from "./pose";

export { ROSTER, LOOKS, lookOf };
export type { RacerLook, RacerRig };

/** Extra handles this system publishes on top of `ModelsService`. */
export interface KartModelsService extends ModelsService {
  /** VFX attachment points, in world space via their own transforms. */
  anchors(racerId: number): RacerAnchors | null;
  /** The full rig, for anything that needs to walk it. */
  rig(racerId: number): RacerRig | null;
  preset(characterId: string): CharacterPreset;
  /** Tear one racer's rig down (a mid-race character swap, or a test). */
  destroyRacer(racerId: number): void;
  /** Live budget numbers for the debug overlay. */
  stats: { rigs: number; triangles: number; drawCalls: number };
}

export interface RacerAnchors {
  /** Exhaust tip nodes, for flame and heat haze. */
  exhausts: THREE.Object3D[];
  /** Rear centre, for drift sparks and dropped items. */
  tail: THREE.Object3D;
  /** Driver head, for the boo/star aura and the results camera. */
  head: THREE.Object3D;
  /** Wheel contact points in racer-local space. */
  wheels: Array<{ x: number; y: number; z: number; radius: number }>;
}

const SHADOW_SLOTS = Math.max(12, TUNING.fieldSize + 4);

export default function createModels(ctx: KartCtx): System {
  const desk = createMaterialDesk(ctx);
  const quality = desk.quality;

  const root = new THREE.Group();
  root.name = "kart/models";
  ctx.scene.add(root);

  const rigs = new Map<number, RacerRig>();
  const posedThisFrame = new Set<number>();
  let frameStamp = -1;

  /** Reset the pose-once guard when the clock has moved on. */
  function newFrame(): void {
    if (ctx.elapsed === frameStamp) return;
    frameStamp = ctx.elapsed;
    posedThisFrame.clear();
  }

  // -- contact shadows -------------------------------------------------------

  // A 2D context is the one thing here that can be missing outright (headless
  // runners, locked-down webviews). A flat 8×8 falloff is a poor blob but a
  // perfectly good insurance policy.
  let shadowTex: THREE.Texture;
  try {
    shadowTex = bakeBlobShadow(quality.tier === "low" ? 64 : 128);
  } catch {
    const n = 16;
    const data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const d = Math.hypot(x / (n - 1) - 0.5, y / (n - 1) - 0.5) * 2;
        const a = Math.max(0, 1 - d) ** 2;
        data[(y * n + x) * 4 + 3] = Math.round(a * 220);
      }
    }
    shadowTex = new THREE.DataTexture(data, n, n);
    shadowTex.needsUpdate = true;
  }
  const shadowGeo = new THREE.PlaneGeometry(1, 1);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadowMat = desk.shadowMaterial(shadowTex);
  const shadows = new THREE.InstancedMesh(shadowGeo, shadowMat, SHADOW_SLOTS);
  shadows.name = "kart/contactShadows";
  shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shadows.frustumCulled = false;
  shadows.renderOrder = 2;
  shadows.castShadow = false;
  shadows.receiveShadow = false;
  {
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < SHADOW_SLOTS; i++) {
      shadows.setMatrixAt(i, hidden);
      shadows.setColorAt(i, white);
    }
  }
  root.add(shadows);
  let nextSlot = 0;

  // -- rig construction ------------------------------------------------------

  function buildRig(racer: RacerState): RacerRig {
    const look = lookOf(racer.characterId);
    const kit = desk.kitFor(look);
    const mats = desk.rigMaterials(look, kit, (racer.id % 8) + 1);

    const kart = buildKart({ style: look.kart, kit, rig: mats, quality });

    // The driver's hands have to arrive at the steering wheel rim, and the rim
    // moved when the kart's style scaled the cockpit — so the grip point is
    // derived from the built kart rather than guessed.
    const rimR = 0.17 * Math.min(look.kart.width * look.kart.scale, look.kart.scale);
    const grip = {
      x: rimR,
      y: kart.steering.position.y - kart.seat.position.y + 0.02,
      z: kart.steering.position.z - kart.seat.position.z - 0.04,
    };
    const driver = buildDriver({ look, kit, rig: mats, quality, grip });

    const root3 = new THREE.Group();
    root3.name = `racer:${racer.id}:${look.preset.id}`;
    const trickNode = new THREE.Group();
    const bodyNode = new THREE.Group();
    root3.add(trickNode);
    trickNode.add(bodyNode);
    bodyNode.add(kart.group);
    kart.seat.add(driver.group);
    if (driver.scarf) root3.add(driver.scarf.mesh);

    const materials: THREE.Material[] = [];
    const scarfMat = driver.scarf?.mesh.userData.ownedMaterial;
    if (scarfMat instanceof THREE.Material) materials.push(scarfMat);

    const rig: RacerRig = {
      id: racer.id,
      look,
      root: root3,
      trickNode,
      bodyNode,
      kart,
      driver,
      mats,
      state: makePoseState(racer.id),
      shadowSlot: nextSlot < SHADOW_SLOTS ? nextSlot++ : -1,
      geometries: [...kart.geometries, ...driver.geometries],
      materials,
      triangles: kart.triangles + driver.triangles,
    };

    root.add(root3);
    return rig;
  }

  function ensureRig(racer: RacerState): RacerRig {
    let rig = rigs.get(racer.id);
    if (rig) return rig;
    rig = buildRig(racer);
    rigs.set(racer.id, rig);
    racer.object = rig.root;
    return rig;
  }

  function destroy(rig: RacerRig): void {
    rig.root.removeFromParent();
    for (const g of rig.geometries) g.dispose();
    for (const m of rig.materials) m.dispose();
    if (rig.shadowSlot >= 0) {
      const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
      shadows.setMatrixAt(rig.shadowSlot, hidden);
      shadows.instanceMatrix.needsUpdate = true;
    }
  }

  // -- shadow projection -----------------------------------------------------

  const _pos = new THREE.Vector3();
  const _nrm = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _back = new THREE.Vector3();
  const _mat = new THREE.Matrix4();
  const _quat = new THREE.Quaternion();
  const _scale = new THREE.Vector3();
  const _col = new THREE.Color();

  function updateShadow(rig: RacerRig, racer: RacerState): void {
    if (rig.shadowSlot < 0) return;
    const track = ctx.services.track;
    let groundY = racer.position.y - TUNING.suspensionRest;
    _nrm.set(0, 1, 0);
    if (track) {
      try {
        const s = track.surfaceAt(racer.position);
        groundY = s.height;
        if (s.normal) _nrm.copy(s.normal).normalize();
      } catch {
        // A track query that throws is the track's problem; a flat guess keeps
        // the shadow on screen either way.
      }
    } else if (racer.grounded && racer.groundNormal) {
      _nrm.copy(racer.groundNormal).normalize();
    }

    const height = Math.max(0, racer.position.y - groundY - TUNING.suspensionRest * 0.6);
    // Airborne: the blob shrinks toward the landing point and fades, which is
    // the only altitude cue a player gets over a jump.
    const fade = clamp01(1 - height / 3) * (racer.finished ? 0.6 : 1);
    const grow = 1 + height * 0.22;

    _fwd.set(0, 0, -1).applyQuaternion(racer.quaternion);
    _fwd.addScaledVector(_nrm, -_fwd.dot(_nrm));
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    _back.copy(_fwd).negate();
    _right.crossVectors(_nrm, _back).normalize();
    _mat.makeBasis(_right, _nrm, _back);
    _quat.setFromRotationMatrix(_mat);

    _pos.set(racer.position.x, groundY + 0.025, racer.position.z);
    if (track) _pos.addScaledVector(_nrm, 0.01);
    const fp = rig.kart.footprint;
    _scale.set(fp.x * 2.4 * grow, 1, fp.z * 2.2 * grow);
    _mat.compose(_pos, _quat, _scale);
    shadows.setMatrixAt(rig.shadowSlot, _mat);
    _col.setRGB(fade * 0.9, fade, fade);
    shadows.setColorAt(rig.shadowSlot, _col);
  }

  // -- service ---------------------------------------------------------------

  const service: KartModelsService = {
    roster: ROSTER,

    createRacer(racer) {
      return ensureRig(racer).root;
    },

    poseRacer(racer, dt) {
      const rig = rigs.get(racer.id) ?? ensureRig(racer);
      // Physics may call this, and so do we. Whoever gets there first wins the
      // frame; a double call would integrate the springs twice.
      newFrame();
      if (posedThisFrame.has(racer.id)) return;
      posedThisFrame.add(racer.id);
      poseRacer(rig, racer, dt, {
        camera: ctx.camera,
        elapsed: ctx.elapsed,
        brake: racer.isPlayer ? ctx.input.brake : 0,
        accelInput: racer.isPlayer ? ctx.input.accel : 0,
        lookBack: racer.isPlayer ? ctx.input.lookBack : false,
      });
      updateShadow(rig, racer);
    },

    anchors(racerId) {
      const rig = rigs.get(racerId);
      if (!rig) return null;
      return {
        exhausts: rig.kart.exhausts,
        tail: rig.kart.tail,
        head: rig.driver.head,
        wheels: rig.kart.wheels.map((w) => ({ x: w.x, y: w.y, z: w.z, radius: w.radius })),
      };
    },

    rig(racerId) {
      return rigs.get(racerId) ?? null;
    },

    preset(characterId) {
      return lookOf(characterId).preset;
    },

    destroyRacer(racerId) {
      const rig = rigs.get(racerId);
      if (!rig) return;
      destroy(rig);
      rigs.delete(racerId);
    },

    stats: { rigs: 0, triangles: 0, drawCalls: 0 },
  };

  // Published before anything is built, per the boot contract.
  ctx.services.models = service;

  return {
    update(dt) {
      newFrame();
      // One reference compare a frame, and every clone we own follows the sky
      // through a tunnel or a change of time of day.
      desk.update();

      const racers = ctx.services.physics?.racers;
      if (racers) {
        for (const racer of racers) {
          if (!racer) continue;
          service.poseRacer(racer, dt);
        }
        // A racer that vanished from the field takes its rig with it.
        if (rigs.size > racers.length) {
          const live = new Set(racers.map((r) => r.id));
          for (const [id, rig] of rigs) {
            if (live.has(id)) continue;
            destroy(rig);
            rigs.delete(id);
          }
        }
      }

      shadows.instanceMatrix.needsUpdate = true;
      if (shadows.instanceColor) shadows.instanceColor.needsUpdate = true;

      let tris = 0;
      for (const rig of rigs.values()) tris += rig.triangles;
      service.stats.rigs = rigs.size;
      service.stats.triangles = tris;
      // Meshes per rig + the one shared shadow draw.
      service.stats.drawCalls = rigs.size * (quality.frills ? 19 : 14) + 1;
    },

    dispose() {
      for (const rig of rigs.values()) destroy(rig);
      rigs.clear();
      shadowGeo.dispose();
      shadowTex.dispose();
      desk.dispose();
      root.removeFromParent();
      if (ctx.services.models === service) delete ctx.services.models;
    },
  };
}
