/**
 * Sky — atmosphere, sun, and the light rig the whole city is lit by.
 *
 * A raymarched single-scattering atmosphere (Rayleigh + Mie) evaluated in the
 * fragment shader on a backside-rendered sphere. This is more expensive than a
 * gradient, and it is worth every cycle: it is what gives you a real sunset,
 * a real blue hour, a sun that reddens as it sets, and a horizon that gets
 * hazier the further you look — none of which a lerp between two colours will
 * ever fake convincingly.
 *
 * It also owns the key light, the sky fill, and the scene fog colour, so
 * everything stays consistent with wherever the sun actually is.
 */
import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { frame } from "../state/store";
import { QUALITY } from "../config";
import { useSfStore } from "../state/store";
import { clamp, clamp01, smoothstep } from "../math/rng";
import { walkableHeight } from "../geo/sfGeo";

/* ------------------------------------------------------------------ *
 * Sun position
 * ------------------------------------------------------------------ */

/**
 * Sun direction for San Francisco at a given local hour — the real solar
 * position equations for latitude 37.77°N at a late-spring declination.
 *
 * This matters more than it sounds. Faking the solar path with a sine wave
 * puts the sun in the wrong part of the sky all day, and every shadow in the
 * city then falls in a direction a San Franciscan would find subtly wrong.
 * With the real equations you get the genuine article: sun rising over the
 * East Bay around 06:25, crossing high in the south at solar noon, and setting
 * out past the Golden Gate to the northwest just before 19:40 — which is
 * exactly why the bridge is a sunset shot and Coit Tower is a sunrise one.
 */
const SF_LAT = (37.7749 * Math.PI) / 180;
const SUN_DECL = (12.0 * Math.PI) / 180; // late spring / early autumn
const SOLAR_NOON = 13.1; // PDT

export function sunDirection(hour: number, out = new THREE.Vector3()): THREE.Vector3 {
  const H = ((hour - SOLAR_NOON) * 15 * Math.PI) / 180; // hour angle, radians
  const sinElev =
    Math.sin(SUN_DECL) * Math.sin(SF_LAT) +
    Math.cos(SUN_DECL) * Math.cos(SF_LAT) * Math.cos(H);
  const elev = Math.asin(Math.max(-1, Math.min(1, sinElev)));
  // Azimuth measured from due south, positive toward the west.
  const az = Math.atan2(
    Math.sin(H),
    Math.cos(H) * Math.sin(SF_LAT) - Math.tan(SUN_DECL) * Math.cos(SF_LAT),
  );
  const cosE = Math.cos(elev);
  // +X east, +Z south: south is (0,0,1), west is (-1,0,0).
  out.set(-Math.sin(az) * cosE, Math.sin(elev), Math.cos(az) * cosE);
  return out.normalize();
}

/** Local hours of sunrise and sunset, for the day/night cycle and mission timing. */
export function sunTimes(): { sunrise: number; sunset: number } {
  const cosH = -Math.tan(SUN_DECL) * Math.tan(SF_LAT);
  const H = (Math.acos(Math.max(-1, Math.min(1, cosH))) * 180) / Math.PI / 15;
  return { sunrise: SOLAR_NOON - H, sunset: SOLAR_NOON + H };
}

/** Warm/cool key-light colour for the hour. */
export function sunColor(hour: number, out = new THREE.Color()): THREE.Color {
  const elev = sunDirection(hour).y;
  // Below the horizon → moonlight; low → deep orange; high → near-white.
  if (elev <= 0.02) {
    const t = clamp01((elev + 0.14) / 0.16);
    return out.setRGB(0.22, 0.28, 0.46).lerp(new THREE.Color(1.0, 0.42, 0.18), t);
  }
  const warm = new THREE.Color(1.0, 0.48, 0.20);
  const noon = new THREE.Color(1.0, 0.965, 0.92);
  return out.copy(warm).lerp(noon, smoothstep(0.02, 0.42, elev));
}

/** Key-light intensity in arbitrary-but-consistent units. */
export function sunIntensity(hour: number): number {
  const elev = sunDirection(hour).y;
  if (elev <= 0) return 0.05 + clamp01((elev + 0.2) / 0.2) * 0.12;
  return 0.4 + smoothstep(0, 0.5, elev) * 3.4;
}

/** Ambient/sky fill colour for the hour. */
export function skyFillColor(hour: number, out = new THREE.Color()): THREE.Color {
  const elev = sunDirection(hour).y;
  const night = new THREE.Color(0.045, 0.06, 0.11);
  const dusk = new THREE.Color(0.24, 0.24, 0.34);
  const day = new THREE.Color(0.42, 0.52, 0.68);
  if (elev < 0) return out.copy(night).lerp(dusk, clamp01((elev + 0.16) / 0.16));
  return out.copy(dusk).lerp(day, smoothstep(0, 0.35, elev));
}

