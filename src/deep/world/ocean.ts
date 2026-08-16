/**
 * The Midnight Zone — the water.
 *
 * This system is most of the look, and it is almost all one idea: **the fog
 * colour, the clear colour and the ambient light are the same value, and that
 * value is a function of depth.** Get that right and the descent reads without
 * a single extra asset. Get it wrong — a fixed background behind a coloured
 * fog — and you draw a hard horizon at the draw distance and the ocean becomes
 * a room.
 *
 * On top of that it owns three things you only see near the top:
 *
 * · **The surface**, from below: a wide plane with a scrolling normal-ish
 *   ripple, lit from above, that recedes into fog by about 120 m. It exists so
 *   the first thing you do — look up — is rewarded.
 * · **Shafts**, the crepuscular rays punching down through it. Additive cones,
 *   faded out entirely by 400 m, because sunbeams at a kilometre would be a
 *   lie about the thing this world is *about*.
 * · **The sun disc's smear**, refracted, as a soft billboard above.
 *
 * Everything here fades on a curve driven by `waterAt`, so nothing pops.
 */
import * as THREE from "three";
import { depthOf, waterAt, type DeepCtx, type System } from "../types";

/** Below this the shafts are gone entirely and we stop paying for them. */
const SHAFT_CUTOFF = 420;

