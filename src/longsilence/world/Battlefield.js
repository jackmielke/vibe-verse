import * as THREE from 'three-ls';
import { mulberry32 } from './generate.js';
import { FACTION, RAMP } from './Troopers.js';

/* ============================================================================
   THE GROUND ITSELF — what the two lines in Troopers.js are fighting over.

   Two lines of soldiers standing in an empty field is a diorama. A firefight
   needs somewhere to be: a thing behind each line worth holding, and enough
   junk between them that walking the seventy metres from your ramp to their
   position is a series of decisions rather than one long stroll.

   So this file builds, on every contested world:

     - two compounds, one per faction, behind their respective lines. Walls,
       a landing pad, masts, a blockhouse, crates and a banner, in the same
       blue and red the troopers wear — because at a hundred metres colour is
       the only thing that resolves and the base has to say whose it is on the
       first frame the player sees it.
     - cover between them: sandbag emplacements, crate stacks, berms, a gun
       nest per side, tank traps, barricades, wrecked armour.
     - a dead world's worth of ruin around all of it: blasted trunks, wall
       fragments, crater rims, rubble.

   Two constraints shaped every number below.

   **It is drawn in about a dozen calls.** There are well over a thousand
   objects out there and a phone cannot afford a thousand draws, so nothing
   here is a Mesh. Everything is a row in one of a handful of instanced
   batches keyed by (geometry, material) — a crate in the allied compound and a
   crate tipped in a crater are the same two triangles' worth of state, and a
   wrecked tank's road wheels share a batch with the antenna masts. What an
   object "is" is a function that pushes rows into batches, not a subtree.

   **It sits on the terrain.** `Game._maybeInvade` hands over the same
   `groundY(x, z)` sampler the troopers walk on, and every cluster samples it at
   its own origin. Authoring anything at a fixed y would put the allied base
   underground on one world and floating on the next.
   ========================================================================== */

/**
 * The faction livery, and it is a copy on purpose.
 *
 * `Troopers.js` keeps its `HUE` table private, and these have to be the same
 * three colours or a base reads as belonging to nobody. `battlefield.test.ts`
 * pins them against the colours actually on a live trooper's armour, so the
 * copy cannot drift without the suite saying so.
 */
const LIVERY = {
  ally: { armour: 0x1f4fa8, helmet: 0x2f6fe0, glow: 0x4d8dff },
  enemy: { armour: 0x8f1f1f, helmet: 0xd0342c, glow: 0xff5a44 },
};

/**
 * Anything shorter than this cannot hide a standing man, so it is cover but not
 * an obstruction: a 1.2 m berm is somewhere to crouch, not somewhere that
 * breaks a sightline. Only things taller are recorded as blockers.
 */
const SIGHT_H = 2.0;

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _c = new THREE.Color();

/**
 * One draw call's worth of scenery.
 *
 * Rows are plain arrays rather than objects because there are thousands of them
 * and they exist only between `add` and `build`; the flat form is what keeps
 * assembling a whole battlefield inside one frame of the landing sequence.
 */
class Batch {
  constructor(geo, mat, cast) {
    this.geo = geo;
    this.mat = mat;
    this.cast = cast;
    this.rows = [];
  }

  /** tint multiplies the material's own colour: 1 is the material as authored. */
  add(x, y, z, sx, sy, sz, ry = 0, tint = 1, rx = 0, rz = 0) {
    this.rows.push([x, y, z, sx, sy, sz, ry, tint, rx, rz]);
  }

  build(parent) {
    if (!this.rows.length) return null;
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, this.rows.length);
    /* Nothing on this field ever moves. Without the hint three re-uploads the
       matrix buffer's usage as dynamic and the driver keeps it in a staging
       heap it never needs. */
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.castShadow = this.cast;
    mesh.receiveShadow = true;
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      _e.set(r[8], r[6], r[9]);
      _q.setFromEuler(_e);
      _p.set(r[0], r[1], r[2]);
      _s.set(r[3], r[4], r[5]);
      mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
      const t = r[7];
      if (Array.isArray(t)) _c.setRGB(t[0], t[1], t[2]); else _c.setRGB(t, t, t);
      mesh.setColorAt(i, _c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    parent.add(mesh);
    this.rows.length = 0;
    return mesh;
  }
}

