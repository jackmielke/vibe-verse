/**
 * The running chapter. Five of the six beats are this file with different data.
 *
 * Two decisions shape everything else in here.
 *
 * **You never move.** The runner is pinned at the world origin and the world
 * is dragged past him at his own speed. That is why there is no tile recycler,
 * no floating-point drift after five miles, and why the ground is one plane
 * with a scrolling texture. Everything that exists is somewhere in
 * z ∈ [-FAR, +BEHIND], and anything that leaves that band goes back in a pool.
 *
 * **Speed is the whole game.** Not score, not the obstacles — the obstacles
 * exist to take speed away from you, and every beat in the story is about
 * getting it back. So speed feeds the stride length, the camera field of view,
 * the shake, the music and the distance the thing behind you is at. Lose speed
 * and you feel all five at once, which is the only reason a runner where you
 * hold one direction is interesting at all.
 */
import * as THREE from "three";
import { blobShadow } from "./props";
import { makeHuman, type Human, type HumanSpec } from "./rig";
import { makeCrowd, type Crowd } from "./crowd";
import type { Chapter, ChapterCtx, ChapterHud, Outcome } from "./types";

/** How far ahead things exist. Beyond this the fog has them anyway. */
const FAR = 220;
/** How far behind before a prop is recycled. */
const BEHIND = 30;
const GRAVITY = 26;
const JUMP_V = 8.6;

type Rng = () => number;

export interface SceneryBand {
  make: (r: Rng) => THREE.Object3D;
  /** Average metres between two of these. */
  every: number;
  /** Distance from the centre line, min and max. */
  offset: [number, number];
  /** "either" (default) puts one on a random side; "both" puts one on each. */
  side?: "either" | "both" | "left" | "right";
  scale?: [number, number];
  /** Sink it into the ground by this much — kills the seam on big rocks. */
  sink?: number;
  /** Turn it to face the road. Grandstands and billboards want this. */
  faceRoad?: boolean;
  /**
   * Spacing exactly `every` metres apart instead of jittered around it.
   * A grandstand is 37 m long, so 37 m spacing tiles into one continuous
   * stand — and the same jitter that makes a treeline look natural puts
   * twelve-metre holes in a stadium.
   */
  exact?: boolean;
}

export interface ObstacleKind {
  key: string;
  make: (r: Rng) => THREE.Object3D;
  /** Collision radius in metres — generous, because a near miss should miss. */
  radius: number;
  /** Clear it by jumping if your feet are above this. */
  height: number;
  weight: number;
  /** 0 = static, 1 = walks straight into your lane. Tacklers use this. */
  homing?: number;
  /** Moves toward you as well as past you — traffic, and the other boats. */
  closing?: number;
}

export type BeatEffect = "braces" | "storm" | "clear" | "cheer" | "crowd" | "endzone";

export interface RunSpec {
  goal: number;
  halfWidth: number;
  start: number;
  max: number;
  accel: number;
  /** Held boost, as a multiplier on top of `max`. */
  boost?: number;
  /** The plain the whole chapter sits on. Tiles in both directions. */
  terrain: { texture: () => THREE.Texture; tile: number; width?: number };
  /**
   * The strip laid on top of it, at exactly the width the chapter wants. Its
   * texture is a cross-section: shoulders at the edges, lines down the middle.
   * Water chapters have no road.
   */
  road?: { texture: () => THREE.Texture; tile: number; width: number };
  sky: [number, number, number, number];
  hero: HumanSpec;
  surface: "dirt" | "grass" | "mud" | "road" | "wood";
  scenery: SceneryBand[];
  obstacles: ObstacleKind[];
  /** Metres between obstacles at the start; tightens toward the finish. */
  obstacleEvery: [number, number];
  pickup: {
    make: () => THREE.Object3D;
    every: number;
    /** Dollars each. Chocolates are worth nothing but themselves. */
    value?: number;
    label: string;
    /** Carried on his back once collected — the buddies in the jungle. */
    carried?: boolean;
    /** Collecting adds a follower to the crowd behind you. */
    recruits?: boolean;
    /** Off for the buddies: they are found alone, not in a line of three. */
    single?: boolean;
  };
  /** Something he is standing on rather than in. The shrimp boat. */
  vehicle?: () => THREE.Object3D;
  /** He stands this high off the ground once he is on the vehicle. */
  deck?: number;
  /** And this far forward along it — out on the deck, not in the wheelhouse. */
  deckZ?: number;
  chase?: {
    make: (r: Rng, i: number) => THREE.Object3D;
    count: number;
    /** Metres behind at the start. */
    gap: number;
    /** How much closer it gets, per second, when you are at half speed. */
    close: number;
    label: string;
    /** Animate the chaser like a person rather than sliding it. */
    human?: HumanSpec;
  };
  /** The finale's crowd. Followers accumulate and run behind you. */
  followers?: { max: number; per: number };
  lives: number;
  /** Fired once as progress crosses `at`. `sky` re-lights the world. */
  beats?: Array<{
    at: number;
    say: string;
    effect?: BeatEffect;
    sky?: [number, number, number, number];
  }>;
  music: [number, number];
  /** Big readout. Given metres, returns [value, label]. */
  stat: (metres: number) => [string, string];
  /** Water: the ground heaves, and there is no jumping. */
  water?: { amp: number; stormAmp: number };
}

