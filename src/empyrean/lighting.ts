/**
 * The sun, the sky light and the day.
 *
 * Two jobs, and they are the same job seen from either end:
 *
 *  1. **The day cycle as light.** One number, `dayPhase` 0..1, and everything
 *     the world is lit by follows from it — where the key comes from, what
 *     colour it is, how hard the sky fills, what the fog is doing, whether the
 *     lamps are on, and what exposure the grade should run at. Every one of
 *     those is a pure function of the phase and is exported as one, so the look
 *     of an hour can be argued about in a test instead of in a screenshot.
 *  2. **The shadows.** One tightly fitted, texel-snapped shadow camera that
 *     follows the player. Why one and not three, at length, below.
 *
 * ## Where the sun is, is not decided here
 *
 * `sky.ts` owns the sun's path and the palette, and this file reads both.
 * That is a deliberate exception to the no-cross-imports rule and the only one
 * worth making: `sunDirFor` and `skyPalette` are pure functions over a number,
 * they drag no scene graph and no GL state behind them, and the alternative is
 * two sun paths that agree on the day somebody wrote them and drift apart on
 * the next edit. A key light two degrees off the sky's blown-out disc is the
 * sort of wrongness nobody can name and everybody can see.
 *
 * So the division is: the sky says *where the sun is and what colour the air
 * is*; this file says *how hard everything shines and what casts what*.
 *
 * ## Two daylights, and they are not the same number
 *
 * `skyPalette().daylight` is 0.32 at the hour this world is painted at. That
 * is correct for what it is for — it is the switch the lamps and the lit
 * windows come on against, and at sunset most of them should be on. It is
 * badly wrong as a grade control: hand it to `postfx.setDaylight` and the
 * image goes to its night tuning at the exact moment the sky is on fire.
 *
 * So there are two. `daylight` is the lamp switch, straight from the palette
 * and shared with everything else that reads the frame context.
 * `gradeDaylight` is 1 whenever there is any sun above the horizon at all,
 * including one sitting on it, and falls to 0 through the twenty minutes after
 * it sets. **`postfx.setDaylight` wants the second one.**
 *
 * It is worth knowing that the same confusion is live elsewhere in the world:
 * `buildings.ts` ends its masonry shader with
 * `col = mix(col * vec3(0.26, 0.28, 0.42), col, uDaylight)` and feeds it the
 * lamp switch, so at the signature hour every facade in the city is multiplied
 * by about 0.48 before the grade ever sees it. That is most of why a shadowed
 * wall reads as a silhouette, and no amount of hemisphere here can reach it.
 *
 * ## One shadow camera, not a cascade
 *
 * A cascade is the right answer in most worlds and the wrong one here, for
 * reasons specific to this place:
 *
 * - **At the signature hour the sun is on the horizon.** A 500 m tower throws
 *   a shadow measured in kilometres. There is no cascade rig — two, three or
 *   eight — that contains that, so the big architectural shadowing at sunset
 *   is not on the table at any price. What *is* on the table is the near
 *   ground: the shadow of a bench, a lamp post, a parapet, a market stall, a
 *   person. That is what ground contact is made of, and it wants resolution,
 *   not extent.
 * - **Blending cascades in three 0.160 means grafting `shadowmap_pars_fragment`
 *   globally.** `THREE.ShaderChunk` is module state shared with forty other
 *   worlds in this repository; a graft here changes /city's lighting too.
 * - **Two shadow-casting directional lights instead** is the graft-free
 *   version and it has a seam: inside the near light's frustum a pixel is
 *   shaded twice, outside it once, so the far shadows come out half as dark
 *   along a hard circle that follows the camera.
 *
 * So: one 2048² map (1024² low) over a ~120 m disc, snapped to its own texel
 * grid so it does not swim as you walk, asymmetric upward so mid-rise blocks
 * get into the frustum, and nothing shadowed past that. The distance is
 * covered by the screen-space AO in `postfx.ts`, which is the pass that
 * actually sells corners and contact, and by aerial perspective, which at
 * 300 m in this fog is doing more than any shadow would.
 *
 * ## The key light at night
 *
 * Below the horizon the sun would light the world from underneath, which reads
 * as a fault rather than as night. The key's *direction* is therefore the
 * sun's with its height clamped to a floor of about three degrees, so it
 * slides along the horizon and never dips under it. Continuous, never
 * degenerate, and what it produces at midnight — a low cold rake across the
 * snow from the sun's azimuth, in the palette's own moon colour — is very
 * close to what a full moon does to a snowfield. The astronomical direction is
 * untouched, so `sky.ts` still puts its disc below the horizon where it
 * belongs.
 */
