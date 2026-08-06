/**
 * What is left of you.
 *
 * A crash is the only thing in this world that has to look *good* rather than
 * look *right*. Everything else here is a simulation with a picture attached —
 * the lift is real, the skyline is at its real address, the smoke oil trails
 * because the real jets carry paraffin. A fireball is the opposite: nobody has
 * ever complained that an explosion in a game was insufficiently faithful to
 * the combustion of JP-5. It exists to make the worst thing you can do the
 * most fun thing to watch.
 *
 * So it is built out of the four things a good one is always built out of, in
 * the order the eye reads them:
 *
 *  1. **The flash.** One frame of white, before anything else resolves. This
 *     is what makes it read as an explosion rather than as a fire starting.
 *  2. **The fireball.** A sphere that expands fast and decelerates, going
 *     white → yellow → orange → black over about a second, lumpy rather than
 *     smooth because a smooth sphere reads as a balloon.
 *  3. **The debris.** Two dozen tumbling shards on ballistic arcs. This is the
 *     part that sells the *scale* — the fireball could be any size, but a
 *     piece of tailplane cartwheeling across three hundred metres could not.
 *  4. **The smoke.** Outlives all of it, rises, spreads, goes from black to
 *     grey. The fireball is the event; the column is the consequence, and it
 *     is what you are still looking at when the jet is handed back.
 *
 * Plus a shock ring on the deck, because a blast that does not touch the world
 * it happened in floats.
 *
 * ## Cost
 * Three draw calls: one sphere, one instanced quad for every puff of smoke,
 * one instanced box for every shard. All of it lives for four seconds, all of
 * it is allocated once at boot and reused, and when nothing is exploding the
 * whole group is invisible and skipped.
 *
 * ## Colour
 * Like everything else here, this writes scene-linear radiance and then tone
 * maps by hand — see `OUTPUT_GLSL` in `world/env.ts`. That matters more for a
 * fireball than for anything else in the world: the core is genuinely bright,
 * far above 1.0, and without the ACES curve it clips to a flat white disc
 * instead of rolling off through yellow.
 */
import * as THREE from "three";
import type { AngelsCtx, System } from "../types";
// OUTPUT_GLSL declares `uniform float uExposure` itself — declaring it again
// alongside the include is a GLSL redefinition, and a redefinition is a failed
// compile, and a failed compile is a mesh that is `visible: true`, has a
// sensible position and a sensible scale, and draws absolutely nothing. The
// first version of this file did that in all five shaders, so the crash was a
// perfectly working card in front of an empty sky.
import { OUTPUT_GLSL } from "../world/env";

/** How long the whole thing lasts. The smoke is the last to go. */
const LIFE = 6.2;
const PUFFS = 54;
const SHARDS = 42;
/**
 * Delayed secondary fireballs, seconds after the first.
 *
 * One fireball is a puff. Three, arriving on top of each other from slightly
 * different places, is a jet full of fuel coming apart — and the ear reads the
 * overlap as a much bigger single event than any one of them.
 */
const SECONDARIES = [0.32, 0.62, 1.05];

interface Puff {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  born: number;
  size: number;
  spin: number;
  /** 0 = sooty black, 1 = pale grey. Fire-adjacent puffs start dark. */
  tone: number;
}

interface Shard {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  angle: THREE.Euler;
  size: THREE.Vector3;
  dead: boolean;
}

