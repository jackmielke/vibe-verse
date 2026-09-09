/**
 * The ground: a heightfield from the terrain tiles (about three metres a
 * sample) resampled to two metres and smoothed so a road does not step, with
 * every road graded into it (a flat bench the width of the road and its
 * gravel shoulder, a cut bank above and a fill bank below, a ditch on the
 * uphill side, driveways filling the ditch where they cross it), streams cut
 * in, ponds dug, and coloured by what the land data says grows there: mown
 * lawn near the houses, rough grass further out, forest floor under the wood
 * polygons, pasture on the farmland, sand and drift logs at Lytle Beach, mud
 * at the pond edges, and gravel feathering out from every road edge into the
 * grass. Rich Passage is at sea level, grey-green, with a wet band of shore.
 */
import * as THREE from "three";
import { mulberry32, lines, ringBounds, rings, type Neighbourhood, type Terrain } from "./geo";
import { buildRoadNet, sampleChain, type Chain } from "./roadnet";
import { disposeSurface, forestFloor, grass, surfaceMaterial } from "./textures";
import { asphaltWorld, disposeWorldSurface, driftwood, gravelWorld, noiseTexture, sandWorld } from "./textures.roads";

export interface Ground {
  group: THREE.Group;
  /** World height including the sea clamp. */
  heightAt(x: number, z: number): number;
  update(time: number): void;
  dispose(): void;
}

