/**
 * Vibey Coin materials for three.js.
 *
 * For a `CylinderGeometry` coin: pass the returned array as the mesh's
 * material, and the two caps get the coin face (`vibeyCoinArt.ts`) while the
 * edge gets the mint rim. A cylinder's groups are side, top, bottom, in that
 * order, and they survive `rotateX`, so a world that stands its coins on edge
 * keeps the face where it belongs.
 *
 * One set is shared per flavour: every coin in every world points at the same
 * texture, so swapping a world's coins over costs one upload.
 */
import * as THREE from "three";
import { vibeyCoinCanvas } from "@/lib/vibeyCoinArt";

let faceTex: THREE.CanvasTexture | null = null;

export function vibeyCoinTexture(): THREE.Texture | null {
  if (faceTex) return faceTex;
  const c = vibeyCoinCanvas(256);
  if (!c) return null;
  faceTex = new THREE.CanvasTexture(c);
  faceTex.colorSpace = THREE.SRGBColorSpace;
  faceTex.anisotropy = 4;
  return faceTex;
}

/** The mint rim's colour, for halos, beacons and sparkles around a coin. */
export const VIBEY_COIN_GLOW = 0x7dffd4;
export const VIBEY_COIN_EDGE = 0x3fd9b4;

const sets = new Map<string, THREE.Material[]>();

/**
 * [edge, face, face] for a CylinderGeometry. `toon` gives MeshToonMaterial,
 * for worlds drawn with cel shading.
 */
export function vibeyCoinMaterials(opts: { toon?: boolean; glow?: number } = {}): THREE.Material[] {
  const glow = opts.glow ?? 1;
  const key = `${opts.toon ? "toon" : "std"}:${glow}`;
  const hit = sets.get(key);
  if (hit) return hit;
  const map = vibeyCoinTexture();
  let edge: THREE.Material;
  let face: THREE.Material;
  if (opts.toon) {
    edge = new THREE.MeshToonMaterial({ color: VIBEY_COIN_EDGE, emissive: 0x0d6b5c, emissiveIntensity: 0.6 * glow });
    face = new THREE.MeshToonMaterial({
      map,
      emissive: 0xffffff,
      emissiveMap: map,
      emissiveIntensity: 0.55 * glow,
    });
  } else {
    edge = new THREE.MeshStandardMaterial({
      color: VIBEY_COIN_EDGE,
      emissive: 0x0fa07a,
      emissiveIntensity: 0.8 * glow,
      metalness: 0.75,
      roughness: 0.25,
    });
    face = new THREE.MeshStandardMaterial({
      map,
      emissive: 0xffffff,
      emissiveMap: map,
      emissiveIntensity: 0.7 * glow,
      metalness: 0.35,
      roughness: 0.35,
    });
  }
  const set = [edge, face, face];
  sets.set(key, set);
  return set;
}
