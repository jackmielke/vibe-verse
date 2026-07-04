/**
 * cloudKingdom — the CLOUD BOUNCE KINGDOM, floating 130m above
 * Vibe Island.
 *
 * Every cloud up here is a trampoline: land and you're launched back
 * up, higher if you were moving fast. A spiral of puffy platforms
 * climbs to a crown at the top, with nine golden rings threaded
 * through the gaps — collect them all for a ✦ shower. You get up
 * there via the springy launch trampoline on the island lawn (or a
 * jetpack, if you insist on doing it the boring way).
 *
 * The platforms are ordinary collision boxes; the BOUNCE lives in
 * City's landing code (cloud tops shove you skyward instead of
 * letting you settle).
 */
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";

export interface CloudKingdom {
  group: THREE.Group;
  update(dt: number, now: number): void;
  /** XZ inside the kingdom's column. */
  inZone(x: number, z: number): boolean;
  /** World position of the launch trampoline on the island lawn. */
  launchPad: THREE.Vector3;
  /** Squash the trampoline for a beat (visual feedback on launch). */
  squashPad(): void;
  /**
   * Collect any ring within reach. Returns null if none, else the
   * number remaining (0 = full set — pay the bonus and respawn later).
   */
  tryCollect(p: THREE.Vector3): number | null;
}