interface Live {
  obj: THREE.Object3D;
  key: string;
  x: number;
  z: number;
  radius: number;
  height: number;
  homing: number;
  closing: number;
  dead: boolean;
}

export class RunChapter implements Chapter {
  private ctx: ChapterCtx;
  private spec: RunSpec;

  private hero: Human;
  private heroHolder = new THREE.Group();
  private shadow: THREE.Mesh;
  private carried: THREE.Object3D[] = [];

  private groundMesh: THREE.Mesh;
  private groundTex: THREE.Texture;
  private roadMesh: THREE.Mesh | null = null;
  private roadTex: THREE.Texture | null = null;
  private waterGeo: THREE.PlaneGeometry | null = null;
  private waterBase: Float32Array | null = null;
  private rain: THREE.LineSegments | null = null;

  private scenery: Live[] = [];
  private obstacles: Live[] = [];
  private pickups: Live[] = [];
  private chasers: Array<{ obj: THREE.Object3D; human: Human | null; lane: number }> = [];
  private crowd: Crowd | null = null;

  private pool = new Map<string, THREE.Object3D[]>();
  private nextScenery: number[] = [];
  private nextObstacle = 60;
  private nextPickup = 30;

  /* --- state ------------------------------------------------------------ */
  private dist = 0;
  private speed: number;
  private x = 0;
  private vx = 0;
  private y = 0;
  private vy = 0;
  private phase = 0;
  private stepAccum = 0;
  private lives: number;
  private invuln = 0;
  private shake = 0;
  private outcome: Outcome = "running";
  private chaseGap: number;
  private beatsFired = new Set<number>();
  private bracesOff = false;
  private storming = 0;
  private collected = 0;
  private earned = 0;
  private chocolates = 0;
  private followers = 0;
  private time = 0;
  private endTimer = 0;

  constructor(ctx: ChapterCtx, spec: RunSpec) {
    this.ctx = ctx;
    this.spec = spec;
    this.speed = spec.start;
    this.lives = spec.lives;
    this.chaseGap = spec.chase?.gap ?? 0;

    ctx.setSky(...spec.sky);

    /* --- the floor ----------------------------------------------------
     * The terrain is deliberately enormous — 420 m across. Nothing costs
     * anything to make it that big (one quad, one tiling texture) and it is
     * the difference between scenery standing on the world and scenery
     * hanging in the air past the edge of a mat. */
    const width = spec.terrain.width ?? 420;
    const len = 520;
    this.groundTex = spec.terrain.texture();
    this.groundTex.repeat.set(width / spec.terrain.tile, len / spec.terrain.tile);
    this.groundTex.needsUpdate = true;

    if (spec.water) {
      // Water is the one surface that has to be geometry: a boat that does not
      // rise and fall with the sea is a boat on a painted floor. 56 × 90 verts
      // is enough resolution for a swell at this camera height and cheap
      // enough to rewrite every frame on a phone.
      this.waterGeo = new THREE.PlaneGeometry(width, len, 56, 90);
      this.waterBase = Float32Array.from(this.waterGeo.attributes.position.array);
      this.groundMesh = new THREE.Mesh(
        this.waterGeo,
        new THREE.MeshLambertMaterial({ map: this.groundTex }),
      );
    } else {
      this.groundMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(width, len),
        new THREE.MeshLambertMaterial({ map: this.groundTex }),
      );
    }
    this.groundMesh.rotation.x = -Math.PI / 2;
    this.groundMesh.position.z = -len / 2 + BEHIND;
    ctx.root.add(this.groundMesh);

