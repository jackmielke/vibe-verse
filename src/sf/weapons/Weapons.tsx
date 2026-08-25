/**
 * weapons/Weapons.tsx — the gun in the player's hands.
 *
 * This component owns the *stateful* half of the gunplay: which weapon is out,
 * how much is in it, what the trigger is doing, and the order in which the
 * eight subsystems below it run each frame. Everything it does is a
 * composition of those subsystems; there is no simulation in here beyond
 * bookkeeping, and there is deliberately no React state in the hot path.
 *
 * Frame order, which is not arbitrary:
 *
 *   1. read input edges           — press/release derived here, not upstream
 *   2. weapon switch / reload     — these gate everything after them
 *   3. recoil                     — reads the player's look delta *before*
 *                                   anything else touches frame.yaw/pitch,
 *                                   which is what compensation eating needs
 *   4. viewmodel animation        — consumes recoil, emits reload/bolt events
 *   5. place the viewmodel        — from the camera the controller just set,
 *                                   so the muzzle is current when we fire
 *   6. fire                       — spends ammo, spawns rounds and effects
 *   7. advance projectiles        — after firing, so a rocket moves on the
 *                                   frame it was launched
 *   8. effects, impacts, HUD      — everything downstream of the above
 *
 * The viewmodel is not parented to the camera. R3F's default camera is not in
 * the scene graph, so children of it are never traversed; instead the weapon
 * group lives in the scene and copies the camera transform every frame. Same
 * result, no dependency on how the camera happens to be mounted.
 *
 * Public API
 * ----------
 *   default export <Weapons />
 *   weaponHud            per-frame HUD read model (no React churn)
 *   weaponSystem()       the live system, for debug tooling
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { PLAYER, WORLD_SEED, type QualityTier } from "../config";
import { frame, useSfStore } from "../state/store";
import { clamp, clamp01, makeRng, smoothstep, type Rng } from "../math/rng";
import {
  ALL_SOLID,
  GROUP,
  destruction,
  interactionGroups,
  makeRayHit,
  raycast,
  sphereCast,
} from "../physics";
import {
  applyEntityDamage,
  environmentEcho,
  playGunshot,
  playWeaponSound,
  pollGlobalSinks,
  primeWeaponAudio,
} from "./bridge";
import {
  clearBallistics,
  detonateSticky,
  fireHitscan,
  onWeaponExplosion,
  spawnProjectile,
  spreadDirection,
  stickyCount,
  updateBallistics,
} from "./ballistics";
import { WeaponEffects } from "./effects";
import { ImpactSystem } from "./impacts";
import { installWeaponInput, weaponInput } from "./input";
import { recoilSystem } from "./recoil";
import {
  WEAPON_ORDER,
  damageAtRange,
  fireInterval,
  getWeapon,
  spreadDegrees,
} from "./registry";
import { buildViewmodel, type Viewmodel } from "./viewmodelMesh";
import { viewmodelAnimator, type VmEvent } from "./viewmodelAnim";
import type { ShotContext, WeaponDef, WeaponHit } from "./types";

const BULLET_MASK = interactionGroups(0xffff, ALL_SOLID & ~GROUP.PLAYER);

/* ------------------------------------------------------------------ *
 * HUD read model
 * ------------------------------------------------------------------ */

/**
 * Everything the HUD needs, updated in place.
 *
 * Ammo also goes into zustand (the HUD wants to re-render on it), but the
 * things that change every frame — crosshair bloom, hitmarker age, heat —
 * live here so a crosshair animation never costs a React render.
 */
export const weaponHud = {
  weapon: "sidearm",
  magazine: 0,
  reserve: 0,
  /** Current cone half-angle in degrees; scale the crosshair by it. */
  spread: 1,
  /** 0..1 aim-down-sights blend. */
  ads: 0,
  /** Sim time of the last hitmarker, and what it was. */
  hitmarkerAt: -100,
  hitmarkerKind: "body" as "body" | "head" | "kill" | "armour",
  /** 0..1 barrel heat. */
  heat: 0,
  /** 0..1 breath meter while scoped. */
  breath: 1,
  /** Placed sticky mines waiting on the detonator. */
  stickies: 0,
  /** True when the trigger would do something. */
  canFire: true,
  reloading: false,
  /** True while a scoped weapon is at full magnification. */
  scoped: false,
};

/* ------------------------------------------------------------------ *
 * Scratch
 * ------------------------------------------------------------------ */

