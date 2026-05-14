// ----------------------------------------------------------------------
// WebXR helper — wraps three's VRButton + provides a small thumbstick
// locomotion helper so scenes can let the player fly / walk around.
//
// Why this exists:
//   - Every Three.js scene would otherwise repeat the same boilerplate:
//     enable xr on the renderer, swap rAF for setAnimationLoop, mount
//     a VRButton, and hand-roll controller-axis locomotion.
//   - VRButton from three/examples writes inline styles + a "VR NOT
//     SUPPORTED" pill that's noisy on a laptop with no headset; we
//     gate the mount on a real isSessionSupported check.
//   - Locomotion is opt-in via createVRLocomotion → caller owns the
//     dolly Group (camera lives inside it) and calls update() each
//     frame inside the XR animation loop.
//
// Usage in a scene:
//   const dolly = new THREE.Group();
//   dolly.add(camera);
//   scene.add(dolly);
//   const cleanup = enableVR(renderer, container, {
//     referenceSpace: "local-floor",
//   });
//   const loco = createVRLocomotion({ mode: "fly" }); // or "walk"
//   renderer.setAnimationLoop((_, frame) => {
//     loco.update(renderer, dolly, camera, dt);
//     ...
//   });
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
  // No XR API at all → bail. Most laptops without a headset land here.
  const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
  if (typeof navigator === "undefined" || !xr) {
    return () => {};
  }

  renderer.xr.enabled = true;
  try {
    renderer.xr.setReferenceSpaceType(opts.referenceSpace ?? "local-floor");
  } catch {
    /* device may not support local-floor; three falls back internally */
  }

  // Probe support before mounting the button so we don't render
  // "VR NOT SUPPORTED" on a laptop where Chrome exposes navigator.xr
  // but no headset is attached. Only mount when the runtime actually
  // says "yes, you could enter immersive-vr".
  let button: HTMLElement | null = null;
  let cancelled = false;
  xr.isSessionSupported?.("immersive-vr").then((ok) => {
    if (cancelled || !ok) return;
    button = VRButton.createButton(renderer);
    // Override three's inline styles so it matches our UI pill.
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
    if (getComputedStyle(mountTarget).position === "static") {
      mountTarget.style.position = "relative";
    }
    mountTarget.appendChild(button);
  }).catch(() => {
    /* probe failed — treat as unsupported, render nothing */
  });

  return () => {
    cancelled = true;
    if (button && button.parentNode === mountTarget) {
      mountTarget.removeChild(button);
    }
  };
}

// ----------------------------------------------------------------------
// Locomotion
//
// Reads the right thumbstick from any connected XR controller and
// translates a "dolly" Group around. The camera should be added to
// the dolly so headset rotation still applies on top of dolly position.
//
//   mode: "fly"  → free 6DOF along the camera's view direction (space)
//   mode: "walk" → ground-locked XZ movement (garden)
//
// The right thumbstick steers (axes[2] = strafe, axes[3] = forward).
// In "fly" mode, the left thumbstick's Y axis (axes[3] of the left
// controller) becomes vertical thrust so you can rise/dip too.
// ----------------------------------------------------------------------

export type VRLocomotionMode = "fly" | "walk";

export type VRLocomotionOptions = {
  mode: VRLocomotionMode;
  /** meters per second at full stick deflection. */
  speed?: number;
  /** stick deadzone, 0..1. */
  deadzone?: number;
};

export type VRLocomotion = {
  update: (
    renderer: THREE.WebGLRenderer,
    dolly: THREE.Object3D,
    camera: THREE.Camera,
    dt: number,
  ) => void;
};

export function createVRLocomotion(opts: VRLocomotionOptions): VRLocomotion {
  const speed = opts.speed ?? (opts.mode === "fly" ? 6 : 2.2);
  const dead = opts.deadzone ?? 0.15;
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  const apply = (v: number) => (Math.abs(v) < dead ? 0 : v);

  return {
    update(renderer, dolly, camera, dt) {
      if (!renderer.xr.isPresenting) return;
      const session = renderer.xr.getSession();
      if (!session) return;

      // Camera world direction (drives "forward" relative to where you look).
      camera.getWorldDirection(fwd);
      if (opts.mode === "walk") {
        fwd.y = 0;
        if (fwd.lengthSq() < 1e-6) return;
        fwd.normalize();
      }
      right.crossVectors(fwd, up).normalize();

      for (const src of session.inputSources) {
        const gp = src.gamepad;
        if (!gp) continue;
        // xr-standard maps thumbstick to axes[2,3]; some runtimes only
        // expose axes[0,1]. Pick whichever pair has stronger deflection.
        const a0 = gp.axes[0] ?? 0;
        const a1 = gp.axes[1] ?? 0;
        const a2 = gp.axes[2] ?? 0;
        const a3 = gp.axes[3] ?? 0;
        const useHigh = Math.hypot(a2, a3) >= Math.hypot(a0, a1);
        const rawX = useHigh ? a2 : a0;
        const rawY = useHigh ? a3 : a1;
        const sx = apply(rawX);
        const sy = apply(rawY);

        // Right hand (or any controller in walk mode) → planar movement.
        const isLeft = src.handedness === "left";
        if (!isLeft || opts.mode === "walk") {
          if (sx !== 0 || sy !== 0) {
            dolly.position.addScaledVector(fwd, -sy * speed * dt);
            dolly.position.addScaledVector(right, sx * speed * dt);
          }
        }

        // In fly mode, left controller drives vertical thrust on Y.
        if (opts.mode === "fly" && isLeft) {
          if (sy !== 0) dolly.position.y += -sy * speed * dt;
        }
      }
    },
  };
}