import * as THREE from "three";
import { skyPalette, sunDirFor, DEFAULT_DAY_PHASE } from "./sky";
import type { BuildContext, FrameContext, System } from "./types";

/** The phase the world opens at, and mostly stays at. */
export const PHASE_SUNSET = DEFAULT_DAY_PHASE;

/* -------------------------------------------------------------------------
 * The look of an hour
 * ---------------------------------------------------------------------- */

/**
 * Everything the rest of the world needs to know about the light, right now.
 *
 * Mutated in place by `dayLook`; never reallocated. Copy anything you keep.
 */
export interface DayLook {
  phase: number;
  /** Astronomical direction toward the sun. Below the horizon at night. */
  sunDir: THREE.Vector3;
  /** Direction the key light actually comes from. Never below ~3°. */
  keyDir: THREE.Vector3;
  /** Sun elevation, radians. Negative below the horizon. */
  elevation: number;
  /** The lamp switch: 0 at midnight, 1 at noon, 0.32 at sunset. */
  daylight: number;
  /** The grade control: 1 whenever the sun is up at all. See the header. */
  gradeDaylight: number;
  /** 1 when every lamp and window in the city should be lit, 0 at noon. */
  lampLevel: number;
  sunColor: THREE.Color;
  sunIntensity: number;
  skyColor: THREE.Color;
  groundColor: THREE.Color;
  hemiIntensity: number;
  rimColor: THREE.Color;
  rimIntensity: number;
  /** For `scene.fog`. The ranges must fade into the sky, not into grey. */
  fogColor: THREE.Color;
  fogDensity: number;
  /** Hand straight to `postfx.setExposure`. */
  exposure: number;
}

interface DayKey {
  /** `sunDir.y` this key is pinned to. */
  y: number;
  sunI: number;
  hemiI: number;
  rim: [number, number, number];
  rimI: number;
  fogD: number;
  exposure: number;
}

/**
 * How hard everything shines, as six heights of the sun.
 *
 * Keyed on the sun's height rather than on the clock, because that is the
 * variable the light actually depends on: it stays true whatever `sky.ts` does
 * to the path, and it eases for free, since a height is already a sine of a
 * time. Colours are not in here — those come from the palette, so that the
 * light on the snow and the sky behind it can never be two different sunsets.
 *
 * The rim is the exception. It is the cold kicker from the anti-sun side and
 * it exists to keep a character from being a black cut-out against a very
 * bright sky, which is a job with no colour in the palette that matches it.
 *
 * ## `hemiI` went up by about 1.7× and that is the point of this table
 *
 * The first pass keyed the sky fill off the key light — 1.75 against a sun of
 * 3.2 at the signature hour, a ratio of 0.55 — and that is backwards for this
 * place. A sun on the horizon is going through forty times the air it goes
 * through at noon; the *dome* is the light source at dusk, and the sun is a
 * warm rim on top of it. So the ratio is now highest at sunset (3.05 against
 * 3.2) and lowest at noon (2.85 against 4.7), which is the shape of the real
 * thing rather than a constant fraction of the key.
 *
 * Driven in a browser, 1.75 put the snowfield's own shading *underneath*
 * `terrain.ts`'s floor of `vec3(0.30, 0.26, 0.38)`, so four kilometres of
 * mountains rendered as one flat lavender plate. At 3.05 the ranges have
 * relief again. Nothing else changed to make that happen.
 *
 * `exposure` came down with it — a table of light this much brighter through
 * an unchanged grade is a blown one — and `fogD` came down too, because the
 * long views were fading into the fog colour a good deal sooner than a
 * beautiful aerial perspective wants to.
 *
 * ## What this table does *not* reach
 *
 * Only `terrain.ts`, the standard-material half of `props.ts`, `vehicles.ts`
 * and the player's own body are lit by these lights. `buildings.ts`,
 * `keel.ts`, `crowd.ts`, `traffic.ts` and `interiors.ts` all build raw
 * `ShaderMaterial`s with `lights: false` and hand-write their own ambient;
 * `streets.ts` takes `getShadowMask()` from the rig here and nothing else.
 * So turning `hemiI` up does not brighten a facade, and if the facades are
 * the thing that is wrong, this is not the file it is wrong in.
 */
