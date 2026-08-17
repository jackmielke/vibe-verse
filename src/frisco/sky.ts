/**
 * sky.ts — a painted sky, and Karl.
 *
 * No atmospheric scattering here. /sf raymarches Rayleigh and Mie through
 * sixteen steps a fragment to get a real sunset, and it is worth it there. A
 * toy city wants a sky that looks like it was painted on the inside of a bowl,
 * so this is a two-colour vertical gradient with a sun disc and some
 * hand-placed clouds, and the whole thing costs one dome and no per-pixel
 * maths worth the name.
 *
 * The fog is the interesting part. San Francisco's fog is a *character* — it
 * comes in over the western hills in the afternoon and pours down into the
 * bowl — and a flat `THREE.Fog` cannot do that because it is a function of
 * distance only. So Karl here is a genuine object: a bank of soft slabs that
 * drifts across the map, thickest to the west, and passes over the city. You
 * fly through it and out the other side.
 */
import * as THREE from "three";
import { COLORS, flat, toon } from "./look";
import { BOUNDS } from "./map";

export interface SkyRig {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  update(dt: number, elapsed: number, camera: THREE.Camera): void;
  /** 0..1 — how much fog is currently over the city. Drives the HUD hint. */
  fogAmount: number;
  setFog(amount: number): void;
  dispose(): void;
}

/**
 * The dome is a big ordinary sphere, and it is worth saying why rather than the
 * usual trick.
 *
 * The clever version is a unit sphere parented to the camera with `depthTest`
 * and `depthWrite` off, pushed to the far plane by forcing `gl_Position.z =
 * gl_Position.w`. It is smaller, it never clips, and it is what this file had
 * first — and it cost hours. With depth testing off, the dome's place in the
 * draw order is decided entirely by `renderOrder`, and anything that perturbs
 * that order (an override material, a debug pass, a future post effect) puts a
 * one-metre sphere in front of the camera with depth writes ON and occludes the
 * entire world. The failure looks like the city not existing, not like the sky
 * being wrong, so it is diagnosed in the wrong place.
 *
 * An ordinary big sphere inside the far plane needs none of that: it is behind
 * everything because it genuinely IS behind everything, and it stays behind
 * everything under any render order.
 *
 * The radius is bounded on both sides and `friscoMap.test.ts` checks both. It
 * has to clear the map's own diagonal — 3.5 km corner to corner — or the sky
 * ends up nearer than the far side of the city; and it has to stay inside the
 * 4.2 km far plane or it is clipped away and the sky renders as the clear
 * colour, which reads as "the world failed to load".
 */
const DOME_RADIUS = 3800;

/**
 * The two `#include`s in each of these are the whole reason the sky is visible.
 *
 * A `ShaderMaterial` still goes through three's include resolver, so a custom
 * shader can opt back in to the parts of the pipeline it needs — and this
 * renderer runs a *logarithmic* depth buffer, which means every other material
 * in the world writes a `gl_FragDepth` on a scale that a shader without
 * `logdepthbuf` knows nothing about. Leave them out and the dome compares an
 * ordinary `gl_FragCoord.z` against log-scale neighbours, loses every
 * comparison, and the sky is simply not there.
 *
 * `colorspace_fragment` is the other half. Uniforms assigned from a
 * `THREE.Color` are converted to linear on assignment; without the conversion
 * back on the way out, the sky is painted with the linear numbers and comes out
 * roughly half as bright as the palette says.
 */
const DOME_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const DOME_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uLow;
  uniform vec3 uHigh;
  uniform vec3 uSun;
  uniform vec3 uSunColor;
  varying vec3 vDir;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 d = normalize(vDir);
    // A slightly curved ramp: linear in height reads as a gradient, this reads
    // as a sky.
    float t = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(uLow, uHigh, pow(t, 0.72));
    // The sun as a soft disc with a wide, gentle bloom around it.
    float m = max(dot(d, normalize(uSun)), 0.0);
    col += uSunColor * pow(m, 620.0) * 1.6;
    col += uSunColor * pow(m, 8.0) * 0.16;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Where the sun sits. Mid-afternoon, west-south-west — SF's best light. */
const SUN_DIR = new THREE.Vector3(-0.55, 0.62, -0.36).normalize();