export function createBlast(ctx: AngelsCtx): System {
  const group = new THREE.Group();
  group.name = "blast";
  group.visible = false;
  ctx.scene.add(group);

  // ---- the fireball --------------------------------------------------------

  const ballGeo = new THREE.IcosahedronGeometry(1, 3);
  const ballMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uT: { value: 0 }, uExposure: { value: 0.66 }, uSeed: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uT;
      uniform float uSeed;
      varying float vLump;
      varying vec3 vNormalV;
      varying vec3 vViewPos;

      // Cheap value noise. Three octaves is enough to break the silhouette,
      // which is the only job — nobody is going to study the surface.
      float h(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      float noise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(h(i), h(i + vec3(1,0,0)), f.x), mix(h(i + vec3(0,1,0)), h(i + vec3(1,1,0)), f.x), f.y),
          mix(mix(h(i + vec3(0,0,1)), h(i + vec3(1,0,1)), f.x), mix(h(i + vec3(0,1,1)), h(i + vec3(1,1,1)), f.x), f.y),
          f.z);
      }

      void main() {
        // The lumps drift outward as it grows, so the surface boils rather
        // than the whole thing inflating like a beach ball.
        float n = noise(position * 2.6 + uSeed + uT * 0.9) * 0.55
                + noise(position * 6.1 - uT * 1.7) * 0.28;
        vLump = n;
        vec3 p = position * (0.72 + n * 0.62);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vViewPos = mv.xyz;
        vNormalV = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uT;
      varying float vLump;
      varying vec3 vNormalV;
      varying vec3 vViewPos;
      ${OUTPUT_GLSL}
      void main() {
        float t = clamp(uT, 0.0, 1.0);

        // How square-on this bit of the shell is to the camera. This is the
        // number that turns a sphere into a fireball: the middle of the disc
        // is looking down the deepest column of burning fuel, so it is the
        // hottest and the most opaque, and the rim is thin and soft. The first
        // version reached for length(position) instead, which on a shell is
        // 1.0 at every single vertex — so the whole thing came out uniformly
        // half-transparent and read as a yellow glass balloon.
        float facing = abs(dot(normalize(vNormalV), normalize(-vViewPos)));

        // Early it is a white core; by half a second it is orange with black
        // roots; by one second it is smoke with embers in it.
        // Squared on both counts. The first version let the surface noise and
        // a linear facing term each push heat past the core threshold on
        // their own, so nearly every fragment came out white-hot and the whole
        // fireball was a flat yellow dome. Noise should *modulate* the heat,
        // not decide it, and the white core should be a small bright middle in
        // the first fraction of a second — not the entire ball for a second.
        float heat = clamp(
          (1.0 - t) * (1.0 - t) * (0.30 + vLump * 0.55) * (0.15 + facing * facing * 1.5),
          0.0,
          1.8
        );
        vec3 core = vec3(11.0, 7.4, 3.2);
        vec3 flame = vec3(4.2, 1.05, 0.14);
        vec3 soot = vec3(0.055, 0.045, 0.042);
        vec3 col = mix(soot, mix(flame, core, smoothstep(0.8, 1.5, heat)), smoothstep(0.04, 0.55, heat));
        float a = clamp((1.0 - t * t * t) * (0.16 + facing * 1.3), 0.0, 1.0);
        gl_FragColor = vec4(outputColor(col * (0.35 + heat)), a);
      }
    `,
  });
  const balls: THREE.Mesh[] = [];
  const ball = new THREE.Mesh(ballGeo, ballMat);
  ball.frustumCulled = false;
  // Above the smoke, not below it. Both are transparent and neither writes
  // depth, so the render order is the only thing deciding which wins — and
  // with the smoke on top the fire was a rim of orange at the bottom of a grey
  // ball for the whole first second. Fire punching through its own smoke is
  // what an explosion looks like.
  ball.renderOrder = 15;
  group.add(ball);
  balls.push(ball);
  // The secondaries share the geometry and clone only the material, so each
  // can be at its own point in its own life.
  for (let i = 0; i < SECONDARIES.length; i++) {
    const b = new THREE.Mesh(ballGeo, ballMat.clone());
    b.frustumCulled = false;
    b.renderOrder = 15;
    b.visible = false;
    group.add(b);
    balls.push(b);
  }

  // ---- the flash -----------------------------------------------------------
  // A camera-facing additive disc for the first fifth of a second. Additive on
  // purpose: it should wash out whatever is behind it.

  const flashGeo = new THREE.PlaneGeometry(1, 1);
  const flashMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uT: { value: 0 }, uExposure: { value: 0.66 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uT;
      varying vec2 vUv;
      ${OUTPUT_GLSL}
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float a = pow(max(0.0, 1.0 - r), 1.9) * max(0.0, 1.0 - uT * 3.2);
        gl_FragColor = vec4(outputColor(vec3(22.0, 15.0, 8.0) * a), a);
      }
    `,
  });
  const flash = new THREE.Mesh(flashGeo, flashMat);
  flash.frustumCulled = false;
  flash.renderOrder = 16;
  group.add(flash);

  // ---- the shock ring ------------------------------------------------------

  const ringGeo = new THREE.RingGeometry(0.82, 1, 48);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { uT: { value: 0 }, uExposure: { value: 0.66 } },
    vertexShader: `void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uT;
      ${OUTPUT_GLSL}
      void main() {
        float a = max(0.0, 1.0 - uT * 0.9) * 0.62;
        gl_FragColor = vec4(outputColor(vec3(1.6, 1.35, 1.1)), a);
      }
    `,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.frustumCulled = false;
  ring.renderOrder = 13;
  group.add(ring);

  // ---- smoke ---------------------------------------------------------------
  // Instanced camera-facing quads. The billboard is done in the vertex shader
  // off the instance matrix's translation, so the CPU only ever writes a
  // position, a scale and two floats per puff.

  const puffGeo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  puffGeo.index = quad.index;
  puffGeo.attributes.position = quad.attributes.position;
  puffGeo.attributes.uv = quad.attributes.uv;
  const puffOffset = new THREE.InstancedBufferAttribute(new Float32Array(PUFFS * 3), 3);
  const puffData = new THREE.InstancedBufferAttribute(new Float32Array(PUFFS * 3), 3); // size, age, tone
  const puffRot = new THREE.InstancedBufferAttribute(new Float32Array(PUFFS), 1);
  puffOffset.setUsage(THREE.DynamicDrawUsage);
  puffData.setUsage(THREE.DynamicDrawUsage);
  puffRot.setUsage(THREE.DynamicDrawUsage);
  puffGeo.setAttribute("aOffset", puffOffset);
  puffGeo.setAttribute("aData", puffData);
  puffGeo.setAttribute("aRot", puffRot);
  puffGeo.instanceCount = PUFFS;

  const puffMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uExposure: { value: 0.66 }, uSun: { value: new THREE.Vector3(0.4, 0.8, 0.3) } },
    vertexShader: /* glsl */ `
      attribute vec3 aOffset;
      attribute vec3 aData;
      attribute float aRot;
      varying vec2 vUv;
      varying float vAge;
      varying float vTone;
      void main() {
        vUv = uv;
        vAge = aData.y;
        vTone = aData.z;
        float c = cos(aRot), s = sin(aRot);
        vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * aData.x;
        // Billboard: the offset goes through the view matrix, the corner does
        // not, so the quad always faces the camera whatever it is doing.
        vec4 mv = modelViewMatrix * vec4(aOffset, 1.0);
        mv.xy += p;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying float vAge;
      varying float vTone;
      ${OUTPUT_GLSL}
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        if (r > 1.0) discard;
        // A soft blob with a slightly hot centre early on: the first second of
        // a smoke ball still has fire inside it.
        float body = pow(1.0 - r, 1.6);
        // Fire inside the smoke, and it has to outlast the fireball itself or
        // the whole thing goes from orange to grey between two frames.
        float ember = max(0.0, 1.0 - vAge * 0.85) * pow(1.0 - r, 3.2);
        vec3 smoke = mix(vec3(0.030, 0.027, 0.026), vec3(0.34, 0.34, 0.36), vTone);
        vec3 col = smoke + vec3(4.6, 1.5, 0.30) * ember;
        // Slow: the column is what you are still looking at when the jet is
        // handed back, and at the old rate it had faded to nothing a second
        // before the countdown ran out.
        float a = body * max(0.0, 1.0 - vAge * 0.16) * 0.94;
        gl_FragColor = vec4(outputColor(col), a);
      }
    `,
  });
  const puffMesh = new THREE.Mesh(puffGeo, puffMat);
  puffMesh.frustumCulled = false;
  puffMesh.renderOrder = 13;
  group.add(puffMesh);

  // ---- debris --------------------------------------------------------------

  const shardGeo = new THREE.BoxGeometry(1, 1, 1);
  const shardMat = new THREE.ShaderMaterial({
    uniforms: { uExposure: { value: 0.66 } },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(mat3(instanceMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal;
      ${OUTPUT_GLSL}
      void main() {
        // Scorched airframe: the blue is still there under the soot on the
        // faces the fire did not reach.
        float up = normalize(vNormal).y * 0.5 + 0.5;
        vec3 col = mix(vec3(0.035, 0.033, 0.03), vec3(0.06, 0.13, 0.34), up * 0.55);
        gl_FragColor = vec4(outputColor(col * (0.35 + up * 0.8)), 1.0);
      }
    `,
  });
  const shardMesh = new THREE.InstancedMesh(shardGeo, shardMat, SHARDS);
  shardMesh.frustumCulled = false;
  shardMesh.count = 0;
  group.add(shardMesh);

  // ---- state ---------------------------------------------------------------

  const puffs: Puff[] = [];
  const shards: Shard[] = [];
  for (let i = 0; i < PUFFS; i++) {
    puffs.push({
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      born: 0,
      size: 1,
      spin: 0,
      tone: 0,
    });
  }
  for (let i = 0; i < SHARDS; i++) {
    shards.push({
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      angle: new THREE.Euler(),
      size: new THREE.Vector3(1, 1, 1),
      dead: true,
    });
  }

  let age = LIFE + 1;
  const origin = new THREE.Vector3();
  let groundY = 0;
  let scale = 1;

  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();

  /** Deterministic per-blast randomness, so a replay looks the same. */
  let seed = 1;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const spread = () => rand() * 2 - 1;

  function detonate(at: { x: number; y: number; z: number }, speed: number): void {
    origin.set(at.x, at.y, at.z);
    const terrain = ctx.services.terrain as { surfaceAt(x: number, z: number): number } | undefined;
    groundY = terrain ? terrain.surfaceAt(at.x, at.z) : 0;
    // Faster arrivals throw more of everything, but only slowly: the
    // difference between hitting the lake at 200 knots and at 500 should be
    // visible and should not be a factor of three.
    scale = 1 + Math.min(1.1, speed / 260);
    age = 0;
    seed = Math.floor(Math.abs(at.x) + Math.abs(at.z)) % 100000 || 7;

    for (const p of puffs) {
      // Puffs start clustered and fly outward with a strong upward bias — a
      // ball of smoke that does not rise reads as fog.
      p.position.copy(origin).add(_s.set(spread() * 9, rand() * 8, spread() * 9));
      // A wide spread of upward speeds is what makes a column instead of a
      // ball: the fastest puffs are two hundred metres up while the slowest
      // are still boiling around the wreck.
      p.velocity.set(spread() * 22 * scale, 12 + rand() * 46 * scale, spread() * 22 * scale);
      p.born = rand() * 0.35;
      p.size = (36 + rand() * 58) * scale;
      p.spin = spread() * 0.7;
      p.tone = rand() * rand();
    }
    for (const s of shards) {
      s.dead = false;
      s.position.copy(origin);
      s.velocity.set(spread() * 44 * scale, 14 + rand() * 52 * scale, spread() * 44 * scale);
      s.spin.set(spread() * 9, spread() * 9, spread() * 9);
      s.angle.set(rand() * 6.28, rand() * 6.28, rand() * 6.28);
      // Big enough to read as airframe from two hundred metres. Small tumbling
      // cubes at this distance are indistinguishable from grit on the lens.
      const k = 1.6 + rand() * 4.2;
      s.size.set(k * (0.5 + rand()), k * 0.4, k * (0.9 + rand() * 2.0));
    }
    shardMesh.count = SHARDS;
    group.visible = true;
  }

  const off = ctx.on("angels:crash", (e: { position: { x: number; y: number; z: number }; speed: number }) =>
    detonate(e.position, e.speed),
  );

  return {
    update(dt, c) {
      if (age > LIFE) {
        if (group.visible) group.visible = false;
        return;
      }
      age += dt;

      const env = c.services.env as { uniforms?: Record<string, THREE.IUniform> } | undefined;
      const exposure = (env?.uniforms?.uExposure?.value as number) ?? 0.66;
      ballMat.uniforms.uExposure.value = exposure;
      flashMat.uniforms.uExposure.value = exposure;
      ringMat.uniforms.uExposure.value = exposure;
      puffMat.uniforms.uExposure.value = exposure;
      shardMat.uniforms.uExposure.value = exposure;

      // ---- fireball ----------------------------------------------------------
      // Radius goes as a decelerating power of time — fast out of the gate,
      // then coasting. Linear growth is the single most common thing that
      // makes a game explosion look cheap.
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        const born = i === 0 ? 0 : SECONDARIES[i - 1];
        const bt = (age - born) / (i === 0 ? 2.4 : 1.8);
        b.visible = bt >= 0 && bt < 1;
        if (!b.visible) continue;
        const size = i === 0 ? 1 : 0.62 - i * 0.06;
        const r = (11 + 38 * Math.pow(Math.min(1, bt), 0.34)) * scale * size;
        // The secondaries come from somewhere else along the wreckage, which is
        // what stops them reading as one ball pulsing.
        const off = i === 0 ? 0 : 1;
        b.position.set(
          origin.x + off * ((((seed >> (i * 5)) & 31) - 15) * 1.7) * scale,
          Math.max(origin.y, groundY + r * 0.35),
          origin.z + off * ((((seed >> (i * 7 + 3)) & 31) - 15) * 1.7) * scale,
        );
        b.scale.setScalar(r);
        const m = b.material as THREE.ShaderMaterial;
        m.uniforms.uT.value = bt;
        m.uniforms.uSeed.value = (seed + i * 37) % 97;
      }

      // ---- flash -------------------------------------------------------------
      flash.visible = age < 0.34;
      if (flash.visible) {
        flash.position.copy(ball.position);
        flash.scale.setScalar(780 * scale);
        flash.quaternion.copy(c.camera.quaternion);
        flashMat.uniforms.uT.value = age;
      }

      // ---- shock ring --------------------------------------------------------
      ring.visible = age < 1.15;
      if (ring.visible) {
        const rr = 30 + age * 640 * scale;
        ring.position.set(origin.x, groundY + 2.5, origin.z);
        ring.scale.set(rr, 1, rr);
        ringMat.uniforms.uT.value = age;
      }

      // ---- smoke -------------------------------------------------------------
      for (let i = 0; i < PUFFS; i++) {
        const p = puffs[i];
        const t = age - p.born;
        if (t <= 0) {
          puffData.setXYZ(i, 0, 9, 0);
          continue;
        }
        // Drag, then buoyancy: hot smoke slows down horizontally almost at
        // once and then just goes up, which is what makes it a column rather
        // than a sphere.
        const drag = Math.max(0, 1 - dt * 1.9);
        p.velocity.x *= drag;
        p.velocity.z *= drag;
        p.velocity.y = p.velocity.y * Math.max(0, 1 - dt * 0.5) + dt * 11;
        p.position.addScaledVector(p.velocity, dt);
        if (p.position.y < groundY + 3) p.position.y = groundY + 3;
        puffOffset.setXYZ(i, p.position.x, p.position.y, p.position.z);
        puffData.setXYZ(i, p.size * (0.35 + t * 0.55), t, Math.min(1, p.tone + t * 0.09));
        puffRot.setX(i, p.spin * t);
      }
      puffOffset.needsUpdate = true;
      puffData.needsUpdate = true;
      puffRot.needsUpdate = true;

      // ---- debris ------------------------------------------------------------
      let live = 0;
      for (let i = 0; i < SHARDS; i++) {
        const s = shards[i];
        if (s.dead) continue;
        s.velocity.y -= 9.81 * dt;
        s.velocity.multiplyScalar(Math.max(0, 1 - dt * 0.22));
        s.position.addScaledVector(s.velocity, dt);
        s.angle.x += s.spin.x * dt;
        s.angle.y += s.spin.y * dt;
        s.angle.z += s.spin.z * dt;
        const floor = groundY + s.size.y * 0.5;
        if (s.position.y <= floor) {
          s.position.y = floor;
          // Bounce once, badly, then lie there. Anything more elaborate is
          // physics nobody will look at.
          if (s.velocity.y < -3) {
            s.velocity.y *= -0.28;
            s.velocity.x *= 0.5;
            s.velocity.z *= 0.5;
            s.spin.multiplyScalar(0.4);
          } else {
            s.velocity.set(0, 0, 0);
            s.spin.set(0, 0, 0);
          }
        }
        _q.setFromEuler(s.angle);
        _m.compose(s.position, _q, s.size);
        shardMesh.setMatrixAt(live++, _m);
      }
      shardMesh.count = live;
      shardMesh.instanceMatrix.needsUpdate = true;
    },

    dispose() {
      off();
      ctx.scene.remove(group);
      ballGeo.dispose();
      for (const b of balls) (b.material as THREE.Material).dispose();
      flashGeo.dispose();
      flashMat.dispose();
      ringGeo.dispose();
      ringMat.dispose();
      quad.dispose();
      puffGeo.dispose();
      puffMat.dispose();
      shardGeo.dispose();
      shardMat.dispose();
      shardMesh.dispose();
    },
  };
}
