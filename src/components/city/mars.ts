/**
 * mars — the red planet. Home to the gremlins, the mascots of
 * negativity in this little universe. They want to wreck things; you
 * want to bonk them. The Mars pad doubles as a tiny speedrun arena:
 *
 *   - Walk into a gremlin from the side → they bite you (lose a heart)
 *   - Jump and land on top of one → splat (kill)
 *   - Gremlins burrow and re-emerge somewhere else, so they never sit
 *     still long enough to be boring.
 *
 * Game state (kills, hearts, timer) lives in the React HUD — this
 * module owns the world simulation and exposes `processPlayer` so the
 * main tick can drive collisions every frame.
 */
import * as THREE from "three";
import type { WorldBox } from "./cardboardIsland";

export interface MarsPlayerSample {
  /** World position of the player's feet. */
  pos: THREE.Vector3;
  /** Vertical velocity (m/s). Negative = falling. */
  velY: number;
}

export interface MarsTickEvents {
  /** Number of gremlins stomped this frame (usually 0 or 1). */
  stomps: number;
  /** True if a roaming gremlin grabbed the player this frame. */
  hit: boolean;
}

export interface MarsWorld {
  group: THREE.Group;
  update(dt: number, now: number): void;
  /** Run collision + behaviour for the player. Call every frame while on Mars. */
  processPlayer(p: MarsPlayerSample, dt: number, now: number): MarsTickEvents;
  spawn: THREE.Vector3;
  padCenter: THREE.Vector3;
  /** Reset every gremlin to roaming. */
  resetGremlins(): void;
  aliveCount(): number;
  totalCount(): number;
  onChange(cb: (alive: number, total: number) => void): () => void;
}

const MARS_RADIUS = 52;
const PAD_HALF = 16;
const GREMLIN_BODY_R = 0.55;
const STOMP_HEAD_Y = 1.2;     // gremlin world-Y of "top of head" above pad
const STOMP_RANGE = 1.4;      // how close (XZ) to count as a stomp
const HIT_RANGE = 1.05;       // how close (XZ) to bite the player
const STOMP_MIN_FALL = 0.5;   // need to be moving down at least this fast
const BURROW_INTERVAL = [4.5, 9] as const;   // seconds between burrows (per gremlin)
const BURROW_TIME = 0.9;      // sink-into-ground animation length
const UNDERGROUND_TIME = [1.2, 2.6] as const;
const EMERGE_TIME = 0.8;

function marsSurfaceTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;

  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#6b2418");
  grad.addColorStop(0.5, "#c0512a");
  grad.addColorStop(1, "#6b2418");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  for (let i = 0; i < 5200; i++) {
    ctx.fillStyle = `rgba(${120 + Math.random() * 90},${40 + Math.random() * 50},${
      20 + Math.random() * 40
    },${0.05 + Math.random() * 0.2})`;
    ctx.fillRect(Math.random() * W, Math.random() * H, 1.4, 1.4);
  }

  for (let i = 0; i < 16; i++) {
    const x = Math.random() * W;
    const y = 50 + Math.random() * (H - 100);
    const r = 30 + Math.random() * 80;
    const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r);
    g.addColorStop(0, "rgba(60,22,12,0.6)");
    g.addColorStop(1, "rgba(60,22,12,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  for (let i = 0; i < 80; i++) {
    const x = Math.random() * W;
    const y = 40 + Math.random() * (H - 80);
    const r = 4 + Math.random() * 22;
    const halo = ctx.createRadialGradient(x, y, r * 0.55, x, y, r * 1.15);
    halo.addColorStop(0, "rgba(255,180,140,0)");
    halo.addColorStop(0.7, "rgba(255,180,140,0.45)");
    halo.addColorStop(1, "rgba(255,180,140,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.15, 0, Math.PI * 2);
    ctx.fill();
    const bowl = ctx.createRadialGradient(x - r * 0.25, y - r * 0.25, 0, x, y, r);
    bowl.addColorStop(0, "rgba(40,16,8,0.85)");
    bowl.addColorStop(1, "rgba(40,16,8,0)");
    ctx.fillStyle = bowl;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const cap = ctx.createLinearGradient(0, 0, 0, 60);
  cap.addColorStop(0, "rgba(255,220,200,0.55)");
  cap.addColorStop(1, "rgba(255,220,200,0)");
  ctx.fillStyle = cap;
  ctx.fillRect(0, 0, W, 60);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

export function makeGremlin(): THREE.Group {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({
    color: "#3ddc7a",
    roughness: 0.55,
    metalness: 0.05,
    emissive: "#103d20",
    emissiveIntensity: 0.4,
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(GREMLIN_BODY_R, 14, 12), skin);
  body.scale.set(1, 1.05, 0.95);
  body.position.y = 0.65;
  g.add(body);

  const eyeWhite = new THREE.MeshBasicMaterial({ color: "#fff8e0" });
  const pupil = new THREE.MeshBasicMaterial({ color: "#1a0a0a" });
  [-0.18, 0.18].forEach((dx) => {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), eyeWhite);
    e.position.set(dx, 0.85, 0.48);
    g.add(e);
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), pupil);
    p.position.set(dx, 0.85, 0.58);
    g.add(p);
  });

  const hornMat = new THREE.MeshStandardMaterial({ color: "#1a3a22", roughness: 0.7 });
  [-0.22, 0.22].forEach((dx) => {
    const h = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.32, 8), hornMat);
    h.position.set(dx, 1.18, 0.05);
    h.rotation.z = dx > 0 ? -0.25 : 0.25;
    g.add(h);
  });

  const mouth = new THREE.Mesh(
    new THREE.PlaneGeometry(0.32, 0.08),
    new THREE.MeshBasicMaterial({ color: "#220505" }),
  );
  mouth.position.set(0, 0.62, 0.52);
  g.add(mouth);

  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.45, 12, 10),
    new THREE.MeshBasicMaterial({
      color: "#5cffae",
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  glow.position.y = 0.15;
  glow.scale.set(1.2, 0.4, 1.2);
  g.add(glow);

  return g;
}

/** Draws the lore plaque text to a canvas the obelisk can wear. */
function makeLoreSign(): THREE.Mesh {
  const W = 512;
  const H = 320;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  // Backdrop.
  ctx.fillStyle = "#1a0a06";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#ff8a3c";
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, W - 16, H - 16);
  // Title.
  ctx.fillStyle = "#ffd2b5";
  ctx.font = "bold 44px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("⚠  GREMLINS  ⚠", W / 2, 70);
  // Body.
  ctx.fillStyle = "#ffe5d0";
  ctx.font = "22px ui-sans-serif, system-ui, sans-serif";
  const lines = [
    "Bringers of negativity. They burrow,",
    "they bite, they break what others build.",
    "",
    "STOMP them from above to pop them.",
    "Touch them on the ground and they bite.",
    "Clear the pad — beat your best time.",
  ];
  lines.forEach((ln, i) => ctx.fillText(ln, W / 2, 120 + i * 32));

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(4.4, 2.75),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }),
  );
  return mesh;
}

