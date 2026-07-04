/**
 * skiWorld — POWDER PEAK, the VibeVerse ski mountain.
 *
 * A real heightfield mountain far out in the ocean fog (you can't see
 * it from the island — you arrive through the gateway arch). Same
 * character, same physics constants; skiing happens in City's movement
 * core: on snow, gravity pulls you along the analytic slope gradient
 * and momentum carries instead of the usual instant walk friction.
 *
 * heightAt(x, z) returns the snow surface height in WORLD coords (or
 * null outside the zone) — City's supportHeightAt treats it as ground,
 * so walking, jumping, landing and fall physics all just work on it.
 *
 * The base town: chalets with smoking chimneys, the VIBE LODGE, a
 * working gondola lift up the mountain, slalom gates on the main run,
 * gentle snowfall, and a portal ring home to Vibe Island.
 */
import * as THREE from "three";
import { signTexture, type WorldBox } from "@/components/city/cardboardIsland";

export const SKI_X = -650;
export const SKI_Z = -550;
const ZONE_R = 205;

// Town sits on a flattened shelf on the NE face (the side facing home).
const TOWN_LX = 100;
const TOWN_LZ = 96;
const TOWN_R = 30;
const TOWN_H = 14;

/** Raw mountain height in zone-local coords, before town flattening. */
function rawHeight(u: number, v: number): number {
  const r = Math.hypot(u, v);
  if (r > ZONE_R) return 0;
  let h =
    3 +
    150 * Math.exp(-((r / 105) ** 2)) +
    2.2 * Math.sin(u * 0.11) * Math.sin(v * 0.13) + // micro-moguls
    1.1 * Math.sin(u * 0.31 + v * 0.17); // crust texture
  // Fade the whole landform to sea level at the zone rim.
  const fade = 1 - THREE.MathUtils.smoothstep(r, 165, ZONE_R);
  h *= fade;
  // Flatten a shelf for the town.
  const dt2 = Math.hypot(u - TOWN_LX, v - TOWN_LZ);
  const townMix = 1 - THREE.MathUtils.smoothstep(dt2, TOWN_R * 0.55, TOWN_R);
  return h * (1 - townMix) + TOWN_H * townMix;
}

export interface SkiWorld {
  group: THREE.Group;
  update(dt: number, now: number): void;
  /** World-space snow height, or null outside Powder Peak. */
  heightAt(x: number, z: number): number | null;
  /** Downhill slope direction (d h / d x, d h / d z), world space. */
  gradientAt(x: number, z: number): { gx: number; gz: number };
  inZone(x: number, z: number): boolean;
  /** Town plaza spawn point. */
  spawn: THREE.Vector3;
  /** Stand by this ring to head home. */
  returnPortal: THREE.Vector3;
}

