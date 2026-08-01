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

  const hipY = H.boot + H.leg;
  const legL = new THREE.Mesh(geo.leg, mat.dark);
  const legR = new THREE.Mesh(geo.leg, mat.dark);
  legL.position.set(-0.12, hipY, 0);
  legR.position.set(0.12, hipY, 0);
  const bootL = new THREE.Mesh(geo.boot, mat.steel);
  const bootR = new THREE.Mesh(geo.boot, mat.steel);
  bootL.position.set(0, -H.leg + H.boot / 2, 0.04);
  bootR.position.copy(bootL.position);
  legL.add(bootL); legR.add(bootR);

  const torso = new THREE.Mesh(geo.torso, mat.kit);
  torso.position.set(0, hipY + H.torso / 2, 0);
  // The chest plate is the faction, and it is the biggest flat surface on the
  // silhouette — which is why it carries the colour rather than a shoulder flash.
  const plate = new THREE.Mesh(geo.plate, armour);
  plate.position.set(0, 0.04, 0.01);
  torso.add(plate);

  const head = new THREE.Mesh(geo.head, mat.skin);
  head.position.set(0, hipY + H.torso + H.head / 2, 0);
  const helmet = new THREE.Mesh(geo.helmet, helmetMat);
  helmet.position.set(0, 0.03, 0);
  const brim = new THREE.Mesh(geo.brim, helmetMat);
  brim.position.set(0, 0.01, 0);
  head.add(helmet); head.add(brim);

  const shoulderY = hipY + H.torso - 0.06;
  const armL = new THREE.Mesh(geo.arm, mat.kit);
  const armR = new THREE.Mesh(geo.arm, mat.kit);
  armL.position.set(-0.30, shoulderY, 0);
  armR.position.set(0.30, shoulderY, 0);

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

/**
 * Your own kit, seen from inside it.
 *
 * The trooper model has a green faction and until now nothing ever wore it: in
 * first person there is no body, so the only green on screen was the reticle.
 * "Give yourself a green helmet" cannot be answered literally — nobody has ever
 * seen their own helmet — so it is answered the way every first-person game
 * answers it, with the parts of yourself you *can* see. Green sleeves, green
 * gloves on a rifle, and a green chest plate when you look down.
 *
 * Laid out directly in camera space rather than reusing the trooper's arm
 * hierarchy. That hierarchy exists so one bone rotation can swing a rifle from
 * the low ready to the shoulder; a viewmodel never does that — it is welded to
 * the view — and inheriting the bones would mean fighting RIFLE_BASE for no
 * benefit. Here -Z is simply forward.
 *
 * The near plane sets every number in here. GROUND_NEAR is 0.5 m, and geometry
 * inside it is not "very close to the camera", it is gone — so the *nearest
 * face of every bounding box* has to clear 0.55 m, not the centres. That is
 * also why there is no chest plate: your own chest is at zero, and no amount of
 * arranging puts it in front of a half-metre near plane. Forearms and a weapon
 * is what a first-person camera can honestly show, which is why it is what
 * every game that has ever tried this shows.
 */
