/**
 * characterRig — load a playable character as a ready-to-mount rig,
 * whether or not it has a model file behind it.
 *
 * Most characters in the catalog are GLBs. Flux isn't: it's assembled
 * from primitives and animated in code (see proceduralPilot.ts). Before
 * this module every surface that showed a character — the lobby
 * turntable, the profile turntable, the memory garden, the gallery —
 * hard-coded `loader.load(spec.url, ...)`, so a URL-less character made
 * each of them silently render nothing.
 *
 * They also each re-derived the same three things by hand, slightly
 * differently: scale to a target height, anchor the feet to y=0, centre
 * the silhouette on x/z. That lives here once now.
 *
 * The returned rig exposes one locomotion knob rather than clip names,
 * because that's the only animation concept the two kinds of character
 * share: a GLB cross-fades idle→walk with it, and Flux feeds it straight
 * into the gait solver that was already driving off real speed.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildProceduralPilot, type ProceduralPilot } from "@/components/city/proceduralPilot";

export interface CharacterRig {
  /** Fitted and anchored — drop it straight into a parent group. */
  object: THREE.Object3D;
  /** Post-fit bounding size, for framing a camera on it. */
  size: THREE.Vector3;
  /** Empty for procedural characters, which have no clips at all. */
  clips: THREE.AnimationClip[];
  mixer: THREE.AnimationMixer | null;
  /**
   * The rig animates itself — true for procedural characters and for
   * GLBs that shipped with clips. Callers that fake motion for rigless
   * models (a manual bob, say) should skip it when this is set;
   * `clips.length` alone would wrongly bob a procedural character, which
   * has no clips precisely because it needs none.
   */
  animated: boolean;
  /**
   * 0 = standing still, 1 = walking. GLB rigs cross-fade idle↔walk;
   * procedural rigs treat it as speed and solve the gait from it.
   */
  setLocomotion(amount01: number): void;
  update(dt: number): void;
  dispose(): void;
}

export interface RigOptions {
  /** Target size in metres, interpreted per `fitBy`. */
  height?: number;
  /**
   * Which dimension `height` constrains.
   *  - "height" (default): scale so the model is exactly that tall. What
   *    the walkable worlds want — everyone stands the same height.
   *  - "max": scale so the LARGEST dimension is that big. What the
   *    turntables want, so wide short characters (the pug, the cow)
   *    don't blow up to fill the frame trying to reach a target height.
   */
  fitBy?: "height" | "max";
  /** Centre the silhouette on x/z (turntables want this; worlds vary). */
  center?: boolean;
  /** Meshes cast shadows. */
  castShadow?: boolean;
  /** Walking speed, m/s, that locomotion=1 means for procedural rigs. */
  walkSpeed?: number;
}

/** Scale to `height`, plant the feet at y=0, optionally centre on x/z. */
function fitAndAnchor(
  object: THREE.Object3D,
  height: number,
  center: boolean,
  fitBy: "height" | "max",
) {
  object.position.set(0, 0, 0);
  object.scale.setScalar(1);
  object.updateMatrixWorld(true);
  const raw = new THREE.Box3().setFromObject(object);
  const rawSize = new THREE.Vector3();
  raw.getSize(rawSize);
  const ref = fitBy === "max"
    ? Math.max(rawSize.x, rawSize.y, rawSize.z)
    : rawSize.y;
  object.scale.setScalar(height / Math.max(ref, 0.0001));
  object.updateMatrixWorld(true);

  const fitted = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  fitted.getSize(size);
  object.position.y = -fitted.min.y;
  if (center) {
    const c = new THREE.Vector3();
    fitted.getCenter(c);
    object.position.x = -c.x;
    object.position.z = -c.z;
  }
  return size;
}

function proceduralRig(opts: Required<RigOptions>, designId?: string): CharacterRig {
  const pilot: ProceduralPilot = buildProceduralPilot(undefined, designId);
  // Wrap it so fitting can scale the wrapper without fighting the
  // squash-and-stretch the rig applies to its own root every frame.
  const holder = new THREE.Group();
  holder.add(pilot.group);
  const size = fitAndAnchor(holder, opts.height, opts.center, opts.fitBy);
  if (opts.castShadow) {
    holder.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
  }

  let locomotion = 0;
  return {
    object: holder,
    size,
    clips: [],
    mixer: null,
    animated: true,
    setLocomotion(a) {
      locomotion = THREE.MathUtils.clamp(a, 0, 1);
    },
    update(dt) {
      pilot.update(dt, {
        speed: locomotion * opts.walkSpeed,
        grounded: true,
        verticalVel: 0,
        yawRate: 0,
        thrusting: false,
      });
    },
    dispose() {
      pilot.dispose();
    },
  };
}

const sharedLoader = new GLTFLoader();

export function loadCharacterRig(
  spec: { url: string; id?: string },
  options: RigOptions = {},
): Promise<CharacterRig> {
  const opts: Required<RigOptions> = {
    height: options.height ?? 1.8,
    fitBy: options.fitBy ?? "height",
    center: options.center ?? true,
    castShadow: options.castShadow ?? true,
    walkSpeed: options.walkSpeed ?? 4.2,
  };

  // No URL means there is no file to fetch — build it here instead. The
  // id selects which design of the shared rig to assemble.
  if (!spec.url) return Promise.resolve(proceduralRig(opts, spec.id));

  return sharedLoader.loadAsync(spec.url).then((gltf) => {
    const object = gltf.scene;
    const size = fitAndAnchor(object, opts.height, opts.center, opts.fitBy);
    object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (opts.castShadow) m.castShadow = true;
      // Match what the worlds do to imported materials: nothing in this
      // catalog should read as polished chrome.
      const apply = (mat: THREE.Material) => {
        const std = mat as THREE.MeshStandardMaterial;
        if (std && "metalness" in std) {
          std.metalness = Math.min(std.metalness, 0.3);
          std.roughness = Math.max(std.roughness, 0.45);
        }
      };
      if (Array.isArray(m.material)) m.material.forEach(apply);
      else if (m.material) apply(m.material);
    });

    const clips = gltf.animations ?? [];
    let mixer: THREE.AnimationMixer | null = null;
    let idle: THREE.AnimationAction | null = null;
    let walk: THREE.AnimationAction | null = null;
    if (clips.length) {
      mixer = new THREE.AnimationMixer(object);
      const idleClip = clips.find((c) => /idle|breath|stand/i.test(c.name)) ?? clips[0];
      const walkClip = clips.find((c) => /walk|run/i.test(c.name)) ?? idleClip;
      idle = mixer.clipAction(idleClip);
      idle.play();
      if (walkClip !== idleClip) {
        walk = mixer.clipAction(walkClip);
        walk.setLoop(THREE.LoopRepeat, Infinity);
        walk.weight = 0;
        walk.play();
      }
    }

    return {
      object,
      size,
      clips,
      mixer,
      animated: clips.length > 0,
      setLocomotion(a: number) {
        const w = THREE.MathUtils.clamp(a, 0, 1);
        if (!walk || !idle) return;
        walk.weight = w;
        idle.weight = 1 - w;
      },
      update(dt: number) {
        mixer?.update(dt);
      },
      dispose() {
        mixer?.stopAllAction();
        object.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.geometry?.dispose();
          const mat = m.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat?.dispose();
        });
      },
    };
  });
}