const KEYS: DayKey[] = [
  {
    // Deep night. A moon on a snowfield is not black — it is a very blue grey,
    // and a night that renders black is a night nobody looks at twice.
    y: -0.78,
    sunI: 0.45,
    hemiI: 0.9,
    rim: [0.66, 0.80, 1.0],
    rimI: 0.28,
    fogD: 0.00007,
    exposure: 0.94,
  },
  {
    y: -0.20,
    sunI: 0.6,
    hemiI: 1.2,
    rim: [0.66, 0.80, 1.0],
    rimI: 0.3,
    fogD: 0.00008,
    exposure: 0.82,
  },
  {
    // Civil twilight: the sun is gone and everything is lit by the band of sky
    // it is behind.
    y: -0.02,
    sunI: 2.1,
    hemiI: 2.45,
    rim: [0.70, 0.84, 1.0],
    rimI: 0.62,
    fogD: 0.000095,
    exposure: 0.56,
  },
  {
    // The hour. Everything else in this table exists so that this one is not
    // the only one that works.
    y: 0.10,
    sunI: 3.2,
    hemiI: 3.05,
    rim: [0.72, 0.86, 1.0],
    rimI: 0.85,
    fogD: 0.0001,
    exposure: 0.52,
  },
  {
    y: 0.35,
    sunI: 4.1,
    hemiI: 3.0,
    rim: [0.74, 0.88, 1.0],
    rimI: 0.6,
    fogD: 0.000095,
    exposure: 0.52,
  },
  {
    y: 0.78,
    sunI: 4.7,
    hemiI: 2.85,
    rim: [0.74, 0.88, 1.0],
    rimI: 0.45,
    fogD: 0.00009,
    exposure: 0.5,
  },
];

/** A fresh, zeroed `DayLook`. Allocate one and reuse it; `dayLook` mutates. */
export function makeDayLook(): DayLook {
  return {
    phase: 0,
    sunDir: new THREE.Vector3(),
    keyDir: new THREE.Vector3(),
    elevation: 0,
    daylight: 0,
    gradeDaylight: 0,
    lampLevel: 0,
    sunColor: new THREE.Color(),
    sunIntensity: 0,
    skyColor: new THREE.Color(),
    groundColor: new THREE.Color(),
    hemiIntensity: 0,
    rimColor: new THREE.Color(),
    rimIntensity: 0,
    fogColor: new THREE.Color(),
    fogDensity: 0,
    exposure: 1,
  };
}

/** The `sunDir.y` the key light is never allowed below. About three degrees. */
const KEY_HEIGHT_FLOOR = 0.055;

