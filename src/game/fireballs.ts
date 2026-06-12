// Fireballs are kept in a module-level mutable array so we don't trigger
// React re-renders every frame. The <Fireballs/> component reads from this
// list inside useFrame and updates a pool of meshes.

export interface Fireball {
  x: number;
  z: number;
  y: number;
  vx: number;
  vz: number;
  life: number; // seconds remaining
}

export const MAX_FIREBALLS = 16;
export const fireballs: Fireball[] = [];

export function spawnFireball(x: number, z: number, dirX: number, dirZ: number) {
  const len = Math.hypot(dirX, dirZ) || 1;
  const speed = 22;
  if (fireballs.length >= MAX_FIREBALLS) fireballs.shift();
  fireballs.push({
    x,
    z,
    y: 1.2,
    vx: (dirX / len) * speed,
    vz: (dirZ / len) * speed,
    life: 1.5,
  });
}

export function clearFireballs() {
  fireballs.length = 0;
}
