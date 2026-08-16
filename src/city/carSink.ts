/**
 * What happens when you drive a car into the sea.
 *
 * Before this, nothing did. The collision world floors everything at y=0 so
 * nobody can fall out of the world, and over open water that floor is a
 * phantom plate — so a kart driven off the quay simply carried on driving, at
 * sea level, across the bay, wheels spinning on nothing. It is the single most
 * "assembled" thing left in the city: an ocean that is scenery for boats and
 * pavement for cars.
 *
 * A car meeting water at thirty metres a second is mostly one event and then a
 * long quiet one, and they want different effects:
 *
 *  - **The hit.** Water does not splash so much as detonate. A crown of spray
 *    thrown out and up, a column punched straight down into the surface, and a
 *    ring running away across it. All three scale hard with the speed you
 *    arrived at, because the difference between rolling in off the slipway and
 *    launching off the sea wall is the whole joke.
 *  - **The sink.** Then it goes quiet, the car noses over, and the only thing
 *    still happening is air leaving it. Bubbles, wobbling as they rise, for as
 *    long as it takes to reach the bottom.
 *
 * Both are drawn as camera-facing instanced quads with soft textures rather
 * than as `THREE.Points`. Points are one draw call and are tempting, and they
 * are hard squares of uniform size: spray is the one effect where the particles
 * genuinely need to be different sizes — a crown is big blobs near the impact
 * and fine mist at the edges — and a square-edged blob reads as a sprite, which
 * is exactly the thing this is trying to stop looking like.
 */
import * as THREE from "three";

/** Soft round blob, brightest in the middle. Foam and spray. */
function discTexture(): THREE.Texture {
  const S = 64;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x / (S - 1)) * 2 - 1;
      const v = (y / (S - 1)) * 2 - 1;
      const r = Math.hypot(u, v);
      const a = Math.pow(Math.max(0, 1 - r), 1.7);
      const o = (y * S + x) * 4;
      img.data[o] = 255;
      img.data[o + 1] = 255;
      img.data[o + 2] = 255;
      img.data[o + 3] = Math.round(255 * a);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Bright rim, hollow middle. A bubble is a shell of light, not a dot. */
function bubbleTexture(): THREE.Texture {
  const S = 64;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x / (S - 1)) * 2 - 1;
      const v = (y / (S - 1)) * 2 - 1;
      const r = Math.hypot(u, v);
      // A shell at r≈0.8 plus a highlight up and to the left, which is what
      // stops a hundred of them reading as a hundred identical rings.
      const shell = Math.pow(Math.max(0, 1 - Math.abs(r - 0.78) / 0.22), 2.0);
      const hi = Math.pow(Math.max(0, 1 - Math.hypot(u + 0.34, v + 0.34) / 0.34), 2.4);
      const a = Math.min(1, shell * 0.75 + hi * 0.9) * (r < 1 ? 1 : 0);
      const o = (y * S + x) * 4;
      img.data[o] = 235;
      img.data[o + 1] = 252;
      img.data[o + 2] = 255;
      img.data[o + 3] = Math.round(255 * a);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Seconds left, and the value it started at, so fade is a ratio. */
  t: number; life: number;
  size: number; grow: number;
  /** Bubbles wobble as they rise; spray does not. */
  wob: number;
}

function emptyParticle(): Particle {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0, life: 1, size: 1, grow: 0, wob: 0 };
}

