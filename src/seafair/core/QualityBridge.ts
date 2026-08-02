import * as THREE from "three";
import { setMaxAnisotropy } from "./Assets";

export { getProfile } from "./Settings";

/** Feed the renderer's real anisotropy cap into the texture factory. */
export function setMaxAnisotropyFromRenderer(renderer: THREE.WebGLRenderer): void {
  setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());
}
