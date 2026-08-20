/**
 * The world under the island: snow, mountains, and the lake that shows you
 * the whole thing upside down.
 *
 * The lake is the reason this file is shaped the way it is. There is no
 * `Reflector` here and that is deliberate — a render-to-texture mirror needs
 * the scene drawn a second time from a virtual camera, and the sky in this
 * world is a unit sphere pinned to the *real* camera, so the reflected pass
 * would photograph the inside of a one-metre ball. It is also the single most
 * expensive thing you can do to a phone.
 *
 * So the reflection is built the way a painter would build it, out of two
 * halves that each solve one part:
 *
 *  - **The sky half is analytic.** The water shader reflects the view ray
 *    about the surface normal and evaluates the same gradient the dome does.
 *    Perfect, free, and correct from every angle.
 *  - **The island half is a real second copy**, mirrored through the water
 *    plane by `scale.y = -1`. Geometrically exact — the reflection moves when
 *    you move, because it is the same geometry seen from underneath.
 *
 * The one rule that makes the second half work is in `keel.ts` and
 * `buildings.ts`: every
 * gradient there is driven by an attribute along the object's own height, not
 * by world Y. Mirror a world-Y gradient and the towers come out with their
 * colours the right way up inside an upside-down reflection, which is the
 * kind of wrong you notice without being able to say why.
 */
import * as THREE from "three";
import { fbm2, ridged2 } from "@/shared/proc/rng";
import { GROUND_Y, ISLAND_Y, LAKE_R, WATER_Y, WORLD_R } from "./config";
import { SUN_DIR } from "./sky";

/**
 * Ring of peaks: how far out they start and how far they run.
 *
 * Pushed well back from the shore on purpose. Close peaks have to be short to
 * stay under the island, and short peaks are dunes — which is exactly what the
 * first two passes produced, four kilometres of soft white swells. Far peaks
 * can be four hundred metres tall and still sit low in the frame, which is
 * both what the reference shows and the only way to get a jagged horizon.
 */
const RANGE_INNER = LAKE_R * 1.30;
const RANGE_OUTER = 7800;

/**
 * Height of the snow at (x, z) — the same function the terrain mesh is built
 * from and the player's feet are tested against, so you can land on a peak
 * and stand on it rather than inside it.
 *
 * Inside the lake it returns the ice, which is flat: the lake is the mirror
 * and a mirror with dunes in it is not a mirror.
 */
export function groundHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r < LAKE_R) return GROUND_Y;

  // Drifts: low, wide, and always there, so the snow is never a flat sheet.
  const drift = fbm2(x * 0.0011, z * 0.0011, 4, 2, 0.5, 7) * 20;

  // The ranges. A raised-cosine band across the ring so the peaks grow out of
  // the plain and die back down into the haze instead of ending at a line.
  const t = (r - RANGE_INNER) / (RANGE_OUTER - RANGE_INNER);
  if (t <= 0 || t >= 1) return GROUND_Y + drift * Math.min(1, Math.max(0, (r - LAKE_R) / 360));
  /* The band reaches full height fast and holds it.
   *
   * A gentle raised cosine puts the nearest peaks — the only ones that
   * subtend any angle from the island — at a third of their amplitude, and
   * the ranges render as a smooth white sheet with a texture on it. Ramping
   * over the first fifth of the band instead means the mountains you can
   * actually see are mountains. */
  const band = Math.sin(Math.PI * Math.min(1, t * 2.2)) ** 0.7;

  // Ridged noise at two scales: the range, then the individual peaks on it.
  const ridge = ridged2(x * 0.00048, z * 0.00048, 4, 31);
  const teeth = ridged2(x * 0.0028, z * 0.0028, 3, 91);
  /**
   * The ceiling on the ranges is a composition decision, not a terrain one.
   *
   * The island's keel bottoms out at 120 m and its plaza is at 420. Peaks that
   * out-climb either of those put a mountain behind the city and the whole
   * read of the picture — a thing hanging in the sky, over a plain — collapses
   * into a landscape with a building in it. The first pass topped out at 984 m
   * and did exactly that.
   */
  const h = (ridge ** 2.6 * 0.62 + teeth ** 1.9 * 0.72) * 560 * band;

  /* Hard ceiling, not a tuned amplitude.
   *
   * The rule is "no peak may out-climb the city deck", and it is a composition
   * rule, not a terrain one — a mountain behind the island turns the picture
   * from "a city in the sky" into "a landscape with a building in it". Every
   * time the ridge noise has been retuned the amplitude has drifted over the
   * line again, so the limit lives here where it cannot be tuned past. Eased
   * rather than clipped, so the tallest peaks round over instead of being
   * sheared flat into a mesa. */
  const CEIL = ISLAND_Y * 0.84;
  const raw = h + drift;
  const capped = raw < CEIL * 0.7 ? raw : CEIL - (CEIL * 0.3 * CEIL * 0.3) / (raw - CEIL * 0.4);
  return GROUND_Y + capped;
}

