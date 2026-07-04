/**
 * rebelDefense — THE VIBE STAR: a wave shooter on the second moon.
 *
 * The grey battle-station moon finally shows its true colors: grab the
 * blaster from the rack and hold the landing pad against waves of
 * DOOM TROOPERS — white-armored goons who jog between cover and shoot
 * back with famously terrible aim (the spread is a design pillar).
 *
 * Everything is real projectiles: teal bolts out, red bolts in, both
 * dodgeable. Auto-aim picks your nearest trooper so it plays great on
 * phones with a single FIRE button.
 *
 * (A loving, legally-distinct homage. Any resemblance to space
 * stations from a galaxy far, far away is purely vibes.)
 */
import * as THREE from "three";
import { signTexture, type WorldBox } from "@/components/city/cardboardIsland";

const TROOPER_SPEED = 3.4;
const ENEMY_BOLT_SPEED = 26;
const PLAYER_BOLT_SPEED = 62;
const ENEMY_SPREAD = 0.35; // radians of wobble — they could not hit a barn
const FIRE_RANGE = 48;
const PLAYER_MAX_HP = 5;

interface Trooper {
  g: THREE.Group;
  hp: number;
  target: THREE.Vector3;
  pauseUntil: number;
  shotAt: number;
  alive: boolean;
  bob: number;
}

interface Bolt {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  friendly: boolean;
  born: number;
}

export interface RebelDefense {
  group: THREE.Group;
  update(dt: number, now: number, playerPos: THREE.Vector3): void;
  start(): void;
  stop(): void;
  /** Fire at the nearest living trooper. Returns true if a bolt left. */
  fire(playerPos: THREE.Vector3): boolean;
  nearRack(playerPos: THREE.Vector3): boolean;
  state(): { active: boolean; wave: number; kills: number; hp: number };
  onKill: ((kills: number) => void) | null;
  onWave: ((wave: number) => void) | null;
  onPlayerHit: ((hp: number) => void) | null;
  onDefeat: (() => void) | null;
}