/** Fog / aerial-perspective colour — the marine layer's own colour. */
export function fogColor(hour: number, fogDensity: number, out = new THREE.Color()): THREE.Color {
  const elev = sunDirection(hour).y;
  const night = new THREE.Color(0.055, 0.068, 0.098);
  const dawn = new THREE.Color(0.66, 0.55, 0.52);
  const day = new THREE.Color(0.74, 0.80, 0.855);
  if (elev < 0) out.copy(night).lerp(dawn, clamp01((elev + 0.14) / 0.14));
  else out.copy(dawn).lerp(day, smoothstep(0.0, 0.28, elev));
  // Thicker fog is greyer and less saturated — Karl is not a colourful fellow.
  const grey = (out.r + out.g + out.b) / 3;
  out.lerp(new THREE.Color(grey, grey, grey * 1.03), fogDensity * 0.45);
  return out;
}

/* ------------------------------------------------------------------ *
 * Atmosphere shader
 * ------------------------------------------------------------------ */

const skyVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // force to the far plane
}
`;

const skyFragment = /* glsl */ `
precision highp float;

uniform vec3  uSunDirection;
uniform float uTurbidity;
uniform float uFogDensity;
uniform float uExposure;
uniform float uTime;
uniform float uNight;      // 0 = day, 1 = full night
uniform vec3  uGroundColor;

varying vec3 vDir;

const float PI = 3.141592653589793;

// Rayleigh scattering coefficients at sea level (RGB), 1/m.
const vec3 BETA_R = vec3(5.8e-6, 13.5e-6, 33.1e-6);
// Mie scattering — aerosol, the haze that makes the horizon white.
const float BETA_M = 21e-6;

const float EARTH_R = 6360e3;
const float ATMO_R  = 6420e3;
const float H_R = 7994.0;
const float H_M = 1200.0;

float rayleighPhase(float mu) {
  return 3.0 / (16.0 * PI) * (1.0 + mu * mu);
}

float miePhase(float mu, float g) {
  float g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) /
         ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
}

// Ray-sphere intersection from inside.
float atmosphereDistance(vec3 origin, vec3 dir, float radius) {
  float b = dot(origin, dir);
  float c = dot(origin, origin) - radius * radius;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  return -b + sqrt(d);
}

vec3 scatter(vec3 dir, vec3 sunDir, float turbidity) {
  vec3 origin = vec3(0.0, EARTH_R + 800.0, 0.0);
  float tMax = atmosphereDistance(origin, dir, ATMO_R);
  if (tMax <= 0.0) return vec3(0.0);

  const int STEPS = 16;
  const int LIGHT_STEPS = 6;

  float mu = dot(dir, sunDir);
  float pR = rayleighPhase(mu);
  float pM = miePhase(mu, 0.78);

  float betaM = BETA_M * turbidity;

  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  float odR = 0.0;
  float odM = 0.0;

  float segment = tMax / float(STEPS);
  float t = segment * 0.5;

  for (int i = 0; i < STEPS; i++) {
    vec3 p = origin + dir * t;
    float h = max(length(p) - EARTH_R, 0.0);
    float hr = exp(-h / H_R) * segment;
    float hm = exp(-h / H_M) * segment;
    odR += hr;
    odM += hm;

    // Optical depth toward the sun.
    float lightT = atmosphereDistance(p, sunDir, ATMO_R);
    float lightSeg = lightT / float(LIGHT_STEPS);
    float odLR = 0.0;
    float odLM = 0.0;
    float lt = lightSeg * 0.5;
    bool blocked = false;
    for (int j = 0; j < LIGHT_STEPS; j++) {
      vec3 lp = p + sunDir * lt;
      float lh = length(lp) - EARTH_R;
      if (lh < 0.0) { blocked = true; break; }
      odLR += exp(-lh / H_R) * lightSeg;
      odLM += exp(-lh / H_M) * lightSeg;
      lt += lightSeg;
    }

    if (!blocked) {
      vec3 tau = BETA_R * (odR + odLR) + vec3(betaM * 1.1 * (odM + odLM));
      vec3 attenuation = exp(-tau);
      sumR += attenuation * hr;
      sumM += attenuation * hm;
    }
    t += segment;
  }

  return 22.0 * (sumR * BETA_R * pR + sumM * betaM * pM);
}

