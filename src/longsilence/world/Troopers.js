import * as THREE from 'three-ls';

/* ============================================================================
   THE FRONT — troopers, and the fight over a landing site.

   Everything here is built from boxes and spheres at load, like the rest of
   this game: no rigs, no clips, no downloads. A trooper is nine parts in a
   group, and the animation is the group's own transforms driven by a phase —
   which is the only kind of animation that survives being spawned forty times
   on a phone.

   Colour is the whole read. At forty metres, across dust, in a helmet, the only
   thing that resolves is who is on your side:

     BLUE   helmet and chest plate — allied
     RED    helmet and chest plate — hostile
     GREEN  helmet — you

   So the armour carries the same hue as the helmet rather than a neutral
   fatigue colour, and both are emissive enough to read against a dark planet
   without a light on them.
   ========================================================================== */

export const FACTION = {
  ALLY: 'ally',
  ENEMY: 'enemy',
  PLAYER: 'player',
};

const HUE = {
  ally: { armour: 0x1f4fa8, helmet: 0x2f6fe0, glow: 0x4d8dff },
  enemy: { armour: 0x8f1f1f, helmet: 0xd0342c, glow: 0xff5a44 },
  player: { armour: 0x1f6b34, helmet: 0x35c95f, glow: 0x6effa0 },
};

/**
 * Where `Game.disembark` puts you on a contested world, in the ground scene's
 * metres: 0.36 L to starboard and 0.74 L forward of an 84 m hull, facing -Z.
 *
 * It is here because the whole layout below is measured from it rather than
 * from the hull's centreline — see the constructor for what happened when it
 * was not.
 */
export const RAMP = { x: 84 * 0.36, z: -84 * 0.74 };

/**
 * The rifle's rest pose, and it is not zero.
 *
 * The arm is one bone with its origin at the shoulder, extending down -Y, and
 * the rifle hangs off the far end of it. Aiming is `armR.rotation.x = -PI/2`,
 * which swings the whole bone forward — so the direction that ends up pointing
 * downrange is the arm's own -Y, not its -Z.
 *
 * With the rifle unrotated its muzzle (-Z) therefore pointed straight at the
 * ground while its owner was in the middle of a firefight. -PI/2 lays the
 * weapon along the bone: muzzle down at the low ready while walking, muzzle
 * downrange the moment the arm comes up, and the blend between them is free
 * because it is the arm that moves.
 */
const RIFLE_BASE = -Math.PI * 0.5;

/** One trooper, in metres. A person is 1.8 m; every number below follows. */
const H = {
  boot: 0.10, leg: 0.82, torso: 0.62, head: 0.24, arm: 0.58, rifle: 0.92,
};
/* Joint heights, shared by the builder and by the poser — a crouch moves three
   of these together and they must agree with where the parts were hung. */
const HIP_Y = H.boot + H.leg;
const TORSO_Y = HIP_Y + H.torso / 2;
const HEAD_Y = HIP_Y + H.torso + H.head / 2;
const SHOULDER_Y = HIP_Y + H.torso - 0.06;

/** Where a rifle starts to be worth firing. See the note in `Trooper.update`. */
const FIRE_RANGE = 45;
/**
 * The closest a bound will take a soldier to the nearest hostile.
 *
 * Without a floor the two lines walk into each other and finish the fight
 * standing inside one another's models, which reads as a scrum rather than a
 * firefight — and at that range the hit rolls below turn the whole thing over
 * in a few seconds.
 */
const STANDOFF = 28;
/**
 * One trooper's chance of hitting with one round, before posture.
 *
 * Deliberately poor marksmanship: a firefight that resolves in four seconds is
 * not a firefight, it is an execution. 0.28 was still an execution — it just
 * took twenty-three seconds, which is less time than it takes to walk to the
 * front. Raised slightly from 0.14 when bounds went in, because a soldier who
 * is running is not shooting and a third of each side is running at any moment.
 */
const BASE_HIT = 0.155;
/** In cover you are hard to kill; up and running you are not. */
const HIT_IN_COVER = 0.55;
const HIT_BOUNDING = 1.8;

/* Geometry and materials are built once and shared by every trooper on the
   field. Forty soldiers is forty groups pointing at the same nine buffers. */
