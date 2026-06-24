/**
 * moon — a small landable moon hanging in the sky near Cardboard Island.
 *
 * Same pattern as cardboardIsland: build a Group, push collision boxes
 * for the landable surface, return { group, update } and a spawn point.
 *
 * Visuals: a low-poly cratered sphere with a painted-canvas regolith
 * texture, a circular landing pad (lit ring + concentric guide rings),
 * a planted "EDGE" flag, an Earth-rise sprite in the sky, and a halo
 * of slow-orbiting stardust so it reads as a celestial body from the
 * city across.
 *
 * Collision is intentionally simple — a square pad inset into the
 * sphere's top, so you can jetpack land and walk around without
 * fighting the spherical curvature.
 */
import * as THREE from "three";
import type { WorldBox } from "./cardboardIsland";

export interface MoonWorld {
  group: THREE.Group;
  update(dt: number, now: number): void;
  /** Where to drop a visitor arriving via ?spawn=moon. */
  spawn: THREE.Vector3;
  /** World-space pad center, for proximity checks. */
  padCenter: THREE.Vector3;
}

const MOON_RADIUS = 38;
const PAD_HALF = 14; // half-size of the square landing zone

// ------------------------------------------------------------------
// Canvas regolith — grey base, peppered with darker craters and a few
// brighter highlands. Wraps once around the sphere.
// ------------------------------------------------------------------
function moonSurfaceTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;

  // Base regolith gradient (lighter at equator, darker poles).
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#7e8290");
  grad.addColorStop(0.5, "#b8bcc7");
  grad.addColorStop(1, "#7e8290");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Fine speckle.
  for (let i = 0; i < 4200; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    ctx.fillStyle = `rgba(${30 + Math.random() * 60},${30 + Math.random() * 60},${
      40 + Math.random() * 60
    },${0.06 + Math.random() * 0.18})`;
    ctx.fillRect(x, y, 1.2, 1.2);
  }

  // Maria (dark patches).
  for (let i = 0; i < 14; i++) {
    const x = Math.random() * W;
    const y = 60 + Math.random() * (H - 120);
    const r = 28 + Math.random() * 70;
    const g2 = ctx.createRadialGradient(x, y, r * 0.2, x, y, r);
    g2.addColorStop(0, "rgba(40,44,55,0.55)");
    g2.addColorStop(1, "rgba(40,44,55,0)");
    ctx.fillStyle = g2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Craters: bright rim + dark interior, slight shadow on one side.
  for (let i = 0; i < 110; i++) {
    const x = Math.random() * W;
    const y = 40 + Math.random() * (H - 80);
    const r = 4 + Math.random() * 26;
    // Bright halo.
    const halo = ctx.createRadialGradient(x, y, r * 0.55, x, y, r * 1.15);
    halo.addColorStop(0, "rgba(220,220,228,0)");
    halo.addColorStop(0.7, "rgba(225,225,232,0.55)");
    halo.addColorStop(1, "rgba(225,225,232,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.15, 0, Math.PI * 2);
    ctx.fill();
    // Dark bowl.
    const bowl = ctx.createRadialGradient(x - r * 0.25, y - r * 0.25, 0, x, y, r);
    bowl.addColorStop(0, "rgba(60,62,70,0.85)");
    bowl.addColorStop(1, "rgba(60,62,70,0)");
    ctx.fillStyle = bowl;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

// Earth-rise sprite hovering over the moon's horizon. Pure canvas so
// it works offline and matches the painted aesthetic of the rest of
// the world.
function earthSprite(): THREE.Sprite {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d")!;
  // Atmosphere glow.
  const glow = ctx.createRadialGradient(S / 2, S / 2, S * 0.34, S / 2, S / 2, S * 0.5);
  glow.addColorStop(0, "rgba(120,180,255,0.55)");
  glow.addColorStop(1, "rgba(120,180,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, S, S);
  // Ocean disc with day/night terminator.
  const disc = ctx.createRadialGradient(
    S * 0.4, S * 0.4, S * 0.04,
    S / 2, S / 2, S * 0.36,
  );
  disc.addColorStop(0, "#7ec0ff");
  disc.addColorStop(0.6, "#2a6db8");
  disc.addColorStop(1, "#0a1a36");
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S * 0.36, 0, Math.PI * 2);
  ctx.fill();
  // Continent blobs.
  ctx.fillStyle = "rgba(80,160,90,0.85)";
  const blobs: [number, number, number][] = [
    [0.46, 0.42, 0.09],
    [0.55, 0.5, 0.07],
    [0.42, 0.58, 0.06],
    [0.6, 0.36, 0.05],
  ];
  blobs.forEach(([x, y, r]) => {
    ctx.beginPath();
    ctx.arc(S * x, S * y, S * r, 0, Math.PI * 2);
    ctx.fill();
  });
  // Cloud wisp.
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  for (let i = 0; i < 8; i++) {
    ctx.beginPath();
    ctx.arc(
      S * (0.45 + Math.random() * 0.15),
      S * (0.45 + Math.random() * 0.15),
      S * (0.02 + Math.random() * 0.03),
      0, Math.PI * 2,
    );
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(34, 34, 1);
  return sprite;
}

function flagTexture(): THREE.CanvasTexture {
  const W = 256;
  const H = 160;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#0c1a14";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(45,212,168,0.6)";
  ctx.lineWidth = 6;
  ctx.strokeRect(6, 6, W - 12, H - 12);
  ctx.font = "bold 64px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#46e88c";
  ctx.shadowColor = "#46e88c";
  ctx.shadowBlur = 14;
  ctx.fillText("EDGE", W / 2, H / 2 - 18);
  ctx.shadowBlur = 0;
  ctx.font = "20px system-ui, sans-serif";
  ctx.fillStyle = "#baffe9";
  ctx.fillText("MOONBASE · EST. 2026", W / 2, H / 2 + 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildMoon(opts: {
  centerX: number;
  centerZ: number;
  topY: number;
  boxes: WorldBox[];
}): MoonWorld {
  const { centerX, centerZ, topY, boxes } = opts;
  const group = new THREE.Group();
  group.position.set(centerX, topY, centerZ);
  const spinners: THREE.Object3D[] = [];

  // ---- Moon body (low-poly sphere) -------------------------------
  const surfaceMat = new THREE.MeshStandardMaterial({
    map: moonSurfaceTexture(),
    roughness: 0.95,
    metalness: 0,
  });
  const moon = new THREE.Mesh(new THREE.SphereGeometry(MOON_RADIUS, 48, 36), surfaceMat);
  // Drop the sphere so its CRATERED top sits a hair BELOW the pad —
  // the noise displacement below can push verts up ~1.5, so we leave
  // ~3 units of headroom so the pad always rests on top of the body
  // and the player can't walk through the rim.
  moon.position.y = -MOON_RADIUS - 2.5;
  // Subtle vertex jitter for a cratered silhouette.
  {
    const pos = moon.geometry.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = v.clone().normalize();
      const noise =
        Math.sin(v.x * 0.21) * Math.cos(v.z * 0.23) * 0.6 +
        Math.sin(v.y * 0.17 + 1.1) * 0.4;
      v.addScaledVector(n, noise);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    moon.geometry.computeVertexNormals();
  }
  group.add(moon);

  // ---- Landing pad (flat, sits flush with topY) -------------------
  const padGroup = new THREE.Group();
  const padBase = new THREE.Mesh(
    new THREE.CylinderGeometry(PAD_HALF * 1.05, PAD_HALF * 1.15, 1.4, 36),
    new THREE.MeshStandardMaterial({ color: "#2a2f3a", roughness: 0.6, metalness: 0.4 }),
  );
  padBase.position.y = -0.7;
  padGroup.add(padBase);

  // Glowing pad rings.
  const ringMat = new THREE.MeshBasicMaterial({
    color: "#2dd4a8",
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  for (let i = 0; i < 3; i++) {
    const ir = PAD_HALF * (0.35 + i * 0.22);
    const ring = new THREE.Mesh(new THREE.RingGeometry(ir, ir + 0.35, 48), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04 + i * 0.01;
    padGroup.add(ring);
  }

  // Corner beacons.
  const beaconMat = new THREE.MeshBasicMaterial({ color: "#46e88c" });
  const cornerR = PAD_HALF * 0.9;
  [-1, 1].forEach((sx) =>
    [-1, 1].forEach((sz) => {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.18, 2.6, 8),
        new THREE.MeshStandardMaterial({ color: "#1a1f2a", roughness: 0.6 }),
      );
      pole.position.set(sx * cornerR, 1.3, sz * cornerR);
      padGroup.add(pole);
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), beaconMat);
      beacon.position.set(sx * cornerR, 2.6, sz * cornerR);
      padGroup.add(beacon);
      spinners.push(beacon);
    }),
  );

  // Pad-side glow light.
  const padLight = new THREE.PointLight(0x46e88c, 25, 60, 1.8);
  padLight.position.set(0, 4, 0);
  padGroup.add(padLight);

  group.add(padGroup);

  // Square collision pad so jetpack landings feel solid.
  boxes.push({
    minX: centerX - PAD_HALF,
    maxX: centerX + PAD_HALF,
    minZ: centerZ - PAD_HALF,
    maxZ: centerZ + PAD_HALF,
    base: topY - 2,
    height: topY,
  });

  // ---- Flag ------------------------------------------------------
  const flagPole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.1, 8, 8),
    new THREE.MeshStandardMaterial({ color: "#cfd5e0", roughness: 0.5, metalness: 0.6 }),
  );
  flagPole.position.set(-PAD_HALF * 0.6, 4, -PAD_HALF * 0.4);
  group.add(flagPole);
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(3.6, 2.25),
    new THREE.MeshBasicMaterial({
      map: flagTexture(),
      side: THREE.DoubleSide,
      transparent: true,
    }),
  );
  flag.position.set(-PAD_HALF * 0.6 + 1.85, 6.6, -PAD_HALF * 0.4);
  group.add(flag);

  // ---- Habitat dome (decorative) ---------------------------------
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(4.5, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({
      color: "#9ad9c4",
      transparent: true,
      opacity: 0.45,
      roughness: 0.2,
      metalness: 0.1,
      side: THREE.DoubleSide,
    }),
  );
  dome.position.set(PAD_HALF * 0.55, 0, PAD_HALF * 0.5);
  group.add(dome);
  const domeBase = new THREE.Mesh(
    new THREE.CylinderGeometry(4.6, 4.8, 0.4, 28),
    new THREE.MeshStandardMaterial({ color: "#2a2f3a", roughness: 0.6 }),
  );
  domeBase.position.set(PAD_HALF * 0.55, 0.2, PAD_HALF * 0.5);
  group.add(domeBase);

  // ---- Scattered moon rocks (around the pad) ---------------------
  const rockMat = new THREE.MeshStandardMaterial({ color: "#7c818d", roughness: 1 });
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + Math.random() * 0.5;
    const r = PAD_HALF + 4 + Math.random() * 14;
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.6 + Math.random() * 1.3, 0), rockMat);
    rock.position.set(Math.cos(a) * r, -0.4 - Math.random() * 0.3, Math.sin(a) * r);
    rock.rotation.set(Math.random(), Math.random(), Math.random());
    rock.scale.y *= 0.55 + Math.random() * 0.4;
    group.add(rock);
  }

  // ---- Earth-rise + stardust halo --------------------------------
  const earth = earthSprite();
  earth.position.set(-22, 38, -28);
  group.add(earth);

  // Stardust ring (slow orbit).
  const dustGeo = new THREE.BufferGeometry();
  const DUST = 220;
  const positions = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = MOON_RADIUS + 12 + Math.random() * 22;
    const y = (Math.random() - 0.5) * 14;
    positions[i * 3] = Math.cos(a) * r;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = Math.sin(a) * r;
  }
  dustGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const dust = new THREE.Points(
    dustGeo,
    new THREE.PointsMaterial({
      color: 0xbaffe9,
      size: 0.55,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  group.add(dust);

  // Beacon beam visible from the city.
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.7, 0.7, 220, 12, 1, true),
    new THREE.MeshBasicMaterial({
      color: "#46e88c",
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    }),
  );
  beam.position.set(0, 110, 0);
  group.add(beam);

  return {
    group,
    update(dt, now) {
      spinners.forEach((s, i) => {
        const t = 0.5 + Math.sin(now * 0.004 + i * 1.7) * 0.5;
        (s as THREE.Mesh).scale.setScalar(0.85 + t * 0.4);
      });
      dust.rotation.y += dt * 0.08;
      (beam.material as THREE.MeshBasicMaterial).opacity =
        0.22 + Math.sin(now * 0.0018) * 0.12;
      flag.rotation.y = Math.sin(now * 0.0006) * 0.18;
    },
    spawn: new THREE.Vector3(centerX, topY + 6, centerZ + PAD_HALF * 0.4),
    padCenter: new THREE.Vector3(centerX, topY, centerZ),
  };
}
