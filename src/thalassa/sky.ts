/**
 * A Mediterranean noon: deep blue overhead, a warm haze toward the sun, and
 * big soft cumulus standing round the horizon the way they frame the
 * painting. The light rig lives here too, since the sky decides it.
 *
 * Clouds are instanced billboards ("puffs"), a few hundred of them grouped
 * into cumulus with flat bottoms and sunlit tops, sorted back to front every
 * few frames so their soft edges blend.
 *
 * No backticks inside the GLSL: it is a template literal.
 */
import * as THREE from "three";
import { makeRng } from "@/shared/proc/rng";

export const SUN_DIR = new THREE.Vector3(-0.52, 0.74, -0.42).normalize();

const domeVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

const domeFrag = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -1.0, 1.0);
  float h = pow(1.0 - clamp(up, 0.0, 1.0), 3.0);
  vec3 col = mix(uZenith, uHorizon, h);
  // Below the horizon the sea haze.
  col = mix(col, uHorizon * 0.96, smoothstep(0.0, -0.08, up));
  float mu = max(dot(d, uSunDir), 0.0);
  col += uGlow * (pow(mu, 6.0) * 0.35 + pow(mu, 60.0) * 0.6);
  // The disc.
  col += vec3(1.0, 0.97, 0.9) * smoothstep(0.9993, 0.9997, mu) * 6.0;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const puffVert = /* glsl */ `
attribute vec3 aCentre;
attribute vec4 aPuff; // size, shade (0 base .. 1 top), rotation, opacity
varying vec2 vUv;
varying float vShade;
varying float vOpacity;
varying float vSun;
uniform vec3 uSunDir;
void main() {
  vUv = uv;
  vShade = aPuff.y;
  vOpacity = aPuff.w;
  vec4 mv = modelViewMatrix * vec4(aCentre, 1.0);
  float c = cos(aPuff.z), s = sin(aPuff.z);
  vec2 q = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * aPuff.x;
  mv.xy += q;
  // How much this puff faces the sun, seen from here.
  vec3 toSun = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  vSun = clamp(dot(normalize(vec3(q, 0.35 * aPuff.x)), toSun) * 0.5 + 0.5, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const puffFrag = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform vec3 uTop;
uniform vec3 uBase;
uniform vec3 uHaze;
varying vec2 vUv;
varying float vShade;
varying float vOpacity;
varying float vSun;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vOpacity;
  if (a < 0.01) discard;
  // Inside of the puff (the texture's own shading) and its place in the cloud.
  float lit = clamp(vShade * 0.7 + vSun * 0.45 + t.r * 0.25 + 0.08, 0.0, 1.0);
  vec3 col = mix(uBase, uTop, lit);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** A soft puff with a lit upper-left and a little texture inside. */
function puffTexture(): THREE.Texture {
  const n = 128;
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const ctx = c.getContext("2d")!;
  const r = makeRng("puff");
  for (let i = 0; i < 26; i++) {
    const x = n / 2 + (r.next() - 0.5) * n * 0.42;
    const y = n / 2 + (r.next() - 0.5) * n * 0.42;
    const rad = n * (0.16 + r.next() * 0.2);
    const g = ctx.createRadialGradient(x - rad * 0.25, y - rad * 0.3, 0, x, y, rad);
    const lum = Math.round(200 + 55 * (1 - (y / n)));
    g.addColorStop(0, `rgba(${lum},${lum},${lum},0.55)`);
    g.addColorStop(0.6, `rgba(${lum - 20},${lum - 20},${lum - 20},0.3)`);
    g.addColorStop(1, "rgba(160,160,160,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  // Fade to the edge so no square shows.
  const id = ctx.getImageData(0, 0, n, n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const d = Math.hypot(i - n / 2, j - n / 2) / (n / 2);
    const k = (j * n + i) * 4 + 3;
    id.data[k] = Math.round(id.data[k] * Math.max(0, Math.min(1, (1 - d) * 2.2)));
  }
  ctx.putImageData(id, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

interface Puff { x: number; y: number; z: number; size: number; shade: number; rot: number; op: number; drift: number }

export interface Sky {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sunDir: THREE.Vector3;
  update(dt: number, time: number, camera: THREE.Camera, focus: THREE.Vector3): void;
  setShadowSize(half: number, mapSize: number): void;
  dispose(): void;
}

export function createSky(): Sky {
  const group = new THREE.Group();
  group.name = "sky";

  const domeMat = new THREE.ShaderMaterial({
    vertexShader: domeVert,
    fragmentShader: domeFrag,
    uniforms: {
      uSunDir: { value: SUN_DIR.clone() },
      uZenith: { value: new THREE.Color("#2f7fd8") },
      uHorizon: { value: new THREE.Color("#d4ecf7") },
      uGlow: { value: new THREE.Color("#ffe6b0") },
    },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1900, 48, 24), domeMat);
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  group.add(dome);

  /* ---- light ---- */
  const sun = new THREE.DirectionalLight("#fff1d8", 3.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  const sc = sun.shadow.camera;
  sc.near = 1; sc.far = 600;
  let shadowHalf = 95;
  sc.left = -shadowHalf; sc.right = shadowHalf; sc.top = shadowHalf; sc.bottom = -shadowHalf;
  group.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight("#cfe9ff", "#a39a62", 1.15);
  group.add(hemi);

  /* ---- clouds ---- */
  const rng = makeRng("thalassa-clouds");
  const puffs: Puff[] = [];
  const addCloud = (cx: number, cy: number, cz: number, w: number, h: number, count: number, op = 1) => {
    for (let i = 0; i < count; i++) {
      const u = rng.next() * 2 - 1;
      const ang = rng.next() * Math.PI * 2;
      const rr = Math.sqrt(rng.next());
      const x = cx + Math.cos(ang) * rr * w;
      const z = cz + Math.sin(ang) * rr * w * 0.7;
      // A flat base and a heaped top: puffs further from the centre sit lower.
      const top = (1 - rr * 0.8) * h;
      const y = cy + Math.abs(u) * top;
      const size = (0.45 + rng.next() * 0.55) * Math.min(w, h * 1.6) * (1.1 - rr * 0.4);
      puffs.push({ x, y, z, size, shade: Math.min(1, (y - cy) / Math.max(1, h)), rot: rng.next() * 6.28, op: op * (0.75 + rng.next() * 0.25), drift: 0 });
    }
  };
  // Cumulus standing round the horizon.
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + rng.next() * 0.2;
    const r = 480 + rng.next() * 340;
    const w = 80 + rng.next() * 80;
    addCloud(Math.cos(a) * r, 30 + rng.next() * 60, Math.sin(a) * r, w, 55 + rng.next() * 60, 24 + Math.floor(rng.next() * 12));
  }
  // A few big ones overhead, high and slow.
  for (let i = 0; i < 7; i++) {
    const a = rng.next() * Math.PI * 2;
    const r = 120 + rng.next() * 260;
    addCloud(Math.cos(a) * r, 150 + rng.next() * 60, Math.sin(a) * r, 40 + rng.next() * 40, 18, 12, 0.85);
  }
  // Low banks over the sea to the south and east, where the painting's
  // clouds roll in at the bottom of the frame.
  for (let i = 0; i < 14; i++) {
    const a = -0.4 + (i / 14) * 2.2 + rng.next() * 0.1; // south-east quadrant
    const r = 300 + rng.next() * 140;
    addCloud(Math.cos(a) * r, 2 + rng.next() * 10, Math.sin(a) * r, 46 + rng.next() * 30, 26 + rng.next() * 14, 16, 0.95);
  }

  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute("position", base.getAttribute("position"));
  geo.setAttribute("uv", base.getAttribute("uv"));
  const centres = new Float32Array(puffs.length * 3);
  const params = new Float32Array(puffs.length * 4);
  const aCentre = new THREE.InstancedBufferAttribute(centres, 3);
  const aPuff = new THREE.InstancedBufferAttribute(params, 4);
  aCentre.setUsage(THREE.DynamicDrawUsage);
  aPuff.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aCentre", aCentre);
  geo.setAttribute("aPuff", aPuff);
  geo.instanceCount = puffs.length;
  const puffMap = puffTexture();
  const puffMat = new THREE.ShaderMaterial({
    vertexShader: puffVert,
    fragmentShader: puffFrag,
    uniforms: {
      uMap: { value: puffMap },
      uSunDir: { value: SUN_DIR.clone() },
      uTop: { value: new THREE.Color("#fffdf6") },
      uBase: { value: new THREE.Color("#c2d2e6") },
      uHaze: { value: new THREE.Color("#d4ecf7") },
    },
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const clouds = new THREE.Mesh(geo, puffMat);
  clouds.frustumCulled = false;
  clouds.renderOrder = 1;
  clouds.name = "clouds";
  group.add(clouds);

  const order = puffs.map((_, i) => i);
  const camPos = new THREE.Vector3();
  let sortClock = 0;
  const writePuffs = () => {
    for (let k = 0; k < order.length; k++) {
      const p = puffs[order[k]];
      centres[k * 3] = p.x + p.drift; centres[k * 3 + 1] = p.y; centres[k * 3 + 2] = p.z;
      params[k * 4] = p.size; params[k * 4 + 1] = p.shade; params[k * 4 + 2] = p.rot; params[k * 4 + 3] = p.op;
    }
    aCentre.needsUpdate = true;
    aPuff.needsUpdate = true;
  };
  writePuffs();

  return {
    group,
    sun,
    hemi,
    sunDir: SUN_DIR,
    update(dt, time, camera, focus) {
      camera.getWorldPosition(camPos);
      dome.position.copy(camPos);
      // The shadow follows the player, snapped to its texels so it does not swim.
      const texel = (shadowHalf * 2) / sun.shadow.mapSize.x;
      const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
      sun.target.position.set(fx, 0, fz);
      sun.position.set(fx + SUN_DIR.x * 300, SUN_DIR.y * 300, fz + SUN_DIR.z * 300);
      sun.target.updateMatrixWorld();
      // Drift, slowly, and keep back-to-front order.
      for (const p of puffs) p.drift = Math.sin(time * 0.015 + p.rot) * 9;
      sortClock -= dt;
      if (sortClock <= 0) {
        sortClock = 0.25;
        const d = (i: number) => {
          const p = puffs[i];
          const dx = p.x - camPos.x, dy = p.y - camPos.y, dz = p.z - camPos.z;
          return dx * dx + dy * dy + dz * dz;
        };
        order.sort((a, b) => d(b) - d(a));
      }
      writePuffs();
    },
    setShadowSize(half, mapSize) {
      shadowHalf = half;
      sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
      sc.updateProjectionMatrix();
      if (sun.shadow.mapSize.x !== mapSize) {
        sun.shadow.mapSize.set(mapSize, mapSize);
        sun.shadow.map?.dispose();
        sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
      }
    },
    dispose() {
      dome.geometry.dispose();
      domeMat.dispose();
      geo.dispose();
      base.dispose();
      puffMat.dispose();
      puffMap.dispose();
      sun.shadow.map?.dispose();
    },
  };
}