export function createSky(scene: THREE.Scene): SkyRig {
  const group = new THREE.Group();
  group.name = "frisco-sky";

  /* ---- the dome ---- */
  const domeGeo = new THREE.SphereGeometry(DOME_RADIUS, 32, 20);
  const domeMat = new THREE.ShaderMaterial({
    uniforms: {
      uLow: { value: new THREE.Color(0xcfeaf7) },
      uHigh: { value: new THREE.Color(COLORS.skyHigh) },
      uSun: { value: SUN_DIR.clone() },
      uSunColor: { value: new THREE.Color(0xfff2cf) },
    },
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    // No depth WRITE, so the sky can never hide anything — it is drawn first
    // (renderOrder below) and everything else paints over it. The depth TEST
    // stays on, and can only stay on because the shader above includes the
    // logdepth chunks; without them the comparison is against numbers on a
    // different scale entirely.
    depthWrite: false,
    fog: false,
  });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.renderOrder = -1000;
  dome.frustumCulled = false;
  group.add(dome);

  /* ---- clouds ---- */
  // Chunky lozenges, high up, drifting east. Deliberately few and large: a toy
  // sky with realistic cloud cover reads as an overcast day, which is the one
  // weather San Francisco has too much of already.
  const cloudMat = toon(0xffffff, { transparent: true, opacity: 0.95 });
  const cloudGeo = new THREE.SphereGeometry(1, 7, 5);
  const clouds: THREE.Group[] = [];
  const cloudRng = mulberry(20240817);
  for (let i = 0; i < 22; i++) {
    const g = new THREE.Group();
    const lobes = 3 + Math.floor(cloudRng() * 3);
    for (let j = 0; j < lobes; j++) {
      const m = new THREE.Mesh(cloudGeo, cloudMat);
      m.position.set((j - lobes / 2) * 26 + cloudRng() * 12, cloudRng() * 9, cloudRng() * 16);
      const s = 22 + cloudRng() * 20;
      m.scale.set(s, s * 0.56, s * 0.8);
      g.add(m);
    }
    g.position.set(
      BOUNDS.minX + cloudRng() * (BOUNDS.maxX - BOUNDS.minX) * 1.6 - 400,
      330 + cloudRng() * 190,
      BOUNDS.minZ + cloudRng() * (BOUNDS.maxZ - BOUNDS.minZ) * 1.6 - 400,
    );
    group.add(g);
    clouds.push(g);
  }

  /* ---- Karl ---- */
  // Fog banks: broad translucent slabs at low altitude that drift east across
  // the map. Additive would glow; this is plain alpha, unlit, so it reads as
  // something the light does not get through.
  const fogMat = flat(COLORS.fog, { transparent: true, opacity: 0.0, side: THREE.DoubleSide });
  const fogGeo = new THREE.PlaneGeometry(1, 1, 1, 1);
  const banks: { mesh: THREE.Mesh; phase: number; y: number; scale: number }[] = [];
  for (let i = 0; i < 14; i++) {
    const m = new THREE.Mesh(fogGeo, fogMat);
    m.rotation.x = -Math.PI / 2;
    const scale = 520 + cloudRng() * 620;
    m.scale.set(scale, scale * 0.7, 1);
    banks.push({ mesh: m, phase: cloudRng(), y: 26 + cloudRng() * 92, scale });
    group.add(m);
  }

  /* ---- light ---- */
  const sun = new THREE.DirectionalLight(0xfff4dd, 2.05);
  sun.position.copy(SUN_DIR).multiplyScalar(600);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const shadowCam = sun.shadow.camera as THREE.OrthographicCamera;
  shadowCam.near = 1;
  shadowCam.far = 2200;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.4;
  group.add(sun);
  group.add(sun.target);

  // A blue sky fill and a warm bounce off the ground: the three-light rig that
  // /sf's art direction asks for and only got two thirds of. On flat-shaded
  // toy geometry the third term is what stops every north face reading as the
  // same dead grey.
  const hemi = new THREE.HemisphereLight(0xbfe3ff, 0xe8d9b8, 1.35);
  group.add(hemi);

  scene.add(group);

  const rig: SkyRig = {
    group,
    sun,
    hemi,
    fogAmount: 0,
    setFog(a: number) {
      rig.fogAmount = Math.max(0, Math.min(1, a));
    },
    update(dt, elapsed, camera) {
      // The dome and the weather follow the camera so they can never be
      // reached, and so the far plane can stay tight.
      // Follows the camera so its edge can never be reached, and so the far
      // plane can stay tight.
      dome.position.copy(camera.position);

      // The sun's shadow frustum follows the player, sized for the near field:
      // a toy city wants crisp shadows on the street, and one 2048 map over
      // 2.4 km would be 1.2 m per texel.
      const target = camera.position;
      sun.position.set(target.x + SUN_DIR.x * 500, target.y + SUN_DIR.y * 500, target.z + SUN_DIR.z * 500);
      sun.target.position.copy(target);
      sun.target.updateMatrixWorld();
      const reach = THREE.MathUtils.clamp(120 + Math.max(0, target.y) * 1.4, 120, 520);
      if (Math.abs(shadowCam.right - reach) > reach * 0.08) {
        shadowCam.left = -reach;
        shadowCam.right = reach;
        shadowCam.top = reach;
        shadowCam.bottom = -reach;
        shadowCam.updateProjectionMatrix();
      }

      // Clouds drift east and wrap.
      const span = (BOUNDS.maxX - BOUNDS.minX) * 1.6;
      for (const c of clouds) {
        c.position.x += dt * 4.2;
        if (c.position.x > BOUNDS.minX + span) c.position.x -= span;
      }

      // Karl comes in from the west and thins out over the bay.
      const amt = rig.fogAmount;
      fogMat.opacity = 0.34 * amt;
      fogMat.visible = amt > 0.01;
      for (let i = 0; i < banks.length; i++) {
        const b = banks[i];
        const t = (elapsed * 0.008 + b.phase) % 1;
        b.mesh.position.set(
          BOUNDS.minX - 500 + t * (MAPW + 1000),
          b.y,
          BOUNDS.minZ + ((b.phase * 7.3) % 1) * MAPD,
        );
      }
    },
    dispose() {
      group.removeFromParent();
      domeGeo.dispose();
      domeMat.dispose();
      cloudGeo.dispose();
      fogGeo.dispose();
      sun.dispose();
    },
  };
  return rig;
}

const MAPW = BOUNDS.maxX - BOUNDS.minX;
const MAPD = BOUNDS.maxZ - BOUNDS.minZ;

/** A tiny deterministic RNG so the clouds are in the same place every load. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
