/**
 * The atmosphere model — one source of truth for where the sun is and what
 * colour everything therefore is.
 *
 * Every other file in `env/` reads from here: the sky dome shades with these
 * coefficients, the key light takes this colour and intensity, the fog takes
 * this horizon colour, the clouds take this rim tint. That single-source rule
 * is what stops the classic amateur mismatch where the sky says "sunset" and
 * the shadows say "midday".
 *
 * The scattering is Preetham-flavoured single scattering: Rayleigh + Mie with
 * an empirical air-mass fit instead of a raymarch. It is a closed form — no
 * loops, no LUTs, ~40 flops a pixel — which matters because the screenshot
 * harness rasterises on the CPU and a 96-tap sky would cost more than the rest
 * of the frame put together. It still gives the real article: a horizon that
 * reddens as the sun drops, a blue that deepens with altitude, and a whitening
 * aureole around the sun for bloom to bite into.
 *
 * ## Units
 * Every colour that ends up multiplied into a fragment (haze, ground bounce,
 * cloud palette) is stored pre-scaled into *render-linear* units — the range
 * the renderer's ACES curve actually resolves, roughly 0.02 … 0.8, with
 * anything above ~1.0 clipping to white. Light `color` values are the
 * exception: three multiplies those by `intensity` itself, so they stay
 * full-range and the intensity carries the exposure.
 */
import * as THREE from "three";
import { clamp01, smoothstep } from "./noise";

// ---------------------------------------------------------------------------
// Sun position
// ---------------------------------------------------------------------------

/**
 * Tilt of the solar arc away from the zenith, radians. At `timeOfDay` 0.25 the
 * sun therefore sits 60° up rather than dead overhead — a sun straight above
 * the track flattens every kart into a pancake with no shadow to read height
 * from, which is precisely the mistake that makes an arcade racer look cheap.
 */
const SUN_ARC_TILT = 0.52;

/**
 * `timeOfDay` runs 0 → 1 over a full day: 0 is sunrise on the +X horizon,
 * 0.25 is high noon, 0.5 is sunset on the -X horizon, 0.75 is midnight.
 *
 * Vibe Kart ships at 0.415 — mid-afternoon, sun ~26° up and a little south.
 * That is a deliberate compromise found by looking at the frame: a 15° sun is
 * a prettier sky but it puts every horizontal surface at grazing incidence, so
 * the grass goes muddy and the tarmac goes flat. 26° keeps the light warm and
 * the shadows long while still landing enough cosine on the ground plane for
 * the course's colours to actually sing.
 */
export const GOLDEN_HOUR = 0.415;

/** Unit vector pointing **at** the sun from anywhere in the world. */
export function sunDirection(timeOfDay: number, out = new THREE.Vector3()): THREE.Vector3 {
  const theta = timeOfDay * Math.PI * 2;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  // A circle in the XY plane, tipped about the east-west axis so the arc leans
  // south. Elevation therefore peaks at (π/2 - SUN_ARC_TILT).
  return out.set(c, s * Math.cos(SUN_ARC_TILT), s * Math.sin(SUN_ARC_TILT)).normalize();
}

/** Sine of the solar elevation, i.e. `sunDirection().y`. */
export function sunAltitude(timeOfDay: number): number {
  return Math.sin(timeOfDay * Math.PI * 2) * Math.cos(SUN_ARC_TILT);
}

// ---------------------------------------------------------------------------
// Scattering coefficients
// ---------------------------------------------------------------------------

/** Rayleigh scattering at sea level for R/G/B, 1/m. Blue scatters ~5.7×. */
const BETA_RAYLEIGH = new THREE.Vector3(5.804e-6, 1.3562e-5, 3.0265e-5);

/**
 * Mie basis at the same three wavelengths. Multiplied through by
 * `0.434 · 0.2 · turbidity · 1e-18 · MIE_COEFF` to get 1/m. Aerosol scatters
 * almost neutrally, which is why haze is white and never blue.
 */
const MIE_BASIS = new THREE.Vector3(1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14);
const MIE_COEFF = 0.0048;

/** Extraterrestrial solar irradiance, arbitrary-but-consistent units. */
const SOLAR_CONSTANT = 1000;

/**
 * Radiance → render-linear scale for the sky. Derived, not guessed: with the
 * renderer's ACES curve a mid-blue zenith wants to land near 0.11 linear, and
 * raw Preetham radiance at that point is ~21, so the sky rides at ~1/190.
 * Change this and every shot in the game changes exposure.
 */
