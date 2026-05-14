// ----------------------------------------------------------------------
// WebXR helper — tiny wrapper around three's VRButton for Quest / Pico /
// Index and any other WebXR-immersive headset.
//
// Why this exists:
//   - Every Three.js scene in the app would otherwise have to repeat
//     the same three lines: enable xr on the renderer, switch from
//     requestAnimationFrame to renderer.setAnimationLoop, and mount a
//     VRButton somewhere visible.
//   - VRButton from three/examples writes inline styles that fight our
//     glass-panel aesthetic — we wrap it so we can reposition / restyle
//     in one place.
//   - Some browsers (mobile Safari without a headset) will not expose
//     navigator.xr at all; the helper degrades silently and just renders
//     nothing.
//
// Usage in a scene:
//   const cleanup = enableVR(renderer, container, {
//     referenceSpace: "local-floor",
//   });
//   renderer.setAnimationLoop(tick); // NOT requestAnimationFrame
//   ...
//   return () => { cleanup(); renderer.setAnimationLoop(null); };
//
// Notes for headset support:
//   - "local-floor" puts the origin at the player's feet — best default
//     for room-scale; falls back to "local" automatically if the device
//     can't provide floor data.
//   - We don't add controllers / teleport here yet — scenes are mostly
//     "viewing" experiences (turntable, character preview). When we add
//     true locomotion, build it on top of THREE.XRControllerModelFactory
//     and a teleport ray helper in the consuming scene.
// ----------------------------------------------------------------------

import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";

export type EnableVROptions = {
  referenceSpace?: XRReferenceSpaceType;
};

export function enableVR(
  renderer: THREE.WebGLRenderer,
  mountTarget: HTMLElement,
  opts: EnableVROptions = {},
): () => void {
  // No XR API → nothing to do. Don't even create the button (it would
  // render a "VR NOT SUPPORTED" pill that's mostly noise on desktop).
  if (typeof navigator === "undefined" || !("xr" in navigator)) {
    return () => {};
  }

  renderer.xr.enabled = true;
  try {
    renderer.xr.setReferenceSpaceType(opts.referenceSpace ?? "local-floor");
  } catch {
    /* device may not support local-floor; three falls back internally */
  }

  const button = VRButton.createButton(renderer);
  // Override the inline styles three sets, so the pill matches our UI.
  button.style.position = "absolute";
  button.style.right = "12px";
  button.style.bottom = "12px";
  button.style.left = "auto";
  button.style.transform = "none";
  button.style.padding = "8px 14px";
  button.style.borderRadius = "999px";
  button.style.fontSize = "11px";
  button.style.fontFamily = "inherit";
  button.style.fontWeight = "600";
  button.style.letterSpacing = "0.12em";
  button.style.textTransform = "uppercase";
  button.style.zIndex = "20";
  // Make sure the mount target can host an absolute child.
  if (getComputedStyle(mountTarget).position === "static") {
    mountTarget.style.position = "relative";
  }
  mountTarget.appendChild(button);

  return () => {
    if (button.parentNode === mountTarget) mountTarget.removeChild(button);
  };
}
