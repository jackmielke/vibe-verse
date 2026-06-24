/**
 * underground — the Gremlin Mines. A pocket dimension carved deep
 * below the world (centered at UNDER_Y, far from the surface scene).
 *
 * Lore: half the God Orb is missing. The gremlins burrowed it down
 * here and are mining it for its light. You drop in as a ninja,
 * fight through the cavern, defeat the BOSS GREMLIN, and recover a
 * shard. Stomp gremlins from above (Mars-style); the boss takes
 * three stomps and gets angrier each time.
 *
 * Physics reuse: we register the floor as a WorldBox so the existing
 * City.tsx player physics treat it like any other surface — gravity,
 * jumping, wall-jumping all just work. Jetpack is disabled at the
 * caller level whenever the player is below y = UNDER_CEILING.
 */
import * as THREE from "three";
import type { WorldBox } from "./cardboardIsland";
import { makeGremlin } from "./mars";

export interface UndergroundPlayerSample {
  pos: THREE.Vector3;
  velY: number;
}

export interface UndergroundTickEvents {
  stomps: number;
  hit: boolean;
  bossStomped: boolean;
  bossDefeated: boolean;
}

export interface UndergroundWorld {
  group: THREE.Group;
  /** World position the player spawns at when entering. */
  spawn: THREE.Vector3;
  /** World position of the exit ring (return to surface). */
  exit: THREE.Vector3;
  /** Centre of the cavern (for distance checks). */
  center: THREE.Vector3;
  /** True if the player's Y is inside the cavern volume. */
  isInside(pos: THREE.Vector3): boolean;
  update(dt: number, now: number): void;
  processPlayer(p: UndergroundPlayerSample, dt: number, now: number): UndergroundTickEvents;
  reset(): void;
  bossHpRemaining(): number;
}

const FLOOR_R = 70;
const FLOOR_THICKNESS = 4;
const CEILING_H = 26;       // height of cavern ceiling above floor
const GREMLIN_COUNT = 8;
const BOSS_HP = 3;

// Behaviour timing (mirrors mars.ts so the feel is consistent).
const BURROW_INTERVAL: readonly [number, number] = [5, 9];
const BURROW_TIME = 0.9;
const UNDERGROUND_TIME: readonly [number, number] = [1.4, 3];
const EMERGE_TIME = 0.8;
const STOMP_HEAD_Y = 1.2;
const STOMP_RANGE = 1.4;
const HIT_RANGE = 1.05;
const STOMP_MIN_FALL = 0.5;

function caveFloorTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  // Dark slate base with violet undertone.
  const grad = ctx.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, W / 1.4);
  grad.addColorStop(0, "#2b1a3d");
  grad.addColorStop(0.6, "#1a0f28");
  grad.addColorStop(1, "#0a0612");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // Speckle.
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = `rgba(${20 + Math.random() * 60},${15 + Math.random() * 30},${
      40 + Math.random() * 70
    },${0.05 + Math.random() * 0.25})`;
    ctx.fillRect(Math.random() * W, Math.random() * H, 1.4, 1.4);
  }
  // Gold veins.
  for (let i = 0; i < 22; i++) {
    ctx.strokeStyle = `rgba(255,${180 + Math.random() * 60},80,${0.25 + Math.random() * 0.45})`;
    ctx.lineWidth = 1 + Math.random() * 2;
    ctx.beginPath();
    let x = Math.random() * W;
    let y = Math.random() * H;
    ctx.moveTo(x, y);
    for (let s = 0; s < 8; s++) {
      x += (Math.random() - 0.5) * 80;
      y += (Math.random() - 0.5) * 80;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeLoreSign(title: string, body: string[]): THREE.Mesh {
  const W = 512;
  const H = 320;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#0c0618";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#b78aff";
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, W - 16, H - 16);
  ctx.fillStyle = "#e3d2ff";
  ctx.font = "bold 36px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(title, W / 2, 60);
  ctx.fillStyle = "#cbb8ff";
  ctx.font = "20px ui-sans-serif, system-ui, sans-serif";
  body.forEach((ln, i) => ctx.fillText(ln, W / 2, 110 + i * 28));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(4.4, 2.75),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }),
  );
  return m;
}