export const SKY_EXPOSURE = 0.0052;

/** Everything the sky, the lights, the clouds and the fog need at one instant. */
export interface AtmosphereState {
  timeOfDay: number;
  /** Unit vector toward the sun. */
  direction: THREE.Vector3;
  /** sin(elevation). */
  altitude: number;
  /** 0 by day, 1 once the sun is properly down — drives stars and the grade. */
  night: number;
  /** 0 at the horizon, 1 with the sun high. Drives warmth everywhere. */
  dayness: number;

  betaR: THREE.Vector3;
  betaM: THREE.Vector3;
  mieG: number;
  sunE: number;
  turbidity: number;

  /** Key light. */
  keyColor: THREE.Color;
  keyIntensity: number;
  /** Sun disc as painted in the sky — HDR, this is what bloom feeds on. */
  discColor: THREE.Color;
  discPower: number;

  /** Hemisphere fill: sky above, bounced ground below. Full-range light colours. */
  skyColor: THREE.Color;
  groundColor: THREE.Color;
  fillIntensity: number;

  /** Cool counter-key from the anti-sun side — the silhouette separator. */
  rimColor: THREE.Color;
  rimIntensity: number;
  /** Warm bounce coming back up off the tarmac into the kart bellies. */
  bounceColor: THREE.Color;
  bounceIntensity: number;

  /** Aerial perspective. Render-linear: also the sky's horizon band and the fog. */
  hazeColor: THREE.Color;
  fogDensity: number;
  /** What the sky sees when it looks down. Render-linear. */
  groundBounce: THREE.Color;

  /** Cloud palette, render-linear (the rim deliberately over 1). */
  cloudShadow: THREE.Color;
  cloudLit: THREE.Color;
  cloudRim: THREE.Color;
}

const scratchColor = new THREE.Color();

function mixColor(out: THREE.Color, a: number, b: number, t: number): THREE.Color {
  return out.setHex(a).lerp(scratchColor.setHex(b), clamp01(t));
}

/**
 * Solar irradiance reaching the top of the atmosphere at this elevation. The
 * exponential shoulder is what makes the last ten minutes before sunset fall
 * off smoothly instead of snapping to black.
 */
function solarIrradiance(altitude: number): number {
  const zenithAngle = Math.acos(clamp01(altitude));
  const cutoff = Math.PI / 1.95;
  return SOLAR_CONSTANT * Math.max(0, 1 - Math.exp(-(cutoff - zenithAngle) / 1.5));
}

function makeState(): AtmosphereState {
  return {
    timeOfDay: 0,
    direction: new THREE.Vector3(),
    altitude: 0,
    night: 0,
    dayness: 1,
    betaR: new THREE.Vector3(),
    betaM: new THREE.Vector3(),
    mieG: 0.79,
    sunE: 0,
    turbidity: 3,
    keyColor: new THREE.Color(),
    keyIntensity: 1,
    discColor: new THREE.Color(),
    discPower: 12,
    skyColor: new THREE.Color(),
    groundColor: new THREE.Color(),
    fillIntensity: 0.5,
    rimColor: new THREE.Color(),
    rimIntensity: 0.4,
    bounceColor: new THREE.Color(),
    bounceIntensity: 0.3,
    hazeColor: new THREE.Color(),
    fogDensity: 0.0011,
    groundBounce: new THREE.Color(),
    cloudShadow: new THREE.Color(),
    cloudLit: new THREE.Color(),
    cloudRim: new THREE.Color(),
  };
}

/**
 * Build the full lighting state for a time of day. Called at boot and whenever
 * `timeOfDay` changes — never per frame, because none of this is free and none
 * of it changes without a deliberate act.
 */