/**
 * What the snow and the ice bounce back up. Cold, and never neutral.
 *
 * Brighter than it looks like it should be, and mixed less far into the fog
 * colour than it was (0.42, from 0.5), because a hemisphere light's ground
 * half is the *only* fill a vertical surface gets from below — the sky half
 * is weighted out of it at `n.y = 0`. A dark ground colour is therefore a
 * dark wall, and this city is standing on pale stone over a frozen lake.
 */
const GROUND_VIOLET = /*@__PURE__*/ new THREE.Color().setRGB(0.42, 0.36, 0.55, THREE.SRGBColorSpace);

/**
 * Everything about the light at `dayPhase` p.
 *
 * Pure apart from `skyPalette`'s shared scratch object, which it reads and
 * copies out of before returning. Allocation-free when handed an `out`.
 */
export function dayLook(p: number, out: DayLook = makeDayLook()): DayLook {
  out.phase = ((p % 1) + 1) % 1;
  sunDirFor(out.phase, out.sunDir);
  const y = out.sunDir.y;
  out.elevation = Math.asin(THREE.MathUtils.clamp(y, -1, 1));

  const pal = skyPalette(out.phase);
  out.daylight = pal.daylight;
  // 1 while the sun is up at all, including sitting on the horizon; it is the
  // twenty minutes *after* that which turn the grade over to its night tuning.
  out.gradeDaylight = THREE.MathUtils.smoothstep(y, -0.22, -0.02);
  out.lampLevel = 1 - THREE.MathUtils.smoothstep(pal.daylight, 0.1, 0.75);

  // The key never dips below the horizon; see the header.
  out.keyDir.set(out.sunDir.x, Math.max(y, KEY_HEIGHT_FLOOR), out.sunDir.z).normalize();

  /* The disc's own colour is the key light's colour, by construction rather
   * than by matching: gold at sunset, white at noon, a pale blue at midnight
   * because that keyframe is the moon. */
  out.sunColor.copy(pal.sun);

  /* The sky fill. A hemisphere light's upper colour stands for the whole dome
   * above the horizon, and at sunset that dome is overwhelmingly the burning
   * band low down rather than the navy at the zenith — so it is weighted
   * toward the warm stops, not averaged over all of them. Getting this wrong
   * puts a blue cast on every upward-facing surface in a city that is on fire.
   */
  out.skyColor.copy(pal.gold).lerp(pal.rose, 0.4).lerp(pal.blue, 0.3);
  out.groundColor.copy(pal.fog).lerp(GROUND_VIOLET, 0.42);
  out.fogColor.copy(pal.fog);

  let i = 0;
  while (i < KEYS.length - 2 && y > KEYS[i + 1].y) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const t = THREE.MathUtils.clamp((y - a.y) / (b.y - a.y), 0, 1);

  out.rimColor.setRGB(
    a.rim[0] + (b.rim[0] - a.rim[0]) * t,
    a.rim[1] + (b.rim[1] - a.rim[1]) * t,
    a.rim[2] + (b.rim[2] - a.rim[2]) * t,
    THREE.SRGBColorSpace,
  );
  out.sunIntensity = a.sunI + (b.sunI - a.sunI) * t;
  out.hemiIntensity = a.hemiI + (b.hemiI - a.hemiI) * t;
  out.rimIntensity = a.rimI + (b.rimI - a.rimI) * t;
  out.fogDensity = a.fogD + (b.fogD - a.fogD) * t;
  out.exposure = a.exposure + (b.exposure - a.exposure) * t;
  return out;
}

/** Unit vector toward the sun at `dayPhase` p. `sky.ts` decides the path. */
export function sunDirection(p: number, out = new THREE.Vector3()): THREE.Vector3 {
  return sunDirFor(p, out);
}

/** The lamp switch: 0 at midnight, 1 at noon. */
export function daylightAt(p: number): number {
  return skyPalette(p).daylight;
}

/* -------------------------------------------------------------------------
 * Shadows
 * ---------------------------------------------------------------------- */

