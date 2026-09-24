/**
 * Grass you can walk through.
 *
 * Blades are one small curved strip, instanced by the tens of thousands,
 * in chunks of CHUNK metres that are built lazily when the player comes
 * near and kept afterwards. Only chunks inside the view radius are drawn,
 * so the cost is bounded by the radius, not by the size of the valley.
 *
 * Everything that moves happens in the vertex shader, in world space:
 *  - wind: a slow rolling gust plus a fast flutter, along the world's own
 *    wind direction and strength, bending each blade more at the tip
 *  - the player's feet: blades within a metre lean away from them
 *  - the distance fade: blades shrink to nothing at the edge of the radius,
 *    so the boundary of the field never pops
 *  - snow: blades shorten under snow cover and pale toward it
 *
 * Normals are pointed up (with a little of the blade's own), which is how
 * stylised grass is usually lit: a field reads as one soft surface instead
 * of forty thousand dark-edged cards. The tip glows faintly when the sun
 * is low and behind it, which is most of what makes a field look alive at
 * golden hour.
 *
 * No backticks inside the GLSL: it is a template literal.
 */
import * as THREE from "three";
import { fbm } from "./noise";

export const CHUNK = 12;

export interface GrassOptions {
  /** Ground height. */
  heightAt(x: number, z: number): number;
  /** 0 means no grass here (paths, water, under buildings), 1 full density. */
  density(x: number, z: number): number;
  /** Blades per square metre at density 1. */
  perSquareMetre: number;
  /** Draw radius in metres. */
  radius: number;
}

export interface Grass {
  group: THREE.Group;
  update(dt: number, time: number, player: THREE.Vector3, look: {
    windDir: number;
    wind: number;
    snow: number;
    tint: THREE.Color;
    sunDir: THREE.Vector3;
    sunColor: THREE.Color;
    night: number;
  }): void;
  /** Change density and radius, for a headset. Rebuilds lazily. */
  setQuality(perSquareMetre: number, radius: number): void;
  /** Chunks and blades currently drawn, for scripts. */
  stats(): { chunks: number; blades: number };
  dispose(): void;
}

const VERT_HEAD = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform float uWindStrength;
uniform vec3 uPlayer;
uniform float uRadius;
uniform float uSnow;
attribute vec3 aTip;
varying float vTip;
varying float vFade;
varying vec3 vTipColor;
`;

// Replaces three's project_vertex so the bend happens in world space, after
// the instance transform, which is the only space where wind has a direction.
const VERT_PROJECT = /* glsl */ `
vec4 wpos = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
vec3 root = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
float h = clamp(uv.y, 0.0, 1.0);
vTip = h;
vTipColor = aTip;
// Distance fade toward the edge of the field.
float d = distance(root.xz, uPlayer.xz);
float fade = 1.0 - smoothstep(uRadius * 0.72, uRadius, d);
vFade = fade;
// Snow presses the blades down.
float scaleY = fade * (1.0 - uSnow * 0.75);
wpos.y = root.y + (wpos.y - root.y) * scaleY;
wpos.xz = root.xz + (wpos.xz - root.xz) * max(fade, 0.2);
// Wind: a slow rolling gust across the field and a quick flutter per blade.
float phase = dot(root.xz, uWind) * 0.35;
float gust = sin(uTime * 1.3 - phase) * 0.5 + 0.5;
gust = gust * gust;
float flutter = sin(uTime * 7.0 + root.x * 3.7 + root.z * 2.3) * 0.12;
float bend = (0.15 + uWindStrength * 1.1) * (0.35 + gust) + flutter;
float k = h * h;
wpos.xz += uWind * bend * k * 0.55;
wpos.y -= abs(bend) * k * 0.12;
// Feet: blades lean away from the player within a metre and a half.
vec2 away = root.xz - uPlayer.xz;
float near = 1.0 - smoothstep(0.3, 1.5, length(away));
wpos.xz += normalize(away + vec2(0.0001)) * near * k * 0.45;
wpos.y -= near * k * 0.25;
vec4 mvPosition = viewMatrix * wpos;
gl_Position = projectionMatrix * mvPosition;
`;

const FRAG_HEAD = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uNight;
uniform vec3 uTint;
uniform float uSnow;
varying float vTip;
varying float vFade;
varying vec3 vTipColor;
`;

