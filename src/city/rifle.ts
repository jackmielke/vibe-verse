/**
 * A rifle you can carry. G raises or lowers it, Q fires.
 *
 * Parented to the model holder (which turns to face the way you run), so the
 * muzzle always points where the body does. Shots are short-lived tracer
 * streaks; nothing is hurt by them.
 */
import * as THREE from "three";

export interface Rifle {
  toggle(): boolean;
  fire(): void;
  readonly equipped: boolean;
  update(dt: number): void;
  dispose(): void;
}

const TRACER_LIFE = 0.12;
const TRACER_LENGTH = 40;

export function createRifle(holder: THREE.Object3D, scene: THREE.Scene): Rifle {
  const metal = new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.5, metalness: 0.6 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.8 });
  const group = new THREE.Group();
  const geos: THREE.BufferGeometry[] = [];
  const part = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    geos.push(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };
  part(new THREE.BoxGeometry(0.07, 0.1, 0.35), wood, 0, 0, -0.2); // stock
  part(new THREE.BoxGeometry(0.06, 0.09, 0.4), metal, 0, 0.01, 0.15); // receiver
  const barrel = part(new THREE.CylinderGeometry(0.018, 0.018, 0.6, 8), metal, 0, 0.03, 0.62);
  barrel.rotation.x = Math.PI / 2;
  part(new THREE.BoxGeometry(0.04, 0.12, 0.05), metal, 0, -0.1, 0.1); // grip
  const scope = part(new THREE.CylinderGeometry(0.025, 0.025, 0.2, 8), metal, 0, 0.1, 0.2);
  scope.rotation.x = Math.PI / 2;
  group.position.set(0.22, 1.05, 0.18);
  group.visible = false;
  holder.add(group);

  const flashLight = new THREE.PointLight(0xffd27a, 0, 6, 2);
  flashLight.position.set(0, 0.03, 0.95);
  group.add(flashLight);

  const tracerMat = new THREE.LineBasicMaterial({ color: 0xfff2a8, transparent: true });
  const tracers: { line: THREE.Line; geo: THREE.BufferGeometry; life: number }[] = [];
  let flash = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const dir = new THREE.Vector3();

  const remove = (t: (typeof tracers)[number]) => {
    scene.remove(t.line);
    t.geo.dispose();
  };

  const self: Rifle = {
    equipped: false,
    toggle() {
      (self as { equipped: boolean }).equipped = !self.equipped;
      group.visible = self.equipped;
      return self.equipped;
    },
    fire() {
      if (!self.equipped) return;
      group.updateWorldMatrix(true, false);
      a.set(0, 0.03, 0.95).applyMatrix4(group.matrixWorld);
      dir.set(0, 0, 1).transformDirection(group.matrixWorld);
      b.copy(a).addScaledVector(dir, TRACER_LENGTH);
      const geo = new THREE.BufferGeometry().setFromPoints([a.clone(), b.clone()]);
      const line = new THREE.Line(geo, tracerMat);
      scene.add(line);
      tracers.push({ line, geo, life: TRACER_LIFE });
      flash = 0.06;
      group.position.z -= 0.05; // recoil, eased back in update
    },
    update(dt) {
      flash = Math.max(0, flash - dt);
      flashLight.intensity = flash > 0 ? 3 : 0;
      group.position.z += (0.18 - group.position.z) * Math.min(1, dt * 15);
      for (let i = tracers.length - 1; i >= 0; i--) {
        tracers[i].life -= dt;
        if (tracers[i].life <= 0) {
          remove(tracers[i]);
          tracers.splice(i, 1);
        }
      }
    },
    dispose() {
      tracers.forEach(remove);
      tracers.length = 0;
      holder.remove(group);
      geos.forEach((g) => g.dispose());
      metal.dispose();
      wood.dispose();
      tracerMat.dispose();
    },
  };
  return self;
}
