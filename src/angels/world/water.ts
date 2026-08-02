/**
 * Puget Sound, Lake Washington, Lake Union and Green Lake.
 *
 * Four polygons at three different heights — the lakes really do sit five
 * metres above the sea, which is what the locks at Ballard are for — shaded by
 * one material that does four things and no more:
 *
 *  - reflects the actual sky, using the same scattering function the dome is
 *    drawn with, so a lake at sunset goes orange without anyone tinting it;
 *  - reads depth and distance-to-shore out of a bake of the height field, so
 *    the water goes green and translucent over the shallows and near-black in
 *    the middle of the lake where it is sixty metres deep;
 *  - runs a sun glitter term wide enough to survive being seen from 3 km up,
 *    which is the single strongest cue that you are looking at water at all;
 *  - lays a band of surf along the shoreline.
 *
 * No vertex displacement anywhere. From a jet you never see a wave profile —
 * you see the *statistics* of a surface, and those live entirely in the normal.
 */
import * as THREE from "three";
import type { AngelsCtx, System } from "../types";
import { AERIAL_GLSL, ATMOSPHERE_GLSL, ENV_UNIFORMS_GLSL, OUTPUT_GLSL } from "./env";
import type { EnvService } from "./sky";
import { EXTENT, WATER_BODIES, latToZ, lonToX } from "./geo";
import { SURFACE_LAND, type HeightField } from "./field";

/** Metres of depth the bake's red channel spans. */
const DEPTH_RANGE = 80;
/** Metres of shore distance the green channel spans. */
const SHORE_RANGE = 500;