const FRAG_COLOR = /* glsl */ `
#include <color_fragment>
// Root dark, tip light, and the tip's own colour per blade.
vec3 rootCol = diffuseColor.rgb * 0.42;
diffuseColor.rgb = mix(rootCol, vTipColor, smoothstep(0.0, 1.0, vTip));
diffuseColor.rgb *= uTint;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.93, 0.97), uSnow * 0.6 * vTip);
`;

const FRAG_GLOW = /* glsl */ `
#include <aomap_fragment>
// Back-lit tips: when the sun is low, the far side of a blade glows.
float low = 1.0 - clamp(uSunDir.y * 2.5, 0.0, 1.0);
vec3 viewDir = normalize(vViewPosition);
float back = pow(max(0.0, dot(viewDir, normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz))), 3.0);
totalEmissiveRadiance += uSunColor * back * low * vTip * vTip * 0.55 * (1.0 - uNight);
`;

function bladeGeometry(): THREE.BufferGeometry {
  // A tapered, slightly curved strip: five segments, two triangles each.
  const segs = 5;
  const w = 0.055;
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const half = w * (1 - t * 0.92);
    const y = t;
    const curl = t * t * 0.18;
    positions.push(-half, y, curl, half, y, curl);
    uvs.push(0, t, 1, t);
    // Mostly up, a little forward: soft field lighting.
    normals.push(0, 0.85, 0.52, 0, 0.85, 0.52);
  }
  const index: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(index);
  return g;
}

