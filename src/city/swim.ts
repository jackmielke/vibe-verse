/**
 * Swimming: the stroke, and the splash it makes going in.
 *
 * Not a clip. Nothing in the city's cast ships a swim animation — the
 * characters are a mixed bag of downloaded GLBs with an idle, a walk, a run
 * and if you are lucky a jump — so a clip-based swim would work on none of
 * them and would have to be re-sourced for every character anybody ever adds.
 * The dances have exactly the same problem and solve it by *solving* the pose
 * instead of playing one back, so swimming is written against the same
 * `DancePose` vocabulary in `dances.ts`.
 *
 * Three things fall out of that for free, and they are the reason it is worth
 * doing this way:
 *
 *  - It works on every character in the catalogue, including ones added later.
 *  - It works on Flux, the procedural pilot, which has no clips at all — it
 *    takes a pose through the same `dance` channel the dances use.
 *  - It is a pure function of (speed, time), so it can be evaluated on a peer's
 *    machine from the tiny bit of state that already crosses the wire.
 *
 * The stroke is two poses blended by how fast you are going. Still, you tread:
 * upright, sculling with your hands, eggbeater kick. Moving, you go prone and
 * swim front crawl. In between, the blend does the work — which is roughly
 * what a person does when they set off, and it means there is no transition to
 * animate.
 */
import * as THREE from "three";
import {
  createDancePose,
  resetDancePose,
  setArm,
  setLeg,
  type DancePose,
  type LimbPose,
  type Vec3,
} from "@/components/city/dances";

const PI = Math.PI;
const TAU = Math.PI * 2;

/**
 * How far a prone swimmer's body is pitched away from standing.
 *
 * The rig's root pivots at the feet, so this lays the body out along the
 * surface with the head at the far end — which is why the swimming player
 * floats with their origin only just under the water rather than a metre and a
 * half down like someone treading.
 */
export const PRONE_PITCH = 1.42;