    if (spec.road) {
      this.roadTex = spec.road.texture();
      this.roadTex.repeat.set(1, len / spec.road.tile);
      this.roadTex.needsUpdate = true;
      this.roadMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(spec.road.width, len),
        new THREE.MeshLambertMaterial({ map: this.roadTex }),
      );
      this.roadMesh.rotation.x = -Math.PI / 2;
      // Two centimetres up. Any less and it z-fights with the terrain at
      // draw distance; any more and you can see the road is a separate slab.
      this.roadMesh.position.set(0, 0.02, -len / 2 + BEHIND);
      ctx.root.add(this.roadMesh);
    }

    /* --- the man ------------------------------------------------------- */
    this.hero = makeHuman(spec.hero);
    this.hero.group.position.set(0, spec.deck ?? 0, spec.deckZ ?? 0);
    this.heroHolder.add(this.hero.group);
    if (spec.vehicle) this.heroHolder.add(spec.vehicle());
    ctx.root.add(this.heroHolder);
    this.shadow = blobShadow(0.7);
    ctx.root.add(this.shadow);

    if (spec.followers) {
      this.crowd = makeCrowd(spec.followers.max);
      ctx.root.add(this.crowd.group);
    }

    /* --- whatever is behind you ---------------------------------------- */
    if (spec.chase) {
      for (let i = 0; i < spec.chase.count; i++) {
        const obj = spec.chase.make(ctx.rng, i);
        ctx.root.add(obj);
        const human = spec.chase.human ? makeHuman(spec.chase.human) : null;
        if (human) obj.add(human.group);
        this.chasers.push({ obj, human, lane: (i - (spec.chase.count - 1) / 2) * 2.2 });
      }
    }

    this.nextScenery = spec.scenery.map(() => 0);
    this.primeWorld();

    ctx.audio.music(spec.music[0], spec.music[1]);
    if (spec.water) ctx.audio.loop("engine", 320, 0.07);
  }

  /* ================================================================== pool */

  private acquire(key: string, make: () => THREE.Object3D) {
    const free = this.pool.get(key);
    const o = free && free.length ? free.pop()! : make();
    o.visible = true;
    this.ctx.root.add(o);
    return o;
  }

  private release(key: string, o: THREE.Object3D) {
    o.removeFromParent();
    const free = this.pool.get(key);
    if (free) free.push(o);
    else this.pool.set(key, [o]);
  }

  /* ================================================================ spawns */

  /** Drop one band's worth of scenery at `z`, on whichever side it belongs. */
  private placeScenery(i: number, band: SceneryBand, z: number) {
    const r = this.ctx.rng;
    const sides =
      band.side === "left"
        ? [-1]
        : band.side === "right"
          ? [1]
          : band.side === "both"
            ? [-1, 1]
            : r() < 0.5
              ? [-1]
              : [1];
    for (const side of sides) {
      const key = `sc${i}`;
      const obj = this.acquire(key, () => band.make(r));
      const off = band.offset[0] + r() * (band.offset[1] - band.offset[0]);
      const s = band.scale ? band.scale[0] + r() * (band.scale[1] - band.scale[0]) : 1;
      obj.scale.setScalar(s);
      if (band.faceRoad) obj.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
      obj.position.set(side * off, -(band.sink ?? 0), z);
      this.scenery.push({
        obj,
        key,
        x: obj.position.x,
        z,
        radius: 0,
        height: 0,
        homing: 0,
        closing: 0,
        dead: false,
      });
    }
  }

  /**
   * Fill the whole visible band before the first frame is ever drawn.
   *
   * Without this the chapter opens on an empty plain that grows a treeline
   * while you watch it, which is the single most obvious tell that a world is
   * being streamed at you rather than being somewhere you arrived.
   */
  private primeWorld() {
    const r = this.ctx.rng;
    this.spec.scenery.forEach((band, i) => {
      const step = () => band.every * (band.exact ? 1 : 0.55 + r() * 0.9);
      for (let z = BEHIND - band.every * r(); z > -FAR; z -= step()) {
        this.placeScenery(i, band, z);
      }
      this.nextScenery[i] = band.every;
    });
  }

  /** Stream in what is due at this distance, always at the far edge. */
  private spawnAhead(atDist: number) {
    const { spec, ctx } = this;
    const r = ctx.rng;
    const z = -FAR;

    spec.scenery.forEach((band, i) => {
      if (atDist < this.nextScenery[i]) return;
      this.nextScenery[i] = atDist + band.every * (band.exact ? 1 : 0.55 + r() * 0.9);
      this.placeScenery(i, band, z);
    });

    /* Obstacles tighten as the chapter goes on: the first minute teaches the
       controls, the last one uses them. */
    const p = Math.min(1, this.dist / spec.goal);
    const every = spec.obstacleEvery[0] + (spec.obstacleEvery[1] - spec.obstacleEvery[0]) * p;
    if (atDist >= this.nextObstacle) {
      this.nextObstacle = atDist + every * (0.7 + r() * 0.7);
      const total = spec.obstacles.reduce((s, o) => s + o.weight, 0);
      let roll = r() * total;
      const kind = spec.obstacles.find((o) => (roll -= o.weight) <= 0) ?? spec.obstacles[0];
      // Never fill the road. There is always a gap wide enough to run through,
      // which is the difference between a hard game and an unfair one.
      const lanes = Math.max(2, Math.floor((spec.halfWidth * 2) / (kind.radius * 2.6)));
      const lane = Math.floor(r() * lanes);
      const lx = -spec.halfWidth + ((lane + 0.5) / lanes) * spec.halfWidth * 2;
      const obj = this.acquire(kind.key, () => kind.make(r));
      obj.position.set(lx, 0, z);
      obj.rotation.y = r() * 0.4 - 0.2;
      this.obstacles.push({
        obj,
        key: kind.key,
        x: lx,
        z,
        radius: kind.radius,
        height: kind.height,
        homing: kind.homing ?? 0,
        closing: kind.closing ?? 0,
        dead: false,
      });
    }

    if (atDist >= this.nextPickup) {
      this.nextPickup = atDist + spec.pickup.every * (0.6 + r() * 0.8);
      // Pickups come in arcs of three, which is what turns "collect the thing"
      // into a line you steer along instead of a single dot you clip.
      const n = spec.pickup.single ? 1 : 1 + Math.floor(r() * 3);
      const cx = (r() * 2 - 1) * spec.halfWidth * 0.8;
      for (let i = 0; i < n; i++) {
        const obj = this.acquire("pickup", spec.pickup.make);
        const px = THREE.MathUtils.clamp(cx + (i - (n - 1) / 2) * 1.6, -spec.halfWidth, spec.halfWidth);
        obj.position.set(px, obj.position.y || 0.7, z - i * 5);
        this.pickups.push({
          obj,
          key: "pickup",
          x: px,
          z: obj.position.z,
          radius: 1.15,
          height: 0,
          homing: 0,
          closing: 0,
          dead: false,
        });
      }
    }
  }

  /* ================================================================ update */

  update(dt: number): ChapterHud {
    const { spec, ctx } = this;
    this.time += dt;

    if (this.outcome !== "running") {
      this.endTimer += dt;
      this.coast(dt);
      return this.hud();
    }

    /* --- speed --------------------------------------------------------- */
    const cap = spec.max * (this.bracesOff || !spec.hero.braces ? 1 : 0.52);
    const boosted = ctx.input.boost ? cap * (spec.boost ?? 1.18) : cap;
    this.speed += (boosted - this.speed) * Math.min(1, spec.accel * dt);
    this.dist += this.speed * dt;

    /* --- steering ------------------------------------------------------
     * Acceleration rather than a direct set, so a flick of the thumb is a
     * lean and a held drag is a lane change. The damping is what stops the
     * runner feeling like a cursor. */
    const want = ctx.input.steer * (spec.water ? 9 : 11);
    this.vx += (want - this.vx) * Math.min(1, 9 * dt);
    this.x = THREE.MathUtils.clamp(this.x + this.vx * dt, -spec.halfWidth, spec.halfWidth);
    if (Math.abs(this.x) >= spec.halfWidth - 0.001) this.vx *= 0.3;

    /* --- the jump ------------------------------------------------------ */
    if (!spec.water) {
      if (ctx.input.jumpPressed && this.y <= 0.01) {
        this.vy = JUMP_V;
        ctx.audio.step_(spec.surface, 1);
      }
      // Releasing early cuts the jump short — a variable-height jump is worth
      // the four lines because clearing a fence and clearing a tractor are
      // different presses.
      if (this.vy > 0 && !ctx.input.jump) this.vy -= GRAVITY * 1.6 * dt;
      this.vy -= GRAVITY * dt;
      this.y = Math.max(0, this.y + this.vy * dt);
      if (this.y === 0 && this.vy < -1) {
        ctx.audio.step_(spec.surface, 0.8);
        this.vy = 0;
      }
    }

    /* --- footfalls ----------------------------------------------------- */
    const stride = 2.1 + this.speed * 0.09;
    this.phase += (this.speed / stride) * Math.PI * dt * 2;
    if (this.y <= 0.01 && !spec.water) {
      this.stepAccum += this.speed * dt;
      if (this.stepAccum > stride / 2) {
        this.stepAccum = 0;
        ctx.audio.step_(spec.surface, this.speed / spec.max);
      }
    }

    this.moveWorld(dt);
    this.collide();
    this.updateChase(dt);
    this.fireBeats();

    if (this.dist >= spec.goal) this.finish("won");

    this.poseAll(dt);
    this.driveCamera(dt);
    return this.hud();
  }

  /** After the chapter has been decided, it keeps running for a beat. */
  private coast(dt: number) {
    const decel = this.outcome === "won" ? 3 : 9;
    this.speed = Math.max(this.outcome === "won" ? 3 : 0, this.speed - decel * dt);
    this.dist += this.speed * dt;
    this.phase += (this.speed / 2.4) * Math.PI * dt * 2;
    this.moveWorld(dt);
    this.poseAll(dt);
    this.driveCamera(dt);
  }

  private moveWorld(dt: number) {
    const d = this.speed * dt;
    this.groundTex.offset.y = this.dist / this.spec.terrain.tile;
    if (this.roadTex && this.spec.road) this.roadTex.offset.y = this.dist / this.spec.road.tile;

    for (const list of [this.scenery, this.obstacles, this.pickups]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const it = list[i];
        it.z += d * (1 + it.closing);
        if (it.homing) {
          // Tacklers close the lane, but only slowly, and only while they are
          // still far enough away that you can beat them to the outside.
          const lead = THREE.MathUtils.clamp((-it.z - 12) / 40, 0, 1);
          it.x += (this.x - it.x) * Math.min(1, it.homing * lead * dt);
        }
        it.obj.position.set(it.x, it.obj.position.y, it.z);
        if (it.z > BEHIND || it.dead) {
          this.release(it.key, it.obj);
          list.splice(i, 1);
        }
      }
    }

    if (this.waterGeo && this.waterBase) this.heave();
    this.spawnAhead(this.dist);
  }

  /**
   * The sea. Two crossed swells plus a chop, at an amplitude the storm ramps.
   *
   * The boat rides the same function rather than a separate spring, which is
   * the whole trick — sampling the surface it is floating on means it is never
   * out of phase with the water underneath it, at any wave height.
   */
  private waveAt(x: number, z: number) {
    const amp = this.spec.water
      ? this.spec.water.amp + (this.spec.water.stormAmp - this.spec.water.amp) * this.storming
      : 0;
    const t = this.time * 0.8 + this.dist * 0.06;
    return (
      Math.sin(z * 0.09 + t) * amp +
      Math.sin(z * 0.037 - x * 0.05 + t * 0.6) * amp * 0.7 +
      Math.sin(x * 0.21 + t * 1.7) * amp * 0.25
    );
  }

  private heave() {
    const pos = this.waterGeo!.attributes.position;
    const base = this.waterBase!;
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3];
      const y = base[i * 3 + 1]; // plane-local Y is world -Z once rotated
      pos.setZ(i, this.waveAt(x, -y));
    }
    pos.needsUpdate = true;
    this.waterGeo!.computeVertexNormals();
  }

  private collide() {
    if (this.invuln > 0) this.invuln -= 1 / 60;

    for (const o of this.obstacles) {
      if (o.dead || Math.abs(o.z) > 1.6) continue;
      if (Math.abs(o.x - this.x) > o.radius + 0.55) continue;
      if (this.y > o.height) continue; // cleared it
      o.dead = true;
      this.hit();
    }

    for (const p of this.pickups) {
      if (p.dead || Math.abs(p.z) > 1.6) continue;
      if (Math.abs(p.x - this.x) > 1.5) continue;
      p.dead = true;
      this.take();
    }
  }

  private hit() {
    if (this.invuln > 0) return;
    const { ctx, spec } = this;
    this.invuln = 1.1;
    this.speed *= 0.42;
    this.vx *= -0.4;
    this.shake = 1;
    if (!ctx.debug.immortal) this.lives -= 1;
    ctx.audio.thud();
    this.chaseGap = Math.max(0, this.chaseGap - (spec.chase ? spec.chase.gap * 0.32 : 0));
    if (this.lives <= 0) this.finish("lost");
  }

  private take() {
    const { spec, ctx } = this;
    this.collected += 1;
    if (spec.pickup.value) {
      this.earned += spec.pickup.value;
      ctx.audio.coin(1 + (this.collected % 4) * 0.06);
    } else {
      this.chocolates += 1;
      ctx.audio.chocolate();
    }
    if (spec.pickup.carried && this.carried.length < 4) {
      // The buddies ride on his back. Four is the shoulder's worth, and it is
      // also the number the chapter asks you for, so the load *is* the score.
      const b = new THREE.Group();
      const c = spec.pickup.make();
      c.position.set(0, 0, 0);
      c.rotation.set(0, 0, Math.PI / 2);
      b.add(c);
      b.position.set(0.05, 1.5, -0.28 - this.carried.length * 0.16);
      b.rotation.set(0.15, 0, 0.1 * (this.carried.length % 2 ? 1 : -1));
      b.scale.setScalar(0.85);
      this.hero.group.add(b);
      this.carried.push(b);
      ctx.say(`${this.carried.length} of 4 — keep going`);
    }
    if (spec.pickup.recruits && this.crowd && spec.followers) {
      this.followers = Math.min(spec.followers.max, this.followers + spec.followers.per);
      this.crowd.setCount(Math.round(this.followers));
      ctx.audio.cheer(this.followers, 0.5);
    }
  }

  private updateChase(dt: number) {
    const { spec } = this;
    if (!spec.chase) return;
    // The gap opens when you are quick and closes when you are not. Being at
    // full speed is *safety*, which is the sentence this whole game is about.
    const rate = (this.speed / spec.max - 0.62) * spec.chase.close;
    this.chaseGap = THREE.MathUtils.clamp(this.chaseGap + rate * dt, 0, spec.chase.gap * 1.6);
    for (const [i, c] of this.chasers.entries()) {
      const z = this.chaseGap + 2 + i * 1.4;
      c.obj.position.set(
        this.x * 0.6 + c.lane + Math.sin(this.time * 1.7 + i) * 0.5,
        this.spec.water ? this.waveAt(c.lane, z) : 0,
        z,
      );
      c.obj.rotation.y = Math.PI;
      c.human?.pose(this.phase * 1.05 + i, 1);
      // Bikes spin their wheels and the firewall gutters. Both come off the
      // prop's own userData, so `chase` stays one config field either way.
      const wheels = c.obj.userData.wheels as THREE.Object3D[] | undefined;
      if (wheels) for (const w of wheels) w.rotation.x -= this.speed * dt * 2.4;
      const flames = c.obj.userData.flames as THREE.Object3D[] | undefined;
      if (flames) {
        for (const [k, f] of flames.entries()) {
          f.scale.y = 0.75 + Math.abs(Math.sin(this.time * 7 + k * 1.7)) * 0.6;
          f.position.x += Math.sin(this.time * 5 + k) * 0.06;
        }
      }
    }
    if (this.chaseGap <= 0.2 && !this.ctx.debug.immortal) {
      this.ctx.audio.fail();
      this.finish("lost");
    }
  }

  private fireBeats() {
    const p = this.dist / this.spec.goal;
    this.spec.beats?.forEach((b, i) => {
      if (this.beatsFired.has(i) || p < b.at) return;
      this.beatsFired.add(i);
      this.ctx.say(b.say);
      if (b.sky) this.ctx.setSky(...b.sky);
      this.applyEffect(b.effect);
    });
  }

  private applyEffect(effect?: BeatEffect) {
    const { ctx } = this;
    switch (effect) {
      case "braces": {
        /* The braces come off. Everything about him changes at once — the
           stride opens, the cap lifts, the music speeds up — because in the
           film this is not an upgrade, it is the moment he becomes himself. */
        const where = this.hero.removeBraces();
        this.bracesOff = true;
        ctx.audio.snap();
        ctx.audio.music(this.spec.music[0] * 1.5, this.spec.music[1] * 0.72);
        if (where) {
          const junk = new THREE.Group();
          junk.position.copy(where);
          ctx.root.add(junk);
          // They land in the road and then slide away behind you like anything
          // else in the world — one more thing you have left back there.
          this.scenery.push({
            obj: junk,
            key: "braces",
            x: where.x,
            z: 0,
            radius: 0,
            height: 0,
            homing: 0,
            closing: 0,
            dead: false,
          });
        }
        break;
      }
      case "storm":
        ctx.audio.loop("rain", 3200, 0.15, "highpass");
        ctx.audio.thunder();
        this.makeRain();
        break;
      case "clear":
        // It has to stop as well as start. Blue sky over torrential rain was
        // the state the gulf sat in for the last third of the chapter.
        this.stormRamp = false;
        this.clearing = true;
        ctx.audio.stopLoop("rain");
        break;
      case "cheer":
        ctx.audio.cheer(60, 2.2);
        break;
      case "crowd":
        if (this.crowd && this.spec.followers) {
          this.followers = Math.min(this.spec.followers.max, this.followers + 6);
          this.crowd.setCount(Math.round(this.followers));
        }
        ctx.audio.cheer(40, 1.6);
        break;
      case "endzone":
        ctx.audio.whistle();
        ctx.audio.cheer(90, 2.5);
        break;
    }
    if (effect === "storm") this.stormRamp = true;
  }

  private stormRamp = false;
  private clearing = false;
  private nextThunder = 0;

  /**
   * Rain, as line segments rather than points.
   *
   * A point sprite is a dot, and rain is not dots — it is streaks, leaning
   * back at whatever speed you are moving through it. Two vertices per drop
   * gives that for free, and eleven hundred of them is one draw call.
   */
  private makeRain() {
    if (this.rain) return;
    const N = 1100;
    const pos = new Float32Array(N * 6);
    for (let i = 0; i < N; i++) {
      const x = (Math.random() * 2 - 1) * 46;
      const y = Math.random() * 26;
      const z = -70 + Math.random() * 95;
      pos.set([x, y, z, x + 0.1, y - 1.05, z + 0.35], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xc8dce8,
      transparent: true,
      opacity: 0.45,
      fog: false,
    });
    this.rain = new THREE.LineSegments(geo, mat);
    this.rain.frustumCulled = false;
    this.ctx.root.add(this.rain);
  }

  private stepRain(dt: number) {
    if (!this.rain) return;
    const attr = this.rain.geometry.attributes.position as THREE.BufferAttribute;
    const a = attr.array as Float32Array;
    const fall = 34 * dt;
    const back = this.speed * dt * 0.5;
    for (let i = 0; i < a.length; i += 6) {
      a[i + 1] -= fall;
      a[i + 4] -= fall;
      a[i + 2] += back;
      a[i + 5] += back;
      if (a[i + 1] < 0) {
        // Recycle above and ahead. Re-randomising x as well is what keeps the
        // curtain from turning into 1100 permanent vertical tracks.
        const x = (Math.random() * 2 - 1) * 46;
        const y = 24 + Math.random() * 4;
        const z = -70 + Math.random() * 95;
        a.set([x, y, z, x + 0.1, y - 1.05, z + 0.35], i);
      } else if (a[i + 2] > 26) {
        a[i + 2] -= 95;
        a[i + 5] -= 95;
      }
    }
    attr.needsUpdate = true;
    (this.rain.material as THREE.Material).opacity = 0.12 + this.storming * 0.42;
  }

  private poseAll(dt: number) {
    const { spec } = this;
    if (this.stormRamp) this.storming = Math.min(1, this.storming + dt * 0.25);
    if (this.clearing) {
      this.storming = Math.max(0, this.storming - dt * 0.3);
      if (this.storming === 0 && this.rain) {
        this.rain.removeFromParent();
        this.rain.geometry.dispose();
        (this.rain.material as THREE.Material).dispose();
        this.rain = null;
        this.clearing = false;
      }
    }
    this.stepRain(dt);
    // Thunder every so often once it is really coming down. Irregular, since
    // weather on a metronome stops being weather after the second one.
    if (this.storming > 0.35 && this.time > this.nextThunder) {
      if (this.nextThunder > 0) {
        this.ctx.audio.thunder();
        this.shake = Math.max(this.shake, 0.35);
      }
      this.nextThunder = this.time + 5 + this.ctx.rng() * 9;
    }

    const effort = THREE.MathUtils.clamp(this.speed / spec.max, 0, 1);
    const air = spec.water ? 0 : THREE.MathUtils.clamp(this.y / 1.4, 0, 1);
    this.hero.pose(this.phase, effort, air);

    const waveY = spec.water ? this.waveAt(this.x, 0) : 0;
    this.heroHolder.position.set(this.x, this.y + waveY, 0);
    // He leans into the turn, and the lean is the only cue you get about
    // lateral speed — without it steering feels like sliding a decal.
    this.heroHolder.rotation.z = -this.vx * 0.035;
    this.heroHolder.rotation.y = this.vx * 0.05;
    if (spec.water) {
      // Clamped. At full storm amplitude the raw wave slope heels the boat
      // past thirty degrees, and a shrimp boat lying on its beam ends with the
      // captain still stood upright on the deck reads as a broken transform.
      const dz = this.waveAt(this.x, 3) - this.waveAt(this.x, -3);
      const dx = this.waveAt(this.x + 2, 0) - this.waveAt(this.x - 2, 0);
      this.heroHolder.rotation.x = THREE.MathUtils.clamp(dz * 0.09, -0.2, 0.2);
      this.heroHolder.rotation.z += THREE.MathUtils.clamp(dx * 0.07, -0.18, 0.18);
    }

    // The invulnerability flash after a hit. Blink the whole man, not a tint —
    // it is legible on a phone in daylight, which a tint is not.
    this.hero.group.visible = this.invuln <= 0 || Math.floor(this.invuln * 14) % 2 === 0;

    this.shadow.position.set(this.x, 0.02 + waveY, 0);
    this.shadow.scale.setScalar(THREE.MathUtils.clamp(1 - this.y * 0.35, 0.35, 1));
    (this.shadow.material as THREE.Material).opacity = spec.water ? 0.25 : 0.9;
    this.shadow.visible = !spec.water || this.storming < 0.5;

    this.crowd?.update(dt, this.phase, this.x, this.speed / spec.max);
    this.shake = Math.max(0, this.shake - dt * 2.4);
  }

  private driveCamera(dt: number) {
    const { camera } = this.ctx;
    const t = THREE.MathUtils.clamp(this.speed / this.spec.max, 0, 1);

    /*
     * The camera backs off as the crowd grows.
     *
     * This is not a flourish — it is a bug fix that turned into the best shot
     * in the game. With a fixed camera seven metres back, the first followers
     * spawned *between* the lens and the runner and filled the frame with a
     * stranger's head. Pulling back as they arrive puts them where they belong
     * and gives you the image the whole finale is for: one man, and then
     * forty people, running.
     */
    const crowd = THREE.MathUtils.clamp(this.followers / 40, 0, 1);
    // Behind the *back row*, not behind the runner. Ask the crowd how deep it
    // is and stand seven metres further out — anything less and the people you
    // have collected are either behind the lens or below the bottom of the
    // frame, which is what the first two attempts at this shot both did.
    const packDepth = this.followers > 0 ? (this.crowd?.depth() ?? 0) : 0;
    const back = this.spec.water ? 16 : Math.max(7.4, packDepth + 7);
    const high = this.spec.water ? 8.2 : 3.1 + crowd * 4.6;

    const waveY = this.spec.water ? this.waveAt(this.x, back) : 0;
    const wantX = this.x * 0.55;
    const wantY = high + this.y * 0.35 + waveY * 0.6;
    camera.position.x += (wantX - camera.position.x) * Math.min(1, 6 * dt);
    camera.position.y += (wantY - camera.position.y) * Math.min(1, 5 * dt);
    // Eased, so picking up a follower is a drift back rather than a jump cut.
    camera.position.z += (back - camera.position.z) * Math.min(1, 2.5 * dt);

    // Field of view is the speed gauge. Nobody reads a number at 20 m/s but
    // everybody feels the edges of the frame pulling out.
    const wantFov = 62 + t * 13 + this.shake * 4 - crowd * 14;
    camera.fov += (wantFov - camera.fov) * Math.min(1, 4 * dt);
    camera.updateProjectionMatrix();

    const shake = this.shake * this.shake;
    camera.position.x += (Math.random() - 0.5) * shake * 0.5;
    camera.position.y += (Math.random() - 0.5) * shake * 0.35;
    camera.lookAt(
      this.x * 0.72,
      (this.spec.water ? 0.4 : 1.35) + this.y * 0.4 + waveY * 0.5,
      this.spec.water ? -16 : -10,
    );
  }

  private finish(o: Outcome) {
    if (this.outcome !== "running") return;
    this.outcome = o;
    this.ctx.audio.stopMusic();
    if (o === "won") this.ctx.audio.fanfare();
    else this.ctx.audio.fail();
  }

  private hud(): ChapterHud {
    const [stat, statLabel] = this.spec.stat(this.dist);
    const hud: ChapterHud = {
      progress: THREE.MathUtils.clamp(this.dist / this.spec.goal, 0, 1),
      stat,
      statLabel,
      lives: Math.max(0, this.lives),
      maxLives: this.spec.lives,
      outcome: this.endTimer > 1.6 || this.outcome === "running" ? this.outcome : "running",
      earned: this.earned,
      chocolates: this.chocolates,
      metres: this.dist,
      shake: this.shake,
    };
    if (this.spec.pickup.carried) {
      hud.extra = `${this.carried.length}/4`;
      hud.extraLabel = this.spec.pickup.label;
    } else if (this.spec.followers) {
      hud.extra = String(Math.round(this.followers));
      hud.extraLabel = "FOLLOWING";
    } else if (this.spec.pickup.value) {
      hud.extra = `$${this.earned.toLocaleString()}`;
      hud.extraLabel = this.spec.pickup.label;
    } else {
      hud.extra = String(this.chocolates);
      hud.extraLabel = this.spec.pickup.label;
    }
    if (this.spec.chase) {
      hud.danger = `${Math.round(this.chaseGap)} M`;
      hud.dangerLabel = this.spec.chase.label;
    }
    return hud;
  }

  dispose() {
    this.ctx.audio.stopAllLoops();
    this.ctx.audio.stopMusic();
    this.groundMesh.geometry.dispose();
    (this.groundMesh.material as THREE.Material).dispose();
    this.roadMesh?.geometry.dispose();
    if (this.roadMesh) (this.roadMesh.material as THREE.Material).dispose();
    this.rain?.geometry.dispose();
    if (this.rain) (this.rain.material as THREE.Material).dispose();
    (this.shadow.userData.dispose as (() => void) | undefined)?.();
    this.crowd?.dispose();
    this.hero.dispose();
    for (const c of this.chasers) c.human?.dispose();
    // Pooled props share the module-level geometry cache, so they only need
    // detaching; `disposeGumpCaches` frees the GPU side once, at teardown.
    this.pool.clear();
    this.ctx.root.clear();
  }
}