function makeBoss(): THREE.Group {
  // Reuse the gremlin recipe but scaled up, with crown spikes + crimson tint.
  const g = makeGremlin();
  g.scale.setScalar(2.4);
  // Tint the body emissive to crimson so the boss reads as "angry".
  g.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (m && "emissive" in m) {
      m.emissive = new THREE.Color("#5a0f1a");
      m.color = new THREE.Color("#6c1f2a").lerp(new THREE.Color("#3ddc7a"), 0.25);
    }
  });
  // Crown of spikes.
  const spikeMat = new THREE.MeshStandardMaterial({
    color: "#1a0a14",
    emissive: "#ff3a5c",
    emissiveIntensity: 0.6,
    roughness: 0.5,
  });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.55, 8), spikeMat);
    spike.position.set(Math.cos(a) * 0.32, 1.32, Math.sin(a) * 0.32);
    g.add(spike);
  }
  // Shard glow — the half of the God Orb the boss carries.
  const shard = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.45, 0),
    new THREE.MeshBasicMaterial({
      color: "#fff2a0",
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  shard.position.set(0, 1.85, 0);
  shard.name = "boss-shard";
  g.add(shard);
  return g;
}

export function buildUnderground(opts: {
  centerX: number;
  centerY: number;
  centerZ: number;
  boxes: WorldBox[];
}): UndergroundWorld {
  const { centerX, centerY, centerZ, boxes } = opts;
  const group = new THREE.Group();
  group.position.set(centerX, centerY, centerZ);

  // ---- Cavern shell: floor disc + domed ceiling -----------------------
  const floorMat = new THREE.MeshStandardMaterial({
    map: caveFloorTexture(),
    roughness: 0.95,
    metalness: 0.1,
  });
  const floor = new THREE.Mesh(
    new THREE.CylinderGeometry(FLOOR_R, FLOOR_R * 1.05, FLOOR_THICKNESS, 48),
    floorMat,
  );
  floor.position.y = -FLOOR_THICKNESS / 2;
  group.add(floor);

  // Collide-able floor box so City.tsx physics treats this like ground.
  boxes.push({
    minX: centerX - FLOOR_R,
    maxX: centerX + FLOOR_R,
    minZ: centerZ - FLOOR_R,
    maxZ: centerZ + FLOOR_R,
    base: centerY - FLOOR_THICKNESS,
    height: centerY,
  });

  // Dome ceiling — interior view only.
  const ceilingMat = new THREE.MeshStandardMaterial({
    color: "#1a0f28",
    roughness: 1,
    side: THREE.BackSide,
    emissive: "#180828",
    emissiveIntensity: 0.15,
  });
  const ceiling = new THREE.Mesh(
    new THREE.SphereGeometry(FLOOR_R * 1.05, 40, 24, 0, Math.PI * 2, 0, Math.PI / 2),
    ceilingMat,
  );
  ceiling.position.y = 0;
  ceiling.scale.y = CEILING_H / (FLOOR_R * 1.05);
  group.add(ceiling);

  // ---- Lighting: dim purple ambient + warm gold pool from mine veins ---
  const amb = new THREE.AmbientLight(0x4a2a72, 0.55);
  group.add(amb);
  const torch = new THREE.PointLight(0xff9a55, 22, 60, 1.8);
  torch.position.set(0, 8, 0);
  group.add(torch);
  // A few side torches for atmosphere.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const tl = new THREE.PointLight(0xb78aff, 12, 36, 2);
    tl.position.set(Math.cos(a) * (FLOOR_R - 8), 4, Math.sin(a) * (FLOOR_R - 8));
    group.add(tl);
  }

  // ---- Decorative stalactites + gold nugget piles ----------------------
  const stoneMat = new THREE.MeshStandardMaterial({ color: "#2a1640", roughness: 1 });
  const goldMat = new THREE.MeshStandardMaterial({
    color: "#ffcc55",
    emissive: "#a06a10",
    emissiveIntensity: 0.45,
    roughness: 0.4,
    metalness: 0.7,
  });
  for (let i = 0; i < 24; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 6 + Math.random() * (FLOOR_R - 12);
    // Stalactite from ceiling
    const h = 2 + Math.random() * 5;
    const stal = new THREE.Mesh(new THREE.ConeGeometry(0.6 + Math.random() * 0.7, h, 8), stoneMat);
    stal.position.set(Math.cos(a) * r, CEILING_H - h / 2 - 0.5, Math.sin(a) * r);
    stal.rotation.x = Math.PI;
    group.add(stal);
  }
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 8 + Math.random() * (FLOOR_R - 14);
    const pile = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.5 + Math.random() * 0.7, 0),
      goldMat,
    );
    pile.position.set(Math.cos(a) * r, 0.35, Math.sin(a) * r);
    pile.rotation.set(Math.random(), Math.random(), Math.random());
    group.add(pile);
  }

  // ---- Entry mist column (purple) at the spawn point ------------------
  // This is the column you fall through. Purely visual — the jetpack
  // block is enforced by City.tsx whenever the player is in the cavern.
  const mist = new THREE.Mesh(
    new THREE.CylinderGeometry(3.2, 4.2, CEILING_H, 24, 1, true),
    new THREE.MeshBasicMaterial({
      color: "#b78aff",
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    }),
  );
  mist.position.set(0, CEILING_H / 2, 0);
  group.add(mist);

  // ---- Exit ring: stand on it to return to the surface ----------------
  const exitGroup = new THREE.Group();
  exitGroup.position.set(FLOOR_R * 0.55, 0.1, 0);
  const exitRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.6, 0.18, 14, 36),
    new THREE.MeshBasicMaterial({
      color: "#7aebff",
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  exitRing.rotation.x = Math.PI / 2;
  exitRing.position.y = 0.05;
  exitGroup.add(exitRing);
  const exitBeam = new THREE.Mesh(
    new THREE.CylinderGeometry(1.4, 1.4, CEILING_H, 20, 1, true),
    new THREE.MeshBasicMaterial({
      color: "#7aebff",
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    }),
  );
  exitBeam.position.y = CEILING_H / 2;
  exitGroup.add(exitBeam);
  group.add(exitGroup);

  // ---- Lore plaque ----------------------------------------------------
  const sign = makeLoreSign("⚔  THE GREMLIN MINES  ⚔", [
    "Half the God Orb was stolen and dragged",
    "down here. The gremlins are mining its",
    "light to feed their negativity.",
    "",
    "STOMP the gremlins. Crush the BOSS.",
    "Recover the shard. Power the world.",
  ]);
  sign.position.set(-FLOOR_R * 0.55, 4, -2);
  sign.rotation.y = Math.PI / 6;
  group.add(sign);

  // ---- Mini gremlin clan (Mars logic, ported) -------------------------
  type GState = "roaming" | "dying" | "burrowing" | "underground" | "emerging";
  interface Gremlin {
    mesh: THREE.Group;
    targetX: number;
    targetZ: number;
    vx: number;
    vz: number;
    bob: number;
    state: GState;
    stateT: number;
    nextBurrow: number;
    alive: boolean;
  }
  const gremlins: Gremlin[] = [];

  const randSpot = () => {
    const a = Math.random() * Math.PI * 2;
    const r = 4 + Math.random() * (FLOOR_R - 10);
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  };
  const rb = () =>
    BURROW_INTERVAL[0] + Math.random() * (BURROW_INTERVAL[1] - BURROW_INTERVAL[0]);
  const ru = () =>
    UNDERGROUND_TIME[0] + Math.random() * (UNDERGROUND_TIME[1] - UNDERGROUND_TIME[0]);

  for (let i = 0; i < GREMLIN_COUNT; i++) {
    const m = makeGremlin();
    const p = randSpot();
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
      nextBurrow: rb(),
      alive: true,
    });
  }

  // ---- Boss ----------------------------------------------------------
  const boss = makeBoss();
  boss.position.set(-FLOOR_R * 0.3, 0.05, FLOOR_R * 0.3);
  group.add(boss);
  let bossHp = BOSS_HP;
  let bossAlive = true;
  let bossInvuln = 0;
  let bossTargetX = boss.position.x;
  let bossTargetZ = boss.position.z;
  let bossBob = 0;

  const tickGremlin = (g: Gremlin, dt: number) => {
    if (g.state === "roaming") {
      g.nextBurrow -= dt;
      if (Math.random() < dt * 0.4) {
        const p = randSpot();
        g.targetX = p.x;
        g.targetZ = p.z;
      }
      const dx = g.targetX - g.mesh.position.x;
      const dz = g.targetZ - g.mesh.position.z;
      const d = Math.hypot(dx, dz);
      const speed = 2.3;
      if (d > 0.05) {
        g.vx = (dx / d) * speed;
        g.vz = (dz / d) * speed;
      }
      g.mesh.position.x += g.vx * dt;
      g.mesh.position.z += g.vz * dt;
      const r = Math.hypot(g.mesh.position.x, g.mesh.position.z);
      if (r > FLOOR_R - 4) {
        g.mesh.position.x *= (FLOOR_R - 4) / r;
        g.mesh.position.z *= (FLOOR_R - 4) / r;
      }
      g.bob += dt;
      g.mesh.position.y = 0.05 + Math.sin(g.bob * 4) * 0.22;
      g.mesh.rotation.y = Math.atan2(g.vx, g.vz);
      if (g.nextBurrow <= 0) {
        g.state = "burrowing";
        g.stateT = BURROW_TIME;
      }
    } else if (g.state === "burrowing") {
      g.stateT -= dt;
      const t = 1 - Math.max(0, g.stateT) / BURROW_TIME;
      g.mesh.position.y = 0.05 - t * 2.2;
      g.mesh.rotation.y += dt * 6;
      if (g.stateT <= 0) {
        g.state = "underground";
        g.stateT = ru();
        g.mesh.visible = false;
      }
    } else if (g.state === "underground") {
      g.stateT -= dt;
      if (g.stateT <= 0) {
        const p = randSpot();
        g.mesh.position.set(p.x, -2.2, p.z);
        g.targetX = p.x;
        g.targetZ = p.z;
        g.mesh.visible = true;
        g.state = "emerging";
        g.stateT = EMERGE_TIME;
      }
    } else if (g.state === "emerging") {
      g.stateT -= dt;
      const t = 1 - Math.max(0, g.stateT) / EMERGE_TIME;
      g.mesh.position.y = -2.2 + t * 2.25;
      g.mesh.rotation.y += dt * 4;
      if (g.stateT <= 0) {
        g.state = "roaming";
        g.nextBurrow = rb();
        g.mesh.position.y = 0.05;
        g.bob = 0;
      }
    } else if (g.state === "dying") {
      g.stateT -= dt;
      const t = 1 - Math.max(0, g.stateT) / 0.4;
      g.mesh.scale.setScalar(Math.max(0.001, 1 - t));
      g.mesh.rotation.y += dt * 12;
      if (g.stateT <= 0) g.mesh.visible = false;
    }
  };

  return {
    group,
    spawn: new THREE.Vector3(centerX, centerY + 8, centerZ),
    exit: new THREE.Vector3(centerX + FLOOR_R * 0.55, centerY, centerZ),
    center: new THREE.Vector3(centerX, centerY, centerZ),
    isInside(pos) {
      return (
        pos.y < centerY + CEILING_H + 4 &&
        pos.y > centerY - 20 &&
        Math.hypot(pos.x - centerX, pos.z - centerZ) < FLOOR_R + 6
      );
    },
    update(dt, now) {
      exitRing.rotation.z += dt * 1.4;
      (exitBeam.material as THREE.MeshBasicMaterial).opacity =
        0.14 + Math.sin(now * 0.003) * 0.06;
      (mist.material as THREE.MeshBasicMaterial).opacity =
        0.18 + Math.sin(now * 0.0018) * 0.06;
      gremlins.forEach((g) => tickGremlin(g, dt));
      if (bossAlive) {
        bossBob += dt;
        if (bossInvuln > 0) bossInvuln -= dt;
        // Slow drift toward target, re-aim periodically.
        if (Math.random() < dt * 0.25) {
          const p = randSpot();
          bossTargetX = p.x;
          bossTargetZ = p.z;
        }
        const dx = bossTargetX - boss.position.x;
        const dz = bossTargetZ - boss.position.z;
        const d = Math.hypot(dx, dz);
        const speed = 1.4 + (BOSS_HP - bossHp) * 0.6; // angrier as HP drops
        if (d > 0.1) {
          boss.position.x += (dx / d) * speed * dt;
          boss.position.z += (dz / d) * speed * dt;
        }
        boss.position.y = 0.05 + Math.sin(bossBob * 3) * 0.35;
        boss.rotation.y += dt * (0.6 + (BOSS_HP - bossHp) * 0.4);
        // Flash on invuln
        const shard = boss.getObjectByName("boss-shard") as THREE.Mesh | null;
        if (shard) {
          (shard.material as THREE.MeshBasicMaterial).opacity =
            0.75 + Math.sin(now * 0.01) * 0.2;
        }
      }
    },
    processPlayer(p, _dt, _now) {
      const events: UndergroundTickEvents = {
        stomps: 0,
        hit: false,
        bossStomped: false,
        bossDefeated: false,
      };
      // Gremlins
      for (const g of gremlins) {
        if (!g.alive || g.state !== "roaming") continue;
        const gx = centerX + g.mesh.position.x;
        const gz = centerZ + g.mesh.position.z;
        const gy = centerY + g.mesh.position.y;
        const dx = p.pos.x - gx;
        const dz = p.pos.z - gz;
        const d = Math.hypot(dx, dz);
        if (d > 2.0) continue;
        const headY = gy + STOMP_HEAD_Y;
        if (p.velY < -STOMP_MIN_FALL && p.pos.y >= headY - 0.4 && d < STOMP_RANGE) {
          g.alive = false;
          g.state = "dying";
          g.stateT = 0.4;
          events.stomps++;
          continue;
        }
        if (Math.abs(p.pos.y - gy) < 1.6 && d < HIT_RANGE) events.hit = true;
      }
      // Boss
      if (bossAlive) {
        const bx = centerX + boss.position.x;
        const bz = centerZ + boss.position.z;
        const by = centerY + boss.position.y;
        const dx = p.pos.x - bx;
        const dz = p.pos.z - bz;
        const d = Math.hypot(dx, dz);
        if (d < 3.2) {
          const headY = by + STOMP_HEAD_Y * 2.4;
          if (
            bossInvuln <= 0 &&
            p.velY < -STOMP_MIN_FALL &&
            p.pos.y >= headY - 0.6 &&
            d < STOMP_RANGE * 2
          ) {
            bossHp--;
            bossInvuln = 1.2;
            events.bossStomped = true;
            if (bossHp <= 0) {
              bossAlive = false;
              events.bossDefeated = true;
              boss.visible = false;
            }
          } else if (Math.abs(p.pos.y - by) < 2.2 && d < HIT_RANGE * 1.8) {
            events.hit = true;
          }
        }
      }
      return events;
    },
    reset() {
      gremlins.forEach((g) => {
        const p = randSpot();
        g.alive = true;
        g.state = "roaming";
        g.stateT = 0;
        g.nextBurrow = rb();
        g.mesh.visible = true;
        g.mesh.scale.setScalar(1);
        g.mesh.position.set(p.x, 0.05, p.z);
        g.targetX = p.x;
        g.targetZ = p.z;
        g.bob = Math.random() * Math.PI * 2;
      });
      bossHp = BOSS_HP;
      bossAlive = true;
      boss.visible = true;
      boss.position.set(-FLOOR_R * 0.3, 0.05, FLOOR_R * 0.3);
      bossInvuln = 0;
    },
    bossHpRemaining: () => bossHp,
  };
}