function makeKit() {
  const geo = {
    boot: new THREE.BoxGeometry(0.16, H.boot, 0.30),
    leg: new THREE.BoxGeometry(0.15, H.leg, 0.16),
    torso: new THREE.BoxGeometry(0.46, H.torso, 0.26),
    plate: new THREE.BoxGeometry(0.50, 0.40, 0.30),
    head: new THREE.BoxGeometry(0.19, H.head, 0.20),
    helmet: new THREE.SphereGeometry(0.155, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62),
    brim: new THREE.CylinderGeometry(0.163, 0.163, 0.03, 12),
    arm: new THREE.BoxGeometry(0.115, H.arm, 0.115),
    rifle: new THREE.BoxGeometry(0.07, 0.10, H.rifle),
    scope: new THREE.BoxGeometry(0.05, 0.06, 0.18),
    muzzle: new THREE.PlaneGeometry(0.42, 0.42),
  };
  // Origins moved so a limb rotates about its joint rather than its middle.
  geo.leg.translate(0, -H.leg / 2, 0);
  geo.arm.translate(0, -H.arm / 2, 0);
  geo.rifle.translate(0, 0, -H.rifle * 0.32);

  const mat = {
    dark: new THREE.MeshStandardMaterial({ color: 0x24272e, roughness: 0.85, metalness: 0.1 }),
    kit: new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.8, metalness: 0.15 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.5, metalness: 0.7 }),
    skin: new THREE.MeshStandardMaterial({ color: 0x8a6a55, roughness: 0.9 }),
  };
  for (const f of Object.keys(HUE)) {
    mat[`${f}Armour`] = new THREE.MeshStandardMaterial({
      color: HUE[f].armour, roughness: 0.62, metalness: 0.22,
      emissive: HUE[f].glow, emissiveIntensity: 0.10,
    });
    mat[`${f}Helmet`] = new THREE.MeshStandardMaterial({
      color: HUE[f].helmet, roughness: 0.48, metalness: 0.25,
      emissive: HUE[f].glow, emissiveIntensity: 0.22,
    });
  }
  mat.muzzle = new THREE.MeshBasicMaterial({
    color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  return { geo, mat };
}

/**
 * Assemble one trooper.
 *
 * Returns the group plus direct handles to the parts that move, so `update`
 * never walks the tree looking for them — at forty troopers a frame that is
 * the difference between a scene graph traversal and four writes.
 */
function buildTrooper(kit, faction) {
  const { geo, mat } = kit;
  const armour = mat[`${faction}Armour`];
  const helmetMat = mat[`${faction}Helmet`];
  const g = new THREE.Group();

  const legL = new THREE.Mesh(geo.leg, mat.dark);
  const legR = new THREE.Mesh(geo.leg, mat.dark);
  legL.position.set(-0.12, HIP_Y, 0);
  legR.position.set(0.12, HIP_Y, 0);
  const bootL = new THREE.Mesh(geo.boot, mat.steel);
  const bootR = new THREE.Mesh(geo.boot, mat.steel);
  bootL.position.set(0, -H.leg + H.boot / 2, 0.04);
  bootR.position.copy(bootL.position);
  legL.add(bootL); legR.add(bootR);

  const torso = new THREE.Mesh(geo.torso, mat.kit);
  torso.position.set(0, TORSO_Y, 0);
  // The chest plate is the faction, and it is the biggest flat surface on the
  // silhouette — which is why it carries the colour rather than a shoulder flash.
  const plate = new THREE.Mesh(geo.plate, armour);
  plate.position.set(0, 0.04, 0.01);
  torso.add(plate);

  const head = new THREE.Mesh(geo.head, mat.skin);
  head.position.set(0, HEAD_Y, 0);
  const helmet = new THREE.Mesh(geo.helmet, helmetMat);
  helmet.position.set(0, 0.03, 0);
  const brim = new THREE.Mesh(geo.brim, helmetMat);
  brim.position.set(0, 0.01, 0);
  head.add(helmet); head.add(brim);

  const armL = new THREE.Mesh(geo.arm, mat.kit);
  const armR = new THREE.Mesh(geo.arm, mat.kit);
  armL.position.set(-0.30, SHOULDER_Y, 0);
  armR.position.set(0.30, SHOULDER_Y, 0);

  /* The rifle hangs off the right arm, so aiming and recoil are one rotation
     of one bone rather than two objects kept in sync. */
  const rifle = new THREE.Mesh(geo.rifle, mat.steel);
  rifle.position.set(0, -H.arm + 0.06, -0.16);
  // Also set here, not only in update(): the dead branch returns before posing
  // anything, so a trooper who never took a live frame would hold it wrong.
  rifle.rotation.x = RIFLE_BASE;
  const scope = new THREE.Mesh(geo.scope, mat.dark);
  /* Below the barrel in the rifle's own frame, which is above it once the
     weapon is posed — see RIFLE_BASE. The arm is a bone pointing down and the
     rifle hangs off its far end, so the rifle's -Y is the world's up. */
  scope.position.set(0, -0.08, -0.10);
  rifle.add(scope);
  /* The one material per trooper rather than per field: the flash's opacity is
     this soldier's recoil, so it cannot be shared. Tagged so dispose() can find
     the clones again — everything else in `mat` is shared and must survive. */
  const flashMat = mat.muzzle.clone();
  flashMat._perTrooper = true;
  const flash = new THREE.Mesh(geo.muzzle, flashMat);
  flash.position.set(0, 0.01, -H.rifle * 0.78);
  rifle.add(flash);
  armR.add(rifle);

  g.add(legL, legR, torso, head, armL, armR);

  /* Shadows, and they earn their cost. The ground scene's shadow box is 110 m
     of half-extent (more at a low sun) and it *follows the camera* — see
     fitGroundShadow — so a soldier anywhere near enough to shoot at is inside
     it. Without this a line of troopers on open ground reads as decals hovering
     a few centimetres above the dirt, which is the one thing a fight on a
     planet cannot afford to look like. The flash is excluded: an additive quad
     in a shadow map is a black rectangle. */
  g.traverse((o) => {
    if (o.isMesh && o !== flash) { o.castShadow = true; o.receiveShadow = true; }
  });

  g.userData.parts = { legL, legR, torso, head, armL, armR, rifle, flash };
  return g;
}

let _kit = null;
let _kitRefs = 0;
/** Shared by every trooper on the field, and rebuilt once the field is empty. */
function kit() { return (_kit = _kit || makeKit()); }
/* Torn down with the last battle rather than kept for the session. These are
   GPU resources belonging to a renderer that is about to be disposed with the
   route — holding them across a teardown means the next visit uploads against
   buffers the old context owned. */
function releaseKit() {
  if (--_kitRefs > 0 || !_kit) return;
  for (const g of Object.values(_kit.geo)) g.dispose();
  for (const m of Object.values(_kit.mat)) m.dispose();
  _kit = null;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class Trooper {
  constructor(faction, x, z, groundY) {
    this.faction = faction;
    this.object = buildTrooper(kit(), faction);
    this.pos = new THREE.Vector3(x, groundY(x, z), z);
    this.object.position.copy(this.pos);
    this.yaw = 0;
    /* The lane this soldier holds. Bounds are allowed to take ground and to
       sidestep, but not to wander: without a lane the two lines slide sideways
       across the map over ninety seconds and the fight leaves the frame the
       player is standing in. */
    this.home = { x, z };
    /* Both 7, up from 3 and 4, and deliberately equal.

       Together with the hit chances above this takes a nine-a-side engagement
       from a median of twenty-three seconds to over a minute — long enough that
       a player who lands, looks around and walks towards the noise arrives at a
       firefight rather than at a field of bodies.

       Equal because of what the alternative measured. At 8 against 6 the allies
       held 97 times out of 100 on their own: you could stand on the ramp doing
       nothing and still be told the site was yours, which makes the rifle set
       dressing — the thing you were handed the world to use. At 7 apiece a
       player who actually shoots is the one who decides it. */
    this.hp = 7;
    this.alive = true;
    this.phase = Math.random() * Math.PI * 2;
    this.cool = 0.4 + Math.random() * 1.6;
    this.target = null;
    this.recoil = 0;
    this.deadFor = 0;
    this.speed = 2.6 + Math.random() * 1.2;

    /* 'hold' shoots and does not move, 'bound' moves and does not shoot. The
       Battle decides who is in which; this class only executes it. */
    this.state = 'hold';
    this.dest = null;
    this.boundFor = 0;
    this.coverSpot = null;
    this.inCover = false;
    /** Decays to zero; drives the flinch, and a hit that lands breaks your shot. */
    this.stagger = 0;
    /** So a line of dead men does not all topple onto the same shoulder. */
    this.deathRoll = (Math.random() - 0.5) * 0.55;
  }

  /** Eye/chest height for hit tests and for where a shot leaves the rifle. */
  chest(out) { return out.copy(this.pos).setY(this.pos.y + 1.25); }

  hit(damage) {
    if (!this.alive) return false;
    this.hp -= damage;
    /* Set whether or not it kills. A round that lands and changes nothing on
       the model is a round the player cannot tell they fired. */
    this.stagger = 1;
    if (this.hp > 0) {
      // Being hit costs you the shot you were about to take.
      this.cool = Math.max(this.cool, 0.4);
      return false;
    }
    this.alive = false;
    this.state = 'down';
    this.dest = null;
    if (this.coverSpot) { this.coverSpot.taken = null; this.coverSpot = null; }
    this.inCover = false;
    return true;
  }

  /** A bound is over: stand the soldier down here and let him shoot again. */
  settle() {
    this.state = 'hold';
    this.dest = null;
    this.boundFor = 0;
    /* Claiming a sandbag is not the same as reaching it — a bound that times
       out halfway leaves you in the open, and being scored as covered there is
       how a side becomes unkillable without ever getting behind anything. */
    if (this.coverSpot) {
      const d = Math.hypot(this.coverSpot.x - this.pos.x, this.coverSpot.z - this.pos.z);
      if (d > 2.4) { this.coverSpot.taken = null; this.coverSpot = null; }
    }
    this.inCover = !!this.coverSpot;
  }

  update(dt, ctx) {
    const p = this.object.userData.parts;

    if (!this.alive) { this._fall(dt, p); return; }

    // ---- who to shoot at
    if (!this.target || !this.target.alive) this.target = ctx.nearestEnemy(this);
    const tgt = this.target;
    let dist = Infinity;
    if (tgt) {
      _v.copy(tgt.pos).sub(this.pos);
      dist = _v.length();
      this.yaw = Math.atan2(_v.x, _v.z);
    }

    this.stagger = Math.max(0, this.stagger - dt * 3.2);

    /* ---- the bound.

       Holding is the default and it is what the old code did all the time: walk
       until you are inside FIRE_RANGE, then stand and trade rounds until one
       line is gone. The Battle now nominates roughly a third of each side to
       move at a time — see _orders — and this is the moving half of that. */
    let moving = false;
    if (this.state === 'bound' && this.dest) {
      this.boundFor += dt;
      const dx = this.dest.x - this.pos.x;
      const dz = this.dest.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      /* Face where you are going, not where you are shooting. A soldier
         crabbing sideways at 4 m/s with the rifle up is the fastest way to make
         a firefight look like a bug. */
      if (d > 0.001) this.yaw = Math.atan2(dx, dz);
      // Five seconds, so a bound whose destination went under terrain still ends.
      if (d < 1.0 || this.boundFor > 5) {
        this.settle();
      } else {
        const step = Math.min(d, this.speed * 1.3 * dt);
        this.pos.x += (dx / d) * step;
        this.pos.z += (dz / d) * step;
        this.pos.y = ctx.groundY(this.pos.x, this.pos.z);
        moving = true;
      }
    }

    /* The stumble is on the object, not on `pos`: hit tests and tracer
       endpoints read `pos`, and a soldier who is briefly un-shootable because
       he is being shot is the worst possible reward for hitting him. */
    const flinch = this.stagger * this.stagger;
    const rock = 0.22 * flinch;
    this.object.position.set(
      this.pos.x - Math.sin(this.yaw) * rock,
      this.pos.y,
      this.pos.z - Math.cos(this.yaw) * rock,
    );
    this.object.rotation.set(0, this.yaw, 0);

    // ---- the walk
    this.phase += dt * (moving ? 7.5 : 1.2);
    const swing = Math.sin(this.phase) * (moving ? 0.62 : 0.05);

    /* Down behind the sandbags. Only ever non-zero when the battlefield handed
       us real cover to stand at, so nothing sinks into bare ground on a field
       that has none. */
    const duckTo = this.inCover ? 1 : 0;
    this._duck = this._duck === undefined ? duckTo : this._duck + (duckTo - this._duck) * Math.min(1, dt * 4);
    const duck = this._duck;
    const drop = 0.30 * duck;

    p.legL.rotation.x = swing + 0.42 * duck;
    p.legR.rotation.x = -swing + 0.42 * duck;
    p.torso.position.y = TORSO_Y + (moving ? Math.abs(Math.sin(this.phase)) * 0.03 : 0) - drop;
    p.head.position.y = HEAD_Y - drop;
    p.armL.position.y = SHOULDER_Y - drop;
    p.armR.position.y = SHOULDER_Y - drop;
    // The flinch: he rocks back off the round. Torso and head only — the rifle
    // is on the arm and a shot that swings the muzzle is a shot nobody can read.
    p.torso.rotation.x = -0.40 * flinch;
    p.head.rotation.x = -0.30 * flinch;

    /* Arms. A soldier walking swings them; a soldier in contact has the rifle
       up and both hands on it, which is the pose that reads as "fighting" from
       any distance. The left arm crosses to support the fore-end. */
    const aiming = this.state === 'hold' && !!tgt && dist <= FIRE_RANGE * 1.35;
    const aimBlend = aiming ? 1 : 0;
    this._aim = this._aim === undefined ? aimBlend : this._aim + (aimBlend - this._aim) * Math.min(1, dt * 6);
    const a = this._aim;
    const recoilKick = this.recoil * 0.5;
    p.armR.rotation.x = (-swing * 0.5) * (1 - a) + (-Math.PI * 0.5 + recoilKick) * a;
    p.armL.rotation.x = (swing * 0.5) * (1 - a) + (-Math.PI * 0.44 + recoilKick * 0.6) * a;
    p.armL.rotation.z = 0.30 * a;
    p.armR.rotation.z = -0.10 * a;
    p.rifle.rotation.x = RIFLE_BASE + this.recoil * 0.9;

    // ---- fire
    this.recoil = Math.max(0, this.recoil - dt * 6.5);
    p.flash.material.opacity = Math.max(0, this.recoil * 1.6);
    p.flash.rotation.z += dt * 22;

    this.cool -= dt;
    if (aiming && this.cool <= 0 && dist <= FIRE_RANGE * 1.2) {
      this.cool = 0.7 + Math.random() * 1.3;
      this.recoil = 1;
      ctx.fire(this, tgt);
    }
  }

  /**
   * Going down, in two beats.
   *
   * One beat is a mannequin tipping over. The round lands, he rocks back for a
   * fifth of a second, and *then* he falls — which is the difference between a
   * kill the player can see land and a body that was suddenly horizontal.
   * Below about 0.15 s the stagger does not resolve at thirty metres; above
   * 0.3 s it looks like he thought about it.
   */
  _fall(dt, p) {
    this.deadFor += dt;
    const s = Math.min(1, this.deadFor / 0.2);
    const f = Math.min(1, Math.max(0, (this.deadFor - 0.2) * 1.9));
    /* The rotation is on the group so the whole soldier goes over as a piece —
       a ragdoll here would cost more than the entire rest of this file. */
    this.object.rotation.x = 0.34 * s * (1 - f) - Math.PI * 0.5 * f * f;
    this.object.rotation.z = this.deathRoll * f;
    const back = 0.35 * s + 0.55 * f;
    this.object.position.set(
      this.pos.x - Math.sin(this.yaw) * back,
      this.pos.y + 0.30 * Math.sin(Math.PI * f) - 0.12 * f,
      this.pos.z - Math.cos(this.yaw) * back,
    );
    // The rifle comes down with him rather than staying welded to his shoulder.
    const g = Math.min(1, dt * 7);
    p.armR.rotation.x += (-0.18 - p.armR.rotation.x) * g;
    p.armL.rotation.x += (-0.18 - p.armL.rotation.x) * g;
    p.armR.rotation.z += (0 - p.armR.rotation.z) * g;
    p.armL.rotation.z += (0 - p.armL.rotation.z) * g;
    p.flash.material.opacity = 0;
  }
}

/**
 * Tracers.
 *
 * One buffer of line segments, rewritten each frame. Every shot on the field is
 * two vertices in the same draw call — a Line per bullet would put a hundred
 * draw calls on the ground scene inside ten seconds of contact.
 */
class Tracers {
  constructor(max = 96) {
    this.max = max;
    this.shots = [];
    const pos = new Float32Array(max * 6);
    const col = new Float32Array(max * 6);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.mat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.object = new THREE.LineSegments(this.geo, this.mat);
    this.object.frustumCulled = false;
    /* Explicitly empty. A fresh BufferGeometry draws its whole range, and the
       whole range here is `max` pairs of zeroed vertices — which is a bright
       additive smear at the origin of the ground scene, i.e. directly under
       the ship, on every frame between the battle spawning and its first
       update. */
    this.geo.setDrawRange(0, 0);
  }

  add(from, to, colour) {
    if (this.shots.length >= this.max) this.shots.shift();
    this.shots.push({ from: from.clone(), to: to.clone(), t: 0, colour: new THREE.Color(colour) });
  }

  update(dt) {
    const pos = this.geo.attributes.position.array;
    const col = this.geo.attributes.color.array;
    let n = 0;
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.t += dt * 4.5;
      if (s.t >= 1) { this.shots.splice(i, 1); continue; }
      // A short bright dash travelling the line, not the whole line lit at once.
      const head = Math.min(1, s.t + 0.16);
      _v.lerpVectors(s.from, s.to, s.t);
      _v2.lerpVectors(s.from, s.to, head);
      const o = n * 6;
      pos[o] = _v.x; pos[o + 1] = _v.y; pos[o + 2] = _v.z;
      pos[o + 3] = _v2.x; pos[o + 4] = _v2.y; pos[o + 5] = _v2.z;
      const f = 1 - s.t;
      col[o] = s.colour.r * f; col[o + 1] = s.colour.g * f; col[o + 2] = s.colour.b * f;
      col[o + 3] = s.colour.r; col[o + 4] = s.colour.g; col[o + 5] = s.colour.b;
      n++;
      if (n >= this.max) break;
    }
    this.geo.setDrawRange(0, n * 2);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }

  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

/**
 * Whatever the battlefield handed us to hide behind, in a shape this file can
 * rely on.
 *
 * `world/Battlefield.js` owns the sandbags and the bases and is a separate
 * module that may or may not be mounted on any given world, so everything here
 * is optional and everything is copied: the entries below carry an occupancy
 * mark, and marking an object that belongs to another module is how two
 * modules end up fighting over one array.
 */
function readCover(src) {
  let raw = src;
  try { if (typeof raw === 'function') raw = raw(); } catch { raw = null; }
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw) {
    if (!c) continue;
    const x = Number(c.x);
    const z = Number(c.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    out.push({
      x,
      z,
      faction: c.faction === FACTION.ALLY || c.faction === FACTION.ENEMY ? c.faction : null,
      taken: null,
    });
  }
  return out;
}

/**
 * The engagement over one landing site.
 *
 * Spawns two lines of troopers either side of the ship and runs them at each
 * other. The player is a third faction of one, on the allied side, and shoots
 * by raycast from wherever the camera is looking.
 */
export class Battle {
  /**
   * @param {THREE.Scene} scene the ground scene
   * @param {(x:number,z:number)=>number} groundY terrain height sampler
   * @param {object} [opts]
   */
  constructor(scene, groundY, opts = {}) {
    this.scene = scene;
    this.groundY = groundY;
    this.group = new THREE.Group();
    scene.add(this.group);
    kit(); _kitRefs++;
    this._live = true;

    this.tracers = new Tracers();
    this.group.add(this.tracers.object);

    this.troopers = [];
    this.kills = 0;
    this.losses = 0;
    this.playerHp = 100;
    this.over = null;
    this._events = [];
    this._cover = readCover(opts.cover);

    /* ---- where the two lines stand, and why the allies were invisible.

       The bug report was "the blue allies are not spawning". They were. Every
       one of them, every time — the loop below has always made one of each per
       iteration and a hundred simulated battles still had nine allies alive ten
       seconds in. What they were not was *in frame*.

       `disembark` stands you 30 m to starboard and 62 m forward of the hull,
       facing -Z (see RAMP). The allied line used to form at z = -80 with a 76 m
       lateral spread centred on the hull's centreline — so it was six to
       eighteen metres ahead of you and up to sixty-eight metres off to your
       left, which is sixty to eighty-five degrees off the view axis. On a 16:9
       frame at the ground camera's 62 degree vertical FOV, two and a half of
       the nine allies were on screen; all nine hostiles were, because at
       seventy metres downrange the same spread subtends barely thirty degrees.
       You stepped out, saw a full red line and nothing blue, and concluded your
       side had not turned up.

       So both lines are laid out around the ramp rather than around the hull,
       the allied line is pushed out to arm's length and narrowed to a bit under
       half the hostile spread, and the two now subtend a similar width from
       where you are standing: your line ahead of you, theirs beyond it, both
       inside the frame on the first sight of the planet. */
    /* `??`, not `||`. Every one of these has a legitimate zero — `count: 0` is
       how a test asks for an empty field to place its own troopers on, and it
       used to quietly get nine. */
    const count = opts.count ?? 9;
    const axisX = opts.axisX ?? RAMP.x;
    const allySpread = opts.allySpread ?? 36;
    const spread = opts.spread ?? 76;
    const allyZ = opts.allyZ ?? -100;
    const enemyZ = opts.enemyZ ?? -128;
    for (let i = 0; i < count; i++) {
      const f = i / Math.max(1, count - 1) - 0.5;
      this.spawn(
        FACTION.ALLY,
        axisX + f * allySpread + (Math.random() - 0.5) * 5,
        allyZ + Math.random() * 10,
      );
      this.spawn(
        FACTION.ENEMY,
        axisX + f * spread + (Math.random() - 0.5) * 7,
        enemyZ - Math.random() * 14,
      );
    }
    const c = this.counts();
    this._start = { ally: c.ally, enemy: c.enemy };
    this._warned = { ally: false, enemy: false };
  }

  spawn(faction, x, z) {
    const t = new Trooper(faction, x, z, this.groundY);
    this.troopers.push(t);
    this.group.add(t.object);
    return t;
  }

  /** Nearest living trooper of the other side. */
  nearestEnemy(from) {
    let best = null, bestD = Infinity;
    for (const t of this.troopers) {
      if (!t.alive || t.faction === from.faction) continue;
      const d = t.pos.distanceToSquared(from.pos);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  /**
   * Bounding overwatch.
   *
   * Two lines that close to rifle range and then stand still for ninety seconds
   * are a shooting gallery with two ends: nothing on the field moves, so
   * nothing the player does reads as having changed anything. A section under
   * fire moves in bounds instead — about a third get up and run to the next
   * piece of cover while the rest keep shooting, then they swap.
   *
   * It also does the balance work. A soldier who is running is not firing, and
   * a soldier who is running is nearly twice as easy to hit, so a side pays for
   * the ground it takes and neither line can simply walk over the other.
   */
  _orders(dt) {
    this._orderT = (this._orderT || 0) + dt;
    if (this._orderT < 1.5) return;
    this._orderT = 0;
    for (const side of [FACTION.ALLY, FACTION.ENEMY]) {
      const held = [];
      let bounding = 0;
      for (const t of this.troopers) {
        if (!t.alive || t.faction !== side) continue;
        if (t.state === 'bound') bounding++; else held.push(t);
      }
      const total = held.length + bounding;
      /* A last man alone holds and shoots. He is allowed to be the one who
         does not move: a lone survivor bounding forever is a soldier who never
         fires, and two of those on opposite sides is a fight that never ends —
         which is how the 400-second stalemates in the cover simulation
         happened. From two up, a third of the side moves and the rest cover,
         which is bounding; a side that stood up all at once would be charging,
         and a charge over open ground here is over in about eight seconds. */
      if (total < 2) continue;
      const want = Math.max(1, Math.round(total * 0.34));
      if (bounding >= want) continue;
      // The ones with the most ground to make up go first.
      held.sort((a, b) => this._gap(b) - this._gap(a));
      for (let i = 0; i < held.length && bounding < want; i++) {
        if (this._planBound(held[i])) bounding++;
      }
    }
  }

  _gap(t) { return t.target && t.target.alive ? t.pos.distanceTo(t.target.pos) : 0; }

  /**
   * Pick somewhere worth running to, and claim it.
   *
   * Prefers a piece of cover that is nearer the enemy than here and no nearer
   * than STANDOFF. With no cover on the field it bounds in the open instead —
   * forward while there is ground to take, sideways once there is not — because
   * `Battlefield.js` is a separate module and this has to look like a fight on
   * a world that has not got one.
   */
  _planBound(tr) {
    const tgt = tr.target && tr.target.alive ? tr.target : this.nearestEnemy(tr);
    if (!tgt) return false;
    tr.target = tgt;
    const dist = tr.pos.distanceTo(tgt.pos);
    const bx = tgt.pos.x - tr.pos.x;
    const bz = tgt.pos.z - tr.pos.z;
    const bl = Math.hypot(bx, bz) || 1;
    const fx = bx / bl, fz = bz / bl;          // toward him
    const lx = -fz, lz = fx;                   // and across

    let dest = null, spot = null, bestScore = Infinity;
    for (const c of this._cover) {
      if (c.faction && c.faction !== tr.faction) continue;
      if (c.taken && c.taken !== tr && c.taken.alive) continue;
      const d = Math.hypot(c.x - tr.pos.x, c.z - tr.pos.z);
      if (d < 3 || d > 24) continue;
      if (Math.abs(c.x - tr.home.x) > 14) continue;
      const toEnemy = Math.hypot(tgt.pos.x - c.x, tgt.pos.z - c.z);
      if (toEnemy < STANDOFF || toEnemy > dist + 6) continue;
      const score = d * 0.5 + toEnemy;
      if (score < bestScore) { bestScore = score; spot = c; dest = { x: c.x, z: c.z }; }
    }

    if (!dest) {
      const push = Math.min(13, Math.max(0, dist - STANDOFF));
      const side = (Math.random() - 0.5) * 14;
      if (push < 2 && Math.abs(side) < 3.5) return false;
      let x = tr.pos.x + fx * push + lx * side;
      const z = tr.pos.z + fz * push + lz * side;
      // Hold the lane, or the whole line walks out of the player's frame.
      const drift = x - tr.home.x;
      if (Math.abs(drift) > 11) x = tr.home.x + Math.sign(drift) * 11;
      dest = { x, z };
    }

    if (tr.coverSpot && tr.coverSpot !== spot) tr.coverSpot.taken = null;
    tr.coverSpot = spot;
    if (spot) spot.taken = tr;
    tr.dest = dest;
    tr.state = 'bound';
    tr.boundFor = 0;
    tr.inCover = false;
    return true;
  }

  /** A trooper takes a shot at another. Hits are rolled, not raycast. */
  fire(shooter, target) {
    shooter.chest(_v);
    target.chest(_v2);
    this.tracers.add(_v, _v2, shooter.faction === FACTION.ENEMY ? 0xff6a4a : 0x6ab5ff);
    let chance = BASE_HIT;
    if (target.state === 'bound') chance *= HIT_BOUNDING;
    else if (target.inCover) chance *= HIT_IN_COVER;
    if (Math.random() < chance && target.hit(1)) {
      if (target.faction === FACTION.ENEMY) { this.kills++; this._events.push(`HOSTILE DOWN · ${this.kills}`); }
      else { this.losses++; this._events.push('ALLY DOWN'); }
    }
    this._checkOver();
  }

  /**
   * The player's shot: a ray from the camera, tested against chest spheres.
   *
   * Spheres rather than mesh raycasting — a trooper is nine boxes and there may
   * be forty of them, and nobody has ever noticed that a torso is a ball.
   *
   * The ball is 0.9 m, which is wider than a chest and deliberately so. The
   * fight happens sixty to a hundred metres out because that is where a line
   * clear of an 84 m hull ends up; at eighty metres a real 0.5 m torso is about
   * six pixels, and a shooter where the target is six pixels wide is a shooter
   * nobody hits anything in.
   */
  playerShoot(origin, dir, range = 220) {
    const HIT_R = 0.9;
    let best = null, bestT = Infinity;
    for (const t of this.troopers) {
      if (!t.alive || t.faction !== FACTION.ENEMY) continue;
      t.chest(_v);
      _v.sub(origin);
      const along = _v.dot(dir);
      if (along <= 0 || along > range) continue;
      const perp = Math.sqrt(Math.max(0, _v.lengthSq() - along * along));
      if (perp > HIT_R) continue;
      if (along < bestT) { bestT = along; best = t; }
    }
    const end = _v2.copy(dir).multiplyScalar(best ? bestT : range).add(origin);
    this.tracers.add(origin, end, 0x9dffc0);
    if (best && best.hit(2)) {
      this.kills++;
      this._events.push(`HOSTILE DOWN · ${this.kills}`);
      this._checkOver();
      return true;
    }
    return false;
  }

  _checkOver() {
    if (this.over) return;
    const enemies = this.troopers.filter((t) => t.faction === FACTION.ENEMY && t.alive).length;
    const allies = this.troopers.filter((t) => t.faction === FACTION.ALLY && t.alive).length;
    /* Said once per side, and only on a field big enough for it to mean
       something. The player cannot count nine helmets across seventy metres of
       dust, so the feed is the only place the state of the fight is legible
       before it is decided. */
    if (!this._warned.enemy && this._start.enemy >= 4 && enemies * 2 <= this._start.enemy) {
      this._warned.enemy = true;
      this._events.push('HOSTILE LINE IS THINNING');
    }
    if (!this._warned.ally && this._start.ally >= 4 && allies * 2 <= this._start.ally) {
      this._warned.ally = true;
      this._events.push('OUR LINE IS TAKING IT');
    }
    if (!enemies) { this.over = 'won'; this._events.push('THE SITE IS HELD'); }
    else if (!allies) { this.over = 'lost'; this._events.push('THE LINE IS BROKEN'); }
  }

  /** Drain anything worth putting in the ship's log. */
  drainEvents() { const e = this._events; this._events = []; return e; }

  counts() {
    let ally = 0, enemy = 0;
    for (const t of this.troopers) {
      if (!t.alive) continue;
      if (t.faction === FACTION.ALLY) ally++; else if (t.faction === FACTION.ENEMY) enemy++;
    }
    return { ally, enemy, kills: this.kills, losses: this.losses, over: this.over };
  }

  update(dt, playerPos) {
    // Built once. Three closures a frame for the lifetime of a landing is not
    // a lot, but nothing else in this engine allocates inside its update loop.
    const ctx = this._ctx || (this._ctx = {
      nearestEnemy: (f) => this.nearestEnemy(f),
      fire: (s, t) => this.fire(s, t),
      groundY: this.groundY,
    });
    if (!this.over) this._orders(dt);
    for (const t of this.troopers) t.update(dt, ctx);
    this.tracers.update(dt);

    /* Return fire on the player. Enemies near enough and alive occasionally
       land one; the number is small because dying to something you never saw
       coming, on a planet you flew to for fun, is a bad trade. */
    if (playerPos && !this.over) {
      this._enemyT = (this._enemyT || 0) + dt;
      if (this._enemyT > 1.4) {
        this._enemyT = 0;
        for (const t of this.troopers) {
          if (!t.alive || t.faction !== FACTION.ENEMY) continue;
          if (t.pos.distanceTo(playerPos) < 50 && Math.random() < 0.22) {
            this.playerHp = Math.max(0, this.playerHp - 6);
            this._events.push('YOU ARE HIT');
            break;
          }
        }
      }
    }
  }

  dispose() {
    if (!this._live) return;                // disposing twice would double-release the kit
    this._live = false;
    this.scene.remove(this.group);
    for (const t of this.troopers) {
      t.object.traverse((o) => { if (o.isMesh && o.material && o.material._perTrooper) o.material.dispose(); });
    }
    this.troopers.length = 0;
    // These hold trooper references; the battle is going, so let them go too.
    for (const c of this._cover) c.taken = null;
    this._cover.length = 0;
    this.tracers.dispose();
    releaseKit();
  }
}
