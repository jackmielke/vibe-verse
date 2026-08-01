/**
 * Image-based lighting — a PMREM cooked from the very sky the player is
 * looking at.
 *
 * Every metallic bumper, every glossy shell, every wet patch of tarmac in the
 * game gets its reflection from this one texture. Baking it from a *shared*
 * sky shader rather than from a hand-picked gradient is what keeps the world
 * coherent: move the sun and the chrome moves with it, for free, everywhere.
 *
 * The bake scene is the dome alone. Its lower hemisphere already fades to the
 * ground-bounce colour, so the irradiance arriving from below is the tarmac
 * and grass rather than a black void — the difference between a kart that sits
 * in the world and one that floats above a hole in it.
 *
 * Everything here is wrapped: PMREM wants a half-float colour target, and while
 * WebGL2 guarantees RGBA16F is renderable and filterable, a driver is a driver.
 * If the bake throws we hand back `null`, the caller leaves `scene.environment`
 * alone and pushes the ambient into the hemisphere light instead. A missing IBL
 * should cost some sparkle, never the frame.
 */
import * as THREE from "three";

export interface IblBaker {
  /** Latest prefiltered environment map, or null if the bake is unavailable. */
  texture: THREE.Texture | null;
  /** Re-cook from the current state of the sky material. Returns the texture. */
  bake(): THREE.Texture | null;
  dispose(): void;
}

export function createIbl(renderer: THREE.WebGLRenderer, skyProxy: THREE.Mesh): IblBaker {
  const bakeScene = new THREE.Scene();
  bakeScene.add(skyProxy);

  let generator: THREE.PMREMGenerator | null = null;
  let target: THREE.WebGLRenderTarget | null = null;
  let broken = false;

  const api: IblBaker = {
    texture: null,

    bake() {
      if (broken) return null;
      try {
        if (!generator) generator = new THREE.PMREMGenerator(renderer);
        const previous = target;
        // `fromScene` saves and restores tone mapping and the render target
        // itself, and it renders with NoToneMapping — which is exactly right,
        // because an envMap must be linear HDR, not display-referred.
        target = generator.fromScene(bakeScene, 0, 0.5, 6000);
        previous?.dispose();
        api.texture = target.texture;
        return api.texture;
      } catch (err) {
        console.warn("[kart/env] PMREM bake failed; falling back to analytic ambient", err);
        broken = true;
        api.texture = null;
        return null;
      }
    },

    dispose() {
      bakeScene.remove(skyProxy);
      target?.dispose();
      target = null;
      generator?.dispose();
      generator = null;
      api.texture = null;
    },
  };

  return api;
}