export interface SwimInput {
  /** Horizontal speed, m/s. Drives both the blend and the stroke rate. */
  speed: number;
  /** Seconds. Any clock will do; only differences matter. */
  t: number;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerpVec = (out: Vec3, a: Vec3, b: Vec3, k: number) => {
  out.x = lerp(a.x, b.x, k);
  out.y = lerp(a.y, b.y, k);
  out.z = lerp(a.z, b.z, k);
};
const lerpLimb = (out: LimbPose, a: LimbPose, b: LimbPose, k: number) => {
  lerpVec(out.upper, a.upper, b.upper, k);
  lerpVec(out.lower, a.lower, b.lower, k);
  lerpVec(out.tip, a.tip, b.tip, k);
};

/** Treading water: upright, hands sculling, eggbeater kick. */
function tread(p: DancePose, t: number) {
  const c = t * 1.5; // slow — treading is meant to look sustainable
  const s = Math.sin(c * TAU);
  const s2 = Math.sin(c * TAU + PI);
  p.rootY = 0.04 * Math.sin(c * TAU * 0.5) - 0.02;
  p.rootRoll = 0.05 * s;
  p.torso.x = 0.12;
  p.head.x = -0.18; // chin up, out of the water
  p.head.y = 0.22 * Math.sin(c * TAU * 0.37);
  // Hands out at shoulder height, sweeping in and out. The elbows stay bent:
  // a scull with straight arms reads as a shrug.
  setArm(p.armL, 1, -0.15 + 0.18 * s, 1.32 + 0.18 * s, 0.85, 0.1);
  setArm(p.armR, -1, -0.15 + 0.18 * s2, 1.32 + 0.18 * s2, 0.85, 0.1);
  // Eggbeater: the legs cycle out of phase with knees well bent.
  setLeg(p.legL, 1, 0.55 + 0.5 * s, 0.34, 1.15 + 0.35 * s2, 0.6);
  setLeg(p.legR, -1, 0.55 + 0.5 * s2, 0.34, 1.15 + 0.35 * s, 0.6);
}

/**
 * Front crawl. The root is pitched prone by the caller, so "swing the arm
 * forward" here comes out as "lift it up out of the water and reach".
 */
function crawl(p: DancePose, t: number, rate: number) {
  const c = t * rate;
  const ph = c * TAU;
  // One arm pulls while the other recovers, half a cycle apart. The swing
  // sweeps a full circle rather than swinging back and forth — a crawl that
  // reverses at the top is a doggy paddle.
  const armSwing = (o: number) => 0.55 + 2.05 * Math.cos(ph + o);
  // Elbow folds through the recovery (the half where the arm is out of the
  // water) and straightens for the catch.
  const armBend = (o: number) => 0.35 + 0.7 * Math.max(0, Math.sin(ph + o));
  setArm(p.armL, 1, armSwing(0), 0.2, armBend(0), 0.1);
  setArm(p.armR, -1, armSwing(PI), 0.2, armBend(PI), 0.1);
  // Body roll follows the pulling arm, which is most of what makes a crawl
  // read as a crawl from behind.
  p.rootRoll = 0.3 * Math.sin(ph);
  p.rootY = 0.03 * Math.sin(ph * 2);
  p.hips.z = 0.08 * Math.sin(ph);
  p.torso.z = 0.1 * Math.sin(ph);
  // Breathe to one side, once a cycle, on the roll that favours it.
  const breath = Math.max(0, Math.sin(ph - 0.6));
  p.head.x = -0.35 + 0.1 * breath;
  p.head.y = 0.75 * breath * breath;
  // Flutter kick: small, fast, knees barely bent. Three beats to the stroke.
  const kick = Math.sin(ph * 3);
  setLeg(p.legL, 1, 0.34 * kick, 0.06, 0.28 + 0.22 * Math.max(0, kick), 0.5);
  setLeg(p.legR, -1, -0.34 * kick, 0.06, 0.28 + 0.22 * Math.max(0, -kick), 0.5);
}

const _tread = createDancePose();
const _crawl = createDancePose();

/**
 * The swim pose, and how prone the body should be while holding it.
 *
 * `prone` comes back rather than being baked into `rootPitch` because the
 * caller needs it for the physics too: a prone swimmer floats with their
 * origin just under the surface, someone treading floats a metre and a half
 * down, and the same number has to drive both or the body and the waterline
 * disagree.
 */
export function evalSwim(out: DancePose, input: SwimInput): { pose: DancePose; prone: number } {
  const speed = Math.max(0, input.speed);
  // Fully prone well below top swim speed: drag means a steady swim settles
  // under the target, and a stroke that only goes properly flat at maximum
  // speed spends its whole life half-upright.
  const prone = THREE.MathUtils.smoothstep(speed, 0.4, 2.4);
  // Stroke rate rises with speed but never stops: a stationary swimmer still
  // sculls, and a frozen pose in water looks like a corpse.
  const rate = 0.42 + speed * 0.085;

  resetDancePose(_tread);
  resetDancePose(_crawl);
  tread(_tread, input.t);
  crawl(_crawl, input.t, rate);

  resetDancePose(out);
  out.rootY = lerp(_tread.rootY, _crawl.rootY, prone);
  out.rootYaw = lerp(_tread.rootYaw, _crawl.rootYaw, prone);
  out.rootRoll = lerp(_tread.rootRoll, _crawl.rootRoll, prone);
  out.rootPitch = PRONE_PITCH * prone;
  lerpVec(out.hips, _tread.hips, _crawl.hips, prone);
  lerpVec(out.torso, _tread.torso, _crawl.torso, prone);
  lerpVec(out.head, _tread.head, _crawl.head, prone);
  lerpLimb(out.armL, _tread.armL, _crawl.armL, prone);
  lerpLimb(out.armR, _tread.armR, _crawl.armR, prone);
  lerpLimb(out.legL, _tread.legL, _crawl.legL, prone);
  lerpLimb(out.legR, _tread.legR, _crawl.legR, prone);
  return { pose: out, prone };
}

// ---------------------------------------------------------------------------
// Splash
// ---------------------------------------------------------------------------

export interface Splash {
  group: THREE.Group;
  /** Throw one. `strength` 0..1 — how hard you hit the water. */
  burst(x: number, y: number, z: number, strength: number): void;
  /**
   * The churn behind a moving swimmer. Called often and at low strength, so it
   * shares the burst pool rather than owning a second one — a body cutting
   * through water with no wake at all is the single loudest tell that it is a
   * model being translated rather than something swimming.
   */
  kick(x: number, y: number, z: number, strength: number): void;
  update(dt: number): void;
  dispose(): void;
}

/**
 * The splash: a spreading ring on the surface and a puff of droplets.
 *
 * One pooled buffer of points and one pooled set of rings, because entering
 * water is a thing that happens repeatedly and allocating a particle system
 * per entry is how a world starts hitching after ten minutes of play.
 */
export function buildSplash(): Splash {
  const group = new THREE.Group();
  group.frustumCulled = false;

  const N = 90;
  const pos = new Float32Array(N * 3);
  const vel = new Float32Array(N * 3);
  const life = new Float32Array(N);
  let next = 0;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  const dropMat = new THREE.PointsMaterial({
    color: "#eaf7ff",
    size: 0.22,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const drops = new THREE.Points(geo, dropMat);
  drops.frustumCulled = false;
  group.add(drops);

  const RINGS = 4;
  const ringGeo = new THREE.RingGeometry(0.44, 0.6, 32);
  ringGeo.rotateX(-Math.PI / 2);
  const rings: Array<{ mesh: THREE.Mesh; t: number; life: number }> = [];
  for (let i = 0; i < RINGS; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: "#cfeaff",
      transparent: true,
      opacity: 0,
      depthWrite: false,
      // Added rather than painted: an opaque white annulus on the sea reads as
      // a plastic ring somebody dropped, not as foam.
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.visible = false;
    // Above the water sheet, which does not write depth — without this the
    // ring sorts behind the sea it is supposed to be sitting on.
    mesh.renderOrder = 3;
    group.add(mesh);
    rings.push({ mesh, t: 0, life: 0 });
  }
  let nextRing = 0;

  return {
    group,
    burst(x, y, z, strength) {
      const s = Math.max(0.15, Math.min(1, strength));
      const count = Math.round(18 + s * 42);
      for (let i = 0; i < count; i++) {
        const k = next++ % N;
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 0.5;
        pos[k * 3] = x + Math.cos(a) * r;
        pos[k * 3 + 1] = y + 0.05;
        pos[k * 3 + 2] = z + Math.sin(a) * r;
        const out = 1.5 + Math.random() * 3.5 * s;
        vel[k * 3] = Math.cos(a) * out;
        vel[k * 3 + 1] = 3 + Math.random() * 6 * s;
        vel[k * 3 + 2] = Math.sin(a) * out;
        life[k] = 0.5 + Math.random() * 0.5;
      }
      const ring = rings[nextRing++ % RINGS];
      ring.mesh.position.set(x, y + 0.06, z);
      ring.mesh.scale.setScalar(0.6);
      ring.mesh.visible = true;
      ring.t = 0;
      ring.life = 0.75 + s * 0.5;
      (ring.mesh.material as THREE.MeshBasicMaterial).opacity = 0.3 + s * 0.35;
    },
    kick(x, y, z, strength) {
      const s = Math.max(0.1, Math.min(1, strength));
      const count = 1 + Math.round(s * 2);
      for (let i = 0; i < count; i++) {
        const k = next++ % N;
        const a = Math.random() * Math.PI * 2;
        pos[k * 3] = x + Math.cos(a) * 0.35;
        pos[k * 3 + 1] = y + 0.04;
        pos[k * 3 + 2] = z + Math.sin(a) * 0.35;
        vel[k * 3] = Math.cos(a) * 0.9;
        vel[k * 3 + 1] = 1.4 + Math.random() * 2.6 * s;
        vel[k * 3 + 2] = Math.sin(a) * 0.9;
        life[k] = 0.28 + Math.random() * 0.3;
      }
    },
    update(dt) {
      let live = false;
      for (let i = 0; i < N; i++) {
        if (life[i] <= 0) continue;
        live = true;
        life[i] -= dt;
        vel[i * 3 + 1] -= 22 * dt;
        pos[i * 3] += vel[i * 3] * dt;
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        // Droplets die at the surface rather than raining through the seabed.
        if (life[i] <= 0 || pos[i * 3 + 1] < 0) {
          life[i] = 0;
          pos[i * 3 + 1] = -9999;
        }
      }
      drops.visible = live;
      if (live) (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;

      for (const r of rings) {
        if (!r.mesh.visible) continue;
        r.t += dt;
        const u = r.t / r.life;
        if (u >= 1) {
          r.mesh.visible = false;
          continue;
        }
        r.mesh.scale.setScalar(0.6 + u * 5.5);
        (r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - u) * (1 - u) * 0.6;
      }
    },
    dispose() {
      geo.dispose();
      dropMat.dispose();
      ringGeo.dispose();
      rings.forEach((r) => (r.mesh.material as THREE.Material).dispose());
    },
  };
}