const _dir = new THREE.Vector3();
const _off = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _mdir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, "YXZ");
const _camPos = new THREE.Vector3();
const _impulse = { x: 0, y: 0, z: 0 };
const _point = { x: 0, y: 0, z: 0 };
const _probe = makeRayHit();
const _conv = makeRayHit();

interface AmmoRuntime {
  mag: number;
  reserve: number;
}

/* ------------------------------------------------------------------ *
 * The system
 * ------------------------------------------------------------------ */

export class WeaponSystem {
  readonly fx: WeaponEffects;
  readonly impacts: ImpactSystem;
  /** Scene-space container for the viewmodel. */
  readonly vmGroup = new THREE.Group();

  private viewmodels = new Map<string, Viewmodel>();
  private vm: Viewmodel | null = null;
  private loadout: string[];
  private currentKey: string;
  private pendingKey: string | null = null;

  private ammo = new Map<string, AmmoRuntime>();
  private rng: Rng = makeRng(`${WORLD_SEED}:weapons`);

  /* ---- trigger state ---- */
  private prevFire = false;
  private prevReload = false;
  private prevDetonate = false;
  private prevInspect = false;
  private nextFireTime = -1;
  private burstLeft = 0;
  private cooking = false;
  private cookTime = 0;
  private magAtReloadStart = 0;
  private lastShotDistance = 0;
  private firstImpactOfShot = true;
  private wantAutoReload = false;

  /** Set false while the harness owns the camera. */
  enabled = true;

  private detachAnim: (() => void) | null = null;
  private disposed = false;

  constructor(tier: QualityTier, loadout: string[], start: string) {
    this.fx = new WeaponEffects(tier);
    this.impacts = new ImpactSystem(this.fx, tier);
    this.loadout = loadout.filter((k) => !!getWeapon(k));
    this.currentKey = this.loadout.includes(start) ? start : this.loadout[0] ?? "sidearm";

    for (const key of this.loadout) {
      const def = getWeapon(key);
      this.ammo.set(key, { mag: def.magazine, reserve: def.startReserve });
    }

    this.fx.casingLandHandler = (x, y, z, s) => this.impacts.casingLanded(x, y, z, s);

    // Explosions from the ballistics layer are ours to draw.
    onWeaponExplosion((x, y, z, radius, def) => this.fx.explosion(x, y, z, radius, def));

    this.detachAnim = viewmodelAnimator.onEvent((e, def) => this.onAnimEvent(e, def));

    this.equip(this.currentKey, true);
  }

  /* ---------------- ammo ---------------- */

  private runtime(key: string): AmmoRuntime {
    let r = this.ammo.get(key);
    if (!r) {
      const def = getWeapon(key);
      r = { mag: def.magazine, reserve: def.startReserve };
      this.ammo.set(key, r);
    }
    return r;
  }

  private publishAmmo(key: string): void {
    const r = this.runtime(key);
    useSfStore.getState().setAmmo(key, { magazine: r.mag, reserve: r.reserve });
    if (key === this.currentKey) {
      weaponHud.magazine = r.mag;
      weaponHud.reserve = r.reserve;
    }
  }

  /** Give the player ammo — pickups call this. Returns what was taken. */
  addAmmo(key: string, rounds: number): number {
    const def = getWeapon(key);
    const r = this.runtime(key);
    const room = def.reserve - r.reserve;
    const take = Math.max(0, Math.min(room, rounds));
    r.reserve += take;
    this.publishAmmo(key);
    return take;
  }

  /* ---------------- equipping ---------------- */

  private viewmodelFor(key: string): Viewmodel {
    let vm = this.viewmodels.get(key);
    if (!vm) {
      vm = buildViewmodel(getWeapon(key));
      this.viewmodels.set(key, vm);
    }
    return vm;
  }

  private equip(key: string, immediate: boolean): void {
    const def = getWeapon(key);
    this.currentKey = key;
    if (this.vm) this.vmGroup.remove(this.vm.root);
    this.vm = this.viewmodelFor(key);
    this.vmGroup.add(this.vm.root);
    // The heat shimmer rides the barrel of whatever is in hand.
    this.vm.root.add(this.fx.heatQuad);
    this.fx.heatQuad.position.copy(this.vm.muzzle.position);
    this.fx.heatQuad.position.z += 0.06;
    this.fx.heatQuad.position.y += 0.09;

    recoilSystem.resetPattern();
    viewmodelAnimator.cancel();
    viewmodelAnimator.play("draw", def);
    useSfStore.getState().setWeapon(key);
    useSfStore.getState().setReloading(false);
    weaponHud.weapon = key;
    weaponHud.scoped = def.sight.scoped;
    this.publishAmmo(key);
    this.burstLeft = 0;
    this.cooking = false;
    this.nextFireTime = frame.time + (immediate ? 0.1 : def.handling.drawTime * 0.6);
  }