/* -------------------------------------------------------------------------
 * Snow
 * ---------------------------------------------------------------------- */

/**
 * A ring, not a disc — the lake is a hole in the ground, and what you see
 * through it is the mirrored copy hanging below.
 *
 * Radial tessellation rather than a grid: the detail belongs where the
 * mountains are, and a grid dense enough for the peaks at four kilometres out
 * is a quarter of a million triangles of perfectly flat snow in the middle.
 */
function buildSnow(): THREE.Mesh {
  const RINGS = 170;
  const SEGS = 256;
  const positions = new Float32Array((RINGS + 1) * (SEGS + 1) * 3);
  const normals = new Float32Array((RINGS + 1) * (SEGS + 1) * 3);
  const indices: number[] = [];

  let p = 0;
  for (let i = 0; i <= RINGS; i++) {
    // Squared spacing: rings bunch up near the shore where the eye is.
    const f = i / RINGS;
    // Starts fractionally *inside* the lake so the snow laps over the ice
    // rather than butting up against it. Two co-radial edges leave a scalloped
    // seam wherever the tessellations disagree, and they always disagree.
    const r = LAKE_R * 0.965 + (WORLD_R - LAKE_R * 0.965) * f ** 1.7;
    for (let j = 0; j <= SEGS; j++) {
      const a = (j / SEGS) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      positions[p] = x;
      positions[p + 1] = groundHeight(x, z);
      positions[p + 2] = z;
      p += 3;
    }
  }

  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEGS; j++) {
      const a = i * (SEGS + 1) + j;
      const b = a + SEGS + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mat = new THREE.MeshStandardMaterial({
    // White. The first pass used a lilac-tinted white, which sounds right for
    // snow at sunset and is not — the tint below already does that job, and
    // doing it twice turned four kilometres of snowfield magenta.
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.0,
    flatShading: false,
    side: THREE.DoubleSide,
  });

  /**
   * Snow is never one colour in this light.
   *
   * Two things are grafted onto the standard material rather than baked into
   * a vertex colour, because both need the *shaded* result to work from: the
   * lit faces go warm gold and the shadowed ones go lavender-blue (which is
   * the whole reason a sunset snowfield looks like that), and the peaks above
   * the treeline stay whiter than the plain.
   */
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSun = { value: SUN_DIR.clone() };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;")
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
         vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
         vWNrm = normalize(mat3(modelMatrix) * objectNormal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform vec3 uSun;\nvarying vec3 vWPos;\nvarying vec3 vWNrm;",
      )
      /* Grafted before the fog, not after it.
       *
       * `<dithering_fragment>` is the last chunk in the shader — after tone
       * mapping, after the colour space, and after `<fog_fragment>`. Anything
       * injected there is immune to fog, and four kilometres of snowfield that
       * fog cannot touch is a flat lavender plate sitting brighter than the
       * lit city in front of it, in every long view, at every hour. Injecting
       * at the fog chunk instead puts this tint where a surface colour
       * belongs: computed, then faded into the distance like everything else.
       */
      .replace(
        "#include <fog_fragment>",
        `
         float sunlit = clamp(dot(normalize(vWNrm), normalize(uSun)) * 0.5 + 0.5, 0.0, 1.0);
         /* Snow is white and stays white. What changes is which light is
          * reaching it: gold on the faces turned to the sun, and the sky's
          * own lavender on the ones turned away. Both are near 1.0 — a tint
          * that darkens is a tint that turns a snowfield into a desert, which
          * is exactly what the first pass did. */
         vec3 warm = vec3(1.06, 0.97, 0.86);
         vec3 cool = vec3(0.80, 0.82, 1.02);
         gl_FragColor.rgb *= mix(cool, warm, pow(sunlit, 1.2));
         // Height: the tops keep the light long after the plain has lost it.
         float alt = clamp((vWPos.y - 40.0) / 220.0, 0.0, 1.0);
         gl_FragColor.rgb *= 1.0 + alt * 0.22;
         // Rose bounce on the faces turned away, which is the sky lighting them.
         gl_FragColor.rgb += vec3(0.26, 0.10, 0.20) * pow(1.0 - sunlit, 3.0) * 0.40;
         /* A little sky in the shadows, added rather than clamped.
          *
          * There was a hard max(rgb, vec3(0.30, 0.26, 0.38)) here, to stop
          * the shadowed side of every peak going to black. It worked, and it
          * pinned the entire snowfield to one flat value that no fog could
          * fade and no grade could put a gradient into — which is most of why
          * every aerial view of this world washed out. An additive term does
          * the same job, keeps the shading underneath it, and gets fogged.
          */
         gl_FragColor.rgb += vec3(0.085, 0.075, 0.125);
#include <fog_fragment>`,
      );
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "empyrean-snow";
  mesh.receiveShadow = false;
  return mesh;
}