/** Helper: build a small obsidian ninja portal mesh (entrance prop). */
export function makeNinjaPortal(): THREE.Group {
  const g = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({
    color: "#1a0a1a",
    roughness: 0.6,
    metalness: 0.5,
    emissive: "#3a1052",
    emissiveIntensity: 0.4,
  });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.5, 0.4, 24), stone);
  base.position.y = 0.2;
  g.add(base);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.05, 0.14, 14, 36),
    new THREE.MeshBasicMaterial({
      color: "#b78aff",
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.45;
  g.add(ring);
  const inner = new THREE.Mesh(
    new THREE.CircleGeometry(0.95, 32),
    new THREE.MeshBasicMaterial({
      color: "#2a0a3a",
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  inner.rotation.x = -Math.PI / 2;
  inner.position.y = 0.46;
  g.add(inner);
  const swirl = new THREE.Mesh(
    new THREE.CircleGeometry(0.85, 32),
    new THREE.MeshBasicMaterial({
      color: "#7aebff",
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
  );
  swirl.rotation.x = -Math.PI / 2;
  swirl.position.y = 0.47;
  g.add(swirl);
  const light = new THREE.PointLight(0xb78aff, 6, 8, 2);
  light.position.set(0, 1.2, 0);
  g.add(light);
  (g as unknown as { __ring: THREE.Mesh }).__ring = ring;
  (g as unknown as { __swirl: THREE.Mesh }).__swirl = swirl;
  return g;
}
