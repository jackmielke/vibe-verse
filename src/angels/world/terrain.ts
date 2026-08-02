/**
 * The ground.
 *
 * One mesh for the 44 km box, plus the mountains that stand outside it.
 *
 * There is no clipmap and no streaming here, and that is a deliberate call:
 * this world is flown over, not walked across. At 300 knots you are never
 * close enough to any one hillside for its triangle size to matter, and a
 * single static mesh at 150 m spacing draws in one call, needs no per-frame
 * rebuild, and cannot pop. What you spend the budget on instead is the
 * shader — the street grid, the urban tint and the aerial perspective are what
 * make the ground read as a city from three thousand feet, and none of them
 * care how many triangles are underneath.
 *
 * The mountains are separate geometry outside the field entirely. Rainier is
 * 94 km away and 4.4 km tall; putting it in the height field would mean a box
 * five times larger for one landmark.
 */
import * as THREE from "three";
import type { AngelsCtx, System, TerrainService } from "../types";
import { AERIAL_GLSL, ENV_UNIFORMS_GLSL, OUTPUT_GLSL } from "./env";
import type { EnvService } from "./sky";
import {
  EXTENT,
  PEAKS,
  RIDGES,
  latToZ,
  lonToX,
} from "./geo";
import {
  SURFACE_LAND,
  buildHeightField,
  sampleHeight,
  sampleShore,
  sampleSurface,
  sampleSurfaceHeight,
  type HeightField,
} from "./field";

const RES: Record<string, number> = { low: 144, medium: 224, high: 320, ultra: 416 };

/**
 * Where the built-up areas are. Density 1 is downtown; 0 is forest.
 *
 * Seattle from the air is not uniformly urban — it is a dense core, a long
 * low-rise carpet either side of it, and then trees. Painting that gradient is
 * what stops the whole box looking like one enormous suburb.
 */
const URBAN: Array<{ lat: number; lon: number; radius: number; density: number }> = [
  { lat: 47.606, lon: -122.334, radius: 2200, density: 1.0 }, // downtown
  { lat: 47.62, lon: -122.35, radius: 1500, density: 0.8 }, // Seattle Center / Belltown
  { lat: 47.63, lon: -122.32, radius: 2200, density: 0.72 }, // Capitol Hill
  { lat: 47.66, lon: -122.32, radius: 2600, density: 0.6 }, // U District
  { lat: 47.59, lon: -122.33, radius: 2400, density: 0.66 }, // SODO
  { lat: 47.57, lon: -122.38, radius: 2600, density: 0.5 }, // West Seattle
  { lat: 47.67, lon: -122.38, radius: 2600, density: 0.55 }, // Ballard
  { lat: 47.7, lon: -122.33, radius: 3200, density: 0.44 }, // north Seattle
  { lat: 47.55, lon: -122.3, radius: 3400, density: 0.46 }, // Rainier Valley
  { lat: 47.615, lon: -122.197, radius: 1600, density: 0.9 }, // Bellevue core
  { lat: 47.61, lon: -122.16, radius: 3000, density: 0.45 }, // Bellevue spread
  { lat: 47.68, lon: -122.2, radius: 2400, density: 0.42 }, // Kirkland
  { lat: 47.49, lon: -122.21, radius: 2400, density: 0.44 }, // Renton
  { lat: 47.45, lon: -122.29, radius: 3000, density: 0.4 }, // SeaTac / Burien
  { lat: 47.73, lon: -122.32, radius: 3000, density: 0.35 }, // Shoreline
  { lat: 47.65, lon: -122.13, radius: 2600, density: 0.4 }, // Redmond
];

function urbanAt(x: number, z: number): number {
  let d = 0;
  for (const u of URBAN) {
    const dx = x - lonToX(u.lon);
    const dz = z - latToZ(u.lat);
    const r = Math.hypot(dx, dz) / u.radius;
    if (r < 2.6) d = Math.max(d, u.density * Math.exp(-r * r * 0.85));
  }
  return Math.min(1, d);
}