export interface CarSink {
  group: THREE.Group;
  /**
   * A car has just hit the water at `speed` m/s. `y` is the surface, not the
   * car — the effect belongs to the sea.
   */
  impact(x: number, y: number, z: number, speed: number): void;
  /**
   * A car ploughing through water too shallow to drown it.
   *
   * Between the waterline and the depth that sinks you there used to be
   * nothing at all: you drove into the sea, the sea ignored you for twenty
   * metres, and then a wall of water arrived out of nowhere. `yaw` is the
   * heading, so the spray can come off the front of the car and be thrown
   * outward the way a bow wave actually goes.
   */
  wake(
    dt: number, x: number, y: number, z: number,
    yaw: number, speed: number, depth: number,
  ): void;
  /**
   * The car does not survive the landing. Fire, then smoke, then nothing —
   * gated on arriving hard, so rolling gently in off the sand does not
   * detonate.
   */
  fireball(x: number, y: number, z: number, speed: number): void;
  /** Air leaving a sinking car. Called every frame while it goes down. */
  bubble(dt: number, x: number, y: number, z: number, rate: number): void;
  /** `camera` is needed to face the quads; there is no billboard material. */
  update(dt: number, camera: THREE.Camera): void;
  dispose(): void;
}

const SPRAY = 260;
const BUBBLES = 200;
const RINGS = 5;
const FIRE = 150;
const SMOKE = 90;
/** Below this the car just gets wet. Above it, it does not survive. */
const FIREBALL_SPEED = 11;