  /** Request a weapon change. Honours the holster animation. */
  switchTo(key: string): void {
    if (!this.loadout.includes(key) || key === this.currentKey) return;
    if (this.pendingKey === key) return;
    this.pendingKey = key;
    viewmodelAnimator.play("holster", getWeapon(this.currentKey));
  }

  cycle(step: number): void {
    if (this.loadout.length < 2) return;
    const i = this.loadout.indexOf(this.pendingKey ?? this.currentKey);
    const n = this.loadout.length;
    const next = this.loadout[((i + step) % n + n) % n];
    this.switchTo(next);
  }

  get weapon(): WeaponDef {
    return getWeapon(this.currentKey);
  }

  /* ---------------- animation events ---------------- */

  private onAnimEvent(e: VmEvent, def: WeaponDef): void {
    const local = { x: frame.position.x, y: frame.position.y, z: frame.position.z, local: true };
    switch (e) {
      case "magOut":
        playWeaponSound(def.audio.reloadOut, { ...local, volume: 0.7 });
        break;
      case "magIn": {
        playWeaponSound(def.audio.reloadIn, { ...local, volume: 0.8 });
        this.creditMagazine(def);
        break;
      }
      case "bolt":
        playWeaponSound(def.audio.bolt, { ...local, volume: 0.85 });
        break;
      case "shellIn": {
        playWeaponSound(def.audio.reloadIn, { ...local, volume: 0.75, pitch: 0.95 + this.rng.next() * 0.1 });
        const r = this.runtime(def.key);
        if (r.reserve > 0 && r.mag < def.magazine) {
          r.mag++;
          r.reserve--;
          this.publishAmmo(def.key);
        }
        if (r.reserve <= 0 || r.mag >= def.magazine) viewmodelAnimator.interruptShells = true;
        break;
      }
      case "cycleOut":
        // Manual actions eject on the *cycle*, not on the shot — a bolt gun
        // that throws brass at the moment of firing is an instant tell.
        playWeaponSound(def.audio.bolt, { ...local, volume: 0.7, pitch: 1.05 });
        this.ejectCasing(def);
        break;
      case "cycleIn":
        playWeaponSound(def.audio.bolt, { ...local, volume: 0.6, pitch: 0.92 });
        break;
      case "drawStart":
        playWeaponSound(def.audio.draw, { ...local, volume: 0.6 });
        break;
      case "holsterEnd":
        if (this.pendingKey) {
          const key = this.pendingKey;
          this.pendingKey = null;
          this.equip(key, false);
        }
        break;
      case "reloadEnd":
        useSfStore.getState().setReloading(false);
        break;
      case "dryFire":
        playWeaponSound(def.audio.dry, { ...local, volume: 0.5 });
        break;
      default:
        break;
    }
  }

  private creditMagazine(def: WeaponDef): void {
    const r = this.runtime(def.key);
    // A chambered round survives a tactical reload — mag + 1.
    const cap = def.magazine + (def.chambered && this.magAtReloadStart > 0 ? 1 : 0);
    const want = Math.max(0, cap - r.mag);
    const take = Math.min(want, r.reserve);
    r.mag += take;
    r.reserve -= take;
    this.publishAmmo(def.key);
  }

  /* ---------------- reloading ---------------- */

  startReload(): void {
    const def = this.weapon;
    const r = this.runtime(def.key);
    if (viewmodelAnimator.busy || r.reserve <= 0) return;
    const cap = def.magazine + (def.chambered && r.mag > 0 ? 1 : 0);
    if (r.mag >= cap) return;

    this.magAtReloadStart = r.mag;
    useSfStore.getState().setReloading(true);
    if (def.handling.shellTime) {
      const need = Math.min(def.magazine - r.mag, r.reserve);
      viewmodelAnimator.play("shellStart", def, need);
    } else {
      viewmodelAnimator.play(r.mag > 0 ? "reloadTactical" : "reloadEmpty", def);
    }
  }

  /* ---------------- firing ---------------- */

  private context(): ShotContext {
    return {
      ads: viewmodelAnimator.currentPose.adsT,
      crouched: weaponInput.crouch,
      moving: frame.speed > 1.6,
      airborne: !frame.grounded && frame.movement !== "vehicle",
      sprinting: weaponInput.sprint && frame.speed > 5,
      time: frame.time,
    };
  }