export function createTerrain(ctx: AngelsCtx): System {
  const env = ctx.services.env as EnvService | undefined;
  const res = RES[ctx.quality] ?? 288;
  const field = buildHeightField(res);

  const group = new THREE.Group();
  group.name = "terrain";
  ctx.scene.add(group);

  const uniforms: Record<string, THREE.IUniform> = env
    ? (env.uniforms as unknown as Record<string, THREE.IUniform>)
    : {};

  const groundMat = new THREE.ShaderMaterial({
    uniforms,
    vertexColors: true,
    fog: false,
    vertexShader: /* glsl */ `
      attribute float aUrban;
      varying vec3 vColor;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vUrban;
      varying float vDist;
      void main() {
        vColor = color;
        vUrban = aUrban;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormal = normalize(normalMatrix * normal);
        vec4 view = viewMatrix * world;
        vDist = -view.z;
        gl_Position = projectionMatrix * view;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vUrban;
      varying float vDist;
      ${ENV_UNIFORMS_GLSL}
      ${OUTPUT_GLSL}
      ${AERIAL_GLSL}

      float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      /** Distance to the nearest gridline of a given spacing, in metres. */
      float gridLine(vec2 p, float spacing) {
        vec2 g = abs(fract(p / spacing) - 0.5) * spacing;
        return min(g.x, g.y);
      }

      void main() {
        vec3 base = vColor;
        vec2 w = vWorld.xz;

        // ---- the city, drawn rather than modelled -------------------------
        // Seattle's street grid is 400-foot blocks over most of the city, with
        // arterials about every half mile. Both are visible from a jet and
        // neither is worth a single triangle.
        if (vUrban > 0.02) {
          float block = 1.0 - smoothstep(2.0, 8.0, gridLine(w, 122.0));
          float arterial = 1.0 - smoothstep(4.0, 14.0, gridLine(w, 805.0));
          float road = max(block * 0.55, arterial);

          // Lots between the streets: a stable per-cell hash so the same block
          // is the same colour every frame and from every altitude.
          vec2 cell = floor(w / 122.0);
          float r = hash21(cell);
          vec3 lot = mix(vec3(0.33, 0.33, 0.30), vec3(0.60, 0.57, 0.51), r);
          lot = mix(lot, vec3(0.44, 0.36, 0.32), step(0.82, r)); // the odd roof
          vec3 street = vec3(0.24, 0.24, 0.25);

          vec3 city = mix(lot, street, road);
          base = mix(base, city, vUrban * 0.86);

          // Sodium and LED street light once the sun is down.
          base += uNight * vUrban * road * vec3(0.30, 0.22, 0.09);
          base += uNight * vUrban * step(0.955, r) * vec3(0.34, 0.30, 0.20);
        }

        // Large-scale variation so open ground is not flat paint. Smoothly
        // interpolated, not a per-cell hash: a hash gives you a visible
        // checkerboard of 340-metre squares, which is worse than flat paint.
        vec2 g = w / 620.0;
        vec2 gi = floor(g);
        vec2 gf = g - gi;
        gf = gf * gf * (3.0 - 2.0 * gf);
        float v = mix(mix(hash21(gi), hash21(gi + vec2(1.0, 0.0)), gf.x),
                      mix(hash21(gi + vec2(0.0, 1.0)), hash21(gi + vec2(1.0, 1.0)), gf.x), gf.y);
        base *= 0.88 + 0.24 * v;

        // ---- light --------------------------------------------------------
        vec3 n = normalize(vNormal);
        float ndl = max(dot(n, uSunDir), 0.0);
        // Wrapped diffuse: real terrain bounces enough light into its own
        // shadowed faces that a hard terminator looks like a bug.
        float wrap = max((dot(n, uSunDir) + 0.35) / 1.35, 0.0);
        vec3 lit = base * (uSunColor * (ndl * 0.95 + wrap * 0.30) + uSkyColor * (0.26 + n.y * 0.14));
        lit *= mix(1.0, 0.14, uNight);

        gl_FragColor = vec4(outputColor(applyAerial(lit, vDist, vWorld.y)), 1.0);
      }
    `,
  });

  // ---- ground mesh --------------------------------------------------------
  const n = res + 1;
  const positions = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const urban = new Float32Array(n * n);
  const step = field.step;

  // Albedos, not screen colours. Seattle's summer green is a dusty
  // yellow-green rather than the emerald a colour picker reaches for, and the
  // dry grass of August pushes it further that way.
  const cShore = new THREE.Color(0xbcae8a);
  const cGrass = new THREE.Color(0x6a8046);
  const cForest = new THREE.Color(0x36502e);
  const cHigh = new THREE.Color(0x6b6656);
  const cBed = new THREE.Color(0x24363a);
  const tmp = new THREE.Color();

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      const x = -EXTENT + i * step;
      const z = -EXTENT + j * step;
      const h = field.height[idx];
      positions[idx * 3] = x;
      positions[idx * 3 + 1] = h;
      positions[idx * 3 + 2] = z;

      const s = field.surface[idx];
      const u = s === SURFACE_LAND ? urbanAt(x, z) : 0;
      urban[idx] = u;

      if (s !== SURFACE_LAND) {
        tmp.copy(cBed);
      } else {
        const shore = field.shore[idx];
        // Beach right at the water, grass behind it, forest on the slopes,
        // and bare rock only where the foothills climb out of the trees.
        // A beach, not a desert: the sand band is metres wide, and at 150 m
        // sampling it is mostly there to keep the shoreline from being a hard
        // green-to-blue edge.
        tmp.copy(cShore).lerp(cGrass, Math.min(1, Math.max(0, (shore - 6) / 55)));
        tmp.lerp(cForest, Math.min(1, Math.max(0, (h - 30) / 150)) * (1 - u * 0.8));
        tmp.lerp(cHigh, Math.min(1, Math.max(0, (h - 320) / 420)));
      }
      colors[idx * 3] = tmp.r;
      colors[idx * 3 + 1] = tmp.g;
      colors[idx * 3 + 2] = tmp.b;
    }
  }

  const indices = new Uint32Array(res * res * 6);
  let k = 0;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("aUrban", new THREE.BufferAttribute(urban, 1));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const ground = new THREE.Mesh(geo, groundMat);
  ground.frustumCulled = false;
  ground.name = "ground";
  group.add(ground);

  // ---- the world past the box ---------------------------------------------
  // A skirt so the terrain does not end in a visible cliff edge, and the
  // mountains, which are the reason anyone looks at the horizon here at all.
  group.add(buildSkirt(groundMat));
  group.add(buildMountains(uniforms, ctx.quality));

  const service: TerrainService = {
    heightAt: (x, z) => sampleHeight(field, x, z),
    surfaceAt: (x, z) => sampleSurfaceHeight(field, x, z),
    isWater: (x, z) => sampleSurface(field, x, z) !== SURFACE_LAND,
    extent: EXTENT,
  };
  ctx.services.terrain = service;
  // The field itself, for anything that wants more than the service exposes.
  ctx.services.heightField = field;

  return {
    dispose() {
      ctx.scene.remove(group);
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
      });
      groundMat.dispose();
      if (ctx.services.terrain === service) delete ctx.services.terrain;
      delete ctx.services.heightField;
    },
  };
}