/* -------------------------------------------------------------------------
 * The lake
 * ---------------------------------------------------------------------- */

const WATER_VERT = /* glsl */ `
varying vec3 vWPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WATER_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec3 uSun;
uniform vec3 uCam;
uniform float uRadius;
varying vec3 vWPos;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1,0)), f.x),
             mix(hash21(i + vec2(0,1)), hash21(i + vec2(1,1)), f.x), f.y);
}

/** The dome's gradient, cut down to what a reflection needs. */
vec3 skyColor(vec3 rd, vec3 sun) {
  float t = clamp(rd.y, 0.0, 1.0);
  float sunAmt = clamp(dot(rd, sun) * 0.5 + 0.5, 0.0, 1.0);
  vec3 cRose   = vec3(1.00, 0.46, 0.58);
  vec3 cOrange = vec3(1.00, 0.58, 0.30);
  vec3 cGold   = vec3(1.00, 0.82, 0.42);
  vec3 cJade   = vec3(0.28, 0.78, 0.74);
  vec3 cSky    = vec3(0.12, 0.36, 0.72);
  vec3 cNavy   = vec3(0.045, 0.075, 0.26);
  vec3 col = mix(cOrange, cGold, smoothstep(0.010, 0.075, t));
  col = mix(col, cJade, smoothstep(0.060, 0.180, t));
  col = mix(col, cSky,  smoothstep(0.150, 0.360, t));
  col = mix(col, cNavy, smoothstep(0.320, 0.760, t));
  float low = 1.0 - smoothstep(0.0, 0.42, t);
  col = mix(col, cRose, low * (1.0 - sunAmt) * 0.62);
  col = mix(col, cGold * 1.10, low * pow(sunAmt, 2.2) * 0.75);
  float d = max(dot(rd, sun), 0.0);
  col += cGold * pow(d, 200.0) * 14.0;
  col += vec3(1.0, 0.72, 0.44) * pow(d, 14.0) * 1.10;
  return col;
}

void main() {
  vec3 sun = normalize(uSun);
  vec3 V = normalize(vWPos - uCam);

  /* Ripple. Two scales, drifting against each other, and heavily flattened —
   * the reference is glass with a breath of movement on it, not a sea. */
  vec2 q = vWPos.xz * 0.0075;
  float n1 = vnoise(q + vec2(uTime * 0.020, uTime * 0.013));
  float n2 = vnoise(q * 3.7 - vec2(uTime * 0.031, uTime * 0.017));
  float ripple = (n1 - 0.5) * 0.020 + (n2 - 0.5) * 0.010;
  vec3 N = normalize(vec3(ripple, 1.0, ripple * 0.8));

  vec3 R = reflect(V, N);
  R.y = abs(R.y);
  vec3 sky = skyColor(R, sun);

  /* Fresnel, and then a hard ceiling on what it is allowed to do.
   *
   * The physical answer at a grazing angle is "almost all reflection", and
   * taking it literally is what made the first pass a sheet of flat pearl:
   * the analytic sky was painted at full strength straight over the mirrored
   * city drawn behind it, so the one thing the lake exists to show was
   * invisible from every angle you would actually look at it from. The sky
   * term is capped well under 1 for that reason — what fills the rest is not
   * a guess at a reflection, it is the reflection. */
  float f = pow(1.0 - clamp(dot(-V, N), 0.0, 1.0), 4.0);
  float reflectivity = mix(0.30, 0.90, f);

  /* The glare road — the streak of sun that runs at you across any water.
   * Broadened by the ripple, which is what makes it shimmer. */
  vec3 sunSpec = vec3(1.0, 0.80, 0.52) * pow(max(dot(R, sun), 0.0), 90.0) * 3.4;

  /* Under the ice: the deep is a cold plum, warming toward the shore where
   * the shallows pick the sunset back up. */
  float shore = 1.0 - clamp(length(vWPos.xz) / uRadius, 0.0, 1.0);
  vec3 deep = mix(vec3(0.05, 0.045, 0.15), vec3(0.52, 0.28, 0.40), pow(shore, 2.0));

  vec3 col = mix(deep, sky, reflectivity) + sunSpec;

  /* Frozen crack lines, very faint, only where the ice is calm. */
  float crack = smoothstep(0.985, 1.0, vnoise(vWPos.xz * 0.0032 + 3.1));
  col += vec3(0.55, 0.60, 0.75) * crack * 0.35;

  /* ---- close up, the ice has a surface -------------------------------
   *
   * At a kilometre and a half this is a mirror and should be nothing else.
   * Underfoot a mirror with nothing on it is a floor made of sky, and once
   * there was a reason to fly down and stand on it that stopped being an
   * acceptable answer. So a band of surface is faded in over the hundred and
   * fifty metres nearest the lens: wind scour running one way, a fine frost
   * grain, and a finer set of cracks than the wide field above.
   *
   * It is done here rather than as geometry because it costs nothing — no
   * draw, no triangle, no memory — and because it covers the whole lake. The
   * camp at Mirrorfoot lays real scour and bubbles on the ice it stands on,
   * which is worth doing where somebody is looking closely at it, but it is
   * 550 m of a 1500 m disc: land anywhere else and this is what stops the
   * ground being blank.
   */
  float near = 1.0 - smoothstep(45.0, 195.0, length(vWPos.xz - uCam.xz));
  if (near > 0.002) {
    float scour = vnoise(vWPos.xz * vec2(0.055, 0.010) + 11.0);
    float grain = vnoise(vWPos.xz * 1.30);
    float fine  = smoothstep(0.955, 1.0, vnoise(vWPos.xz * 0.028 + 7.3));
    col += vec3(0.72, 0.80, 0.92) * smoothstep(0.52, 0.94, scour) * near * 0.15;
    col += vec3(0.10, 0.12, 0.16) * (grain - 0.5) * near * 0.55;
    col += vec3(0.58, 0.68, 0.85) * fine * near * 0.55;
  }

  /* Alpha is what lets the mirrored island through, so it is deliberately
   * low and barely varies: even looking straight down the lake keeps a third
   * of its own colour, and even at the grazing angle the card art is composed
   * at it keeps two thirds of the city.
   *
   * The near band adds to it, which is both what a steep view of ice actually
   * does — less reflection, more surface — and what stops the ground under a
   * standing player reading as a hole with the sky at the bottom of it. */
  gl_FragColor = vec4(col, mix(0.30, 0.55, f) + near * 0.20);
}
`;

