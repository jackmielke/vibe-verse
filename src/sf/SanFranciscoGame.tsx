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
import { SHOT_POSES, installShotHook, readShotRequest, resolvePose } from "./debug/shotHook";
import { SPAWNS, terrainHeight, walkableHeight, WORLD } from "./geo/sfGeo";
import Walker from "./player/Walker";
import Terrain from "./world/Terrain";
import Bay from "./world/Bay";
import Sky from "./sky/Sky";
import Buildings from "./world/buildings/Buildings";
import Landmarks from "./world/landmarks/Landmarks";
import Streets from "./world/street";
import Explorer from "./player/Explorer";

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
  const { gl, camera, scene } = useThree();
  const hook = useMemo(() => installShotHook(), []);
  const acc = useRef({ t: 0, frames: 0 });

  /* The debug surface the offline harnesses drive the level through. Installed
     here because this is the one component that holds the renderer, the camera
     and the scene at once. `snapshot` renders synchronously rather than waiting
     for the loop, which is what lets sf-flicker.mjs take two frames that differ
     in nothing but depth precision. */
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    hook.camPose = () => ({
      x: cam.position.x,
      y: cam.position.y,
      z: cam.position.z,
      yaw: frame.yaw,
      pitch: frame.pitch,
      near: cam.near,
      far: cam.far,
      fov: cam.fov,
      logDepth: gl.capabilities.logarithmicDepthBuffer === true,
    });
    hook.setPose = (pos, look, fov) => {
      cam.position.set(...pos);
      cam.lookAt(new THREE.Vector3(...look));
      frame.position.set(...pos);
      const dir = new THREE.Vector3(...look).sub(cam.position).normalize();
      frame.yaw = Math.atan2(-dir.x, -dir.z);
      frame.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      if (fov !== undefined) cam.fov = fov;
      cam.updateProjectionMatrix();
      hook.framesSincePose = 0;
    };
    hook.setWeather = (tod, fog) => {
      frame.timeOfDay = tod;
      frame.fogDensity = fog;
    };
    /**
     * `depthNudge` scales whichever plane actually decides depth precision.
     *
     * Not the near plane — that was the first version of this and it measured
     * nothing at all. three's logarithmic depth is `log2(w + 1) * FC * 0.5`
     * with `FC = 2 / log2(far + 1)`: the near plane does not appear in it, so
     * nudging near leaves every pixel bit-identical and the probe cheerfully
     * reports 0.00% z-fighting for a scene that is visibly fighting. The far
     * plane is the one that moves FC, so under log depth that is the knob.
     */
    hook.snapshot = (depthNudge) => {
      const log = gl.capabilities.logarithmicDepthBuffer === true;
      const prevNear = cam.near;
      const prevFar = cam.far;
      if (depthNudge !== undefined) {
        if (log) cam.far = prevFar * depthNudge;
        else cam.near = prevNear * depthNudge;
        cam.updateProjectionMatrix();
      }
      gl.render(scene, cam);
      const url = gl.domElement.toDataURL("image/png");
      if (depthNudge !== undefined) {
        cam.near = prevNear;
        cam.far = prevFar;
        cam.updateProjectionMatrix();
      }
      return url;
    };
    return () => {
      delete hook.camPose;
      delete hook.setPose;
      delete hook.setWeather;
      delete hook.snapshot;
    };
  }, [camera, gl, scene, hook]);

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
      // `ready` means "this frame is worth photographing", which is NOT the
      // same as "a frame has been drawn". Waiting a fixed 12 frames meant the
      // harness photographed a city that was still streaming in — so every
      // capture judged so far was of a half-built San Francisco, and the
      // higher the tier the emptier the picture. Require the streaming queue
      // to have actually drained, with a frame floor so the pose settles and
      // a ceiling so a stuck queue cannot hang the capture forever.
      const drained = hook.pendingChunks === 0;
      const settled = hook.framesSincePose > 12;
      const timedOut = hook.framesSincePose > 900;
      if (!hook.ready && settled && (drained || timedOut)) hook.ready = true;
    }
  });

  // Apply the harness pose once the scene exists.
  useEffect(() => {
    if (!shotKey) return;
    const raw = SHOT_POSES[shotKey];
    if (!raw) return;
    const pose = resolvePose(raw, walkableHeight);
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
  // Resolved once: terrain height is deterministic, so re-solving it every
  // frame would only burn CPU to arrive at the same number.
  const pose = useMemo(() => {
    const raw = SHOT_POSES[shotKey];
    return raw ? resolvePose(raw, walkableHeight) : null;
  }, [shotKey]);
  useFrame(() => {
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
      <Buildings />
      <Streets />
      <Landmarks />
    </>
  );
}

export interface SanFranciscoGameProps {
  /** Spawn key from `SPAWNS`. */
  spawn?: string;
  /** `walk` puts your character on the pavement; `fly` is the free camera. */
  mode?: "walk" | "fly";
  /** Character id from `@/lib/characters`. Only read in `walk`. */
  charId?: string;
}

export default function SanFranciscoGame({
  spawn = "coit",
  mode = "walk",
  charId,
}: SanFranciscoGameProps) {
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
    /* A spawn's `yOffset` is where a *flying* observer starts — 266 m up the
       Transamerica, on the Golden Gate's south tower. Dropping a walking
       character in at the same place is a long fall onto a roof they did not
       ask for, so on foot the offset is ignored and you start on the ground
       under it, which is the interesting place to be standing anyway. */
    const y = mode === "walk" ? walkableHeight(sp.x, sp.z) : terrainHeight(sp.x, sp.z) + sp.yOffset;
    resetFrame(sp.x, y, sp.z, sp.heading);
    setPhase("playing");
  }, [shot, spawn, mode, setQuality, setPhase]);

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
        {shot ? (
          <ShotCamera shotKey={shot.key} fov={shot.fov} />
        ) : mode === "walk" ? (
          <Walker charId={charId ?? "vibey"} />
        ) : (
          <Explorer />
        )}
        <Suspense fallback={null}>
          <World />
        </Suspense>
        <fog attach="fog" args={[0xb9c8d4, 400, Math.min(q.drawDistance, WORLD.skyCeiling * 4)]} />
      </Canvas>
    </div>
  );
}
