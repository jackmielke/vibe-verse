import * as THREE from "three";
import { Engine } from "./core/Engine";
import { Input } from "./core/Input";
import { bus } from "./core/EventBus";
import { getProfile, setMaxAnisotropyFromRenderer } from "./core/QualityBridge";
import type { UserSettings } from "./core/Settings";
import { createSky, type SkyRig } from "./world/Sky";
import { createWater, type WaterRig } from "./world/Water";
import { createTerrain, type TerrainRig } from "./world/Terrain";
import { createCity, type CityRig } from "./world/City";
import { createSpaceNeedle, type NeedleRig } from "./world/SpaceNeedle";
import { Player, CHARACTER_CONFIGS, type Collider } from "./entities/Player";
import { WeaponSystem } from "./systems/Weapons";
import { mulberry32 } from "./core/Assets";
import { audio } from "./systems/Audio";
import type {
  GameModule,
  ModuleContext,
  ModuleInstance,
  DamageTarget,
  RayHit,
  FxBus,
  SoundBus,
} from "./ModuleTypes";

/**
 * Assembles every world + system module and drives them from the engine loop.
 *
 * Module contract: each `create*` returns a rig with `update(dt, elapsed, ...)`
 * and `dispose()`. Add new modules here and nowhere else — this is the single
 * place that knows about the whole world.
 */

/**
 * Every `.ts` under game/modules is discovered here at build time, so adding
 * content to the world never means editing this file. See modules/README.md.
 */
const MODULE_GLOB = import.meta.glob<{ default: GameModule }>("./modules/*.ts", {
  eager: true,
});

const TIER_ORDER = { low: 0, medium: 1, high: 2, ultra: 3 } as const;

export class GameWorld {
  readonly engine: Engine;
  readonly input: Input;

  sky!: SkyRig;
  water!: WaterRig;
  terrain!: TerrainRig;
  city!: CityRig;
  needle!: NeedleRig;
  player!: Player;
  weapons!: WeaponSystem;

  colliders: Collider[] = [];
  targets: DamageTarget[] = [];

  private modules: Array<{ id: string; inst: ModuleInstance }> = [];
  private updaters: Array<(dt: number, elapsed: number) => void> = [];
  private disposers: Array<() => void> = [];
  private settings: UserSettings;
  private paused = false;
  private damageFlash = 0;
  private muzzleFlash = 0;

  constructor(container: HTMLElement, settings: UserSettings, characterId: string) {
    this.settings = settings;
    const profile = getProfile(settings.tier);

    this.engine = new Engine(container, profile);
    setMaxAnisotropyFromRenderer(this.engine.renderer);
    this.engine.setFov(settings.fov);

    this.input = new Input(this.engine.canvas);
    this.input.sensitivity = settings.sensitivity;
    this.input.invertY = settings.invertY;

    this.build(characterId);
    this.wireEvents();

    this.engine.setHooks({
      onUpdate: (dt, elapsed) => this.update(dt, elapsed),
    });

    // Exposed for the screenshot harness (tools/shoot.mjs) and for debugging.
    (window as unknown as { __WORLD__: GameWorld }).__WORLD__ = this;
  }