export function buildSkiWorld({ boxes }: { boxes: WorldBox[] }): SkiWorld {
  const group = new THREE.Group();
  group.position.set(SKI_X, 0, SKI_Z);

  const heightAt = (x: number, z: number): number | null => {
    const u = x - SKI_X;
    const v = z - SKI_Z;
    if (Math.hypot(u, v) > ZONE_R) return null;
    return rawHeight(u, v);
  };
  const gradientAt = (x: number, z: number) => {
    const e = 0.7;
    const h = (xx: number, zz: number) => heightAt(xx, zz) ?? 0;
    return {
      gx: (h(x + e, z) - h(x - e, z)) / (2 * e),
      gz: (h(x, z + e) - h(x, z - e)) / (2 * e),
    };
  };

  // ---- The mountain ---------------------------------------------------
  const SEG = 130;
  const terrainGeo = new THREE.PlaneGeometry(ZONE_R * 2, ZONE_R * 2, SEG, SEG);
  terrainGeo.rotateX(-Math.PI / 2);
  {
    const p = terrainGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i);
      const v = p.getZ(i);
      // Sink the square plane's corners under the ocean so the visible
      // landform is the round snow island, not a floating white sheet.
      p.setY(i, Math.hypot(u, v) > ZONE_R - 1 ? -3 : rawHeight(u, v));
    }
    p.needsUpdate = true;
    terrainGeo.computeVertexNormals();
  }
  const snow = new THREE.Mesh(
    terrainGeo,
    new THREE.MeshStandardMaterial({ color: "#f2f6fd", roughness: 0.92, metalness: 0.02 }),
  );
  group.add(snow);

  // ---- Evergreens (instanced), avoiding the main run + the town ------
  // Main run: the sector pointing from the peak toward the town.
  const runDir = Math.atan2(TOWN_LX, TOWN_LZ);
  const treeCount = 170;
  const foliage = new THREE.InstancedMesh(
    new THREE.ConeGeometry(2.1, 5.2, 7),
    new THREE.MeshStandardMaterial({ color: "#2c5f3e", roughness: 0.9, flatShading: true }),
    treeCount,
  );
  const caps = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1.4, 2.6, 7),
    new THREE.MeshStandardMaterial({ color: "#e8f2fa", roughness: 0.9, flatShading: true }),
    treeCount,
  );
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.28, 0.36, 1.6, 6),
    new THREE.MeshStandardMaterial({ color: "#5a3d28", roughness: 0.95 }),
    treeCount,
  );
  {
    const m = new THREE.Matrix4();
    let placedTrees = 0;
    let tries = 0;
    while (placedTrees < treeCount && tries < 3000) {
      tries++;
      const a = Math.random() * Math.PI * 2;
      const r = 35 + Math.random() * 150;
      const u = Math.sin(a) * r;
      const v = Math.cos(a) * r;
      // Keep the main run + the town shelf clear.
      let dA = a - runDir;
      while (dA > Math.PI) dA -= Math.PI * 2;
      while (dA < -Math.PI) dA += Math.PI * 2;
      if (Math.abs(dA) < 0.42) continue;
      if (Math.hypot(u - TOWN_LX, v - TOWN_LZ) < TOWN_R + 8) continue;
      const h = rawHeight(u, v);
      if (h < 2.5) continue; // not in the surf
      const s = 0.8 + Math.random() * 0.7;
      m.makeScale(s, s, s);
      m.setPosition(u, h + 2.4 * s, v);
      foliage.setMatrixAt(placedTrees, m);
      m.makeScale(s, s, s);
      m.setPosition(u, h + 5.4 * s, v);
      caps.setMatrixAt(placedTrees, m);
      m.makeScale(s, s, s);
      m.setPosition(u, h + 0.8 * s, v);
      trunks.setMatrixAt(placedTrees, m);
      placedTrees++;
    }
    foliage.count = placedTrees;
    caps.count = placedTrees;
    trunks.count = placedTrees;
  }
  group.add(foliage, caps, trunks);

  // ---- The town: chalets + VIBE LODGE --------------------------------
  const wood = new THREE.MeshStandardMaterial({ color: "#7a5236", roughness: 0.85 });
  const woodDark = new THREE.MeshStandardMaterial({ color: "#4e3320", roughness: 0.9 });
  const roofSnow = new THREE.MeshStandardMaterial({ color: "#eef4fb", roughness: 0.9 });
  const windowGlow = new THREE.MeshStandardMaterial({
    color: "#ffe6ad", emissive: "#ffb84d", emissiveIntensity: 0.9, roughness: 0.4,
  });
  const smokes: THREE.Sprite[] = [];

  const chalet = (lx: number, lz: number, w: number, d: number, hgt: number, yaw: number, lodge = false) => {
    const base = rawHeight(lx, lz);
    const c = new THREE.Group();
    c.position.set(lx, base, lz);
    c.rotation.y = yaw;
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, d), wood);
    body.position.y = hgt / 2;
    c.add(body);
    // Gable roof: two tilted slabs with a snowy cap.
    for (const side of [-1, 1]) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(w * 0.62, 0.24, d + 1.2), roofSnow);
      slab.position.set(side * w * 0.24, hgt + w * 0.16, 0);
      slab.rotation.z = side * -0.62;
      c.add(slab);
    }
    // Warm windows on the long faces.
    for (const side of [-1, 1]) {
      for (let i = 0; i < (lodge ? 3 : 2); i++) {
        const win = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.3), windowGlow);
        win.position.set((i - (lodge ? 1 : 0.5)) * (w / (lodge ? 3.4 : 2.6)), hgt * 0.45, side * (d / 2 + 0.03));
        if (side < 0) win.rotation.y = Math.PI;
        c.add(win);
      }
    }
    // Chimney + smoke.
    const chim = new THREE.Mesh(new THREE.BoxGeometry(0.7, 2.2, 0.7), woodDark);
    chim.position.set(w * 0.28, hgt + 1.4, d * 0.2);
    c.add(chim);
    const smoke = new THREE.Sprite(
      new THREE.SpriteMaterial({ color: 0xdfe8f2, transparent: true, opacity: 0.4, depthWrite: false }),
    );
    smoke.position.set(w * 0.28, hgt + 2.6, d * 0.2);
    smoke.scale.setScalar(1.4);
    c.add(smoke);
    smokes.push(smoke);
    group.add(c);
    // Coarse collision (axis-aligned around the rotated body).
    const half = Math.max(w, d) * 0.62;
    boxes.push({
      minX: SKI_X + lx - half, maxX: SKI_X + lx + half,
      minZ: SKI_Z + lz - half, maxZ: SKI_Z + lz + half,
      base: base, height: base + hgt,
    });
    return c;
  };

  chalet(TOWN_LX - 14, TOWN_LZ - 10, 7, 5.6, 3.6, 0.4);
  chalet(TOWN_LX + 12, TOWN_LZ - 12, 6.4, 5.2, 3.4, -0.5);
  chalet(TOWN_LX + 15, TOWN_LZ + 8, 6.8, 5.4, 3.5, 2.6);
  const lodgeGroup = chalet(TOWN_LX - 6, TOWN_LZ + 14, 12, 8, 4.6, Math.PI + 0.35, true);
  {
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(7.5, 1.9),
      new THREE.MeshBasicMaterial({
        map: signTexture(["VIBE LODGE ⛷ powder peak"], "#2b3a4d", "#cfe8ff", true),
        side: THREE.DoubleSide,
        transparent: true,
      }),
    );
    sign.position.set(0, 6.8, 0);
    lodgeGroup.add(sign);
  }

  // ---- Gondola lift up the main run -----------------------------------
  // Pylons march from the town shelf to just below the peak.
  const liftFrom = new THREE.Vector3(TOWN_LX - 4, rawHeight(TOWN_LX - 4, TOWN_LZ - 6) + 6, TOWN_LZ - 6);
  const liftTo = new THREE.Vector3(14, rawHeight(14, 12) + 8, 12);
  const pylonMat = new THREE.MeshStandardMaterial({ color: "#3a4450", roughness: 0.6, metalness: 0.4 });
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    const px = THREE.MathUtils.lerp(liftFrom.x, liftTo.x, t);
    const pz = THREE.MathUtils.lerp(liftFrom.z, liftTo.z, t);
    const ground = rawHeight(px, pz);
    const cableY = THREE.MathUtils.lerp(liftFrom.y, liftTo.y, t);
    const py = Math.max(cableY, ground + 5);
    const pylon = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.45, py - ground + 1, 8), pylonMat);
    pylon.position.set(px, ground + (py - ground + 1) / 2 - 0.5, pz);
    group.add(pylon);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.22, 0.22), pylonMat);
    arm.position.set(px, py + 0.4, pz);
    group.add(arm);
  }
  {
    const cableGeo = new THREE.BufferGeometry().setFromPoints([liftFrom, liftTo]);
    group.add(new THREE.Line(cableGeo, new THREE.LineBasicMaterial({ color: 0x222831 })));
  }
  const gondolas: Array<{ g: THREE.Group; t: number; dir: 1 | -1 }> = [];
  for (let i = 0; i < 3; i++) {
    const cab = new THREE.Group();
    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 1.5, 1.2),
      new THREE.MeshStandardMaterial({ color: ["#d94f4f", "#3f7ad9", "#ffd166"][i], roughness: 0.5 }),
    );
    shell.position.y = -1.1;
    cab.add(shell);
    const hangArm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.9, 6), pylonMat);
    hangArm.position.y = -0.45;
    cab.add(hangArm);
    const winBand = new THREE.Mesh(
      new THREE.BoxGeometry(1.55, 0.55, 1.25),
      new THREE.MeshStandardMaterial({ color: "#dff2ff", emissive: "#9cc8e8", emissiveIntensity: 0.3, roughness: 0.3 }),
    );
    winBand.position.y = -0.95;
    cab.add(winBand);
    group.add(cab);
    gondolas.push({ g: cab, t: i / 3, dir: i % 2 === 0 ? 1 : -1 });
  }

  // ---- Slalom gates down the main run ---------------------------------
  for (let i = 0; i < 10; i++) {
    const t = 0.18 + (i / 10) * 0.72;
    const gx = THREE.MathUtils.lerp(10, TOWN_LX - 12, t) + Math.sin(i * 1.8) * 9;
    const gz = THREE.MathUtils.lerp(10, TOWN_LZ - 16, t) + Math.cos(i * 1.4) * 9;
    const gy = rawHeight(gx, gz);
    const color = i % 2 === 0 ? "#e04444" : "#2f6fd9";
    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.07, 2.4, 6),
        new THREE.MeshStandardMaterial({ color, roughness: 0.5 }),
      );
      pole.position.set(gx + side * 1.7, gy + 1.2, gz);
      group.add(pole);
      const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(0.8, 0.5),
        new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
      );
      flag.position.set(gx + side * 1.7 + 0.4, gy + 2.1, gz);
      group.add(flag);
    }
  }

  // ---- Portal home + spawn --------------------------------------------
  const portalLocal = new THREE.Vector3(TOWN_LX + 2, TOWN_H, TOWN_LZ + 4);
  {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.7, 0.14, 10, 40),
      new THREE.MeshStandardMaterial({
        color: "#7ad7ff", emissive: "#3aa0e8", emissiveIntensity: 1.2, roughness: 0.3,
      }),
    );
    ring.position.set(portalLocal.x, portalLocal.y + 2.2, portalLocal.z);
    group.add(ring);
    const glow = new THREE.PointLight(0x7ad7ff, 12, 16, 2);
    glow.position.copy(ring.position);
    group.add(glow);
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(4.4, 1.1),
      new THREE.MeshBasicMaterial({
        map: signTexture(["🏝 back to vibe island"], "#123048", "#9fe0ff"),
        side: THREE.DoubleSide,
        transparent: true,
      }),
    );
    sign.position.set(portalLocal.x, portalLocal.y + 4.4, portalLocal.z);
    // Face the town plaza so the text reads the right way around.
    sign.rotation.y = Math.atan2(TOWN_LX - 2 - portalLocal.x, TOWN_LZ - 2 - portalLocal.z);
    group.add(sign);
  }

  // ---- Snowfall ---------------------------------------------------------
  const FLAKES = 500;
  const flakeGeo = new THREE.BufferGeometry();
  const flakePos = new Float32Array(FLAKES * 3);
  for (let i = 0; i < FLAKES; i++) {
    flakePos[i * 3] = (Math.random() * 2 - 1) * ZONE_R;
    flakePos[i * 3 + 1] = Math.random() * 190;
    flakePos[i * 3 + 2] = (Math.random() * 2 - 1) * ZONE_R;
  }
  flakeGeo.setAttribute("position", new THREE.BufferAttribute(flakePos, 3));
  const flakes = new THREE.Points(
    flakeGeo,
    new THREE.PointsMaterial({ color: 0xffffff, size: 0.45, transparent: true, opacity: 0.85, depthWrite: false }),
  );
  group.add(flakes);

  return {
    group,
    heightAt,
    gradientAt,
    inZone: (x, z) => Math.hypot(x - SKI_X, z - SKI_Z) <= ZONE_R,
    spawn: new THREE.Vector3(SKI_X + TOWN_LX - 2, TOWN_H + 0.4, SKI_Z + TOWN_LZ - 2),
    returnPortal: new THREE.Vector3(SKI_X + portalLocal.x, TOWN_H, SKI_Z + portalLocal.z),
    update(dt, now) {
      // Gondolas shuttle up and down the cable.
      for (const gd of gondolas) {
        gd.t += gd.dir * dt * 0.028;
        if (gd.t > 1) { gd.t = 1; gd.dir = -1; }
        if (gd.t < 0) { gd.t = 0; gd.dir = 1; }
        gd.g.position.set(
          THREE.MathUtils.lerp(liftFrom.x, liftTo.x, gd.t),
          THREE.MathUtils.lerp(liftFrom.y, liftTo.y, gd.t) - 0.05,
          THREE.MathUtils.lerp(liftFrom.z, liftTo.z, gd.t),
        );
        gd.g.rotation.y = Math.sin(now * 0.001 + gd.t * 9) * 0.05;
      }
      // Chimney smoke drifts up and re-lights.
      smokes.forEach((s, i) => {
        const k = (now * 0.0004 + i * 0.37) % 1;
        s.position.y = 4.2 + k * 3.2;
        (s.material as THREE.SpriteMaterial).opacity = 0.42 * (1 - k);
        s.scale.setScalar(1.1 + k * 1.6);
      });
      // Snowfall: sink and wrap.
      const p = flakeGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < FLAKES; i++) {
        let y = p.getY(i) - dt * (4 + (i % 5));
        if (y < 0) y = 185;
        p.setY(i, y);
      }
      p.needsUpdate = true;
    },
  };
}
