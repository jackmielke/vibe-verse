/**
 * VR portals — drop one of these into any Three.js scene to let an
 * XR user walk into it and teleport to another route.
 *
 * Visual: a glowing torus ring with a swirling translucent disc
 * inside, plus a floating canvas-sprite label so you know where it
 * leads. Tuck them in corners or behind props for an "Easter egg"
 * vibe.
 *
 * The helper is renderer/scene-agnostic — the caller pumps it with
 * the player's world-space head position each frame and is told
 * exactly once when the player crosses the threshold.
 *
 * Usage:
 *
 *   const portal = createVRPortal(scene, {
 *     position: [4, 1.6, -3],
 *     color: 0x73ffb8,
 *     label: "Garden",
 *     onEnter: () => leaveXrAndNavigate(renderer, navigate, "/garden"),
 *   });
 *   // each frame:
 *   portal.update(headWorldPos, dt);
 *   // teardown:
 *   portal.dispose();
 */
import * as THREE from "three";

export interface VRPortalOpts {
  position: [number, number, number];
  /** Ring/glow color (hex). */
  color?: number;
  /** Floating label rendered above the ring. */
  label: string;
  /** Outer ring radius in scene units. Default 0.9. */
  radius?: number;
  /** XZ distance from ring center that counts as "entering". Default 0.7. */
  triggerRadius?: number;
  /** Optional Y rotation (radians) so the ring faces the player. */
  rotationY?: number;
  /** Fired exactly once when the head enters triggerRadius. */
  onEnter: () => void;
}

export interface VRPortalHandle {
  group: THREE.Group;
  /** Pass head position in WORLD space (e.g. via getWorldPosition). */
  update: (headWorld: THREE.Vector3, dt: number) => void;
  dispose: () => void;
}

export function createVRPortal(
  scene: THREE.Scene,
  opts: VRPortalOpts,
): VRPortalHandle {
  const color = opts.color ?? 0x73ffb8;
  const radius = opts.radius ?? 0.9;
  const trigger = opts.triggerRadius ?? 0.7;

  const group = new THREE.Group();
  group.position.set(opts.position[0], opts.position[1], opts.position[2]);
  if (opts.rotationY) group.rotation.y = opts.rotationY;

  // Outer torus — the visible ring
  const ringGeo = new THREE.TorusGeometry(radius, 0.06, 16, 64);
  const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  group.add(ring);

  // Inner swirling disc — additive blending for a portal-y feel
  const discGeo = new THREE.CircleGeometry(radius * 0.92, 64);
  const discMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const disc = new THREE.Mesh(discGeo, discMat);
  group.add(disc);

  // Soft glow halo behind the ring
  const haloGeo = new THREE.RingGeometry(radius * 1.0, radius * 1.4, 64);
  const haloMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const halo = new THREE.Mesh(haloGeo, haloMat);
  halo.position.z = -0.01;
  group.add(halo);

  // Floating sprite label
  const label = makeLabelSprite(opts.label, color);
  label.position.set(0, radius + 0.45, 0);
  group.add(label);

  scene.add(group);

  let triggered = false;
  let t = 0;
  const tmp = new THREE.Vector3();
  const center = new THREE.Vector3();

  function update(headWorld: THREE.Vector3, dt: number) {
    t += dt;
    // swirl + breathe
    disc.rotation.z += dt * 1.2;
    const pulse = 0.85 + Math.sin(t * 2.4) * 0.15;
    ring.scale.setScalar(pulse);
    halo.material.opacity = 0.12 + Math.sin(t * 2.4) * 0.06;
    // label always faces head (sprite is auto-billboard, but keep it bobbing)
    label.position.y = radius + 0.45 + Math.sin(t * 1.5) * 0.04;

    if (triggered) return;
    group.getWorldPosition(center);
    tmp.subVectors(headWorld, center);
    // Flat XZ distance — Y can vary (head height vs ring height).
    const dxz = Math.hypot(tmp.x, tmp.z);
    if (dxz < trigger && Math.abs(tmp.y) < radius * 1.6) {
      triggered = true;
      opts.onEnter();
    }
  }

  function dispose() {
    scene.remove(group);
    ringGeo.dispose(); ringMat.dispose();
    discGeo.dispose(); discMat.dispose();
    haloGeo.dispose(); haloMat.dispose();
    const tex = (label.material as THREE.SpriteMaterial).map;
    tex?.dispose();
    (label.material as THREE.SpriteMaterial).dispose();
  }

  return { group, update, dispose };
}

function makeLabelSprite(text: string, color: number): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, c.width, c.height);
  // pill background
  const bg = "rgba(10,18,14,0.78)";
  ctx.fillStyle = bg;
  roundRect(ctx, 16, 16, c.width - 32, c.height - 32, 40);
  ctx.fill();
  // border in portal color
  ctx.strokeStyle = `#${color.toString(16).padStart(6, "0")}`;
  ctx.lineWidth = 4;
  roundRect(ctx, 16, 16, c.width - 32, c.height - 32, 40);
  ctx.stroke();
  // text
  ctx.fillStyle = "#eafff3";
  ctx.font = "600 56px Sora, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`→ ${text}`, c.width / 2, c.height / 2 + 4);

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.1, 0.28, 1);
  return sprite;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Convenience: end any active XR session, then navigate. Use as the
 * `onEnter` for a portal that crosses worlds.
 */
export async function leaveXrAndNavigate(
  renderer: THREE.WebGLRenderer,
  navigate: (path: string) => void,
  path: string,
) {
  try {
    const session = renderer.xr.getSession();
    if (session) await session.end();
  } catch { /* noop */ }
  navigate(path);
}