/** What a fit produced, for a test to look at. */
export interface ShadowFit {
  /** Centre of the covered disc, after texel snapping. */
  center: THREE.Vector3;
  radius: number;
  left: number;
  right: number;
  bottom: number;
  top: number;
  near: number;
  far: number;
  /** Metres per shadow-map texel, across and up. */
  texel: THREE.Vector2;
}

const UP = /*@__PURE__*/ new THREE.Vector3(0, 1, 0);
const UP_ALT = /*@__PURE__*/ new THREE.Vector3(0, 0, 1);
const _lx = new THREE.Vector3();
const _ly = new THREE.Vector3();
const _lz = new THREE.Vector3();
const _snap = new THREE.Vector3();

/**
 * Point a directional light's shadow camera at a disc of world, snapped to its
 * own texel grid.
 *
 * The snap is the difference between shadows that sit still while you walk and
 * shadows that crawl along every edge in the frame. It works because three
 * builds the shadow camera's basis with exactly this `lookAt` — z toward the
 * light, x = up × z — so quantising the centre in that basis quantises the
 * projection.
 *
 * `casterHeight` is how far the frustum reaches *above* the disc, and is the
 * one asymmetry: a low sun rakes almost horizontally, so a parapet forty
 * metres up and a hundred out is a caster into ground you are looking at, and
 * a symmetric box would have cropped it out.
 */
export function fitShadowCamera(
  light: THREE.DirectionalLight,
  keyDir: THREE.Vector3,
  center: THREE.Vector3,
  radius: number,
  casterHeight = 120,
): ShadowFit {
  const cam = light.shadow.camera;
  const mapSize = Math.max(1, light.shadow.mapSize.x);

  _lz.copy(keyDir);
  if (!Number.isFinite(_lz.lengthSq()) || _lz.lengthSq() < 1e-8) _lz.set(0, 1, 0);
  _lz.normalize();
  const upRef = Math.abs(_lz.y) > 0.999 ? UP_ALT : UP;
  _lx.crossVectors(upRef, _lz).normalize();
  _ly.crossVectors(_lz, _lx).normalize();

  const top = radius + casterHeight;
  const texelX = (2 * radius) / mapSize;
  const texelY = (top + radius) / mapSize;

  const cx = Math.round(center.dot(_lx) / texelX) * texelX;
  const cy = Math.round(center.dot(_ly) / texelY) * texelY;
  // Depth along the light is quantised too. It does not move the projection —
  // an ortho slides along its own axis for free — but it does move every depth
  // the map stores, and a bias sitting one part in a thousand from acne is a
  // bias that flickers.
  const cz = Math.round(center.dot(_lz) / texelY) * texelY;
  _snap.set(0, 0, 0).addScaledVector(_lx, cx).addScaledVector(_ly, cy).addScaledVector(_lz, cz);

  // Far enough back that everything sunward of the disc which could reach into
  // it is in front of the near plane. An ortho projection's depth is linear,
  // so a wide range costs precision nobody can see.
  const dist = radius + casterHeight + 900;
  light.position.copy(_snap).addScaledVector(_lz, dist);
  light.target.position.copy(_snap);
  light.target.updateMatrixWorld();

  cam.left = -radius;
  cam.right = radius;
  cam.bottom = -radius;
  cam.top = top;
  cam.near = 1;
  cam.far = dist + radius + 400;
  cam.updateProjectionMatrix();

  // Slope-scaled by hand: the acne a sun on the horizon produces on a flat
  // deck is worth several texels, and normal bias is the only one of the two
  // that does not detach a shadow from the thing casting it.
  light.shadow.normalBias = Math.max(0.02, texelY * 2.4);
  light.shadow.bias = -0.15 / (cam.far - cam.near);

  return {
    center: _snap.clone(),
    radius,
    left: cam.left,
    right: cam.right,
    bottom: cam.bottom,
    top: cam.top,
    near: cam.near,
    far: cam.far,
    texel: new THREE.Vector2(texelX, texelY),
  };
}