export class Battlefield {
  /**
   * @param {THREE.Scene} scene the ground scene
   * @param {(x:number,z:number)=>number} groundY the sampler the troopers walk on
   * @param {object} [opts]
   * @param {number} [opts.seed]     the planet spec's seed — same world, same field
   * @param {boolean} [opts.mobile]  scales the decorative counts, never the cover
   * @param {number} [opts.axisX]    the lane both lines are centred on
   * @param {number} [opts.allyZ]    where the allied line forms
   * @param {number} [opts.enemyZ]   where the hostile line forms
   */
  constructor(scene, groundY, opts = {}) {
    this.scene = scene;
    this._live = true;
    this.group = new THREE.Group();
    this.group.name = 'battlefield';

    const sampler = typeof groundY === 'function' ? groundY : null;
    /* A sampler that returns NaN anywhere would poison an instance matrix, and
       an InstancedMesh with one NaN in it disappears entirely — the bounding
       sphere goes non-finite and the whole batch culls. */
    this._gy = (x, z) => {
      if (!sampler) return 0;
      const y = sampler(x, z);
      return Number.isFinite(y) ? y : 0;
    };

    /* The spec's seed is a float around 0-100, so it has to be spread out
       before mulberry32 sees it: consecutive planets otherwise differ in the
       low bits only, and mulberry32's first draw off two nearby integers is
       two nearby numbers. */
    const raw = Number(opts.seed);
    const seed = Number.isFinite(raw) ? Math.floor(Math.abs(raw) * 7919) + 101 : 20240607;
    const rnd = mulberry32(seed);
    this.seed = seed;
    this.mobile = !!opts.mobile;

    const rng = (a, b) => a + rnd() * (b - a);
    const jit = (n) => (rnd() - 0.5) * 2 * n;
    this._rnd = rnd; this._rng = rng; this._jit = jit;

    /* Everything is laid out from the same three numbers `Battle` spawns off,
       so the two modules cannot disagree about where the fight is. Defaults
       match Troopers.js; Game passes nothing and gets the same field. */
    const axis = opts.axisX ?? RAMP.x;
    const allyZ = opts.allyZ ?? -100;
    const enemyZ = opts.enemyZ ?? -128;
    this.axis = axis;
    this.allyZ = allyZ;
    this.enemyZ = enemyZ;
    this.midZ = (allyZ + enemyZ) / 2;

    /** Cover the AI can claim: {x, y, z, yaw, r, faction, kind}. */
    this._cover = [];
    /** Footprints tall enough to break a sightline: {x, z, r}. */
    this._blockers = [];

    this._geo = this._makeGeometry();
    this._mat = this._makeMaterials();
    this._batches = this._makeBatches();
    this._wire = [];
    this._meshes = [];

    this._buildBase(FACTION.ALLY, axis - 44, allyZ + 24, -1);
    this._buildBase(FACTION.ENEMY, axis + 6, enemyZ - 48, 1);
    this._buildFront();
    this._buildRuin();

    for (const b of Object.values(this._batches)) {
      const m = b.build(this.group);
      if (m) this._meshes.push(m);
    }
    this._buildWires();

    scene.add(this.group);
  }

  /* ------------------------------------------------------------------ the API

     `Troopers.Battle` takes `opts.cover` and copies whatever it finds, so this
     is the whole contract between the two modules. Faction is always set —
     never null — because a bound claims a spot and the trooper suite asserts
     that a claimed spot belongs to the claimant's side. */

  /**
   * Somewhere to get behind, with the direction its occupant should be facing.
   *
   * `yaw` is in the same convention a trooper's own yaw uses (`atan2(dx, dz)`
   * toward the enemy), so a soldier standing here and looking downrange is
   * looking over the sandbags rather than into them.
   */
  coverPoints() { return this._cover; }

  /**
   * Is the straight line from A to B interrupted by something a man can stand
   * behind?
   *
   * The layout claim this backs is that neither line has an unbroken view of
   * the other — the point of a hundred tonnes of shipping container across the
   * middle of a field. Cheap enough to ask per trooper per second: the field
   * carries a few dozen blockers and each is one segment/circle test.
   */
  blocksSight(x0, z0, x1, z1) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len2 = dx * dx + dz * dz;
    for (const b of this._blockers) {
      const t = len2 > 0
        ? Math.max(0, Math.min(1, ((b.x - x0) * dx + (b.z - z0) * dz) / len2))
        : 0;
      const px = x0 + dx * t - b.x;
      const pz = z0 + dz * t - b.z;
      if (px * px + pz * pz < b.r * b.r) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- resources */

  _makeGeometry() {
    return {
      box: new THREE.BoxGeometry(1, 1, 1),
      /* Eight sides, not sixteen. These are drums, masts, road wheels and a
         landing pad seen from a hundred metres; the extra ring costs a third
         of the field's triangle budget and resolves on none of them. */
      cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 8),
      trunk: new THREE.CylinderGeometry(0.20, 0.5, 1, 6),
      rubble: new THREE.IcosahedronGeometry(0.5, 0),
    };
  }

  _makeMaterials() {
    const std = (o) => new THREE.MeshStandardMaterial(o);
    const mat = {
      steel: std({ color: 0x767b82, roughness: 0.70, metalness: 0.38 }),
      rust: std({ color: 0x7d4a30, roughness: 0.95, metalness: 0.14 }),
      concrete: std({ color: 0x8b877c, roughness: 0.96, metalness: 0.02 }),
      sand: std({ color: 0x9d9070, roughness: 1.0, metalness: 0.0 }),
      bark: std({ color: 0x3a322a, roughness: 1.0, metalness: 0.0 }),
      rock: std({ color: 0x56524c, roughness: 1.0, metalness: 0.03 }),
    };
    for (const f of ['ally', 'enemy']) {
      const h = LIVERY[f];
      mat[`${f}Panel`] = std({
        color: h.armour, roughness: 0.58, metalness: 0.24,
        emissive: h.glow, emissiveIntensity: 0.12,
      });
      /* A lamp on a mast is the one thing on the base that has to be legible
         at the far end of the field, past the fight, against a dark planet —
         so it is emissive well past its own albedo rather than a bright paint. */
      mat[`${f}Lamp`] = std({
        color: h.helmet, roughness: 0.4, metalness: 0.1,
        emissive: h.glow, emissiveIntensity: 1.6,
      });
    }
    mat.wire = new THREE.LineBasicMaterial({ color: 0x2b2e33, transparent: true, opacity: 0.75 });
    return mat;
  }

