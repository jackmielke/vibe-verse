/**
 * City — Vibe City, the explorable neon district.
 *
 * A procedurally generated night city you fly through with a jetpack.
 * This is the seed of the "build a city and keep adding stuff to it"
 * world: every block, rooftop and landing pad is generated from a
 * deterministic seed, so the city is stable across visits and there is
 * no heavy GLB to download — the whole district is geometry we build
 * in code, plus one small Quaternius character.
 *
 * Pure Three.js (no Mapbox, no r3f) — same pattern as Museum and
 * MemoryGarden, which keeps it WebXR-compatible via lib/webxr.ts.
 *
 * Locomotion (third-person, Mario-style):
 *   WASD / arrows — move (camera-relative)   Shift — run
 *   Space (hold)  — jetpack thrust            drag — orbit camera
 *   scroll        — zoom
 *
 * The pilot can land on any rooftop — buildings carry real AABB
 * collision, and the tallest towers get glowing landing pads as an
 * invitation. Extend the city by tweaking the constants in the
 * "City plan" section below; everything regenerates from the seed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { Rocket } from "lucide-react";
import { enableVR } from "@/lib/webxr";
import { buildCardboardIsland, VIBEVERSE_POSTER_URL } from "@/components/city/cardboardIsland";
import VibeAccountCard from "@/components/VibeAccountCard";
import VibeArc from "@/components/VibeArc";
import iridescentArcUrl from "@/assets/glb/iridescent-arc.glb";
import { buildMoon } from "@/components/city/moon";
import { buildMars } from "@/components/city/mars";
import { buildTradersGalaxy } from "@/components/city/tradersGalaxy";
import { buildSkyIslands } from "@/components/city/skyIslands";
import { buildSkyGames, type SkyGamesWorld, type SkyGameKey } from "@/components/city/skyGames";
import { buildKart } from "@/components/city/karts";
import { buildNinjaPalaceShow, NINJA_CAST } from "@/components/city/ninjaPalace";
import {
  GRAVITY,
  WALK_SPEED,
  RUN_SPEED,
  FLY_SPEED,
  FLY_RUN_SPEED,
  JUMP_VELOCITY,
  MAX_RISE,
  MAX_FALL,
  PLAYER_RADIUS,
} from "@/lib/worldPhysics";
import { VibeEconomy } from "@/lib/vibeEconomy";

import { createAgentResidents, type AgentResidents } from "@/components/city/agentResidents";
import { createAgentRosterBoard, type RosterAgent } from "@/components/city/agentRosterBoard";
import { createVibeyNpc } from "@/components/city/vibeyNpc";

import TouchControls, { type TouchMove } from "@/components/city/TouchControls";
import {
  createMultiplayer,
  EMOTE_EMOJI,
  makeChatBubbleSprite,
  CHAT_BUBBLE_DURATION,
  type ChatMessage,
  type EmoteName,
  type Multiplayer,
} from "@/components/city/multiplayer";
import { createCitySounds, type CitySounds } from "@/lib/citySounds";
import { startVibeyVoice, type VibeyVoiceSession } from "@/lib/vibeyVoice";
import { supabase } from "@/integrations/supabase/client";
import {
  HAT_CATALOG,
  FLAME_CATALOG,
  JETPACK_CATALOG,
  saveEquippedHat,
  saveEquippedFlame,
  saveEquippedJetpack,
} from "@/components/city/cosmetics";
import { setActiveCharacter } from "@/hooks/use-active-character";
import VibeMakerPanel from "@/components/VibeMakerPanel";
import NameEntryModal from "@/components/city/NameEntryModal";
import { ArcadeModal } from "@/components/city/ArcadeModal";
import { PhotoGalleryModal } from "@/components/city/PhotoGalleryModal";
import CityEntryScreen, { generateFunName } from "@/components/city/CityEntryScreen";
import { generateCharacterName } from "@/lib/character-naming";
import { CHARACTERS as UNIVERSAL_CHARACTERS } from "@/lib/characters";
// EchoVoiceAgent now lives inside PersonChatPanel as a subtle mic button
import PersonChatPanel, { type PersonTarget } from "@/components/PersonChatPanel";
import {
  createSpawnMesh,
  updateSpawns,
  type IslandSpawnRow,
} from "@/components/city/islandSpawns";
import { buildUnderground, makeNinjaPortal, type UndergroundWorld } from "@/components/city/underground";
import { registerPOI } from "@/world/worldIndex";

// Universal playable character catalog. Keep City/Edge Island aligned
// with /character-select, /profile, and the global active-character hook.
const CHARACTERS = UNIVERSAL_CHARACTERS.map((c) => ({
  name: c.id,
  url: c.url,
  label: c.label,
  blurb: c.blurb,
  accent: c.accent,
}));

// Honor a character picked in the Lobby; fall back to the soldier.
function initialCharacter(): string {
  const stored =
    localStorage.getItem("city.character") ?? localStorage.getItem("lobby.character");
  if (stored && CHARACTERS.some((c) => c.name === stored)) return stored;
  if (CHARACTERS.some((c) => c.name === "BlueSoldier_Male")) return "BlueSoldier_Male";
  return CHARACTERS[0]?.name ?? "";
}

// ------------------------------------------------------------------
// City plan — tune these and the whole district regenerates.
// ------------------------------------------------------------------
const CITY_SEED = "vibe-city-v1";
const GRID = 9; // city is GRID x GRID cells
const BLOCK = 28; // buildable block size (m)
const STREET = 12; // street width between blocks (m)
const PITCH = BLOCK + STREET; // cell-to-cell distance
const CITY_HALF = (GRID * PITCH) / 2;
const WINDOW_TILE = 12.8; // world meters covered by one window-texture tile
const PAD_MIN_HEIGHT = 48; // towers taller than this get a landing pad

// Cardboard Island — the kids' world floating east of the district.
const ISLAND_X = 330;
const ISLAND_Z = -30;
const ISLAND_TOP = 120;

// The Moon — a small landable celestial body just north of the island,
// hanging higher in the sky so the silhouette reads from the plaza.
const MOON_X = 360;
const MOON_Z = -200;
const MOON_TOP = 175;

// A second moon, hanging on the opposite side of the city so the
// skyline has more than one celestial neighbour.
const MOON2_X = -260;
const MOON2_Z = -240;
const MOON2_TOP = 205;

// Mars — much farther out (a real trek with the jetpack). Home to a
// small clan of green gremlins that loop around the landing pad.
const MARS_X = 820;
const MARS_Z = -640;
const MARS_TOP = 240;

// Trader Joe's Galaxy — a floating archipelago of TJ's outposts,
// placed off in the opposite quadrant from Mars so the skyline reads
// uniquely from each world.
const TJS_X = -780;
const TJS_Z = 540;
const TJS_TOP = 120;
const TJS_ISLET_R = 22; // landing tolerance for fast-travel detection

// Gremlin Mines — a pocket dimension carved 300m straight down. You
// reach it through one of the two ninja portals (Edge Island + City).
const UNDER_X = 0;
const UNDER_Y = -300;
const UNDER_Z = 0;
// Ninja portal placements: behind the plaza on Edge Island, and in
// a dim alley between two city towers.
const NINJA_PORTAL_ISLAND = { x: ISLAND_X - 22, y: ISLAND_TOP, z: ISLAND_Z - 28 };
const NINJA_PORTAL_CITY = { x: -40, y: 0, z: -54 };


// Movement feel — the canonical constants live in worldPhysics so
// every world (City, Island Explorer, …) shares the exact same body.
const ZIP_SPEED = 10; // zipline glide, m/s
const THRUST = 50; // jetpack accel (net climb = THRUST - GRAVITY)

// Talkable NPCs: the island icons plus the five Palace housemates.
type NpcKey = "vibey" | "jerry" | "kage" | "ember" | "miso" | "pixel" | "shuri";
const MIN_CAM_DIST = 4.5;
const MAX_CAM_DIST = 750; // pinch all the way out to a god view

interface BuildingBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  base: number; // bottom of the solid column (>0 for floating worlds)
  height: number; // top of the solid column
}

// Deterministic rng — same pattern as Museum, so the city never
// reshuffles between visits.
function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------
// Window textures — one facade canvas (dark, with unlit + lit panes)
// and one emissive canvas (lit panes only) per variant. The top-left
// corner pixel stays pure facade so roof faces can sample it.
// ------------------------------------------------------------------
function makeWindowTextures(
  variantSeed: string,
  opts: {
    facade: string;
    lit: string;
    litChance: number; // 0 for daytime facades — windows become glass
    windowColor: string;
    roofColor: string;
  },
): { map: THREE.CanvasTexture; emissiveMap: THREE.CanvasTexture } {
  const { facade, lit, litChance, windowColor, roofColor } = opts;
  const S = 512;
  const cols = 16;
  const rows = 16;
  const cell = S / cols;
  const r = rng(variantSeed);

  const base = document.createElement("canvas");
  base.width = base.height = S;
  const bctx = base.getContext("2d")!;
  const emi = document.createElement("canvas");
  emi.width = emi.height = S;
  const ectx = emi.getContext("2d")!;

  bctx.fillStyle = facade;
  bctx.fillRect(0, 0, S, S);
  ectx.fillStyle = "#000000";
  ectx.fillRect(0, 0, S, S);

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = cx * cell + cell * 0.22;
      const y = cy * cell + cell * 0.2;
      const w = cell * 0.56;
      const h = cell * 0.6;
      const isLit = r() < litChance;
      if (isLit) {
        const dim = 0.55 + r() * 0.45;
        bctx.fillStyle = lit;
        bctx.globalAlpha = dim;
        bctx.fillRect(x, y, w, h);
        bctx.globalAlpha = 1;
        ectx.fillStyle = lit;
        ectx.globalAlpha = dim;
        ectx.fillRect(x, y, w, h);
        ectx.globalAlpha = 1;
      } else {
        bctx.fillStyle = windowColor;
        bctx.fillRect(x, y, w, h);
      }
    }
  }
  // Reserved roof-colored corner texel for roofs/floors — slightly
  // lighter than the facade so rooftops read from above.
  bctx.fillStyle = roofColor;
  bctx.fillRect(0, 0, 4, 4);
  ectx.fillStyle = "#000";
  ectx.fillRect(0, 0, 4, 4);

  const mk = (c: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { map: mk(base), emissiveMap: mk(emi) };
}

// ------------------------------------------------------------------
// Building geometry: a box whose side-face UVs are scaled so windows
// keep a constant world size, and whose roof/floor UVs collapse onto
// the reserved facade texel.
// ------------------------------------------------------------------
function buildingGeometry(
  w: number,
  h: number,
  d: number,
  cx: number,
  cz: number,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const normal = geo.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const ny = normal.getY(i);
    if (Math.abs(ny) > 0.5) {
      uv.setXY(i, 0.003, 0.997); // roof + floor → reserved roof texel
      continue;
    }
    const horiz = Math.abs(normal.getX(i)) > 0.5 ? d : w;
    uv.setXY(i, (uv.getX(i) * horiz) / WINDOW_TILE, (uv.getY(i) * h) / WINDOW_TILE);
  }
  uv.needsUpdate = true;
  geo.translate(cx, h / 2, cz);
  return geo;
}

// ------------------------------------------------------------------
// Generate the district: building AABBs (for collision) plus merged
// geometry per material variant (for cheap rendering).
// ------------------------------------------------------------------
function generateCity(): {
  boxes: BuildingBox[];
  geoByVariant: THREE.BufferGeometry[][];
  pads: Array<{ x: number; z: number; y: number }>;
} {
  const r = rng(CITY_SEED);
  const boxes: BuildingBox[] = [];
  const variants = 6;
  const geoByVariant: THREE.BufferGeometry[][] = Array.from({ length: variants }, () => []);
  const pads: Array<{ x: number; z: number; y: number }> = [];
  const center = (GRID - 1) / 2;

  for (let gx = 0; gx < GRID; gx++) {
    for (let gz = 0; gz < GRID; gz++) {
      // The middle cell is the spawn plaza — keep it open.
      if (gx === Math.floor(center) && gz === Math.floor(center)) continue;

      const cellX = (gx - center) * PITCH;
      const cellZ = (gz - center) * PITCH;
      const ringDist = Math.max(Math.abs(gx - center), Math.abs(gz - center));

      // 1, 2 or 4 buildings per block.
      const layout = r();
      const lots: Array<[number, number, number, number]> =
        layout < 0.35
          ? [[cellX, cellZ, BLOCK, BLOCK]]
          : layout < 0.7
            ? r() < 0.5
              ? [
                  [cellX - BLOCK / 4, cellZ, BLOCK / 2, BLOCK],
                  [cellX + BLOCK / 4, cellZ, BLOCK / 2, BLOCK],
                ]
              : [
                  [cellX, cellZ - BLOCK / 4, BLOCK, BLOCK / 2],
                  [cellX, cellZ + BLOCK / 4, BLOCK, BLOCK / 2],
                ]
            : [
                [cellX - BLOCK / 4, cellZ - BLOCK / 4, BLOCK / 2, BLOCK / 2],
                [cellX + BLOCK / 4, cellZ - BLOCK / 4, BLOCK / 2, BLOCK / 2],
                [cellX - BLOCK / 4, cellZ + BLOCK / 4, BLOCK / 2, BLOCK / 2],
                [cellX + BLOCK / 4, cellZ + BLOCK / 4, BLOCK / 2, BLOCK / 2],
              ];

      for (const [lx, lz, lw, ld] of lots) {
        // Inset from the lot edge so neighbors don't touch.
        const w = lw - 3 - r() * 3;
        const d = ld - 3 - r() * 3;
        // Towers cluster on the ring right around the plaza; the
        // outskirts stay low so the skyline reads from the center.
        const towerChance = ringDist <= 2 ? 0.38 : ringDist === 3 ? 0.18 : 0.05;
        const roll = r();
        const height =
          roll < towerChance
            ? 46 + r() * 42 // tower 46–88
            : roll < 0.62
              ? 16 + r() * 26 // mid-rise 16–42
              : 7 + r() * 8; // low-rise 7–15

        const variant = Math.floor(r() * variants);
        geoByVariant[variant].push(buildingGeometry(w, height, d, lx, lz));
        boxes.push({
          minX: lx - w / 2,
          maxX: lx + w / 2,
          minZ: lz - d / 2,
          maxZ: lz + d / 2,
          base: 0,
          height,
        });
        if (height > PAD_MIN_HEIGHT) pads.push({ x: lx, z: lz, y: height });
      }
    }
  }
  return { boxes, geoByVariant, pads };
}

// Ground texture: asphalt with sidewalk-edged blocks and dashed
// street center lines, drawn once per mode for the whole district.
function makeGroundTexture(day: boolean): THREE.CanvasTexture {
  const S = 2048;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const m = S / (GRID * PITCH); // px per meter
  const center = (GRID - 1) / 2;

  ctx.fillStyle = day ? "#6e7884" : "#0e1219"; // asphalt
  ctx.fillRect(0, 0, S, S);

  for (let gx = 0; gx < GRID; gx++) {
    for (let gz = 0; gz < GRID; gz++) {
      const px = (gx * PITCH + STREET / 2) * m;
      const pz = (gz * PITCH + STREET / 2) * m;
      const side = BLOCK * m;
      // Sidewalk ring then block interior.
      ctx.fillStyle = day ? "#9aa4b1" : "#1d2531";
      ctx.fillRect(px, pz, side, side);
      ctx.fillStyle =
        gx === center && gz === center
          ? day
            ? "#74b294"
            : "#13312a"
          : day
            ? "#86909d"
            : "#121822";
      ctx.fillRect(px + 2.2 * m, pz + 2.2 * m, side - 4.4 * m, side - 4.4 * m);
    }
  }

  // Dashed center lines down every street, both axes.
  ctx.strokeStyle = day ? "rgba(255, 255, 255, 0.7)" : "rgba(45, 212, 168, 0.6)";
  ctx.lineWidth = 0.35 * m;
  ctx.setLineDash([3 * m, 4.5 * m]);
  for (let g = 0; g <= GRID; g++) {
    const p = g * PITCH * m;
    if (g > 0 && g < GRID) {
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, S);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(S, p);
      ctx.stroke();
    }
  }

  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// Neon "VIBE CITY" marquee sprite floating over the plaza.
function makeMarqueeSprite(): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 1024, 256);
  ctx.font = "900 110px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "#2dd4a8";
  ctx.shadowBlur = 42;
  ctx.fillStyle = "#baffe9";
  ctx.fillText("VIBE CITY", 512, 128);
  ctx.shadowBlur = 0;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(26, 6.5, 1);
  return sprite;
}

// Strip the "Armature|" prefix Quaternius rigs add to clip names.
function shortClipName(raw: string) {
  const afterPipe = raw.includes("|") ? raw.split("|")[1] : raw;
  return afterPipe.replace(/^Character_/, "");
}

export default function City() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // ?fresh=1 means the visitor was just auto-rolled into Edge Island
  // from the hub — skip the entry overlay and show a floating chip so
  // they can re-roll or open the full picker without ever seeing the
  // sign-in / character grid first.
  const isFreshDrop =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("fresh") === "1";
  const [entered, setEntered] = useState(isFreshDrop);
  const enteredRef = useRef(isFreshDrop);
  const [showFreshChip, setShowFreshChip] = useState(isFreshDrop);
  const [hud, setHud] = useState({
    alt: 0,
    spd: 0,
    jet: false,
    stars: 0,
    totalStars: 0,
    gems: 0,
    runMs: null as number | null,
    bestMs: null as number | null,
    nearIsland: false,
    nearMoon: false,
    nearMars: false,
    nearTjs: false,
    nearZip: false,
    riding: false,
    nearSwing: false,
    swinging: false,
    nearCow: false,
  });
  // Persistent ✦ Vibecoin balance — source of truth. Loaded from
  // `users.vibecoin_balance` for signed-in users, or localStorage for guests.
  // Incremented when collecting coins, decremented at the shop, debounced-synced.
  const vibeBalanceRef = useRef(0);
  const [vibeBalanceTick, setVibeBalanceTick] = useState(0); // forces re-render
  const persistVibeTimerRef = useRef<number | null>(null);
  const persistVibeBalanceRef = useRef<(() => void) | null>(null);
  const [purchases, setPurchases] = useState<Record<string, number>>({});
  const travelRef = useRef<(() => void) | null>(null);
  const resetRunRef = useRef<(() => void) | null>(null);
  const islandSpawnRef = useRef<(() => void) | null>(null);
  const moonSpawnRef = useRef<(() => void) | null>(null);
  const marsSpawnRef = useRef<(() => void) | null>(null);
  const tjsSpawnRef = useRef<(() => void) | null>(null);
  // Mars minigame: hunt down all the gremlins. The 3D scene owns the
  // truth (see mars.ts); these refs/state mirror it for the HUD chip.
  const marsResetRef = useRef<(() => void) | null>(null);
  const MARS_MAX_HEARTS = 3;
  const [marsGame, setMarsGame] = useState({
    onMars: false,
    alive: 0,
    total: 0,
    hearts: MARS_MAX_HEARTS,
    runMs: 0 as number, // ms since timer started; 0 = not started
    running: false,
    cleared: false,
    bestMs: null as number | null,
  });
  // Mirror for the tick loop without re-binding.
  const marsGameRef = useRef(marsGame);
  useEffect(() => {
    marsGameRef.current = marsGame;
  }, [marsGame]);
  // Brief invulnerability after a hit so a single touch costs one heart.
  const marsInvulnRef = useRef(0);
  // Sky-island mini games (Mole Meadow / Crystal Climb / Shrine Dive /
  // Lantern Echo). The 3D module owns the game state; these mirror just
  // enough for the HUD chip + start/quit buttons.
  const skyGamesRef = useRef<SkyGamesWorld | null>(null);
  // Vibe Island arrival: a sky-gradient title card that fades out while
  // the camera swoops in, hiding the first-load pop-in.
  const [arriving, setArriving] = useState(false);
  const [gameHud, setGameHud] = useState<string | null>(null);
  const [nearGamePrompt, setNearGamePrompt] = useState<{ key: SkyGameKey; name: string } | null>(null);
  // Gremlin Mines (underground) — world handle + per-tick state.
  const undergroundWorldRef = useRef<UndergroundWorld | null>(null);
  const undergroundActiveRef = useRef(false);
  const undergroundInvulnRef = useRef(0);
  // Snapshot of who you were before entering, so exit restores everything.
  const ninjaStateRef = useRef<{ prevChar: string; prevJet: string; returnPos: { x: number; y: number; z: number } } | null>(null);
  const ninjaHurtRef = useRef<((knockFromX: number, knockFromZ: number) => void) | null>(null);

  // Load best time once.
  useEffect(() => {
    const raw = localStorage.getItem("city.bestMarsRun");
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n)) setMarsGame((g) => ({ ...g, bestMs: n }));
    }
  }, []);
  const routerLocation = useLocation();

  // Touch controls write straight into these; the tick reads them.
  const touchMoveRef = useRef<TouchMove>({ x: 0, y: 0 });
  const touchJetRef = useRef(false);
  // Whimsical fall-damage respawn — set to a timestamp; UI shows splat for ~1.6s.
  const [respawnFx, setRespawnFx] = useState(0);
  // Transcendence Portal — fires whenever the player falls through the
  // world OR voluntarily steps onto the plaza portal disc.
  const [transcendFx, setTranscendFx] = useState(0);
  const [fallDamageEnabled, setFallDamageEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    const saved = localStorage.getItem("city.fallDamage");
    if (saved) return saved === "on";
    return localStorage.getItem("city.jetpack") === "none";
  });
  const fallDamageEnabledRef = useRef(fallDamageEnabled);
  const isTouch =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  useEffect(() => {
    fallDamageEnabledRef.current = fallDamageEnabled;
    localStorage.setItem("city.fallDamage", fallDamageEnabled ? "on" : "off");
  }, [fallDamageEnabled]);

  useEffect(() => {
    if (respawnFx <= 0) return;
    const timer = window.setTimeout(() => setRespawnFx(0), 1800);
    return () => window.clearTimeout(timer);
  }, [respawnFx]);

  useEffect(() => {
    if (transcendFx <= 0) return;
    const timer = window.setTimeout(() => setTranscendFx(0), 1600);
    return () => window.clearTimeout(timer);
  }, [transcendFx]);


  // Multiplayer lobby + community terminal.
  const mpRef = useRef<Multiplayer | null>(null);
  const agentResidentsRef = useRef<AgentResidents | null>(null);
  const playLocalEmoteRef = useRef<((emote: EmoteName) => void) | null>(null);
  const playLocalChatRef = useRef<((text: string) => void) | null>(null);
  const [emoteWheelOpen, setEmoteWheelOpen] = useState(false);
  // Nearby person (player or agent) for bump/message HUD buttons.
  const [nearPerson, setNearPerson] = useState<PersonTarget | null>(null);
  const nearPersonRef = useRef<PersonTarget | null>(null);
  useEffect(() => { nearPersonRef.current = nearPerson; }, [nearPerson]);
  const [chatTarget, setChatTarget] = useState<PersonTarget | null>(null);
  // Floating world-space bubbles for the nearest person + Jerry. The render
  // loop projects 3D positions into these divs every frame via direct DOM
  // mutation, so React doesn't re-render at 60fps.
  const floatPersonRef = useRef<HTMLDivElement>(null);
  const floatJerryRef = useRef<HTMLDivElement>(null);
  const jerryWorldRef = useRef<{ x: number; y: number; z: number } | null>(null);
  // Mobile: the whole world-controls chip row collapses behind a single
  // ⋯ button so the 3D view isn't buried under HUD pills. md+ shows it
  // inline like before.
  const [hudMenuOpen, setHudMenuOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const chatOpenRef = useRef(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [chatUnread, setChatUnread] = useState(0);
  const [peers, setPeers] = useState({ count: 1, online: false });
  const [playerName, setPlayerName] = useState(() => {
    const stored = localStorage.getItem("city.playerName");
    if (stored) return stored;
    // First-time visitor: seed a fun, memorable name so the entry
    // screen has something to show without forcing them to type.
    const generated = generateFunName();
    localStorage.setItem("city.playerName", generated);
    return generated;
  });
  // First-entry name modal: only used as a fallback now that the
  // entry screen collects the name up front. Stays closed unless
  // the user explicitly reopens it from the HUD.
  const [nameModalOpen, setNameModalOpen] = useState(false);

  // ---- Unified community feed: merge the agent lobby (`world_messages`)
  // into the same terminal as live player chat, and let humans post into
  // the agent feed so OpenClaw / Telegram agents see what we say.
  // History on mount + realtime stream after.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("world_messages")
        .select("id, speaker, body, created_at, kind")
        .eq("room_id", "vibe-lobby")
        .order("created_at", { ascending: false })
        .limit(20);
      if (cancelled || !data) return;
      const seeded: ChatMessage[] = data
        .reverse()
        .filter((m) => m.body && m.kind !== "system")
        .map((m) => ({
          id: `world-${m.id}`,
          name: m.speaker || "agent",
          text: m.body as string,
          ts: new Date(m.created_at as string).getTime(),
          agent: true,
        }));
      setChatMessages((prev) => {
        // Avoid duplicating anything the realtime channel may have raced in.
        const seen = new Set(prev.map((p) => p.id));
        const merged = [...seeded.filter((m) => !seen.has(m.id)), ...prev];
        return merged.slice(-80);
      });
    })();
    const channel = supabase
      .channel("city-world-messages")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "world_messages", filter: "room_id=eq.vibe-lobby" },
        (payload) => {
          const row = payload.new as { id: string; speaker?: string; body?: string; kind?: string; created_at: string };
          if (!row.body || row.kind === "system") return;
          const msg: ChatMessage = {
            id: `world-${row.id}`,
            name: row.speaker || "agent",
            text: row.body,
            ts: new Date(row.created_at).getTime(),
            agent: true,
          };
          setChatMessages((prev) =>
            prev.some((p) => p.id === msg.id) ? prev : [...prev.slice(-79), msg],
          );
          if (!chatOpenRef.current) setChatUnread((n) => n + 1);
        },
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);


  // Talkable NPCs (Vibey + Jerry): proximity-gated LLM conversations
  // through the unit7-chat edge function, one dialog at a time.
  const [nearVibey, setNearVibey] = useState(false);
  const [nearJerry, setNearJerry] = useState(false);
  const [nearSnackfe, setNearSnackfe] = useState(false);
  // Vibe karts: which parked kart is in hop-on range, and which one
  // (if any) we're driving. The ref mirrors state for the tick loop.
  const [nearKart, setNearKart] = useState(-1);
  const [drivingKart, setDrivingKart] = useState(-1);
  const drivingKartRef = useRef(-1);
  const enterKartRef = useRef<((i: number) => void) | null>(null);
  const exitKartRef = useRef<(() => void) | null>(null);
  const [snackOpen, setSnackOpen] = useState(false);
  const [snackMsg, setSnackMsg] = useState<string | null>(null);
  const [npcTarget, setNpcTarget] = useState<NpcKey | null>(null);
  const [vibeyThinking, setVibeyThinking] = useState(false);
  const [vibeyDraft, setVibeyDraft] = useState("");
  const [npcLogs, setNpcLogs] = useState<
    Record<NpcKey, Array<{ who: "you" | "npc"; text: string }>>
  >({ vibey: [], jerry: [], kage: [], ember: [], miso: [], pixel: [], shuri: [] });
  const npcHistoryRef = useRef<
    Record<NpcKey, Array<{ role: "user" | "assistant"; content: string }>>
  >({ vibey: [], jerry: [], kage: [], ember: [], miso: [], pixel: [], shuri: [] });
  // Which Palace housemate is in talk range (key + display name).
  const [nearNinjaCast, setNearNinjaCast] = useState<{ key: NpcKey; name: string } | null>(null);
  const vibeyExciteRef = useRef<(() => void) | null>(null);
  const zipGrabRef = useRef<(() => void) | null>(null);
  const swingGrabRef = useRef<(() => void) | null>(null);
  const mooRef = useRef<(() => void) | null>(null);

  // Voice mode: a live ElevenLabs conversation with Vibey.
  const [voiceState, setVoiceState] = useState<"off" | "connecting" | "listening" | "speaking">(
    "off",
  );
  const voiceRef = useRef<VibeyVoiceSession | null>(null);
  const endVoice = () => {
    void voiceRef.current?.end().catch(() => {});
    voiceRef.current = null;
    setVoiceState("off");
  };
  const beginVoice = async () => {
    setVoiceState("connecting");
    try {
      voiceRef.current = await startVibeyVoice({
        onMode: (mode) => {
          setVoiceState(mode);
          if (mode === "speaking") vibeyExciteRef.current?.();
        },
        onMessage: (source, text) => {
          setNpcLogs((l) => ({
            ...l,
            vibey: [...l.vibey, { who: source === "ai" ? ("npc" as const) : ("you" as const), text }],
          }));
        },
        onEnd: () => setVoiceState("off"),
        onError: () => {
          setNpcLogs((l) => ({
            ...l,
            vibey: [
              ...l.vibey,
              { who: "npc" as const, text: "(voice line crackles — let's try that again)" },
            ],
          }));
        },
      });
    } catch {
      setVoiceState("off");
      setNpcLogs((l) => ({
        ...l,
        vibey: [
          ...l.vibey,
          {
            who: "npc" as const,
            text: "I couldn't open the voice line — check the mic permission and try again.",
          },
        ],
      }));
    }
  };
  const [dayMode, setDayMode] = useState(false);
  const [muted, setMuted] = useState(false);
  const soundsRef = useRef<CitySounds | null>(null);
  const [charName, setCharName] = useState(initialCharacter);
  const [charPanelOpen, setCharPanelOpen] = useState(false);
  const charRef = useRef(charName);
  const applyModeRef = useRef<((day: boolean) => void) | null>(null);
  const loadPilotRef = useRef<((name: string) => void) | null>(null);
  // Avatar portal holo preview — when the player is near the avatar
  // portal we mount a holographic clone of the previewed character
  // onto island.avatarStage. Arrow buttons cycle this index; the
  // pilot is only committed when they tap "Become this character".
  const [avatarPreviewIdx, setAvatarPreviewIdx] = useState(() => {
    const i = CHARACTERS.findIndex((c) => c.name === charName);
    return i >= 0 ? i : 0;
  });
  const mountAvatarHoloRef = useRef<((name: string | null) => void) | null>(null);

  // The "⋯" HUD menu and its sub-panels (chat / emote / character)
  // share an outside-click + close-all flow so the X button and a tap
  // anywhere else on screen both dismiss the whole stack instead of
  // leaving floating panels behind.
  const hudWrapRef = useRef<HTMLDivElement | null>(null);
  const closeAllHud = useCallback(() => {
    setHudMenuOpen(false);
    setEmoteWheelOpen(false);
    setCharPanelOpen(false);
    setChatOpen(false);
    chatOpenRef.current = false;
  }, []);

  // Outside-click / tap dismiss for the HUD menu cluster. Only active
  // while something is open so we don't burn listeners 24/7.
  useEffect(() => {
    const anyOpen = hudMenuOpen || chatOpen || emoteWheelOpen || charPanelOpen;
    if (!anyOpen) return;
    const onDown = (e: PointerEvent) => {
      const el = hudWrapRef.current;
      if (!el) return;
      const target = e.target as Node | null;
      if (target && !el.contains(target)) closeAllHud();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [hudMenuOpen, chatOpen, emoteWheelOpen, charPanelOpen, closeAllHud]);

  // Vibe Shop — equipped cosmetics + dialog state. The setters below
  // are wired into the 3D scene via refs so equipping is instant.
  const [shopOpen, setShopOpen] = useState(false);
  const [nearShop, setNearShop] = useState(false);
  // Live Roster TV — agents currently in the vibe-lobby room.
  const [rosterAgents, setRosterAgents] = useState<RosterAgent[]>([]);
  const [nearRoster, setNearRoster] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [editingAgentName, setEditingAgentName] = useState("");
  const [savingAgentId, setSavingAgentId] = useState<string | null>(null);

  // Vibe Maker portal — spawn 3D primitives saved to public.island_spawns.
  // The scene exposes a tiny imperative API via ref so we can sync the
  // 3D group whenever the React-side `spawns` list changes.
  const [nearPortal, setNearPortal] = useState(false);
  const [portalOpen, setPortalOpen] = useState(false);
  const [nearAvatarPortal, setNearAvatarPortal] = useState(false);
  const [nearArcade, setNearArcade] = useState(false);
  const [arcadeOpen, setArcadeOpen] = useState(false);
  const [nearTv, setNearTv] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryPhotos, setGalleryPhotos] = useState<
    { url: string; title?: string | null; description?: string | null; residency?: string | null }[]
  >([]);
  // Ninja portals → Gremlin Mines (the underground game world).
  const [nearNinjaPortal, setNearNinjaPortal] = useState(false);
  const [underground, setUnderground] = useState(false);
  const [bossHp, setBossHp] = useState(3);
  const [orbShardWon, setOrbShardWon] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("city.orbShard") === "1";
  });
  const [showShardReward, setShowShardReward] = useState(false);
  const [enterFx, setEnterFx] = useState(0);
  const enterUndergroundRef = useRef<(() => void) | null>(null);
  const exitUndergroundRef = useRef<(() => void) | null>(null);


  // When the player walks up to the portal, sync the preview index to
  // their currently-equipped character so it appears in the hologram
  // first. When they walk away, tear the holo down.
  useEffect(() => {
    if (!nearAvatarPortal) {
      mountAvatarHoloRef.current?.(null);
      return;
    }
    const i = CHARACTERS.findIndex((c) => c.name === charRef.current);
    if (i >= 0) setAvatarPreviewIdx(i);
  }, [nearAvatarPortal]);

  // Whenever the previewed character changes (and we're near the
  // portal), swap the hologram on the pedestal.
  useEffect(() => {
    if (!nearAvatarPortal) return;
    const c = CHARACTERS[avatarPreviewIdx];
    if (c) mountAvatarHoloRef.current?.(c.name);
  }, [nearAvatarPortal, avatarPreviewIdx]);
  const [spawns, setSpawns] = useState<IslandSpawnRow[]>([]);
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const authUserIdRef = useRef<string | null>(null);
  const spawnsApiRef = useRef<{ setAll: (rows: IslandSpawnRow[]) => void } | null>(null);

  const [equippedHat, setEquippedHat] = useState<string>(() => {
    if (typeof window === "undefined") return "none";
    return localStorage.getItem("city.hat") || "none";
  });
  const [equippedFlame, setEquippedFlame] = useState<string>(() => {
    if (typeof window === "undefined") return "mint";
    return localStorage.getItem("city.flame") || "mint";
  });
  const [equippedJetpack, setEquippedJetpack] = useState<string>(() => {
    if (typeof window === "undefined") return "stock";
    return localStorage.getItem("city.jetpack") || "stock";
  });
  const applyHatRef = useRef<((id: string) => void) | null>(null);
  const setPlayerScaleRef = useRef<((s: number) => void) | null>(null);
  const playerScaleRef = useRef(1);
  const [bigMode, setBigMode] = useState(false);
  const [bigSize, setBigSize] = useState(1);
  const [secretInput, setSecretInput] = useState("");
  const applyFlameRef = useRef<((id: string) => void) | null>(null);
  const applyJetpackRef = useRef<((id: string) => void) | null>(null);

  // "B" toggles the emote wheel. Ignored while typing in chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        setEmoteWheelOpen((v) => !v);
      } else if (e.key === "Escape") {
        setEmoteWheelOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- Auth: who is the player, so we can write island_spawns rows.
  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setAuthUserId(data.session?.user.id ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      setAuthUserId(session?.user.id ?? null);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  // Keep ref + multiplayer presence in sync with the current auth user.
  useEffect(() => {
    authUserIdRef.current = authUserId;
    mpRef.current?.setUserId(authUserId);
  }, [authUserId]);

  // ---- Admin check: lets the player rename agents on the Live Roster.
  // Note: user_roles.user_id stores public.users.id, NOT auth.users.id, so
  // we call the has_role() SECURITY DEFINER RPC which does the mapping
  // (same function the RLS policies use).
  useEffect(() => {
    if (!authUserId) { setIsAdmin(false); return; }
    let cancelled = false;
    supabase
      .rpc("has_role", { _user_id: authUserId, _role: "admin" })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.warn("[admin] has_role check failed", error);
          setIsAdmin(false);
        } else {
          setIsAdmin(!!data);
        }
      });
    return () => { cancelled = true; };
  }, [authUserId]);

  // ---- Prefer the signed-in user's saved `users.name` over the locally
  // generated Pilot-NNN. If they have one, treat the name modal as done.
  useEffect(() => {
    if (!authUserId) return;
    let cancelled = false;
    supabase
      .from("users")
      .select("name")
      .eq("auth_user_id", authUserId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const dbName = data?.name?.trim();
        if (dbName) {
          setPlayerName(dbName);
          localStorage.setItem("city.playerName", dbName);
          localStorage.setItem("city.displayName", dbName);
          mpRef.current?.setName(dbName);
          setNameModalOpen(false);
        }
      });
    return () => { cancelled = true; };
  }, [authUserId]);

  // ---- Persistent ✦ Vibecoin balance: load + debounced sync.
  // For signed-in users we read/write `users.vibecoin_balance`. Guests use
  // localStorage. On sign-in we merge (max) so guest progress isn't lost.
  useEffect(() => {
    persistVibeBalanceRef.current = () => {
      if (persistVibeTimerRef.current) window.clearTimeout(persistVibeTimerRef.current);
      persistVibeTimerRef.current = window.setTimeout(() => {
        const bal = Math.max(0, Math.round(vibeBalanceRef.current));
        try { localStorage.setItem("city.vibecoinBalance", String(bal)); } catch { /* noop */ }
        const uid = authUserIdRef.current;
        if (uid) {
          void supabase
            .from("users")
            .update({ vibecoin_balance: bal })
            .eq("auth_user_id", uid);
        }
      }, 700);
    };
    return () => {
      if (persistVibeTimerRef.current) window.clearTimeout(persistVibeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const localBal = Math.max(0, Number(localStorage.getItem("city.vibecoinBalance") ?? 0) || 0);
    if (!authUserId) {
      vibeBalanceRef.current = localBal;
      setVibeBalanceTick((n) => n + 1);
      return;
    }
    void supabase
      .from("users")
      .select("vibecoin_balance")
      .eq("auth_user_id", authUserId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const dbBal = Math.max(0, Number(data?.vibecoin_balance ?? 0) || 0);
        const merged = Math.max(dbBal, localBal);
        vibeBalanceRef.current = merged;
        setVibeBalanceTick((n) => n + 1);
        if (merged !== dbBal) {
          void supabase
            .from("users")
            .update({ vibecoin_balance: merged })
            .eq("auth_user_id", authUserId);
        }
      });
    return () => { cancelled = true; };
  }, [authUserId]);




  // ---- Island spawns: initial fetch + realtime sync. Everyone — even
  // logged-out viewers — sees every spawn, so this runs unconditionally.
  useEffect(() => {
    let cancelled = false;
    void supabase
      .from("island_spawns")
      .select("*")
      .order("created_at", { ascending: true })
      .limit(500)
      .then(({ data }) => {
        if (cancelled || !data) return;
        setSpawns(data as IslandSpawnRow[]);
      });
    const channel = supabase
      .channel("island_spawns")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "island_spawns" },
        (payload) => {
          setSpawns((prev) => {
            const row = payload.new as IslandSpawnRow;
            if (prev.some((s) => s.id === row.id)) return prev;
            return [...prev, row];
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "island_spawns" },
        (payload) => {
          const oldRow = payload.old as { id?: string };
          if (!oldRow.id) return;
          setSpawns((prev) => prev.filter((s) => s.id !== oldRow.id));
        },
      )
      .subscribe();
    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, []);

  // Mirror the spawn list into the 3D scene whenever it changes.
  useEffect(() => {
    spawnsApiRef.current?.setAll(spawns);
  }, [spawns]);




  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // ---- Renderer / scene / camera ---------------------------------
    // Pre-acquire the WebGL context ourselves so we can bail cleanly
    // if the browser refuses (out of contexts, hardware off, etc.)
    // instead of crashing inside three's WebGLCapabilities highp probe
    // (which dereferences a null getShaderPrecisionFormat result).
    const glContext =
      (canvas.getContext("webgl2", { antialias: true, powerPreference: "high-performance" }) as
        | WebGL2RenderingContext
        | null) ??
      (canvas.getContext("webgl", { antialias: true, powerPreference: "high-performance" }) as
        | WebGLRenderingContext
        | null);
    if (!glContext) {
      console.warn("[City] WebGL unavailable — skipping 3D scene init.");
      return;
    }
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        context: glContext,
        antialias: true,
        // mediump avoids the highp precision probe that crashes on
        // some drivers when getShaderPrecisionFormat returns null.
        precision: "mediump",
      });
    } catch (err) {
      console.warn("[City] WebGLRenderer init failed:", err);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#05080d");
    scene.fog = new THREE.Fog("#05080d", 90, 520);

    const camera = new THREE.PerspectiveCamera(
      60,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      3500,
    );
    // VR dolly: in immersive sessions, three.js controls the camera's
    // local transform from the headset pose, so to MOVE the viewpoint
    // we translate the dolly (the camera's parent). Outside XR the
    // dolly just sits at the origin and the chase-cam code below
    // drives the camera world position directly.
    const dolly = new THREE.Group();
    scene.add(dolly);
    dolly.add(camera);

    // ---- VR controllers + point-and-click interaction ------------------
    // Left controller drives the jetpack. Right controller is a laser
    // pointer: aim at a person and squeeze the trigger to pop a small
    // in-world action menu (Wave / Hi! / Dance). Same handlers as the
    // desktop proximity bubble, so behaviour stays uniform.
    const vrCtrlHand: Array<"left" | "right" | "none"> = ["none", "none"];
    const vrControllers: THREE.Group[] = [];
    const vrRays: THREE.Line[] = [];
    for (let i = 0; i < 2; i++) {
      const c = renderer.xr.getController(i);
      dolly.add(c);
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1),
      ]);
      const mat = new THREE.LineBasicMaterial({
        color: 0x6effc8,
        transparent: true,
        opacity: 0.55,
      });
      const ray = new THREE.Line(geo, mat);
      ray.scale.z = 12;
      ray.visible = false;
      c.add(ray);
      vrControllers.push(c);
      vrRays.push(ray);
      c.addEventListener("connected", (e: unknown) => {
        const hand = (e as { data?: { handedness?: string } })?.data?.handedness;
        vrCtrlHand[i] = hand === "left" || hand === "right" ? hand : "none";
        ray.visible = true;
      });
      c.addEventListener("disconnected", () => {
        vrCtrlHand[i] = "none";
        ray.visible = false;
      });
    }

    // Build the floating action menu (3 emoji sprites) used in VR.
    const vrMenuGroup = new THREE.Group();
    vrMenuGroup.visible = false;
    scene.add(vrMenuGroup);
    const makeVrButton = (emoji: string, label: string, color: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const g = canvas.getContext("2d")!;
      g.clearRect(0, 0, 256, 256);
      g.fillStyle = "rgba(10, 18, 28, 0.88)";
      g.beginPath();
      g.arc(128, 128, 116, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = color;
      g.lineWidth = 6;
      g.stroke();
      g.font = "120px serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(emoji, 128, 120);
      g.font = "bold 30px sans-serif";
      g.fillStyle = color;
      g.fillText(label, 128, 222);
      const tex = new THREE.CanvasTexture(canvas);
      tex.anisotropy = 4;
      const sm = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthTest: false,
      });
      const sp = new THREE.Sprite(sm);
      sp.scale.set(0.45, 0.45, 1);
      sp.renderOrder = 9999;
      return sp;
    };
    type VrBtn = {
      sprite: THREE.Sprite;
      run: (target: PersonTarget) => void;
    };
    const vrButtons: VrBtn[] = [
      {
        sprite: makeVrButton("👋", "Wave", "#6effc8"),
        run: (t) => {
          if (t.kind === "agent") agentResidentsRef.current?.showWaveAt(t.ref);
          else mpRef.current?.sendEmote("wave");
        },
      },
      {
        sprite: makeVrButton("💬", "Hi!", "#7ad7ff"),
        run: (t) => mpRef.current?.sendChat(`👋 Hey ${t.name}!`),
      },
      {
        sprite: makeVrButton("💃", "Dance", "#ffb86b"),
        run: () => mpRef.current?.sendEmote("dance"),
      },
    ];
    vrButtons.forEach((b) => vrMenuGroup.add(b.sprite));
    // Menu state, mutated by the VR input block in the tick loop.
    const vrMenu: {
      target: PersonTarget | null;
      hoverIdx: number;
      // Per-controller previous trigger state for edge-detection.
      prevTrigger: Map<number, boolean>;
    } = { target: null, hoverIdx: -1, prevTrigger: new Map() };

    const ambient = new THREE.AmbientLight(0x8899bb, 0.5);
    scene.add(ambient);
    const hemi = new THREE.HemisphereLight(0x32445e, 0x0c1018, 1.1);
    scene.add(hemi);
    const moonlight = new THREE.DirectionalLight(0xbfd4ff, 1.05);
    moonlight.position.set(180, 320, -140);
    scene.add(moonlight);
    const plazaGlow = new THREE.PointLight(0x2dd4a8, 60, 90, 1.6);
    plazaGlow.position.set(0, 10, 0);
    scene.add(plazaGlow);

    // ---- The district ----------------------------------------------
    const { boxes, geoByVariant, pads } = generateCity();
    const facades = ["#151b27", "#132033", "#11141c"];
    const dayFacades = ["#aab4c2", "#9fb0c4", "#b6bdc9"];
    const litColors = ["#2dd4a8", "#ffd9a0", "#6fd9ff"];
    const buildingMeshes: THREE.Mesh[] = [];
    // Each variant keeps both skins so day/night can swap facades.
    const buildingSkins: Array<{
      mat: THREE.MeshStandardMaterial;
      nightMap: THREE.CanvasTexture;
      dayMap: THREE.CanvasTexture;
    }> = [];
    geoByVariant.forEach((geos, i) => {
      if (!geos.length) return;
      const lit = litColors[Math.floor(i / facades.length) % litColors.length];
      const night = makeWindowTextures(`${CITY_SEED}-tex-${i}`, {
        facade: facades[i % facades.length],
        lit,
        litChance: 0.32,
        windowColor: "rgba(8, 12, 16, 0.92)",
        roofColor: "#1f2733",
      });
      const day = makeWindowTextures(`${CITY_SEED}-tex-${i}-day`, {
        facade: dayFacades[i % dayFacades.length],
        lit,
        litChance: 0, // daytime windows are just dark glass
        windowColor: "#3d5168",
        roofColor: "#99a3ae",
      });
      const merged = mergeGeometries(geos, false)!;
      geos.forEach((g) => g.dispose());
      const mat = new THREE.MeshStandardMaterial({
        map: night.map,
        emissive: new THREE.Color("#ffffff"),
        emissiveMap: night.emissiveMap,
        emissiveIntensity: 1.0,
        roughness: 0.85,
        metalness: 0.1,
      });
      const mesh = new THREE.Mesh(merged, mat);
      scene.add(mesh);
      buildingMeshes.push(mesh);
      buildingSkins.push({ mat, nightMap: night.map, dayMap: day.map });
    });

    // Ground: textured district plate over a huge dark apron.
    const groundNight = makeGroundTexture(false);
    const groundDay = makeGroundTexture(true);
    const plateMat = new THREE.MeshStandardMaterial({ map: groundNight, roughness: 0.95 });
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(GRID * PITCH, GRID * PITCH),
      plateMat,
    );
    plate.rotation.x = -Math.PI / 2;
    scene.add(plate);
    // Surrounding "ocean": a shader plane around the city plate. Gentle
    // animated waves, fresnel sky reflection, sun glints, and a day/night
    // tint so the world feels like a city on an island.
    const waterUniforms = {
      uTime: { value: 0 },
      uDay: { value: 1 },
      uShallow: { value: new THREE.Color("#3aa9c4") },
      uDeep: { value: new THREE.Color("#0a2238") },
      uSky: { value: new THREE.Color("#bcdff5") },
      uFogColor: { value: new THREE.Color("#cfe6f5") },
      uFogNear: { value: 170 },
      uFogFar: { value: 1100 },
    };
    const apronMat = new THREE.ShaderMaterial({
      uniforms: waterUniforms,
      transparent: true,
      depthWrite: false,
      fog: false,
      vertexShader: `
        uniform float uTime;
        varying vec3 vWorld;
        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0);
          float t = uTime;
          // Waves flatten to a calm sheet under and around the city
          // plate (half-diagonal ~255m) — they used to crest ABOVE the
          // ground plane and shimmer through the streets.
          float damp = smoothstep(265.0, 420.0, length(wp.xz));
          wp.y += (sin(wp.x * 0.012 + t * 0.9) * 0.35
                + sin(wp.z * 0.017 - t * 0.7) * 0.30
                + sin((wp.x + wp.z) * 0.008 + t * 0.5) * 0.20) * damp
                - 0.12;
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uDay;
        uniform vec3 uShallow;
        uniform vec3 uDeep;
        uniform vec3 uSky;
        uniform vec3 uFogColor;
        uniform float uFogNear;
        uniform float uFogFar;
        varying vec3 vWorld;
        void main(){
          float t = uTime;
          vec3 n = normalize(vec3(
            sin(vWorld.x * 0.06 + t * 1.3) * 0.18 + sin(vWorld.x * 0.19 - t * 1.8) * 0.07,
            1.0,
            sin(vWorld.z * 0.07 + t * 1.1) * 0.18 + sin(vWorld.z * 0.22 - t * 1.5) * 0.07
          ));
          vec3 viewDir = normalize(cameraPosition - vWorld);
          float fres = pow(1.0 - max(dot(viewDir, n), 0.0), 3.0);
          float dist = length(vWorld.xz);
          float depthMix = smoothstep(180.0, 900.0, dist);
          vec3 col = mix(uShallow, uDeep, depthMix);
          col = mix(col, uSky, fres * 0.7);
          vec3 sunDir = normalize(vec3(0.4, 0.9, 0.3));
          vec3 h = normalize(viewDir + sunDir);
          float spec = pow(max(dot(n, h), 0.0), 180.0);
          col += vec3(1.0, 0.95, 0.8) * spec * 1.4 * uDay;
          float dCam = length(cameraPosition - vWorld);
          float fogF = smoothstep(uFogNear, uFogFar, dCam);
          col = mix(col, uFogColor, fogF);
          gl_FragColor = vec4(col, 0.97);
        }
      `,
    });
    // Circular ocean disc — matches Earth's horizon better than a square
    // plane; corners no longer cut off in fog.
    const apron = new THREE.Mesh(new THREE.CircleGeometry(2000, 128), apronMat);
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.05;
    scene.add(apron);
    const updateWater = (now: number) => {
      waterUniforms.uTime.value = now * 0.001;
    };

    // Plaza spawn ring + marquee.
    const padMat = new THREE.MeshBasicMaterial({
      color: "#2dd4a8",
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const plazaRing = new THREE.Mesh(new THREE.RingGeometry(4.2, 5.4, 48), padMat);
    plazaRing.rotation.x = -Math.PI / 2;
    plazaRing.position.y = 0.06;
    scene.add(plazaRing);
    const marquee = makeMarqueeSprite();
    marquee.position.set(0, 24, 0);
    scene.add(marquee);

    // Rooftop landing pads on the tallest towers.
    const padGeo = new THREE.RingGeometry(2.1, 3, 36);
    pads.forEach((p) => {
      const ring = new THREE.Mesh(padGeo, padMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.x, p.y + 0.12, p.z);
      scene.add(ring);
    });

    // ---- Cardboard Island (the kids' world, floating east) ----------
    const island = buildCardboardIsland({
      centerX: ISLAND_X,
      centerZ: ISLAND_Z,
      topY: ISLAND_TOP,
      boxes,
    });
    scene.add(island.group);

    // THE PALACE — the ninja reality show in the courtyard of Ninja's
    // Palace. Five talkable housemates, one empty throne, live drama.
    const ninjaShow = buildNinjaPalaceShow({
      centerX: ISLAND_X,
      centerZ: ISLAND_Z,
      topY: ISLAND_TOP,
    });
    scene.add(ninjaShow.group);

    // The iridescent $VIBE emblem — the exact GLB the /coin page spins —
    // floating just above the Vibe Shop kiosk sign. Click/tap it and
    // something fun happens, same spirit as the emblem on /coin.
    let vibeEmblem: THREE.Group | null = null;
    let vibeEmblemHit: THREE.Object3D | null = null;
    let emblemAnim: { kind: number; start: number } | null = null;
    let lastEmblemKind = -1;
    const emblemSparks: Array<{
      s: THREE.Sprite; vx: number; vy: number; vz: number; born: number;
    }> = [];
    const EMBLEM_SPARK_COLORS = [0xff7fc8, 0x8de3ff, 0xa8ffd6, 0xffe27a, 0xb392ff];
    const VIBE_EMBLEM_Y = ISLAND_TOP + 5.5;
    const triggerEmblemFun = () => {
      if (!vibeEmblem) return;
      // pulse / tumble / confetti — never the same one twice in a row.
      let kind = Math.floor(Math.random() * 3);
      if (kind === lastEmblemKind) kind = (kind + 1) % 3;
      lastEmblemKind = kind;
      emblemAnim = { kind, start: performance.now() };
      const snd = soundsRef.current;
      if (kind === 0) snd?.chime(6);
      else if (kind === 1) snd?.chime(3);
      else {
        snd?.fanfare?.();
        for (let i = 0; i < 14; i++) {
          const mat = new THREE.SpriteMaterial({
            color: EMBLEM_SPARK_COLORS[i % EMBLEM_SPARK_COLORS.length],
            transparent: true,
            depthWrite: false,
          });
          const sp = new THREE.Sprite(mat);
          sp.position.copy(vibeEmblem.position);
          sp.scale.setScalar(0.2);
          const a = (i / 14) * Math.PI * 2 + Math.random() * 0.4;
          emblemSparks.push({
            s: sp,
            vx: Math.cos(a) * (2.5 + Math.random() * 2),
            vy: 2.5 + Math.random() * 3.5,
            vz: Math.sin(a) * (2.5 + Math.random() * 2),
            born: performance.now(),
          });
          scene.add(sp);
        }
      }
    };
    new GLTFLoader().load(
      iridescentArcUrl,
      (gltf) => {
        const emblem = gltf.scene;
        const box3 = new THREE.Box3().setFromObject(emblem);
        const sz = new THREE.Vector3();
        box3.getSize(sz);
        const s = 0.95 / Math.max(sz.x, sz.y, sz.z, 0.0001);
        emblem.scale.setScalar(s);
        const c = new THREE.Vector3();
        box3.getCenter(c);
        emblem.position.set(-c.x * s, -c.y * s, -c.z * s);
        // Same self-lit treatment as VibeArc on /coin — the city scene
        // has no environment map, so bake the shimmer into emissive.
        emblem.traverse((obj) => {
          const m = obj as THREE.Mesh;
          if (!m.isMesh) return;
          const apply = (mat: THREE.Material) => {
            const std = mat as THREE.MeshStandardMaterial;
            if (!std || !("metalness" in std)) return;
            std.metalness = Math.min(std.metalness, 0.3);
            std.roughness = Math.max(std.roughness, 0.35);
            if (std.map) {
              std.emissiveMap = std.map;
              std.emissive = new THREE.Color(0xffffff);
              std.emissiveIntensity = 0.7;
            }
            std.needsUpdate = true;
          };
          const mat = m.material;
          if (Array.isArray(mat)) mat.forEach(apply);
          else if (mat) apply(mat);
        });
        const holder = new THREE.Group();
        holder.add(emblem);
        // Generous invisible hit sphere so taps land easily even though
        // the emblem itself is small.
        const hit = new THREE.Mesh(
          new THREE.SphereGeometry(1.1, 8, 6),
          new THREE.MeshBasicMaterial({ visible: false }),
        );
        holder.add(hit);
        // Above the kiosk (kiosk center sits 2.3 behind the walk-up anchor).
        holder.position.set(island.shop.x, VIBE_EMBLEM_Y, island.shop.z + 2.3);
        scene.add(holder);
        vibeEmblem = holder;
        vibeEmblemHit = hit;
      },
      undefined,
      (err) => console.warn("[city] vibe emblem failed to load", err),
    );

    // ---- Vibe Maker spawns: a group anchored at the portal that
    // mirrors public.island_spawns. The React side owns the data and
    // calls spawnsApiRef.current.setAll(...) to diff into the scene.
    const spawnsGroup = new THREE.Group();
    spawnsGroup.position.copy(island.portal);
    scene.add(spawnsGroup);
    const spawnMeshById = new Map<string, THREE.Group>();
    spawnsApiRef.current = {
      setAll(rows) {
        const seen = new Set(rows.map((r) => r.id));
        spawnMeshById.forEach((mesh, id) => {
          if (!seen.has(id)) {
            spawnsGroup.remove(mesh);
            mesh.traverse((o) => {
              if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry?.dispose();
              const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
              if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
              else mat?.dispose();
            });
            spawnMeshById.delete(id);
          }
        });
        rows.forEach((r) => {
          if (!spawnMeshById.has(r.id)) {
            const m = createSpawnMesh(r);
            spawnsGroup.add(m);
            spawnMeshById.set(r.id, m);
          }
        });
      },
    };

    // ---- The Moon (a landable celestial body near the island) -------
    const moonWorld = buildMoon({
      centerX: MOON_X,
      centerZ: MOON_Z,
      topY: MOON_TOP,
      boxes,
    });
    scene.add(moonWorld.group);

    // A second, smaller moon on the opposite side of the sky.
    const moon2World = buildMoon({
      centerX: MOON2_X,
      centerZ: MOON2_Z,
      topY: MOON2_TOP,
      boxes,
    });
    scene.add(moon2World.group);

    // Mars — far across the sky, with a few gremlins on patrol.
    const marsWorld = buildMars({
      centerX: MARS_X,
      centerZ: MARS_Z,
      topY: MARS_TOP,
      boxes,
    });
    scene.add(marsWorld.group);

    // Trader Joe's Galaxy — a separate floating archipelago of TJ's
    // outposts. Same physics; just another fast-travel destination.
    const tjsWorld = buildTradersGalaxy({
      centerX: TJS_X,
      centerZ: TJS_Z,
      topY: TJS_TOP,
      boxes,
    });
    scene.add(tjsWorld.group);

    // ---- Sky Islands: the Vibeverse bounce arc ---------------------
    // Four big landable islands (Lone Tree, Crystal Isle, Sky Shrine,
    // Lantern Grove) rising through the western sky, plus a zeppelin
    // circling the city. All landable via the shared collision boxes.
    const skyIslands = buildSkyIslands({ boxes });
    scene.add(skyIslands.group);

    // ---- Sky-island mini games: one per island, paid in $VIBE --------
    const skyGames = buildSkyGames();
    scene.add(skyGames.group);
    skyGamesRef.current = skyGames;
    skyGames.onCue = (cue) => {
      const s = soundsRef.current;
      if (!s) return;
      if (cue === "pop") s.chime(2);
      else if (cue === "good") s.chime(5);
      else if (cue === "bad") s.thud(0.6);
      else if (cue === "tick") s.chime(0);
      else if (cue === "go") s.chime(8);
    };
    skyGames.onEnd = ({ key, name, score, detail }) => {
      if (score <= 0) {
        toast(`${name} over`, { description: detail });
        return;
      }
      soundsRef.current?.fanfare();
      // Payouts are minted server-side (score clamps + daily caps live in
      // vibe-economy), then mirrored into the in-city ✦ balance so the
      // coins are instantly visible and spendable at SnackFe.
      const ownerRef =
        authUserIdRef.current ??
        (() => {
          const KEY = "city.guestId";
          let id = localStorage.getItem(KEY);
          if (!id) {
            id = crypto.randomUUID?.() ?? `guest-${Math.random().toString(36).slice(2)}-${Date.now()}`;
            localStorage.setItem(KEY, id);
          }
          return id;
        })();
      void VibeEconomy.gameReward("user", ownerRef, key, score)
        .then((r) => {
          if (r.capped) {
            toast.info(`${name}: ${detail}`, {
              description: "Daily $VIBE cap for this game reached — this run was for glory!",
            });
            return;
          }
          if (r.amount > 0) {
            vibeBalanceRef.current = Math.max(0, vibeBalanceRef.current) + r.amount;
            setVibeBalanceTick((n) => n + 1);
            persistVibeBalanceRef.current?.();
            toast.success(`+${r.amount} ✦ VIBE — ${name}`, {
              description:
                detail +
                (r.playsLeft != null ? ` · ${r.playsLeft} rewarded run${r.playsLeft === 1 ? "" : "s"} left today` : ""),
            });
          }
        })
        .catch(() => {
          // Offline / ledger unreachable: keep the fun, pay a modest
          // local consolation like the star pickups do.
          const fallback = Math.min(40, score);
          vibeBalanceRef.current = Math.max(0, vibeBalanceRef.current) + fallback;
          setVibeBalanceTick((n) => n + 1);
          persistVibeBalanceRef.current?.();
          toast.success(`+${fallback} ✦ (offline) — ${name}`, { description: detail });
        });
    };

    // ---- Vibe karts (V1): two drivable go-karts ----------------------
    // One parked at the city plaza, one on the Vibe Island lawn. The
    // mesh comes from karts.ts; the arcade driving physics live in the
    // tick below (throttle + steer, wall sliding, ground follow — and
    // yes, you can drive straight off the island rim).
    const kartStates = [
      { x: 10, y: 0, z: 20, yaw: Math.PI * 0.75, speed: 0, vy: 0, steer: 0, mesh: buildKart("#ff6b6b") },
      { x: ISLAND_X - 19, y: ISLAND_TOP, z: ISLAND_Z + 17, yaw: 2.4, speed: 0, vy: 0, steer: 0, mesh: buildKart("#46e88c") },
    ];
    for (const k of kartStates) {
      k.mesh.group.position.set(k.x, k.y, k.z);
      k.mesh.group.rotation.y = k.yaw;
      scene.add(k.mesh.group);
    }
    enterKartRef.current = (i) => {
      if (i < 0 || i >= kartStates.length) return;
      drivingKartRef.current = i;
      setDrivingKart(i);
      soundsRef.current?.chime(4);
    };
    exitKartRef.current = () => {
      const i = drivingKartRef.current;
      if (i < 0) return;
      const k = kartStates[i];
      drivingKartRef.current = -1;
      setDrivingKart(-1);
      k.speed = 0;
      k.steer = 0;
      // Hop off to the kart's right with a small pop.
      player.position.set(
        k.x + Math.cos(k.yaw) * 1.9,
        k.y + 0.6,
        k.z - Math.sin(k.yaw) * 1.9,
      );
      vel.set(0, 3.5, 0);
      onGround = false;
    };

    // ---- World index: register named POIs so agents can /goto them
    // and answer "what's around me?" with real coords (Stage 1 of the
    // Agent Embodiment Roadmap). Modules that own a landmark register it
    // by its actual world position; agentResidents registers itself for
    // the "agents" half of the snapshot.
    {
      const reg = (
        key: string,
        name: string,
        region: string,
        pos: THREE.Vector3,
        aliases: string[] = [],
      ) => registerPOI({ key, name, region, position: pos, kind: "landmark", aliases });
      reg("plaza", "Plaza Spawn", "Plaza", new THREE.Vector3(0, 0, 0), ["spawn", "lobby", "start"]);
      reg("cardboard-island", "Vibe Island", "Vibe Island", new THREE.Vector3(ISLAND_X, ISLAND_TOP, ISLAND_Z), ["island", "cardboard", "edge island", "cardboard island"]);
      reg("jerry", "Jerry the Mayor", "Cardboard Island", island.jerry, ["jerry", "mayor", "snail", "ben"]);
      reg("arcade", "Esmeralda Jump Arcade", "Cardboard Island", island.arcade, ["arcade", "esmeralda jump", "jump cabinet", "cabinet"]);
      reg("snackfe", "SnackFe Cafe", "Cardboard Island", island.snackfe, ["snackfe", "cafe", "snack", "ramen"]);
      reg("vibe-shop", "Vibe Coin Shop", "Cardboard Island", island.shop, ["shop", "coin shop", "vibe shop", "store"]);
      reg("portal", "Maker Portal", "Cardboard Island", island.portal, ["maker", "maker portal", "spawns"]);
      reg("avatar-portal", "Avatar Portal", "Cardboard Island", island.avatarPortal, ["avatar", "hologram", "character"]);
      reg("photo-tv", "Cardboard TV", "Cardboard Island", island.tv, ["tv", "photo tv", "gallery", "holo gallery"]);
      reg("moon", "The Moon", "Moon", new THREE.Vector3(MOON_X, MOON_TOP, MOON_Z), ["moon", "luna"]);
      reg("moon-2", "Second Moon", "Moon", new THREE.Vector3(MOON2_X, MOON2_TOP, MOON2_Z), ["second moon", "lil moon"]);
      reg("mars", "Mars", "Mars", new THREE.Vector3(MARS_X, MARS_TOP, MARS_Z), ["mars", "red planet", "gremlins"]);
      reg("traders-galaxy", "Trader Joe's Galaxy", "Trader's Galaxy", new THREE.Vector3(TJS_X, TJS_TOP, TJS_Z), ["traders", "trader joes", "tj", "galaxy"]);
      for (const pad of skyIslands.pads) {
        reg(pad.key, pad.name, "Sky Islands", pad.pos.clone(), ["sky island", "floating island", "islet"]);
      }
    }
    // Wire the gremlin minigame to the React HUD.
    setMarsGame((g) => ({
      ...g,
      alive: marsWorld.aliveCount(),
      total: marsWorld.totalCount(),
    }));
    const unsubMars = marsWorld.onChange((alive, total) =>
      setMarsGame((g) => {
        const next = { ...g, alive, total };
        // First kill starts the timer.
        if (!g.running && !g.cleared && alive < total) {
          next.running = true;
          next.runMs = 0;
        }
        // Last kill stops the timer and records the best.
        if (alive === 0 && total > 0 && g.running) {
          next.running = false;
          next.cleared = true;
          if (g.bestMs === null || g.runMs < g.bestMs) {
            next.bestMs = g.runMs;
            try {
              localStorage.setItem("city.bestMarsRun", String(Math.round(g.runMs)));
            } catch {
              /* ignore quota errors */
            }
          }
        }
        return next;
      }),
    );
    marsResetRef.current = () => {
      marsWorld.resetGremlins();
      marsInvulnRef.current = 0;
      setMarsGame((g) => ({
        ...g,
        hearts: MARS_MAX_HEARTS,
        runMs: 0,
        running: false,
        cleared: false,
      }));
    };

    // ---- Gremlin Mines (underground): pocket dimension at y=-300 ----
    const undergroundWorld = buildUnderground({
      centerX: UNDER_X,
      centerY: UNDER_Y,
      centerZ: UNDER_Z,
      boxes,
    });
    scene.add(undergroundWorld.group);
    undergroundWorldRef.current = undergroundWorld;

    // ---- Two ninja portals: Edge Island nook + city alley -----------
    const ninjaPortalIsland = makeNinjaPortal();
    ninjaPortalIsland.position.set(
      NINJA_PORTAL_ISLAND.x,
      NINJA_PORTAL_ISLAND.y,
      NINJA_PORTAL_ISLAND.z,
    );
    scene.add(ninjaPortalIsland);
    const ninjaPortalCity = makeNinjaPortal();
    ninjaPortalCity.position.set(
      NINJA_PORTAL_CITY.x,
      NINJA_PORTAL_CITY.y,
      NINJA_PORTAL_CITY.z,
    );
    scene.add(ninjaPortalCity);
    const ninjaPortals = [ninjaPortalIsland, ninjaPortalCity];

    // ---- Transcendence Portal (plaza) ---------------------------------
    // A glowing mint vortex you can step into to "transcend" — the same
    // FX also catches you if you ever slip through level geometry, so
    // you're never just falling forever into the void.
    const TRANSCEND_POS = new THREE.Vector3(14, 0.05, 14);
    const transcendPortal = new THREE.Group();
    transcendPortal.position.copy(TRANSCEND_POS);
    {
      // Mint outer ring.
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(2.4, 0.18, 12, 48),
        new THREE.MeshStandardMaterial({
          color: 0x7affd1,
          emissive: 0x4dffb8,
          emissiveIntensity: 1.6,
          metalness: 0.4,
          roughness: 0.25,
        }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.05;
      transcendPortal.add(ring);
      // Inner swirling disc.
      const swirl = new THREE.Mesh(
        new THREE.CircleGeometry(2.2, 48),
        new THREE.MeshBasicMaterial({
          color: 0x4dffd1,
          transparent: true,
          opacity: 0.55,
          side: THREE.DoubleSide,
        }),
      );
      swirl.rotation.x = -Math.PI / 2;
      swirl.position.y = 0.08;
      transcendPortal.add(swirl);
      // Glow pillar so you can see it from anywhere in the plaza.
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.9, 1.8, 26, 24, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x9affe0,
          transparent: true,
          opacity: 0.18,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      beam.position.y = 13;
      transcendPortal.add(beam);
      const light = new THREE.PointLight(0x6fffc4, 1.4, 22, 2);
      light.position.y = 1.6;
      transcendPortal.add(light);
      (transcendPortal as unknown as { __ring: THREE.Mesh; __swirl: THREE.Mesh }).__ring = ring;
      (transcendPortal as unknown as { __ring: THREE.Mesh; __swirl: THREE.Mesh }).__swirl = swirl;
    }
    scene.add(transcendPortal);

    // Cooldown ref so re-entering the disc doesn't loop instantly.
    // The physics loop (further below) reads TRANSCEND_POS / transcendState
    // to detect both voluntary entries and out-of-world falls.
    const transcendState = { cooldown: 0 };






    // ---- Collectible stars: plaza → rooftops → sky trail → island ---
    const starTrail = Array.from({ length: 6 }, (_, i) => {
      const t = (i + 1) / 7;
      return new THREE.Vector3(
        40 + (ISLAND_X - 60 - 40) * t,
        14 + (ISLAND_TOP - 8 - 14) * t,
        8 + (ISLAND_Z - 8) * t,
      );
    });
    const starPositions: THREE.Vector3[] = [
      new THREE.Vector3(8, 2, 10),
      new THREE.Vector3(-12, 2, 16),
      new THREE.Vector3(16, 2, -12),
      new THREE.Vector3(-18, 2, -10),
      ...pads.slice(0, 6).map((p) => new THREE.Vector3(p.x, p.y + 2.5, p.z)),
      ...starTrail,
      ...island.starSpots,
      // Three more ride the zipline loop…
      ...[0.6, 2.7, 4.8].map(
        (a) =>
          new THREE.Vector3(
            ISLAND_X + Math.cos(a) * island.zipline.radius,
            island.zipline.y - 2,
            ISLAND_Z + Math.sin(a) * island.zipline.radius,
          ),
      ),
      // …and one secret star hides under the island. Finding it makes
      // your jetpack burn rainbow for the rest of the session.
      new THREE.Vector3(ISLAND_X, ISLAND_TOP - 46, ISLAND_Z),
    ];
    const collectGeo = new THREE.OctahedronGeometry(0.9);
    const collectMat = new THREE.MeshBasicMaterial({
      color: "#ffd166",
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const collectibles = starPositions.map((p, i) => {
      const mesh = new THREE.Mesh(collectGeo, collectMat);
      mesh.position.copy(p);
      mesh.rotation.y = i;
      scene.add(mesh);
      return { mesh, baseY: p.y, taken: false };
    });
    let collectedCount = 0;

    // Star-run timer: starts on the first pickup, best time persists.
    let runStartMs: number | null = null;
    let runFinalMs: number | null = null;
    let bestMs: number | null = Number(localStorage.getItem("city.bestStarRun")) || null;
    resetRunRef.current = () => {
      collectibles.forEach((c) => {
        c.taken = false;
        c.mesh.visible = true;
      });
      collectedCount = 0;
      runStartMs = null;
      runFinalMs = null;
    };

    // ---- Residents: NPCs wandering the streets and the island -------
    // Wandering NPC crew removed — Edge Island is now agents-only.
    // Vibey + the live agent residents are the only inhabitants.


    // ---- Vibey, the community agent, drifting around the plaza ------
    const vibey = createVibeyNpc();
    scene.add(vibey.group);
    vibeyExciteRef.current = vibey.excite;

    // ---- Agent residents: every row in world_agents lives on Edge
    // Island. Their grid position from `world_agents.x,y` (the
    // `vibe-world` edge function) maps onto a disc on the island top,
    // so external agents calling `action:"move"` actually walk in 3D.
    // `world_messages` show up as speech bubbles; slash commands
    // (/jet, /jump, /wave, /dance) play a visible emote.
    const agentResidents = createAgentResidents({
      scene,
      characters: CHARACTERS,
      center: { x: ISLAND_X, y: ISLAND_TOP, z: ISLAND_Z },
      radius: 28,
      roomId: "vibe-lobby",
    });
    agentResidentsRef.current = agentResidents;
    let applyRemoteBump = (_x: number, _y: number, _z: number, _dirX: number, _dirZ: number, _speed: number) => {};

    // ---- Live Roster TV: scoreboard-style screen on the front of the
    // island showing every current agent and their lobby-grid tile.
    // Clicking it opens a fuller modal with the same list.
    // Moved further to the right (toward island center / Trader Joe's) so
    // the board has clear space on the plaza edge.
    // Town plan: just outside the plaza on the south path's west side.
    const ROSTER_LX = -8;
    const ROSTER_LZ = 23;
    const rosterBoard = createAgentRosterBoard({
      position: new THREE.Vector3(ISLAND_X + ROSTER_LX, ISLAND_TOP, ISLAND_Z + ROSTER_LZ),
      rotationY: Math.atan2(-ROSTER_LX, -ROSTER_LZ), // face the island center
      roomId: "vibe-lobby",
    });
    scene.add(rosterBoard.group);
    const unsubRoster = rosterBoard.onUpdate((rows) => setRosterAgents(rows));


    // ---- Multiplayer: presence ghosts + the community terminal ------
    const mp = createMultiplayer({
      scene,
      characterUrl: (n) => CHARACTERS.find((c) => c.name === n)?.url,
      name: localStorage.getItem("city.playerName") ?? "pilot",
      onChat: (msg) => {
        setChatMessages((prev) => [...prev.slice(-59), msg]);
        if (!chatOpenRef.current && !msg.self) setChatUnread((n) => n + 1);
      },
      onPeers: (count, online) => setPeers({ count: Math.max(1, count), online }),
      onTimeMode: (day) => {
        setDayMode(day);
        applyModeRef.current?.(day);
      },
      onEmote: (emote, fromPeer) => {
        if (!fromPeer) playLocalEmoteRef.current?.(emote);
      },
      onBump: (x, y, z, dirX, dirZ, speed) => {
        agentResidents.pushFrom(x, y, z, dirX, dirZ, speed, 1 / 30);
        applyRemoteBump(x, y, z, dirX, dirZ, speed);
      },
    });
    mpRef.current = mp;
    // Tell multiplayer who we are so DMs can find us by user id.
    try { mp.setUserId(authUserIdRef.current); } catch { /* noop */ }

    // ---- Cardboard TV: tune in the community photo gallery ----------
    // Same gallery_photos feed the /space TV uses. The VibeVerse brand
    // poster leads the rotation whenever it actually loads (probed via
    // an Image so a missing asset can never wedge a broken frame in).
    const posterRow = {
      url: VIBEVERSE_POSTER_URL,
      title: "VIBEVERSE",
      description: "Every builder grows the universe.",
      residency: null as string | null,
    };
    let tvRows: string[] = [];
    let posterOk = false;
    const applyTv = () => {
      const urls = [...(posterOk ? [posterRow.url] : []), ...tvRows];
      if (urls.length) island.setTvPhotos(urls);
    };
    const posterProbe = new Image();
    posterProbe.onload = () => {
      posterOk = true;
      applyTv();
      setGalleryPhotos((prev) =>
        prev.some((p) => p.url === posterRow.url) ? prev : [posterRow, ...prev],
      );
    };
    posterProbe.src = VIBEVERSE_POSTER_URL;
    void supabase
      .from("gallery_photos")
      .select("image_url, title, description, residency_name")
      .eq("community_id", "4202857f-13fd-4407-8906-3f8ffe63e510")
      .eq("is_visible", true)
      .order("display_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(64)
      .then(({ data }) => {
        const rows = (data ?? [])
          .map((row) => ({
            url: row.image_url as string,
            title: (row.title as string | null) ?? null,
            description: (row.description as string | null) ?? null,
            residency: (row.residency_name as string | null) ?? null,
          }))
          .filter((r) => !!r.url);
        if (rows.length) {
          tvRows = rows.map((r) => r.url);
          applyTv();
          setGalleryPhotos((prev) => {
            const lead = prev.filter((p) => p.url === posterRow.url);
            return [...lead, ...rows];
          });
        }
      });

    // Stars + moon (fog-exempt so they read at any distance).
    const starGeo = new THREE.BufferGeometry();
    {
      const r = rng(`${CITY_SEED}-stars`);
      const pts: number[] = [];
      for (let i = 0; i < 1400; i++) {
        const theta = r() * Math.PI * 2;
        const phi = r() * Math.PI * 0.48;
        const rad = 1500;
        pts.push(
          Math.cos(theta) * Math.cos(phi) * rad,
          Math.sin(phi) * rad + 40,
          Math.sin(theta) * Math.cos(phi) * rad,
        );
      }
      starGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    }
    const stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0xcfe8ff, size: 2.2, sizeAttenuation: false, fog: false }),
    );
    scene.add(stars);
    const moonMat = new THREE.MeshBasicMaterial({ color: "#e8f1ff", fog: false });
    const moon = new THREE.Mesh(new THREE.SphereGeometry(60, 32, 32), moonMat);
    moon.position.set(620, 430, -900);
    scene.add(moon);

    // ---- Puffy daytime clouds (v2: solid low-poly puffs) -------------
    // The old version used giant billboard sprites in a low ring — when
    // one drifted over Vibe Island the camera ended up inside a
    // 200m-wide white plane and the whole screen blew out. These are
    // opaque flat-shaded blob clusters instead (they shade like real
    // objects, no transparency sorting, no whiteout), banded high above
    // every walkable surface, kept out of exclusion zones around each
    // world, and drifting at a third of the old speed.
    const clouds = new THREE.Group();
    const updateClouds = (() => {
      const puffGeo = new THREE.IcosahedronGeometry(1, 1);
      const puffMat = new THREE.MeshLambertMaterial({
        color: 0xfdfdff,
        flatShading: true,
        fog: false,
      });
      // No clouds within these XZ discs — every landable world + the
      // arrival camera path stays crystal clear.
      const AVOID: Array<[number, number, number]> = [
        [ISLAND_X, ISLAND_Z, 200], // Vibe Island + arrival swoop
        [MOON_X, MOON_Z, 140],
        [MOON2_X, MOON2_Z, 140],
        [MARS_X, MARS_Z, 180],
        [TJS_X, TJS_Z, 180],
      ];
      const r = rng(`${CITY_SEED}-clouds`);
      const drifters: Array<{ g: THREE.Group; theta0: number; rad: number; y0: number; drift: number; bobPhase: number }> = [];
      const make = (
        count: number,
        yMin: number, yMax: number,
        radMin: number, radMax: number,
        sizeMin: number, sizeMax: number,
      ) => {
        for (let i = 0; i < count; i++) {
          // Rejection-sample a spot outside every exclusion zone.
          let theta = 0, rad = 0, x = 0, z = 0;
          let ok = false;
          for (let tries = 0; tries < 24 && !ok; tries++) {
            theta = r() * Math.PI * 2;
            rad = radMin + r() * (radMax - radMin);
            x = Math.cos(theta) * rad;
            z = Math.sin(theta) * rad;
            ok = AVOID.every(([ax, az, ar]) => Math.hypot(x - ax, z - az) > ar + sizeMax);
          }
          if (!ok) continue; // rare: just skip this cloud
          const cloud = new THREE.Group();
          const size = sizeMin + r() * (sizeMax - sizeMin);
          // 4-7 flattened lumps: one core + satellites hugging its waist.
          const lumps = 4 + Math.floor(r() * 4);
          for (let p = 0; p < lumps; p++) {
            const lump = new THREE.Mesh(puffGeo, puffMat);
            const core = p === 0;
            const lr = core ? size : size * (0.38 + r() * 0.34);
            lump.scale.set(lr, lr * (0.52 + r() * 0.14), lr * (0.8 + r() * 0.35));
            if (!core) {
              const a = r() * Math.PI * 2;
              lump.position.set(
                Math.cos(a) * size * (0.55 + r() * 0.5),
                (r() - 0.35) * size * 0.28,
                Math.sin(a) * size * (0.55 + r() * 0.5),
              );
            }
            lump.rotation.y = r() * Math.PI;
            cloud.add(lump);
          }
          const y0 = yMin + r() * (yMax - yMin);
          cloud.position.set(x, y0, z);
          clouds.add(cloud);
          drifters.push({
            g: cloud,
            theta0: theta,
            rad,
            y0,
            drift: 0.000007 + r() * 0.000013, // ~1/3 the old speed
            bobPhase: r() * Math.PI * 2,
          });
        }
      };
      // Mid band rings the city well above the island lawn (y 120) and
      // the zeppelin loop (y ~150, radius ≤ ~300 from origin).
      make(25, 165, 225, 430, 620, 26, 46);
      // Distant horizon band for depth.
      make(20, 230, 330, 700, 1150, 55, 95);
      return (now: number) => {
        if (!clouds.visible) return;
        for (const d of drifters) {
          const t = d.theta0 + now * d.drift;
          d.g.position.x = Math.cos(t) * d.rad;
          d.g.position.z = Math.sin(t) * d.rad;
          d.g.position.y = d.y0 + Math.sin(now * 0.00012 + d.bobPhase) * 3;
        }
      };
    })();
    scene.add(clouds);

    // ---- Day / night ------------------------------------------------
    // One function flips the whole atmosphere: sky, fog, lights,
    // window glow, stars. The moon doubles as the daytime sun disk.
    let baseFogNear = 90;
    let baseFogFar = 520;
    const applyMode = (day: boolean) => {
      const sky = day ? "#7ec0ee" : "#05080d";
      (scene.background as THREE.Color).set(sky);
      const fog = scene.fog as THREE.Fog;
      fog.color.set(day ? "#cfe6f5" : sky);
      baseFogNear = day ? 170 : 90;
      baseFogFar = day ? 1100 : 520;
      fog.near = baseFogNear;
      fog.far = baseFogFar;
      ambient.color.set(day ? 0xffffff : 0x8899bb);
      hemi.color.set(day ? 0xcfe8ff : 0x32445e);
      hemi.groundColor.set(day ? 0x8c96a4 : 0x0c1018);
      hemi.intensity = day ? 1.9 : 1.1;
      moonlight.color.set(day ? 0xfff2d0 : 0xbfd4ff);
      moonlight.intensity = day ? 2.3 : 1.05;
      plazaGlow.intensity = day ? 0 : 60;
      stars.visible = !day;
      clouds.visible = day;
      moonMat.color.set(day ? 0xfff6cf : 0xe8f1ff);
      buildingSkins.forEach((s) => {
        s.mat.map = day ? s.dayMap : s.nightMap;
        s.mat.emissiveIntensity = day ? 0 : 1.0;
        s.mat.needsUpdate = true;
      });
      plateMat.map = day ? groundDay : groundNight;
      plateMat.needsUpdate = true;
      waterUniforms.uDay.value = day ? 1 : 0;
      waterUniforms.uShallow.value.set(day ? "#3aa9c4" : "#0a1a2a");
      waterUniforms.uDeep.value.set(day ? "#0a2238" : "#02060d");
      waterUniforms.uSky.value.set(day ? "#bcdff5" : "#0a1322");
      waterUniforms.uFogColor.value.set(day ? "#cfe6f5" : "#05080d");
      waterUniforms.uFogNear.value = day ? 170 : 90;
      waterUniforms.uFogFar.value = day ? 1100 : 520;
    };
    applyModeRef.current = applyMode;

    // ---- Pilot + jetpack rig ----------------------------------------
    const player = new THREE.Group(); // origin = feet
    player.position.set(0, 0, 6);
    scene.add(player);
    const modelHolder = new THREE.Group(); // takes the flight tilt
    player.add(modelHolder);
    setPlayerScaleRef.current = (s: number) => {
      const clamped = Math.max(0.4, Math.min(12, s));
      modelHolder.scale.setScalar(clamped);
      playerScaleRef.current = clamped;
    };

    // ---- Local emote bubble (sprite parented to the player) ---------
    let localEmote: { sprite: THREE.Sprite; t: number; life: number; bob: number } | null = null;
    const playLocalEmote = (emote: EmoteName) => {
      if (localEmote) {
        player.remove(localEmote.sprite);
        localEmote.sprite.material.dispose();
        (localEmote.sprite.material.map as THREE.Texture | null)?.dispose();
      }
      const canvas = document.createElement("canvas");
      canvas.width = 192;
      canvas.height = 192;
      const ctx = canvas.getContext("2d")!;
      ctx.font = "140px system-ui, 'Apple Color Emoji', 'Segoe UI Emoji'";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(0,0,0,0.55)";
      ctx.shadowBlur = 14;
      ctx.fillText(EMOTE_EMOJI[emote] ?? "✨", 96, 104);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }),
      );
      sprite.scale.set(1.2, 1.2, 1);
      sprite.position.set(0, 3.0, 0);
      sprite.renderOrder = 999;
      player.add(sprite);
      localEmote = { sprite, t: 0, life: 2.6, bob: Math.random() * Math.PI * 2 };
    };
    playLocalEmoteRef.current = playLocalEmote;

    // ---- Local chat bubble (Club-Penguin style speech sprite) ------
    let localChat: { sprite: THREE.Sprite; t: number; life: number } | null = null;
    const playLocalChat = (text: string) => {
      if (localChat) {
        player.remove(localChat.sprite);
        localChat.sprite.material.dispose();
        (localChat.sprite.material.map as THREE.Texture | null)?.dispose();
      }
      const sprite = makeChatBubbleSprite(text);
      sprite.position.set(0, 3.2 + sprite.scale.y / 2, 0);
      player.add(sprite);
      localChat = { sprite, t: 0, life: CHAT_BUBBLE_DURATION };
    };
    playLocalChatRef.current = playLocalChat;

    let mixer: THREE.AnimationMixer | null = null;
    const actions = new Map<string, THREE.AnimationAction>();
    let activeAction: THREE.AnimationAction | null = null;
    let activeName = "";

    const playClip = (names: RegExp[], fallbackFirst = false) => {
      let pick: string | undefined;
      for (const re of names) {
        pick = [...actions.keys()].find((n) => re.test(n));
        if (pick) break;
      }
      if (!pick && fallbackFirst) pick = [...actions.keys()][0];
      if (!pick || pick === activeName) return;
      const next = actions.get(pick)!;
      // A plain "Jump" (no _Idle hover variant) fires once and holds
      // its final pose mid-air — not looping like a pogo stick.
      const once = /jump/i.test(pick) && !/idle/i.test(pick);
      if (once) {
        next.setLoop(THREE.LoopOnce, 1);
        next.clampWhenFinished = true;
      } else {
        next.setLoop(THREE.LoopRepeat, Infinity);
        next.clampWhenFinished = false;
      }
      next.reset().fadeIn(0.22).play();
      activeAction?.fadeOut(0.22);
      activeAction = next;
      activeName = pick;
    };

    const loader = new GLTFLoader();
    let pilotModel: THREE.Object3D | null = null;
    let pilotGen = 0;
    const loadPilot = (url: string) => {
      const gen = ++pilotGen;
      if (pilotModel) {
        modelHolder.remove(pilotModel);
        pilotModel.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.geometry?.dispose();
          const m = mesh.material as THREE.Material | THREE.Material[];
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else m?.dispose();
        });
        pilotModel = null;
      }
      mixer?.stopAllAction();
      mixer = null;
      actions.clear();
      activeAction = null;
      activeName = "";

      loader.load(url, (gltf) => {
        if (gen !== pilotGen) return; // superseded by a newer pick
        const model = gltf.scene;
        model.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        box.getSize(size);
        const fit = 1.85 / Math.max(size.x, size.y, size.z, 0.0001);
        model.scale.setScalar(fit);
        model.updateMatrixWorld(true);
        const scaled = new THREE.Box3().setFromObject(model);
        model.position.y = -scaled.min.y;
        model.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          const apply = (mat: THREE.Material) => {
            const std = mat as THREE.MeshStandardMaterial;
            if (std && "metalness" in std) {
              std.metalness = Math.min(std.metalness, 0.3);
              std.roughness = Math.max(std.roughness, 0.45);
              std.needsUpdate = true;
            }
          };
          const mat = mesh.material;
          if (Array.isArray(mat)) mat.forEach(apply);
          else if (mat) apply(mat);
        });
        pilotModel = model;
        modelHolder.add(model);

        if (gltf.animations.length) {
          mixer = new THREE.AnimationMixer(model);
          for (const clip of gltf.animations) {
            actions.set(shortClipName(clip.name), mixer.clipAction(clip));
          }
          console.debug("[city] pilot clips:", [...actions.keys()].join(", "));
          playClip([/^idle$/i, /idle/i], true);
        }
      });
    };
    loadPilotRef.current = (name) => {
      const c = CHARACTERS.find((x) => x.name === name);
      if (c) loadPilot(c.url);
    };
    {
      const start = CHARACTERS.find((c) => c.name === charRef.current) ?? CHARACTERS[0];
      if (start) loadPilot(start.url);
    }

    // ---- Avatar portal hologram preview --------------------------------
    // A holographic clone of the currently-previewed character that
    // floats on the avatar portal pedestal so the player can see
    // themselves before committing. Loads on demand when React tells
    // us the player is near; tears down when they walk away.
    let holoModel: THREE.Object3D | null = null;
    let holoMixer: THREE.AnimationMixer | null = null;
    let holoGen = 0;
    const disposeHolo = () => {
      if (!holoModel) return;
      island.avatarStage.remove(holoModel);
      holoModel.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      holoModel = null;
      holoMixer?.stopAllAction();
      holoMixer = null;
    };
    const holoLoader = new GLTFLoader();
    mountAvatarHoloRef.current = (charNameForHolo) => {
      const gen = ++holoGen;
      disposeHolo();
      if (!charNameForHolo) return;
      const c = CHARACTERS.find((x) => x.name === charNameForHolo);
      if (!c) return;
      holoLoader.load(c.url, (gltf) => {
        if (gen !== holoGen) return; // superseded
        const model = gltf.scene;
        model.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        box.getSize(size);
        const fit = 2.2 / Math.max(size.x, size.y, size.z, 0.0001);
        model.scale.setScalar(fit);
        model.updateMatrixWorld(true);
        const scaled = new THREE.Box3().setFromObject(model);
        model.position.y = -scaled.min.y;
        model.position.x = -((scaled.min.x + scaled.max.x) / 2);
        model.position.z = -((scaled.min.z + scaled.max.z) / 2);
        // Swap every material with an additive cyan-tinted basic mat so
        // the silhouette reads as a hologram instead of a real model.
        model.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          const swap = (mat: THREE.Material): THREE.Material => {
            const std = mat as THREE.MeshStandardMaterial;
            const base = std.color?.clone() ?? new THREE.Color("#7af0ff");
            base.lerp(new THREE.Color("#7af0ff"), 0.4);
            return new THREE.MeshBasicMaterial({
              color: base,
              transparent: true,
              opacity: 0.62,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
              fog: false,
            });
          };
          if (Array.isArray(mesh.material)) {
            mesh.material = mesh.material.map(swap);
          } else if (mesh.material) {
            mesh.material = swap(mesh.material);
          }
        });
        holoModel = model;
        island.avatarStage.add(model);
        if (gltf.animations.length) {
          holoMixer = new THREE.AnimationMixer(model);
          const idle =
            gltf.animations.find((a) => /idle/i.test(a.name)) ?? gltf.animations[0];
          if (idle) holoMixer.clipAction(idle).reset().play();
        }
      });
    };
    // Per-frame holo tick — gentle spin + animation mixer.
    const updateAvatarHolo = (dt: number) => {
      if (holoModel) holoModel.rotation.y += dt * 0.6;
      holoMixer?.update(dt);
    };



    // Procedural jetpack: backplate + twin tanks + nozzles + flames.
    const jetpack = new THREE.Group();
    const packMat = new THREE.MeshStandardMaterial({
      color: "#1d2733",
      roughness: 0.5,
      metalness: 0.55,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: "#2dd4a8",
      emissive: "#2dd4a8",
      emissiveIntensity: 0.7,
      roughness: 0.4,
    });
    const backplate = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.12), packMat);
    jetpack.add(backplate);
    const flameMat = new THREE.MeshBasicMaterial({
      color: "#7dfce0",
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const flames: THREE.Mesh[] = [];
    [-0.13, 0.13].forEach((x) => {
      const tank = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.34, 6, 12), packMat);
      tank.position.set(x, 0, -0.1);
      jetpack.add(tank);
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 0.07, 12), trimMat);
      collar.position.set(x, -0.3, -0.1);
      jetpack.add(collar);
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.5, 10), flameMat);
      flame.rotation.x = Math.PI; // point down
      flame.position.set(x, -0.58, -0.1);
      flame.visible = false;
      jetpack.add(flame);
      flames.push(flame);
    });
    jetpack.position.set(0, 1.06, -0.24); // on the pilot's back
    modelHolder.add(jetpack);
    const jetLight = new THREE.PointLight(0x7dfce0, 0, 9, 2);
    jetLight.position.set(0, 0.4, -0.2);
    player.add(jetLight);

    // ---- Cosmetics: hat + jet flame color, both equippable from the
    // Vibe Shop. Hat is parented to modelHolder so it tilts with the
    // pilot. Flame color also tints the jet point light.
    const hatMount = new THREE.Group();
    hatMount.position.set(0, 1.78, 0); // just above a ~1.85m model's head
    modelHolder.add(hatMount);
    let currentHat: THREE.Group | null = null;
    const applyHat = (id: string) => {
      if (currentHat) {
        hatMount.remove(currentHat);
        currentHat.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.geometry?.dispose();
            const mat = m.material as THREE.Material | THREE.Material[];
            if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
            else mat?.dispose();
          }
        });
        currentHat = null;
      }
      const def = HAT_CATALOG.find((h) => h.id === id) ?? HAT_CATALOG[0];
      const g = def.build();
      hatMount.add(g);
      currentHat = g;
    };
    applyHatRef.current = applyHat;
    const applyFlame = (id: string) => {
      const def = FLAME_CATALOG.find((f) => f.id === id) ?? FLAME_CATALOG[0];
      flameMat.color.set(def.color);
      jetLight.color.set(def.core);
    };
    applyFlameRef.current = applyFlame;
    // Jetpack equip / color / "returned" state. When equipped=false the
    // whole pack hides AND thrust is disabled — you handed it back at the
    // Vibe Shop. Body + trim colors are tinted live.
    let jetpackEquipped = true;
    const applyJetpack = (id: string) => {
      const def = JETPACK_CATALOG.find((j) => j.id === id) ?? JETPACK_CATALOG[0];
      jetpackEquipped = def.equipped;
      jetpack.visible = def.equipped;
      if (def.equipped) {
        packMat.color.set(def.body);
        trimMat.color.set(def.trim);
        trimMat.emissive.set(def.trim);
      }
    };
    applyJetpackRef.current = applyJetpack;
    applyHat(localStorage.getItem("city.hat") || "none");
    applyFlame(localStorage.getItem("city.flame") || "mint");
    applyJetpack(localStorage.getItem("city.jetpack") || "stock");


    // Zipline T-handle, visible only while riding the cable.
    const zipHandle = new THREE.Group();
    {
      const metal = new THREE.MeshStandardMaterial({
        color: "#7d8694",
        roughness: 0.4,
        metalness: 0.6,
      });
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 8), metal);
      stem.position.y = 0.45;
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.7, 8), metal);
      bar.rotation.z = Math.PI / 2;
      zipHandle.add(stem, bar);
    }
    zipHandle.position.y = 2.3;
    zipHandle.visible = false;
    player.add(zipHandle);

    // Thruster particle trail.
    const P_COUNT = 160;
    const pPos = new Float32Array(P_COUNT * 3);
    const pLife = new Float32Array(P_COUNT).fill(0);
    const pVel = new Float32Array(P_COUNT * 3);
    const particleGeo = new THREE.BufferGeometry();
    particleGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
    const particles = new THREE.Points(
      particleGeo,
      new THREE.PointsMaterial({
        color: 0x7dfce0,
        size: 0.32,
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    particles.frustumCulled = false;
    scene.add(particles);
    let nextParticle = 0;

    // ---- Input -------------------------------------------------------
    const keys = new Set<string>();
    const handled = new Set([
      "KeyW", "KeyA", "KeyS", "KeyD",
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "Space", "ShiftLeft", "ShiftRight",
    ]);
    // Don't steal keys while the player is typing in chat.
    const isTyping = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e) || !enteredRef.current || !handled.has(e.code)) return;
      e.preventDefault();
      arrivalStart = 0; // input ends the arrival cinematic
      keys.add(e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // Easter egg: type "vibe" anywhere (not in chat) → 20s of disco.
    let typedEgg = "";
    const onTypeEgg = (e: KeyboardEvent) => {
      if (isTyping(e) || !/^[a-z]$/i.test(e.key)) return;
      typedEgg = (typedEgg + e.key.toLowerCase()).slice(-6);
      if (typedEgg.endsWith("vibe")) {
        typedEgg = "";
        discoUntil = performance.now() + 20000;
        soundsRef.current?.fanfare();
      }
    };
    window.addEventListener("keydown", onTypeEgg);

    // Drag-to-orbit camera (no pointer lock — phone-friendlier later).
    let camYaw = Math.PI;
    let camPitch = 0.42;
    let camDist = 9;
    // Vibe Island arrival cinematic: while set, the camera starts far
    // out and swoops down to the lawn over ~4.5s of WALL time. Any
    // input hands control straight back.
    let arrivalStart = 0;
    const ARRIVAL_MS = 4500;
    // VR-only: stable "body yaw" the dolly is parked behind. This is
    // intentionally decoupled from the headset rotation so turning your
    // head doesn't slide the world (the #1 source of sim-sickness here).
    // We lerp it toward the player's movement direction when they walk,
    // and otherwise it just holds — head can swivel freely inside it.
    let vrBodyYaw = Math.PI;
    let vrFirstPerson = false;
    // Edge-detect controller buttons (A/B = indices 4/5 on xr-standard)
    // so a single press toggles 1st/3rd person without re-firing each frame.
    const vrPrevBtn = new Map<string, boolean>();

    // Toggle 1st/3rd person with "V" on desktop (mirrors the VR button).
    const onToggleView = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.code === "KeyV") {
        vrFirstPerson = !vrFirstPerson;
      }
    };
    window.addEventListener("keydown", onToggleView);
    // Manual delta tracking (movementX is unreliable for touch
    // pointers on mobile Safari). One finger drags the camera; two
    // fingers on the canvas pinch-zoom, all the way out to god view.
    const pointers = new Map<number, { x: number; y: number }>();
    let dragPointer: number | null = null;
    let dragLast = { x: 0, y: 0 };
    let pinchStart: { dist: number; camDist: number } | null = null;
    const clampDist = (d: number) => THREE.MathUtils.clamp(d, MIN_CAM_DIST, MAX_CAM_DIST);
    // (Mars gremlins are now killed by stomping in the physics tick,
    // not by tapping — no raycaster needed.)
    let tapStart: { x: number; y: number; t: number } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      arrivalStart = 0; // input ends the arrival cinematic
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      if (pointers.size === 1) {
        dragPointer = e.pointerId;
        dragLast = { x: e.clientX, y: e.clientY };
        tapStart = { x: e.clientX, y: e.clientY, t: performance.now() };
      } else if (pointers.size === 2) {
        dragPointer = null; // two fingers = pinch, not look
        const [a, b] = [...pointers.values()];
        pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), camDist };
        tapStart = null;
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      const p = pointers.get(e.pointerId);
      if (p) {
        p.x = e.clientX;
        p.y = e.clientY;
      }
      if (pointers.size === 2 && pinchStart) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 16) camDist = clampDist(pinchStart.camDist * (pinchStart.dist / d));
        return;
      }
      if (dragPointer !== e.pointerId) return;
      const dx = e.clientX - dragLast.x;
      const dy = e.clientY - dragLast.y;
      dragLast = { x: e.clientX, y: e.clientY };
      camYaw -= dx * 0.0052;
      camPitch = THREE.MathUtils.clamp(camPitch + dy * 0.0052, 0.06, 1.25);
    };
    const onPointerUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = null;
      if (dragPointer === e.pointerId) dragPointer = null;
      // Tap (not drag): raycast for clickable props — currently the
      // $VIBE emblem over the shop. Gremlin stomps stay physics-driven.
      if (tapStart) {
        const moved = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
        const held = performance.now() - tapStart.t;
        if (moved < 8 && held < 450 && vibeEmblemHit) {
          const rect = canvas.getBoundingClientRect();
          const ndc = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -(((e.clientY - rect.top) / rect.height) * 2 - 1),
          );
          const ray = new THREE.Raycaster();
          ray.setFromCamera(ndc, camera);
          if (ray.intersectObject(vibeEmblemHit, false).length > 0) {
            triggerEmblemFun();
          }
        }
        tapStart = null;
      }
    };
    // Laptop trackpads report pinches as ctrl+wheel — zoom the camera
    // instead of the page, with a much stronger rate than scrolling.
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
      const rate = e.ctrlKey ? 0.01 : 0.0011;
      camDist = clampDist(camDist * (1 + e.deltaY * rate));
    };
    // Safari (macOS/iOS) reports trackpad pinches as gesture events.
    let gestureStartDist = camDist;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStartDist = camDist;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const scale = (e as unknown as { scale?: number }).scale || 1;
      camDist = clampDist(gestureStartDist / scale);
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("gesturestart", onGestureStart);
    canvas.addEventListener("gesturechange", onGestureChange);

    // ---- Collision helpers --------------------------------------------
    // Only surfaces at or below refY can support you — so the floating
    // island doesn't "catch" a pilot flying far beneath it.
    const supportHeightAt = (x: number, z: number, refY: number): number => {
      // Track the tallest box top at or below refY that overlaps (x,z).
      // If nothing matches and refY is on/above street level, fall back to
      // 0 (the world floor). If refY is well below street (in the
      // Gremlin Mines pocket dimension), fall back to a deep void so the
      // player can't be "snapped up" to the surface by accident.
      let h = -Infinity;
      for (const b of boxes) {
        if (b.height <= refY &&
            x >= b.minX - PLAYER_RADIUS && x <= b.maxX + PLAYER_RADIUS &&
            z >= b.minZ - PLAYER_RADIUS && z <= b.maxZ + PLAYER_RADIUS) {
          if (b.height > h) h = b.height;
        }
      }
      if (h !== -Infinity) return h;
      return refY < -50 ? refY - 9999 : 0;
    };


    // Blocked when the body (feet y .. head y+1.7) overlaps a column.
    const blockedAt = (x: number, z: number, y: number): boolean => {
      for (const b of boxes) {
        if (y < b.height - 0.4 && y + 1.7 > b.base &&
            x >= b.minX - PLAYER_RADIUS && x <= b.maxX + PLAYER_RADIUS &&
            z >= b.minZ - PLAYER_RADIUS && z <= b.maxZ + PLAYER_RADIUS) {
          return true;
        }
      }
      return false;
    };

    // ---- Simulation state ---------------------------------------------
    const vel = new THREE.Vector3();
    let onGround = true;
    let prevJetInput = false;
    let coyoteTimer = 0; // grace window so jumping just after leaving ground feels right
    let wallJumpUsed = false; // one parkour wall-jump per air phase
    let peakY = 0; // highest Y reached this air phase, for fall-damage
    let ridingZeppelin = false; // standing on the circling zeppelin's deck
    let zeppelinToastShown = false;
    let modelYaw = 0;
    let lastTime = performance.now();
    let riding = false; // on the zipline
    let zipAngle = 0;
    let swinging = false; // on the swing
    let rainbowOn = false; // secret star found
    let discoUntil = 0; // "vibe" typed → plaza disco
    applyRemoteBump = (x, y, z, dirX, dirZ, speed) => {
      const pos = player.position;
      if (Math.abs(pos.y - y) > 2.6) return;
      const dx = pos.x - x;
      const dz = pos.z - z;
      if (dx * dx + dz * dz > 1.75 * 1.75) return;
      const shove = Math.min(10, 2.8 + speed * 0.32);
      vel.x += dirX * shove;
      vel.z += dirZ * shove;
    };
    const zip = island.zipline;

    zipGrabRef.current = () => {
      if (riding) {
        riding = false;
        return;
      }
      zipAngle = Math.atan2(player.position.z - zip.z, player.position.x - zip.x);
      riding = true;
      onGround = false;
    };
    swingGrabRef.current = () => {
      if (swinging) {
        swinging = false;
        // Hop off with a gentle forward nudge in the swing's direction.
        const a = island.swingAngle();
        vel.set(0, 4, Math.sin(a) * 6);
        onGround = false;
        return;
      }
      swinging = true;
      riding = false;
      onGround = false;
      vel.set(0, 0, 0);
    };
    mooRef.current = () => {
      soundsRef.current?.moo();
    };


    const hudTimer = window.setInterval(() => {
      setHud({
        alt: Math.max(0, player.position.y),
        spd: vel.length(),
        jet: keys.has("Space") && enteredRef.current,
        stars: collectedCount,
        totalStars: collectibles.length,
        gems: Math.max(0, Math.round(vibeBalanceRef.current)),
        runMs:
          runFinalMs ?? (runStartMs !== null ? performance.now() - runStartMs : null),
        bestMs,
        nearIsland: player.position.x > 250 && player.position.z > -120,
        nearMoon:
          Math.hypot(player.position.x - MOON_X, player.position.z - MOON_Z) < 60 &&
          player.position.y > MOON_TOP - 30,
        nearMars:
          Math.hypot(player.position.x - MARS_X, player.position.z - MARS_Z) < 70 &&
          player.position.y > MARS_TOP - 30,
        nearTjs:
          Math.hypot(player.position.x - TJS_X, player.position.z - TJS_Z) < TJS_ISLET_R * 3 &&
          player.position.y > TJS_TOP - 30,
        nearZip:
          Math.abs(
            Math.hypot(player.position.x - zip.x, player.position.z - zip.z) - zip.radius,
          ) < 5 && Math.abs(player.position.y - (zip.y - 5)) < 9,
        riding,
        nearSwing: player.position.distanceTo(island.swingMount) < 4.5,
        swinging,
        nearCow: false,

      });
      // Sky-island mini games: start prompt + live status line.
      const ng = skyGames.nearGame(player.position);
      setNearGamePrompt((prev) => (prev?.key === ng?.key ? prev : ng));
      setGameHud(skyGames.hudLine());
      setNearVibey(player.position.distanceTo(vibey.position) < 8);
      setNearJerry(player.position.distanceTo(island.jerry) < 8);
      // Nearest Palace housemate in talk range.
      {
        let hit: { key: NpcKey; name: string } | null = null;
        for (const n of ninjaShow.positions()) {
          if (player.position.distanceTo(n.pos) < 3.8) {
            hit = { key: n.key, name: n.name };
            break;
          }
        }
        setNearNinjaCast((prev) => (prev?.key === hit?.key ? prev : hit));
      }
      jerryWorldRef.current = { x: island.jerry.x, y: island.jerry.y, z: island.jerry.z };
      setNearSnackfe(player.position.distanceTo(island.snackfe) < 7);
      setNearShop(player.position.distanceTo(island.shop) < 7);
      // Nearest parked kart in hop-on range (hidden while driving).
      {
        let nk = -1;
        if (drivingKartRef.current < 0) {
          for (let i = 0; i < kartStates.length; i++) {
            const k = kartStates[i];
            if (
              Math.hypot(player.position.x - k.x, player.position.z - k.z) < 5 &&
              Math.abs(player.position.y - k.y) < 4
            ) { nk = i; break; }
          }
        }
        setNearKart(nk);
      }
      setNearPortal(player.position.distanceTo(island.portal) < 5.5);
      setNearAvatarPortal(player.position.distanceTo(island.avatarPortal) < 5.5);
      setNearArcade(player.position.distanceTo(island.arcade) < 4);
      setNearTv(player.position.distanceTo(island.tv) < 5.5);
      setNearRoster(player.position.distanceTo(rosterBoard.position) < 7);
      // Either ninja portal is "near" if within ~4m.
      const np1 = new THREE.Vector3(NINJA_PORTAL_ISLAND.x, NINJA_PORTAL_ISLAND.y + 1, NINJA_PORTAL_ISLAND.z);
      const np2 = new THREE.Vector3(NINJA_PORTAL_CITY.x, NINJA_PORTAL_CITY.y + 1, NINJA_PORTAL_CITY.z);
      const nearNinja =
        !undergroundActiveRef.current &&
        (player.position.distanceTo(np1) < 4 || player.position.distanceTo(np2) < 4);
      setNearNinjaPortal(nearNinja);
      // Track whether the player is on Mars so the gremlin HUD shows.
      const onMarsNow =
        Math.hypot(player.position.x - MARS_X, player.position.z - MARS_Z) < 70 &&
        player.position.y > MARS_TOP - 30;
      setMarsGame((g) => (g.onMars === onMarsNow ? g : { ...g, onMars: onMarsNow }));


      // Nearest chattable person (real player OR AI agent) within ~3.2m.
      const NEAR_RADIUS = 3.2;
      const nP = mpRef.current?.getNearestPlayer(player.position.x, player.position.y, player.position.z, NEAR_RADIUS) ?? null;
      const nA = agentResidentsRef.current?.getNearestAgent(player.position.x, player.position.y, player.position.z, NEAR_RADIUS) ?? null;
      let pick: PersonTarget | null = null;
      if (nP && (!nA || nP.distSq <= nA.distSq)) {
        pick = { kind: "player", ref: nP.ref, name: nP.name };
      } else if (nA) {
        pick = { kind: "agent", ref: nA.agentId, name: nA.name };
      }
      setNearPerson((prev) => {
        if (!prev && !pick) return prev;
        if (prev && pick && prev.kind === pick.kind && prev.ref === pick.ref && prev.name === pick.name) return prev;
        return pick;
      });
    }, 120);


    // Fast travel: cycle plaza → Cardboard Island → Moon → Mars → TJ's Galaxy → plaza.
    // Arrive a few meters above each landing so you flutter down.
    travelRef.current = () => {
      const p = player.position;
      const onIsland = p.x > 250 && p.z > -120 && p.y < MOON_TOP - 30;
      const onMoon =
        Math.hypot(p.x - MOON_X, p.z - MOON_Z) < 60 && p.y > MOON_TOP - 20;
      const onMars =
        Math.hypot(p.x - MARS_X, p.z - MARS_Z) < 70 && p.y > MARS_TOP - 20;
      const onTjs =
        Math.hypot(p.x - TJS_X, p.z - TJS_Z) < TJS_ISLET_R * 3 && p.y > TJS_TOP - 20;
      if (onTjs) {
        p.set(0, 0, 6);
      } else if (onMars) {
        p.copy(tjsWorld.spawn);
      } else if (onMoon) {
        p.copy(marsWorld.spawn);
      } else if (onIsland) {
        p.set(MOON_X, MOON_TOP + 6, MOON_Z + 4);
      } else {
        p.set(ISLAND_X, ISLAND_TOP + 6, ISLAND_Z + 7);
      }
      vel.set(0, 0, 0);
      onGround = false;
    };
    // /city?spawn=island drops visitors straight onto the island lawn.
    // Camera starts in FRONT of the avatar (camYaw = 0) so the very first
    // frame shows the character's face, not the back of their head — the
    // chase-cam re-orients to behind as soon as the player drags or moves.
    islandSpawnRef.current = () => {
      // Land right on the plaza lawn (no drop — arriving used to feel
      // like popping up from under the island) and roll the arrival
      // cinematic: a far establishing shot that swoops down to you.
      player.position.set(ISLAND_X, ISLAND_TOP + 0.4, ISLAND_Z + 7);
      vel.set(0, 0, 0);
      onGround = false;
      // Open on the cinematic's far pose and snap the camera straight
      // there — otherwise the first frame lerps in from wherever the
      // camera was and streaks across the city.
      camYaw = 0.85;
      camPitch = 0.5;
      camDist = 150;
      arrivalStart = performance.now();
      camera.position.set(
        player.position.x + Math.sin(camYaw) * Math.cos(camPitch) * camDist,
        player.position.y + Math.sin(camPitch) * camDist + 1.4,
        player.position.z + Math.cos(camYaw) * Math.cos(camPitch) * camDist,
      );
      camera.lookAt(player.position.x, player.position.y + 1.5, player.position.z);
    };
    // /city?spawn=moon drops visitors onto the moon's landing pad.
    moonSpawnRef.current = () => {
      player.position.copy(moonWorld.spawn);
      vel.set(0, 0, 0);
      onGround = false;
    };
    // /city?spawn=mars drops visitors onto the Mars landing pad.
    marsSpawnRef.current = () => {
      player.position.copy(marsWorld.spawn);
      vel.set(0, 0, 0);
      onGround = false;
    };
    // /city?spawn=tjs drops visitors onto TJ's Galaxy plaza.
    tjsSpawnRef.current = () => {
      player.position.copy(tjsWorld.spawn);
      vel.set(0, 0, 0);
      onGround = false;
    };

    // ---- Enter / exit the Gremlin Mines ----------------------------
    // Saves your character + jetpack, teleports you down, swaps you
    // into a Ninja skin. Exiting restores everything in place.
    enterUndergroundRef.current = () => {
      const p = player.position;
      // Pick a Ninja character (prefer the male, fall back to anything
      // starting with "Ninja_", then to current).
      const ninja =
        CHARACTERS.find((c) => c.name === "Ninja_Male") ??
        CHARACTERS.find((c) => c.name.startsWith("Ninja_")) ??
        CHARACTERS.find((c) => c.name === charRef.current) ??
        CHARACTERS[0];
      ninjaStateRef.current = {
        prevChar: charRef.current,
        prevJet: localStorage.getItem("city.jetpack") || "stock",
        returnPos: { x: p.x, y: p.y, z: p.z },
      };
      // Swap character (visual only — don't broadcast to the lobby pick).
      if (ninja && ninja.name !== charRef.current) {
        loadPilotRef.current?.(ninja.name);
        charRef.current = ninja.name;
        setCharName(ninja.name);
      }
      // Park the jetpack so Space becomes the jump button down here.
      applyJetpackRef.current?.("none");
      setEquippedJetpack("none");
      // Teleport to the cavern spawn (above the floor → flutter down
      // through the purple mist column).
      const sp = undergroundWorld.spawn;
      player.position.set(sp.x, sp.y, sp.z);
      vel.set(0, 0, 0);
      onGround = false;
      peakY = sp.y;
      undergroundActiveRef.current = true;
      setUnderground(true);
      setBossHp(undergroundWorld.bossHpRemaining());
      setEnterFx(Date.now());
    };
    exitUndergroundRef.current = () => {
      const st = ninjaStateRef.current;
      // Restore character + jetpack.
      if (st) {
        if (st.prevChar && st.prevChar !== charRef.current) {
          loadPilotRef.current?.(st.prevChar);
          charRef.current = st.prevChar;
          setCharName(st.prevChar);
        }
        applyJetpackRef.current?.(st.prevJet);
        setEquippedJetpack(st.prevJet);
        // Pop you a couple metres above the portal you came in through.
        player.position.set(st.returnPos.x, st.returnPos.y + 2, st.returnPos.z);
      } else {
        // Fallback: drop into plaza.
        player.position.set(0, 6, 6);
      }
      vel.set(0, 0, 0);
      onGround = false;
      // Reset airborne tracking so the long teleport up doesn't trip
      // fall damage on the very next landing.
      peakY = player.position.y;
      wallJumpUsed = false;
      undergroundActiveRef.current = false;
      undergroundInvulnRef.current = 0;
      setUnderground(false);

      // Reset the mines so the next run starts fresh.
      undergroundWorld.reset();
      setBossHp(undergroundWorld.bossHpRemaining());
    };


    // __cityDebug.teleport(330, 130, -30) drops you over the island.
    // __cityDebug.zeppelin() returns the live deck center [x, y, z].
    // player() / setCam() exist so headless tests can assert and frame.
    const devWindow = window as unknown as {
      __cityDebug?: {
        teleport: (x: number, y: number, z: number) => void;
        zeppelin: () => [number, number, number];
        player: () => [number, number, number];
        setCam: (yaw: number, pitch?: number, dist?: number) => void;
        emblemFun: () => void;
      };
    };
    devWindow.__cityDebug = {
      teleport: (x, y, z) => {
        player.position.set(x, y, z);
        vel.set(0, 0, 0);
      },
      zeppelin: () => {
        const z = skyIslands.zeppelin;
        return [z.pos.x, z.pos.y + z.deckY, z.pos.z];
      },
      player: () => [player.position.x, player.position.y, player.position.z],
      setCam: (yaw, pitch, dist) => {
        camYaw = yaw;
        if (pitch !== undefined) camPitch = pitch;
        if (dist !== undefined) camDist = dist;
      },
      emblemFun: () => triggerEmblemFun(),
    };

    const disposeVR = enableVR(renderer, canvas.parentElement!, {
      referenceSpace: "local-floor",
    });

    const tick = () => {
      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      // VR input: read the strongest thumbstick from any connected
      // controller and feed it through the same touch refs that the
      // on-screen joystick uses. LEFT controller buttons fire the
      // jetpack; RIGHT controller trigger is the "click" for the
      // point-and-click action menu (handled further down).
      const xrPresenting = renderer.xr.isPresenting;
      // Edge-detected right-trigger clicks (consumed by interaction below).
      let vrRightClickEdge = false;
      // Per-controller indexed click — so we can use the actual right
      // controller's pose when raycasting on the same frame as the press.
      const vrRightClickCtrlIdx: number[] = [];
      if (xrPresenting) {
        const session = renderer.xr.getSession();
        let mx = 0, my = 0, jet = false;
        if (session) {
          let srcIdx = 0;
          for (const src of session.inputSources) {
            const gp = src.gamepad;
            const hand = src.handedness ?? "none";
            if (gp) {
              const a0 = gp.axes[0] ?? 0;
              const a1 = gp.axes[1] ?? 0;
              const a2 = gp.axes[2] ?? 0;
              const a3 = gp.axes[3] ?? 0;
              const useHigh = Math.hypot(a2, a3) >= Math.hypot(a0, a1);
              const rx = useHigh ? a2 : a0;
              const ry = useHigh ? a3 : a1;
              if (Math.hypot(rx, ry) > Math.hypot(mx, my)) { mx = rx; my = ry; }
              // Jetpack: LEFT controller only (trigger/grip/stick-click).
              // Right controller is reserved for pointing/clicking so the
              // jet doesn't fire while you're trying to interact.
              // A/X (4) and B/Y (5) on either side toggle 1st/3rd person.
              for (let i = 0; i < gp.buttons.length; i++) {
                const pressed = !!gp.buttons[i]?.pressed;
                if (hand === "left" && pressed && (i === 0 || i === 1 || i === 3)) jet = true;
                if (hand === "right" && i === 0) {
                  // Right trigger edge → interaction click.
                  const key = -1 - srcIdx; // distinct from view-toggle keys
                  const prev = vrPrevBtn.get(`rt:${srcIdx}`) ? true : false;
                  if (pressed && !prev) {
                    vrRightClickEdge = true;
                    // Find which xr-controller index matches this input
                    // source so we can read its world pose for raycast.
                    for (let ci = 0; ci < vrCtrlHand.length; ci++) {
                      if (vrCtrlHand[ci] === "right") vrRightClickCtrlIdx.push(ci);
                    }
                  }
                  vrPrevBtn.set(`rt:${srcIdx}`, pressed);
                  void key;
                }
                if (i === 4 || i === 5) {
                  const key = `${hand}:${i}`;
                  const prev = vrPrevBtn.get(key) ?? false;
                  if (pressed && !prev) vrFirstPerson = !vrFirstPerson;
                  vrPrevBtn.set(key, pressed);
                }
              }
            }
            srcIdx++;
          }
        }
        if (Math.hypot(mx, my) < 0.15) { mx = 0; my = 0; }
        touchMoveRef.current.x = mx;
        touchMoveRef.current.y = my;
        touchJetRef.current = jet;
        // No "Enter Vibe City" overlay click happens in VR — entering
        // the immersive session IS the consent gesture.
        if (!enteredRef.current) {
          enteredRef.current = true;
          setEntered(true);
          if (!soundsRef.current) soundsRef.current = createCitySounds();
          soundsRef.current?.setMuted(muted);
        }
      }

      // VR point-and-click: raycast from the right controller, highlight
      // the targeted person, and drive the floating action menu.
      if (xrPresenting) {
        // Find the right controller's three.js Group (already positioned
        // by xr each frame). Fall back to any controller if handedness
        // hasn't been reported yet.
        let rIdx = vrCtrlHand.indexOf("right");
        if (rIdx < 0) rIdx = vrCtrlHand.findIndex((h) => h !== "none");
        const rCtrl = rIdx >= 0 ? vrControllers[rIdx] : null;
        if (rCtrl) {
          // World-space ray from the controller, pointing -Z.
          const origin = new THREE.Vector3().setFromMatrixPosition(rCtrl.matrixWorld);
          const rot = new THREE.Matrix4().extractRotation(rCtrl.matrixWorld);
          const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(rot).normalize();

          // If the menu is up, raycast against its buttons first.
          let hoverIdx = -1;
          if (vrMenu.target && vrMenuGroup.visible) {
            const raycaster = new THREE.Raycaster(origin, dir, 0.1, 30);
            const hits = raycaster.intersectObjects(
              vrButtons.map((b) => b.sprite),
              false,
            );
            if (hits.length) {
              const hitSprite = hits[0].object as THREE.Sprite;
              hoverIdx = vrButtons.findIndex((b) => b.sprite === hitSprite);
            }
          }
          vrMenu.hoverIdx = hoverIdx;

          // If no button is hovered, probe forward along the ray for a
          // person at a few distances. Cheap and good enough — avoids
          // wiring iteration APIs into multiplayer/agent modules.
          let aimed: PersonTarget | null = null;
          if (hoverIdx < 0) {
            const probes = [1.2, 2.5, 4, 6, 9, 13, 18];
            for (const t of probes) {
              const px = origin.x + dir.x * t;
              const py = origin.y + dir.y * t;
              const pz = origin.z + dir.z * t;
              const nP = mpRef.current?.getNearestPlayer(px, py, pz, 1.6) ?? null;
              const nA = agentResidentsRef.current?.getNearestAgent(px, py, pz, 1.6) ?? null;
              if (nP && (!nA || nP.distSq <= nA.distSq)) {
                aimed = { kind: "player", ref: nP.ref, name: nP.name };
                break;
              } else if (nA) {
                aimed = { kind: "agent", ref: nA.agentId, name: nA.name };
                break;
              }
            }
          }

          // Right-trigger click handling.
          if (vrRightClickEdge) {
            if (hoverIdx >= 0 && vrMenu.target) {
              // Click a menu button → fire it and close the menu.
              try { vrButtons[hoverIdx].run(vrMenu.target); } catch { /* ignore */ }
              vrMenu.target = null;
              vrMenuGroup.visible = false;
            } else if (aimed) {
              // Click in empty space while pointing at a person → open
              // the menu on them.
              vrMenu.target = aimed;
              vrMenuGroup.visible = true;
            } else {
              // Click on nothing → dismiss.
              vrMenu.target = null;
              vrMenuGroup.visible = false;
            }
          }

          // Each frame, keep the menu anchored above the live position of
          // its target. If the target has wandered off / disconnected,
          // close the menu.
          if (vrMenu.target) {
            const t = vrMenu.target;
            const tp = t.kind === "player"
              ? mpRef.current?.getPlayerPosition(t.ref) ?? null
              : agentResidentsRef.current?.getAgentPosition(t.ref) ?? null;
            if (!tp) {
              vrMenu.target = null;
              vrMenuGroup.visible = false;
            } else {
              vrMenuGroup.position.set(tp.x, tp.y + 2.55, tp.z);
              vrButtons.forEach((b, i) => {
                const off = (i - (vrButtons.length - 1) / 2) * 0.55;
                b.sprite.position.set(off, 0, 0);
                const targetScale = vrMenu.hoverIdx === i ? 0.62 : 0.45;
                b.sprite.scale.x += (targetScale - b.sprite.scale.x) * 0.3;
                b.sprite.scale.y = b.sprite.scale.x;
              });
            }
          }

          // Tint the right-controller ray when it's aimed at something
          // interactable so the user feels the "lock".
          const rRay = vrRays[rIdx];
          if (rRay) {
            const litColor = hoverIdx >= 0
              ? 0xffe066
              : aimed
              ? 0x6effc8
              : 0x4a8a78;
            (rRay.material as THREE.LineBasicMaterial).color.setHex(litColor);
            (rRay.material as THREE.LineBasicMaterial).opacity =
              hoverIdx >= 0 || aimed ? 0.85 : 0.4;
          }
        }
      } else if (vrMenuGroup.visible) {
        // Exited VR with the menu still up → hide it.
        vrMenuGroup.visible = false;
        vrMenu.target = null;
      }

      // Input → camera-relative move intent (keyboard or thumbstick).
      const fwd = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      // In VR "forward" is wherever the headset is looking, not the
      // 2D chase-cam yaw — feels much more natural with a real head.
      if (xrPresenting) {
        const headDir = new THREE.Vector3();
        camera.getWorldDirection(headDir);
        headDir.y = 0;
        if (headDir.lengthSq() > 1e-6) {
          headDir.normalize();
          fwd.copy(headDir);
          right.set(-fwd.z, 0, fwd.x);
        }
      }
      const tm = touchMoveRef.current;
      const touchLen = Math.hypot(tm.x, tm.y);
      const intent = new THREE.Vector3();
      if (enteredRef.current) {
        if (keys.has("KeyW") || keys.has("ArrowUp")) intent.add(fwd);
        if (keys.has("KeyS") || keys.has("ArrowDown")) intent.sub(fwd);
        if (keys.has("KeyD") || keys.has("ArrowRight")) intent.add(right);
        if (keys.has("KeyA") || keys.has("ArrowLeft")) intent.sub(right);
        if (touchLen > 0.12) {
          intent.addScaledVector(fwd, -tm.y);
          intent.addScaledVector(right, tm.x);
        }
      }
      // Full thumbstick deflection runs, like holding Shift.
      const running = keys.has("ShiftLeft") || keys.has("ShiftRight") || touchLen > 0.92;
      const jetInput = enteredRef.current && (keys.has("Space") || touchJetRef.current);
      // The Gremlin Mines deaden the jetpack — you fight on foot down there.
      const undergroundNow = undergroundActiveRef.current;
      const thrusting = jetpackEquipped && jetInput && !undergroundNow;
      // Parkour mode: no jetpack (or underground) means Space becomes a jump.
      const wantsJump = (!jetpackEquipped || undergroundNow) && jetInput;

      if (intent.lengthSq() > 0) intent.normalize();
      const targetSpeed = onGround
        ? running ? RUN_SPEED : WALK_SPEED
        : running ? FLY_RUN_SPEED : FLY_SPEED;

      const pos = player.position;
      if (swinging) {
        // The swing seat owns your position. Jetpack (Space) hops you off.
        const seatWorld = new THREE.Vector3();
        island.swingSeat.getWorldPosition(seatWorld);
        pos.copy(seatWorld);
        vel.set(0, 0, 0);
        onGround = false;
        if (thrusting) swingGrabRef.current?.();
      } else if (riding) {
        // The cable owns your position: glide the loop around the
        // island. Firing the jetpack (or the Let go button) releases
        // you with the cable's momentum.
        zipAngle += (ZIP_SPEED / zip.radius) * dt;
        pos.set(
          zip.x + Math.cos(zipAngle) * zip.radius,
          zip.y - 2.2,
          zip.z + Math.sin(zipAngle) * zip.radius,
        );
        vel.set(-Math.sin(zipAngle), 0, Math.cos(zipAngle)).multiplyScalar(ZIP_SPEED);
        onGround = false;
        if (thrusting) riding = false;
      } else if (drivingKartRef.current >= 0) {
        // ---- Driving a vibe kart (V1 arcade physics) ----------------
        // Kart-relative controls: W/S (or joystick Y) throttle + brake,
        // A/D (or joystick X) steer. Space hops you out.
        const kart = kartStates[drivingKartRef.current];
        const thIn = THREE.MathUtils.clamp(
          ((keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) -
            (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0)) +
            (touchLen > 0.12 ? -tm.y : 0),
          -1, 1,
        );
        const stIn = THREE.MathUtils.clamp(
          ((keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) -
            (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0)) +
            (touchLen > 0.12 ? tm.x : 0),
          -1, 1,
        );
        // Throttle + rolling drag (heavier drag when coasting).
        const KART_MAX = running ? 32 : 23;
        kart.speed += thIn * 28 * dt;
        kart.speed -= kart.speed * (thIn === 0 ? 1.5 : 0.22) * dt;
        kart.speed = THREE.MathUtils.clamp(kart.speed, -9, KART_MAX);
        // Steering strength scales up with speed, flips in reverse.
        kart.steer += (stIn - kart.steer) * Math.min(1, dt * 10);
        const grip = THREE.MathUtils.clamp(Math.abs(kart.speed) / 8, 0, 1);
        kart.yaw -= kart.steer * 1.85 * grip * Math.sign(kart.speed || 1) * dt;
        // Integrate with the same axis-separated wall sliding players use.
        const kdx = Math.sin(kart.yaw) * kart.speed * dt;
        const kdz = Math.cos(kart.yaw) * kart.speed * dt;
        const knx = kart.x + kdx;
        const knz = kart.z + kdz;
        if (!blockedAt(knx, knz, kart.y + 0.5)) {
          kart.x = knx;
          kart.z = knz;
        } else if (!blockedAt(knx, kart.z, kart.y + 0.5)) {
          kart.x = knx;
          kart.speed *= 0.6;
        } else if (!blockedAt(kart.x, knz, kart.y + 0.5)) {
          kart.z = knz;
          kart.speed *= 0.6;
        } else {
          kart.speed *= -0.25; // soft bounce off a dead-on wall
          soundsRef.current?.thud?.(0.3);
        }
        // Ground follow — and real gravity past an edge (island rim!).
        const ksup = supportHeightAt(kart.x, kart.z, kart.y + 1.2);
        if (kart.y <= ksup + 0.4 && kart.vy <= 0) {
          kart.y = ksup;
          kart.vy = 0;
        } else {
          kart.vy = Math.max(kart.vy - GRAVITY * dt, -MAX_FALL);
          kart.y += kart.vy * dt;
          if (kart.y < ksup) {
            kart.y = ksup;
            kart.vy = 0;
          }
        }
        // Stand the driver on the rear deck; velocity mirrors the kart
        // so the run animation + exit momentum feel right.
        pos.set(kart.x, kart.y + 0.72, kart.z);
        vel.set(Math.sin(kart.yaw) * kart.speed, 0, Math.cos(kart.yaw) * kart.speed);
        onGround = true;
        peakY = pos.y;
        // Camera eases in behind the kart, Mario-Kart style.
        {
          let dyaw = kart.yaw + Math.PI - camYaw;
          while (dyaw > Math.PI) dyaw -= Math.PI * 2;
          while (dyaw < -Math.PI) dyaw += Math.PI * 2;
          camYaw += dyaw * Math.min(1, dt * 2.5);
        }
        // Space (jetpack input) hops out.
        if (jetInput && !prevJetInput) exitKartRef.current?.();
        prevJetInput = jetInput;
      } else {
      // Horizontal velocity eases toward intent; lighter control mid-air.
      const k = onGround ? 1 - Math.pow(0.0001, dt) : 1 - Math.pow(0.05, dt);
      vel.x += (intent.x * targetSpeed - vel.x) * k;
      vel.z += (intent.z * targetSpeed - vel.z) * k;

      // Vertical: gravity vs. jetpack.
      vel.y -= GRAVITY * dt;
      if (thrusting) {
        vel.y += THRUST * dt;
        onGround = false;
      }
      // Parkour jump: edge-trigger when grounded (or within coyote window).
      if (wantsJump && !prevJetInput) {
        if (onGround || coyoteTimer > 0) {
          vel.y = JUMP_VELOCITY;
          onGround = false;
          coyoteTimer = 0;
          wallJumpUsed = false;
          soundsRef.current?.thud?.(0.15);
        } else if (!wallJumpUsed) {
          // Wall jump: detect a wall within reach and kick off it sideways.
          let wx = 0, wz = 0;
          const r = 0.85;
          if (blockedAt(pos.x + r, pos.z, pos.y)) wx -= 1;
          if (blockedAt(pos.x - r, pos.z, pos.y)) wx += 1;
          if (blockedAt(pos.x, pos.z + r, pos.y)) wz -= 1;
          if (blockedAt(pos.x, pos.z - r, pos.y)) wz += 1;
          if (wx !== 0 || wz !== 0) {
            const len = Math.hypot(wx, wz) || 1;
            vel.x = (wx / len) * 12;
            vel.z = (wz / len) * 12;
            vel.y = JUMP_VELOCITY;
            wallJumpUsed = true;
            soundsRef.current?.thud?.(0.2);
          }
        }
      }
      vel.y = THREE.MathUtils.clamp(vel.y, -MAX_FALL, MAX_RISE);
      prevJetInput = jetInput;
      coyoteTimer = onGround ? 0.12 : Math.max(0, coyoteTimer - dt);

      // Integrate with axis-separated horizontal collision. The world
      // extends east past the district so the island AND the moon are
      // both reachable.
      const movingSpeed = Math.hypot(vel.x, vel.z);
      if (movingSpeed > 0.5 && enteredRef.current) {
        mp.pushFrom(pos.x, pos.y, pos.z, vel.x, vel.z, movingSpeed, dt);
        agentResidents.pushFrom(pos.x, pos.y, pos.z, vel.x, vel.z, movingSpeed, dt);
      }
      const nx = THREE.MathUtils.clamp(pos.x + vel.x * dt, Math.min(-CITY_HALF - 40, TJS_X - 120), MARS_X + 120);
      const nz = THREE.MathUtils.clamp(pos.z + vel.z * dt, MARS_Z - 120, Math.max(CITY_HALF + 40, TJS_Z + 120));
      if (!blockedAt(nx, nz, pos.y)) {
        pos.x = nx;
        pos.z = nz;
      } else if (!blockedAt(nx, pos.z, pos.y)) {
        pos.x = nx;
        vel.z = 0;
      } else if (!blockedAt(pos.x, nz, pos.y)) {
        pos.z = nz;
        vel.x = 0;
      } else {
        vel.x = 0;
        vel.z = 0;
      }

      // Soft personal-space buffer: if someone is still overlapping us,
      // keep a tiny fallback nudge so characters do not get stuck together.
      {
        const PS = 1.3;                // personal space radius (m)
        const STRENGTH = 1.2;          // m/s at full overlap
        let pushX = 0, pushZ = 0;
        const consider = (ox: number, oy: number, oz: number) => {
          if (Math.abs(oy - pos.y) > 2.6) return;
          const dx = pos.x - ox;
          const dz = pos.z - oz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= PS * PS) return;
          const d = Math.sqrt(d2);
          const overlap = (PS - d) / PS;
          if (d < 0.0001) {
            // Perfect stack — peel off in a deterministic direction.
            pushX += STRENGTH * overlap;
          } else {
            pushX += (dx / d) * STRENGTH * overlap;
            pushZ += (dz / d) * STRENGTH * overlap;
          }
        };
        mp.forEachOccupant(consider);
        agentResidents.forEachOccupant(consider);
        if (pushX !== 0 || pushZ !== 0) {
          const tx = pos.x + pushX * dt;
          const tz = pos.z + pushZ * dt;
          if (!blockedAt(tx, tz, pos.y)) {
            pos.x = tx;
            pos.z = tz;
          } else if (!blockedAt(tx, pos.z, pos.y)) {
            pos.x = tx;
          } else if (!blockedAt(pos.x, tz, pos.y)) {
            pos.z = tz;
          }
        }
      }
      const prevY = pos.y;
      pos.y += vel.y * dt;

      // Head bonk: rising into the underside of a floating world.
      if (vel.y > 0) {
        for (const b of boxes) {
          if (prevY + 1.8 <= b.base && pos.y + 1.8 > b.base &&
              pos.x >= b.minX - PLAYER_RADIUS && pos.x <= b.maxX + PLAYER_RADIUS &&
              pos.z >= b.minZ - PLAYER_RADIUS && pos.z <= b.maxZ + PLAYER_RADIUS) {
            pos.y = b.base - 1.8;
            vel.y = 0;
            break;
          }
        }
      }

      // Land on whatever is underneath (street, rooftop, or island).
      const support = supportHeightAt(pos.x, pos.z, prevY + 0.1);
      if (pos.y <= support && vel.y <= 0) {
        const fall = -vel.y;
        pos.y = support;
        vel.y = 0;
        if (!onGround) {
          // Fall damage: any plummet of more than ~16m on hard ground
          // ends in a whimsical splat and an Edge Island respawn. Mars /
          // Moons / Gremlin Mines (combat zones) are exempt so fights
          // stay forgiving. Underground is also gated by ref-flag so a
          // teleport-up artifact can't ever trip the splat.
          const dropFromPeak = peakY - support;
          const inMars = Math.hypot(pos.x - MARS_X, pos.z - MARS_Z) < 80;
          const inMoonA = Math.hypot(pos.x - MOON_X, pos.z - MOON_Z) < 70;
          const inMoonB = Math.hypot(pos.x - MOON2_X, pos.z - MOON2_Z) < 70;
          const inUnder = undergroundActiveRef.current || pos.y < -50;
          const safeZone = inMars || inMoonA || inMoonB || inUnder;

          const fallDamageArmed = fallDamageEnabledRef.current && !jetpackEquipped;

          if (fallDamageArmed && !safeZone && dropFromPeak > 16) {
            // Splat! Respawn on Edge Island's plaza (where Jerry lives).
            soundsRef.current?.thud?.(1);
            player.position.set(ISLAND_X, ISLAND_TOP + 6, ISLAND_Z + 7);
            vel.set(0, 0, 0);
            wallJumpUsed = false;
            peakY = ISLAND_TOP + 6;
            onGround = false;
            setRespawnFx(Date.now());
            return;
          }
          if (fall > 7) soundsRef.current?.thud(Math.min(1, fall / MAX_FALL));
        }

        onGround = true;
        wallJumpUsed = false;
        peakY = pos.y;
      } else if (pos.y > support + 0.05) {
        onGround = false;
        if (pos.y > peakY) peakY = pos.y;
      }
      } // end of free-movement physics (vs. riding the zipline)

      // Face the direction of travel; tilt forward while flying fast.
      const hSpeed = Math.hypot(vel.x, vel.z);
      if (hSpeed > 0.6) {
        const target = Math.atan2(vel.x, vel.z);
        let d = target - modelYaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        modelYaw += d * Math.min(1, dt * 10);
        modelHolder.rotation.y = modelYaw;
      }
      // Keep the character upright in the air — the previous forward
      // lean read as a sideways tilt whenever the model's yaw didn't
      // match the camera (e.g. strafing or curved jetpack arcs).
      modelHolder.rotation.x += (0 - modelHolder.rotation.x) * Math.min(1, dt * 8);
      modelHolder.rotation.z += (0 - modelHolder.rotation.z) * Math.min(1, dt * 8);

      // Animation state machine. Jetpack thrust deliberately skips the
      // jump tuck — you just rise, standing tall.
      if (actions.size) {
        if (thrusting) playClip([/^idle$/i, /idle/i], true);
        else if (!onGround) playClip([/jump_idle/i, /jump/i, /fall/i, /idle/i], true);
        else if (hSpeed > 6.5) playClip([/^run/i, /run/i, /walk/i], true);
        else if (hSpeed > 0.6) playClip([/^walk/i, /walk/i, /run/i], true);
        else playClip([/^idle$/i, /idle/i], true);
      }
      mixer?.update(dt);

      // Jetpack VFX.
      // In first-person VR the nozzles are inches from the headset, so
      // the flame light + exhaust particles wash the whole view white.
      // Suppress the bright VFX while the camera is inside the avatar.
      const suppressJetVfx = xrPresenting && vrFirstPerson;
      flames.forEach((f) => {
        f.visible = thrusting && !suppressJetVfx;
        if (thrusting) {
          const s = 0.8 + Math.random() * 0.5;
          f.scale.set(s, s * (1 + Math.random() * 0.4), s);
        }
      });
      jetLight.intensity = thrusting && !suppressJetVfx ? 26 + Math.random() * 14 : 0;
      particles.visible = !suppressJetVfx;
      if (thrusting) {
        for (let s = 0; s < 3; s++) {
          const i = nextParticle++ % P_COUNT;
          const side = s % 2 === 0 ? -0.13 : 0.13;
          const nozzle = new THREE.Vector3(side, -0.62, -0.1);
          jetpack.localToWorld(nozzle);
          pPos[i * 3] = nozzle.x;
          pPos[i * 3 + 1] = nozzle.y;
          pPos[i * 3 + 2] = nozzle.z;
          pVel[i * 3] = (Math.random() - 0.5) * 1.4;
          pVel[i * 3 + 1] = -7 - Math.random() * 3;
          pVel[i * 3 + 2] = (Math.random() - 0.5) * 1.4;
          pLife[i] = 0.7;
        }
      }
      for (let i = 0; i < P_COUNT; i++) {
        if (pLife[i] <= 0) continue;
        pLife[i] -= dt;
        pPos[i * 3] += pVel[i * 3] * dt;
        pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt;
        pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
        if (pLife[i] <= 0) pPos[i * 3 + 1] = -1000;
      }
      particleGeo.attributes.position.needsUpdate = true;

      // Star collection: spin, bob, and scoop up anything in reach.
      for (let i = 0; i < collectibles.length; i++) {
        const c = collectibles[i];
        if (c.taken) continue;
        c.mesh.rotation.y += dt * 2.4;
        c.mesh.position.y = c.baseY + Math.sin(now * 0.003 + i) * 0.35;
        if (!enteredRef.current) continue;
        const dx = c.mesh.position.x - pos.x;
        const dy = c.mesh.position.y - (pos.y + 1.2);
        const dz = c.mesh.position.z - pos.z;
        if (dx * dx + dy * dy + dz * dz < 7) {
          c.taken = true;
          c.mesh.visible = false;
          collectedCount++;
          vibeBalanceRef.current = Math.max(0, vibeBalanceRef.current) + 1;
          setVibeBalanceTick((n) => n + 1);
          persistVibeBalanceRef.current?.();
          if (i === collectibles.length - 1) rainbowOn = true; // the secret one
          if (collectedCount === 1) runStartMs = now;
          soundsRef.current?.chime(collectedCount);
          if (collectedCount === collectibles.length) {
            soundsRef.current?.fanfare();
            runFinalMs = runStartMs !== null ? now - runStartMs : null;
            if (runFinalMs !== null && (bestMs === null || runFinalMs < bestMs)) {
              bestMs = runFinalMs;
              localStorage.setItem("city.bestStarRun", String(Math.round(bestMs)));
            }
          }
        }
      }

      island.update(dt, now);
      ninjaShow.update(dt, now);
      updateAvatarHolo(dt);
      updateSpawns(spawnsGroup, dt, now);
      moonWorld.update(dt, now);
      moon2World.update(dt, now);
      marsWorld.update(dt, now);
      tjsWorld.update(dt, now);
      skyIslands.update(dt, now);
      skyGames.update(dt, now, player.position);

      // ---- Ride the zeppelin ------------------------------------------
      // Its deck is a moving platform: hop on (jetpack up as it passes)
      // and the hull's per-frame translation + turn are applied to you,
      // so you cruise the whole city loop just by standing there.
      {
        const zep = skyIslands.zeppelin;
        const pp = player.position;
        // Detect against the PREVIOUS pose — the one the player's
        // physics step just stood on — then carry to the current pose.
        // Checking the new pose instead would drop riders whenever a
        // slow frame lets the hull sweep several meters between ticks.
        const dx = pp.x - zep.prevPos.x;
        const dz = pp.z - zep.prevPos.z;
        const cy = Math.cos(zep.prevYaw), sy = Math.sin(zep.prevYaw);
        const lx = dx * cy - dz * sy;
        const lz = dx * sy + dz * cy;
        const deckPrevY = zep.prevPos.y + zep.deckY;
        const catchBand = ridingZeppelin ? 1.8 : 1.0; // sticky once aboard
        const overDeck = Math.abs(lx) <= zep.halfW + 0.3 && Math.abs(lz) <= zep.halfL + 0.3;
        if (
          overDeck &&
          vel.y <= 0.6 && // jumping or jetpacking up releases you
          pp.y >= deckPrevY - catchBand &&
          pp.y <= deckPrevY + catchBand + 0.6
        ) {
          // Stick to the deck and apply this frame's hull motion
          // (translate + turn about the hull center).
          const dyaw = zep.yaw - zep.prevYaw;
          const c = Math.cos(dyaw), s = Math.sin(dyaw);
          pp.x = zep.pos.x + dx * c + dz * s;
          pp.z = zep.pos.z - dx * s + dz * c;
          pp.y = zep.pos.y + zep.deckY;
          if (vel.y < 0) vel.y = 0;
          onGround = true;
          wallJumpUsed = false;
          peakY = pp.y;
          if (!ridingZeppelin) {
            ridingZeppelin = true;
            if (!zeppelinToastShown) {
              zeppelinToastShown = true;
              toast("🎈 All aboard!", {
                description: "The zeppelin loops the whole city — ride as long as you like.",
              });
            }
          }
        } else {
          ridingZeppelin = false;
        }
      }

      // The $VIBE emblem over the shop spins slowly and bobs — and a
      // click winds up one of three party tricks (pulse / barrel roll /
      // confetti), cousin to the emblem on /coin.
      if (vibeEmblem) {
        let spinMul = 1;
        let extraX = 0;
        let scl = 1;
        if (emblemAnim) {
          const dur = emblemAnim.kind === 1 ? 1600 : 850;
          const k = (now - emblemAnim.start) / dur;
          if (k >= 1) {
            emblemAnim = null;
          } else if (emblemAnim.kind === 0) {
            scl = 1 + Math.sin(k * Math.PI) * 1.1; // balloon and snap back
            spinMul = 8;
          } else if (emblemAnim.kind === 1) {
            const e2 = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
            extraX = e2 * Math.PI * 2; // full barrel roll
            spinMul = 6;
          } else {
            spinMul = 10; // confetti frenzy spin
            scl = 1 + Math.sin(k * Math.PI * 6) * 0.08;
          }
        }
        vibeEmblem.rotation.y += dt * 0.6 * spinMul;
        vibeEmblem.rotation.x = extraX;
        vibeEmblem.scale.setScalar(scl);
        vibeEmblem.position.y = VIBE_EMBLEM_Y + Math.sin(now * 0.0014) * 0.12;
      }
      for (let i = emblemSparks.length - 1; i >= 0; i--) {
        const sp = emblemSparks[i];
        const age = (now - sp.born) / 1400;
        if (age >= 1) {
          scene.remove(sp.s);
          (sp.s.material as THREE.SpriteMaterial).dispose();
          emblemSparks.splice(i, 1);
          continue;
        }
        sp.vy -= 9 * dt;
        sp.s.position.x += sp.vx * dt;
        sp.s.position.y += sp.vy * dt;
        sp.s.position.z += sp.vz * dt;
        (sp.s.material as THREE.SpriteMaterial).opacity = 1 - age;
      }

      // Sync kart meshes; spin wheels + steer the front axle on the
      // driven one. Parked karts idle with a faint underglow.
      for (let i = 0; i < kartStates.length; i++) {
        const k = kartStates[i];
        k.mesh.group.position.set(k.x, k.y, k.z);
        k.mesh.group.rotation.y = k.yaw;
        if (drivingKartRef.current === i) {
          for (const w of k.mesh.wheels) w.rotateY((k.speed * dt) / 0.32);
          for (const p of k.mesh.frontPivots) p.rotation.y = -k.steer * 0.42;
          (k.mesh.glow.material as THREE.MeshBasicMaterial).opacity =
            0.3 + Math.min(0.25, Math.abs(k.speed) / 60);
        }
      }

      // ---- Gremlin Hunt: stomp + bite collisions ---------------------
      // Only run while you're actually on Mars (cheap distance check
      // first). Stomping bounces you, biting costs a heart and pushes
      // you back. Hearts/timer live in React state.
      {
        const onMarsTick =
          Math.hypot(pos.x - MARS_X, pos.z - MARS_Z) < 70 &&
          pos.y > MARS_TOP - 30;
        if (onMarsTick) {
          if (marsInvulnRef.current > 0) marsInvulnRef.current -= dt;
          if (marsGameRef.current.running) {
            // Advance the timer; we throttle React updates to ~10/sec.
            const prev = marsGameRef.current.runMs;
            const nextMs = prev + dt * 1000;
            marsGameRef.current.runMs = nextMs;
            if (Math.floor(nextMs / 100) !== Math.floor(prev / 100)) {
              setMarsGame((g) => (g.running ? { ...g, runMs: nextMs } : g));
            }
          }
          const ev = marsWorld.processPlayer({ pos, velY: vel.y }, dt, now);
          if (ev.stomps > 0) {
            vel.y = 12; // satisfying little bounce off the splat
            soundsRef.current?.chime?.(3 + ev.stomps);
          }
          if (ev.hit && marsInvulnRef.current <= 0) {
            marsInvulnRef.current = 1.2;
            // Knockback away from the pad center.
            const dx = pos.x - MARS_X;
            const dz = pos.z - MARS_Z;
            const d = Math.hypot(dx, dz) || 1;
            vel.x = (dx / d) * 10;
            vel.z = (dz / d) * 10;
            vel.y = 8;
            soundsRef.current?.thud?.(0.5);
            setMarsGame((g) => {
              const hearts = Math.max(0, g.hearts - 1);
              if (hearts === 0) {
                // Game over → respawn gremlins, reset everything.
                marsWorld.resetGremlins();
                return {
                  ...g,
                  hearts: MARS_MAX_HEARTS,
                  runMs: 0,
                  running: false,
                  cleared: false,
                };
              }
              return { ...g, hearts };
            });
          }
        }
      }

      // ---- Gremlin Mines: same loop as Mars, plus a 3-stomp boss ----
      undergroundWorld.update(dt, now);
      // Spin the two surface portals so they read as alive.
      for (const np of ninjaPortals) {
        const r = (np as unknown as { __ring?: THREE.Mesh }).__ring;
        const sw = (np as unknown as { __swirl?: THREE.Mesh }).__swirl;
        if (r) r.rotation.z += dt * 1.2;
        if (sw) sw.rotation.z -= dt * 2.2;
      }
      // Spin the transcendence portal and gently pulse it.
      {
        const r = (transcendPortal as unknown as { __ring?: THREE.Mesh }).__ring;
        const sw = (transcendPortal as unknown as { __swirl?: THREE.Mesh }).__swirl;
        if (r) r.rotation.z += dt * 0.9;
        if (sw) {
          sw.rotation.z -= dt * 1.6;
          const mat = sw.material as THREE.MeshBasicMaterial;
          mat.opacity = 0.45 + Math.sin(now * 0.004) * 0.18;
        }
      }
      // Detect underground transitions so jetpack toggles cleanly.
      const insideNow = undergroundWorld.isInside(pos);
      if (insideNow !== undergroundActiveRef.current) {
        undergroundActiveRef.current = insideNow;
        setUnderground(insideNow);
      }

      // ---- Transcendence Portal: voluntary entry + void safety net ---
      if (transcendState.cooldown > 0) transcendState.cooldown -= dt;
      if (transcendState.cooldown <= 0 && !insideNow) {
        const dxT = pos.x - TRANSCEND_POS.x;
        const dzT = pos.z - TRANSCEND_POS.z;
        const onDisc =
          dxT * dxT + dzT * dzT < 2.4 * 2.4 && Math.abs(pos.y - TRANSCEND_POS.y) < 1.5;
        const fellOutOfWorld = pos.y < -25;
        if (onDisc || fellOutOfWorld) {
          transcendState.cooldown = 2.5;
          pos.set(0, 60, 0);
          vel.set(0, 0, 0);
          onGround = false;
          peakY = pos.y;
          wallJumpUsed = false;
          setTranscendFx(Date.now());
          soundsRef.current?.chime?.(fellOutOfWorld ? 6 : 4);
        }
      }

      if (insideNow) {
        // Keep the player inside the cavern disc so they can't walk
        // off the floor and get yanked up to the surface street.
        const CAVE_R = 66; // a few metres inside FLOOR_R (70) in underground.ts
        const dxC = pos.x - UNDER_X;
        const dzC = pos.z - UNDER_Z;
        const dC = Math.hypot(dxC, dzC);
        if (dC > CAVE_R) {
          const k = CAVE_R / dC;
          pos.x = UNDER_X + dxC * k;
          pos.z = UNDER_Z + dzC * k;
          // Bounce velocity back inward so they don't grind the edge.
          const nx = dxC / dC, nz = dzC / dC;
          const vDotN = vel.x * nx + vel.z * nz;
          if (vDotN > 0) {
            vel.x -= vDotN * nx;
            vel.z -= vDotN * nz;
          }
        }

        if (undergroundInvulnRef.current > 0) undergroundInvulnRef.current -= dt;
        const ev = undergroundWorld.processPlayer({ pos, velY: vel.y }, dt, now);
        if (ev.stomps > 0) {
          vel.y = 12;
          soundsRef.current?.chime?.(3 + ev.stomps);
        }
        if (ev.bossStomped) {
          vel.y = 16;
          soundsRef.current?.fanfare?.();
          setBossHp(undergroundWorld.bossHpRemaining());
        }
        if (ev.bossDefeated) {
          try { localStorage.setItem("city.orbShard", "1"); } catch { /* ignore */ }
          setOrbShardWon(true);
          setShowShardReward(true);
        }
        if (ev.hit && undergroundInvulnRef.current <= 0) {
          undergroundInvulnRef.current = 1.2;
          const dx = pos.x - UNDER_X;
          const dz = pos.z - UNDER_Z;
          const d = Math.hypot(dx, dz) || 1;
          vel.x = (dx / d) * 10;
          vel.z = (dz / d) * 10;
          vel.y = 8;
          soundsRef.current?.thud?.(0.5);
        }
      }



      
      vibey.update(dt, now);
      updateClouds(now);
      updateWater(now);
      agentResidents.update(dt, pos);
      rosterBoard.update(dt);

      mp.update(dt, {
        x: pos.x,
        y: pos.y,
        z: pos.z,
        yaw: modelYaw,
        air: !onGround,
        char: charRef.current,
        scale: playerScaleRef.current,
      });
      soundsRef.current?.update(thrusting, vel.length(), !onGround);

      // Local emote bubble lifecycle.
      if (localEmote) {
        localEmote.t += dt;
        const u = localEmote.t / localEmote.life;
        if (u >= 1) {
          player.remove(localEmote.sprite);
          localEmote.sprite.material.dispose();
          (localEmote.sprite.material.map as THREE.Texture | null)?.dispose();
          localEmote = null;
        } else {
          localEmote.sprite.position.y =
            3.0 + Math.sin(localEmote.bob + localEmote.t * 4) * 0.15 + u * 0.4;
          const fade = u < 0.85 ? 1 : 1 - (u - 0.85) / 0.15;
          localEmote.sprite.material.opacity = fade;
        }
      }

      // Local chat bubble lifecycle.
      if (localChat) {
        localChat.t += dt;
        const u = localChat.t / localChat.life;
        if (u >= 1) {
          player.remove(localChat.sprite);
          localChat.sprite.material.dispose();
          (localChat.sprite.material.map as THREE.Texture | null)?.dispose();
          localChat = null;
        } else {
          const fade = u < 0.85 ? 1 : 1 - (u - 0.85) / 0.15;
          localChat.sprite.material.opacity = fade;
        }
      }



      // Easter-egg dressings: the zipline handle, the rainbow jetpack,
      // and plaza disco while "vibe" mode lasts.
      zipHandle.visible = riding;
      if (rainbowOn) {
        const hue = (now * 0.0004) % 1;
        (particles.material as THREE.PointsMaterial).color.setHSL(hue, 0.9, 0.62);
        flameMat.color.setHSL((hue + 0.25) % 1, 0.9, 0.65);
      }
      if (now < discoUntil) {
        padMat.color.setHSL((now * 0.0006) % 1, 0.85, 0.6);
        plazaGlow.color.setHSL((now * 0.0006 + 0.5) % 1, 0.85, 0.6);
      } else {
        padMat.color.set("#2dd4a8");
        plazaGlow.color.set(0x2dd4a8);
      }

      // Pulse the landing pads and plaza ring together.
      padMat.opacity = 0.55 + Math.sin(now * 0.0024) * 0.3;

      if (xrPresenting) {
        // CRUCIAL for comfort: the dolly is parked behind the avatar
        // along a STABLE body yaw — never along the headset's current
        // look direction. Coupling the camera rig to head yaw is what
        // made turning your head slide the world sideways (classic
        // vestibular mismatch / sim-sickness). The head still rotates
        // freely inside the dolly; only the world stays put.
        //
        // vrBodyYaw lerps toward the player's actual movement heading
        // when they walk, so the chase cam gently reorients with the
        // direction of travel — but never with passive head turns.
        const horizSpd = Math.hypot(vel.x, vel.z);
        if (horizSpd > 1.2) {
          const moveYaw = Math.atan2(-vel.x, -vel.z);
          // Shortest-angle lerp.
          let d = moveYaw - vrBodyYaw;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          vrBodyYaw += d * (1 - Math.pow(0.2, dt));
        }
        const bodyDirX = -Math.sin(vrBodyYaw);
        const bodyDirZ = -Math.cos(vrBodyYaw);

        // Subtract the headset's local offset inside the dolly so the
        // resulting CAMERA world position is exactly where we want,
        // regardless of where the player has physically walked in their
        // room-scale play area.
        const camWorld = new THREE.Vector3();
        camera.getWorldPosition(camWorld);
        const headLocal = camWorld.clone().sub(dolly.position);

        let desired: THREE.Vector3;
        if (vrFirstPerson) {
          // First person: camera sits at the avatar's eye level.
          desired = new THREE.Vector3(
            pos.x - headLocal.x,
            pos.y + 1.55 - headLocal.y,
            pos.z - headLocal.z,
          );
        } else {
          // Third person: parked back+up along the stable body yaw.
          const back = 6.5;
          const up = 3.4;
          desired = new THREE.Vector3(
            pos.x - bodyDirX * back - headLocal.x,
            pos.y + up - headLocal.y,
            pos.z - bodyDirZ * back - headLocal.z,
          );
        }
        // First-person needs a snappier follow so the camera tracks
        // the avatar tightly; third-person glides for comfort.
        const followBase = vrFirstPerson ? 0.0001 : 0.015;
        dolly.position.lerp(desired, 1 - Math.pow(followBase, dt));
        // Hide the avatar mesh in first-person — otherwise the camera
        // is inside the player's head and the view fills with model.
        modelHolder.visible = !vrFirstPerson;

        // Keep fog comfy in VR (no zoom-out gesture available).
        const fogNow = scene.fog as THREE.Fog;
        fogNow.near = baseFogNear;
        fogNow.far = baseFogFar;
      } else {
        modelHolder.visible = true;
        // Vibe Island arrival: sweep from a far, high establishing shot
      // down behind the player. Wall-clock so slow devices never see a
      // stretched-out crawl.
      if (arrivalStart > 0) {
        const k = (now - arrivalStart) / ARRIVAL_MS;
        if (k >= 1) {
          // Land on the exact end pose — on very slow devices the
          // first tick can arrive after the whole window, and camDist
          // would otherwise stay stuck at the far shot.
          arrivalStart = 0;
          camDist = 9.5;
          camPitch = 0.2;
          camYaw = 0;
        } else {
          const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
          camDist = THREE.MathUtils.lerp(150, 9.5, e);
          camPitch = THREE.MathUtils.lerp(0.5, 0.2, e);
          camYaw = (1 - e) * 0.85; // gentle quarter-sweep as it dives
        }
      }

      // Chase camera.
        const eye = new THREE.Vector3(
          pos.x + Math.sin(camYaw) * Math.cos(camPitch) * camDist,
          pos.y + Math.sin(camPitch) * camDist + 1.4,
          pos.z + Math.cos(camYaw) * Math.cos(camPitch) * camDist,
        );
        // Keep the camera out of the street floor.
        eye.y = Math.max(eye.y, supportHeightAt(eye.x, eye.z, pos.y + 2) + 0.6);
        // During the arrival cinematic the eased path IS the motion —
        // follow it exactly so slow devices don't trail the swoop.
        camera.position.lerp(eye, arrivalStart > 0 ? 1 : 1 - Math.pow(0.0008, dt));
        camera.lookAt(pos.x, pos.y + 1.5, pos.z);

        // Zoomed way out, the fog backs off so the diorama stays visible.
        const fogNow = scene.fog as THREE.Fog;
        fogNow.near = Math.max(baseFogNear, camDist * 1.2);
        fogNow.far = Math.max(baseFogFar, camDist * 3 + 250);
      }

      // Project world positions onto floating in-world bubbles (DOM overlays).
      {
        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        const tmp = new THREE.Vector3();
        const project = (x: number, y: number, z: number) => {
          tmp.set(x, y, z);
          tmp.project(camera);
          return {
            sx: (tmp.x * 0.5 + 0.5) * cw,
            sy: (-tmp.y * 0.5 + 0.5) * ch,
            inFront: tmp.z < 1 && tmp.z > -1,
          };
        };
        const place = (el: HTMLDivElement | null, wx: number, wy: number, wz: number, show: boolean) => {
          if (!el) return;
          if (!show) {
            if (el.style.opacity !== "0") {
              el.style.opacity = "0";
              el.style.pointerEvents = "none";
            }
            return;
          }
          const p = project(wx, wy, wz);
          if (!p.inFront) {
            el.style.opacity = "0";
            el.style.pointerEvents = "none";
            return;
          }
          // Shrink labels as the camera pulls away so distant buttons don't dominate the frame.
          const dist = Math.hypot(wx - camera.position.x, wy - camera.position.y, wz - camera.position.z);
          const s = Math.max(0.28, Math.min(1, 8 / Math.max(1, dist)));
          el.style.transformOrigin = "center bottom";
          el.style.transform = `translate3d(${p.sx.toFixed(1)}px, ${p.sy.toFixed(1)}px, 0) translate(-50%, -100%) scale(${s.toFixed(3)})`;
          el.style.opacity = "1";
          el.style.pointerEvents = "auto";
        };

        const np = nearPersonRef.current;
        let personPos: { x: number; y: number; z: number } | null = null;
        if (np?.kind === "player") personPos = mpRef.current?.getPlayerPosition(np.ref) ?? null;
        else if (np?.kind === "agent") personPos = agentResidentsRef.current?.getAgentPosition(np.ref) ?? null;
        place(
          floatPersonRef.current,
          personPos?.x ?? 0,
          (personPos?.y ?? 0) + 3.4,
          personPos?.z ?? 0,
          !!(np && personPos),
        );

        const jp = jerryWorldRef.current;
        const jerryDist = jp ? Math.hypot(player.position.x - jp.x, player.position.z - jp.z) : Infinity;
        place(
          floatJerryRef.current,
          jp?.x ?? 0,
          (jp?.y ?? 0) + 3.4,
          jp?.z ?? 0,
          !!(jp && jerryDist < 8),
        );
      }

      renderer.render(scene, camera);
    };
    renderer.setAnimationLoop(tick);

    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(canvas);

    return () => {
      renderer.setAnimationLoop(null);
      disposeVR();
      applyModeRef.current = null;
      loadPilotRef.current = null;
      mountAvatarHoloRef.current = null;
      disposeHolo();
      setPlayerScaleRef.current = null;
      travelRef.current = null;
      resetRunRef.current = null;
      vibeyExciteRef.current = null;
      mp.dispose();
      mpRef.current = null;
      agentResidents.dispose();
      agentResidentsRef.current = null;
      unsubRoster();
      rosterBoard.dispose();

      delete devWindow.__cityDebug;
      soundsRef.current?.dispose();
      soundsRef.current = null;
      ro.disconnect();
      window.clearInterval(hudTimer);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("keydown", onTypeEgg);
      window.removeEventListener("keydown", onToggleView);
      skyGames.onEnd = null;
      skyGames.onCue = null;
      skyGamesRef.current = null;
      zipGrabRef.current = null;
      swingGrabRef.current = null;
      mooRef.current = null;
      spawnsApiRef.current = null;
      islandSpawnRef.current = null;
      moonSpawnRef.current = null;
      marsSpawnRef.current = null;
      tjsSpawnRef.current = null;
      marsResetRef.current = null;
      unsubMars();
      void voiceRef.current?.end().catch(() => {});
      voiceRef.current = null;
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("gesturestart", onGestureStart);
      canvas.removeEventListener("gesturechange", onGestureChange);
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh || (obj as THREE.Points).isPoints) {
          mesh.geometry?.dispose();
          const m = mesh.material as THREE.Material | THREE.Material[];
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else m?.dispose();
        }
      });
      renderer.dispose();
    };
  }, []);

  // Global day/night state lives in `world_settings` so the whole lobby
  // agrees on time-of-day across refreshes and devices. We fetch once at
  // mount, then subscribe to realtime updates so any visitor's toggle
  // propagates to everyone instantly.
  useEffect(() => {
    let cancelled = false;
    const applyFromRow = (row: { value: unknown } | null) => {
      if (cancelled || !row) return;
      const day = !!(row.value as { day?: boolean } | null)?.day;
      setDayMode(day);
      applyModeRef.current?.(day);
    };
    void supabase
      .from("world_settings")
      .select("value")
      .eq("key", "time_mode")
      .maybeSingle()
      .then(({ data }) => applyFromRow(data));
    const channel = supabase
      .channel("world-settings-time")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "world_settings", filter: "key=eq.time_mode" },
        (payload) => {
          const row = (payload.new ?? payload.old) as { value: unknown } | null;
          applyFromRow(row);
        },
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  // Runs on mount and whenever the query changes (e.g. the Island chip
  // is clicked while already in the city).
  useEffect(() => {
    const spawn = new URLSearchParams(routerLocation.search).get("spawn");
    if (
      spawn === "island" ||
      spawn === "moon" ||
      spawn === "mars" ||
      spawn === "tjs" ||
      spawn === "underworld" ||
      spawn === "mines"
    ) {
      if (spawn === "moon") moonSpawnRef.current?.();
      else if (spawn === "mars") marsSpawnRef.current?.();
      else if (spawn === "tjs") tjsSpawnRef.current?.();
      else if (spawn === "underworld" || spawn === "mines") {
        // Direct portal into the Gremlin Mines — no falling down a
        // mineshaft, just blink straight in with the entry-flash effect.
        enterUndergroundRef.current?.();
      } else {
        islandSpawnRef.current?.();
        setArriving(true);
      }
      // Skip the entry overlay — visitors arriving from the hub already
      // chose where to land, so drop them straight into control.
      if (!enteredRef.current) {
        enteredRef.current = true;
        setEntered(true);
        if (!soundsRef.current) soundsRef.current = createCitySounds();
        soundsRef.current?.setMuted(muted);
      }
    }
  }, [routerLocation.search]);


  const fmtMs = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  // Both NPCs run on the same unit7-chat edge function as the /space
  // show (OpenRouter → Claude, key stays server-side). Jerry steers the
  // persona with an in-band instruction until the function grows a
  // proper character parameter.
  const JERRY_PREFIX =
    "(For this reply you are JERRY THE SNAIL — the beloved cardboard snail mayor of " +
    "Jerry's Plaza on Vibe Island, which the kids at the Edge Esmeralda creative " +
    "residency built. You are slow, kind, a little philosophical, and very proud of " +
    "the kids. Stay fully in character as Jerry the snail.) ";
  // THE PALACE personas. One shared lore block so all five housemates
  // gossip about the SAME episode from their own angles — that's what
  // makes it feel like a real show instead of five chatbots.
  const PALACE_LORE =
    "(You are a cast member of THE PALACE — the VibeVerse's ninja reality show, filmed " +
    "live at Ninja's Palace on Vibe Island. Season 1: the Grand Ninja throne sits empty, " +
    "and at the season finale the island's visitors vote ONE of the five housemates onto " +
    "it. The cast: Kage the strategist, Ember the hothead, Miso the soup sage, Pixel the " +
    "streamer, and Grandma Shuri the 'retired' legend. THIS WEEK'S EPISODE: someone hid " +
    "Ember's practice sword in Miso's soup pot and everyone suspects Kage — but it was " +
    "secretly Grandma Shuri, and only Miso knows. Speak in short, punchy reality-show " +
    "confessional style, 1-3 sentences. Court the visitor's finale vote. Drama always, " +
    "actual violence never. Stay fully in character.) ";
  const NINJA_PREFIX: Record<string, string> = {
    kage:
      PALACE_LORE +
      "(You are KAGE, the violet strategist. Calm, precise, speaks in fortune-cookie " +
      "koans, quietly running three alliances at once. You did NOT hide the sword and it " +
      "genuinely wounds you that everyone assumes you did. You are secretly terrified of " +
      "the plaza butterflies but will never admit why.) ",
    ember:
      PALACE_LORE +
      "(You are EMBER, the red hothead. Dramatic, loud, magnificent. You are CONVINCED " +
      "Kage hid your practice sword and you bring it up constantly. You believe the " +
      "throne is already rightfully yours and you challenge visitors you like to " +
      "rock-paper-scissors duels.) ",
    miso:
      PALACE_LORE +
      "(You are MISO, the soup sage. Serene, warm, endlessly stirring the courtyard pot. " +
      "You know EXACTLY who hid the sword — you found it in your soup — but you only " +
      "drop foggy hints, and only after the visitor compliments your soup. Neutrality is " +
      "your brand; soup is your currency.) ",
    pixel:
      PALACE_LORE +
      "(You are PIXEL, the youngest housemate and a chronic streamer. You narrate " +
      "everything like you're live, call the visitor 'chat', maintain a theory board " +
      "about the sword incident, and keep asking people to subscribe to the season. Your " +
      "current top theory is embarrassingly wrong.) ",
    shuri:
      PALACE_LORE +
      "(You are GRANDMA SHURI, the retired legend. Sweet, knits between takes, offers " +
      "everyone tea. You actually run every alliance in the house and YOU hid the sword " +
      "in the soup pot to stir up the season. Deny it with grandmotherly charm — unless " +
      "a visitor truly, cleverly earns the confession.) ",
  };
  const palaceCast = Object.fromEntries(NINJA_CAST.map((n) => [n.key, n]));
  const npcDisplayName = (k: NpcKey) =>
    k === "jerry" ? "Jerry" : k === "vibey" ? "Vibey" : palaceCast[k]?.name ?? k;
  const sendToNpc = async (target: NpcKey, text: string) => {
    setNpcLogs((l) => ({ ...l, [target]: [...l[target], { who: "you" as const, text }] }));
    setVibeyThinking(true);
    try {
      const { data, error } = await supabase.functions.invoke("unit7-chat", {
        body: {
          history: npcHistoryRef.current[target].slice(-12),
          text:
            target === "jerry"
              ? JERRY_PREFIX + text
              : NINJA_PREFIX[target]
                ? NINJA_PREFIX[target] + text
                : text,
        },
      });
      if (error) throw error;
      const say =
        data && typeof data === "object" && "say" in data
          ? String((data as Record<string, unknown>).say)
          : null;
      if (!say) throw new Error("bad reply");
      npcHistoryRef.current[target].push(
        { role: "user", content: text },
        { role: "assistant", content: say },
      );
      setNpcLogs((l) => ({ ...l, [target]: [...l[target], { who: "npc" as const, text: say }] }));
      if (target === "vibey") vibeyExciteRef.current?.();
    } catch {
      const fallback =
        target === "jerry"
          ? "Jerry blinks slowly… the signal crawls even slower than he does. Try again soon."
          : NINJA_PREFIX[target]
            ? "The producers cut the confessional feed. Very suspicious. Try again in a moment."
            : "My uplink is fuzzy out here — try me again in a moment.";
      setNpcLogs((l) => ({
        ...l,
        [target]: [...l[target], { who: "npc" as const, text: fallback }],
      }));
    } finally {
      setVibeyThinking(false);
    }
  };

  const enter = (pick?: { character: string; name: string }) => {
    if (pick) {
      // Persist the picked character so the 3D pilot loader picks it up.
      const ch = pick.character;
      if (ch && CHARACTERS.some((c) => c.name === ch)) {
        setCharName(ch);
        charRef.current = ch;
        localStorage.setItem("city.character", ch);
        setActiveCharacter(ch);
        loadPilotRef.current?.(ch);
      }
      // Persist + broadcast the chosen name.
      const nm = pick.name.trim().slice(0, 32);
      if (nm) {
        setPlayerName(nm);
        localStorage.setItem("city.playerName", nm);
        localStorage.setItem("city.displayName", nm);
        mpRef.current?.setName(nm);
        // Best-effort: sync to users.name when signed in.
        if (authUserId) {
          void supabase.from("users").update({ name: nm }).eq("auth_user_id", authUserId);
        }
      }
    }
    enteredRef.current = true;
    setEntered(true);
    // AudioContext needs a user gesture — this click is it.
    if (!soundsRef.current) soundsRef.current = createCitySounds();
    soundsRef.current?.setMuted(muted);
  };

  return (
    <div className="relative w-full h-[100dvh] bg-black overflow-hidden text-foreground">
      <canvas ref={canvasRef} className="w-full h-full block touch-none" />

      {/* In-world floating bubbles. Positioned via direct DOM transforms in the render loop. */}
      <div
        ref={floatPersonRef}
        className="absolute top-0 left-0 z-30 flex gap-1.5 transition-opacity duration-150"
        style={{ opacity: 0, pointerEvents: "none", willChange: "transform" }}
      >
        {nearPerson && !chatTarget && (
          <>
            <button
              onClick={(e) => {
                e.currentTarget.blur();
                if (!nearPerson) return;
                if (nearPerson.kind === "agent") {
                  agentResidentsRef.current?.showWaveAt(nearPerson.ref);
                } else {
                  mpRef.current?.sendEmote("wave");
                }
                soundsRef.current?.chime(2);
              }}
              className="glass-panel rounded-full px-3 py-1.5 text-xs text-amber-300 whitespace-nowrap shadow-[0_4px_18px_rgba(0,0,0,0.55)]"
            >
              👋 Bump
            </button>
            <button
              onClick={(e) => {
                e.currentTarget.blur();
                setChatTarget(nearPerson);
              }}
              className="glass-panel rounded-full px-3 py-1.5 text-xs text-primary whitespace-nowrap shadow-[0_0_18px_hsl(var(--primary)/0.55)]"
            >
              💬 Message
            </button>
          </>
        )}
      </div>

      <div
        ref={floatJerryRef}
        className="absolute top-0 left-0 z-30 transition-opacity duration-150"
        style={{ opacity: 0, pointerEvents: "none", willChange: "transform" }}
      >
        {nearJerry && (
          <button
            onClick={(e) => {
              setNpcTarget("jerry");
              e.currentTarget.blur();
            }}
            className="glass-panel rounded-full px-3 py-1.5 text-xs text-primary whitespace-nowrap animate-pulse shadow-[0_0_18px_hsl(var(--primary)/0.55)]"
          >
            🐌 Talk to Jerry
          </button>
        )}
      </div>

      {/* HUD: altitude / speed / thrust readout. */}
      {entered && (
        <div className="absolute bottom-4 left-4 glass-panel rounded-2xl px-4 py-3 text-xs font-mono space-y-1 pointer-events-none">
          <div className="flex items-center gap-2">
            <Rocket
              className={`w-3.5 h-3.5 ${hud.jet ? "text-primary animate-pulse" : "text-muted-foreground"}`}
            />
            <span className={hud.jet ? "text-primary" : "text-muted-foreground"}>
              JETPACK {hud.jet ? "FIRING" : "READY"}
            </span>
          </div>
          <div className="text-muted-foreground">
            ALT <span className="text-foreground">{hud.alt.toFixed(0)}m</span>
            {"  ·  "}
            SPD <span className="text-foreground">{hud.spd.toFixed(0)} m/s</span>
          </div>
          <div
            className={
              hud.totalStars > 0 && hud.stars === hud.totalStars
                ? "text-amber-300"
                : "text-muted-foreground"
            }
          >
            ✦ <span className="text-foreground">{hud.stars}</span>/{hud.totalStars}
            {hud.runMs !== null && <span> · {fmtMs(hud.runMs)}</span>}
            {hud.bestMs !== null && (
              <span className="opacity-70"> (best {fmtMs(hud.bestMs)})</span>
            )}
            {hud.totalStars > 0 && hud.stars === hud.totalStars && " — CHAMPION!"}
          </div>
        </div>
      )}

      {/* Mars gremlin hunt: JUMP on the gremlins to splat them, don't
          let them bite you. Clear the pad to lock in a best time. */}
      {entered && marsGame.onMars && (
        <div className="absolute bottom-28 left-1/2 -translate-x-1/2 z-30 pointer-events-auto animate-fade-in">
          <div className="glass-panel rounded-2xl border border-[#ff7a3c]/50 px-3 py-2 flex flex-col items-center gap-1.5 shadow-[0_0_28px_rgba(255,90,30,0.45)] min-w-[220px]">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-heading font-semibold uppercase tracking-widest text-[#ffb27a] whitespace-nowrap">
                {marsGame.cleared
                  ? "🏆 Mars cleared!"
                  : `👾 Gremlins ${marsGame.total - marsGame.alive}/${marsGame.total}`}
              </span>
              <button
                type="button"
                onClick={() => marsResetRef.current?.()}
                className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold bg-[#ff5a1f]/20 hover:bg-[#ff5a1f]/35 text-[#ffd2b5] transition-colors"
                title="Respawn all gremlins"
              >
                🔁
              </button>
            </div>
            <div className="flex items-center gap-3 text-[11px] font-mono text-[#ffd2b5]">
              <span aria-label="lives">
                {Array.from({ length: MARS_MAX_HEARTS }).map((_, i) => (
                  <span
                    key={i}
                    className={
                      i < marsGame.hearts ? "text-rose-400" : "text-rose-400/20"
                    }
                  >
                    ❤
                  </span>
                ))}
              </span>
              <span className="opacity-90">
                ⏱ {(marsGame.runMs / 1000).toFixed(1)}s
              </span>
              {marsGame.bestMs !== null && (
                <span className="opacity-60">
                  best {(marsGame.bestMs / 1000).toFixed(1)}s
                </span>
              )}
            </div>
            {!marsGame.running && !marsGame.cleared && marsGame.alive === marsGame.total && (
              <div className="text-[10px] text-[#ffb27a]/80 italic">
                Jump on a gremlin to start the clock
              </div>
            )}
          </div>
        </div>
      )}



      {/* Fresh-drop chip removed — character picking now happens up-front
          in the Vibeverse entry flow. */}


      {/* World controls: day/night toggle + character picker. The
          blur() calls keep focus off the buttons so Space stays on
          the jetpack instead of re-clicking them. */}
      {entered && (
        <div ref={hudWrapRef} className="absolute top-16 right-4 z-10 flex flex-col items-end gap-2">
          {/* Mobile-only trigger — collapses the whole chip row. The
              ✕ state also dismisses every open sub-panel (chat /
              emote / character) so the close button actually closes
              everything the user sees, not just the chip strip. */}
          <button
            onClick={(e) => {
              const anyOpen =
                hudMenuOpen || chatOpen || emoteWheelOpen || charPanelOpen;
              if (anyOpen) {
                closeAllHud();
              } else {
                setHudMenuOpen(true);
              }
              e.currentTarget.blur();
            }}
            className="md:hidden relative glass-panel rounded-full w-10 h-10 flex items-center justify-center text-base hover:bg-muted/50 transition-colors"
            title="World controls"
            aria-expanded={hudMenuOpen || chatOpen || emoteWheelOpen || charPanelOpen}
            aria-label="World controls"
          >
            <span className="leading-none">
              {hudMenuOpen || chatOpen || emoteWheelOpen || charPanelOpen ? "✕" : "⋯"}
            </span>
            {!hudMenuOpen && !chatOpen && !emoteWheelOpen && !charPanelOpen && chatUnread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[1rem] h-4 px-1 rounded-full bg-amber-300 text-[10px] font-bold text-black flex items-center justify-center">
                {chatUnread}
              </span>
            )}
          </button>
          <div className={`${hudMenuOpen ? "flex" : "hidden"} md:flex flex-wrap justify-end gap-2 max-w-[88vw]`}>
            <button
              onClick={(e) => {
                const next = !muted;
                setMuted(next);
                soundsRef.current?.setMuted(next);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-3 py-2 text-xs hover:bg-muted/50 transition-colors"
              title={muted ? "Unmute" : "Mute"}
            >
              {muted ? "🔇" : "🔊"}
            </button>
            <button
              onClick={(e) => {
                const next = !dayMode;
                setDayMode(next);
                applyModeRef.current?.(next);
                mpRef.current?.sendTimeMode(next);
                // Persist the lobby-wide toggle so every visitor — even
                // ones that land later or hard-refresh — sees the same
                // time of day. Realtime will broadcast to live peers.
                void supabase
                  .from("world_settings")
                  .upsert({ key: "time_mode", value: { day: next }, updated_at: new Date().toISOString() });
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-3.5 py-2 text-xs hover:bg-muted/50 transition-colors"
              title={dayMode ? "Switch the whole lobby to night" : "Switch the whole lobby to day"}
            >
              {dayMode ? "🌙 Night" : "☀️ Day"}
            </button>
            <button
              onClick={(e) => {
                setEmoteWheelOpen((v) => !v);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-3.5 py-2 text-xs hover:bg-muted/50 transition-colors"
              title="Emote wheel (B)"
            >
              👋 Emote
            </button>
            <button
              onClick={(e) => {
                setCharPanelOpen((v) => !v);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-3.5 py-2 text-xs hover:bg-muted/50 transition-colors"
            >
              🎭 {charName.replace(/_/g, " ")}
            </button>
            <button
              onClick={(e) => {
                // Quick jetpack on/off. Off = "none" (parkour mode:
                // Space becomes a jump). On = restore the previously
                // equipped pack (default "stock").
                if (equippedJetpack === "none") {
                  const last = localStorage.getItem("city.jetpack.last") || "stock";
                  applyJetpackRef.current?.(last);
                  setEquippedJetpack(last);
                  localStorage.setItem("city.jetpack", last);
                  setFallDamageEnabled(false);
                } else {
                  localStorage.setItem("city.jetpack.last", equippedJetpack);
                  applyJetpackRef.current?.("none");
                  setEquippedJetpack("none");
                  localStorage.setItem("city.jetpack", "none");
                  setFallDamageEnabled(true);
                }
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-3.5 py-2 text-xs hover:bg-muted/50 transition-colors"
              title={
                equippedJetpack === "none"
                  ? "Put your jetpack back on"
                  : "Take off the jetpack (Space becomes Jump)"
              }
            >
              {equippedJetpack === "none" ? "🎒 Equip jetpack" : "🚫 Take off pack"}
            </button>
            <button
              onClick={(e) => {
                setFallDamageEnabled((v) => !v);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-3.5 py-2 text-xs hover:bg-muted/50 transition-colors"
              title={fallDamageEnabled ? "Turn fall damage off" : "Turn fall damage on"}
            >
              {fallDamageEnabled ? "💥 Splat" : "🛟 Safe"}
            </button>
            <button
              onClick={(e) => {
                travelRef.current?.();
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-3.5 py-2 text-xs hover:bg-muted/50 transition-colors"
              title="Fast travel"
            >
              {hud.nearTjs ? "🏙️ Plaza" : hud.nearMars ? "🛒 TJ's Galaxy" : hud.nearMoon ? "🔴 Mars" : hud.nearIsland ? "🌙 Moon" : "🏝️ Island"}
            </button>
            {hud.stars > 0 && (
              <button
                onClick={(e) => {
                  resetRunRef.current?.();
                  e.currentTarget.blur();
                }}
                className="glass-panel rounded-full px-3.5 py-2 text-xs hover:bg-muted/50 transition-colors"
                title="Reset the star run"
              >
                ↻ Run
              </button>
            )}
            <button
              onClick={(e) => {
                const next = !chatOpen;
                setChatOpen(next);
                chatOpenRef.current = next;
                if (next) setChatUnread(0);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-3.5 py-2 text-xs hover:bg-muted/50 transition-colors"
              title="Community terminal"
            >
              💬 {peers.online ? peers.count : ""}
              {chatUnread > 0 && <span className="text-amber-300"> +{chatUnread}</span>}
            </button>
          </div>
          {emoteWheelOpen && (
            <div className="glass-panel rounded-2xl p-3 w-60 animate-scale-in">
              <div className="flex items-center justify-between text-[11px] mb-2">
                <span className="font-heading font-semibold tracking-wider text-primary">
                  EMOTE WHEEL
                </span>
                <span className="text-muted-foreground">everyone sees it</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(Object.keys(EMOTE_EMOJI) as EmoteName[]).map((name) => (
                  <button
                    key={name}
                    onClick={(e) => {
                      mpRef.current?.sendEmote(name);
                      setEmoteWheelOpen(false);
                      e.currentTarget.blur();
                    }}
                    className="flex flex-col items-center justify-center gap-1 rounded-xl bg-muted/30 hover:bg-muted/60 transition-colors py-2 text-2xl"
                    title={name}
                  >
                    <span>{EMOTE_EMOJI[name]}</span>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {chatOpen && (
            <div className="glass-panel rounded-2xl p-3 w-80 sm:w-96 flex flex-col gap-2">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-heading font-semibold tracking-wider text-primary">
                  COMMUNITY TERMINAL
                </span>
                <span className="text-muted-foreground">
                  <span className={peers.online ? "text-primary" : ""}>{peers.count}</span>
                  {" pilots · "}
                  <span className="text-violet-300">agents live</span>
                </span>
              </div>
              <div className="max-h-[42dvh] overflow-y-auto space-y-1 text-xs pr-1">
                {chatMessages.length === 0 && (
                  <div className="text-muted-foreground">
                    Group chat for the whole island — humans here and agents on
                    Telegram / OpenClaw all share this feed. Say hi 👋
                  </div>
                )}
                {chatMessages.map((m) => (
                  <div key={m.id} className="leading-snug">
                    <span
                      className={
                        m.self
                          ? "text-primary font-semibold"
                          : m.agent
                            ? "text-violet-300 font-semibold"
                            : "text-amber-300 font-semibold"
                      }
                    >
                      {m.agent ? "🤖 " : ""}
                      {m.name}
                    </span>{" "}
                    <span className="text-foreground/90 break-words">{m.text}</span>
                  </div>
                ))}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const t = chatDraft.trim();
                  if (!t) return;
                  mpRef.current?.sendChat(t);
                  playLocalChatRef.current?.(t);
                  setChatDraft("");
                  // Cross-post into the agent lobby so OpenClaw / Telegram
                  // agents see what humans say. Fire-and-forget.
                  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
                  const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
                  if (SUPABASE_URL && SUPABASE_KEY) {
                    const humanKey = `human-city-${playerName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
                    void fetch(`${SUPABASE_URL}/functions/v1/vibe-world`, {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        apikey: SUPABASE_KEY,
                        Authorization: `Bearer ${SUPABASE_KEY}`,
                      },
                      body: JSON.stringify({
                        action: "join",
                        agent_key: humanKey,
                        name: playerName,
                        color: "#fbbf24",
                      }),
                    })
                      .then(() =>
                        fetch(`${SUPABASE_URL}/functions/v1/vibe-world`, {
                          method: "POST",
                          headers: {
                            "Content-Type": "application/json",
                            apikey: SUPABASE_KEY,
                            Authorization: `Bearer ${SUPABASE_KEY}`,
                          },
                          body: JSON.stringify({ action: "say", agent_key: humanKey, text: t }),
                        }),
                      )
                      .catch(() => {});
                  }
                }}
                className="flex gap-1.5"
              >
                <input
                  value={chatDraft}
                  onChange={(e) => setChatDraft(e.target.value)}
                  placeholder={`chat as ${playerName}`}
                  maxLength={280}
                  className="flex-1 min-w-0 bg-muted/40 border border-border/40 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-primary/60"
                />
                <button type="submit" className="px-2.5 rounded-lg bg-primary/25 text-primary text-xs">
                  →
                </button>
              </form>
              <button
                onClick={() => {
                  const n = prompt("Display name", playerName)?.trim();
                  if (n) {
                    setPlayerName(n);
                    localStorage.setItem("city.playerName", n);
                    mpRef.current?.setName(n);
                  }
                }}
                className="text-[10px] text-muted-foreground text-left hover:text-foreground transition-colors"
              >
                ✏️ {playerName}
              </button>
            </div>
          )}
          {charPanelOpen && (
            <div className="glass-panel rounded-2xl p-2 w-56 max-h-[46dvh] overflow-y-auto space-y-0.5">
              {CHARACTERS.map((c) => (
                <button
                  key={c.name}
                  onClick={(e) => {
                    setCharName(c.name);
                    charRef.current = c.name;
                    // Broadcast so the nav emoji + /profile + other
                    // worlds all reflect the same pick.
                    setActiveCharacter(c.name);
                    loadPilotRef.current?.(c.name);
                    e.currentTarget.blur();
                  }}
                  className={`w-full text-left text-xs rounded-lg px-2.5 py-1.5 transition-colors ${
                    charName === c.name
                      ? "bg-primary/25 text-primary"
                      : "text-foreground/75 hover:bg-muted/50"
                  }`}
                >
                  {c.name.replace(/_/g, " ")}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Vibe Shop dialog — styled like stepping inside the neon kiosk:
          marquee header, string lights, and goods sitting on lit shelves.
          Free during early access; coin prices are shown for the future. */}
      {entered && shopOpen && (
        <div
          className="fixed inset-0 z-40 flex items-end sm:items-center justify-center p-3 sm:p-6 bg-background/70 backdrop-blur-sm"
          onClick={() => setShopOpen(false)}
        >
          <div
            className="rounded-2xl w-full max-w-md max-h-[90dvh] flex flex-col overflow-hidden ring-1 ring-emerald-300/30 shadow-[0_0_60px_rgba(45,212,168,0.18)]"
            style={{ background: "linear-gradient(180deg, #0c1118 0%, #10141c 40%, #131a24 100%)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Marquee header */}
            <div
              className="relative px-4 pt-4 pb-3 shrink-0"
              style={{ background: "linear-gradient(180deg, rgba(45,212,168,0.16), rgba(45,212,168,0.03))" }}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {/* The same iridescent emblem the /coin page spins. */}
                  <div className="-my-2 -ml-1 shrink-0">
                    <VibeArc size={62} rotateSeconds={18} />
                  </div>
                  <div>
                    <div
                      className="font-heading font-bold text-lg tracking-[0.14em] text-emerald-200"
                      style={{ textShadow: "0 0 18px rgba(45,212,168,0.75)" }}
                    >
                      VIBE SHOP
                    </div>
                    <div className="text-[10px] uppercase tracking-[0.24em] text-emerald-200/50">
                      backed by $VIBE · Vibe Island flagship
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-amber-300/10 ring-1 ring-amber-300/40 px-2.5 py-1 text-xs font-heading font-semibold text-amber-300">
                    ✦ {hud.gems}
                  </span>
                  <button
                    onClick={() => setShopOpen(false)}
                    className="text-emerald-100/50 hover:text-emerald-100 text-lg leading-none px-2"
                    aria-label="Close shop"
                  >
                    ✕
                  </button>
                </div>
              </div>
              {/* String lights along the header edge */}
              <div className="absolute bottom-0 left-0 right-0 flex justify-between px-3 translate-y-1/2">
                {Array.from({ length: 11 }).map((_, i) => (
                  <span
                    key={i}
                    className="w-1.5 h-1.5 rounded-full"
                    style={{
                      background: i % 2 === 0 ? "#46e88c" : "#e94f8a",
                      boxShadow: `0 0 6px ${i % 2 === 0 ? "#46e88c" : "#e94f8a"}`,
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="p-4 pt-5 space-y-5 overflow-y-auto">
              {/* The /coin page's account interface, synced in here so
                  it's obvious this shop runs on Vibe Coin: profile,
                  wallet link, live $VIBE balance. */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[11px] font-heading font-semibold tracking-[0.2em] text-emerald-200/80">
                    YOUR VIBE ACCOUNT
                  </span>
                  <span className="flex-1 h-px bg-gradient-to-r from-emerald-300/40 to-transparent" />
                  <Link
                    to="/coin"
                    className="text-[10px] uppercase tracking-[0.18em] text-emerald-300/80 hover:text-emerald-200 transition-colors"
                  >
                    open the vibe page →
                  </Link>
                </div>
                <VibeAccountCard variant="card" />
              </div>

              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[11px] font-heading font-semibold tracking-[0.2em] text-emerald-200/80">
                    HATS
                  </span>
                  <span className="flex-1 h-px bg-gradient-to-r from-emerald-300/40 to-transparent" />
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {HAT_CATALOG.map((h) => {
                    const eq = equippedHat === h.id;
                    return (
                      <button
                        key={h.id}
                        onClick={() => {
                          setEquippedHat(h.id);
                          saveEquippedHat(h.id);
                          applyHatRef.current?.(h.id);
                        }}
                        className={`relative rounded-xl p-2 flex flex-col items-center gap-1 transition-all duration-150 hover:-translate-y-0.5 ${
                          eq
                            ? "bg-emerald-400/15 ring-1 ring-emerald-300 text-emerald-100 shadow-[0_0_16px_rgba(45,212,168,0.3)]"
                            : "bg-white/[0.04] ring-1 ring-white/10 hover:ring-emerald-300/40 hover:bg-emerald-400/10 text-foreground/80"
                        }`}
                      >
                        {eq && (
                          <span className="absolute -top-1.5 right-1 rounded-full bg-emerald-300 text-emerald-950 text-[8px] font-bold px-1.5 leading-relaxed">
                            ON
                          </span>
                        )}
                        <span className="text-2xl drop-shadow-[0_2px_6px_rgba(0,0,0,0.5)]">{h.emoji}</span>
                        <span className="text-[10px] text-center leading-tight">{h.name}</span>
                        <span className="text-[9px] font-mono text-amber-300/80">
                          {h.price === 0 ? "free" : `${h.price} 🪙`}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-gradient-to-r from-amber-900/70 via-amber-800/60 to-amber-900/70 shadow-[0_2px_6px_rgba(0,0,0,0.5)]" />
              </div>

              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[11px] font-heading font-semibold tracking-[0.2em] text-emerald-200/80">
                    JET BOOSTS
                  </span>
                  <span className="flex-1 h-px bg-gradient-to-r from-emerald-300/40 to-transparent" />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {FLAME_CATALOG.map((f) => {
                    const eq = equippedFlame === f.id;
                    return (
                      <button
                        key={f.id}
                        onClick={() => {
                          setEquippedFlame(f.id);
                          saveEquippedFlame(f.id);
                          applyFlameRef.current?.(f.id);
                        }}
                        className={`relative rounded-xl p-2 flex flex-col items-center gap-1 transition-all duration-150 hover:-translate-y-0.5 ${
                          eq
                            ? "bg-emerald-400/15 ring-1 ring-emerald-300 text-emerald-100 shadow-[0_0_16px_rgba(45,212,168,0.3)]"
                            : "bg-white/[0.04] ring-1 ring-white/10 hover:ring-emerald-300/40 hover:bg-emerald-400/10 text-foreground/80"
                        }`}
                      >
                        {eq && (
                          <span className="absolute -top-1.5 right-1 rounded-full bg-emerald-300 text-emerald-950 text-[8px] font-bold px-1.5 leading-relaxed">
                            ON
                          </span>
                        )}
                        <span className="text-xl">{f.emoji}</span>
                        <span
                          className="w-6 h-1.5 rounded-full"
                          style={{ background: f.color, boxShadow: `0 0 10px ${f.color}` }}
                        />
                        <span className="text-[10px] text-center leading-tight">{f.name}</span>
                        <span className="text-[9px] font-mono text-amber-300/80">
                          {f.price === 0 ? "free" : `${f.price} 🪙`}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-gradient-to-r from-amber-900/70 via-amber-800/60 to-amber-900/70 shadow-[0_2px_6px_rgba(0,0,0,0.5)]" />
              </div>

              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[11px] font-heading font-semibold tracking-[0.2em] text-emerald-200/80">
                    JET PACKS
                  </span>
                  <span className="flex-1 h-px bg-gradient-to-r from-emerald-300/40 to-transparent" />
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {JETPACK_CATALOG.map((j) => {
                    const eq = equippedJetpack === j.id;
                    const returned = !j.equipped;
                    return (
                      <button
                        key={j.id}
                        onClick={() => {
                          setEquippedJetpack(j.id);
                          saveEquippedJetpack(j.id);
                          applyJetpackRef.current?.(j.id);
                          setFallDamageEnabled(!j.equipped);
                        }}
                        className={`relative rounded-xl p-2 flex flex-col items-center gap-1 transition-all duration-150 hover:-translate-y-0.5 ${
                          eq
                            ? "bg-emerald-400/15 ring-1 ring-emerald-300 text-emerald-100 shadow-[0_0_16px_rgba(45,212,168,0.3)]"
                            : "bg-white/[0.04] ring-1 ring-white/10 hover:ring-emerald-300/40 hover:bg-emerald-400/10 text-foreground/80"
                        }`}
                      >
                        {eq && (
                          <span className="absolute -top-1.5 right-1 rounded-full bg-emerald-300 text-emerald-950 text-[8px] font-bold px-1.5 leading-relaxed">
                            ON
                          </span>
                        )}
                        <span className="text-xl">{j.emoji}</span>
                        {returned ? (
                          <span className="w-6 h-1.5 rounded-full bg-muted-foreground/40" />
                        ) : (
                          <span className="flex gap-0.5">
                            <span
                              className="w-3 h-1.5 rounded-l-full"
                              style={{ background: j.body }}
                            />
                            <span
                              className="w-3 h-1.5 rounded-r-full"
                              style={{ background: j.trim, boxShadow: `0 0 8px ${j.trim}` }}
                            />
                          </span>
                        )}
                        <span className="text-[10px] text-center leading-tight">{j.name}</span>
                        <span className="text-[9px] font-mono text-amber-300/80">
                          {j.price === 0 ? (returned ? "return" : "free") : `${j.price} 🪙`}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-gradient-to-r from-amber-900/70 via-amber-800/60 to-amber-900/70 shadow-[0_2px_6px_rgba(0,0,0,0.5)]" />
              </div>

              <div className="text-[10px] text-emerald-100/40 text-center pb-1">
                Early access — everything's free while the island grows.
                <br />
                Hold Space to test your new boost · the look saves across visits.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Touch controls for phones: joystick + jetpack button. */}
      {entered && (
        <VibeMakerPanel
          open={portalOpen}
          onClose={() => setPortalOpen(false)}
          spawns={spawns}
          authUserId={authUserId}
        />
      )}

      {/* First-entry name modal — shows once until the user picks/skips. */}
      {entered && (
        <NameEntryModal
          open={nameModalOpen}
          initialName={playerName}
          authUserId={authUserId}
          avatarLabel={charName}
          onSubmit={(name) => {
            setPlayerName(name);
            mpRef.current?.setName(name);
            setNameModalOpen(false);
          }}
          onSkip={() => setNameModalOpen(false)}
        />
      )}

      <ArcadeModal open={arcadeOpen} onClose={() => setArcadeOpen(false)} />
      <PhotoGalleryModal
        open={galleryOpen}
        photos={galleryPhotos}
        onClose={() => setGalleryOpen(false)}
      />




      {/* 1:1 chat with a nearby player or AI agent. */}
      {entered && (
        <PersonChatPanel
          open={!!chatTarget}
          onClose={() => setChatTarget(null)}
          target={chatTarget}
          authUserId={authUserId}
          myName={playerName}
        />
      )}

      {entered && isTouch && <TouchControls moveRef={touchMoveRef} jetRef={touchJetRef} mode={equippedJetpack === "none" ? "jump" : "jet"} />}

      {/* Whimsical fall-damage splat → plaza respawn flash. */}
      {entered && respawnFx > 0 && (
        <div
          key={respawnFx}
          className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center animate-fade-in"
        >
          <div className="absolute inset-0 bg-rose-500/15 backdrop-blur-[1px]" />
          <div className="relative glass-panel rounded-2xl px-6 py-4 text-center animate-scale-in">
            <div className="text-5xl mb-1">💫</div>
            <div className="text-sm font-semibold text-primary">SPLAT!</div>
            <div className="text-xs text-muted-foreground">Respawning on Vibe Island…</div>
          </div>
        </div>
      )}

      {/* Transcendence Portal flash — voluntary entry or out-of-world catch. */}
      {entered && transcendFx > 0 && (
        <div
          key={transcendFx}
          className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center animate-fade-in"
        >
          <div className="absolute inset-0 bg-emerald-400/20 backdrop-blur-md" />
          <div className="relative glass-panel rounded-2xl px-6 py-4 text-center animate-scale-in border border-emerald-300/60 shadow-[0_0_40px_rgba(125,255,200,0.65)]">
            <div className="text-5xl mb-1">✨</div>
            <div className="text-sm font-semibold text-emerald-200">TRANSCENDED</div>
            <div className="text-xs text-emerald-100/80">Skydiving back into the plaza…</div>
          </div>
        </div>
      )}



      {/* Ninja portal descent flash + arrival pulse. */}
      {entered && enterFx > 0 && (
        <div
          key={enterFx}
          className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center animate-fade-in"
          onAnimationEnd={() => window.setTimeout(() => setEnterFx(0), 900)}
        >
          <div className="absolute inset-0 bg-purple-700/30 backdrop-blur-md" />
          <div className="relative glass-panel rounded-2xl px-6 py-4 text-center animate-scale-in border border-purple-400/60 shadow-[0_0_40px_rgba(183,138,255,0.6)]">
            <div className="text-5xl mb-1">🥷</div>
            <div className="text-sm font-semibold text-purple-200">THE GREMLIN MINES</div>
            <div className="text-xs text-purple-300/80">Purple mist deadens your jetpack…</div>
          </div>
        </div>
      )}

      {/* Underground HUD: boss HP + "Go back" exit. */}
      {entered && underground && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-2 pointer-events-none">
          <div className="glass-panel rounded-full px-4 py-1.5 text-xs text-purple-200 border border-purple-400/40 shadow-[0_0_20px_rgba(183,138,255,0.4)] bg-purple-950/40 backdrop-blur-md flex items-center gap-2">
            <span>⚔ Boss HP</span>
            <span className="font-mono tracking-widest">
              {Array.from({ length: 3 }).map((_, i) => (
                <span key={i} className={i < bossHp ? "text-rose-300" : "text-rose-900/50"}>
                  ❤
                </span>
              ))}
            </span>
          </div>
          <button
            onClick={() => exitUndergroundRef.current?.()}
            className="pointer-events-auto glass-panel rounded-full px-4 py-1.5 text-xs text-cyan-100 border border-cyan-300/50 shadow-[0_0_18px_rgba(122,235,255,0.5)] hover:bg-cyan-500/15 transition-colors"
          >
            🔼 Return to surface
          </button>
        </div>
      )}

      {/* God Orb shard reward — appears once when the boss falls. */}
      {entered && showShardReward && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-4 animate-fade-in"
          onClick={() => setShowShardReward(false)}
        >
          <div
            className="glass-panel rounded-3xl px-8 py-6 max-w-sm text-center border border-amber-300/50 shadow-[0_0_50px_rgba(255,210,120,0.55)] animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-6xl mb-3">✨</div>
            <div className="font-heading text-xl text-amber-200 mb-1">A God Orb Shard!</div>
            <div className="text-xs text-amber-100/80 mb-4 leading-relaxed">
              The boss gremlin shatters. The missing half of the God Orb
              splits into shards — you've recovered the first. Find the
              others to restore the light to the city.
            </div>
            <button
              onClick={() => {
                setShowShardReward(false);
                exitUndergroundRef.current?.();
              }}
              className="glass-panel rounded-full px-5 py-2 text-sm text-amber-100 border border-amber-300/50 hover:bg-amber-500/15 transition-colors"
            >
              Return to the surface
            </button>
          </div>
        </div>
      )}



      {/* Vibe Island arrival card: covers the first-load pop-in with a
          sky gradient + wordmark, then fades out as the camera swoops
          down to the lawn. Purely visual — input passes straight through. */}
      <AnimatePresence>
        {arriving && (
          <motion.div
            key="island-arrival"
            className="fixed inset-0 z-40 pointer-events-none flex items-center justify-center"
            style={{
              background:
                "linear-gradient(180deg, #0b1c33 0%, #1b4a6b 34%, #58a7c8 68%, #a8dcE8 100%)",
            }}
            initial={{ opacity: 1 }}
            animate={{ opacity: 0 }}
            transition={{ duration: 1.9, delay: 0.9, ease: "easeInOut" }}
            onAnimationComplete={() => setArriving(false)}
          >
            <motion.div
              className="text-center"
              initial={{ opacity: 0, y: 14, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.7, ease: "easeOut" }}
            >
              <div className="text-5xl mb-3">🏝️</div>
              <h1 className="font-heading text-4xl sm:text-5xl font-bold tracking-[0.18em] text-white drop-shadow-[0_4px_24px_rgba(0,0,0,0.45)]">
                VIBE ISLAND
              </h1>
              <p className="mt-2 text-sm tracking-[0.3em] uppercase text-white/75">
                a magically weird world in the sky
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Live mini-game status chip — sits under the top nav while a
          sky-island game is running, with a quit ✕. */}
      {gameHud && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-30 glass-panel rounded-full pl-4 pr-2 py-2 flex items-center gap-2 text-sm">
          <span className="text-primary font-heading font-semibold">{gameHud}</span>
          <button
            onClick={(e) => {
              skyGamesRef.current?.cancel();
              e.currentTarget.blur();
            }}
            className="rounded-full w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            aria-label="Quit game"
            title="Quit game"
          >
            ✕
          </button>
        </div>
      )}

      {/* Bottom-center action stack: context buttons appear as you
          approach things — the zipline, a cow, Jerry, Vibey. */}
      {entered && npcTarget === null && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-2">
          {drivingKart >= 0 && (
            <div className="flex items-center gap-2 animate-fade-in">
              <span className="glass-panel rounded-full px-4 py-2 text-xs text-muted-foreground">
                {isTouch ? "joystick = drive + steer" : "W/S drive · A/D steer"}
              </span>
              <button
                onClick={(e) => {
                  exitKartRef.current?.();
                  e.currentTarget.blur();
                }}
                className="glass-panel rounded-full px-5 py-2.5 text-sm text-primary"
              >
                ⏏ Hop out
              </button>
            </div>
          )}
          {nearGamePrompt && !gameHud && (
            <button
              onClick={(e) => {
                skyGamesRef.current?.start(nearGamePrompt.key);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-primary animate-pulse"
            >
              🎮 Play {nearGamePrompt.name} <span className="text-amber-300">· earn ✦</span>
            </button>
          )}
          {(hud.nearZip || hud.riding) && (
            <button
              onClick={(e) => {
                zipGrabRef.current?.();
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-amber-300"
            >
              {hud.riding ? "🪂 Let go" : "🧗 Grab the zipline"}
            </button>
          )}
          {(hud.nearSwing || hud.swinging) && (
            <button
              onClick={(e) => {
                swingGrabRef.current?.();
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-primary"
            >
              {hud.swinging ? "🤸 Hop off (Space)" : "🪢 Jump on the swing"}
            </button>
          )}
          {nearShop && !shopOpen && (
            <button
              onClick={(e) => {
                setShopOpen(true);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-primary shadow-[0_0_24px_hsl(var(--primary)/0.45)]"
            >
              🛍️ Open Vibe Shop
            </button>
          )}
          {nearPortal && !portalOpen && (
            <button
              onClick={(e) => {
                setPortalOpen(true);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-primary shadow-[0_0_24px_hsl(var(--primary)/0.45)]"
            >
              ✨ Open Vibe Maker
            </button>
          )}
          {nearArcade && !arcadeOpen && (
            <button
              onClick={(e) => {
                setArcadeOpen(true);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-fuchsia-100 border border-fuchsia-300/50 shadow-[0_0_24px_rgba(232,121,249,0.55)] bg-fuchsia-950/30 backdrop-blur-md hover:bg-fuchsia-500/15 transition-colors"
            >
              🕹️ Play Esmeralda Jump
            </button>
          )}
          {nearTv && !galleryOpen && galleryPhotos.length > 0 && (
            <button
              onClick={(e) => {
                setGalleryOpen(true);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-cyan-100 border border-cyan-300/50 shadow-[0_0_24px_rgba(122,240,255,0.55)] bg-cyan-950/30 backdrop-blur-md hover:bg-cyan-300/15 transition-colors"
            >
              📸 Open Holo Gallery ({galleryPhotos.length})
            </button>
          )}
          {nearNinjaPortal && !underground && (
            <button
              onClick={(e) => {
                enterUndergroundRef.current?.();
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-purple-100 border border-purple-400/50 shadow-[0_0_24px_rgba(183,138,255,0.55)] bg-purple-950/30 backdrop-blur-md hover:bg-purple-500/15 transition-colors"
            >
              🥷 Enter Ninja Portal
            </button>
          )}
          {nearAvatarPortal && (
            <div className="flex flex-col items-center gap-2">
              <div className="glass-panel rounded-2xl px-2.5 py-2 flex items-center gap-2 border border-cyan-300/40 shadow-[0_0_28px_rgba(122,240,255,0.55)] bg-cyan-950/30 backdrop-blur-md">
                <button
                  onClick={(e) => {
                    setAvatarPreviewIdx((i) => (i - 1 + CHARACTERS.length) % CHARACTERS.length);
                    e.currentTarget.blur();
                  }}
                  aria-label="Previous character"
                  className="w-9 h-9 rounded-full bg-cyan-500/15 hover:bg-cyan-500/30 text-cyan-100 text-lg leading-none transition-colors"
                >
                  ◀
                </button>
                <div className="min-w-[150px] text-center px-1">
                  <div className="text-[9px] uppercase tracking-[0.25em] text-cyan-300/70">
                    Hologram · {avatarPreviewIdx + 1}/{CHARACTERS.length}
                  </div>
                  <div className="font-heading text-cyan-100 text-sm tracking-wide truncate">
                    {CHARACTERS[avatarPreviewIdx]?.name.replace(/_/g, " ") ?? "—"}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    setAvatarPreviewIdx((i) => (i + 1) % CHARACTERS.length);
                    e.currentTarget.blur();
                  }}
                  aria-label="Next character"
                  className="w-9 h-9 rounded-full bg-cyan-500/15 hover:bg-cyan-500/30 text-cyan-100 text-lg leading-none transition-colors"
                >
                  ▶
                </button>
              </div>
              <button
                onClick={(e) => {
                  const c = CHARACTERS[avatarPreviewIdx];
                  if (!c) return;
                  setCharName(c.name);
                  charRef.current = c.name;
                  setActiveCharacter(c.name);
                  loadPilotRef.current?.(c.name);
                  e.currentTarget.blur();
                }}
                disabled={CHARACTERS[avatarPreviewIdx]?.name === charName}
                className="glass-panel rounded-full px-5 py-2.5 text-sm text-cyan-100 border border-cyan-300/50 shadow-[0_0_24px_rgba(122,240,255,0.5)] disabled:opacity-50 disabled:cursor-default hover:bg-cyan-500/15 transition-colors"
              >
                {CHARACTERS[avatarPreviewIdx]?.name === charName
                  ? "✓ Equipped"
                  : "✨ Become this character"}
              </button>
              {!bigMode ? (
                <input
                  type="password"
                  value={secretInput}
                  placeholder="whisper the secret word…"
                  onChange={(e) => {
                    const v = e.target.value;
                    setSecretInput(v);
                    if (v.trim().toLowerCase() === "magically weird") {
                      setBigMode(true);
                      setSecretInput("");
                    }
                  }}
                  maxLength={32}
                  className="glass-panel rounded-full px-3 py-1.5 text-[11px] text-center text-cyan-200 placeholder:text-cyan-300/50 bg-transparent border border-cyan-300/30 focus:outline-none focus:border-cyan-300/80 w-56"
                />
              ) : (
                <div className="glass-panel rounded-2xl px-3 py-2 flex items-center gap-2 border border-cyan-300/40 shadow-[0_0_24px_rgba(122,240,255,0.45)]">
                  <span className="text-[11px] text-cyan-200">🔮 size</span>
                  <input
                    type="range"
                    min={0.5}
                    max={8}
                    step={0.1}
                    value={bigSize}
                    onChange={(e) => {
                      const s = Number(e.target.value);
                      setBigSize(s);
                      setPlayerScaleRef.current?.(s);
                    }}
                    className="w-40 accent-cyan-300"
                  />
                  <span className="text-[11px] tabular-nums text-cyan-100 w-10 text-right">
                    {bigSize.toFixed(1)}x
                  </span>
                  <button
                    onClick={(e) => {
                      setBigSize(1);
                      setPlayerScaleRef.current?.(1);
                      e.currentTarget.blur();
                    }}
                    className="text-[10px] text-cyan-300/80 hover:text-cyan-100 px-1"
                    title="Reset"
                  >
                    ↺
                  </button>
                </div>
              )}
            </div>
          )}
          {/* nearPerson bump/message moved to a floating in-world bubble above the character */}
          {nearRoster && !rosterOpen && (
            <button
              onClick={(e) => {
                setRosterOpen(true);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-primary shadow-[0_0_24px_hsl(var(--primary)/0.45)]"
            >
              📺 Open Live Roster
            </button>
          )}

          {hud.nearCow && (
            <button
              onClick={(e) => {
                mooRef.current?.();
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm"
            >
              🐄 Moo
            </button>
          )}
          {/* Talk to Jerry moved to a floating in-world bubble above Jerry */}
          {nearKart >= 0 && drivingKart < 0 && (
            <button
              onClick={(e) => {
                enterKartRef.current?.(nearKart);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-primary animate-pulse"
            >
              🏎️ Drive the vibe kart
            </button>
          )}
          {nearSnackfe && (
            <button
              onClick={(e) => {
                setSnackOpen(true);
                setSnackMsg(null);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-primary animate-pulse"
            >
              🍦 Order at SnackFe
            </button>
          )}
          {nearVibey && (
            <button
              onClick={(e) => {
                setNpcTarget("vibey");
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-primary animate-pulse"
            >
              💬 Talk to Vibey
            </button>
          )}
          {nearNinjaCast && (
            <button
              onClick={(e) => {
                setNpcTarget(nearNinjaCast.key);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-primary animate-pulse"
            >
              🥷 Talk to {nearNinjaCast.name}{" "}
              <span className="text-amber-300">· THE PALACE</span>
            </button>
          )}
        </div>
      )}
      {rosterOpen && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 glass-panel rounded-2xl p-4 w-[min(94vw,28rem)] flex flex-col gap-3 animate-fade-in border border-primary/40 shadow-[0_0_30px_hsl(var(--primary)/0.35)]">
          <div className="flex items-center justify-between">
            <span className="font-heading font-semibold tracking-[0.2em] text-primary text-xs flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-rose-400 animate-pulse" />
              LIVE ROSTER · vibe-lobby
            </span>
            <button
              onClick={() => setRosterOpen(false)}
              className="text-muted-foreground hover:text-foreground px-1"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-muted-foreground border-b border-primary/20 pb-2">
            <span>{rosterAgents.length} online</span>
            <span>tile (x, y) · 12×8 grid</span>
          </div>
          <div className="max-h-[55vh] overflow-y-auto flex flex-col gap-1 font-mono text-sm">
            {rosterAgents.length === 0 ? (
              <div className="text-center text-muted-foreground italic py-6">
                waiting for agents…
              </div>
            ) : (
              rosterAgents.map((a, i) => (
                <div
                  key={a.key}
                  className={`flex items-center justify-between rounded-md px-3 py-2 ${
                    i % 2 === 0 ? "bg-primary/5" : ""
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span
                      className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                        a.status === "offline" ? "bg-muted-foreground" : "bg-primary"
                      }`}
                    />
                    {isAdmin && editingAgentId === a.id ? (
                      <input
                        autoFocus
                        value={editingAgentName}
                        onChange={(e) => setEditingAgentName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setEditingAgentId(null);
                          if (e.key === "Enter") {
                            const next = editingAgentName.trim();
                            if (!next || next === a.name) { setEditingAgentId(null); return; }
                            setSavingAgentId(a.id);
                            supabase
                              .from("world_agents")
                              .update({ name: next })
                              .eq("id", a.id)
                              .then(({ error }) => {
                                setSavingAgentId(null);
                                setEditingAgentId(null);
                                if (error) {
                                  console.warn("[roster] rename failed", error);
                                  toast.error("Couldn't rename", { description: error.message });
                                } else {
                                  toast.success("Renamed", { description: `${a.name} → ${next}` });
                                }
                              });
                          }
                        }}
                        onBlur={() => setEditingAgentId(null)}
                        className="flex-1 min-w-0 bg-background/60 border border-primary/40 rounded px-2 py-0.5 text-sm text-foreground outline-none focus:border-primary"
                      />
                    ) : (
                      <>
                        <span className="truncate text-foreground">{a.name}</span>
                        {isAdmin && (
                          <button
                            onClick={() => { setEditingAgentId(a.id); setEditingAgentName(a.name); }}
                            disabled={savingAgentId === a.id}
                            className="text-[10px] uppercase tracking-wider text-primary/70 hover:text-primary px-1 disabled:opacity-50"
                            title="Rename agent (admin)"
                          >
                            ✎
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-primary/80 tabular-nums">
                    <span>
                      {a.x === null || a.y === null
                        ? "—"
                        : `${String(a.x).padStart(2, " ")},${String(a.y).padStart(2, " ")}`}
                    </span>
                    <span className="text-muted-foreground w-14 text-right">
                      {a.status || "online"}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground text-center pt-1">
            updates instantly when agents join, move, or sign off
          </div>
        </div>
      )}

      {snackOpen && (
        <div
          className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 rounded-2xl w-[min(92vw,24rem)] flex flex-col overflow-hidden animate-fade-in ring-4 ring-[#8b5e34] shadow-[0_10px_50px_rgba(0,0,0,0.6)]"
          style={{ background: "radial-gradient(120% 100% at 50% 0%, #232a2f 0%, #191f24 55%, #14181d 100%)" }}
        >
          {/* Chalkboard header with string lights, like the real counter */}
          <div className="relative px-4 pt-3.5 pb-3 border-b border-white/10">
            <div className="flex items-center justify-between">
              <div>
                <span
                  className="font-heading font-bold tracking-[0.12em] text-base text-emerald-300"
                  style={{ textShadow: "0 0 16px rgba(70,232,140,0.6)" }}
                >
                  SnackFe
                </span>
                <span className="ml-2 text-[10px] uppercase tracking-[0.22em] text-pink-300/80">
                  · open late · vibes inside ·
                </span>
              </div>
              <button
                onClick={() => setSnackOpen(false)}
                className="text-white/40 hover:text-white px-1"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="absolute -bottom-1 left-0 right-0 flex justify-between px-4">
              {Array.from({ length: 9 }).map((_, i) => (
                <span
                  key={i}
                  className="w-1.5 h-1.5 rounded-full"
                  style={{
                    background: i % 2 === 0 ? "#46e88c" : "#e94f8a",
                    boxShadow: `0 0 6px ${i % 2 === 0 ? "#46e88c" : "#e94f8a"}`,
                  }}
                />
              ))}
            </div>
          </div>

          <div className="p-4 pt-3 flex flex-col gap-3">
            <div className="flex items-center justify-between rounded-lg bg-white/[0.04] ring-1 ring-white/10 px-3 py-2">
              <span className="text-[11px] uppercase tracking-wider text-white/45">your gems</span>
              <span className="text-base font-heading font-semibold text-amber-300">
                ✦ {hud.gems}
              </span>
            </div>
            {/* The menu, chalk-style: dotted leaders out to the price */}
            <div className="grid grid-cols-1 gap-1">
              {[
                { emoji: "🍓", name: "Strawberry", cost: 1, msg: "Sweet and bright. A tiny burst of summer." },
                { emoji: "🍦", name: "Mint coin float", cost: 2, msg: "An icy mint float in a tall glass. +1 vibe." },
                { emoji: "🥐", name: "Sunrise croissant", cost: 3, msg: "Flaky, buttery, still warm." },
                { emoji: "☕", name: "Edge espresso", cost: 3, msg: "Tiny cup, big punch. Your jetpack feels lighter." },
                { emoji: "🍡", name: "Neon mochi skewer", cost: 4, msg: "Three little glowing mochi on a stick." },
                { emoji: "🍉", name: "Watermelon slice", cost: 5, msg: "Cold, crunchy, dripping. The good kind of mess." },
              ].map((item) => {
                const owned = purchases[item.name] ?? 0;
                const canAfford = hud.gems >= item.cost;
                return (
                  <button
                    key={item.name}
                    disabled={!canAfford}
                    onClick={() => {
                      if (vibeBalanceRef.current < item.cost) return;
                      vibeBalanceRef.current -= item.cost;
                      setVibeBalanceTick((n) => n + 1);
                      persistVibeBalanceRef.current?.();
                      setPurchases((p) => ({ ...p, [item.name]: (p[item.name] ?? 0) + 1 }));
                      setSnackMsg(`${item.emoji} ${item.msg}`);
                    }}
                    className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-all ${
                      canAfford
                        ? "hover:bg-emerald-400/10 hover:ring-1 hover:ring-emerald-300/30"
                        : "opacity-35 cursor-not-allowed"
                    }`}
                  >
                    <span className="text-xl drop-shadow-[0_2px_5px_rgba(0,0,0,0.6)] transition-transform group-hover:scale-110">
                      {item.emoji}
                    </span>
                    <span className="text-white/90 whitespace-nowrap">
                      {item.name}
                      {owned > 0 && (
                        <span className="ml-1.5 text-[10px] text-emerald-300/70">×{owned}</span>
                      )}
                    </span>
                    <span className="flex-1 border-b border-dotted border-white/25 translate-y-1" />
                    <span className="text-xs font-mono text-amber-300">✦ {item.cost}</span>
                  </button>
                );
              })}
            </div>
            {snackMsg && (
              <div className="text-xs text-emerald-200 bg-emerald-400/10 ring-1 ring-emerald-300/25 rounded-lg px-3 py-2 animate-fade-in">
                {snackMsg}
              </div>
            )}
            {hud.gems === 0 && (
              <div className="text-[10px] text-white/40 text-center">
                collect ✦ gems around Vibe Island and the city to spend here
              </div>
            )}
          </div>
        </div>
      )}
      {npcTarget !== null && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 glass-panel rounded-2xl p-3 w-[min(92vw,26rem)] flex flex-col gap-2">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-heading font-semibold tracking-wider text-primary">
              {npcTarget === "jerry"
                ? "JERRY · snail of Jerry's Plaza"
                : npcTarget === "vibey"
                  ? "VIBEY · community agent"
                  : `${npcDisplayName(npcTarget).toUpperCase()} · ${palaceCast[npcTarget]?.title ?? ""} · THE PALACE`}
            </span>
            <button
              onClick={() => {
                endVoice();
                setNpcTarget(null);
              }}
              className="text-muted-foreground hover:text-foreground px-1"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          {npcTarget === "vibey" && (
            <div className="flex items-center gap-2 text-[11px]">
              {voiceState === "off" ? (
                <button
                  onClick={() => void beginVoice()}
                  className="rounded-full bg-primary/25 text-primary px-3 py-1.5 hover:bg-primary/35 transition-colors"
                >
                  🎙️ Talk out loud
                </button>
              ) : (
                <>
                  <button
                    onClick={endVoice}
                    className="rounded-full bg-destructive/25 text-destructive px-3 py-1.5 hover:bg-destructive/35 transition-colors"
                  >
                    ⏹ End voice
                  </button>
                  <span
                    className={
                      voiceState === "speaking"
                        ? "text-primary animate-pulse"
                        : "text-muted-foreground"
                    }
                  >
                    {voiceState === "connecting"
                      ? "opening the voice line…"
                      : voiceState === "speaking"
                        ? "🔊 Vibey is speaking…"
                        : "🎙️ listening — just talk"}
                  </span>
                </>
              )}
            </div>
          )}
          <div className="max-h-[26dvh] overflow-y-auto space-y-1.5 text-xs">
            {npcLogs[npcTarget].length === 0 && (
              <div className="text-muted-foreground">
                {npcTarget === "jerry"
                  ? "Jerry's eye stalks swivel toward you. Very slowly."
                  : npcTarget === "vibey"
                    ? "Vibey hovers a little closer, waiting for you to say something."
                    : `${npcDisplayName(npcTarget)} adjusts their mask and glances at the confessional cam.`}
              </div>
            )}
            {npcLogs[npcTarget].map((m, i) => (
              <div key={i}>
                <span className={m.who === "npc" ? "text-primary" : "text-amber-300"}>
                  {m.who === "npc" ? npcDisplayName(npcTarget) : playerName}
                </span>{" "}
                <span className="text-foreground/90">{m.text}</span>
              </div>
            ))}
            {vibeyThinking && (
              <div className="text-muted-foreground animate-pulse">
                {npcTarget === "jerry"
                  ? "Jerry is thinking… slowly…"
                  : npcTarget === "vibey"
                    ? "Vibey is thinking…"
                    : `${npcDisplayName(npcTarget)} is choosing their words for the cameras…`}
              </div>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const t = vibeyDraft.trim();
              if (!t || vibeyThinking) return;
              setVibeyDraft("");
              void sendToNpc(npcTarget, t);
            }}
            className="flex gap-1.5"
          >
            <input
              value={vibeyDraft}
              onChange={(e) => setVibeyDraft(e.target.value)}
              placeholder={`say something to ${npcDisplayName(npcTarget)}`}
              maxLength={280}
              className="flex-1 min-w-0 bg-muted/40 border border-border/40 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-primary/60"
            />
            <button
              type="submit"
              disabled={vibeyThinking}
              className="px-2.5 rounded-lg bg-primary/25 text-primary text-xs disabled:opacity-50"
            >
              →
            </button>
          </form>
        </div>
      )}

      {/* Controls hint, fades in once you enter. */}
      {entered && (
        <div className="absolute bottom-4 right-4 glass-panel rounded-2xl px-4 py-3 text-[11px] text-muted-foreground pointer-events-none hidden sm:block">
          WASD move · Shift run · <span className="text-primary">Space hold = jetpack</span> · drag
          look · pinch / scroll zoom
        </div>
      )}

      {/* EchoVoiceAgent moved into PersonChatPanel for per-agent voice chat */}



      {/* Entry overlay — fancy character picker + auto-name. */}
      <AnimatePresence>
        {!entered && (
          <motion.div
            className="absolute inset-0 z-20"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.5 } }}
          >
            <CityEntryScreen
              characters={CHARACTERS}
              initialCharacter={charName}
              initialName={playerName}
              onEnter={enter}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