export function buildRebelDefense(opts: {
  cx: number;
  cz: number;
  topY: number;
  padHalf: number;
  boxes: WorldBox[];
}): RebelDefense {
  const { cx, cz, topY, padHalf, boxes } = opts;
  const group = new THREE.Group();

  // ---- Set dressing: rack, banner, crate cover -----------------------
  const rackPos = new THREE.Vector3(cx - padHalf + 3, topY, cz);
  {
    const rack = new THREE.Group();
    rack.position.copy(rackPos);
    const post = new THREE.MeshStandardMaterial({ color: "#3a4450", roughness: 0.6, metalness: 0.4 });
    const stand = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.2, 0.4), post);
    stand.position.y = 0.6;
    rack.add(stand);
    // The blaster on display: chunky sci-fi rifle silhouette.
    const rifle = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.16, 0.12), new THREE.MeshStandardMaterial({ color: "#14181f", roughness: 0.4, metalness: 0.5 }));
    rifle.add(body);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 8), new THREE.MeshStandardMaterial({ color: "#2b323d", roughness: 0.35, metalness: 0.6 }));
    barrel.rotation.z = Math.PI / 2;
    barrel.position.set(0.7, 0.02, 0);
    rifle.add(barrel);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.22, 0.1), body.material);
    grip.position.set(-0.25, -0.16, 0);
    rifle.add(grip);
    const glow = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.14), new THREE.MeshBasicMaterial({ color: "#4defd0" }));
    glow.position.set(0.2, 0.06, 0);
    rifle.add(glow);
    rifle.position.y = 1.35;
    rifle.rotation.z = -0.18;
    rack.add(rifle);
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(5.4, 1.3),
      new THREE.MeshBasicMaterial({
        map: signTexture(["⭐ REBEL DEFENSE · grab the blaster"], "#101826", "#ff5b5b", true),
        side: THREE.DoubleSide,
        transparent: true,
      }),
    );
    banner.position.set(0, 3.1, 0);
    banner.rotation.y = Math.PI / 2; // face across the pad
    rack.add(banner);
    group.add(rack);
  }
  // Crate barricades — real cover (they collide).
  const crateMat = new THREE.MeshStandardMaterial({ color: "#4b5563", roughness: 0.7, metalness: 0.25 });
  const crateGlow = new THREE.MeshBasicMaterial({ color: "#4defd0" });
  for (const [dx, dz, w] of [[-3, -6, 2.4], [4, 5, 2.0], [-5, 6, 2.0], [6, -4, 2.4]] as Array<[number, number, number]>) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(w, 1.3, 1.1), crateMat);
    crate.position.set(cx + dx, topY + 0.65, cz + dz);
    crate.rotation.y = dx * 0.3;
    group.add(crate);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(w * 0.8, 0.06, 0.06), crateGlow);
    strip.position.set(cx + dx, topY + 1.34, cz + dz);
    strip.rotation.y = dx * 0.3;
    group.add(strip);
    boxes.push({
      minX: cx + dx - w / 2 - 0.2, maxX: cx + dx + w / 2 + 0.2,
      minZ: cz + dz - 0.75, maxZ: cz + dz + 0.75,
      base: topY, height: topY + 1.3,
    });
  }

  // ---- Trooper factory -------------------------------------------------
  const white = new THREE.MeshStandardMaterial({ color: "#f2f4f8", roughness: 0.35, metalness: 0.1 });
  const black = new THREE.MeshStandardMaterial({ color: "#0c0e12", roughness: 0.5 });
  const makeTrooper = (): THREE.Group => {
    const t = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.65, 4, 10), white);
    torso.position.y = 1.0;
    t.add(torso);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10), white);
    helmet.position.y = 1.72;
    t.add(helmet);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.2), black);
    visor.position.set(0, 1.72, 0.18);
    t.add(visor);
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.4, 0.16), black);
    pack.position.set(0, 1.15, -0.32);
    t.add(pack);
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.4, 4, 8), white);
      leg.position.set(side * 0.16, 0.38, 0);
      t.add(leg);
    }
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.08), black);
    gun.position.set(0.32, 1.05, 0.25);
    t.add(gun);
    return t;
  };

  // ---- Game state --------------------------------------------------------
  let active = false;
  let wave = 0;
  let kills = 0;
  let hp = PLAYER_MAX_HP;
  let troopers: Trooper[] = [];
  let bolts: Bolt[] = [];
  let waveBreakUntil = 0;

  const boltGeo = new THREE.CylinderGeometry(0.045, 0.045, 1.15, 6);
  const friendlyMat = new THREE.MeshBasicMaterial({ color: "#4defd0" });
  const enemyMat = new THREE.MeshBasicMaterial({ color: "#ff4444" });

  const randomPadPoint = () =>
    new THREE.Vector3(
      cx + (Math.random() * 2 - 1) * (padHalf - 2),
      topY,
      cz + (Math.random() * 2 - 1) * (padHalf - 2),
    );

  const spawnWave = (n: number, now: number) => {
    const count = 2 + n;
    for (let i = 0; i < count; i++) {
      const g = makeTrooper();
      // Enter from the pad's rim.
      const a = Math.random() * Math.PI * 2;
      g.position.set(cx + Math.cos(a) * (padHalf - 1), topY, cz + Math.sin(a) * (padHalf - 1));
      group.add(g);
      troopers.push({
        g,
        hp: n >= 3 ? 2 : 1,
        target: randomPadPoint(),
        pauseUntil: 0,
        shotAt: now + 1000 + Math.random() * 2000,
        alive: true,
        bob: Math.random() * Math.PI * 2,
      });
    }
  };

  const clearField = () => {
    for (const t of troopers) group.remove(t.g);
    for (const b of bolts) group.remove(b.mesh);
    troopers = [];
    bolts = [];
  };

  const spawnBolt = (from: THREE.Vector3, dir: THREE.Vector3, friendly: boolean, now: number) => {
    const mesh = new THREE.Mesh(boltGeo, friendly ? friendlyMat : enemyMat);
    mesh.position.copy(from);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    group.add(mesh);
    bolts.push({
      mesh,
      vel: dir.clone().multiplyScalar(friendly ? PLAYER_BOLT_SPEED : ENEMY_BOLT_SPEED),
      friendly,
      born: now,
    });
  };

  const api: RebelDefense = {
    group,
    onKill: null,
    onWave: null,
    onPlayerHit: null,
    onDefeat: null,
    nearRack: (p) => p.distanceTo(rackPos) < 5,
    state: () => ({ active, wave, kills, hp }),
    start() {
      if (active) return;
      active = true;
      wave = 1;
      kills = 0;
      hp = PLAYER_MAX_HP;
      clearField();
      spawnWave(wave, performance.now());
    },
    stop() {
      active = false;
      clearField();
    },
    fire(playerPos) {
      if (!active) return false;
      let best: Trooper | null = null;
      let bd = FIRE_RANGE;
      for (const t of troopers) {
        if (!t.alive) continue;
        const d = playerPos.distanceTo(t.g.position);
        if (d < bd) { bd = d; best = t; }
      }
      if (!best) return false;
      const from = playerPos.clone().add(new THREE.Vector3(0, 1.2, 0));
      const aim = best.g.position.clone().add(new THREE.Vector3(0, 1.1, 0)).sub(from).normalize();
      // Tiny spread so it's not a hitscan laser-pointer.
      aim.x += (Math.random() - 0.5) * 0.04;
      aim.z += (Math.random() - 0.5) * 0.04;
      aim.normalize();
      spawnBolt(from, aim, true, performance.now());
      return true;
    },
    update(dt, now, playerPos) {
      if (!active) return;

      // Wave flow.
      const aliveCount = troopers.filter((t) => t.alive).length;
      if (aliveCount === 0 && waveBreakUntil === 0) {
        waveBreakUntil = now + 3500;
        api.onWave?.(wave);
      }
      if (waveBreakUntil > 0 && now >= waveBreakUntil) {
        waveBreakUntil = 0;
        wave++;
        spawnWave(wave, now);
      }

      // Troopers: jog between points, occasionally stop and (badly) shoot.
      for (const t of troopers) {
        if (!t.alive) continue;
        t.bob += dt * 10;
        if (now < t.pauseUntil) {
          // Standing still — face the player and maybe fire.
          const face = Math.atan2(playerPos.x - t.g.position.x, playerPos.z - t.g.position.z);
          t.g.rotation.y = face;
          if (now >= t.shotAt) {
            t.shotAt = now + 1400 + Math.random() * 1600;
            const from = t.g.position.clone().add(new THREE.Vector3(0, 1.3, 0));
            const dir = playerPos.clone().add(new THREE.Vector3(0, 0.9, 0)).sub(from).normalize();
            dir.x += (Math.random() - 0.5) * ENEMY_SPREAD;
            dir.y += (Math.random() - 0.5) * ENEMY_SPREAD * 0.5;
            dir.z += (Math.random() - 0.5) * ENEMY_SPREAD;
            dir.normalize();
            spawnBolt(from, dir, false, now);
          }
        } else {
          const to = t.target.clone().sub(t.g.position);
          to.y = 0;
          const d = to.length();
          if (d < 0.6) {
            // Arrived: pause to shoot, then pick a new dash point.
            t.pauseUntil = now + 1200 + Math.random() * 1800;
            t.shotAt = now + 300 + Math.random() * 700;
            t.target = randomPadPoint();
          } else {
            to.normalize();
            t.g.position.x += to.x * TROOPER_SPEED * dt;
            t.g.position.z += to.z * TROOPER_SPEED * dt;
            t.g.rotation.y = Math.atan2(to.x, to.z);
            t.g.position.y = topY + Math.abs(Math.sin(t.bob)) * 0.12; // jog hop
          }
        }
      }

      // Bolts: fly, collide, expire.
      for (let i = bolts.length - 1; i >= 0; i--) {
        const b = bolts[i];
        b.mesh.position.addScaledVector(b.vel, dt);
        let dead = now - b.born > 2600;
        if (b.friendly) {
          for (const t of troopers) {
            if (!t.alive) continue;
            const dx = b.mesh.position.x - t.g.position.x;
            const dy = b.mesh.position.y - (t.g.position.y + 1.0);
            const dz = b.mesh.position.z - t.g.position.z;
            if (dx * dx + dy * dy + dz * dz < 1.1) {
              t.hp--;
              dead = true;
              if (t.hp <= 0) {
                t.alive = false;
                kills++;
                // Defeat pose: tip over, sink, remove.
                t.g.rotation.x = Math.PI / 2;
                window.setTimeout(() => group.remove(t.g), 1200);
                api.onKill?.(kills);
              }
              break;
            }
          }
        } else {
          const dx = b.mesh.position.x - playerPos.x;
          const dy = b.mesh.position.y - (playerPos.y + 0.9);
          const dz = b.mesh.position.z - playerPos.z;
          if (dx * dx + dy * dy + dz * dz < 0.85) {
            dead = true;
            hp--;
            api.onPlayerHit?.(hp);
            if (hp <= 0) {
              api.onDefeat?.();
              api.stop();
            }
          }
        }
        if (dead) {
          group.remove(b.mesh);
          bolts.splice(i, 1);
        }
      }

      // Wandered off the station? Stand down.
      if (Math.hypot(playerPos.x - cx, playerPos.z - cz) > padHalf * 3.5) {
        api.stop();
      }
    },
  };
  return api;
}
