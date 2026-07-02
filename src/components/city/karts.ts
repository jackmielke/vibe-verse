/**
 * karts — cute drivable go-karts (V1).
 *
 * This module only builds the MESH; the driving physics live in City's
 * tick (they need the shared collision helpers + input state). A kart
 * is an open-top candy-colored runabout with a flat rear deck the
 * driver stands on, chunky wheels, handlebar, headlights and a neon
 * underglow — reads as "hop on me" from across the plaza.
 *
 * Conventions match the player: forward = (sin yaw, 0, cos yaw).
 */
import * as THREE from "three";

export interface KartMesh {
  group: THREE.Group;
  /** All four wheels — spin around X as the kart rolls. */
  wheels: THREE.Mesh[];
  /** Front wheel pivots — yaw with steering input. */
  frontPivots: THREE.Group[];
  /** Underglow strip — brightens while driving. */
  glow: THREE.Mesh;
}

export function buildKart(color: string): KartMesh {
  const g = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.15 });
  const darkMat = new THREE.MeshStandardMaterial({ color: "#1c2026", roughness: 0.7, metalness: 0.3 });
  const trimMat = new THREE.MeshStandardMaterial({ color: "#f6f2e8", roughness: 0.5 });

  // Chassis: low rounded tub with a nose cowl.
  const tub = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.34, 2.5), bodyMat);
  tub.position.y = 0.44;
  g.add(tub);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.28, 0.7), bodyMat);
  nose.position.set(0, 0.62, 1.05);
  g.add(nose);
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.16, 0.18), trimMat);
  bumper.position.set(0, 0.42, 1.32);
  g.add(bumper);

  // Flat rear standing deck with a grip plate.
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.08, 1.05), darkMat);
  deck.position.set(0, 0.65, -0.62);
  g.add(deck);

  // Handlebar column the driver holds.
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.0, 8), darkMat);
  column.position.set(0, 1.1, 0.58);
  column.rotation.x = -0.35;
  g.add(column);
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.85, 8), darkMat);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0, 1.56, 0.4);
  g.add(bar);
  for (const side of [-1, 1]) {
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.16, 8), bodyMat);
    grip.rotation.z = Math.PI / 2;
    grip.position.set(side * 0.42, 1.56, 0.4);
    g.add(grip);
  }

  // Wheels: chunky dark cylinders with pale hubs. Fronts sit in pivot
  // groups so steering can visually turn them.
  const wheels: THREE.Mesh[] = [];
  const frontPivots: THREE.Group[] = [];
  const wheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.26, 14);
  const hubGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.28, 10);
  const makeWheel = (x: number, z: number, front: boolean) => {
    const wheel = new THREE.Mesh(wheelGeo, darkMat);
    wheel.rotation.z = Math.PI / 2;
    const hub = new THREE.Mesh(hubGeo, trimMat);
    hub.rotation.z = Math.PI / 2;
    wheel.add(hub);
    if (front) {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.32, z);
      wheel.position.set(0, 0, 0);
      pivot.add(wheel);
      g.add(pivot);
      frontPivots.push(pivot);
    } else {
      wheel.position.set(x, 0.32, z);
      g.add(wheel);
    }
    wheels.push(wheel);
  };
  makeWheel(-0.82, 0.85, true);
  makeWheel(0.82, 0.85, true);
  makeWheel(-0.82, -0.8, false);
  makeWheel(0.82, -0.8, false);

  // Headlights + tail light.
  const lightMat = new THREE.MeshBasicMaterial({ color: "#fff7d0" });
  for (const side of [-1, 1]) {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), lightMat);
    lamp.position.set(side * 0.4, 0.66, 1.42);
    g.add(lamp);
  }
  const tail = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.08, 0.06),
    new THREE.MeshBasicMaterial({ color: "#ff5b5b" }),
  );
  tail.position.set(0, 0.55, -1.28);
  g.add(tail);

  // Neon underglow — the "this thing is special" tell.
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.9, 2.9),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.06;
  g.add(glow);

  // Tiny antenna pennant.
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.9, 5), darkMat);
  antenna.position.set(-0.6, 1.1, -1.15);
  g.add(antenna);
  const pennant = new THREE.Mesh(
    new THREE.PlaneGeometry(0.3, 0.2),
    new THREE.MeshBasicMaterial({ color: "#ffd166", side: THREE.DoubleSide }),
  );
  pennant.position.set(-0.45, 1.48, -1.15);
  g.add(pennant);

  return { group: g, wheels, frontPivots, glow };
}
