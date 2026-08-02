import * as THREE from 'three-ls';

/* ============================================================================
   IMPACT — flying a hull into a world, and what it costs.

   Until this file there was no collision in the game at all. `updateProximity`
   put a soft repulsion field around every planet and star and, past the floor,
   teleported the ship back onto the shell. The bleed inside it removes
   `min(1, t*2.4)` of the *remaining* inward velocity every frame, which at
   60 Hz is a quarter of it per frame a tenth of the way in and all of it from
   40% in — an e-fold of about seventy milliseconds. That is why a hull could
   be pointed at a world at full boost and simply end up parked against it, and
   why nothing in the codebase matched /crash|collide|impact|explode/ except
   one comment about an anti-collision strobe.

   Two halves live here.

   **The decision**, `approachVerdict`, is a pure function of four numbers and
   has no renderer in it, so the one thing that can actually ruin the game — a
   detonation on a landing somebody was trying to fly — is testable from node.
   The envelope is kept exactly as it was for everything under the limit,
   because a game that explodes when you were being careful is worse than one
   that never explodes. Above the limit the assist simply stops helping.

   The test is the *radial* component of velocity, and that is deliberately
   also the angle test the brief asked for: a hull crossing the envelope along
   the tangent is skimming the atmosphere and the field holds it, one coming
   straight down at the same speed is not and it does not. Fast, steep or
   unaligned all fall out of the same dot product.

   **The explosion** is everything else. Every mesh, material, buffer and
   particle below is built in the constructor and recycled; `fire()` writes
   numbers into arrays that already exist and allocates nothing, because the
   frame of the impact is the exact frame a hitch is unforgivable on.

   Three things about the shapes are not taste:

     · every burning surface is DoubleSide. The camera is inside the hull in
       two of the three view modes and the fireball is centred on the hull, so
       a front-faced sphere would cull to nothing precisely when the player is
       standing in the middle of it.
     · the point light is added to the *scene*, outside the group everything
       else hangs from, and it stays there at zero intensity for the life of
       the route. `NUM_POINT_LIGHTS` is part of every lit material's program
       key, so a light that appears at the moment of impact recompiles the
       whole frame on the one frame that must not stall. It costs one loop
       iteration per fragment forever and buys a detonation that actually
       lights the hull. Not built at all on the low tier, where that iteration
       is worth more than the light is.
     · the sprite falloff is a DataTexture computed in JS rather than a canvas
       gradient. A 2D context is not guaranteed outside a browser and this
       module is constructed in the test suite.
   ========================================================================== */

/* Closing speed, in world units per second — kilometres per second, as the
   flight model counts — above which the approach envelope is overwhelmed.

   Cruise is 60 and boost takes that to 252, so twenty is a third of an
   unboosted run: quick enough that anyone who arrived at a world on purpose is
   under it, slow enough that "I pointed the nose at the planet and held W" is
   not. The envelope's own throttle cut (t > 0.5) removes thrust but not
   momentum, so coasting in above this is still fatal, which is correct — the
   drive is not what kills you. */
export const CRASH_CLOSING = 20;

/* ...and the same number for a structure, which is a different problem. A
   station has no atmosphere to brake in and no field to be pushed off by, so
   there is no envelope at all: either you missed it or you hit it. Four is
   about seven per cent of cruise — a nudge is survivable, a fly-past is not. */
export const CRASH_CLOSING_HARD = 4;

/* The closing speed at which nothing recognisable is left. Only the top of the
   severity ramp; past it the explosion stops getting bigger because there is
   no frame left to fill. */
const CRASH_TOTAL = 150;

/** 0.3 at the threshold, 1 at CRASH_TOTAL. Scales the fireball and the shake. */
export function impactSeverity(closing) {
  const s = (Math.abs(closing) - CRASH_CLOSING) / (CRASH_TOTAL - CRASH_CLOSING);
  return Math.max(0.3, Math.min(1, 0.3 + s * 0.7));
}

