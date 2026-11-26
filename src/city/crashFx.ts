/**
 * crashFx — what a crash looks like in Vibe City.
 *
 * Explosions, sparks off a wall, leaves out of a tree you just drove through,
 * bits of car, tyre smoke from a bot that lost it, and the smoke and flame
 * that pour off a car as it takes damage. One module, a handful of instanced
 * pools, no allocation per frame.
 *
 * Built the same way as `carSink.ts`, which does the water version of most of
 * this, and for the same reasons: additive fire (it is light, and it sums),
 * normal-blended smoke (it darkens what is behind it), quads faced at the
 * camera by hand because there is no billboard material, and per-instance
 * colour so one pool can cool from white to dull red over a particle's life.
 * Plain `MeshBasicMaterial` everywhere, which matters more than it looks: the
 * city's renderer uses a logarithmic depth buffer, and a hand-written shader
 * that forgets its chunks simply never draws.
 */
import * as THREE from "three";

interface P {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  t: number; life: number; size: number; grow: number;
  /** Per-kind spare: colour offset, spin, wobble phase. */
  a: number;
  b: number;
}
const blank = (): P => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0, life: 1, size: 1, grow: 0, a: 0, b: 0 });

export interface CrashFx {
  group: THREE.Group;
  /** A car going up. `power` around 1; 1.6 for something big. */
  explode(x: number, y: number, z: number, power?: number, color?: number): void;
  /** Metal on stone or metal on metal. `dx`/`dz` is roughly where they fly. */
  sparks(x: number, y: number, z: number, dx: number, dz: number, n?: number): void;
  /** A tree going over. */
  leaves(x: number, y: number, z: number, n?: number): void;
  /** Bits of something. */
  debris(x: number, y: number, z: number, n: number, color: number, force?: number): void;
  /** Black smoke and, when `fire` > 0, flame, from a hurt engine. Call every frame. */
  smoulder(dt: number, x: number, y: number, z: number, smoke: number, fire: number): void;
  /** Grey tyre smoke at a wheel. Call every frame while it skids. */
  tyreSmoke(dt: number, x: number, z: number, rate: number): void;
  /** Exhaust flame off a fast car's tail, for boost. */
  afterburn(dt: number, x: number, y: number, z: number, dx: number, dz: number, rate: number): void;
  /** Seconds-decaying camera shake, 0..1. */
  shake(): number;
  /** Add some camera shake, scaled by distance from the viewer elsewhere. */
  kick(amount: number): void;
  update(dt: number, camera: THREE.Camera): void;
  /** How many explosions so far, for harnesses. */
  explosions(): number;
  dispose(): void;
}

const FIRE = 260;
const SMOKE = 220;
const SPARK = 160;
const BITS = 90;
const LEAF = 120;
const RINGS = 4;

function softTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.75)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createCrashFx(): CrashFx {
  const group = new THREE.Group();
  group.name = "city/crash-fx";
  group.frustumCulled = false;
  const trash: Array<{ dispose(): void }> = [];

  const tex = softTexture();
  const quad = new THREE.PlaneGeometry(1, 1);
  trash.push(tex, quad);

  const pool = (count: number, mat: THREE.Material, geo: THREE.BufferGeometry = quad, order = 6) => {
    const m = new THREE.InstancedMesh(geo, mat, count);
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.renderOrder = order;
    const c = new THREE.Color(1, 1, 1);
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < count; i++) {
      m.setMatrixAt(i, hidden);
      m.setColorAt(i, c);
    }
    group.add(m);
    trash.push(mat);
    return m;
  };

  const fireMat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, fog: false, opacity: 0.7,
  });
  const smokeMat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0.82,
  });
  const sparkMat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, fog: false,
  });
  const bitGeo = new THREE.BoxGeometry(1, 0.35, 0.7);
  const bitMat = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.4 });
  const leafGeo = new THREE.PlaneGeometry(1, 0.7);
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide });
  trash.push(bitGeo, leafGeo);

  const fire = pool(FIRE, fireMat, quad, 7);
  const smoke = pool(SMOKE, smokeMat, quad, 5);
  const spark = pool(SPARK, sparkMat, quad, 8);
  const bits = pool(BITS, bitMat, bitGeo, 0);
  bits.castShadow = true;
  const leaf = pool(LEAF, leafMat, leafGeo, 0);

  const fireP = Array.from({ length: FIRE }, blank);
  const smokeP = Array.from({ length: SMOKE }, blank);
  const sparkP = Array.from({ length: SPARK }, blank);
  const bitP = Array.from({ length: BITS }, blank);
  const leafP = Array.from({ length: LEAF }, blank);
  const bitCol: THREE.Color[] = Array.from({ length: BITS }, () => new THREE.Color());
  const leafCol: THREE.Color[] = Array.from({ length: LEAF }, () => new THREE.Color());
  let nf = 0, ns = 0, nk = 0, nb = 0, nl = 0;

  // Shock rings: flat, fast, gone.
  const ringGeo = new THREE.RingGeometry(0.8, 1, 48);
  ringGeo.rotateX(-Math.PI / 2);
  trash.push(ringGeo);
  const rings = Array.from({ length: RINGS }, () => {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    });
    trash.push(mat);
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    group.add(mesh);
    return { mesh, mat, t: 0, life: 0.6, to: 12 };
  });
  let nr = 0;

  // One light for the flash, parked at zero rather than added and removed:
  // adding a light recompiles every material in the scene.
  const flash = new THREE.PointLight(0xff9a40, 0, 34, 2);
  group.add(flash);
  let flashT = 0;
  let flashPeak = 0;

  let shakeAmt = 0;
  let explosions = 0;
  let smoulderCarry = 0;
  let tyreCarry = 0;
  let burnCarry = 0;

  const M = new THREE.Matrix4();
  const Q = new THREE.Quaternion();
  const E = new THREE.Euler();
  const V = new THREE.Vector3();
  const S = new THREE.Vector3();
  const C = new THREE.Color();
  const FACE = new THREE.Quaternion();
  const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

  const addFire = (x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, cool = 0) => {
    const p = fireP[nf++ % FIRE];
    p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz;
    p.t = p.life = life; p.size = size; p.grow = 1.2; p.a = cool; p.b = 0;
  };
  const addSmoke = (x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, dark: number) => {
    const p = smokeP[ns++ % SMOKE];
    p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz;
    p.t = p.life = life; p.size = size; p.grow = 2.2; p.a = dark; p.b = Math.random() * 6.28;
  };

  const api: CrashFx = {
    group,

    explode(x, y, z, power = 1, color = 0x555a60) {
      explosions++;
      const pw = THREE.MathUtils.clamp(power, 0.4, 2.2);
      // Fire: a ball that rises and cools. Small dim blobs that sum into a core.
      const balls = Math.round(50 * pw);
      for (let i = 0; i < balls; i++) {
        const a = Math.random() * Math.PI * 2;
        const u = Math.random() * 2 - 1;
        const rr = Math.sqrt(1 - u * u);
        const out = (2 + Math.random() * 6) * pw;
        addFire(
          x + Math.cos(a) * rr * 0.8, y + Math.random() * 0.8, z + Math.sin(a) * rr * 0.8,
          Math.cos(a) * rr * out, Math.abs(u) * out * 0.9 + 2.5 * pw, Math.sin(a) * rr * out,
          0.45 + Math.random() * 0.7, (0.7 + Math.random() * 0.9) * pw, Math.random() * 0.35,
        );
      }
      // A column, so it reads from down the street and not only up close.
      for (let i = 0; i < 14 * pw; i++) {
        addFire(x, y + 0.5, z, (Math.random() - 0.5) * 2, 7 + Math.random() * 6 * pw, (Math.random() - 0.5) * 2, 0.6 + Math.random() * 0.5, 0.9 * pw, 0.1);
      }
      const puffs = Math.round(34 * pw);
      for (let i = 0; i < puffs; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 2 * pw;
        addSmoke(
          x + Math.cos(a) * r, y + 0.6 + Math.random() * 2.2, z + Math.sin(a) * r,
          Math.cos(a) * (0.8 + Math.random() * 2.2), 1.6 + Math.random() * 3.2, Math.sin(a) * (0.8 + Math.random() * 2.2),
          2.4 + Math.random() * 2.4, (1.2 + Math.random() * 1.6) * pw, 0.08,
        );
      }
      api.sparks(x, y + 0.6, z, 0, 0, Math.round(40 * pw));
      api.debris(x, y + 0.6, z, Math.round(12 * pw), color, 10 * pw);
      const ring = rings[nr++ % RINGS];
      ring.mesh.position.set(x, Math.max(0.08, y + 0.08), z);
      ring.t = ring.life = 0.55;
      ring.to = 13 * pw;
      ring.mesh.visible = true;
      flash.position.set(x, y + 2, z);
      flashPeak = 30 + 40 * pw;
      flashT = 0.5;
      shakeAmt = Math.min(1, shakeAmt + 0.6 * pw);
    },

    sparks(x, y, z, dx, dz, n = 14) {
      const l = Math.hypot(dx, dz);
      for (let i = 0; i < n; i++) {
        const p = sparkP[nk++ % SPARK];
        const a = Math.random() * Math.PI * 2;
        const s = 3 + Math.random() * 9;
        p.x = x; p.y = y; p.z = z;
        p.vx = Math.cos(a) * s * 0.6 + (l > 0 ? (dx / l) * s : 0);
        p.vz = Math.sin(a) * s * 0.6 + (l > 0 ? (dz / l) * s : 0);
        p.vy = 2 + Math.random() * 6;
        p.t = p.life = 0.25 + Math.random() * 0.45;
        p.size = 0.12 + Math.random() * 0.12;
      }
    },

    leaves(x, y, z, n = 18) {
      for (let i = 0; i < n; i++) {
        const k = nl++ % LEAF;
        const p = leafP[k];
        const a = Math.random() * Math.PI * 2;
        const s = 1 + Math.random() * 4;
        p.x = x + (Math.random() - 0.5) * 2; p.y = y + Math.random() * 2; p.z = z + (Math.random() - 0.5) * 2;
        p.vx = Math.cos(a) * s; p.vz = Math.sin(a) * s; p.vy = 1.5 + Math.random() * 4;
        p.t = p.life = 2.2 + Math.random() * 2.4;
        p.size = 0.22 + Math.random() * 0.2;
        p.a = Math.random() * 6.28;
        p.b = (Math.random() - 0.5) * 8;
        leafCol[k].setHSL(0.26 + Math.random() * 0.08, 0.5, 0.25 + Math.random() * 0.18);
      }
    },

    debris(x, y, z, n, color, force = 7) {
      for (let i = 0; i < n; i++) {
        const k = nb++ % BITS;
        const p = bitP[k];
        const a = Math.random() * Math.PI * 2;
        const s = force * (0.4 + Math.random() * 0.8);
        p.x = x; p.y = y; p.z = z;
        p.vx = Math.cos(a) * s; p.vz = Math.sin(a) * s; p.vy = 4 + Math.random() * force;
        p.t = p.life = 3 + Math.random() * 2;
        p.size = 0.18 + Math.random() * 0.32;
        p.a = Math.random() * 6.28;
        p.b = (Math.random() - 0.5) * 14;
        bitCol[k].set(Math.random() < 0.35 ? 0x22262b : color);
      }
    },

    smoulder(dt, x, y, z, s, f) {
      if (s <= 0 && f <= 0) return;
      smoulderCarry += dt * (6 + s * 26);
      while (smoulderCarry >= 1) {
        smoulderCarry -= 1;
        addSmoke(
          x + (Math.random() - 0.5) * 0.6, y, z + (Math.random() - 0.5) * 0.6,
          (Math.random() - 0.5) * 0.8, 1.6 + Math.random() * 1.6, (Math.random() - 0.5) * 0.8,
          1.4 + Math.random() * 1.6 * (0.5 + s), 0.5 + s * 0.9, 0.35 - s * 0.3,
        );
      }
      if (f > 0) {
        burnCarry += dt * f * 40;
        while (burnCarry >= 1) {
          burnCarry -= 1;
          addFire(
            x + (Math.random() - 0.5) * 0.9, y + Math.random() * 0.3, z + (Math.random() - 0.5) * 0.9,
            (Math.random() - 0.5) * 0.8, 2 + Math.random() * 2.5, (Math.random() - 0.5) * 0.8,
            0.35 + Math.random() * 0.4, 0.45 + f * 0.5, 0.15 + Math.random() * 0.2,
          );
        }
      }
    },

    tyreSmoke(dt, x, z, rate) {
      tyreCarry += dt * rate;
      while (tyreCarry >= 1) {
        tyreCarry -= 1;
        addSmoke(
          x + (Math.random() - 0.5) * 1.6, 0.3, z + (Math.random() - 0.5) * 1.6,
          (Math.random() - 0.5) * 1.2, 0.5 + Math.random() * 0.8, (Math.random() - 0.5) * 1.2,
          1.2 + Math.random() * 1.2, 0.7, 0.62,
        );
      }
    },

    afterburn(dt, x, y, z, dx, dz, rate) {
      burnCarry += dt * rate;
      while (burnCarry >= 1) {
        burnCarry -= 1;
        addFire(
          x, y, z,
          -dx * (4 + Math.random() * 3) + (Math.random() - 0.5), (Math.random() - 0.2) * 0.8, -dz * (4 + Math.random() * 3) + (Math.random() - 0.5),
          0.14 + Math.random() * 0.12, 0.35 + Math.random() * 0.2, 0.05,
        );
      }
    },

    shake() {
      return shakeAmt;
    },
    kick(a) {
      shakeAmt = Math.min(1, shakeAmt + a);
    },
    explosions() {
      return explosions;
    },

    update(dt, camera) {
      FACE.copy(camera.quaternion);
      shakeAmt = Math.max(0, shakeAmt - dt * 1.8);

      // Fire: rises, cools white → yellow → orange → dull red.
      for (let i = 0; i < FIRE; i++) {
        const p = fireP[i];
        if (p.t <= 0) { fire.setMatrixAt(i, HIDDEN); continue; }
        p.t -= dt;
        p.vy += 5 * dt;
        const drag = Math.pow(0.08, dt);
        p.vx *= drag; p.vz *= drag; p.vy *= Math.pow(0.45, dt);
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const k = Math.max(0, p.t / p.life);
        const heat = Math.max(0, k - p.a);
        C.setRGB(Math.min(1, 0.25 + heat * 0.65), Math.min(1, 0.06 + heat * heat * 0.55), Math.min(1, heat * heat * heat * 0.35));
        fire.setColorAt(i, C);
        S.setScalar(Math.max(0.001, p.size * (1 + p.grow * (1 - k)) * Math.min(1, k * 4)));
        fire.setMatrixAt(i, M.compose(V.set(p.x, p.y, p.z), FACE, S));
      }
      fire.instanceMatrix.needsUpdate = true;
      if (fire.instanceColor) fire.instanceColor.needsUpdate = true;

      for (let i = 0; i < SMOKE; i++) {
        const p = smokeP[i];
        if (p.t <= 0) { smoke.setMatrixAt(i, HIDDEN); continue; }
        p.t -= dt;
        p.b += dt * 0.8;
        p.vy *= Math.pow(0.6, dt);
        p.vy += 0.7 * dt;
        const drag = Math.pow(0.3, dt);
        p.vx *= drag; p.vz *= drag;
        p.x += (p.vx + Math.sin(p.b) * 0.3) * dt;
        p.y += p.vy * dt;
        p.z += (p.vz + Math.cos(p.b * 0.8) * 0.3) * dt;
        const k = Math.max(0, p.t / p.life);
        // `a` is how pale it starts: 0 is black engine smoke, 0.6 tyre smoke.
        const g = p.a + (1 - k) * 0.32;
        C.setRGB(g, g * 0.98, g * 0.96);
        smoke.setColorAt(i, C);
        S.setScalar(Math.max(0.001, p.size * (1 + p.grow * (1 - k)) * Math.min(1, k * 6)));
        smoke.setMatrixAt(i, M.compose(V.set(p.x, p.y, p.z), FACE, S));
      }
      smoke.instanceMatrix.needsUpdate = true;
      if (smoke.instanceColor) smoke.instanceColor.needsUpdate = true;

      for (let i = 0; i < SPARK; i++) {
        const p = sparkP[i];
        if (p.t <= 0) { spark.setMatrixAt(i, HIDDEN); continue; }
        p.t -= dt;
        p.vy -= 20 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        if (p.y < 0.03) { p.y = 0.03; p.vy *= -0.35; p.vx *= 0.6; p.vz *= 0.6; }
        const k = Math.max(0, p.t / p.life);
        C.setRGB(1, 0.55 + k * 0.4, 0.15 + k * 0.5);
        spark.setColorAt(i, C);
        S.setScalar(p.size * (0.4 + k));
        spark.setMatrixAt(i, M.compose(V.set(p.x, p.y, p.z), FACE, S));
      }
      spark.instanceMatrix.needsUpdate = true;
      if (spark.instanceColor) spark.instanceColor.needsUpdate = true;

      for (let i = 0; i < BITS; i++) {
        const p = bitP[i];
        if (p.t <= 0) { bits.setMatrixAt(i, HIDDEN); continue; }
        p.t -= dt;
        p.vy -= 22 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        if (p.y < p.size * 0.2) {
          p.y = p.size * 0.2;
          p.vy = Math.abs(p.vy) > 2 ? -p.vy * 0.3 : 0;
          const f = Math.pow(0.02, dt);
          p.vx *= f; p.vz *= f; p.b *= f;
        }
        p.a += p.b * dt;
        E.set(p.a, p.a * 0.7, p.a * 0.3);
        Q.setFromEuler(E);
        const k = Math.min(1, p.t / 0.5);
        S.setScalar(p.size * k);
        bits.setMatrixAt(i, M.compose(V.set(p.x, p.y, p.z), Q, S));
        bits.setColorAt(i, bitCol[i]);
      }
      bits.instanceMatrix.needsUpdate = true;
      if (bits.instanceColor) bits.instanceColor.needsUpdate = true;

      for (let i = 0; i < LEAF; i++) {
        const p = leafP[i];
        if (p.t <= 0) { leaf.setMatrixAt(i, HIDDEN); continue; }
        p.t -= dt;
        // Leaves flutter down rather than fall: heavy air drag, a sideways sway.
        p.vy = Math.max(p.vy - 9 * dt, -1.4);
        const drag = Math.pow(0.2, dt);
        p.vx *= drag; p.vz *= drag;
        p.a += p.b * dt;
        p.x += (p.vx + Math.sin(p.a) * 0.6) * dt;
        p.y = Math.max(0.05, p.y + p.vy * dt);
        p.z += (p.vz + Math.cos(p.a * 0.7) * 0.6) * dt;
        E.set(p.a, p.a * 1.3, p.a * 0.4);
        Q.setFromEuler(E);
        S.setScalar(p.size * Math.min(1, p.t / 0.6));
        leaf.setMatrixAt(i, M.compose(V.set(p.x, p.y, p.z), Q, S));
        leaf.setColorAt(i, leafCol[i]);
      }
      leaf.instanceMatrix.needsUpdate = true;
      if (leaf.instanceColor) leaf.instanceColor.needsUpdate = true;

      for (const r of rings) {
        if (r.t <= 0) { r.mesh.visible = false; continue; }
        r.t -= dt;
        const k = 1 - Math.max(0, r.t / r.life);
        const s = 1 + (r.to - 1) * (1 - (1 - k) * (1 - k));
        r.mesh.scale.set(s, 1, s);
        r.mat.opacity = 0.75 * (1 - k);
      }

      if (flashT > 0) {
        flashT -= dt;
        flash.intensity = flashPeak * Math.max(0, flashT / 0.5) ** 2;
      } else if (flash.intensity !== 0) {
        flash.intensity = 0;
      }
    },

    dispose() {
      for (const t of trash) t.dispose();
      fire.dispose(); smoke.dispose(); spark.dispose(); bits.dispose(); leaf.dispose();
      flash.dispose();
    },
  };
  return api;
}
