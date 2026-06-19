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
import { useLocation } from "react-router-dom";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { motion, AnimatePresence } from "framer-motion";
import { Rocket } from "lucide-react";
import { enableVR } from "@/lib/webxr";
import { buildCardboardIsland } from "@/components/city/cardboardIsland";
import { buildMoon } from "@/components/city/moon";

import { createAgentResidents } from "@/components/city/agentResidents";
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
import {
  createSpawnMesh,
  updateSpawns,
  type IslandSpawnRow,
} from "@/components/city/islandSpawns";

// Every Quaternius character can be the pilot — same glob pattern as
// the Lobby, so these assets are shared with it, not duplicated.
const CHARACTER_URLS = import.meta.glob(
  "@/assets/glb/characters/*.glb",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;

const CHARACTERS = Object.entries(CHARACTER_URLS)
  .map(([path, url]) => ({
    name: path.split("/").pop()!.replace(/\.glb$/, ""),
    url,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

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

// Movement feel.
const WALK_SPEED = 7;
const RUN_SPEED = 16;
const FLY_SPEED = 22; // jetpack cruising is faster than running…
const FLY_RUN_SPEED = 34; // …and Shift opens the throttle for island runs
const ZIP_SPEED = 10; // zipline glide, m/s
const GRAVITY = 24;
const THRUST = 50; // jetpack accel (net climb = THRUST - GRAVITY)
const MAX_RISE = 19;
const MAX_FALL = 32;
const PLAYER_RADIUS = 0.55;
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
  const [entered, setEntered] = useState(false);
  const enteredRef = useRef(false);
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
    nearZip: false,
    riding: false,
    nearSwing: false,
    swinging: false,
    nearCow: false,
  });
  const spentGemsRef = useRef(0);
  const [purchases, setPurchases] = useState<Record<string, number>>({});
  const travelRef = useRef<(() => void) | null>(null);
  const resetRunRef = useRef<(() => void) | null>(null);
  const islandSpawnRef = useRef<(() => void) | null>(null);
  const moonSpawnRef = useRef<(() => void) | null>(null);
  const routerLocation = useLocation();

  // Touch controls write straight into these; the tick reads them.
  const touchMoveRef = useRef<TouchMove>({ x: 0, y: 0 });
  const touchJetRef = useRef(false);
  const isTouch =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  // Multiplayer lobby + community terminal.
  const mpRef = useRef<Multiplayer | null>(null);
  const playLocalEmoteRef = useRef<((emote: EmoteName) => void) | null>(null);
  const playLocalChatRef = useRef<((text: string) => void) | null>(null);
  const [emoteWheelOpen, setEmoteWheelOpen] = useState(false);
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
    const generated = `Pilot-${Math.floor(100 + Math.random() * 900)}`;
    localStorage.setItem("city.playerName", generated);
    return generated;
  });

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
  const [snackOpen, setSnackOpen] = useState(false);
  const [snackMsg, setSnackMsg] = useState<string | null>(null);
  const [npcTarget, setNpcTarget] = useState<"vibey" | "jerry" | null>(null);
  const [vibeyThinking, setVibeyThinking] = useState(false);
  const [vibeyDraft, setVibeyDraft] = useState("");
  const [npcLogs, setNpcLogs] = useState<
    Record<"vibey" | "jerry", Array<{ who: "you" | "npc"; text: string }>>
  >({ vibey: [], jerry: [] });
  const npcHistoryRef = useRef<
    Record<"vibey" | "jerry", Array<{ role: "user" | "assistant"; content: string }>>
  >({ vibey: [], jerry: [] });
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


  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // ---- Renderer / scene / camera ---------------------------------
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
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
    const apronMat = new THREE.MeshStandardMaterial({ color: "#04060a", roughness: 1 });
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), apronMat);
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.05;
    scene.add(apron);

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

    // ---- The Moon (a landable celestial body near the island) -------
    const moonWorld = buildMoon({
      centerX: MOON_X,
      centerZ: MOON_Z,
      topY: MOON_TOP,
      boxes,
    });
    scene.add(moonWorld.group);

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
    let applyRemoteBump = (_x: number, _y: number, _z: number, _dirX: number, _dirZ: number, _speed: number) => {};

    // ---- Live Roster TV: scoreboard-style screen on the front of the
    // island showing every current agent and their lobby-grid tile.
    // Clicking it opens a fuller modal with the same list.
    const ROSTER_LX = -22;
    const ROSTER_LZ = 14;
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

    // ---- Cardboard TV: tune in the community photo gallery ----------
    // Same gallery_photos feed the /space TV uses.
    void supabase
      .from("gallery_photos")
      .select("image_url")
      .eq("community_id", "4202857f-13fd-4407-8906-3f8ffe63e510")
      .eq("is_visible", true)
      .order("display_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(16)
      .then(({ data }) => {
        const urls = (data ?? [])
          .map((row) => row.image_url as string)
          .filter(Boolean);
        if (urls.length) island.setTvPhotos(urls);
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

    // ---- Day / night ------------------------------------------------
    // One function flips the whole atmosphere: sky, fog, lights,
    // window glow, stars. The moon doubles as the daytime sun disk.
    let baseFogNear = 90;
    let baseFogFar = 520;
    const applyMode = (day: boolean) => {
      const sky = day ? "#9fd1f0" : "#05080d";
      (scene.background as THREE.Color).set(sky);
      const fog = scene.fog as THREE.Fog;
      fog.color.set(sky);
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
      moonMat.color.set(day ? 0xfff6cf : 0xe8f1ff);
      buildingSkins.forEach((s) => {
        s.mat.map = day ? s.dayMap : s.nightMap;
        s.mat.emissiveIntensity = day ? 0 : 1.0;
        s.mat.needsUpdate = true;
      });
      plateMat.map = day ? groundDay : groundNight;
      plateMat.needsUpdate = true;
      apronMat.color.set(day ? 0x67717d : 0x04060a);
    };
    applyModeRef.current = applyMode;

    // ---- Pilot + jetpack rig ----------------------------------------
    const player = new THREE.Group(); // origin = feet
    player.position.set(0, 0, 6);
    scene.add(player);
    const modelHolder = new THREE.Group(); // takes the flight tilt
    player.add(modelHolder);

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
    // Manual delta tracking (movementX is unreliable for touch
    // pointers on mobile Safari). One finger drags the camera; two
    // fingers on the canvas pinch-zoom, all the way out to god view.
    const pointers = new Map<number, { x: number; y: number }>();
    let dragPointer: number | null = null;
    let dragLast = { x: 0, y: 0 };
    let pinchStart: { dist: number; camDist: number } | null = null;
    const clampDist = (d: number) => THREE.MathUtils.clamp(d, MIN_CAM_DIST, MAX_CAM_DIST);
    const onPointerDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      if (pointers.size === 1) {
        dragPointer = e.pointerId;
        dragLast = { x: e.clientX, y: e.clientY };
      } else if (pointers.size === 2) {
        dragPointer = null; // two fingers = pinch, not look
        const [a, b] = [...pointers.values()];
        pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), camDist };
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
      let h = 0;
      for (const b of boxes) {
        if (b.height <= refY &&
            x >= b.minX - PLAYER_RADIUS && x <= b.maxX + PLAYER_RADIUS &&
            z >= b.minZ - PLAYER_RADIUS && z <= b.maxZ + PLAYER_RADIUS) {
          if (b.height > h) h = b.height;
        }
      }
      return h;
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
        gems: Math.max(0, collectedCount - spentGemsRef.current),
        runMs:
          runFinalMs ?? (runStartMs !== null ? performance.now() - runStartMs : null),
        bestMs,
        nearIsland: player.position.x > 250 && player.position.z > -120,
        nearMoon:
          Math.hypot(player.position.x - MOON_X, player.position.z - MOON_Z) < 60 &&
          player.position.y > MOON_TOP - 30,
        nearZip:
          Math.abs(
            Math.hypot(player.position.x - zip.x, player.position.z - zip.z) - zip.radius,
          ) < 5 && Math.abs(player.position.y - (zip.y - 5)) < 9,
        riding,
        nearSwing: player.position.distanceTo(island.swingMount) < 4.5,
        swinging,
        nearCow: false,

      });
      setNearVibey(player.position.distanceTo(vibey.position) < 8);
      setNearJerry(player.position.distanceTo(island.jerry) < 8);
      setNearSnackfe(player.position.distanceTo(island.snackfe) < 7);
      setNearShop(player.position.distanceTo(island.shop) < 7);
      setNearRoster(player.position.distanceTo(rosterBoard.position) < 7);

    }, 120);

    // Fast travel: cycle between plaza → Cardboard Island → Moon → plaza.
    // Arrive a few meters above each landing so you flutter down.
    travelRef.current = () => {
      const p = player.position;
      const onIsland = p.x > 250 && p.z > -120;
      const onMoon =
        Math.hypot(p.x - MOON_X, p.z - MOON_Z) < 60 && p.y > MOON_TOP - 20;
      if (onMoon) {
        p.set(0, 0, 6);
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
      // Spawn inside Jerry's Plaza, a few steps south of Jerry himself.
      player.position.set(ISLAND_X, ISLAND_TOP + 6, ISLAND_Z + 7);
      vel.set(0, 0, 0);
      onGround = false;
      camYaw = 0;
      camPitch = 0.18;
    };
    // /city?spawn=moon drops visitors onto the moon's landing pad.
    moonSpawnRef.current = () => {
      player.position.copy(moonWorld.spawn);
      vel.set(0, 0, 0);
      onGround = false;
    };

    // Dev hook for screenshot-driven iteration (and console fun):
    // __cityDebug.teleport(330, 130, -30) drops you over the island.
    const devWindow = window as unknown as {
      __cityDebug?: { teleport: (x: number, y: number, z: number) => void };
    };
    devWindow.__cityDebug = {
      teleport: (x, y, z) => {
        player.position.set(x, y, z);
        vel.set(0, 0, 0);
      },
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
      // on-screen joystick uses. Any controller button (trigger, grip,
      // A/B/X/Y) doubles as the jetpack — same gesture as touch.
      const xrPresenting = renderer.xr.isPresenting;
      if (xrPresenting) {
        const session = renderer.xr.getSession();
        let mx = 0, my = 0, jet = false;
        if (session) {
          for (const src of session.inputSources) {
            const gp = src.gamepad;
            if (gp) {
              const a0 = gp.axes[0] ?? 0;
              const a1 = gp.axes[1] ?? 0;
              const a2 = gp.axes[2] ?? 0;
              const a3 = gp.axes[3] ?? 0;
              const useHigh = Math.hypot(a2, a3) >= Math.hypot(a0, a1);
              const rx = useHigh ? a2 : a0;
              const ry = useHigh ? a3 : a1;
              if (Math.hypot(rx, ry) > Math.hypot(mx, my)) { mx = rx; my = ry; }
              for (const b of gp.buttons) if (b?.pressed) jet = true;
            }
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
      const thrusting = jetpackEquipped && jetInput;
      // Parkour mode: no jetpack means Space / mobile jet button becomes a jump.
      const wantsJump = !jetpackEquipped && jetInput;
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
      if (wantsJump && !prevJetInput && (onGround || coyoteTimer > 0)) {
        vel.y = 11;
        onGround = false;
        coyoteTimer = 0;
        soundsRef.current?.thud?.(0.15);
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
      const nx = THREE.MathUtils.clamp(pos.x + vel.x * dt, -CITY_HALF - 40, MOON_X + 80);
      const nz = THREE.MathUtils.clamp(pos.z + vel.z * dt, MOON_Z - 80, CITY_HALF + 40);
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
        if (!onGround && fall > 7) soundsRef.current?.thud(Math.min(1, fall / MAX_FALL));
        onGround = true;
      } else if (pos.y > support + 0.05) {
        onGround = false;
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
      const tiltTarget = !onGround ? Math.min(hSpeed / RUN_SPEED, 1) * 0.38 : 0;
      modelHolder.rotation.x += (tiltTarget - modelHolder.rotation.x) * Math.min(1, dt * 6);

      // Animation state machine.
      if (actions.size) {
        if (!onGround) playClip([/jump_idle/i, /jump/i, /fall/i, /idle/i], true);
        else if (hSpeed > 6.5) playClip([/^run/i, /run/i, /walk/i], true);
        else if (hSpeed > 0.6) playClip([/^walk/i, /walk/i, /run/i], true);
        else playClip([/^idle$/i, /idle/i], true);
      }
      mixer?.update(dt);

      // Jetpack VFX.
      flames.forEach((f) => {
        f.visible = thrusting;
        if (thrusting) {
          const s = 0.8 + Math.random() * 0.5;
          f.scale.set(s, s * (1 + Math.random() * 0.4), s);
        }
      });
      jetLight.intensity = thrusting ? 26 + Math.random() * 14 : 0;
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
      moonWorld.update(dt, now);
      
      vibey.update(dt, now);
      agentResidents.update(dt, pos);
      rosterBoard.update(dt);

      mp.update(dt, {
        x: pos.x,
        y: pos.y,
        z: pos.z,
        yaw: modelYaw,
        air: !onGround,
        char: charRef.current,
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
        // Third-person VR: park the dolly behind/above the avatar
        // along the headset's current look direction so the player
        // sees themselves walking around (much more comfortable than
        // a tiny FPS view, and matches the screen experience).
        const headDir = new THREE.Vector3();
        camera.getWorldDirection(headDir);
        headDir.y = 0;
        if (headDir.lengthSq() > 1e-6) headDir.normalize();
        else headDir.set(0, 0, -1);
        // Pulled further back + higher up so the avatar reads as a
        // small figure in the world. A bigger frame of reference is
        // much gentler on motion-sick VR viewers than a tight chase
        // cam — the periphery moves less per head turn.
        const back = 6.5;
        const up = 3.4;
        // Compensate for the headset's own offset inside the dolly so
        // the resulting camera world position is exactly back+up from
        // the avatar (not back+up + headset translation).
        const camWorld = new THREE.Vector3();
        camera.getWorldPosition(camWorld);
        const headLocal = camWorld.clone().sub(dolly.position);
        const desired = new THREE.Vector3(
          pos.x - headDir.x * back - headLocal.x,
          pos.y + up - headLocal.y,
          pos.z - headDir.z * back - headLocal.z,
        );
        // Slower lerp = the camera glides toward the target instead of
        // snapping. Higher base → smaller per-frame catch-up fraction.
        dolly.position.lerp(desired, 1 - Math.pow(0.015, dt));

        // Keep fog comfy in VR (no zoom-out gesture available).
        const fogNow = scene.fog as THREE.Fog;
        fogNow.near = baseFogNear;
        fogNow.far = baseFogFar;
      } else {
        // Chase camera.
        const eye = new THREE.Vector3(
          pos.x + Math.sin(camYaw) * Math.cos(camPitch) * camDist,
          pos.y + Math.sin(camPitch) * camDist + 1.4,
          pos.z + Math.cos(camYaw) * Math.cos(camPitch) * camDist,
        );
        // Keep the camera out of the street floor.
        eye.y = Math.max(eye.y, supportHeightAt(eye.x, eye.z, pos.y + 2) + 0.6);
        camera.position.lerp(eye, 1 - Math.pow(0.0008, dt));
        camera.lookAt(pos.x, pos.y + 1.5, pos.z);

        // Zoomed way out, the fog backs off so the diorama stays visible.
        const fogNow = scene.fog as THREE.Fog;
        fogNow.near = Math.max(baseFogNear, camDist * 1.2);
        fogNow.far = Math.max(baseFogFar, camDist * 3 + 250);
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
      travelRef.current = null;
      resetRunRef.current = null;
      vibeyExciteRef.current = null;
      mp.dispose();
      mpRef.current = null;
      agentResidents.dispose();
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
      zipGrabRef.current = null;
      swingGrabRef.current = null;
      mooRef.current = null;
      islandSpawnRef.current = null;
      moonSpawnRef.current = null;
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
    if (spawn === "island" || spawn === "moon") {
      if (spawn === "moon") moonSpawnRef.current?.();
      else islandSpawnRef.current?.();
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
    "Jerry's Plaza on Edge Island, which the kids at the Edge Esmeralda creative " +
    "residency built. You are slow, kind, a little philosophical, and very proud of " +
    "the kids. Stay fully in character as Jerry the snail.) ";
  const sendToNpc = async (target: "vibey" | "jerry", text: string) => {
    setNpcLogs((l) => ({ ...l, [target]: [...l[target], { who: "you" as const, text }] }));
    setVibeyThinking(true);
    try {
      const { data, error } = await supabase.functions.invoke("unit7-chat", {
        body: {
          history: npcHistoryRef.current[target].slice(-12),
          text: target === "jerry" ? JERRY_PREFIX + text : text,
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
          : "My uplink is fuzzy out here — try me again in a moment.";
      setNpcLogs((l) => ({
        ...l,
        [target]: [...l[target], { who: "npc" as const, text: fallback }],
      }));
    } finally {
      setVibeyThinking(false);
    }
  };

  const enter = () => {
    enteredRef.current = true;
    setEntered(true);
    // AudioContext needs a user gesture — this click is it.
    if (!soundsRef.current) soundsRef.current = createCitySounds();
    soundsRef.current?.setMuted(muted);
  };

  return (
    <div className="relative w-full h-[100dvh] bg-black overflow-hidden text-foreground">
      <canvas ref={canvasRef} className="w-full h-full block touch-none" />

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
                travelRef.current?.();
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-3.5 py-2 text-xs hover:bg-muted/50 transition-colors"
              title="Fast travel"
            >
              {hud.nearMoon ? "🏙️ Plaza" : hud.nearIsland ? "🌙 Moon" : "🏝️ Island"}
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

      {/* Vibe Shop dialog — hats + jet boost cosmetics. Free during
          early access; vibe coin prices are shown for the future. */}
      {entered && shopOpen && (
        <div
          className="fixed inset-0 z-40 flex items-end sm:items-center justify-center p-3 sm:p-6 bg-background/70 backdrop-blur-sm"
          onClick={() => setShopOpen(false)}
        >
          <div
            className="glass-panel rounded-2xl w-full max-w-md p-4 space-y-3 max-h-[90dvh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="font-heading font-bold text-base tracking-wide text-primary">
                  🛍️ VIBE SHOP
                </div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  Early access · everything free
                </div>
              </div>
              <button
                onClick={() => setShopOpen(false)}
                className="text-muted-foreground hover:text-foreground text-lg leading-none px-2"
                aria-label="Close shop"
              >
                ✕
              </button>
            </div>

            <div>
              <div className="text-[11px] font-heading font-semibold tracking-wider text-foreground/80 mb-1.5">
                HATS
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
                      className={`rounded-xl p-2 flex flex-col items-center gap-1 transition-all ${
                        eq
                          ? "bg-primary/25 ring-1 ring-primary text-primary"
                          : "bg-muted/30 hover:bg-muted/60 text-foreground/80"
                      }`}
                    >
                      <span className="text-2xl">{h.emoji}</span>
                      <span className="text-[10px] text-center leading-tight">{h.name}</span>
                      <span className="text-[9px] text-muted-foreground">
                        {h.price === 0 ? "free" : `${h.price} 🪙`}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="text-[11px] font-heading font-semibold tracking-wider text-foreground/80 mb-1.5">
                JET BOOSTS
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
                      className={`rounded-xl p-2 flex flex-col items-center gap-1 transition-all ${
                        eq
                          ? "bg-primary/25 ring-1 ring-primary text-primary"
                          : "bg-muted/30 hover:bg-muted/60 text-foreground/80"
                      }`}
                    >
                      <span className="text-xl">{f.emoji}</span>
                      <span
                        className="w-6 h-1.5 rounded-full"
                        style={{ background: f.color, boxShadow: `0 0 10px ${f.color}` }}
                      />
                      <span className="text-[10px] text-center leading-tight">{f.name}</span>
                      <span className="text-[9px] text-muted-foreground">
                        {f.price === 0 ? "free" : `${f.price} 🪙`}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="text-[11px] font-heading font-semibold tracking-wider text-foreground/80 mb-1.5">
                JET PACKS
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
                      }}
                      className={`rounded-xl p-2 flex flex-col items-center gap-1 transition-all ${
                        eq
                          ? "bg-primary/25 ring-1 ring-primary text-primary"
                          : "bg-muted/30 hover:bg-muted/60 text-foreground/80"
                      }`}
                    >
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
                      <span className="text-[9px] text-muted-foreground">
                        {j.price === 0 ? (returned ? "return" : "free") : `${j.price} 🪙`}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>



            <div className="text-[10px] text-muted-foreground text-center pt-1">
              Hold Space to test your new boost · the look saves across visits.
            </div>
          </div>
        </div>
      )}

      {/* Touch controls for phones: joystick + jetpack button. */}
      {entered && isTouch && <TouchControls moveRef={touchMoveRef} jetRef={touchJetRef} />}

      {/* Bottom-center action stack: context buttons appear as you
          approach things — the zipline, a cow, Jerry, Vibey. */}
      {entered && npcTarget === null && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-2">
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
          {nearJerry && (
            <button
              onClick={(e) => {
                setNpcTarget("jerry");
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-primary animate-pulse"
            >
              🐌 Talk to Jerry
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
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${
                        a.status === "offline" ? "bg-muted-foreground" : "bg-primary"
                      }`}
                    />
                    <span className="truncate text-foreground">{a.name}</span>
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
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 glass-panel rounded-2xl p-4 w-[min(92vw,24rem)] flex flex-col gap-3 animate-fade-in">
          <div className="flex items-center justify-between">
            <span className="font-heading font-semibold tracking-wider text-primary text-xs">
              SNACKFE · open late
            </span>
            <button
              onClick={() => setSnackOpen(false)}
              className="text-muted-foreground hover:text-foreground px-1"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-foreground/5 px-3 py-2">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">your gems</span>
            <span className="text-base font-heading font-semibold text-amber-300">
              ✦ {hud.gems}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-1.5">
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
                    spentGemsRef.current += item.cost;
                    setPurchases((p) => ({ ...p, [item.name]: (p[item.name] ?? 0) + 1 }));
                    setSnackMsg(`${item.emoji} ${item.msg}`);
                  }}
                  className={`flex items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                    canAfford
                      ? "bg-foreground/5 hover:bg-primary/15"
                      : "bg-foreground/5 opacity-40 cursor-not-allowed"
                  }`}
                >
                  <span className="text-xl">{item.emoji}</span>
                  <span className="flex-1 text-foreground/90">
                    {item.name}
                    {owned > 0 && (
                      <span className="ml-2 text-[10px] text-muted-foreground">×{owned}</span>
                    )}
                  </span>
                  <span className="text-xs font-mono text-amber-300">✦ {item.cost}</span>
                </button>
              );
            })}
          </div>
          {snackMsg && (
            <div className="text-xs text-primary bg-primary/10 rounded-lg px-3 py-2 animate-fade-in">
              {snackMsg}
            </div>
          )}
          {hud.gems === 0 && (
            <div className="text-[10px] text-muted-foreground text-center">
              collect ✦ gems around Edge Island and the city to spend here
            </div>
          )}
        </div>
      )}
      {npcTarget !== null && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 glass-panel rounded-2xl p-3 w-[min(92vw,26rem)] flex flex-col gap-2">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-heading font-semibold tracking-wider text-primary">
              {npcTarget === "jerry" ? "JERRY · snail of Jerry's Plaza" : "VIBEY · community agent"}
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
                  : "Vibey hovers a little closer, waiting for you to say something."}
              </div>
            )}
            {npcLogs[npcTarget].map((m, i) => (
              <div key={i}>
                <span className={m.who === "npc" ? "text-primary" : "text-amber-300"}>
                  {m.who === "npc" ? (npcTarget === "jerry" ? "Jerry" : "Vibey") : playerName}
                </span>{" "}
                <span className="text-foreground/90">{m.text}</span>
              </div>
            ))}
            {vibeyThinking && (
              <div className="text-muted-foreground animate-pulse">
                {npcTarget === "jerry" ? "Jerry is thinking… slowly…" : "Vibey is thinking…"}
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
              placeholder={npcTarget === "jerry" ? "say something to Jerry" : "say something to Vibey"}
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

      {/* Entry overlay. */}
      <AnimatePresence>
        {!entered && (
          <motion.div
            className="absolute inset-0 z-20 flex items-center justify-center bg-background/70 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.5 } }}
          >
            <motion.div
              className="glass-panel rounded-3xl px-8 py-7 max-w-md mx-4 text-center space-y-4"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="text-3xl">🏙️</div>
              <h1 className="font-heading text-2xl font-bold tracking-wide text-primary">
                VIBE CITY
              </h1>
              <p className="text-sm text-muted-foreground leading-relaxed">
                A neon district to explore. Hold{" "}
                <span className="text-primary font-semibold">Space</span> to fire the jetpack, land
                on rooftops, and collect every{" "}
                <span className="text-amber-300 font-semibold">✦ star</span>. Then follow the
                golden beam east — the kids built{" "}
                <span className="text-primary font-semibold">Edge Island</span> up in the sky.
              </p>
              <div className="text-[11px] text-muted-foreground font-mono">
                WASD / arrows — move · Shift — run · Space — jetpack
                <br />
                drag — look around · pinch / scroll — zoom
              </div>
              <button
                onClick={enter}
                className="px-6 py-2.5 rounded-full bg-primary text-primary-foreground font-heading font-semibold text-sm tracking-wider uppercase hover:opacity-90 transition-opacity"
              >
                Jet in
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