/**
 * What the approach envelope should do about one body this frame.
 *
 * @param {number} dist    centre-to-centre distance
 * @param {number} floor   the hard shell — surface, corona, hull
 * @param {number} soft    where the envelope starts to push back
 * @param {number} closing inward radial speed, positive toward the body
 * @param {number} [limit] the assist's authority
 * @returns {'clear'|'assist'|'doomed'|'crash'}
 *   clear   nothing to do; outside the envelope entirely
 *   assist  inside it and slow enough to be saved — the old behaviour, intact
 *   doomed  inside it and too fast to be saved; the assist stands down so the
 *           ship actually reaches the surface instead of being tucked against
 *           it, and the player gets told while there is still time to turn
 *   crash   through the shell, at speed
 */
export function approachVerdict(dist, floor, soft, closing, limit = CRASH_CLOSING) {
  if (dist > soft) return 'clear';
  if (closing > limit) return dist <= floor ? 'crash' : 'doomed';
  return 'assist';
}

/* ---------------------------------------------------------------- the feel */

/* How long the world is held nearly still, and how long it takes to come back.
   A hit stop is the cheapest large win in the whole feature: 100 ms of near
   freeze reads as an impact you felt rather than a transition you watched. */
const FREEZE = 0.10;
const FREEZE_RAMP = 0.55;
const FROZEN = 0.05;

/* How long each layer of the explosion lasts, in seconds. Everything's *size*
   is authored in multiples of the hull's own length instead (see `this.S`), so
   the numbers further down read as "two ship lengths" rather than as fractions
   of a kilometre. */
const FIRE_LIFE = 1.35;
const SHOCK_LIFE = 0.62;
const SHELL_LIFE = 0.44;
const DEBRIS_LIFE = 3.2;
const SMOKE_LIFE = 4.6;
const LIGHT_LIFE = 0.95;
/* The longest a puff can actually last — SMOKE_LIFE times the top of its own
   jitter, plus the longest stagger — so `stop()` never cuts smoke that is
   still visible. Getting this wrong is a cloud that vanishes in one frame. */
const TOTAL_LIFE = SMOKE_LIFE * 1.1 + 0.5;

/* The crash, layered out of the pings Audio.js already owns, because the score
   is not this module's to extend. 'jump' is a 2.4 s lowpassed roar under a
   110 Hz sine falling to 27.5 — the sub-bass thump with the long tail; 'shot'
   is the crack sitting on top of it; 'fold' and 'unfold' are the tearing
   rumble underneath. The two alarms afterwards are the ship telling you it is
   still there. In time order, and read with a cursor rather than spliced out
   of a copy, so firing costs no allocation and no cue can play twice. */
const CUES = [
  [0, 'shot'], [0, 'jump'], [0.02, 'fold'], [0.16, 'unfold'],
  [1.30, 'alarm'], [2.10, 'alarm'],
];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _c = new THREE.Color();
// RingGeometry faces +Z, which is what the shockwave is rotated *from*.
const _RING_AXIS = new THREE.Vector3(0, 0, 1);

/** A soft round falloff with no canvas and no file behind it. */
function softSprite(size = 64) {
  const d = new Uint8Array(size * size * 4);
  const h = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - h, y - h) / h;
      // Squared falloff on a disc that never quite reaches the edge: a puff
      // that clips at the quad boundary reads as a square, which is the one
      // way a smoke sprite can look obviously fake.
      const a = Math.max(0, 1 - r * r);
      const i = (y * size + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = Math.round(255 * a * a);
    }
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Cheap deterministic-enough scatter; nothing here needs to be reproducible. */
const rnd = (a, b) => a + Math.random() * (b - a);

