/**
 * What the sky and the post pipeline agree on. The sky decides where the sun
 * is, how thick the air is and how the frame should be exposed; the post
 * pipeline reads that every frame to draw the aerial perspective, the mist
 * and the far shadow tier. Neither module imports the other, and the world
 * assembly does not know this file exists.
 *
 * The world owns the render loop, so anything that has to run once a frame
 * before the scene is drawn (moving the shadow boxes with the eye) registers
 * here and the post pipeline runs it at the top of its render.
 */
import * as THREE from "three";

export type Weather = "sun" | "overcast";

export interface Atmosphere {
  weather: Weather;
  /** Unit vector toward the sun. */
  sunDir: THREE.Vector3;
  /** Linear colour of the light, for the forward-scatter glow in the haze. */
  sunColor: THREE.Color;
  /** Linear colour the distance fades to, before exposure. */
  hazeColor: THREE.Color;
  /** Extinction per metre for the distance haze. */
  hazeDensity: number;
  /** Strength of the brightening toward the sun. */
  hazeGlow: number;
  /** Colour of the low mist, linear, before exposure. */
  mistColor: THREE.Color;
  /** Mist extinction per metre at `mistHeight`; zero switches it off. */
  mistDensity: number;
  /** Altitude (metres) at which the mist has its full density. */
  mistHeight: number;
  /** How fast the mist thins with height, per metre. */
  mistFalloff: number;
  /** How dark a far-tier shadow is, 0 for none, as a fraction of the light. */
  farShadowStrength: number;
  /** The sharp shadow tier that follows the eye. */
  nearLight: THREE.DirectionalLight | null;
  /** The wide shadow tier, sampled by the post pipeline. */
  farLight: THREE.DirectionalLight | null;
  /** Exposure multiplier applied to the linear frame before bloom and tone mapping. */
  exposure: number;
  /** Bloom strength. */
  bloom: number;
  /** Film grain amount. */
  grain: number;
  /** Saturation multiplier after tone mapping. */
  saturation: number;
  /** A tint pulled into the shadows after tone mapping. */
  shadowTint: THREE.Color;
  /** Ambient occlusion strength. */
  ao: number;
}

export const atmosphere: Atmosphere = {
  weather: "sun",
  sunDir: new THREE.Vector3(-0.6, 0.55, 0.58).normalize(),
  sunColor: new THREE.Color(1, 0.93, 0.82),
  hazeColor: new THREE.Color(0.62, 0.7, 0.82),
  hazeDensity: 0.0009,
  hazeGlow: 0.9,
  mistColor: new THREE.Color(0.7, 0.72, 0.74),
  mistDensity: 0,
  mistHeight: 0,
  mistFalloff: 0.08,
  farShadowStrength: 0.7,
  nearLight: null,
  farLight: null,
  exposure: 0.7,
  bloom: 0.3,
  grain: 0.03,
  saturation: 1.0,
  shadowTint: new THREE.Color(0, 0, 0),
  ao: 1,
};

export type FrameHook = (camera: THREE.Camera) => void;
const hooks = new Set<FrameHook>();

/** Run `hook` at the top of every render; returns the function that removes it. */
export function onFrame(hook: FrameHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

export function runFrameHooks(camera: THREE.Camera): void {
  for (const h of hooks) h(camera);
}