const WATER_VERT = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
void main() {
  vec3 p = position;
  vec4 w0 = modelMatrix * vec4(p, 1.0);
  // A long low swell coming up the passage, and a chop on top of it.
  p.y += sin((w0.x + w0.z * 0.6) * 0.035 + uTime * 0.45) * 0.09 + sin(w0.x * 0.11 + uTime * 0.7) * 0.04 + sin(w0.z * 0.09 - uTime * 0.5) * 0.035;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const WATER_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uCamera; uniform float uTime; uniform vec3 uSkyColor; uniform vec3 uDeep; uniform vec3 uShallow;
uniform vec3 uFogColor; uniform float uFogDensity;
varying vec3 vWorld;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
void main() {
  vec3 V = normalize(uCamera - vWorld);
  float n1 = vnoise(vWorld.xz * 0.5 + uTime * 0.12);
  float n2 = vnoise(vWorld.xz * 1.9 - uTime * 0.09);
  float n3 = vnoise(vWorld.xz * 0.07 + uTime * 0.03);
  vec3 N = normalize(vec3((n1 - 0.5) * 0.22, 1.0, (n2 - 0.5) * 0.22));
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  vec3 body = mix(uDeep, uShallow, n3 * 0.6);
  vec3 col = mix(body, uSkyColor, 0.3 + 0.62 * fres);
  vec3 L = normalize(vec3(-0.58, 0.57, 0.58));
  vec3 H = normalize(L + V);
  col += vec3(1.0, 0.96, 0.88) * pow(max(dot(N, H), 0.0), 260.0) * 0.6;
  float dist = length(uCamera - vWorld);
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}
`;

function smooth01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

export function buildGround(data: Neighbourhood, terrain: Terrain): Ground {
  const group = new THREE.Group();
  const [tl, br] = data.bbox;
  const pad = 120;
  const x0 = tl[0] - pad;
  const z0 = tl[1] - pad;
  const x1 = br[0] + pad;
  const z1 = br[1] + pad;
  const step = 2;
  const nx = Math.ceil((x1 - x0) / step) + 1;
  const nz = Math.ceil((z1 - z0) / step) + 1;
  const N = nx * nz;
  const net = buildRoadNet(data);

  // ---- Height: sample, then smooth the three-metre creases out. ----------------
  const H = new Float32Array(N);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) H[j * nx + i] = terrain.at(x0 + i * step, z0 + j * step);
  const tmp = new Float32Array(N);
  const blur = (g: Float32Array, passes: number) => {
    const k = [1, 4, 6, 4, 1];
    for (let p = 0; p < passes; p++) {
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          let s = 0;
          for (let o = -2; o <= 2; o++) s += k[o + 2] * g[j * nx + Math.min(nx - 1, Math.max(0, i + o))];
          tmp[j * nx + i] = s / 16;
        }
      }
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          let s = 0;
          for (let o = -2; o <= 2; o++) s += k[o + 2] * tmp[Math.min(nz - 1, Math.max(0, j + o)) * nx + i];
          g[j * nx + i] = s / 16;
        }
      }
    }
  };
  blur(H, 2);

  const gridAt = (g: Float32Array, x: number, z: number) => {
    const fx = Math.min(nx - 1.001, Math.max(0, (x - x0) / step));
    const fz = Math.min(nz - 1.001, Math.max(0, (z - z0) / step));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const a = g[j * nx + i];
    const b = g[j * nx + i + 1];
    const c = g[(j + 1) * nx + i];
    const d = g[(j + 1) * nx + i + 1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };

  // ---- Land weights, rasterised polygon by polygon. --------------------------
  const forest = new Float32Array(N);
  const sand = new Float32Array(N);
  const pasture = new Float32Array(N);
  const mud = new Float32Array(N);
  const lawn = new Float32Array(N);
  const paved = new Float32Array(N);
  const edge = new Float32Array(N).fill(9);
  const shoulderW = new Float32Array(N);
  const raster = (ring: number[][], fn: (k: number) => void) => {
    const b = ringBounds(ring);
    const j0 = Math.max(0, Math.ceil((b.minZ - z0) / step));
    const j1 = Math.min(nz - 1, Math.floor((b.maxZ - z0) / step));
    const xs: number[] = [];
    for (let j = j0; j <= j1; j++) {
      const z = z0 + j * step;
      xs.length = 0;
      for (let e = 0, n = ring.length; e < n; e++) {
        const p = ring[e];
        const q = ring[(e + 1) % n];
        if (p[1] > z !== q[1] > z) xs.push(p[0] + ((z - p[1]) * (q[0] - p[0])) / (q[1] - p[1]));
      }
      xs.sort((a, c) => a - c);
      for (let s = 0; s + 1 < xs.length; s += 2) {
        const i0 = Math.max(0, Math.ceil((xs[s] - x0) / step));
        const i1 = Math.min(nx - 1, Math.floor((xs[s + 1] - x0) / step));
        for (let i = i0; i <= i1; i++) fn(j * nx + i);
      }
    }
  };
  const stampMax = (g: Float32Array, v: number) => (k: number) => {
    if (g[k] < v) g[k] = v;
  };
  for (const l of data.land) {
    if (l.sub === "forest") for (const r of rings(l.g)) raster(r, stampMax(forest, 1));
    else if (l.sub === "shrub") for (const r of rings(l.g)) raster(r, stampMax(forest, 0.55));
    else if (l.sub === "sand") for (const r of rings(l.g)) raster(r, stampMax(sand, 1));
    else if (l.sub === "grass") for (const r of rings(l.g)) raster(r, stampMax(pasture, 0.6));
  }
  for (const l of data.landuse) {
    const rs = rings(l.g);
    if (l.sub === "agriculture" || l.cls === "orchard") for (const r of rs) raster(r, stampMax(pasture, 1));
    else if (l.sub === "recreation" || l.cls === "grass" || l.sub === "education" || l.sub === "horticulture") for (const r of rs) raster(r, stampMax(lawn, 1));
    else if (l.sub === "residential") for (const r of rs) raster(r, stampMax(lawn, 0.5));
    else if (l.sub === "construction") for (const r of rs) raster(r, stampMax(mud, 0.6));
  }
  // Lawn is mown where somebody lives: within a few metres of a building, fading out by thirty.
  for (const bld of data.buildings) {
    for (const r of rings(bld.g)) {
      const b = ringBounds(r);
      const reachM = 30;
      const i0 = Math.max(0, Math.floor((b.minX - reachM - x0) / step));
      const i1 = Math.min(nx - 1, Math.ceil((b.maxX + reachM - x0) / step));
      const j0 = Math.max(0, Math.floor((b.minZ - reachM - z0) / step));
      const j1 = Math.min(nz - 1, Math.ceil((b.maxZ + reachM - z0) / step));
      for (let j = j0; j <= j1; j++) {
        const z = z0 + j * step;
        const dz = Math.max(0, b.minZ - z, z - b.maxZ);
        for (let i = i0; i <= i1; i++) {
          const x = x0 + i * step;
          const dx = Math.max(0, b.minX - x, x - b.maxX);
          const d = Math.hypot(dx, dz);
          const w = 1 - smooth01((d - 8) / 22);
          const k = j * nx + i;
          if (lawn[k] < w) lawn[k] = w;
        }
      }
    }
  }
  // Paved parking: asphalt on the school grounds, gravel elsewhere. Both are graded flat.
  const school = data.landuse.filter((l) => l.sub === "education").flatMap((l) => rings(l.g)).map((r) => ({ r, b: ringBounds(r) }));
  for (const f of data.infra) {
    if (f.cls !== "parking") continue;
    for (const r of rings(f.g)) {
      const c = r[0];
      const asphalt = school.some(({ r: sr, b }) => c[0] >= b.minX && c[0] <= b.maxX && c[1] >= b.minZ && c[1] <= b.maxZ && pointInRingFast(c[0], c[1], sr));
      let sum = 0;
      let n = 0;
      raster(r, (k) => {
        sum += H[k];
        n++;
      });
      const mean = n ? sum / n : 0;
      raster(r, (k) => {
        if (asphalt) paved[k] = 1;
        else if (edge[k] > -1) edge[k] = -1;
        H[k] += (mean - H[k]) * 0.75;
      });
    }
  }

  // ---- Ponds: dug to a level, mud round the rim. Streams: a shallow channel. ----
  const ponds: { ring: number[]; level: number }[] = [];
  const pondMask = new Float32Array(N);
  for (const w of data.water) {
    if (w.cls !== "pond" && w.cls !== "basin") continue;
    for (const r of rings(w.g)) {
      let lo = Infinity;
      raster(r, (k) => {
        if (H[k] < lo) lo = H[k];
      });
      if (!isFinite(lo)) continue;
      const level = lo + 0.1;
      raster(r, (k) => (pondMask[k] = 1));
      ponds.push({ ring: r.flat(), level });
      // Dig with a soft rim so the bank slopes rather than steps.
      raster(r, (k) => (H[k] = Math.min(H[k], level - 0.8)));
    }
  }
  blur(pondMask, 2);
  for (let k = 0; k < N; k++) if (pondMask[k] > 0.02) mud[k] = Math.max(mud[k], Math.min(1, pondMask[k] * 1.6));
  const dig = new Float32Array(N);
  for (const w of data.water) {
    if (w.cls !== "stream") continue;
    for (const l of lines(w.g)) {
      for (let e = 0; e < l.length - 1; e++) {
        const [ax, az] = l[e];
        const [bx, bz] = l[e + 1];
        const R = 3.2;
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - R - x0) / step));
        const i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + R - x0) / step));
        const j0 = Math.max(0, Math.floor((Math.min(az, bz) - R - z0) / step));
        const j1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz) + R - z0) / step));
        const dx = bx - ax;
        const dz = bz - az;
        const l2 = dx * dx + dz * dz || 1e-9;
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const x = x0 + i * step;
            const z = z0 + j * step;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
            const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
            const b = 1 - smooth01(d / R);
            const k = j * nx + i;
            if (dig[k] < b) dig[k] = b;
          }
        }
      }
    }
  }
  for (let k = 0; k < N; k++) {
    if (dig[k] > 0) {
      H[k] -= 0.5 * dig[k];
      mud[k] = Math.max(mud[k], dig[k] * 0.85);
    }
  }

  // ---- Roads graded in, best road first, so a driveway meets the road it leaves. ----
  const lock = new Float32Array(N);
  const touched = new Map<number, [number, number]>();
  for (const c of net.chains) {
    const inner = c.w / 2 + c.shoulder;
    const R = inner + c.bank;
    // The profile: the ground along the road, averaged over the grading length, pinned to
    // whatever it meets at a trimmed end so there is no step at the junction.
    const samples = sampleChain(c, 2);
    const raw = samples.map((p) => gridAt(H, p.x, p.z));
    const win = Math.max(1, Math.round(c.grade / 2));
    const prof = raw.map((_, i) => {
      let s = 0;
      let n = 0;
      for (let o = -win; o <= win; o++) {
        const j = i + o;
        if (j < 0 || j >= raw.length) continue;
        const wgt = 1 - Math.abs(o) / (win + 1);
        s += raw[j] * wgt;
        n += wgt;
      }
      return s / n;
    });
    const pin = (end: 0 | 1) => {
      if (!(c.trim[end] > 0 || c.apron[end])) return;
      const ei = end === 0 ? 0 : raw.length - 1;
      const delta = raw[ei] - prof[ei];
      const span = Math.max(2, win * 2);
      for (let i = 0; i < raw.length; i++) {
        const dist = Math.abs(i - ei);
        if (dist > span) continue;
        prof[i] += delta * (1 - dist / (span + 1));
      }
    };
    pin(0);
    pin(1);
    const profAt = (s: number) => {
      const f = Math.max(0, Math.min(prof.length - 1.0001, s / 2));
      const i = Math.floor(f);
      return prof[i] + (prof[i + 1] - prof[i]) * (f - i);
    };
    touched.clear();
    let s0 = 0;
    for (let e = 0; e < c.pts.length - 1; e++) {
      const [ax, az] = c.pts[e];
      const [bx, bz] = c.pts[e + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6) continue;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - R - x0) / step));
      const i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + R - x0) / step));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - R - z0) / step));
      const j1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz) + R - z0) / step));
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = x0 + i * step;
          const z = z0 + j * step;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
          const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
          if (d > R) continue;
          const k = j * nx + i;
          const prev = touched.get(k);
          if (!prev || d < prev[0]) touched.set(k, [d, s0 + len * t]);
        }
      }
      s0 += len;
    }
    for (const [k, [d, s]] of touched) {
      const y = profAt(s);
      const kk = d <= inner ? 1 : 1 - smooth01((d - inner) / c.bank);
      const keff = kk * (1 - lock[k]);
      const natural = H[k];
      H[k] += (y - natural) * keff;
      if (c.ditch > 0 && d > inner) {
        const uphill = natural > y + 0.12 ? 1 : 0.2;
        const bump = Math.sin(Math.PI * Math.min(1, (d - inner) / 2.4));
        H[k] -= c.ditch * bump * uphill * (1 - lock[k]);
      }
      if (d <= inner) lock[k] = 1;
      const ed = d - c.w / 2;
      if (ed < edge[k]) {
        edge[k] = ed;
        shoulderW[k] = c.shoulder;
      }
    }
  }

  // The sea floor: nothing below four metres down, so the shore keeps a slope and the water has a bed.
  for (let k = 0; k < N; k++) if (H[k] < -4) H[k] = -4;
  // Soft edges on the land classes; the road edge and the paving stay crisp.
  blur(forest, 1);
  blur(pasture, 1);
  blur(lawn, 1);
  blur(mud, 1);
  blur(sand, 1);
  // Below about a metre and a half the ground is beach whatever the polygons say.
  for (let k = 0; k < N; k++) {
    const s = 1 - smooth01((H[k] - 0.9) / 1.4);
    if (s > sand[k]) sand[k] = s;
  }

  const heightAt = (x: number, z: number) => gridAt(H, x, z);

  // ---- The mesh. ---------------------------------------------------------------
  const pos = new Float32Array(N * 3);
  const uv = new Float32Array(N * 2);
  const blend = new Float32Array(N * 4);
  const road = new Float32Array(N * 4);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = x0 + i * step;
      const z = z0 + j * step;
      pos[k * 3] = x;
      pos[k * 3 + 1] = H[k];
      pos[k * 3 + 2] = z;
      uv[k * 2] = x;
      uv[k * 2 + 1] = z;
      blend[k * 4] = forest[k];
      blend[k * 4 + 1] = sand[k];
      blend[k * 4 + 2] = pasture[k];
      blend[k * 4 + 3] = mud[k];
      road[k * 4] = edge[k];
      road[k * 4 + 1] = shoulderW[k];
      road[k * 4 + 2] = lawn[k];
      road[k * 4 + 3] = paved[k];
    }
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let q = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      idx[q++] = a;
      idx[q++] = a + nx;
      idx[q++] = a + 1;
      idx[q++] = a + 1;
      idx[q++] = a + nx;
      idx[q++] = a + nx + 1;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("aBlend", new THREE.BufferAttribute(blend, 4));
  geo.setAttribute("aRoad", new THREE.BufferAttribute(road, 4));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();

  const lawnTex = grass();
  const floorTex = forestFloor();
  const gravelTex = gravelWorld();
  const sandTex = sandWorld();
  const asphaltTex = asphaltWorld();
  const noise = noiseTexture();
  const mat = surfaceMaterial(lawnTex, { roughness: 0.95 });
  mat.roughnessMap = null;
  mat.normalScale.set(0.7, 0.7);
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uFloor: { value: floorTex.map },
      uFloorN: { value: floorTex.normalMap },
      uGravel: { value: gravelTex.map },
      uGravelN: { value: gravelTex.normalMap },
      uSand: { value: sandTex.map },
      uSandN: { value: sandTex.normalMap },
      uPaved: { value: asphaltTex.map },
      uNoise: { value: noise },
    });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 aBlend; attribute vec4 aRoad; varying vec4 vBlend; varying vec4 vRoad; varying float vWy;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvBlend = aBlend; vRoad = aRoad; vWy = (modelMatrix * vec4(transformed, 1.0)).y;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform sampler2D uFloor; uniform sampler2D uFloorN; uniform sampler2D uGravel; uniform sampler2D uGravelN;
        uniform sampler2D uSand; uniform sampler2D uSandN; uniform sampler2D uPaved; uniform sampler2D uNoise;
        varying vec4 vBlend; varying vec4 vRoad; varying float vWy;
        float gGrav; float gWet; float gSand; float gForest;`,
      )
      .replace(
        "#include <map_fragment>",
        /* glsl */ `
        vec2 wuv = vMapUv;
        vec3 nz = texture2D(uNoise, wuv / 41.0).rgb;
        vec3 nz2 = texture2D(uNoise, wuv / 6.3 + 0.31).rgb;
        // Two scales of the same lawn so the tile never reads, then pulled toward a duller September green.
        vec3 lawnC = mix(texture2D(map, wuv / 3.0).rgb, texture2D(map, wuv / 7.7 + 0.43).rgb, 0.5);
        lawnC = mix(lawnC, vec3(dot(lawnC, vec3(0.3, 0.59, 0.11))), 0.18) * vec3(0.9, 0.88, 0.82);
        vec3 floorC = texture2D(uFloor, wuv / 4.0).rgb;
        // The shoulder gravel is duller and browner than the crushed rock on a fresh driveway: fines, dust, leaf litter.
        vec3 gravC = texture2D(uGravel, wuv / 1.5).rgb * vec3(0.74, 0.7, 0.62);
        vec3 sandC = texture2D(uSand, wuv / 2.0).rgb;
        vec3 pavedC = texture2D(uPaved, wuv / 2.0).rgb;
        float forest = vBlend.x; float sandW = vBlend.y; float pasture = vBlend.z; float mud = vBlend.w;
        float edge = vRoad.x; float shoulder = vRoad.y; float lawn = vRoad.z; float paved = vRoad.w;
        // Rough grass is yellower and patchy; a mown lawn is greener with the odd dry patch.
        vec3 rough = lawnC * vec3(1.0, 0.9, 0.62) * (0.7 + 0.6 * nz.r);
        vec3 dry = lawnC * vec3(1.28, 1.12, 0.74);
        vec3 mown = mix(lawnC, dry, smoothstep(0.52, 0.85, nz.g) * 0.6) * (0.88 + 0.24 * nz2.g);
        vec3 grassC = mix(rough, mown, lawn);
        vec3 pastureC = lawnC * vec3(1.12, 1.0, 0.6) * (0.78 + 0.45 * nz.b);
        vec3 col = mix(grassC, pastureC, pasture);
        col = mix(col, floorC * (0.8 + 0.35 * nz2.r), forest);
        col = mix(col, vec3(0.21, 0.17, 0.12) * (0.75 + 0.5 * nz2.b), mud);
        col = mix(col, sandC, sandW);
        // The shore is wet below half a metre or so, and a driftwood-brown line of wrack above it.
        gWet = (1.0 - smoothstep(0.1, 0.65, vWy)) * max(sandW, 0.5);
        col = mix(col, col * vec3(0.5, 0.52, 0.55), gWet);
        col = mix(col, col * vec3(0.7, 0.62, 0.5), sandW * (1.0 - smoothstep(0.0, 0.35, abs(vWy - 1.55))) * 0.7 * step(0.5, nz2.r));
        // Gravel from the road edge, the grass growing into it unevenly.
        float fe = edge + (nz2.b - 0.5) * 0.8 + (nz.b - 0.5) * 0.3;
        gGrav = 1.0 - smoothstep(shoulder - 0.3, shoulder + 0.6, fe);
        gGrav = max(gGrav, 1.0 - smoothstep(-0.6, -0.2, edge));
        vec3 gravTint = mix(gravC, gravC * vec3(0.8, 0.92, 0.7), smoothstep(shoulder - 0.6, shoulder + 0.7, fe) * 0.55);
        col = mix(col, gravTint, gGrav);
        col = mix(col, pavedC, paved);
        gSand = sandW; gForest = forest;
        diffuseColor.rgb *= col;`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `float roughnessFactor = roughness * mix(1.0, 0.5, gWet) * mix(1.0, 0.9, gForest);`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        /* glsl */ `
        vec3 nL = texture2D(normalMap, vNormalMapUv / 3.0).xyz;
        vec3 nF = texture2D(uFloorN, vNormalMapUv / 4.0).xyz;
        vec3 nG = texture2D(uGravelN, vNormalMapUv / 1.5).xyz;
        vec3 nS = texture2D(uSandN, vNormalMapUv / 2.0).xyz;
        vec3 mapN = mix(nL, nF, gForest);
        mapN = mix(mapN, nS, gSand);
        mapN = mix(mapN, nG, gGrav);
        mapN = mapN * 2.0 - 1.0;
        mapN.xy *= normalScale;
        normal = normalize(tbn * mapN);`,
      );
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  group.add(mesh);

  // ---- The sea: Rich Passage, at 0 m, out to the horizon. ----------------------
  const waterMat = new THREE.ShaderMaterial({
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uCamera: { value: new THREE.Vector3() },
      uSkyColor: { value: new THREE.Color(0x9db0bf) },
      uDeep: { value: new THREE.Color(0x24393b) },
      uShallow: { value: new THREE.Color(0x3d5a57) },
      uFogColor: { value: new THREE.Color(0xcfd8e2) },
      uFogDensity: { value: 0.0011 },
    },
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000, 90, 90).rotateX(-Math.PI / 2), waterMat);
  water.position.set(0, 0.05, 400);
  group.add(water);

  // ---- Ponds: still, dark, at their own level. -----------------------------------
  const pondMat = new THREE.MeshStandardMaterial({ color: 0x1d2a24, roughness: 0.12, metalness: 0.0, envMapIntensity: 1.2 });
  const pondGeos: THREE.BufferGeometry[] = [];
  for (const p of ponds) {
    const shape = new THREE.Shape();
    for (let i = 0; i < p.ring.length; i += 2) {
      if (i === 0) shape.moveTo(p.ring[i], -p.ring[i + 1]);
      else shape.lineTo(p.ring[i], -p.ring[i + 1]);
    }
    const g = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
    pondGeos.push(g);
    const m = new THREE.Mesh(g, pondMat);
    m.position.y = p.level;
    m.receiveShadow = true;
    group.add(m);
  }

  // ---- Driftwood along the wrack line at Lytle Beach. ----------------------------
  const wood = driftwood();
  const logMat = surfaceMaterial({ map: wood.map, normalMap: wood.normalMap, roughnessMap: wood.map }, { roughness: 0.92 });
  logMat.roughnessMap = null;
  const logGeo = new THREE.CylinderGeometry(0.78, 1, 1, 8, 1).rotateZ(Math.PI / 2);
  const logs: THREE.Matrix4[] = [];
  const rnd = mulberry32(9090);
  const beach = data.land.filter((l) => l.sub === "sand").flatMap((l) => rings(l.g));
  for (const ring of beach) {
    const b = ringBounds(ring);
    const cand: { x: number; z: number; gx: number; gz: number }[] = [];
    for (let z = b.minZ - 30; z <= b.maxZ + 30; z += 1.5) {
      for (let x = b.minX - 30; x <= b.maxX + 30; x += 1.5) {
        const h = heightAt(x, z);
        // The wrack line sits at the top of the beach; on the mapped beach itself the logs
        // are thrown right up onto the bench above it by the winter storms.
        const onBeach = x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && pointInRingFast(x, z, ring);
        if (h < 1.42 || h > (onBeach ? 3.4 : 2.15)) continue;
        if (gridAt(forest, x, z) > 0.3) continue;
        const gx = heightAt(x + 2, z) - heightAt(x - 2, z);
        const gz = heightAt(x, z + 2) - heightAt(x, z - 2);
        cand.push({ x, z, gx, gz });
      }
    }
    const count = Math.min(70, Math.floor(cand.length / 5));
    for (let i = 0; i < count && cand.length; i++) {
      const c = cand.splice(Math.floor(rnd() * cand.length), 1)[0];
      const along = Math.atan2(c.gx, -c.gz) + Math.PI / 2 + (rnd() - 0.5) * 0.9;
      const len = 2.5 + rnd() * 7;
      const r = 0.16 + rnd() * 0.3;
      const y = heightAt(c.x, c.z) + r * 0.55;
      const m = new THREE.Matrix4().compose(new THREE.Vector3(c.x, y, c.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 6.28, along, (rnd() - 0.5) * 0.08)), new THREE.Vector3(len, r, r));
      logs.push(m);
    }
  }
  const logMesh = new THREE.InstancedMesh(logGeo, logMat, Math.max(1, logs.length));
  logs.forEach((m, i) => logMesh.setMatrixAt(i, m));
  logMesh.count = logs.length;
  logMesh.instanceMatrix.needsUpdate = true;
  logMesh.castShadow = true;
  logMesh.receiveShadow = true;
  group.add(logMesh);

  return {
    group,
    heightAt,
    update(time) {
      waterMat.uniforms.uTime.value = time;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      disposeSurface(lawnTex);
      disposeSurface(floorTex);
      disposeWorldSurface(gravelTex);
      disposeWorldSurface(sandTex);
      disposeWorldSurface(asphaltTex);
      disposeWorldSurface(wood);
      noise.dispose();
      water.geometry.dispose();
      waterMat.dispose();
      pondMat.dispose();
      for (const g of pondGeos) g.dispose();
      logGeo.dispose();
      logMat.dispose();
    },
  };
}

