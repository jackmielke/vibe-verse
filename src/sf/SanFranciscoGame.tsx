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
import {
  QUALITY,
  WORLD_SEED,
  advanceClock,
  sanFranciscoHour,
  type QualityTier,
} from "./config";
import { frame, resetFrame, useSfStore } from "./state/store";
import { SHOT_POSES, installShotHook, readShotRequest, resolvePose } from "./debug/shotHook";
import { SPAWNS, terrainHeight, walkableHeight, WORLD } from "./geo/sfGeo";
import Terrain from "./world/Terrain";
import Bay from "./world/Bay";
import Sky from "./sky/Sky";
import Buildings from "./world/buildings/Buildings";
import Landmarks from "./world/landmarks/Landmarks";
import Streets from "./world/street";
import Explorer from "./player/Explorer";
import Player from "./player/Player";
import { input as playerInput } from "./player/input";
import { isPhysicsReady, physics } from "./physics";
import { playerCtrl } from "./player/controller";
import CityAI, { pedestrians, trafficSim } from "./ai";
import Vehicles, { vehicleRuntime } from "./vehicles";
import Weapons from "./weapons";
import GameDirector from "./game";
import SfAudio from "./audio";
import SfUi from "./ui/SfUi";
import Peers from "./net/Peers";
import type { NetMode } from "./net/transport";
import Pipeline from "./postfx/Pipeline";
import Vfx from "./vfx/Vfx";
import Weather from "./weather/Weather";
import { currentReport, setReport } from "./weather/service";
import { describeWeather, worldWeather } from "./weather/report";

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
  /** Consecutive bad seconds, for the tier watchdog below. */
  const degrade = useRef({ bad: 0 });

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
      // No nudge: read back the frame that was last presented, rather than
      // re-rendering one. The post chain owns the render loop (it subscribes at
      // priority 1, which is how R3F hands over), so a bare `gl.render` here
      // would draw the raw scene straight over the composed image and every
      // screenshot would silently be of a world with no AO, no bloom and no
      // grade — a picture of something we do not ship. `preserveDrawingBuffer`
      // is on, so the buffer is still there to read.
      if (depthNudge === undefined) return gl.domElement.toDataURL("image/png");

      // A depth probe deliberately wants the unposted scene: it is measuring
      // z-fighting, and the composite would only get in the way.
      const log = gl.capabilities.logarithmicDepthBuffer === true;
      const prevNear = cam.near;
      const prevFar = cam.far;
      if (log) cam.far = prevFar * depthNudge;
      else cam.near = prevNear * depthNudge;
      cam.updateProjectionMatrix();
      gl.render(scene, cam);
      const url = gl.domElement.toDataURL("image/png");
      cam.near = prevNear;
      cam.far = prevFar;
      cam.updateProjectionMatrix();
      return url;
    };
    /* Name what is under a screen coordinate. See `pick` in the hook type for
       why the instance transform is the interesting half of the answer. */
    hook.pick = (ndcX, ndcY) => {
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
      const mat = new THREE.Matrix4();
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      return ray.intersectObjects(scene.children, true).slice(0, 6).map((h) => {
        const obj = h.object as THREE.Mesh & { isInstancedMesh?: boolean };
        const m = obj.material as THREE.Material | THREE.Material[];
        const hit: import("./debug/shotHook").PickHit = {
          distance: Math.round(h.distance * 100) / 100,
          object: obj.name || `«${obj.uuid.slice(-6)}»`,
          material: Array.isArray(m) ? m.map((x) => x.name).join("+") : m?.name || "«unnamed»",
          point: [h.point.x, h.point.y, h.point.z].map((n) => Math.round(n * 100) / 100) as
            [number, number, number],
        };
        if (obj.isInstancedMesh && h.instanceId !== undefined) {
          hit.instanceId = h.instanceId;
          (obj as THREE.InstancedMesh).getMatrixAt(h.instanceId, mat);
          mat.premultiply(obj.matrixWorld).decompose(pos, quat, scl);
          hit.scale = [scl.x, scl.y, scl.z].map((n) => Math.round(n * 100) / 100) as
            [number, number, number];
          hit.origin = [pos.x, pos.y, pos.z].map((n) => Math.round(n * 100) / 100) as
            [number, number, number];
        }
        return hit;
      });
    };
    /* Force a report, bypassing the network. The live fetch cannot be
       exercised in the sandbox at all — the egress proxy answers 403 to
       CONNECT for every weather host — so this is how the *rendered* result of
       a given forecast gets looked at: push a July morning in and photograph
       what the city does with it. */
    hook.forceReport = (over) => {
      const base = currentReport() ?? {
        tempC: 15, apparentC: 14, humidity: 78, cloudCover: 50, precipMm: 0,
        code: 3, windKph: 18, gustKph: 28, windFromDeg: 270, isDay: true,
        at: Date.now(), source: "live" as const,
      };
      setReport({ ...base, ...over, at: Date.now() });
    };
    hook.weather = () => {
      const r = currentReport();
      if (!r) return null;
      const w = worldWeather(r);
      const round = (n: number) => Math.round(n * 1000) / 1000;
      return {
        source: r.source,
        label: describeWeather(r, w),
        tempC: round(r.tempC),
        code: r.code,
        rain: round(w.rain),
        fogDensity: round(frame.fogDensity),
        groundFog: round(w.groundFog),
        windSpeed: round(frame.windSpeed),
        windDir: [round(frame.windDirection.x), round(frame.windDirection.y)] as [number, number],
      };
    };
    hook.state = () => ({
      paused: frame.paused,
      phase: useSfStore.getState().phase,
      inputEnabled: playerInput.enabled,
      vehicleId: frame.vehicleId,
      grounded: frame.grounded,
      speed: frame.speed,
      moveX: playerInput.snapshot.moveX,
      moveZ: playerInput.snapshot.moveZ,
      health: playerCtrl.health,
      physicsReady: isPhysicsReady(),
      stepCount: physics.stepCount,
      pedestrians: pedestrians.stats.count,
      traffic: trafficSim.stats.count,
      vehicles: vehicleRuntime.stats.count,
      vehiclesSpawned: vehicleRuntime.stats.spawned,
      vehiclesPending: vehicleRuntime.stats.pending,
      thirdPerson: frame.thirdPerson,
      quality: useSfStore.getState().quality,
      timeOfDay: Math.round(frame.timeOfDay * 1000) / 1000,
      peers: useSfStore.getState().peers.length,
      peerNames: useSfStore.getState().peers,
    });
    hook.teleport = (x, y, z, yaw) => {
      playerCtrl.respawn(x, y, z, yaw ?? frame.yaw);
    };
    hook.nearestVehicle = () => {
      const v = vehicleRuntime.nearest(
        frame.position.x, frame.position.y, frame.position.z, 400,
      );
      if (!v) return null;
      return {
        id: v.id,
        kind: v.def.kind,
        x: v.position.x,
        y: v.position.y,
        z: v.position.z,
        distance: Math.round(v.distance * 100) / 100,
      };
    };
    hook.nearestPedestrian = () => {
      let best: import("./debug/shotHook").NearestPedestrian | null = null;
      pedestrians.forEachHitbox(
        frame.position.x, frame.position.z, 400,
        (entityId, x, y, z, _h, alive) => {
          const d = Math.hypot(x - frame.position.x, z - frame.position.z);
          if (!best || d < best.distance) {
            best = { entityId, x, y, z, distance: Math.round(d * 100) / 100, alive };
          }
        },
      );
      return best;
    };
    return () => {
      delete hook.camPose;
      delete hook.setPose;
      delete hook.setWeather;
      delete hook.snapshot;
      delete hook.pick;
      delete hook.state;
      delete hook.teleport;
      delete hook.nearestVehicle;
      delete hook.nearestPedestrian;
      delete hook.forceReport;
      delete hook.weather;
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

    // The day passes. `delta`, not `dt`: the clock is wall-clock time and has
    // no business being clamped to the simulation's step ceiling — a tab that
    // was hidden for a minute should come back a minute later in the day, not
    // a twentieth of a second later.
    if (!frame.paused && !frame.clockHeld && !shotKey) {
      frame.timeOfDay = advanceClock(frame.timeOfDay, delta);
    }

    // Stats once a second — cheap, and the critics need them to catch
    // "prettier but unplayable".
    //
    // `delta`, not `dt`. `dt` is clamped to 1/20 so a tab restore cannot hand
    // the controller a two-second step, and accumulating the clamp made this
    // window stretch exactly when it mattered: below 20 fps every frame
    // contributed at most 0.05 no matter how long it really took, so "one
    // second" of stats took as long as it had to and the reported frame rate
    // could not fall below 20. A world running at 3 fps measured itself at 20
    // and reported it to the HUD, to the critic harnesses and to the watchdog
    // below, which is why nothing ever stepped the quality down.
    acc.current.t += delta;
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
      const store = useSfStore.getState();
      store.setStats(stats.fps, stats.drawCalls, stats.triangles);

      /* ---- the safety valve ----
         Nothing used to lower the render tier, ever. The AI director sheds
         crowd and traffic when it measures a bad frame rate, which helps with
         CPU and does nothing at all about the thing that actually takes a
         machine down: the post chain's render targets and the shadow cascades.
         A laptop that guessed too high stayed too high until the tab died.

         So: three consecutive bad seconds and we step down one tier. Only
         down, and only ever once per step, because an automatic upgrade would
         find the frame rate it just fixed and oscillate. Recovering is the
         player's call, from the settings screen. */
      if (!shotKey) {
        const d = degrade.current;
        // The *unrounded* rate. `stats.fps` is rounded for display, and a world
        // limping along at a third of a frame per second rounds to zero — which
        // a "greater than zero" guard reads as "no sample yet" and skips, so the
        // watchdog sat out precisely the emergency it exists for.
        const rate = acc.current.frames / acc.current.t;
        if (acc.current.frames > 0 && rate < LIMP_FPS) d.bad++;
        else d.bad = 0;
        const next = LOWER_TIER[store.quality];
        if (d.bad >= LIMP_SECONDS && next) {
          d.bad = 0;
          store.setQuality(next);
          store.notify(`Graphics turned down to ${QUALITY[next].label} to keep up`, "info");
        }
      }
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

/** Below this, for `LIMP_SECONDS` running, the tier steps down. */
const LIMP_FPS = 20;
const LIMP_SECONDS = 3;

/** Where each tier falls back to. `low` is the floor and has nowhere to go. */
const LOWER_TIER: Partial<Record<QualityTier, QualityTier>> = {
  ultra: "high",
  high: "medium",
  medium: "low",
};

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

/**
 * The static city. Nothing here moves on its own or knows the player exists.
 */
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

/**
 * The city that moves: crowds, traffic, police, parked and drivable vehicles.
 *
 * Split out from `World` because the order matters and the reason is not
 * obvious from the tags. `CityAI` reads vehicle positions as crowd obstacles,
 * and `Vehicles` promotes an AI traffic car into a driveable one when you pull
 * its door open — so they share a frame and the AI has to have run first.
 * Mounting `Vehicles` above `CityAI` gets you pedestrians walking through cars
 * for one frame after every hijack.
 */
function LivingCity({ peaceful }: { peaceful: boolean }) {
  return (
    <>
      <CityAI peaceful={peaceful} />
      <Vehicles />
    </>
  );
}

export interface SanFranciscoGameProps {
  /**
   * `stroll` is a city. `mayhem` is a game about a city.
   *
   * Stroll is the default and turns off the whole hostile stack — weapons,
   * the opposition, police, the wanted level, the chaos director. What is
   * left is the thing that was worth building: nine kilometres of San
   * Francisco with people and traffic in it, a car you can get into, and
   * nothing keeping score.
   */
  vibe?: "stroll" | "mayhem";
  /**
   * Force a quality tier, overriding what the device was guessed to be.
   * `?quality=low` in the URL is the escape hatch for a machine the detector
   * was too optimistic about, and the way to reproduce a tier that is not the
   * one you are on.
   */
  quality?: QualityTier;
  /**
   * Multiplayer transport. `online` shares the city with everybody on the
   * internet in the same room, `local` with every tab of this browser, `off`
   * opens no socket at all.
   */
  net?: NetMode;
  /** Room id. Everybody in the same one is in the same San Francisco. */
  room?: string;
  /** Our display name over our own head, as everybody else sees it. */
  playerName?: string;
  /** Spawn key from `SPAWNS`. */
  spawn?: string;
  /** `walk` puts your character on the pavement; `fly` is the free camera. */
  mode?: "walk" | "fly";
  /** Character id from `@/lib/characters`. Only read in `walk`. */
  charId?: string;
}

export default function SanFranciscoGame({
  vibe = "stroll",
  quality: forcedQuality,
  net = "online",
  room = "sf",
  playerName = "Someone",
  spawn = "coit",
  mode = "walk",
  charId,
}: SanFranciscoGameProps) {
  const peaceful = vibe !== "mayhem";
  const quality = useSfStore((s) => s.quality);
  const setQuality = useSfStore((s) => s.setQuality);
  const setPhase = useSfStore((s) => s.setPhase);
  const setPeers = useSfStore((s) => s.setPeers);

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
    if (forcedQuality) setQuality(forcedQuality);
    // Open on the real city's clock, unless the harness asked for an hour.
    if (!shot) frame.timeOfDay = sanFranciscoHour();
    const sp = SPAWNS.find((s) => s.key === spawn) ?? SPAWNS[0];
    /* A spawn's `yOffset` is where a *flying* observer starts — 266 m up the
       Transamerica, on the Golden Gate's south tower. Dropping a walking
       character in at the same place is a long fall onto a roof they did not
       ask for, so on foot the offset is ignored and you start on the ground
       under it, which is the interesting place to be standing anyway. */
    /* `walkY` is for a spawn whose floor is built rather than terrain — the
       summit of the Terraces is 113 m of structure above the hill it stands
       on, and the hill is what `walkableHeight` knows about. */
    const y = mode === "walk"
      ? walkableHeight(sp.x, sp.z) + (sp.walkY ?? 0)
      : terrainHeight(sp.x, sp.z) + sp.yOffset;
    resetFrame(sp.x, y, sp.z, sp.heading);
    setPhase("playing");
  }, [shot, spawn, mode, forcedQuality, setQuality, setPhase]);

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
          <>
            {/* The player owns the physics step; everything downstream — the
                crowd's avoidance queries, the vehicles' suspension rays —
                needs a world that has already been stepped this frame. */}
            <Player
              charId={charId ?? "vibey"}
              thirdPerson
              drivePhysics
              simpleControls={peaceful}
            />
            {/* No gun in your hands unless you asked for one. */}
            {peaceful ? null : <Weapons />}
            {/* Everybody else. Opens a socket, or quietly does not, and either
                way San Francisco is the same city — see `transport.ts`. */}
            <Peers
              mode={net}
              room={room}
              name={playerName}
              charId={charId ?? "vibey"}
              onRoster={setPeers}
            />
          </>
        ) : (
          <Explorer />
        )}
        <Suspense fallback={null}>
          <World />
          {/* Traffic and crowds are pointless under the shot harness, which
              freezes the camera at a fixed pose — and expensive, because they
              stream against a player who never moves. */}
          {!shot && mode === "walk" ? <LivingCity peaceful={peaceful} /> : null}
        </Suspense>
        {/* The real weather in the real San Francisco, right now. Not mounted
            under the shot harness, which sets its own fog and expects it to
            stay set. */}
        {!shot ? <Weather /> : null}
        {/* Rain, gulls, ground fog, manhole steam, blowing litter, wet
            asphalt. Every one of those was written, tested and documented, and
            this component had never been mounted anywhere in the repository —
            so none of it had drawn a single pixel. `physics` is the explosion
            and destruction bridge, which only mayhem has anything to hand it. */}
        {!shot ? <Vfx physics={!peaceful} /> : null}
        {/* Missions, chaos scoring and the escalation clock. A city you are
            just walking around does not need a director. */}
        {!shot && !peaceful ? <GameDirector /> : null}
        {/* Nothing is ever heard in a screenshot, and priming the banks costs
            a couple of seconds of load the harness would spend waiting. */}
        <SfAudio prime={!shot} music={!shot} ambience={!shot} />
        {/* Last, and it takes over the render loop: `Pipeline` subscribes to
            the frame at priority 1, which is R3F's signal to stop rendering by
            itself and let this own the presentation.

            Not mounted at all below Medium. Which passes run is already gated
            per tier, but the composer's cost is mostly *allocation* — every
            pass wants its own full-resolution half-float target — and a phone
            at devicePixelRatio 3 cannot afford the buffers whether or not
            anything draws into them. Unmounted, the scene renders straight to
            the screen the way it did before any of this existed. */}
        {q.postProcessing ? <Pipeline /> : null}
        <fog attach="fog" args={[0xb9c8d4, 400, Math.min(q.drawDistance, WORLD.skyCeiling * 4)]} />
      </Canvas>
      {/* Outside the Canvas: the HUD, map, menus and pause screen are DOM. */}
      <SfUi hidden={!!shot && !shot.hud} peaceful={peaceful} />
    </div>
  );
}
