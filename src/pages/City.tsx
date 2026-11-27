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
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { useUnseenCount } from "@/whatsnew";
import { Link, useLocation } from "react-router-dom";
import * as THREE from "three";
import { releaseRenderer } from "@/lib/quality";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { Rocket } from "lucide-react";
import { enableVR } from "@/lib/webxr";
import { buildCardboardIsland, signTexture, VIBEVERSE_POSTER_URL, SNACK_MENU } from "@/components/city/cardboardIsland";
import { SITE, SPAWN } from "@/components/city/islandPlan";
import VibeAccountCard from "@/components/VibeAccountCard";
import VibeArc from "@/components/VibeArc";
const iridescentArcUrl = "/models/iridescent-arc.glb";
import { buildMoon } from "@/components/city/moon";
import { buildMars } from "@/components/city/mars";
import { buildTradersGalaxy } from "@/components/city/tradersGalaxy";
import { buildSkyIslands } from "@/components/city/skyIslands";
import { buildPegasus, type PegasusWorld } from "@/components/city/pegasus";
import { createRiderPose } from "@/components/city/riderPose";
import { buildHelicopter } from "@/components/city/helicopter";
import { stepMount, MOUNT_SEAT, type MountKind, type FlightState } from "@/components/city/mountFlight";
import { Button } from "@/components/ui/button";
import { buildSkyGames, type SkyGamesWorld, type SkyGameKey } from "@/components/city/skyGames";
import { buildKart } from "@/components/city/karts";
import { buildNinjaPalaceShow, NINJA_CAST } from "@/components/city/ninjaPalace";
import { buildSkiWorld } from "@/components/city/skiWorld";
import { buildMoonGolf } from "@/components/city/moonGolf";
import { buildCloudKingdom } from "@/components/city/cloudKingdom";
import { buildRebelDefense } from "@/components/city/rebelDefense";
import { buildHeistChase } from "@/components/city/heistChase";
import { buildRoadmapBoard } from "@/components/city/roadmapBoard";
import { buildWishGarden } from "@/components/city/wishGarden";
import { makeBoombox } from "@/components/city/boombox";
import {
  GRAVITY,
  WALK_SPEED,
  RUN_SPEED,
  FLY_SPEED,
  FLY_RUN_SPEED,
  SWIM_SPEED,
  SWIM_SPRINT,
  JUMP_VELOCITY,
  MAX_RISE,
  MAX_FALL,
  PLAYER_RADIUS,
} from "@/lib/worldPhysics";
import { CollisionWorld } from "@/city/player/collision";
import { buildDistrict } from "@/city/district";
import { buildLandmarks, LANDMARK_RESERVE, type Landmarks } from "@/city/landmarks";
import { LandmarkHud } from "@/city/landmarks/LandmarkHud";
import { buildThanksgiving, thanksgivingOn, saveThanksgiving, TURKEY_REST } from "@/city/thanksgiving";
import { buildTurkey } from "@/city/turkey";
import {
  buildOcean,
  beachHeightAt,
  seaSurfaceAt,
  waterDepthAt,
  OCEAN_DAY,
  OCEAN_NIGHT,
} from "@/city/ocean";
import { buildSplash, evalSwim, strokeRate, PRONE_PITCH } from "@/city/swim";
import { createSnowCover } from "@/city/snowCover";
import { createUnderwater } from "@/city/underwater";
import { createCarSink } from "@/city/carSink";
import { createCrashFx } from "@/city/crashFx";
import { createMayhem, GUNS, type GunKind, type Mayhem, type MayhemHud } from "@/city/mayhem";

/** The weapon bar's order, and what the 1 to 5 keys count along. */
const GUN_SLOTS: readonly GunKind[] = ["glock", "water", "paint", "blaster", "rifle"];
import { buildHideouts } from "@/city/hideouts";
import { buildArcade, ARCADE_RESERVE, type ArcadeStation } from "@/city/arcade";
import { ArcadeCabinet, type CabinetGame } from "@/components/city/ArcadeCabinet";
import { buildKartRace, type RaceUi } from "@/city/kartRace";
import { KartRaceHud } from "@/components/city/KartRaceHud";
import { createBodyguards, squadEnabled, type Bodyguards } from "@/city/bodyguards";
import { SquadPanel } from "@/components/city/SquadPanel";
import {
  VEHICLES, MAX_HEALTH, impactDamage, distress, cometSpot,
  buildMonsterTruck, buildComet, buildMower, buildBeacon, scorch,
  type VehicleKind, type ImpactSurface,
} from "@/city/vehicles";
import { createWrecks } from "@/city/wrecks";
import { createTrench } from "@/city/trench";
import { createHeadMount } from "@/city/headMount";
import { createBackMount } from "@/city/backMount";
import { VibeEconomy } from "@/lib/vibeEconomy";

import { createAgentResidents, type AgentResidents } from "@/components/city/agentResidents";
import { createDanceFloor } from "@/components/city/danceFloor";
import { createClub } from "@/components/city/club";
import { createTagGame, type TagGame } from "@/components/city/tagGame";
import { TagHud } from "@/components/city/TagHud";
import { createAgentRosterBoard, type RosterAgent } from "@/components/city/agentRosterBoard";
import { createVibeyNpc } from "@/components/city/vibeyNpc";

import TouchControls, { type TouchMove } from "@/components/city/TouchControls";
import {
  createMultiplayer,
  pickHubSpawn,
  EMOTE_EMOJI,
  makeChatBubbleSprite,
  CHAT_BUBBLE_DURATION,
  type ChatMessage,
  type EmoteName,
  type Multiplayer,
  type RebelEvent,
} from "@/components/city/multiplayer";
import { createCitySounds, type CitySounds } from "@/lib/citySounds";
import { createCityMusic, musicLayerCount, nextLayerAt, type CityMusic } from "@/lib/cityMusic";
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
import { useWardrobe } from "@/hooks/use-wardrobe";
import VibeMakerPanel from "@/components/VibeMakerPanel";
import NameEntryModal from "@/components/city/NameEntryModal";
import { ArcadeModal } from "@/components/city/ArcadeModal";
import ItemShelves from "@/components/shop/ItemShelves";
import CharacterShelf from "@/components/shop/CharacterShelf";
import { ownedWeapons } from "@/lib/weaponCatalog";
import { getWardrobeState } from "@/lib/wardrobe";
import { useVibecoin } from "@/hooks/use-vibecoin";
import { formatVibecoin } from "@/lib/vibecoin";
import RockPaperScissors, { RpsDevHook } from "@/components/city/RockPaperScissors";
import { PhotoGalleryModal } from "@/components/city/PhotoGalleryModal";
import CharacterDashboardModal from "@/components/city/CharacterDashboardModal";
import { STICKER_ART, STICKER_SLOTS, placeSticker, sanitizeStickers, type Sticker } from "@/components/city/stickers";
import { applyStickers } from "@/components/city/stickerMesh";
import CityEntryScreen, { generateFunName } from "@/components/city/CityEntryScreen";
import { generateCharacterName } from "@/lib/character-naming";
import { CHARACTERS as UNIVERSAL_CHARACTERS } from "@/lib/characters";
import { buildProceduralPilot, type ProceduralPilot } from "@/components/city/proceduralPilot";
import {
  DANCES,
  applyDancePose,
  evalDanceGrooved,
  makeGroove,
  bindGltfDanceSkeleton,
  createDancePose,
  evalDance,
  findDance,
  randomDanceId,
  releaseDanceSkeleton,
  stepDanceWeight,
  type DanceSkeleton,
} from "@/components/city/dances";
// EchoVoiceAgent now lives inside PersonChatPanel as a subtle mic button
import PersonChatPanel, { type PersonTarget } from "@/components/PersonChatPanel";
import RpsDuelModal from "@/components/RpsDuelModal";
import { createGraffitiWall } from "@/components/city/graffitiWall";
import { createNewsstand } from "@/components/city/newsstand";
import { createStudioEmbassy } from "@/components/city/studioEmbassy";
import { createWorldEventFeed, tickerLine } from "@/components/city/worldEventFeed";
import { createWishConstruction } from "@/components/city/wishConstruction";
import { createWeather, WEATHERS, type WeatherKind, type WeatherSystem } from "@/components/city/weather";
import { createLiveDirector } from "@/components/city/liveDirector";
import {
  createSpawnMesh,
  updateSpawns,
  type IslandSpawnRow,
} from "@/components/city/islandSpawns";
import { buildUnderground, makeNinjaPortal, type UndergroundWorld } from "@/components/city/underground";
import { registerPOI } from "@/world/worldIndex";
import { IOS_APP } from "@/lib/iosApp";
import { isBlocked, noteSafetyContent, openSafety, subscribeSafety } from "@/safety/safety";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import { createWizard, type WizardController } from "@/wizard/controller";
import { createWizardNpc } from "@/wizard/npc";
import WizardHud from "@/wizard/WizardHud";
import { createCitySky, isDayLook, lookFor, parseLook, SKY_LOOKS, type SkyLook } from "@/city/sky";
import { buildNeon } from "@/city/neon";
import { createWetStreets } from "@/city/wet";
import { createBirds } from "@/city/birds";
import { buildBay } from "@/city/bay";
import { createFolk, type Folk } from "@/city/folk";
import type { FolkDef } from "@/city/folk/cast";
import FolkChat from "@/city/folk/FolkChat";

/* Lazy: almost nobody opens the changelog mid-game, so it is not in the world's chunk. */
const WhatsNewSheet = lazy(() => import("@/whatsnew/WhatsNewSheet"));

// Universal playable character catalog. Keep City/Edge Island aligned
// with /character-select, /profile, and the global active-character hook.
// Entries with an empty `url` (Flux) have no model file and are built in
// code — every load path here handles that case.
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
/**
 * What sits in each `kartStates` slot, in order. Module-level so the HUD can
 * name the vehicle you are standing next to without reaching into the effect.
 * The last slot is the standing one for a commandeered city car.
 */
const VEHICLE_SLOTS: VehicleKind[] = ["kart", "kart", "monster", "comet", "mower", "car"];
const GRID = 9; // city is GRID x GRID cells
const BLOCK = 28; // buildable block size (m)
const STREET = 12; // street width between blocks (m)
const PITCH = BLOCK + STREET; // cell-to-cell distance
const CITY_HALF = (GRID * PITCH) / 2;
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
/* THE BASEMENT — a room three hundred metres under the sea floor, south-west
   of everything. Same address book as the Gremlin Mines at (620, -300, 480),
   and deliberately so: the city's world is a 360m square of streets ringed by
   ocean, so "somewhere quiet at ground level" does not exist — the first
   version of this put the club on open water and players spawned swimming
   inside a black box. Down here nothing else is within seven hundred metres,
   the swim solver stops looking below -40, and the transcendence portal's
   fell-out-of-the-world net is told to skip it, exactly as it is for the
   mines. */
const CLUB_X = -420;
const CLUB_Z = 420;
const CLUB_Y = -300;

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

// Gremlin Mines — a pocket dimension deep below the open ocean, well
// away from every walkable world (but inside the world-edge clamp in
// the physics tick). You only ever reach it through a ninja portal
// (Edge Island + City). It used to sit at (0,-300,0) — directly under
// the plaza — and its floor's collision box shadowed the city street,
// which made walkers sink straight through downtown. Never put world
// geometry under the city again.
const UNDER_X = 620;
const UNDER_Y = -300;
const UNDER_Z = 480;
// A mines run gives you three hearts. Take three hits and the gremlins
// throw you out — you keep the coins you banked, the cavern resets.
const MINES_HEARTS = 3;
// Coins: one per gold nugget, one per gremlin stomped, and a purse for
// putting the boss down.
const MINES_STOMP_COIN = 1;
const MINES_BOSS_COIN = 25;
// Ninja portal placements: behind the plaza on Edge Island, and in
// a dim alley between two city towers.
const NINJA_PORTAL_ISLAND = { x: ISLAND_X + SITE.ninjaPortal.x, y: ISLAND_TOP, z: ISLAND_Z + SITE.ninjaPortal.z };
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
  /**
   * Launch speed (m/s) when the player lands on this box's top. Only
   * clouds set it — everything else is solid ground you can stand on.
   *
   * This used to be inferred from altitude ("anything landed on between
   * y=140 and y=260 is a cloud"), which was wrong the moment a world
   * moved into that band: the Moon (top y=175), Moon II (205) and Mars
   * (240) all sat inside it, so every step on three entire worlds
   * trampolined you back into the sky. Bounciness is a property of the
   * surface, so it lives on the surface.
   */
  bouncy?: number;
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

/**
 * `?spawn=` targets that land you somewhere specific in the city.
 *
 * Half the world list is a `/city?spawn=…` link — Vibe Island, Powder Peak, the
 * moon, Mars, TJ's, Vibestar, the mines — so this set is what "going to a
 * world" means for most of the registry, and it has to be one list. It was two:
 * the effect below knew these nine, and the entry overlay knew nothing about
 * them, so every one of those links painted the character picker for a frame
 * before the effect dismissed it. You clicked Vibe Island and got somebody
 * else's screen, then a loading screen.
 */
const DIRECT_SPAWNS = new Set([
  "island",
  "hub",
  "club",
  "moon",
  "mars",
  "tjs",
  "ski",
  "vibestar",
  "underworld",
  "mines",
]);

/** The spawn target in a query string, if it is one we land directly at. */
function directSpawn(search: string): string | null {
  const s = new URLSearchParams(search).get("spawn");
  return s && DIRECT_SPAWNS.has(s) ? s : null;
}

export default function City() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/city", "Vibe City");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  // ?fresh=1 means the visitor was just auto-rolled into Edge Island
  // from the hub — skip the entry overlay and show a floating chip so
  // they can re-roll or open the full picker without ever seeing the
  // sign-in / character grid first.
  const isFreshDrop =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("fresh") === "1";
  // /live — spectator broadcast mode: no entry overlay, no HUD, an
  // invisible camera anchor, and the AI director runs the show.
  const isLive = typeof window !== "undefined" && window.location.pathname === "/live";
  /* Arriving at a named destination is itself a choice about where to be, so
     the overlay asking where to be is skipped — and skipped from the *first*
     render rather than by an effect, which is the difference between not
     showing it and showing it briefly. */
  const isDirectSpawn =
    typeof window !== "undefined" && !!directSpawn(window.location.search);
  const [entered, setEntered] = useState(isFreshDrop || isLive || isDirectSpawn);
  /**
   * In the water, for the UI only.
   *
   * Set from the swim transitions in the frame loop — which fire exactly once
   * each way — rather than polled every frame, because this drives a React
   * render and swimming is a state you can be in for minutes at a time.
   */
  const [inWater, setInWater] = useState(false);
  const enteredRef = useRef(isFreshDrop || isLive || isDirectSpawn);
  const [showFreshChip, setShowFreshChip] = useState(isFreshDrop);
  const [liveLines, setLiveLines] = useState<string[]>([]);
  const [liveShot, setLiveShot] = useState("");

  // Fresh visitors picked an adventure with Vibey on /start — greet
  // them with a pointer that matches it, once the arrival cinematic
  // has had its moment.
  useEffect(() => {
    if (!isFreshDrop) return;
    let adv: string | null = null;
    try { adv = localStorage.getItem("vibe.adventure"); } catch { /* ignore */ }
    if (!adv) return;
    const tips: Record<string, [string, string]> = {
      explore: ["🌍 Explorer mode", "The zeppelin overhead is boardable, Powder Peak is through the east arch, and the moon takes wishes for golf."],
      build: ["🔨 Builder mode", "Find the God Orb in the sky and whisper a wish — real features get built from them. The Maker Portal spawns objects too."],
      create: ["🌱 Creator mode", "The Character Studio (west lawn) swaps your look, and the Vibe Maker portal turns prompts into objects."],
      connect: ["👥 Connect mode", "The plaza chat is live, THE PALACE ninjas love visitors, and VIBE FM by SnackFe sets the mood."],
    };
    const tip = tips[adv];
    if (!tip) return;
    const t = window.setTimeout(() => toast(tip[0], { description: tip[1] }), 9000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
    /** Standing on the bad guys' hideout pad. */
    badPad: false,
    /** Next to a bad guy's car, close enough to hop on the roof. */
    nearBad: false,
    /** On a bad guy's roof right now. */
    ridingBad: false,
    /** Next to the warehouse's red ride-along button. */
    nearRideButton: false,
    /** In a bad guy's back seat, shooting out of the rear window. */
    gunner: false,
  });
  /** E on the hideout pad, F next to a bad guy: what the buttons do. */
  const badSummonRef = useRef<(() => void) | null>(null);
  const badRideRef = useRef<(() => void) | null>(null);
  /** The red button in the warehouse: straight into a bad guy's back seat. */
  const rideButtonRef = useRef<(() => void) | null>(null);
  // Persistent ✦ Vibecoin balance — source of truth. Loaded from
  // `users.vibecoin_balance` for signed-in users, or localStorage for guests.
  // Incremented when collecting coins, decremented at the shop, debounced-synced.
  const vibeBalanceRef = useRef(0);
  const [vibeBalanceTick, setVibeBalanceTick] = useState(0); // forces re-render
  const persistVibeTimerRef = useRef<number | null>(null);
  const persistVibeBalanceRef = useRef<(() => void) | null>(null);
  const [purchases, setPurchases] = useState<Record<string, number>>({});
  // Repaints the SnackFe kiosk menu board (set once the island is built).
  const islandSnackRef = useRef<
    ((gems: number, owned: Record<string, number>, justBought?: string | null) => void) | null
  >(null);
  const travelRef = useRef<(() => void) | null>(null);
  const resetRunRef = useRef<(() => void) | null>(null);
  const islandSpawnRef = useRef<(() => void) | null>(null);
  const hubSpawnRef = useRef<(() => void) | null>(null);
  const moonSpawnRef = useRef<(() => void) | null>(null);
  const clubSpawnRef = useRef<(() => void) | null>(null);
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
  // Keep the SnackFe kiosk board in sync with gems + what you've bought.
  useEffect(() => {
    islandSnackRef.current?.(hud.gems, purchases);
  }, [hud.gems, purchases]);
  // Buy a snack straight from the order rail (reuses the exact economy
  // path the old popup used, so balances/persistence are unchanged).
  const buySnack = (item: (typeof SNACK_MENU)[number]) => {
    if (vibeBalanceRef.current < item.cost) return;
    vibeBalanceRef.current -= item.cost;
    setVibeBalanceTick((n) => n + 1);
    persistVibeBalanceRef.current?.();
    const nextOwned = { ...purchases, [item.name]: (purchases[item.name] ?? 0) + 1 };
    setPurchases(nextOwned);
    setSnackMsg(`${item.emoji} ${item.msg}`);
    islandSnackRef.current?.(Math.max(0, Math.round(vibeBalanceRef.current)), nextOwned, item.name);
  };
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
  // Zeppelin helm: "aboard" once you're standing on the deck, "piloting"
  // once you take the wheel. The ref is what the render loop reads.
  const [zepMode, setZepMode] = useState<"off" | "aboard" | "piloting">("off");
  const [mountKind, setMountKind] = useState<MountKind | null>(null);
  const activeMountRef = useRef<MountKind | null>(null);
  const mountActionRef = useRef<((kind: MountKind | null) => void) | null>(null);
  /**
   * The mount you are standing next to (or on), if any. Riding one works like
   * getting into a car: walk up, press F or tap the one prompt. It used to be
   * a pair of "Ride" buttons shown anywhere within 100 m of the island, which
   * on a phone sat on top of the joystick.
   */
  const [nearMount, setNearMount] = useState<MountKind | null>(null);
  const [skyTagOn, setSkyTagOn] = useState(false);
  const skyTagRef = useRef(false);
  const diveMountRef = useRef(false);
  const [skyStatus, setSkyStatus] = useState("Waiting for another rider");
  const zepPilotRef = useRef(false);
  const zepHelmRef = useRef<((on: boolean) => void) | null>(null);
  // Gremlin Mines (underground) — world handle + per-tick state.
  const undergroundWorldRef = useRef<UndergroundWorld | null>(null);
  const undergroundActiveRef = useRef(false);
  const undergroundInvulnRef = useRef(0);
  // Hearts live in a ref because the render loop reads them every frame;
  // the state above is only the HUD's copy.
  const minesHeartsRef = useRef(MINES_HEARTS);
  // Edge-detects the boss's charge tell so the warning banner and its
  // sound fire once per charge, not once per frame.
  const bossWarnRef = useRef(false);
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
  /** The on-screen fire button, held. */
  const touchFireRef = useRef(false);
  /** GTA Junior: stars, cops and the gun in your hand. */
  const [squad, setSquad] = useState<Bodyguards | null>(null);
  const [mayhemHud, setMayhemHud] = useState<MayhemHud>({
    stars: 0, forgiveIn: null, cops: 0, gun: null, owned: [], bads: 0, bombs: null, atStall: false,
  });
  const mayhemCycleRef = useRef<(() => void) | null>(null);
  /** What the number keys see: the guns you own and the one in hand. */
  const mayhemSlotsRef = useRef<{ owned: GunKind[]; gun: GunKind | null }>({ owned: [], gun: null });
  const mayhemRef = useRef<Mayhem | null>(null);
  const touchThrowRef = useRef(false);
  /** Opened from the Vibe Arms stall in town: the shop opens on its weapons. */
  const [shopWeaponsFirst, setShopWeaponsFirst] = useState(false);
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
  // Tag mini-game: walk into another real player to score a tag; streak
  // decays if you loiter. Instantiated lazily so it survives HMR.
  const tagGameRef = useRef<TagGame | null>(null);
  if (!tagGameRef.current) tagGameRef.current = createTagGame();
  const playLocalEmoteRef = useRef<((emote: EmoteName) => void) | null>(null);
  /** Start / change / stop the body dance. Owned by the canvas effect. */
  const setDanceRef = useRef<((id: string | null) => void) | null>(null);
  /** Mirrored into React only so the HUD can name what you're doing. */
  const [activeDance, setActiveDance] = useState<string | null>(null);
  const playLocalChatRef = useRef<((text: string) => void) | null>(null);
  const [emoteWheelOpen, setEmoteWheelOpen] = useState(false);
  // Nearby person (player or agent) for bump/message HUD buttons.
  const [nearPerson, setNearPerson] = useState<PersonTarget | null>(null);
  const nearPersonRef = useRef<PersonTarget | null>(null);
  useEffect(() => { nearPersonRef.current = nearPerson; }, [nearPerson]);
  const [chatTarget, setChatTarget] = useState<PersonTarget | null>(null);
  const [duelTarget, setDuelTarget] = useState<PersonTarget | null>(null);
  const [nearGraffiti, setNearGraffiti] = useState(false);
  const [nearNews, setNearNews] = useState(false);
  const [nearStudio, setNearStudio] = useState(false);
  const [graffitiText, setGraffitiText] = useState("");
  const [graffitiSending, setGraffitiSending] = useState(false);
  const graffitiWallRef = useRef<{ refresh: () => void } | null>(null);
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
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const whatsNewUnseen = useUnseenCount();
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
        .filter((m) => m.body && m.kind !== "system" && !isBlocked(m.speaker ?? undefined))
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
          if (isBlocked(row.speaker)) return;
          noteSafetyContent("city", { name: row.speaker || "agent", text: row.body });
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

  // A block takes the blocked player's lines out of the terminal at once
  // (new ones are already dropped where they arrive).
  useEffect(
    () =>
      subscribeSafety(() =>
        setChatMessages((prev) => {
          const kept = prev.filter((m) => m.self || !isBlocked(m.name, m.fromId));
          return kept.length === prev.length ? prev : kept;
        }),
      ),
    [],
  );


  // Talkable NPCs (Vibey + Jerry): proximity-gated LLM conversations
  // through the unit7-chat edge function, one dialog at a time.
  const [nearVibey, setNearVibey] = useState(false);
  const [nearJerry, setNearJerry] = useState(false);
  const [nearSnackfe, setNearSnackfe] = useState(false);
  // Powder Peak travel prompts + on-snow hint chip.
  const [nearSkiGate, setNearSkiGate] = useState(false);
  const [nearSkiReturn, setNearSkiReturn] = useState(false);
  const [onPowderPeak, setOnPowderPeak] = useState(false);
  const [moonGolfHud, setMoonGolfHud] = useState<string | null>(null);
  // Rebel Defense (the Vibe Star shooter): HUD + hit flash + prompts.
  const [rebelHud, setRebelHud] = useState<{ active: boolean; wave: number; kills: number; hp: number } | null>(null);
  const [nearBlasterRack, setNearBlasterRack] = useState(false);
  const [rebelFlash, setRebelFlash] = useState(0);
  const rebelStartRef = useRef<(() => void) | null>(null);
  const rebelFireRef = useRef<(() => void) | null>(null);
  const vibeStarSpawnRef = useRef<(() => void) | null>(null);
  // Co-op: remote peers' Rebel Defense events (wave syncs + kills).
  const rebelRemoteRef = useRef<((ev: RebelEvent) => void) | null>(null);
  // THE GETAWAY — the chaseable city heist. HUD chip while it's loose.
  const [heistChaseOn, setHeistChaseOn] = useState(false);
  // The ten talkable pedestrians (src/city/folk).
  const folkRef = useRef<Folk | null>(null);
  const [folkNear, setFolkNear] = useState<FolkDef | null>(null);
  const [folkOpen, setFolkOpen] = useState<FolkDef | null>(null);
  const folkNearRef = useRef<FolkDef | null>(null);
  const folkOpenRef = useRef<FolkDef | null>(null);
  const openFolk = useCallback((d: FolkDef | null) => {
    folkOpenRef.current = d;
    setFolkOpen(d);
    folkRef.current?.engage(d?.id ?? null);
  }, []);
  // Let players dismiss the bounty chip; it comes back on the next heist.
  const [heistChipDismissed, setHeistChipDismissed] = useState(false);
  useEffect(() => {
    if (heistChaseOn) setHeistChipDismissed(false);
  }, [heistChaseOn]);
  const skiTravelRef = useRef<((to: "peak" | "island") => void) | null>(null);

  // God Orb wish portal — click the sky orb, ask the universe for
  // anything, it lands in the build queue (and Jack's Telegram).
  const [wishOpen, setWishOpen] = useState(false);
  const [wishText, setWishText] = useState("");
  const [wishSending, setWishSending] = useState(false);
  const [wishDone, setWishDone] = useState(false);
  const wishBurstRef = useRef<(() => void) | null>(null);
  // Vibe karts: which parked kart is in hop-on range, and which one
  // (if any) we're driving. The ref mirrors state for the tick loop.
  const [nearKart, setNearKart] = useState(-1);
  const [drivingKart, setDrivingKart] = useState(-1);
  /** Health of whatever you are driving, 0..100, for the meter. */
  const [driveHp, setDriveHp] = useState(MAX_HEALTH);
  const drivingKartRef = useRef(-1);
  const enterKartRef = useRef<((i: number) => void) | null>(null);
  const exitKartRef = useRef<(() => void) | null>(null);
  /**
   * The traffic car standing in hop-in range, if any.
   *
   * Separate from `nearKart` because the two parked vibe karts are fixed
   * objects with an index into `kartStates`, and a city car is a fleet member
   * identified by its own id — see `src/city/traffic.ts`. They share the
   * driving physics and the hop-out button; only the way you get in differs.
   */
  const [nearRide, setNearRide] = useState(-1);
  const enterRideRef = useRef<((id: number) => void) | null>(null);
  const [snackMsg, setSnackMsg] = useState<string | null>(null);
  // The order-rail flavor line fades on its own a few seconds after a buy.
  useEffect(() => {
    if (!snackMsg) return;
    const t = window.setTimeout(() => setSnackMsg(null), 3500);
    return () => window.clearTimeout(t);
  }, [snackMsg]);
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
  // GOD MODE — weather over the whole world. Local to you: the day/night
  // switch is lobby-wide because everyone shares one sky, but the storm
  // is yours to summon.
  const [weatherKind, setWeatherKind] = useState<WeatherKind>("clear");
  const [godPanelOpen, setGodPanelOpen] = useState(false);
  const weatherRef = useRef<WeatherSystem | null>(null);
  const setWeatherRef = useRef<((k: WeatherKind) => void) | null>(null);
  const dayModeRef = useRef(false);
  /** Which of the four skies: Day, Sunset, Night, Aurora. See src/city/sky.ts. */
  const skyLookRef = useRef<SkyLook>(parseLook(new URLSearchParams(window.location.search).get("sky")) ?? "night");
  const [skyLook, setSkyLook] = useState<SkyLook>(skyLookRef.current);
  // The weather has to re-apply itself whenever the sky changes, and the
  // sky can change from three places (the button, a peer, the DB), so the
  // current value is mirrored here rather than threaded through each one.
  useEffect(() => { dayModeRef.current = dayMode; }, [dayMode]);
  const [muted, setMuted] = useState(false);
  /** Mirror of `muted`, so audio created from a frame loop or a raw key
   *  handler starts at the right level without re-creating the callback. */
  const mutedRef = useRef(false);
  mutedRef.current = muted;
  const soundsRef = useRef<CitySounds | null>(null);
  const landmarksRef = useRef<Landmarks | null>(null);
  // The Wizard (src/wizard): wishes become things, shared live through Supabase.
  const [wizardApi, setWizardApi] = useState<WizardController | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const wizardOpenRef = useRef(false);
  wizardOpenRef.current = wizardOpen;
  const playerNameForWizard = useRef("a traveller");
  playerNameForWizard.current = playerName || "a traveller";
  /** The dance track. Created on the same gesture the sound effects are. */
  const musicRef = useRef<CityMusic | null>(null);
  /**
   * Bring the audio up, if it is not already.
   *
   * An AudioContext needs a user gesture, and the city has several front doors
   * — the entry screen's button, a VR session, and arriving from the hub with
   * `?fresh=1`, which skips the screen entirely and so never had a click to
   * hang this on. That last one meant a visitor coming from the lobby got a
   * silent city: no chimes, no thud on landing, and now no music. Every
   * gesture that can plausibly be the first one calls this instead of
   * repeating the two constructors.
   */
  const ensureAudioRef = useRef<(() => void) | null>(null);
  /** Dancers within earshot, including you — mirrored out for the HUD. */
  const [danceCrowd, setDanceCrowd] = useState(0);
  const ensureAudio = useCallback(() => {
    if (!soundsRef.current) soundsRef.current = createCitySounds();
    if (!musicRef.current) musicRef.current = createCityMusic();
    soundsRef.current?.setMuted(mutedRef.current);
    musicRef.current?.setMuted(mutedRef.current);
  }, []);
  ensureAudioRef.current = ensureAudio;
  const [charName, setCharName] = useState(initialCharacter);
  const [charPanelOpen, setCharPanelOpen] = useState(false);
  const [stickerOpen, setStickerOpen] = useState(false);
  const [stickerArt, setStickerArt] = useState<string>(STICKER_ART[0]);
  const [stickers, setStickers] = useState<Sticker[]>(() => {
    try { return sanitizeStickers(JSON.parse(localStorage.getItem("city.stickers") ?? "[]")); } catch { return []; }
  });
  const stickersRef = useRef(stickers);
  useEffect(() => {
    stickersRef.current = stickers;
    localStorage.setItem("city.stickers", JSON.stringify(stickers));
  }, [stickers]);
  const charRef = useRef(charName);
  const applyModeRef = useRef<((day: boolean) => void) | null>(null);
  // Thanksgiving dress-up: on by itself in Thanksgiving week, unless switched
  // off (per device). See src/city/thanksgiving.ts.
  const [thanksOn, setThanksOn] = useState<boolean>(() => thanksgivingOn());
  const thanksRef = useRef(thanksOn);
  const setThanksRef = useRef<((on: boolean) => void) | null>(null);
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
  const [avatarSearch, setAvatarSearch] = useState("");
  const [avatarDashOpen, setAvatarDashOpen] = useState(false);
  const [nearArcade, setNearArcade] = useState(false);
  const [nearRps, setNearRps] = useState(false);
  const [rpsOpen, setRpsOpen] = useState(false);
  const [arcadeOpen, setArcadeOpen] = useState(false);
  // The Vibe Arcade on the block east of the plaza (src/city/arcade.ts):
  // the station you are standing at, and the game open in the cabinet.
  const [arcadeStation, setArcadeStation] = useState<ArcadeStation | null>(null);
  const [cabinetGame, setCabinetGame] = useState<CabinetGame | null>(null);
  const cabinetOpenRef = useRef(false);
  const arcadeStationRef = useRef<ArcadeStation | null>(null);
  // The Vibe Kart GP (src/city/kartRace.ts): its readout, the board at the
  // kiosk, and the page's hook to start a race with a stake.
  const [raceUi, setRaceUi] = useState<RaceUi | null>(null);
  const [nearRaceKiosk, setNearRaceKiosk] = useState(false);
  const [raceLobby, setRaceLobby] = useState(false);
  const nearRaceKioskRef = useRef(false);
  const raceStartRef = useRef<((bet: number) => void) | null>(null);
  const closeCabinet = useCallback(() => {
    cabinetOpenRef.current = false;
    setCabinetGame(null);
  }, []);
  const openCabinet = useCallback((st: ArcadeStation | null) => {
    if (!st) return;
    cabinetOpenRef.current = true;
    setCabinetGame({ key: st.key, title: st.title, emoji: st.emoji, route: st.route, accent: st.accent });
  }, []);
  const [nearTv, setNearTv] = useState(false);
  // VIBE FM boomboxes — walking up shows the tune-in prompt; walking
  // away folds the deck UI (the music itself keeps playing).
  const [nearRadio, setNearRadio] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryPhotos, setGalleryPhotos] = useState<
    { url: string; title?: string | null; description?: string | null; residency?: string | null }[]
  >([]);
  // Ninja portals → Gremlin Mines (the underground game world).
  const [nearNinjaPortal, setNearNinjaPortal] = useState(false);
  const [underground, setUnderground] = useState(false);
  const [bossHp, setBossHp] = useState(3);
  // A mines run: three hearts, and a tally of what you got out with.
  // Without a fail state the fight had no stakes — a hit just shoved
  // you sideways and you walked back in.
  const [minesHearts, setMinesHearts] = useState(MINES_HEARTS);
  const [minesStomps, setMinesStomps] = useState(0);
  const [minesGold, setMinesGold] = useState(0);
  const [minesKo, setMinesKo] = useState(0);
  const [bossWarning, setBossWarning] = useState(false);
  const [orbShardWon, setOrbShardWon] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("city.orbShard") === "1";
  });
  const [showShardReward, setShowShardReward] = useState(false);
  const [enterFx, setEnterFx] = useState(0);
  // Clear the arrival flash on a timer, exactly like respawnFx and
  // transcendFx above. It used to hang its cleanup off onAnimationEnd,
  // which never fired — so the flash, and its full-screen backdrop blur,
  // stayed on top of the mines forever.
  useEffect(() => {
    if (enterFx <= 0) return;
    const timer = window.setTimeout(() => setEnterFx(0), 2000);
    return () => window.clearTimeout(timer);
  }, [enterFx]);
  useEffect(() => {
    if (minesKo <= 0) return;
    const timer = window.setTimeout(() => setMinesKo(0), 2200);
    return () => window.clearTimeout(timer);
  }, [minesKo]);
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

  // Walking away from a boombox folds the VIBE FM deck.
  useEffect(() => {
    if (!nearRadio) window.dispatchEvent(new Event("vibefm:close"));
  }, [nearRadio]);
  const [spawns, setSpawns] = useState<IslandSpawnRow[]>([]);
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const authUserIdRef = useRef<string | null>(null);
  const spawnsApiRef = useRef<{ setAll: (rows: IslandSpawnRow[]) => void } | null>(null);

  /**
   * What you own, for the in-world cosmetics picker.
   *
   * Cosmetics used to be free and this picker handed them out; now they are
   * bought with Vibecoin at /shop and recorded against the wallet, so the
   * picker has to respect that or the shop is decorative. Unowned items stay
   * visible with their price on them — seeing the crown you cannot afford is
   * the point of a shop window.
   */
  const wardrobe = useWardrobe();
  const { balance: coinBalance } = useVibecoin();
  // What you have bought at Vibe Arms (or on /shop) is what is in your hands.
  useEffect(() => {
    mayhemRef.current?.setBought(ownedWeapons(wardrobe.owned));
  }, [wardrobe.owned]);
  const ownsCosmetic = useCallback(
    (kind: "hat" | "flame" | "jetpack", id: string, price: number) =>
      price <= 0 || wardrobe.owned.includes(`${kind}:${id}`),
    [wardrobe.owned],
  );

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

  // The shop shelves equip through the wardrobe; put on whatever it says.
  useEffect(() => {
    const { hat, flame, jetpack } = wardrobe.loadout;
    setEquippedHat((cur) => {
      if (cur !== hat) applyHatRef.current?.(hat);
      return hat;
    });
    setEquippedFlame((cur) => {
      if (cur !== flame) applyFlameRef.current?.(flame);
      return flame;
    });
    setEquippedJetpack((cur) => {
      if (cur !== jetpack) {
        applyJetpackRef.current?.(jetpack);
        const def = JETPACK_CATALOG.find((j) => j.id === jetpack);
        if (def) setFallDamageEnabled(!def.equipped);
      }
      return jetpack;
    });
  }, [wardrobe.loadout.hat, wardrobe.loadout.flame, wardrobe.loadout.jetpack]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Spawns carry other players' text labels; the app shows none (1.2).
    if (IOS_APP) return;
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

    /**
     * Tone mapping. The city rendered with none at all, which is why every
     * bright thing in it — a lit window, the sun glint on the water, a neon
     * sign — hit pure white and stayed there. ACES rolls the top end off
     * instead of clipping it, so highlights keep their colour and the night
     * skyline stops looking like it was drawn with a highlighter.
     *
     * It costs about 15% of apparent brightness across the midtones, which the
     * light intensities below are raised to pay for. Do not change one without
     * the other.
     */
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    /**
     * Shadows. The single biggest reason the city did not look real from the
     * air: nothing cast one, so ninety towers appeared to hover a little above
     * their own plate. A sun shadow is what puts a building ON the ground.
     *
     * Scoped tightly on purpose — see the shadow camera set up with the
     * moonlight below. Soft PCF because the map has to cover a 360 m district
     * and hard edges at that scale look like stencils.
     */
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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
        run: () => {
          mpRef.current?.sendEmote("dance");
          setDanceRef.current?.(randomDanceId());
        },
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
    const moonlight = new THREE.DirectionalLight(0xbfd4ff, 1.3);
    /**
     * Where the sun is, and why it is low.
     *
     * It used to sit at (180, 320, −140) — 54° up, which is noon. A noon sun
     * puts every shadow directly under its own building, where you cannot see
     * it, and lights every face of every tower at almost the same angle, which
     * is why the massing read as flat even once it stopped being flat.
     *
     * 30° is late afternoon. Shadows run about 1.7× the height of what casts
     * them, so the towers lay stripes across the district and each setback
     * catches light on its own roof while shading the step below. That is the
     * whole reason for the setbacks in `district.ts`, and at noon it is
     * invisible.
     *
     * The bearing also points roughly at the moon (MOON_X/MOON_Z), so the
     * shadows agree with the light source you can actually see in the sky.
     */
    moonlight.position.set(300, 210, -170);
    scene.add(moonlight);

    /**
     * The sun's shadow camera.
     *
     * Deliberately narrow. A directional light's shadow is an orthographic
     * render of everything inside its frustum into one texture, so the frustum
     * is a resolution budget: widen it to take in Mars and the whole 2048 map
     * is spent on empty ocean, leaving the district a couple of texels per
     * metre and shadows that shimmer. So it covers the district and nothing
     * else — ±210 m, which is the 360 m grid plus a margin for the long shadows
     * a low sun throws off the tall towers.
     *
     * The far worlds (the island, the moons, Mars, TJ's) sit outside it and are
     * simply lit without shadows, which is correct rather than a compromise:
     * they are floating in the sky with nothing under them to receive one.
     *
     * `normalBias` rather than a big depth bias — the facades are single-sided
     * planes, and a depth bias large enough to stop them shadow-acneing pulls
     * the contact shadow visibly away from the wall.
     */
    moonlight.castShadow = true;
    // Half-resolution on a phone. A 2048² depth texture is 16 MB of VRAM and a
    // full extra pass over the district every frame, which is a fine trade on a
    // laptop and a bad one on a handset that is already pushing a 3× pixel
    // ratio. 1024² over 500 m is two texels per metre — soft, but a soft shadow
    // is still the thing that puts a building on the ground.
    const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 700;
    const shadowRes = smallScreen ? 1024 : 2048;
    moonlight.shadow.mapSize.set(shadowRes, shadowRes);
    // ±250, not ±180: the district is 360 m across, but a 30° sun throws an
    // 88 m tower's shadow 150 m past its own footprint, and a frustum sized to
    // the buildings clips the shadows off the far edge.
    moonlight.shadow.camera.left = -250;
    moonlight.shadow.camera.right = 250;
    moonlight.shadow.camera.top = 250;
    moonlight.shadow.camera.bottom = -250;
    moonlight.shadow.camera.near = 20;
    moonlight.shadow.camera.far = 900;
    moonlight.shadow.bias = -0.0006;
    moonlight.shadow.normalBias = 0.7;
    // Aim it at the plaza. Without a target the light points at the origin
    // anyway, but the target has to be IN the scene for three to update its
    // world matrix, and a stale target is a shadow that lags the sun.
    moonlight.target.position.set(0, 0, 0);
    scene.add(moonlight.target);
    const plazaGlow = new THREE.PointLight(0x2dd4a8, 60, 90, 1.6);
    plazaGlow.position.set(0, 10, 0);
    scene.add(plazaGlow);

    // ---- The district ----------------------------------------------
    // Buildings, roofs, streets, trees and traffic all come out of
    // `src/city/district.ts`. It used to be `generateCity()` right here: a
    // loop that extruded one box per lot and a material that painted every
    // roof a single flat colour, which is exactly what the city looked like
    // from the air. See that module's header for what replaced it and why.
    /**
     * Snow settles on whatever it is handed. Built before the district so the
     * district's materials can be patched as they are made — a material that
     * has already compiled needs a `needsUpdate` to pick the injection up, and
     * relying on that is how half a city ends up bare in a blizzard.
     */
    const snowCover = createSnowCover();
    const district = buildDistrict({
      seed: CITY_SEED,
      grid: GRID,
      block: BLOCK,
      street: STREET,
      padMinHeight: PAD_MIN_HEIGHT,
      snow: snowCover,
      lowDetail: smallScreen,
      // Landmarks, plus the warehouse (6,4) and police station (2,4) from
      // `src/city/hideouts.ts`.
      reserve: [...LANDMARK_RESERVE, { gx: 6, gz: 4, ground: "pave", trees: true }, { gx: 2, gz: 4, ground: "pave", trees: true }, ARCADE_RESERVE],
    });
    scene.add(district.group);
    // The Space Needle, the Empire State and the Eiffel Tower, on the blocks
    // `LANDMARK_RESERVE` kept empty. See src/city/landmarks/index.ts.
    const landmarks = buildLandmarks({ boxes: district.boxes, pitch: BLOCK + STREET, lowDetail: smallScreen });
    scene.add(landmarks.group);
    snowCover.patch(landmarks.snowMaterials);
    // The Vibe Gate Bridge, west over the bay to The Rock. See src/city/bay.
    const bay = buildBay({ boxes: district.boxes, lowDetail: smallScreen });
    scene.add(bay.group);
    // Neon on the shopfronts, and its streaks in the road when it rains.
    const neon = buildNeon({ footprints: district.footprints, seed: CITY_SEED, lowDetail: smallScreen });
    scene.add(neon.group);
    const wetStreets = createWetStreets({ renderer, road: district.ground.road, pave: district.ground.pave });
    // Gulls over the marina, the beach and the towers; pigeons on the plaza.
    const birds = createBirds({
      plaza: { x: 0, z: -2, y: 0.14 },
      flocks: [
        { x: -225, z: 60, y: 16, radius: 34, count: 9 },
        { x: -205, z: -70, y: 22, radius: 48, count: 6 },
        { x: 15, z: -25, y: 72, radius: 70, count: 6 },
        { x: 120, z: 150, y: 30, radius: 40, count: 4 },
      ],
      lowDetail: smallScreen,
    });
    scene.add(birds.group);
    const folk = createFolk({
      scene,
      ground: (x, z, y) => Math.max(beachHeightAt(x, z) ?? 0, supportHeightAt(x, z, y + 0.5)),
      lowDetail: smallScreen,
    });
    folkRef.current = folk;
    landmarksRef.current = landmarks;

    // ---- The Wizard ---------------------------------------------------
    // He lives on a rune circle on the open lawn north-west of the plaza,
    // in sight of spawn and clear of the lamp posts and planters on the
    // road. Wishes are drawn by `wizard.layer`, anywhere on the map.
    const wizardHome = new THREE.Vector3(ISLAND_X - 15, ISLAND_TOP, ISLAND_Z - 12);
    const wizardNpc = createWizardNpc(wizardHome, Math.atan2(15, 19));
    scene.add(wizardNpc.group);
    const wizardDir = new THREE.Vector3();
    const wizardParams = new URLSearchParams(window.location.search);
    const wizard = createWizard({
      getHere: () => {
        camera.getWorldDirection(wizardDir);
        return { x: player.position.x, y: player.position.y, z: player.position.z, yaw: Math.atan2(-wizardDir.x, -wizardDir.z) };
      },
      getName: () => playerNameForWizard.current,
      initialWorld: wizardParams.get("world") ?? undefined,
      offline: wizardParams.get("wizard") === "local",
      lowDetail: smallScreen,
    });
    scene.add(wizard.layer.group);
    wizard.onGrant((at, mine) => {
      if (mine || wizardNpc.near(at, 40)) wizardNpc.cast(at);
    });
    let wizardWasOpen = false;
    setWizardApi(wizard);
    landmarks.onEvent((ev) => {
      const snd = soundsRef.current;
      if (ev.type === "depart") snd?.chime(1);
      else {
        snd?.chime(4);
        window.setTimeout(() => soundsRef.current?.chime(2), 160);
      }
      if (ev.title) toast(ev.title, { description: ev.description });
    });
    const hideouts = buildHideouts();
    scene.add(hideouts.group);
    district.boxes.push(...hideouts.boxes);
    // The Vibe Arcade, east of the plaza on cell (5,4).
    const arcade = buildArcade({ lowDetail: smallScreen });
    scene.add(arcade.group);
    district.boxes.push(...arcade.boxes);
    // The Vibe Kart GP: gates on the streets, a kiosk on the plaza's east edge.
    const race = buildKartRace({ lowDetail: smallScreen });
    scene.add(race.group);
    // Held live by reference — every world that loads after this pushes its
    // own collision into the same array. See CollisionWorld's constructor.
    const boxes = district.boxes;
    const pads = district.pads;
    // The sea, the seabed and the beach the city sits on all come out of
    // `src/city/ocean.ts` — but it is built further down, after the sky
    // dome, because it reflects that dome's own uniforms rather than a
    // second set of colours that could drift out of step with it.

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
      lowDetail: smallScreen,
    });
    scene.add(island.group);
    // Let React drive the SnackFe kiosk board; paint the opening state.
    islandSnackRef.current = (g, o, jb) => island.setSnackMenu(g, o, jb);
    island.setSnackMenu(Math.max(0, Math.round(vibeBalanceRef.current)), {});

    // ---- VIBE FM boomboxes: the radio lives in the world now ---------
    // One on the island's hangout corner by SnackFe, one at the city
    // plaza. Walk up → tune-in prompt → the retro deck opens (and the
    // needle drops). The music follows you everywhere after that.
    const islandRadio = makeBoombox();
    islandRadio.group.position.set(ISLAND_X + SITE.radio.x, ISLAND_TOP, ISLAND_Z + SITE.radio.z);
    islandRadio.group.rotation.y = Math.atan2(-SITE.radio.x, -SITE.radio.z); // face the island plaza
    scene.add(islandRadio.group);
    const cityRadio = makeBoombox();
    cityRadio.group.position.set(-12, 0, 12);
    cityRadio.group.rotation.y = Math.atan2(12, -12); // face the plaza ring
    scene.add(cityRadio.group);

    // 🛸 MISSION CONTROL — the living roadmap billboard on Vibe
    // Island's north-west lawn, fed by a beam of golden motes falling
    // from the God Orb: wish it → it lands on the board → it gets
    // built. Renders /roadmap.json (regenerated by Claude's recurring
    // sweep) + fresh wishes straight from universe_requests.
    const roadmapBoard = buildRoadmapBoard();
    roadmapBoard.group.position.set(ISLAND_X + SITE.missionControl.x, ISLAND_TOP, ISLAND_Z + SITE.missionControl.z);
    roadmapBoard.group.rotation.y = Math.atan2(14, 18); // face the island plaza
    scene.add(roadmapBoard.group);
    {
      // The God Orb hangs at island-local (0, 42, 0) — express it in
      // board-local space so the mote beam pours from orb to panel.
      const orbWorld = new THREE.Vector3(ISLAND_X, ISLAND_TOP + 42, ISLAND_Z);
      const orbLocal = orbWorld.clone().sub(roadmapBoard.group.position);
      orbLocal.applyAxisAngle(new THREE.Vector3(0, 1, 0), -roadmapBoard.group.rotation.y);
      roadmapBoard.attachWishBeam(orbLocal);
    }
    // 🌸 WISH GARDEN — the other half of the loop, on the south-east
    // promenade lawn (plaza → SnackFe walk, directly under the orb):
    // granted wishes bloom, pending ones bud. Placement verified
    // against the aerial — the NW/NE lawns belong to the gallery signs
    // and THE PALACE set, the south axis to the roster board.
    const wishGarden = buildWishGarden();
    wishGarden.group.position.set(ISLAND_X + SITE.wishGarden.x, ISLAND_TOP, ISLAND_Z + SITE.wishGarden.z);
    wishGarden.group.rotation.y = Math.atan2(-7, -23); // sign faces the plaza
    scene.add(wishGarden.group);

    // 🏗️ Construction row — the town's south edge, where pending wishes
    // are visibly being built. Granted wishes leave the row and bloom in
    // the garden instead: the island grows outward, wish by wish.
    const wishSites = createWishConstruction();
    wishSites.group.position.set(ISLAND_X + SITE.wishSites.x, ISLAND_TOP, ISLAND_Z + SITE.wishSites.z);
    scene.add(wishSites.group);

    // One fetch feeds all three: the board's 🌠 strip (first 3), the
    // garden's plants (blooms for granted, buds for pending), and the
    // construction row (top pending wishes).
    void (supabase as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          limit: (n: number) => Promise<{ data: Array<{ text: string; author: string; status: string | null }> | null }>;
        };
      };
    })
      .from("orb_wishes_public")
      .select("text, author, status")
      .limit(24)
      .then(({ data }) => {
        if (data?.length) {
          roadmapBoard.setWishes(data.slice(0, 3));
          wishGarden.setWishes(data);
          wishSites.setWishes(data);
        }
      })
      .catch(() => { /* board shows "the orb is listening…", garden stays soil */ });
    const radioAnchors = [
      new THREE.Vector3(ISLAND_X + SITE.radio.x, ISLAND_TOP + 1, ISLAND_Z + SITE.radio.z),
      new THREE.Vector3(-12, 1, 12),
    ];

    // THE PALACE — the ninja reality show in the courtyard of Ninja's
    // Palace. Five talkable housemates, one empty throne, live drama.
    const ninjaShow = buildNinjaPalaceShow({
      centerX: ISLAND_X,
      centerZ: ISLAND_Z,
      topY: ISLAND_TOP,
    });
    scene.add(ninjaShow.group);

    // ---- POWDER PEAK: the ski world ----------------------------------
    // A heightfield mountain far out in the ocean fog — same body, same
    // physics; skiing is a movement branch on its snow. You get there
    // through the gateway arch on the island's east rim.
    const skiWorld = buildSkiWorld({ boxes });
    scene.add(skiWorld.group);
    // Gateway arch on the island's east rim.
    const SKI_GATE = new THREE.Vector3(ISLAND_X + SITE.skiGate.x, ISLAND_TOP, ISLAND_Z + SITE.skiGate.z);
    {
      const gate = new THREE.Group();
      gate.position.copy(SKI_GATE);
      gate.rotation.y = Math.atan2(-40, 8); // face the plaza
      const post = new THREE.MeshStandardMaterial({ color: "#5a4a38", roughness: 0.85 });
      for (const side of [-1, 1]) {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 4.6, 8), post);
        p.position.set(side * 2.1, 2.3, 0);
        gate.add(p);
      }
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.5, 0.5), post);
      lintel.position.y = 4.55;
      gate.add(lintel);
      const gateSign = new THREE.Mesh(
        new THREE.PlaneGeometry(4.6, 1.15),
        new THREE.MeshBasicMaterial({
          map: signTexture(["⛷ POWDER PEAK · ski world"], "#dfedfb", "#1f4f7a"),
          side: THREE.DoubleSide,
          transparent: true,
        }),
      );
      gateSign.position.y = 5.6;
      gate.add(gateSign);
      // Shimmering doorway film.
      const film = new THREE.Mesh(
        new THREE.PlaneGeometry(3.8, 4.2),
        new THREE.MeshBasicMaterial({
          color: "#bfe6ff", transparent: true, opacity: 0.28,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        }),
      );
      film.position.y = 2.2;
      gate.add(film);
      scene.add(gate);
    }
    skiTravelRef.current = (to) => {
      if (to === "peak") {
        player.position.copy(skiWorld.spawn);
        player.position.y += 2;
        toast("⛷ Welcome to Powder Peak", {
          description: "Ski down with WASD — carve, don't fight it. Jetpack works as the lift.",
        });
      } else {
        player.position.set(ISLAND_X + SPAWN.x, ISLAND_TOP + 2, ISLAND_Z + SPAWN.z);
        toast("🏝 Back on Vibe Island");
      }
      vel.set(0, 0, 0);
      onGround = false;
      soundsRef.current?.chime(7);
    };

    // ---- CLOUD BOUNCE KINGDOM ------------------------------------------
    // Trampoline clouds 130m above the island. Step on the launch pad,
    // get yeeted into the sky, bounce cloud to cloud collecting rings.
    const cloudKingdom = buildCloudKingdom({
      cx: ISLAND_X,
      cz: ISLAND_Z,
      baseY: ISLAND_TOP,
      boxes,
    });
    scene.add(cloudKingdom.group);

    // ---- MOON GOLF -----------------------------------------------------
    // Kick-golf on the lunar landing pad: run into the ball, watch it
    // arc through low gravity, sink the glowing hole in few strokes.
    const moonGolf = buildMoonGolf({ cx: MOON_X, cz: MOON_Z, topY: MOON_TOP, padHalf: 14 });
    scene.add(moonGolf.group);
    moonGolf.onKick = () => soundsRef.current?.thud?.(0.25);
    moonGolf.onOut = () => {
      toast("🌑 Into the void…", { description: "The ball drifted off the pad. +1 stroke, back to the tee." });
    };
    moonGolf.onSink = (strokes) => {
      const reward = strokes <= 3 ? 25 : strokes <= 5 ? 10 : 3;
      vibeBalanceRef.current = Math.max(0, vibeBalanceRef.current) + reward;
      setVibeBalanceTick((n) => n + 1);
      persistVibeBalanceRef.current?.();
      soundsRef.current?.fanfare?.();
      toast.success(`⛳ Holed it in ${strokes}! +${reward} ✦`, {
        description: strokes <= 3 ? "Lunar birdie. The flag salutes you." : "The moon keeps no judgments.",
      });
    };

    // ---- God Orb wish portal -----------------------------------------
    // Generous invisible hit sphere on the sky orb so taps land from
    // any distance; a spark burst plays when a wish is accepted.
    const divineHit = new THREE.Mesh(
      new THREE.SphereGeometry(8, 8, 6),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    island.divineSphere.add(divineHit);
    wishBurstRef.current = () => {
      const p = new THREE.Vector3();
      island.divineSphere.getWorldPosition(p);
      for (let i = 0; i < 18; i++) {
        const mat = new THREE.SpriteMaterial({
          color: EMBLEM_SPARK_COLORS[i % EMBLEM_SPARK_COLORS.length],
          transparent: true,
          depthWrite: false,
        });
        const sp = new THREE.Sprite(mat);
        sp.position.copy(p);
        sp.scale.setScalar(0.6);
        const a = (i / 18) * Math.PI * 2 + Math.random() * 0.4;
        emblemSparks.push({
          s: sp,
          vx: Math.cos(a) * (4 + Math.random() * 4),
          vy: 1 + Math.random() * 6,
          vz: Math.sin(a) * (4 + Math.random() * 4),
          born: performance.now(),
        });
        scene.add(sp);
      }
      soundsRef.current?.fanfare?.();
    };

    // ---- Zeppelin Heist ----------------------------------------------
    // Every few minutes a golden vibe coin materializes on the blimp's
    // deck with a sky-high beacon — visible from the whole island.
    // Chase the zeppelin down (jetpack or ride it) and grab the coin.
    const heist = (() => {
      const g = new THREE.Group();
      const coinMat = new THREE.MeshStandardMaterial({
        color: "#ffd166", emissive: "#ffb700", emissiveIntensity: 1.0,
        roughness: 0.25, metalness: 0.7,
      });
      const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.12, 24), coinMat);
      coin.rotation.x = Math.PI / 2;
      g.add(coin);
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(0.55, 0.06, 8, 24),
        new THREE.MeshStandardMaterial({
          color: "#fff3c2", emissive: "#ffd166", emissiveIntensity: 1.3, roughness: 0.3,
        }),
      );
      g.add(rim);
      const beacon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 1.6, 70, 10, 1, true),
        new THREE.MeshBasicMaterial({
          color: "#ffd166", transparent: true, opacity: 0.2,
          blending: THREE.AdditiveBlending, depthWrite: false,
          side: THREE.DoubleSide, fog: false,
        }),
      );
      beacon.position.y = 35;
      g.add(beacon);
      const light = new THREE.PointLight(0xffc84a, 10, 10, 2);
      g.add(light);
      g.visible = false;
      scene.add(g);
      return g;
    })();
    const HEIST_REWARD = 15;
    const HEIST_PERIOD_MS = 150_000; // ~2.5 minutes between coins
    let heistNextAt = performance.now() + 45_000; // first coin lands soon
    let heistActive = false;
    let heistToastShown = false;

    // ---- THE GETAWAY: the chaseable city heist -----------------------
    // A masked gremlin robs the vault and tears through the streets in
    // a stolen kart. Ram it (run, drive, or fly) to recover the loot.
    const heistChase = buildHeistChase();
    scene.add(heistChase.group);
    const CHASE_REWARD = 25;
    // A heist is a treat, not a metronome. At four minutes it read as
    // nagging — this is a quarter-hour apart, and the timer only runs
    // while you are actually in the city (see the tick below).
    const CHASE_PERIOD_MS = 900_000;
    let chaseNextAt = performance.now() + 240_000;
    let chaseAnnounced = false;

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

    // THE VIBE STAR: the grey battle-station moon hosts Rebel Defense —
    // grab the blaster, hold the pad against waves of doom troopers.
    const rebel = buildRebelDefense({
      cx: MOON2_X,
      cz: MOON2_Z,
      topY: MOON2_TOP,
      padHalf: 14,
      boxes,
    });
    scene.add(rebel.group);
    rebel.onKill = (_kills, id) => {
      vibeBalanceRef.current = Math.max(0, vibeBalanceRef.current) + 2;
      setVibeBalanceTick((n) => n + 1);
      persistVibeBalanceRef.current?.();
      soundsRef.current?.chime(6);
      // Co-op: mirror this kill on every peer fighting the same wave.
      mpRef.current?.sendRebel({ t: "kill", killId: id });
    };
    // Every wave spawn broadcasts {seed, wave} so anyone near the Vibe
    // Star can adopt the same deterministic fight (late join included).
    rebel.onSpawnWave = (w, seed) => {
      mpRef.current?.sendRebel({ t: "sync", seed, wave: w });
    };
    let rebelHintMutedUntil = 0;
    rebelRemoteRef.current = (ev) => {
      if (ev.t === "kill" && typeof ev.killId === "number") {
        rebel.killById(ev.killId);
        return;
      }
      if (ev.t === "sync" && typeof ev.seed === "number" && typeof ev.wave === "number") {
        if (rebel.state().active) return; // already in the fight
        const nearStar =
          Math.hypot(player.position.x - MOON2_X, player.position.z - MOON2_Z) < 50 &&
          player.position.y > MOON2_TOP - 30;
        if (nearStar) {
          rebel.startAt(ev.seed, ev.wave);
          soundsRef.current?.chime(8);
          toast(`⭐ Joined the defense — wave ${ev.wave}`, {
            description: "Another rebel is holding the pad with you. FIRE at will!",
          });
        } else if (performance.now() > rebelHintMutedUntil && enteredRef.current) {
          rebelHintMutedUntil = performance.now() + 180_000;
          toast("⭐ Rebel Defense is live on the Vibe Star", {
            description: "A rebel is holding the pad right now — fly over and join the fight!",
          });
        }
      }
    };
    rebel.onWave = (w) => {
      vibeBalanceRef.current = Math.max(0, vibeBalanceRef.current) + 5;
      setVibeBalanceTick((n) => n + 1);
      persistVibeBalanceRef.current?.();
      soundsRef.current?.fanfare?.();
      toast.success(`⭐ Wave ${w} cleared! +5 ✦`, {
        description: "Reinforcements inbound — hold the pad.",
      });
    };
    rebel.onPlayerHit = (hpLeft) => {
      soundsRef.current?.thud?.(0.5);
      setRebelFlash(Date.now());
      window.setTimeout(() => setRebelFlash(0), 380);
      if (hpLeft > 0 && hpLeft <= 2) {
        toast(`⚠️ ${hpLeft} ♥ left`, { description: "Use the crates as cover!" });
      }
    };
    rebel.onDefeat = () => {
      toast("💥 Overrun!", {
        description: "The troopers took the pad. Grab the blaster to try again.",
      });
    };
    rebelStartRef.current = () => {
      rebel.start();
      soundsRef.current?.chime(8);
      toast("🔫 Blaster up, rebel!", {
        description: "Doom troopers incoming. FIRE auto-aims the nearest one — they can't aim, you can.",
      });
    };
    rebelFireRef.current = () => {
      if (rebel.fire(player.position)) soundsRef.current?.chime(1);
    };
    vibeStarSpawnRef.current = () => {
      player.position.set(MOON2_X, MOON2_TOP + 4, MOON2_Z + 6);
      vel.set(0, 0, 0);
      onGround = false;
    };

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
    const pegasus = buildPegasus(new THREE.Vector3(ISLAND_X, ISLAND_TOP, ISLAND_Z));
    scene.add(pegasus.group);
    const dragon = buildPegasus(new THREE.Vector3(ISLAND_X, ISLAND_TOP, ISLAND_Z), "dragon");
    dragon.pose = { x: ISLAND_X + 12, y: ISLAND_TOP + 2.5, z: ISLAND_Z + 8, yaw: Math.PI, bank: 0, flap: false };
    // Pegasus waits on the ground too, across from the dragon. It used to
    // circle 28 m overhead, which is pretty and means the only way on was a
    // "Ride Pegasus" button that sat on screen all the time. On the ground
    // you walk up to it and press F (or tap the prompt), like a car.
    const PEGASUS_REST = { x: ISLAND_X - 12, y: ISLAND_TOP + 2.5, z: ISLAND_Z + 8, yaw: Math.PI, bank: 0, flap: false };
    pegasus.pose = { ...PEGASUS_REST };
    scene.add(dragon.group);
    // The Thanksgiving turkey: a third mount, on the north lawn facing the
    // plaza, there only while Thanksgiving is on.
    const turkey = buildTurkey(new THREE.Vector3(ISLAND_X + TURKEY_REST.x, ISLAND_TOP + 2.5, ISLAND_Z + TURKEY_REST.z), TURKEY_REST.yaw);
    scene.add(turkey.group);
    const thanks = buildThanksgiving({
      island: new THREE.Vector3(ISLAND_X, ISLAND_TOP, ISLAND_Z),
      lowDetail: smallScreen,
      balloon: buildTurkey(new THREE.Vector3(0, 2.5, 0), 0),
    });
    scene.add(thanks.group);
    const applyThanks = (on: boolean) => {
      thanksRef.current = on;
      thanks.setOn(on);
      turkey.group.visible = on || activeMountRef.current === "turkey";
    };
    applyThanks(thanksRef.current);
    setThanksRef.current = applyThanks;
    /** The mounts you can get on right now: the turkey only while it is out. */
    /*
     * The helicopter: on a helipad at the corner of the plaza, down in the
     * city, because a thing that flies is most fun where there is something
     * to fly between. It is a mount, so it flies on `stepMount`.
     */
    const HELI_REST = { x: -9, y: 0.6, z: -9, yaw: Math.PI / 4 };
    const heli = buildHelicopter(HELI_REST);
    scene.add(heli.group);
    const mountsInReach = (): Array<[MountKind, PegasusWorld]> => [
      ["pegasus", pegasus], ["dragon", dragon], ["helicopter", heli],
      ...(thanksRef.current ? [["turkey", turkey] as [MountKind, PegasusWorld]] : []),
    ];
    const nearestMount = (p: THREE.Vector3): MountKind | null => {
      for (const [k, c] of mountsInReach()) if (p.distanceTo(c.body.position) < 7) return k;
      return null;
    };
    const creatureOf = (k: MountKind) =>
      k === "dragon" ? dragon : k === "turkey" ? turkey : k === "helicopter" ? heli : pegasus;
    let mountFlight: FlightState | null = null;
    /** The helicopter has been landed away from its pad and holds that pose. */
    let parkedHeli = false;
    let toldHeli = false;

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
    /*
     * `mesh` is the parked go-kart's own model; `ride` is the id of a city car
     * whose wheel you have taken. Exactly one of them is set. The third entry
     * is the standing slot for a commandeered city car — a fixed index rather
     * than a push/pop, because `drivingKartRef` holds an index into this array
     * and shuffling it mid-drive would hand you a different vehicle.
     */
    /** The kart you are driving, while it slides on a Soaker puddle. */
    const kartSlip: { kart: unknown; t: number; spin: number; yaw: number } = { kart: null, t: 0, spin: 0, yaw: 0 };
    const kartStates: Array<{
      x: number; y: number; z: number; yaw: number;
      speed: number; vy: number; steer: number;
      mesh: ReturnType<typeof buildKart> | null;
      ride: number;
      /**
       * Seconds since this vehicle hit the water, or 0 for one that is dry.
       *
       * A sinking car is no longer a car: it does not steer, does not answer
       * the throttle and is not held up by the phantom sea-level plate that
       * every other query in the world floors at y=0. See `sinkTick`.
       */
      sink: number;
      /** In water shallow enough to drive through. Edge-triggers the first splash. */
      wet: boolean;
      /** Where it noses over to, and how far it lists. Rolled once per sink. */
      pitch: number; roll: number;
      /** Parked pose, so a drowned kart can be recovered rather than lost. */
      home: { x: number; y: number; z: number; yaw: number } | null;
      /** Which vehicle this is; its handling and armour come from `VEHICLES`. */
      kind: VehicleKind;
      /** 0..100. At zero it explodes. See `src/city/vehicles.ts`. */
      hp: number;
      /** Seconds since it exploded, 0 while it is a working vehicle. */
      wreck: number;
      /** Seconds before another hit may cost health, so one scrape is one hit. */
      dmgCool: number;
      /** End-over-end angle of a wreck, eased toward upside down. */
      flip: number;
      /**
       * How far it has settled into water it is wading through, metres. The
       * world floors everything at sea level, so without this a car in a
       * metre of water drives along the surface like a hovercraft.
       */
      wade: number;
    }> = [];
    const vehicle = (
      kind: VehicleKind, x: number, y: number, z: number, yaw: number,
      mesh: ReturnType<typeof buildKart> | null,
    ) => kartStates.push({
      x, y, z, yaw, speed: 0, vy: 0, steer: 0, mesh, ride: -1, sink: 0, wet: false,
      pitch: 0, roll: 0, home: null, kind, hp: MAX_HEALTH, wreck: 0, dmgCool: 0, flip: 0, wade: 0,
    });
    vehicle("kart", 10, 0, 20, Math.PI * 0.75, buildKart("#ff6b6b"));
    vehicle("kart", ISLAND_X + SITE.karts.x, ISLAND_TOP, ISLAND_Z + SITE.karts.z, 2.4, buildKart("#46e88c"));
    // The monster truck, on the plaza, nose to the street.
    vehicle("monster", -7, 0, 8, 0, buildMonsterTruck());
    /*
     * The Comet. Somewhere different every visit, under a gold beam; `?comet`
     * parks it on the plaza for a demo or a harness.
     */
    const cometHere = (() => {
      try {
        return new URLSearchParams(window.location.search).has("comet");
      } catch {
        return false;
      }
    })();
    {
      const spot = cometHere
        ? { x: 7, z: 8, yaw: 0 }
        : cometSpot(Math.floor(Math.random() * 1e9), BLOCK + STREET, GRID);
      vehicle("comet", spot.x, 0, spot.z, spot.yaw, buildComet());
    }
    const cometBeacon = buildBeacon();
    scene.add(cometBeacon);
    // A green beam over the lawnmower until you have ridden it once, because
    // nobody could find it: it is on Vibe Island, beside the go-karts.
    const mowerBeacon = buildBeacon(0x6dff8a);
    mowerBeacon.scale.set(0.6, 0.25, 0.6);
    scene.add(mowerBeacon);
    let mowerRidden = (() => {
      try {
        return localStorage.getItem("vibe.city.mowerRidden") === "1";
      } catch {
        return false;
      }
    })();
    // The lawnmower, on the island lawn beside the go-karts.
    vehicle("mower", ISLAND_X + SITE.karts.x + 4, ISLAND_TOP, ISLAND_Z + SITE.karts.z, 2.4, buildMower());
    vehicle("car", 0, 0, 0, 0, null);
    for (const k of kartStates) {
      if (k.mesh) k.home = { x: k.x, y: k.y, z: k.z, yaw: k.yaw };
    }
    const RIDE_SLOT = kartStates.length - 1;
    /**
     * True while the player is sitting inside a city car (not a go-kart).
     *
     * Both halves matter. `ride >= 0` alone means "the slot is holding a car",
     * which stays true after the player has left it — and a car sinking in the
     * bay is deliberately kept claimed for the whole descent so that releasing
     * it does not teleport it back to the nearest lane. This drives whether
     * the avatar is drawn, so with the `driving` half missing the player was
     * simply invisible for the eleven seconds it took the wreck to be
     * recovered: you crash into the sea, bail out, and swim as nobody.
     */
    const insideACar = () =>
      (kartStates[RIDE_SLOT].ride >= 0 && drivingKartRef.current === RIDE_SLOT) ||
      // The truck and the Comet have closed cabs too.
      (drivingKartRef.current >= 0 && drivingKartRef.current !== RIDE_SLOT &&
        VEHICLES[kartStates[drivingKartRef.current].kind].enclosed);
    for (const k of kartStates) {
      if (!k.mesh) continue;
      k.mesh.group.position.set(k.x, k.y, k.z);
      k.mesh.group.rotation.y = k.yaw;
      scene.add(k.mesh.group);
    }
    /** Each vehicle's how-to is said once a visit, not every time you get in. */
    const toldAbout = new Set<VehicleKind>();
    const hintComet = () => {
      if (toldAbout.has("comet") || cometHere) return;
      toldAbout.add("car");
      toast("Hit too many things and it blows up", {
        description: "Watch the health meter. And somewhere in the city a rare gold car is parked under a beam of light.",
      });
    };
    raceStartRef.current = (bet) => {
      if (race.active()) return;
      const k = kartStates[0];
      if (bet > Math.max(0, vibeBalanceRef.current)) bet = 0;
      if (bet > 0) {
        vibeBalanceRef.current -= bet;
        setVibeBalanceTick((n) => n + 1);
        persistVibeBalanceRef.current?.();
      }
      if (drivingKartRef.current >= 0 && drivingKartRef.current !== 0) exitKartRef.current?.();
      const [gx, gz, gyaw] = race.grid;
      k.x = gx;
      k.z = gz;
      k.y = 0;
      k.yaw = gyaw;
      k.speed = 0;
      k.vy = 0;
      k.steer = 0;
      k.sink = 0;
      k.wet = false;
      k.wade = 0;
      k.hp = MAX_HEALTH;
      k.wreck = 0;
      k.flip = 0;
      if (drivingKartRef.current !== 0) enterKartRef.current?.(0);
      race.start(bet);
      setRaceLobby(false);
      toast("🏁 Vibe Kart GP", { description: "Three laps. Follow the beam of light to the next gate. W to go, Shift for boost." });
    };
    enterKartRef.current = (i) => {
      if (i < 0 || i >= kartStates.length) return;
      if (kartStates[i].wreck > 0) return;
      drivingKartRef.current = i;
      setDrivingKart(i);
      setDriveHp(Math.round(kartStates[i].hp));
      const kind = kartStates[i].kind;
      if (!toldAbout.has(kind)) {
        toldAbout.add(kind);
        if (kind === "comet") {
          toast("☄️ You found the Vibe Comet", { description: "Hold Shift for the afterburner. It is very fast and not very strong." });
        } else if (kind === "mower") {
          toast("🌱 Lawnmower", { description: "It shreds trees, buildings, cars and the getaway kart. Nothing hurts it." });
        } else if (kind === "monster") {
          toast("🚚 Monster truck", { description: "Drive over cars to crush them. Trees and signs do not stand a chance." });
        } else {
          hintComet();
        }
      }
      soundsRef.current?.chime(4);
    };
    /**
     * Take the wheel of a city car.
     *
     * The car leaves the fleet (`claim`) and the standing ride slot picks up
     * its pose, after which it is driven by exactly the same arcade physics as
     * the two parked go-karts. The avatar is hidden for the duration: they are
     * inside a car with a roof on it, and a 1.7 m figure standing through the
     * windscreen is worse than no figure at all.
     */
    enterRideRef.current = (id) => {
      const ride = district.traffic.claim(id);
      if (!ride) return;
      const k = kartStates[RIDE_SLOT];
      k.ride = id;
      k.x = ride.x;
      k.y = 0;
      k.z = ride.z;
      k.yaw = ride.yaw + Math.PI; // see the note where `drive` is called
      k.speed = 0;
      k.vy = 0;
      k.steer = 0;
      k.hp = MAX_HEALTH;
      k.wreck = 0;
      drivingKartRef.current = RIDE_SLOT;
      setDrivingKart(RIDE_SLOT);
      setDriveHp(MAX_HEALTH);
      if (!toldAbout.has("car")) hintComet();
      setNearRide(-1);
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
      if (k.ride >= 0) {
        district.traffic.release(k.ride);
        k.ride = -1;
      }
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
      for (const site of landmarks.sites) reg(site.key, site.name, "Vibe City", site.entrance.clone(), site.aliases);
      reg("vibe-arcade", "Vibe Arcade", "Vibe City", arcade.entrance.clone(), ["vibe arcade", "the arcade", "game room", "arcade hall", "pool hall", "pool table", "foosball"]);
      reg("cardboard-island", "Vibe Island", "Vibe Island", new THREE.Vector3(ISLAND_X, ISLAND_TOP, ISLAND_Z), ["island", "cardboard", "edge island", "cardboard island"]);
      reg("jerry", "Jerry the Mayor", "Cardboard Island", island.jerry, ["jerry", "mayor", "snail", "ben"]);
      reg("arcade", "Esmeralda Jump Arcade", "Cardboard Island", island.arcade, ["arcade", "esmeralda jump", "jump cabinet", "cabinet"]);
      reg("powder-peak", "Powder Peak (ski world)", "Powder Peak", skiWorld.spawn, ["ski", "powder peak", "mountain", "snow", "ski town"]);
      reg("vibe-star", "The Vibe Star (Rebel Defense)", "The Vibe Star", new THREE.Vector3(MOON2_X, MOON2_TOP, MOON2_Z), ["vibe star", "rebel defense", "shooter", "troopers", "battle station"]);
      reg("snackfe", "SnackFe Cafe", "Cardboard Island", island.snackfe, ["snackfe", "cafe", "snack", "ramen"]);
      reg("vibe-shop", "Vibe Coin Shop", "Cardboard Island", island.shop, ["shop", "coin shop", "vibe shop", "store"]);
      reg("portal", "Maker Portal", "Cardboard Island", island.portal, ["maker", "maker portal", "spawns"]);
      reg("avatar-portal", "Character Studio", "Cardboard Island", island.avatarPortal, ["avatar", "hologram", "character", "studio"]);
      reg("photo-tv", "Cardboard TV", "Cardboard Island", island.tv, ["tv", "photo tv", "gallery", "holo gallery"]);
      reg("vibe-fm", "VIBE FM Radio", "Cardboard Island", radioAnchors[0], ["radio", "music", "fm", "boombox", "vibe fm"]);
      reg("mission-control", "Mission Control (roadmap)", "Cardboard Island", new THREE.Vector3(ISLAND_X + SITE.missionControl.x, ISLAND_TOP, ISLAND_Z + SITE.missionControl.z), ["roadmap", "mission control", "board", "notion"]);
      reg("wish-garden", "Wish Garden", "Cardboard Island", new THREE.Vector3(ISLAND_X + SITE.wishGarden.x, ISLAND_TOP, ISLAND_Z + SITE.wishGarden.z), ["wish", "wishes", "garden", "flowers", "blooms"]);
      reg("studio-embassy", "Vibe Ventures Studio Embassy", "Cardboard Island", new THREE.Vector3(ISLAND_X + SITE.studioEmbassy.x, ISLAND_TOP, ISLAND_Z + SITE.studioEmbassy.z), ["studio", "embassy", "vibe ventures", "network globe", "hubs"]);
      reg("the-basement", "THE BASEMENT (club)", "THE BASEMENT", new THREE.Vector3(CLUB_X, CLUB_Y, CLUB_Z), ["club", "basement", "nightclub", "dance floor", "disco", "rave"]);
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
    // Two flavors of pickup — floor gems and hoop-caged coins.
    //   Gem  = crystalline emerald octahedron, sitting on the floor of
    //          Vibe Island (or the plaza). Snaps to ground level.
    //   Coin = gold cylinder floating inside a mint torus "hoop" —
    //          fly through the ring to grab it.
    // A pickup counts as a "gem" if it sits near a floor (plaza y≈2 or
    // island top). Everything aerial becomes a hoop coin.
    const gemGeo = new THREE.OctahedronGeometry(0.7, 0);
    const gemMat = new THREE.MeshStandardMaterial({
      color: "#2dd4a8",
      emissive: "#0fa07a",
      emissiveIntensity: 1.2,
      metalness: 0.4,
      roughness: 0.15,
      transparent: true,
      opacity: 0.95,
    });
    const coinGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.12, 24);
    const coinMat = new THREE.MeshStandardMaterial({
      color: "#ffd166",
      emissive: "#c9891a",
      emissiveIntensity: 0.9,
      metalness: 0.85,
      roughness: 0.25,
    });
    const hoopGeo = new THREE.TorusGeometry(1.3, 0.09, 10, 32);
    const hoopMat = new THREE.MeshBasicMaterial({
      color: "#baffe9",
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const collectibles = starPositions.map((p, i) => {
      const nearIslandTop = Math.abs(p.y - ISLAND_TOP) < 2.5;
      const nearPlazaFloor = p.y < 3.5;
      const isGem = nearIslandTop || nearPlazaFloor;
      if (isGem) {
        const mesh = new THREE.Mesh(gemGeo, gemMat);
        // Sit gems just above the floor so they don't z-fight.
        const y = nearPlazaFloor ? 0.9 : ISLAND_TOP + 0.75;
        mesh.position.set(p.x, y, p.z);
        mesh.rotation.y = i;
        scene.add(mesh);
        return { mesh, baseY: y, taken: false, kind: "gem" as const };
      }
      // Hoop with a coin spinning inside it.
      const group = new THREE.Group();
      const coin = new THREE.Mesh(coinGeo, coinMat);
      coin.rotation.x = Math.PI / 2;
      group.add(coin);
      const hoop = new THREE.Mesh(hoopGeo, hoopMat);
      group.add(hoop);
      group.position.copy(p);
      group.rotation.y = i;
      // Face the hoop toward the plaza so it reads as a ring from the
      // main approach angle.
      const facing = Math.atan2(p.x, p.z);
      hoop.rotation.y = facing;
      scene.add(group);
      return { mesh: group, baseY: p.y, taken: false, kind: "hoop" as const, coin, hoop };
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
    // The city's side of the physical doorbell (Agent API v2): walking up
    // to a resident, entering, and leaving all post world events, so agents
    // with real bodies (Vibey's Reachy Mini in Jack's house) can perk up
    // and announce visitors out loud. Fire-and-forget, throttled per agent.
    const proximityLastSent = new Map<string, number>();
    const postWorldEvent = (kind: string, extra: Record<string, unknown> = {}) => {
      void supabase.functions
        .invoke("vibe-world", {
          body: {
            action: "event",
            kind,
            actor_kind: "human",
            actor_name: localStorage.getItem("city.playerName") ?? "a visitor",
            ...extra,
          },
        })
        .catch(() => {});
    };
    const agentResidents = createAgentResidents({
      scene,
      characters: CHARACTERS,
      center: { x: ISLAND_X, y: ISLAND_TOP, z: ISLAND_Z },
      radius: 28,
      roomId: "vibe-lobby",
      onProximity: ({ agentKey, name }) => {
        const now = Date.now();
        if (now - (proximityLastSent.get(agentKey) ?? 0) < 90_000) return;
        proximityLastSent.set(agentKey, now);
        postWorldEvent("proximity", { target_key: agentKey, target_name: name });
      },
    });
    agentResidentsRef.current = agentResidents;

    /* ---- The dance floor -------------------------------------------------
       Off the plaza's east side, clear of the spawn point and the portal
       discs. It comes with four regulars who join in when anybody near them
       dances — see `danceFloor.ts` for why the crowd is stocked rather than
       left to chance: the music's layers are gated on a headcount, and an
       empty city means nobody ever hears past the first one. */
    const danceFloor = createDanceFloor({
      center: { x: 15, y: 0, z: 4 },
      tiles: 7,
    });
    scene.add(danceFloor.group);

    /* ---- THE BASEMENT ----------------------------------------------------
       A room off the map where the music is the point: twenty regulars, a DJ,
       beams on the beat. Reached from the stairwell disc beside the plaza
       floor or `?spawn=club`, and left by the pad inside. */
    const club = createClub({ centerX: CLUB_X, centerZ: CLUB_Z, floorY: CLUB_Y, boxes });
    scene.add(club.group);

    // The way in: a lit disc beside the dance floor.
    const stairMat = new THREE.MeshBasicMaterial({ color: 0xb46bff, toneMapped: false });
    const stairPad = new THREE.Mesh(new THREE.CircleGeometry(1.7, 24), stairMat);
    stairPad.rotation.x = -Math.PI / 2;
    stairPad.position.set(22.5, 0.06, 4);
    scene.add(stairPad);
    const STAIR = new THREE.Vector3(22.5, 0, 4);
    /* Both doors need a cooldown, or standing on the arrival pad after a
       teleport immediately satisfies the other door's test and you bounce
       between the two worlds several times a second. The transcendence portal
       learned this the same way. */
    let clubDoorCooldown = 0;
    /** Mirror of the frame loop's `onGround`, for `__cityDebug.clubDoor`. */
    let onGroundForDebug = false;

    postWorldEvent("enter");
    let applyRemoteBump = (_x: number, _y: number, _z: number, _dirX: number, _dirZ: number, _speed: number) => {};

    // ---- Live Roster TV: scoreboard-style screen on the front of the
    // island showing every current agent and their lobby-grid tile.
    // Clicking it opens a fuller modal with the same list.
    // Moved further to the right (toward island center / Trader Joe's) so
    // the board has clear space on the plaza edge.
    // Town plan: just outside the plaza on the south path's west side.
    const ROSTER_LX = SITE.rosterBoard.x;
    const ROSTER_LZ = SITE.rosterBoard.z;
    const rosterBoard = createAgentRosterBoard({
      position: new THREE.Vector3(ISLAND_X + ROSTER_LX, ISLAND_TOP, ISLAND_Z + ROSTER_LZ),
      rotationY: Math.atan2(-ROSTER_LX, -ROSTER_LZ), // face the island center
      roomId: "vibe-lobby",
    });
    scene.add(rosterBoard.group);
    const unsubRoster = rosterBoard.onUpdate((rows) => setRosterAgents(rows));

    // The Graffiti Wall — mirrors the roster board across the south path.
    // Agents write via the API, humans via the walk-up input below.
    const GRAFFITI_LX = SITE.graffitiWall.x;
    const GRAFFITI_LZ = SITE.graffitiWall.z;
    const graffitiWall = createGraffitiWall({
      position: new THREE.Vector3(ISLAND_X + GRAFFITI_LX, ISLAND_TOP, ISLAND_Z + GRAFFITI_LZ),
      rotationY: Math.atan2(-GRAFFITI_LX, -GRAFFITI_LZ),
    });
    scene.add(graffitiWall.group);
    // Strangers' words on a wall: not in the iOS app (App Store 1.2).
    if (IOS_APP) graffitiWall.group.visible = false;
    graffitiWallRef.current = graffitiWall;

    // The Vibe Times newsstand — front page of the loop's nightly paper.
    const NEWS_LX = SITE.newsstand.x;
    const NEWS_LZ = SITE.newsstand.z;
    const newsstand = createNewsstand({
      position: new THREE.Vector3(ISLAND_X + NEWS_LX, ISLAND_TOP, ISLAND_Z + NEWS_LZ),
      rotationY: Math.atan2(-NEWS_LX, -NEWS_LZ),
    });
    scene.add(newsstand.group);

    // The Vibe Ventures Studio embassy — the studio's mini network
    // globe, in-world. The studio site shows the Vibeverse as a moon;
    // here the Vibeverse holds the studio's constellation in return.
    const STUDIO_LX = SITE.studioEmbassy.x;
    const STUDIO_LZ = SITE.studioEmbassy.z;
    const studioEmbassy = createStudioEmbassy({
      position: new THREE.Vector3(ISLAND_X + STUDIO_LX, ISLAND_TOP, ISLAND_Z + STUDIO_LZ),
      rotationY: Math.atan2(-STUDIO_LX, -STUDIO_LZ),
    });
    scene.add(studioEmbassy.group);


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
      // Rebel Defense co-op: peers' wave syncs + kills land here.
      onRebel: (ev) => rebelRemoteRef.current?.(ev),
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

    /**
     * The sky, as a gradient instead of a fill.
     *
     * `scene.background` was one flat colour, and a flat colour is the single
     * clearest tell that a 3D scene is a 3D scene: real sky is darkest
     * overhead, palest at the horizon, and warm where the sun is. Once the
     * horizon band matches the fog colour, distant things — the far towers, the
     * sky islands, Mars — dissolve into it instead of ending against a wall,
     * which is most of what "aerial perspective" actually is.
     *
     * A dome, not an environment map: the colours are driven by uniforms so
     * `applyMode` can cross a whole sky from night to day by setting three
     * vectors, and there is no cubemap to bake or ship.
     *
     * `fog: false` because fogging the sky with the fog colour that came FROM
     * the sky is a slow way to draw a flat fill again. `depthWrite: false` and
     * a low render order keep it behind everything without a depth range.
     */
    const skyUniforms = {
      uZenith: { value: new THREE.Color("#050810") },
      uHorizon: { value: new THREE.Color("#05080d") },
      uGround: { value: new THREE.Color("#04060a") },
      uSun: { value: new THREE.Vector3(300, 210, -170).normalize() },
      uSunColor: { value: new THREE.Color("#bfd4ff") },
      uSunPower: { value: 0.35 },
    };
    const skyDome = new THREE.Mesh(
      new THREE.SphereGeometry(2600, 32, 20),
      new THREE.ShaderMaterial({
        uniforms: skyUniforms,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        vertexShader: `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 uZenith;
          uniform vec3 uHorizon;
          uniform vec3 uGround;
          uniform vec3 uSun;
          uniform vec3 uSunColor;
          uniform float uSunPower;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            // Tight band at the horizon, long fade to the zenith. The pow is
            // what stops the gradient looking like a linear ramp, which reads
            // as a UI element rather than as air.
            float up = clamp(d.y, -1.0, 1.0);
            vec3 col = up >= 0.0
              ? mix(uHorizon, uZenith, pow(up, 0.42))
              : mix(uHorizon, uGround, pow(-up, 0.6));
            // Sun scatter — broad and weak, not a disk. The moon mesh is the
            // disk; this is the air around it.
            float s = max(dot(d, normalize(uSun)), 0.0);
            col += uSunColor * pow(s, 6.0) * uSunPower;
            col += uSunColor * pow(s, 1.6) * uSunPower * 0.18;
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      }),
    );
    skyDome.renderOrder = -1000;
    scene.add(skyDome);

    /**
     * The sea, and the beach it breaks on.
     *
     * Built here rather than up with the district because it takes the sky
     * dome's uniform objects BY REFERENCE. The water's reflection is the same
     * gradient function fed the same colours, so `applyMode` crossing the sky
     * from night to day, and the weather system tinting it afterwards, both
     * carry into the water for free. The previous ocean kept its own copies of
     * four colours and they had to be re-stated by hand in `applyMode`, which
     * is exactly how the city once ended up sitting at night on a bright
     * turquoise daylight sea.
     */
    const ocean = buildOcean({ skyUniforms, lowDetail: smallScreen, snow: snowCover });
    scene.add(ocean.group);
    // Entering and leaving the water. Pooled, because entering water is a
    // thing that happens over and over and a particle system per entry is how
    // a world starts hitching after ten minutes of play.
    const splash = buildSplash();
    scene.add(splash.group);
    // Much bigger water, for the one thing that arrives much faster than a
    // swimmer: a car. Kept separate rather than scaling `splash` up, because a
    // person's entry and a two-tonne impact want different particle counts,
    // different lifetimes and different shapes, and one tunable that has to be
    // both ends up being neither.
    const carSink = createCarSink();
    scene.add(carSink.group);
    // And the dry-land version: explosions, sparks, leaves, smoke off a hurt
    // engine. See `src/city/crashFx.ts`.
    const crashFx = createCrashFx();
    scene.add(crashFx.group);
    // Something to find down there, so the dive has a point beyond the view.
    const wrecks = createWrecks();
    scene.add(wrecks.group);
    /**
     * And the hole in the bay floor. See `src/city/trench.ts` — it is a realm
     * you reach by swimming, so it has no portal and nothing to register.
     */
    const trench = createTrench();
    scene.add(trench.group);
    // Dev-only handle for `scripts/ocean-probe.mjs`. Water is the one thing in
    // here you genuinely cannot debug from a screenshot: "flat blue" is what a
    // missing mesh, a shader that failed to link and a correct calm sea all
    // look like.
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__cityOcean = ocean.group;
    }

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
      // Each landable cloud carries a WorldBox so the collision system
      // treats its puffy top as a real platform. The box is mutated in
      // place every frame as the cloud drifts and bobs.
      const drifters: Array<{
        g: THREE.Group;
        theta0: number;
        rad: number;
        y0: number;
        drift: number;
        bobPhase: number;
        box: BuildingBox | null;
        size: number;
      }> = [];
      const make = (
        count: number,
        yMin: number, yMax: number,
        radMin: number, radMax: number,
        sizeMin: number, sizeMax: number,
        landable: boolean,
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
          // Turn the closer band into landable trampoline platforms —
          // step tops sit ~0.3*size above center; base is well below so
          // you can never accidentally clip inside the puff.
          let box: BuildingBox | null = null;
          if (landable) {
            const half = size * 1.0;
            box = {
              minX: x - half, maxX: x + half,
              minZ: z - half, maxZ: z + half,
              base: y0 - size * 1.2,
              height: y0 + size * 0.35,
              bouncy: 16, // gentle hop from puff to puff
            };
            boxes.push(box);
          }
          drifters.push({
            g: cloud,
            theta0: theta,
            rad,
            y0,
            drift: 0.000007 + r() * 0.000013, // ~1/3 the old speed
            bobPhase: r() * Math.PI * 2,
            box,
            size,
          });
        }
      };
      // Mid band rings the city well above the island lawn (y 120) and
      // the zeppelin loop (y ~150, radius ≤ ~300 from origin). LANDABLE.
      make(25, 165, 225, 430, 620, 26, 46, true);
      // Distant horizon band for depth (scenery only).
      make(20, 230, 330, 700, 1150, 55, 95, false);
      return (now: number) => {
        if (!clouds.visible) return;
        for (const d of drifters) {
          const t = d.theta0 + now * d.drift;
          const x = Math.cos(t) * d.rad;
          const z = Math.sin(t) * d.rad;
          const y = d.y0 + Math.sin(now * 0.00012 + d.bobPhase) * 3;
          d.g.position.set(x, y, z);
          if (d.box) {
            const half = d.size * 1.0;
            d.box.minX = x - half; d.box.maxX = x + half;
            d.box.minZ = z - half; d.box.maxZ = z + half;
            d.box.base = y - d.size * 1.2;
            d.box.height = y + d.size * 0.35;
          }
        }
      };
    })();
    scene.add(clouds);

    // ---- Day / night ------------------------------------------------
    // One function flips the whole atmosphere: sky, fog, lights,
    // window glow, stars. The moon doubles as the daytime sun disk.
    let baseFogNear = 90;
    let baseFogFar = 520;
    // Sunset and Aurora ride on top of plain day and plain night.
    const citySky = createCitySky({ scene, fog: scene.fog as THREE.Fog, ambient, hemi, sun: moonlight, moon, moonMat, skyUniforms, setOcean: (p) => ocean.setPalette(p) });
    scene.add(citySky.group);
    const applyMode = (day: boolean) => {
      const sky = day ? "#7ec0ee" : "#05080d";
      (scene.background as THREE.Color).set(sky);
      const fog = scene.fog as THREE.Fog;
      fog.color.set(day ? "#cfe6f5" : sky);
      baseFogNear = day ? 170 : 90;
      baseFogFar = day ? 1100 : 520;
      fog.near = baseFogNear;
      fog.far = baseFogFar;
      // Intensities are ~30% up on what they were, paying for the ACES curve
      // set on the renderer — it rolls the top end off rather than clipping it,
      // which costs apparent brightness through the midtones. Changing one of
      // these without the other is what makes the city look washed out or
      // black.
      ambient.color.set(day ? 0xffffff : 0x8899bb);
      ambient.intensity = day ? 0.62 : 0.5;
      hemi.color.set(day ? 0xcfe8ff : 0x32445e);
      hemi.groundColor.set(day ? 0x8c96a4 : 0x0c1018);
      hemi.intensity = day ? 2.3 : 1.35;
      moonlight.color.set(day ? 0xffeec4 : 0xbfd4ff);
      // Night shadows come out softer for free: the moon is a fifth of the
      // sun's intensity against an ambient that barely drops, so the shadow is
      // a tint rather than a hole. (`shadow.intensity` would say this directly
      // but it does not exist until three r165 and this app is on r160.)
      moonlight.intensity = day ? 3.1 : 1.35;
      plazaGlow.intensity = day ? 0 : 60;
      stars.visible = !day;
      clouds.visible = day;
      moonMat.color.set(day ? 0xfff6cf : 0xe8f1ff);
      // The horizon stop matches the fog colour exactly, which is what makes
      // distant geometry dissolve into the sky rather than end against it.
      skyUniforms.uZenith.value.set(day ? "#3d7fc4" : "#04060e");
      skyUniforms.uHorizon.value.set(day ? "#cfe6f5" : "#05080d");
      skyUniforms.uGround.value.set(day ? "#8ea7bb" : "#03050a");
      skyUniforms.uSunColor.value.set(day ? "#ffe6b0" : "#8fb4e8");
      skyUniforms.uSunPower.value = day ? 0.9 : 0.22;
      district.setDay(day);
      landmarks.setDay(day);
      ocean.setPalette(day ? OCEAN_DAY : OCEAN_NIGHT);
      // The sand is lit geometry, not a shader, so it needs the same knock-down
      // the facades get at night or the beach glows like a runway.
      ocean.setSandTint(day ? "#ffffff" : "#7f92aa");
      const look = lookFor(day, skyLookRef.current);
      citySky.apply(look);
      baseFogNear = (scene.fog as THREE.Fog).near;
      baseFogFar = (scene.fog as THREE.Fog).far;
      neon.setDay(day);
      bay.setDay(day);
      wetStreets.setSky(skyUniforms.uZenith.value, skyUniforms.uHorizon.value, !day || look === "sunset");
      // GOD MODE layers on top: this function has just reset every handle
      // to its clear-sky value, so the weather has to re-state itself.
      weatherRef.current?.applyAtmosphere(day);
    };
    applyModeRef.current = applyMode;

    // ---- Below the waterline -------------------------------------------
    /**
     * Built here, after `applyMode`, because that is the thing it has to be
     * able to undo.
     *
     * Underwater is an atmosphere, not an object: it collapses the fog from a
     * kilometre to thirty metres, recolours the ambient and the hemisphere and
     * repaints the background. All four of those handles belong to `applyMode`,
     * which owns the day/night crossing and the weather on top of it. So rather
     * than try to remember and replay whatever they were, surfacing calls the
     * one function that can rebuild all of them from scratch.
     */
    const underwater = createUnderwater({
      scene,
      fog: scene.fog as THREE.Fog,
      ambient,
      hemi,
      sun: moonlight,
      sunDir: skyUniforms.uSun.value,
      restore: () => applyMode(dayModeRef.current),
    });
    scene.add(underwater.group);
    // Caustics go on the seabed — the same mesh as the beach, so the moving
    // web runs right up the sand and stops at the waterline on its own.
    underwater.patch(ocean.bedMaterial);
    /**
     * Everything under the water, not just the floor under it.
     *
     * The caustic web was patched onto the seabed alone, which is where it is
     * most obvious and where a screenshot proves it works — and it meant a
     * swimmer six metres down was the one object in the scene with no moving
     * light on them at all, lit exactly as if they were standing in a street.
     * The shader already does the right thing on arbitrary geometry: it keys
     * off the world normal, so the web lands on shoulders and backs and the
     * tops of chests, and not on undersides.
     *
     * Safe to point at a whole subtree — `patch` skips any material whose
     * shader has no normal to read.
     */
    const patchForCaustics = (root: THREE.Object3D | null | undefined) => {
      root?.traverse((o) => {
        const mat = (o as THREE.Mesh).material;
        if (mat) underwater.patch(mat);
      });
    };
    patchForCaustics(wrecks.group);
    // The karts too: a wreck on the seabed lit flat is the one thing down
    // there that looks pasted in. Done here rather than where they are built,
    // a thousand lines earlier, because the water does not exist yet up there.
    for (const k of kartStates) if (k.mesh) patchForCaustics(k.mesh.group);

    // ---- GOD MODE: weather over the whole world ------------------------
    const weather = createWeather({
      scene,
      fog: scene.fog as THREE.Fog,
      ambient,
      hemi,
      sun: moonlight,
      skyUniforms,
    });
    scene.add(weather.group);
    weatherRef.current = weather;
    weather.onFlash(() => soundsRef.current?.thunder?.());
    setWeatherRef.current = (next) => {
      weather.set(next);
      setWeatherKind(next);
      // Re-run the day/night pass so the weather tint is rebuilt from a
      // known-clean base rather than stacked on the previous weather.
      applyMode(dayModeRef.current);
    };
    /**
     * Start from ONE coherent state.
     *
     * Every piece of the atmosphere used to pick its own initial value at
     * construction, and they disagreed: the sky, the fog and the facades were
     * built for night, while the ocean's uniforms were declared with day
     * colours and `uDay: 1`. Nothing reconciled them until the `world_settings`
     * row arrived from Supabase — so on a slow connection, and permanently on a
     * failed one, the city sat at night on a bright turquoise daylight sea.
     *
     * Calling the one function that owns the whole atmosphere is the fix. The
     * realtime subscription still overrides this the moment it answers.
     */
    applyMode(false);

    // ---- Pilot + jetpack rig ----------------------------------------
    const player = new THREE.Group(); // origin = feet
    if (isLive) player.visible = false; // /live: the player is a camera dolly
    player.position.set(0, 0, 6);
    scene.add(player);
    const riderPose = createRiderPose();
    const modelHolder = new THREE.Group(); // takes the flight tilt
    let stickerKey = "";
    player.add(modelHolder);
    /* Declared up here, hundreds of lines before the hat code that reads it,
       because `loadPilot` below attaches to it — and for a procedural
       character (Flux and friends, `url: ""`) it does so *synchronously*, on
       the initial load, before execution ever reaches the cosmetics block.
       Left down there, that is a temporal-dead-zone ReferenceError that takes
       the whole world down: anyone whose saved character had no GLB opened
       /city and got the crash screen. A GLB character hid it, because there
       the attach happens in a loader callback a tick later. */
    const headMount = createHeadMount();
    // Same trick, other end of the spine — see src/city/backMount.ts.
    const backMount = createBackMount();
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

    // ---- Dancing -------------------------------------------------------
    /* The emote wheel throws an emoji over your head; this moves the body
       underneath it. See `dances.ts` for why the moves are solved rather than
       played back — almost nothing in the city's cast ships a dance clip.

       `danceSk` is bound once per character load, from the rest pose, because
       the bind has to record what "not posed" looks like before the mixer
       starts writing walk cycles onto the same bones. */
    let danceId: string | null = null;
    let danceWeight = 0;
    let danceReleased = true;
    let danceSk: DanceSkeleton | null = null;
    const dancePose = createDancePose();
    /** Last crowd size pushed to React, so the HUD isn't re-rendered per frame. */
    let crowdShown = 0;
    /* Your personal feel for the beat, fixed for this visit. Random rather
       than derived from the character, so two people on the same avatar are
       still visibly two people. */
    const myGroove = makeGroove(Math.floor(Math.random() * 9973));
    const setDance = (id: string | null) => {
      /* A key press is a user gesture, and on the `?fresh=1` route it may be
         the FIRST one — nothing else on that path has opened an AudioContext.
         Without this, arriving from the hub and pressing T got you a dance in
         silence, which is the one outcome this whole feature exists to
         prevent. */
      ensureAudioRef.current?.();
      const def = findDance(id);
      danceId = def ? def.id : null;
      setActiveDance(danceId);
      if (def) soundsRef.current?.chime?.(1);
    };
    setDanceRef.current = setDance;

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
    // Non-null only while Flux is equipped; the frame loop drives it
    // instead of the animation mixer.
    let procPilot: ProceduralPilot | null = null;
    const loadPilot = (url: string, designId?: string) => {
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
      // Flux owns its own geometry, so it disposes itself rather than
      // going through the traverse above.
      procPilot?.dispose();
      procPilot = null;
      mixer?.stopAllAction();
      mixer = null;
      actions.clear();
      activeAction = null;
      activeName = "";
      // The old skeleton belongs to a model that is on its way out; the new
      // one binds below, from its own rest pose.
      danceSk = null;
      danceReleased = true;

      // No URL means the procedural pilot — nothing to fetch, it's built
      // on the spot.
      if (!url) {
        procPilot = buildProceduralPilot(undefined, designId);
        pilotModel = procPilot.group;
        modelHolder.add(procPilot.group);
        patchForCaustics(procPilot.group);
        // Flux is built rather than rigged, so there is no head bone to bind:
        // the mount falls back to the fixed height it always used.
        headMount.attach(null, null, modelHolder);
        backMount.attach(null, null, modelHolder);
        return;
      }

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
          // A character standing on the plaza with no shadow under them is the
          // street-level version of the towers hovering above their own plate.
          // One avatar in the shadow pass costs nothing.
          mesh.castShadow = true;
          const apply = (mat: THREE.Material) => {
            const std = mat as THREE.MeshStandardMaterial;
            if (std && "metalness" in std) {
              std.metalness = Math.min(std.metalness, 0.3);
              std.roughness = Math.max(std.roughness, 0.45);
              std.needsUpdate = true;
            }
            // So the moving light crawls over a swimmer too, and not only
            // over the sand they are swimming above.
            underwater.patch(mat);
          };
          const mat = mesh.material;
          if (Array.isArray(mat)) mat.forEach(apply);
          else if (mat) apply(mat);
        });
        pilotModel = model;
        // Bound here, before a single clip plays: the rest pose is the frame
        // every dance angle is measured from, and one `mixer.update` later
        // these bones are mid-stride.
        danceSk = bindGltfDanceSkeleton(model);
        modelHolder.add(model);
        // After the add: the mount measures the head against the model's own
        // extent, and both need their world matrices to be real.
        headMount.attach(danceSk, model, modelHolder);
        backMount.attach(danceSk, model, modelHolder);

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
      // `name` here IS the catalog id (see the CHARACTERS map above), which
      // is what selects the procedural design.
      if (c) loadPilot(c.url, c.name);
    };
    {
      const start = CHARACTERS.find((c) => c.name === charRef.current) ?? CHARACTERS[0];
      if (start) loadPilot(start.url, start.name);
    }

    // ---- Avatar portal hologram preview --------------------------------
    // A holographic clone of the currently-previewed character that
    // floats on the avatar portal pedestal so the player can see
    // themselves before committing. Loads on demand when React tells
    // us the player is near; tears down when they walk away.
    let holoModel: THREE.Object3D | null = null;
    let holoMixer: THREE.AnimationMixer | null = null;
    let holoProc: ProceduralPilot | null = null;
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
      holoProc = null;
    };
    const holoLoader = new GLTFLoader();
    mountAvatarHoloRef.current = (charNameForHolo) => {
      const gen = ++holoGen;
      disposeHolo();
      if (!charNameForHolo) return;
      const c = CHARACTERS.find((x) => x.name === charNameForHolo);
      if (!c) return;
      // Flux has no file to fetch — build it, tint it, and let it jog on
      // the pedestal so the preview shows the animation, which is the
      // whole reason to pick it.
      if (!c.url) {
        const p = buildProceduralPilot("#7af0ff");
        p.group.scale.setScalar(1.22);
        holoProc = p;
        holoModel = p.group;
        island.avatarStage.add(p.group);
        return;
      }
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
      // Jog on the spot, with a lazy weave so the bank and the scarf both
      // show up in the preview.
      holoProc?.update(dt, {
        speed: 4.4,
        grounded: true,
        verticalVel: 0,
        yawRate: Math.sin(performance.now() * 0.0011) * 1.5,
        thrusting: false,
      });
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
    /**
     * On the pilot's back, and this time actually on it.
     *
     * It used to be `modelHolder.add(jetpack)` at a fixed (0, 1.06, −0.24),
     * which is right for one character standing upright and wrong for the
     * other fifty-seven — and wrong for ALL of them the moment they move,
     * because the swim stroke pitches the rig's root eighty-one degrees and
     * the model holder is not part of that. The swimmer went flat and the
     * jetpack stayed vertical, hanging in the water behind them.
     */
    backMount.attach(null, null, modelHolder);
    backMount.group.add(jetpack);
    const jetLight = new THREE.PointLight(0x7dfce0, 0, 9, 2);
    jetLight.position.set(0, 0.4, -0.2);
    player.add(jetLight);

    // ---- Cosmetics: hat + jet flame color, both equippable from the
    // Vibe Shop. Hat is parented to modelHolder so it tilts with the
    // pilot. Flame color also tints the jet point light.
    /**
     * Hats hang off the head BONE, not off a fixed height on the body.
     *
     * The old mount was a group parked at 1.78 m — right for a character
     * standing still and for nothing else. Every character is a different GLB
     * fitted to the same overall height, so their heads sit at different
     * places inside it, and the hat never moved when the head did: it stayed
     * bolt upright through nods, through dances, and through a swimmer turning
     * to breathe. See `src/city/headMount.ts` for how the bone's bind
     * transform is cancelled so a hat still sits upright and at its authored
     * size on a rig whose head bone is rolled or scaled.
     */
    /* `headMount` itself is created next to `modelHolder`, far above — see the
       note there. This is only the default bind for a body that has not been
       loaded yet. */
    headMount.attach(null, null, modelHolder);
    const hatMount = headMount.group;
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
      "Space", "ShiftLeft", "ShiftRight", "KeyC", "KeyR", "KeyQ", "KeyX",
    ]);
    // Don't steal keys while the player is typing in chat.
    const isTyping = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e) || !enteredRef.current) return;
      // T is the dance key: it picks a move at random, and pressing it again
      // picks a different one. One key, no menu — the point is that dancing
      // costs less thought than walking does.
      if (e.code === "KeyG" && !e.repeat) {
        mayhemCycleRef.current?.();
        return;
      }
      if (/^Digit[1-5]$/.test(e.code) && !e.repeat) {
        const { owned, gun } = mayhemSlotsRef.current;
        const pick = GUN_SLOTS.filter((k) => owned.includes(k))[Number(e.code.slice(5)) - 1];
        if (pick) {
          mayhemRef.current?.select(pick === gun ? null : pick);
          return;
        }
      }
      if (e.code === "KeyE" && !e.repeat && atHideout) {
        badSummonRef.current?.();
        return;
      }
      if (e.code === "KeyE" && !e.repeat && nearRideButton) {
        rideButtonRef.current?.();
        return;
      }
      if (e.code === "KeyE" && !e.repeat && nearRaceKioskRef.current) {
        setRaceLobby(true);
        return;
      }
      if (e.code === "KeyE" && !e.repeat && arcadeStationRef.current && !cabinetOpenRef.current) {
        openCabinet(arcadeStationRef.current);
        return;
      }
      if (e.code === "KeyY" && !e.repeat) {
        e.preventDefault();
        if (document.pointerLockElement) document.exitPointerLock();
        setWizardOpen((o) => !o);
        return;
      }
      if (e.code === "KeyT" && !e.repeat && folkNearRef.current && !folkOpenRef.current) {
        e.preventDefault();
        const d = folkNearRef.current;
        folkOpenRef.current = d;
        setFolkOpen(d);
        folkRef.current?.engage(d.id);
        return;
      }
      if (e.code === "KeyT") {
        e.preventDefault();
        arrivalStart = 0;
        setDance(randomDanceId(danceId));
        return;
      }
      if (!handled.has(e.code)) return;
      e.preventDefault();
      arrivalStart = 0; // input ends the arrival cinematic
      // Walking out of it is the stop button. Done on the keypress rather
      // than waiting for speed to build so the first step already looks like
      // a step and not like the last frame of a floss.
      if (danceId && e.code !== "ShiftLeft" && e.code !== "ShiftRight") setDance(null);
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
    /**
     * Set by the DEV-only `__cityCam` to place the camera on its target in one
     * frame instead of easing to it. Never set in a production build — the
     * hook that writes it lives behind `import.meta.env.DEV` — so this is a
     * boolean that is read once a frame and is always false for visitors.
     *
     * It exists because the chase camera closes on its target by about 30% a
     * tick, and on the software renderer the screenshot harnesses run under, a
     * tick can be seconds. A 700 m zoom took half a minute of wall clock to
     * arrive, and every harness in `scripts/` had grown its own fixed wait
     * that was sometimes too short — which is how shots came back framed on
     * the avatar's back at nine metres instead of the view that was asked for.
     */
    let camSnap = false;

    /**
     * Dev-only: pose the orbit camera from a script.
     *
     * `scripts/city-flyover.mjs` photographs the city from a fixed set of
     * altitudes so a change to how it looks can be compared instead of
     * remembered. It used to do that by synthesising wheel and drag events,
     * which on a software GL renderer took three minutes a shot and still
     * landed somewhere else — the zoom is exponential per notch, so a dropped
     * event is a different altitude, and there is nothing to read back.
     *
     * Stripped from production builds by the `DEV` guard: `import.meta.env.DEV`
     * is a compile-time constant, so the whole block is dead code the minifier
     * removes rather than a hook shipped to visitors.
     */
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__cityCam = (
        dist: number,
        pitch: number,
        yaw: number,
      ) => {
        arrivalStart = 0; // cancel the arrival swoop, or it fights the pose
        camDist = THREE.MathUtils.clamp(dist, MIN_CAM_DIST, MAX_CAM_DIST);
        camPitch = THREE.MathUtils.clamp(pitch, minCamPitch(), 1.25);
        camYaw = yaw;
        camSnap = true; // arrive this frame, not in thirty seconds
      };

      /**
       * Stand somewhere, in island-local coordinates.
       *
       * `__cityCam` orbits the *player*, so posing it while the player is at
       * spawn photographs spawn from a new angle — which is how a screenshot
       * of "the new plaza" turned out to be a picture of Jerry's Plaza. The
       * anchors in `cardboardIsland.ts` are all local offsets, so this takes
       * the same numbers you would read there.
       */
      (window as unknown as Record<string, unknown>).__cityGoto = (
        x: number,
        z: number,
      ) => {
        arrivalStart = 0;
        player.position.set(ISLAND_X + x, ISLAND_TOP + 1.2, ISLAND_Z + z);
      };

      /**
       * Hold a synthetic "forward" input, for photographing motion.
       *
       * The swim stroke is solved from speed, so there is no clip to scrub and
       * the only way to see it at pace is to actually be moving. Synthesising
       * keyboard events would work and would also drive every other key
       * handler in the page; one number is less to go wrong.
       */
      (window as unknown as Record<string, unknown>).__citySwim = (fwd: number) => {
        devForward = Math.max(0, Math.min(1, fwd));
        // Seeded up to speed rather than waiting for the easing. `dt` is
        // clamped to 0.05, so under the software renderer a harness runs at
        // roughly a fifteenth of real time and a swimmer takes the better part
        // of a minute of wall clock to reach a stroke worth photographing.
        if (devForward > 0) {
          vel.x = -Math.sin(camYaw) * SWIM_SPEED * devForward;
          vel.z = -Math.cos(camYaw) * SWIM_SPEED * devForward;
        }
      };
      /**
       * Force a snowfall and how deep it has settled.
       *
       * Accumulation takes half a minute of game time on purpose, and the
       * software renderer a harness runs on advances at about a fifteenth of
       * real time — so photographing "an inch of snow" by waiting for it costs
       * seven minutes a frame. This sets the depth directly.
       */
      (window as unknown as Record<string, unknown>).__citySnow = (depth: number) => {
        setWeatherRef.current?.(depth > 0 ? "snow" : "clear");
        snowCover.uniform.value = Math.max(0, Math.min(1, depth));
      };
      /**
       * Equip a hat and, optionally, hold a dance — the pair a harness needs to
       * tell "sits on the head" from "sits where the head usually is".
       */
      /**
       * Freeze the stroke at an exact phase, or null to let the clock run.
       * `scripts/swim-strip.mjs` walks a full cycle with this.
       */
      (window as unknown as Record<string, unknown>).__citySwimPose = (
        phase: number | null,
        speed = 3.2,
      ) => {
        devSwimPose = phase === null ? null : { phase, speed };
      };
      (window as unknown as Record<string, unknown>).__cityHat = (
        hat: string | null,
        dance: string | null,
      ) => {
        if (hat) applyHat(hat);
        setDance(dance);
      };
      /**
       * Which joints the pose system actually got hold of on this character.
       *
       * The stroke can be perfect and still look broken if the rig's arm bones
       * did not match: the body pitches prone, the mixer keeps playing idle on
       * the unbound limbs, and the result is a face-down avatar doing a
       * standing animation. That failure is per-character and silent.
       */
      (window as unknown as Record<string, unknown>).__cityRig = () => ({
        bound: danceSk?.bound ?? 0,
        hips: !!danceSk?.hips,
        spine: !!danceSk?.spine,
        torso: !!danceSk?.torso,
        head: !!danceSk?.head,
        armL: [!!danceSk?.armL.upper, !!danceSk?.armL.lower],
        armR: [!!danceSk?.armR.upper, !!danceSk?.armR.lower],
        legL: [!!danceSk?.legL.upper, !!danceSk?.legL.lower, !!danceSk?.legL.tip],
        legR: [!!danceSk?.legR.upper, !!danceSk?.legR.lower, !!danceSk?.legR.tip],
      });
      (window as unknown as Record<string, unknown>).__cityChar = (name: string) => {
        loadPilotRef.current?.(name);
      };
      (window as unknown as Record<string, unknown>).__cityDive = (v: number | null) => {
        devDive = v === null ? null : Math.max(0, Math.min(1, v));
      };
      /**
       * Put the red kart somewhere, pointed somewhere, at a speed, and get in.
       *
       * Driving one into the sea by hand takes a route, a straight, and about
       * eight seconds of held throttle — which under software GL is two
       * minutes of a harness pressing W and hoping it did not clip a bollard
       * on the way. This starts the interesting part at the interesting place.
       */
      (window as unknown as Record<string, unknown>).__cityDrive = (
        x: number, y: number, z: number, yaw: number, speed: number,
        throttle: number | null = null,
      ) => {
        const k = kartStates[0];
        k.x = x; k.y = y; k.z = z; k.yaw = yaw;
        k.speed = speed; k.vy = 0; k.steer = 0;
        k.sink = 0; k.wet = false; k.pitch = 0; k.roll = 0;
        kartPitchNow[0] = 0;
        devThrottle = throttle;
        enterKartRef.current?.(0);
      };
      /**
       * Fast-forward the sink clock.
       *
       * The recovery fires eleven seconds after the hit, and under software GL
       * this world steps at about a tenth of real time — so measuring it
       * honestly costs a hundred and ten seconds of a harness polling a car
       * lying on the seabed. This skips the lying-there, not the logic: the
       * same branch, with the same conditions, on the next frame.
       */
      (window as unknown as Record<string, unknown>).__cityKartAge = (sec: number) => {
        if (kartStates[0].sink > 0) kartStates[0].sink = sec;
      };
      /**
       * Is the avatar actually being drawn?
       *
       * `modelHolder.visible` is written every frame from `insideACar()`, and
       * a wrong answer there is completely silent — the player is simply not
       * there. That shipped once: bailing out of a car sinking in the bay left
       * the car claimed, which left `insideACar()` true, which left the
       * swimmer invisible for the eleven seconds until the wreck was
       * recovered.
       */
      (window as unknown as Record<string, unknown>).__cityAvatar = () => ({
        visible: modelHolder.visible,
        x: player.position.x, y: player.position.y, z: player.position.z,
        vx: vel.x, vy: vel.y, vz: vel.z,
        // Seconds left of being bowled over by a car. Zero the rest of the
        // time, which is most of it.
        knockdown,
        onGround,
      });
      (window as unknown as Record<string, unknown>).__cityCarsNear = (
        x: number, z: number, r: number,
      ) => district.traffic.debugNear(x, z, r);
      /**
       * Where the treasure is and what has been taken.
       *
       * A hunt is the one feature you genuinely cannot photograph: the sites
       * are placed by walking out along a bearing until the water is deep
       * enough, so nothing in the source says where they end up, and "did the
       * chest pay out" is a number in a wallet.
       */
      /**
       * Where the jetpack actually is, relative to the body wearing it.
       *
       * The whole failure mode is that the pack keeps its authored offset
       * while the character moves out from under it — so the only thing worth
       * measuring is the gap between the pack and the spine it is supposed to
       * be strapped to, sampled while the body is doing something. Standing
       * still it looked correct for two weeks.
       */
      (window as unknown as Record<string, unknown>).__cityJetpack = () => {
        const jp = new THREE.Vector3();
        jetpack.getWorldPosition(jp);
        const bone = danceSk?.torso?.obj ?? danceSk?.spine?.obj ?? danceSk?.hips?.obj ?? null;
        const bp = new THREE.Vector3();
        if (bone) bone.getWorldPosition(bp);
        else modelHolder.getWorldPosition(bp);
        return {
          bound: !!bone,
          gap: bone ? jp.distanceTo(bp) : -1,
          jet: { x: jp.x, y: jp.y, z: jp.z },
          spine: { x: bp.x, y: bp.y, z: bp.z },
          // The pack's own tilt in world space. A back that has pitched eighty
          // degrees and a pack still pointing at the sky is the bug.
          tilt: new THREE.Euler().setFromQuaternion(jetpack.getWorldQuaternion(new THREE.Quaternion())).x,
        };
      };
      /**
       * Where the hole is, and how far down you have got.
       *
       * The mouth is placed by walking a bearing out to water deeper than
       * twelve metres, so nothing in the source says where it lands — and
       * "am I in the Deep" is a footprint test that four separate bounds in
       * this file depend on.
       */
      (window as unknown as Record<string, unknown>).__cityTrench = () => ({
        mouth: trench.mouth,
        pearl: trench.prize(),
        inside: trench.inside(player.position.x, player.position.z),
        descent: trench.descent(player.position.y),
        floor: trench.floorAt(player.position.x, player.position.z),
        y: player.position.y,
        camY: camera.position.y,
        swimming,
        // Everything that could be quietly overruling the swim.
        onGround,
        support: supportHeightAt(player.position.x, player.position.z, player.position.y + 0.1),
        depthHere: waterDepthAt(player.position.x, player.position.z),
        underground: undergroundActiveRef.current,
        vy: vel.y,
      });
      (window as unknown as Record<string, unknown>).__cityTrenchReset = () => trench.reset();
      (window as unknown as Record<string, unknown>).__cityWrecks = () =>
        wrecks.sites.map((s) => ({ ...s }));
      (window as unknown as Record<string, unknown>).__cityWrecksReset = () => wrecks.reset();
      (window as unknown as Record<string, unknown>).__cityVibe = () => vibeBalanceRef.current;
      /**
       * Crashes, for harnesses. `drive(slot, x, z, yaw, speed, throttle)` puts
       * any vehicle somewhere at speed and gets in (slot 2 is the monster
       * truck, 3 the Comet); `state()` is what has gone wrong so far.
       */
      (window as unknown as Record<string, unknown>).__cityCrash = {
        drive: (slot: number, x: number, z: number, yaw: number, speed: number, throttle: number | null = null) => {
          const k = kartStates[slot];
          if (!k || !k.mesh) return false;
          k.x = x; k.y = supportHeightAt(x, z, 50); k.z = z; k.yaw = yaw;
          k.speed = speed; k.vy = 0; k.steer = 0; k.sink = 0; k.wet = false;
          k.wreck = 0; k.flip = 0;
          if (k.mesh) scorch(k.mesh.group, false);
          kartPitchNow[slot] = 0;
          devThrottle = throttle;
          enterKartRef.current?.(slot);
          return true;
        },
        throttle: (t: number | null) => { devThrottle = t; },
        /** Stop drawing (false) so the world steps quickly in software GL; true to resume. */
        render: (on: boolean) => { devSkipRender = !on; },
        hurt: (amount: number) => {
          const i = drivingKartRef.current;
          if (i >= 0) hurtVehicle(i, "blast", amount, true);
        },
        skid: () => district.traffic.loseControl(player.position),
        traffic: district.traffic,
        /** Which collision boxes would stop a vehicle probe at this point. */
        probe: (x: number, z: number, y: number) =>
          boxes
            .filter((b) => y < b.height - 0.4 && y + 1.7 > b.base &&
              x >= b.minX - PLAYER_RADIUS && x <= b.maxX + PLAYER_RADIUS &&
              z >= b.minZ - PLAYER_RADIUS && z <= b.maxZ + PLAYER_RADIUS)
            .map((b) => ({ ...b, i: boxes.indexOf(b) })),
        state: () => {
          const i = drivingKartRef.current;
          const k = i >= 0 ? kartStates[i] : null;
          return {
            driving: i,
            kind: k?.kind ?? null,
            hp: k?.hp ?? null,
            x: k?.x ?? player.position.x, z: k?.z ?? player.position.z, speed: k?.speed ?? 0,
            vehicles: kartStates.map((v) => ({ kind: v.kind, hp: v.hp, wreck: v.wreck, x: v.x, y: v.y, z: v.z })),
            traffic: district.traffic.stats(),
            propsDown: district.smash.downCount(),
            props: district.smash.count(),
            fxExplosions: crashFx.explosions(),
          };
        },
      };
      (window as unknown as Record<string, unknown>).__cityKartState = () => {
        const k = kartStates[0];
        return {
          x: k.x, y: k.y, z: k.z, vy: k.vy, speed: k.speed,
          // Seconds since it hit the water, 0 when dry. The single number that
          // says whether the sea is water or pavement.
          sink: k.sink,
          // In water but not yet drowning — the ploughing phase that used to
          // not exist at all.
          wet: k.wet,
          pitch: kartPitchNow[0], roll: k.roll,
          driving: drivingKartRef.current === 0,
          depth: waterDepthAt(k.x, k.z),
          sea: seaSurfaceAt(k.x, k.z, performance.now() * 0.001),
          home: k.home,
        };
      };
      (window as unknown as Record<string, unknown>).__citySwimState = () => ({
        swimming,
        prone: swimProne,
        speed: Math.hypot(vel.x, vel.z),
        // Where buoyancy is taking the body, so a harness can wait for it to
        // get there instead of photographing a swimmer mid-sink.
        floatY:
          seaSurfaceAt(player.position.x, player.position.z, performance.now() * 0.001) -
          THREE.MathUtils.lerp(1.15, -0.26, swimProne),
        y: player.position.y,
        sea: seaSurfaceAt(player.position.x, player.position.z, performance.now() * 0.001),
        depth: waterDepthAt(player.position.x, player.position.z),
        // Diving. `camY` and `under` are about the CAMERA, because the camera
        // is what decides whether the world is rendered as water or as air —
        // a swimmer can be well below the surface with the eye still in the
        // sunshine, and that reads on screen as "the dive did nothing".
        dive: diveEased,
        // Vertical velocity, so a harness can ask "is it still descending?"
        // without inferring it from how far it got between two polls — which
        // under software GL measures the frame rate, not the physics.
        vy: vel.y,
        camY: camera.position.y,
        under: underwater.submerged(),
      });

      /**
       * Pin the time of day.
       *
       * Clicking the toggle is not enough for a screenshot harness: the mode
       * is a shared world setting, so the Supabase row and any peer's toggle
       * both overwrite it mid-run — which is how a "day" pass came back as
       * seven pictures of a night ocean.
       */
      (window as unknown as Record<string, unknown>).__citySky = (look: SkyLook) => {
        skyLookRef.current = look;
        setSkyLook(look);
        const day = isDayLook(look);
        setDayMode(day);
        dayModeRef.current = day;
        applyMode(day);
        citySky.snap();
        return { look: citySky.get(), neon: neon.count };
      };
      (window as unknown as Record<string, unknown>).__cityWet = (w: number | null) => wetStreets.force(w);
      (window as unknown as Record<string, unknown>).__cityFolk = {
        where: () => folk.where(),
        near: () => folk.near()?.id ?? null,
        say: (id: string, t: string) => folk.say(id, t),
        pigeons: () => birds.airborne(),
      };
      (window as unknown as Record<string, unknown>).__cityBay = () => ({ bridge: bay.spots.bridge.toArray(), rock: bay.spots.rock.toArray() });
      (window as unknown as Record<string, unknown>).__cityDay = (on: boolean) => {
        setDayMode(on);
        // The ref too, not just the state. `dayModeRef` is updated by an effect
        // on the next React render, and anything that re-applies the
        // atmosphere before then — the weather setter does — reads the stale
        // value and puts the world straight back to night.
        dayModeRef.current = on;
        applyMode(on);
      };

      /**
       * Stand anywhere, in world coordinates.
       *
       * `__cityGoto` is island-local and pins you to the island's altitude,
       * which is the wrong tool for photographing the shoreline: getting to
       * the beach through it meant a 120 m drop, and a 120 m drop is fall
       * damage, a respawn, and a screenshot of the plaza.
       */
      // Where the rideable animals are, so a script can walk up to one and
      // press F the way a player does, instead of calling the mount directly.
      (window as unknown as Record<string, unknown>).__cityMounts = () => ({
        pegasus: pegasus.body.position.toArray(),
        dragon: dragon.body.position.toArray(),
        turkey: turkey.body.position.toArray(),
        helicopter: heli.body.position.toArray(),
        parade: thanks.float.getWorldPosition(new THREE.Vector3()).toArray(),
      });
      (window as unknown as Record<string, unknown>).__cityRace = {
        ui: () => race.ui(),
        start: (bet = 0) => raceStartRef.current?.(bet),
        finish: () => race.devFinish(),
        gates: () => race.devGates(),
        kiosk: () => race.kiosk.toArray(),
        grid: () => race.grid,
      };
      (window as unknown as Record<string, unknown>).__cityArcade = {
        stations: () => arcade.stations.map((s) => ({ key: s.key, route: s.route, at: s.at.toArray() })),
        near: () => arcadeStationRef.current?.key ?? null,
        open: (key?: string) => openCabinet(key ? arcade.stations.find((s) => s.key === key) ?? null : arcadeStationRef.current),
        close: () => closeCabinet(),
        entrance: () => arcade.entrance.toArray(),
      };
      (window as unknown as Record<string, unknown>).__cityLandmarks = {
        sites: () => landmarks.devSites(),
        near: () => landmarks.ui(),
        state: () => {
          const u = landmarks.ui();
          return { riding: !!(u.ride || u.express), ui: u, player: player.position.toArray() };
        },
        act: () => landmarks.act(),
        shot: (s: { eye: number[]; look: number[]; fov?: number } | null) => landmarks.devShot(s),
        ball: (k?: [number, number, number, number]) => landmarks.devBall(k),
        match: (op?: string, arg?: number) => landmarks.devMatch(op, arg),
        boat: (at?: [number, number, number]) => landmarks.devBoat(at),
      };
      (window as unknown as Record<string, unknown>).__cityPos = () => {
        const k = drivingKartRef.current >= 0 ? kartStates[drivingKartRef.current] : null;
        return { p: [player.position.x, player.position.y, player.position.z], kart: k ? [k.x, k.y, k.z, k.speed] : null, onGround };
      };
      (window as unknown as Record<string, unknown>).__cityWarp = (
        x: number,
        y: number,
        z: number,
      ) => {
        arrivalStart = 0;
        player.position.set(x, y, z);
        // Velocity too, or a harness that re-asserts the pose every half
        // second re-drops the player from the same height over and over and
        // accumulates fall speed without bound. The chase camera eases behind
        // a moving player, so it then never sits at the distance it was asked
        // for — which is what made half the screenshots in this repo come back
        // framed on the avatar's back instead of the shot requested.
        vel.set(0, 0, 0);
        // A teleport is a cut, not a pan. Without this the chase camera eases
        // in from wherever it was, and a harness that warps 70 m down a trench
        // and then samples the very next frame reads a camera 33 m behind the
        // swimmer — and calls it a camera that never followed. It was simply
        // still on its way.
        camSnap = true;
      };
    }
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

    /**
     * What the frame loop last worked out is within reach, for the keyboard.
     *
     * The same values go to React state for the on-screen buttons, but a
     * keydown handler cannot read those — it closes over the state from the
     * render it was created in, which for a handler registered once is the
     * first one, forever. These are the live copies.
     */
    let nearKartNow = -1;
    let nearRideNow = -1;

    // Toggle 1st/3rd person with "V" on desktop (mirrors the VR button).
    const onToggleView = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.code === "KeyV") {
        vrFirstPerson = !vrFirstPerson;
      }
      // "P" takes / releases the zeppelin helm while standing on its deck.
      if (e.code === "KeyP" && ridingZeppelin) {
        setZepPilotMode(!zepPilotRef.current);
      }
      /**
       * "F" is get in / get out, and it is one key on purpose.
       *
       * Getting into a vehicle used to be a small button that appears at the
       * bottom of the screen when you walk near one, and getting out was that
       * button again or Space — which is also the jetpack, so leaving a kart
       * and firing your jetpack were the same keystroke and you did both.
       * Driving is the one activity in this world where your hands are already
       * on the keyboard, and taking them off to aim a mouse at a pill-shaped
       * target is the wrong ask.
       */
      // E: the landmarks' elevators and binoculars.
      if (e.code === "KeyE" && !e.repeat && enteredRef.current) {
        if (landmarksRef.current?.act()) e.preventDefault();
      }
      if (e.code === "KeyF" && !e.repeat) {
        if (activeMountRef.current) { mountActionRef.current?.(null); return; }
        if (ridingBad !== null || nearBadNow !== null) { badRideRef.current?.(); return; }
        const p = player.position;
        const nearest = nearestMount(p);
        if (nearest) { mountActionRef.current?.(nearest); return; }
        if (drivingKartRef.current >= 0) exitKartRef.current?.();
        else if (nearKartNow >= 0) enterKartRef.current?.(nearKartNow);
        else if (nearRideNow >= 0) enterRideRef.current?.(nearRideNow);
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
    /**
     * How far down the camera may aim, which is a different number in water.
     *
     * On land the chase camera must stay above the player — a negative pitch
     * puts the eye in the pavement, and the floor clamp then shoves it back up
     * through the model. In water there is no floor until the seabed, and
     * aiming UP is the whole point: Snell's window is directly overhead, so a
     * camera that can only ever look down at you can never show you the single
     * most recognisable thing about being underwater. It was built, it worked,
     * and for two weeks nobody could see it.
     */
    const minCamPitch = () => (swimming ? -0.85 : 0.06);

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
      camPitch = THREE.MathUtils.clamp(camPitch + dy * 0.0052, minCamPitch(), 1.25);
    };
    const onPointerUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = null;
      if (dragPointer === e.pointerId) dragPointer = null;
      // Tap (not drag): raycast for clickable props — the $VIBE emblem
      // over the shop and the God Orb in the sky. Gremlin stomps stay
      // physics-driven.
      if (tapStart) {
        const moved = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
        const held = performance.now() - tapStart.t;
        if (moved < 8 && held < 450) {
          const rect = canvas.getBoundingClientRect();
          const ndc = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -(((e.clientY - rect.top) / rect.height) * 2 - 1),
          );
          const ray = new THREE.Raycaster();
          ray.setFromCamera(ndc, camera);
          if (vibeEmblemHit && ray.intersectObject(vibeEmblemHit, false).length > 0) {
            triggerEmblemFun();
          } else if (ray.intersectObject(divineHit, false).length > 0) {
            setWishOpen(true);
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
    // The queries themselves live in src/city/player/collision.ts, where
    // they can be tested without standing up a WebGL context — see
    // collision.test.ts, which walks a surface up through every altitude
    // this world uses and asserts it stays walkable. `boxes` is passed by
    // reference because worlds push into it as they load and the drifting
    // clouds mutate theirs in place every frame.
    const collision = new CollisionWorld(boxes, {
      radius: PLAYER_RADIUS,
      // Powder Peak's snow is computed, not boxed.
      // Two analytic surfaces now: Powder Peak's snow, and the sand berm
      // around the city. They never overlap — the ski world is 850 m out —
      // so first non-null wins is enough.
      analyticHeightAt: (x, z) => skiWorld.heightAt(x, z) ?? beachHeightAt(x, z),
    });

    // Bounciness of whichever surface won the most recent
    // supportHeightAt() call — 0 for ordinary ground. The landing code
    // reads it immediately after querying support.
    let supportBounce = 0;
    const supportHeightAt = (x: number, z: number, refY: number): number => {
      const s = collision.supportAt(x, z, refY);
      supportBounce = s.bouncy;
      return s.height;
    };
    const blockedAt = (x: number, z: number, y: number): boolean =>
      collision.isBlocked(x, z, y);

    // ---- GTA Junior: guns, fire, police ---------------------------------
    // See `src/city/mayhem.ts`. The callbacks reach back into the vehicle
    // and avatar code further down this effect; they only run once the tick
    // has started, by which time all of it exists.
    const mayhem: Mayhem = createMayhem({
      scene,
      crashFx,
      smash: district.smash,
      traffic: district.traffic,
      boxes: district.boxes,
      blocked: () => blockedAt,
      pitch: BLOCK + STREET,
      half: (GRID * (BLOCK + STREET)) / 2,
      hand: modelHolder,
      stallSpots: [[6, 0, -6], [-6, 0, -6], [6, 0, 6], [0, 0, -9], [9, 0, 0]],
      onContact: (dx, dz, speed, byCop) => {
        const i = drivingKartRef.current;
        if (i >= 0) {
          const k = kartStates[i];
          hurtVehicle(i, "car", speed);
          if (byCop) {
            k.x += dx * 0.5;
            k.z += dz * 0.5;
            k.speed *= 0.55;
          } else {
            k.speed *= 0.7;
          }
          crashFx.kick(Math.min(0.6, speed / 35));
          soundsRef.current?.thud?.(Math.min(1, 0.4 + speed / 30));
        } else if (byCop) {
          bowlOver(dx, dz, speed);
        }
      },
      onSlip: (dx, dz, speed, driving) => {
        const i = drivingKartRef.current;
        if (driving) {
          if (i < 0) return;
          const k = kartStates[i];
          kartSlip.kart = k;
          kartSlip.t = 1.2;
          kartSlip.yaw = k.speed >= 0 ? k.yaw : k.yaw + Math.PI;
          kartSlip.spin = (Math.random() < 0.5 ? -1 : 1) * 5.5;
          soundsRef.current?.thud?.(0.35);
          return;
        }
        // On foot: feet go out from under you and you slide on along the way
        // you were running, low and fast, rather than flying up.
        const k = Math.min(1, speed / 9);
        vel.x = dx * (5 + speed * 0.8);
        vel.z = dz * (5 + speed * 0.8);
        vel.y = 2.5 + k * 1.5;
        onGround = false;
        coyoteTimer = 0;
        peakY = player.position.y;
        knockdown = 1.1;
        knockSpin = 0;
        knockAxis = Math.abs(dx) > Math.abs(dz) ? 1 : 0;
        soundsRef.current?.thud?.(0.4);
        setDance(null);
      },
      onBlast: (x, z, r) => {
        const d = Math.hypot(player.position.x - x, player.position.z - z);
        if (d > r) return;
        if (drivingKartRef.current >= 0) {
          hurtVehicle(drivingKartRef.current, "blast", 35 * (1 - d / r), true);
        } else if (Math.abs(player.position.y - 1) < 5) {
          bowlOver((player.position.x - x) / (d || 1), (player.position.z - z) / (d || 1), 14 * (1 - d / r) + 4);
        }
      },
      onBust: () => heistChase.bust(),
      hideout: hideouts.hideout,
      lair: hideouts.lair,
      garage: hideouts.garage,
      parked: hideouts.parked,
      onBadDown: (left) => {
        toast("💥 A bad guy blew up", {
          description: left > 0 ? `${left} still on the loose.` : "That was the last one. Summon another from the hideout roof.",
        });
      },
      onHud: (h) => {
        mayhemSlotsRef.current = { owned: h.owned, gun: h.gun };
        setMayhemHud(h);
      },
      onPickup: (kind) => {
        soundsRef.current?.fanfare?.();
        toast(`${GUNS[kind].emoji} You found the ${GUNS[kind].label}`, {
          description: "Hold R (or Q) to fire, it aims for you, G to switch guns. Shooting in town brings the police.",
        });
      },
      boom: (x, z) => soundsRef.current?.boom?.(1, earshot(x, z, 160)),
    });
    mayhemCycleRef.current = () => mayhem.cycle();
    mayhemRef.current = mayhem;
    mayhem.setBought(ownedWeapons(getWardrobeState().owned));
    (window as unknown as Record<string, unknown>).__cityMayhem = mayhem;

    // ---- Samurai bodyguards: see `src/city/bodyguards.ts` -----------------
    // Ordered about by the squad HUD, typed words and, when somebody presses
    // Talk, the Magician's voice session with the squad's own tool list.
    // Behind a switch while Jack tries it: `?squad` turns it on for this
    // device (and remembers), `?squad=off` turns it back off.
    const squadApi: Bodyguards | null = squadEnabled() ? createBodyguards({
      scene,
      mayhem,
      crashFx,
      ground: (x, z, y) => collision.supportAt(x, z, y).height,
      blocked: blockedAt,
      sound: (kind) => {
        if (kind === "slash") soundsRef.current?.thud?.(0.25);
      },
    }) : null;
    setSquad(squadApi);
    (window as unknown as Record<string, unknown>).__citySquad = squadApi;

    // ---- Driving into the sea ------------------------------------------
    /**
     * Deep enough to drown a car. Below this you are fording a puddle at the
     * top of the beach, which should stay driveable — the shore shelves out
     * gently on purpose and a hard cutoff at the waterline would mean a kart
     * that dies the instant a wave washes over the sand.
     */
    const SINK_DEPTH = 1.6;
    /** Seconds from the hit to the driver bailing out. */
    const SINK_EJECT = 1.15;
    /** Seconds from the hit to a drowned kart being put back where it lives. */
    const SINK_RECOVER = 11;
    /** Seconds until the next audible bubble; see the note where it is used. */
    let bubbleSfx = 0;
    /** Have we announced the Deep on this descent? Re-arms when you leave. */
    let trenchGreeted = false;
    /**
     * How loud something at (x, z) should be, 0..1.
     *
     * `citySounds` has no panner and no listener — every sound is mixed
     * straight into one master gain — so distance is the caller's job, and
     * until now no caller did it. A kart sinking on the far side of the bay
     * bubbled in your ear at full volume for eleven seconds, which is what
     * "the water sound kept going after I left the water" actually was: not a
     * stuck filter, a wreck three hundred metres away that nobody had told the
     * audio engine about.
     *
     * Linear rather than inverse-square: this is a cartoon city, and a proper
     * physical falloff makes everything more than a few metres away inaudible,
     * which trades one wrong answer for a quieter one.
     */
    const earshot = (x: number, z: number, reach = 45) => {
      const d = Math.hypot(player.position.x - x, player.position.z - z);
      return THREE.MathUtils.clamp(1 - d / reach, 0, 1);
    };
    /** Eased nose-down angle per vehicle, written here, read by the mesh sync. */
    const kartPitchNow: number[] = kartStates.map(() => 0);
    const ease01 = (t: number) => {
      const x = THREE.MathUtils.clamp(t, 0, 1);
      return x * x * (3 - 2 * x);
    };

    /**
     * One vehicle, one frame, in or above the water.
     *
     * The whole reason this exists: `CollisionWorld` floors everything at y=0
     * so nothing can fall out of the world, and over open water that floor is
     * a phantom plate with no mesh under it. Every ground query a car makes
     * therefore answers "sea level, go ahead" — so before this, driving off
     * the quay put you on a two-tonne hovercraft, wheels spinning, crossing
     * the bay at thirty miles an hour on top of the waves. It is the loudest
     * remaining tell that the ocean is scenery.
     *
     * A sinking car opts out of that plate the same way a swimmer does, and
     * for the same reason.
     */
    const sinkTick = (k: (typeof kartStates)[number], i: number, dt: number) => {
      const seaTop = seaSurfaceAt(k.x, k.z, performance.now() * 0.001);
      const deep = waterDepthAt(k.x, k.z);

      if (k.sink === 0) {
        /**
         * Wading: in the water, not yet drowning.
         *
         * This whole branch is here because there used to be nothing between
         * the waterline and the sinking depth. You drove into the sea, the sea
         * ignored you completely for twenty metres, and then a wall of water
         * arrived out of nowhere — no first touch, no spray off the wheels,
         * no warning. The big splash was the ONLY splash, and it read as a
         * cutscene rather than as a consequence.
         *
         * The height test is doing real work: Vibe Island, Mars and the moons
         * all sit far offshore at their own altitudes, so `waterDepthAt` is
         * happily positive under all of them and a kart on the island lawn
         * would otherwise be permanently wading.
         */
        const atSeaLevel = k.y < seaTop + 0.6 && k.y > -40;
        if (atSeaLevel && deep > 0.1) {
          if (!k.wet) {
            k.wet = true;
            // The first touch. A quarter of the weight of the real thing, so
            // it reads as the moment the wheels find water rather than
            // stealing the plunge's thunder.
            const touch = Math.hypot(k.speed, k.vy);
            carSink.impact(k.x, seaTop, k.z, touch * 0.35);
            soundsRef.current?.splash?.(Math.min(0.6, 0.12 + touch / 55), earshot(k.x, k.z));
          }
          const truck = k.kind === "monster";
          // Eased, so rolling into the shallows is a settle and not a step.
          const wantWade = Math.min(deep, truck ? 2.4 : 1.2) * 0.5;
          k.wade += (wantWade - k.wade) * (1 - Math.pow(0.02, dt));
          carSink.wake(dt, k.x, seaTop, k.z, k.yaw, Math.abs(k.speed), deep, truck ? 1.45 : 0.55, truck ? 1.9 : 1);
          // Water is heavy. Wading scrubs speed off well before the depth
          // does anything, which is what makes the shallows feel like water
          // rather than like slightly damp road. Less so on 2 m tyres.
          k.speed *= Math.pow(Math.max(0.25, 1 - (deep / (truck ? 2.6 : 1)) * 0.5), dt);
        } else if (k.wet) {
          k.wet = false;
        }
        if (!k.wet && k.wade > 0) k.wade = Math.max(0, k.wade - dt * 1.5);
        // The monster truck fords: its axles are higher than a kart's roof.
        if (deep <= SINK_DEPTH * (k.kind === "monster" ? 1.8 : 1) || !atSeaLevel) return;
        k.sink = 1e-6;
        // Hand the settle over to the sink, which owns `y` from here.
        k.y -= k.wade;
        k.wade = 0;
        // Arriving fast is the whole joke, so the impact reads off the speed
        // it actually arrived with — forward and downward together, since
        // launching off a sea wall is mostly the second one.
        const hit = Math.hypot(k.speed, k.vy);
        // `carSink.impact` and nothing else. Firing the swimmer's `splash`
        // here as well seemed like free extra water and is not: it draws its
        // own four expanding rings on top of these two, and the six together
        // read as a bullseye painted on the sea. Its droplets are square
        // `Points` next to these soft ones, too. One effect, one look.
        carSink.impact(k.x, seaTop, k.z, hit);
        // And it does not survive the landing. Gated on arriving hard inside
        // `fireball`, so rolling gently off the sand gets a splash and keeps
        // its paint.
        carSink.fireball(k.x, seaTop, k.z, hit);
        soundsRef.current?.splash?.(Math.min(1, 0.5 + hit / 40), earshot(k.x, k.z));
        // The explosion is gated on the same speed the fireball is, so a
        // gentle roll-in gets a splash and no detonation to go with it.
        // A detonation carries further than a splash does.
        if (hit > 11) {
          soundsRef.current?.boom?.(Math.min(1, (hit - 11) / 20), earshot(k.x, k.z, 140));
        }
        // Nose-down and listing, rolled once so no two cars go down the same
        // way. Front-heavy: that is where the engine is.
        k.pitch = -(0.55 + Math.random() * 0.5);
        k.roll = (Math.random() - 0.5) * 0.7;
        // Punch it under. Two tonnes arriving at speed goes THROUGH the
        // surface and comes back up — without this the car sits dead level on
        // the water for the second it takes the flooding to ramp in, which is
        // the exact "driving on top of the sea" reading this replaced, just
        // briefer.
        k.vy = -(0.8 + Math.min(30, hit) * 0.1);
        return;
      }

      const prev = k.sink;
      k.sink += dt;

      /**
       * It keeps going. This is the line that decides where a car ends up.
       *
       * Killing the speed on impact is the obvious model and it puts every
       * car on the bottom at the exact spot it touched — which, because the
       * shore shelves gently on purpose, is always the shallowest water that
       * qualifies. Measured: a kart launched off the beach at 26 m/s stopped
       * dead and settled in 1.7 m, roof awash, technically sunk and reading
       * as a car parked in a puddle.
       *
       * Two tonnes at speed does not stop dead in water; it ploughs. So the
       * momentum carries, and it carries the car out down the shelf into
       * water deep enough to swallow it, which is both what happens and the
       * shot worth watching. Once it is dragging along the seabed the sand
       * takes the rest off it quickly.
       */
      const onBed = k.y <= -deep + 0.35;
      k.speed *= Math.pow(onBed ? 0.06 : 0.42, dt);
      k.x += Math.sin(k.yaw) * k.speed * dt;
      k.z += Math.cos(k.yaw) * k.speed * dt;

      /**
       * Plunge, bob, then go.
       *
       * A car does not sink the moment it lands and it does not sit on the
       * water either — it punches under, comes back up wallowing, and then
       * goes as the cabin fills. That middle beat is most of what makes the
       * sink read as something heavy rather than as an object being deleted
       * downward, and the recovery from the plunge is what makes it read as
       * floating rather than as hovering.
       *
       * So: buoyancy holds it just under the surface and FADES as it floods,
       * while the flooding rate takes over. The two crossing is the moment it
       * stops being a car in the water and starts being a wreck.
       */
      const flood = ease01((k.sink - 0.15) / 1.5);
      const lift = (1 - flood) * THREE.MathUtils.clamp((seaTop - 0.35 - k.y) * 5.5, -2.5, 7);
      const wantVy = lift - 3.4 * flood;
      k.vy += (wantVy - k.vy) * (1 - Math.pow(0.02, dt));
      k.y += k.vy * dt;

      // Down to the seabed, and no further. `waterDepthAt` is analytic and
      // keeps descending forever; the mesh under it does not, but out here it
      // now goes far enough to be the thing you land on.
      const bed = -deep;
      const settled = k.y <= bed + 0.2;
      if (settled) {
        k.y = bed + 0.2;
        k.vy = 0;
      }

      // Nose over. It starts the moment the front end digs in and holds
      // whatever attitude it settled into; `k.pitch` and `k.roll` were rolled
      // once at entry and are not re-randomised, or it would shimmy all the
      // way to the bottom.
      kartPitchNow[i] = k.pitch * ease01(k.sink / 1.6);

      // Air leaving it: hard at first, a trickle once it is on the bottom.
      // Emitted from below the waterline whatever the car is doing — while it
      // is still bobbing, `k.y + 0.5` is in the air, and bubbles born above
      // the sea are just white dots hanging over it.
      const rate = settled ? 5 : 34 * Math.exp(-k.sink * 0.35) + 6;
      if (k.sink < SINK_RECOVER) {
        carSink.bubble(dt, k.x, Math.min(k.y + 0.5, seaTop - 0.35), k.z, rate);
        /**
         * And you can hear them, at a small fraction of the visual rate.
         *
         * One sound per bubble would be thirty oscillators a second, which is
         * not a wreck venting air, it is a kettle. A few a second reads as the
         * same event and leaves room to hear anything else.
         */
        bubbleSfx -= dt;
        if (bubbleSfx <= 0) {
          soundsRef.current?.bubble?.(earshot(k.x, k.z, 28));
          bubbleSfx = 0.16 + Math.random() * 0.24;
        }
      }

      // Get out. Crossing the threshold once, not every frame after it.
      if (prev < SINK_EJECT && k.sink >= SINK_EJECT && drivingKartRef.current === i) {
        drivingKartRef.current = -1;
        setDrivingKart(-1);
        // Pushed off the roof and into the water, where swimming takes over.
        // Deliberately NOT `exitKartRef`: that releases a commandeered city
        // car back to the traffic fleet, which teleports it to the nearest
        // lane — so the car you just drowned reappears, dry, on the road,
        // while you are still watching the bubbles.
        player.position.set(k.x + Math.cos(k.yaw) * 1.4, seaTop + 0.2, k.z - Math.sin(k.yaw) * 1.4);
        vel.set(0, 1.5, 0);
        onGround = false;
        splash.burst(player.position.x, seaTop, player.position.z, 0.5);
      }

      // Give it back. A world that permanently loses one of its two karts to
      // the bay every time somebody tries this is a world that runs out of
      // karts, and the fix a player would reach for — swimming down to push
      // it home — is not a thing you can do.
      /**
       * Wait until nobody is watching, then put it back.
       *
       * The recovery is a teleport, and a kart that blinks out of existence
       * three metres in front of a player treading water over it is worse
       * than the problem it solves. So it needs both the timer AND some
       * distance — with a hard deadline, because "nobody is watching" is a
       * condition a player can hold false indefinitely by floating there, and
       * a kart that never comes back is the thing this exists to prevent.
       */
      const watcher = Math.hypot(player.position.x - k.x, player.position.z - k.z);
      if (k.sink >= SINK_RECOVER && (watcher > 30 || k.sink >= SINK_RECOVER * 3)) {
        k.sink = 0;
        k.wet = false;
        k.speed = 0;
        k.vy = 0;
        k.steer = 0;
        k.pitch = 0;
        k.roll = 0;
        kartPitchNow[i] = 0;
        if (k.ride >= 0) {
          // A city car rejoins the traffic fleet on its own, which snaps it to
          // the nearest lane — exactly the recovery this needs, for free.
          district.traffic.release(k.ride);
          k.ride = -1;
        } else if (k.home) {
          k.x = k.home.x;
          k.y = k.home.y;
          k.z = k.home.z;
          k.yaw = k.home.yaw;
        }
        return;
      }
    };

    // ---- Damage ---------------------------------------------------------
    /**
     * One hit on one of our vehicles. `surface` and `speed` decide the cost
     * (`impactDamage`); a short cooldown makes one scrape one hit rather than
     * one hit per frame of contact. Furniture passes `ignoreCool`, because
     * ploughing a row of three trees is three trees.
     */
    const hurtVehicle = (i: number, surface: ImpactSurface, speed: number, ignoreCool = false) => {
      if (i < 0) return;
      const k = kartStates[i];
      if (k.wreck > 0 || k.sink > 0) return;
      if (!ignoreCool && k.dmgCool > 0) return;
      const d = impactDamage(k.kind, surface, speed);
      if (d <= 0) return;
      k.hp = Math.max(0, k.hp - d);
      if (!ignoreCool) k.dmgCool = 0.25;
      if (i === drivingKartRef.current) setDriveHp(Math.round(k.hp));
      if (k.hp <= 0) blowUp(i);
    };
    /** The mower's answer to anything it touches: chew it up, keep going. */
    const shredFx = (x: number, y: number, z: number, fx: number, fz: number) => {
      crashFx.debris(x, y + 0.4, z, 6, 0x6fbf5a, 6);
      crashFx.debris(x, y + 0.5, z, 4, 0xb8bcc2, 8);
      crashFx.sparks(x, y + 0.5, z, fx, fz, 10);
      crashFx.leaves(x, y + 1, z, 8);
    };
    const wallHit = (k: (typeof kartStates)[number], impact: number) => {
      if (k.kind === "mower") {
        if (impact > 1) {
          shredFx(k.x + Math.sin(k.yaw) * 1.4, k.y, k.z + Math.cos(k.yaw) * 1.4, -Math.sin(k.yaw), -Math.cos(k.yaw));
          crashFx.kick(0.05);
        }
        return;
      }
      {
        const fx = Math.sin(k.yaw) * Math.sign(k.speed || 1);
        const fz = Math.cos(k.yaw) * Math.sign(k.speed || 1);
        const reach = VEHICLES[k.kind].reach + 0.6;
        if (mayhem.wall(k.x + fx * reach, k.y, k.z + fz * reach, impact, fx, fz)) {
          hurtVehicle(kartStates.indexOf(k), "blast", 18, true);
        }
      }
      if (impact > 5) {
        const fx = Math.sin(k.yaw);
        const fz = Math.cos(k.yaw);
        crashFx.sparks(k.x + fx * 1.2, k.y + 0.6, k.z + fz * 1.2, -fx, -fz, 6 + Math.round(impact / 2));
        crashFx.kick(Math.min(0.6, impact / 40));
        soundsRef.current?.thud?.(Math.min(1, 0.3 + impact / 30));
      }
      hurtVehicle(kartStates.indexOf(k), "wall", impact);
    };
    /**
     * Out of health: it goes up, you go flying, and so does everything near it.
     *
     * A city car stays behind as a burnt-out wreck in the fleet until it is
     * towed; the go-karts, the truck and the Comet lie upside down and
     * smoking where they landed, then reappear at their spot once you are out
     * of sight of them.
     */
    function blowUp(i: number) {
      const k = kartStates[i];
      if (k.wreck > 0) return;
      const spec = VEHICLES[k.kind];
      const { x, y, z } = k;
      crashFx.explode(x, y + 0.8, z, k.kind === "monster" ? 1.7 : 1.3, spec.paint);
      soundsRef.current?.boom?.(1, earshot(x, z, 160));
      district.traffic.blast(x, z, 11, 18);
      district.smash.blast(x, z, 9, 16);
      mayhem.ignite(x, z, 14);
      if (drivingKartRef.current === i) mayhem.crime(1);
      if (drivingKartRef.current === i) {
        drivingKartRef.current = -1;
        setDrivingKart(-1);
        player.position.set(x - Math.cos(k.yaw) * 1.8, y + 1.2, z + Math.sin(k.yaw) * 1.8);
        const a = Math.random() * Math.PI * 2;
        bowlOver(Math.cos(a), Math.sin(a), 15);
        toast("💥 Wrecked!", {
          description: k.ride >= 0
            ? "That car is toast. Grab another one."
            : `Your ${spec.label} exploded. It will be back at its spot soon.`,
        });
      }
      if (k.ride >= 0) {
        // Handed to the fleet as a burning wreck, right where it stands.
        district.traffic.detonate(k.ride, k.yaw + Math.PI);
        k.ride = -1;
        k.hp = MAX_HEALTH;
        k.speed = 0;
        return;
      }
      k.wreck = 1e-3;
      k.hp = 0;
      k.flip = 0;
      k.vy = 9;
      k.speed *= 0.3;
      if (k.mesh) scorch(k.mesh.group, true);
    }

    // ---- Simulation state ---------------------------------------------
    const vel = new THREE.Vector3();
    let onGround = true;
    let prevJetInput = false;
    let coyoteTimer = 0; // grace window so jumping just after leaving ground feels right
    let wallJumpUsed = false; // one parkour wall-jump per air phase
    let peakY = 0; // highest Y reached this air phase, for fall-damage
    /**
     * Seconds left of being bowled over by a car.
     *
     * While this is running you have no steering — you are a body that has
     * been hit, not a pedestrian who has decided to travel in that direction —
     * and the model tumbles. It runs out on its own; there is no getting-up
     * animation to wait for and nothing here can kill you.
     */
    let knockdown = 0;
    /** Tumble angle, so the avatar rolls rather than skidding upright. */
    let knockSpin = 0;
    let knockAxis = 0;
    /**
     * Registered here rather than where the district is built, because it
     * needs `vel` and `onGround` and those are declared with the rest of the
     * simulation state, a couple of thousand lines further down the file than
     * the scenery.
     */
    district.traffic.onPlayerHit((dx, dz, speed) => {
      // Not while you are in something. Being launched out of a car you are
      // driving because that car got rear-ended is a different feature and a
      // much more annoying one.
      if (drivingKartRef.current >= 0 || riding || swinging || ridingBad !== null) return;
      bowlOver(dx, dz, speed);
    });
    /** Sent flying: by a car, or by your own car exploding under you. */
    function bowlOver(dx: number, dz: number, speed: number) {
      const k = Math.min(1, speed / 13);
      // Sent the way the car was going, mostly, plus enough lift to leave the
      // ground — a pedestrian who slides along the tarmac reads as a physics
      // bug and one who goes over the bonnet reads as a consequence.
      vel.x = dx * (7 + speed * 0.9);
      vel.z = dz * (7 + speed * 0.9);
      vel.y = 5.5 + k * 4;
      onGround = false;
      coyoteTimer = 0;
      peakY = player.position.y;
      knockdown = 1.5 + k * 0.6;
      knockSpin = 0;
      // Tumble about whichever axis is across the direction of travel, so the
      // roll is over the bonnet rather than around the spine.
      knockAxis = Math.abs(dx) > Math.abs(dz) ? 1 : 0;
      soundsRef.current?.thud?.(Math.min(1, 0.5 + speed / 26));
      setDance(null);
    }
    /*
     * Bots crashing on their own: into buildings, furniture, each other, and
     * sometimes all the way to an explosion. The fleet only reports it; what
     * it looks and sounds like is decided here.
     */
    district.traffic.onCrash((e) => {
      const near = earshot(e.x, e.z, 70);
      switch (e.kind) {
        case "explode": {
          crashFx.explode(e.x, e.y, e.z, 1.1, 0x9aa2ab);
          mayhem.ignite(e.x, e.z, 12);
          soundsRef.current?.boom?.(0.9, earshot(e.x, e.z, 160));
          crashFx.kick(0.7 * earshot(e.x, e.z, 60));
          // Standing next to one is a bad idea.
          const d = Math.hypot(player.position.x - e.x, player.position.z - e.z);
          if (d < 7 && drivingKartRef.current < 0 && Math.abs(player.position.y - e.y) < 4) {
            bowlOver((player.position.x - e.x) / (d || 1), (player.position.z - e.z) / (d || 1), 14 * (1 - d / 7) + 4);
          } else if (d < 9 && drivingKartRef.current >= 0) {
            hurtVehicle(drivingKartRef.current, "blast", 30 * (1 - d / 9), true);
          }
          break;
        }
        case "car":
        case "wall":
          if (near > 0) {
            crashFx.sparks(e.x, e.y, e.z, 0, 0, 6 + Math.round(e.strength / 2));
            if (e.strength > 9) crashFx.debris(e.x, e.y, e.z, 3, 0x9aa2ab, 5);
            soundsRef.current?.thud?.(Math.min(1, 0.25 + e.strength / 30) * near);
          }
          break;
        case "prop":
          if (near > 0) {
            if (e.prop === "tree") crashFx.leaves(e.x, 3.5, e.z, 18);
            else crashFx.sparks(e.x, 1, e.z, 0, 0, 8);
            soundsRef.current?.thud?.(0.35 * near);
          }
          break;
        case "crush":
          crashFx.debris(e.x, e.y, e.z, 6, 0x9aa2ab, 4);
          break;
        case "skid":
          break;
      }
    });
    let ridingZeppelin = false; // standing on the circling zeppelin's deck
    let zeppelinToastShown = false;
    let zeppelinPilotToastShown = false;
    // Take / release the helm. Declared as a function so the keydown
    // handler above can call it (declarations hoist within the effect).
    function setZepPilotMode(on: boolean) {
      if (zepPilotRef.current === on) return;
      zepPilotRef.current = on;
      skyIslands.zeppelin.piloted = on;
      if (!on) skyIslands.zeppelin.control.throttle = 0;
      setZepMode(on ? "piloting" : ridingZeppelin ? "aboard" : "off");
      if (on && !zeppelinPilotToastShown) {
        zeppelinPilotToastShown = true;
        toast("🎈 You have the helm", {
          description: "W/S throttle · A/D rudder · Space up · C down · P to let go.",
        });
      }
    }
    zepHelmRef.current = setZepPilotMode;
    mountActionRef.current = (kind) => {
      if (kind && (drivingKartRef.current >= 0 || undergroundActiveRef.current || riding || swinging)) return;
      if (kind === null) {
        const was = activeMountRef.current;
        if (was === "helicopter" && mountFlight) {
          // It sets down where you are and waits there, rotor winding down.
          const f = mountFlight;
          const floor = Math.max(0, supportHeightAt(f.x, f.z, f.y));
          activeMountRef.current = null; setMountKind(null);
          mountFlight = null; skyTagRef.current = false; setSkyTagOn(false);
          heli.pose = { x: f.x, y: floor + 0.6, z: f.z, yaw: f.yaw, bank: 0, flap: false };
          parkedHeli = true;
          vel.set(0, 0, 0);
          player.position.set(f.x + Math.cos(f.yaw) * 2.6, floor + 0.1, f.z - Math.sin(f.yaw) * 2.6);
          peakY = player.position.y; camSnap = true;
          return;
        }
        if (was === "turkey" && mountFlight) {
          // The turkey stays where you get off it, like a car, rather than
          // flying home: hop off in the town and it waits for you there.
          const f = mountFlight;
          const floor = Math.max(0, supportHeightAt(f.x, f.z, f.y));
          activeMountRef.current = null; setMountKind(null);
          mountFlight = null; skyTagRef.current = false; setSkyTagOn(false);
          turkey.pose = { x: f.x, y: floor + 2.5, z: f.z, yaw: f.yaw, bank: 0, flap: false };
          turkey.group.visible = thanksRef.current;
          vel.set(0, 0, 0);
          player.position.set(f.x + Math.cos(f.yaw) * 3, floor + 0.1, f.z - Math.sin(f.yaw) * 3);
          peakY = player.position.y; camSnap = true;
          return;
        }
        activeMountRef.current = null; setMountKind(null);
        mountFlight = null; skyTagRef.current = false; setSkyTagOn(false);
        pegasus.pose = { ...PEGASUS_REST };
        dragon.pose = { x: ISLAND_X+12, y: ISLAND_TOP+2.5, z: ISLAND_Z+8, yaw: Math.PI, bank: 0, flap: false };
        vel.set(0, 0, 0);
        player.position.set(ISLAND_X+8, ISLAND_TOP+0.1, ISLAND_Z+6);
        peakY=player.position.y; camSnap=true;
        return;
      }
      arrivalStart=0; setZepPilotMode(false); setDance(null);
      const creature = creatureOf(kind);
      const near = player.position.distanceTo(creature.body.position) < 7;
      const base = near ? creature.body.position : player.position;
      // The turkey can be left anywhere, so it takes off from where it stands;
      // the other two only ever wait on the island.
      const startY = kind === "turkey" || kind === "helicopter" ? base.y : Math.max(base.y, ISLAND_TOP + 2.5);
      const startYaw = kind === "helicopter" ? (heli.pose?.yaw ?? HELI_REST.yaw) : camYaw + Math.PI;
      mountFlight={x:base.x,y:startY,z:base.z,yaw:startYaw,speed:kind === "turkey" ? 10 : kind === "helicopter" ? 0 : 22,lift:0,bank:0};
      if (kind === "helicopter" && !toldHeli) {
        toldHeli = true;
        toast("🚁 Helicopter", { description: "W/S forward and back, A/D turn, Space to climb, C to come down. F to land and hop out." });
      }
      if (kind === "turkey") soundsRef.current?.gobble();
      activeMountRef.current=kind; setMountKind(kind);
      player.position.set(mountFlight.x,mountFlight.y+MOUNT_SEAT,mountFlight.z);
      camDist=Math.max(camDist,12); camPitch=0.18; camSnap=true; vel.set(0,0,0);
    };
    // Cloud Kingdom: launches and cloud-trampoline bounces briefly lift
    // the vertical speed cap so you can actually reach the sky.
    let superBounceUntil = 0;

    /**
     * Swimming.
     *
     * Entering is a hysteresis band rather than a threshold: swim from 1.1 m of
     * water, stand up again at 0.85 m. One number for both and you get a
     * stutter every time the swell lifts and drops you across it, which on a
     * beach with a 30 cm swash is most of the shoreline most of the time.
     *
     * The sea is not part of the collision world — `CollisionWorld` floors
     * everything at y=0 so nobody can fall out of the world, and over water
     * that means standing on it. Rather than make the ocean solid for karts,
     * NPCs and everything else that queries support, the swimmer opts out of
     * that floor locally and is held up by buoyancy instead.
     */
    const SWIM_IN = 1.1;
    const SWIM_OUT = 0.85;
    let swimming = false;
    let swimWeight = 0;
    let swimProne = 0;
    /** DEV-only synthetic forward input; see `__citySwim`. */
    let devForward = 0;
    /** DEV-only frozen stroke phase; see `__citySwimPose`. */
    let devSwimPose: { phase: number; speed: number } | null = null;
    /**
     * DEV-only held dive, 0..1; see `__cityDive`.
     *
     * Diving is normally driven BY the camera aim, which means a harness can
     * never dive and look up at the same time — levelling the camera to shoot
     * Snell's window cancels the dive that put you under it, and you surface
     * mid-shot. This decouples the two for measurement only.
     */
    let devDive: number | null = null;
    /**
     * DEV-only held throttle for a kart; see `__cityDrive`.
     *
     * The sibling of `devForward` for swimming, and there for the same reason:
     * a harness pressing a real W key has to win a race against the keypress
     * actually arriving, and it lost. The kart was placed doing 26 m/s,
     * coasted for the second it took the key to land, and hit the water at 3 —
     * which made the impact look like it was not scaling with speed, when what
     * was broken was the measurement.
     */
    let devThrottle: number | null = null;
    /** Dev only: skip drawing so a harness can step the simulation at speed. */
    let devSkipRender = false;
    let swimKickTimer = 0;
    /**
     * Stroke phase, in cycles, ACCUMULATED — never derived from the clock.
     *
     * See the note on `SwimInput.phase`: a phase computed as clock x rate
     * teleports every time the rate changes, and the rate follows speed, which
     * follows the waves and the stick. It kept the pose valid and made the
     * motion nonsense.
     */
    let swimPhase = 0;
    /**
     * Speed, smoothed. It feeds how prone the body is, so raw speed makes a
     * swimmer pitch up and down every time a wave takes the edge off them.
     */
    let swimSpeedEased = 0;
    /**
     * How hard the swimmer is currently diving, 0..1, eased.
     *
     * There is no dive BUTTON. You aim the camera down and swim forward, which
     * is the gesture people already try, and it is reversible without thinking
     * about it: level the camera off and buoyancy — which is never switched
     * off, only turned down — floats you back up. That last part is the whole
     * safety argument for having no air meter. Nobody can get stuck down there
     * by letting go of the controls.
     */
    let diveEased = 0;
    /** How hard the swimmer is holding depth, 0..1, eased. See the glide note. */
    let glideEased = 0;
    const swimPose = createDancePose();
    let lastRebelShot = 0; // KeyF autofire cooldown
    let modelYaw = 0;
    let lastTime = performance.now();
    let riding = false; // on the zipline
    let zipAngle = 0;
    let swinging = false; // on the swing
    /** The bad guy whose roof you are on, by id. See `mayhem.ts`. */
    let ridingBad: number | null = null;
    let nearBadNow: number | null = null;
    let atHideout = false;
    /** Riding inside the car as its back-seat gunner, in first person. */
    let gunner = false;
    /** His car's heading last frame, so the view turns with the car. */
    let gunnerCarYaw = 0;
    let nearRideButton = false;
    const RIDE_BUTTON = hideouts.rideButton;
    /** Where the gunner sits: the back seat, a little behind the middle. */
    const gunnerSeat = (s: { x: number; z: number; yaw: number }) => ({
      x: s.x - Math.sin(s.yaw) * 0.85,
      y: 0.3,
      z: s.z - Math.cos(s.yaw) * 0.85,
    });
    badSummonRef.current = () => {
      const r = mayhem.summon();
      if (r === "ok") {
        soundsRef.current?.thud?.(0.6);
        toast("🦹 A bad guy is on the loose", {
          description: "He just tore out of the warehouse in an orange car, and the police are already after him. Catch up and press F to ride on his roof, or hit the red button inside the warehouse to ride shotgun.",
        });
      } else if (r === "full") {
        toast("🦹 Three bad guys are already out there", { description: "Wait for one of them to blow up." });
      } else {
        toast("No cars nearby to steal", { description: "Try again in a moment." });
      }
    };
    rideButtonRef.current = () => {
      if (ridingBad !== null || drivingKartRef.current >= 0 || activeMountRef.current) return;
      const id = mayhem.board(player.position.x, player.position.z);
      const s = id === null ? null : mayhem.seat(id);
      if (id === null || !s) {
        toast("🔴 Nobody to ride with", { description: "Try again in a moment." });
        return;
      }
      soundsRef.current?.thud?.(0.6);
      ridingBad = id;
      gunner = true;
      gunnerCarYaw = s.yaw;
      // Facing out of the back window to start with.
      camYaw = s.yaw;
      camPitch = 0.05;
      mayhem.crime(1);
      toast("🔴 You're riding shotgun", {
        description: isTouch
          ? "Drag to aim out of the back window and hold the fire button. Hop out when you've had enough."
          : "Drag to aim out of the back window, hold R or Q to shoot at the police. F hops out.",
      });
    };
    badRideRef.current = () => {
      if (ridingBad !== null) {
        const s = mayhem.seat(ridingBad);
        ridingBad = null;
        gunner = false;
        // Off the side, carrying the car's speed.
        if (s) {
          const rx = Math.cos(s.yaw);
          const rz = -Math.sin(s.yaw);
          player.position.set(s.x + rx * 2.2, s.y + 0.4, s.z + rz * 2.2);
          vel.set(Math.sin(s.yaw) * s.speed * 0.5 + rx * 3, 4, Math.cos(s.yaw) * s.speed * 0.5 + rz * 3);
        }
        onGround = false;
        return;
      }
      if (nearBadNow === null || drivingKartRef.current >= 0 || activeMountRef.current) return;
      ridingBad = nearBadNow;
      mayhem.crime(1);
      toast("🦹 You're riding with a bad guy", {
        description: "Hold R or Q to shoot from the roof. F or Space hops off. If his car blows up, so do you.",
      });
    };
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
        badPad: atHideout,
        nearBad: nearBadNow !== null,
        ridingBad: ridingBad !== null,
        nearRideButton,
        gunner: ridingBad !== null && gunner,
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
      setNearSkiGate(player.position.distanceTo(SKI_GATE) < 6);
      setNearSkiReturn(player.position.distanceTo(skiWorld.returnPortal) < 6);
      setOnPowderPeak(skiWorld.inZone(player.position.x, player.position.z));
      setMoonGolfHud(moonGolf.hudLine(player.position));
      {
        const rs = rebel.state();
        setRebelHud((prev) =>
          prev?.active === rs.active && prev?.wave === rs.wave && prev?.kills === rs.kills && prev?.hp === rs.hp
            ? prev
            : rs,
        );
        setNearBlasterRack(!rs.active && rebel.nearRack(player.position));
      }
      // Nearest city car you could get into — only while on the streets, and
      // only when one has actually stopped near you.
      setNearRide(() => {
        if (drivingKartRef.current >= 0) return (nearRideNow = -1);
        if (Math.abs(player.position.y) > 3) return (nearRideNow = -1);
        const r = district.traffic.nearestRidable(player.position.x, player.position.z, 6);
        return (nearRideNow = r ? r.id : -1);
      });
      // Nearest parked kart in hop-on range (hidden while driving).
      {
        let nk = -1;
        if (drivingKartRef.current < 0) {
          for (let i = 0; i < kartStates.length; i++) {
            const k = kartStates[i];
            if (!k.mesh) continue; // the ride slot has no parked model
            if (k.wreck > 0) continue; // burning on its roof: not a ride
            if (
              Math.hypot(player.position.x - k.x, player.position.z - k.z) < 5 &&
              Math.abs(player.position.y - k.y) < 4
            ) { nk = i; break; }
          }
        }
        setNearKart(nk);
        nearKartNow = nk;
      }
      setNearPortal(player.position.distanceTo(island.portal) < 5.5);
      setNearAvatarPortal(player.position.distanceTo(island.avatarPortal) < 5.5);
      setNearArcade(player.position.distanceTo(island.arcade) < 4);
      setNearRps(player.position.distanceTo(island.rpsTable) < 4);
      setNearTv(player.position.distanceTo(island.tv) < 5.5);
      setNearRadio(
        player.position.distanceTo(radioAnchors[0]) < 4.5 ||
          player.position.distanceTo(radioAnchors[1]) < 4.5,
      );
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


      // Same reach as the F key, so the prompt and the key always agree.
      setNearMount(
        activeMountRef.current || drivingKartRef.current >= 0 ? null
          : nearestMount(player.position),
      );
      if (skyTagRef.current) {
        const sky=mp.skyState();
        setSkyStatus(!sky.online ? "Connecting…" : sky.players<2 ? "Waiting for another rider" : sky.self ? "You're IT — chase the other rider!" : `${sky.name ?? "Your friend"} is IT — fly away!`);
      }
      // Nearest chattable person (real player OR AI agent) within ~3.2m.
      const NEAR_RADIUS = 3.2;
      const nP = mpRef.current?.getNearestPlayer(player.position.x, player.position.y, player.position.z, NEAR_RADIUS) ?? null;
      const nA = agentResidentsRef.current?.getNearestAgent(player.position.x, player.position.y, player.position.z, NEAR_RADIUS) ?? null;
      // Tag mini-game: any real-player body inside ~1.6m counts as a tag
      // (per-player cooldown suppresses double-counting a hug). Also
      // ticks the game so streaks decay when you loiter.
      tagGameRef.current?.tick(performance.now());
      if (nP && nP.distSq < 1.6 * 1.6 && enteredRef.current) {
        tagGameRef.current?.tryTag(nP.ref, nP.name);
      }
      let pick: PersonTarget | null = null;
      if (nP && (!nA || nP.distSq <= nA.distSq)) {
        pick = { kind: "player", ref: nP.ref, name: nP.name };
      } else if (nA) {
        pick = { kind: "agent", ref: nA.agentId, name: nA.name };
      }
      if (activeMountRef.current) pick=null;
      setNearPerson((prev) => {
        if (!prev && !pick) return prev;
        if (prev && pick && prev.kind === pick.kind && prev.ref === pick.ref && prev.name === pick.name) return prev;
        return pick;
      });
      // Near the Graffiti Wall? (island top only)
      {
        const gdx = player.position.x - (ISLAND_X + SITE.graffitiWall.x);
        const gdz = player.position.z - (ISLAND_Z + SITE.graffitiWall.z);
        setNearGraffiti(
          player.position.y > ISLAND_TOP - 5 && gdx * gdx + gdz * gdz < 5 * 5,
        );
      }
      // Near the newsstand?
      {
        const ndx = player.position.x - (ISLAND_X + SITE.newsstand.x);
        const ndz = player.position.z - (ISLAND_Z + SITE.newsstand.z);
        setNearNews(
          player.position.y > ISLAND_TOP - 5 && ndx * ndx + ndz * ndz < 5 * 5,
        );
      }
      // Near the studio embassy?
      {
        const sdx = player.position.x - (ISLAND_X + SITE.studioEmbassy.x);
        const sdz = player.position.z - (ISLAND_Z + SITE.studioEmbassy.z);
        setNearStudio(
          player.position.y > ISLAND_TOP - 5 && sdx * sdx + sdz * sdz < 6 * 6,
        );
      }
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
        p.set(ISLAND_X + SPAWN.x, ISLAND_TOP + 6, ISLAND_Z + SPAWN.z);
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
      player.position.set(ISLAND_X + SPAWN.x, ISLAND_TOP + 0.4, ISLAND_Z + SPAWN.z);
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
    // /city?spawn=hub — the default landing for new arrivals. Drop beside
    // an active player when anyone's around (land in the thick of it);
    // otherwise open on Vibe Island — the flagship welcome (Jack's call:
    // "loading in for the first time, I'd rather spawn on the island").
    hubSpawnRef.current = () => {
      const occupants: { x: number; y: number; z: number }[] = [];
      mp.forEachOccupant((x, y, z) => occupants.push({ x, y, z }));
      if (occupants.length === 0) {
        // First load / nobody around → Vibe Island with its arrival cinematic.
        islandSpawnRef.current?.();
        setArriving(true);
        return;
      }
      // Someone's already here → drop into the action beside them.
      const target = pickHubSpawn(occupants, {
        x: ISLAND_X,
        y: ISLAND_TOP + 0.4,
        z: ISLAND_Z + SPAWN.z,
      });
      player.position.set(target.x, target.y, target.z);
      vel.set(0, 0, 0);
      onGround = false;
      // Open facing the avatar's front; the chase-cam swings behind as
      // soon as they move or drag.
      camYaw = 0;
      camPitch = 0.16;
      camDist = 8.5;
      camera.position.set(
        player.position.x + Math.sin(camYaw) * Math.cos(camPitch) * camDist,
        player.position.y + Math.sin(camPitch) * camDist + 1.4,
        player.position.z + Math.cos(camYaw) * Math.cos(camPitch) * camDist,
      );
      camera.lookAt(player.position.x, player.position.y + 1.2, player.position.z);
    };
    // /city?spawn=moon drops visitors onto the moon's landing pad.
    // /city?spawn=club drops visitors straight inside THE BASEMENT.
    clubSpawnRef.current = () => {
      player.position.copy(club.spawn);
      vel.set(0, 0, 0);
      onGround = true;
      camYaw = 0; // looking at the floor and the DJ, not at the back wall
    };
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
      // Fresh run: full hearts, empty scoreboard.
      minesHeartsRef.current = MINES_HEARTS;
      bossWarnRef.current = false;
      setMinesHearts(MINES_HEARTS);
      setMinesStomps(0);
      setMinesGold(0);
      setMinesKo(0);
      setBossWarning(false);
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
      bossWarnRef.current = false;
      setUnderground(false);
      setBossWarning(false);

      // Reset the mines so the next run starts fresh.
      undergroundWorld.reset();
      setBossHp(undergroundWorld.bossHpRemaining());
      minesHeartsRef.current = MINES_HEARTS;
      setMinesHearts(MINES_HEARTS);
    };


    // __cityDebug.teleport(330, 130, -30) drops you over the island.
    // __cityDebug.zeppelin() returns the live deck center [x, y, z].
    // player() / setCam() exist so headless tests can assert and frame.
    const devWindow = window as unknown as {
      __cityDebug?: {
        teleport: (x: number, y: number, z: number) => void;
        mount: (kind: MountKind | null) => void;
        mountState: () => { kind: MountKind | null; flight: FlightState | null; };
        skyTag: (on: boolean) => void;
        skyState: () => ReturnType<typeof mp.skyState>;
        peerStates: () => ReturnType<typeof mp.peerStates>;
        identity: (name: string, character: string) => void;
        mountPose: (x: number, y: number, z: number) => void;
        zeppelin: () => [number, number, number];
        player: () => [number, number, number];
        setCam: (yaw: number, pitch?: number, dist?: number) => void;
        emblemFun: () => void;
        support: (x: number, y: number, z: number) => number;
        boxesNear: (x: number, z: number) => Array<Record<string, number>>;
        mines: () => [boolean, boolean, number, number, number];
        minesRun: () => {
          hearts: number; bossHp: number; boss: string; bossDist: number;
          bossAt: [number, number, number];
        };
        snapshot: (near?: number) => string;
        camPose: () => {
          near: number; dist: number; pitch: number; yaw: number;
          x: number; y: number; z: number; px: number; py: number; pz: number;
        };
        heistGo: () => void;
        heistPos: () => [number, number, number] | null;
        rebelRemote: (ev: RebelEvent) => void;
        rebelState: () => { active: boolean; wave: number; kills: number; hp: number; seed: number };
        addVibe: (n: number) => void;
        residentNear: (x: number, z: number) => { name: string; x: number; y: number; z: number } | null;
        atmos: () => Record<string, unknown>;
        /**
         * The state of THE BASEMENT's two doors.
         *
         * Exposed because the cooldown that stops them ping-ponging is counted
         * in SIMULATED seconds, and a headless harness on a software renderer
         * gets about fifteen milliseconds of those per wall-clock second — so
         * `sleep(4000)` after stepping on a pad proves nothing, and reported
         * both doors as broken when both worked. A harness should wait for the
         * condition, not for a guess at how long it takes.
         */
        clubDoor: () => { cool: number; onGround: boolean; dStair: number; dExit: number };
      };
    };
    devWindow.__cityDebug = {
      mount: (kind) => mountActionRef.current?.(kind),
      mountState: () => ({kind:activeMountRef.current,flight:mountFlight ? {...mountFlight} : null}),
      skyTag: (on) => { skyTagRef.current=on; setSkyTagOn(on); },
      skyState: () => mp.skyState(),
      peerStates: () => mp.peerStates(),
      identity: (name, character) => {
        mp.setName(name); setPlayerName(name);
        charRef.current=character; setCharName(character); loadPilotRef.current?.(character);
      },
      mountPose: (x,y,z) => {
        if (mountFlight) { mountFlight.x=x; mountFlight.y=y-MOUNT_SEAT; mountFlight.z=z; }
        player.position.set(x,y,z); vel.set(0,0,0);
        mp.update(0.05,{x,y,z,yaw:mountFlight?.yaw ?? modelYaw,air:!!mountFlight,char:charRef.current,mount:activeMountRef.current,skyTag:skyTagRef.current});
      },
      teleport: (x, y, z) => {
        player.position.set(x, y, z);
        vel.set(0, 0, 0);
      },
      clubDoor: () => ({
        cool: +clubDoorCooldown.toFixed(3),
        onGround: onGroundForDebug,
        dStair: +player.position.distanceTo(STAIR).toFixed(2),
        dExit: +player.position.distanceTo(club.exit).toFixed(2),
      }),
      zeppelin: () => {
        const z = skyIslands.zeppelin;
        return [z.pos.x, z.pos.y + z.deckY, z.pos.z];
      },
      /**
       * What the atmosphere ACTUALLY is right now.
       *
       * Reading an underwater scene off a screenshot does not work. "The
       * seabed looks too bright and unfogged" has at least four causes that
       * produce the same picture — fog not reaching the material, the fog
       * range not collapsing, the key light not being absorbed, or the sand
       * simply being a pale colour — and picking between them by eye is how an
       * afternoon disappears. These are the numbers.
       */
      atmos: () => {
        const f = scene.fog as THREE.Fog;
        const bed = ocean.bedMaterial as THREE.MeshStandardMaterial;
        return {
          fogNear: f.near,
          fogFar: f.far,
          fogColor: `#${f.color.getHexString()}`,
          background: `#${(scene.background as THREE.Color).getHexString()}`,
          ambient: `${ambient.intensity.toFixed(2)} #${ambient.color.getHexString()}`,
          hemi: `${hemi.intensity.toFixed(2)} #${hemi.color.getHexString()}`,
          sun: `${moonlight.intensity.toFixed(2)} #${moonlight.color.getHexString()}`,
          // The seabed's own material, since it is the thing being judged.
          bedFog: bed.fog,
          bedColor: `#${bed.color.getHexString()}`,
          bedVertexColors: bed.vertexColors,
        };
      },
      player: () => [player.position.x, player.position.y, player.position.z],
      setCam: (yaw, pitch, dist) => {
        camYaw = yaw;
        if (pitch !== undefined) camPitch = pitch;
        if (dist !== undefined) camDist = dist;
      },
      emblemFun: () => triggerEmblemFun(),
      // Physics probes for headless ground-truth tests.
      support: (x, y, z) => supportHeightAt(x, z, y),
      boxesNear: (x, z) =>
        boxes
          .filter(
            (b) =>
              x >= b.minX - 2 && x <= b.maxX + 2 && z >= b.minZ - 2 && z <= b.maxZ + 2,
          )
          .map((b) => ({ ...b })),
      mines: () => [
        undergroundWorld.isInside(player.position),
        undergroundActiveRef.current,
        undergroundWorld.spawn.x,
        undergroundWorld.spawn.y,
        undergroundWorld.spawn.z,
      ],
      // Live run state, so a headless play-test can assert that the
      // clan actually lands hits and the boss actually charges.
      minesRun: () => {
        const bp = undergroundWorld.bossPos();
        return {
          hearts: minesHeartsRef.current,
          bossHp: undergroundWorld.bossHpRemaining(),
          boss: undergroundWorld.bossPhase(),
          bossDist: Math.hypot(bp.x - player.position.x, bp.z - player.position.z),
          bossAt: [bp.x, bp.y, bp.z] as [number, number, number],
        };
      },
      // Render one fresh frame and read it back in the same task —
      // works without preserveDrawingBuffer, so headless tests can
      // take reliable stills of the world.
      /**
       * Render one frame right now and read the canvas back.
       *
       * `near` re-renders the SAME frame with a different near plane, which is
       * the only way to see z-fighting in a still: two surfaces at the same
       * depth pick a winner and hold it, so a frozen frame looks fine and the
       * shimmer only appears once the camera moves. Nudge the near plane by a
       * hair and every pixel whose winner depended on depth precision swaps —
       * with nothing else in the world having moved, since both renders happen
       * inside one synchronous call. See `scripts/city-flicker.mjs`.
       */
      snapshot: (near?: number) => {
        const prev = camera.near;
        if (near !== undefined) {
          camera.near = near;
          camera.updateProjectionMatrix();
        }
        renderer.render(scene, camera);
        const url = canvas.toDataURL("image/png");
        if (near !== undefined) {
          camera.near = prev;
          camera.updateProjectionMatrix();
        }
        return url;
      },
      /**
       * Where the camera actually IS, as opposed to where it was told to go.
       *
       * `__cityCam` is a request, not a guarantee: the arrival swoop, fast
       * travel and the kart chase all drive the camera too, and any of them
       * firing mid-run silently rehomes it. A harness that cannot read the
       * pose back cannot tell a fixed camera from a drifting one — which is
       * how a flicker measurement came back saying a fix had made things
       * worse, when what had actually changed was the zoom.
       */
      camPose: () => ({
        near: camera.near,
        dist: camDist,
        pitch: camPitch,
        yaw: camYaw,
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
        // The player too, so a harness can tell "posed" from "arrived": the
        // chase camera EASES to its target, and the requested distance is only
        // real once the camera is actually that far from what it is orbiting.
        px: player.position.x,
        py: player.position.y,
        pz: player.position.z,
      }),
      heistGo: () => {
        chaseNextAt = 0;
      },
      heistPos: () => {
        if (!heistChase.isActive()) return null;
        const p = heistChase.pos();
        return [p.x, p.y, p.z];
      },
      rebelRemote: (ev) => rebelRemoteRef.current?.(ev),
      rebelState: () => rebel.state(),
      // Test aid: grant ✦ so economy features (SnackFe, shop) can be
      // exercised headlessly without grinding gems first.
      addVibe: (n: number) => {
        vibeBalanceRef.current = Math.max(0, vibeBalanceRef.current) + n;
        setVibeBalanceTick((k) => k + 1);
      },
      // Test aid: locate the nearest AI resident so headless runs can
      // frame its name label without knowing where it wandered.
      residentNear: (x: number, z: number) => {
        const n = agentResidents.getNearestAgent(x, 0, z, 99999);
        if (!n) return null;
        const p = agentResidents.getAgentPosition(n.agentId);
        return p ? { name: n.name, x: p.x, y: p.y, z: p.z } : null;
      },
    };

    // ---- /live: the world streams itself -----------------------------
    // An AI director cuts between residents and points of interest, and
    // the event stream feeds both the cuts and the broadcast ticker.
    let liveDirector: ReturnType<typeof createLiveDirector> | null = null;
    let liveFeed: ReturnType<typeof createWorldEventFeed> | null = null;
    if (isLive) {
      liveDirector = createLiveDirector({
        moveTo: (x, y, z) => {
          player.position.set(x, y, z);
          vel.set(0, 0, 0);
        },
        aim: (yaw, pitch, dist) => {
          camYaw = yaw;
          if (pitch !== undefined) camPitch = pitch;
          if (dist !== undefined) camDist = dist;
        },
        cast: () => agentResidents.listAgents(),
        pois: [
          [ISLAND_X + SPAWN.x, ISLAND_TOP, ISLAND_Z + SPAWN.z, "the plaza"],
          [ISLAND_X + SITE.graffitiWall.x, ISLAND_TOP, ISLAND_Z + SITE.graffitiWall.z, "the graffiti wall"],
          [ISLAND_X + SITE.newsstand.x, ISLAND_TOP, ISLAND_Z + SITE.newsstand.z, "the newsstand"],
          [ISLAND_X + SITE.rosterBoard.x, ISLAND_TOP, ISLAND_Z + SITE.rosterBoard.z, "the roster board"],
          [ISLAND_X + SITE.studioEmbassy.x, ISLAND_TOP, ISLAND_Z + SITE.studioEmbassy.z, "the studio embassy"],
        ],
        onShot: (label) => setLiveShot(label),
      });
      liveFeed = createWorldEventFeed({
        onEvent: (ev) => {
          liveDirector?.notify(ev);
          const line = tickerLine(ev);
          if (line) setLiveLines((prev) => [...prev.slice(-5), line]);
        },
      });
    }

    const disposeVR = enableVR(renderer, canvas.parentElement!, {
      referenceSpace: "local-floor",
    });

    const tick = () => {
      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      // At a Vibe Arcade cabinet the game in the frame gets the whole GPU;
      // the city holds still underneath and picks up where it left off.
      if (cabinetOpenRef.current) return;

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
          ensureAudioRef.current?.();
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
      // ---- Zeppelin helm ------------------------------------------------
      // While piloting, the same sticks/keys fly the airship instead of
      // walking the body: the player is glued to the deck by the ride code
      // below, so any walk intent would just march them off the edge.
      const piloting = zepPilotRef.current && ridingZeppelin;
      if (zepPilotRef.current && !ridingZeppelin) setZepPilotMode(false);
      {
        const zc = skyIslands.zeppelin.control;
        if (piloting) {
          const kf = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
          const ks = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
          zc.throttle = THREE.MathUtils.clamp(kf + (touchLen > 0.12 ? -tm.y : 0), -0.4, 1);
          zc.turn = THREE.MathUtils.clamp(ks + (touchLen > 0.12 ? tm.x : 0), -1, 1);
          zc.climb = (keys.has("Space") || touchJetRef.current ? 1 : 0) - (keys.has("KeyC") ? 1 : 0);
        } else {
          zc.throttle = 0;
          zc.turn = 0;
          zc.climb = 0;
        }
      }
      const intent = new THREE.Vector3();
      if (enteredRef.current && !piloting && !activeMountRef.current) {
        if (keys.has("KeyW") || keys.has("ArrowUp")) intent.add(fwd);
        if (keys.has("KeyS") || keys.has("ArrowDown")) intent.sub(fwd);
        if (keys.has("KeyD") || keys.has("ArrowRight")) intent.add(right);
        if (keys.has("KeyA") || keys.has("ArrowLeft")) intent.sub(right);
        if (touchLen > 0.12) {
          intent.addScaledVector(fwd, -tm.y);
          intent.addScaledVector(right, tm.x);
        }
      }
      // Dev-only: a synthetic hold on "forward", so a screenshot harness can
      // photograph a stroke at speed without simulating a keyboard. Stripped
      // from production — `devForward` is only ever written by a DEV block.
      if (devForward > 0) intent.addScaledVector(fwd, devForward);
      // Full thumbstick deflection runs, like holding Shift.
      const running = keys.has("ShiftLeft") || keys.has("ShiftRight") || touchLen > 0.92;
      const jetInput = enteredRef.current && !piloting && !activeMountRef.current && (keys.has("Space") || touchJetRef.current);
      // The Gremlin Mines deaden the jetpack — you fight on foot down there.
      const undergroundNow = undergroundActiveRef.current;
      const thrusting = jetpackEquipped && jetInput && !undergroundNow;
      // Parkour mode: no jetpack (or underground) means Space becomes a jump.
      const wantsJump = (!jetpackEquipped || undergroundNow) && jetInput;

      // Knocked over: no steering. A body that has just been hit by a bus does
      // not get to change its mind about which way it is going, and letting it
      // is what turns the whole thing from a consequence into a bump.
      if (knockdown > 0) intent.set(0, 0, 0);
      if (intent.lengthSq() > 0) intent.normalize();
      const matchCap = landmarksRef.current?.speedCap() ?? null;
      const targetSpeed = Math.min(
        onGround
          ? running ? RUN_SPEED : WALK_SPEED
          : running ? FLY_RUN_SPEED : FLY_SPEED,
        // On the pitch in a Vibe Commons Cup match you run at a footballer's
        // pace, not a superhero's: 16 m/s crosses the pitch in a second and a half.
        matchCap ?? Infinity,
      );

      const pos = player.position;
      if (mountFlight && activeMountRef.current) {
        const control={
          throttle:(keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0)-(keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0)-tm.y,
          steer:(keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0)-(keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0)+tm.x,
          flap:keys.has("Space") || touchJetRef.current,
          dive:keys.has("KeyC") || diveMountRef.current,
        };
        const floor=supportHeightAt(mountFlight.x,mountFlight.z,mountFlight.y);
        stepMount(mountFlight,control,dt,Math.max(0,floor),activeMountRef.current);
        pos.set(mountFlight.x,mountFlight.y+MOUNT_SEAT,mountFlight.z);
        vel.set(Math.sin(mountFlight.yaw)*mountFlight.speed,mountFlight.lift,Math.cos(mountFlight.yaw)*mountFlight.speed);
        onGround=false; peakY=pos.y;
        const creature=creatureOf(activeMountRef.current);
        creature.pose={x:mountFlight.x,y:mountFlight.y,z:mountFlight.z,yaw:mountFlight.yaw,bank:mountFlight.bank,flap:control.flap};
        let turn=mountFlight.yaw+Math.PI-camYaw;
        turn=Math.atan2(Math.sin(turn),Math.cos(turn));
        camYaw+=turn*(1-Math.exp(-4*dt));
      } else if (ridingBad !== null) {
        // On a bad guy's roof. His car owns your position; Space hops off.
        const s = mayhem.seat(ridingBad);
        if (!s) {
          ridingBad = null;
          gunner = false;
        } else if (gunner) {
          // In the back seat. The view turns with the car.
          const g = gunnerSeat(s);
          pos.set(g.x, g.y, g.z);
          vel.set(0, 0, 0);
          onGround = false;
          peakY = pos.y;
          let turn = s.yaw - gunnerCarYaw;
          turn = Math.atan2(Math.sin(turn), Math.cos(turn));
          camYaw += turn;
          gunnerCarYaw = s.yaw;
          modelYaw = camYaw + Math.PI;
        } else {
          pos.set(s.x, s.y, s.z);
          vel.set(0, 0, 0);
          onGround = false;
          peakY = pos.y;
          modelYaw = s.yaw;
          if (jetInput) badRideRef.current?.();
        }
      } else if (swinging) {
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
        /**
         * Going down. `sinkTick` owns the vehicle from here — position, sink
         * rate and attitude — so everything below is skipped rather than
         * fighting it: the throttle would keep driving it forward through the
         * seabed and the ground follow would snap it straight back up to the
         * phantom sea-level plate it is supposed to have fallen through.
         *
         * Steering is dead too. A car in the water is not a boat, and being
         * able to drive it around down there would undo the whole point.
         */
        const drowning = kart.sink > 0;
        // On the Kart GP grid during the countdown: engine revs, kart stays.
        const gridHold = drivingKartRef.current === 0 && race.holding();
        if (gridHold) kart.speed = 0;
        const thIn = drowning || gridHold ? 0 : devThrottle ?? THREE.MathUtils.clamp(
          ((keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) -
            (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0)) +
            (touchLen > 0.12 ? -tm.y : 0),
          -1, 1,
        );
        const stIn = drowning ? 0 : THREE.MathUtils.clamp(
          ((keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) -
            (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0)) +
            (touchLen > 0.12 ? tm.x : 0),
          -1, 1,
        );
        const spec = VEHICLES[kart.kind];
        if (kart.dmgCool > 0) kart.dmgCool -= dt;
        if (!drowning) {
        // Throttle + rolling drag (heavier drag when coasting).
        const KART_MAX = running ? spec.boost : spec.max;
        kart.speed += thIn * spec.accel * dt;
        kart.speed -= kart.speed * (thIn === 0 ? 1.5 : 0.22) * dt;
        // Over the limit (the afterburner just let go) bleeds off rather than
        // snapping down, so letting go of Shift is a coast, not a wall.
        if (kart.speed > KART_MAX) kart.speed = Math.max(KART_MAX, kart.speed - 30 * dt);
        kart.speed = THREE.MathUtils.clamp(kart.speed, -9, Math.max(KART_MAX, kart.speed));
        // Steering strength scales up with speed, flips in reverse.
        kart.steer += (stIn - kart.steer) * Math.min(1, dt * 10);
        const grip = THREE.MathUtils.clamp(Math.abs(kart.speed) / spec.gripSpeed, 0, 1);
        // On a Soaker puddle the wheel does nothing for a moment: it spins
        // and carries on the way it was going.
        const slipping = kartSlip.kart === kart && kartSlip.t > 0;
        if (slipping) {
          kartSlip.t -= dt;
          kart.yaw += kartSlip.spin * dt;
        } else {
          kart.yaw -= kart.steer * spec.steer * grip * Math.sign(kart.speed || 1) * dt;
        }
        // Integrate with the same axis-separated wall sliding players use.
        const headYaw = slipping ? kartSlip.yaw : kart.yaw;
        const kdx = Math.sin(headYaw) * kart.speed * dt;
        const kdz = Math.cos(headYaw) * kart.speed * dt;
        const knx = kart.x + kdx;
        const knz = kart.z + kdz;
        /**
         * Bumper cars.
         *
         * `blockedAt` says something is in the way; it does not say what, and
         * before this nothing asked. So running into a parked Nissan and
         * running into a granite office block were the same event — you
         * stopped dead, which is the least interesting thing that can happen
         * in a car, and the city's ninety-odd vehicles were effectively
         * street furniture.
         *
         * Now a car in the way gets hit. It leaves its lane, goes up and away
         * carrying the momentum you gave it, tumbles, lands, and drives off
         * again. You keep most of your speed, because the whole point is that
         * you can plough through a junction.
         */
        const nose = kart.y + spec.nose;
        /*
         * Street furniture first: it is not in the collision world at all, so
         * nothing below would ever notice it. Down it goes, and it costs a
         * little each time — which is what makes "hit too many things and it
         * blows up" true without any one tree being lethal.
         */
        if (kart.y < 2 && Math.abs(kart.speed) > 3) {
          const fwdX = Math.sin(kart.yaw) * Math.sign(kart.speed);
          const fwdZ = Math.cos(kart.yaw) * Math.sign(kart.speed);
          const fell = district.smash.hit(
            knx + fwdX * 0.9, knz + fwdZ * 0.9, spec.crushes ? 1.7 : 1.0,
            fwdX, fwdZ, Math.abs(kart.speed),
          );
          for (const f of fell) {
            mayhem.crime(0.1);
            hurtVehicle(drivingKartRef.current, f.kind as ImpactSurface, Math.abs(kart.speed), true);
            if (kart.kind === "mower") shredFx(f.x, kart.y, f.z, fwdX, fwdZ);
            if (f.kind === "tree") crashFx.leaves(f.x, 3.5, f.z, 22);
            else crashFx.sparks(f.x, 0.8, f.z, fwdX, fwdZ, 10);
            kart.speed *= spec.crushes || kart.kind === "mower" ? 0.97 : 0.86;
            soundsRef.current?.thud?.(Math.min(0.7, 0.2 + Math.abs(kart.speed) / 50));
            crashFx.kick(spec.crushes ? 0.04 : 0.1);
          }
        }
        /*
         * Probe from the front bumper, not the middle. A four-metre car probed
         * at its centre has buried half its bonnet in whatever it hits before
         * anything notices, and a monster truck its whole front axle.
         */
        const dirSign = Math.sign(kart.speed || 1);
        const rx = Math.sin(kart.yaw) * spec.reach * dirSign;
        const rz = Math.cos(kart.yaw) * spec.reach * dirSign;
        const blockedV = (x: number, z: number) => blockedAt(x + rx, z + rz, nose);
        // Generous on purpose: the collision world pads every box by the
        // player's radius, and a car found by `blockedAt` but missed here by a
        // few centimetres used to be scored as a wall.
        const hitId = blockedV(knx, knz)
          ? district.traffic.carAt(knx + rx, knz + rz, nose, 1.0)
          : -1;
        if (hitId >= 0 && spec.crushes) {
          /*
           * The monster truck does not shove cars, it goes over them. The car
           * is flattened where it stands and stays a wreck you can drive on;
           * the truck lurches up onto it.
           */
          district.traffic.crush(hitId);
          mayhem.crime(0.5);
          kart.x = knx;
          kart.z = knz;
          kart.vy = Math.max(kart.vy, 3.5);
          kart.y += 0.15;
          kart.speed *= 0.9;
          crashFx.debris(knx, 0.8, knz, 8, 0x9aa2ab, 5);
          crashFx.sparks(knx, 0.6, knz, 0, 0, 16);
          crashFx.kick(0.25);
          soundsRef.current?.thud?.(0.9);
        } else if (hitId >= 0) {
          const impactSpeed = Math.abs(kart.speed);
          // Scaled off how hard you arrived, and always worth SOMETHING —
          // nudging a car at walking pace should still shift it, or the rule
          // becomes "fast cars pass through, slow cars are blocked", which is
          // worse than the behaviour it replaced.
          district.traffic.shove(
            hitId,
            Math.sin(kart.yaw) * Math.sign(kart.speed || 1),
            Math.cos(kart.yaw) * Math.sign(kart.speed || 1),
            3 + impactSpeed * 0.85,
          );
          // Through it. Barging costs a third of your speed, so a run down a
          // busy street bleeds off and you have to get back on the throttle.
          kart.x = knx;
          kart.z = knz;
          kart.speed *= 0.66;
          soundsRef.current?.thud?.(Math.min(1, 0.3 + impactSpeed / 34));
          // Both of you pay. Hard enough and the other car goes up.
          // A mower does not bounce off a car, it eats it.
          district.traffic.damage(hitId, kart.kind === "mower" ? 1000 : impactSpeed * 3.4);
          mayhem.crime(impactSpeed > 10 ? 0.45 : 0.2);
          if (kart.kind === "mower") {
            shredFx(knx + rx, kart.y, knz + rz, Math.sin(kart.yaw), Math.cos(kart.yaw));
            kart.speed = Math.max(kart.speed * 1.5, Math.min(8, spec.max));
          }
          hurtVehicle(drivingKartRef.current, "car", impactSpeed);
          crashFx.sparks(knx, 0.7, knz, Math.sin(kart.yaw), Math.cos(kart.yaw), 8 + Math.round(impactSpeed / 2));
          crashFx.kick(Math.min(0.5, impactSpeed / 60));
        } else if (!blockedV(knx, knz)) {
          kart.x = knx;
          kart.z = knz;
        } else if (!blockedV(knx, kart.z)) {
          // A glancing scrape along a wall: costs the part of the speed that
          // went into the wall, which is less than all of it.
          const scrape = Math.abs(kart.speed * Math.cos(kart.yaw));
          kart.x = knx;
          kart.speed *= 0.6;
          wallHit(kart, scrape);
        } else if (!blockedV(kart.x, knz)) {
          const scrape = Math.abs(kart.speed * Math.sin(kart.yaw));
          kart.z = knz;
          kart.speed *= 0.6;
          wallHit(kart, scrape);
        } else {
          wallHit(kart, Math.abs(kart.speed));
          kart.speed *= kart.kind === "mower" ? 0.4 : -0.25; // soft bounce off a dead-on wall
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
        }
        // Stand the driver on the rear deck; velocity mirrors the kart
        // so the run animation + exit momentum feel right.
        pos.set(kart.x, kart.y - kart.wade + spec.seat, kart.z);
        vel.set(Math.sin(kart.yaw) * kart.speed, 0, Math.cos(kart.yaw) * kart.speed);
        // Not standing on anything, once it is under: `onGround` gates the
        // jump, the landing thud and the walk animation, and a driver riding a
        // car to the seabed is doing none of those.
        onGround = !drowning;
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
      // Horizontal velocity: on Powder Peak snow you SKI — gravity
      // pulls along the slope gradient, momentum carries, and input
      // carves instead of teleporting your velocity. Everywhere else,
      // the usual ease-toward-intent walk.
      const onSnow =
        onGround && !undergroundNow && skiWorld.inZone(pos.x, pos.z) &&
        skiWorld.heightAt(pos.x, pos.z) !== null;
      if (onSnow) {
        const grad = skiWorld.gradientAt(pos.x, pos.z);
        vel.x += -grad.gx * 26 * dt;
        vel.z += -grad.gz * 26 * dt;
        const carve = running ? 16 : 10;
        vel.x += intent.x * carve * dt;
        vel.z += intent.z * carve * dt;
        const glide = Math.pow(0.55, dt); // low friction, keeps the run alive
        vel.x *= glide;
        vel.z *= glide;
        const sp = Math.hypot(vel.x, vel.z);
        const MAX_SKI = 38;
        if (sp > MAX_SKI) {
          vel.x *= MAX_SKI / sp;
          vel.z *= MAX_SKI / sp;
        }
      } else {
        // During a Cloud Kingdom launch/bounce with no input, keep the
        // ballistic momentum — the usual air easing was dragging the
        // launch drift to zero so you never reached the arrival cloud.
        const airK =
          now < superBounceUntil && intent.lengthSq() < 0.01
            ? 1 - Math.pow(0.7, dt)
            : 1 - Math.pow(0.05, dt);
        const k = swimming
          ? 1 - Math.pow(0.06, dt) // water: firmer than air, softer than tarmac
          : onGround
            ? 1 - Math.pow(0.0001, dt)
            : airK;
        const speedNow = swimming ? (running ? SWIM_SPRINT : SWIM_SPEED) : targetSpeed;
        vel.x += (intent.x * speedNow - vel.x) * k;
        vel.z += (intent.z * speedNow - vel.z) * k;
      }

      // ---- In the water? ------------------------------------------------
      const waterHere = waterDepthAt(pos.x, pos.z);
      const seaBed = -waterHere;
      const seaTop = seaSurfaceAt(pos.x, pos.z, now * 0.001);
      // Depth is measured to MEAN sea level, not to the instantaneous surface.
      // Offshore the swell is nearly two metres peak to trough, so a swimmer
      // sitting in a passing trough would otherwise be told the water had gone
      // shallow and asked to stand up in it.
      const deepEnough = waterHere > (swimming ? SWIM_OUT : SWIM_IN);
      // Only in the city's own ocean: the ski world, the moons and Mars all
      // live at their own altitudes and none of them is at sea level.
      /**
       * The −40 floor on swimming, and the one place it does not apply.
       *
       * It is there so the moons, Mars and a mineshaft under the ocean are not
       * treated as water. The trench is the exception the rule never
       * anticipated: eighty metres of genuine sea, straight down, at one point
       * offshore. Every bound in this file that assumes nobody is ever that
       * deep has to ask.
       */
      const inTrench = trench.inside(pos.x, pos.z);
      const atSeaLevel =
        pos.y < Math.max(seaTop, 0) + 0.6 && (pos.y > -40 || inTrench);
      const wantSwim =
        deepEnough && atSeaLevel && !undergroundNow && !riding && !swinging && drivingKartRef.current < 0 && !landmarks.holding();
      if (wantSwim && !swimming) {
        // Hitting the water is worth a noise and a splash proportional to how
        // hard you arrived; stepping in off the sand should barely ripple.
        const impact = Math.min(1, Math.max(0.12, (-vel.y - 1) / 22));
        splash.burst(pos.x, seaTop, pos.z, impact);
        // Water, not a landing. `thud` is a body hitting ground and it is what
        // stepping into the sea sounded like until there was anything better.
        soundsRef.current?.splash?.(0.15 + impact * 0.55);
        setDance(null);
        setInWater(true);
      } else if (!wantSwim && swimming) {
        splash.burst(pos.x, seaTop, pos.z, 0.25);
        soundsRef.current?.splash?.(0.3);
        setInWater(false);
      }
      swimming = wantSwim;
      // A wake, while there is something to make one with. Throttled rather
      // than per-frame: at sixty frames a second an emitter this cheap still
      // empties the pool in a second and a half and the entry splash stops
      // having any droplets left to use.
      if (swimming) {
        const swimSpd = Math.hypot(vel.x, vel.z);
        if (swimProne > 0.35 && swimSpd > 1.2) {
          swimKickTimer -= dt;
          if (swimKickTimer <= 0) {
            splash.kick(pos.x, seaTop, pos.z, Math.min(1, swimSpd / 4));
            swimKickTimer = 0.11;
          }
        }
      }

      // Vertical: buoyancy in water, gravity out of it.
      if (swimming) {
        onGround = false;
        wallJumpUsed = false;
        peakY = pos.y;
        /**
         * A prone swimmer rides with their back OUT of the water and a
         * treading one is out to the shoulders — not because that is prettier
         * but because the sea is an opaque sheet at any depth over about three
         * metres, and a body floating wholly beneath it is a body nobody can
         * see — the first cut of this rode twenty centimetres under and the
         * swimmer was simply not in the frame. The rig pivots near the feet,
         * so pitching the body prone lays it along the surface; sitting that
         * pivot slightly PROUD of the water is what puts the back and
         * shoulders above it, which is what a front crawl looks like.
         */
        const floatY = seaTop - THREE.MathUtils.lerp(1.15, -0.26, swimProne);
        /**
         * Eased toward a target RATE rather than sprung.
         *
         * A spring with linear damping (`vel *= 1 - dt * k`) is the obvious
         * shape and it goes wrong at large dt — the damping term reaches zero
         * at dt = 1/k and flips sign past it. `dt` is clamped to 0.05 here so
         * that is not reachable, but an exponential is the same length of code
         * and cannot be broken by a future clamp, and it makes the rise rate
         * something you can read off the line rather than derive.
         *
         * The clamp on the target rate is what makes entering fast read as a
         * plunge: you keep the speed you arrived with until the water has had
         * time to take it off you, rather than being caught at the surface.
         */
        /**
         * Diving: aim the camera down and swim forward.
         *
         * Buoyancy is turned DOWN, never off, and a modest sink rate is added
         * on top. Two consequences worth stating, because they are the design:
         * levelling the camera off floats you back to the surface with no
         * input at all, and holding the dive still leaves you rising slowly if
         * you stop swimming — so the sea can never trap anybody. There is no
         * air meter for the same reason.
         */
        const paddling = Math.min(1, Math.hypot(intent.x, intent.z));
        const wantDive =
          devDive ?? THREE.MathUtils.clamp((camPitch - 0.45) / 0.7, 0, 1) * paddling;
        diveEased += (wantDive - diveEased) * (1 - Math.pow(0.05, dt));
        /**
         * Gliding: swimming forward on a level camera holds your depth.
         *
         * Without this the sea has exactly two states — going down, or on your
         * way back up — because buoyancy is never off. That is the right answer
         * for safety and the wrong one for looking at anything: the moment you
         * stop aiming at the seabed you leave it, so you cannot swim ALONG the
         * bottom, which is what anybody down there actually wants to do.
         *
         * It is safe for the same reason the dive is. Gliding needs you to be
         * swimming; stop, and it decays and full buoyancy takes you up. Aiming
         * up does the same. There is still nothing you can hold that keeps you
         * under.
         */
        const levelish = THREE.MathUtils.clamp(1 - Math.abs(camPitch - 0.1) / 0.55, 0, 1);
        const wantGlide = paddling * levelish * (1 - diveEased);
        glideEased += (wantGlide - glideEased) * (1 - Math.pow(0.05, dt));
        const buoyK = THREE.MathUtils.lerp(5.5, 0.7, Math.max(diveEased, glideEased));
        const rise = THREE.MathUtils.clamp((floatY - pos.y) * buoyK, -9, 9);
        /**
         * The dive has to out-pull buoyancy at EVERY depth, not just the first
         * few metres.
         *
         * Buoyancy is a spring, so its pull grows the deeper you get, and a
         * constant sink rate on top of a growing spring has an equilibrium: at
         * a 0.7 gain against 3.4 m/s that lands just under five metres, and the
         * bay is twelve deep. Measured, it was exactly that — the swimmer sank
         * to about five metres and hung there, with the caustics and the whole
         * lit seabed still seven metres below and unreachable. The dive worked
         * and had a ceiling on it nobody had chosen.
         *
         * So while diving, cap how hard the water is allowed to push back. A
         * body a few metres down is very nearly neutrally buoyant anyway; it is
         * the last metre to the surface that does the lifting, and that metre
         * is exactly what the cap leaves intact for when you let go.
         */
        /**
         * Two caps, and the tighter one wins.
         *
         * Diving keeps 1.1 m/s, which against the 3.4 m/s sink term is the
         * measured 2.3 m/s descent. Gliding gets 0.35, so a swimmer working
         * along the bottom drifts up slowly rather than being fired at the
         * surface the instant they level off — while still, always, drifting
         * UP if they do nothing.
         */
        const cap = Math.min(
          THREE.MathUtils.lerp(9, 1.1, diveEased),
          THREE.MathUtils.lerp(9, 0.35, glideEased),
        );
        const held = Math.min(rise, cap);
        /**
         * You fall faster the deeper you get.
         *
         * A diver's buoyancy is not constant — everything compressible about
         * them shrinks under pressure, so past a few metres you stop swimming
         * down and start sinking, and it accelerates. In the bay that is a
         * detail worth about half a metre a second. Down the trench it is the
         * difference between a plunge and a lift ride: eighty metres at a flat
         * 2.3 m/s is a very long time to watch a wall go past.
         */
        const sinkGain = 3.4 + Math.min(2.5, Math.max(0, -pos.y - 6) * 0.05);
        const wantVy = held - diveEased * sinkGain;
        vel.y += (wantVy - vel.y) * (1 - Math.pow(0.008, dt));
        if (thrusting) vel.y += THRUST * dt;
        // Without a jetpack, Space is a kick for the surface.
        else if (jetInput) vel.y += 26 * dt;
      } else {
        diveEased *= Math.pow(0.05, dt);
        glideEased *= Math.pow(0.05, dt);
        vel.y -= GRAVITY * dt;
        if (thrusting) {
          vel.y += THRUST * dt;
          onGround = false;
        }
      }
      // Parkour jump: edge-trigger when grounded (or within coyote window).
      if (wantsJump && !prevJetInput && !swimming) {
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
      vel.y = THREE.MathUtils.clamp(
        vel.y,
        -MAX_FALL,
        now < superBounceUntil ? 90 : MAX_RISE,
      );
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
        const ceiling = collision.ceilingAt(pos.x, pos.z, prevY, pos.y);
        if (ceiling !== null) {
          pos.y = ceiling;
          vel.y = 0;
        }
      }

      // Land on whatever is underneath (street, rooftop, or island).
      // A grounded walker steps up anything under 0.42 m: the same allowance
      // `isBlocked` gives, so a ledge you can walk into is one you stand on.
      // Without it a walker passed straight through ramps and stairs at street
      // level and met the top step as a wall (the marina ramp, Nov 2026).
      let support = supportHeightAt(pos.x, pos.z, prevY + (onGround && vel.y <= 0 ? 0.42 : 0.1));
      // Nothing but the phantom sea-level plate won, and we are in the water:
      // let the swimmer past it and down to the actual seabed, which is what
      // buoyancy is then pushing them back up off.
      if (swimming && support <= 0.0001) {
        // Inside the trench the floor is the trench's, which is a long way
        // past the −80 that was only ever there as a backstop.
        const tf = trench.floorAt(pos.x, pos.z);
        support = tf !== null ? tf : Math.max(seaBed, -80);
      }
      // Wading. In water too shallow to swim in, stand on the SEABED rather
      // than on the sea: the plate at y=0 is there so nobody can fall out of
      // the world, and over the shallows it was also letting them walk out
      // across the top of it. Bounded to the wading band, so a jetpack pilot
      // descending over deep water still meets the surface and starts
      // swimming rather than dropping to the bottom of the bay.
      else if (!swimming && waterHere > 0 && waterHere <= SWIM_IN && support <= 0.0001) {
        support = seaBed;
      }
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
          // Powder Peak is a soft-snow zone — hucking cliffs is the point.
          const inSki = skiWorld.inZone(pos.x, pos.z);
          // Falls that started up in the Cloud Kingdom OR the drifting
          // ambient cloud band land soft — nothing up there should trap.
          const fromClouds = peakY > ISLAND_TOP + 90;
          // Landing in water is landing in water. A cannonball off a tower is
          // a thing people should be rewarded for, not respawned for.
          const inSea = waterHere > SWIM_OUT;
          const safeZone = inMars || inMoonA || inMoonB || inUnder || inSki || fromClouds || inSea;

          const fallDamageArmed = fallDamageEnabledRef.current && !jetpackEquipped;

          if (fallDamageArmed && !safeZone && dropFromPeak > 16) {
            // Splat! Respawn on Edge Island's plaza (where Jerry lives).
            soundsRef.current?.thud?.(1);
            player.position.set(ISLAND_X + SPAWN.x, ISLAND_TOP + 6, ISLAND_Z + SPAWN.z);
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

        // Clouds are trampolines: land on one and it throws you back up,
        // higher when you carry speed into it. Everything else — the
        // Moon, Mars, sky-island rooftops, the plaza — is solid ground
        // you simply stand on. `supportBounce` came from the box that
        // actually caught us, so a world can never become bouncy by
        // drifting into some magic altitude band.
        if (supportBounce > 0) {
          const big = supportBounce >= 25; // Cloud Kingdom vs. ambient puff
          vel.y = supportBounce + Math.hypot(vel.x, vel.z) * (big ? 0.3 : 0.15);
          onGround = false;
          superBounceUntil = now + (big ? 2000 : 1200);
          peakY = pos.y;
          soundsRef.current?.chime?.(big ? 3 : 2);
        }
      } else if (pos.y > support + 0.05) {
        onGround = false;
        if (pos.y > peakY) peakY = pos.y;
      }
      } // end of free-movement physics (vs. riding the zipline)

      // Face the direction of travel; tilt forward while flying fast.
      {
        const key = JSON.stringify(stickersRef.current) + modelHolder.children.filter((c) => c.name !== "__stickers").map((c) => c.uuid).join();
        if (key !== stickerKey) { stickerKey = key; applyStickers(modelHolder, stickersRef.current); }
      }
      const hSpeed = Math.hypot(vel.x, vel.z);
      const prevModelYaw = modelYaw;
      if (hSpeed > 0.6) {
        const target = Math.atan2(vel.x, vel.z);
        let d = target - modelYaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        modelYaw += d * Math.min(1, dt * 10);
        modelHolder.rotation.y = modelYaw;
      }
      // Signed turn rate, wrapped — Flux banks into corners with it.
      let yawDelta = modelYaw - prevModelYaw;
      while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
      while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
      // Keep the character upright in the air — the previous forward
      // lean read as a sideways tilt whenever the model's yaw didn't
      // match the camera (e.g. strafing or curved jetpack arcs).
      //
      // Except while you are being run over, which is the one time you should
      // NOT be upright. The same easing then puts you back on your feet on its
      // own as the knockdown runs out, so there is no getting-up animation to
      // own and nothing to get stuck in.
      if (knockdown > 0) {
        if (knockAxis === 1) modelHolder.rotation.z = knockSpin;
        else modelHolder.rotation.x = knockSpin;
      } else {
        modelHolder.rotation.x += (0 - modelHolder.rotation.x) * Math.min(1, dt * 8);
        modelHolder.rotation.z += (0 - modelHolder.rotation.z) * Math.min(1, dt * 8);
      }

      // Animation state machine. Jetpack thrust deliberately skips the
      // jump tuck — you just rise, standing tall.
      if (actions.size) {
        // Swimming holds the idle clip underneath and lets the solved stroke
        // do the work on top. A walk cycle fighting a front crawl for the same
        // bones is a mess no blend weight rescues.
        if (activeMountRef.current || swimming || thrusting) playClip([/^idle$/i, /idle/i], true);
        else if (!onGround) playClip([/jump_idle/i, /jump/i, /fall/i, /idle/i], true);
        else if (hSpeed > 6.5) playClip([/^run/i, /run/i, /walk/i], true);
        else if (hSpeed > 0.6) playClip([/^walk/i, /walk/i, /run/i], true);
        else playClip([/^idle$/i, /idle/i], true);
      }

      // ---- Swimming -----------------------------------------------------
      /* Solved, not played back — see `src/city/swim.ts`. It rides the same
         pose channel the dances use, so it lands on every character in the
         catalogue and on Flux, none of which ship a swim clip. */
      swimWeight = stepDanceWeight(swimWeight, swimming, dt);
      if (swimWeight > 0) {
        swimSpeedEased += (hSpeed - swimSpeedEased) * (1 - Math.pow(0.02, dt));
        swimPhase += strokeRate(swimSpeedEased) * dt;
        // The stroke is a pure function of (speed, phase), which is what lets a
        // harness freeze it at an exact point in the cycle and photograph a
        // whole one — motion is the only way to judge an animation, and a
        // screenshot of a running clock never lands on the same frame twice.
        swimProne = evalSwim(
          swimPose,
          devSwimPose ?? { speed: swimSpeedEased, phase: swimPhase },
        ).prone;
      } else {
        swimProne = 0;
      }
      // ---- Dance --------------------------------------------------------
      /* Walking out of a dance is how you stop one — no menu, no second key
         press. Speed rather than key state so the joystick, VR and a shove
         from another player all end it too. Leaving the ground ends it as
         well: a jetpack take-off mid-floss looked like a bug. */
      if (danceId && (hSpeed > 1.2 || thrusting || (!onGround && vel.y > 1.5))) {
        setDance(null);
      }
      danceWeight = stepDanceWeight(danceWeight, !!danceId, dt);
      const danceDef = findDance(danceId);
      // Grooved, not straight: you have your own feel for the beat, a few
      // milliseconds either side of it, the same way everybody else in the
      // room does. Without this the player is the one perfectly quantised
      // dancer on a floor full of people, which reads as the crowd being wrong
      // rather than as you being a metronome.
      if (danceDef && danceWeight > 0) evalDanceGrooved(danceDef, dancePose, myGroove);

      mixer?.update(dt);
      // Applied after the mixer, so the solved pose slerps on top of the live
      // clip and melts back into it as the weight falls away. Swimming wins
      // over a dance: you cannot floss and front crawl at once, and entering
      // the water already cancelled the dance anyway.
      const bodyPose = activeMountRef.current ? riderPose : swimWeight > 0 ? swimPose : dancePose;
      const bodyWeight = activeMountRef.current ? 1 : swimWeight > 0 ? swimWeight : danceWeight;
      // Follow-through for dancing only. Swimming solves its own arcs and was
      // tuned against a rig that snaps; lag 0 there keeps it exactly as it was.
      const bodyLag = swimWeight > 0 ? 0 : danceDef?.lag;
      if (danceSk) {
        if (bodyWeight > 0) {
          applyDancePose(danceSk, bodyPose, bodyWeight, dt, bodyLag);
          danceReleased = false;
        } else if (!danceReleased) {
          releaseDanceSkeleton(danceSk);
          danceReleased = true;
        }
      }
      // Flux has no clips to pick between — it reads the same motion the
      // camera does and solves every joint from it.
      procPilot?.update(dt, {
        speed: hSpeed,
        grounded: onGround,
        verticalVel: vel.y,
        yawRate: yawDelta / Math.max(dt, 1e-4),
        thrusting,
        dance: bodyWeight > 0 ? { pose: bodyPose, weight: bodyWeight } : null,
      });

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
        if (c.kind === "gem") {
          // Gentle floor gem: slow spin, tiny hover.
          c.mesh.rotation.y += dt * 1.2;
          c.mesh.position.y = c.baseY + Math.sin(now * 0.002 + i) * 0.12;
        } else {
          // Hoop stays put; the coin inside spins fast like a pickup.
          c.mesh.position.y = c.baseY + Math.sin(now * 0.003 + i) * 0.35;
          c.coin!.rotation.y += dt * 4.2;
          c.hoop!.rotation.z += dt * 0.6;
        }
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

      // The traffic. The player goes in because the cars brake for whoever is
      // standing in the road — and push them back out if they end up inside
      // one, which mutates `player.position`. See src/city/traffic.ts.
      district.update(dt, player.position);
      if (knockdown > 0) {
        knockdown = Math.max(0, knockdown - dt);
        knockSpin += dt * 9;
      }
      island.update(dt, now);
      ninjaShow.update(dt, now);
      updateAvatarHolo(dt);
      {
        const fmOn = !!(window as unknown as { __vibefm?: { playing: boolean } })
          .__vibefm?.playing;
        islandRadio.update(dt, now, fmOn);
        cityRadio.update(dt, now, fmOn);
      }
      roadmapBoard.update(dt, now);
      studioEmbassy.update(dt, now);
      wishGarden.update(dt, now, player.position);
      if (wizardOpenRef.current !== wizardWasOpen) {
        wizardWasOpen = wizardOpenRef.current;
        wizardNpc.setTalking(wizardWasOpen);
        if (wizardWasOpen) {
          camera.getWorldDirection(wizardDir);
          wizardNpc.summon(player.position, Math.atan2(-wizardDir.x, -wizardDir.z));
        }
      }
      wizardNpc.update(dt, now, player.position);
      wizard.update(dt, now, camera.position);
      updateSpawns(spawnsGroup, dt, now);
      moonWorld.update(dt, now);
      moon2World.update(dt, now);
      marsWorld.update(dt, now);
      tjsWorld.update(dt, now);
      skyIslands.update(dt, now);
      pegasus.update(dt, now);
      dragon.update(dt, now);
      if (activeMountRef.current !== "helicopter" && !parkedHeli) heli.pose = null;
      heli.update(dt, now);
      if (turkey.group.visible) turkey.update(dt, now);
      thanks.update(dt, now, camera);
      if (!activeMountRef.current && enteredRef.current && vel.y <= 0 && drivingKartRef.current < 0 && !riding && !swinging && ridingBad === null) {
        for (const [kind, creature] of mountsInReach()) {
          const bp=creature.body.position;
          if (Math.hypot(pos.x-bp.x,pos.z-bp.z)<2.4 && pos.y>=bp.y+MOUNT_SEAT-0.7 && pos.y<=bp.y+MOUNT_SEAT+1.5) {
            mountActionRef.current?.(kind); break;
          }
        }
      }
      skyGames.update(dt, now, player.position);
      skiWorld.update(dt, now);
      moonGolf.update(dt, now, player.position, vel);
      rebel.update(dt, now, player.position);
      // F = rapid fire (button on mobile). 220ms between bolts.
      if (keys.has("KeyF") && now - lastRebelShot > 220) {
        lastRebelShot = now;
        rebelFireRef.current?.();
      }

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
        // Sticky once aboard, stickier still at the helm — a pilot who
        // slips off their own ship mid-climb is pure frustration.
        const catchBand = zepPilotRef.current ? 3.2 : ridingZeppelin ? 1.8 : 1.0;
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
            setZepMode(zepPilotRef.current ? "piloting" : "aboard");
            if (!zeppelinToastShown) {
              zeppelinToastShown = true;
              toast("🎈 All aboard!", {
                description: "Press P (or tap Take the helm) to fly it yourself.",
              });
            }
          }
        } else if (ridingZeppelin) {
          ridingZeppelin = false;
          setZepPilotMode(false);
          setZepMode("off");
        }
      }

      // ---- Landmarks: elevators, binoculars, the turning Loupe -------------
      // A rider is locked to the car rather than carried by physics; see
      // src/city/landmarks/index.ts.
      {
        const tmL = touchMoveRef.current;
        const tmLen = Math.hypot(tmL.x, tmL.y);
        arcade.update(dt, now, player.position);
        {
          // The Kart GP rides kart 0, the red one on the plaza.
          const k0 = kartStates[0];
          const inRaceKart = drivingKartRef.current === 0 && k0.wreck <= 0;
          if (race.active() && !inRaceKart) {
            race.abort();
            toast("🏁 Out of the race", { description: k0.wreck > 0 ? "The kart is wrecked. Walk back to the kiosk on the plaza to try again." : "You got out of the kart. The kiosk on the plaza starts another one." });
          }
          const ev = race.update(dt, now, inRaceKart ? k0 : null);
          if (ev?.type === "go") soundsRef.current?.chime(4);
          else if (ev?.type === "gate") soundsRef.current?.chime(2);
          else if (ev?.type === "lap") {
            soundsRef.current?.chime(4);
            toast(ev.lap === 3 ? "🏁 Final lap!" : `🏁 Lap ${ev.lap}`);
          } else if (ev?.type === "finish") {
            if (ev.payout > 0) {
              vibeBalanceRef.current = Math.max(0, vibeBalanceRef.current) + ev.payout;
              setVibeBalanceTick((n) => n + 1);
              persistVibeBalanceRef.current?.();
            }
            soundsRef.current?.fanfare?.();
          }
        }
        const lock = landmarks.update(dt, now, {
          player: player.position,
          grounded: onGround,
          busy: drivingKartRef.current >= 0 || !!activeMountRef.current || swimming || ridingZeppelin,
          swimming,
          // The speedboat's helm: the same keys and stick as a kart.
          throttle:
            (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) -
            (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0) +
            (tmLen > 0.12 ? -tmL.y : 0),
          steer:
            (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) -
            (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0) +
            (tmLen > 0.12 ? tmL.x : 0),
        });
        if (lock) {
          player.position.copy(lock);
          vel.set(0, 0, 0);
          onGround = true;
          wallJumpUsed = false;
          peakY = lock.y;
        }
        // At the helm the camera swings in behind the bow, like a kart's.
        const fy = landmarks.followYaw();
        if (fy !== null) {
          let dyaw = fy - camYaw;
          while (dyaw > Math.PI) dyaw -= Math.PI * 2;
          while (dyaw < -Math.PI) dyaw += Math.PI * 2;
          camYaw += dyaw * Math.min(1, dt * 2.5);
        }
      }

      // Zeppelin Heist: spawn the sky coin on schedule, ride it around
      // on the deck, and pay out when someone grabs it.
      {
        const zep = skyIslands.zeppelin;
        if (!heistActive && now >= heistNextAt) {
          heistActive = true;
          heist.visible = true;
          // Announce only once per session — the golden beacon is the
          // real signal; repeat toasts read as confusing spam.
          if (enteredRef.current && !heistToastShown) {
            heistToastShown = true;
            toast("🪙 Zeppelin Heist", {
              description:
                "A sky coin appears on the zeppelin every few minutes — look for the golden beacon and grab it for +15 ✦.",
            });
          }
        }
        if (heistActive) {
          heist.position.set(
            zep.pos.x,
            zep.pos.y + zep.deckY + 1.0 + Math.sin(now * 0.004) * 0.15,
            zep.pos.z,
          );
          heist.rotation.y = now * 0.003;
          if (player.position.distanceTo(heist.position) < 1.9) {
            heistActive = false;
            heist.visible = false;
            heistNextAt = now + HEIST_PERIOD_MS;
            vibeBalanceRef.current = Math.max(0, vibeBalanceRef.current) + HEIST_REWARD;
            setVibeBalanceTick((n) => n + 1);
            persistVibeBalanceRef.current?.();
            soundsRef.current?.fanfare?.();
            toast.success(`+${HEIST_REWARD} ✦ — Zeppelin Heist!`, {
              description: "You caught the sky coin. Another lands in a few minutes.",
            });
          }
        }
      }

      // THE GETAWAY: launch the chase on schedule, drive the lap, and
      // settle the outcome (rammed → loot recovered, timer → escaped).
      {
        // The heist happens on the CITY streets, so it only starts when
        // you are actually down there to see it. Announcing a car chase
        // to someone standing on the moon is just a popup.
        const p = player.position;
        const inCity =
          p.y < 40 &&
          Math.hypot(p.x, p.z) < 220 &&
          Math.hypot(p.x - ISLAND_X, p.z - ISLAND_Z) > 90;
        if (!inCity) {
          // Hold the timer while you're away rather than letting it come
          // due elsewhere and fire the moment you land back downtown.
          chaseNextAt = Math.max(chaseNextAt, now + 45_000);
        }
        if (inCity && !heistChase.isActive() && now >= chaseNextAt) {
          heistChase.start(now);
          setHeistChaseOn(true);
          if (enteredRef.current) {
            toast("🚨 HEIST!", {
              description: chaseAnnounced
                ? "The getaway kart is back on the city streets."
                : "A gremlin cracked the city vault! Chase the getaway kart through the streets and ram it to recover the loot (+25 ✦).",
            });
          }
          chaseAnnounced = true;
        }
        weather.update(dt, player.position);
        {
          const wk = weather.get();
          wetStreets.update(dt, wk === "rain" || wk === "storm");
          neon.setWet(wetStreets.wetness());
          neon.update(dt);
          birds.update(dt, player.position);
          bay.update(dt);
          folk.update(dt, player.position);
          {
            const n = folk.near();
            if (n !== folkNearRef.current) {
              folkNearRef.current = n;
              setFolkNear(n);
            }
            // Walking off ends the conversation.
            const o = folkOpenRef.current;
            if (o && !n) {
              const w = folk.where().find((p) => p.id === o.id);
              if (!w || Math.hypot(w.x - player.position.x, w.z - player.position.z) > 7) {
                folkOpenRef.current = null;
                setFolkOpen(null);
                folk.engage(null);
              }
            }
          }
          citySky.update(dt, camera.position);
        }
        {
          const di = drivingKartRef.current;
          const dk = di >= 0 ? kartStates[di] : null;
          mayhem.update(dt, {
            player: player.position,
            yaw: modelYaw,
            driving: dk ? { x: dk.x, y: dk.y, z: dk.z, yaw: dk.yaw, speed: dk.speed } : null,
            inCity,
            heist: heistChase.isActive() ? heistChase.pos() : null,
            firing: enteredRef.current && (keys.has("KeyR") || keys.has("KeyQ") || touchFireRef.current),
            throwing: enteredRef.current && (keys.has("KeyX") || touchThrowRef.current),
            grounded: onGround && knockdown <= 0 && !activeMountRef.current,
            riding: ridingBad,
            gunner: ridingBad !== null && gunner,
          });
          if (ridingBad !== null) {
            const s = mayhem.seat(ridingBad);
            if (s && gunner) {
              const g = gunnerSeat(s);
              player.position.set(g.x, g.y, g.z);
            } else if (s) player.position.set(s.x, s.y, s.z);
            else {
              // His car went up with you on it.
              ridingBad = null;
              gunner = false;
              vel.set((Math.random() - 0.5) * 8, 9, (Math.random() - 0.5) * 8);
              onGround = false;
            }
          }
          const hq = mayhem.hideout();
          const pp = player.position;
          atHideout = !!hq && drivingKartRef.current < 0 && ridingBad === null &&
            Math.hypot(pp.x - hq[0], pp.z - hq[2]) < 3.2 && Math.abs(pp.y - hq[1]) < 2.5;
          nearRideButton = ridingBad === null && drivingKartRef.current < 0 && !activeMountRef.current &&
            Math.hypot(pp.x - RIDE_BUTTON[0], pp.z - RIDE_BUTTON[2]) < 2.6 && pp.y < 3;
          {
            const nk = drivingKartRef.current < 0 && !activeMountRef.current && race.nearKiosk(pp);
            if (nk !== nearRaceKioskRef.current) {
              nearRaceKioskRef.current = nk;
              setNearRaceKiosk(nk);
            }
            const ru = race.ui();
            setRaceUi((prev) =>
              prev && prev.phase === ru.phase && prev.count === ru.count && prev.lap === ru.lap && prev.place === ru.place &&
              Math.abs(prev.time - ru.time) < 0.05 && Math.abs(prev.nextGateDist - ru.nextGateDist) < 1 && prev.result === ru.result
                ? prev
                : ru,
            );
          }
          {
            const st = drivingKartRef.current < 0 && !activeMountRef.current ? arcade.nearest(pp) : null;
            if (st !== arcadeStationRef.current) {
              arcadeStationRef.current = st;
              setArcadeStation(st);
            }
          }
          nearBadNow = null;
          if (ridingBad === null && drivingKartRef.current < 0 && !activeMountRef.current) {
            for (const b of mayhem.bads()) {
              if (!b.boarding && Math.hypot(pp.x - b.x, pp.z - b.z) < 4.5 && Math.abs(pp.y - b.y) < 4) {
                nearBadNow = b.id;
                break;
              }
            }
          }
          squadApi?.update(dt, {
            player: player.position,
            yaw: modelYaw,
            driving: dk ? { x: dk.x, y: dk.y, z: dk.z, yaw: dk.yaw, speed: dk.speed } : null,
            airborne: !onGround || Boolean(activeMountRef.current),
          });
        }
        const mowing = drivingKartRef.current >= 0 && kartStates[drivingKartRef.current].kind === "mower";
        const chaseEv = heistChase.update(dt, now, player.position, mowing);
        if (heistChase.shredding()) {
          const kp = heistChase.pos();
          shredFx(kp.x, kp.y, kp.z, Math.random() - 0.5, Math.random() - 0.5);
          crashFx.debris(kp.x, kp.y + 0.6, kp.z, 6, 0x31161f, 7);
          crashFx.kick(0.1);
        }
        if (chaseEv) {
          setHeistChaseOn(false);
          chaseNextAt = now + CHASE_PERIOD_MS;
          if (chaseEv === "caught") {
            vibeBalanceRef.current = Math.max(0, vibeBalanceRef.current) + CHASE_REWARD;
            setVibeBalanceTick((n) => n + 1);
            persistVibeBalanceRef.current?.();
            soundsRef.current?.fanfare?.();
            toast.success(`💰 Heist foiled! +${CHASE_REWARD} ✦`, {
              description: "You rammed the getaway kart and recovered the loot. The gremlin respects it.",
            });
          } else if (chaseEv === "busted") {
            crashFx.explode(heistChase.pos().x, 0.8, heistChase.pos().z, 0.9, 0x31161f);
            if (enteredRef.current) {
              toast("🚓 The police got the getaway kart", {
                description: "They rammed it off the road before you did. Beat them to it next time.",
              });
            }
          } else if (enteredRef.current) {
            toast("🚁 The getaway kart escaped…", {
              description: "The gremlin vanished into an alley with the loot. It'll be back.",
            });
          }
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

      // Cloud Kingdom: the launch trampoline yeets grounded players
      // skyward; golden rings collect on touch.
      cloudKingdom.update(dt, now);
      {
        const pp = player.position;
        if (
          onGround &&
          Math.hypot(pp.x - cloudKingdom.launchPad.x, pp.z - cloudKingdom.launchPad.z) < 2.2 &&
          Math.abs(pp.y - cloudKingdom.launchPad.y) < 3
        ) {
          // Straight up + a drift toward the kingdom's center so the
          // arc delivers you onto the big arrival cloud.
          vel.y = 82;
          const ldx = ISLAND_X - pp.x;
          const ldz = ISLAND_Z - pp.z;
          const llen = Math.hypot(ldx, ldz) || 1;
          vel.x = (ldx / llen) * 7;
          vel.z = (ldz / llen) * 7;
          onGround = false;
          superBounceUntil = now + 4200; // covers the whole 3.4s ascent
          peakY = pp.y;
          cloudKingdom.squashPad();
          soundsRef.current?.chime(8);
          toast("☁️ To the Cloud Kingdom!", {
            description: "Bounce cloud to cloud — collect all nine golden rings.",
          });
        }
        const remaining = cloudKingdom.tryCollect(pp);
        if (remaining !== null) {
          if (remaining === 0) {
            vibeBalanceRef.current = Math.max(0, vibeBalanceRef.current) + 30;
            setVibeBalanceTick((n) => n + 1);
            persistVibeBalanceRef.current?.();
            soundsRef.current?.fanfare?.();
            toast.success("👑 All nine rings! +30 ✦", {
              description: "The Cloud Kingdom crowns you. Rings return in a bit.",
            });
          } else {
            soundsRef.current?.chime(5);
          }
        }
      }

      /**
       * Water check for every vehicle, not just the one being driven.
       *
       * Hop out mid-plunge and the car has to carry on going down without
       * you — otherwise abandoning it at the waterline leaves a kart bobbing
       * on the surface, which is the exact thing this replaced.
       */
      for (let i = 0; i < kartStates.length; i++) sinkTick(kartStates[i], i, dt);

      /*
       * Wrecks and hurt engines.
       *
       * A wreck has nobody driving it, so the driving physics above never
       * touch it: it gets its own gravity here, flips over onto its roof,
       * burns, and once you are out of sight of it goes home good as new. A
       * working vehicle that has taken a beating smokes, and then burns,
       * from the engine — which is the warning that the next hit is the one.
       */
      for (let i = 0; i < kartStates.length; i++) {
        const k = kartStates[i];
        if (k.ride >= 0 && k.wreck === 0) {
          const ds = distress(k.hp);
          if (ds.smoke > 0) {
            crashFx.smoulder(dt, k.x + Math.sin(k.yaw) * 1.6, k.y + 1.3, k.z + Math.cos(k.yaw) * 1.6, ds.smoke, ds.fire);
          }
          continue;
        }
        if (!k.mesh) continue;
        if (k.wreck > 0) {
          k.wreck += dt;
          if (k.sink === 0) {
            const sup = supportHeightAt(k.x, k.z, k.y + 1.2);
            k.x += Math.sin(k.yaw) * k.speed * dt;
            k.z += Math.cos(k.yaw) * k.speed * dt;
            if (k.y <= sup + 0.05 && k.vy <= 0) {
              k.y = sup;
              k.vy = 0;
              k.speed *= Math.pow(0.02, dt);
            } else {
              k.vy = Math.max(k.vy - GRAVITY * dt, -MAX_FALL);
              k.y += k.vy * dt;
              if (k.y < sup) {
                k.y = sup;
                k.vy = k.vy < -4 ? -k.vy * 0.25 : 0;
              }
            }
          }
          // End over end in the air, settling onto its roof.
          k.flip += (Math.PI - k.flip) * (1 - Math.pow(k.vy !== 0 ? 0.25 : 0.01, dt));
          if (k.wreck < 20) {
            crashFx.smoulder(dt, k.x, k.y + 0.6, k.z, k.wreck < 10 ? 1 : 0.5, k.wreck < 9 ? 0.9 : 0);
          }
          const watcher = Math.hypot(player.position.x - k.x, player.position.z - k.z);
          if (k.wreck > 9 && (watcher > 28 || k.wreck > 30) && k.home) {
            k.wreck = 0;
            k.hp = MAX_HEALTH;
            k.flip = 0;
            k.speed = 0;
            k.vy = 0;
            k.sink = 0;
            k.wet = false;
            kartPitchNow[i] = 0;
            k.x = k.home.x;
            k.y = k.home.y;
            k.z = k.home.z;
            k.yaw = k.home.yaw;
            scorch(k.mesh.group, false);
          }
        } else {
          const ds = distress(k.hp);
          if (ds.smoke > 0) {
            const up = k.kind === "monster" ? 2.6 : k.kind === "comet" ? 0.8 : 0.9;
            const fwd = k.kind === "monster" ? 1.6 : k.kind === "comet" ? -1.6 : 1.0;
            crashFx.smoulder(
              dt, k.x + Math.sin(k.yaw) * fwd, k.y + up, k.z + Math.cos(k.yaw) * fwd,
              ds.smoke, ds.fire,
            );
          }
          // The Comet's afterburner, on Shift at speed.
          if (k.kind === "comet" && drivingKartRef.current === i && k.speed > 26 &&
            (keys.has("ShiftLeft") || keys.has("ShiftRight"))) {
            const fx = Math.sin(k.yaw);
            const fz = Math.cos(k.yaw);
            for (const side of [-0.35, 0.35]) {
              crashFx.afterburn(
                dt, k.x - fx * 2.45 + fz * side, k.y + 0.42, k.z - fz * 2.45 - fx * side,
                fx, fz, 45,
              );
            }
          }
        }
        if (k.kind === "comet") {
          cometBeacon.position.set(k.x, k.y, k.z);
          cometBeacon.visible = k.wreck === 0 && drivingKartRef.current !== i;
        }
        if (k.kind === "mower") {
          if (drivingKartRef.current === i && !mowerRidden) {
            mowerRidden = true;
            try {
              localStorage.setItem("vibe.city.mowerRidden", "1");
            } catch {
              /* private window */
            }
          }
          mowerBeacon.position.set(k.x, k.y, k.z);
          mowerBeacon.visible = !mowerRidden && k.wreck === 0 && drivingKartRef.current !== i;
        }
      }

      // Bots' wrecks burn, and a bot that has lost it lays down tyre smoke.
      for (const b of district.traffic.burning()) {
        if (Math.hypot(b.x - player.position.x, b.z - player.position.z) > 140) continue;
        crashFx.smoulder(dt, b.x, b.y + 1.1, b.z, b.age < 8 ? 0.9 : 0.45, b.age < 6 ? 0.8 : 0);
      }
      for (const sk of district.traffic.skidding()) {
        if (sk.speed > 4) crashFx.tyreSmoke(dt, sk.x, sk.z, 26);
      }

      // Sync kart meshes; spin wheels + steer the front axle on the
      // driven one. Parked karts idle with a faint underglow.
      for (let i = 0; i < kartStates.length; i++) {
        const k = kartStates[i];
        if (k.ride >= 0) {
          // A commandeered city car: the fleet still draws it, we just say
          // where. Its wheels and body come from src/city/traffic.ts.
          /*
           * `+ π` is the whole handshake between two forward conventions.
           * City's kart physics drives toward (sin yaw, cos yaw) — +Z forward,
           * inherited from `karts.ts`. The Vibe Kart model is −Z forward. Pass
           * the raw yaw and the car drives perfectly, backwards.
           */
          district.traffic.drive(
            k.ride, k.x, k.y - k.wade, k.z, k.yaw + Math.PI,
            // Sign flips with the `+ π`: the car model faces the other way, so
            // the nose-down it needs is the tail-down of the kart convention.
            -kartPitchNow[i], k.sink > 0 ? k.roll : 0,
          );
          continue;
        }
        if (!k.mesh) continue;
        // A wreck on its roof is lifted by its own height, or it would be
        // upside down half under the road.
        const lift = k.flip ? (1 - Math.cos(k.flip)) * 0.5 * (VEHICLES[k.kind].seat + 0.55) : 0;
        k.mesh.group.position.set(k.x, k.y + lift - k.wade, k.z);
        // YXZ so the yaw stays a heading and the pitch tips the nose, rather
        // than the default XYZ applying the roll before the pitch and turning
        // a listing car into a corkscrew.
        k.mesh.group.rotation.set(kartPitchNow[i] + k.flip, k.yaw, k.sink > 0 ? k.roll : 0, "YXZ");
        if (drivingKartRef.current === i) {
          for (const w of k.mesh.wheels) w.rotateY((k.speed * dt) / VEHICLES[k.kind].wheelR);
          for (const p of k.mesh.frontPivots) p.rotation.y = -k.steer * 0.42;
          if (k.kind === "mower") {
            const bl = k.mesh.group.getObjectByName("blade");
            if (bl) bl.rotation.y += dt * 60;
          }
          (k.mesh.glow.material as THREE.MeshBasicMaterial).opacity =
            0.3 + Math.min(0.25, Math.abs(k.speed) / 60);
        }
        // The electrics drown. Also removes a real artifact: the underglow is
        // a flat bright quad under the chassis, invisible while the kart is
        // level on a road and, once it noses over in the water, a hard-edged
        // white parallelogram sticking out from under the car.
        if (k.sink > 0) {
          (k.mesh.glow.material as THREE.MeshBasicMaterial).opacity =
            Math.max(0, 0.3 - k.sink * 0.5);
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
      // The clan and the boss only hunt a player who is actually down
      // here, so the cavern is told where you are — or that you are not.
      const inMinesNow = undergroundWorld.isInside(pos);
      undergroundWorld.update(dt, now, inMinesNow ? pos : null);
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
      const insideNow = inMinesNow;
      if (insideNow !== undergroundActiveRef.current) {
        undergroundActiveRef.current = insideNow;
        setUnderground(insideNow);
      }

      // ---- Transcendence Portal: voluntary entry + void safety net ---
      if (transcendState.cooldown > 0) transcendState.cooldown -= dt;
      if (transcendState.cooldown <= 0 && !insideNow && !club.contains(pos)) {
        const dxT = pos.x - TRANSCEND_POS.x;
        const dzT = pos.z - TRANSCEND_POS.z;
        const onDisc =
          dxT * dxT + dzT * dzT < 2.4 * 2.4 && Math.abs(pos.y - TRANSCEND_POS.y) < 1.5;
        /**
         * Falling out of the world, and the one place that is just deep water.
         *
         * Below −25 metres used to mean something had gone wrong: there was no
         * geometry down there and the safety net caught you and put you back
         * in the plaza. The trench is eighty metres of somewhere you are meant
         * to be — so without this exemption the net fires at −25, every time,
         * and the realm is unreachable by the exact mechanism that exists to
         * stop the world losing you.
         */
        const fellOutOfWorld = pos.y < -25 && !trench.inside(pos.x, pos.z);
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
          setMinesStomps((n) => n + ev.stomps);
          vibeBalanceRef.current =
            Math.max(0, vibeBalanceRef.current) + ev.stomps * MINES_STOMP_COIN;
          setVibeBalanceTick((n) => n + 1);
          persistVibeBalanceRef.current?.();
        }
        if (ev.nuggets > 0) {
          soundsRef.current?.chime?.(8);
          setMinesGold((n) => n + ev.nuggets);
          vibeBalanceRef.current = Math.max(0, vibeBalanceRef.current) + ev.nuggets;
          setVibeBalanceTick((n) => n + 1);
          persistVibeBalanceRef.current?.();
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
          vibeBalanceRef.current = Math.max(0, vibeBalanceRef.current) + MINES_BOSS_COIN;
          setVibeBalanceTick((n) => n + 1);
          persistVibeBalanceRef.current?.();
        }
        // Warn the HUD while the boss is winding up a charge.
        {
          const phase = undergroundWorld.bossPhase();
          const warn = phase === "windup" || phase === "charge";
          if (warn !== bossWarnRef.current) {
            bossWarnRef.current = warn;
            setBossWarning(warn);
            if (warn) soundsRef.current?.thud?.(0.25);
          }
        }
        if (ev.hit && undergroundInvulnRef.current <= 0) {
          undergroundInvulnRef.current = 1.2;
          const dx = pos.x - UNDER_X;
          const dz = pos.z - UNDER_Z;
          const d = Math.hypot(dx, dz) || 1;
          const knock = ev.bossCharged ? 18 : 10;
          vel.x = (dx / d) * knock;
          vel.z = (dz / d) * knock;
          vel.y = ev.bossCharged ? 11 : 8;
          soundsRef.current?.thud?.(ev.bossCharged ? 0.8 : 0.5);
          // Guarded so a second hit inside the knock-out animation
          // cannot schedule a second exit.
          if (minesHeartsRef.current > 0) {
            const left = minesHeartsRef.current - 1;
            minesHeartsRef.current = left;
            setMinesHearts(left);
            if (left <= 0) {
              // Knocked out: the gremlins win this run. Coins already
              // banked stay banked; the cavern starts over.
              setMinesKo(Date.now());
              window.setTimeout(() => exitUndergroundRef.current?.(), 900);
            }
          }
        }
      }



      
      vibey.update(dt, now);
      updateClouds(now);
      ocean.update(now * 0.001, scene.fog as THREE.Fog | null);
      splash.update(dt);
      // Lays down while it is snowing, melts off when it stops.
      snowCover.update(dt, weatherRef.current?.get() === "snow");
      agentResidents.update(dt, pos);
      rosterBoard.update(dt);
      /* Peers first, then the floor: its regulars join in for a remote player
         dancing on it as readily as for you, so somebody watching from across
         the plaza sees a real party rather than four statues around one
         person. `mp` has not been updated yet this frame, so these are last
         frame's positions — a sixteenth of a beat stale, which nothing here
         can perceive. */
      const peerDancers = mp.countDancersNear(pos.x, pos.z, 34);
      // Returns how many of its regulars are dancing, which the music below
      // counts alongside the real people.
      const floorDancers = danceFloor.update(dt, pos, (danceId ? 1 : 0) + peerDancers);

      // ---- THE BASEMENT: the room, and its two doors --------------------
      onGroundForDebug = onGround;
      const clubDancers = club.update(dt, pos, !!danceId);
      if (clubDoorCooldown > 0) clubDoorCooldown -= dt;
      else if (pos.distanceTo(STAIR) < 1.9 && onGround) {
        clubDoorCooldown = 2.5;
        pos.copy(club.spawn);
        vel.set(0, 0, 0);
        /* Face into the room. You come in through the back wall, so whatever
           way you happened to be looking in the plaza, the first thing on
           screen is a blank wall and twenty people behind you. */
        camYaw = 0;
        soundsRef.current?.chime?.(4);
      } else if (pos.distanceTo(club.exit) < 1.9 && onGround) {
        clubDoorCooldown = 2.5;
        pos.set(STAIR.x, 0.2, STAIR.z + 3);
        vel.set(0, 0, 0);
        soundsRef.current?.chime?.(2);
      }
      stairPad.material.opacity = 1;
      stairPad.position.y = 0.06 + Math.sin(now * 0.004) * 0.03;

      mp.update(dt, {
        x: pos.x,
        y: pos.y,
        z: pos.z,
        yaw: modelYaw,
        air: !onGround,
        char: charRef.current,
        scale: playerScaleRef.current,
        dance: danceId,
        mount: activeMountRef.current,
        flap: keys.has("Space") || touchJetRef.current,
        skyTag: skyTagRef.current && !!activeMountRef.current,
        stickers: stickersRef.current,
      });
      soundsRef.current?.update(thrusting, vel.length(), !onGround);

      // ---- The dance track ----------------------------------------------
      /* Layers are gated on how many people are dancing within earshot, you
         included, so a crowd literally sounds bigger than a soloist. Counted
         here rather than in the music because only the world knows where
         anybody is standing. The radius is generous — you should hear a party
         from far enough away to want to walk over to it. */
      const crowd =
        (danceId ? 1 : 0) + peerDancers + floorDancers + (club.contains(pos) ? clubDancers : 0);
      musicRef.current?.update(crowd);
      if (crowd !== crowdShown) {
        crowdShown = crowd;
        setDanceCrowd(crowd);
      }

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
        modelHolder.visible = !vrFirstPerson && !insideACar();

        // Keep fog comfy in VR (no zoom-out gesture available).
        const fogNow = scene.fog as THREE.Fog;
        fogNow.near = baseFogNear;
        fogNow.far = baseFogFar;
        // And put the near plane back where a headset needs it. The
        // zoom-driven one in the else-branch below is meaningless in VR, and a
        // 6 m near plane inherited from a god-view zoom would clip away the
        // room you are standing in.
        if (camera.near !== 0.1) {
          camera.near = 0.1;
          camera.updateProjectionMatrix();
        }
      } else {
        /*
         * Visible unless you are sitting in a car.
         *
         * This line runs every frame, so setting `visible = false` at the
         * moment you take the wheel does not survive to the next one — which is
         * how the first version of the ride shipped with the driver's head
         * poking up through the roof.
         */
        modelHolder.visible = !insideACar();
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
        /**
         * Diving swings the camera from overhead to behind.
         *
         * The gesture that starts a dive is aiming DOWN, and aiming down is
         * exactly what lifts the chase camera up and away: at nine metres and a
         * steep pitch the eye rides five metres above the swimmer's head. Leave
         * it there and the camera never gets wet however deep the player goes —
         * you would be watching a dive from a helicopter, through the surface,
         * with the whole underwater world on the far side of the sea from you.
         *
         * So the eye commits to the dive too. It comes in close and drops to
         * just over the swimmer's head, which is both the right shot and the
         * thing that puts the camera under the water at about two metres.
         * `camPitch` itself is untouched — the player's aim still means what
         * they set it to, and levelling off unwinds all of this.
         */
        // Out of the water, the underwater aim is no longer legal — ease it
        // back rather than snapping, so surfacing while looking up is a tilt
        // and not a cut. Without this the camera stays below the waterline on
        // dry land and the floor clamp shoves it up through the player's head.
        if (!swimming && camPitch < 0.06) {
          camPitch = Math.min(0.06, camPitch + dt * 1.6);
        }
        /**
         * The dive pulls the camera down to 0.35 — but only ever DOWN.
         *
         * Its job is to stop the eye hovering five metres overhead while you
         * aim at the seabed, so it only has to act on a steep downward aim.
         * Applied unconditionally it also overrides an UPWARD one, which
         * quietly cancels the entire free-look: hold a dive, aim at the
         * surface, and the camera sits at 0.35 looking down at you. Measured
         * exactly that — pitch −0.72 requested, eye still a metre and a half
         * above the swimmer's head.
         */
        const camPitchNow =
          camPitch > 0.35 ? THREE.MathUtils.lerp(camPitch, 0.35, diveEased) : camPitch;
        /* Indoors, pull the camera in.
           A 9m chase camera in a 34×26 room spends most of its time on the
           far side of a wall, and since the walls are single-sided you are not
           looking at a wall — you are looking through it at nothing, which
           renders as a completely black screen. That is not a harness quirk;
           it is what a player standing in the club would see. Clamping to
           something that fits inside the room is the fix, and it is the same
           trick the dive camera above already uses. */
        const camDistNow = club.contains(pos) || landmarks.indoors(pos) || arcade.contains(pos)
          ? Math.min(camDist, 5.2)
          : THREE.MathUtils.lerp(camDist, Math.min(camDist, 4.6), diveEased);
        const camLift = THREE.MathUtils.lerp(1.4, 0.25, diveEased);
        const eye = new THREE.Vector3(
          pos.x + Math.sin(camYaw) * Math.cos(camPitchNow) * camDistNow,
          pos.y + Math.sin(camPitchNow) * camDistNow + camLift,
          pos.z + Math.cos(camYaw) * Math.cos(camPitchNow) * camDistNow,
        );
        // Keep the camera out of the street floor — but over open water the
        // collision world answers with the phantom plate at y=0, which pinned
        // the eye 60 cm above the waves no matter how deep the swimmer went.
        // Under the sea the floor is the seabed.
        const eyeSupport = supportHeightAt(eye.x, eye.z, pos.y + 2);
        // Riding a sinking car counts too, and it is the whole shot: the water
        // closing over the windscreen only works if the camera is allowed to
        // go with it. Clamped to the plate instead, it stops dead at the
        // surface and you watch your own car leave without you.
        const eyeMayGoUnder =
          swimming ||
          (drivingKartRef.current >= 0 && kartStates[drivingKartRef.current].sink > 0);
        /**
         * The floor the camera may not go through — and it is not always the
         * bay's.
         *
         * `-waterDepthAt` is the seabed, which over the trench is the rim at
         * about fourteen metres. Clamping to it pinned the eye there while the
         * swimmer went down another seventy-five: the camera hung at the mouth
         * looking into fog, and because the whole underwater atmosphere keys
         * off the CAMERA's depth, the abyss rendered as mid-teal shallows with
         * nothing in them. Every measurement passed — they were all about the
         * swimmer — and the screenshot was a flat empty rectangle.
         */
        const eyeTrenchFloor = trench.floorAt(eye.x, eye.z);
        eye.y = Math.max(
          eye.y,
          eyeMayGoUnder && eyeSupport <= 0.0001
            ? (eyeTrenchFloor !== null ? eyeTrenchFloor : -waterDepthAt(eye.x, eye.z)) + 0.45
            : eyeSupport + 0.6,
        );
        // During the arrival cinematic the eased path IS the motion —
        // follow it exactly so slow devices don't trail the swoop.
        camera.position.lerp(eye, camSnap || arrivalStart > 0 ? 1 : 1 - Math.pow(0.0008, dt));
        camSnap = false;
        camera.lookAt(pos.x, pos.y + 1.5, pos.z);
        // Binoculars (and dev shots): the landmarks take the camera.
        {
          const shot = landmarks.cameraShot(camYaw, camPitch);
          const fov = shot ? shot.fov : 60;
          if (shot) {
            camera.position.copy(shot.eye);
            camera.lookAt(shot.look);
            modelHolder.visible = false;
          } else if (ridingBad !== null && gunner) {
            // First person from the back seat, looking where you aim.
            const dx = -Math.sin(camYaw);
            const dz = -Math.cos(camYaw);
            const pitch = THREE.MathUtils.clamp(camPitch - 0.12, -0.5, 0.6);
            camera.position.set(pos.x, pos.y + 1.0, pos.z);
            camera.lookAt(
              pos.x + dx * Math.cos(pitch) * 10,
              pos.y + 1.0 - Math.sin(pitch) * 10,
              pos.z + dz * Math.cos(pitch) * 10,
            );
            modelHolder.visible = false;
          }
          if (camera.fov !== fov) {
            camera.fov = fov;
            camera.updateProjectionMatrix();
          }
        }
        // Crash shake. A rotation after the look-at, so it never accumulates.
        {
          const sh = crashFx.shake();
          if (sh > 0.01) {
            camera.rotateX((Math.random() - 0.5) * sh * 0.06);
            camera.rotateY((Math.random() - 0.5) * sh * 0.06);
          }
        }

        // Zoomed way out, the fog backs off so the diorama stays visible.
        const fogNow = scene.fog as THREE.Fog;
        fogNow.near = Math.max(baseFogNear, camDist * 1.2);
        fogNow.far = Math.max(baseFogFar, camDist * 3 + 250);

        /**
         * The near plane moves with the zoom, and that is what stops the city
         * shimmering from the air.
         *
         * A depth buffer's precision falls off with the SQUARE of distance and
         * in inverse proportion to the near plane: at range z it can resolve
         * about z² / (near · 2²⁴). Parked at 0.1 m — which is what a camera
         * needs when it is nine metres behind a walking player — that is 21 cm
         * of resolution at 600 m. The sidewalks sit 1.2 cm above the asphalt
         * and the crossings 2 cm above that, so from a god view every kerb and
         * every zebra in the district is fighting the road underneath it, and
         * the whole grid boils. A burst of ten frames had 44% of the pixels
         * inside the district flipping back and forth.
         *
         * The near plane is the free variable: nothing is ever within 2% of
         * the orbit radius of the camera, because the orbit radius is how far
         * away the thing being looked at is. At full zoom-out that buys 6 m of
         * near plane and takes the resolution at 600 m to 4 mm.
         *
         * This is only half the fix — it scales with camDist, so it does
         * nothing for a player who jetpacks to 300 m with the camera still
         * tight behind them. `polygonOffset` on the pavement in district.ts is
         * the other half, and that one is resolution-independent.
         */
        const wantNear = THREE.MathUtils.clamp(camDist * 0.02, 0.12, 6);
        if (Math.abs(camera.near - wantNear) > wantNear * 0.04) {
          camera.near = wantNear;
          camera.updateProjectionMatrix();
        }
      }

      /**
       * Underwater, driven off the CAMERA and run last.
       *
       * Last because the block above rewrites `fog.near`/`fog.far` from the
       * zoom level every single frame, so anything that fogs the world has to
       * come after it or be silently undone. Off the camera because the eye is
       * what decides whether you are looking through thirty metres of water or
       * through a kilometre of air — a swimmer six metres down with a chase
       * camera still in the sunshine is above water, however wet they are.
       */
      {
        const eyeY = camera.position.y;
        const seaAtEye = seaSurfaceAt(camera.position.x, camera.position.z, now * 0.001);
        /**
         * Over the sea, and in the same world as it.
         *
         * The depth test alone is a trap: the Gremlin Mines are a pocket
         * dimension deep below the open ocean, so a camera four hundred metres
         * down a mineshaft is directly under water by this arithmetic and
         * reads as submerged by four hundred metres. Nothing about that is
         * visible — the mines have their own fog and their own sky — except
         * that every sound in them would be muffled as if you were drowning,
         * with no way out because you never surface.
         */
        const overSea =
          waterDepthAt(camera.position.x, camera.position.z) > 0.05 &&
          (camera.position.y > -40 || trench.inside(camera.position.x, camera.position.z)) &&
          !undergroundActiveRef.current;
        const camDepth = overSea ? seaAtEye - eyeY : -1;
        underwater.update(dt, now * 0.001, camDepth, camera.position);
        // The offshore seabed is only worth drawing to somebody who can see
        // it, which means somebody under the surface — from above, the sea is
        // opaque long before the shelf begins. A metre of margin so breaking
        // through a wave does not flicker it.
        ocean.setDeepBedVisible(camDepth > -1);
        ocean.setUnderside(camDepth > -1);
        // Muffle the world by how far under the LISTENER is — the camera, not
        // the swimmer, for the same reason the fog keys off it. Half a metre
        // of water is already audibly different, hence the short ramp.
        soundsRef.current?.setSubmerged?.(THREE.MathUtils.clamp(camDepth / 0.9, 0, 1));
        /**
         * Treasure, gated on the SWIMMER being under — not the camera.
         *
         * Everything else down here keys off the camera because the camera is
         * what sees. Reaching into a chest is the one thing that is about the
         * body: a swimmer on the bottom with the camera up in a wave trough
         * has still got their hand on it.
         */
        /**
         * You are breathing.
         *
         * A swimmer under the surface trailing nothing at all is the tell that
         * the world is a diorama — every other moving thing down here vents
         * air, including the car you drove in. Rate rises with effort, because
         * the one thing everybody knows about diving is that working harder
         * costs you more of it.
         */
        {
          const seaHere = seaSurfaceAt(player.position.x, player.position.z, now * 0.001);
          if (swimming && player.position.y < seaHere - 0.55) {
            const effort = Math.min(1, Math.hypot(vel.x, vel.z) / 4);
            carSink.bubble(dt, player.position.x, player.position.y + 1.25, player.position.z,
              1.4 + effort * 4.5);
          }
        }
        /**
         * The Deep. Driven off the swimmer AND the eye — the life is drawn
         * around the camera, the pearl is picked up by the body.
         */
        {
          const prize = trench.update(dt, now * 0.001, player.position, camera.position);
          if (prize) {
            soundsRef.current?.fanfare?.();
            vibeBalanceRef.current = Math.max(0, vibeBalanceRef.current) + prize.reward;
            setVibeBalanceTick((n) => n + 1);
            persistVibeBalanceRef.current?.();
            toast.success(`+${prize.reward} ✦ VIBE — ${prize.label}`, {
              description: "Eighty metres down, in the dark.",
            });
          }
          // Arriving is worth saying once. It is the only realm in this world
          // with no portal and no loading screen, so without this you can be
          // somewhere entirely new and have nothing tell you.
          const down = trench.descent(player.position.y);
          if (swimming && trench.inside(player.position.x, player.position.z) && down > 0.25) {
            if (!trenchGreeted) {
              trenchGreeted = true;
              toast("🕳 THE DEEP", {
                description: "The sun does not reach this far. Something down here makes its own.",
              });
            }
          } else if (down < 0.05) {
            trenchGreeted = false;
          }
        }
        {
          const got = wrecks.update(
            dt, now * 0.001, player.position,
            swimming && player.position.y < seaSurfaceAt(player.position.x, player.position.z, now * 0.001) - 0.4,
          );
          if (got) {
            soundsRef.current?.fanfare?.();
            vibeBalanceRef.current = Math.max(0, vibeBalanceRef.current) + got.reward;
            setVibeBalanceTick((n) => n + 1);
            persistVibeBalanceRef.current?.();
            toast.success(`+${got.reward} ✦ VIBE — ${got.label}`, {
              description: "Salvaged from the bay floor.",
            });
          }
        }
      }
      // Also after the camera block, and for the same kind of reason: the
      // spray quads have no billboard material, they are faced by copying the
      // camera's world quaternion. Do it before the camera has moved and every
      // particle is aimed one frame behind, which shows up as the whole plume
      // shearing whenever you swing the view — during a crash, which is the
      // only time you ever see it, and exactly when the view is swinging.
      carSink.update(dt, camera);
      crashFx.update(dt, camera);

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

      if (!devSkipRender) renderer.render(scene, camera);
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
      setDanceRef.current = null;
      mountAvatarHoloRef.current = null;
      disposeHolo();
      procPilot?.dispose();
      procPilot = null;
      setPlayerScaleRef.current = null;
      travelRef.current = null;
      resetRunRef.current = null;
      vibeyExciteRef.current = null;
      mountActionRef.current=null; activeMountRef.current=null; skyTagRef.current=false;
      squadApi?.dispose();
      setSquad(null);
      pegasus.dispose(); dragon.dispose(); turkey.dispose(); thanks.dispose(); setThanksRef.current = null;
      danceFloor.dispose();
      club.dispose();
      stairPad.geometry.dispose();
      stairMat.dispose();
      mp.dispose();
      mpRef.current = null;
      postWorldEvent("leave");
      liveDirector?.dispose();
      liveFeed?.dispose();
      weatherRef.current = null;
      setWeatherRef.current = null;
      weather.dispose();
      wishSites.dispose();
      newsstand.dispose();
      studioEmbassy.dispose();
      graffitiWallRef.current = null;
      graffitiWall.dispose();
      agentResidents.dispose();
      agentResidentsRef.current = null;
      unsubRoster();
      rosterBoard.dispose();
      mayhem.dispose();
      mayhemRef.current = null;
      district.dispose();
      landmarks.dispose();
      neon.dispose();
      birds.dispose();
      bay.dispose();
      folk.dispose();
      folkRef.current = null;
      wetStreets.dispose();
      citySky.dispose();
      landmarksRef.current = null;
      wizard.dispose();
      wizardNpc.dispose();
      setWizardApi(null);
      mayhem.dispose();
      hideouts.dispose();
      arcade.dispose();
      race.dispose();
      ocean.dispose();
      underwater.dispose();
      splash.dispose();
      carSink.dispose();
      wrecks.dispose();
      trench.dispose();
      headMount.dispose();
      backMount.dispose();

      delete devWindow.__cityDebug;
      delete (window as unknown as Record<string, unknown>).__cityCam;
      delete (window as unknown as Record<string, unknown>).__cityGoto;
      delete (window as unknown as Record<string, unknown>).__cityWarp;
      delete (window as unknown as Record<string, unknown>).__cityOcean;
      delete (window as unknown as Record<string, unknown>).__cityDay;
      delete (window as unknown as Record<string, unknown>).__citySwim;
      delete (window as unknown as Record<string, unknown>).__citySnow;
      delete (window as unknown as Record<string, unknown>).__cityHat;
      delete (window as unknown as Record<string, unknown>).__citySwimPose;
      delete (window as unknown as Record<string, unknown>).__cityRig;
      delete (window as unknown as Record<string, unknown>).__cityChar;
      delete (window as unknown as Record<string, unknown>).__citySwimState;
      delete (window as unknown as Record<string, unknown>).__cityDive;
      delete (window as unknown as Record<string, unknown>).__cityDrive;
      delete (window as unknown as Record<string, unknown>).__cityKartState;
      delete (window as unknown as Record<string, unknown>).__cityKartAge;
      delete (window as unknown as Record<string, unknown>).__cityAvatar;
      delete (window as unknown as Record<string, unknown>).__cityCarsNear;
      delete (window as unknown as Record<string, unknown>).__cityJetpack;
      delete (window as unknown as Record<string, unknown>).__cityTrench;
      delete (window as unknown as Record<string, unknown>).__cityTrenchReset;
      delete (window as unknown as Record<string, unknown>).__cityWrecks;
      delete (window as unknown as Record<string, unknown>).__cityWrecksReset;
      delete (window as unknown as Record<string, unknown>).__cityVibe;
      soundsRef.current?.dispose();
      soundsRef.current = null;
      musicRef.current?.dispose();
      musicRef.current = null;
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
      clubSpawnRef.current = null;
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
      /* releaseRenderer, not dispose: three r160's dispose() drops its own caches and
         leaves the GL context to the garbage collector. See docs/performance.md. */
      releaseRenderer(renderer);
    };
  }, []);

  // Global day/night state lives in `world_settings` so the whole lobby
  // agrees on time-of-day across refreshes and devices. We fetch once at
  // mount, then subscribe to realtime updates so any visitor's toggle
  // propagates to everyone instantly.
  useEffect(() => {
    let cancelled = false;
    // `?sky=sunset` (or day, night, aurora) pins a look for a demo or a
    // screenshot and ignores the lobby's shared setting.
    const pinned = parseLook(new URLSearchParams(window.location.search).get("sky"));
    if (pinned) {
      skyLookRef.current = pinned;
      setSkyLook(pinned);
      const day = isDayLook(pinned);
      dayModeRef.current = day;
      setDayMode(day);
      applyModeRef.current?.(day);
      return;
    }
    const applyFromRow = (row: { value: unknown } | null) => {
      if (cancelled || !row) return;
      const v = row.value as { day?: boolean; look?: unknown } | null;
      const day = !!v?.day;
      // Older clients only write `day`; keep a compatible look.
      const look = lookFor(day, parseLook(v?.look) ?? skyLookRef.current);
      skyLookRef.current = look;
      setSkyLook(look);
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
    const spawn = directSpawn(routerLocation.search);
    if (spawn) {
      if (spawn === "hub") hubSpawnRef.current?.();
      else if (spawn === "moon") moonSpawnRef.current?.();
      else if (spawn === "club") clubSpawnRef.current?.();
      else if (spawn === "mars") marsSpawnRef.current?.();
      else if (spawn === "tjs") tjsSpawnRef.current?.();
      else if (spawn === "ski") skiTravelRef.current?.("peak");
      else if (spawn === "vibestar") vibeStarSpawnRef.current?.();
      else if (spawn === "underworld" || spawn === "mines") {
        // Direct portal into the Gremlin Mines — no falling down a
        // mineshaft, just blink straight in with the entry-flash effect.
        enterUndergroundRef.current?.();
      } else {
        islandSpawnRef.current?.();
        setArriving(true);
      }
      // Skip the entry overlay — visitors arriving from the hub already chose
      // where to land, so drop them straight into control. Usually already
      // true, set on the first render; this also covers the Island chip being
      // clicked while the visitor is standing in the city.
      if (!enteredRef.current) {
        enteredRef.current = true;
        setEntered(true);
      }
      /* Outside that guard, unlike everywhere else, because it used to be
         inside it and `entered` now starts true for these arrivals — leaving it
         there would silence every world reached by a spawn link. */
      ensureAudio();
    }
  }, [routerLocation.search]);


  // Send a God Orb wish to the build queue (+ Telegram ping to the
  // builder). The promise made in-world: granted within ~10 hours.
  const submitWish = async () => {
    const text = wishText.trim();
    if (!text || wishSending) return;
    setWishSending(true);
    try {
      const ownerRef =
        authUserId ?? (typeof window !== "undefined" ? localStorage.getItem("city.guestId") : null);
      const { error } = await supabase.functions.invoke("god-orb-wish", {
        body: { text, author: playerName || "anonymous", owner_ref: ownerRef },
      });
      if (error) throw error;
      setWishDone(true);
      wishBurstRef.current?.();
    } catch {
      toast.error("The orb flickered — try again in a moment.");
    } finally {
      setWishSending(false);
    }
  };

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
    ensureAudio();
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
        {nearPerson && !chatTarget && !isLive && (
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
            {!IOS_APP && (
            <button
              onClick={(e) => {
                e.currentTarget.blur();
                setChatTarget(nearPerson);
              }}
              className="glass-panel rounded-full px-3 py-1.5 text-xs text-primary whitespace-nowrap shadow-[0_0_18px_hsl(var(--primary)/0.55)]"
            >
              💬 Message
            </button>
            )}
            {nearPerson.kind === "agent" && (
              <button
                onClick={(e) => {
                  e.currentTarget.blur();
                  setDuelTarget(nearPerson);
                  soundsRef.current?.chime(3);
                }}
                className="glass-panel rounded-full px-3 py-1.5 text-xs text-emerald-300 whitespace-nowrap shadow-[0_4px_18px_rgba(0,0,0,0.55)]"
              >
                ✊ Duel
              </button>
            )}
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
      {entered && !isLive && (
        <div className="absolute bottom-4 left-4 glass-panel rounded-2xl px-4 py-3 text-xs font-mono space-y-1 pointer-events-none">
          <div className="flex items-center gap-2">
            <Rocket
              className={`w-3.5 h-3.5 ${hud.jet ? "text-primary animate-pulse" : "text-muted-foreground"}`}
            />
            <span className={hud.jet ? "text-primary" : "text-muted-foreground"}>
              {mountKind === "helicopter" ? "ROTOR" : mountKind ? "WINGS" : "JETPACK"} {hud.jet ? (mountKind === "helicopter" ? "CLIMBING" : mountKind ? "FLAPPING" : "FIRING") : (mountKind === "helicopter" ? "HOVERING" : mountKind ? "GLIDING" : "READY")}
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

      {/* Tag mini-game HUD: only appears once you've bumped another player. */}
      {entered && <TagHud game={tagGameRef.current} />}

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
      {entered && !isLive && (
        <div
          ref={hudWrapRef}
          /* Centred by `inset-x-0` + `items-center`, not by `left-1/2` and a
             translate. The old pair looks like centring and is also a width
             cap: an absolutely positioned box whose containing block starts at
             the 50% mark has only the right half of the screen to grow into, so
             the strip could never exceed 50vw however much room was going. The
             ten chips want 752px, which meant three rows at 900px and two rows
             at 1440px — the `max-w-[62vw]` written here never once applied.

             `pointer-events-none` because the wrapper now spans the whole width
             and would otherwise swallow clicks on the sky across the top of the
             world; the strip itself takes them back.

             And it sits at `top-16` at every width now, rather than sliding up
             to `top-3` on a desktop. A full-width strip on the same band as the
             global nav runs underneath the Worlds pill, which is `z-40` to this
             HUD's `z-10` — so between 900 and 1024 the mute chip was covered
             and simply did not take clicks. Hit-tested, not guessed. The nav
             owns that row; this one goes below it. */
          className="absolute top-16 right-4 z-10 flex flex-col items-end gap-2 md:inset-x-2 md:items-center md:pointer-events-none"
        >
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
          <div
            className={`${
              hudMenuOpen ? "flex" : "hidden"
            } md:flex flex-wrap justify-end gap-2 max-w-[88vw] md:pointer-events-auto md:justify-center md:gap-1.5 md:max-w-full md:rounded-full md:bg-background/40 md:backdrop-blur-md md:border md:border-border/40 md:px-2 md:py-1.5`}
          >
            <button
              onClick={(e) => {
                const next = !muted;
                setMuted(next);
                soundsRef.current?.setMuted(next);
                musicRef.current?.setMuted(next);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-3 py-2 text-xs hover:bg-muted/50 transition-colors"
              title={muted ? "Unmute" : "Mute"}
            >
              {muted ? "🔇" : "🔊"}
            </button>
            <button
              onClick={(e) => {
                // Day, Sunset, Night, Aurora, round and round.
                const i = SKY_LOOKS.findIndex((l) => l.look === lookFor(dayMode, skyLook));
                const nextLook = SKY_LOOKS[(i + 1) % SKY_LOOKS.length];
                const next = nextLook.day;
                skyLookRef.current = nextLook.look;
                setSkyLook(nextLook.look);
                dayModeRef.current = next;
                setDayMode(next);
                applyModeRef.current?.(next);
                mpRef.current?.sendTimeMode(next);
                // Persist the lobby-wide toggle so every visitor — even
                // ones that land later or hard-refresh — sees the same
                // time of day. Realtime will broadcast to live peers.
                void supabase
                  .from("world_settings")
                  .upsert({ key: "time_mode", value: { day: next, look: nextLook.look }, updated_at: new Date().toISOString() });
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-3.5 py-2 text-xs hover:bg-muted/50 transition-colors"
              title="Change the sky for the whole lobby: Day, Sunset, Night, Aurora"
            >
              {(() => {
                const cur = SKY_LOOKS.find((l) => l.look === lookFor(dayMode, skyLook)) ?? SKY_LOOKS[2];
                return `${cur.emoji} ${cur.label}`;
              })()}
            </button>
            <button
              onClick={(e) => {
                const next = !thanksOn;
                setThanksOn(next);
                saveThanksgiving(next);
                setThanksRef.current?.(next);
                e.currentTarget.blur();
              }}
              className={`glass-panel rounded-full px-3.5 py-2 text-xs transition-colors ${thanksOn ? "text-amber-300" : "hover:bg-muted/50 text-muted-foreground"}`}
              title={thanksOn ? "Turn the Thanksgiving decorations off" : "Turn the Thanksgiving decorations on"}
              data-testid="thanksgiving-toggle"
              aria-pressed={thanksOn}
            >
              {thanksOn ? "🦃 Thanksgiving" : "🦃 Off"}
            </button>
            {/* GOD MODE — summon weather. Opens a little palette rather
                than cycling, so you can go straight to the storm. */}
            <div className="relative">
              <button
                onClick={(e) => {
                  setGodPanelOpen((v) => !v);
                  e.currentTarget.blur();
                }}
                className="glass-panel rounded-full px-3.5 py-2 text-xs hover:bg-muted/50 transition-colors"
                title="God mode — change the weather"
                data-testid="god-mode"
              >
                {weatherKind === "clear"
                  ? "⚡ God mode"
                  : `${WEATHERS.find((w) => w.kind === weatherKind)?.emoji} ${
                      WEATHERS.find((w) => w.kind === weatherKind)?.label
                    }`}
              </button>
              {godPanelOpen && (
                <div className="glass-panel absolute right-0 top-11 z-20 flex flex-col gap-1 rounded-2xl p-2">
                  <div className="px-2 pb-1 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    God mode
                  </div>
                  {WEATHERS.map((w) => (
                    <button
                      key={w.kind}
                      onClick={(e) => {
                        setWeatherRef.current?.(w.kind);
                        setGodPanelOpen(false);
                        e.currentTarget.blur();
                      }}
                      data-testid={`weather-${w.kind}`}
                      className={`flex items-center gap-2 whitespace-nowrap rounded-xl px-3 py-1.5 text-xs transition-colors ${
                        weatherKind === w.kind
                          ? "bg-primary/25 text-primary"
                          : "hover:bg-muted/50"
                      }`}
                    >
                      <span>{w.emoji}</span>
                      {w.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
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
                setAvatarDashOpen(true);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-3.5 py-2 text-xs hover:bg-muted/50 transition-colors"
            >
              🎭 {charName.replace(/_/g, " ")}
            </button>
            <button
              onClick={(e) => {
                setStickerOpen((v) => !v);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-3.5 py-2 text-xs hover:bg-muted/50 transition-colors"
            >
              ✨ Stickers
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
            <button
              onClick={(e) => {
                setWhatsNewOpen(true);
                setHudMenuOpen(false);
                if (document.pointerLockElement) document.exitPointerLock();
                e.currentTarget.blur();
              }}
              className="relative glass-panel rounded-full px-3.5 py-2 text-xs hover:bg-muted/50 transition-colors"
              title="What's New: every update, with dates"
            >
              ✨ New
              {whatsNewUnseen > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[1rem] h-4 px-1 rounded-full bg-amber-300 text-[10px] font-bold text-black flex items-center justify-center">
                  {whatsNewUnseen}
                </span>
              )}
            </button>
            {whatsNewOpen && (
              <Suspense fallback={null}>
                <WhatsNewSheet onClose={() => setWhatsNewOpen(false)} />
              </Suspense>
            )}
          </div>
          {emoteWheelOpen && (
            /* Two grids tall now that the dance shelf is in here, which is
               taller than a phone held in landscape — hence the scroll. */
            <div className="glass-panel rounded-2xl p-3 w-60 max-h-[70dvh] overflow-y-auto animate-scale-in">
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
                      // 💃 is a promise the sprite alone can't keep: throw the
                      // emoji AND actually dance.
                      if (name === "dance") setDanceRef.current?.(randomDanceId(activeDance));
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
              <div className="flex items-center justify-between text-[11px] mt-3 mb-2">
                <span className="font-heading font-semibold tracking-wider text-primary">
                  DANCE FLOOR
                </span>
                <span className="text-muted-foreground">press T</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {DANCES.map((d) => {
                  const on = activeDance === d.id;
                  return (
                    <button
                      key={d.id}
                      onClick={(e) => {
                        setDanceRef.current?.(on ? null : d.id);
                        e.currentTarget.blur();
                      }}
                      className={`flex flex-col items-center justify-center gap-1 rounded-xl transition-colors py-2 text-2xl ${
                        on
                          ? "bg-primary/25 ring-1 ring-primary/60"
                          : "bg-muted/30 hover:bg-muted/60"
                      }`}
                      title={d.blurb}
                    >
                      <span>{d.emoji}</span>
                      <span className="text-[9px] leading-tight text-center uppercase tracking-wider text-muted-foreground">
                        {d.label}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
                Everyone dances on the same beat. Walk to stop.
              </p>
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
                    {IOS_APP && !m.self && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.currentTarget.blur();
                          openSafety({ name: m.name, id: m.fromId, text: m.text, world: "city" });
                        }}
                        aria-label={`Report or block ${m.name}`}
                        className="ml-1 px-1 text-muted-foreground hover:text-foreground align-middle"
                      >
                        ⋯
                      </button>
                    )}
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
          {stickerOpen && (
            <div className="glass-panel rounded-2xl p-3 w-64 space-y-2" onKeyDown={(e) => e.stopPropagation()}>
              <div className="text-xs font-heading text-foreground">Pick a sticker, then tap where it goes</div>
              <div className="grid grid-cols-6 gap-1">
                {STICKER_ART.map((a) => (
                  <button key={a} onClick={() => setStickerArt(a)} className={`text-lg rounded-lg py-1 ${stickerArt === a ? "bg-primary/30 ring-1 ring-primary" : "hover:bg-muted/50"}`}>{a}</button>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-1">
                {STICKER_SLOTS.map((slot) => {
                  const on = stickers.find((x) => x.slot === slot.id);
                  return (
                    <button key={slot.id} onClick={() => setStickers((l) => on && on.art === stickerArt ? l.filter((x) => x.slot !== slot.id) : placeSticker(l, { art: stickerArt, slot: slot.id }))} className={`text-[11px] rounded-lg px-1 py-1.5 ${on ? "bg-primary/20 text-primary" : "bg-muted/30 text-foreground/80 hover:bg-muted/50"}`}>
                      {on ? on.art + " " : ""}{slot.label}
                    </button>
                  );
                })}
              </div>
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>Everyone nearby sees them</span>
                <button onClick={() => setStickers([])} className="hover:text-foreground">Clear all</button>
              </div>
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

      {/* Vibe Shop dialog: the neon kiosk's marquee and string lights around
          the shared shop shelves. The island's kiosk and the Vibe Arms stall
          in town both open it. */}
      {entered && shopOpen && (
        <div
          className="fixed inset-0 z-40 flex items-end sm:items-center justify-center p-3 sm:p-6 bg-background/70 backdrop-blur-sm"
          onClick={() => setShopOpen(false)}
        >
          <div
            className="rounded-2xl w-full max-w-2xl max-h-[90dvh] flex flex-col overflow-hidden ring-1 ring-emerald-300/30 shadow-[0_0_60px_rgba(45,212,168,0.18)]"
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
                      {shopWeaponsFirst ? "VIBE ARMS" : "VIBE SHOP"}
                    </div>
                    <div className="text-[10px] uppercase tracking-[0.24em] text-emerald-200/50">
                      {shopWeaponsFirst ? "vibe city plaza · same shop, same stock" : "backed by $VIBE · Vibe Island flagship"}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-emerald-300/10 ring-1 ring-emerald-300/40 px-2.5 py-1 text-xs font-heading font-semibold tabular-nums text-[#7dffd4]">
                    {coinBalance == null ? "…" : formatVibecoin(coinBalance, { compact: false })}
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
              {!IOS_APP && !shopWeaponsFirst && (
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
              )}

              {/* The same shelves as /shop and the arcade: one till, one
                  inventory. Weapons lead when you walked up to Vibe Arms. */}
              <ItemShelves weapons={shopWeaponsFirst ? "first" : "last"} />
              <CharacterShelf />
              <div className="text-[10px] text-emerald-100/45 text-center pb-1 leading-relaxed">
                Bought with Vibey Coins, yours on every device. Hats and jetpacks change as you tap
                them; a new character arrives on your next visit.{" "}
                <Link to="/profile" className="underline hover:text-emerald-100">
                  Stickers and your locker are on My Vibe
                </Link>
                .
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Touch controls for phones: joystick + jetpack button. */}
      {entered && !IOS_APP && (
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
      <ArcadeCabinet game={cabinetGame} onClose={closeCabinet} />
      <KartRaceHud
        ui={raceUi}
        lobby={raceLobby}
        balance={vibeBalanceRef.current}
        onStart={(b) => raceStartRef.current?.(b)}
        onClose={() => setRaceLobby(false)}
      />
      {!IOS_APP && <RockPaperScissors open={rpsOpen} onClose={() => setRpsOpen(false)} />}
      {!IOS_APP && <RpsDevHook onOpen={() => setRpsOpen(true)} />}
      <PhotoGalleryModal
        open={galleryOpen}
        photos={galleryPhotos}
        onClose={() => setGalleryOpen(false)}
      />
      {avatarDashOpen && (
        <CharacterDashboardModal
          activeId={charName}
          onPick={(id) => {
            const i = CHARACTERS.findIndex((c) => c.name === id);
            if (i >= 0) setAvatarPreviewIdx(i);
            setCharName(id);
            charRef.current = id;
            setActiveCharacter(id);
            loadPilotRef.current?.(id);
          }}
          onClose={() => setAvatarDashOpen(false)}
        />
      )}




      {/* 1:1 chat with a nearby player or AI agent. */}
      {entered && !IOS_APP && (
        <PersonChatPanel
          open={!!chatTarget}
          onClose={() => setChatTarget(null)}
          target={chatTarget}
          authUserId={authUserId}
          myName={playerName}
        />
      )}

      {nearNews && !duelTarget && !chatTarget && !isLive && (
        <div className={`absolute ${isTouch ? "bottom-[15.5rem] landscape:bottom-6" : "bottom-24"} left-1/2 z-30 -translate-x-1/2`}>
          <a
            href="/times"
            className="glass-panel block rounded-full px-4 py-2 text-sm text-primary whitespace-nowrap shadow-[0_0_18px_hsl(var(--primary)/0.55)]"
            data-testid="read-times"
          >
            📰 read today's Vibe Times
          </a>
        </div>
      )}

      {nearStudio && !duelTarget && !chatTarget && !isLive && (
        <div className={`absolute ${isTouch ? "bottom-[15.5rem] landscape:bottom-6" : "bottom-24"} left-1/2 z-30 -translate-x-1/2`}>
          <a
            href="https://vibe-ventures-studio.lovable.app/?from=vibeverse"
            target="_blank"
            rel="noreferrer"
            className="glass-panel block rounded-full px-4 py-2 text-sm text-primary whitespace-nowrap shadow-[0_0_18px_hsl(var(--primary)/0.55)]"
            data-testid="visit-studio"
          >
            🌐 visit Vibe Ventures Studio →
          </a>
        </div>
      )}

      {nearGraffiti && !duelTarget && !chatTarget && !isLive && !IOS_APP && (
        <div className={`absolute ${isTouch ? "bottom-[15.5rem] landscape:bottom-6" : "bottom-24"} left-1/2 z-30 w-[min(92vw,26rem)] -translate-x-1/2`}>
          <form
            className="glass-panel flex items-center gap-2 rounded-full px-3 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              const text = graffitiText.trim();
              if (!text || graffitiSending) return;
              setGraffitiSending(true);
              void supabase.functions
                .invoke("vibe-world", {
                  body: {
                    action: "graffiti",
                    text,
                    author_name: localStorage.getItem("city.playerName") ?? "someone",
                  },
                })
                .then(() => {
                  setGraffitiText("");
                  setTimeout(() => graffitiWallRef.current?.refresh(), 600);
                })
                .finally(() => setGraffitiSending(false));
            }}
          >
            <span aria-hidden>✍️</span>
            <input
              value={graffitiText}
              onChange={(e) => setGraffitiText(e.target.value)}
              maxLength={120}
              placeholder="write on the wall…"
              data-testid="graffiti-input"
              className="min-w-0 flex-1 bg-transparent text-sm focus:outline-none placeholder:text-muted-foreground/70"
            />
            <button
              type="submit"
              disabled={!graffitiText.trim() || graffitiSending}
              data-testid="graffiti-send"
              className="rounded-full bg-primary/90 px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-40"
            >
              post
            </button>
          </form>
        </div>
      )}

      {duelTarget && (
        <RpsDuelModal
          agentName={duelTarget.name}
          onWin={() => agentResidentsRef.current?.celebrateAt(duelTarget.ref)}
          onClose={() => setDuelTarget(null)}
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
        >
          <div className="absolute inset-0 bg-purple-700/30 backdrop-blur-md" />
          <div className="relative glass-panel rounded-2xl px-6 py-4 text-center animate-scale-in border border-purple-400/60 shadow-[0_0_40px_rgba(183,138,255,0.6)]">
            <div className="text-5xl mb-1">🥷</div>
            <div className="text-sm font-semibold text-purple-200">THE GREMLIN MINES</div>
            <div className="text-xs text-purple-300/80">Purple mist deadens your jetpack…</div>
          </div>
        </div>
      )}

      {/* Underground HUD: your hearts, boss HP, the run's haul, exit.
          It used to sit dead centre at top-20, underneath the world
          toolbar — unreadable on a phone. Tucked into the left margin
          it clears both the toolbar and the touch sticks. */}
      {entered && underground && (
        <div className="fixed top-16 left-2 sm:left-3 z-30 flex flex-col items-start gap-1.5 pointer-events-none">
          <div className="glass-panel rounded-full px-3 py-1.5 text-xs text-rose-100 border border-rose-400/40 shadow-[0_0_20px_rgba(255,120,150,0.35)] bg-rose-950/40 backdrop-blur-md flex items-center gap-2">
            <span>🥷 You</span>
            <span className="font-mono tracking-widest">
              {Array.from({ length: MINES_HEARTS }).map((_, i) => (
                <span key={i} className={i < minesHearts ? "text-rose-300" : "text-rose-900/50"}>
                  ❤
                </span>
              ))}
            </span>
          </div>
          <div className="glass-panel rounded-full px-3 py-1.5 text-xs text-purple-200 border border-purple-400/40 shadow-[0_0_20px_rgba(183,138,255,0.4)] bg-purple-950/40 backdrop-blur-md flex items-center gap-2">
            <span>⚔ Boss</span>
            <span className="font-mono tracking-widest">
              {Array.from({ length: 3 }).map((_, i) => (
                <span key={i} className={i < bossHp ? "text-rose-300" : "text-rose-900/50"}>
                  ❤
                </span>
              ))}
            </span>
          </div>
          <div className="glass-panel rounded-full px-3 py-1.5 text-xs text-amber-100 border border-amber-300/40 bg-amber-950/30 backdrop-blur-md flex items-center gap-3 font-mono">
            <span>🪙 {minesGold}</span>
            <span>👣 {minesStomps}</span>
          </div>
          <button
            onClick={() => exitUndergroundRef.current?.()}
            className="pointer-events-auto glass-panel rounded-full px-3 py-1.5 text-xs text-cyan-100 border border-cyan-300/50 shadow-[0_0_18px_rgba(122,235,255,0.5)] hover:bg-cyan-500/15 transition-colors"
          >
            🔼 Return to surface
          </button>
        </div>
      )}

      {/* Charge tell — the boss is about to run you down. Mirrors the
          red ring that lights up under it in the 3D scene, for anybody
          looking at their own feet when it starts. */}
      {entered && underground && bossWarning && minesKo === 0 && (
        <div className="pointer-events-none fixed top-1/3 left-1/2 -translate-x-1/2 z-30 animate-fade-in">
          <div className="glass-panel rounded-full px-4 py-1.5 text-xs font-semibold tracking-wide text-rose-100 border border-rose-400/70 bg-rose-950/60 shadow-[0_0_28px_rgba(255,60,90,0.6)]">
            ⚠ THE BOSS IS CHARGING — MOVE
          </div>
        </div>
      )}

      {/* Knocked out of the mines: three hits and the clan wins. */}
      {entered && minesKo > 0 && (
        <div
          key={minesKo}
          className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center animate-fade-in"
        >
          <div className="absolute inset-0 bg-rose-900/30 backdrop-blur-[2px]" />
          <div className="relative glass-panel rounded-2xl px-6 py-4 text-center animate-scale-in border border-rose-400/60 shadow-[0_0_40px_rgba(255,80,110,0.6)]">
            <div className="text-5xl mb-1">💀</div>
            <div className="text-sm font-semibold text-rose-200">THE GREMLINS WIN</div>
            <div className="text-xs text-rose-100/80">
              You keep every ✦ you banked. The mines reset.
            </div>
          </div>
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



      {/* God Orb wish portal — ask the universe, it gets built. */}
      {wishOpen && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-background/70 backdrop-blur-sm"
          onClick={() => {
            setWishOpen(false);
            setWishDone(false);
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl overflow-hidden ring-1 ring-amber-300/40 shadow-[0_0_60px_rgba(255,200,100,0.25)]"
            style={{ background: "radial-gradient(120% 120% at 50% 0%, #2a2040 0%, #171226 55%, #0d0a18 100%)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 space-y-4 text-center">
              <div className="text-4xl">🔮</div>
              <div>
                <h2 className="font-heading text-xl font-bold tracking-[0.14em] text-amber-200"
                    style={{ textShadow: "0 0 18px rgba(255,200,100,0.6)" }}>
                  THE GOD ORB
                </h2>
                <p className="text-xs text-amber-100/60 mt-1 tracking-wide">
                  every builder grows the universe
                </p>
              </div>
              {wishDone ? (
                <div className="space-y-4">
                  <p className="text-sm text-amber-50/90 leading-relaxed">
                    🌠 The universe heard you. Your wish is in the build
                    queue — check back soon and it'll be part of the world.
                  </p>
                  <button
                    onClick={() => {
                      setWishOpen(false);
                      setWishDone(false);
                      setWishText("");
                    }}
                    className="w-full h-11 rounded-xl bg-amber-300 text-amber-950 font-semibold hover:bg-amber-200 transition-colors"
                  >
                    Back to the island
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-amber-50/80 leading-relaxed">
                    Ask for anything — a building, a creature, a game, a
                    whole new island — and the universe will build it.
                  </p>
                  <textarea
                    autoFocus
                    value={wishText}
                    onChange={(e) => setWishText(e.target.value.slice(0, 500))}
                    placeholder="I wish the island had…"
                    rows={3}
                    className="w-full rounded-xl bg-white/5 border border-amber-200/25 focus:border-amber-200/60 outline-none p-3 text-sm text-amber-50 placeholder:text-amber-100/30 resize-none"
                  />
                  <button
                    onClick={() => void submitWish()}
                    disabled={wishSending || !wishText.trim()}
                    className="w-full h-11 rounded-xl bg-amber-300 text-amber-950 font-semibold hover:bg-amber-200 transition-colors disabled:opacity-40"
                  >
                    {wishSending ? "Sending to the universe…" : "Send it to the universe"}
                  </button>
                  <p className="text-[10px] text-amber-100/45 tracking-wide">
                    wishes are currently granted within ~10 hours ·
                    soon: ~10 minutes ⚡
                  </p>
                </div>
              )}
            </div>
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
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* On-snow hint chip while you're on Powder Peak. */}
      {entered && onPowderPeak && !gameHud && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-30 glass-panel rounded-full px-4 py-2 text-xs">
          <span className="text-primary font-heading font-semibold">⛷ POWDER PEAK</span>
          <span className="text-muted-foreground"> · carve with A/D · Space hops · jetpack = ski lift</span>
          <Link to="/summit" className="ml-3 rounded-full bg-sky-400/90 px-3 py-1 font-semibold text-slate-900 hover:bg-sky-300">
            🏔 Big mountain: Vibe Summit →
          </Link>
        </div>
      )}

      {/* Moon Golf status chip while you're on the lunar pad. */}
      {entered && moonGolfHud && !gameHud && !onPowderPeak && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-30 glass-panel rounded-full px-4 py-2 text-xs">
          <span className="text-primary font-heading font-semibold">{moonGolfHud}</span>
        </div>
      )}

      {/* THE GETAWAY: bounty chip while the kart is loose — dismissible. */}
      {entered && heistChaseOn && !heistChipDismissed && !gameHud && !onPowderPeak && !rebelHud?.active && (
        <div className="fixed top-28 left-1/2 -translate-x-1/2 z-30 glass-panel rounded-full pl-4 pr-1.5 py-1.5 text-xs border border-rose-400/40 shadow-[0_0_24px_rgba(244,63,94,0.35)] flex items-center gap-2 animate-fade-in">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-70 animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-rose-400" />
          </span>
          <span className="text-rose-300 font-heading font-semibold">GETAWAY KART LOOSE</span>
          <span className="text-muted-foreground hidden sm:inline">· ram it for +25 ✦</span>
          <button
            onClick={(e) => {
              setHeistChipDismissed(true);
              e.currentTarget.blur();
            }}
            aria-label="Dismiss"
            className="ml-0.5 grid place-items-center h-5 w-5 rounded-full text-muted-foreground/70 hover:text-foreground hover:bg-white/10 transition-colors"
          >
            ✕
          </button>
        </div>
      )}

      {/* Samurai bodyguards: hire, order, type or talk. */}
      <SquadPanel squad={squad} hidden={!entered || underground || Boolean(gameHud) || Boolean(rebelHud?.active)} />

      {/* GTA Junior: wanted stars, the gun in hand, and a fire button on touch. */}
      {entered && !gameHud && !rebelHud?.active && (mayhemHud.stars > 0 || mayhemHud.gun || mayhemHud.bombs !== null) && (
        <div className="fixed top-40 right-4 z-30 glass-panel rounded-2xl px-3 py-2 text-xs flex flex-col items-end gap-1 pointer-events-none select-none">
          {mayhemHud.stars > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[15px] tracking-tight">
                <span className="text-amber-300 drop-shadow-[0_0_6px_rgba(252,211,77,0.8)]">{"★".repeat(mayhemHud.stars)}</span>
                <span className="text-muted-foreground/30">{"★".repeat(5 - mayhemHud.stars)}</span>
              </span>
            </div>
          )}
          {mayhemHud.stars > 0 && (
            <span className="text-rose-300 font-heading font-semibold">
              {mayhemHud.cops > 0 ? `🚓 ${mayhemHud.cops} on your tail` : "🚨 Police on the way"}
            </span>
          )}
          {mayhemHud.stars > 0 && mayhemHud.forgiveIn !== null && (
            <span className="text-muted-foreground tabular-nums">
              Lie low {Math.floor(mayhemHud.forgiveIn / 60)}:{String(mayhemHud.forgiveIn % 60).padStart(2, "0")} and they let it go
            </span>
          )}
          {mayhemHud.gun && (
            <span className="text-foreground/90">
              {GUNS[mayhemHud.gun].emoji} {GUNS[mayhemHud.gun].label}
              <span className="text-muted-foreground"> · {isTouch ? "hold FIRE · tap a gun to switch" : "R or Q fire · 1 to 5 or G switch"}</span>
            </span>
          )}
          {mayhemHud.bombs !== null && (
            <span className="text-foreground/90">
              {"🍍".repeat(mayhemHud.bombs)}
              <span className="opacity-25">{"🍍".repeat(Math.max(0, 3 - mayhemHud.bombs))}</span>
              <span className="text-muted-foreground"> · {isTouch ? "tap 🍍" : "X throw"}</span>
            </span>
          )}
        </div>
      )}
      {/* The weapon bar: one button per gun you own, so a gun you just bought
          is one tap away on a phone (there is no G key there). Tapping the gun
          in your hand puts it away. On a keyboard 1 to 5 do the same. */}
      {entered && !gameHud && !rebelHud?.active && mayhemHud.owned.length > 0 && (
        <div
          className={`fixed z-30 flex gap-1.5 select-none ${
            isTouch ? "bottom-48 right-[5.75rem] flex-row" : "right-4 top-1/2 -translate-y-1/2 flex-col"
          }`}
          role="toolbar"
          aria-label="Weapons"
        >
          {GUN_SLOTS.filter((k) => mayhemHud.owned.includes(k)).map((k, i) => {
            const active = mayhemHud.gun === k;
            return (
              <button
                key={k}
                onClick={() => mayhemRef.current?.select(active ? null : k)}
                aria-pressed={active}
                aria-label={active ? `Put away the ${GUNS[k].label}` : `Draw the ${GUNS[k].label}`}
                title={GUNS[k].label}
                className={`relative grid h-12 w-12 place-items-center rounded-xl text-2xl transition-transform active:scale-90 touch-manipulation ${
                  active
                    ? "bg-amber-400/90 shadow-[0_0_18px_rgba(251,191,36,0.6)] ring-2 ring-white/80"
                    : "glass-panel opacity-80 hover:opacity-100"
                }`}
              >
                <span className="leading-none">{GUNS[k].emoji}</span>
                {!isTouch && (
                  <span className="absolute bottom-0.5 right-1 font-heading text-[9px] font-bold text-white/80">{i + 1}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {entered && isTouch && mayhemHud.gun && !rebelHud?.active && (
        <button
          onPointerDown={(e) => {
            touchFireRef.current = true;
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }}
          onPointerUp={() => {
            touchFireRef.current = false;
          }}
          onPointerCancel={() => {
            touchFireRef.current = false;
          }}
          className="fixed bottom-48 right-5 z-30 w-16 h-16 rounded-full bg-amber-500/90 text-white font-heading font-bold text-xs shadow-[0_0_24px_rgba(245,158,11,0.5)] active:scale-90 transition-transform select-none touch-none"
        >
          FIRE
        </button>
      )}
      {entered && isTouch && mayhemHud.bombs !== null && !rebelHud?.active && (
        <button
          onPointerDown={(e) => {
            touchThrowRef.current = true;
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }}
          onPointerUp={() => {
            touchThrowRef.current = false;
          }}
          onPointerCancel={() => {
            touchThrowRef.current = false;
          }}
          disabled={mayhemHud.bombs <= 0}
          aria-label="Throw a pineapple bomb"
          className="fixed bottom-[17rem] right-7 z-30 w-12 h-12 rounded-full bg-yellow-400/90 text-xl shadow-[0_0_20px_rgba(250,204,21,0.5)] active:scale-90 transition-transform select-none touch-none disabled:opacity-40"
        >
          🍍
        </button>
      )}

      {/* Rebel Defense battle HUD + FIRE button + hit vignette. */}
      {entered && rebelHud?.active && (
        <>
          <div className="fixed top-16 left-1/2 -translate-x-1/2 z-30 glass-panel rounded-full px-4 py-2 text-xs flex items-center gap-3">
            <span className="text-rose-300 font-heading font-semibold">⭐ REBEL DEFENSE</span>
            <span className="text-muted-foreground">wave {rebelHud.wave} · {rebelHud.kills} down</span>
            <span className="tracking-tighter text-rose-400">
              {"♥".repeat(Math.max(0, rebelHud.hp))}
              <span className="text-muted-foreground/40">{"♥".repeat(Math.max(0, 5 - rebelHud.hp))}</span>
            </span>
          </div>
          <button
            onPointerDown={(e) => {
              rebelFireRef.current?.();
              e.currentTarget.blur();
            }}
            className="fixed bottom-28 right-5 z-30 w-20 h-20 rounded-full bg-rose-500/90 text-white font-heading font-bold text-sm shadow-[0_0_30px_rgba(244,63,94,0.5)] active:scale-90 transition-transform select-none touch-none"
          >
            FIRE
          </button>
        </>
      )}
      {rebelFlash > 0 && (
        <div
          key={rebelFlash}
          className="pointer-events-none fixed inset-0 z-30"
          style={{ background: "radial-gradient(120% 120% at 50% 50%, transparent 55%, rgba(244,63,94,0.4) 100%)" }}
        />
      )}

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

      {entered && <WizardHud wizard={wizardApi} open={wizardOpen} onOpenChange={setWizardOpen} />}
      {/* Bottom-center action stack: context buttons appear as you
          approach things — the zipline, a cow, Jerry, Vibey. */}
      {entered && npcTarget === null && (
        /*
         * On a touchscreen the joystick (bottom-left) and the jump button
         * (bottom-right) live at this same height, and a full-width panel of
         * ride buttons sat squarely on top of the stick, so you could not
         * steer a mount at all. Portrait: lift the whole stack above them.
         * Landscape: keep it low but only as wide as the gap between them.
         */
        <div
          data-testid="action-stack"
          className={`absolute left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-2 ${
            isTouch ? "bottom-[15.5rem] landscape:bottom-6 landscape:max-w-[calc(100vw-22rem)]" : "bottom-24"
          }`}
        >
          {!mountKind && nearMount && drivingKart < 0 && (
            <button
              onClick={(e) => { mountActionRef.current?.(nearMount); e.currentTarget.blur(); }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-primary animate-pulse"
            >
              {nearMount === "dragon" ? "🐉 Ride the dragon" : nearMount === "turkey" ? "🦃 Ride the turkey" : nearMount === "helicopter" ? "🚁 Fly the helicopter" : "🦄 Ride Pegasus"}{isTouch ? "" : " (F)"}
            </button>
          )}
          {mountKind && drivingKart < 0 && (
            <div className={`glass-panel rounded-lg px-3 py-2 flex flex-wrap justify-center items-center gap-2 ${
              isTouch ? "gap-1 px-2 w-[min(36rem,calc(100vw-2rem))] landscape:w-[calc(100vw-22rem)]" : "w-[min(36rem,calc(100vw-2rem))]"
            }`}>
              <>
                <span className="text-xs text-primary">{mountKind === "dragon" ? "🐉 Dragon" : mountKind === "turkey" ? "🦃 Turkey" : mountKind === "helicopter" ? "🚁 Helicopter" : "🦄 Pegasus"}</span>
                {!isTouch && <Button size="sm" variant="ghost" className="text-primary touch-none" aria-label="Flap wings" onPointerDown={(e)=>{e.currentTarget.setPointerCapture(e.pointerId);touchJetRef.current=true;}} onPointerUp={()=>{touchJetRef.current=false;}} onPointerCancel={()=>{touchJetRef.current=false;}}>{mountKind === "helicopter" ? "Climb" : "Flap"}{isTouch ? "" : " · Space"}</Button>}
                <Button size="sm" variant="ghost" className="text-primary touch-none" onPointerDown={(e)=>{e.currentTarget.setPointerCapture(e.pointerId);diveMountRef.current=true;}} onPointerUp={()=>{diveMountRef.current=false;}} onPointerCancel={()=>{diveMountRef.current=false;}}>{mountKind === "helicopter" ? "Descend" : "Dive"}{isTouch ? "" : " · C"}</Button>
                <Button size="sm" variant={skyTagOn ? "default" : "ghost"} onClick={(e)=>{skyTagRef.current=!skyTagRef.current;setSkyTagOn(skyTagRef.current);e.currentTarget.blur();}}>{skyTagOn ? "Stop sky tag" : "Play sky tag"}</Button>
                <Button size="sm" variant="ghost" className="text-primary touch-none" onClick={async()=>{const url=new URL(window.location.href);url.searchParams.set("spawn","island");url.searchParams.delete("net");try {await navigator.clipboard.writeText(url.toString());toast("Riding link copied");} catch {toast("Share this page's address with your friend");}}}>Invite</Button>
                <Button size="sm" variant="ghost" className="text-primary touch-none" onClick={(e)=>{mountActionRef.current?.(null);e.currentTarget.blur();}}>Land & hop off</Button>
                {skyTagOn && <span className="basis-full text-center text-xs text-primary">{skyStatus}</span>}
              </>
            </div>
          )}
          {drivingKart >= 0 && (
            <div className="flex flex-wrap justify-center items-center gap-2 animate-fade-in">
              <span
                className="glass-panel rounded-full px-3 py-2 text-xs flex items-center gap-2"
                title="Vehicle health. At zero it explodes."
                data-testid="vehicle-health"
              >
                <span className={driveHp < 25 ? "animate-pulse" : ""}>{driveHp < 25 ? "🔥" : driveHp < 55 ? "💨" : "🛡️"}</span>
                <span className="relative block h-2 w-20 rounded-full bg-white/15 overflow-hidden">
                  <span
                    className="absolute inset-y-0 left-0 rounded-full transition-all duration-300"
                    style={{
                      width: `${Math.max(0, Math.min(100, driveHp))}%`,
                      background: driveHp < 25 ? "#ef4444" : driveHp < 55 ? "#f59e0b" : "#34d399",
                    }}
                  />
                </span>
                <span className="tabular-nums text-muted-foreground w-7 text-right">{Math.max(0, driveHp)}</span>
              </span>
              {!isTouch && <span className="glass-panel rounded-full px-4 py-2 text-xs text-muted-foreground">
                {VEHICLE_SLOTS[drivingKart] === "comet" ? "W/S drive · A/D steer · Shift afterburner" : "W/S drive · A/D steer · Shift boost"}
              </span>}
              <button
                onClick={(e) => {
                  exitKartRef.current?.();
                  e.currentTarget.blur();
                }}
                className="glass-panel rounded-full px-5 py-2.5 text-sm text-primary"
              >
                ⏏ Hop out{isTouch ? "" : " (F)"}
              </button>
            </div>
          )}
          <LandmarkHud system={landmarksRef} compact={isTouch} />
          <FolkChat
            near={folkNear}
            open={folkOpen}
            look={skyLook}
            onOpen={(d) => openFolk(d)}
            onClose={() => openFolk(null)}
            onSay={(id, text) => folkRef.current?.say(id, text)}
          />
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
          {zepMode !== "off" && (
            <button
              onClick={(e) => {
                zepHelmRef.current?.(zepMode !== "piloting");
                e.currentTarget.blur();
              }}
              className={`glass-panel rounded-full px-5 py-2.5 text-sm ${
                zepMode === "piloting" ? "text-amber-300" : "text-primary animate-pulse"
              }`}
            >
              {zepMode === "piloting" ? "🎈 Let go of the helm · P" : "🎈 Take the helm · P"}
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
          {hud.badPad && (
            <button
              onClick={(e) => {
                badSummonRef.current?.();
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-rose-300 font-semibold"
            >
              🦹 Summon a bad guy{isTouch ? "" : " (E)"} · {mayhemHud.bads}/3 out
            </button>
          )}
          {(hud.nearBad || hud.ridingBad) && (
            <button
              onClick={(e) => {
                badRideRef.current?.();
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-rose-300 font-semibold"
            >
              {hud.ridingBad ? `🤸 Hop off${isTouch ? "" : " (F or Space)"}` : `🦹 Ride with the bad guy${isTouch ? "" : " (F)"}`}
            </button>
          )}
          {hud.nearRideButton && (
            <button
              onClick={(e) => {
                rideButtonRef.current?.();
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-rose-300 font-semibold"
            >
              🔴 Press the red button{isTouch ? "" : " (E)"} · ride shotgun with a bad guy
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
          {mayhemHud.atStall && !shopOpen && (
            <button
              onClick={(e) => {
                setShopWeaponsFirst(true);
                setShopOpen(true);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-rose-100 border border-rose-300/50 shadow-[0_0_24px_rgba(255,90,110,0.45)]"
            >
              🔫 Open Vibe Arms
            </button>
          )}
          {nearShop && !shopOpen && (
            <button
              onClick={(e) => {
                setShopWeaponsFirst(false);
                setShopOpen(true);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-primary shadow-[0_0_24px_hsl(var(--primary)/0.45)]"
            >
              🛍️ Open Vibe Shop
            </button>
          )}
          {nearPortal && !portalOpen && !IOS_APP && (
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
          {nearRaceKiosk && !raceLobby && (
            <button
              onClick={(e) => {
                setRaceLobby(true);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-white border-2 border-cyan-300/70 backdrop-blur-md shadow-[0_0_24px_rgba(56,232,255,0.5)] hover:bg-white/10"
            >
              🏁 Race the Vibe Kart GP{isTouch ? "" : " (E)"}
            </button>
          )}
          {arcadeStation && !cabinetGame && (
            <button
              onClick={(e) => {
                openCabinet(arcadeStation);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-white border-2 backdrop-blur-md transition-colors hover:bg-white/10"
              style={{ borderColor: arcadeStation.accent, boxShadow: `0 0 24px ${arcadeStation.accent}88`, background: "rgba(10,6,24,0.55)" }}
            >
              {arcadeStation.emoji} Play {arcadeStation.title}{isTouch ? "" : " (E)"}
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
          {nearRps && !rpsOpen && !IOS_APP && (
            <button
              onClick={(e) => {
                setRpsOpen(true);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-emerald-100 border border-emerald-300/50 shadow-[0_0_24px_rgba(125,255,212,0.55)] bg-emerald-950/30 backdrop-blur-md hover:bg-emerald-400/15 transition-colors"
            >
              ✊ Bet against the house
            </button>
          )}
          {nearRadio && (
            <button
              onClick={(e) => {
                window.dispatchEvent(new Event("vibefm:open"));
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-amber-100 border border-amber-300/50 shadow-[0_0_24px_rgba(255,179,71,0.55)] bg-amber-950/30 backdrop-blur-md hover:bg-amber-400/15 transition-colors"
            >
              📻 Tune VIBE FM
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

              {/* Look one up by name, or open the whole roster at once — the
                  arrows are unusable for sixty bodies. */}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={avatarSearch}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAvatarSearch(v);
                    const q = v.trim().toLowerCase();
                    if (!q) return;
                    const i = CHARACTERS.findIndex(
                      (c) =>
                        (c.label ?? "").toLowerCase().includes(q) ||
                        c.name.toLowerCase().replace(/_/g, " ").includes(q),
                    );
                    if (i >= 0) setAvatarPreviewIdx(i);
                  }}
                  placeholder="Search by name…"
                  className="glass-panel rounded-full px-4 py-1.5 text-[12px] text-cyan-100 placeholder:text-cyan-300/50 bg-cyan-950/30 border border-cyan-300/30 focus:outline-none focus:border-cyan-300/80 w-48"
                />
                <button
                  onClick={(e) => {
                    setAvatarDashOpen(true);
                    e.currentTarget.blur();
                  }}
                  className="glass-panel rounded-full px-3.5 py-1.5 text-[12px] text-cyan-100 border border-cyan-300/40 bg-cyan-950/30 hover:bg-cyan-500/15 transition-colors whitespace-nowrap"
                >
                  🗂 All {CHARACTERS.length}
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
          {nearBlasterRack && (
            <button
              onClick={(e) => {
                rebelStartRef.current?.();
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-rose-300 animate-pulse"
            >
              🔫 Grab the blaster · REBEL DEFENSE
            </button>
          )}
          {nearSkiGate && (
            <button
              onClick={(e) => {
                skiTravelRef.current?.("peak");
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-primary animate-pulse"
            >
              ⛷ Ski Powder Peak
            </button>
          )}
          {nearSkiReturn && (
            <button
              onClick={(e) => {
                skiTravelRef.current?.("island");
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-primary animate-pulse"
            >
              🏝 Back to Vibe Island
            </button>
          )}
          {nearKart >= 0 && drivingKart < 0 && (
            <button
              onClick={(e) => {
                enterKartRef.current?.(nearKart);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-primary animate-pulse"
            >
              {VEHICLE_SLOTS[nearKart] === "monster"
                ? "🚚 Drive the monster truck"
                : VEHICLE_SLOTS[nearKart] === "comet"
                  ? "☄️ Drive the Vibe Comet"
                  : VEHICLE_SLOTS[nearKart] === "mower"
                    ? "🌱 Ride the lawnmower"
                    : "🏎️ Drive the vibe kart"}
              {isTouch ? "" : " (F)"}
            </button>
          )}
          {nearRide >= 0 && nearKart < 0 && drivingKart < 0 && (
            <button
              onClick={(e) => {
                enterRideRef.current?.(nearRide);
                e.currentTarget.blur();
              }}
              className="glass-panel rounded-full px-5 py-2.5 text-sm text-primary animate-pulse"
            >
              🚗 Take the wheel{isTouch ? "" : " (F)"}
            </button>
          )}
          {nearSnackfe && (
            <div className="flex flex-col items-center gap-1.5 animate-fade-in">
              {snackMsg && (
                <div className="text-[11px] text-emerald-100 bg-emerald-500/15 ring-1 ring-emerald-300/30 rounded-full px-3 py-1 max-w-[18rem] text-center">
                  {snackMsg}
                </div>
              )}
              <div className="glass-panel rounded-2xl px-2.5 py-2 flex items-center gap-1.5 border border-emerald-300/30 shadow-[0_0_24px_rgba(70,232,140,0.35)] bg-[#14181d]/70 backdrop-blur-md">
                <span className="text-[10px] uppercase tracking-[0.18em] text-emerald-300/80 pl-1 pr-0.5 hidden sm:inline">
                  order
                </span>
                {SNACK_MENU.map((item) => {
                  const canAfford = hud.gems >= item.cost;
                  const owned = purchases[item.name] ?? 0;
                  return (
                    <button
                      key={item.name}
                      disabled={!canAfford}
                      title={`${item.name} — ✦${item.cost}`}
                      onClick={(e) => {
                        buySnack(item);
                        e.currentTarget.blur();
                      }}
                      className={`relative flex flex-col items-center rounded-xl px-2 py-1 transition-all ${
                        canAfford
                          ? "hover:bg-emerald-400/15 hover:ring-1 hover:ring-emerald-300/40 active:scale-95"
                          : "opacity-35 cursor-not-allowed"
                      }`}
                    >
                      <span className="text-xl leading-none drop-shadow-[0_2px_4px_rgba(0,0,0,0.6)]">
                        {item.emoji}
                      </span>
                      <span className="text-[9px] font-mono text-amber-300 mt-0.5">✦{item.cost}</span>
                      {owned > 0 && (
                        <span className="absolute -top-1 -right-0.5 text-[8px] font-bold text-emerald-950 bg-emerald-300 rounded-full w-3.5 h-3.5 flex items-center justify-center">
                          {owned}
                        </span>
                      )}
                    </button>
                  );
                })}
                <span className="text-xs font-heading font-semibold text-amber-300 pl-1 pr-1 whitespace-nowrap">
                  ✦ {hud.gems}
                </span>
              </div>
            </div>
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
      {/* Keyboard hints mean nothing on a touchscreen, and a landscape phone is
          wide enough for `sm:` to show them right under the ride buttons. */}
      {entered && !isLive && !isTouch && (
        <div className="absolute bottom-4 right-4 glass-panel rounded-2xl px-4 py-3 text-[11px] text-muted-foreground pointer-events-none hidden sm:block">
          WASD move · Shift run · <span className="text-primary">Space hold = jetpack</span> ·{" "}
          <span className="text-primary">T dance</span> · drag look · pinch / scroll zoom
        </div>
      )}

      {/*
        Diving is a gesture, not a button, which makes it the kind of thing
        nobody ever finds. So say it, once, while they are in the water — where
        it is the only thing they can do and the only place it means anything.
      */}
      {entered && !isLive && inWater && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-40 animate-scale-in">
          <span className="glass-panel rounded-full px-4 py-2 text-xs pointer-events-none">
            <span className="mr-1.5">🤿</span>
            <span className="text-muted-foreground">Look down and swim to </span>
            <span className="font-semibold text-primary">dive</span>
            <span className="text-muted-foreground"> · Space to surface</span>
          </span>
        </div>
      )}

      {/* What you're dancing, while you're dancing it. */}
      {entered && !isLive && activeDance && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 animate-scale-in">
          <span className="glass-panel rounded-full px-4 py-2 text-xs pointer-events-none">
            <span className="mr-1.5">{findDance(activeDance)?.emoji}</span>
            <span className="font-semibold text-primary">{findDance(activeDance)?.label}</span>
            <span className="text-muted-foreground"> · T for another · walk to stop</span>
          </span>
          {/* The crowd, and what it is worth. The track gains a layer at 2, 3
              and 5 dancers, so this is the one number that explains why the
              music just got bigger. */}
          <span className="glass-panel rounded-full px-3 py-2 text-xs pointer-events-none">
            <span className="mr-1">🎵</span>
            <span className="font-semibold text-primary">
              {danceCrowd} dancing
            </span>
            <span className="text-muted-foreground">
              {nextLayerAt(danceCrowd)
                ? ` · ${nextLayerAt(danceCrowd)! - danceCrowd} more for the next layer`
                : " · full mix"}
            </span>
            <span className="ml-1.5 tracking-widest text-primary/70">
              {"▮".repeat(musicLayerCount(danceCrowd))}
              <span className="text-muted-foreground/40">
                {"▮".repeat(4 - musicLayerCount(danceCrowd))}
              </span>
            </span>
          </span>
          <button
            onClick={(e) => {
              setDanceRef.current?.(randomDanceId(activeDance));
              e.currentTarget.blur();
            }}
            className="glass-panel rounded-full px-3 py-2 text-xs hover:bg-muted/50 transition-colors"
            title="Next dance"
          >
            🔀
          </button>
        </div>
      )}

      {/* /live broadcast chrome: LIVE badge + shot label + event ticker. */}
      {isLive && (
        <>
          <div className="absolute left-4 top-4 z-40 flex items-center gap-2">
            <span className="glass-panel flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-widest">
              <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" aria-hidden />
              Live
            </span>
            {liveShot && (
              <span className="glass-panel rounded-full px-3 py-1.5 text-xs text-muted-foreground" data-testid="live-shot">
                cam · {liveShot}
              </span>
            )}
          </div>
          <div className="absolute right-4 top-4 z-40">
            <span className="glass-panel rounded-full px-3 py-1.5 text-xs tracking-widest text-muted-foreground">
              myvibeverse.com
            </span>
          </div>
          <div className="absolute bottom-0 left-0 right-0 z-40 border-t border-border/40 bg-background/70 px-4 py-2 backdrop-blur">
            <div className="flex items-center gap-3 overflow-hidden whitespace-nowrap text-sm" data-testid="live-ticker">
              <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.25em] text-primary">
                world feed
              </span>
              {liveLines.length ? (
                [...liveLines].reverse().map((l, i) => (
                  <span key={`${l}-${i}`} className={i === 0 ? "text-foreground" : "text-muted-foreground/60"}>
                    {l}
                    {i < liveLines.length - 1 ? <span className="mx-2 text-muted-foreground/40">·</span> : null}
                  </span>
                ))
              ) : (
                <span className="text-muted-foreground/60">the island is quiet… residents are wandering</span>
              )}
            </div>
          </div>
        </>
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