/**
 * Turn shadow casting on (or off) across a subtree.
 *
 * The heuristic is deliberately blunt and documented rather than clever:
 * anything that draws opaquely casts and receives; anything that does not
 * write depth — the sky dome, the plume, the glow cards — is skipped, because
 * a shadow cast by an additive sprite is a black rectangle.
 *
 * **Do not turn it on for the mirrored clone.** `terrain.mirror` is scaled −1
 * on Y, which reverses its winding; its shadows are inside out and land in the
 * sky. Call this on the real city, and call it with `false` on the mirror,
 * because `clone(true)` will have copied the flags across.
 */
export function setShadowFlags(root: THREE.Object3D, enabled: boolean): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (!enabled) {
      m.castShadow = false;
      m.receiveShadow = false;
      return;
    }
    const mat = m.material as THREE.Material | THREE.Material[];
    const one = Array.isArray(mat) ? mat[0] : mat;
    const drawsDepth = !!one && one.depthWrite !== false;
    m.castShadow = drawsDepth;
    m.receiveShadow = drawsDepth;
  });
}

/* -------------------------------------------------------------------------
 * The system
 * ---------------------------------------------------------------------- */

export interface LightingHandle extends System {
  sun: THREE.DirectionalLight;
  /** Fitted to the view each frame. */
  shadowsFor(camera: THREE.PerspectiveCamera, focus: THREE.Vector3): void;
  /** Given 0..1 through the day, everything else follows. */
  setDayPhase(p: number): void;
  readonly sunDir: THREE.Vector3;
  readonly daylight: number;

  /* --- the rest of what a world needs, past the required four ----------- */

  /** The sky fill. Two colours, and both of them are the sky. */
  hemi: THREE.HemisphereLight;
  /** The cold kicker from the anti-sun side. Without it a body is a cut-out. */
  rim: THREE.DirectionalLight;
  /** Live, mutated in place, never reallocated. Read it; do not keep it. */
  readonly look: DayLook;
  /** Current key-light colour, linear working space. */
  readonly sunColor: THREE.Color;
  /** 1 when every window in the city should be lit, 0 at noon. */
  readonly lampLevel: number;
  /** What `postfx.setDaylight` wants. Not the same as `daylight`. */
  readonly gradeDaylight: number;
  /** What `postfx.setExposure` should be holding. */
  readonly exposure: number;
  /** Metres of world the shadow map covers, as a radius. */
  setShadowRadius(m: number): void;
  setShadowsEnabled(on: boolean): void;
  readonly shadowsEnabled: boolean;
}

const _focusAhead = new THREE.Vector3();
const _camFwd = new THREE.Vector3();