export function computeAtmosphere(timeOfDay: number, out?: AtmosphereState): AtmosphereState {
  const s = out ?? makeState();
  const dir = sunDirection(timeOfDay, s.direction);
  const alt = dir.y;

  // Night ramps in over the last few degrees of dusk; `dayness` is the "how
  // white is the light" control that everything warm keys off. Its top end is
  // set at the *zenith*, not at some low elevation, so a 26° afternoon sun
  // reads as roughly half-warm rather than as noon-with-a-tint.
  const night = 1 - smoothstep(-0.16, 0.02, alt);
  const dayness = smoothstep(0, 0.85, alt);

  // More aerosol when the sun is low. A golden hour in clean air looks like a
  // colour-picker gradient; the haze is what sells the depth.
  const turbidity = 2.4 + (1 - dayness) * 4.2;

  s.timeOfDay = timeOfDay;
  s.altitude = alt;
  s.night = night;
  s.dayness = dayness;
  s.turbidity = turbidity;

  // Rayleigh is dialled up well past sea-level truth: the honest coefficient
  // gives a pale washed zenith once the sun is low, and Mario Kart's sky is
  // emphatically not pale. Physically-plausible, art-directed.
  s.betaR.copy(BETA_RAYLEIGH).multiplyScalar(2.9 + (1 - dayness) * 0.8);
  s.betaM.copy(MIE_BASIS).multiplyScalar(0.434 * 0.2 * turbidity * 1e-18 * MIE_COEFF);
  s.mieG = 0.79;
  s.sunE = solarIrradiance(alt);

  // --- Lights -------------------------------------------------------------
  // Deep amber on the deck, near-white at altitude, moonlight below it.
  if (alt <= 0) mixColor(s.keyColor, 0x2b3a68, 0xff6a22, clamp01((alt + 0.16) / 0.18));
  else mixColor(s.keyColor, 0xff8534, 0xfff4e2, dayness);
  // The key has to carry the frame on its own: a low sun lands little cosine
  // on horizontal surfaces, so the intensity is pushed up to compensate rather
  // than letting the ambient fill in and flatten everything.
  s.keyIntensity = alt <= 0
    ? 0.14 + clamp01((alt + 0.2) / 0.2) * 0.2
    : 1.0 + smoothstep(0, 0.55, alt) * 2.5;

  // The painted disc runs hotter and paler than the light it casts — a sun the
  // same colour as its own key reads as a sticker glued to the backdrop.
  mixColor(s.discColor, 0xffb066, 0xfff8ec, smoothstep(0.02, 0.6, alt));
  s.discPower = (9 + dayness * 7) * (1 - night);

  mixColor(s.skyColor, 0x3d4f78, 0x9fc9f2, smoothstep(-0.05, 0.4, alt));
  mixColor(s.groundColor, 0x1b2028, 0x7a6d52, smoothstep(-0.05, 0.3, alt));
  // Deliberately modest: `scene.environment` already carries most of the
  // ambient, and doubling it up is how a scene ends up flat and milky.
  s.fillIntensity = 0.26 + dayness * 0.34;

  // The single light that does most for silhouette readability. Without it any
  // kart facing away from the sun collapses into one flat dark shape.
  mixColor(s.rimColor, 0x33477a, 0x8fc4ff, dayness);
  s.rimIntensity = 0.18 + dayness * 0.42;

  mixColor(s.bounceColor, 0x2a2620, 0xffc07a, dayness);
  s.bounceIntensity = 0.1 + dayness * 0.34;

  // --- Aerial perspective -------------------------------------------------
  // The horizon at golden hour is peach; by night it matches the zenith so
  // nothing glows for no reason. Scaled into render-linear.
  //
  // Both ends of this ramp are warmer than a physical horizon would be. That
  // is the point: aerial perspective is the game's depth cue, and a haze that
  // is merely pale grey-blue desaturates the distance without *colouring* it,
  // which reads as fog rather than as distance.
  if (alt < 0) mixColor(s.hazeColor, 0x0a0d16, 0xd08858, clamp01((alt + 0.14) / 0.15));
  else mixColor(s.hazeColor, 0xf09050, 0xa8c4de, dayness);
  s.hazeColor.multiplyScalar(0.14 + dayness * 0.2);
  // Thicker air low in the sky, so distance reads further at dusk. Tuned for a
  // course a kilometre across: ~5% haze at 150 m, ~30% at 400 m, ~85% at 800 m.
  s.fogDensity = 0.0016 + (1 - dayness) * 0.0009;

  // What the sky sees looking down: tarmac and grass, lit by the key.
  //
  // This is far brighter than "a dark floor colour" and it has to be. A
  // vertical mirror facing the camera reflects the *lower* hemisphere, so if
  // this value is dark then every chrome bumper in the game is black — which
  // is exactly what the first test frame showed. Lit grass sits near 0.12
  // render-linear, and so does this.
  mixColor(s.groundBounce, 0x1c222c, 0x77754f, dayness);
  s.groundBounce.multiplyScalar(0.4 + dayness * 1.6);

  // --- Clouds -------------------------------------------------------------
  // The lit/shadow spread here is the entire read of the deck. Too wide and
  // the clouds turn into ink blots with white halos; the pair below lands at
  // roughly 0.78 and 0.40 sRGB after the grade, which is a cumulus base seen
  // from underneath on a bright afternoon.
  mixColor(s.cloudShadow, 0x647291, 0xb4c0d8, 0.25 + dayness * 0.45);
  s.cloudShadow.multiplyScalar(0.3 + dayness * 0.22);
  mixColor(s.cloudLit, 0xb89a92, 0xfff4e4, 0.2 + dayness * 0.7);
  s.cloudLit.multiplyScalar(0.28 + dayness * 0.34);
  mixColor(s.cloudRim, 0xd09058, 0xfff2cc, dayness);
  // Over 1.0 on purpose: the silver lining is the one part of the sky the
  // bloom pass should find all by itself.
  s.cloudRim.multiplyScalar((0.45 + dayness * 0.9) * (1 - night * 0.85));

  return s;
}

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------

