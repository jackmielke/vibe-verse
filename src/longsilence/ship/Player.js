import * as THREE from 'three-ls';

/* ============================================================================
   First-person crew controller, working in interior metres.

   Collision is deliberately not a physics engine: the module is a corridor of
   known width, so the walkable region is a half-width function of Z plus a
   handful of blocker rectangles. Moving each axis separately means you slide
   along a bulkhead instead of sticking to it.
   ========================================================================== */

const EYE = 1.66;          // eye height, metres
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _ctrl = new THREE.Vector3();
const _tmpV = new THREE.Vector3();
const RADIUS = 0.30;

/* Two sets of speeds, because the two places this controller runs are not the
   same size. The deck is a nine-metre corridor with a seat at one end: 1.75 m/s
   is a walk and anything quicker is running into bulkheads. A planet is
   hundreds of metres of open ground — the hostile line forms about sixty-six
   metres past where the ramp puts you down — and crossing it at deck pace is
   half a minute of holding W with nothing happening. Sprint is a shade under
   double walk in both places, so the key does the same thing in both.

   Ground sprint was 7.6 m/s for a while, which is 27 km/h — a world record,
   and fast enough that the eye's terrain follow below could not keep up with
   it. 6.6 still puts the hostile line ten seconds out. */
const DECK_WALK = 1.75;
const DECK_RUN = 3.1;
const GROUND_WALK = 4.0;
const GROUND_RUN = 6.6;

/* Radians of look per pixel of pointer travel, and the two are separate for the
   same reason the speeds are. In the cabin you are reading labels off a
   console; on a planet you are turning to face something shooting at you.
   0.0034 puts a full turn at about 1850 px, which is a normal shooter. Neither
   of these is `Input.sensitivity` — that is the gain on the flight rate stick
   and it is a different quantity in different units.

   LOOK_GROUND is load-bearing outside this file: Game's rifle kicks the muzzle
   with `player.look(0, -13, 1)`, in pixels, so this gain sets the recoil angle
   as well as the mouse gain — 13 px is 2.53° here against 1.79° at the old
   shared 0.0024. onFoot.test.ts pins that number so the next person to touch
   this has to decide what the rifle does rather than move it by accident. */
const LOOK_DECK = 0.0024;
const LOOK_GROUND = 0.0034;

/* Just shy of straight up and straight down. It was 1.32 rad (76°), which is a
   fine limit for a pilot in a seat and a bad one on foot: you could not look at
   your own feet on a slope, or up at the thing on the ridge. π/2 exactly is the
   YXZ gimbal singularity — the head snaps a half turn as it crosses — so stop
   just under it. */
const PITCH_LIMIT = 1.54;

export class Player {
  constructor(interior) {
    this.interior = interior;
    this.pos = new THREE.Vector3(0, 0, 2.4);   // standing in the habitat
    this.vel = new THREE.Vector3();
    this.yaw = 0;                       // wake facing forward, toward the helm
    this.pitch = 0;
    this.mode = 'walk';                 // walk | seated | moving | ground
    /* `ground` is the same controller standing on a planet instead of on a
       deck. Everything about walking is identical — the only two things the
       interior supplies are the corridor's walkable region and a floor at y=0,
       and outdoors both come from the terrain instead. */
    this.groundHeight = null;           // (x, z) -> metres, set by Game on foot
    this.groundY = 0;
    this.bob = 0;
    this.bobAmt = 0;
    this.seatBlend = 0;
    this.station = null;                // station currently in reach
    this.seatedAt = null;
    this._from = { pos: new THREE.Vector3(), yaw: 0, pitch: 0 };
    this._t = 0;
    this._headTilt = 0;

    this.eye = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
  }

  /** Walkable half-width at a given Z (the corridor is narrower than the ends). */
  _halfWidthAt(z) {
    const V = this.interior.volumes;
    for (const v of V) if (z >= v[2] && z <= v[3]) return v[1];
    return 0.6;
  }

  _blocked(x, z) {
    for (const b of this.interior.blockers) {
      if (x > b[0] - RADIUS && x < b[1] + RADIUS && z > b[2] - RADIUS && z < b[3] + RADIUS) return true;
    }
    return false;
  }

