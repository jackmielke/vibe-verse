/**
 * The Midnight Zone — the bottom.
 *
 * Eight kilometres of nothing needs somewhere to end, and the ending has to be
 * worth the trip. So the floor is not a plane: it is a trench, with a
 * hydrothermal field on it, and it only exists when you are close enough to
 * see it.
 *
 * That last part is the whole trick. Building a seafloor at boot and leaving it
 * 8 km below the camera costs a draw call and a depth-sort on every frame of a
 * dive that spends most of its time nowhere near it. Instead the floor builds
 * itself the first time the sub comes within `REVEAL` metres and disposes when
 * it leaves — so the top of the dive pays nothing for the bottom of it.
 *
 * The black smokers are the payoff: superheated mineral water at 400 °C
 * billowing out of chimneys, and the only place on Earth where a whole food
 * web runs on chemistry instead of sunlight. It is the right thing to find at
 * the bottom of a game about light running out.
 */
import * as THREE from "three";
import { FLOOR_DEPTH, type DeepCtx, type SubService, type System } from "../types";

/** Build the floor when the sub is this close to it. */
const REVEAL = 420;
const EXTENT = 900;

interface Built {
  group: THREE.Group;
  plumes: Array<{ points: THREE.Points; base: Float32Array; speed: Float32Array }>;
  glowMats: THREE.MeshStandardMaterial[];
}

function build(ctx: DeepCtx): Built {
  const group = new THREE.Group();
  group.name = "seafloor";
  const plumes: Built["plumes"] = [];
  const glowMats: THREE.MeshStandardMaterial[] = [];

  // -- the ooze -------------------------------------------------------------
  // Abyssal sediment is the flattest surface on the planet, so the noise here
  // is deliberately gentle — just enough that the lamps have something to rake
  // across. A rugged floor would read as a canyon and lose the scale.
  const seg = ctx.quality === "low" ? 48 : 96;
  const geo = new THREE.PlaneGeometry(EXTENT * 2, EXTENT * 2, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // Sum of a few sines; the low-frequency term is the trench wall rising at
    // the edges, which is what stops the floor reading as infinite tabletop.
    const trench = Math.pow(Math.abs(x) / EXTENT, 3) * 260 + Math.pow(Math.abs(z) / EXTENT, 3) * 190;
    const dunes =
      Math.sin(x * 0.012) * 2.4 +
      Math.cos(z * 0.017) * 2.1 +
      Math.sin((x + z) * 0.033) * 1.1 +
      Math.sin(x * 0.09 + z * 0.07) * 0.4;
    pos.setY(i, dunes + trench);
  }
  geo.computeVertexNormals();
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x6b6455,
    roughness: 0.97,
    metalness: 0.02,
  });
  const floor = new THREE.Mesh(geo, floorMat);
  floor.position.y = -FLOOR_DEPTH;
  group.add(floor);

  // -- boulders -------------------------------------------------------------
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x3c3a36, roughness: 0.95 });
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, 160);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i < 160; i++) {
    p.set((ctx.rng() - 0.5) * EXTENT * 1.4, -FLOOR_DEPTH + 0.4, (ctx.rng() - 0.5) * EXTENT * 1.4);
    q.setFromEuler(new THREE.Euler(ctx.rng() * 3, ctx.rng() * 3, ctx.rng() * 3));
    const scale = 0.5 + ctx.rng() * 2.6;
    s.set(scale, scale * (0.5 + ctx.rng() * 0.4), scale);
    rocks.setMatrixAt(i, m.compose(p, q, s));
  }
  rocks.instanceMatrix.needsUpdate = true;
  group.add(rocks);

  // -- hydrothermal vents ---------------------------------------------------
  const chimneyMat = new THREE.MeshStandardMaterial({ color: 0x241d1a, roughness: 0.9 });
  // Clustered, not scattered. A vent field spread over 300 m is a vent field
  // you will never find: at these fog densities each chimney is invisible from
  // more than about 120 m, so a random walk across the trench floor meets
  // nothing. Real vents cluster anyway — they follow the spreading ridge — so
  // packing them into one neighbourhood near where the descent lands is both
  // truer and the difference between a payoff and an empty plain.
  const ventCount = ctx.quality === "low" ? 5 : 11;
  for (let v = 0; v < ventCount; v++) {
    const a = (v / ventCount) * Math.PI * 2 + ctx.rng() * 0.6;
    const rad = 14 + ctx.rng() * 62;
    const vx = Math.cos(a) * rad;
    const vz = Math.sin(a) * rad;
    const height = 6 + ctx.rng() * 16;

    // A chimney is a stack of narrowing cylinders, kinked — they grow crooked
    // because they precipitate wherever the water happens to be going.
    const chimney = new THREE.Group();
    let y = 0;
    let r = 1.5 + ctx.rng() * 1.4;
    let lean = 0;
    for (let k = 0; k < 6; k++) {
      const h = height / 6;
      const seg2 = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.78, r, h, 8), chimneyMat);
      lean += (ctx.rng() - 0.5) * 0.5;
      seg2.position.set(Math.sin(lean) * k * 0.35, y + h / 2, Math.cos(lean) * k * 0.12);
      seg2.rotation.z = lean * 0.12;
      chimney.add(seg2);
      y += h;
      r *= 0.8;
    }
    chimney.position.set(vx, -FLOOR_DEPTH, vz);
    group.add(chimney);

    // The mouth glows — hot rock, and the only warm colour in the whole world.
    const mouth = new THREE.MeshStandardMaterial({
      color: 0xff6a2a,
      emissive: 0xff6a2a,
      emissiveIntensity: 2.4,
    });
    glowMats.push(mouth);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.8, r * 0.8, 0.3, 8), mouth);
    cap.position.set(vx + Math.sin(lean) * 1.8, -FLOOR_DEPTH + y, vz + Math.cos(lean) * 0.6);
    group.add(cap);
    const heat = new THREE.PointLight(0xff7a34, 220, 150, 1.6);
    heat.position.copy(cap.position);
    group.add(heat);

    // The smoke: particles rising and spreading, recycled at the top.
    const n = ctx.quality === "low" ? 90 : 220;
    const arr = new Float32Array(n * 3);
    const base = new Float32Array(n * 3);
    const speed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = base[i * 3] = cap.position.x + (ctx.rng() - 0.5) * 1.2;
      arr[i * 3 + 1] = base[i * 3 + 1] = cap.position.y + ctx.rng() * 40;
      arr[i * 3 + 2] = base[i * 3 + 2] = cap.position.z + (ctx.rng() - 0.5) * 1.2;
      speed[i] = 1.4 + ctx.rng() * 2.8;
    }
    const pgeo = new THREE.BufferGeometry();
    pgeo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    const pmat = new THREE.PointsMaterial({
      color: 0x2a2320,
      size: 2.6,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const pts = new THREE.Points(pgeo, pmat);
    group.add(pts);
    plumes.push({ points: pts, base, speed });

    // Tube worms — the thing that makes a vent a *community* rather than a
    // geyser. Red plumes on white tubes, clustered at the base.
    const tubeMat = new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.8 });
    const plumeMat = new THREE.MeshStandardMaterial({
      color: 0xd2214a,
      emissive: 0x5a0a1c,
      emissiveIntensity: 0.8,
      roughness: 0.6,
    });
    for (let w = 0; w < 26; w++) {
      const a = ctx.rng() * Math.PI * 2;
      const rad = 2 + ctx.rng() * 7;
      const wh = 0.7 + ctx.rng() * 1.9;
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.1, wh, 5), tubeMat);
      tube.position.set(vx + Math.cos(a) * rad, -FLOOR_DEPTH + wh / 2, vz + Math.sin(a) * rad);
      tube.rotation.z = (ctx.rng() - 0.5) * 0.4;
      group.add(tube);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 6, 5), plumeMat);
      head.position.set(tube.position.x, -FLOOR_DEPTH + wh + 0.08, tube.position.z);
      head.scale.set(1, 1.6, 1);
      group.add(head);
    }
  }

  ctx.scene.add(group);
  return { group, plumes, glowMats };
}