function hash(x: number, z: number, s: number): number {
  let h = (x * 374761393 + z * 668265263 + s * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function createGrass(opts: GrassOptions): Grass {
  const group = new THREE.Group();
  group.name = "grass";
  const geo = bladeGeometry();
  const uniforms = {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2(1, 0) },
    uWindStrength: { value: 0.3 },
    uPlayer: { value: new THREE.Vector3() },
    uRadius: { value: opts.radius },
    uSnow: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color("#fff2cf") },
    uNight: { value: 0 },
    uTint: { value: new THREE.Color(1, 1, 1) },
  };
  const mat = new THREE.MeshStandardMaterial({ color: "#5d9a3c", roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + VERT_HEAD)
      .replace("#include <project_vertex>", VERT_PROJECT);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + FRAG_HEAD)
      .replace("#include <color_fragment>", FRAG_COLOR)
      .replace("#include <aomap_fragment>", FRAG_GLOW);
  };
  // The shadow pass needs the same bend, or the shadows stand still while
  // the blades move. It is cheaper to let grass cast none at all: a field's
  // self-shadowing is what the dark roots already fake.
  mat.customProgramCacheKey = () => "magician-grass";

  let perM2 = opts.perSquareMetre;
  let radius = opts.radius;
  const chunks = new Map<string, THREE.InstancedMesh>();
  const tipColor = new THREE.Color();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  function build(cx: number, cz: number): THREE.InstancedMesh {
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const target = Math.round(CHUNK * CHUNK * perM2);
    const pos: number[] = [];
    const tips: number[] = [];
    const mats: THREE.Matrix4[] = [];
    for (let i = 0; i < target * 2 && mats.length < target; i++) {
      const x = x0 + hash(cx, cz, i * 2) * CHUNK;
      const z = z0 + hash(cx, cz, i * 2 + 1) * CHUNK;
      const d = opts.density(x, z);
      if (d <= 0 || hash(cz, cx, i) > d) continue;
      // Clumps: blades are taller where a slow noise says the soil is good.
      const clump = fbm(x * 0.18, z * 0.18, 2);
      const h = (0.28 + clump * 0.55) * (0.7 + hash(cx, i, cz) * 0.6);
      const w = 0.8 + hash(i, cx, cz) * 0.6;
      q.setFromAxisAngle(up, hash(i, cz, cx) * Math.PI * 2);
      // A small random lean, so the field is not a crowd standing to attention.
      const lean = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (hash(cz, i, cx) - 0.5) * 0.5);
      q.multiply(lean);
      m.compose(p.set(x, opts.heightAt(x, z) - 0.02, z), q, s.set(w, h, w));
      mats.push(m.clone());
      // Tip colour: most blades a warm green, a few dry and golden, a few
      // with a blue-green cast, which is what grass looks like up close.
      const r = hash(i, i, cx + cz);
      if (r < 0.08) tipColor.setHSL(0.13 + r * 0.3, 0.55, 0.62);
      else if (r < 0.2) tipColor.setHSL(0.3, 0.45, 0.5);
      else tipColor.setHSL(0.22 + clump * 0.06, 0.55, 0.45 + hash(cx, i, i) * 0.12);
      tips.push(tipColor.r, tipColor.g, tipColor.b);
      pos.push(x, z);
    }
    const g = geo.clone();
    const mesh = new THREE.InstancedMesh(g, mat, Math.max(1, mats.length));
    for (let i = 0; i < mats.length; i++) mesh.setMatrixAt(i, mats[i]);
    mesh.count = mats.length;
    const tipAttr = new THREE.InstancedBufferAttribute(new Float32Array(tips.length ? tips : [0.4, 0.6, 0.3]), 3);
    g.setAttribute("aTip", tipAttr);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = true;
    // A bounding sphere around the chunk, so three can cull whole chunks.
    const cy = opts.heightAt(x0 + CHUNK / 2, z0 + CHUNK / 2);
    mesh.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(x0 + CHUNK / 2, cy, z0 + CHUNK / 2), CHUNK * 0.8 + 3);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = `grass-${cx},${cz}`;
    return mesh;
  }

  const wanted = new Set<string>();
  let lastCell = "";
  let builtThisFrame = 0;

  function refresh(player: THREE.Vector3) {
    const pcx = Math.floor(player.x / CHUNK), pcz = Math.floor(player.z / CHUNK);
    const key = `${pcx},${pcz}|${radius}|${perM2}`;
    if (key === lastCell && builtThisFrame === 0) return;
    lastCell = key;
    wanted.clear();
    const r = Math.ceil(radius / CHUNK) + 1;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = pcx + dx, cz = pcz + dz;
        const ccx = (cx + 0.5) * CHUNK, ccz = (cz + 0.5) * CHUNK;
        if (Math.hypot(ccx - player.x, ccz - player.z) > radius + CHUNK * 0.75) continue;
        wanted.add(`${cx},${cz}`);
      }
    }
    // Build at most two new chunks a frame, nearest first, so walking into a
    // new area never costs a visible hitch.
    builtThisFrame = 0;
    const missing = [...wanted].filter((k) => !chunks.has(k)).map((k) => {
      const [cx, cz] = k.split(",").map(Number);
      return { k, cx, cz, d: Math.hypot((cx + 0.5) * CHUNK - player.x, (cz + 0.5) * CHUNK - player.z) };
    }).sort((a, b) => a.d - b.d);
    for (const c of missing.slice(0, 2)) {
      const mesh = build(c.cx, c.cz);
      chunks.set(c.k, mesh);
      group.add(mesh);
      builtThisFrame++;
    }
    if (missing.length > 2) lastCell = ""; // come back next frame for the rest
    for (const [k, mesh] of chunks) mesh.visible = wanted.has(k);
  }

  return {
    group,
    update(dt, time, player, look) {
      refresh(player);
      uniforms.uTime.value = time;
      uniforms.uWind.value.set(Math.sin(look.windDir), Math.cos(look.windDir));
      uniforms.uWindStrength.value = look.wind;
      uniforms.uPlayer.value.copy(player);
      uniforms.uRadius.value = radius;
      uniforms.uSnow.value = look.snow;
      uniforms.uSunDir.value.copy(look.sunDir);
      uniforms.uSunColor.value.copy(look.sunColor);
      uniforms.uNight.value = look.night;
      uniforms.uTint.value.copy(look.tint);
    },
    setQuality(m2, r) {
      if (m2 === perM2 && r === radius) return;
      perM2 = m2;
      radius = r;
      for (const mesh of chunks.values()) { group.remove(mesh); mesh.geometry.dispose(); }
      chunks.clear();
      lastCell = "";
    },
    stats() {
      let blades = 0, n = 0;
      for (const mesh of chunks.values()) if (mesh.visible) { n++; blades += mesh.count; }
      return { chunks: n, blades };
    },
    dispose() {
      for (const mesh of chunks.values()) mesh.geometry.dispose();
      chunks.clear();
      geo.dispose();
      mat.dispose();
    },
  };
}