  private build(characterId: string): void {
    const { scene } = this.engine;
    const profile = this.engine.profile;

    bus.emit("loading:progress", { phase: "Charting Lake Washington", progress: 0.1 });
    this.terrain = createTerrain(scene, profile);
    this.disposers.push(() => this.terrain.dispose());

    bus.emit("loading:progress", { phase: "Raising the sun", progress: 0.25 });
    this.sky = createSky(scene, profile);

    bus.emit("loading:progress", { phase: "Filling the lake", progress: 0.4 });
    this.water = createWater(scene, profile, 0);
    this.water.material.uniforms.uSunDirection.value.copy(this.sky.sunDirection);
    this.disposers.push(() => this.water.dispose());

    bus.emit("loading:progress", { phase: "Building Seattle 2117", progress: 0.6 });
    this.city = createCity(scene, profile, this.terrain);
    this.disposers.push(() => this.city.dispose());

    bus.emit("loading:progress", { phase: "Contacting the Space Needle", progress: 0.8 });
    this.needle = createSpaceNeedle(scene, profile, this.terrain);
    this.disposers.push(() => this.needle.dispose());

    bus.emit("loading:progress", { phase: "Deploying", progress: 0.94 });
    const cfg = CHARACTER_CONFIGS[characterId] ?? CHARACTER_CONFIGS.spartan;
    this.player = new Player(cfg);
    this.player.setWorld(this.terrain, (x, z) => this.water.sampleHeight(x, z));
    this.player.colliders = this.colliders;
    this.player.position.set(0, this.terrain.height(0, 55) + 1, 55);
    this.player.yaw = Math.PI; // face out over the lake, Needle to the north-west
    this.player.emitVitals();
    this.player.onFootstep = (surface) => {
      this.sound.play(surface === "water" ? "impact-water" : "impact-dirt", undefined, 0.28, 1);
    };

    this.weapons = new WeaponSystem(["ar", "br"]);
    this.weapons.onFire = ({ origin, direction, def }) => {
      this.player.addRecoil(def.recoilVertical, (Math.random() - 0.5) * def.recoilHorizontal * 2);
      this.muzzleFlash = def.flavor === "explosive" ? 0.28 : 0.11;
      this.sound.play(`shot-${def.id}`, undefined, 1, 1);
      this.fx.spawn("muzzle", origin, direction);

      // Hitscan weapons resolve immediately; projectiles are the FX module's job.
      if (def.projectile !== "none") return;
      const hit = this.raycast(origin, direction, def.range);
      if (!hit) return;

      this.fx.tracer(origin, hit.point, def.color);
      if (hit.target) {
        const killed = hit.target.applyDamage(
          def.damage * (hit.headshot ? def.headshotMultiplier : 1),
          !!hit.headshot,
          direction,
        );
        this.fx.spawn("impact-flesh", hit.point, hit.normal);
        this.sound.play("impact-flesh", hit.point);
        bus.emit("combat:hit", { headshot: !!hit.headshot, killed, targetName: hit.target.name });
        if (killed) {
          bus.emit("combat:kill", {
            targetName: hit.target.name,
            weapon: def.name,
            headshot: !!hit.headshot,
          });
        }
      } else {
        const kind =
          hit.surface === "water" ? "impact-water" : hit.surface === "prop" ? "impact-metal" : "impact-dirt";
        this.fx.spawn(kind, hit.point, hit.normal);
        this.sound.play(kind, hit.point);
      }
    };

    bus.emit("loading:progress", { phase: "Populating Seafair", progress: 0.96 });
    this.buildModules();

    bus.emit("loading:progress", { phase: "Ready", progress: 1 });
    bus.emit("loading:done", {});
    bus.emit("objective:changed", {
      text: "REACH THE STAN SAYRES PITS",
      sub: "Seafair is live. Hostiles hold the Needle.",
    });
  }

  /** A module may replace `fx`; audio is wired to the procedural synth engine. */
  fx: FxBus = { spawn: () => {}, tracer: () => {} };
  sound: SoundBus = audio;

  private buildModules(): void {
    const tier = TIER_ORDER[this.engine.profile.tier];
    const mods = Object.entries(MODULE_GLOB)
      .map(([path, m]) => ({ path, mod: m?.default }))
      .filter((e): e is { path: string; mod: GameModule } => !!e.mod?.build)
      .filter((e) => (e.mod.minTier ? TIER_ORDER[e.mod.minTier] <= tier : true))
      .sort((a, b) => (a.mod.order ?? 100) - (b.mod.order ?? 100));

    const ctx = this.moduleContext();
    for (const { path, mod } of mods) {
      try {
        const inst = mod.build(ctx);
        if (inst) this.modules.push({ id: mod.id, inst });
      } catch (err) {
        // One broken module must never take the whole world down.
        console.error(`[GameWorld] module "${mod.id}" (${path}) failed to build`, err);
      }
    }
  }