function destroy(ctx: DeepCtx, built: Built): void {
  ctx.scene.remove(built.group);
  built.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
    if (mat) for (const one of Array.isArray(mat) ? mat : [mat]) one.dispose();
  });
}

export default function createFloor(ctx: DeepCtx): System {
  let built: Built | null = null;

  return {
    update(dt) {
      const sub = ctx.services.sub as SubService | undefined;
      const depth = sub?.depth ?? 0;
      const close = depth > FLOOR_DEPTH - REVEAL;

      if (close && !built) {
        try {
          built = build(ctx);
          ctx.emit("floor:revealed", { depth });
        } catch (err) {
          console.error("[The Deep] the seafloor failed to build:", err);
        }
      } else if (!close && built) {
        destroy(ctx, built);
        built = null;
      }
      if (!built) return;

      // Smoke rises, spreads and recycles. Black smoker plumes really do stay
      // coherent for tens of metres before the cold water shreds them.
      const t = ctx.elapsed;
      for (const plume of built.plumes) {
        const attr = plume.points.geometry.attributes.position as THREE.BufferAttribute;
        const arr = attr.array as Float32Array;
        for (let i = 0; i < plume.speed.length; i++) {
          const i3 = i * 3;
          arr[i3 + 1] += plume.speed[i] * dt;
          const rise = arr[i3 + 1] - plume.base[i3 + 1];
          // Widen with height, and wander — that is what makes it a plume.
          arr[i3] = plume.base[i3] + Math.sin(t * 0.7 + i) * (0.4 + rise * 0.055);
          arr[i3 + 2] = plume.base[i3 + 2] + Math.cos(t * 0.6 + i * 1.7) * (0.4 + rise * 0.055);
          if (rise > 46) arr[i3 + 1] = plume.base[i3 + 1];
        }
        attr.needsUpdate = true;
      }

      // The vent mouths shimmer with the flow rate.
      for (let i = 0; i < built.glowMats.length; i++) {
        built.glowMats[i].emissiveIntensity = 2 + Math.sin(t * 1.4 + i * 2.1) * 0.9;
      }
    },

    dispose() {
      if (built) destroy(ctx, built);
      built = null;
    },
  };
}