function bakeWaterMap(field: HeightField): THREE.DataTexture {
  const n = field.res + 1;
  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const isWater = field.surface[i] !== SURFACE_LAND;
    const level = isWater ? field.water[i] : 0;
    const depth = isWater ? Math.max(0, level - field.height[i]) : 0;
    const shore = Math.abs(field.shore[i]);
    data[i * 4] = Math.round(Math.min(1, depth / DEPTH_RANGE) * 255);
    data[i * 4 + 1] = Math.round(Math.min(1, shore / SHORE_RANGE) * 255);
    data[i * 4 + 2] = isWater ? 255 : 0;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export interface WaterService {
  /** Surface height of the water body under this point, or null on dry land. */
  levelAt(x: number, z: number): number | null;
}

export function createWater(ctx: AngelsCtx): System {
  const env = ctx.services.env as EnvService | undefined;
  const field = ctx.services.heightField as HeightField | undefined;
  if (!field) {
    // Terrain failed to boot. A world with no water is wrong but survivable;
    // a world that throws here is not.
    console.warn("[Blue Angels] water needs the height field — skipping");
    return {};
  }

  const map = bakeWaterMap(field);
  const group = new THREE.Group();
  group.name = "water";
  ctx.scene.add(group);

  const base = env ? (env.uniforms as unknown as Record<string, THREE.IUniform>) : {};

  const materials: THREE.ShaderMaterial[] = [];
  const geometries: THREE.BufferGeometry[] = [];

  for (const body of WATER_BODIES) {
    // THREE.Shape lives in XY. Building it with y = -worldZ and then rotating
    // -90° about X lands it the right way up and the right way round.
    const shape = new THREE.Shape(
      body.outline.map((p) => new THREE.Vector2(lonToX(p[1]), -latToZ(p[0]))),
    );
    for (const hole of body.holes) {
      shape.holes.push(
        new THREE.Path(hole.map((p) => new THREE.Vector2(lonToX(p[1]), -latToZ(p[0])))),
      );
    }
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    geo.computeBoundingSphere();
    geometries.push(geo);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...base,
        uMap: { value: map },
        uExtent: { value: EXTENT },
        uDeep: { value: new THREE.Color(body.color) },
        uShallow: { value: new THREE.Color(body.level === 0 ? 0x2f6b6e : 0x386d63) },
        uLevel: { value: body.level },
        uCamPos: { value: new THREE.Vector3() },
      },
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        varying float vDist;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          vec4 view = viewMatrix * world;
          vDist = -view.z;
          gl_Position = projectionMatrix * view;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform float uExtent;
        uniform vec3  uDeep;
        uniform vec3  uShallow;
        uniform vec3  uCamPos;
        varying vec3 vWorld;
        varying float vDist;
        ${ENV_UNIFORMS_GLSL}
        ${OUTPUT_GLSL}
        ${ATMOSPHERE_GLSL}
        ${AERIAL_GLSL}

        float hashW(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noiseW(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hashW(i), hashW(i + vec2(1,0)), u.x),
                     mix(hashW(i + vec2(0,1)), hashW(i + vec2(1,1)), u.x), u.y);
        }

        void main() {
          vec2 uv = (vWorld.xz + uExtent) / (uExtent * 2.0);
          vec4 m = texture2D(uMap, uv);
          float depth = m.r;
          float shore = m.g;

          // ---- surface normal ---------------------------------------------
          // Four crossed wave trains at incommensurate scales and speeds. The
          // highest-frequency one fades out with distance: past a kilometre it
          // is smaller than a pixel, and leaving it in is how water starts to
          // shimmer and crawl in the distance.
          vec2 p = vWorld.xz;
          float t = uTime;
          float detail = 1.0 - smoothstep(400.0, 2600.0, vDist);
          vec2 n2 = vec2(0.0);
          // Three octaves of *noise*, and only a whisper of sine.
          //
          // The first pass built the normal out of crossed cosine trains, which
          // is the textbook cheap-water recipe and is exactly wrong seen from a
          // jet: four regular waves interfere into a stationary herringbone
          // that covers the whole lake and screams "shader". Real water seen
          // from 1,500 feet is a *stochastic* field — irregular glitter with no
          // repeating structure anywhere in it — so the noise carries the
          // normal and the sines only supply the drift.
          vec2 flow = vec2(t * 2.6, t * 1.7);
          n2 += (vec2(noiseW(p * 0.020 + flow * 0.02), noiseW(p * 0.020 + 91.0 - flow * 0.02)) - 0.5) * 0.055;
          n2 += (vec2(noiseW(p * 0.085 + flow * 0.06), noiseW(p * 0.085 + 37.0 - flow * 0.05)) - 0.5) * 0.075;
          n2 += (vec2(noiseW(p * 0.34 + flow * 0.2), noiseW(p * 0.34 + 17.0 - flow * 0.18)) - 0.5) * 0.16 * detail;
          n2 += vec2(cos(p.x * 0.052 + t * 1.7), cos(p.y * 0.047 - t * 1.3)) * 0.012 * detail;
          // Chop grows with fetch: the middle of the Sound is rougher than a
          // sheltered corner of Portage Bay, and that reads from the air.
          n2 *= 0.35 + 0.65 * smoothstep(0.0, 0.55, shore);
          vec3 n = normalize(vec3(n2.x, 1.0, n2.y));

          vec3 viewDir = normalize(uCamPos - vWorld);
          float fres = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 4.0);
          fres = mix(0.035, 1.0, fres);

          // ---- reflection ---------------------------------------------------
          vec3 refl = reflect(-viewDir, n);
          refl.y = abs(refl.y);
          vec3 sky = skyRadiance(refl);

          // ---- body colour ---------------------------------------------------
          vec3 body = mix(uShallow, uDeep, smoothstep(0.02, 0.30, depth));
          // Suspended sediment near the shore — the Duwamish and the Cedar both
          // run brown, and every beach here has a pale band off it.
          body = mix(vec3(0.32, 0.34, 0.28), body, smoothstep(0.0, 0.06, shore));

          vec3 col = mix(body * (uSkyColor * 0.85 + 0.35), sky, fres);

          // ---- glitter -------------------------------------------------------
          // Two lobes: a tight specular for the sun's own image and a broad one
          // for the sheet of glitter around it. The broad lobe is what you can
          // still see from ten thousand feet.
          // Two lobes, and the tight one is faded out with distance. A 220-
          // exponent highlight is sub-pixel past a kilometre, so all it can do
          // out there is alias into a field of white sparks that crawls when
          // the camera moves.
          vec3 h = normalize(uSunDir + viewDir);
          float spec = pow(max(dot(n, h), 0.0), 220.0) * detail;
          float sheen = pow(max(dot(n, h), 0.0), 14.0);
          col += uSunColor * (spec * 2.6 + sheen * 0.42) * (1.0 - uNight * 0.9);

          // ---- surf ----------------------------------------------------------
          float surf = (1.0 - smoothstep(0.0, 0.045, shore)) * (0.35 + 0.65 * noiseW(p * 0.12 + t * 0.9));
          col = mix(col, vec3(0.86, 0.90, 0.92), surf * 0.55);

          gl_FragColor = vec4(outputColor(applyAerial(col, vDist, vWorld.y)), 1.0);
        }
      `,
    });
    materials.push(mat);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = body.level;
    mesh.renderOrder = -5;
    mesh.name = body.name;
    group.add(mesh);
  }

  const service: WaterService = {
    levelAt(x, z) {
      const n = field.res + 1;
      const i = Math.max(0, Math.min(field.res, Math.round((x + field.extent) / field.step)));
      const j = Math.max(0, Math.min(field.res, Math.round((z + field.extent) / field.step)));
      const idx = j * n + i;
      return field.surface[idx] === SURFACE_LAND ? null : field.water[idx];
    },
  };
  ctx.services.water = service;

  return {
    update(_dt, c) {
      for (const m of materials) {
        (m.uniforms.uCamPos.value as THREE.Vector3).copy(c.camera.position);
      }
    },
    dispose() {
      ctx.scene.remove(group);
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      map.dispose();
      if (ctx.services.water === service) delete ctx.services.water;
    },
  };
}

/** Exposed so tests can assert the bake without a GPU. */
export const _bakeRanges = { DEPTH_RANGE, SHORE_RANGE };
export { latToZ, lonToX };
