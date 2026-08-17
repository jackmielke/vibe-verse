/**
 * The Midnight Zone — the grade.
 *
 * Bloom is not decoration in this world, it is the subject. Bioluminescence is
 * *light seen in darkness*, and light seen in darkness blooms — in a real eye,
 * in a real lens, in the water itself. Rendered without it, an anglerfish's
 * lure is a small yellow circle; rendered with it, it is a lamp.
 *
 * The stack is deliberately three passes and no more, because everything here
 * runs at full resolution over a scene that is already cheap:
 *
 *   render → bloom (selective by luminance) → vignette + grain → screen
 *
 * The vignette is doing real work too: it darkens the frame edges, which is
 * where the fog is thinnest in a perspective projection, and closes the
 * viewport down to something that feels like looking out of a porthole.
 *
 * If any of it fails to construct — an old GPU, a missing extension — the
 * system falls back to rendering the scene directly rather than taking the
 * world down with it. A world with no bloom is disappointing. A black screen
 * is broken.
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { depthOf, type DeepCtx, type SubService, type System } from "../types";

/** Vignette, a touch of grain, and a cold lift in the shadows. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uVignette: { value: 1.0 },
    uGrain: { value: 0.035 },
    /** Rises with depth — the deeper you are, the colder and tighter it gets. */
    uDepth: { value: 0 },
    /** Kicks on hull stress. */
    uStress: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uDepth;
    uniform float uStress;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;

      // Pressure wobble. Only ever visible below crush depth, and it is the
      // only thing in the world that distorts the image — which is what makes
      // it alarming rather than stylish.
      if (uStress > 0.001) {
        uv.x += sin(uv.y * 42.0 + uTime * 9.0) * 0.0022 * uStress;
        uv.y += cos(uv.x * 37.0 + uTime * 7.0) * 0.0018 * uStress;
      }

      vec4 c = texture2D(tDiffuse, uv);

      // Chromatic aberration toward the edges: a thick porthole, not a lens
      // defect. Scaled by depth so the surface looks clean.
      float edge = length(vUv - 0.5);
      float ca = (0.0016 + uDepth * 0.0026) * edge;
      c.r = texture2D(tDiffuse, uv + vec2(ca, 0.0)).r;
      c.b = texture2D(tDiffuse, uv - vec2(ca, 0.0)).b;

      // Vignette, tightening with depth.
      float v = smoothstep(0.92, 0.24, edge * (1.0 + uDepth * 0.5));
      c.rgb *= mix(1.0, v, uVignette);

      // Cold shadows. The deep is not neutral grey, it is blue-black.
      c.rgb = mix(c.rgb, c.rgb * vec3(0.72, 0.9, 1.15), uDepth * 0.55);

      // Sensor grain, stronger in the dark where a real sensor would be
      // pushing its gain up.
      float g = hash(vUv * 900.0 + fract(uTime) * 91.0) - 0.5;
      c.rgb += g * uGrain * (0.35 + uDepth);

      gl_FragColor = c;
    }
  `,
};

export default function createPostFx(ctx: DeepCtx): System {
  const size = new THREE.Vector2(ctx.viewport.width, ctx.viewport.height);
  let composer: EffectComposer | null = null;
  let grade: ShaderPass | null = null;
  let bloom: UnrealBloomPass | null = null;

  try {
    composer = new EffectComposer(ctx.renderer);
    composer.addPass(new RenderPass(ctx.scene, ctx.camera));

    // strength / radius / threshold. The threshold is the important number:
    // high enough that the fog and the hull do not bloom, low enough that
    // every emissive creature does.
    bloom = new UnrealBloomPass(size, 0.85, 0.72, 0.62);
    composer.addPass(bloom);

    grade = new ShaderPass(GradeShader);
    grade.renderToScreen = true;
    composer.addPass(grade);

    ctx.emit("postfx:override", (dt: number) => {
      if (!composer) return;
      composer.render(dt);
    });
  } catch (err) {
    console.error("[The Deep] post-processing failed to build; rendering plain:", err);
    composer = null;
  }

  return {
    update(dt) {
      if (!grade) return;
      const sub = ctx.services.sub as SubService | undefined;
      const depth = sub?.depth ?? depthOf(ctx.camera.position.y);
      // 0 at the surface, 1 by the midnight zone. Everything in the grade is
      // driven off this one number.
      const d = Math.min(1, depth / 1400);
      const u = grade.uniforms;
      u.uTime.value = ctx.elapsed;
      u.uDepth.value += (d - u.uDepth.value) * Math.min(1, dt * 1.6);
      const stress = sub ? Math.max(0, 1 - sub.hull) : 0;
      u.uStress.value += (stress - u.uStress.value) * Math.min(1, dt * 3);

      // Bloom grows as the world darkens: at the surface it would just wash
      // the sunlight out, and at 4 km it is the only thing making the animals
      // read as luminous.
      if (bloom) bloom.strength = 0.55 + d * 0.75;
    },

    resize(width, height) {
      // `composer.setSize` takes CSS pixels and multiplies by the renderer's
      // pixel ratio itself — and it already forwards the *device*-pixel size to
      // every pass it owns. Calling `bloom.setSize` again here re-sized the
      // bloom's internal targets to the unscaled figure, so on any display with
      // a pixel ratio above 1 every window resize or rotation halved the
      // bloom's resolution and mis-registered it against the frame. That is a
      // glitch you cannot see on the machine that renders at 1×, which is
      // exactly the machine this was verified on.
      composer?.setSize(width, height);
    },

    dispose() {
      ctx.emit("postfx:override", null);
      bloom?.dispose();
      composer?.dispose();
      composer = null;
    },
  };
}