  /** Direction the crosshair is pointing, rebuilt from yaw/pitch. */
  private aimDirection(out: THREE.Vector3): THREE.Vector3 {
    const cy = Math.cos(frame.yaw);
    const sy = Math.sin(frame.yaw);
    const cp = Math.cos(frame.pitch);
    const sp = Math.sin(frame.pitch);
    return out.set(-sy * cp, sp, -cy * cp).normalize();
  }

  private onHit = (h: WeaponHit, def: WeaponDef): void => {
    // Visuals and audio first: they run even for zero-damage exit wounds.
    this.impacts.spawn(h, def);

    if (this.firstImpactOfShot && h.damage >= 0) {
      this.firstImpactOfShot = false;
      this.lastShotDistance = h.distance > 0 ? h.distance : 40;
    }

    if (h.damage <= 0) return;

    /* ---- entities ---- */
    if (h.targetId >= 0) {
      const res = applyEntityDamage(h.object, h.targetId, h.damage, h, def);
      if (res.applied > 0) this.hitmarker(h.part === "head" ? "head" : "body", res.killed);
      return;
    }

    const obj = h.object;
    if (!obj) return;

    /* ---- destructibles ---- */
    if (obj.destructibleId >= 0) {
      const imp = h.damage * 0.5;
      destruction.applyDamage(
        obj.destructibleId,
        h.damage * def.structure,
        h.x, h.y, h.z,
        h.dx * imp, h.dy * imp, h.dz * imp,
      );
    }

    /* ---- gameplay bodies ---- */
    if (obj.kind === "enemy" || obj.kind === "ragdoll" || obj.kind === "vehicle") {
      const res = applyEntityDamage(obj, obj.id, h.damage * (obj.kind === "vehicle" ? def.structure : 1), h, def);
      if (res.applied > 0) this.hitmarker(h.part === "head" ? "head" : "body", res.killed);
    }

    /* ---- momentum ---- */
    // A round carries real momentum: mass × velocity is small, but scaled to
    // gameplay it is what makes a shot to a propane tank *shove* it.
    if (obj.body && obj.kind !== "building" && obj.kind !== "terrain") {
      const k = clamp(h.damage * 0.22, 0, 90);
      _impulse.x = h.dx * k;
      _impulse.y = h.dy * k;
      _impulse.z = h.dz * k;
      _point.x = h.x;
      _point.y = h.y;
      _point.z = h.z;
      try {
        obj.body.applyImpulseAtPoint(_impulse, _point, true);
      } catch {
        /* body was removed between query and apply */
      }
    }
  };

  private hitmarker(kind: "body" | "head" | "kill" | "armour", killed: boolean): void {
    weaponHud.hitmarkerAt = frame.time;
    weaponHud.hitmarkerKind = killed ? "kill" : kind;
    playWeaponSound(killed ? "hitmarker_kill" : kind === "head" ? "hitmarker_head" : "hitmarker", {
      x: frame.position.x, y: frame.position.y, z: frame.position.z,
      local: true,
      volume: killed ? 0.5 : 0.32,
      pitch: kind === "head" ? 1.25 : 1,
    });
  }

  private ejectCasing(def: WeaponDef): void {
    if (!this.vm) return;
    this.vm.ejectPort.getWorldPosition(_off);
    _right.set(1, 0, 0).applyQuaternion(this.vmGroup.quaternion);
    _up.set(0, 1, 0).applyQuaternion(this.vmGroup.quaternion);
    this.fx.ejectCasing(
      def,
      _off.x, _off.y, _off.z,
      _right.x, _right.y, _right.z,
      _up.x, _up.y, _up.z,
      frame.velocity.x, frame.velocity.y, frame.velocity.z,
    );
  }