/* -------------------------------------------------------------------------
 * Handle
 * ---------------------------------------------------------------------- */

export interface TerrainHandle {
  group: THREE.Group;
  /** Everything mirrored through the water plane is parented here. */
  mirror: THREE.Group;
  update(time: number, camera: THREE.Camera): void;
  dispose(): void;
}

export function buildTerrain(): TerrainHandle {
  const group = new THREE.Group();
  group.name = "empyrean-terrain";

  const snow = buildSnow();
  group.add(snow);

  /**
   * The mirror.
   *
   * `scale.y = -1` about the water plane, so anything added here appears
   * exactly where its reflection belongs. Winding is inverted by the negative
   * scale, which is why every material in the reflected systems is
   * double-sided — the
   * alternative is a second set of cloned materials to keep in step, and this
   * world has no back faces worth culling.
   */
  const mirror = new THREE.Group();
  mirror.name = "empyrean-mirror";
  mirror.scale.set(1, -1, 1);
  mirror.position.y = WATER_Y * 2;
  group.add(mirror);

  const waterMat = new THREE.ShaderMaterial({
    name: "EmpyreanWater",
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uSun: { value: SUN_DIR.clone() },
      uCam: { value: new THREE.Vector3() },
      uRadius: { value: LAKE_R },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });

  const water = new THREE.Mesh(new THREE.CircleGeometry(LAKE_R, 128), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_Y;
  water.name = "empyrean-lake";
  // After the mirrored copy, always: it is transparent and the thing it is
  // transparent over is drawn in the same pass.
  water.renderOrder = 10;
  group.add(water);

  return {
    group,
    mirror,
    update(time, camera) {
      waterMat.uniforms.uTime.value = time;
      (waterMat.uniforms.uCam.value as THREE.Vector3).copy(camera.position);
    },
    dispose() {
      snow.geometry.dispose();
      (snow.material as THREE.Material).dispose();
      water.geometry.dispose();
      waterMat.dispose();
    },
  };
}
