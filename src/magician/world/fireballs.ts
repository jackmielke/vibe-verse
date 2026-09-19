/**
 * Fireballs from the mountain.
 *
 * The one gameplay system in the valley, and it exists to demonstrate a
 * single sentence: *the world's rules are the world's state*. A fireball is
 * a ball of fire flying at the player. Rain, storm and snow are wet. Wet puts
 * fire out. So when a visitor says "make it rain" mid-attack, every fireball
 * in the air hisses into steam and the attack stops — not because anybody
 * wrote a rule about rain and fireballs, but because `fireballsFizzle()` reads
 * the same weather everything else does.
 */
import * as THREE from "three";
import { makeSoftDot } from "./sky";

export interface FireballHit {
  /** Where the player was, for the flash. */
  x: number;
  z: number;
}

export interface Fireballs {
  group: THREE.Group;
  update(dt: number, opts: { on: boolean; rate: number; wet: boolean; player: THREE.Vector3; heightAt(x: number, z: number): number }): FireballHit | null;
  /** Live count, for the HUD and for tests. */
  count(): number;
  fizzled(): number;
  dispose(): void;
}

interface Ball {
  mesh: THREE.Mesh;
  light: THREE.PointLight;
  vel: THREE.Vector3;
  age: number;
  /** >0 once the weather has got to it. */
  steam: number;
  trail: THREE.Points;
  trailPos: Float32Array;
  trailHead: number;
}

const ORIGIN = new THREE.Vector3(110, 118, -120);

export function createFireballs(): Fireballs {
  const group = new THREE.Group();
  const balls: Ball[] = [];
  const geo = new THREE.SphereGeometry(0.55, 12, 10);
  const fireMat = new THREE.MeshBasicMaterial({ color: "#ff8a1f" });
  const steamMat = new THREE.MeshBasicMaterial({ color: "#c8ccd4", transparent: true, opacity: 0.8 });
  const trailTex = makeSoftDot("#ffb060");
  const trailMat = new THREE.PointsMaterial({ map: trailTex, color: "#ff9a30", size: 0.9, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9 });
  let spawnAcc = 0;
  let fizzledTotal = 0;
  const tmp = new THREE.Vector3();

  function launch(target: THREE.Vector3) {
    const mesh = new THREE.Mesh(geo, fireMat);
    mesh.position.copy(ORIGIN);
    mesh.position.x += (Math.random() - 0.5) * 20;
    mesh.position.z += (Math.random() - 0.5) * 20;
    const light = new THREE.PointLight("#ff8a1f", 3, 16, 2);
    mesh.add(light);
    // Aim at the player with a little lead and a little error, lobbed.
    const dir = tmp.copy(target).sub(mesh.position);
    const dist = dir.length();
    const speed = Math.max(26, Math.min(48, dist / 3.2));
    dir.normalize().multiplyScalar(speed);
    dir.y += 9;
    dir.x += (Math.random() - 0.5) * 3;
    dir.z += (Math.random() - 0.5) * 3;
    const n = 14;
    const trailPos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) trailPos.set([mesh.position.x, mesh.position.y, mesh.position.z], i * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
    const trail = new THREE.Points(tg, trailMat);
    trail.frustumCulled = false;
    group.add(mesh, trail);
    balls.push({ mesh, light, vel: dir.clone(), age: 0, steam: 0, trail, trailPos, trailHead: 0 });
  }

  function kill(i: number) {
    const b = balls[i];
    group.remove(b.mesh, b.trail);
    b.trail.geometry.dispose();
    balls.splice(i, 1);
  }

  return {
    group,
    update(dt, opts) {
      let hit: FireballHit | null = null;
      if (opts.on) {
        spawnAcc += dt * opts.rate;
        while (spawnAcc >= 1 && balls.length < 24) { spawnAcc -= 1; launch(opts.player); }
      } else spawnAcc = 0;
      for (let i = balls.length - 1; i >= 0; i--) {
        const b = balls[i];
        b.age += dt;
        if (opts.wet && b.steam === 0) { b.steam = 0.001; fizzledTotal++; b.mesh.material = steamMat; b.light.intensity = 0; }
        if (b.steam > 0) {
          b.steam += dt;
          b.mesh.scale.setScalar(1 + b.steam * 2.5);
          b.vel.multiplyScalar(Math.max(0, 1 - dt * 3));
          b.vel.y += dt * 2;
          steamMat.opacity = 0.7;
          b.mesh.position.addScaledVector(b.vel, dt);
          b.trail.visible = false;
          if (b.steam > 1.6) kill(i);
          continue;
        }
        b.vel.y -= 9.8 * dt;
        b.mesh.position.addScaledVector(b.vel, dt);
        b.mesh.rotation.x += dt * 5;
        b.light.intensity = 2.5 + Math.sin(b.age * 30) * 0.8;
        // Trail ring buffer.
        b.trailPos.set([b.mesh.position.x, b.mesh.position.y, b.mesh.position.z], b.trailHead * 3);
        b.trailHead = (b.trailHead + 1) % 14;
        (b.trail.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        const ground = opts.heightAt(b.mesh.position.x, b.mesh.position.z);
        const d = b.mesh.position.distanceTo(opts.player);
        if (d < 1.6) {
          hit = { x: opts.player.x, z: opts.player.z };
          kill(i);
          continue;
        }
        if (b.mesh.position.y < ground - 0.5 || b.age > 12) { kill(i); continue; }
      }
      return hit;
    },
    count() { return balls.filter((b) => b.steam === 0).length; },
    fizzled() { return fizzledTotal; },
    dispose() {
      while (balls.length) kill(0);
      geo.dispose();
      fireMat.dispose();
      steamMat.dispose();
      trailMat.dispose();
      trailTex.dispose();
    },
  };
}