  /**
   * One trigger pull's worth of rounds.
   *
   * Shotguns fire their whole pattern here; everything else fires one round
   * and lets the cadence gate handle the next.
   */
  private fireOnce(def: WeaponDef, ctx: ShotContext): void {
    const r = this.runtime(def.key);
    if (r.mag <= 0) {
      viewmodelAnimator.onDryFire(def);
      this.nextFireTime = frame.time + 0.28;
      this.wantAutoReload = true;
      return;
    }

    r.mag--;
    this.publishAmmo(def.key);

    this.aimDirection(_dir);
    // Rays start at the eye, not the muzzle: the crosshair is the contract,
    // and a round that comes out of the barrel's actual position clips the
    // corner the player is peeking around.
    if (this.lastCameraPos) _camPos.copy(this.lastCameraPos);
    else _camPos.set(frame.position.x, frame.position.y, frame.position.z);

    // Where the barrel actually is, for effects and for projectile launches.
    if (this.vm) {
      this.vm.muzzle.getWorldPosition(_muzzle);
      _mdir.set(0, 0, -1).applyQuaternion(this.vmGroup.quaternion);
    } else {
      _muzzle.copy(_camPos);
      _mdir.copy(_dir);
    }

    const cone = spreadDegrees(def, ctx, recoilSystem.bloom);
    const pellets = def.spread.pellets ?? 1;
    const pelletCone = def.spread.pelletCone ?? 0;

    this.firstImpactOfShot = true;
    this.lastShotDistance = 0;

    if (def.ballistics === "projectile") {
      // Converge the launch on whatever the crosshair is over, so a grenade
      // launched from a barrel 30 cm right of the eye still lands on the mark.
      const range = raycast(_camPos.x, _camPos.y, _camPos.z, _dir.x, _dir.y, _dir.z, 400, _conv, {
        groups: BULLET_MASK, skipSurface: true,
      })
        ? _conv.distance
        : 400;
      _aim.copy(_camPos).addScaledVector(_dir, Math.max(6, range));
      _aim.sub(_muzzle).normalize();
      const s = spreadDirection(_aim.x, _aim.y, _aim.z, cone, this.rng);
      const p = spawnProjectile(def, _muzzle.x, _muzzle.y, _muzzle.z, s.x, s.y, s.z, ctx, {
        inheritX: frame.velocity.x * 0.5,
        inheritY: frame.velocity.y * 0.5,
        inheritZ: frame.velocity.z * 0.5,
      });
      if (p) this.lastShotDistance = 0;
    } else {
      for (let i = 0; i < pellets; i++) {
        const c = pellets > 1 ? pelletCone * (0.65 + this.rng.next() * 0.5) + cone : cone;
        const s = spreadDirection(_dir.x, _dir.y, _dir.z, c, this.rng);
        fireHitscan(def, _camPos.x, _camPos.y, _camPos.z, s.x, s.y, s.z, ctx, this.rng, this.onHit);
      }
    }

    /* ---- feel ---- */
    recoilSystem.onShot(def, ctx);
    viewmodelAnimator.onFire(def);

    this.fx.muzzleFlash(def, _muzzle.x, _muzzle.y, _muzzle.z, _mdir.x, _mdir.y, _mdir.z);
    this.fx.muzzleSmoke(def, _muzzle.x, _muzzle.y, _muzzle.z, _mdir.x, _mdir.y, _mdir.z);
    if (def.tracerFraction > 0 && this.rng.next() < def.tracerFraction) {
      this.fx.tracer(
        def, _muzzle.x, _muzzle.y, _muzzle.z, _dir.x, _dir.y, _dir.z,
        this.lastShotDistance > 0 ? this.lastShotDistance : 260,
      );
    }
    // Self-loading actions throw brass now; manual actions wait for the cycle.
    const manual = def.fireMode === "bolt" || def.fireMode === "pump";
    if (!manual) this.ejectCasing(def);

    /* ---- report ---- */
    const echo = environmentEcho(frame.position.x, frame.position.y + 1.5, frame.position.z);
    // Calibre "weight" for the fallback synth: a .45 and a .338 must not share
    // a voice even when no audio system is attached.
    const weight = clamp01(
      (damageAtRange(def, 0) / 120) * 0.6 + (def.view.casing[1] ?? 0.02) * 8 + (def.explosive ? 0.5 : 0),
    );
    playGunshot(def.audio.fire, weight, {
      x: _muzzle.x, y: _muzzle.y, z: _muzzle.z,
      local: true,
      volume: 0.9,
      pitch: 0.97 + this.rng.next() * 0.06,
      loudness: def.audio.loudness,
    }, echo);

    this.nextFireTime = frame.time + fireInterval(def);
  }

  private throwGrenade(def: WeaponDef, ctx: ShotContext, cooked: number): void {
    const r = this.runtime(def.key);
    if (r.mag <= 0 && r.reserve <= 0) return;
    if (r.mag > 0) r.mag--;
    else r.reserve--;
    this.publishAmmo(def.key);

    this.aimDirection(_dir);
    if (this.vm) this.vm.muzzle.getWorldPosition(_muzzle);
    else _muzzle.copy(frame.position);

    const fuse = Math.max(0.12, (def.explosive?.fuse ?? 4) - cooked);
    // Throwing arc: a hand throw is aimed a little above the crosshair, which
    // is what every player expects from muscle memory.
    _aim.copy(_dir);
    _aim.y += 0.12;
    _aim.normalize();
    const s = spreadDirection(_aim.x, _aim.y, _aim.z, def.spread.hip * 0.4, this.rng);
    spawnProjectile(def, _muzzle.x, _muzzle.y, _muzzle.z, s.x, s.y, s.z, ctx, {
      fuse,
      inheritX: frame.velocity.x * 0.7,
      inheritY: frame.velocity.y * 0.7,
      inheritZ: frame.velocity.z * 0.7,
    });

    recoilSystem.onShot(def, ctx);
    viewmodelAnimator.onFire(def);
    playWeaponSound(def.audio.fire, {
      x: _muzzle.x, y: _muzzle.y, z: _muzzle.z, local: true, volume: 0.6,
    });
    this.nextFireTime = frame.time + fireInterval(def);

    // Out of grenades in hand: pull the next one from the pouch.
    if (r.mag <= 0 && r.reserve > 0) this.startReload();
  }

