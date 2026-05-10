/**
 * MemoryGarden — Vibey's memory garden.
 *
 * A small cozy 3D scene where each plant is one of Vibey's memories.
 * You walk Vibey around with click-to-move (or WASD if you must),
 * and clicking a plant opens a soft animated card with the memory.
 *
 * Design notes:
 *  - Pure Three.js, no Mapbox — this is its own world, not anchored
 *    to real geography. Lighter to load, simpler to compose.
 *  - RSI-friendly: click-to-move is primary. WASD is bonus.
 *  - Pastel sky + soft fog + drifting particles for "this is a dream"
 *    energy. Plants gently bob so the world feels alive.
 *  - Memories are seeded in a small constant array. Easy to expand,
 *    and a clear path later to swap for Supabase-backed user-planted
 *    memories.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { motion, AnimatePresence } from "framer-motion";
import { X, Flower2 } from "lucide-react";

// Vibey is the visitor.
import vibeyUrl from "@/assets/glb/vibey.glb";

// Plants we'll use as memory markers. Picked for readable variety —
// one tree, a few flowers, a mushroom, a berry bush, a sunflower
// stand-in (Flower_4 reads as a tall yellow bloom).
import sunflowerUrl from "@/assets/glb/kits/crops/Flower_4.glb";
import berryUrl from "@/assets/glb/kits/crops/BushBerries_4.glb";
import mushroomUrl from "@/assets/glb/kits/crops/Mushroom_3.glb";
import pumpkinUrl from "@/assets/glb/kits/crops/Pumpkin_4.glb";
import flowerSmallUrl from "@/assets/glb/kits/crops/Flower_2.glb";
import tomatoUrl from "@/assets/glb/kits/crops/Tomato_4.glb";
import bushUrl from "@/assets/glb/nature/Bush2.glb";
import treeUrl from "@/assets/glb/nature/Tree3.glb";

interface Memory {
  id: string;
  title: string;
  emoji: string;
  text: string;
  asset: string; // GLB URL
  color: string; // accent hex
  position: [number, number]; // (x, z) in world meters
  scale: number; // size override
  plantedAt: string; // human-readable date
}

// Each memory is hand-placed in a soft ring around the spawn point.
// The (x,z) coords are meters from origin; y is sampled from terrain.
const MEMORIES: Memory[] = [
  {
    id: "first-village",
    title: "The first village",
    emoji: "🗺️",
    text:
      "The day Healdsburg first appeared on the map with real 3D terrain. " +
      "Plaza, Raven, CraftWork — they were just pins, but the camera flew in and " +
      "for a second it felt like a whole town existed in here.",
    asset: treeUrl,
    color: "#73ffb8",
    position: [-9, -8],
    scale: 1.3,
    plantedAt: "Apr 2026",
  },
  {
    id: "vibey-2-arrives",
    title: "Vibey 2.0 lands",
    emoji: "🤖",
    text:
      "Outer Space went live. A floating asteroid, knowledge in the sky, " +
      "real chat — the moment Vibey got a body and a voice and a place to live.",
    asset: sunflowerUrl,
    color: "#ffd166",
    position: [10, -6],
    scale: 1.4,
    plantedAt: "May 2026",
  },
  {
    id: "pirate-rescue",
    title: "The pirate texture rescue",
    emoji: "🏴‍☠️",
    text:
      "Hours of pirates rendering pure white. Turned out assimp stripped the " +
      "shared atlas. gltf-pipeline saved them. Worth it for one good laugh.",
    asset: mushroomUrl,
    color: "#a78bfa",
    position: [-12, 4],
    scale: 1.5,
    plantedAt: "Apr 2026",
  },
  {
    id: "patagonia",
    title: "Patagonia residency",
    emoji: "🏔️",
    text:
      "Two months of co-living in the south. The seed for 'what if a community " +
      "lived inside the same tool they use every day.' The roots of all this.",
    asset: bushUrl,
    color: "#6aa8ff",
    position: [12, 6],
    scale: 1.1,
    plantedAt: "Oct–Nov 2025",
  },
  {
    id: "spotify-connected",
    title: "Music in space",
    emoji: "🎶",
    text:
      "PKCE OAuth, scopes, the Time Portal — the day the lobby got a real " +
      "soundtrack. 'Brazil' on loop while the stars rendered in.",
    asset: flowerSmallUrl,
    color: "#ff8ad6",
    position: [3, 11],
    scale: 1.3,
    plantedAt: "May 2026",
  },
  {
    id: "live-vibey",
    title: "Live Vibey hooked up",
    emoji: "🌐",
    text:
      "Streaming SSE from the production endpoint right into the Space chat. " +
      "Markdown, autoscroll, multi-line input — it finally felt like a real " +
      "conversation, not a demo.",
    asset: tomatoUrl,
    color: "#ff7e8a",
    position: [-4, 12],
    scale: 1.3,
    plantedAt: "May 2026",
  },
  {
    id: "vibe-coin",
    title: "$VIBE on the lobby wall",
    emoji: "🪙",
    text:
      "GeckoTerminal pool data, a calculator, a heartbeat dot. The community " +
      "could see the vibe in dollars and cents now. Strange and lovely.",
    asset: pumpkinUrl,
    color: "#ffb24a",
    position: [-13, -2],
    scale: 1.2,
    plantedAt: "May 2026",
  },
  {
    id: "edge-island",
    title: "Edge Island floats up",
    emoji: "🏝️",
    text:
      "272 MB of dream. The first time the floating island bobbed above the " +
      "village I closed my eyes and pretended I'd built Howl's castle.",
    asset: berryUrl,
    color: "#73ffb8",
    position: [13, -3],
    scale: 1.2,
    plantedAt: "Apr 2026",
  },
];

// Click-to-move target marker — a small ring on the ground.
function makeTargetRing(): THREE.Mesh {
  const geo = new THREE.RingGeometry(0.6, 0.85, 32);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x73ffb8,
    transparent: true,
    opacity: 0.0,
    side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.01;
  return m;
}

// Soft hilly terrain — a plane warped by a gentle sine surface so
// the garden has shape but Vibey can still walk anywhere.
function makeTerrain(): THREE.Mesh {
  const SIZE = 80;
  const SEGMENTS = 64;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // Two interfering sine waves → gentle rolling hills, never steep.
    const h =
      Math.sin(x * 0.18) * 0.35 +
      Math.cos(z * 0.22) * 0.3 +
      Math.sin((x + z) * 0.08) * 0.25;
    pos.setY(i, h);
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x6cc18a,
    roughness: 0.95,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.userData.kind = "ground";
  return mesh;
}

// Sample terrain height at (x, z) by reading from the plane geometry.
// Used to pin plants and Vibey to the ground.
function sampleTerrainHeight(terrain: THREE.Mesh, x: number, z: number): number {
  // Cheap re-derive of the same surface formula. Faster + simpler than
  // raycasting downward every frame.
  return (
    Math.sin(x * 0.18) * 0.35 +
    Math.cos(z * 0.22) * 0.3 +
    Math.sin((x + z) * 0.08) * 0.25
  );
}

export default function MemoryGarden() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [activeMemory, setActiveMemory] = useState<Memory | null>(null);
  const [hint, setHint] = useState(true);
  // Mirror activeMemory into a ref so the Three.js raycast handler
  // (registered once) can read fresh state without re-binding.
  const activeMemoryRef = useRef<Memory | null>(null);
  useEffect(() => { activeMemoryRef.current = activeMemory; }, [activeMemory]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const scene = new THREE.Scene();
    // Soft pastel fog → distant edges fade, dreamy.
    scene.fog = new THREE.Fog(0xf6c8d8, 28, 70);

    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
    camera.position.set(0, 8, 14);
    camera.lookAt(0, 1, 0);

    // Lights — soft sky/sun pair.
    const sky = new THREE.HemisphereLight(0xfde6ff, 0x9be0a8, 1.1);
    scene.add(sky);
    const sun = new THREE.DirectionalLight(0xfff0d6, 1.4);
    sun.position.set(15, 22, 10);
    scene.add(sun);
    const rim = new THREE.PointLight(0xff9bd8, 0.6, 40);
    rim.position.set(-10, 6, -10);
    scene.add(rim);

    // Sky gradient backdrop — a giant inverted sphere with a soft
    // pastel gradient. Cheaper than a real skybox texture.
    const skyGeo = new THREE.SphereGeometry(120, 16, 16);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0xc7e7ff) },
        midColor: { value: new THREE.Color(0xffd9e8) },
        bottomColor: { value: new THREE.Color(0xfff5d0) },
      },
      vertexShader: `
        varying vec3 vWorld;
        void main() {
          vWorld = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 midColor;
        uniform vec3 bottomColor;
        varying vec3 vWorld;
        void main() {
          float h = normalize(vWorld).y * 0.5 + 0.5;
          vec3 c = mix(bottomColor, midColor, smoothstep(0.0, 0.55, h));
          c = mix(c, topColor, smoothstep(0.55, 1.0, h));
          gl_FragColor = vec4(c, 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const skyDome = new THREE.Mesh(skyGeo, skyMat);
    scene.add(skyDome);

    // Terrain.
    const terrain = makeTerrain();
    scene.add(terrain);

    // Drifting fireflies — small glowing points that bob in place.
    const fireflyCount = 90;
    const fireflyGeo = new THREE.BufferGeometry();
    const fireflyPos = new Float32Array(fireflyCount * 3);
    const fireflySeed = new Float32Array(fireflyCount);
    for (let i = 0; i < fireflyCount; i++) {
      const r = 6 + Math.random() * 18;
      const a = Math.random() * Math.PI * 2;
      fireflyPos[i * 3 + 0] = Math.cos(a) * r;
      fireflyPos[i * 3 + 1] = 1 + Math.random() * 4;
      fireflyPos[i * 3 + 2] = Math.sin(a) * r;
      fireflySeed[i] = Math.random() * Math.PI * 2;
    }
    fireflyGeo.setAttribute("position", new THREE.BufferAttribute(fireflyPos, 3));
    const fireflyMat = new THREE.PointsMaterial({
      color: 0xfff5b3,
      size: 0.18,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const fireflies = new THREE.Points(fireflyGeo, fireflyMat);
    scene.add(fireflies);

    // Plant carriers + per-plant glow halos. Each memory becomes one
    // entry here so the click handler can map a hit back to a memory.
    interface PlantEntry {
      memory: Memory;
      group: THREE.Group; // root that holds the GLB and bobs
      hitProxy: THREE.Mesh; // invisible-ish cylinder used for raycasting
      halo: THREE.Mesh;
      basePosY: number;
      seed: number; // randomized per plant for asynchronous bobbing
    }
    const plants: PlantEntry[] = [];

    // Vibey carrier — initialized after the GLB loads.
    const vibeyGroup = new THREE.Group();
    scene.add(vibeyGroup);
    let vibey: THREE.Group | null = null;
    let vibeyMixer: THREE.AnimationMixer | null = null;
    const vibeyState = {
      pos: new THREE.Vector3(0, 0, 0),
      target: new THREE.Vector3(0, 0, 0),
      heading: 0, // radians
      walking: false,
    };

    const targetRing = makeTargetRing();
    scene.add(targetRing);

    // GLB loader, shared.
    const loader = new GLTFLoader();

    // Load Vibey.
    loader.load(vibeyUrl, (gltf) => {
      vibey = gltf.scene;
      // Normalize size so Vibey reads as ~1.6 meters tall regardless
      // of the source GLB's scale.
      const box = new THREE.Box3().setFromObject(vibey);
      const size = new THREE.Vector3();
      box.getSize(size);
      const fit = 1.6 / Math.max(size.y, 0.01);
      vibey.scale.setScalar(fit);
      // Re-center so the model's feet sit on the carrier's origin.
      const center = new THREE.Vector3();
      box.getCenter(center);
      vibey.position.x = -center.x * fit;
      vibey.position.y = (-center.y + size.y / 2) * fit;
      vibey.position.z = -center.z * fit;
      vibey.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          (o as THREE.Mesh).castShadow = true;
        }
      });
      vibeyGroup.add(vibey);
      // If Vibey ships with an Idle clip, play it.
      if (gltf.animations && gltf.animations.length > 0) {
        vibeyMixer = new THREE.AnimationMixer(vibey);
        const idle = gltf.animations.find((c) => /idle|breath/i.test(c.name)) ?? gltf.animations[0];
        if (idle) vibeyMixer.clipAction(idle).play();
      }
    });

    // Load all the memory plants.
    MEMORIES.forEach((memory) => {
      loader.load(memory.asset, (gltf) => {
        const root = gltf.scene;
        const box = new THREE.Box3().setFromObject(root);
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z, 0.01);
        // Plants are normalized to ~1.5m tall × scale override — gives
        // each memory its own visual weight.
        const fit = (1.5 * memory.scale) / maxDim;
        root.scale.setScalar(fit);
        const center = new THREE.Vector3();
        box.getCenter(center);
        root.position.x = -center.x * fit;
        root.position.y = (-center.y + size.y / 2) * fit;
        root.position.z = -center.z * fit;
        root.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            (o as THREE.Mesh).castShadow = true;
          }
        });

        const group = new THREE.Group();
        const [px, pz] = memory.position;
        const py = sampleTerrainHeight(terrain, px, pz);
        group.position.set(px, py, pz);
        group.add(root);

        // Glowing halo at the plant's base — picks up the memory's
        // accent color so the garden glows in mixed pastels.
        const haloMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(memory.color),
          transparent: true,
          opacity: 0.0,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const halo = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.45, 32), haloMat);
        halo.rotation.x = -Math.PI / 2;
        halo.position.y = 0.02;
        group.add(halo);

        // Invisible-ish cylinder for raycasting — a comfortable click
        // target that's bigger than the mesh so the user doesn't have
        // to pixel-hunt for tiny berries.
        const proxy = new THREE.Mesh(
          new THREE.CylinderGeometry(1.0, 1.0, 2.4, 12),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }),
        );
        proxy.position.y = 1.2;
        proxy.userData.memoryId = memory.id;
        group.add(proxy);

        scene.add(group);
        plants.push({
          memory,
          group,
          hitProxy: proxy,
          halo,
          basePosY: py,
          seed: Math.random() * Math.PI * 2,
        });
      });
    });

    // Click → either pick a plant or set a walk target.
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    const handlePointer = (clientX: number, clientY: number) => {
      if (activeMemoryRef.current) return; // ignore while modal is open
      const rect = canvas.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      // First check plant hit proxies.
      const hitProxies = plants.map((p) => p.hitProxy);
      const plantHit = raycaster.intersectObjects(hitProxies, false)[0];
      if (plantHit) {
        const id = (plantHit.object as THREE.Mesh).userData.memoryId as string;
        const memory = MEMORIES.find((m) => m.id === id);
        if (memory) setActiveMemory(memory);
        return;
      }
      // Fallback: ground click → walk target.
      const groundHit = raycaster.intersectObject(terrain, false)[0];
      if (groundHit) {
        vibeyState.target.copy(groundHit.point);
        vibeyState.walking = true;
        targetRing.position.set(groundHit.point.x, groundHit.point.y + 0.02, groundHit.point.z);
        (targetRing.material as THREE.MeshBasicMaterial).opacity = 0.9;
        setHint(false);
      }
    };

    const onClick = (e: MouseEvent) => handlePointer(e.clientX, e.clientY);
    const onTouch = (e: TouchEvent) => {
      if (!e.touches[0]) return;
      handlePointer(e.touches[0].clientX, e.touches[0].clientY);
    };
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("touchstart", onTouch, { passive: true });

    // Optional WASD for keyboard users — but click-to-move is primary.
    const keys: Record<string, boolean> = {};
    const onKeyDown = (e: KeyboardEvent) => {
      keys[e.key.toLowerCase()] = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keys[e.key.toLowerCase()] = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // Resize handling.
    const resize = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Main loop.
    const clock = new THREE.Clock();
    let raf = 0;
    const tick = () => {
      const dt = Math.min(0.05, clock.getDelta());
      const t = clock.elapsedTime;

      // Plants: gentle bob + halo proximity glow.
      for (const p of plants) {
        const bob = Math.sin(t * 1.4 + p.seed) * 0.08;
        p.group.position.y = p.basePosY + bob;
        // Halo glows brighter when Vibey is nearby (proximity hint).
        const dx = p.group.position.x - vibeyState.pos.x;
        const dz = p.group.position.z - vibeyState.pos.z;
        const dist = Math.hypot(dx, dz);
        const proximity = THREE.MathUtils.clamp(1 - dist / 5, 0, 1);
        const targetOpacity = 0.15 + proximity * 0.55;
        const haloMat = p.halo.material as THREE.MeshBasicMaterial;
        haloMat.opacity += (targetOpacity - haloMat.opacity) * Math.min(1, dt * 4);
        p.halo.scale.setScalar(0.95 + proximity * 0.25 + Math.sin(t * 2 + p.seed) * 0.04);
      }

      // Fireflies bob in place.
      const positions = fireflies.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < fireflyCount; i++) {
        const baseY = 1 + Math.sin(t * 0.6 + fireflySeed[i]) * 1.6;
        const drift = Math.sin(t * 0.3 + i) * 0.4;
        positions.array[i * 3 + 1] = baseY + drift;
      }
      positions.needsUpdate = true;

      // Keyboard nudge — translate WASD into a delta target.
      const kx = (keys["d"] ? 1 : 0) - (keys["a"] ? 1 : 0);
      const kz = (keys["s"] ? 1 : 0) - (keys["w"] ? 1 : 0);
      if (kx !== 0 || kz !== 0) {
        vibeyState.target.x = vibeyState.pos.x + kx * 4;
        vibeyState.target.z = vibeyState.pos.z + kz * 4;
        vibeyState.walking = true;
        targetRing.visible = false;
      } else {
        targetRing.visible = true;
      }

      // Move Vibey toward target with a soft ease.
      if (vibeyState.walking) {
        const dx = vibeyState.target.x - vibeyState.pos.x;
        const dz = vibeyState.target.z - vibeyState.pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.15) {
          vibeyState.walking = false;
          // Fade the target ring out.
          const m = targetRing.material as THREE.MeshBasicMaterial;
          m.opacity += (0 - m.opacity) * Math.min(1, dt * 3);
        } else {
          const speed = 4.5; // m/s
          const step = Math.min(speed * dt, dist);
          vibeyState.pos.x += (dx / dist) * step;
          vibeyState.pos.z += (dz / dist) * step;
          // Heading: turn toward motion.
          const targetHeading = Math.atan2(dx, dz);
          const dh = ((targetHeading - vibeyState.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          vibeyState.heading += dh * Math.min(1, dt * 8);
        }
      }
      // Snap to terrain.
      vibeyState.pos.y = sampleTerrainHeight(terrain, vibeyState.pos.x, vibeyState.pos.z);
      vibeyGroup.position.copy(vibeyState.pos);
      vibeyGroup.rotation.y = vibeyState.heading;
      // Subtle bob if walking.
      if (vibey) {
        vibey.position.y = vibeyState.walking ? Math.abs(Math.sin(t * 8)) * 0.08 : 0;
      }
      vibeyMixer?.update(dt);

      // Camera: smooth third-person chase.
      const camTargetX = vibeyState.pos.x - Math.sin(vibeyState.heading) * 9;
      const camTargetZ = vibeyState.pos.z - Math.cos(vibeyState.heading) * 9;
      const camTargetY = vibeyState.pos.y + 5.5;
      camera.position.x += (camTargetX - camera.position.x) * Math.min(1, dt * 2);
      camera.position.y += (camTargetY - camera.position.y) * Math.min(1, dt * 2);
      camera.position.z += (camTargetZ - camera.position.z) * Math.min(1, dt * 2);
      camera.lookAt(vibeyState.pos.x, vibeyState.pos.y + 1.0, vibeyState.pos.z);

      // Fade target ring opacity smoothly when not walking.
      if (!vibeyState.walking) {
        const m = targetRing.material as THREE.MeshBasicMaterial;
        m.opacity += (0 - m.opacity) * Math.min(1, dt * 3);
      }

      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("touchstart", onTouch as EventListener);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      ro.disconnect();
      renderer.dispose();
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
    };
  }, []);

  return (
    <div className="relative w-full min-h-[100dvh] bg-black overflow-hidden">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full block"
        style={{ touchAction: "none" }}
      />

      {/* Header pill */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2">
        <div className="glass-panel rounded-full px-3 py-2 flex items-center gap-2">
          <Flower2 className="w-4 h-4 text-primary" />
          <span className="text-[11px] font-heading font-semibold tracking-widest uppercase">
            Vibey's Memory Garden
          </span>
        </div>
        <div className="hidden sm:block glass-panel rounded-full px-3 py-2 text-[11px] text-muted-foreground">
          {MEMORIES.length} memories planted
        </div>
      </div>

      {/* Tutorial hint — fades after first interaction */}
      <AnimatePresence>
        {hint && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.4 }}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 glass-panel rounded-full px-4 py-2.5 text-xs text-foreground/85 flex items-center gap-2 max-w-[90vw]"
          >
            <span className="text-base">🪻</span>
            <span>Click anywhere to walk · click a plant to read its memory</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Memory card overlay */}
      <AnimatePresence>
        {activeMemory && (
          <motion.div
            key="memory-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0 z-20 flex items-end md:items-center justify-center bg-black/30 backdrop-blur-[2px] p-4"
            onClick={() => setActiveMemory(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 30 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: 16 }}
              transition={{ type: "spring", damping: 22, stiffness: 260 }}
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-md rounded-2xl glass-panel p-5"
              style={{
                border: `1px solid ${activeMemory.color}88`,
                boxShadow: `0 30px 80px rgba(0,0,0,0.6), 0 0 60px ${activeMemory.color}33`,
              }}
            >
              <button
                onClick={() => setActiveMemory(null)}
                className="absolute top-3 right-3 p-1.5 rounded-md hover:bg-muted/40 transition-colors"
                title="Close"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.08, duration: 0.25 }}
                className="flex items-baseline gap-3 mb-1"
              >
                <span
                  className="text-3xl"
                  style={{ filter: `drop-shadow(0 0 8px ${activeMemory.color}aa)` }}
                >
                  {activeMemory.emoji}
                </span>
                <h2 className="font-heading text-lg font-bold tracking-tight text-foreground">
                  {activeMemory.title}
                </h2>
              </motion.div>
              <p className="text-[10px] uppercase tracking-widest opacity-60 mb-3">
                Planted · {activeMemory.plantedAt}
              </p>
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.16, duration: 0.3 }}
                className="text-sm text-foreground/90 leading-relaxed mb-4"
              >
                {activeMemory.text}
              </motion.p>
              <button
                onClick={() => setActiveMemory(null)}
                className="w-full px-3 py-2 rounded-lg text-sm font-semibold transition-colors"
                style={{
                  background: `${activeMemory.color}33`,
                  border: `1px solid ${activeMemory.color}88`,
                  color: "#eaf3ff",
                }}
              >
                Keep walking
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
