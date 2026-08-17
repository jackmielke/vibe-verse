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
import { COLORS, flat, setNight, toon } from "./look";
import { BOUNDS, VIEW } from "./map";

export interface SkyRig {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  update(dt: number, elapsed: number, camera: THREE.Camera): void;
  /** 0..1 — how much fog is currently over the city. Drives the HUD hint. */
  fogAmount: number;
  setFog(amount: number): void;
  /** Which of `TIMES` is showing. */
  time: TimeOfDay;
  setTime(key: string): void;
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
 * The radius lives in `map.ts` with the clip planes, bounded on both sides and
 * checked by `friscoMap.test.ts`: it has to clear the map's own diagonal or
 * the sky ends up nearer than the far side of the city, and it has to stay
 * inside the far plane or it is clipped away and the sky renders as the clear
 * colour, which reads as "the world failed to load".
 */
const DOME_RADIUS = VIEW.domeRadius;

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

/**
 * The times of day, as five sets of numbers.
 *
 * A named list rather than a continuous clock, and that is a deliberate
 * limitation. A real day/night cycle means every screenshot, every recorded
 * clip and every bug report happens at a different time, and "the shadows look
 * wrong" becomes unanswerable. Five stops you choose between are five looks
 * that can each be checked, and four of them exist mainly so that the fifth —
 * night, with nine thousand lit windows — has something to be different from.
 *
 * `night` is the blend factor `look.ts` uses to light the windows, not a
 * lighting term in itself.
 */
export interface TimeOfDay {
  key: string;
  label: string;
  /** Direction TO the sun. */
  sun: [number, number, number];
  sunColor: number;
  sunIntensity: number;
  skyLow: number;
  skyHigh: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  /** 0 by day, 1 when the lights are on. */
  night: number;
  /** What the clear colour and the loading screen use. */
  backdrop: number;
}

export const TIMES: TimeOfDay[] = [
  {
    key: "dawn", label: "Dawn",
    sun: [0.72, 0.16, 0.34], sunColor: 0xffcf9a, sunIntensity: 1.5,
    skyLow: 0xffd9b0, skyHigh: 0x5c86c4, hemiSky: 0xd8c4e0, hemiGround: 0xc0a888,
    hemiIntensity: 1.0, night: 0.4, backdrop: 0xbcd0e4,
  },
  {
    key: "day", label: "Midday",
    sun: [-0.55, 0.62, -0.36], sunColor: 0xfff4dd, sunIntensity: 2.05,
    skyLow: 0xcfeaf7, skyHigh: 0x3f8fd8, hemiSky: 0xbfe3ff, hemiGround: 0xe8d9b8,
    hemiIntensity: 1.35, night: 0, backdrop: 0x8fd0f0,
  },
  {
    key: "golden", label: "Golden hour",
    sun: [-0.86, 0.22, -0.2], sunColor: 0xffc888, sunIntensity: 2.0,
    skyLow: 0xffd7a4, skyHigh: 0x4f8ecf, hemiSky: 0xd8dcf0, hemiGround: 0xe8c496,
    hemiIntensity: 1.1, night: 0.18, backdrop: 0xd7c0a8,
  },
  {
    key: "dusk", label: "Dusk",
    sun: [-0.94, 0.07, -0.12], sunColor: 0xff9a63, sunIntensity: 1.2,
    skyLow: 0xff9d6e, skyHigh: 0x2c3f78, hemiSky: 0x8a90c8, hemiGround: 0x7a5f60,
    hemiIntensity: 0.85, night: 0.72, backdrop: 0x6a5a80,
  },
  {
    key: "night", label: "Night",
    sun: [-0.4, 0.5, -0.5], sunColor: 0x9fb4e0, sunIntensity: 0.42,
    skyLow: 0x2a3556, skyHigh: 0x0d1430, hemiSky: 0x38456e, hemiGround: 0x232a3c,
    hemiIntensity: 0.5, night: 1, backdrop: 0x121a33,
  },
];

const TIME_KEY = "frisco.time";

/** Where the sun sits. Replaced on every time change. */
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

  const domeLow = domeMat.uniforms.uLow.value as THREE.Color;
  const domeHigh = domeMat.uniforms.uHigh.value as THREE.Color;
  const domeSun = domeMat.uniforms.uSun.value as THREE.Vector3;
  const domeSunColor = domeMat.uniforms.uSunColor.value as THREE.Color;

  let stored = "day";
  try {
    stored = localStorage.getItem(TIME_KEY) ?? "day";
  } catch {
    /* ignore */
  }

  const rig: SkyRig = {
    group,
    sun,
    hemi,
    time: TIMES.find((t) => t.key === stored) ?? TIMES[1],
    setTime(key: string) {
      const t = TIMES.find((v) => v.key === key);
      if (!t) return;
      rig.time = t;
      try {
        localStorage.setItem(TIME_KEY, key);
      } catch {
        /* ignore */
      }
      SUN_DIR.set(t.sun[0], t.sun[1], t.sun[2]).normalize();
      sun.color.setHex(t.sunColor);
      sun.intensity = t.sunIntensity;
      hemi.color.setHex(t.hemiSky);
      hemi.groundColor.setHex(t.hemiGround);
      hemi.intensity = t.hemiIntensity;
      domeLow.setHex(t.skyLow);
      domeHigh.setHex(t.skyHigh);
      domeSunColor.setHex(t.sunColor);
      domeSun.copy(SUN_DIR);
      /* The clouds go with the light. They are unlit white geometry, so at
         night they stay a bright white cut-out unless somebody tells them —
         which is the single most obvious tell that a "night mode" is a filter
         rather than a time of day. */
      cloudMat.color.setHex(t.night > 0.5 ? 0x5d6a8c : 0xffffff);
      setNight(t.night);
    },
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
      domeSun.copy(SUN_DIR);

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
  rig.setTime(rig.time.key);
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