  /* ---------------- frame ---------------- */

  private lastCameraPos: THREE.Vector3 | null = null;

  update(dt: number, camera: THREE.Camera): void {
    if (this.disposed) return;
    pollGlobalSinks();

    const def = this.weapon;
    const ctx = this.context();
    const paused = frame.paused;

    if (!this.lastCameraPos) this.lastCameraPos = new THREE.Vector3();
    camera.getWorldPosition(this.lastCameraPos);

    /* ---- 1. input edges ---- */
    const firePressed = weaponInput.fire && !this.prevFire;
    const fireReleased = !weaponInput.fire && this.prevFire;
    const reloadPressed = weaponInput.reload && !this.prevReload;
    const detonatePressed = weaponInput.detonate && !this.prevDetonate;
    const inspectPressed = weaponInput.inspect && !this.prevInspect;
    this.prevFire = weaponInput.fire;
    this.prevReload = weaponInput.reload;
    this.prevDetonate = weaponInput.detonate;
    this.prevInspect = weaponInput.inspect;

    if (this.enabled && !paused) {
      /* ---- 2. switching / reloading / detonating ---- */
      if (weaponInput.slot >= 0) {
        const key = this.loadout[weaponInput.slot] ?? WEAPON_ORDER[weaponInput.slot];
        weaponInput.slot = -1;
        if (key) this.switchTo(key);
      }
      if (weaponInput.cycle !== 0) {
        const step = weaponInput.cycle > 0 ? 1 : -1;
        weaponInput.cycle = 0;
        this.cycle(step);
      }
      if (detonatePressed && stickyCount() > 0) {
        detonateSticky(this.onHit, true);
      }
      if (reloadPressed) this.startReload();
      if (inspectPressed && !viewmodelAnimator.busy) viewmodelAnimator.play("inspect", def);

      // Firing interrupts a shell-by-shell reload at the next shell.
      if (weaponInput.fire && viewmodelAnimator.current === "shellLoad") {
        viewmodelAnimator.interruptShells = true;
      }
    }

    /* ---- 3. recoil (reads the player's look delta before anything else
             writes to frame.yaw/pitch) ---- */
    recoilSystem.setBreathHold(weaponInput.holdBreath && def.sight.scoped);
    const canFire = this.canFire(def);
    recoilSystem.update(paused ? 0 : dt, def, ctx, canFire);

    /* ---- 4. viewmodel animation ---- */
    const pose = viewmodelAnimator.update(paused ? 0 : dt, def, {
      wantAds: weaponInput.ads && this.enabled,
      sprinting: ctx.sprinting,
      speed: frame.speed,
      grounded: frame.grounded,
      verticalVelocity: frame.velocity.y,
    });

    /* ---- 5. place the viewmodel ----
       Before firing, not after: the muzzle empty is what the flash, the smoke
       and the casing are spawned from, and a frame-old muzzle transform is
       visible as a flash that trails the gun during a fast turn. */
    this.placeViewmodel(camera, pose.x, pose.y, pose.z, pose.pitch, pose.yaw, pose.roll, pose);

    /* ---- 6. firing ---- */
    // Refresh the ADS blend the shot will be judged with: spread, recoil scale
    // and the sight picture must all agree with the frame being drawn.
    ctx.ads = pose.adsT;
    if (this.enabled && !paused) {
      this.updateTrigger(dt, def, ctx, firePressed, fireReleased);
    }

    /* ---- 7. projectiles ---- */
    if (!paused) updateBallistics(dt, this.onHit);

    /* ---- 8. downstream ---- */
    this.fx.update(paused ? 0 : dt, camera, pose.heat);
    this.impacts.update(paused ? 0 : dt);
    recoilSystem.applyToCamera(camera);
    this.applyFov(camera, def, pose.adsT);

    /* ---- HUD ---- */
    const r = this.runtime(def.key);
    weaponHud.weapon = def.key;
    weaponHud.magazine = r.mag;
    weaponHud.reserve = r.reserve;
    weaponHud.spread = recoilSystem.cone;
    weaponHud.ads = pose.adsT;
    weaponHud.heat = pose.heat;
    weaponHud.breath = recoilSystem.breath;
    weaponHud.stickies = stickyCount();
    weaponHud.canFire = canFire;
    weaponHud.reloading = viewmodelAnimator.busy;
    weaponHud.scoped = def.sight.scoped && pose.adsT > 0.9;
    const aiming = pose.adsT > 0.55;
    if (useSfStore.getState().aiming !== aiming) useSfStore.getState().setAiming(aiming);

    /* ---- auto-reload after a dry trigger ---- */
    if (this.wantAutoReload && !viewmodelAnimator.busy) {
      this.wantAutoReload = false;
      this.startReload();
    }
  }

