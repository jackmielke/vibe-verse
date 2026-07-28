/**
 * Composition root for San Francisco: FREE FALL.
 *
 * Owns the canvas, the renderer configuration and the frame loop, and hands
 * every subsystem its slot. Subsystems live in their own modules and know
 * nothing about each other — they talk through `frame` (per-frame mutable
 * state) and `useSfStore` (UI state), never through props drilled ten levels
 * deep.
 */
import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { QUALITY, WORLD_SEED, type QualityTier } from "./config";
import { frame, resetFrame, useSfStore } from "./state/store";
import { SHOT_POSES, installShotHook, readShotRequest } from "./debug/shotHook";
import { SPAWNS, terrainHeight, WORLD } from "./geo/sfGeo";
import Terrain from "./world/Terrain";
import Bay from "./world/Bay";
import Sky from "./sky/Sky";

/* ------------------------------------------------------------------ *
 * Renderer configuration — the AAA baseline every other system assumes.
 * ------------------------------------------------------------------ */

function RendererSetup({ tier }: { tier: QualityTier }) {
  const { gl, camera, scene } = useThree();
  const q = QUALITY[tier];

  useEffect(() => {
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.0;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    gl.setPixelRatio(Math.min(window.devicePixelRatio, q.maxPixelRatio));
    const cam = camera as THREE.PerspectiveCamera;
    cam.near = 0.15;
    cam.far = q.drawDistance;
    cam.updateProjectionMatrix();
    scene.matrixWorldAutoUpdate = true;
  }, [gl, camera, scene, q]);

  return null;
}

/* ------------------------------------------------------------------ *
 * Frame driver — advances `frame`, publishes stats, drives the shot hook.
 * ------------------------------------------------------------------ */

function FrameDriver({ shotKey }: { shotKey: string | null }) {
  const { gl, camera } = useThree();
  const hook = useMemo(() => installShotHook(), []);
  const acc = useRef({ t: 0, frames: 0 });

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 20);
    frame.dt = dt;
    if (!frame.paused) frame.time += dt;

    // Camera basis from yaw/pitch — every system reads these instead of
    // recomputing trig.
    const cy = Math.cos(frame.yaw);
    const sy = Math.sin(frame.yaw);
    const cp = Math.cos(frame.pitch);
    const sp = Math.sin(frame.pitch);
    frame.forward.set(-sy * cp, sp, -cy * cp).normalize();
    frame.right.set(cy, 0, -sy).normalize();
    frame.up.crossVectors(frame.right, frame.forward).normalize();
    frame.speed = frame.velocity.length();
    frame.altitudeAGL = frame.position.y - terrainHeight(frame.position.x, frame.position.z);

    // Stats once a second — cheap, and the critics need them to catch
    // "prettier but unplayable".
    acc.current.t += dt;
    acc.current.frames++;
    if (acc.current.t >= 1) {
      const info = gl.info;
      const stats = {
        fps: Math.round(acc.current.frames / acc.current.t),
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        programs: info.programs?.length ?? 0,
        textures: info.memory.textures,
        geometries: info.memory.geometries,
      };
      hook.stats = stats;
      useSfStore.getState().setStats(stats.fps, stats.drawCalls, stats.triangles);
      acc.current.t = 0;
      acc.current.frames = 0;
    }

    if (shotKey) {
      hook.framesSincePose++;
      if (hook.framesSincePose > 12 && !hook.ready) hook.ready = true;
    }
  });

  // Apply the harness pose once the scene exists.
  useEffect(() => {
    if (!shotKey) return;
    const pose = SHOT_POSES[shotKey];
    if (!pose) return;
    const cam = camera as THREE.PerspectiveCamera;
    cam.position.set(...pose.pos);
    cam.lookAt(new THREE.Vector3(...pose.look));
    frame.position.set(...pose.pos);
    const dir = new THREE.Vector3(...pose.look).sub(cam.position).normalize();
    frame.yaw = Math.atan2(-dir.x, -dir.z);
    frame.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    hook.framesSincePose = 0;
  }, [shotKey, camera, hook]);

  return null;
}

/** In shot mode the camera is frozen at the requested pose. */
function ShotCamera({ shotKey, fov }: { shotKey: string; fov: number }) {
  const { camera } = useThree();
  useFrame(() => {
    const pose = SHOT_POSES[shotKey];
    if (!pose) return;
    const cam = camera as THREE.PerspectiveCamera;
    cam.position.set(...pose.pos);
    cam.lookAt(new THREE.Vector3(...pose.look));
    if (cam.fov !== fov) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  });
  return null;
}

/* ------------------------------------------------------------------ *
 * The world
 * ------------------------------------------------------------------ */

function World() {
  return (
    <>
      <Sky />
      <Terrain />
      <Bay />
    </>
  );
}

export interface SanFranciscoGameProps {
  /** Spawn key from `SPAWNS`. */
  spawn?: string;
}

export default function SanFranciscoGame({ spawn = "coit" }: SanFranciscoGameProps) {
  const quality = useSfStore((s) => s.quality);
  const setQuality = useSfStore((s) => s.setQuality);
  const setPhase = useSfStore((s) => s.setPhase);

  const shot = useMemo(
    () => (typeof window === "undefined" ? null : readShotRequest(window.location.search)),
    [],
  );

  useEffect(() => {
    installShotHook().request = shot;
    if (shot) {
      frame.timeOfDay = shot.tod;
      frame.fogDensity = shot.fog;
      if (["low", "medium", "high", "ultra"].includes(shot.quality)) {
        setQuality(shot.quality as QualityTier);
      }
    }
    const sp = SPAWNS.find((s) => s.key === spawn) ?? SPAWNS[0];
    resetFrame(sp.x, terrainHeight(sp.x, sp.z) + sp.yOffset, sp.z, sp.heading);
    setPhase("playing");
  }, [shot, spawn, setQuality, setPhase]);

  const q = QUALITY[quality];

  return (
    <div className="fixed inset-0 bg-black">
      <Canvas
        key={WORLD_SEED}
        shadows
        dpr={[1, q.maxPixelRatio]}
        gl={{
          antialias: false,
          powerPreference: "high-performance",
          stencil: false,
          depth: true,
          alpha: false,
          logarithmicDepthBuffer: true,
          preserveDrawingBuffer: true,
        }}
        camera={{ fov: shot?.fov ?? 74, near: 0.15, far: q.drawDistance, position: [0, 120, 0] }}
      >
        <RendererSetup tier={quality} />
        <FrameDriver shotKey={shot?.key ?? null} />
        {shot ? <ShotCamera shotKey={shot.key} fov={shot.fov} /> : null}
        <Suspense fallback={null}>
          <World />
        </Suspense>
        <fog attach="fog" args={[0xb9c8d4, 400, Math.min(q.drawDistance, WORLD.skyCeiling * 4)]} />
      </Canvas>
    </div>
  );
}