  _makeBatches() {
    const g = this._geo;
    const m = this._mat;
    /* Shadows on the silhouettes and not on the litter. The ground scene's
       shadow box follows the camera at 110 m of half-extent, so every one of
       these is inside it while the player is anywhere near the fight — a
       thousand pieces of gravel casting is a second full pass over the field
       for something nobody can see the shadow of. */
    const litter = !this.mobile;
    return {
      steel: new Batch(g.box, m.steel, true),
      rust: new Batch(g.box, m.rust, true),
      concrete: new Batch(g.box, m.concrete, true),
      sand: new Batch(g.box, m.sand, litter),
      allyPanel: new Batch(g.box, m.allyPanel, true),
      enemyPanel: new Batch(g.box, m.enemyPanel, true),
      allyLamp: new Batch(g.box, m.allyLamp, false),
      enemyLamp: new Batch(g.box, m.enemyLamp, false),
      cylSteel: new Batch(g.cyl, m.steel, true),
      cylRust: new Batch(g.cyl, m.rust, litter),
      trunk: new Batch(g.trunk, m.bark, true),
      rubble: new Batch(g.rubble, m.rock, litter),
    };
  }

  /* ------------------------------------------------------------------ pieces */

  _panelBatch(faction) {
    return faction === FACTION.ENEMY ? this._batches.enemyPanel : this._batches.allyPanel;
  }

  _lampBatch(faction) {
    return faction === FACTION.ENEMY ? this._batches.enemyLamp : this._batches.allyLamp;
  }

  _block(x, z, r) { this._blockers.push({ x, z, r }); }

  /**
   * Somewhere to fight from, facing whichever way the enemy is.
   *
   * `yaw` is `atan2(dx, dz)` toward downrange, which is the convention a
   * trooper's own yaw uses — with no lateral component that is 0 looking down
   * +Z and PI looking down -Z.
   */
  _mark(x, z, faction, kind, r, face) {
    this._cover.push({
      x, y: this._gy(x, z), z, yaw: face < 0 ? Math.PI : 0, r, faction, kind,
    });
  }

  /**
   * A run of sandbags, and a place behind it.
   *
   * `face` is the z direction the enemy is in; the bags go on that side of the
   * fighting position so that ducking behind them puts the wall between the
   * occupant and the incoming, which is the entire point and was backwards the
   * first time.
   */
  _sandbags(x, z, len, rows, faction, face, yaw = 0) {
    const B = this._batches.sand;
    const gy = this._gy(x, z);
    const bag = 0.92;
    const n = Math.max(2, Math.round(len / bag));
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    for (let r = 0; r < rows; r++) {
      const y = gy + 0.16 + r * 0.30;
      // Every other course is offset half a bag, or the wall reads as brickwork
      // drawn by a machine that has never seen a wall.
      const off = (r % 2) * bag * 0.5;
      for (let i = 0; i < n; i++) {
        const t = (i - (n - 1) / 2) * bag + off;
        const px = x + cos * t;
        const pz = z - sin * t;
        B.add(
          px, y, pz + face * 0.55,
          bag * 0.96, 0.30, 0.48,
          yaw + this._jit(0.09), 0.86 + this._rnd() * 0.28,
          0, this._jit(0.05),
        );
      }
    }
    if (faction) this._mark(x, z, faction, 'sandbag', 1.5, face);
    return gy;
  }

  /** A stack of cargo crates: cover, and the only litter on the field with corners. */
  _crates(x, z, count, faction, face) {
    const B = this._batches.steel;
    const gy = this._gy(x, z);
    let y = gy;
    for (let i = 0; i < count; i++) {
      const w = this._rng(1.5, 2.3);
      const h = this._rng(1.0, 1.5);
      const d = this._rng(1.5, 2.2);
      B.add(
        x + this._jit(0.5), y + h / 2, z + this._jit(0.5),
        w, h, d,
        this._jit(0.5), [this._rng(0.5, 0.8), this._rng(0.5, 0.75), this._rng(0.45, 0.7)],
        this._jit(0.04), this._jit(0.04),
      );
      // A band of colour on the top crate: a stack in your own compound should
      // read as yours even before the walls behind it do.
      if (faction && i === count - 1) {
        this._panelBatch(faction).add(x, y + h * 0.55, z + d * 0.5, w * 0.9, 0.22, 0.1, 0, 1);
      }
      y += h;
    }
    if (y - gy >= SIGHT_H) this._block(x, z, 1.15);
    if (faction && face) this._mark(x, z - face * 1.7, faction, 'crates', 1.6, face);
    return y;
  }

