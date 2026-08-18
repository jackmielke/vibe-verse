/**
 * A round, soft-edged white dot, drawn rather than loaded.
 *
 * A `THREE.Points` sprite with no map is a hard square, and a hard square
 * hanging in open water does not read as a drifting particle — it reads as a
 * dead pixel or a missing texture. That is not a subtle failure: in the first
 * capture of the trench the nearest few motes were the most eye-catching thing
 * in the frame, brighter and harder-edged than the diver.
 *
 * It is a gradient, so there is no asset to ship, nothing to load and nothing
 * to get 404 on a deploy. Returns null where there is no 2D canvas — jsdom
 * under vitest, mainly — so importing a module that calls it in a test does not
 * need a canvas polyfill. The points fall back to squares there, and nobody is
 * looking at those.
 */
import * as THREE from "three";

export function softDot(): THREE.Texture | null {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  if (!g) return null;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.62)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