  private moduleContext(): ModuleContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      scene: this.engine.scene,
      camera: this.engine.camera,
      renderer: this.engine.renderer,
      profile: this.engine.profile,
      terrain: this.terrain,
      water: this.water,
      sky: this.sky,
      needle: this.needle,
      player: this.player,
      weapons: this.weapons,
      colliders: this.colliders,
      rng: mulberry32(20117),
      targets: this.targets,
      registerTarget: (t) => {
        this.targets.push(t);
        return () => {
          const i = this.targets.indexOf(t);
          if (i >= 0) this.targets.splice(i, 1);
        };
      },
      raycast: (o, d, maxDist) => this.raycast(o, d, maxDist),
      // Late-bound: a module built later can install the real FX/audio
      // implementation and modules built earlier still pick it up.
      get fx(): FxBus {
        return self.fx;
      },
      set fx(v: FxBus) {
        self.fx = v;
      },
      get sound(): SoundBus {
        return self.sound;
      },
      set sound(v: SoundBus) {
        self.sound = v;
      },
    };
  }

  /**
   * Cheap broad-phase ray: sphere-test every damage target, AABB-test
   * colliders, then march the terrain and lake surface.
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null {
    let best: RayHit | null = null;
    const d = dir.clone().normalize();

    // --- damage targets (sphere + head sphere) ---
    const toC = new THREE.Vector3();
    for (const t of this.targets) {
      if (!t.alive || t.team === "player") continue;
      for (const [centreY, radius, isHead] of [
        [0, t.radius, false] as const,
        [t.headOffset, t.headRadius, true] as const,
      ]) {
        if (radius <= 0) continue;
        toC.copy(t.position);
        toC.y += centreY;
        toC.sub(origin);
        const proj = toC.dot(d);
        if (proj < 0 || proj > maxDist) continue;
        const perp2 = toC.lengthSq() - proj * proj;
        if (perp2 > radius * radius) continue;
        const dist = proj - Math.sqrt(Math.max(0, radius * radius - perp2));
        if (dist < 0 || (best && dist >= best.distance)) continue;
        const point = origin.clone().addScaledVector(d, dist);
        best = {
          point,
          normal: point.clone().sub(t.position).normalize(),
          distance: dist,
          target: t,
          headshot: isHead,
          surface: "target",
        };
      }
    }

    // --- solid colliders ---
    const ray = new THREE.Ray(origin, d);
    const hit = new THREE.Vector3();
    for (const c of this.colliders) {
      if (!c.solid) continue;
      if (!ray.intersectBox(c.box, hit)) continue;
      const dist = hit.distanceTo(origin);
      if (dist > maxDist || (best && dist >= best.distance)) continue;
      const centre = c.box.getCenter(new THREE.Vector3());
      const local = hit.clone().sub(centre);
      const size = c.box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      const nx = Math.abs(local.x / size.x);
      const ny = Math.abs(local.y / size.y);
      const nz = Math.abs(local.z / size.z);
      const normal =
        nx > ny && nx > nz
          ? new THREE.Vector3(Math.sign(local.x), 0, 0)
          : ny > nz
            ? new THREE.Vector3(0, Math.sign(local.y), 0)
            : new THREE.Vector3(0, 0, Math.sign(local.z));
      best = { point: hit.clone(), normal, distance: dist, surface: "prop" };
    }

    // --- terrain + water march ---
    const limit = Math.min(maxDist, best?.distance ?? maxDist);
    const p = new THREE.Vector3();
    let step = 0.6;
    for (let dist = 0.5; dist < limit; dist += step) {
      p.copy(origin).addScaledVector(d, dist);
      const gh = this.terrain.height(p.x, p.z);
      if (p.y <= gh) {
        return {
          point: p.clone().setY(gh),
          normal: this.terrain.normal(p.x, p.z),
          distance: dist,
          surface: "terrain",
        };
      }
      const wh = this.water.sampleHeight(p.x, p.z);
      if (p.y <= wh && gh < wh) {
        return {
          point: p.clone().setY(wh),
          normal: this.water.sampleNormal(p.x, p.z),
          distance: dist,
          surface: "water",
        };
      }
      // March coarser as we get further out — precision matters near the muzzle.
      step = Math.min(6, 0.6 + dist * 0.02);
    }

    return best;
  }

  private wireEvents(): void {
    this.disposers.push(
      bus.on("player:damaged", () => {
        this.damageFlash = 1;
      }),
    );

    // WebAudio needs a user gesture before it will make a sound.
    const kick = () => {
      audio.start();
      audio.setVolumes(this.settings.masterVolume, this.settings.musicVolume);
      audio.music("ambient");
    };
    window.addEventListener("pointerdown", kick, { once: true });
    window.addEventListener("keydown", kick, { once: true });
    this.disposers.push(() => {
      window.removeEventListener("pointerdown", kick);
      window.removeEventListener("keydown", kick);
    });
  }

  /** Escape hatch for code that needs a frame hook without being a module. */
  addUpdater(fn: (dt: number, elapsed: number) => void): void {
    this.updaters.push(fn);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    if (p) this.input.releaseLock();
  }

  applySettings(s: UserSettings): void {
    this.settings = s;
    this.input.sensitivity = s.sensitivity;
    this.input.invertY = s.invertY;
    this.engine.setFov(s.fov);
    this.engine.gradePass.uniforms.uGrain.value = s.filmGrain ? 0.035 : 0;
    audio.setVolumes(s.masterVolume, s.musicVolume);
  }

  setCharacter(id: string): void {
    const cfg = CHARACTER_CONFIGS[id];
    if (cfg) this.player.setCharacter(cfg);
  }

  private update(dt: number, elapsed: number): void {
    const input = this.input.update();

    if (input.pausePressed) {
      this.paused = !this.paused;
      bus.emit("game:state", { state: this.paused ? "paused" : "playing" });
      if (this.paused) this.input.releaseLock();
      else this.input.requestLock();
    }

    const cam = this.engine.camera;

    if (!this.paused) {
      this.player.update(dt, input, cam);

      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      const origin = cam.position.clone().addScaledVector(dir, 0.4);
      const moving = Math.hypot(this.player.velocity.x, this.player.velocity.z) / 8;

      this.weapons.update(dt, {
        fire: input.fire,
        firePressed: input.firePressed,
        aim: input.aim,
        reloadPressed: input.reloadPressed,
        swapPressed: input.swapPressed,
        origin,
        direction: dir,
        moving,
      });

      // ADS FOV blend
      const w = this.weapons.current;
      const targetFov = THREE.MathUtils.lerp(this.settings.fov, w.def.adsFov, w.ads);
      if (Math.abs(cam.fov - targetFov) > 0.05) this.engine.setFov(targetFov);
    }

    {
      const fwd = new THREE.Vector3();
      cam.getWorldDirection(fwd);
      audio.setListener(cam.position, fwd);
    }

    this.sky.update(dt, elapsed, cam.position);
    this.water.update(dt, elapsed, cam.position);
    this.water.material.uniforms.uSunDirection.value.copy(this.sky.sunDirection);
    this.city.update(dt, elapsed);
    this.needle.update(dt, elapsed);

    for (const m of this.modules) {
      if (!m.inst.update) continue;
      try {
        m.inst.update(dt, elapsed);
      } catch (err) {
        console.error(`[GameWorld] module "${m.id}" update threw; disabling`, err);
        m.inst.update = undefined;
      }
    }

    for (const fn of this.updaters) fn(dt, elapsed);

    // post-process reactive uniforms
    this.damageFlash = Math.max(0, this.damageFlash - dt * 2.2);
    this.muzzleFlash = Math.max(0, this.muzzleFlash - dt * 4.5);
    const health = this.player.health / this.player.config.maxHealth;
    const lowHealth = this.player.shield <= 0 ? Math.pow(1 - health, 1.6) * 0.55 : 0;
    this.engine.gradePass.uniforms.uDamage.value = Math.max(this.damageFlash * 0.8, lowHealth);
    this.engine.gradePass.uniforms.uFlash.value = this.muzzleFlash * 0.35;

    this.input.endFrame();
  }

  start(): void {
    this.engine.start();
  }

  dispose(): void {
    this.engine.stop();
    for (const m of this.modules) {
      try {
        m.inst.dispose?.();
      } catch (err) {
        console.error(`[GameWorld] module "${m.id}" dispose threw`, err);
      }
    }
    this.modules = [];
    this.disposers.forEach((d) => d());
    this.disposers = [];
    this.input.dispose();
    this.engine.dispose();
  }
}
