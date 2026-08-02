import * as THREE from "three";
import { bus } from "../core/EventBus";

/**
 * Weapon definitions + the firing state machine. Hitscan weapons raycast
 * immediately; projectile weapons hand off to the projectile pool. Every
 * weapon carries a full recoil/spread/ADS profile so they feel distinct.
 */

export type FireMode = "auto" | "semi" | "burst" | "charge";
export type ProjectileKind = "none" | "plasma" | "needle" | "rocket";

export interface WeaponDef {
  id: string;
  name: string;
  icon: string;
  mode: FireMode;
  /** rounds per second */
  rpm: number;
  magazine: number;
  reserve: number;
  reloadTime: number;
  damage: number;
  headshotMultiplier: number;
  /** degrees of cone at the hip while still */
  baseSpread: number;
  /** additional spread per shot, decays over time */
  spreadPerShot: number;
  maxSpread: number;
  adsSpreadMultiplier: number;
  adsFov: number;
  adsTime: number;
  /** radians of upward kick per shot */
  recoilVertical: number;
  recoilHorizontal: number;
  range: number;
  projectile: ProjectileKind;
  projectileSpeed: number;
  /** explosion radius in metres; 0 = no splash */
  splash: number;
  burstCount: number;
  chargeTime: number;
  /** hint for the muzzle flash + audio layer */
  flavor: "kinetic" | "plasma" | "energy" | "explosive";
  color: number;
}

export const WEAPONS: Record<string, WeaponDef> = {
  ar: {
    id: "ar",
    name: "MA7C ASSAULT RIFLE",
    icon: "▮▮▮",
    mode: "auto",
    rpm: 9.2,
    magazine: 36,
    reserve: 288,
    reloadTime: 2.1,
    damage: 13,
    headshotMultiplier: 1.6,
    baseSpread: 1.15,
    spreadPerShot: 0.36,
    maxSpread: 5.2,
    adsSpreadMultiplier: 0.34,
    adsFov: 58,
    adsTime: 0.16,
    recoilVertical: 0.0075,
    recoilHorizontal: 0.0032,
    range: 220,
    projectile: "none",
    projectileSpeed: 0,
    splash: 0,
    burstCount: 0,
    chargeTime: 0,
    flavor: "kinetic",
    color: 0xffcc77,
  },
  br: {
    id: "br",
    name: "BR85 BATTLE RIFLE",
    icon: "▮▮",
    mode: "burst",
    rpm: 2.6,
    magazine: 36,
    reserve: 144,
    reloadTime: 2.35,
    damage: 17,
    headshotMultiplier: 2.4,
    baseSpread: 0.42,
    spreadPerShot: 0.2,
    maxSpread: 2.1,
    adsSpreadMultiplier: 0.18,
    adsFov: 42,
    adsTime: 0.2,
    recoilVertical: 0.011,
    recoilHorizontal: 0.0026,
    range: 420,
    projectile: "none",
    projectileSpeed: 0,
    splash: 0,
    burstCount: 3,
    chargeTime: 0,
    flavor: "kinetic",
    color: 0xffd28a,
  },
  plasma: {
    id: "plasma",
    name: "TYPE-25 PLASMA RIFLE",
    icon: "◈◈",
    mode: "auto",
    rpm: 7.4,
    magazine: 100,
    reserve: 0,
    reloadTime: 2.8,
    damage: 16,
    headshotMultiplier: 1.15,
    baseSpread: 1.6,
    spreadPerShot: 0.28,
    maxSpread: 4.4,
    adsSpreadMultiplier: 0.5,
    adsFov: 62,
    adsTime: 0.14,
    recoilVertical: 0.005,
    recoilHorizontal: 0.004,
    range: 160,
    projectile: "plasma",
    projectileSpeed: 92,
    splash: 0,
    burstCount: 0,
    chargeTime: 0,
    flavor: "plasma",
    color: 0x63e0ff,
  },
  sniper: {
    id: "sniper",
    name: "SRS99 ANTI-MATERIEL",
    icon: "┃",
    mode: "semi",
    rpm: 0.85,
    magazine: 4,
    reserve: 24,
    reloadTime: 3.1,
    damage: 145,
    headshotMultiplier: 3.2,
    baseSpread: 2.4,
    spreadPerShot: 1.4,
    maxSpread: 6,
    adsSpreadMultiplier: 0.005,
    adsFov: 14,
    adsTime: 0.34,
    recoilVertical: 0.075,
    recoilHorizontal: 0.008,
    range: 1600,
    projectile: "none",
    projectileSpeed: 0,
    splash: 0,
    burstCount: 0,
    chargeTime: 0,
    flavor: "kinetic",
    color: 0xfff0c0,
  },
  rocket: {
    id: "rocket",
    name: "M41 SPNKR",
    icon: "◉◉",
    mode: "semi",
    rpm: 0.7,
    magazine: 2,
    reserve: 8,
    reloadTime: 3.6,
    damage: 190,
    headshotMultiplier: 1,
    baseSpread: 0.5,
    spreadPerShot: 0,
    maxSpread: 0.5,
    adsSpreadMultiplier: 1,
    adsFov: 60,
    adsTime: 0.3,
    recoilVertical: 0.09,
    recoilHorizontal: 0.012,
    range: 900,
    projectile: "rocket",
    projectileSpeed: 46,
    splash: 9.5,
    burstCount: 0,
    chargeTime: 0,
    flavor: "explosive",
    color: 0xff8a3d,
  },
};