/**
 * A low green plain running from the edge of the box out to the horizon.
 *
 * Without it the terrain simply stops 22 km out, and from 10,000 feet that
 * edge is the single most immersion-breaking thing in the frame.
 */
function buildSkirt(material: THREE.Material): THREE.Mesh {
  const inner = EXTENT;
  const outer = 200000;
  const seg = 64;
  const pos: number[] = [];
  const col: number[] = [];
  const urb: number[] = [];
  const idx: number[] = [];

  const push = (x: number, y: number, z: number, c: THREE.Color) => {
    pos.push(x, y, z);
    col.push(c.r, c.g, c.b);
    urb.push(0);
    return pos.length / 3 - 1;
  };

  const near = new THREE.Color(0x33472c);
  const far = new THREE.Color(0x2d3b3c);

  // A ring of quads around the box: inner edge at the box boundary, outer edge
  // far enough away to be under the haze.
  for (let i = 0; i <= seg; i++) {
    const t = (i / seg) * Math.PI * 2;
    const cx = Math.cos(t);
    const cz = Math.sin(t);
    // Square the circle so the inner ring meets the box corners.
    const m = 1 / Math.max(Math.abs(cx), Math.abs(cz));
    const a = push(cx * m * inner, 0.2, cz * m * inner, near);
    const b = push(cx * outer, -30, cz * outer, far);
    if (i > 0) {
      idx.push(a - 2, b - 2, a, a, b - 2, b);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute("aUrban", new THREE.Float32BufferAttribute(urb, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

/**
 * Rainier, Baker, the Olympics and the Cascade crest.
 *
 * Volcanoes as tapered cones with a snow line, ranges as extruded ridges with
 * a noisy crest. Neither is a real mountain and neither needs to be: at 60 to
 * 150 km, through this much haze, what you perceive is a silhouette and a
 * snow line, and those are exactly the two things this gets right.
 */
function buildMountains(uniforms: Record<string, THREE.IUniform>, quality: string): THREE.Group {
  const group = new THREE.Group();
  group.name = "mountains";

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexColors: true,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vColor;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying float vDist;
      void main() {
        vColor = color;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormal = normalize(normalMatrix * normal);
        vec4 view = viewMatrix * world;
        vDist = -view.z;
        gl_Position = projectionMatrix * view;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying float vDist;
      ${ENV_UNIFORMS_GLSL}
      ${OUTPUT_GLSL}
      ${AERIAL_GLSL}
      void main() {
        vec3 n = normalize(vNormal);
        float ndl = max(dot(n, uSunDir), 0.0);
        float wrap = max((dot(n, uSunDir) + 0.4) / 1.4, 0.0);
        vec3 lit = vColor * (uSunColor * (ndl * 0.82 + wrap * 0.34) + uSkyColor * 0.34);
        lit *= mix(1.0, 0.16, uNight);
        gl_FragColor = vec4(outputColor(applyAerial(lit, vDist, vWorld.y)), 1.0);
      }
    `,
  });

  const rock = new THREE.Color(0x6a7080);
  const snow = new THREE.Color(0xeef3fb);
  const tmp = new THREE.Color();
  const segs = quality === "low" ? 20 : 40;

  for (const peak of PEAKS) {
    const cx = lonToX(peak.at[1]);
    const cz = latToZ(peak.at[0]);
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const rings = 8;

    for (let r = 0; r <= rings; r++) {
      const tr = r / rings;
      for (let s = 0; s <= segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        // A volcano's profile is concave, not straight: steep at the summit,
        // flaring out at the base. pow 1.7 on the radius does it.
        const radius = peak.radius * Math.pow(1 - tr, 1.7);
        // Ridges radiating off the summit — enough to break the silhouette.
        const ridge = 1 + 0.11 * Math.sin(a * 7 + peak.height) * tr;
        const y = peak.height * tr;
        pos.push(cx + Math.cos(a) * radius * ridge, y, cz + Math.sin(a) * radius * ridge);
        const snowy = Math.min(1, Math.max(0, (y - peak.snow) / 500));
        tmp.copy(rock).lerp(snow, snowy);
        col.push(tmp.r, tmp.g, tmp.b);
      }
    }
    const row = segs + 1;
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < segs; s++) {
        const a = r * row + s;
        idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  for (const ridgeSpec of RIDGES) {
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const pts = ridgeSpec.points.map((p) => new THREE.Vector2(lonToX(p[1]), latToZ(p[0])));
    const curve = new THREE.SplineCurve(pts);
    const samples = 64;
    let vi = 0;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const p = curve.getPoint(t);
      const tan = curve.getTangent(t);
      const nx = -tan.y;
      const nz = tan.x;
      // Peaks and cols along the crest, from two incommensurate sines so it
      // never visibly repeats.
      const wob = Math.sin(t * 37) * 0.5 + Math.sin(t * 13.7 + 1.3) * 0.5;
      const h = ridgeSpec.height + wob * ridgeSpec.variance;
      const w = ridgeSpec.width;
      const profile: Array<[number, number]> = [
        [-1, 0],
        [-0.45, h * 0.62],
        [0, h],
        [0.45, h * 0.58],
        [1, 0],
      ];
      for (const [off, y] of profile) {
        pos.push(p.x + nx * off * w * 0.5, y, p.y + nz * off * w * 0.5);
        const snowy = Math.min(1, Math.max(0, (y - 1550) / 500));
        tmp.copy(rock).lerp(snow, snowy);
        col.push(tmp.r, tmp.g, tmp.b);
      }
      if (i > 0) {
        for (let s = 0; s < 4; s++) {
          const a = vi - 5 + s;
          const b = vi + s;
          idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
      vi += 5;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  return group;
}

export type { HeightField };
export { sampleHeight, sampleShore, sampleSurface, sampleSurfaceHeight };