export function buildLighting(ctx: BuildContext, renderer: THREE.WebGLRenderer): LightingHandle {
  const high = ctx.quality === "high";
  const group = new THREE.Group();
  group.name = "empyrean-lighting";

  const look = dayLook(PHASE_SUNSET);

  /* ---- the key -------------------------------------------------------- */
  const sun = new THREE.DirectionalLight(0xffffff, look.sunIntensity);
  sun.name = "empyrean-sun";
  sun.color.copy(look.sunColor);
  sun.castShadow = true;
  sun.shadow.mapSize.set(high ? 2048 : 1024, high ? 2048 : 1024);
  // The radius is in texels and only does anything for the PCF types, which is
  // what we ask the renderer for below.
  sun.shadow.radius = high ? 2.2 : 1.4;
  sun.shadow.blurSamples = high ? 12 : 6;
  group.add(sun);
  group.add(sun.target);

  /* ---- the sky -------------------------------------------------------- */
  const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, look.hemiIntensity);
  hemi.name = "empyrean-skyfill";
  hemi.color.copy(look.skyColor);
  hemi.groundColor.copy(look.groundColor);
  group.add(hemi);

  /* ---- the kicker ------------------------------------------------------ */
  const rim = new THREE.DirectionalLight(0xffffff, look.rimIntensity);
  rim.name = "empyrean-rim";
  rim.color.copy(look.rimColor);
  group.add(rim);
  group.add(rim.target);

  let shadowRadius = high ? 120 : 90;
  let shadowsOn = true;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = high ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = true;

  const applyLook = () => {
    sun.color.copy(look.sunColor);
    sun.intensity = look.sunIntensity;
    hemi.color.copy(look.skyColor);
    hemi.groundColor.copy(look.groundColor);
    hemi.intensity = look.hemiIntensity;
    /* Point the key, whether or not it is casting. `shadowsFor` overrides
     * both of these every frame when shadows are on — but with them off it is
     * never called, and a sun frozen at the hour the world was built is a
     * whole day cycle that lights nothing. */
    sun.position.copy(look.keyDir).multiplyScalar(3000);
    sun.target.position.set(0, 0, 0);
    sun.target.updateMatrixWorld();
    rim.color.copy(look.rimColor);
    rim.intensity = look.rimIntensity;
    // Opposite the key in plan, lifted, and it never casts: it is a fill, and
    // a fill that casts is a fill you can see.
    rim.position.set(-look.keyDir.x, 0.42, -look.keyDir.z).normalize().multiplyScalar(1200);
    rim.target.position.set(0, 0, 0);
    rim.target.updateMatrixWorld();
  };

  const shadowsFor = (camera: THREE.PerspectiveCamera, focus: THREE.Vector3) => {
    if (!shadowsOn) return;
    // Bias the covered disc toward where the player is looking: two thirds of
    // it in front of them is worth more than a ring of shadow behind their
    // head.
    camera.getWorldDirection(_camFwd);
    _camFwd.y = 0;
    if (_camFwd.lengthSq() < 1e-6) _camFwd.set(0, 0, -1);
    _camFwd.normalize();
    _focusAhead.copy(focus).addScaledVector(_camFwd, shadowRadius * 0.42);
    fitShadowCamera(sun, look.keyDir, _focusAhead, shadowRadius);
  };

  const setDayPhase = (p: number) => {
    dayLook(p, look);
    applyLook();
  };

  applyLook();
  // Somewhere sane before the first `shadowsFor`, so a frame drawn before the
  // loop starts is not lit from inside the rock.
  fitShadowCamera(sun, look.keyDir, new THREE.Vector3(0, 620, 0), shadowRadius);

  const handle: LightingHandle = {
    name: "lighting",
    group,
    sun,
    hemi,
    rim,
    look,
    get sunDir() {
      return look.sunDir;
    },
    get daylight() {
      return look.daylight;
    },
    get gradeDaylight() {
      return look.gradeDaylight;
    },
    get sunColor() {
      return look.sunColor;
    },
    get lampLevel() {
      return look.lampLevel;
    },
    get exposure() {
      return look.exposure;
    },
    get shadowsEnabled() {
      return shadowsOn;
    },
    setDayPhase,
    shadowsFor,
    setShadowRadius(m) {
      shadowRadius = Math.max(8, m);
    },
    setShadowsEnabled(on) {
      shadowsOn = on;
      sun.castShadow = on;
    },
    update(frame: FrameContext) {
      setDayPhase(frame.dayPhase);
      // Lighting is the authority on these two. The frame context is mutated
      // in place by design, and every system downstream — lamps, windows, the
      // grade — reads them from here rather than each keeping a day cycle of
      // its own and disagreeing with this one.
      frame.sunDir.copy(look.sunDir);
      frame.daylight = look.daylight;
      shadowsFor(frame.camera, frame.player ? frame.player.position : frame.camera.position);
    },
    dispose() {
      sun.shadow.dispose();
      sun.dispose();
      hemi.dispose();
      rim.dispose();
      group.clear();
    },
  };

  return handle;
}