/**
 * The scattering kernel, shared verbatim by the visible dome and the cube bake
 * that feeds the PMREM. Sharing it is not a nicety: if the IBL and the sky it
 * is supposedly of disagree even slightly, every reflective surface in the
 * game picks up a horizon that is not there.
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
uniform vec3  uSunDir;
uniform vec3  uBetaR;
uniform vec3  uBetaM;
uniform float uSunE;
uniform float uMieG;
uniform float uSkyExposure;
uniform float uSunAngular;
uniform float uSunDiscPower;
uniform vec3  uSunDiscColor;
uniform vec3  uGroundColor;
uniform vec3  uHazeColor;
uniform float uNight;
uniform float uTime;

const float PI = 3.141592653589793;
const float RAYLEIGH_PHASE_K = 0.0596831036594607; // 3 / (16 PI)
const float RAYLEIGH_ZENITH = 8400.0;
const float MIE_ZENITH = 1250.0;

// x^1.5 as x*sqrt(x). On a software rasteriser pow() is exp2(y*log2(x)) — two
// transcendentals — while sqrt is a single instruction. This file evaluates
// enough 1.5 and 0.5 powers per pixel for that swap to be worth doing by hand.
float pow15(float x) { return x * sqrt(x); }
vec3 pow15(vec3 x) { return x * sqrt(x); }

float miePhase(float cosT, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow15(max(1.0 + g2 - 2.0 * g * cosT, 1e-4)));
}

/** Hashed star field. Only ever evaluated once the sun is actually down. */
float starField(vec3 dir) {
  vec3 p = dir * 260.0;
  vec3 cell = floor(p);
  float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  if (h < 0.9958) return 0.0;
  vec3 f = fract(p) - 0.5;
  float twinkle = 0.6 + 0.4 * sin(uTime * (1.2 + h * 8.0) + h * 90.0);
  return smoothstep(0.34, 0.0, length(f)) * twinkle * (h - 0.9958) / 0.0042;
}