export interface WeaponRuntime {
  def: WeaponDef;
  ammo: number;
  reserve: number;
  /** seconds until the next shot is allowed */
  cooldown: number;
  reloading: number;
  spread: number;
  /** 0..1 ADS blend */
  ads: number;
  charge: number;
  burstRemaining: number;
  burstTimer: number;
}

export function makeRuntime(def: WeaponDef): WeaponRuntime {
  return {
    def,
    ammo: def.magazine,
    reserve: def.reserve,
    cooldown: 0,
    reloading: 0,
    spread: def.baseSpread,
    ads: 0,
    charge: 0,
    burstRemaining: 0,
    burstTimer: 0,
  };
}

export interface FireResult {
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  def: WeaponDef;
}

export class WeaponSystem {
  slots: WeaponRuntime[] = [];
  active = 0;
  /** Called when a shot is actually emitted. */
  onFire?: (r: FireResult) => void;
  onReloadStart?: (def: WeaponDef) => void;
  onSwap?: (def: WeaponDef) => void;

  constructor(ids: string[] = ["ar", "br"]) {
    this.slots = ids.map((id) => makeRuntime(WEAPONS[id]));
    this.emitChanged();
  }

  get current(): WeaponRuntime {
    return this.slots[this.active];
  }

  emitChanged(): void {
    const w = this.current;
    bus.emit("weapon:changed", {
      name: w.def.name,
      ammo: Math.floor(w.ammo),
      reserve: w.reserve,
      icon: w.def.icon,
    });
  }

  emitAmmo(): void {
    const w = this.current;
    bus.emit("weapon:ammo", { ammo: Math.floor(w.ammo), reserve: w.reserve });
  }

  swap(): void {
    if (this.slots.length < 2) return;
    this.active = (this.active + 1) % this.slots.length;
    this.current.reloading = 0;
    this.current.cooldown = Math.max(this.current.cooldown, 0.45);
    this.onSwap?.(this.current.def);
    this.emitChanged();
  }

  pickUp(id: string): void {
    const def = WEAPONS[id];
    if (!def) return;
    const existing = this.slots.find((s) => s.def.id === id);
    if (existing) {
      existing.reserve = Math.min(def.reserve, existing.reserve + def.magazine * 2);
      this.emitAmmo();
      return;
    }
    this.slots[this.active] = makeRuntime(def);
    this.onSwap?.(def);
    this.emitChanged();
  }

