/**
 * The jetpack, as seen from behind.
 *
 * Two parts, because they answer two different questions. The **flames** are
 * geometry parented to the body and they answer "is it on" — they have to be
 * exactly in step with the input or the throttle feels laggy. The **trail** is
 * a pool of world-space points and it answers "where have I been", which is
 * the part that makes a climb off the plaza look like a climb rather than a
 * translation.
 *
 * Both are additive and both are allowed well above 1.0, because the bloom
 * pass in `postfx.ts` is what turns them from orange triangles into a rocket.
 */
import * as THREE from "three";

const MAX_PUFFS = 260;

export interface PlumeHandle {
  /** Parent this to the body. */
  flames: THREE.Group;
  /** Lives in world space — add it to the scene, not to the body. */
  trail: THREE.Points;
  /**
   * @param burn 0..1 throttle
   * @param origin world position of the pack
   * @param vel body velocity, so a puff keeps some of the momentum it was
   *        born with instead of hanging in the air like a decal
   */
  update(dt: number, time: number, burn: number, origin: THREE.Vector3, vel: THREE.Vector3): void;
  dispose(): void;
}

export function buildPlume(): PlumeHandle {
  /* ---- flames ---------------------------------------------------------- */
  const flames = new THREE.Group();
  flames.name = "empyrean-flames";

  const flameMat = new THREE.ShaderMaterial({
    name: "EmpyreanFlame",
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: { uTime: { value: 0 }, uBurn: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uBurn;
      varying float vT;
      void main() {
        // uv.y runs 0 at the nozzle to 1 at the tip of the cone.
        vT = uv.y;
        vec3 p = position;
        // Flicker: the cone pinches and swells along its length, faster and
        // deeper the harder it is burning.
        float f = sin(uTime * 42.0 + p.y * 7.0) * 0.5 + sin(uTime * 71.0) * 0.5;
        p.xz *= 1.0 + f * 0.14 * uBurn;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uBurn;
      varying float vT;
      void main() {
        // White-hot at the nozzle, through gold, to a violet tail — which is
        // the colour a hot flame actually goes and also the palette this
        // world is painted in.
        vec3 core = vec3(1.6, 1.5, 1.35);
        vec3 mid  = vec3(1.5, 0.72, 0.24);
        vec3 tail = vec3(0.70, 0.30, 0.85);
        float t = 1.0 - vT;
        vec3 col = mix(tail, mid, smoothstep(0.0, 0.55, t));
        col = mix(col, core, smoothstep(0.62, 1.0, t));
        float a = smoothstep(0.0, 0.22, t) * (1.0 - smoothstep(0.55, 1.0, 1.0 - t));
        gl_FragColor = vec4(col * uBurn, a * uBurn);
      }
    `,
  });

  // Two nozzles, one per shoulder blade, pointing down and slightly out.
  for (const side of [-1, 1]) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.13, 1.25, 10, 4, true), flameMat);
    cone.rotation.x = Math.PI; // tip downward
    cone.rotation.z = side * -0.16;
    cone.position.set(side * 0.24, 0.95, -0.22);
    cone.frustumCulled = false;
    flames.add(cone);
  }
  flames.visible = false;

  /* ---- trail ----------------------------------------------------------- */
  const pos = new Float32Array(MAX_PUFFS * 3);
  const life = new Float32Array(MAX_PUFFS);
  const seed = new Float32Array(MAX_PUFFS);
  const vel = new Float32Array(MAX_PUFFS * 3);
  for (let i = 0; i < MAX_PUFFS; i++) {
    life[i] = 0;
    seed[i] = Math.random();
    // Parked far below the world until they are used; a dead puff at the
    // origin is a dot on the plaza that nobody can explain.
    pos[i * 3 + 1] = -100000;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aLife", new THREE.BufferAttribute(life, 1));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const trailMat = new THREE.ShaderMaterial({
    name: "EmpyreanTrail",
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: { uScale: { value: 520 } },
    vertexShader: /* glsl */ `
      attribute float aLife;
      attribute float aSeed;
      uniform float uScale;
      varying float vLife;
      varying float vSeed;
      void main() {
        vLife = aLife;
        vSeed = aSeed;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // Puffs grow as they age and cool.
        float grow = 0.6 + (1.0 - aLife) * 2.4;
        gl_PointSize = max(1.0, grow * uScale / max(-mv.z, 1.0)) * step(0.001, aLife);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying float vLife;
      varying float vSeed;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d) * 2.0;
        float core = smoothstep(1.0, 0.0, r);
        vec3 hot  = vec3(1.5, 0.85, 0.40);
        vec3 cold = vec3(0.55, 0.42, 0.75);
        vec3 col = mix(cold, hot, vLife * vLife);
        gl_FragColor = vec4(col * (0.4 + core), core * core * vLife * 0.75);
      }
    `,
  });

  const trail = new THREE.Points(geo, trailMat);
  trail.name = "empyrean-trail";
  trail.frustumCulled = false;

  let cursor = 0;
  let emitTimer = 0;

  return {
    flames,
    trail,
    update(dt, time, burn, origin, bodyVel) {
      flameMat.uniforms.uTime.value = time;
      flameMat.uniforms.uBurn.value = burn;
      flames.visible = burn > 0.02;

      // Emit at a fixed rate in *time*, not per frame — otherwise a 144 Hz
      // machine lays down two and a half times the trail a 60 Hz one does.
      if (burn > 0.05) {
        emitTimer += dt;
        const interval = 0.012;
        while (emitTimer >= interval) {
          emitTimer -= interval;
          const i = cursor;
          cursor = (cursor + 1) % MAX_PUFFS;
          pos[i * 3] = origin.x + (Math.random() - 0.5) * 0.35;
          pos[i * 3 + 1] = origin.y + (Math.random() - 0.5) * 0.25;
          pos[i * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.35;
          vel[i * 3] = bodyVel.x * 0.35 + (Math.random() - 0.5) * 1.6;
          vel[i * 3 + 1] = bodyVel.y * 0.25 - 3.0 - Math.random() * 2.2;
          vel[i * 3 + 2] = bodyVel.z * 0.35 + (Math.random() - 0.5) * 1.6;
          life[i] = 1;
          seed[i] = Math.random();
        }
      } else {
        emitTimer = 0;
      }

      const decay = dt / 0.85;
      for (let i = 0; i < MAX_PUFFS; i++) {
        if (life[i] <= 0) continue;
        life[i] -= decay;
        if (life[i] <= 0) {
          life[i] = 0;
          pos[i * 3 + 1] = -100000;
          continue;
        }
        // Exhaust slows as it spreads, then drifts.
        const drag = Math.pow(0.12, dt);
        vel[i * 3] *= drag;
        vel[i * 3 + 1] = vel[i * 3 + 1] * drag - 1.2 * dt;
        vel[i * 3 + 2] *= drag;
        pos[i * 3] += vel[i * 3] * dt;
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      }

      geo.attributes.position.needsUpdate = true;
      geo.attributes.aLife.needsUpdate = true;
      geo.attributes.aSeed.needsUpdate = true;
    },
    dispose() {
      flames.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      flameMat.dispose();
      geo.dispose();
      trailMat.dispose();
    },
  };
}
