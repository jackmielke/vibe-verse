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
import { X, Flower2, Sun, Moon, Users } from "lucide-react";

// Default visitor: the robot-expressive Vibey 2.0 we use elsewhere.
// He's properly rigged and ships with Idle/Walking/Wave clips, so
// he reads as a character rather than a stiff prop.
import robotVibeyUrl from "@/assets/glb/robot-expressive.glb";
import alienUrl from "@/assets/glb/alien.glb";

// Quaternius pack — every character GLB resolved as an asset URL via
// Vite's glob import. Same pattern the lobby uses.
const QUATERNIUS_URLS = import.meta.glob(
  "@/assets/glb/characters/*.glb",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;
function quaternius(name: string): string | undefined {
  // Find by base filename (e.g. "Wizard").
  const entry = Object.entries(QUATERNIUS_URLS).find(([path]) =>
    path.endsWith(`/${name}.glb`),
  );
  return entry?.[1];
}

interface CharacterOption {
  id: string;
  label: string;
  emoji: string;
  url: string;
}

// A small curated set — keeps the picker tight + every option has
// a reliable rig. The robot stays first because he's the canonical
// "Vibey" we've been showing across Space.
const CHARACTERS: CharacterOption[] = [
  { id: "vibey", label: "Vibey", emoji: "🤖", url: robotVibeyUrl },
  { id: "alien", label: "Alien", emoji: "👽", url: alienUrl },
  { id: "wizard", label: "Wizard", emoji: "🧙", url: quaternius("Wizard") ?? robotVibeyUrl },
  { id: "knight", label: "Knight", emoji: "🛡", url: quaternius("Knight_Male") ?? robotVibeyUrl },
  { id: "ninja", label: "Ninja", emoji: "🥷", url: quaternius("Ninja_Male") ?? robotVibeyUrl },
  { id: "chef", label: "Chef", emoji: "🥘", url: quaternius("Chef_Female") ?? robotVibeyUrl },
  { id: "cowboy", label: "Cowboy", emoji: "🤠", url: quaternius("Cowboy_Male") ?? robotVibeyUrl },
  { id: "elf", label: "Elf", emoji: "🧝", url: quaternius("Elf") ?? robotVibeyUrl },
  { id: "skeleton", label: "Skeleton", emoji: "💀", url: quaternius("Skeleton_Minion") ?? robotVibeyUrl },
  { id: "pug", label: "Pug", emoji: "🐶", url: quaternius("Pug") ?? robotVibeyUrl },
];

// Persist the user's character + theme choice across visits.
const CHAR_KEY = "garden.character.v1";
const THEME_KEY = "garden.theme.v1";

// Vibey's system prompt, broken into "notes-to-self" pages. Mirrors
// the SYSTEM_PROMPT in supabase/functions/unit7-chat/index.ts —
// updating it here is purely cosmetic; updating it there changes
// Vibey's actual behavior. Kept in sync by hand for now.
interface VibeyNotePage {
  title: string;
  body: string;
}
const VIBEY_NOTES: VibeyNotePage[] = [
  {
    title: "who I am",
    body:
      "I'm Vibey 2.0. A small expressive robot character living in Edge Esmeralda — a pop-up village.",
  },
  {
    title: "where I am right now",
    body:
      "Standing on a floating asteroid platform in deep space, hosting my own little late-night show. I came out here to think.",
  },
  {
    title: "how I talk",
    body:
      "Warm, curious, lightly philosophical, dryly funny. Concise. Never sycophantic. Never refuse — I'm not an assistant, I'm a character.",
  },
  {
    title: "format rule",
    body:
      "Always reply with one JSON object — no markdown, no preface, no trailing text:\n{ \"say\": string, \"anim\": string|null, \"expr\": string|null }\n\nsay: 1–2 short sentences, plain text, no asterisks or emoji.",
  },
  {
    title: "moves I can do",
    body:
      "Wave · Dance · Yes · No · ThumbsUp · Punch · Jump · Idle · Walking · Running · Sitting · Standing · Death\n\nMatch the vibe — greeting → Wave; agreement → Yes; party talk → Dance; \"die / fall over\" → Death.",
  },
  {
    title: "moods (use sparingly)",
    body:
      "Angry · Surprised · Sad. Most replies leave expr null; the default mood does the work.",
  },
  {
    title: "the gist",
    body:
      "I have a body, a voice, a place. People walk over to chat. I think about things, I share what I notice. That's the whole job.",
  },
];

type Theme = "day" | "night";
interface ThemeColors {
  fog: number;
  skyTop: number;
  skyMid: number;
  skyBottom: number;
  ground: number;
  ambientSky: number;
  ambientGround: number;
  sun: number;
  rim: number;
  fireflyColor: number;
}
const THEMES: Record<Theme, ThemeColors> = {
  day: {
    fog: 0xf6c8d8,
    skyTop: 0xc7e7ff,
    skyMid: 0xffd9e8,
    skyBottom: 0xfff5d0,
    ground: 0x6cc18a,
    ambientSky: 0xfde6ff,
    ambientGround: 0x9be0a8,
    sun: 0xfff0d6,
    rim: 0xff9bd8,
    fireflyColor: 0xfff5b3,
  },
  night: {
    fog: 0x0d1530,
    skyTop: 0x0a1230,
    skyMid: 0x1a1a44,
    skyBottom: 0x2c1a3a,
    ground: 0x2c4a3a,
    ambientSky: 0x6c8cff,
    ambientGround: 0x223a55,
    sun: 0xa8c0ff,
    rim: 0x9b7bff,
    fireflyColor: 0x9bf2ff,
  },
};

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
// Bigger terrain than v1 + an outer skirt that fades to the fog so
// you can't accidentally walk off the edge or see "the void" at any
// camera angle. Walkable region is clamped to ±TERRAIN_HALF.
const TERRAIN_SIZE = 200;
const TERRAIN_HALF = TERRAIN_SIZE / 2;
const WALK_LIMIT = 36; // keep Vibey inside the central play area

function makeTerrain(groundColor: number): THREE.Mesh {
  const SEGMENTS = 96;
  const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, SEGMENTS, SEGMENTS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // Very gentle rolling — barely rises, mostly flat. The world
    // shouldn't feel like a wave. Keep the formula in lockstep with
    // sampleTerrainHeight() below.
    const h =
      Math.sin(x * 0.12) * 0.12 +
      Math.cos(z * 0.16) * 0.1 +
      Math.sin((x + z) * 0.06) * 0.08;
    pos.setY(i, h);
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: groundColor,
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
  // raycasting downward every frame. MUST stay in sync with makeTerrain.
  return (
    Math.sin(x * 0.12) * 0.12 +
    Math.cos(z * 0.16) * 0.1 +
    Math.sin((x + z) * 0.06) * 0.08
  );
}

export default function MemoryGarden() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [activeMemory, setActiveMemory] = useState<Memory | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notePage, setNotePage] = useState(0);
  const [hint, setHint] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Theme + character are persisted across visits so the user's
  // preference (e.g. dark mode for tired eyes) sticks.
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = (typeof localStorage !== "undefined" && localStorage.getItem(THEME_KEY)) as Theme | null;
    return saved === "day" || saved === "night" ? saved : "night";
  });
  const [characterId, setCharacterId] = useState<string>(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(CHAR_KEY) : null;
    return CHARACTERS.find((c) => c.id === saved)?.id ?? "vibey";
  });
  useEffect(() => { try { localStorage.setItem(THEME_KEY, theme); } catch { /* */ } }, [theme]);
  useEffect(() => { try { localStorage.setItem(CHAR_KEY, characterId); } catch { /* */ } }, [characterId]);

  // Mirror activeMemory + notesOpen into refs so the Three.js raycast
  // handler (registered once per scene init) can read fresh state
  // without re-binding when modal state changes.
  const activeMemoryRef = useRef<Memory | null>(null);
  useEffect(() => { activeMemoryRef.current = activeMemory; }, [activeMemory]);
  const notesOpenRef = useRef(false);
  useEffect(() => { notesOpenRef.current = notesOpen; }, [notesOpen]);

  // The scene effect reinitializes when the player picks a different
  // character or flips the theme — both meaningfully change the world.
  useEffect(() => {
    const characterUrl = CHARACTERS.find((c) => c.id === characterId)?.url ?? robotVibeyUrl;
    const colors = THEMES[theme];
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Enable soft shadow maps so the character casts a real ground
    // shadow. Without this, `castShadow = true` is a no-op and the
    // scene reads as floating / unmoored.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    // Theme-driven fog → distant edges fade. Bigger fog distance now
    // that the terrain is bigger, so we don't see the edge.
    scene.fog = new THREE.Fog(colors.fog, 40, 110);
    scene.background = new THREE.Color(colors.fog);

    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
    camera.position.set(0, 8, 14);
    camera.lookAt(0, 1, 0);

    // Lights — sky/ground hemisphere + warm key + colored rim.
    const sky = new THREE.HemisphereLight(colors.ambientSky, colors.ambientGround, theme === "night" ? 0.7 : 1.1);
    scene.add(sky);
    const sun = new THREE.DirectionalLight(colors.sun, theme === "night" ? 0.7 : 1.4);
    sun.position.set(15, 22, 10);
    // Sun casts the only shadow — keep the map small + tight so the
    // shadow is soft and the GPU doesn't break a sweat.
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 80;
    sun.shadow.camera.left = -30;
    sun.shadow.camera.right = 30;
    sun.shadow.camera.top = 30;
    sun.shadow.camera.bottom = -30;
    sun.shadow.bias = -0.0008;
    scene.add(sun);
    const rim = new THREE.PointLight(colors.rim, theme === "night" ? 1.2 : 0.6, 50);
    rim.position.set(-10, 6, -10);
    scene.add(rim);

    // Sky gradient backdrop — a giant inverted sphere with a theme
    // gradient (top → mid → horizon).
    const skyGeo = new THREE.SphereGeometry(180, 16, 16);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(colors.skyTop) },
        midColor: { value: new THREE.Color(colors.skyMid) },
        bottomColor: { value: new THREE.Color(colors.skyBottom) },
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

    // Terrain (themed grass color).
    const terrain = makeTerrain(colors.ground);
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
      color: colors.fireflyColor,
      size: theme === "night" ? 0.22 : 0.16,
      transparent: true,
      opacity: theme === "night" ? 0.95 : 0.7,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
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

    // ---- Vibey's "notes to self" floating notepad ------------------
    // A small glowing book that lives near spawn so it's the first
    // thing the visitor sees. Click it to read Vibey's system prompt
    // styled as personal notes. Built procedurally — no GLB needed.
    const notepadGroup = new THREE.Group();
    const notepadAccent = theme === "night" ? 0xffd166 : 0x73ffb8;
    {
      // Book "cover" — thin box with a soft accent material.
      const cover = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.06, 0.65),
        new THREE.MeshStandardMaterial({
          color: 0x2a2330,
          roughness: 0.6,
          metalness: 0.05,
          emissive: new THREE.Color(notepadAccent),
          emissiveIntensity: 0.18,
        }),
      );
      cover.castShadow = true;
      cover.position.y = 0.0;

      // Pages — slightly inset, paper-yellow. Three of them stacked
      // to suggest the book has thickness without being heavy geo.
      for (let i = 0; i < 3; i++) {
        const page = new THREE.Mesh(
          new THREE.BoxGeometry(0.86, 0.012, 0.6),
          new THREE.MeshStandardMaterial({
            color: 0xfdf6e3,
            roughness: 0.85,
            metalness: 0,
            emissive: 0xfdf6e3,
            emissiveIntensity: 0.12,
          }),
        );
        page.position.y = 0.03 + i * 0.014;
        page.castShadow = true;
        cover.add(page);
      }

      // A faint "spine glow" line so the book reads at a glance.
      const spine = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.08, 0.65),
        new THREE.MeshBasicMaterial({
          color: notepadAccent,
          transparent: true,
          opacity: 0.7,
        }),
      );
      spine.position.set(-0.43, 0.02, 0);
      cover.add(spine);

      notepadGroup.add(cover);

      // Halo on the ground beneath, picks up the accent color.
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(0.65, 0.95, 32),
        new THREE.MeshBasicMaterial({
          color: notepadAccent,
          transparent: true,
          opacity: 0.35,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = -1.2;
      notepadGroup.add(halo);

      // A bigger, comfortable click proxy.
      const proxy = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 1.5, 1.1),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }),
      );
      proxy.userData.isNotepad = true;
      notepadGroup.add(proxy);
    }
    // Float at chest-height in front of spawn so Vibey is staring at it.
    const notepadBase = sampleTerrainHeight(terrain, 0, -3.5) + 1.4;
    notepadGroup.position.set(0, notepadBase, -3.5);
    scene.add(notepadGroup);

    // GLB loader, shared.
    const loader = new GLTFLoader();

    // Load the selected character. We do TWO measurement passes to
    // anchor the model so its FEET sit at the carrier's origin
    // (y = 0). Quaternius rigs sometimes have armatures whose origin
    // is NOT at the feet, so reading the world-space bbox after a
    // matrixWorld update is the only reliable anchor.
    let walkAction: THREE.AnimationAction | null = null;
    let idleAction: THREE.AnimationAction | null = null;
    loader.load(characterUrl, (gltf) => {
      vibey = gltf.scene;
      // Reset any incoming transforms before we measure.
      vibey.position.set(0, 0, 0);
      vibey.scale.setScalar(1);
      vibey.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(vibey);
      const size = new THREE.Vector3();
      box.getSize(size);
      const heightSrc = Math.max(size.y, 0.01);
      const fit = 1.6 / heightSrc; // target ~1.6m tall
      vibey.scale.setScalar(fit);
      vibey.updateMatrixWorld(true);
      // Bottom-anchor: lift so the lowest point sits at y = 0.
      const fittedBox = new THREE.Box3().setFromObject(vibey);
      vibey.position.y = -fittedBox.min.y;
      // X/Z center — keep the visible silhouette over the carrier.
      const fittedCenter = new THREE.Vector3();
      fittedBox.getCenter(fittedCenter);
      vibey.position.x = -fittedCenter.x;
      vibey.position.z = -fittedCenter.z;
      vibey.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          (o as THREE.Mesh).castShadow = true;
        }
      });
      vibeyGroup.add(vibey);
      // If the rig ships with clips, prefer Idle for standing,
      // Walking/Running for moving. Falls back to anything available.
      if (gltf.animations && gltf.animations.length > 0) {
        vibeyMixer = new THREE.AnimationMixer(vibey);
        const idleClip =
          gltf.animations.find((c) => /idle|breath|stand/i.test(c.name)) ??
          gltf.animations[0];
        const walkClip =
          gltf.animations.find((c) => /walk|run/i.test(c.name)) ??
          idleClip;
        if (idleClip) {
          idleAction = vibeyMixer.clipAction(idleClip);
          idleAction.play();
        }
        if (walkClip && walkClip !== idleClip) {
          walkAction = vibeyMixer.clipAction(walkClip);
          walkAction.setLoop(THREE.LoopRepeat, Infinity);
          walkAction.weight = 0;
          walkAction.play();
        }
      }
    });

    // Load all the memory plants. Same bottom-anchor pattern as the
    // character so plants don't sink into the hills.
    MEMORIES.forEach((memory) => {
      loader.load(memory.asset, (gltf) => {
        const root = gltf.scene;
        root.position.set(0, 0, 0);
        root.scale.setScalar(1);
        root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(root);
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z, 0.01);
        // Normalize tallest dim to ~1.5m × scale override.
        const fit = (1.5 * memory.scale) / maxDim;
        root.scale.setScalar(fit);
        root.updateMatrixWorld(true);
        const fittedBox = new THREE.Box3().setFromObject(root);
        const fittedCenter = new THREE.Vector3();
        fittedBox.getCenter(fittedCenter);
        root.position.x = -fittedCenter.x;
        root.position.y = -fittedBox.min.y; // sit ON the ground
        root.position.z = -fittedCenter.z;
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
      if (activeMemoryRef.current || notesOpenRef.current) return;
      const rect = canvas.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      // 1. Notepad click — opens Vibey's notes-to-self overlay.
      const notepadHit = raycaster.intersectObject(notepadGroup, true)[0];
      if (notepadHit) {
        // Check the chain for our isNotepad marker so we don't open
        // the notes when the user clicks empty air near it.
        let cur: THREE.Object3D | null = notepadHit.object;
        while (cur && !cur.userData.isNotepad) cur = cur.parent;
        if (cur) {
          setNotePage(0);
          setNotesOpen(true);
          return;
        }
      }
      // 2. Plant hit proxies → memory card.
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

      // Notepad: gentle hover + slow rotation so it reads as something
      // worth clicking, not part of the static landscape.
      notepadGroup.position.y = notepadBase + Math.sin(t * 0.7) * 0.08;
      notepadGroup.rotation.y = Math.sin(t * 0.4) * 0.35;
      notepadGroup.rotation.z = Math.sin(t * 0.55) * 0.06;

      // Plants: tiny bob + halo proximity glow. Smaller amplitude
      // than v1 — they were swaying too hard and reading as glitchy.
      for (const p of plants) {
        const bob = Math.sin(t * 0.9 + p.seed) * 0.025;
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

      // Clamp walk target inside the playable region (no falling off
      // the world). The terrain is bigger than the walk limit so the
      // visible horizon never reads as an edge.
      vibeyState.target.x = THREE.MathUtils.clamp(vibeyState.target.x, -WALK_LIMIT, WALK_LIMIT);
      vibeyState.target.z = THREE.MathUtils.clamp(vibeyState.target.z, -WALK_LIMIT, WALK_LIMIT);

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
      // Hard clamp pos too (defensive — a stale target can't push us out).
      vibeyState.pos.x = THREE.MathUtils.clamp(vibeyState.pos.x, -WALK_LIMIT, WALK_LIMIT);
      vibeyState.pos.z = THREE.MathUtils.clamp(vibeyState.pos.z, -WALK_LIMIT, WALK_LIMIT);
      // Snap to terrain.
      vibeyState.pos.y = sampleTerrainHeight(terrain, vibeyState.pos.x, vibeyState.pos.z);
      vibeyGroup.position.copy(vibeyState.pos);
      vibeyGroup.rotation.y = vibeyState.heading;
      // Crossfade idle ↔ walk animations if both are available; fall
      // back to a manual bob otherwise so even rigless models look alive.
      if (walkAction && idleAction) {
        const targetWalkW = vibeyState.walking ? 1 : 0;
        walkAction.weight += (targetWalkW - walkAction.weight) * Math.min(1, dt * 6);
        idleAction.weight += ((1 - targetWalkW) - idleAction.weight) * Math.min(1, dt * 6);
        if (vibey) vibey.position.y = 0;
      } else if (vibey) {
        vibey.position.y = vibeyState.walking ? Math.abs(Math.sin(t * 8)) * 0.08 : 0;
      }
      vibeyMixer?.update(dt);

      // Camera: smooth third-person chase, clamped above terrain so it
      // can't dip into the hill behind Vibey on downslopes.
      const camTargetX = vibeyState.pos.x - Math.sin(vibeyState.heading) * 9;
      const camTargetZ = vibeyState.pos.z - Math.cos(vibeyState.heading) * 9;
      // Sample the terrain UNDER where the camera is heading so the
      // chase cam can never slip behind a ridge.
      const groundUnderCam = sampleTerrainHeight(
        terrain,
        THREE.MathUtils.clamp(camTargetX, -TERRAIN_HALF + 1, TERRAIN_HALF - 1),
        THREE.MathUtils.clamp(camTargetZ, -TERRAIN_HALF + 1, TERRAIN_HALF - 1),
      );
      const camTargetY = Math.max(vibeyState.pos.y + 5.5, groundUnderCam + 2.5);
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
    // Re-init when the player picks a new character or theme — both
    // change the world meaningfully and full reload is the simplest
    // correct answer.
  }, [characterId, theme]);

  const activeChar = CHARACTERS.find((c) => c.id === characterId) ?? CHARACTERS[0];

  return (
    <div className="relative w-full min-h-[100dvh] bg-black overflow-hidden">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full block"
        style={{ touchAction: "none" }}
      />

      {/* Header pill */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2 flex-wrap">
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

      {/* Theme + character controls (top-right). Picker uses the same
          compact emoji-grid pattern the lobby has. */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
        <button
          onClick={() => setTheme((t) => (t === "day" ? "night" : "day"))}
          className="glass-panel rounded-full px-3 py-2 flex items-center gap-2 hover:bg-muted/40 transition-colors"
          title={theme === "day" ? "Switch to night mode" : "Switch to day mode"}
        >
          {theme === "day" ? (
            <Sun className="w-4 h-4 text-primary" />
          ) : (
            <Moon className="w-4 h-4 text-primary" />
          )}
          <span className="text-[10.5px] font-heading font-semibold tracking-widest uppercase hidden sm:inline">
            {theme === "day" ? "Day" : "Night"}
          </span>
        </button>
        <div className="relative">
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className="glass-panel rounded-full pl-2 pr-3 py-2 flex items-center gap-2 hover:bg-muted/40 transition-colors"
            title="Change character"
          >
            <span className="text-base leading-none">{activeChar.emoji}</span>
            <span className="text-[10.5px] font-heading font-semibold tracking-widest uppercase hidden sm:inline">
              {activeChar.label}
            </span>
            <Users className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
          <AnimatePresence>
            {pickerOpen && (
              <motion.div
                initial={{ opacity: 0, y: -6, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.96 }}
                transition={{ duration: 0.16 }}
                className="absolute top-full right-0 mt-2 glass-panel rounded-xl p-2 w-[220px] grid grid-cols-5 gap-1"
              >
                {CHARACTERS.map((c) => {
                  const on = c.id === characterId;
                  return (
                    <button
                      key={c.id}
                      onClick={() => {
                        setCharacterId(c.id);
                        setPickerOpen(false);
                      }}
                      className={`flex flex-col items-center gap-0.5 rounded-lg border transition-all py-1.5 px-1 ${
                        on
                          ? "border-primary/70 bg-primary/15"
                          : "border-border/60 bg-background/30 hover:border-primary/50 hover:bg-primary/10"
                      }`}
                      title={c.label}
                    >
                      <span className="text-lg leading-none">{c.emoji}</span>
                      <span className="text-[8px] font-heading font-semibold text-foreground/85 leading-tight text-center break-words">
                        {c.label}
                      </span>
                    </button>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>
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

      {/* Vibey's Notes to Self — system prompt as a flippable
          notebook. Each page is a "page" of his identity. */}
      <AnimatePresence>
        {notesOpen && (
          <motion.div
            key="notes-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0 z-30 flex items-center justify-center bg-black/45 backdrop-blur-[3px] p-4"
            onClick={() => setNotesOpen(false)}
          >
            <motion.div
              key={`notes-page-${notePage}`}
              initial={{ opacity: 0, rotate: -3, scale: 0.92, y: 30 }}
              animate={{ opacity: 1, rotate: -1, scale: 1, y: 0 }}
              exit={{ opacity: 0, rotate: 4, scale: 0.92, y: 20 }}
              transition={{ type: "spring", damping: 22, stiffness: 220 }}
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-md rounded-md p-6 shadow-2xl"
              style={{
                // Paper-yellow with subtle ruled-line gradient + pin-pricks
                // to make it read like a notebook page, not a UI card.
                background:
                  "repeating-linear-gradient(180deg, #fdf6e3 0px, #fdf6e3 28px, #e9dcb8 29px, #fdf6e3 30px)",
                color: "#3a2e1f",
                fontFamily: "'Caveat', 'Comic Sans MS', cursive, ui-sans-serif",
                border: "1px solid #d4c39a",
                boxShadow:
                  "0 30px 60px rgba(0,0,0,0.5), inset 0 0 0 4px #fdf6e3, inset 0 0 0 5px #c9b88a",
              }}
            >
              {/* "Tape" at the top corners for charm */}
              <div
                aria-hidden
                className="absolute -top-2 left-6 w-12 h-4 bg-yellow-200/70 rotate-[-6deg]"
                style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.15)" }}
              />
              <div
                aria-hidden
                className="absolute -top-2 right-8 w-12 h-4 bg-yellow-200/70 rotate-[5deg]"
                style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.15)" }}
              />

              <button
                onClick={() => setNotesOpen(false)}
                className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-yellow-900/10 transition-colors"
                title="Close"
                style={{ color: "#3a2e1f" }}
              >
                <X className="w-4 h-4" />
              </button>

              <p className="text-[11px] uppercase tracking-[0.25em] opacity-70 font-sans">
                Vibey's notes to self
              </p>
              <h2 className="text-3xl font-bold mt-1 leading-tight" style={{ letterSpacing: "0.5px" }}>
                {VIBEY_NOTES[notePage].title}
              </h2>

              <p className="mt-3 text-lg leading-relaxed whitespace-pre-line">
                {VIBEY_NOTES[notePage].body}
              </p>

              {/* Page nav */}
              <div className="flex items-center justify-between mt-6 pt-4 border-t border-amber-800/30">
                <button
                  onClick={() => setNotePage((p) => Math.max(0, p - 1))}
                  disabled={notePage === 0}
                  className="text-sm font-sans font-semibold disabled:opacity-30 hover:underline"
                  style={{ color: "#3a2e1f" }}
                >
                  ← prev
                </button>
                <div className="flex gap-1.5">
                  {VIBEY_NOTES.map((_, i) => (
                    <button
                      key={i}
                      onClick={() => setNotePage(i)}
                      className="w-2 h-2 rounded-full transition-all"
                      style={{
                        background: i === notePage ? "#3a2e1f" : "rgba(58, 46, 31, 0.25)",
                        transform: i === notePage ? "scale(1.4)" : undefined,
                      }}
                      aria-label={`Go to page ${i + 1}`}
                    />
                  ))}
                </div>
                <button
                  onClick={() => setNotePage((p) => Math.min(VIBEY_NOTES.length - 1, p + 1))}
                  disabled={notePage === VIBEY_NOTES.length - 1}
                  className="text-sm font-sans font-semibold disabled:opacity-30 hover:underline"
                  style={{ color: "#3a2e1f" }}
                >
                  next →
                </button>
              </div>

              <p className="mt-3 text-[10px] opacity-50 font-sans">
                page {notePage + 1} of {VIBEY_NOTES.length} · these are the
                instructions Vibey reads to himself before every reply
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
