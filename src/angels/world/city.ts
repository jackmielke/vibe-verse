/**
 * The built world: skylines, landmarks, bridges and runways.
 *
 * Two tiers, and the split is the whole design.
 *
 * **Fill** is eleven thousand boxes in three instanced draw calls, scattered
 * by the same urban-density field the terrain shader tints itself with. None
 * of them is a real building and none of them needs to be — from a jet, a
 * skyline is a *histogram*, and getting the distribution of heights right in
 * each neighbourhood is what makes Belltown read as Belltown.
 *
 * **Heroes** are the two dozen structures a Seattleite would name, each at its
 * real address with its real height, each modelled well enough to recognise in
 * silhouette. Those are what you navigate by. The Needle north-west of
 * downtown, Columbia Center as the one tower that is obviously tallest, the
 * two floating bridges lying parallel across the lake — get those right and
 * the eleven thousand boxes become a city.
 */
import * as THREE from "three";
import type { AngelsCtx, System, TerrainService } from "../types";
import { AERIAL_GLSL, ENV_UNIFORMS_GLSL, OUTPUT_GLSL } from "./env";
import type { EnvService } from "./sky";
import {
  AIRPORTS,
  BRIDGES,
  LANDMARKS,
  landmarkHull,
  latToZ,
  lonToX,
  type Landmark,
} from "./geo";

const BUILDING_BUDGET: Record<string, number> = {
  low: 3200,
  medium: 6500,
  high: 11000,
  ultra: 16000,
};

/** Where the fill buildings go, and how tall they get there. */
const DISTRICTS: Array<{
  lat: number;
  lon: number;
  radius: number;
  /** Typical height, metres. */
  base: number;
  /** Height of the tallest thing here. */
  peak: number;
  /** Buildings per square kilometre. */
  density: number;
}> = [
  { lat: 47.6055, lon: -122.334, radius: 900, base: 55, peak: 190, density: 900 }, // downtown core
  { lat: 47.6115, lon: -122.337, radius: 800, base: 42, peak: 150, density: 800 }, // Denny Triangle
  { lat: 47.6215, lon: -122.338, radius: 900, base: 30, peak: 90, density: 700 }, // South Lake Union
  { lat: 47.6165, lon: -122.348, radius: 800, base: 26, peak: 70, density: 620 }, // Belltown
  { lat: 47.5985, lon: -122.331, radius: 700, base: 24, peak: 60, density: 520 }, // Pioneer Square
  { lat: 47.6285, lon: -122.319, radius: 1200, base: 14, peak: 40, density: 430 }, // Capitol Hill
  { lat: 47.6595, lon: -122.315, radius: 1100, base: 15, peak: 55, density: 430 }, // U District
  { lat: 47.5905, lon: -122.328, radius: 1600, base: 12, peak: 32, density: 260 }, // SODO
  { lat: 47.5665, lon: -122.386, radius: 1500, base: 9, peak: 28, density: 300 }, // West Seattle Junction
  { lat: 47.6685, lon: -122.383, radius: 1400, base: 11, peak: 34, density: 330 }, // Ballard
  { lat: 47.6465, lon: -122.35, radius: 900, base: 10, peak: 26, density: 300 }, // Fremont
  { lat: 47.703, lon: -122.335, radius: 2200, base: 8, peak: 20, density: 230 }, // north Seattle
  { lat: 47.545, lon: -122.298, radius: 2400, base: 8, peak: 22, density: 220 }, // Rainier Valley
  { lat: 47.615, lon: -122.196, radius: 800, base: 60, peak: 175, density: 780 }, // Bellevue core
  { lat: 47.612, lon: -122.175, radius: 1800, base: 14, peak: 45, density: 280 }, // Bellevue spread
  { lat: 47.678, lon: -122.202, radius: 1300, base: 12, peak: 40, density: 280 }, // Kirkland
  { lat: 47.653, lon: -122.132, radius: 1600, base: 14, peak: 48, density: 280 }, // Redmond
  { lat: 47.487, lon: -122.208, radius: 1600, base: 10, peak: 30, density: 240 }, // Renton
  { lat: 47.448, lon: -122.295, radius: 2200, base: 8, peak: 26, density: 200 }, // SeaTac
  { lat: 47.73, lon: -122.33, radius: 2000, base: 7, peak: 18, density: 180 }, // Shoreline
];

