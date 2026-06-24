/**
 * mars — the red planet, far across the sky from the city. A little
 * landable world with a rusty surface, dust devils, and a handful of
 * roaming "gremlins" — small chittery creatures that wander the pad.
 *
 * Mirrors the structure of moon.ts: build a Group, push a square
 * collision pad, and return { group, update, spawn, padCenter }.
 */
import * as THREE from "three";
import type { WorldBox } from "./cardboardIsland";

export interface MarsWorld {
  group: THREE.Group;
  update(dt: number, now: number): void;
  spawn: THREE.Vector3;
  padCenter: THREE.Vector3;
  /** Root meshes for raycasting. Each carries userData.gremlinIndex. */
  gremlinTargets: THREE.Object3D[];
  /** Returns the gremlin index for a raycast hit, or -1. */
  hitTest(obj: THREE.Object3D): number;
  /** Mark a gremlin as dead. Returns true if it was alive. */
  killGremlin(index: number): boolean;
  /** Reset all gremlins to alive + a new orbit. */
  resetGremlins(): void;
  /** How many are still alive. */
  aliveCount(): number;
  /** Total spawned. */
  totalCount(): number;
  /** Fires whenever the alive count changes. */
  onChange(cb: (alive: number, total: number) => void): () => void;
}

const MARS_RADIUS = 52;
const PAD_HALF = 16;

function marsSurfaceTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;

  // Rusty base.
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#6b2418");
  grad.addColorStop(0.5, "#c0512a");
  grad.addColorStop(1, "#6b2418");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Dusty speckle.
  for (let i = 0; i < 5200; i++) {
    ctx.fillStyle = `rgba(${120 + Math.random() * 90},${40 + Math.random() * 50},${
      20 + Math.random() * 40
    },${0.05 + Math.random() * 0.2})`;
    ctx.fillRect(Math.random() * W, Math.random() * H, 1.4, 1.4);
  }

  // Dark basalt patches.
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

  // Crater rings.
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

  // Polar dust cap hint.
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

// Tiny gremlin: green body, big eyes, two horns, sits on a hover
// blob. Built procedurally so we can spawn a handful cheaply.
function makeGremlin(): THREE.Group {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({
    color: "#3ddc7a",
    roughness: 0.55,
    metalness: 0.05,
    emissive: "#103d20",
    emissiveIntensity: 0.4,
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 12), skin);
  body.scale.set(1, 1.05, 0.95);
  body.position.y = 0.65;
  g.add(body);

  // Eyes.
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

  // Horns.
  const hornMat = new THREE.MeshStandardMaterial({ color: "#1a3a22", roughness: 0.7 });
  [-0.22, 0.22].forEach((dx) => {
    const h = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.32, 8), hornMat);
    h.position.set(dx, 1.18, 0.05);
    h.rotation.z = dx > 0 ? -0.25 : 0.25;
    g.add(h);
  });

  // Toothy grin.
  const mouth = new THREE.Mesh(
    new THREE.PlaneGeometry(0.32, 0.08),
    new THREE.MeshBasicMaterial({ color: "#220505" }),
  );
  mouth.position.set(0, 0.62, 0.52);
  g.add(mouth);

  // Hover glow.
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
  // Sink the planet so its noisy top sits below the landing pad —
  // otherwise the bowl rises through the pad and the player walks
  // through the rim. Leaves ~2-3 units of headroom for the pad.
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

  // Rusty atmospheric halo.
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

  // ---- Welcome obelisk ---------------------------------------------
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
  // The "kill the gremlins" minigame: each one is a click target with
  // an `alive` flag. When killed we shrink it out, hide it, and emit a
  // change event so HUDs can update their counters.
  interface Gremlin {
    mesh: THREE.Group;
    orbitR: number;
    speed: number;
    phase: number;
    bob: number;
    alive: boolean;
    deathT: number; // 0..1 shrink animation
  }
  const gremlins: Gremlin[] = [];
  const N_GREMLINS = 6;
  for (let i = 0; i < N_GREMLINS; i++) {
    const m = makeGremlin();
    const orbitR = PAD_HALF * 0.55 + Math.random() * PAD_HALF * 0.5;
    const phase = Math.random() * Math.PI * 2;
    const speed = 0.25 + Math.random() * 0.35;
    m.position.set(Math.cos(phase) * orbitR, 0.05, Math.sin(phase) * orbitR);
    // Tag every descendant so raycaster hits map back to the index.
    m.userData.gremlinIndex = i;
    m.traverse((o) => {
      o.userData.gremlinIndex = i;
    });
    group.add(m);
    gremlins.push({
      mesh: m,
      orbitR,
      speed: speed * (Math.random() < 0.5 ? -1 : 1),
      phase,
      bob: Math.random() * Math.PI * 2,
      alive: true,
      deathT: 0,
    });
  }

  const changeListeners = new Set<(alive: number, total: number) => void>();
  const aliveCount = () => gremlins.reduce((n, g) => n + (g.alive ? 1 : 0), 0);
  const emitChange = () => {
    const a = aliveCount();
    changeListeners.forEach((cb) => cb(a, gremlins.length));
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

  // Beacon beam (red so you can spot Mars from the city).
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

  return {
    group,
    update(dt, now) {
      dust.rotation.y += dt * 0.12;
      (beam.material as THREE.MeshBasicMaterial).opacity =
        0.2 + Math.sin(now * 0.0019) * 0.12;
      gremlins.forEach((g) => {
        g.phase += dt * g.speed;
        const x = Math.cos(g.phase) * g.orbitR;
        const z = Math.sin(g.phase) * g.orbitR;
        g.mesh.position.x = x;
        g.mesh.position.z = z;
        g.mesh.position.y = 0.05 + Math.sin(now * 0.004 + g.bob) * 0.25;
        // Face direction of motion.
        g.mesh.rotation.y = Math.atan2(
          -Math.sin(g.phase) * g.speed,
          Math.cos(g.phase) * g.speed,
        );
      });
      ringSpinners.forEach((r, i) => {
        r.rotation.z += dt * (0.4 + i * 0.2);
      });
    },
    spawn: new THREE.Vector3(centerX, topY + 6, centerZ + PAD_HALF * 0.4),
    padCenter: new THREE.Vector3(centerX, topY, centerZ),
  };
}
