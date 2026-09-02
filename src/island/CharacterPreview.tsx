import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import type { CharacterOption } from "./characters";
import { buildProceduralPilot, type ProceduralPilot } from "@/components/city/proceduralPilot";
import { DEFAULT_POSE, poseById, type PoseId } from "./previewPose";
import { HAT_CATALOG } from "@/components/city/cosmetics";

function findClip(clips: THREE.AnimationClip[], names: string[]): THREE.AnimationClip | null {
  for (const n of names) {
    const c = clips.find((x) => x.name.toLowerCase().includes(n.toLowerCase()));
    if (c) return c;
  }
  return null;
}

function visibleMeshBounds(object: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();
  let found = false;

  object.updateMatrixWorld(true);
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    /* A skinned mesh's geometry box is the BIND pose, wherever the modeller
       left it. On the Quaternius rigs that box is centred on the origin while
       the posed character stands on it, so planting "the feet" at y=0 lifted
       the model by half its height and the turntable framed a pair of boots.
       `SkinnedMesh` keeps a box of the posed vertices; use that. */
    const skinned = mesh as THREE.SkinnedMesh;
    let box: THREE.Box3 | null;
    if (skinned.isSkinnedMesh) {
      skinned.computeBoundingBox();
      box = skinned.boundingBox;
    } else {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      box = mesh.geometry.boundingBox;
    }
    if (!box) return;
    meshBox.copy(box).applyMatrix4(mesh.matrixWorld);
    if (!Number.isFinite(meshBox.min.x) || !Number.isFinite(meshBox.max.x)) return;
    if (meshBox.isEmpty()) return;
    if (!found) {
      box.copy(meshBox);
      found = true;
    } else {
      box.union(meshBox);
    }
  });

  return found ? box : new THREE.Box3().setFromObject(object);
}

function PreviewModel({
  character,
  spinning,
  pose,
  hat,
  onFit,
}: {
  character: CharacterOption;
  spinning: boolean;
  pose: PoseId;
  hat?: string | null;
  onFit: (size: THREE.Vector3) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const procRef = useRef<ProceduralPilot | null>(null);
  const [scene, setScene] = useState<THREE.Group | null>(null);
  /* Seconds since this pose was picked, not since the page loaded. Leap and
     dash both start from a known phase, so switching to them mid-cycle would
     drop the character in halfway through a jump. */
  const poseT = useRef(0);
  useEffect(() => {
    poseT.current = 0;
  }, [pose]);

  useEffect(() => {
    let alive = true;
    // An empty url means the character has no model file — it's built
    // from primitives and animated in code. Build it and let it walk;
    // a still pose would sell none of what makes it different.
    if (!character.url) {
      const p = buildProceduralPilot(undefined, character.id);
      procRef.current = p;
      /* The hat rides the head joint, not the root — see the note on
         `ProceduralPilot.head`. Built here rather than in a second effect so
         it is torn down with the pilot it belongs to; a hat that outlives its
         character is a hat floating in an empty stage. */
      if (hat && hat !== "none") {
        const def = HAT_CATALOG.find((h) => h.id === hat);
        if (def) {
          const g = def.build();
          /* The catalog builds for a mount at y=1.78 on a 1.85m model whose
             head is wider than this rig's. At full size the propeller sat a
             clear centimetre above the skull and read as a hovering prop
             rather than a hat, so it comes down and in. Tuned against the
             tallest and widest things in the catalogue — propeller and crown
             — because those are the two that show a bad fit first. */
          g.position.y = 0.235;
          g.scale.setScalar(0.62);
          p.head.add(g);
        }
      }
      const size = new THREE.Vector3();
      new THREE.Box3().setFromObject(p.group).getSize(size);
      setScene(p.group);
      onFit(size);
      return () => {
        alive = false;
        procRef.current?.dispose();
        procRef.current = null;
      };
    }
    const loader = new GLTFLoader();
    loader.loadAsync(character.url).then((gltf) => {
      if (!alive) return;
      const cloned = SkeletonUtils.clone(gltf.scene) as THREE.Group;
      cloned.traverse((o: any) => {
        if (o.isMesh) {
          o.castShadow = false;
          o.receiveShadow = false;
        }
      });
      cloned.scale.setScalar(character.scale);

      // Normalize from visible mesh bounds only. Some GLBs include armature,
      // helper, or root nodes with huge bounds, which made real characters
      // render as tiny dots in the picker.
      const box = visibleMeshBounds(cloned);
      const size = new THREE.Vector3();
      box.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z, 0.0001);
      cloned.scale.multiplyScalar(2.2 / maxDim);
      cloned.updateMatrixWorld(true);

      // Auto-frame: recenter on x/z, plant feet at y=0
      const fitBox = visibleMeshBounds(cloned);
      const fitSize = new THREE.Vector3();
      const center = new THREE.Vector3();
      fitBox.getSize(fitSize);
      fitBox.getCenter(center);
      cloned.position.x -= center.x;
      cloned.position.z -= center.z;
      cloned.position.y -= fitBox.min.y;
      cloned.position.y += character.yOffset;

      const mixer = new THREE.AnimationMixer(cloned);
      const clip = findClip(gltf.animations, ["idle", "stand", "breath"]);
      if (clip) mixer.clipAction(clip).play();
      mixerRef.current = mixer;
      setScene(cloned);
      onFit(fitSize);
    }).catch(() => {});
    return () => {
      alive = false;
      mixerRef.current?.stopAllAction();
      mixerRef.current = null;
    };
    /* `character.id` is in here for a reason that is easy to delete by
       accident: every code-built character has an empty `url`, so keying the
       rebuild on the url alone meant flipping between them showed the FIRST
       one forever. The picker looked like it was working — the name, the
       blurb and the accent all changed — and the model underneath never did. */
  }, [character.id, character.url, character.scale, character.yOffset, hat, onFit]);

  useFrame((_state, dt) => {
    const step = Math.min(dt, 0.05);
    if (mixerRef.current) mixerRef.current.update(step);
    poseT.current += step;
    const p = poseById(pose);
    procRef.current?.update(step, p.frame(poseT.current));
    if (groupRef.current) {
      // `spinning` is the caller forcing a turntable; a pose can also ask for
      // one, and idle does, because a still character facing front hides
      // every cape in the roster.
      const rate = spinning ? 0.6 : p.spin;
      if (rate) groupRef.current.rotation.y += step * rate;
    }
  });

  return (
    <group ref={groupRef}>
      {scene ? <primitive object={scene} /> : null}
    </group>
  );
}