export class Impact {
  /**
   * @param {THREE.Scene} scene the scene the wreck happens in
   * @param {{mobile?:boolean, quality?:string, scale?:number}} [opts]
   *   scale — the hull's own length in world units. Everything is authored in
   *   multiples of it, so the explosion is sized to the ship rather than to
   *   the kilometre.
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.mobile = !!opts.mobile;
    const low = this.mobile || opts.quality === 'low';
    this.low = low;
    // 84 m, as ship/hull.js builds it, in the space scene's kilometres.
    this.S = opts.scale || 0.084;
    const S = this.S;

    this._t = 0;
    this.live = false;
    this.shake = 0;
    this.flash = 0;
    this.chroma = 0;
    this.desat = 0;
    this._anchor = new THREE.Vector3();
    this._normal = new THREE.Vector3(0, 1, 0);
    this._sev = 1;
    this._audio = null;
    this._cue = 0;

    this.group = new THREE.Group();
    this.group.frustumCulled = false;
    this.group.visible = false;
    scene.add(this.group);

    /* ---- the first frame: a hard white ball, gone almost before it is seen */
    this.flashMesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 2),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      }));
    this.flashMesh.frustumCulled = false;
    this.group.add(this.flashMesh);
    /* Every transparent piece of this is ordered by hand, above the planet's
       own atmosphere shell, which draws late and would otherwise sort in front
       of a fireball standing on the surface. `renderOrder` on the Group is not
       the same thing and does nothing: groups are never in the render list. */
    this.flashMesh.renderOrder = 14;

    /* ---- the fireball, as lobes rather than as a sphere.
       One instanced draw, one colour per lobe. A single expanding ball reads
       as a balloon; eight of them at different offsets, radii and rates read
       as something coming apart. Additive, so cooling to black is the fade
       and no per-instance opacity is needed. */
    const LOBES = low ? 6 : 11;
    this.lobeGeo = new THREE.IcosahedronGeometry(1, 1);
    this.lobeMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 1, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    });
    this.lobes = new THREE.InstancedMesh(this.lobeGeo, this.lobeMat, LOBES);
    this.lobes.frustumCulled = false;
    this.lobes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lobes.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(LOBES * 3), 3);
    this.lobes.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.lobes.renderOrder = 13;
    this.group.add(this.lobes);
    this._lobe = [];
    for (let i = 0; i < LOBES; i++) {
      this._lobe.push({
        dir: new THREE.Vector3(), pos: new THREE.Vector3(),
        r0: 0, r1: 0, out: 0, rate: 1, delay: 0,
      });
    }

    /* ---- the shockwave, flat on the surface it came off */
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.84, 1.0, low ? 32 : 72, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      }));
    this.ring.frustumCulled = false;
    this.ring.renderOrder = 13;
    this.group.add(this.ring);

    /* ...and the blast sphere behind it, which is what carries the read when
       the camera happens to be on the ring's own plane and the ring is edge-on
       and therefore invisible. Dropped on the low tier: it is a 24x16 sphere
       of overdraw for a beat and a half. */
    if (!low) {
      this.shell = new THREE.Mesh(
        new THREE.SphereGeometry(1, 24, 16),
        new THREE.MeshBasicMaterial({
          color: 0x9fc8ff, transparent: true, opacity: 0, depthWrite: false,
          blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
        }));
      this.shell.frustumCulled = false;
      this.shell.renderOrder = 13;
      this.group.add(this.shell);
    }

    /* ---- debris: two instanced draws over one set of transforms.
       The cold one is a lit metal fragment and belongs to the star; the hot
       one is an additive shell a fraction larger, carrying the per-piece heat
       in `instanceColor`, and it dies as the piece cools. Doing it as one
       material cannot work — `instanceColor` multiplies diffuse and does not
       reach emissive, so a standard material can be lit or per-piece hot but
       not both. */
    const N = this.mobile ? 12 : low ? 16 : 30;
    this.debrisN = N;
    this.fragGeo = new THREE.BoxGeometry(1, 0.34, 0.62);
    this.coldMat = new THREE.MeshStandardMaterial({
      color: 0x4a4d52, metalness: 0.85, roughness: 0.52, fog: false,
    });
    this.cold = new THREE.InstancedMesh(this.fragGeo, this.coldMat, N);
    this.cold.frustumCulled = false;
    this.cold.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.cold);

    this.hotMat = new THREE.MeshBasicMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, fog: false,
    });
    this.hot = new THREE.InstancedMesh(this.fragGeo, this.hotMat, N);
    this.hot.frustumCulled = false;
    this.hot.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.hot.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    this.hot.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.hot.renderOrder = 13;
    this.group.add(this.hot);

    this._frag = [];
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < N; i++) {
      this._frag.push({
        p: new THREE.Vector3(), v: new THREE.Vector3(),
        q: new THREE.Quaternion(), spin: new THREE.Vector3(),
        s: 1, heat: 0, age: 0, life: 1,
      });
      /* Explicitly collapsed rather than left on the zero-filled matrix the
         buffer starts with. Both draw nothing, but `prewarm` shows this group
         to the compiler on a live canvas and "nothing is drawn because the
         maths happens to degenerate" is not a thing to rely on there. */
      this.cold.setMatrixAt(i, _m);
      this.hot.setMatrixAt(i, _m);
    }

    /* ---- the trails. One segment per fragment, drawn from where it is back
       along where it has been, so the streak shortens as the piece slows and
       goes out as it cools. A real history buffer would be N times this for a
       streak nobody can resolve at the speed these are moving. */
    const tg = new THREE.BufferGeometry();
    this._trailPos = new Float32Array(N * 6);
    this._trailCol = new Float32Array(N * 6);
    tg.setAttribute('position', new THREE.BufferAttribute(this._trailPos, 3));
    tg.setAttribute('color', new THREE.BufferAttribute(this._trailCol, 3));
    tg.getAttribute('position').setUsage(THREE.DynamicDrawUsage);
    tg.getAttribute('color').setUsage(THREE.DynamicDrawUsage);
    this.trailGeo = tg;
    this.trailMat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false,
    });
    this.trails = new THREE.LineSegments(tg, this.trailMat);
    this.trails.frustumCulled = false;
    this.trails.renderOrder = 13;
    this.group.add(this.trails);

    /* ---- smoke. Sprites, not an instanced batch, and the reason is opacity:
       smoke has to *occlude*, so it cannot be additive, and there is no
       per-instance alpha on an InstancedMesh. A sprite carries its own
       material and therefore its own fade, at the price of one draw each. */
    const P = this.mobile ? 8 : low ? 10 : 16;
    this.puffTex = softSprite(64);
    this._puff = [];
    for (let i = 0; i < P; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.puffTex, transparent: true, opacity: 0, depthWrite: false,
        color: 0xffffff, fog: false,
      });
      const sp = new THREE.Sprite(mat);
      sp.frustumCulled = false;
      sp.renderOrder = 12;          // under the fire, over the world
      sp.visible = false;
      this.group.add(sp);
      this._puff.push({
        sp, mat, v: new THREE.Vector3(), s0: 1, s1: 2, age: 0, life: 1, peak: 0.5,
      });
    }

    /* ---- and a light that flares and dies. Outside the group on purpose —
       see the header. */
    if (!low) {
      this.light = new THREE.PointLight(0xffcf9a, 0, 60 * S, 2);
      scene.add(this.light);
    } else this.light = null;
  }

  /**
   * Build every program the wreck needs, against a scene that is already up.
   *
   * `group.visible` is false for the whole of a session that nobody crashes
   * in, and three skips invisible objects when it walks a scene to compile it
   * — so without this the four programs below (an additive basic, a lit
   * standard for the fragments, a sprite and a line) are built on the frame of
   * the impact. That is the one frame this entire module exists to keep
   * smooth, and a compile there measures in tens of milliseconds.
   *
   * Safe to show the group while it runs: every material is at zero opacity or
   * zero instance colour and every instance matrix is still zero-filled, so
   * there is nothing to draw. It runs behind the boot screen anyway.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera
   */
  async prewarm(renderer, camera) {
    if (this._warm || !renderer || !renderer.compileAsync) return;
    this._warm = true;
    const was = this.group.visible;
    this.group.visible = true;
    for (const p of this._puff) p.sp.visible = true;
    try {
      await renderer.compileAsync(this.scene, camera);
    } catch (e) {
      // Same call as Game._compileScene, and the same answer: a failed
      // precompile costs a slow frame later, not a broken route now.
      console.warn('[impact] precompile skipped', e);
    }
    this.group.visible = was;
    for (const p of this._puff) p.sp.visible = false;
  }

  /**
   * Detonate. Allocates nothing.
   *
   * @param {THREE.Vector3} at      the impact point, in absolute coordinates
   * @param {THREE.Vector3} normal  unit vector out of the surface that was hit
   * @param {number} severity       0.3 to 1, from `impactSeverity`
   * @param {{ping:Function}} [audio]
   */
  fire(at, normal, severity = 1, audio = null) {
    const S = this.S;
    const sev = Math.max(0.15, Math.min(1, severity));
    const size = 0.7 + sev * 0.6;
    this._sev = sev;
    this._t = 0;
    this.live = true;
    this._anchor.copy(at);
    this._normal.copy(normal).normalize();
    this.group.visible = true;
    this.group.position.set(0, 0, 0);

    // See CUES. Played off this object's own clock rather than off setTimeout,
    // so leaving the route silences the tail instead of scheduling noise into
    // the next world.
    this._audio = audio;
    this._cue = 0;

    // The flat plane of the blast is the surface, so the ring lies on it.
    _q.setFromUnitVectors(_RING_AXIS, this._normal);
    this.ring.quaternion.copy(_q);
    this.ring.scale.setScalar(0.3 * S * size);

    for (const l of this._lobe) {
      // A hemisphere biased out of the surface, with enough of a tangential
      // spread that the ball is wider than it is tall — which is what an
      // impact fireball does and what tells the eye it hit something.
      l.dir.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1));
      if (l.dir.lengthSq() < 1e-6) l.dir.set(0, 1, 0);
      l.dir.normalize();
      if (l.dir.dot(this._normal) < 0) l.dir.addScaledVector(this._normal, -1.4 * l.dir.dot(this._normal));
      l.dir.normalize();
      l.r0 = rnd(0.28, 0.5) * S * size;
      l.r1 = rnd(1.0, 2.1) * S * size;
      l.out = rnd(0.15, 1.5) * S * size;
      l.rate = rnd(0.75, 1.35);
      l.delay = rnd(0, 0.12);
    }

    for (const f of this._frag) {
      f.p.copy(this._normal).multiplyScalar(rnd(0.02, 0.14) * S);
      f.v.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1));
      if (f.v.lengthSq() < 1e-6) f.v.copy(this._normal);
      f.v.normalize();
      // Nothing is thrown *into* the thing it just hit.
      if (f.v.dot(this._normal) < 0.05) f.v.addScaledVector(this._normal, 0.6 - f.v.dot(this._normal));
      f.v.normalize().multiplyScalar(rnd(1.1, 5.2) * S * (0.6 + sev));
      f.spin.set(rnd(-9, 9), rnd(-9, 9), rnd(-9, 9));
      f.q.identity();
      f.s = rnd(0.05, 0.24) * S * size;
      f.heat = rnd(0.55, 1);
      f.age = 0;
      f.life = DEBRIS_LIFE * rnd(0.6, 1.15);
    }

    for (const p of this._puff) {
      p.v.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1));
      if (p.v.lengthSq() < 1e-6) p.v.copy(this._normal);
      p.v.normalize().multiplyScalar(rnd(0.10, 0.62) * S);
      // Smoke rises off the surface even in vacuum here, because it is what
      // the eye expects a column to do and the alternative reads as a static
      // grey ball parked on a planet.
      p.v.addScaledVector(this._normal, rnd(0.05, 0.34) * S);
      p.sp.position.copy(this._normal).multiplyScalar(rnd(0.05, 0.5) * S);
      p.s0 = rnd(0.55, 1.5) * S * size;
      p.s1 = p.s0 * rnd(2.4, 4.2);
      p.peak = rnd(0.28, 0.6);
      p.age = -rnd(0, 0.45);            // staggered, so it billows rather than pops
      p.life = SMOKE_LIFE * rnd(0.6, 1.1);
      p.sp.visible = true;
    }
  }

  /**
   * @param {number} dt   real seconds — this is the clock that ends the freeze,
   *   so it must never be the dilated one it hands back through `timeScale`.
   * @param {THREE.Vector3} [origin] the floating-origin anchor. The wreck stays
   *   where it happened; without this it would ride the camera.
   */
  update(dt, origin) {
    if (!this.live) return;
    const S = this.S, sev = this._sev;
    this._t += dt;
    const t = this._t;

    if (origin) this.group.position.copy(this._anchor).sub(origin);

    // ---- the cues, in order, each exactly once
    while (this._cue < CUES.length && t >= CUES[this._cue][0]) {
      const kind = CUES[this._cue++][1];
      if (this._audio) {
        try { this._audio.ping(kind); } catch { /* the context is closed */ }
      }
    }

    /* ---- the feel. Sharp attack, then a decay — a shake that ramps in reads
       as turbulence, and this is not turbulence. 12 ms to peak is about one
       frame, which is as close to instant as a 60 Hz camera can be. */
    const attack = Math.min(1, t / 0.012);
    this.shake = attack * Math.exp(-Math.max(0, t - 0.012) * 2.6) * (1.1 + sev * 2.4);
    this.flash = Math.max(0, 1 - t / (0.10 + sev * 0.32));
    this.chroma = Math.max(0, 0.011 * sev * (1 - t / 1.1));
    /* The colour going out of the picture and coming back. Longer than the
       flash by a lot: the flash is the hit and this is the concussion, and a
       desaturation that recovers as fast as the flash does just looks like a
       dropped frame. */
    this.desat = Math.max(0, 0.85 * sev * (1 - t / 1.9));

    // ---- flash ball
    {
      const u = Math.min(1, t / 0.16);
      const m = this.flashMesh.material;
      m.opacity = Math.max(0, 1 - u * u);
      this.flashMesh.scale.setScalar(S * (0.5 + u * 1.9) * (0.7 + sev * 0.6));
      this.flashMesh.visible = m.opacity > 0.002;
    }

    // ---- fireball
    {
      const alive = t < FIRE_LIFE;
      this.lobes.visible = alive;
      if (alive) {
        for (let i = 0; i < this._lobe.length; i++) {
          const l = this._lobe[i];
          const lt = Math.max(0, t - l.delay) * l.rate;
          const u = Math.min(1, lt / FIRE_LIFE);
          // Fast out of the gate, then coasting: 1-(1-u)^3.
          const e = 1 - (1 - u) * (1 - u) * (1 - u);
          const r = l.r0 + (l.r1 - l.r0) * e;
          l.pos.copy(l.dir).multiplyScalar(l.out * e);
          _m.compose(l.pos, _q.identity(), _v.setScalar(r));
          this.lobes.setMatrixAt(i, _m);
          this._fireColour(u, _c);
          this.lobes.instanceColor.setXYZ(i, _c.r, _c.g, _c.b);
        }
        this.lobes.instanceMatrix.needsUpdate = true;
        this.lobes.instanceColor.needsUpdate = true;
      }
    }

    // ---- shockwave
    {
      const u = Math.min(1, t / SHOCK_LIFE);
      const e = 1 - (1 - u) * (1 - u) * (1 - u);
      const m = this.ring.material;
      m.opacity = Math.max(0, (1 - u) * (1 - u) * 0.95);
      // White at the front, cooling behind it, exactly like the ball.
      m.color.setRGB(2.4 - u * 1.2, 2.0 - u * 1.6, 1.7 - u * 1.6);
      this.ring.scale.setScalar(S * (0.4 + e * 19 * (0.7 + sev * 0.6)));
      this.ring.visible = m.opacity > 0.004;
      if (this.shell) {
        const su = Math.min(1, t / SHELL_LIFE);
        const se = 1 - (1 - su) * (1 - su) * (1 - su);
        const sm = this.shell.material;
        sm.opacity = Math.max(0, (1 - su) * 0.5);
        this.shell.scale.setScalar(S * (0.4 + se * 10 * (0.7 + sev * 0.6)));
        this.shell.visible = sm.opacity > 0.004;
      }
    }

    // ---- debris and their trails
    {
      let any = false;
      for (let i = 0; i < this._frag.length; i++) {
        const f = this._frag[i];
        f.age += dt;
        const u = f.age / f.life;
        if (u >= 1) {
          // Parked at zero scale rather than removed: an InstancedMesh has a
          // fixed count and a stale matrix would leave a fragment hanging in
          // space for the rest of the route.
          _m.makeScale(0, 0, 0);
          this.cold.setMatrixAt(i, _m);
          this.hot.setMatrixAt(i, _m);
          this.hot.instanceColor.setXYZ(i, 0, 0, 0);
          this._trailPos[i * 6 + 0] = this._trailPos[i * 6 + 3] = 0;
          this._trailPos[i * 6 + 1] = this._trailPos[i * 6 + 4] = 0;
          this._trailPos[i * 6 + 2] = this._trailPos[i * 6 + 5] = 0;
          continue;
        }
        any = true;
        // A little drag, so pieces settle into a drifting cloud rather than
        // leaving the frame at a constant rate forever.
        f.v.multiplyScalar(Math.max(0, 1 - dt * 0.55));
        f.p.addScaledVector(f.v, dt);
        _e.set(f.spin.x * dt, f.spin.y * dt, f.spin.z * dt);
        f.q.multiply(_q.setFromEuler(_e));

        _m.compose(f.p, f.q, _v.set(f.s, f.s * 0.6, f.s * 0.8));
        this.cold.setMatrixAt(i, _m);
        _m.compose(f.p, f.q, _v.set(f.s * 1.28, f.s * 0.82, f.s * 1.05));
        this.hot.setMatrixAt(i, _m);

        // Cools far faster than it dies: a fragment glows for the first fifth
        // of its life and is a dark tumbling shard for the rest.
        const heat = Math.max(0, f.heat * (1 - u * 4.2));
        this.hot.instanceColor.setXYZ(i, heat * 3.0, heat * 1.15, heat * 0.28);

        const k = i * 6;
        this._trailPos[k] = f.p.x; this._trailPos[k + 1] = f.p.y; this._trailPos[k + 2] = f.p.z;
        _v2.copy(f.p).addScaledVector(f.v, -0.085);
        this._trailPos[k + 3] = _v2.x; this._trailPos[k + 4] = _v2.y; this._trailPos[k + 5] = _v2.z;
        this._trailCol[k] = heat * 2.6; this._trailCol[k + 1] = heat * 1.0; this._trailCol[k + 2] = heat * 0.24;
        this._trailCol[k + 3] = 0; this._trailCol[k + 4] = 0; this._trailCol[k + 5] = 0;
      }
      this.cold.instanceMatrix.needsUpdate = true;
      this.hot.instanceMatrix.needsUpdate = true;
      this.hot.instanceColor.needsUpdate = true;
      this.trailGeo.getAttribute('position').needsUpdate = true;
      this.trailGeo.getAttribute('color').needsUpdate = true;
      this.cold.visible = any;
      this.hot.visible = any;
      this.trails.visible = any;
    }

    // ---- smoke
    for (const p of this._puff) {
      p.age += dt;
      if (p.age < 0) { p.mat.opacity = 0; continue; }
      const u = p.age / p.life;
      if (u >= 1) { p.sp.visible = false; continue; }
      p.v.multiplyScalar(Math.max(0, 1 - dt * 0.30));
      p.sp.position.addScaledVector(p.v, dt);
      p.sp.scale.setScalar(p.s0 + (p.s1 - p.s0) * Math.sqrt(u));
      // In fast, out slow, and lit by the fire while there still is one.
      p.mat.opacity = p.peak * Math.min(1, u / 0.08) * (1 - u) * (1 - u);
      const glow = Math.max(0, 1 - p.age / 0.9);
      p.mat.color.setRGB(0.13 + glow * 0.9, 0.12 + glow * 0.42, 0.12 + glow * 0.10);
      p.sp.visible = p.mat.opacity > 0.003;
    }

    // ---- the light
    if (this.light) {
      const u = Math.min(1, t / LIGHT_LIFE);
      /* Candela, not a multiplier: irradiance falls as intensity/d², and the
         hull sits about 0.15 units from the centre of this, so 2.4 lands at
         roughly a hundred — a decade and a half over the star's 3.4, which is
         what a detonation at arm's length should be. */
      const k = Math.min(1, t / 0.03) * (1 - u) * (1 - u);
      this.light.intensity = 2.4 * sev * k;
      this.light.position.copy(this.group.position);
      this._fireColour(u, _c);
      this.light.color.setRGB(
        Math.min(1, 0.35 + _c.r * 0.3), Math.min(1, 0.2 + _c.g * 0.3), Math.min(1, 0.1 + _c.b * 0.3));
    }

    if (t > TOTAL_LIFE) this.stop();
  }

  /* White through yellow and orange into smoke, in HDR — the scene is tone
     mapped and a fireball authored at 1.0 comes out of AgX as beige. */
  _fireColour(u, out) {
    if (u < 0.12) {
      const k = u / 0.12;
      return out.setRGB(5.5 - k * 1.6, 5.2 - k * 2.3, 4.8 - k * 4.0);
    }
    if (u < 0.42) {
      const k = (u - 0.12) / 0.30;
      return out.setRGB(3.9 - k * 1.9, 2.9 - k * 2.1, 0.8 - k * 0.65);
    }
    const k = Math.min(1, (u - 0.42) / 0.58);
    return out.setRGB(2.0 * (1 - k) * (1 - k), 0.8 * (1 - k) * (1 - k), 0.15 * (1 - k));
  }

  /** Time dilation for everything that is not this explosion.
   *
   *  Clamped at both ends rather than only at the top, and that is not
   *  belt-and-braces: the ramp is `FROZEN + (t - FREEZE)/RAMP`, which is
   *  *negative* for the whole of the freeze, and Game multiplies its frame
   *  delta by this. A negative delta runs the world backwards. */
  get timeScale() {
    if (!this.live) return 1;
    return Math.max(FROZEN, Math.min(1, FROZEN + (this._t - FREEZE) / FREEZE_RAMP));
  }

  /**
   * Re-place the wreck against a floating origin that has just jumped.
   *
   * `update` reads the origin at the top of Game's frame, before the frame has
   * moved it, which costs nothing while the ship is stationary — and the ship
   * is stationary for the whole of a crash. The exception is the frame the
   * ship is teleported out from under a still-burning explosion, where one
   * frame of the old origin draws the smoke at the *new* position and the
   * fireball appears to follow the player into orbit.
   */
  reanchor(origin) {
    if (this.live && origin) this.group.position.copy(this._anchor).sub(origin);
  }

  /** Put it away. Idempotent; `fire` restarts it from here. */
  stop() {
    this.live = false;
    this.shake = this.flash = this.chroma = this.desat = 0;
    this.group.visible = false;
    this._cue = CUES.length;
    this._audio = null;
    if (this.light) this.light.intensity = 0;
    for (const p of this._puff) { p.sp.visible = false; p.mat.opacity = 0; }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.stop();
    if (this.scene) {
      this.scene.remove(this.group);
      if (this.light) this.scene.remove(this.light);
    }
    this.flashMesh.geometry.dispose();
    this.flashMesh.material.dispose();
    this.lobeGeo.dispose();
    this.lobeMat.dispose();
    this.lobes.dispose();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    if (this.shell) { this.shell.geometry.dispose(); this.shell.material.dispose(); }
    this.fragGeo.dispose();
    this.coldMat.dispose();
    this.hotMat.dispose();
    this.cold.dispose();
    this.hot.dispose();
    this.trailGeo.dispose();
    this.trailMat.dispose();
    for (const p of this._puff) p.mat.dispose();
    // Shared by every sprite, so it is released once and only here.
    this.puffTex.dispose();
    this.group.clear();
  }
}