  private canFire(def: WeaponDef): boolean {
    if (!this.enabled || frame.paused) return false;
    if (viewmodelAnimator.busy || viewmodelAnimator.cycling) return false;
    if (viewmodelAnimator.currentPose.sprintT > 0.35) return false;
    if (frame.time < this.nextFireTime) return false;
    return this.runtime(def.key).mag > 0;
  }

  private updateTrigger(
    dt: number,
    def: WeaponDef,
    ctx: ShotContext,
    pressed: boolean,
    released: boolean,
  ): void {
    /* ---- thrown: press to pull the pin, release to throw ---- */
    if (def.fireMode === "throw") {
      if (pressed && !viewmodelAnimator.busy && this.runtime(def.key).mag > 0) {
        this.cooking = true;
        this.cookTime = 0;
        playWeaponSound(def.audio.reloadIn, {
          x: frame.position.x, y: frame.position.y, z: frame.position.z, local: true, volume: 0.55,
        });
      }
      if (this.cooking) {
        this.cookTime += dt;
        const fuse = def.explosive?.fuse ?? 4;
        // Cook it too long and it goes off in your hand. It should.
        if (this.cookTime >= fuse - 0.05) {
          this.cooking = false;
          this.throwGrenade(def, ctx, fuse - 0.08);
          return;
        }
        if (released) {
          this.cooking = false;
          this.throwGrenade(def, ctx, this.cookTime);
        }
      }
      return;
    }

    const ready = this.canFire(def);

    /* ---- burst ---- */
    if (def.fireMode === "burst") {
      if (pressed && this.burstLeft <= 0 && ready) this.burstLeft = def.burst ?? 3;
      if (this.burstLeft > 0 && ready) {
        this.fireOnce(def, ctx);
        this.burstLeft--;
        if (this.burstLeft <= 0) this.nextFireTime += def.burstDelay ?? 0.2;
      }
      return;
    }

    const wants =
      def.fireMode === "auto"
        ? weaponInput.fire
        : pressed;

    if (!wants || !ready) {
      if (pressed && !ready && this.runtime(def.key).mag <= 0 && !viewmodelAnimator.busy) {
        viewmodelAnimator.onDryFire(def);
        this.nextFireTime = frame.time + 0.28;
        this.wantAutoReload = true;
      }
      return;
    }
    this.fireOnce(def, ctx);
  }