function CameraRig({ targetY, distance }: { targetY: number; distance: number }) {
  const { camera } = useThree();
  useEffect(() => {
    camera.position.set(0, targetY + 0.05, distance);
    camera.lookAt(0, targetY, 0);
  }, [camera, targetY, distance]);
  return null;
}

export function CharacterPreview({
  character,
  spinning = true,
  pose = DEFAULT_POSE,
  hat,
}: {
  character: CharacterOption;
  spinning?: boolean;
  pose?: PoseId;
  /** Hat id from `HAT_CATALOG`, or null/"none" for bare-headed. */
  hat?: string | null;
}) {
  const [size, setSize] = useState<THREE.Vector3 | null>(null);
  const onFit = useCallback((s: THREE.Vector3) => setSize(s.clone()), []);

  const fov = 28;
  const { targetY, distance } = useMemo(() => {
    if (!size) {
      return { targetY: character.previewTarget, distance: character.previewDistance };
    }
    const h = Math.max(size.y, 0.3);
    const w = Math.max(size.x, size.z, 0.3);
    const fovRad = (fov * Math.PI) / 180;
    const distV = (h * 1.2) / (2 * Math.tan(fovRad / 2));
    const distH = (w * 1.2) / (2 * Math.tan(fovRad / 2));
    return { targetY: h / 2, distance: Math.max(distV, distH, 1.2) };
  }, [size, character.previewTarget, character.previewDistance]);

  // Reset fit on character swap so the next model auto-frames itself. By id,
  // not url — see the note in PreviewModel about empty urls.
  useEffect(() => {
    setSize(null);
  }, [character.id]);

  return (
    <Canvas
      shadows={false}
      dpr={[1, 1.5]}
      camera={{ position: [0, 1.4, 3], fov, near: 0.1, far: 50 }}
      gl={{ antialias: true, alpha: true }}
      // `flat` = NoToneMapping. R3F defaults to ACES filmic, which
      // crushes these midtones badly: every character in the picker was
      // rendering as a black silhouette, and the worlds themselves don't
      // tone-map either, so the card didn't match what you got in-game.
      flat
    >
      <CameraRig targetY={targetY} distance={distance} />
      {/* Intensities are for three's post-r155 physical lighting units,
          where the old hand-tuned values land about a stop and a half
          under. Key warm, fill cool, rim behind to lift the edge off a
          dark card background. */}
      <ambientLight intensity={1.5} />
      <hemisphereLight args={["#dff0ff", "#4a4a55", 1.2]} />
      <directionalLight position={[2, 4, 3]} intensity={2.6} color="#ffe6b8" />
      <directionalLight position={[-3, 2, -2]} intensity={1.4} color="#a0c8ff" />
      <directionalLight position={[0, 2.5, -4]} intensity={1.6} color="#ffffff" />
      <Suspense fallback={null}>
        <PreviewModel
          character={character}
          spinning={spinning}
          pose={pose}
          hat={hat}
          onFit={onFit}
        />
      </Suspense>
    </Canvas>
  );
}