  _tryMove(dx, dz) {
    const V = this.interior.volumes;
    const zMin = V[0][2] + RADIUS, zMax = V[V.length - 1][3] - RADIUS;

    const nx = this.pos.x + dx;
    if (Math.abs(nx) <= this._halfWidthAt(this.pos.z) - RADIUS && !this._blocked(nx, this.pos.z)) {
      this.pos.x = nx;
    }
    const nz = THREE.MathUtils.clamp(this.pos.z + dz, zMin, zMax);
    if (Math.abs(this.pos.x) <= this._halfWidthAt(nz) - RADIUS && !this._blocked(this.pos.x, nz)) {
      this.pos.z = nz;
    }
  }

  look(dx, dy, sens = 1) {
    if (this.mode === 'moving') return;
    const g = (this.mode === 'ground' ? LOOK_GROUND : LOOK_DECK) * sens;
    this.yaw -= dx * g;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * g, -PITCH_LIMIT, PITCH_LIMIT);
    if (this.mode === 'seated') {
      // Seated look is limited to the arc the canopy actually covers, so you
      // cannot end up staring through the back of your own chair.
      const s = this.seatedAt;
      const rel = wrapPi(this.yaw - s.baseYaw);
      this.yaw = s.baseYaw + THREE.MathUtils.clamp(rel, -1.15, 1.15);
      this.pitch = THREE.MathUtils.clamp(this.pitch, -0.72, 0.62);
    }
  }

  sit(station) {
    if (this.mode !== 'walk') return;
    this._from.pos.copy(this.pos);
    this._from.yaw = this.yaw;
    this._from.pitch = this.pitch;
    this.seatedAt = {
      station,
      eye: station.seatEye || new THREE.Vector3(0, 1.16, -5.28),
      baseYaw: station.seatYaw !== undefined ? station.seatYaw : 0,
    };
    this.mode = 'moving';
    this._t = 0;
    this._target = 'seated';
  }

  stand() {
    if (this.mode !== 'seated') return;
    this._from.pos.set(this.seatedAt.eye.x, 0, this.seatedAt.eye.z);
    this._from.yaw = this.yaw;
    this._from.pitch = this.pitch;
    this.pos.set(0, 0, -4.35);
    this.mode = 'moving';
    this._t = 0;
    this._target = 'walk';
  }

  /**
   * Eye path between standing and seated.
   *
   * A straight line from where you are standing to the seat eye point runs
   * through the backrest, and the camera flies through it — visible as a frame
   * or two of grey shell filling the screen. The path is bowed instead: out to
   * whichever side you approached from, and lifted, so the eye swings around
   * the seat and settles into it the way a body would.
   */
  _seatPath(from, to, k, out) {
    const side = Math.abs(from.x - to.x) > 0.04 ? Math.sign(from.x - to.x) : 1;
    _ctrl.copy(from).lerp(to, 0.5);
    _ctrl.x += side * 0.30;
    _ctrl.y += 0.17;
    _ctrl.z += 0.16;                       // clear of the backrest
    const u = 1 - k;
    out.set(
      u * u * from.x + 2 * u * k * _ctrl.x + k * k * to.x,
      u * u * from.y + 2 * u * k * _ctrl.y + k * k * to.y,
      u * u * from.z + 2 * u * k * _ctrl.z + k * k * to.z);
  }

  update(dt, input, uiOpen) {
    /* The rate stick is a rate, and a rate with no hand on it is a ship that
       turns by itself. Two modes have no hand on it: standing on a planet,
       where Game feeds the pointer to `look` and never to `feedStick`, and the
       half-second of sitting down, where the seat transition has already taken
       the head off the mouse. The second is the one you can feel — stand up
       mid-turn, cross the cabin, sit back down, and `autoCenter` at 0.85/s has
       still got about a third of that turn left to hand you.

       Emphatically *not* "whenever nobody is seated". In exterior view — V from
       the cabin, which Game supports on foot and counts as `flying` — the
       player is standing and the mouse is still the ship's only stick. Game
       feeds it before this runs and reads it on the next frame, so a blanket
       zero here deleted exterior steering outright. */
    if (input.stick && (this.mode === 'ground'
      || (this.mode === 'moving' && this._target === 'seated'))) {
      input.stick.set(0, 0);
    }

    if (this.mode === 'moving') {
      this._t = Math.min(1, this._t + dt * 1.7);
      const k = easeInOut(this._t);
      const s = this.seatedAt;
      const stand = _tmpA.set(this._from.pos.x, EYE, this._from.pos.z);
      if (this._target === 'seated') {
        this._seatPath(stand, s.eye, k, this.eye);
        this.yaw = lerpAngle(this._from.yaw, s.baseYaw, k);
        this.pitch = THREE.MathUtils.lerp(this._from.pitch, -0.10, k);
      } else {
        this._seatPath(_tmpB.set(this.pos.x, EYE, this.pos.z), s.eye, 1 - k, this.eye);
        this.yaw = lerpAngle(this._from.yaw, s.baseYaw + Math.PI * 0.0, k);
        this.pitch = THREE.MathUtils.lerp(this._from.pitch, 0, k);
      }
      /* Bleed the seated lean out over the transition rather than at the end of
         it. The eye is already flying a scripted path here, so a few degrees of
         head offset coming off is invisible; snapping it off on the frame the
         player lands in `walk` would not be. */
      const k2 = Math.min(1, dt * 5);
      this.headYawOff = THREE.MathUtils.lerp(this.headYawOff || 0, 0, k2);
      this.headPitchOff = THREE.MathUtils.lerp(this.headPitchOff || 0, 0, k2);
      if (this._t >= 1) { this.mode = this._target; if (this._target === 'walk') this.seatedAt = null; }
    } else if (this.mode === 'seated') {
      this.eye.copy(this.seatedAt.eye);
      this.bobAmt *= Math.max(0, 1 - dt * 6);

      // Lean is *added* to wherever you are looking rather than replacing it:
      // overwriting the pilot's aim meant you could never study your own
      // console. Free-look holds the head; releasing it eases back to centre.
      const av = this.autoHead;
      const lean = av ? av : { x: 0, y: 0, z: 0 };
      this.headYawOff = THREE.MathUtils.lerp(this.headYawOff || 0, lean.y * 0.16, Math.min(1, dt * 5));
      this.headPitchOff = THREE.MathUtils.lerp(this.headPitchOff || 0, -lean.x * 0.16, Math.min(1, dt * 5));
      this._headTilt = THREE.MathUtils.lerp(this._headTilt,
        -lean.z * 0.11 - lean.y * 0.06, Math.min(1, dt * 5));

      if (!this.freeLook) {
        const k = Math.min(1, dt * 2.6);
        this.yaw = lerpAngle(this.yaw, this.seatedAt.baseYaw, k);
        this.pitch = THREE.MathUtils.lerp(this.pitch, -0.09, k);
      }
    } else {
      // ---- walking, on a deck or on a planet

      /* The lean is a seated affordance — it is the pilot's head answering the
         ship's angular velocity — and out of the seat there is no ship under
         you to answer. It was never cleared, so whatever it happened to be on
         the frame you stood up was welded on for the rest of the walk: up to
         about nine degrees between `yaw`, which is what the legs use, and
         `quat`, which is what the camera and the rifle use. You walked at an
         angle to where you were looking and shot at an angle to the crosshair. */
      this.headYawOff = 0;
      this.headPitchOff = 0;

      const onFoot = this.mode === 'ground';
      const run = input.held('sprint');
      const walkSpeed = onFoot ? GROUND_WALK : DECK_WALK;
      const runSpeed = onFoot ? GROUND_RUN : DECK_RUN;
      const speed = (run ? runSpeed : walkSpeed) * (uiOpen ? 0 : 1);
      const fwd = (input.held('walkF') ? 1 : 0) - (input.held('walkB') ? 1 : 0)
        + (input.touch ? -input.touchL.y : 0);
      const strafe = (input.held('walkR') ? 1 : 0) - (input.held('walkL') ? 1 : 0)
        + (input.touch ? input.touchL.x : 0);

      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      let vx = (-sy * fwd + cy * strafe);
      let vz = (-cy * fwd - sy * strafe);
      const l = Math.hypot(vx, vz);
      if (l > 1) { vx /= l; vz /= l; }

      // Reused: this is the walk loop, and on a phone a fresh Vector3 a frame is
      // a hundred and eighty of them a second for the garbage collector to find.
      this.vel.lerp(_tmpV.set(vx * speed, 0, vz * speed), Math.min(1, dt * 12));
      if (onFoot) {
        // No corridor to be constrained by. Terrain collision is the ground
        // height under the feet, resolved below.
        this.pos.x += this.vel.x * dt;
        this.pos.z += this.vel.z * dt;
      } else {
        this._tryMove(this.vel.x * dt, this.vel.z * dt);
      }

      const moving = this.vel.length();
      // Stride cadence, not ground speed. Driving the phase off metres per
      // second directly meant the outdoor pace — more than twice the deck's —
      // shook the camera at eight hertz. Normalising by the local walk speed
      // leaves the deck exactly as it was and gives the planet the same gait.
      this.bob += (moving / walkSpeed) * DECK_WALK * dt * (run ? 5.4 : 6.6);
      // Bob amount is a fraction of *this* controller's walking pace. Measured
      // against the deck's while outdoors it saturates the instant you move and
      // the head bobs the same however slowly you are creeping.
      this.bobAmt += (Math.min(moving / walkSpeed, 1.2) - this.bobAmt) * Math.min(1, dt * 8);
      this._headTilt += ((-strafe * 0.02) - this._headTilt) * Math.min(1, dt * 6);

      /* Follow the ground, but not instantly. Sampling the height field and
         writing it straight to the eye means every ripple the terrain has at
         stride scale is transmitted directly into the camera, which reads as a
         hand-held shot on a trampoline. Legs absorb the high frequencies; a
         critically-damped follow is the cheap stand-in for that.

         The rate scales with pace for the same reason the bob does. What is
         being rejected is a *distance* — a ripple a metre or two across — but a
         fixed rate only rejects a fixed distance at a fixed speed. Measured on
         a 1-in-5 slope at 60 Hz, the deck's own run trails the true ground by
         0.29 m of travel, which is the design point 9 was chosen at; a planet
         sprint at the flat 9 trailed 0.72, which is the trampoline back the
         other way — the eye sagging behind ground the feet have already left.
         Normalised, the sprint trails 0.21. The deck is untouched by
         construction: walkSpeed is DECK_WALK there, so the factor is 1. */
      if (onFoot) {
        const h = this.groundHeight ? this.groundHeight(this.pos.x, this.pos.z) : 0;
        const follow = 9 * (walkSpeed / DECK_WALK);
        this.groundY += (h - this.groundY) * Math.min(1, dt * follow);
      } else {
        this.groundY = 0;
      }
      this.pos.y = this.groundY;

      this.eye.set(
        this.pos.x,
        this.groundY + EYE + Math.sin(this.bob * 2) * 0.021 * this.bobAmt,
        this.pos.z
      );
      this.eye.x += Math.cos(this.bob) * 0.014 * this.bobAmt;
    }

    this._e.set(this.pitch + (this.headPitchOff || 0),
      this.yaw + (this.headYawOff || 0), this._headTilt);
    this.quat.setFromEuler(this._e);

    // ---- station in reach
    this.station = null;
    if (this.mode === 'walk') {
      let best = null, bd = 1e9;
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      for (const s of this.interior.stations) {
        const dx = s.pos.x - this.pos.x, dz = s.pos.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > s.radius + 0.55) continue;
        const facing = d < 0.25 ? 1 : (dx * fx + dz * fz) / d;
        if (facing < 0.25) continue;
        if (d < bd) { bd = d; best = s; }
      }
      this.station = best;
    }
    return this;
  }
}

function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
function wrapPi(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
function lerpAngle(a, b, t) { return a + wrapPi(b - a) * t; }
