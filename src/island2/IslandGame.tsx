/**
 * Composition root for VIBE ISLAND II.
 *
 * Mirrors the structure that worked for San Francisco — canvas, renderer
 * config, frame driver, capture hook — because the discipline is what makes
 * the iteration loop possible: a deterministic offline capture is the only way
 * "did this get prettier" becomes a question with an answer.
 */
import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { QUALITY, WORLD_SEED, type QualityTier } from "./config";
import { frame, resetFrame, useIslandStore } from "./state/store";
import { SPAWNS, WORLD, surfaceHeight, walkableHeight } from "./geo/islandGeo";
import Sky from "./sky/Sky";
import Islands from "./world/Islands";
import Lagoon from "./world/Lagoon";
import Explorer from "./player/Explorer";
import { ISLAND_SHOTS, installIslandHook, readIslandShot } from "./debug/shotHook";

function RendererSetup({ tier }: { tier: QualityTier }) {
  const { gl, camera } = useThree();
  const q = QUALITY[tier];
  useEffect(() => {
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    // Slightly hot on purpose: the island is a bright, generous place and a
    // neutral exposure makes golden hour look like an overcast afternoon.
    gl.toneMappingExposure = 1.12;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    gl.setPixelRatio(Math.min(window.devicePixelRatio, q.maxPixelRatio));
    const cam = camera as THREE.PerspectiveCamera;
    cam.near = 0.12;
    cam.far = q.drawDistance;
    cam.updateProjectionMatrix();
  }, [gl, camera, q]);
  return null;
}

function FrameDriver({ shotKey }: { shotKey: string | null }) {
  const { gl } = useThree();
  const hook = useMemo(() => installIslandHook(), []);
  const acc = useRef({ t: 0, frames: 0 });

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 20);
    frame.dt = dt;
    if (!frame.paused) frame.time += dt;

    const cy = Math.cos(frame.yaw);
    const sy = Math.sin(frame.yaw);
    const cp = Math.cos(frame.pitch);
    const sp = Math.sin(frame.pitch);
    frame.forward.set(-sy * cp, sp, -cy * cp).normalize();
    frame.right.set(cy, 0, -sy).normalize();
    frame.up.crossVectors(frame.right, frame.forward).normalize();
    frame.speed = frame.velocity.length();

    const ground = surfaceHeight(frame.position.x, frame.position.z);
    frame.overVoid = ground === null;
    frame.altitudeAGL = ground === null ? frame.position.y - WORLD.cloudDeck : frame.position.y - ground;

    acc.current.t += dt;
    acc.current.frames++;
    if (acc.current.t >= 1) {
      const info = gl.info;
      const stats = {
        fps: Math.round(acc.current.frames / acc.current.t),
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
      };
      hook.stats = stats;
      useIslandStore.getState().setStats(stats.fps, stats.drawCalls, stats.triangles);
      acc.current.t = 0;
      acc.current.frames = 0;
    }

    if (shotKey) {
      hook.framesSincePose++;
      // Unlike SF there is no chunk streaming here — the archipelago is built
      // in one pass — so a settle window is genuinely sufficient.
      if (!hook.ready && hook.framesSincePose > 20) hook.ready = true;
    }
  });

  return null;
}

function ShotCamera({ shotKey, fov }: { shotKey: string; fov: number }) {
  const { camera } = useThree();
  const pose = useMemo(() => ISLAND_SHOTS[shotKey] ?? null, [shotKey]);
  useFrame(() => {
    if (!pose) return;
    const cam = camera as THREE.PerspectiveCamera;
    const y = pose.agl ? walkableHeight(pose.pos[0], pose.pos[2]) + pose.pos[1] : pose.pos[1];
    cam.position.set(pose.pos[0], y, pose.pos[2]);
    cam.lookAt(new THREE.Vector3(...pose.look));
    if (cam.fov !== fov) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  });
  return null;
}

function World() {
  return (
    <>
      <Sky />
      <Islands />
      <Lagoon />
    </>
  );
}

export default function IslandGame({ spawn = "plaza" }: { spawn?: string }) {
  const quality = useIslandStore((s) => s.quality);
  const setQuality = useIslandStore((s) => s.setQuality);
  const setPhase = useIslandStore((s) => s.setPhase);

  const shot = useMemo(
    () => (typeof window === "undefined" ? null : readIslandShot(window.location.search)),
    [],
  );

  useEffect(() => {
    installIslandHook().request = shot;
    if (shot) {
      frame.timeOfDay = shot.tod;
      frame.haze = shot.haze;
      if (["low", "medium", "high", "ultra"].includes(shot.quality)) {
        setQuality(shot.quality as QualityTier);
      }
    }
    const sp = SPAWNS.find((s) => s.key === spawn) ?? SPAWNS[0];
    resetFrame(sp.x, walkableHeight(sp.x, sp.z) + sp.yOffset, sp.z, sp.heading);
    setPhase("playing");
  }, [shot, spawn, setQuality, setPhase]);

  const q = QUALITY[quality];

  return (
    <div className="fixed inset-0 bg-[#0a0d14]">
      <Canvas
        key={WORLD_SEED}
        shadows
        dpr={[1, q.maxPixelRatio]}
        gl={{
          antialias: true,
          powerPreference: "high-performance",
          stencil: false,
          alpha: false,
          preserveDrawingBuffer: true,
        }}
        camera={{ fov: shot?.fov ?? 72, near: 0.12, far: q.drawDistance, position: [0, 40, 120] }}
      >
        <RendererSetup tier={quality} />
        <FrameDriver shotKey={shot?.key ?? null} />
        {shot ? <ShotCamera shotKey={shot.key} fov={shot.fov} /> : <Explorer />}
        <Suspense fallback={null}>
          <World />
        </Suspense>
        <fog attach="fog" args={[0xf0bc85, 320, 5200]} />
      </Canvas>
    </div>
  );
}
