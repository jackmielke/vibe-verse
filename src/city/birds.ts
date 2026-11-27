/**
 * Birds over Vibe City: gulls wheeling over the marina, the beach and the
 * towers, and a flock of pigeons on the plaza that bursts into the air when
 * you walk through it and settles again a little later.
 *
 * All of them are one instanced mesh each, a body and two wings, and the
 * flapping is done in the vertex shader from a per-bird phase, so a hundred
 * birds cost two draw calls and no per-frame geometry. Positions are written
 * every frame from closed-form paths (gulls) or a tiny state machine
 * (pigeons); there is no physics and nothing collides.
 */
import * as THREE from "three";

export interface Birds {
  group: THREE.Group;
  update(dt: number, player: THREE.Vector3): void;
  /** Dev hook: how many pigeons are in the air. */
  airborne(): number;
  dispose(): void;
}

interface Flock {
  x: number;
  z: number;
  y: number;
  radius: number;
  count: number;
}

function birdGeometry(span: number, len: number): THREE.BufferGeometry {
  // A body diamond and two wing triangles, in the bird's own space:
  // +z forward, wings along x. The wing tips carry |x| for the flap.
  const h = span / 2;
  const v = [
    // body (two triangles, top and bottom are the same quad, double-sided)
    0, 0, len * 0.55, -len * 0.09, 0, 0, 0, 0, -len * 0.45,
    0, 0, len * 0.55, 0, 0, -len * 0.45, len * 0.09, 0, 0,
    // left wing
    -len * 0.08, 0, len * 0.18, -h, 0, -len * 0.05, -len * 0.08, 0, -len * 0.2,
    // right wing
    len * 0.08, 0, len * 0.18, len * 0.08, 0, -len * 0.2, h, 0, -len * 0.05,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

function flapMaterial(color: number, uniforms: { uTime: { value: number } }, amp: number): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uTime;\nattribute float aPhase;\nattribute float aFlap;",
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        float wing = abs(position.x);
        transformed.y += wing * sin(uTime * (7.0 + aFlap * 6.0) + aPhase) * ${amp.toFixed(2)} * aFlap;`,
      );
  };
  return m;
}

export function createBirds(opts: { plaza: { x: number; z: number; y: number }; flocks: Flock[]; lowDetail?: boolean }): Birds {
  const group = new THREE.Group();
  group.name = "birds";
  const uniforms = { uTime: { value: 0 } };
  const thin = opts.lowDetail ? 0.5 : 1;

  // ---- Gulls -----------------------------------------------------------------
  const gullGeo = birdGeometry(1.5, 0.75);
  const gullMat = flapMaterial(0xf4f6f8, uniforms, 0.55);
  const gulls: Array<{ f: Flock; r: number; speed: number; phase: number; dy: number; bob: number }> = [];
  for (const f of opts.flocks) {
    const n = Math.max(2, Math.round(f.count * thin));
    for (let i = 0; i < n; i++) {
      gulls.push({
        f,
        r: f.radius * (0.6 + Math.random() * 0.6),
        speed: (5 + Math.random() * 3) * (Math.random() < 0.5 ? 1 : -1),
        phase: Math.random() * Math.PI * 2,
        dy: (Math.random() - 0.5) * 14,
        bob: Math.random() * 10,
      });
    }
  }
  const gullMesh = new THREE.InstancedMesh(gullGeo, gullMat, gulls.length);
  const gPhase = new Float32Array(gulls.length);
  const gFlap = new Float32Array(gulls.length);
  gulls.forEach((g, i) => {
    gPhase[i] = g.phase * 3;
    gFlap[i] = 0.35;
  });
  const gFlapAttr = new THREE.InstancedBufferAttribute(gFlap, 1);
  gullGeo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(gPhase, 1));
  gullGeo.setAttribute("aFlap", gFlapAttr);
  gullMesh.frustumCulled = false;
  group.add(gullMesh);

  // ---- Pigeons ---------------------------------------------------------------
  const PIGEONS = opts.lowDetail ? 8 : 16;
  const pigeonGeo = birdGeometry(0.62, 0.36);
  const pigeonMat = flapMaterial(0x8a8f9c, uniforms, 0.4);
  type Pigeon = {
    home: THREE.Vector3;
    pos: THREE.Vector3;
    yaw: number;
    state: "ground" | "flee" | "circle" | "land";
    t: number;
    peck: number;
    vel: THREE.Vector3;
    circleR: number;
    circleA: number;
  };
  const pigeons: Pigeon[] = [];
  for (let i = 0; i < PIGEONS; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 3 + Math.random() * 7;
    const home = new THREE.Vector3(opts.plaza.x + Math.cos(a) * d, opts.plaza.y, opts.plaza.z + Math.sin(a) * d);
    pigeons.push({
      home,
      pos: home.clone(),
      yaw: Math.random() * Math.PI * 2,
      state: "ground",
      t: Math.random() * 3,
      peck: Math.random() * 10,
      vel: new THREE.Vector3(),
      circleR: 12 + Math.random() * 10,
      circleA: a,
    });
  }
  const pigeonMesh = new THREE.InstancedMesh(pigeonGeo, pigeonMat, PIGEONS);
  const pPhase = new Float32Array(PIGEONS).map(() => Math.random() * 20);
  const pFlap = new Float32Array(PIGEONS);
  const pFlapAttr = new THREE.InstancedBufferAttribute(pFlap, 1);
  pigeonGeo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(pPhase, 1));
  pigeonGeo.setAttribute("aFlap", pFlapAttr);
  pigeonMesh.frustumCulled = false;
  group.add(pigeonMesh);

  const M = new THREE.Matrix4();
  const Q = new THREE.Quaternion();
  const E = new THREE.Euler();
  const S = new THREE.Vector3(1, 1, 1);
  const P = new THREE.Vector3();
  let time = 0;

  return {
    group,
    airborne: () => pigeons.filter((p) => p.state !== "ground").length,
    update(dt, player) {
      time += dt;
      uniforms.uTime.value = time;

      // Gulls: wide circles with a slow rise and fall, banking into the turn.
      gulls.forEach((g, i) => {
        const w = g.speed / g.r;
        const a = g.phase + time * w;
        const y = g.f.y + g.dy + Math.sin(time * 0.3 + g.bob) * 4;
        P.set(g.f.x + Math.cos(a) * g.r, y, g.f.z + Math.sin(a) * g.r);
        // Tangent heading.
        const hx = -Math.sin(a) * Math.sign(w);
        const hz = Math.cos(a) * Math.sign(w);
        E.set(0, Math.atan2(hx, hz), -Math.sign(w) * 0.35, "YXZ");
        Q.setFromEuler(E);
        M.compose(P, Q, S);
        gullMesh.setMatrixAt(i, M);
        // Mostly gliding, a few beats now and then.
        gFlap[i] = Math.sin(time * 0.5 + g.bob) > 0.55 ? 0.55 : 0.04;
      });
      gullMesh.instanceMatrix.needsUpdate = true;
      gFlapAttr.needsUpdate = true;

      // Pigeons.
      pigeons.forEach((p, i) => {
        const dx = p.pos.x - player.x;
        const dz = p.pos.z - player.z;
        const near = dx * dx + dz * dz < 4.5 * 4.5 && Math.abs(player.y - p.pos.y) < 3;
        p.t += dt;
        switch (p.state) {
          case "ground": {
            pFlap[i] = 0;
            p.peck += dt;
            // Shuffle about now and then.
            if (Math.random() < dt * 0.4) p.yaw += (Math.random() - 0.5) * 2;
            const step = Math.sin(p.peck * 3) > 0.7 ? 0.25 * dt : 0;
            p.pos.x += Math.sin(p.yaw) * step;
            p.pos.z += Math.cos(p.yaw) * step;
            if (p.pos.distanceTo(p.home) > 6) p.yaw = Math.atan2(p.home.x - p.pos.x, p.home.z - p.pos.z);
            if (near) {
              // Away from you, and up.
              const len = Math.hypot(dx, dz) || 1;
              p.vel.set((dx / len) * 5 + (Math.random() - 0.5) * 2, 5 + Math.random() * 3, (dz / len) * 5 + (Math.random() - 0.5) * 2);
              p.state = "flee";
              p.t = 0;
            }
            break;
          }
          case "flee": {
            pFlap[i] = 1;
            p.pos.addScaledVector(p.vel, dt);
            p.vel.y = Math.max(1, p.vel.y - dt * 2);
            p.yaw = Math.atan2(p.vel.x, p.vel.z);
            if (p.t > 2.5) {
              p.state = "circle";
              p.t = 0;
              p.circleA = Math.atan2(p.pos.z - opts.plaza.z, p.pos.x - opts.plaza.x);
            }
            break;
          }
          case "circle": {
            pFlap[i] = 0.6;
            p.circleA += dt * 0.6;
            const tx = opts.plaza.x + Math.cos(p.circleA) * p.circleR;
            const tz = opts.plaza.z + Math.sin(p.circleA) * p.circleR;
            P.set(tx - p.pos.x, opts.plaza.y + 14 - p.pos.y, tz - p.pos.z);
            p.pos.addScaledVector(P, Math.min(1, dt * 0.9));
            p.yaw = Math.atan2(-Math.sin(p.circleA), Math.cos(p.circleA));
            if (p.t > 9 + Math.random() * 6) {
              p.state = "land";
              p.t = 0;
            }
            break;
          }
          case "land": {
            pFlap[i] = 0.8;
            P.copy(p.home).sub(p.pos);
            const d = P.length();
            if (d < 0.3) {
              p.pos.copy(p.home);
              p.state = "ground";
              p.t = 0;
            } else {
              p.yaw = Math.atan2(P.x, P.z);
              p.pos.addScaledVector(P.normalize(), Math.min(d, dt * 7));
            }
            // Spooked again on the way down.
            if (near && d < 4) {
              p.vel.set(dx, 6, dz).setLength(7);
              p.state = "flee";
              p.t = 0;
            }
            break;
          }
        }
        const pecking = p.state === "ground" && Math.sin(p.peck * 2.3 + i) > 0.6;
        E.set(pecking ? 0.5 : p.state === "ground" ? 0 : -0.15, p.yaw, 0, "YXZ");
        Q.setFromEuler(E);
        P.copy(p.pos).setY(p.pos.y + 0.12);
        M.compose(P, Q, S);
        pigeonMesh.setMatrixAt(i, M);
      });
      pigeonMesh.instanceMatrix.needsUpdate = true;
      pFlapAttr.needsUpdate = true;
    },
    dispose() {
      gullGeo.dispose();
      gullMat.dispose();
      pigeonGeo.dispose();
      pigeonMat.dispose();
    },
  };
}