  /**
   * Copy the camera transform, apply the animated local pose, then push the
   * weapon out of any wall it is about to clip through.
   */
  private placeViewmodel(
    camera: THREE.Camera,
    x: number, y: number, z: number,
    pitch: number, yaw: number, roll: number,
    pose: { slide: number; mag: number; heat: number; hide: number; adsT: number },
  ): void {
    const g = this.vmGroup;
    camera.getWorldQuaternion(_q);
    camera.getWorldPosition(_camPos);

    /* ---- weapon collision ---- */
    // One sphere cast down the barrel line. Inside about 70 cm the weapon
    // rotates up and back — it is the cheapest fix for the oldest FPS bug,
    // and it doubles as a readable "you are too close to shoot" cue.
    let push = 0;
    _dir.set(0, 0, -1).applyQuaternion(_q);
    if (
      sphereCast(0.1, _camPos.x, _camPos.y, _camPos.z, _dir.x, _dir.y, _dir.z, 0.85, _probe, {
        groups: BULLET_MASK, skipSurface: true,
      })
    ) {
      push = 1 - clamp01(_probe.distance / 0.85);
      push = smoothstep(0.08, 1, push);
    }

    const zz = z + push * 0.14;
    const yy = y - push * 0.02;
    const pitchAdj = pitch - push * 0.75;
    const rollAdj = roll + push * 0.35;

    _off.set(x, yy, zz).applyQuaternion(_q);
    g.position.copy(_camPos).add(_off);
    _e.set(pitchAdj, yaw, rollAdj, "YXZ");
    g.quaternion.copy(_q).multiply(_q2.setFromEuler(_e));
    // The world matrix must be current *now*: the muzzle and ejection-port
    // empties are read this same frame, before R3F's own traversal.
    g.updateMatrixWorld(true);

    if (!this.vm) return;
    const vm = this.vm;
    // Hidden by the animator (holstered, mid-swap), or because the camera is
    // out on the third-person boom — a viewmodel is posed 30 cm from the lens,
    // so from behind the shoulder it is a black slab across half the frame.
    // The group is still *placed* either way: the muzzle and ejection-port
    // empties hang off it and the flash, smoke and casings are spawned from
    // them whether or not the gun itself is drawn.
    vm.root.visible = pose.hide < 0.5 && !frame.thirdPerson;
    // Reciprocating mass travels back along +Z in weapon space.
    const travel = this.weapon.cls === "sidearm" ? 0.03 : 0.022;
    vm.slide.position.z = pose.slide * travel;
    vm.magazine.position.y = -pose.mag * 0.26;
    vm.magazine.rotation.z = pose.mag * 0.5;
    vm.magazine.visible = pose.mag < 0.97;
    vm.setHeat(pose.heat);
  }

  private applyFov(camera: THREE.Camera, def: WeaponDef, adsT: number): void {
    const cam = camera as THREE.PerspectiveCamera;
    if (!cam.isPerspectiveCamera) return;
    const base = frame.fov || PLAYER.fov;
    // Zoom is a magnification, so the FOV divides — a 6.5× scope at 74° base
    // is 11.4°, which is what a real scope of that power gives you.
    const target = base * (1 + (1 / Math.max(1, def.sight.zoom) - 1) * smoothstep(0, 1, adsT));
    if (Math.abs(cam.fov - target) > 0.02) {
      cam.fov = target;
      cam.updateProjectionMatrix();
    }
  }

  /* ---------------- lifecycle ---------------- */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachAnim?.();
    onWeaponExplosion(null);
    clearBallistics();
    for (const vm of this.viewmodels.values()) vm.dispose();
    this.viewmodels.clear();
    this.vm = null;
    this.fx.dispose();
    this.impacts.dispose();
    this.vmGroup.clear();
  }
}

/* ------------------------------------------------------------------ *
 * React wrapper
 * ------------------------------------------------------------------ */

let liveSystem: WeaponSystem | null = null;

/** The live weapon system, for debug overlays and mission scripting. */
export function weaponSystem(): WeaponSystem | null {
  return liveSystem;
}

export interface WeaponsProps {
  /** Disabled while the screenshot harness owns the camera, or in menus. */
  enabled?: boolean;
  /** Weapon keys in slot order. Defaults to the full registry order. */
  loadout?: string[];
  /** Which one starts in hand. */
  startWeapon?: string;
  /**
   * Bind the built-in mouse/keyboard listeners. Leave true unless the player
   * controller is writing `weaponInput` itself.
   */
  bindInput?: boolean;
}

export default function Weapons({
  enabled = true,
  loadout,
  startWeapon = "rifle",
  bindInput = true,
}: WeaponsProps) {
  const { camera, gl } = useThree();
  const quality = useSfStore((s) => s.quality);
  const slots = useMemo(() => loadout ?? WEAPON_ORDER.slice(), [loadout]);

  const sys = useMemo(
    () => new WeaponSystem(quality, slots as string[], startWeapon),
    // Rebuilding on a quality change is intentional: particle budgets and
    // decal caps are sized at construction.
    [quality, slots, startWeapon],
  );
  const sysRef = useRef(sys);
  sysRef.current = sys;

  useEffect(() => {
    liveSystem = sys;
    return () => {
      sys.dispose();
      if (liveSystem === sys) liveSystem = null;
    };
  }, [sys]);

  useEffect(() => {
    sys.enabled = enabled;
  }, [sys, enabled]);

  useEffect(() => {
    if (!bindInput || weaponInput.external) return;
    return installWeaponInput(gl.domElement, primeWeaponAudio);
  }, [bindInput, gl]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 20);
    sysRef.current.update(dt, camera);
  });

  return (
    <>
      <primitive object={sys.vmGroup} />
      <primitive object={sys.fx.group} />
      <primitive object={sys.impacts.group} />
    </>
  );
}