  /** A shipping container: twelve metres of sightline, gone. */
  _container(x, z, yaw, tipped) {
    const gy = this._gy(x, z);
    const tint = [this._rng(0.35, 0.7), this._rng(0.35, 0.65), this._rng(0.3, 0.6)];
    const roll = tipped ? Math.PI * 0.5 + this._jit(0.12) : 0;
    // Tipped is on its side, so it is a wall rather than a box — and half
    // buried in its own crater, which is why the roll is not a clean quarter
    // turn.
    this._batches.rust.add(x, gy + 1.35, z, 12.2, 2.6, 2.6, yaw, tint, 0, roll);
    /* Three circles down its length rather than one around the middle. A
       twelve-metre box inside a single r = 3 disc is a sightline blocker that
       lets a line pass straight through both ends of it. */
    for (let i = -1; i <= 1; i++) {
      this._block(x + Math.cos(yaw) * i * 4.1, z - Math.sin(yaw) * i * 4.1, 1.7);
    }
    return gy;
  }

  /**
   * An emplaced gun: sandbag horseshoe, tripod, a shield and a barrel.
   *
   * One per side, and it is the only thing out there that is unmistakably a
   * *weapon* rather than a place to stand — which is what makes the position it
   * sits in read as worth taking.
   */
  _gunNest(x, z, faction, face) {
    const gy = this._sandbags(x, z, 6.4, 3, faction, face);
    const S = this._batches.cylSteel;
    const B = this._batches.steel;
    // Tripod: three legs splayed off a hub at chest height.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.4;
      S.add(
        x + Math.sin(a) * 0.34, gy + 0.42, z + Math.cos(a) * 0.34,
        0.10, 0.95, 0.10, a, 1, Math.cos(a) * 0.38, -Math.sin(a) * 0.38,
      );
    }
    B.add(x, gy + 0.98, z, 0.55, 0.26, 0.75, 0, 0.8);
    // Shield plate, on the enemy's side of the gun.
    B.add(x, gy + 1.20, z + face * 0.45, 1.30, 0.62, 0.08, 0, 0.7);
    this._panelBatch(faction).add(x, gy + 1.20, z + face * 0.52, 0.5, 0.22, 0.05, 0, 1);
    // Barrel, through the shield and pointing downrange.
    S.add(x, gy + 1.22, z + face * 1.35, 0.12, 1.9, 0.12, 0, 0.6, Math.PI * 0.5, 0);
  }

  /** Tank trap: three bars welded through each other, and impossible to drive over. */
  _tankTrap(x, z) {
    const gy = this._gy(x, z);
    const S = this._batches.cylRust;
    const yaw = this._rng(0, Math.PI);
    const L = this._rng(2.4, 3.1);
    for (let i = 0; i < 3; i++) {
      const a = yaw + (i / 3) * Math.PI * 2;
      S.add(
        x, gy + L * 0.32, z,
        0.16, L, 0.16, a, 0.9 + this._rnd() * 0.2,
        Math.sin(a) * 0.62, Math.cos(a) * 0.62,
      );
    }
    /* Not a blocker. A hedgehog is three bars with air between them: it stops
       a vehicle and it stops nothing a rifle fires. */
  }

  /** A low mound of spoil. Somewhere to lie down; not somewhere to hide. */
  _berm(x, z, len, yaw, faction, face) {
    const gy = this._gy(x, z);
    const seg = Math.max(3, Math.round(len / 4));
    for (let i = 0; i < seg; i++) {
      const t = (i - (seg - 1) / 2) * (len / seg);
      const h = this._rng(0.9, 1.45);
      this._batches.sand.add(
        x + Math.cos(yaw) * t, gy + h / 2 - 0.15, z - Math.sin(yaw) * t,
        len / seg + 0.6, h, this._rng(2.4, 3.4),
        yaw + this._jit(0.12), 0.72 + this._rnd() * 0.2,
        this._jit(0.06), this._jit(0.06),
      );
    }
    if (faction && face) this._mark(x, z - face * 1.3, faction, 'berm', 1.8, face);
  }

  /** Somebody's armour, on its roof. */
  _wreck(x, z, yaw) {
    const gy = this._gy(x, z);
    const R = this._batches.rust;
    const S = this._batches.cylRust;
    const roll = this._rnd() < 0.4 ? Math.PI * this._rng(0.55, 0.85) : this._jit(0.22);
    R.add(x, gy + 1.15, z, 6.6, 1.9, 3.2, yaw, [0.85, 0.7, 0.62], this._jit(0.1), roll);
    // The turret is off the hull and lying in the dirt beside it, which is the
    // only detail that says this was killed rather than parked.
    const ta = yaw + this._rng(1.0, 2.4);
    R.add(
      x + Math.sin(ta) * 5.2, gy + 0.62, z + Math.cos(ta) * 5.2,
      2.6, 1.15, 2.9, ta, [0.8, 0.66, 0.58], this._jit(0.3), this._rng(0.6, 1.3),
    );
    S.add(x + Math.sin(ta) * 7.6, gy + 0.5, z + Math.cos(ta) * 7.6, 0.16, 3.0, 0.16, ta, 0.7, Math.PI * 0.5, 0);
    for (let i = 0; i < 4; i++) {
      const t = (i - 1.5) * 1.5;
      for (const side of [-1, 1]) {
        S.add(
          x + Math.cos(yaw) * t + Math.sin(yaw) * side * 1.5,
          gy + 0.55,
          z - Math.sin(yaw) * t + Math.cos(yaw) * side * 1.5,
          1.05, 0.42, 1.05, yaw, 0.6, 0, Math.PI * 0.5,
        );
      }
    }
    this._block(x, z, 3.2);
  }

  /** A tree that stopped being one. */
  _deadTree(x, z) {
    const gy = this._gy(x, z);
    const T = this._batches.trunk;
    const h = this._rng(3.0, 7.5);
    const lean = this._jit(0.16);
    const yaw = this._rng(0, Math.PI * 2);
    T.add(x, gy + h / 2, z, this._rng(0.5, 0.85), h, this._rng(0.5, 0.85), yaw, 0.8 + this._rnd() * 0.35, lean, this._jit(0.16));
    const limbs = Math.round(this._rng(1, 4));
    for (let i = 0; i < limbs; i++) {
      const a = yaw + (i / limbs) * Math.PI * 2 + this._jit(0.6);
      const at = this._rng(0.45, 0.9) * h;
      const l = this._rng(1.1, 2.6);
      T.add(
        x + Math.sin(a) * l * 0.3, gy + at, z + Math.cos(a) * l * 0.3,
        0.26, l, 0.26, a, 0.75 + this._rnd() * 0.3,
        Math.cos(a) * 1.1, -Math.sin(a) * 1.1,
      );
    }
    // The trunk, and only the trunk — the limbs are 26 cm of bare wood.
    if (h >= SIGHT_H * 1.6) this._block(x, z, 0.35);
  }

  /** What is left of a building: three or four faces of it, none of them whole. */
  _ruin(x, z, w, d) {
    const gy = this._gy(x, z);
    const C = this._batches.concrete;
    const yaw = this._rng(0, Math.PI);
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const local = (lx, lz) => [x + cos * lx + sin * lz, z - sin * lx + cos * lz];
    const faces = [
      [0, -d / 2, w, 0], [0, d / 2, w, 0], [-w / 2, 0, d, Math.PI / 2], [w / 2, 0, d, Math.PI / 2],
    ];
    for (const [lx, lz, len, extra] of faces) {
      // A blown wall is a run of stubs of wildly different heights, not one box
      // with a ragged texture: the skyline is the whole read.
      const n = Math.max(2, Math.round(len / 2.6));
      for (let i = 0; i < n; i++) {
        if (this._rnd() < 0.28) continue;                 // the bits that fell in
        const t = (i - (n - 1) / 2) * (len / n);
        const ox = extra ? lx : lx + t;
        const oz = extra ? lz + t : lz;
        const [px, pz] = local(ox, oz);
        const h = this._rng(1.2, 5.4);
        C.add(px, gy + h / 2, pz, len / n + 0.15, h, 0.55, yaw + extra, 0.72 + this._rnd() * 0.3, this._jit(0.05), this._jit(0.05));
      }
    }
    // A floor slab still spanning part of it, and the rubble of the rest.
    C.add(x, gy + this._rng(2.4, 4.2), z, w * this._rng(0.3, 0.55), 0.4, d * this._rng(0.3, 0.6), yaw, 0.66, this._jit(0.12), this._jit(0.12));
    this._rubbleRing(x, z, Math.max(w, d) * 0.62, Math.round(this._rng(10, 18)));
    // A third rather than a half: most of a blown building is the holes.
    this._block(x, z, Math.max(w, d) * 0.34);
  }

  /** A crater, as a rim: the terrain belongs to Surface.js and cannot be dented. */
  _crater(x, z, r) {
    const gy = this._gy(x, z);
    const R = this._batches.rubble;
    const n = Math.round(r * 3.5);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + this._jit(0.2);
      const rr = r * this._rng(0.82, 1.15);
      const px = x + Math.sin(a) * rr;
      const pz = z + Math.cos(a) * rr;
      const s = this._rng(0.7, 1.9);
      R.add(px, this._gy(px, pz) + s * 0.22, pz, s * 1.5, s, s * 1.4, a, 0.85 + this._rnd() * 0.3, this._jit(0.5), this._jit(0.5));
    }
    // Scorched slabs thrown into the middle of it.
    for (let i = 0; i < 3; i++) {
      const px = x + this._jit(r * 0.5);
      const pz = z + this._jit(r * 0.5);
      this._batches.rubble.add(px, this._gy(px, pz) + 0.15, pz, this._rng(0.8, 2.0), 0.4, this._rng(0.8, 1.8), this._rng(0, 3), 0.42, this._jit(0.3), this._jit(0.3));
    }
    return gy;
  }

  _rubbleRing(x, z, r, n) {
    for (let i = 0; i < n; i++) {
      const a = this._rng(0, Math.PI * 2);
      const rr = r * Math.sqrt(this._rnd());
      const px = x + Math.sin(a) * rr;
      const pz = z + Math.cos(a) * rr;
      const s = this._rng(0.3, 1.3);
      this._batches.rubble.add(
        px, this._gy(px, pz) + s * 0.25, pz,
        s * this._rng(0.9, 1.8), s, s * this._rng(0.9, 1.7),
        this._rng(0, 3), 0.7 + this._rnd() * 0.4, this._jit(0.6), this._jit(0.6),
      );
    }
  }

  /* -------------------------------------------------------------------- bases

     `face` is the z direction the enemy lies in, so one function builds both
     compounds and the gate always opens onto the fight. */

  _buildBase(faction, cx, cz, face) {
    const W = 21;                      // half-width, x
    const D = 15;                      // half-depth, z
    const gate = 5.6;                  // half the opening in the front wall
    const P = this._panelBatch(faction);
    const L = this._lampBatch(faction);
    const C = this._batches.concrete;
    const S = this._batches.cylSteel;
    const front = cz + face * D;
    const rear = cz - face * D;

    // ---- perimeter. Panels, because a prefab base is delivered on a lorry.
    const panel = (px, pz, yaw) => {
      const gy = this._gy(px, pz);
      C.add(px, gy + 1.65, pz, 4.2, 3.3, 0.55, yaw, 0.8 + this._rnd() * 0.2);
      P.add(px, gy + 2.85, pz, 4.2, 0.30, 0.62, yaw, 1);
      this._block(px, pz, 2.2);
    };
    for (let x = -W; x <= W; x += 4.2) {
      if (Math.abs(x) > gate) panel(cx + x, front, 0);
      if (Math.abs(x) > W * 0.45) panel(cx + x, rear, 0);      // open at the back: this is where supply comes from
    }
    for (let z = -D + 2; z <= D - 2; z += 4.2) {
      panel(cx - W, cz + z, Math.PI / 2);
      panel(cx + W, cz + z, Math.PI / 2);
    }

    // ---- gate towers, and the lamps that say whose gate it is.
    for (const side of [-1, 1]) {
      const tx = cx + side * gate;
      const gy = this._gy(tx, front);
      C.add(tx, gy + 2.6, front, 2.6, 5.2, 2.6, 0, 0.85);
      P.add(tx, gy + 4.6, front, 2.7, 0.5, 2.7, 0, 1);
      L.add(tx, gy + 5.4, front, 0.5, 0.5, 0.5, 0, 1);
      this._block(tx, front, 1.6);
    }
    // Sandbags either side of the opening: the fighting position at your own gate.
    this._sandbags(cx - gate - 2.6, front + face * 2.2, 5.0, 3, faction, face);
    this._sandbags(cx + gate + 2.6, front + face * 2.2, 5.0, 3, faction, face);

    // ---- blockhouse
    {
      const bx = cx - 12;
      const bz = cz - face * 4;
      const gy = this._gy(bx, bz);
      C.add(bx, gy + 2.2, bz, 11, 4.4, 8, 0, 0.9);
      C.add(bx, gy + 4.6, bz, 12, 0.5, 9, 0, 0.75);
      P.add(bx, gy + 3.9, bz + face * 4.05, 11, 0.5, 0.2, 0, 1);
      this._batches.steel.add(bx + 3.2, gy + 1.1, bz + face * 4.05, 1.8, 2.2, 0.2, 0, 0.35);
      for (let i = 0; i < 3; i++) {
        this._batches.steel.add(bx - 3.4 + i * 2.2, gy + 3.0, bz + face * 4.05, 1.5, 0.5, 0.16, 0, 0.2);
      }
      L.add(bx + 3.2, gy + 2.5, bz + face * 4.12, 0.34, 0.34, 0.12, 0, 1);
      this._block(bx, bz, 6.0);
    }

    // ---- outbuilding
    {
      const hx = cx + 14;
      const hz = cz + face * 7;
      const gy = this._gy(hx, hz);
      C.add(hx, gy + 1.6, hz, 6.4, 3.2, 5.2, 0.14, 0.82);
      P.add(hx, gy + 3.3, hz, 6.6, 0.4, 5.4, 0.14, 1);
      this._block(hx, hz, 3.6);
    }

    // ---- landing pad. An octagon, because eight sides at this size read as
    // built and a circle reads as a puddle.
    {
      const px = cx + 9;
      const pz = cz - face * 7;
      const gy = this._gy(px, pz);
      S.add(px, gy + 0.22, pz, 17, 0.45, 17, Math.PI / 8, 0.55);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        L.add(px + Math.sin(a) * 7.4, gy + 0.62, pz + Math.cos(a) * 7.4, 0.42, 0.42, 0.42, 0, 1);
      }
      for (let i = 0; i < 4; i++) {
        const o = (i - 1.5) * 1.9;
        P.add(px + o, gy + 0.47, pz - 2.2, 5.4, 0.1, 0.8, 0.62, 1);
        P.add(px + o, gy + 0.47, pz + 2.2, 5.4, 0.1, 0.8, -0.62, 1);
      }
      // Drums, off the pad and in a row, because fuel next to a landing site is
      // the one thing a compound would actually be careful about.
      for (let i = 0; i < 6; i++) {
        const dx = px + 11 + (i % 3) * 1.5;
        const dz = pz + Math.floor(i / 3) * 1.6 - 1;
        this._batches.cylRust.add(dx, this._gy(dx, dz) + 0.8, dz, 1.05, 1.6, 1.05, this._rng(0, 3), 0.8 + this._rnd() * 0.3);
      }
    }

    // ---- masts. Two, different heights, with guyed wire — the tallest thing
    // on the field and therefore what the player navigates by.
    for (const [mx, mz, h] of [[cx - 17.5, cz + face * 10, 18], [cx + 17.5, cz + face * 9, 13.5]]) {
      const gy = this._gy(mx, mz);
      S.add(mx, gy + h / 2, mz, 0.36, h, 0.36, 0, 0.7);
      for (let i = 0; i < 3; i++) {
        const at = gy + h * (0.6 + i * 0.14);
        const len = 3.4 - i * 0.9;
        this._batches.steel.add(mx, at, mz, len, 0.14, 0.14, i * 0.7, 0.5);
        this._batches.steel.add(mx, at, mz, 0.14, 0.14, len, i * 0.7, 0.5);
      }
      L.add(mx, gy + h + 0.4, mz, 0.44, 0.44, 0.44, 0, 1);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.5;
        const ax = mx + Math.sin(a) * 7;
        const az = mz + Math.cos(a) * 7;
        this._wire.push(mx, gy + h * 0.88, mz, ax, this._gy(ax, az) + 0.2, az);
      }
    }

    // ---- the banner. Skewed, and lit from its own material: a flag that hangs
    // straight down on a world with weather reads as a texture on a pole.
    {
      const fx = cx + 1.5;
      const fz = cz + face * 1.5;
      const gy = this._gy(fx, fz);
      S.add(fx, gy + 5.5, fz, 0.24, 11, 0.24, 0, 0.75);
      P.add(fx + 1.9, gy + 9.0, fz + 0.35, 3.6, 2.2, 0.09, 0.34, 1, 0, 0.11);
      L.add(fx, gy + 11.1, fz, 0.3, 0.3, 0.3, 0, 1);
    }

    // ---- stores
    this._crates(cx - 4.5, cz - face * 9, 3, faction, 0);
    this._crates(cx - 1.0, cz - face * 10.5, 2, faction, 0);
    this._crates(cx + 5.0, cz + face * 11, 2, faction, 0);
    this._rubbleRing(cx, cz, W * 0.9, this.mobile ? 12 : 26);
  }

  /* ----------------------------------------------------------------- the front

     Cover between the lines, and the numbers are the ones `Battle._planBound`
     can actually use: it rejects anything closer than 3 m or further than 24 m
     from the soldier, anything more than 14 m off his lane, and anything that
     would take him inside STANDOFF of his target. So the two claimable bands
     sit on the lines themselves rather than out in the middle — the middle is
     where the wrecks are, and the middle is contested precisely because there
     is nothing there to hold. */

  _buildFront() {
    const ax = this.axis;
    const allyBand = this.allyZ - 2;      // the allied line forms on its own sandbags
    const enemyBand = this.enemyZ + 1;
    const n = this.mobile ? 5 : 7;

    for (let i = 0; i < n; i++) {
      const f = i / (n - 1) - 0.5;
      // Allied cover is narrower than hostile cover because the allied *line*
      // is: 36 m of spread against 76 m. Cover wider than the men who use it is
      // cover nobody ever reaches.
      const axz = allyBand + this._jit(4);
      this._sandbags(ax + f * 40 + this._jit(2.5), axz, this._rng(5, 8), 3, FACTION.ALLY, -1);
      const exz = enemyBand + this._jit(4);
      this._sandbags(ax + f * 66 + this._jit(3.5), exz, this._rng(5, 9), 3, FACTION.ENEMY, 1);
    }

    // Crate stacks on both lines: taller cover, and it breaks the skyline that
    // a row of sandbags alone leaves perfectly flat.
    for (let i = 0; i < (this.mobile ? 2 : 4); i++) {
      const f = i / Math.max(1, (this.mobile ? 2 : 4) - 1) - 0.5;
      this._crates(ax + f * 34 + this._jit(3), allyBand + this._jit(5), 2 + Math.round(this._rnd()), FACTION.ALLY, -1);
      this._crates(ax + f * 58 + this._jit(4), enemyBand + this._jit(5), 2 + Math.round(this._rnd()), FACTION.ENEMY, 1);
    }

    // Spoil berms, dug out of the ground the lines are standing on.
    this._berm(ax - 26, allyBand - 3, 16, 0.08, FACTION.ALLY, -1);
    this._berm(ax + 24, allyBand - 1, 14, -0.1, FACTION.ALLY, -1);
    this._berm(ax - 30, enemyBand + 2, 18, 0.06, FACTION.ENEMY, 1);
    this._berm(ax + 30, enemyBand + 3, 16, -0.05, FACTION.ENEMY, 1);

    // One emplaced gun each, offset so the two are not mirror images.
    this._gunNest(ax - 19, this.allyZ - 4, FACTION.ALLY, -1);
    this._gunNest(ax + 23, this.enemyZ + 3, FACTION.ENEMY, 1);

    /* ---- the middle, and the reason it is here.

       Two lines on open ground can see every one of each other, which is a
       shooting gallery pointed both ways. Containers, ruins and dead armour
       across the midline mean most pairs of soldiers have something between
       them, so the fight is a series of angles rather than one long exchange —
       and so the player walking down from the ramp has a route. */
    const mid = this.midZ;
    /* Four, and not one more.
       A container is twelve metres of solid wall 2.6 m high, and the frontage
       the two lines occupy is about ninety. Eight of them — which is what this
       had first — is a fence: standing at the ramp you could see the allied
       line, a wall, and no hostiles at all, which is a worse failure than the
       open field it replaced. Four, staggered ten metres either side of the
       midline so they are not one row, leaves lanes to look and walk down. */
    const heavy = this.mobile ? 2 : 4;
    for (let i = 0; i < heavy; i++) {
      const f = i / Math.max(1, heavy - 1) - 0.5;
      this._container(
        ax + f * 76 + this._jit(5),
        mid + (i % 2 ? 10 : -10) + this._jit(4),
        this._rng(-0.55, 0.55) + (i % 2 ? Math.PI * 0.5 : 0),
        this._rnd() < 0.45,
      );
    }

    for (let i = 0; i < (this.mobile ? 2 : 4); i++) {
      this._wreck(ax + this._jit(46), mid + this._jit(16), this._rng(0, Math.PI * 2));
    }

    // Tank traps in two loose belts, which is how they are actually laid.
    const traps = this.mobile ? 14 : 26;
    for (let i = 0; i < traps; i++) {
      const belt = i % 2 ? mid - 9 : mid + 9;
      this._tankTrap(ax + this._jit(48), belt + this._jit(4));
    }

    /* ---- and the ground between the ship and your own line.

       The player steps out at z = -62 and the fighting starts thirty metres
       further on. Empty ground there means the first thirty seconds of a
       contested landing is a walk; these are the things to move between. */
    for (let i = 0; i < (this.mobile ? 3 : 5); i++) {
      const px = ax + this._jit(30);
      const pz = this.allyZ + this._rng(10, 26);
      this._crates(px, pz, 1 + Math.round(this._rnd() * 2), null, 0);
    }
    this._sandbags(ax - 12, this.allyZ + 16, 7, 3, FACTION.ALLY, -1);
    this._sandbags(ax + 14, this.allyZ + 20, 6, 3, FACTION.ALLY, -1);
    this._wreck(ax + 20, this.allyZ + 13, 1.1);
    for (let i = 0; i < 6; i++) this._tankTrap(ax + this._jit(34), this.allyZ + this._rng(8, 26));
  }

  /* ------------------------------------------------------------------- the ruin

     What the world looked like before anybody landed on it, minus most of it. */

  _buildRuin() {
    const ax = this.axis;
    const near = this.allyZ + 34;
    const far = this.enemyZ - 62;
    const span = (t) => near + (far - near) * t;

    for (let i = 0; i < (this.mobile ? 3 : 5); i++) {
      this._ruin(ax + this._jit(72), span(this._rng(0.08, 0.92)), this._rng(9, 20), this._rng(8, 16));
    }
    for (let i = 0; i < (this.mobile ? 5 : 9); i++) {
      this._crater(ax + this._jit(80), span(this._rng(0.02, 0.98)), this._rng(2.6, 6.5));
    }
    for (let i = 0; i < (this.mobile ? 10 : 24); i++) {
      this._deadTree(ax + this._jit(90), span(this._rng(0, 1)));
    }
    for (let i = 0; i < (this.mobile ? 6 : 14); i++) {
      this._rubbleRing(ax + this._jit(85), span(this._rng(0, 1)), this._rng(3, 9), this.mobile ? 5 : 9);
    }
    // Loose wall fragments away from any building they were ever part of.
    for (let i = 0; i < (this.mobile ? 4 : 9); i++) {
      const x = ax + this._jit(78);
      const z = span(this._rng(0, 1));
      const gy = this._gy(x, z);
      const h = this._rng(1.4, 3.6);
      this._batches.concrete.add(x, gy + h / 2 - 0.2, z, this._rng(2.2, 6.0), h, 0.5, this._rng(0, 3), 0.7 + this._rnd() * 0.25, this._jit(0.14), this._jit(0.14));
      if (h >= SIGHT_H) this._block(x, z, 1.4);
    }
  }

  _buildWires() {
    if (!this._wire.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this._wire), 3));
    const lines = new THREE.LineSegments(geo, this._mat.wire);
    lines.frustumCulled = false;
    this.group.add(lines);
    this._meshes.push(lines);
    this._geo.wire = geo;
    this._wire.length = 0;
  }

  dispose() {
    // Twice would double-free geometry a live renderer may still be drawing —
    // the same guard, and for the same reason, as Battle._live.
    if (!this._live) return;
    this._live = false;
    if (this.scene) this.scene.remove(this.group);
    for (const m of this._meshes) {
      if (m.isInstancedMesh) m.dispose();
    }
    this._meshes.length = 0;
    for (const g of Object.values(this._geo)) g.dispose();
    for (const m of Object.values(this._mat)) m.dispose();
    this.group.clear();
    /* These are handed out to Troopers.Battle, which marks them with live
       trooper references. Emptying rather than dropping the array means a
       consumer holding the same reference sees a field with no cover on it
       instead of cover on a field that no longer exists. */
    this._cover.length = 0;
    this._blockers.length = 0;
  }
}
