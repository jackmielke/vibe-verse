/**
 * Bolts: what the player and Vibey shoot.
 *
 * A bolt is a small glowing sphere with a light and a short life. It flies
 * straight, hits the first enemy inside its radius, and otherwise lands on
 * the ground, where the mode may care (Spirit Lights can be popped from a
 * distance, bells can be rung from the bridge).
 */
import * as THREE from "three";
import type { Enemies, Enemy } from "./enemies";

export interface Bolts {
  group: THREE.Group;
  fire(origin: THREE.Vector3, dir: THREE.Vector3, owner: "player" | "vibey"): void;
  update(dt: number, enemies: Enemies, heightAt: (x: number, z: number) => number, onHit: (e: Enemy, owner: "player" | "vibey") => void, onLand: (x: number, y: number, z: number, owner: "player" | "vibey") => void): void;
  count(): number;
  dispose(): void;
}

interface Bolt { mesh: THREE.Mesh; light: THREE.PointLight; vel: THREE.Vector3; age: number; owner: "player" | "vibey" }

export function createBolts(): Bolts {
  const group = new THREE.Group();
  const geo = new THREE.SphereGeometry(0.18, 10, 8);
  const playerMat = new THREE.MeshBasicMaterial({ color: "#c9a8ff" });
  const vibeyMat = new THREE.MeshBasicMaterial({ color: "#8dffc8" });
  const live: Bolt[] = [];
  return {
    group,
    fire(origin, dir, owner) {
      if (live.length > 40) return;
      const mesh = new THREE.Mesh(geo, owner === "player" ? playerMat : vibeyMat);
      mesh.position.copy(origin);
      const light = new THREE.PointLight(owner === "player" ? "#b98cff" : "#73ffb8", 1.6, 8, 2);
      mesh.add(light);
      group.add(mesh);
      live.push({ mesh, light, vel: dir.clone().normalize().multiplyScalar(owner === "player" ? 34 : 26), age: 0, owner });
    },
    update(dt, enemies, heightAt, onHit, onLand) {
      const alive = enemies.alive();
      for (let i = live.length - 1; i >= 0; i--) {
        const b = live[i];
        b.age += dt;
        b.mesh.position.addScaledVector(b.vel, dt);
        b.vel.y -= 4 * dt;
        b.mesh.scale.setScalar(1 + Math.sin(b.age * 30) * 0.15);
        let done = false;
        for (const e of alive) {
          if (e.dead) continue;
          const dx = e.position.x - b.mesh.position.x, dy = e.position.y + 1.3 - b.mesh.position.y, dz = e.position.z - b.mesh.position.z;
          if (dx * dx + dy * dy + dz * dz < (e.radius + 0.6) ** 2) { onHit(e, b.owner); done = true; break; }
        }
        if (!done) {
          const g = heightAt(b.mesh.position.x, b.mesh.position.z);
          if (b.mesh.position.y <= g + 0.1) { onLand(b.mesh.position.x, g, b.mesh.position.z, b.owner); done = true; }
          else if (b.age > 3) done = true;
        }
        if (done) { group.remove(b.mesh); live.splice(i, 1); }
      }
    },
    count: () => live.length,
    dispose() {
      for (const b of live) group.remove(b.mesh);
      live.length = 0;
      geo.dispose();
      playerMat.dispose();
      vibeyMat.dispose();
    },
  };
}
