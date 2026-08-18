/**
 * Sky, sun, and the environment light everything else is lit by.
 *
 * ## The one thing that makes this look real
 *
 * Not the shadows and not the water — the **environment map**. Three lights in
 * a scene give you three directions of information, and a PBR material lit that
 * way looks like a product render on a white sweep. A PMREM of the actual sky
 * gives every material the whole hemisphere: a rock in shadow picks up the blue
 * above it, a wet stone at the shore reflects the orange band at the horizon,
 * and the difference between those two facts is most of what "photoreal" means
 * at dawn.
 *
 * It costs one render of the sky into a cube target, and it is regenerated only
 * when the sun has moved far enough to matter (`ENV_STEP`), not every frame.
 * Regenerating a PMREM per frame is a well-worn way to turn a 60 fps scene into
 * a 20 fps one, because it is a full mip chain of convolutions each time.
 *
 * ## Colour is not decoration here
 *
 * Sun colour, fog colour and ambient are all derived from one number — the sun
 * elevation — so they cannot drift apart. Hand-tuning three colour pickers to
 * agree at every time of day is how a scene ends up with a warm sun, a grey
 * horizon and a blue ambient all at once, which the eye reads instantly as
 * wrong without being able to say why.
 */
import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";

export interface SkySystem {
  sky: Sky;
  sun: THREE.DirectionalLight;
  ambient: THREE.HemisphereLight;
  /** Sun elevation in degrees. Drive this to move the day. */
  setElevation(deg: number, azimuthDeg?: number): void;
  /** Call after `setElevation`; cheap unless the sun really moved. */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void;
  readonly elevation: number;
  readonly sunDirection: THREE.Vector3;
  /** Horizon colour at the current elevation — what the fog matches. */
  readonly horizon: THREE.Color;
  dispose(): void;
}

/** Regenerate the environment only after the sun has moved this far. */
const ENV_STEP = 0.35;

/**
 * Sun colour through the day. Sampled from the transmittance you actually get
 * at these elevations rather than picked: at −2° the disc is below the horizon
 * and lighting the scene only through scattered light, so the "sun" colour is a
 * dim rose; by 10° it has gone through most of its warmth into near-white.
 */
function sunColorFor(elevationDeg: number, out: THREE.Color): THREE.Color {
  const e = elevationDeg;
  if (e <= -4) return out.setRGB(0.16, 0.15, 0.22);
  if (e < 0) return out.setRGB(0.16, 0.15, 0.22).lerp(new THREE.Color(0.95, 0.42, 0.24), (e + 4) / 4);
  if (e < 6) return out.setRGB(0.95, 0.42, 0.24).lerp(new THREE.Color(1.0, 0.74, 0.5), e / 6);
  if (e < 16) return out.setRGB(1.0, 0.74, 0.5).lerp(new THREE.Color(1.0, 0.95, 0.88), (e - 6) / 10);
  return out.setRGB(1.0, 0.95, 0.88);
}

/** Roughly how bright the disc is once the atmosphere has taken its cut. */
function sunIntensityFor(elevationDeg: number): number {
  if (elevationDeg <= -5) return 0;
  return Math.min(1, Math.max(0, (elevationDeg + 5) / 13)) ** 1.5 * 5.8;
}