export function createCarSink(): CarSink {
  const group = new THREE.Group();
  group.frustumCulled = false;
  const trash: Array<{ dispose(): void }> = [];

  const quad = new THREE.PlaneGeometry(1, 1);
  trash.push(quad);

  const sprayTex = discTexture();
  const sprayMat = new THREE.MeshBasicMaterial({
    map: sprayTex,
    color: "#ffffff",
    transparent: true,
    depthWrite: false,
    // Foam is white and opaque, not glowing. Additive blending was the first
    // instinct and it turned the whole plume into a blown-out white smear
    // against a bright sky — the shape went with it, and the shape is the
    // effect.
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    fog: true,
  });
  const spray = new THREE.InstancedMesh(quad, sprayMat, SPRAY);
  spray.frustumCulled = false;
  spray.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  spray.count = SPRAY;
  spray.renderOrder = 4;
  group.add(spray);
  trash.push(sprayTex, sprayMat);

  const bubbleTex = bubbleTexture();
  const bubbleMat = new THREE.MeshBasicMaterial({
    map: bubbleTex,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  const bubbles = new THREE.InstancedMesh(quad, bubbleMat, BUBBLES);
  bubbles.frustumCulled = false;
  bubbles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bubbles.renderOrder = 4;
  group.add(bubbles);
  trash.push(bubbleTex, bubbleMat);

  // ---- Fire and smoke ----------------------------------------------------
  /**
   * Two pools, because fire and smoke are not the same material.
   *
   * Fire is additive — it is light, it blows out to white where it is thick,
   * and it must not be occluded by the water it is sitting on. Smoke is the
   * opposite: it is opaque, it DARKENS what is behind it, and drawn additively
   * it would brighten the sky instead of blocking it, which reads as steam.
   * The colours are per-instance so a single pool can cool from white through
   * yellow to a dull red over its life.
   */
  const fireMat = new THREE.MeshBasicMaterial({
    map: sprayTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    // Fire is its own light source, so distance haze should not tint it.
    fog: false,
  });
  const fire = new THREE.InstancedMesh(quad, fireMat, FIRE);
  fire.frustumCulled = false;
  fire.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  fire.renderOrder = 6;
  group.add(fire);
  trash.push(fireMat);

  const smokeMat = new THREE.MeshBasicMaterial({
    map: sprayTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    fog: true,
  });
  const smoke = new THREE.InstancedMesh(quad, smokeMat, SMOKE);
  smoke.frustumCulled = false;
  smoke.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  smoke.renderOrder = 5;
  group.add(smoke);
  trash.push(smokeMat);

  /**
   * The flash.
   *
   * An explosion that does not light anything around it is a decal. This one
   * light is what puts the fireball onto the water under it and the car in
   * front of it, and it costs one extra light for the half second it is above
   * zero — parked at intensity 0 the rest of the time, not removed and
   * re-added, because adding a light forces every material in the scene to
   * recompile and that is a hitch you would see.
   */
  const flash = new THREE.PointLight(0xffa040, 0, 26, 2);
  group.add(flash);

  const sprayP: Particle[] = Array.from({ length: SPRAY }, emptyParticle);
  const bubbleP: Particle[] = Array.from({ length: BUBBLES }, emptyParticle);
  const fireP: Particle[] = Array.from({ length: FIRE }, emptyParticle);
  const smokeP: Particle[] = Array.from({ length: SMOKE }, emptyParticle);
  let sprayNext = 0;
  let bubbleNext = 0;
  let fireNext = 0;
  let smokeNext = 0;
  /** Seconds left on the flash, and how bright it started. */
  let flashT = 0;
  let flashPeak = 0;
  /** Metres of water the car has ploughed since the last wake puff. */
  let wakeCarry = 0;

  // Surface rings, flat on the water, running outward from the hit.
  const ringGeo = new THREE.RingGeometry(0.72, 1.0, 48);
  ringGeo.rotateX(-Math.PI / 2);
  const rings: Array<{ mesh: THREE.Mesh; t: number; life: number; to: number }> = [];
  for (let i = 0; i < RINGS; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: "#dff2ff",
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.visible = false;
    // The sea does not write depth, so anything meant to sit ON it has to be
    // told to sort after it or it draws underneath the water it is foam on.
    mesh.renderOrder = 3;
    group.add(mesh);
    rings.push({ mesh, t: 0, life: 0, to: 1 });
  }
  let ringNext = 0;
  trash.push(ringGeo, ...rings.map((r) => r.mesh.material as THREE.Material));

  const M = new THREE.Matrix4();
  const P = new THREE.Vector3();
  const S = new THREE.Vector3();
  const FACE = new THREE.Quaternion();
  const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
  const FIRE_COL = new THREE.Color();
  const SMOKE_COL = new THREE.Color();

  return {
    group,

    impact(x, y, z, speed) {
      // 8 m/s is a gentle roll off the slipway; 32 is flat out. Squared-ish so
      // arriving fast is visibly, disproportionately more spectacular.
      const s = THREE.MathUtils.clamp((speed - 4) / 26, 0, 1);
      const power = 0.25 + s * s * 1.6;

      // ---- The crown: thrown out and up, big near the middle ------------
      const crown = Math.round(40 + power * 90);
      for (let i = 0; i < crown; i++) {
        const p = sprayP[sprayNext++ % SPRAY];
        const a = Math.random() * Math.PI * 2;
        const r = Math.random();
        p.x = x + Math.cos(a) * r * 1.9;
        p.y = y + 0.1;
        p.z = z + Math.sin(a) * r * 1.9;
        const out = (2.5 + Math.random() * 6) * (0.4 + power);
        p.vx = Math.cos(a) * out;
        p.vz = Math.sin(a) * out;
        // Steeper in the middle, flatter at the rim: that is the crown shape.
        p.vy = (4 + Math.random() * 7) * (0.5 + power) * (1.25 - r * 0.6);
        p.life = p.t = 0.8 + Math.random() * 0.9;
        /**
         * Small, and growing as they fly.
         *
         * The first cut made these about 1.4 m across at birth and threw a
         * hundred and sixty of them into a two-metre sphere, which is not a
         * crown, it is one white blob with a car under it. A crown is legible
         * because you can see the gaps between the lumps of water — so they
         * start small enough to be individually visible and swell as they
         * break up, which is also what water does.
         */
        p.size = (0.42 - r * 0.2) * (0.7 + power * 0.5) * (0.6 + Math.random() * 0.9);
        p.grow = 1.4;
        p.wob = 0;
      }

      /**
       * The blast: a low sheet of foam thrown flat across the surface.
       *
       * The crown goes up and the column goes higher, and between them they
       * still read as "a splash" rather than as an impact — because the thing
       * the eye actually uses to judge how hard something hit is how fast the
       * disturbance travels OUTWARD. So: fast, flat, short-lived, hugging the
       * water, growing as it goes. This is the part that makes arriving at
       * thirty look like arriving at thirty.
       */
      const blast = Math.round(14 + power * 34);
      for (let i = 0; i < blast; i++) {
        const p = sprayP[sprayNext++ % SPRAY];
        const a = Math.random() * Math.PI * 2;
        p.x = x + Math.cos(a) * 0.8;
        p.y = y + 0.12 + Math.random() * 0.25;
        p.z = z + Math.sin(a) * 0.8;
        const out = (9 + Math.random() * 11) * (0.35 + power * 0.9);
        p.vx = Math.cos(a) * out;
        p.vz = Math.sin(a) * out;
        p.vy = 0.6 + Math.random() * 1.6;
        p.life = p.t = 0.5 + Math.random() * 0.5;
        p.size = 0.3 + Math.random() * 0.35;
        p.grow = 2.6;
        p.wob = 0;
      }

      // ---- The column: straight up, out of the hole the car made --------
      const col = Math.round(14 + power * 34);
      for (let i = 0; i < col; i++) {
        const p = sprayP[sprayNext++ % SPRAY];
        const a = Math.random() * Math.PI * 2;
        p.x = x + Math.cos(a) * Math.random() * 0.6;
        p.y = y + 0.2 + Math.random() * 0.5;
        p.z = z + Math.sin(a) * Math.random() * 0.6;
        p.vx = Math.cos(a) * 0.8;
        p.vz = Math.sin(a) * 0.8;
        p.vy = (7 + Math.random() * 9) * (0.55 + power * 0.8);
        p.life = p.t = 1.0 + Math.random() * 0.8;
        p.size = (0.5 + Math.random() * 0.5) * (0.6 + power * 0.5);
        p.grow = 2.2;
        p.wob = 0;
      }

      /**
       * The rings, and why they are not bigger.
       *
       * The annulus is scaled uniformly, so its 0.28-unit band grows with its
       * radius — push the radius to fourteen metres and the band is four
       * metres wide, which additively blended over dark water is not a ring of
       * foam, it is a pale grey plate lying across the bay. Measured, that is
       * exactly what it looked like. Kept to about eight metres, where the
       * band still reads as an edge, and faded hard.
       */
      for (let i = 0; i < 2; i++) {
        const ring = rings[ringNext++ % RINGS];
        ring.mesh.position.set(x, y + 0.07, z);
        ring.mesh.scale.setScalar(0.8 + i * 0.5);
        ring.mesh.visible = true;
        ring.t = 0;
        ring.life = 1.1 + power * 0.9;
        // The two kept close in size, so they read as one thick foam edge
        // rather than as two concentric circles.
        ring.to = (2.2 + power * 2.6) * (1 + i * 0.14);
        (ring.mesh.material as THREE.MeshBasicMaterial).opacity = 0.18 + power * 0.08;
      }
    },

    wake(dt, x, y, z, yaw, speed, depth) {
      if (speed < 1.2 || depth < 0.08) return;
      // How much water is actually being shifted: fast through deep-ish water
      // throws a lot, a crawl through an inch throws nothing.
      const bite = Math.min(1, depth / 1.2) * Math.min(1, speed / 18);
      /**
       * Emitted per METRE travelled, not per second.
       *
       * Per-second emission ties the wake's density to how fast the machine is
       * rendering rather than to how fast the car is going — so the same drive
       * through the same shallows lays down a thick trail on a fast device and
       * a dotted line on a slow one. Per-metre, the trail is a property of the
       * drive.
       */
      wakeCarry += speed * dt;
      const step = 0.55;
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      while (wakeCarry >= step) {
        wakeCarry -= step;
        // Two sheets, thrown out to either side off the front wheels — which
        // is where a car actually picks the water up.
        for (const side of [-1, 1]) {
          const p = sprayP[sprayNext++ % SPRAY];
          p.x = x + fx * 0.9 - fz * side * 0.55;
          p.y = y + 0.08;
          p.z = z + fz * 0.9 + fx * side * 0.55;
          const out = (1.6 + Math.random() * 2.6) * (0.4 + bite);
          p.vx = -fz * side * out + fx * speed * 0.18;
          p.vz = fx * side * out + fz * speed * 0.18;
          p.vy = (1.8 + Math.random() * 3.4) * (0.35 + bite);
          p.life = p.t = 0.4 + Math.random() * 0.45;
          p.size = (0.14 + Math.random() * 0.2) * (0.5 + bite);
          p.grow = 2.0;
          p.wob = 0;
        }
      }
    },

    fireball(x, y, z, speed) {
      if (speed < FIREBALL_SPEED) return;
      const s = THREE.MathUtils.clamp((speed - FIREBALL_SPEED) / 20, 0, 1);
      const power = 0.5 + s;

      /**
       * Fire: a ball that rises and cools.
       *
       * Every number here is smaller than the obvious one, because additive
       * blending SUMS. The first cut threw a hundred quads up to 2.4 m across
       * into a three-metre sphere four metres from the camera, each one at
       * full brightness — and additively that is not a fireball, it is a white
       * rectangle where the screen used to be. You could not see the car, the
       * sea or the explosion.
       *
       * So each blob is dim and small, and the hot core is what you get where
       * a lot of them overlap. That is also how fire actually looks: bright in
       * the middle because there is more of it there, not because the edges
       * are dark.
       */
      const balls = Math.round(24 + power * 30);
      for (let i = 0; i < balls; i++) {
        const p = fireP[fireNext++ % FIRE];
        // Spherical, biased upward — an explosion off a surface goes up
        // because the ground is in the way of everything else.
        const a = Math.random() * Math.PI * 2;
        const up = Math.random();
        const r = Math.random() * 0.85 * power;
        p.x = x + Math.cos(a) * r;
        p.y = y + 0.4 + up * 1.2 * power;
        p.z = z + Math.sin(a) * r;
        const out = (1.2 + Math.random() * 3.2) * power;
        p.vx = Math.cos(a) * out;
        p.vz = Math.sin(a) * out;
        p.vy = (2.2 + Math.random() * 5.5) * power;
        p.life = p.t = 0.35 + Math.random() * 0.55;
        p.size = (0.3 + Math.random() * 0.5) * power;
        p.grow = 1.1;
        // Reused as the cooling offset, so no two blobs are the same colour
        // at the same instant.
        p.wob = Math.random() * 0.35;
      }

      // ---- Smoke: slower, bigger, sticks around ---------------------------
      const puffs = Math.round(14 + power * 24);
      for (let i = 0; i < puffs; i++) {
        const p = smokeP[smokeNext++ % SMOKE];
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 1.6 * power;
        p.x = x + Math.cos(a) * r;
        p.y = y + 0.6 + Math.random() * 1.8;
        p.z = z + Math.sin(a) * r;
        p.vx = Math.cos(a) * (0.5 + Math.random() * 1.6);
        p.vz = Math.sin(a) * (0.5 + Math.random() * 1.6);
        p.vy = 1.4 + Math.random() * 2.8;
        p.life = p.t = 1.6 + Math.random() * 1.8;
        p.size = (0.9 + Math.random() * 1.3) * power;
        p.grow = 2.4;
        p.wob = Math.random() * Math.PI * 2;
      }

      // Enough to throw orange onto the water and the car, and no more. The
      // first pass ran this to 220 over a 60 m radius, which lit the whole bay
      // as if somebody had switched the sun on underneath it.
      flashPeak = 18 + power * 26;
      flashT = 0.42;
      flash.position.set(x, y + 1.4, z);
    },

    bubble(dt, x, y, z, rate) {
      // Poisson-ish: a fractional expected count per frame turned into whole
      // bubbles, so the stream does not quantise to the frame rate.
      let n = rate * dt;
      while (n > 0) {
        if (n < 1 && Math.random() > n) break;
        n -= 1;
        const p = bubbleP[bubbleNext++ % BUBBLES];
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 1.1;
        p.x = x + Math.cos(a) * r;
        p.y = y + (Math.random() - 0.3) * 0.7;
        p.z = z + Math.sin(a) * r;
        p.vx = 0;
        p.vz = 0;
        // Big bubbles rise faster, which is true and is also what sells the
        // spread as a column of air rather than a sheet of decals.
        p.size = 0.09 + Math.random() * 0.26;
        p.vy = 1.1 + p.size * 3.4 + Math.random() * 0.5;
        p.life = p.t = 2.4 + Math.random() * 2.2;
        p.grow = 0.05;
        p.wob = Math.random() * Math.PI * 2;
      }
    },

    update(dt, camera) {
      camera.getWorldQuaternion(FACE);

      // ---- Spray ---------------------------------------------------------
      for (let i = 0; i < SPRAY; i++) {
        const p = sprayP[i];
        if (p.t <= 0) {
          spray.setMatrixAt(i, HIDDEN);
          continue;
        }
        p.t -= dt;
        p.vy -= 19 * dt;
        // Air drag, so the mist stops dead and the heavy blobs carry — the
        // one line that makes a crown look like water rather than confetti.
        const drag = Math.pow(0.22, dt);
        p.vx *= drag;
        p.vz *= drag;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        const k = Math.max(0, p.t / p.life);
        P.set(p.x, p.y, p.z);
        S.setScalar(Math.max(0.001, p.size * (1 + p.grow * (1 - k))));
        spray.setMatrixAt(i, M.compose(P, FACE, S));
      }
      spray.instanceMatrix.needsUpdate = true;
      // One opacity for the whole batch, so the fade is per-batch rather than
      // per-particle — the per-particle shrink above carries the individual
      // fade and this only has to stop the last frame popping.
      sprayMat.opacity = 0.92;

      // ---- Bubbles -------------------------------------------------------
      for (let i = 0; i < BUBBLES; i++) {
        const p = bubbleP[i];
        if (p.t <= 0) {
          bubbles.setMatrixAt(i, HIDDEN);
          continue;
        }
        p.t -= dt;
        p.wob += dt * 3.4;
        p.y += p.vy * dt;
        p.x += Math.sin(p.wob) * 0.22 * dt * 4;
        p.z += Math.cos(p.wob * 0.83) * 0.22 * dt * 4;
        // Gone at the surface: a bubble that swims out into the air and keeps
        // going is the tell that nothing here knows where the water is.
        // Hidden on the same frame, not the next one — deferring it leaves one
        // frame of bubble hanging in the sky, which at sixty frames a second
        // nobody sees and in a screenshot harness is the only thing you see.
        if (p.y > 0) {
          p.t = 0;
          bubbles.setMatrixAt(i, HIDDEN);
          continue;
        }
        const k = Math.max(0, p.t / p.life);
        P.set(p.x, p.y, p.z);
        S.setScalar(Math.max(0.001, p.size * (1 + p.grow * (1 - k))));
        bubbles.setMatrixAt(i, M.compose(P, FACE, S));
      }
      bubbles.instanceMatrix.needsUpdate = true;
      bubbleMat.opacity = 0.85;

      // ---- Fire ----------------------------------------------------------
      for (let i = 0; i < FIRE; i++) {
        const p = fireP[i];
        if (p.t <= 0) {
          fire.setMatrixAt(i, HIDDEN);
          continue;
        }
        p.t -= dt;
        // Rises rather than falls: it is hot gas, not debris. The outward
        // punch dies fast; the buoyancy does not.
        p.vy += 5.5 * dt;
        const drag = Math.pow(0.06, dt);
        p.vx *= drag;
        p.vz *= drag;
        p.vy *= Math.pow(0.5, dt);
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        const k = Math.max(0, p.t / p.life);
        // Cools white → yellow → orange → dull red as it goes, which is the
        // whole reason this is per-instance colour rather than one hot orange
        // material: a fireball that stays the same colour for its entire life
        // reads as a light being switched off, not as something burning out.
        const heat = Math.max(0, k - p.wob);
        // Deliberately well under 1. These sum where they overlap, and the
        // overlap is where the fireball gets its bright core — start them at
        // full brightness and the core is not a core, it is the whole screen.
        FIRE_COL.setRGB(
          Math.min(1, 0.22 + heat * 0.62),
          Math.min(1, 0.05 + heat * heat * 0.52),
          Math.min(1, heat * heat * heat * 0.34),
        );
        fire.setColorAt(i, FIRE_COL);
        P.set(p.x, p.y, p.z);
        S.setScalar(Math.max(0.001, p.size * (1 + p.grow * (1 - k)) * Math.min(1, k * 3.5)));
        fire.setMatrixAt(i, M.compose(P, FACE, S));
      }
      fire.instanceMatrix.needsUpdate = true;
      if (fire.instanceColor) fire.instanceColor.needsUpdate = true;
      // A second brake on the same runaway: with additive blending, opacity is
      // a straight multiplier on how much each blob contributes to the sum.
      fireMat.opacity = 0.6;

      // ---- Smoke ---------------------------------------------------------
      for (let i = 0; i < SMOKE; i++) {
        const p = smokeP[i];
        if (p.t <= 0) {
          smoke.setMatrixAt(i, HIDDEN);
          continue;
        }
        p.t -= dt;
        p.wob += dt * 0.7;
        p.vy *= Math.pow(0.55, dt);
        p.vy += 0.9 * dt;
        const drag = Math.pow(0.25, dt);
        p.vx *= drag;
        p.vz *= drag;
        p.x += (p.vx + Math.sin(p.wob) * 0.35) * dt;
        p.y += p.vy * dt;
        p.z += (p.vz + Math.cos(p.wob * 0.8) * 0.35) * dt;
        const k = Math.max(0, p.t / p.life);
        // Darkest while it is fresh and thick, thinning to nothing.
        const grey = 0.1 + (1 - k) * 0.34;
        SMOKE_COL.setRGB(grey, grey * 0.97, grey * 0.95);
        smoke.setColorAt(i, SMOKE_COL);
        P.set(p.x, p.y, p.z);
        S.setScalar(Math.max(0.001, p.size * (1 + p.grow * (1 - k))));
        smoke.setMatrixAt(i, M.compose(P, FACE, S));
      }
      smoke.instanceMatrix.needsUpdate = true;
      if (smoke.instanceColor) smoke.instanceColor.needsUpdate = true;
      // One opacity for the batch. Smoke has to thin out or it leaves a bank
      // of grey discs hanging over the bay.
      smokeMat.opacity = 0.5;

      // ---- Flash -----------------------------------------------------------
      if (flashT > 0) {
        flashT = Math.max(0, flashT - dt);
        // Squared falloff: the eye reads an explosion's light as a spike, and
        // a linear fade looks like somebody turning a dimmer down.
        const k = flashT / 0.42;
        flash.intensity = flashPeak * k * k;
      } else if (flash.intensity !== 0) {
        flash.intensity = 0;
      }

      // ---- Rings ---------------------------------------------------------
      for (const ring of rings) {
        if (!ring.mesh.visible) continue;
        ring.t += dt;
        const k = ring.t / ring.life;
        if (k >= 1) {
          ring.mesh.visible = false;
          continue;
        }
        // Fast at first and easing out, the way a real ring loses energy.
        const e = 1 - Math.pow(1 - k, 2.2);
        ring.mesh.scale.setScalar(0.8 + ring.to * e);
        const mat = ring.mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = (1 - k) * (1 - k) * 0.34;
      }
    },

    dispose() {
      trash.forEach((t) => t.dispose());
    },
  };
}