export function createCity(ctx: AngelsCtx): System {
  const env = ctx.services.env as EnvService | undefined;
  const terrain = ctx.services.terrain as TerrainService | undefined;
  const uniforms = env ? (env.uniforms as unknown as Record<string, THREE.IUniform>) : {};

  const group = new THREE.Group();
  group.name = "city";
  ctx.scene.add(group);

  const ground = (x: number, z: number) => terrain?.heightAt(x, z) ?? 0;
  const wet = (x: number, z: number) => terrain?.isWater(x, z) ?? false;

  const disposables: Array<{ dispose(): void }> = [];

  // -------------------------------------------------------------------------
  // Fill: instanced boxes
  // -------------------------------------------------------------------------

  /**
   * A window grid drawn in the fragment shader rather than textured.
   *
   * The vertical rhythm of floor lines is the single strongest cue for how
   * tall a building is, and at night the scatter of lit windows is most of
   * what a city looks like from the air. Both come out of two `fract` calls.
   */
  const buildingMat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uSeed: { value: 1 } },
    vertexColors: true,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vColor;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying vec3 vLocal;
      varying float vDist;
      varying float vHeight;
      void main() {
        vColor = instanceColor;
        // The unit box is scaled by the instance matrix; recovering the scale
        // from its columns gives the window grid a real-world pitch instead of
        // one that stretches with the building.
        float sx = length(instanceMatrix[0].xyz);
        float sy = length(instanceMatrix[1].xyz);
        float sz = length(instanceMatrix[2].xyz);
        vLocal = position * vec3(sx, sy, sz);
        vHeight = sy;
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormal = normalize(mat3(instanceMatrix) * normal);
        vec4 view = viewMatrix * world;
        vDist = -view.z;
        gl_Position = projectionMatrix * view;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying vec3 vLocal;
      varying float vDist;
      varying float vHeight;
      ${ENV_UNIFORMS_GLSL}
      ${OUTPUT_GLSL}
      ${AERIAL_GLSL}

      float h21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      void main() {
        vec3 n = normalize(vNormal);
        vec3 col = vColor;

        // Facades only — the roof gets plant and gravel, not windows.
        float side = 1.0 - abs(n.y);
        if (side > 0.4) {
          // 3.6 m floors, 2.4 m window bays. Fades out past a kilometre, where
          // it would be finer than a pixel and would alias into a grey mush.
          float lod = 1.0 - smoothstep(500.0, 2200.0, vDist);
          vec2 uv = abs(n.x) > 0.5 ? vLocal.zy : vLocal.xy;
          float floors = smoothstep(0.30, 0.42, abs(fract(uv.y / 3.6) - 0.5));
          float bays = smoothstep(0.26, 0.40, abs(fract(uv.x / 2.4) - 0.5));
          float glass = floors * bays;
          col = mix(col, col * 0.42, (1.0 - glass) * 0.75 * lod);

          if (uNight > 0.01) {
            vec2 cell = floor(vec2(uv.x / 2.4, uv.y / 3.6)) + floor(vWorld.xz * 0.31);
            float lit = step(0.62, h21(cell));
            col += uNight * lit * glass * vec3(0.85, 0.72, 0.42) * 0.8 * lod;
          }
        } else {
          col *= 0.78;
          // Rooftop clutter: a per-building hash, so tall ones get plant.
          col *= 0.85 + 0.3 * h21(floor(vWorld.xz * 0.2));
        }

        float ndl = max(dot(n, uSunDir), 0.0);
        float wrap = max((dot(n, uSunDir) + 0.3) / 1.3, 0.0);
        vec3 lit = col * (uSunColor * (ndl * 1.05 + wrap * 0.24) + uSkyColor * 0.32);
        lit *= mix(1.0, 0.20, uNight);
        gl_FragColor = vec4(outputColor(applyAerial(lit, vDist, vWorld.y)), 1.0);
      }
    `,
  });
  disposables.push(buildingMat);

  const budget = BUILDING_BUDGET[ctx.quality] ?? 8000;
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  boxGeo.translate(0, 0.5, 0); // sit on the ground, not through it
  disposables.push(boxGeo);

  const rng = ctx.rng.fork(0x8171d);
  const instances: Array<{ m: THREE.Matrix4; c: THREE.Color }> = [];
  const tmpMat = new THREE.Matrix4();
  const tmpQuat = new THREE.Quaternion();
  const tmpPos = new THREE.Vector3();
  const tmpScale = new THREE.Vector3();

  const CONCRETE = new THREE.Color(0xb2b0a6);
  // The Pacific Northwest's glass towers are green-blue, not mirror-silver.
  const GLASSY = new THREE.Color(0x7f9dab);
  // Pioneer Square brick, muted well down — at this density a saturated brick
  // turns whole neighbourhoods pink.
  const BRICK = new THREE.Color(0x9a7466);
  const PALE = new THREE.Color(0xcbc7bb);

  // Distribute the budget across districts by area × density, so downtown
  // fills up first and Shoreline gets whatever is left.
  const weights = DISTRICTS.map((d) => (Math.PI * d.radius * d.radius * d.density) / 1e6);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  for (let di = 0; di < DISTRICTS.length; di++) {
    const d = DISTRICTS[di];
    const count = Math.round((weights[di] / totalWeight) * budget);
    const cx = lonToX(d.lon);
    const cz = latToZ(d.lat);

    for (let i = 0; i < count; i++) {
      // Square root of a uniform gives a uniform disc; biasing it inward
      // concentrates the towers on the core, which is what a downtown is.
      const r = Math.pow(rng.next(), 0.62) * d.radius;
      const a = rng.next() * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (wet(x, z)) continue;

      const centrality = 1 - r / d.radius;
      // Heights follow a power law: mostly low-rise, a few towers. Uniform
      // heights look like a bar chart, not a city.
      const roll = Math.pow(rng.next(), 2.6);
      const h = d.base * (0.45 + rng.next() * 0.7) + (d.peak - d.base) * roll * centrality;
      if (h < 5) continue;

      // Footprint scales with height, because tall buildings need a base.
      const w = 12 + Math.sqrt(h) * (2.4 + rng.next() * 2.6);
      const dep = w * (0.6 + rng.next() * 0.8);
      const y = ground(x, z);

      tmpPos.set(x, y - 1, z);
      tmpQuat.setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        // Most of Seattle is on a north-south grid; downtown is rotated 32°.
        (r < 1200 && d.base > 40 ? 0.56 : 0) + (rng.next() - 0.5) * 0.12,
      );
      tmpScale.set(w, h + 1, dep);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);

      const c = new THREE.Color();
      const kind = rng.next();
      if (h > 90) c.copy(GLASSY).lerp(PALE, rng.next() * 0.4);
      // Brick is one building in eight, not one in four. At a quarter the
      // whole city goes pink from three thousand feet.
      else if (kind < 0.13) c.copy(BRICK);
      else if (kind < 0.58) c.copy(CONCRETE);
      else c.copy(PALE);
      c.offsetHSL(0, 0, (rng.next() - 0.5) * 0.09);

      instances.push({ m: tmpMat.clone(), c });
    }
  }

  const fill = new THREE.InstancedMesh(boxGeo, buildingMat, instances.length);
  for (let i = 0; i < instances.length; i++) {
    fill.setMatrixAt(i, instances[i].m);
    fill.setColorAt(i, instances[i].c);
  }
  fill.instanceMatrix.needsUpdate = true;
  if (fill.instanceColor) fill.instanceColor.needsUpdate = true;
  fill.frustumCulled = false;
  fill.name = "buildings";
  group.add(fill);

  // -------------------------------------------------------------------------
  // Heroes
  // -------------------------------------------------------------------------

  const solidMat = new THREE.ShaderMaterial({
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
        float wrap = max((dot(n, uSunDir) + 0.3) / 1.3, 0.0);
        vec3 lit = vColor * (uSunColor * (ndl * 1.05 + wrap * 0.22) + uSkyColor * 0.34);
        lit *= mix(1.0, 0.24, uNight);
        gl_FragColor = vec4(outputColor(applyAerial(lit, vDist, vWorld.y)), 1.0);
      }
    `,
  });
  disposables.push(solidMat);

  const heroes = new THREE.Group();
  heroes.name = "landmarks";
  group.add(heroes);

  /**
   * Landmark positions in world space, for the Easter-egg proximity layer and
   * for the one piece of hard geometry in the world a jet can hit. `position`
   * is a point *inside* the structure for the proximity test; `base`, `top`
   * and `hull` are the cylinder the collision uses, and `hull` is zero for
   * anything that is not really a structure.
   */
  const landmarkPoints: Array<{
    id: string;
    name: string;
    position: THREE.Vector3;
    note?: string;
    base: number;
    top: number;
    hull: number;
  }> = [];

  for (const lm of LANDMARKS) {
    const x = lonToX(lm.at[1]);
    const z = latToZ(lm.at[0]);
    const y = ground(x, z);
    const obj = buildLandmark(lm, solidMat);
    if (obj) {
      obj.position.set(x, y, z);
      heroes.add(obj);
    }
    landmarkPoints.push({
      id: lm.id,
      name: lm.name,
      position: new THREE.Vector3(x, y + lm.height * 0.6, z),
      note: lm.note,
      base: y,
      top: y + lm.height,
      hull: landmarkHull(lm),
    });
  }
  ctx.services.landmarks = landmarkPoints;

  // -------------------------------------------------------------------------
  // Bridges
  // -------------------------------------------------------------------------

  for (const b of BRIDGES) {
    const from = new THREE.Vector3(lonToX(b.from[1]), 0, latToZ(b.from[0]));
    const to = new THREE.Vector3(lonToX(b.to[1]), 0, latToZ(b.to[0]));
    const decks = b.twin > 0 ? [-b.twin / 2, b.twin / 2] : [0];
    for (const offset of decks) {
      heroes.add(buildBridge(from, to, offset, b.deck, b.width, b.hump, ground, solidMat));
    }
  }

  // -------------------------------------------------------------------------
  // Runways
  // -------------------------------------------------------------------------

  const runwayMat = new THREE.ShaderMaterial({
    uniforms,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      varying float vDist;
      void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vec4 view = viewMatrix * world;
        vDist = -view.z;
        gl_Position = projectionMatrix * view;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      varying float vDist;
      ${ENV_UNIFORMS_GLSL}
      ${OUTPUT_GLSL}
      ${AERIAL_GLSL}
      void main() {
        // uv.x runs across the runway, uv.y along it.
        vec3 col = vec3(0.155, 0.155, 0.163);
        float centre = 1.0 - smoothstep(0.006, 0.014, abs(vUv.x - 0.5));
        float dash = step(0.5, fract(vUv.y * 34.0));
        col = mix(col, vec3(0.86), centre * dash);
        // Threshold piano keys at both ends.
        float endBand = step(vUv.y, 0.028) + step(0.972, vUv.y);
        float keys = step(0.45, fract(vUv.x * 9.0));
        col = mix(col, vec3(0.88), min(1.0, endBand) * keys);
        // Edge lights, which are the whole reason to fly here after dark.
        float edge = 1.0 - smoothstep(0.010, 0.026, min(vUv.x, 1.0 - vUv.x));
        col += uNight * edge * step(0.5, fract(vUv.y * 42.0)) * vec3(0.9, 0.75, 0.4);

        vec3 lit = col * (uSunColor * 0.85 + uSkyColor * 0.35);
        lit *= mix(1.0, 0.28, uNight);
        gl_FragColor = vec4(outputColor(applyAerial(lit, vDist, vWorld.y)), 1.0);
      }
    `,
  });
  disposables.push(runwayMat);

  /** Where a jet can be put on the ground, for spawns and for landing scoring. */
  const runwayInfo: Array<{
    icao: string;
    id: string;
    start: THREE.Vector3;
    end: THREE.Vector3;
    heading: number;
    elevation: number;
    length: number;
  }> = [];

  for (const airport of AIRPORTS) {
    for (const rw of airport.runways) {
      const a = new THREE.Vector3(lonToX(rw.from[1]), rw.elevation, latToZ(rw.from[0]));
      const b = new THREE.Vector3(lonToX(rw.to[1]), rw.elevation, latToZ(rw.to[0]));
      const len = a.distanceTo(b);
      const dir = new THREE.Vector3().subVectors(b, a).normalize();
      const heading = (Math.atan2(dir.x, -dir.z) * 180) / Math.PI;

      const geo = new THREE.PlaneGeometry(rw.width, len);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, runwayMat);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.position.y = rw.elevation + 0.35;
      mesh.rotation.y = -Math.atan2(dir.x, -dir.z);
      mesh.name = `${airport.icao}/${rw.id}`;
      heroes.add(mesh);
      disposables.push(geo);

      runwayInfo.push({
        icao: airport.icao,
        id: rw.id,
        start: a,
        end: b,
        heading: (heading + 360) % 360,
        elevation: rw.elevation,
        length: len,
      });
    }
  }
  ctx.services.runways = runwayInfo;

  return {
    dispose() {
      ctx.scene.remove(group);
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry && m.geometry !== boxGeo) m.geometry.dispose();
      });
      for (const d of disposables) d.dispose();
      fill.dispose();
      delete ctx.services.landmarks;
      delete ctx.services.runways;
    },
  };
}

// ---------------------------------------------------------------------------
// Hero geometry
// ---------------------------------------------------------------------------

function paint(geo: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

function buildLandmark(lm: Landmark, mat: THREE.Material): THREE.Object3D | null {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, color: number, y = 0) => {
    const mesh = new THREE.Mesh(paint(geo, color), mat);
    mesh.position.y = y;
    g.add(mesh);
    return mesh;
  };

  switch (lm.kind) {
    case "needle": {
      // The 1962 profile: a hyperbolic waist, three splayed legs, the saucer at
      // 158 m and the spire above it. The waist is the bit everyone draws
      // wrong — the tower is *thinnest* two thirds of the way up.
      const core = new THREE.CylinderGeometry(3.2, 8, lm.height * 0.85, 12, 6);
      const pos = core.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i) + lm.height * 0.425;
        const t = y / (lm.height * 0.85);
        const waist = 1 - 0.42 * Math.sin(Math.min(1, t * 1.15) * Math.PI);
        pos.setX(i, pos.getX(i) * waist);
        pos.setZ(i, pos.getZ(i) * waist);
      }
      core.computeVertexNormals();
      add(core, 0xd8d2c4, lm.height * 0.425);

      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.5;
        const leg = new THREE.CylinderGeometry(1.5, 3.4, lm.height * 0.8, 6);
        const mesh = add(leg, 0xd8d2c4, lm.height * 0.4);
        mesh.position.x = Math.cos(a) * 9;
        mesh.position.z = Math.sin(a) * 9;
        mesh.rotation.z = -Math.cos(a) * 0.14;
        mesh.rotation.x = Math.sin(a) * 0.14;
      }

      const saucer = new THREE.CylinderGeometry(22, 13, 9, 24);
      add(saucer, 0xe8e2d4, 158);
      const halo = new THREE.TorusGeometry(24, 1.4, 6, 28);
      halo.rotateX(Math.PI / 2);
      add(halo, 0xd9563a, 152);
      const roof = new THREE.ConeGeometry(13, 8, 24);
      add(roof, 0xd9563a, 167);
      add(new THREE.CylinderGeometry(0.5, 1.6, 14, 6), 0xcfcabc, lm.height - 7);
      return g;
    }

    case "tower": {
      const r = lm.radius ?? 24;
      // A gentle taper and a plant box on the roof. Everything downtown is a
      // box; what distinguishes them at this distance is proportion.
      const body = new THREE.CylinderGeometry(r * 0.86, r, lm.height, lm.id === "smith" ? 8 : 4, 1);
      body.rotateY(Math.PI / 4);
      // Seattle's supertalls are dark glass, but "dark glass" as an albedo is
      // nearly black once the sun is off it — and a black Columbia Center next
      // to a field of pale fill buildings reads as a hole in the city.
      add(body, lm.height > 200 ? 0x7d92a6 : 0xa8a69c, lm.height / 2);
      if (lm.id === "smith") {
        // The pyramid cap that makes Smith Tower unmistakable.
        add(new THREE.ConeGeometry(r * 0.9, 34, 8), 0xb9b2a2, lm.height + 17);
      } else {
        add(new THREE.BoxGeometry(r, 8, r), 0x6a6a64, lm.height + 4);
        add(new THREE.CylinderGeometry(0.4, 0.4, 22, 4), 0xcc4444, lm.height + 19);
      }
      return g;
    }

    case "stadium": {
      const r = lm.radius ?? 120;
      const bowl = new THREE.CylinderGeometry(r, r * 0.86, lm.height, 26, 1, true);
      add(bowl, 0x8c8880, lm.height / 2);
      const field = new THREE.CylinderGeometry(r * 0.62, r * 0.62, 1, 26);
      add(field, lm.id === "tmobile" ? 0x4e7a3a : 0x3f6b30, 2);
      // Two cantilever roof leaves, which is the shape of both Lumen and Husky.
      for (const side of [-1, 1]) {
        const roof = new THREE.BoxGeometry(r * 1.7, 3, r * 0.44);
        const mesh = add(roof, 0xb6b2a8, lm.height + 3);
        mesh.position.z = side * r * 0.7;
        mesh.rotation.x = side * 0.09;
      }
      return g;
    }

    case "arena": {
      const r = lm.radius ?? 90;
      // Climate Pledge's hyperbolic-paraboloid roof, kept from 1962 and now
      // hovering over a building that was dug out from under it.
      const roof = new THREE.ConeGeometry(r, lm.height * 0.6, 4, 1);
      roof.rotateY(Math.PI / 4);
      add(roof, 0xa9b3bd, lm.height * 0.7);
      add(new THREE.CylinderGeometry(r * 0.8, r * 0.8, lm.height * 0.45, 4), 0x8a8f95, lm.height * 0.22);
      return g;
    }

    case "wheel": {
      const r = lm.radius ?? 26;
      const rim = new THREE.TorusGeometry(r, 1.1, 6, 32);
      add(rim, 0xdadfe6, r + 3);
      for (let i = 0; i < 8; i++) {
        const spoke = new THREE.CylinderGeometry(0.35, 0.35, r * 2, 4);
        const mesh = add(spoke, 0xdadfe6, r + 3);
        mesh.rotation.z = (i / 8) * Math.PI;
      }
      add(new THREE.BoxGeometry(6, r + 3, 6), 0xc8ccd2, (r + 3) / 2);
      // The pier it stands on the end of.
      add(new THREE.BoxGeometry(30, 2, 60), 0x6d5c4a, 1);
      return g;
    }

    case "gasworks": {
      for (let i = 0; i < 4; i++) {
        const t = new THREE.CylinderGeometry(5, 5.6, lm.height * (0.7 + (i % 2) * 0.3), 10);
        const mesh = add(t, 0x6b5a48, (lm.height * (0.7 + (i % 2) * 0.3)) / 2);
        mesh.position.x = (i - 1.5) * 13;
      }
      return g;
    }

    case "lighthouse": {
      add(new THREE.CylinderGeometry(2.4, 3.2, lm.height, 10), 0xf2f2ee, lm.height / 2);
      add(new THREE.CylinderGeometry(1.8, 1.8, 2.4, 8), 0x2a2a2a, lm.height + 1.2);
      add(new THREE.BoxGeometry(14, 4, 9), 0xe8e6de, 2);
      return g;
    }

    case "locks": {
      add(new THREE.BoxGeometry(140, 6, 34), 0x8a877e, 3);
      add(new THREE.BoxGeometry(120, 2, 18), 0x2b4a52, 6);
      return g;
    }

    case "museum": {
      add(new THREE.BoxGeometry(150, lm.height, 90), 0xb8bcc0, lm.height / 2);
      // The Great Gallery's glass box, and the airliners parked outside it.
      add(new THREE.BoxGeometry(90, lm.height * 0.8, 70), 0x5f7d92, lm.height * 0.4);
      for (let i = 0; i < 4; i++) {
        const fuselage = new THREE.CylinderGeometry(2.4, 1.6, 42, 8);
        fuselage.rotateZ(Math.PI / 2);
        const mesh = add(fuselage, 0xe6e8ea, 5);
        mesh.position.set(-40 + i * 34, 5, 78);
        const wing = new THREE.BoxGeometry(9, 0.7, 38);
        const w = add(wing, 0xdcdee0, 4);
        w.position.set(-40 + i * 34, 4, 78);
      }
      return g;
    }

    case "market": {
      add(new THREE.BoxGeometry(120, lm.height, 34), 0x9a6a52, lm.height / 2);
      // The sign. It has said PUBLIC MARKET CENTER since 1937 and it is the
      // one piece of neon in this world worth modelling.
      add(new THREE.BoxGeometry(3, 9, 22), 0xd8332f, lm.height + 4);
      return g;
    }

    case "park":
      // Parks are terrain, not geometry — but they still want a waypoint, so
      // the caller records the position and gets nothing to draw.
      return null;

    default:
      return null;
  }
}

/** A road deck slung between two shores, following the ground at each end. */
function buildBridge(
  from: THREE.Vector3,
  to: THREE.Vector3,
  offset: number,
  deckHeight: number,
  width: number,
  hump: number,
  ground: (x: number, z: number) => number,
  mat: THREE.Material,
): THREE.Object3D {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length();
  dir.normalize();
  const side = new THREE.Vector3(-dir.z, 0, dir.x);

  const segs = Math.max(8, Math.round(len / 90));
  const pos: number[] = [];
  const idx: number[] = [];

  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const x = from.x + dir.x * len * t + side.x * offset;
    const z = from.z + dir.z * len * t + side.z * offset;
    // Ramp up off each shore, and raise the middle if this bridge has a hump.
    const shoreBlend = Math.min(1, Math.min(t, 1 - t) * segs * 0.35);
    const g = ground(x, z);
    const humpY = hump * Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.2) / 0.6)));
    const y = Math.max(g + 1, deckHeight + humpY) * shoreBlend + (g + 1) * (1 - shoreBlend);
    for (const w of [-width / 2, width / 2]) {
      pos.push(x + side.x * w, y, z + side.z * w);
    }
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  paint(geo, 0x9d9a92);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "bridge";
  return mesh;
}