/** Radiance looking along 'dir', in render-linear units. Caller tone-maps. */
vec3 atmosphere(vec3 dir) {
  // Relative air mass. The empirical tail keeps the horizon finite instead of
  // dividing by zero, and it is what reddens a low sun properly.
  float upness = clamp(dir.y, -0.08, 1.0);
  float zenith = acos(clamp(upness, -1.0, 1.0));
  // cos(acos(x)) is x — the angle is only needed for the empirical tail.
  float airMass = 1.0 / (upness + 0.15 * pow(max(93.885 - degrees(zenith), 0.001), -1.253));

  vec3 extinction = exp(-(uBetaR * RAYLEIGH_ZENITH + uBetaM * MIE_ZENITH) * airMass);

  float cosT = dot(dir, uSunDir);
  vec3 numer = uBetaR * (RAYLEIGH_PHASE_K * (1.0 + cosT * cosT)) + uBetaM * miePhase(cosT, uMieG);
  vec3 betaTotal = numer / max(uBetaR + uBetaM, vec3(1e-9));

  vec3 inscatter = pow15(max(uSunE * betaTotal * (1.0 - extinction), vec3(0.0)));
  // Preetham's own correction: the 1.5 exponent is right overhead and far too
  // dark at grazing angles, so it is walked back as the sun nears the horizon.
  // This one line is the difference between a sunset and a mud slick.
  float grazing = clamp(pow(1.0 - max(uSunDir.y, 0.0), 5.0), 0.0, 1.0);
  inscatter *= mix(vec3(1.0), sqrt(max(uSunE * betaTotal * extinction, vec3(0.0))), grazing);

  // Two-lobe aureole: a tight core for the lens flare, a wide skirt for the
  // aerosol glow the god-ray pass smears into the scene. Both lobes are pushed
  // well past physical truth — the skirt is multiplied by the same extinction
  // as the disc, so it arrives already reddened, and it is the thing that puts
  // gold in the sky around the sun instead of the white a correct Preetham
  // aureole would give at this elevation.
  float sunward = max(cosT, 0.0);
  float aureole = pow(sunward, 400.0) * 1.3 + pow(sunward, 22.0) * 0.22;

  // The disc. Small-angle form of acos(cosT): acos itself loses every bit of
  // precision it has within half a degree of the sun, which is exactly where
  // the disc lives, and on a software rasteriser that shows as a torn edge.
  //
  // Branched, because the disc occupies a few thousand of two million pixels
  // and its limb-darkening pow is pure waste everywhere else.
  float discTerm = 0.0;
  float e = sqrt(2.0 * max(0.0, 1.0 - cosT)) / uSunAngular;
  if (e < 1.05) {
    float limb = sqrt(max(1.0 - e * e, 0.0));
    discTerm = (1.0 - smoothstep(0.88, 1.02, e)) * (0.32 + 0.68 * pow(limb, 0.45));
  }

  vec3 col = inscatter * uSkyExposure
           + uSunDiscColor * (discTerm * uSunDiscPower + aureole) * extinction;

  // Ground half of the dome carries the bounce colour, so reflective surfaces
  // pick up a floor instead of a black void.
  col = mix(col, uGroundColor, smoothstep(0.02, -0.09, dir.y));

  // The haze band. Identical colour to scene fog, so the point where distant
  // geometry dissolves into sky is invisible — the cheapest depth cue there is.
  // The band is wide with a long power tail rather than a smoothstep: a
  // smoothstep terminates, and a terminating haze band reads as a painted
  // stripe across the sky.
  float band = pow(1.0 - smoothstep(0.0, 0.42, abs(dir.y)), 1.7);
  col = mix(col, uHazeColor, band * 0.78);

  if (uNight > 0.004) {
    vec3 nightCol = vec3(0.0035, 0.0055, 0.0125)
                  + vec3(0.85, 0.9, 1.0) * starField(dir) * (1.0 - band);
    col = mix(col, nightCol + col * 0.2, uNight);
  }

  return max(col, vec3(0.0));
}
`;

/** Uniform block shared by the dome and the bake; filled by `applyAtmosphere`. */
export function makeAtmosphereUniforms(): Record<string, THREE.IUniform> {
  return {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uBetaR: { value: new THREE.Vector3() },
    uBetaM: { value: new THREE.Vector3() },
    uSunE: { value: SOLAR_CONSTANT },
    uMieG: { value: 0.79 },
    uSkyExposure: { value: SKY_EXPOSURE },
    // Angular *radius*: 1.1°, so a 2.2° disc against a real sun's 0.53°. A
    // life-size sun is twelve pixels across at 1080p and reads as a dead
    // pixel rather than a star; every game in the genre cheats this.
    uSunAngular: { value: 0.019 },
    uSunDiscPower: { value: 12 },
    uSunDiscColor: { value: new THREE.Color(0xfff2dc) },
    uGroundColor: { value: new THREE.Color(0x0a0b0c) },
    uHazeColor: { value: new THREE.Color(0x2a1e18) },
    uNight: { value: 0 },
    uTime: { value: 0 },
  };
}

/** Push an `AtmosphereState` into a uniform block built above. */
export function applyAtmosphere(uniforms: Record<string, THREE.IUniform>, s: AtmosphereState): void {
  (uniforms.uSunDir.value as THREE.Vector3).copy(s.direction);
  (uniforms.uBetaR.value as THREE.Vector3).copy(s.betaR);
  (uniforms.uBetaM.value as THREE.Vector3).copy(s.betaM);
  uniforms.uSunE.value = s.sunE;
  uniforms.uMieG.value = s.mieG;
  uniforms.uSunDiscPower.value = s.discPower;
  (uniforms.uSunDiscColor.value as THREE.Color).copy(s.discColor);
  (uniforms.uGroundColor.value as THREE.Color).copy(s.groundBounce);
  (uniforms.uHazeColor.value as THREE.Color).copy(s.hazeColor);
  uniforms.uNight.value = s.night;
}