/** Vertex-coloured cone, wide at the surface, faded to nothing at the tip. */
function makeShaft(rng: () => number): THREE.Mesh {
  const height = 260 + rng() * 220;
  const radius = 5 + rng() * 12;
  const geo = new THREE.CylinderGeometry(radius * 0.35, radius, height, 7, 1, true);
  // Fade along the shaft's own length by baking alpha into vertex colours: one
  // material, no texture, and the falloff is exactly where we want it.
  const colors: number[] = [];
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = (y + height / 2) / height; // 0 at the tip, 1 at the surface
    const a = Math.pow(t, 1.7);
    colors.push(a, a, a);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({
    color: 0xbdf3ff,
    vertexColors: true,
    transparent: true,
    opacity: 0.07,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -height / 2;
  return mesh;
}

export default function createOcean(ctx: DeepCtx): System {
  const group = new THREE.Group();
  group.name = "ocean";
  ctx.scene.add(group);

  // -- light ----------------------------------------------------------------
  // Two lights and no more. Ambient is the water itself; the directional is
  // the sun, and it dies with the sunlight zone. Everything below 1000 m is
  // lit exclusively by things that chose to glow.
  const ambient = new THREE.AmbientLight(0x2fb6c8, 1.1);
  const sun = new THREE.DirectionalLight(0xcdf6ff, 1.5);
  sun.position.set(30, 120, 20);
  ctx.scene.add(ambient, sun);

  // -- the surface, from underneath ----------------------------------------
  const surfGeo = new THREE.PlaneGeometry(2600, 2600, 28, 28);
  surfGeo.rotateX(Math.PI / 2);
  const surfBase = (surfGeo.attributes.position as THREE.BufferAttribute).clone();
  const surfMat = new THREE.MeshStandardMaterial({
    color: 0x8fe6ff,
    roughness: 0.12,
    metalness: 0.6,
    transparent: true,
    opacity: 0.55,
    side: THREE.BackSide,
    fog: true,
  });
  const surface = new THREE.Mesh(surfGeo, surfMat);
  surface.position.y = 0.6;
  group.add(surface);

  // The sun seen through the chop: a soft disc that never resolves.
  const glowTex = makeGlowTexture();
  const sunGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    }),
  );
  sunGlow.scale.set(180, 180, 1);
  sunGlow.position.set(70, -1.5, 40);
  group.add(sunGlow);

  // -- shafts ---------------------------------------------------------------
  const shaftCount = ctx.quality === "low" ? 7 : ctx.quality === "medium" ? 12 : 20;
  const shafts = new THREE.Group();
  for (let i = 0; i < shaftCount; i++) {
    const s = makeShaft(ctx.rng);
    const a = ctx.rng() * Math.PI * 2;
    const r = 20 + ctx.rng() * 260;
    s.position.x = Math.cos(a) * r;
    s.position.z = Math.sin(a) * r;
    // Lean them all the same way — they are all cast by one sun.
    s.rotation.z = -0.12 + ctx.rng() * 0.05;
    s.rotation.x = 0.06 - ctx.rng() * 0.12;
    shafts.add(s);
  }
  group.add(shafts);

  let surfTick = 0;
  const color = new THREE.Color();
  /** What the ambient tends toward once the sun is gone. See the update loop. */
  const ABYSS_AMBIENT = new THREE.Color(0x24506e);
  const fog = ctx.scene.fog as THREE.FogExp2;
  const bg = ctx.scene.background as THREE.Color;

  return {
    update(dt) {
      const camY = ctx.camera.position.y;
      const depth = depthOf(camY);
      const { color: hex, density, sun: sunAmount } = waterAt(depth);

      // The one line that carries the whole descent.
      color.setHex(hex);
      fog.color.copy(color);
      fog.density = density;
      bg.copy(color);

      // Ambient tracks the water but never reaches zero, and the colour it
      // settles to at depth is *not* the near-black water colour — a light of
      // colour 0x000308 is not a light. It is a cold blue at a low intensity,
      // which is what keeps a shape readable as a shape in the abyss rather
      // than as an absence, and an absence reads as a bug rather than as dark.
      ambient.color.copy(color).lerp(ABYSS_AMBIENT, 1 - sunAmount);
      ambient.intensity = 0.3 + sunAmount * 0.85;
      sun.intensity = sunAmount * 1.5;
      sun.visible = sunAmount > 0.01;

      // The sky follows you down so the surface stays overhead rather than
      // sliding off into the corner of the frame as you travel.
      group.position.x = ctx.camera.position.x;
      group.position.z = ctx.camera.position.z;

      const nearSurface = depth < SHAFT_CUTOFF;
      shafts.visible = nearSurface;
      surface.visible = depth < 340;
      sunGlow.visible = depth < 300;

      if (nearSurface) {
        const fade = Math.pow(1 - depth / SHAFT_CUTOFF, 1.4);
        for (const s of shafts.children) {
          const m = (s as THREE.Mesh).material as THREE.MeshBasicMaterial;
          // Breathe, slightly out of phase per shaft, the way real ones do as
          // the swell passes overhead.
          m.opacity = fade * (0.05 + 0.035 * (0.5 + 0.5 * Math.sin(ctx.elapsed * 0.6 + s.position.x)));
        }
      }

      if (surface.visible) {
        surfMat.opacity = 0.55 * Math.max(0, 1 - depth / 340);
        // Swell: two crossing sine trains, which is enough to stop it reading
        // as a grid without paying for a real water sim in a game where you
        // are looking at it for ninety seconds.
        const p = surfGeo.attributes.position as THREE.BufferAttribute;
        const t = ctx.elapsed;
        for (let i = 0; i < p.count; i++) {
          const x = surfBase.getX(i);
          const z = surfBase.getZ(i);
          p.setY(i, Math.sin(x * 0.045 + t * 0.9) * 1.5 + Math.sin(z * 0.031 - t * 0.7) * 1.2);
        }
        p.needsUpdate = true;
        // Recomputing normals over the whole swell every frame was, measurably,
        // the most expensive thing in the world — and it is a specular
        // highlight on water you look at for ninety seconds. Every third frame
        // is indistinguishable and roughly three times cheaper.
        if (++surfTick % 3 === 0) surfGeo.computeVertexNormals();
      }

      void dt;
    },

    dispose() {
      ctx.scene.remove(group, ambient, sun);
      surfGeo.dispose();
      surfMat.dispose();
      glowTex.dispose();
      sunGlow.material.dispose();
      for (const s of shafts.children) {
        const m = s as THREE.Mesh;
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    },
  };
}

/** A radial falloff, drawn once into a canvas. Used for the sun and for eyes. */
export function makeGlowTexture(inner = "rgba(255,255,255,1)", outer = "rgba(255,255,255,0)"): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.35, "rgba(255,255,255,0.42)");
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