export function buildViewModel() {
  const { geo, mat } = kit();
  const g = new THREE.Group();

  /* `geo.rifle` is 0.92 long and pre-translated by -0.32 of that, so it spans
     local z from +0.166 to -0.754. At -0.88 its butt sits 0.71 m out and the
     muzzle 1.63 m out — well clear, and about where a shouldered weapon looks. */
  const rifle = new THREE.Mesh(geo.rifle, mat.steel);
  rifle.position.set(0.12, -0.15, -0.88);
  const scope = new THREE.Mesh(geo.scope, mat.dark);
  scope.position.set(0, 0.08, 0.02);
  rifle.add(scope);
  const flash = new THREE.Mesh(geo.muzzle, mat.muzzle.clone());
  flash.material._perTrooper = true;
  flash.position.set(0, 0.01, -H.rifle * 0.78);
  rifle.add(flash);

  /* Forearms and gloves, in your own green. `geo.arm` hangs 0.58 m down -Y from
     its joint, so about +75 degrees on X lays it along -Z, pointing where you
     are looking. The elbows are further from the eye than an elbow really is;
     they have to be. */
  const armR = new THREE.Mesh(geo.arm, mat.playerArmour);
  armR.position.set(0.20, -0.24, -0.70);
  armR.rotation.set(Math.PI * 0.42, 0, -0.10);
  const armL = new THREE.Mesh(geo.arm, mat.playerArmour);
  armL.position.set(-0.07, -0.26, -0.74);
  armL.rotation.set(Math.PI * 0.40, 0, 0.34);

  g.add(rifle, armL, armR);
  /* No shadows from any of it. A rifle 60 cm from the eye is a metre-wide
     shadow across the whole near field, and it belongs to a body that is not
     there. */
  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  g.userData.parts = { rifle, flash, armL, armR };
  return g;
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
    /* Both 7, up from 3 and 4, and deliberately equal.

       Together with the halved hit chance in `fire` this takes a nine-a-side
       engagement from a median of twenty-three seconds to ninety — long enough
       that a player who lands, looks around and walks towards the noise arrives
       at a firefight rather than at a field of bodies.

       Equal because of what the alternative measured. At 8 against 6 the allies
       held 97 times out of 100 on their own: you could stand on the ramp doing
       nothing and still be told the site was yours, which makes the rifle set
       dressing — the thing you were handed the world to use. At 7 apiece it is
       55%, and a player who actually shoots is the one who decides it. */
    this.hp = 7;
    this.alive = true;
    this.phase = Math.random() * Math.PI * 2;
    this.cool = 0.4 + Math.random() * 1.6;
    this.target = null;
    this.recoil = 0;
    this.deadFor = 0;
    this.speed = 2.6 + Math.random() * 1.2;
  }

  /** Eye/chest height for hit tests and for where a shot leaves the rifle. */
  chest(out) { return out.copy(this.pos).setY(this.pos.y + 1.25); }

  hit(damage) {
    if (!this.alive) return false;
    this.hp -= damage;
    if (this.hp > 0) return false;
    this.alive = false;
    return true;
  }

  update(dt, ctx) {
    const p = this.object.userData.parts;

    if (!this.alive) {
      /* Fall, once, and stay down. The rotation is on the group so the whole
         soldier goes over as a piece — a ragdoll here would cost more than the
         entire rest of this file. */
      this.deadFor += dt;
      const t = Math.min(1, this.deadFor * 2.2);
      this.object.rotation.x = -Math.PI * 0.5 * t * t;
      this.object.position.y = this.pos.y + 0.35 * Math.sin(Math.PI * t) - 0.1 * t;
      p.flash.material.opacity = 0;
      return;
    }

    // ---- who to shoot at
    if (!this.target || !this.target.alive) this.target = ctx.nearestEnemy(this);
    const tgt = this.target;
    let dist = Infinity;
    if (tgt) {
      _v.copy(tgt.pos).sub(this.pos);
      dist = _v.length();
      this.yaw = Math.atan2(_v.x, _v.z);
    }

    /* Advance until in range, then hold and fire. Soldiers that close all the
       way end up standing inside each other, which reads as a scrum rather
       than a firefight.

       Forty-five metres, not twenty-five. The ship is eighty-four metres long,
       so anything spawned clear of the hull starts a long way out; a shorter
       engagement range means the two lines spend most of the fight walking at
       each other, and a player who has just landed is watching a parade. */
    const RANGE = 45;
    let moving = false;
    if (tgt && dist > RANGE) {
      const step = this.speed * dt;
      this.pos.x += Math.sin(this.yaw) * step;
      this.pos.z += Math.cos(this.yaw) * step;
      this.pos.y = ctx.groundY(this.pos.x, this.pos.z);
      moving = true;
    }
    this.object.position.copy(this.pos);
    this.object.rotation.set(0, this.yaw, 0);

    // ---- the walk
    this.phase += dt * (moving ? 7.5 : 1.2);
    const swing = Math.sin(this.phase) * (moving ? 0.62 : 0.05);
    p.legL.rotation.x = swing;
    p.legR.rotation.x = -swing;
    p.torso.position.y = H.boot + H.leg + H.torso / 2 + (moving ? Math.abs(Math.sin(this.phase)) * 0.03 : 0);

    /* Arms. A soldier walking swings them; a soldier in contact has the rifle
       up and both hands on it, which is the pose that reads as "fighting" from
       any distance. The left arm crosses to support the fore-end. */
    const aiming = !!tgt && dist <= RANGE * 1.35;
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
    if (aiming && this.cool <= 0 && dist <= RANGE * 1.2) {
      this.cool = 0.7 + Math.random() * 1.3;
      this.recoil = 1;
      ctx.fire(this, tgt);
    }
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

    /* Your own arms and rifle, welded to the view. Parented to the battle's
       group so it appears with the fight and goes with it — there is no reason
       to be holding a rifle on a world nobody is contesting. Hidden until the
       first `aim()`, so it never flashes at the origin on the frame it is
       built. */
    this.view = buildViewModel();
    this.view.visible = false;
    this.group.add(this.view);
    this._kick = 0;

    this.tracers = new Tracers();
    this.group.add(this.tracers.object);

    this.troopers = [];
    this.kills = 0;
    this.losses = 0;
    this.playerHp = 100;
    this.over = null;
    this._events = [];

    /* ---- where the two lines stand.

       All of it is past the ship's nose, down -Z, and the numbers come from the
       hull: it is 84 m long, so its nose is at z = -42 and anything nearer than
       about -55 spawns a soldier inside the landing gear. You step out at -62.

       These were -95 and -165, and driving the landing in a browser is what
       showed that to be wrong. The two lines met around -130 — a hundred and
       ten metres from the ramp, a thirty-five second jog at 3.1 m/s — and the
       whole engagement resolved in a median of twenty-three seconds. You landed
       on a contested world, set off towards the fight, and it was over before
       you got there. The one thing an invasion cannot be is somebody else's.

       So the front comes to you: -80 and -128. Forty-eight metres apart, which
       is inside the 45 m engagement range almost immediately — land, step out,
       and it has already started, thirty metres in front of you. It is also the
       range at which red armour still reads as red, which is the other thing
       the browser showed. */
    /* `??`, not `||`. Every one of these has a legitimate zero — `count: 0` is
       how a test asks for an empty field to place its own troopers on, and it
       used to quietly get nine. */
    const count = opts.count ?? 9;
    const spread = opts.spread ?? 76;
    const allyZ = opts.allyZ ?? -80;
    const enemyZ = opts.enemyZ ?? -128;
    for (let i = 0; i < count; i++) {
      const t = (i / Math.max(1, count - 1) - 0.5) * spread;
      this.spawn(FACTION.ALLY, t + (Math.random() - 0.5) * 7, allyZ + Math.random() * 12);
      this.spawn(FACTION.ENEMY, t + (Math.random() - 0.5) * 7, enemyZ - Math.random() * 14);
    }
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

  /** A trooper takes a shot at another. Hits are rolled, not raycast. */
  fire(shooter, target) {
    shooter.chest(_v);
    target.chest(_v2);
    this.tracers.add(_v, _v2, shooter.faction === FACTION.ENEMY ? 0xff6a4a : 0x6ab5ff);
    /* Deliberately poor marksmanship: a firefight that resolves in four seconds
       is not a firefight, it is an execution. 0.28 was still an execution — it
       just took twenty-three seconds, which is less time than it takes to walk
       to the front. See the note on where the lines stand. */
    if (Math.random() < 0.14 && target.hit(1)) {
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
    if (!enemies) { this.over = 'won'; this._events.push('THE SITE IS HELD'); }
    else if (!allies) { this.over = 'lost'; this._events.push('THE LINE IS BROKEN'); }
  }

  /**
   * Put the viewmodel where the eye is.
   *
   * Called with the *player's* eye and orientation rather than the camera's,
   * because on the ground the camera is assigned from those a few lines later
   * and reading it here would hang the rifle one frame behind your head — which
   * is exactly the lag people describe as "floaty" without being able to say
   * why.
   *
   * `shown` is false whenever the player is not standing on the planet: in the
   * cabin, in a cutscene, or watching the crane shot after touchdown. A rifle
   * across the middle of a landing sequence is not a viewmodel, it is a bug.
   */
  aim(eye, quat, shown) {
    const v = this.view;
    if (!v) return;
    v.visible = !!shown;
    if (!shown) return;
    v.position.copy(eye);
    v.quaternion.copy(quat);
    /* Recoil. The weapon comes back towards the shoulder and the muzzle lifts;
       the *view* kick is separate and lives in Game (see `player.look`), so this
       is only the gun moving inside the frame. */
    this._kick = Math.max(0, this._kick - 0.06);
    const p = v.userData.parts;
    p.rifle.position.z = -0.62 + this._kick * 0.09;
    p.rifle.rotation.x = this._kick * 0.22;
    p.flash.material.opacity = Math.max(0, this._kick * 1.5 - 0.4);
    p.flash.rotation.z += 0.7;
  }

  /** The player pulled the trigger: kick the gun in the frame. */
  kick() { this._kick = 1; }

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
    // The viewmodel's muzzle flash is a clone too — same rule as a trooper's.
    if (this.view) {
      this.view.traverse((o) => {
        if (o.isMesh && o.material && o.material._perTrooper) o.material.dispose();
      });
      this.view = null;
    }
    this.troopers.length = 0;
    this.tracers.dispose();
    releaseKit();
  }
}