// Stars — hashed points, only visible once the sun is well down.
float stars(vec3 dir) {
  vec3 p = dir * 340.0;
  vec3 i = floor(p);
  float h = fract(sin(dot(i, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  if (h < 0.9965) return 0.0;
  vec3 f = fract(p) - 0.5;
  float d = length(f);
  float twinkle = 0.65 + 0.35 * sin(uTime * (1.5 + h * 9.0) + h * 60.0);
  return smoothstep(0.36, 0.0, d) * twinkle * (h - 0.9965) / 0.0035;
}

void main() {
  vec3 dir = normalize(vDir);

  vec3 col = scatter(dir, uSunDirection, uTurbidity) * uExposure;

  // The solar disc itself, softened by the aerosol.
  float mu = dot(dir, uSunDirection);
  float disc = smoothstep(0.99975, 0.99992, mu);
  float bloom = pow(max(mu, 0.0), 900.0) * 0.7 + pow(max(mu, 0.0), 60.0) * 0.05;
  col += vec3(1.0, 0.93, 0.82) * (disc * 22.0 + bloom) * (1.0 - uNight * 0.92);

  // Night sky: stars plus a faint airglow, never pure black.
  vec3 nightCol = vec3(0.010, 0.016, 0.034)
                + vec3(0.9, 0.92, 1.0) * stars(dir) * 0.9
                + vec3(0.02, 0.03, 0.06) * pow(clamp(1.0 - dir.y, 0.0, 1.0), 3.0);
  col = mix(col, nightCol, uNight);

  // Ground half of the dome: the world's own haze, so there is no hard seam
  // where geometry ends and sky begins.
  float below = smoothstep(0.03, -0.12, dir.y);
  col = mix(col, uGroundColor, below * 0.92);

  // The marine layer eats the horizon.
  float horizon = 1.0 - smoothstep(0.0, 0.34, abs(dir.y));
  vec3 haze = mix(vec3(0.72, 0.78, 0.84), vec3(0.06, 0.075, 0.11), uNight);
  col = mix(col, haze, horizon * uFogDensity * 0.85);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export default function Sky() {
  const { scene } = useThree();
  const tier = useSfStore((s) => s.quality);
  const q = QUALITY[tier];

  const sunRef = useRef<THREE.DirectionalLight>(null);
  const hemiRef = useRef<THREE.HemisphereLight>(null);
  const bounceRef = useRef<THREE.HemisphereLight>(null);
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const domeRef = useRef<THREE.Mesh>(null);

  const uniforms = useMemo(
    () => ({
      uSunDirection: { value: new THREE.Vector3(0.3, 0.4, 0.8).normalize() },
      uTurbidity: { value: 2.6 },
      uFogDensity: { value: 0.35 },
      uExposure: { value: 1.0 },
      uTime: { value: 0 },
      uNight: { value: 0 },
      uGroundColor: { value: new THREE.Color(0.42, 0.44, 0.46) },
    }),
    [],
  );

  const scratch = useMemo(
    () => ({
      dir: new THREE.Vector3(),
      sun: new THREE.Color(),
      fill: new THREE.Color(),
      fog: new THREE.Color(),
    }),
    [],
  );

  useFrame(({ camera }) => {
    const hour = frame.timeOfDay;
    const dir = sunDirection(hour, scratch.dir);
    const night = 1 - clamp01((dir.y + 0.14) / 0.2);

    // Sky dome rides with the camera.
    if (domeRef.current) domeRef.current.position.copy(camera.position);

    if (matRef.current) {
      const u = matRef.current.uniforms;
      u.uSunDirection.value.copy(dir);
      u.uFogDensity.value = frame.fogDensity;
      u.uTime.value = frame.time;
      u.uNight.value = night;
      // Turbidity rises with the marine layer — more aerosol, whiter horizon.
      u.uTurbidity.value = 2.0 + frame.fogDensity * 5.5;
      (u.uGroundColor.value as THREE.Color).copy(fogColor(hour, frame.fogDensity, scratch.fog));
    }

    // Key light.
    if (sunRef.current) {
      const light = sunRef.current;
      light.position.copy(camera.position).addScaledVector(dir, 900);
      light.target.position.copy(camera.position);
      light.target.updateMatrixWorld();
      light.color.copy(sunColor(hour, scratch.sun));
      // Fog robs the key light of its punch and hands it to the ambient.
      light.intensity = sunIntensity(hour) * (1 - frame.fogDensity * 0.55);
      light.castShadow = q.shadowCascades > 0;
      if (light.shadow) {
        const cam = light.shadow.camera as THREE.OrthographicCamera;
        /**
         * The shadow frustum follows how high you are, and that is what stops
         * the pavement crawling with speckle.
         *
         * One orthographic map covering `shadowDistance` spends its texels
         * uniformly: at the medium tier that is 560 m across a 1536² map, or
         * 36 cm per texel. Thirty-six centimetres is fine for a building's
         * shadow seen from the air and hopeless on the road surface directly
         * under a character's feet — the depth comparison lands on the wrong
         * side of the texel in patches, and a downtown street in shadow fills
         * with lit white crumbs. Nobody had seen it because until there was a
         * walking mode nobody was ever down there.
         *
         * Height above ground is the free variable, exactly as camera distance
         * is in Vibe City's near plane: what you can see the shadows OF grows
         * with how high you are, so the frustum can shrink to a tenth when you
         * are standing on the street and take the texel to 9 cm.
         */
        const agl = camera.position.y - walkableHeight(camera.position.x, camera.position.z);
        const d = clamp(64 + Math.max(agl, 0) * 1.5, 64, Math.max(q.shadowDistance * 0.5, 64));
        // Re-projecting every frame on a continuously varying number is a
        // matrix rebuild for nothing; 6% is under the threshold where the
        // shadow edge visibly resamples.
        if (Math.abs(cam.right - d) > d * 0.06) {
          cam.left = -d;
          cam.right = d;
          cam.top = d;
          cam.bottom = -d;
          cam.near = 1;
          cam.far = 2600;
          cam.updateProjectionMatrix();
        }
        light.shadow.bias = -0.0006;
        // Normal bias is in world units, so it has to shrink with the frustum
        // or a tight map pays a 55 cm offset it no longer needs — which is how
        // a shadow detaches from the thing casting it.
        light.shadow.normalBias = Math.max(0.05, (d / 280) * 0.55);
      }
    }

    // Sky fill.
    if (hemiRef.current) {
      const fill = skyFillColor(hour, scratch.fill);
      hemiRef.current.color.copy(fill);
      hemiRef.current.groundColor.copy(fill).multiplyScalar(0.35);
      hemiRef.current.intensity = 0.55 + frame.fogDensity * 0.9 + (1 - night) * 0.35;
    }

    /**
     * The third term: warm bounce off the sunlit facades.
     *
     * ART_DIRECTION lists three lights — "the sun as key, the sky dome as a
     * coloured fill, and the ground bounce as a warm third term" — and only two
     * of them were ever built. From the air you cannot tell, because everything
     * up there is in direct sun. From the pavement it is the whole picture: a
     * downtown street at golden hour is in shadow from end to end, and with a
     * cold sky fill as its only light the asphalt reads as pure black. The
     * light that is actually falling on that road in real life comes off the
     * building faces opposite, which are in full sun and are the warmest thing
     * for a mile.
     *
     * A hemisphere light lights +Y normals with its sky colour, so this term
     * lands on roads, pavements and roof decks — the horizontal surfaces the
     * bounce would reach — and barely touches the walls that are casting it. It
     * follows the sun's own colour and intensity, so it is at its strongest and
     * most orange exactly when the shadows are longest, and it goes away at
     * night when there is nothing to bounce.
     */
    if (bounceRef.current) {
      const warm = sunColor(hour, scratch.sun);
      bounceRef.current.color.copy(warm);
      bounceRef.current.groundColor.copy(warm).multiplyScalar(0.15);
      bounceRef.current.intensity = 0.55 * sunIntensity(hour) * (1 - frame.fogDensity * 0.4);
    }

    // Scene fog tracks the atmosphere so distant geometry and sky agree.
    const fc = fogColor(hour, frame.fogDensity, scratch.fog);
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.color.copy(fc);
      scene.fog.near = 260 - frame.fogDensity * 180;
      scene.fog.far = 1800 + (1 - frame.fogDensity) * 9000;
    }
    scene.background = null;
  });

  return (
    <>
      <mesh ref={domeRef} frustumCulled={false} renderOrder={-1000} name="sky">
        <sphereGeometry args={[1, 48, 32]} />
        <shaderMaterial
          ref={matRef}
          vertexShader={skyVertex}
          fragmentShader={skyFragment}
          uniforms={uniforms}
          side={THREE.BackSide}
          depthWrite={false}
          depthTest={false}
          toneMapped={false}
        />
      </mesh>

      <directionalLight
        ref={sunRef}
        castShadow
        shadow-mapSize-width={q.shadowMapSize}
        shadow-mapSize-height={q.shadowMapSize}
      />
      <hemisphereLight ref={hemiRef} intensity={0.8} />
      {/* The warm bounce term — see the note where it is driven, above. */}
      <hemisphereLight ref={bounceRef} intensity={0} />
    </>
  );
}