function pointInRingFast(x: number, z: number, r: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0];
    const zi = r[i][1];
    const xj = r[j][0];
    const zj = r[j][1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Let the water shader know where the eye is, and match its fog to the scene's. */
export function updateWaterCamera(ground: Ground, camera: THREE.Camera): void {
  const water = ground.group.children.find((c) => (c as THREE.Mesh).material && ((c as THREE.Mesh).material as THREE.ShaderMaterial).uniforms?.uCamera) as THREE.Mesh | undefined;
  if (!water) return;
  const u = (water.material as THREE.ShaderMaterial).uniforms;
  (u.uCamera.value as THREE.Vector3).copy(camera.position);
  const fog = (camera.parent as THREE.Scene | null)?.fog ?? null;
  const scene = fog ? null : findScene(ground.group);
  const f = fog ?? scene?.fog ?? null;
  if (f && (f as THREE.FogExp2).isFogExp2) {
    (u.uFogColor.value as THREE.Color).copy(f.color);
    u.uFogDensity.value = (f as THREE.FogExp2).density;
    (u.uSkyColor.value as THREE.Color).copy(f.color).lerp(new THREE.Color(0x8fa6b8), 0.4);
  }
}

function findScene(o: THREE.Object3D): THREE.Scene | null {
  let p: THREE.Object3D | null = o;
  while (p) {
    if ((p as THREE.Scene).isScene) return p as THREE.Scene;
    p = p.parent;
  }
  return null;
}