export function buildCloudKingdom(opts: {
  cx: number;
  cz: number;
  baseY: number; // island lawn height (launch pad sits here)
  boxes: WorldBox[];
}): CloudKingdom {
  const { cx, cz, baseY, boxes } = opts;
  const group = new THREE.Group();
  const ZONE_R = 60;

  const puffGeo = new THREE.IcosahedronGeometry(1, 1);
  const puffMat = new THREE.MeshLambertMaterial({ color: 0xfdfdff, flatShading: true });
  const cloudPlatform = (x: number, y: number, z: number, size: number) => {
    const cloud = new THREE.Group();
    cloud.position.set(x, y, z);
    for (let p = 0; p < 5; p++) {
      const lump = new THREE.Mesh(puffGeo, puffMat);
      const core = p === 0;
      const s = core ? size : size * (0.45 + Math.random() * 0.3);
      lump.scale.set(s, s * 0.55, s * (0.85 + Math.random() * 0.3));
      if (!core) {
        const a = Math.random() * Math.PI * 2;
        lump.position.set(Math.cos(a) * size * 0.75, (Math.random() - 0.5) * size * 0.2, Math.sin(a) * size * 0.75);
      }
      lump.rotation.y = Math.random() * Math.PI;
      cloud.add(lump);
    }
    group.add(cloud);
    // Walkable top: a box whose top sits at the puff crown.
    const half = size * 1.15;
    boxes.push({
      minX: x - half, maxX: x + half,
      minZ: z - half, maxZ: z + half,
      base: y - size * 0.6,
      height: y + size * 0.5,
    });
    return cloud;
  };

  // A rising spiral of trampoline clouds, launch column first.
  const K_BASE = baseY + 130; // first platform band
  const spiral: Array<[number, number, number, number]> = [
    [0, K_BASE, 0, 6],           // the big arrival cloud, dead center
    [14, K_BASE + 9, 6, 4.4],
    [4, K_BASE + 19, 17, 4.2],
    [-11, K_BASE + 28, 12, 4.2],
    [-16, K_BASE + 38, -3, 4],
    [-6, K_BASE + 47, -15, 4],
    [9, K_BASE + 55, -12, 3.8],
    [16, K_BASE + 64, 2, 3.6],
    [5, K_BASE + 72, 13, 3.4],
    [-8, K_BASE + 79, 6, 3.2],
    [-2, K_BASE + 88, -6, 4.6], // the crown
  ];
  const clouds: THREE.Group[] = [];
  for (const [dx, y, dz, s] of spiral) clouds.push(cloudPlatform(cx + dx, y, cz + dz, s));

  // Crown ornament: a golden star on the top cloud.
  {
    const star = new THREE.Mesh(
      new THREE.OctahedronGeometry(1.2),
      new THREE.MeshStandardMaterial({
        color: "#ffd166", emissive: "#ffb700", emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.5,
      }),
    );
    const top = spiral[spiral.length - 1];
    star.position.set(cx + top[0], top[1] + 4.4, cz + top[2]);
    group.add(star);
    clouds.push(star as unknown as THREE.Group); // ride the bob animation
  }

  // Nine golden rings threaded through the bounce arcs.
  const ringMat = new THREE.MeshStandardMaterial({
    color: "#ffd166", emissive: "#ffb700", emissiveIntensity: 0.8, roughness: 0.35, metalness: 0.5,
  });
  const rings: Array<{ mesh: THREE.Mesh; taken: boolean }> = [];
  const ringSpots: Array<[number, number, number]> = [
    [7, K_BASE + 6, 3], [10, K_BASE + 15, 12], [-4, K_BASE + 24, 15],
    [-14, K_BASE + 33, 5], [-12, K_BASE + 43, -9], [1, K_BASE + 51, -15],
    [13, K_BASE + 60, -5], [11, K_BASE + 68, 8], [-5, K_BASE + 84, 0],
  ];
  for (const [dx, y, dz] of ringSpots) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.16, 10, 28), ringMat.clone());
    ring.position.set(cx + dx, y, cz + dz);
    group.add(ring);
    rings.push({ mesh: ring, taken: false });
  }
  let respawnAt = 0;

  // The launch trampoline down on the island lawn.
  const launchPad = new THREE.Vector3(cx + 24, baseY, cz + 4);
  const padGroup = new THREE.Group();
  padGroup.position.copy(launchPad);
  const padRim = new THREE.Mesh(
    new THREE.TorusGeometry(2.1, 0.28, 10, 28),
    new THREE.MeshStandardMaterial({ color: "#3a4450", roughness: 0.6, metalness: 0.4 }),
  );
  padRim.rotation.x = Math.PI / 2;
  padRim.position.y = 0.45;
  padGroup.add(padRim);
  const padSkin = new THREE.Mesh(
    new THREE.CircleGeometry(1.95, 26),
    new THREE.MeshStandardMaterial({
      color: "#7ad7ff", emissive: "#2f8fd0", emissiveIntensity: 0.5,
      roughness: 0.5, side: THREE.DoubleSide,
    }),
  );
  padSkin.rotation.x = -Math.PI / 2;
  padSkin.position.y = 0.42;
  padGroup.add(padSkin);
  const padSign = (() => {
    const c = document.createElement("canvas");
    c.width = 720; c.height = 100;
    const ctx = c.getContext("2d")!;
    ctx.beginPath();
    ctx.roundRect(8, 12, 704, 76, 32);
    ctx.fillStyle = "rgba(12, 16, 26, 0.68)";
    ctx.fill();
    ctx.strokeStyle = "rgba(122, 215, 255, 0.9)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "600 38px 'Sora', 'Segoe UI', sans-serif";
    ctx.fillStyle = "#c8ecff";
    ctx.fillText("☁️ CLOUD KINGDOM · step on!", 360, 52);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const padTag = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: padSign, transparent: true, depthWrite: false }),
  );
  padTag.scale.set(8.6, 1.2, 1);
  padTag.position.y = 3;
  padGroup.add(padTag);
  group.add(padGroup);

  let squashUntil = 0;

  return {
    group,
    launchPad,
    inZone: (x, z) => Math.hypot(x - cx, z - cz) <= ZONE_R,
    squashPad() {
      squashUntil = performance.now() + 400;
    },
    tryCollect(p) {
      for (const r of rings) {
        if (r.taken || !r.mesh.visible) continue;
        if (p.distanceTo(r.mesh.position) < 2.3) {
          r.taken = true;
          r.mesh.visible = false;
          const remaining = rings.filter((x) => !x.taken).length;
          if (remaining === 0) respawnAt = performance.now() + 90_000;
          return remaining;
        }
      }
      return null;
    },
    update(dt, now) {
      // Clouds breathe; rings spin.
      clouds.forEach((c, i) => {
        c.position.y += Math.sin(now * 0.0009 + i * 1.3) * 0.004;
      });
      rings.forEach((r, i) => {
        if (!r.mesh.visible) return;
        r.mesh.rotation.y = now * 0.0012 + i;
        r.mesh.position.y += Math.sin(now * 0.0016 + i * 0.8) * 0.006;
      });
      // Trampoline squash-and-stretch after a launch.
      const squash = now < squashUntil ? 1 - 0.5 * Math.sin(((squashUntil - now) / 400) * Math.PI) : 1;
      padSkin.scale.setScalar(squash < 1 ? 1.15 : 1);
      padSkin.position.y = 0.42 - (1 - squash) * 0.25;
      // Ring set respawns after the victory lap.
      if (respawnAt > 0 && now >= respawnAt) {
        respawnAt = 0;
        for (const r of rings) {
          r.taken = false;
          r.mesh.visible = true;
        }
      }
    },
  };
}