  reload(): void {
    const w = this.current;
    if (w.reloading > 0 || w.ammo >= w.def.magazine) return;
    if (w.def.reserve > 0 && w.reserve <= 0) return;
    w.reloading = w.def.reloadTime;
    this.onReloadStart?.(w.def);
    bus.emit("weapon:reload", { duration: w.def.reloadTime });
  }

  private emit(origin: THREE.Vector3, dir: THREE.Vector3): void {
    const w = this.current;
    const spreadRad = THREE.MathUtils.degToRad(
      w.spread * THREE.MathUtils.lerp(1, w.def.adsSpreadMultiplier, w.ads),
    );
    const d = dir.clone();
    if (spreadRad > 0.0001) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spreadRad;
      const up = new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(d, up).normalize();
      const trueUp = new THREE.Vector3().crossVectors(right, d).normalize();
      d.addScaledVector(right, Math.cos(a) * r).addScaledVector(trueUp, Math.sin(a) * r).normalize();
    }
    w.ammo -= 1;
    w.spread = Math.min(w.def.maxSpread, w.spread + w.def.spreadPerShot);
    this.onFire?.({ origin: origin.clone(), direction: d, def: w.def });
    bus.emit("weapon:fired", { name: w.def.name });
    this.emitAmmo();
  }

  update(
    dt: number,
    opts: {
      fire: boolean;
      firePressed: boolean;
      aim: boolean;
      reloadPressed: boolean;
      swapPressed: boolean;
      origin: THREE.Vector3;
      direction: THREE.Vector3;
      moving: number;
    },
  ): void {
    const w = this.current;

    if (opts.swapPressed) this.swap();
    if (opts.reloadPressed) this.reload();

    // ADS blend
    const adsTarget = opts.aim && w.reloading <= 0 ? 1 : 0;
    const adsRate = dt / Math.max(0.01, w.def.adsTime);
    w.ads = THREE.MathUtils.clamp(w.ads + (adsTarget - w.ads) * Math.min(1, adsRate * 3), 0, 1);

    // spread recovery, worse while moving
    const recover = 5.2 * (1 - Math.min(opts.moving, 1) * 0.55);
    const floor = w.def.baseSpread * (1 + Math.min(opts.moving, 1) * 1.4);
    w.spread = Math.max(floor, w.spread - recover * dt);

    if (w.reloading > 0) {
      w.reloading -= dt;
      if (w.reloading <= 0) {
        const need = w.def.magazine - w.ammo;
        if (w.def.reserve === 0) {
          w.ammo = w.def.magazine; // battery weapons vent instead of reloading
        } else {
          const take = Math.min(need, w.reserve);
          w.ammo += take;
          w.reserve -= take;
        }
        this.emitAmmo();
      }
      return;
    }

    w.cooldown = Math.max(0, w.cooldown - dt);

    // burst continuation
    if (w.burstRemaining > 0) {
      w.burstTimer -= dt;
      if (w.burstTimer <= 0 && w.ammo > 0) {
        this.emit(opts.origin, opts.direction);
        w.burstRemaining--;
        w.burstTimer = 0.075;
        if (w.burstRemaining === 0) w.cooldown = 1 / w.def.rpm;
      }
      return;
    }

    const wantsToFire =
      w.def.mode === "auto" ? opts.fire : w.def.mode === "charge" ? opts.fire : opts.firePressed;

    if (!wantsToFire || w.cooldown > 0) return;

    if (w.ammo <= 0) {
      if (opts.firePressed) this.reload();
      return;
    }

    if (w.def.mode === "burst") {
      w.burstRemaining = w.def.burstCount;
      w.burstTimer = 0;
      return;
    }

    this.emit(opts.origin, opts.direction);
    w.cooldown = 1 / w.def.rpm;
  }
}
