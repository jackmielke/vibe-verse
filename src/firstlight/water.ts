/**
 * The lake.
 *
 * Built on three's `Water`, which renders a real reflection and refraction pass
 * rather than faking either. That matters more at dawn than it would at noon:
 * almost everything you read as "water" in this scene is the inverted hillside
 * and the orange band of sky lying on it, and a cube-map or a flat fresnel tint
 * cannot produce a reflection that moves correctly when *you* move.
 *
 * ## Why it is quiet
 *
 * `distortionScale` is 2.1 here against the 3.7 the three example ships with.
 * The example is an ocean. This is a lake at first light, and the giveaway that
 * a body of water is fake is almost always that it is too *busy* — a still lake
 * has ripples measured in centimetres, and a reflection that survives them. Set
 * the distortion high and the reflection breaks up into glitter, which reads as
 * choppy sea no matter what else you do.
 *
 * ## `size`, which is not optional
 *
 * `Water` samples its normal map at `worldPosition.xz * size`, and the shader
 * then divides by 103 for its finest octave. At the default `size: 1` that is
 * one ripple every hundred metres — across a lake this size, three of them.
 * The near water came out as a flat pink smear with no surface at all, which
 * looked like a lighting problem and was a texture-coordinate problem. At 18
 * the finest octave lands around five metres and the broad swell around fifty,
 * which is the spread a still lake actually has.
 */
import * as THREE from "three";
import { Water } from "three/examples/jsm/objects/Water.js";
import { tilingNormalMap } from "./textures";
import { WORLD_SIZE, WATER_LEVEL } from "./terrain";

export interface Lake {
  mesh: Water;
  update(dt: number, sunDirection: THREE.Vector3, sunColor: THREE.Color): void;
  setReflections(on: boolean): void;
  dispose(): void;
}

export function createLake(opts: { reflectionSize: number; fog: boolean }): Lake {
  const normals = tilingNormalMap(
    512,
    [
      { period: 4, amp: 1 },
      { period: 8, amp: 0.5 },
      { period: 16, amp: 0.25 },
      { period: 32, amp: 0.12 },
    ],
    4242,
    2.6,
  );
  normals.repeat.set(1, 1);

  /* Generously larger than the basin so the water runs past the hills to the
     horizon. A water plane that stops short of the skyline leaves a hard edge
     where the lake ends and the sky begins, and nothing says "flat plane in a
     3-D scene" faster. */
  const geo = new THREE.PlaneGeometry(WORLD_SIZE * 6, WORLD_SIZE * 6);

  /* A reflection target of 0 would break Water, which always allocates one.
     Reflections off is expressed as the smallest useful target instead, and the
     low tier simply gets a blurry mirror rather than none — a lake with no
     reflection at all looks like tarmac. */
  const size = opts.reflectionSize > 0 ? opts.reflectionSize : 128;

  const water = new Water(geo, {
    textureWidth: size,
    textureHeight: size,
    waterNormals: normals,
    sunDirection: new THREE.Vector3(0, 1, 0),
    sunColor: 0xffffff,
    /* Deep and green-black, the colour of a lake over silt rather than the
       tropical blue the example uses. Most of what you see is reflection, so
       this only shows where the fresnel is weakest — looking straight down. */
    waterColor: 0x080f12,
    distortionScale: 2.1,
    fog: opts.fog,
    alpha: 1,
  });
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_LEVEL;
  water.matrixAutoUpdate = false;
  water.updateMatrix();
  /* The reflection pass renders the scene again. It must not also try to render
     the water, and it must not cast a shadow onto the thing it is reflecting. */
  water.receiveShadow = false;
  water.castShadow = false;

  const uniforms = (water.material as THREE.ShaderMaterial).uniforms;
  /* Set through the uniform, which is the only way that works. `size` looks
     like a constructor option — it sits in Water's uniform block right next to
     `distortionScale` — but Water.js never reads `options.size`, so passing it
     in the literal is silently ignored *and* fails typecheck for good measure.
     Costing one capture to discover, it is written down here so the next person
     does not spend another. */
  uniforms.size.value = 18;
  let enabled = true;

  return {
    mesh: water,
    update(dt, sunDirection, sunColor) {
      /* Slow. The default 1.0/60 per frame is an ocean's pace; a lake at dawn
         moves at about a third of that and the stillness is the point. */
      uniforms.time.value += dt * 0.34;
      uniforms.sunDirection.value.copy(sunDirection).normalize();
      uniforms.sunColor.value.copy(sunColor);
    },
    setReflections(on: boolean) {
      if (on === enabled) return;
      enabled = on;
      /* Killing the distortion is not the same as killing the reflection pass,
         but it is the knob Water exposes, and flattening it is what buys the
         frame time back when the adaptive controller asks. */
      uniforms.distortionScale.value = on ? 2.1 : 0;
    },
    dispose() {
      geo.dispose();
      normals.dispose();
      (water.material as THREE.Material).dispose();
      /* Water allocates its own reflection render target and never frees it.
         The target itself is trapped in the constructor's closure with no
         accessor, but the texture it owns is reachable through the uniform it
         was assigned to, and disposing that is what actually releases the GPU
         allocation. Left alone it is 512² × 4 bytes of VRAM per visit to this
         route — the kind of leak that only shows up on the fifth world somebody
         opens, which is the hardest kind to attribute. */
      const mirror = uniforms.mirrorSampler?.value as THREE.Texture | undefined;
      mirror?.dispose();
    },
  };
}