export function buildMars(opts: {
  centerX: number;
  centerZ: number;
  topY: number;
  boxes: WorldBox[];
}): MarsWorld {
  const { centerX, centerZ, topY, boxes } = opts;
  const group = new THREE.Group();
  group.position.set(centerX, topY, centerZ);

  // ---- Planet body --------------------------------------------------
  const planetMat = new THREE.MeshStandardMaterial({
    map: marsSurfaceTexture(),
    roughness: 0.95,
    metalness: 0,
  });
  const planet = new THREE.Mesh(new THREE.SphereGeometry(MARS_RADIUS, 56, 40), planetMat);
  planet.position.y = -MARS_RADIUS - 2.5;
  {
    const pos = planet.geometry.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = v.clone().normalize();
      const noise =
        Math.sin(v.x * 0.18) * Math.cos(v.z * 0.21) * 0.75 +
        Math.sin(v.y * 0.15 + 0.7) * 0.45;
      v.addScaledVector(n, noise);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    planet.geometry.computeVertexNormals();
  }
  group.add(planet);

  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(MARS_RADIUS * 1.1, 32, 24),
    new THREE.MeshBasicMaterial({
      color: "#ff7a3c",
      transparent: true,
      opacity: 0.08,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  halo.position.y = -MARS_RADIUS - 2.5;
  group.add(halo);

  // ---- Landing pad --------------------------------------------------
  const padGroup = new THREE.Group();
  const padBase = new THREE.Mesh(
    new THREE.CylinderGeometry(PAD_HALF * 1.05, PAD_HALF * 1.15, 1.4, 36),
    new THREE.MeshStandardMaterial({ color: "#3a1d14", roughness: 0.7, metalness: 0.3 }),
  );
  padBase.position.y = -0.7;
  padGroup.add(padBase);

  const ringMat = new THREE.MeshBasicMaterial({
    color: "#ff8a3c",
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const ringSpinners: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const ir = PAD_HALF * (0.35 + i * 0.22);
    const ring = new THREE.Mesh(new THREE.RingGeometry(ir, ir + 0.4, 48), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04 + i * 0.01;
    padGroup.add(ring);
    ringSpinners.push(ring);
  }

  const padLight = new THREE.PointLight(0xff7a3c, 28, 70, 1.8);
  padLight.position.set(0, 4, 0);
  padGroup.add(padLight);
  group.add(padGroup);

  boxes.push({
    minX: centerX - PAD_HALF,
    maxX: centerX + PAD_HALF,
    minZ: centerZ - PAD_HALF,
    maxZ: centerZ + PAD_HALF,
    base: topY - 2,
    height: topY,
  });

  // ---- Welcome obelisk + lore plaque --------------------------------
  const obelisk = new THREE.Mesh(
    new THREE.ConeGeometry(0.9, 5.5, 4),
    new THREE.MeshStandardMaterial({
      color: "#1a0d08",
      roughness: 0.4,
      metalness: 0.6,
      emissive: "#ff5a1f",
      emissiveIntensity: 0.35,
    }),
  );
  obelisk.position.set(-PAD_HALF * 0.6, 2.75, -PAD_HALF * 0.4);
  obelisk.rotation.y = Math.PI / 4;
  group.add(obelisk);

  const sign = makeLoreSign();
  sign.position.set(PAD_HALF * 0.05, 3.2, -PAD_HALF * 0.95);
  group.add(sign);
  // Pair of support legs so the sign reads like a planted plaque.
  const legMat = new THREE.MeshStandardMaterial({ color: "#5a2418", roughness: 0.8 });
  [-1.5, 1.5].forEach((dx) => {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3.2, 8), legMat);
    leg.position.set(sign.position.x + dx, 1.6, sign.position.z + 0.05);
    group.add(leg);
  });

  // Scattered red rocks.
  const rockMat = new THREE.MeshStandardMaterial({ color: "#8a3a22", roughness: 1 });
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + Math.random() * 0.5;
    const r = PAD_HALF + 4 + Math.random() * 18;
    const rock = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.7 + Math.random() * 1.6, 0),
      rockMat,
    );
    rock.position.set(Math.cos(a) * r, -0.4 - Math.random() * 0.4, Math.sin(a) * r);
    rock.rotation.set(Math.random(), Math.random(), Math.random());
    rock.scale.y *= 0.5 + Math.random() * 0.5;
    group.add(rock);
  }

  // ---- Gremlins ----------------------------------------------------
  // Game model. Each gremlin cycles through these states:
  //   roaming    — wandering on the pad, can be stomped, will bite
  //   dying      — stomped, playing the splat animation, then hides
  //   burrowing  — sinking into the ground (dust puff), can't be hit
  //   underground — invisible, waiting to pop up at a new spot
  //   emerging   — rising up at the new spot, can't bite yet
  type GState = "roaming" | "dying" | "burrowing" | "underground" | "emerging";
  interface Gremlin {
    mesh: THREE.Group;
    /** Center of current wander orbit. */
    targetX: number;
    targetZ: number;
    /** Velocity for the gentle drift. */
    vx: number;
    vz: number;
    bob: number;
    state: GState;
    /** Seconds remaining in current state (for non-roaming states). */
    stateT: number;
    /** Countdown until next burrow while roaming. */
    nextBurrow: number;
    alive: boolean;
  }

  const gremlins: Gremlin[] = [];
  const N_GREMLINS = 6;

  const randPad = () => {
    // Pick a random point on the pad (away from the very edge).
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * (PAD_HALF - 2.5);
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  };
  const randBurrowDelay = () =>
    BURROW_INTERVAL[0] + Math.random() * (BURROW_INTERVAL[1] - BURROW_INTERVAL[0]);
  const randUnderTime = () =>
    UNDERGROUND_TIME[0] + Math.random() * (UNDERGROUND_TIME[1] - UNDERGROUND_TIME[0]);

  for (let i = 0; i < N_GREMLINS; i++) {
    const m = makeGremlin();
    const p = randPad();
    m.position.set(p.x, 0.05, p.z);
    group.add(m);
    gremlins.push({
      mesh: m,
      targetX: p.x,
      targetZ: p.z,
      vx: 0,
      vz: 0,
      bob: Math.random() * Math.PI * 2,
      state: "roaming",
      stateT: 0,
      nextBurrow: randBurrowDelay(),
      alive: true,
    });
  }

  const changeListeners = new Set<(alive: number, total: number) => void>();
  const aliveCount = () => gremlins.reduce((n, g) => n + (g.alive ? 1 : 0), 0);
  const emitChange = () => {
    const a = aliveCount();
    changeListeners.forEach((cb) => cb(a, gremlins.length));
  };

  // Burrow dust puff: a quick ring that pops when they go under or surface.
  const puffMat = new THREE.MeshBasicMaterial({
    color: "#ffb27a",
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const puffPool: { mesh: THREE.Mesh; life: number }[] = [];
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.6, 24), puffMat.clone());
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    group.add(m);
    puffPool.push({ mesh: m, life: 0 });
  }
  let puffIdx = 0;
  const spawnPuff = (x: number, z: number) => {
    const p = puffPool[puffIdx++ % puffPool.length];
    p.mesh.position.set(x, 0.06, z);
    p.mesh.scale.setScalar(1);
    (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.7;
    p.mesh.visible = true;
    p.life = 0.6;
  };

  // ---- Dust devil swirl --------------------------------------------
  const dustGeo = new THREE.BufferGeometry();
  const DUST = 260;
  const positions = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = MARS_RADIUS + 14 + Math.random() * 26;
    const y = (Math.random() - 0.5) * 18;
    positions[i * 3] = Math.cos(a) * r;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = Math.sin(a) * r;
  }
  dustGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const dust = new THREE.Points(
    dustGeo,
    new THREE.PointsMaterial({
      color: 0xffb27a,
      size: 0.7,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  group.add(dust);

  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.8, 0.8, 260, 12, 1, true),
    new THREE.MeshBasicMaterial({
      color: "#ff5a1f",
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    }),
  );
  beam.position.set(0, 130, 0);
  group.add(beam);

  // Convert pad-local coords to world for collision checks.
  const groupOriginX = centerX;
  const groupOriginZ = centerZ;
  const groupOriginY = topY;

  const tickGremlin = (g: Gremlin, dt: number) => {
    if (g.state === "roaming") {
      // Wander: drift toward a moving target, with occasional re-aim.
      g.nextBurrow -= dt;
      if (Math.random() < dt * 0.4) {
        const p = randPad();
        g.targetX = p.x;
        g.targetZ = p.z;
      }
      const dx = g.targetX - g.mesh.position.x;
      const dz = g.targetZ - g.mesh.position.z;
      const d = Math.hypot(dx, dz);
      const speed = 2.2;
      if (d > 0.05) {
        g.vx = (dx / d) * speed;
        g.vz = (dz / d) * speed;
      }
      g.mesh.position.x += g.vx * dt;
      g.mesh.position.z += g.vz * dt;
      // Clamp to pad.
      const r = Math.hypot(g.mesh.position.x, g.mesh.position.z);
      if (r > PAD_HALF - 1.5) {
        g.mesh.position.x *= (PAD_HALF - 1.5) / r;
        g.mesh.position.z *= (PAD_HALF - 1.5) / r;
      }
      g.bob += dt;
      g.mesh.position.y = 0.05 + Math.sin(g.bob * 4) * 0.22;
      g.mesh.rotation.y = Math.atan2(g.vx, g.vz);

      if (g.nextBurrow <= 0) {
        g.state = "burrowing";
        g.stateT = BURROW_TIME;
        spawnPuff(g.mesh.position.x, g.mesh.position.z);
      }
    } else if (g.state === "burrowing") {
      g.stateT -= dt;
      const t = 1 - Math.max(0, g.stateT) / BURROW_TIME;
      g.mesh.position.y = 0.05 - t * 2.2;
      g.mesh.rotation.y += dt * 6;
      if (g.stateT <= 0) {
        g.state = "underground";
        g.stateT = randUnderTime();
        g.mesh.visible = false;
      }
    } else if (g.state === "underground") {
      g.stateT -= dt;
      if (g.stateT <= 0) {
        // Pop up somewhere new.
        const p = randPad();
        g.mesh.position.set(p.x, -2.2, p.z);
        g.targetX = p.x;
        g.targetZ = p.z;
        g.mesh.visible = true;
        g.state = "emerging";
        g.stateT = EMERGE_TIME;
        spawnPuff(p.x, p.z);
      }
    } else if (g.state === "emerging") {
      g.stateT -= dt;
      const t = 1 - Math.max(0, g.stateT) / EMERGE_TIME;
      g.mesh.position.y = -2.2 + t * 2.25;
      g.mesh.rotation.y += dt * 4;
      if (g.stateT <= 0) {
        g.state = "roaming";
        g.nextBurrow = randBurrowDelay();
        g.mesh.position.y = 0.05;
        g.bob = 0;
      }
    } else if (g.state === "dying") {
      g.stateT -= dt;
      const t = 1 - Math.max(0, g.stateT) / 0.4;
      const s = Math.max(0.001, 1 - t);
      g.mesh.scale.setScalar(s);
      g.mesh.rotation.y += dt * 12;
      if (g.stateT <= 0) g.mesh.visible = false;
    }
  };

  return {
    group,
    update(dt, now) {
      dust.rotation.y += dt * 0.12;
      (beam.material as THREE.MeshBasicMaterial).opacity =
        0.2 + Math.sin(now * 0.0019) * 0.12;
      gremlins.forEach((g) => tickGremlin(g, dt));
      ringSpinners.forEach((r, i) => {
        r.rotation.z += dt * (0.4 + i * 0.2);
      });
      // Fade burrow puffs.
      puffPool.forEach((p) => {
        if (!p.mesh.visible) return;
        p.life -= dt;
        const m = p.mesh.material as THREE.MeshBasicMaterial;
        m.opacity = Math.max(0, p.life / 0.6) * 0.7;
        p.mesh.scale.multiplyScalar(1 + dt * 4);
        if (p.life <= 0) p.mesh.visible = false;
      });
    },
    processPlayer(p, _dt, _now) {
      const events: MarsTickEvents = { stomps: 0, hit: false };
      // Convert gremlin local coords to world space for distance.
      for (const g of gremlins) {
        if (!g.alive || g.state !== "roaming") continue;
        const gx = groupOriginX + g.mesh.position.x;
        const gz = groupOriginZ + g.mesh.position.z;
        const gy = groupOriginY + g.mesh.position.y; // gremlin foot Y
        const dx = p.pos.x - gx;
        const dz = p.pos.z - gz;
        const d = Math.hypot(dx, dz);
        if (d > 2.0) continue;
        // Stomp: player must be coming down and above the gremlin's head.
        const headY = gy + STOMP_HEAD_Y;
        if (p.velY < -STOMP_MIN_FALL && p.pos.y >= headY - 0.4 && d < STOMP_RANGE) {
          g.alive = false;
          g.state = "dying";
          g.stateT = 0.4;
          events.stomps++;
          emitChange();
          continue;
        }
        // Bite: same level as the gremlin and inside their hit ring.
        if (Math.abs(p.pos.y - gy) < 1.6 && d < HIT_RANGE) {
          events.hit = true;
        }
      }
      return events;
    },
    spawn: new THREE.Vector3(centerX, topY + 6, centerZ + PAD_HALF * 0.4),
    padCenter: new THREE.Vector3(centerX, topY, centerZ),
    resetGremlins() {
      gremlins.forEach((g) => {
        const p = randPad();
        g.alive = true;
        g.state = "roaming";
        g.stateT = 0;
        g.nextBurrow = randBurrowDelay();
        g.mesh.visible = true;
        g.mesh.scale.setScalar(1);
        g.mesh.position.set(p.x, 0.05, p.z);
        g.targetX = p.x;
        g.targetZ = p.z;
        g.bob = Math.random() * Math.PI * 2;
      });
      emitChange();
    },
    aliveCount,
    totalCount: () => gremlins.length,
    onChange(cb) {
      changeListeners.add(cb);
      return () => changeListeners.delete(cb);
    },
  };
}
