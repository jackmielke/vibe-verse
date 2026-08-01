/**
 * THE TERMINAL — the Vibeverse's front door.
 *
 * A stylised sky-lobby you actually stand in, which is also the world picker.
 * The 3D scene and the interface are deliberately separate concerns: the scene
 * owns the frame budget, the UI owns the input, and they meet through one
 * number — which gate is focused.
 */
import { Suspense, useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import * as THREE from "three";
import Scene from "./world/Scene";
import Lobby from "./ui/Lobby";
import { GATES, LOBBY_CAMERA, SPAWN, gatePosition } from "./geo/terminalGeo";
import { MOBILE, SHOT_MODE } from "./device";

/** Ease the camera toward the focused gate so the lobby feels like it looks. */
function useFocusCamera(focusedIndex: number) {
  const [target] = useState(() => new THREE.Vector3());
  useEffect(() => {
    const g = GATES[focusedIndex];
    const p = gatePosition(g);
    target.set(p.x, p.y, p.z);
  }, [focusedIndex, target]);
  return target;
}

export default function TerminalScene() {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [online, setOnline] = useState<number | null>(null);
  const focusTarget = useFocusCamera(focusedIndex);

  // Presence, best-effort. The lobby is still a lobby if the backend is down,
  // so this never blocks anything and never surfaces an error.
  useEffect(() => {
    let cancelled = false;
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
    if (!url || !key) return;
    fetch(`${url}/functions/v1/vibe-world`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.agents) setOnline(d.agents.length);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div className="fixed inset-0 bg-[#5fa8e8]">
      <Canvas
        shadows
        /* A phone renders this at 3x by default, which is three times the
           pixels for a screen nobody is inspecting closely. Cap it — the lobby
           promises to load in about a second on a phone, and a 1200p render of
           a flat-shaded scene is how that promise gets broken. */
        dpr={[1, MOBILE ? 1.5 : 2]}
        gl={{
          antialias: true,
          alpha: false,
          powerPreference: "high-performance",
          /* Only the screenshot harness needs the buffer kept around; for
             everyone else it costs bandwidth on every single frame. */
          preserveDrawingBuffer: SHOT_MODE,
        }}
        camera={{
          fov: LOBBY_CAMERA.fov,
          near: 0.1,
          far: 3000,
          position: [0, LOBBY_CAMERA.height, SPAWN.z + LOBBY_CAMERA.distance],
        }}
        onCreated={({ camera }) => {
          camera.lookAt(0, LOBBY_CAMERA.lookHeight, -18);
        }}
      >
        <Suspense fallback={null}>
          <Scene focusedKey={GATES[focusedIndex]?.key ?? null} />
        </Suspense>
        <CameraRig focusTarget={focusTarget} />
      </Canvas>

      <Lobby focusedIndex={focusedIndex} onFocus={setFocusedIndex} online={online} />
    </div>
  );
}

/**
 * The camera stays anchored behind the character and only *turns* toward the
 * focused gate. Flying the camera to each island would be showier and much
 * worse: you would lose the character, and the character standing on the
 * platform is the thing that makes this a place rather than a menu.
 */
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";

function CameraRig({ focusTarget }: { focusTarget: THREE.Vector3 }) {
  const look = useRef(new THREE.Vector3(0, LOBBY_CAMERA.lookHeight, -18));
  const desired = useRef(new THREE.Vector3());

  useFrame(({ camera, size }, delta) => {
    const k = 1 - Math.exp(-2.6 * Math.min(delta, 0.05));
    const aspect = size.width / Math.max(size.height, 1);

    /* Portrait needs a wider lens and a smaller turn.
       The frame was composed at 16:9. On a phone held upright the same 46°
       lens crops the island to a green wall, and the same one-third turn swings
       the character — the thing that makes this a place rather than a menu —
       into the corner of the screen. Both scale with how tall the viewport is. */
    const portrait = Math.max(0, Math.min(1, (1.2 - aspect) / 0.75));
    const fov = LOBBY_CAMERA.fov + portrait * 20;
    if (Math.abs((camera as THREE.PerspectiveCamera).fov - fov) > 0.01) {
      (camera as THREE.PerspectiveCamera).fov = fov;
      camera.updateProjectionMatrix();
    }

    // Aim a third of the way toward the focused island: enough to feel like
    // the world is turning to face it, not so much that the platform swings
    // out of frame.
    desired.current.copy(focusTarget).multiplyScalar(0.33 * (1 - portrait * 0.6));
    desired.current.y = LOBBY_CAMERA.lookHeight + focusTarget.y * 0.12;
    look.current.lerp(desired.current, k);

    const sway = Math.sin(performance.now() * 0.00022) * 0.5;
    camera.position.lerp(
      new THREE.Vector3(
        look.current.x * 0.07 + sway,
        LOBBY_CAMERA.height,
        SPAWN.z + LOBBY_CAMERA.distance,
      ),
      k,
    );
    camera.lookAt(look.current);
  });

  return null;
}
