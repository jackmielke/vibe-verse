/**
 * pegasus — a winged unicorn that glides in lazy figure-eights over
 * Vibe Island, flapping, bobbing and shedding rainbow sparkles.
 * Pure procedural geometry; mount once, call update(dt, now) per frame.
 */
import * as THREE from "three";
import type { MountKind } from "./mountFlight";
import { buildTurkey } from "@/city/turkey";

export interface PegasusWorld {
  group: THREE.Group;
  body: THREE.Group;
  pose: { x: number; y: number; z: number; yaw: number; bank: number; flap: boolean } | null;
  update(dt: number, now: number): void;
  dispose(): void;
}

export function buildPegasus(center: THREE.Vector3, kind: MountKind = "pegasus"): PegasusWorld {
  if (kind === "turkey") return buildTurkey(center);
  const dragon = kind === "dragon";
  const group = new THREE.Group();
  group.name = kind;
  const body = new THREE.Group();
  group.add(body);

  const white = new THREE.MeshStandardMaterial({ color: 0xfaf7ff, roughness: 0.55, emissive: 0x332a44, emissiveIntensity: 0.25 });
  const mane = new THREE.MeshStandardMaterial({ color: 0xff8fd8, roughness: 0.4, emissive: 0xaa3388, emissiveIntensity: 0.5 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xffd76a, metalness: 0.8, roughness: 0.25, emissive: 0x996611, emissiveIntensity: 0.6 });
  const wingMat = new THREE.MeshStandardMaterial({ color: 0xe8f0ff, roughness: 0.5, side: THREE.DoubleSide, emissive: 0x6677cc, emissiveIntensity: 0.3 });
  if (dragon) { white.color.setHex(0x239c83); mane.color.setHex(0x184f59); mane.emissive.setHex(0x123c34); wingMat.emissive.setHex(0x194d3c); wingMat.color.setHex(0x65d4b2); }
  const mats: THREE.Material[] = [white, mane, gold, wingMat];
  const geos: THREE.BufferGeometry[] = [];
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material) => { geos.push(g); const x = new THREE.Mesh(g, m); x.castShadow = true; return x; };

  // Body (horse faces +z)
  const torso = mesh(new THREE.CapsuleGeometry(0.9, 2.2, 6, 14), white);
  torso.rotation.x = Math.PI / 2;
  body.add(torso);
  const neck = mesh(new THREE.CapsuleGeometry(0.45, 1.3, 4, 10), white);
  neck.position.set(0, 1.0, 1.5); neck.rotation.x = -0.6;
  body.add(neck);
  const head = mesh(new THREE.CapsuleGeometry(0.42, 0.9, 4, 10), white);
  head.position.set(0, 1.75, 2.15); head.rotation.x = Math.PI / 2 - 0.4;
  body.add(head);
  const horn = mesh(new THREE.ConeGeometry(0.12, 1.0, 10), gold);
  horn.position.set(0, 2.3, 2.25); horn.rotation.x = 0.5;
  body.add(horn);
  for (const s of [-1, 1]) {
    const ear = mesh(new THREE.ConeGeometry(0.1, 0.3, 6), white);
    ear.position.set(0.2 * s, 2.15, 1.85);
    body.add(ear);
    const eye = mesh(new THREE.SphereGeometry(0.07, 8, 8), gold);
    eye.position.set(0.33 * s, 1.9, 2.35);
    body.add(eye);
  }
  // Mane + tail
  for (let i = 0; i < 6; i++) {
    const tuft = mesh(new THREE.SphereGeometry(0.22 - i * 0.015, 8, 8), mane);
    tuft.position.set(0, 2.0 - i * 0.22, 1.85 - i * 0.22);
    body.add(tuft);
  }
  const tail = new THREE.Group();
  tail.position.set(0, 0.4, -1.9);
  body.add(tail);
  for (let i = 0; i < 6; i++) {
    const t = mesh(new THREE.SphereGeometry(0.25 - i * 0.02, 8, 8), mane);
    t.position.set(0, -i * 0.25, -i * 0.25);
    tail.add(t);
  }
  // Legs (tucked, swing gently)
  const legs: THREE.Group[] = [];
  for (const [x, z] of [[-0.45, 1.0], [0.45, 1.0], [-0.45, -1.0], [0.45, -1.0]]) {
    const leg = new THREE.Group();
    leg.position.set(x, -0.6, z);
    const l = mesh(new THREE.CapsuleGeometry(0.16, 1.1, 4, 8), white);
    l.position.y = -0.6;
    leg.add(l);
    const hoof = mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.2, 10), gold);
    hoof.position.y = -1.25;
    leg.add(hoof);
    body.add(leg);
    legs.push(leg);
  }
  // Wings: a feathered fan per side, hinged at the shoulder
  const wings: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const wing = new THREE.Group();
    wing.position.set(0.7 * s, 0.6, 0.5);
    for (let i = 0; i < 7; i++) {
      const len = 3.4 - i * 0.3;
      const f = mesh(new THREE.PlaneGeometry(len, 0.55), wingMat);
      f.position.set((len / 2) * s, 0, -i * 0.32);
      f.rotation.x = -Math.PI / 2;
      wing.add(f);
    }
    body.add(wing);
    wings.push(wing);
  }
  if (dragon) {
    horn.visible = false;
    for (const side of [-1, 1]) {
      const h = mesh(new THREE.ConeGeometry(0.17, 1.0, 8), gold);
      h.position.set(side * 0.38, 2.1, 1.8); h.rotation.z = -side * 0.4; body.add(h);
    }
    for (let i = 0; i < 9; i++) {
      const spike = mesh(new THREE.ConeGeometry(0.18, 0.55, 5), gold);
      spike.position.set(0, 0.9 - i * 0.08, 1.2 - i * 0.55); body.add(spike);
    }
    tail.scale.set(1, 0.7, 2.5);
    wings.forEach((wing, i) => {
      while (wing.children.length) wing.remove(wing.children[0]);
      const side = i === 0 ? -1 : 1;
      const shape = new THREE.Shape();
      shape.moveTo(0, 0); shape.lineTo(4.8 * side, -0.6);
      shape.quadraticCurveTo(3.1 * side, -0.7, 3.2 * side, -2.3);
      shape.quadraticCurveTo(1.8 * side, -1.7, 1.4 * side, -3.0);
      shape.lineTo(0, -1.4); shape.closePath();
      const membrane = mesh(new THREE.ShapeGeometry(shape), wingMat);
      membrane.rotation.x = Math.PI / 2; wing.add(membrane);
      for (const [x,z] of [[4.8,-0.6],[3.2,-2.3],[1.4,-3]]) {
        const length = Math.hypot(x,z);
        const strut = mesh(new THREE.CylinderGeometry(0.055, 0.08, length, 5), mane);
        strut.position.set(x * side / 2, 0, -z / 2);
        strut.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), new THREE.Vector3(x*side,0,-z).normalize());
        wing.add(strut);
      }
    });
  }
  const saddle = mesh(new THREE.BoxGeometry(0.65, 0.16, 0.8), mane);
  saddle.position.set(0, 0.91, 0); body.add(saddle);
  body.scale.setScalar(1.6);

  // Rainbow sparkle trail
  const N = 160;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const life = new Float32Array(N);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  trailGeo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geos.push(trailGeo);
  const trailMat = new THREE.PointsMaterial({ size: 0.6, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
  mats.push(trailMat);
  const trail = new THREE.Points(trailGeo, trailMat);
  trail.frustumCulled = false;
  group.add(trail);
  let head_i = 0;
  let emitAcc = 0;
  const c = new THREE.Color();

  const R = 45, H = center.y + 28;
  const at = (t: number, out: THREE.Vector3) =>
    out.set(center.x + Math.sin(t) * R, H + Math.sin(t * 2) * 5, center.z + Math.sin(t * 2) * R * 0.55);
  const p = new THREE.Vector3(), q = new THREE.Vector3();

  return {
    group,
    body,
    pose: null,
    update(dt, now) {
      const s = now / 1000;
      const t = s * 0.12;
      if (this.pose) {
        const pose = this.pose;
        p.set(pose.x, pose.y, pose.z);
        body.position.copy(p);
        body.rotation.set(0, pose.yaw, pose.bank, "YXZ");
      } else {
      at(t, p); at(t + 0.01, q);
      body.position.copy(p);
      body.lookAt(q);
      const bank = Math.cos(t) * 0.35;
      body.rotateZ(-bank);
      }
      const flap = Math.sin(s * (this.pose?.flap ? 10 : 4.5));
      wings[0].rotation.z = -flap * 0.7 + 0.1;
      wings[1].rotation.z = flap * 0.7 - 0.1;
      if (!this.pose) body.position.y += -flap * 0.4;
      legs.forEach((l, i) => (l.rotation.x = 0.6 + Math.sin(s * 3 + i) * 0.25));
      tail.rotation.y = Math.sin(s * 2) * 0.3;

      emitAcc += dt * 40;
      while (emitAcc > 1) {
        emitAcc -= 1;
        const i = head_i++ % N;
        pos[i * 3] = p.x + (Math.random() - 0.5);
        pos[i * 3 + 1] = p.y + (Math.random() - 0.5);
        pos[i * 3 + 2] = p.z + (Math.random() - 0.5);
        life[i] = 1;
        c.setHSL((s * 0.3 + i / N) % 1, 1, 0.65);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      for (let i = 0; i < N; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt * 0.5;
        pos[i * 3 + 1] -= dt * 0.8;
        const k = Math.max(0, 1 - dt * 0.5);
        col[i * 3] *= k; col[i * 3 + 1] *= k; col[i * 3 + 2] *= k;
      }
      trailGeo.attributes.position.needsUpdate = true;
      trailGeo.attributes.color.needsUpdate = true;
    },
    dispose() {
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      group.removeFromParent();
    },
  };
}