export function createSky(opts: { shadowMapSize: number; shadowDistance: number }): SkySystem {
  const sky = new Sky();
  sky.scale.setScalar(45000);

  const u = sky.material.uniforms;
  /* Tuned for sunrise, and the first pass had it backwards. Turbidity 3 and
     rayleigh 2 is a clean high-altitude noon: at 5° elevation it produced a
     flat pale-blue wash with no warmth anywhere, which is what the first
     capture of this world showed.
     
     Sunrise is the opposite — a *dirty* atmosphere is what makes it red. High
     turbidity puts more aerosol in the path, which is what strips the blue out
     of a low sun and leaves the orange; low rayleigh keeps the rest of the sky
     from going saturated blue and fighting it; and a high mie g concentrates
     the forward scatter into the glow immediately around the disc rather than
     spreading it over the whole dome. */
  u.turbidity.value = 9.5;
  u.rayleigh.value = 1.45;
  u.mieCoefficient.value = 0.006;
  u.mieDirectionalG.value = 0.86;

  const sunDirection = new THREE.Vector3();
  const horizon = new THREE.Color();
  let elevation = -2;
  let azimuth = 126;
  let lastEnvElevation = Number.NEGATIVE_INFINITY;

  const sun = new THREE.DirectionalLight(0xffffff, 0);
  sun.castShadow = opts.shadowMapSize > 0;
  if (sun.castShadow) {
    sun.shadow.mapSize.set(opts.shadowMapSize, opts.shadowMapSize);
    const d = opts.shadowDistance;
    const cam = sun.shadow.camera;
    cam.left = -d;
    cam.right = d;
    cam.top = d;
    cam.bottom = -d;
    cam.near = 1;
    cam.far = d * 4.5;
    /* Dawn means long shadows, which means grazing light, which is the exact
       case that acne shows up in. A slope-scaled bias handles it without the
       peter-panning a large constant bias would cause on the reeds. */
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.6;
  }
  sun.target.position.set(0, 0, 0);

  /* Hemisphere light stands in for the ground bounce the PMREM cannot give us:
     the env map is the sky only, so without this everything's underside is lit
     by nothing at all and reads as if it is floating. */
  const ambient = new THREE.HemisphereLight(0x9fb6d4, 0x4a4433, 0);

  let pmrem: THREE.PMREMGenerator | null = null;
  let envRT: THREE.WebGLRenderTarget | null = null;
  const envScene = new THREE.Scene();
  envScene.add(sky);

  const sunColor = new THREE.Color();

  const applySun = () => {
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    sunDirection.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(sunDirection);

    sunColorFor(elevation, sunColor);
    sun.color.copy(sunColor);
    sun.intensity = sunIntensityFor(elevation);
    sun.position.copy(sunDirection).multiplyScalar(opts.shadowDistance * 2.2);

    /* Ambient tracks the sky but never goes fully dark — pre-dawn is dim, not
       black, and a scene that clamps to zero here loses the shore entirely.
       
       Kept deliberately low. A hemisphere fill this size is the difference
       between dawn and an overcast morning: at 0.56 it was landing more light
       on the shore than the sun was, so the warm key had nothing to contrast
       against and the whole frame went grey. Fill should lift the shadows, not
       compete for them. */
    const day = Math.min(1, Math.max(0, (elevation + 6) / 20));
    const amb = 0.12 + day * 0.4;
    ambient.intensity = amb;
    /* And it warms up as the sun comes through it. A constant blue fill under a
       gold key is the other half of why this read cold — skylight at sunrise is
       genuinely warmer than skylight at noon, because most of what reaches the
       ground has come through the same long path the sun did. */
    const warmth = 1 - Math.min(1, Math.max(0, (elevation + 2) / 12));
    ambient.color.setRGB(
      0.52 + warmth * 0.34,
      0.64 + warmth * 0.1,
      0.86 - warmth * 0.32,
    );

    /* The horizon colour, approximated from the same elevation that drives the
       sky shader. The fog reads this, so aerial perspective always agrees with
       what is painted behind it. */
    if (elevation < 0) horizon.setRGB(0.29, 0.3, 0.4).lerp(new THREE.Color(0.86, 0.5, 0.36), (elevation + 6) / 6);
    else if (elevation < 8) horizon.setRGB(0.86, 0.5, 0.36).lerp(new THREE.Color(0.76, 0.79, 0.85), elevation / 8);
    else horizon.setRGB(0.76, 0.79, 0.85).lerp(new THREE.Color(0.68, 0.76, 0.9), Math.min(1, (elevation - 8) / 22));
  };
  applySun();

  return {
    sky,
    sun,
    ambient,
    get elevation() {
      return elevation;
    },
    get sunDirection() {
      return sunDirection;
    },
    get horizon() {
      return horizon;
    },
    setElevation(deg: number, azimuthDeg?: number) {
      elevation = deg;
      if (azimuthDeg !== undefined) azimuth = azimuthDeg;
      applySun();
    },
    update(renderer, scene) {
      if (Math.abs(elevation - lastEnvElevation) < ENV_STEP) return;
      lastEnvElevation = elevation;
      if (!pmrem) {
        pmrem = new THREE.PMREMGenerator(renderer);
        pmrem.compileEquirectangularShader();
      }
      const prev = envRT;
      envRT = pmrem.fromScene(envScene);
      scene.environment = envRT.texture;
      /* Dispose *after* swapping: releasing the target that is still bound as
         scene.environment gives one frame of black reflections on every
         material, which at ENV_STEP intervals is a visible strobe. */
      prev?.dispose();
    },
    dispose() {
      sky.geometry.dispose();
      (sky.material as THREE.Material).dispose();
      envRT?.dispose();
      pmrem?.dispose();
    },
  };
}
