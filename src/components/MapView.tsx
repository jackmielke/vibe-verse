import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Navigation, Zap, Layers, Locate } from "lucide-react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { MAPBOX_TOKEN, VILLAGE_CENTER } from "@/config/mapbox";
import { createMeditationTempleLayer } from "./map/MeditationTempleLayer";
import { createPlazaLayer } from "./map/PlazaLayer";
import { createVenueBeaconLayer } from "./map/VenueBeaconLayer";
import {
  createHelicopterLayer,
  createDefaultHelicopterState,
  type HelicopterState,
} from "./map/HelicopterLayer";
import HelicopterControl, {
  type HelicopterControlState,
  type NimbusControlState,
} from "./HelicopterControl";
import { createVibeyLayer, type VibeyState } from "./map/VibeyLayer";
import {
  createUnit7Layer,
  createDefaultUnit7State,
  UNIT7_DEFAULT_SCALE_METERS,
  UNIT7_MIN_SCALE_METERS,
  UNIT7_MAX_SCALE_METERS,
  type Unit7State,
  type Unit7AnimName,
  type Unit7Expression,
} from "./map/Unit7Layer";
import {
  createVibePoliceLayer,
  createDefaultVibePoliceState,
  VIBE_POLICE_DEFAULT_SCALE_METERS,
  VIBE_POLICE_MIN_SCALE_METERS,
  VIBE_POLICE_MAX_SCALE_METERS,
  type VibePoliceState,
} from "./map/VibePoliceLayer";
import {
  createNimbusVtolLayer,
  createDefaultNimbusState,
  type NimbusState,
} from "./map/NimbusVtolLayer";
import {
  createSpawnableLayer,
  type SpawnableState,
} from "./map/SpawnableLayer";
import VibeyDialog from "./VibeyDialog";
import Unit7Dialog from "./Unit7Dialog";

// Vibey hangs out near the central plaza, slightly offset so he doesn't
// overlap the plaza structure.
const VIBEY_LOCATION = { lng: -122.8695, lat: 38.6135 };

// Unit-7 spawns in the open ground south of the village so the plaza
// pavilion can't visually swallow him on the initial flyTo, and so the
// teal beacon stands out against open street + tree cover.
const UNIT7_LOCATION = { lng: -122.8696, lat: 38.6118 };
// Wander radius (in meters, approximate) from spawn point.
const UNIT7_WANDER_RADIUS_M = 50;

// Vibe Police starts a block east, separate from Unit-7 so the two are
// distinguishable on first sight.
const VIBE_POLICE_LOCATION = { lng: -122.8688, lat: 38.6122 };
const VIBE_POLICE_WANDER_RADIUS_M = 45;

// Walking speed in meters/second.
// Base walking speed at the default body size. The wander loop scales this
// by `state.scaleMeters / UNIT7_DEFAULT_SCALE_METERS` so a 10× kaiju takes
// 10× strides instead of looking like he's foot-shuffling.
const UNIT7_SPEED_MPS = 4;
// Idle pause between moves, seconds.
const UNIT7_IDLE_MIN_S = 2.5;
const UNIT7_IDLE_MAX_S = 6;

// Village locations with real coordinates around Healdsburg.
// `structure3d` marks locations that are rendered as a 3D model on the map
// instead of an emoji bubble — the marker becomes an invisible click target
// over the 3D asset, and the same selection/animation flow is used.
const VILLAGE_LOCATIONS = [
  { id: 1, name: "Main Stage", lat: 38.6132, lng: -122.8700, type: "venue", people: 42, emoji: "🎤" },
  { id: 2, name: "Hacker House", lat: 38.6140, lng: -122.8682, type: "workspace", people: 18, emoji: "💻" },
  { id: 3, name: "The Grove", lat: 38.6120, lng: -122.8715, type: "social", people: 27, emoji: "🌳" },
  { id: 4, name: "Dining Hall", lat: 38.6145, lng: -122.8698, type: "food", people: 55, emoji: "🍽️" },
  { id: 5, name: "Meditation Garden", lat: 38.6115, lng: -122.8688, type: "wellness", people: 8, emoji: "🧘", structure3d: "temple" as const, hitSize: 160, beaconColor: 0xb392ff },
  { id: 6, name: "Co-working Barn", lat: 38.6128, lng: -122.8720, type: "workspace", people: 31, emoji: "🏠" },
  { id: 7, name: "Pool Deck", lat: 38.6148, lng: -122.8690, type: "social", people: 15, emoji: "🏊" },
  { id: 8, name: "Art Studio", lat: 38.6118, lng: -122.8672, type: "venue", people: 12, emoji: "🎨" },
  // Real Healdsburg Plaza (OpenStreetMap-verified centroid).
  { id: 9, name: "Central Plaza", lat: 38.61080, lng: -122.87007, type: "social", people: 64, emoji: "⛲", structure3d: "plaza" as const, hitSize: 200, beaconColor: 0x73ffb8 },
  // ---- Edge Esmeralda real-world venues (all OSM-geocoded) -------
  // Each gets a unique structure3d id so its beacon layer is unique.
  // None of these have a spawnable 3D model — they're beacon-only.
  { id: 10, name: "CraftWork", lat: 38.61230, lng: -122.87098, type: "workspace", people: 22, emoji: "☕", structure3d: "craftwork" as const, hitSize: 140, beaconColor: 0xffb24a },
  { id: 11, name: "Hotel Trio", lat: 38.62568, lng: -122.87503, type: "venue", people: 36, emoji: "🛎️", structure3d: "hotel-trio" as const, hitSize: 180, beaconColor: 0x6aa8ff },
  { id: 12, name: "SingleThread", lat: 38.61234, lng: -122.86969, type: "food", people: 18, emoji: "🍽️", structure3d: "single-thread" as const, hitSize: 140, beaconColor: 0xff7e8a },
  { id: 13, name: "Bergamot Alley", lat: 38.61152, lng: -122.87048, type: "social", people: 24, emoji: "🍷", structure3d: "bergamot" as const, hitSize: 130, beaconColor: 0xb392ff },
  { id: 14, name: "Costeaux", lat: 38.61254, lng: -122.87159, type: "food", people: 14, emoji: "🥐", structure3d: "costeaux" as const, hitSize: 130, beaconColor: 0xffd166 },
  { id: 15, name: "Valette", lat: 38.61206, lng: -122.86957, type: "food", people: 19, emoji: "🥂", structure3d: "valette" as const, hitSize: 130, beaconColor: 0xff9f7a },
  { id: 16, name: "Raven Theater", lat: 38.61228, lng: -122.87041, type: "venue", people: 28, emoji: "🎭", structure3d: "raven" as const, hitSize: 140, beaconColor: 0xeaeaf0 },
  { id: 17, name: "Hotel Les Mars", lat: 38.61217, lng: -122.87157, type: "venue", people: 22, emoji: "🛏️", structure3d: "les-mars" as const, hitSize: 140, beaconColor: 0xc9a86a },
  { id: 18, name: "Barndiva", lat: 38.60963, lng: -122.86947, type: "food", people: 18, emoji: "🌿", structure3d: "barndiva" as const, hitSize: 130, beaconColor: 0x8ad48a },
];

const TYPE_COLORS: Record<string, string> = {
  venue: "#2dd4a8",
  workspace: "#38bdf8",
  social: "#fbbf24",
  food: "#f97316",
  wellness: "#a78bfa",
};

// Maps a `structure3d` key to a Mapbox custom layer factory + its layer id.
const STRUCTURE_FACTORIES: Record<
  string,
  { layerId: string; create: typeof createMeditationTempleLayer }
> = {
  temple: { layerId: "structure-temple", create: createMeditationTempleLayer },
  plaza: { layerId: "structure-plaza", create: createPlazaLayer },
};

// Adds the small "venue beacon" layer (a thin pillar of light + halo)
// at every location that has a structure3d. The beacon is the always-on
// minimalist marker — the actual pavilion / fountain / temple meshes
// are gated behind the spawn toggles.
function addVenueBeaconLayers(m: mapboxgl.Map) {
  VILLAGE_LOCATIONS.forEach((loc) => {
    if (!loc.structure3d) return;
    const id = `beacon-${loc.structure3d}`;
    if (m.getLayer(id)) return;
    let altitude = 0;
    try {
      const elev = m.queryTerrainElevation([loc.lng, loc.lat], { exaggerated: true });
      if (typeof elev === "number") altitude = elev + 0.2;
    } catch { /* terrain not ready */ }
    try {
      const color = (loc as { beaconColor?: number }).beaconColor ?? 0x73ffb8;
      m.addLayer(createVenueBeaconLayer(id, { lng: loc.lng, lat: loc.lat }, altitude, color));
    } catch { /* style not ready */ }
  });
}

// Adds the heavy 3D structure for a single venue (called when the user
// spawns it from the Spawn panel). Returns true if it succeeded.
function addStructureLayer(m: mapboxgl.Map, structure: "plaza" | "temple") {
  const loc = VILLAGE_LOCATIONS.find((l) => l.structure3d === structure);
  if (!loc) return false;
  const factory = STRUCTURE_FACTORIES[structure];
  if (!factory || m.getLayer(factory.layerId)) return false;
  let altitude = 0;
  try {
    const elev = m.queryTerrainElevation([loc.lng, loc.lat], { exaggerated: true });
    if (typeof elev === "number") altitude = elev + 0.5;
  } catch { /* terrain not ready */ }
  try {
    m.addLayer(factory.create(factory.layerId, { lng: loc.lng, lat: loc.lat }, altitude));
    return true;
  } catch {
    return false;
  }
}

// Removes a previously-spawned 3D structure layer if present.
function removeStructureLayer(m: mapboxgl.Map, structure: "plaza" | "temple") {
  const factory = STRUCTURE_FACTORIES[structure];
  if (!factory) return;
  if (m.getLayer(factory.layerId)) m.removeLayer(factory.layerId);
}

// Adds a 3D building extrusion layer for non-Standard styles (e.g. satellite).
// The Mapbox Standard style ships its own beautiful 3D buildings and hides the
// `composite` source, so this is a no-op there. On satellite-streets the
// `composite` source is exposed and we can extrude the `building` layer.
// Safe to call multiple times.
function addBuildingsLayer(m: mapboxgl.Map) {
  if (m.getLayer("3d-buildings")) return;
  // Skip if `composite` source isn't available (Standard style hides it).
  if (!m.getSource("composite")) return;

  const layers = m.getStyle()?.layers;
  // Insert beneath the first label layer so labels stay readable on top.
  const labelLayer = layers?.find(
    (layer) => layer.type === "symbol" && (layer.layout as any)?.["text-field"],
  );

  try {
    m.addLayer(
      {
        id: "3d-buildings",
        source: "composite",
        "source-layer": "building",
        filter: ["==", "extrude", "true"],
        type: "fill-extrusion",
        minzoom: 14,
        paint: {
          // Slight teal tint so buildings feel "Edge"-themed on satellite imagery.
          "fill-extrusion-color": [
            "interpolate",
            ["linear"],
            ["get", "height"],
            0, "#7fe7c4",
            50, "#2dd4a8",
            150, "#1a8f73",
          ],
          "fill-extrusion-height": ["*", ["get", "height"], 1.5],
          "fill-extrusion-base": ["get", "min_height"],
          "fill-extrusion-opacity": 0.85,
          "fill-extrusion-vertical-gradient": true,
        },
      },
      labelLayer?.id,
    );
  } catch {
    /* ignore — source/layer not yet ready */
  }
}

// Re-create structure layers (e.g. once terrain has loaded) so altitude
// reflects current ground elevation.
// Pacific Time → Mapbox Standard light preset. Roughly:
//   05:00–08:00 → dawn
//   08:00–16:00 → day
//   16:00–19:00 → dusk
//   else        → night
function lightPresetForPTHour(hour: number): "dawn" | "day" | "dusk" | "night" {
  if (hour >= 5 && hour < 8) return "dawn";
  if (hour >= 8 && hour < 16) return "day";
  if (hour >= 16 && hour < 19) return "dusk";
  return "night";
}

function getPacificClock(): { hour: number; label: string } {
  const now = new Date();
  // Use Intl with a known timezone so we don't trust the user's local clock.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(now);
  const label = parts.map((p) => p.value).join("");
  const hour24Str = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    hour12: false,
  }).format(now);
  const hour = Number(hour24Str) % 24;
  return { hour, label };
}

function refreshVenueBeacons(m: mapboxgl.Map) {
  VILLAGE_LOCATIONS.forEach((loc) => {
    if (!loc.structure3d) return;
    const id = `beacon-${loc.structure3d}`;
    if (m.getLayer(id)) {
      try { m.removeLayer(id); } catch { /* noop */ }
    }
  });
  addVenueBeaconLayers(m);
}

interface MapViewProps {
  onLocationSelect: (location: typeof VILLAGE_LOCATIONS[0] | null) => void;
  selectedLocation: typeof VILLAGE_LOCATIONS[0] | null;
}

export default function MapView({ onLocationSelect, selectedLocation }: MapViewProps) {
  const navigate = useNavigate();
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  const userMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapStyle, setMapStyle] = useState<"satellite" | "dark">("dark");
  const activeStyleRef = useRef<"satellite" | "dark">("dark");
  const mapReadyTimeoutRef = useRef<number | null>(null);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [mapError, setMapError] = useState(false);

  // ---- Helicopter ------------------------------------------------------
  // Mutable state that the custom layer reads on every render frame.
  const heliStateRef = useRef<HelicopterState>(
    createDefaultHelicopterState(VILLAGE_CENTER.lng, VILLAGE_CENTER.lat),
  );
  // React-visible mirror so the control panel HUD updates.
  const [heliUI, setHeliUI] = useState<HelicopterControlState>({
    enabled: false,
    pilotMode: false,
    altitude: 60,
    speedKts: 0,
    heading: 0,
  });
  const heliLayerAddedRef = useRef(false);
  const keysRef = useRef<Record<string, boolean>>({});
  const heliVelocityRef = useRef({ forward: 0, lateral: 0, vertical: 0 });

  // ---- Vibey (community agent character) -------------------------------
  const vibeyStateRef = useRef<VibeyState>({
    lng: VIBEY_LOCATION.lng,
    lat: VIBEY_LOCATION.lat,
    baseAltitude: 0,
    heading: 0,
    walkMode: false,
  });
  const vibeyLayerAddedRef = useRef(false);
  const vibeyMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const [vibeyOpen, setVibeyOpen] = useState(false);
  const [vibeyUI, setVibeyUI] = useState({ walkMode: false, heading: 0 });
  const vibeyKeysRef = useRef<Record<string, boolean>>({});
  // Lazy-load: characters are off by default. Toggling on triggers GLB
  // download + layer mount; toggling off tears them down so initial app
  // load stays light (no ~12-54 MB of bundled meshes on first paint).
  const [vibeyVisible, setVibeyVisible] = useState(false);

  // ---- Unit-7 (autonomous resident bot) --------------------------------
  const unit7StateRef = useRef<Unit7State>(
    createDefaultUnit7State(UNIT7_LOCATION.lng, UNIT7_LOCATION.lat),
  );
  // Wander target. When null we're idling.
  const unit7TargetRef = useRef<{ lng: number; lat: number } | null>(null);
  const unit7IdleUntilRef = useRef<number>(0);
  // After a one-shot emote finishes, return to this animation.
  const unit7BaseAnimRef = useRef<Unit7AnimName>("Idle");
  const unit7LayerAddedRef = useRef(false);
  const unit7MarkerRef = useRef<mapboxgl.Marker | null>(null);
  const [unit7Open, setUnit7Open] = useState(false);
  // UI-driven size slider for Unit-7 on the map. The layer reads from
  // `unit7StateRef.current.scaleMeters` each frame.
  const [unit7Scale, setUnit7Scale] = useState(UNIT7_DEFAULT_SCALE_METERS);
  // Walk-as-Unit-7 (mirrors Vibey's walk mode): pause wander, control with
  // WASD, third-person chase camera.
  const [unit7WalkMode, setUnit7WalkMode] = useState(false);
  const unit7KeysRef = useRef<Record<string, boolean>>({});
  const [unit7Visible, setUnit7Visible] = useState(false);

  // Pacific Time clock label + sun/lighting that follow real local time.
  const [clockLabel, setClockLabel] = useState(() => getPacificClock().label);

  // ---- Vibe Police (anti-vibe officer) ---------------------------------
  const vibePoliceStateRef = useRef<VibePoliceState>(
    createDefaultVibePoliceState(VIBE_POLICE_LOCATION.lng, VIBE_POLICE_LOCATION.lat),
  );
  const vibePoliceTargetRef = useRef<{ lng: number; lat: number } | null>(null);
  const vibePoliceIdleUntilRef = useRef<number>(0);
  const vibePoliceLayerAddedRef = useRef(false);
  const vibePoliceMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const [vibePoliceScale, setVibePoliceScale] = useState(VIBE_POLICE_DEFAULT_SCALE_METERS);
  const [vibePoliceVisible, setVibePoliceVisible] = useState(false);

  // ---- Spawnables (lazy-loaded heavy GLBs) -----------------------------
  const islandStateRef = useRef<SpawnableState>({
    lng: VILLAGE_CENTER.lng,
    lat: VILLAGE_CENTER.lat,
    altitude: 700, // hover way up so the camera can pull back & include both
    heading: 0,
    scaleMeters: 260,
    bobAmplitude: 8,
    rotationSpeed: 0.04,
  });
  const islandLayerRef = useRef<ReturnType<typeof createSpawnableLayer> | null>(null);
  const [islandEnabled, setIslandEnabled] = useState(false);
  const [islandLoading, setIslandLoading] = useState(false);
  const [islandProgress, setIslandProgress] = useState<number | null>(null);

  const deathStarStateRef = useRef<SpawnableState>({
    lng: VILLAGE_CENTER.lng + 0.012, // ~1km east of the village
    lat: VILLAGE_CENTER.lat + 0.006,
    altitude: 1100, // even higher than the island
    heading: 0,
    scaleMeters: 180,
    bobAmplitude: 2,
    bobPeriod: 22,
    rotationSpeed: 0.18, // spins faster — it's a moon-sized space station
  });
  const deathStarLayerRef = useRef<ReturnType<typeof createSpawnableLayer> | null>(null);
  const [deathStarEnabled, setDeathStarEnabled] = useState(false);
  const [deathStarLoading, setDeathStarLoading] = useState(false);
  const [deathStarProgress, setDeathStarProgress] = useState<number | null>(null);

  // Littlest Tokyo: keyframe-animated micro-city. Sits on the ground a few
  // blocks east of the plaza so it feels like its own neighborhood — far
  // enough that it doesn't overlap the plaza pavilion's footprint.
  const tokyoStateRef = useRef<SpawnableState>({
    lng: -122.8662, // ~280m east of the plaza, in open ground
    lat: 38.6125,
    altitude: 32, // ground-level fallback; resampled from terrain on mount
    heading: 0,
    scaleMeters: 35,
    bobAmplitude: 0, // no bob — this one sits on the ground
    rotationSpeed: 0, // no auto-spin — its internal animations are the show
    bottomAnchor: true, // city's footprint sits ON the ground, not half-buried
  });
  const tokyoLayerRef = useRef<ReturnType<typeof createSpawnableLayer> | null>(null);
  const [tokyoEnabled, setTokyoEnabled] = useState(false);
  const [tokyoLoading, setTokyoLoading] = useState(false);
  const [tokyoProgress, setTokyoProgress] = useState<number | null>(null);

  // 3D venue structures (plaza pavilion + meditation temple) are
  // gated behind their own spawn toggles. The always-on beacons mark
  // their location until the heavy meshes are spawned.
  const [plazaEnabled, setPlazaEnabled] = useState(false);
  const [templeEnabled, setTempleEnabled] = useState(false);

  // ---- Nimbus VTOL ------------------------------------------------------
  const nimbusStateRef = useRef<NimbusState>(
    createDefaultNimbusState(VILLAGE_CENTER.lng, VILLAGE_CENTER.lat),
  );
  const [nimbusUI, setNimbusUI] = useState<NimbusControlState>({
    enabled: false,
    pilotMode: false,
    altitude: 90,
    speedKts: 0,
    heading: 0,
  });
  const nimbusLayerAddedRef = useRef(false);
  const nimbusKeysRef = useRef<Record<string, boolean>>({});
  const nimbusVelocityRef = useRef({ forward: 0, lateral: 0, vertical: 0 });

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;

    try {
      const m = new mapboxgl.Map({
        container: mapContainer.current,
        style: "mapbox://styles/mapbox/standard",
        center: [VILLAGE_CENTER.lng, VILLAGE_CENTER.lat],
        zoom: VILLAGE_CENTER.zoom,
        pitch: 45,
        bearing: -17,
        antialias: true,
      });

      const markMapReady = () => {
        if (mapReadyTimeoutRef.current) {
          window.clearTimeout(mapReadyTimeoutRef.current);
          mapReadyTimeoutRef.current = null;
        }
        setMapLoaded(true);
      };

      mapReadyTimeoutRef.current = window.setTimeout(markMapReady, 4500);

      // Dev helper: shift+click anywhere on the map → logs the
      // precise lng/lat to the console + copies it to the clipboard.
      // Use this to pin landmarks exactly (open the map, shift+click
      // the spot, paste the coord into VILLAGE_LOCATIONS).
      m.on("click", (e) => {
        if (!e.originalEvent.shiftKey) return;
        const { lng, lat } = e.lngLat;
        const out = `lat: ${lat.toFixed(5)}, lng: ${lng.toFixed(5)}`;
        // eslint-disable-next-line no-console
        console.log("[map shift+click]", out);
        if (navigator.clipboard) {
          navigator.clipboard.writeText(out).catch(() => { /* noop */ });
        }
      });

      m.on("style.load", () => {
        // Enable 3D terrain
        if (!m.getSource("mapbox-dem")) {
          m.addSource("mapbox-dem", {
            type: "raster-dem",
            url: "mapbox://mapbox.mapbox-terrain-dem-v1",
            tileSize: 512,
            maxzoom: 14,
          });
        }
        m.setTerrain({ source: "mapbox-dem", exaggeration: 1.5 });

        // Set Standard style config for colorful, immersive 3D look. The
        // lightPreset reflects local Pacific Time so the "sun" rises and
        // sets in sync with whoever's running the village.
        try {
          m.setConfigProperty(
            "basemap",
            "lightPreset",
            lightPresetForPTHour(getPacificClock().hour),
          );
          m.setConfigProperty("basemap", "showPointOfInterestLabels", true);
          m.setConfigProperty("basemap", "showTransitLabels", false);
          m.setConfigProperty("basemap", "showPlaceLabels", true);
          m.setConfigProperty("basemap", "show3dObjects", true);
        } catch (e) {
          // Config properties may not be available on all versions
        }

        // Re-add the always-on venue beacons (custom layers are wiped
        // on style change). Heavy structures are gated behind the
        // Spawn panel and re-added by the spawn-state effect below.
        addVenueBeaconLayers(m);
        // Add city 3D buildings on styles that expose `composite` (satellite).
        // Standard ships its own 3D buildings so this is a no-op there.
        addBuildingsLayer(m);
        markMapReady();
        m.once("idle", () => refreshVenueBeacons(m));
      });

      // When new terrain tiles load near our structures, re-seat them on the
      // ground so they don't appear to sink as the user pans/zooms.
      m.on("sourcedata", (e) => {
        if (e.sourceId === "mapbox-dem" && e.isSourceLoaded) {
          refreshVenueBeacons(m);
          // Re-sample ground altitude for live characters too. Without this,
          // they stay at sea-level (altitude 0) until a frame happens to
          // resample, which leaves them underground in places like Healdsburg
          // (terrain ~32m).
          try {
            const ve = m.queryTerrainElevation(
              [vibeyStateRef.current.lng, vibeyStateRef.current.lat],
              { exaggerated: true },
            );
            if (typeof ve === "number") vibeyStateRef.current.baseAltitude = ve;
            const ue = m.queryTerrainElevation(
              [unit7StateRef.current.lng, unit7StateRef.current.lat],
              { exaggerated: true },
            );
            if (typeof ue === "number") unit7StateRef.current.baseAltitude = ue;
            const te = m.queryTerrainElevation(
              [tokyoStateRef.current.lng, tokyoStateRef.current.lat],
              { exaggerated: true },
            );
            if (typeof te === "number") tokyoStateRef.current.altitude = te;
            const pe = m.queryTerrainElevation(
              [vibePoliceStateRef.current.lng, vibePoliceStateRef.current.lat],
              { exaggerated: true },
            );
            if (typeof pe === "number") vibePoliceStateRef.current.baseAltitude = pe;
          } catch { /* terrain not ready */ }
        }
      });

      m.addControl(new mapboxgl.NavigationControl({ showCompass: true, visualizePitch: true }), "bottom-right");

      m.on("load", () => {
        markMapReady();

        // Fly to the 3D pavilion so it's immediately visible
        const templeLoc = VILLAGE_LOCATIONS.find((l) => l.id === 5)!;
        setTimeout(() => {
          m.flyTo({
            center: [templeLoc.lng, templeLoc.lat],
            zoom: 18,
            pitch: 60,
            bearing: -20,
            duration: 2200,
          });
        }, 600);

        // (3D city buildings are added in `style.load` via `addBuildingsLayer`.)

        // Add village boundary glow
        m.addSource("village-area", {
          type: "geojson",
          data: {
            type: "Feature",
            properties: {},
            geometry: {
              type: "Polygon",
              coordinates: [[
                [-122.8730, 38.6110],
                [-122.8660, 38.6110],
                [-122.8660, 38.6155],
                [-122.8730, 38.6155],
                [-122.8730, 38.6110],
              ]],
            },
          },
        });

        m.addLayer({
          id: "village-boundary",
          type: "fill",
          source: "village-area",
          paint: {
            "fill-color": "#2dd4a8",
            "fill-opacity": 0.05,
          },
        });

        m.addLayer({
          id: "village-boundary-line",
          type: "line",
          source: "village-area",
          paint: {
            "line-color": "#2dd4a8",
            "line-width": 2,
            "line-opacity": 0.3,
            "line-dasharray": [3, 3],
          },
        });

        // Always-on venue beacons (also re-added on style.load).
        addVenueBeaconLayers(m);
      });

      m.on("error", (event) => {
        const message = String((event.error as Error | undefined)?.message ?? "");
        if (/token|401|403|unauthorized|forbidden/i.test(message)) {
          setMapError(true);
        } else if (event.error) {
          console.warn("[Mapbox] non-fatal map error", event.error);
        }
      });

      map.current = m;
      if (import.meta.env.DEV) {
        (window as any).__map = m;
      }
    } catch {
      setMapError(true);
    }

    return () => {
      if (mapReadyTimeoutRef.current) {
        window.clearTimeout(mapReadyTimeoutRef.current);
        mapReadyTimeoutRef.current = null;
      }
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Update map style
  useEffect(() => {
    if (!map.current || !mapLoaded) return;
    if (activeStyleRef.current === mapStyle) return;
    activeStyleRef.current = mapStyle;
    setMapLoaded(false);
    map.current.setStyle(
      mapStyle === "dark"
        ? "mapbox://styles/mapbox/standard"
        : "mapbox://styles/mapbox/satellite-streets-v12"
    );
  }, [mapStyle, mapLoaded]);

  // Create custom markers
  useEffect(() => {
    if (!map.current || !mapLoaded) return;

    // Clear existing markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    VILLAGE_LOCATIONS.forEach((loc) => {
      const color = TYPE_COLORS[loc.type] || "#2dd4a8";
      const isSelected = selectedLocation?.id === loc.id;
      // Only 3D structures get an invisible click target. All other
      // locations are intentionally hidden — no pins, no labels.
      if (!loc.structure3d) return;
      const hitSize = loc.hitSize ?? 44;

      const el = document.createElement("div");
      el.className = "village-marker";

      const hitWidth = hitSize;
      const hitHeight = Math.round(hitSize * 1.6);
      el.style.cssText = `
        width: ${hitWidth}px; height: ${hitHeight}px;
        position: relative;
        cursor: pointer;
        pointer-events: auto;
      `;
      // Plain invisible click target — the visible indicator is the
      // vertical beacon beam, not a circular halo on the marker.
      const inner = document.createElement("div");
      inner.style.cssText = `
        width: 100%; height: 100%;
        background: transparent;
      `;
      el.appendChild(inner);

      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onLocationSelect(selectedLocation?.id === loc.id ? null : loc);
        map.current?.flyTo({ center: [loc.lng, loc.lat], zoom: 17, duration: 800 });
      });

      const marker = new mapboxgl.Marker({
        element: el,
        anchor: "bottom",
      })
        .setLngLat([loc.lng, loc.lat])
        .addTo(map.current!);

      markersRef.current.push(marker);
    });
  }, [mapLoaded, selectedLocation, onLocationSelect]);

  // GPS tracking
  const trackLocation = useCallback(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserLocation(coords);

        if (map.current) {
          // Add/update user marker
          if (userMarkerRef.current) {
            userMarkerRef.current.setLngLat([coords.lng, coords.lat]);
          } else {
            const el = document.createElement("div");
            el.style.cssText = `
              width: 18px; height: 18px;
              background: hsl(160, 80%, 50%);
              border: 3px solid hsl(160, 100%, 95%);
              border-radius: 50%;
              box-shadow: 0 0 20px hsl(160, 80%, 50%, 0.5), 0 0 60px hsl(160, 80%, 50%, 0.2);
            `;

            const pulse = document.createElement("div");
            pulse.style.cssText = `
              position: absolute; inset: -8px;
              border-radius: 50%;
              background: hsl(160, 80%, 50%, 0.2);
              animation: marker-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
            `;
            el.appendChild(pulse);

            userMarkerRef.current = new mapboxgl.Marker({ element: el })
              .setLngLat([coords.lng, coords.lat])
              .addTo(map.current);
          }

          map.current.flyTo({ center: [coords.lng, coords.lat], zoom: 17, duration: 1200 });
        }
      },
      () => {},
      { enableHighAccuracy: true }
    );
  }, []);

  // ---- Time of day + dynamic sun --------------------------------------
  // Update the on-screen clock once a second so it stays smooth, and the
  // Mapbox Standard lightPreset once a minute so the basemap relighting
  // doesn't churn.
  useEffect(() => {
    const tickClock = () => setClockLabel(getPacificClock().label);
    const interval = setInterval(tickClock, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || !mapLoaded) return;
    let lastPreset: string | null = null;
    const applyPreset = () => {
      const preset = lightPresetForPTHour(getPacificClock().hour);
      if (preset === lastPreset) return;
      lastPreset = preset;
      try {
        m.setConfigProperty("basemap", "lightPreset", preset);
      } catch { /* may not exist on older mapbox-gl */ }
    };
    applyPreset();
    const interval = setInterval(applyPreset, 60_000);
    return () => clearInterval(interval);
  }, [mapLoaded]);

  // ---- Vibey: mount layer + click marker (only when toggled on) -------
  useEffect(() => {
    const m = map.current;
    if (!m || !mapLoaded || !vibeyVisible) return;
    const LAYER_ID = "vibey-character";

    const mount = () => {
      if (vibeyLayerAddedRef.current) return;
      try {
        const elev = m.queryTerrainElevation(
          [vibeyStateRef.current.lng, vibeyStateRef.current.lat],
          { exaggerated: true },
        );
        if (typeof elev === "number") vibeyStateRef.current.baseAltitude = elev;
      } catch { /* terrain not ready */ }

      try {
        m.addLayer(createVibeyLayer(LAYER_ID, vibeyStateRef.current));
        vibeyLayerAddedRef.current = true;
        m.triggerRepaint();
      } catch { /* ignore */ }

      // Invisible click target floating where Vibey hovers
      if (!vibeyMarkerRef.current) {
        const el = document.createElement("div");
        el.style.cssText = `
          width: 90px; height: 110px;
          cursor: pointer;
          pointer-events: auto;
          display: flex; align-items: flex-end; justify-content: center;
        `;
        const tag = document.createElement("div");
        tag.style.cssText = `
          font-family: 'Sora', sans-serif;
          font-size: 10px; font-weight: 700;
          letter-spacing: 0.12em; text-transform: uppercase;
          color: #f0fdf9;
          padding: 4px 10px;
          border-radius: 999px;
          background: rgba(13, 27, 42, 0.78);
          border: 1px solid rgba(45, 212, 168, 0.6);
          box-shadow: 0 0 14px rgba(45, 212, 168, 0.45);
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
          white-space: nowrap;
          transform: translateY(-110px);
          transition: transform 0.2s ease, box-shadow 0.2s ease;
        `;
        tag.textContent = "✦ Vibey";
        el.appendChild(tag);
        el.addEventListener("mouseenter", () => {
          tag.style.transform = "translateY(-110px) scale(1.06)";
          tag.style.boxShadow = "0 0 22px rgba(45, 212, 168, 0.7)";
        });
        el.addEventListener("mouseleave", () => {
          tag.style.transform = "translateY(-110px)";
          tag.style.boxShadow = "0 0 14px rgba(45, 212, 168, 0.45)";
        });
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          if (vibeyStateRef.current.walkMode) return;
          setVibeyOpen(true);
        });
        vibeyMarkerRef.current = new mapboxgl.Marker({
          element: el,
          anchor: "bottom",
        })
          .setLngLat([vibeyStateRef.current.lng, vibeyStateRef.current.lat])
          .addTo(m);
      }
    };

    mount();
    // Custom layers are wiped on style.load — remount.
    const onStyle = () => {
      vibeyLayerAddedRef.current = false;
      m.once("idle", mount);
    };
    m.on("style.load", onStyle);

    return () => {
      m.off("style.load", onStyle);
      // Tear down on toggle-off so memory + GPU resources are freed.
      try { m.removeLayer(LAYER_ID); } catch { /* */ }
      vibeyLayerAddedRef.current = false;
      vibeyMarkerRef.current?.remove();
      vibeyMarkerRef.current = null;
    };
  }, [mapLoaded, vibeyVisible]);

  // ---- Unit-7: mount layer + click marker (only when toggled on) ------
  useEffect(() => {
    const m = map.current;
    if (!m || !mapLoaded || !unit7Visible) return;
    const LAYER_ID = "unit7-character";

    const handleOneShotFinished = () => {
      // Resume whatever the wander loop wants (Idle or Walking).
      unit7StateRef.current.currentAnim = unit7BaseAnimRef.current;
      unit7StateRef.current.animPulse++;
    };

    const mount = () => {
      if (unit7LayerAddedRef.current) return;
      try {
        const elev = m.queryTerrainElevation(
          [unit7StateRef.current.lng, unit7StateRef.current.lat],
          { exaggerated: true },
        );
        if (typeof elev === "number") unit7StateRef.current.baseAltitude = elev;
      } catch { /* terrain not ready */ }

      try {
        m.addLayer(createUnit7Layer(LAYER_ID, unit7StateRef.current, handleOneShotFinished));
        unit7LayerAddedRef.current = true;
        m.triggerRepaint();
      } catch { /* ignore */ }

      if (!unit7MarkerRef.current) {
        const el = document.createElement("div");
        el.style.cssText = `
          width: 70px; height: 90px;
          cursor: pointer;
          pointer-events: auto;
          display: flex; align-items: flex-end; justify-content: center;
        `;
        const tag = document.createElement("div");
        tag.style.cssText = `
          font-family: 'Sora', sans-serif;
          font-size: 10px; font-weight: 700;
          letter-spacing: 0.12em; text-transform: uppercase;
          color: #f0fdf9;
          padding: 4px 10px;
          border-radius: 999px;
          background: rgba(13, 27, 42, 0.78);
          border: 1px solid rgba(115, 255, 184, 0.6);
          box-shadow: 0 0 14px rgba(115, 255, 184, 0.4);
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
          white-space: nowrap;
          transform: translateY(-90px);
          transition: transform 0.2s ease, box-shadow 0.2s ease;
        `;
        tag.textContent = "◆ Unit-7";
        el.appendChild(tag);
        el.addEventListener("mouseenter", () => {
          tag.style.transform = "translateY(-90px) scale(1.06)";
          tag.style.boxShadow = "0 0 22px rgba(115, 255, 184, 0.7)";
        });
        el.addEventListener("mouseleave", () => {
          tag.style.transform = "translateY(-90px)";
          tag.style.boxShadow = "0 0 14px rgba(115, 255, 184, 0.4)";
        });
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          // Third-person framing + wave hello + face the camera.
          const s = unit7StateRef.current;
          const camBearing = m.getBearing();
          m.flyTo({
            center: [s.lng, s.lat],
            zoom: 19.5,
            pitch: 55,
            bearing: camBearing,
            duration: 1100,
          });
          unit7BaseAnimRef.current = "Idle";
          unit7TargetRef.current = null;
          s.heading = (camBearing * Math.PI) / 180 + Math.PI;
          s.currentAnim = "Wave";
          s.animPulse++;
          setUnit7Open(true);
        });
        unit7MarkerRef.current = new mapboxgl.Marker({
          element: el,
          anchor: "bottom",
        })
          .setLngLat([unit7StateRef.current.lng, unit7StateRef.current.lat])
          .addTo(m);
      }
    };

    mount();
    const onStyle = () => {
      unit7LayerAddedRef.current = false;
      m.once("idle", mount);
    };
    m.on("style.load", onStyle);

    return () => {
      m.off("style.load", onStyle);
      try { m.removeLayer(LAYER_ID); } catch { /* */ }
      unit7LayerAddedRef.current = false;
      unit7MarkerRef.current?.remove();
      unit7MarkerRef.current = null;
    };
  }, [mapLoaded, unit7Visible]);

  // ---- Unit-7: autonomous wander loop ----------------------------------
  useEffect(() => {
    if (!mapLoaded || !unit7Visible) return;
    const m = map.current;
    if (!m) return;

    let raf = 0;
    let lastTime = performance.now();
    // Meters → degrees conversion at this latitude. Lat is constant; lng
    // depends on cos(lat). 1° lat ≈ 111_111 m.
    const metersPerDegLat = 111_111;
    const metersPerDegLng = 111_111 * Math.cos((UNIT7_LOCATION.lat * Math.PI) / 180);

    function pickNewTarget() {
      // Random point inside the wander radius (uniform on disc).
      const r = Math.sqrt(Math.random()) * UNIT7_WANDER_RADIUS_M;
      const theta = Math.random() * Math.PI * 2;
      const dxMeters = r * Math.cos(theta);
      const dyMeters = r * Math.sin(theta);
      unit7TargetRef.current = {
        lng: UNIT7_LOCATION.lng + dxMeters / metersPerDegLng,
        lat: UNIT7_LOCATION.lat + dyMeters / metersPerDegLat,
      };
    }

    const tick = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;
      const s = unit7StateRef.current;

      // Don't run wander while user has the dialog open — let him stand still
      // and emote.
      if (unit7Open) {
        raf = requestAnimationFrame(tick);
        return;
      }

      // Don't override one-shot emotes mid-play.
      const isOneShot = ["Wave", "Yes", "No", "ThumbsUp", "Punch", "Jump"].includes(
        s.currentAnim,
      );
      if (isOneShot) {
        raf = requestAnimationFrame(tick);
        return;
      }

      // Pause autonomous wander while the user is piloting him.
      if (unit7WalkMode) {
        raf = requestAnimationFrame(tick);
        return;
      }

      const target = unit7TargetRef.current;
      if (!target) {
        // Idling. Pick a new target once the idle timer expires.
        if (now >= unit7IdleUntilRef.current) {
          pickNewTarget();
          if (s.currentAnim !== "Walking") {
            unit7BaseAnimRef.current = "Walking";
            s.currentAnim = "Walking";
            s.animPulse++;
          }
        } else if (s.currentAnim !== "Idle") {
          unit7BaseAnimRef.current = "Idle";
          s.currentAnim = "Idle";
          s.animPulse++;
        }
      } else {
        // Move toward target.
        const dxMeters = (target.lng - s.lng) * metersPerDegLng;
        const dyMeters = (target.lat - s.lat) * metersPerDegLat;
        const distance = Math.hypot(dxMeters, dyMeters);
        if (distance < 0.6) {
          unit7TargetRef.current = null;
          unit7IdleUntilRef.current =
            now + (UNIT7_IDLE_MIN_S + Math.random() * (UNIT7_IDLE_MAX_S - UNIT7_IDLE_MIN_S)) * 1000;
          unit7BaseAnimRef.current = "Idle";
          s.currentAnim = "Idle";
          s.animPulse++;
        } else {
          const sizeFactor = (s.scaleMeters || UNIT7_DEFAULT_SCALE_METERS) /
            UNIT7_DEFAULT_SCALE_METERS;
          const step = Math.min(distance, UNIT7_SPEED_MPS * sizeFactor * dt);
          const nx = dxMeters / distance;
          const ny = dyMeters / distance;
          s.lng += (nx * step) / metersPerDegLng;
          s.lat += (ny * step) / metersPerDegLat;
          s.heading = Math.atan2(nx, ny);
          try {
            const elev = m.queryTerrainElevation([s.lng, s.lat], { exaggerated: true });
            if (typeof elev === "number") s.baseAltitude = elev;
          } catch { /* terrain not ready */ }
          unit7MarkerRef.current?.setLngLat([s.lng, s.lat]);
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mapLoaded, unit7Open, unit7WalkMode, unit7Visible]);

  // ---- Vibe Police: mount layer + click marker (only when toggled on) -
  useEffect(() => {
    const m = map.current;
    if (!m || !mapLoaded || !vibePoliceVisible) return;
    const LAYER_ID = "vibe-police-character";

    const mount = () => {
      if (vibePoliceLayerAddedRef.current) return;
      try {
        const elev = m.queryTerrainElevation(
          [vibePoliceStateRef.current.lng, vibePoliceStateRef.current.lat],
          { exaggerated: true },
        );
        if (typeof elev === "number") vibePoliceStateRef.current.baseAltitude = elev;
      } catch { /* terrain not ready */ }

      try {
        m.addLayer(createVibePoliceLayer(LAYER_ID, vibePoliceStateRef.current));
        vibePoliceLayerAddedRef.current = true;
        m.triggerRepaint();
      } catch { /* ignore */ }

      if (!vibePoliceMarkerRef.current) {
        const el = document.createElement("div");
        el.style.cssText = `
          width: 70px; height: 90px;
          cursor: default;
          pointer-events: auto;
          display: flex; align-items: flex-end; justify-content: center;
        `;
        const tag = document.createElement("div");
        tag.style.cssText = `
          font-family: 'Sora', sans-serif;
          font-size: 10px; font-weight: 700;
          letter-spacing: 0.12em; text-transform: uppercase;
          color: #f0f7ff;
          padding: 4px 10px;
          border-radius: 999px;
          background: rgba(13, 27, 60, 0.78);
          border: 1px solid rgba(106, 168, 255, 0.6);
          box-shadow: 0 0 14px rgba(106, 168, 255, 0.4);
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
          white-space: nowrap;
          transform: translateY(-90px);
        `;
        tag.textContent = "★ Vibe Police";
        el.appendChild(tag);
        vibePoliceMarkerRef.current = new mapboxgl.Marker({
          element: el,
          anchor: "bottom",
        })
          .setLngLat([vibePoliceStateRef.current.lng, vibePoliceStateRef.current.lat])
          .addTo(m);
      }
    };

    mount();
    const onStyle = () => {
      vibePoliceLayerAddedRef.current = false;
      m.once("idle", mount);
    };
    m.on("style.load", onStyle);
    return () => {
      m.off("style.load", onStyle);
      try { m.removeLayer(LAYER_ID); } catch { /* */ }
      vibePoliceLayerAddedRef.current = false;
      vibePoliceMarkerRef.current?.remove();
      vibePoliceMarkerRef.current = null;
    };
  }, [mapLoaded, vibePoliceVisible]);

  // ---- Vibe Police: autonomous wander loop -----------------------------
  useEffect(() => {
    if (!mapLoaded || !vibePoliceVisible) return;
    const m = map.current;
    if (!m) return;

    let raf = 0;
    let lastTime = performance.now();
    const metersPerDegLat = 111_111;
    const metersPerDegLng = 111_111 * Math.cos((VIBE_POLICE_LOCATION.lat * Math.PI) / 180);

    function pickNewTarget() {
      const r = Math.sqrt(Math.random()) * VIBE_POLICE_WANDER_RADIUS_M;
      const theta = Math.random() * Math.PI * 2;
      vibePoliceTargetRef.current = {
        lng: VIBE_POLICE_LOCATION.lng + (r * Math.cos(theta)) / metersPerDegLng,
        lat: VIBE_POLICE_LOCATION.lat + (r * Math.sin(theta)) / metersPerDegLat,
      };
    }

    const tick = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;
      const s = vibePoliceStateRef.current;

      const target = vibePoliceTargetRef.current;
      if (!target) {
        if (now >= vibePoliceIdleUntilRef.current) {
          pickNewTarget();
          if (s.currentAnim !== "Walking") {
            s.currentAnim = "Walking";
            s.animPulse++;
          }
        } else if (s.currentAnim !== "Alert") {
          s.currentAnim = "Alert";
          s.animPulse++;
        }
      } else {
        const dxMeters = (target.lng - s.lng) * metersPerDegLng;
        const dyMeters = (target.lat - s.lat) * metersPerDegLat;
        const distance = Math.hypot(dxMeters, dyMeters);
        if (distance < 0.6) {
          vibePoliceTargetRef.current = null;
          vibePoliceIdleUntilRef.current = now + (3 + Math.random() * 5) * 1000;
          s.currentAnim = "Alert";
          s.animPulse++;
        } else {
          const sizeFactor = (s.scaleMeters || VIBE_POLICE_DEFAULT_SCALE_METERS) /
            VIBE_POLICE_DEFAULT_SCALE_METERS;
          const step = Math.min(distance, UNIT7_SPEED_MPS * sizeFactor * dt);
          const nx = dxMeters / distance;
          const ny = dyMeters / distance;
          s.lng += (nx * step) / metersPerDegLng;
          s.lat += (ny * step) / metersPerDegLat;
          s.heading = Math.atan2(nx, ny);
          try {
            const elev = m.queryTerrainElevation([s.lng, s.lat], { exaggerated: true });
            if (typeof elev === "number") s.baseAltitude = elev;
          } catch { /* terrain not ready */ }
          vibePoliceMarkerRef.current?.setLngLat([s.lng, s.lat]);
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mapLoaded, vibePoliceVisible]);

  // ---- Spawnables: clear refs when style reloads -----------------------
  // Mapbox wipes all custom layers on style.load. Without nulling the refs
  // here the per-spawnable effects below would think their layer is still
  // mounted and skip re-adding.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const onStyle = () => {
      islandLayerRef.current = null;
      deathStarLayerRef.current = null;
      tokyoLayerRef.current = null;
    };
    m.on("style.load", onStyle);
    return () => { m.off("style.load", onStyle); };
  }, []);

  // ---- Spawnables: add/remove layer when enabled toggles ---------------
  // Heavy GLBs are mounted (and downloads started) only on user opt-in.
  useEffect(() => {
    const m = map.current;
    if (!m || !mapLoaded) return;
    const LAYER_ID = "edge-island";

    if (islandEnabled && !islandLayerRef.current) {
      setIslandLoading(true);
      setIslandProgress(null);
      const layer = createSpawnableLayer(LAYER_ID, islandStateRef.current, {
        modelUrl: "/models/edge-island.glb",
        onProgress: (loaded, total) => {
          setIslandProgress(total ? loaded / total : null);
        },
        onLoaded: () => setIslandLoading(false),
        onError: () => setIslandLoading(false),
      });
      try {
        m.addLayer(layer);
        islandLayerRef.current = layer;
        m.triggerRepaint();
      } catch (e) {
        console.error("[EdgeIsland] addLayer failed", e);
        setIslandLoading(false);
      }
    } else if (!islandEnabled && islandLayerRef.current) {
      try { m.removeLayer(LAYER_ID); } catch { /* noop */ }
      islandLayerRef.current.dispose();
      islandLayerRef.current = null;
      setIslandLoading(false);
      setIslandProgress(null);
    }
  }, [islandEnabled, mapLoaded]);

  // ---- Plaza + Temple 3D structure spawn toggles -----------------
  useEffect(() => {
    if (!mapLoaded || !map.current) return;
    const m = map.current;
    if (plazaEnabled) addStructureLayer(m, "plaza");
    else removeStructureLayer(m, "plaza");
  }, [plazaEnabled, mapLoaded]);

  useEffect(() => {
    if (!mapLoaded || !map.current) return;
    const m = map.current;
    if (templeEnabled) addStructureLayer(m, "temple");
    else removeStructureLayer(m, "temple");
  }, [templeEnabled, mapLoaded]);

  useEffect(() => {
    const m = map.current;
    if (!m || !mapLoaded) return;
    const LAYER_ID = "death-star";

    if (deathStarEnabled && !deathStarLayerRef.current) {
      setDeathStarLoading(true);
      setDeathStarProgress(null);
      const layer = createSpawnableLayer(LAYER_ID, deathStarStateRef.current, {
        modelUrl: "/models/death-star.glb",
        onProgress: (loaded, total) => {
          setDeathStarProgress(total ? loaded / total : null);
        },
        onLoaded: () => setDeathStarLoading(false),
        onError: () => setDeathStarLoading(false),
      });
      try {
        m.addLayer(layer);
        deathStarLayerRef.current = layer;
        m.triggerRepaint();
      } catch (e) {
        console.error("[DeathStar] addLayer failed", e);
        setDeathStarLoading(false);
      }
    } else if (!deathStarEnabled && deathStarLayerRef.current) {
      try { m.removeLayer(LAYER_ID); } catch { /* noop */ }
      deathStarLayerRef.current.dispose();
      deathStarLayerRef.current = null;
      setDeathStarLoading(false);
      setDeathStarProgress(null);
    }
  }, [deathStarEnabled, mapLoaded]);

  useEffect(() => {
    const m = map.current;
    if (!m || !mapLoaded) return;
    const LAYER_ID = "littlest-tokyo";

    if (tokyoEnabled && !tokyoLayerRef.current) {
      // Sample current terrain altitude so the town sits on the ground.
      try {
        const elev = m.queryTerrainElevation(
          [tokyoStateRef.current.lng, tokyoStateRef.current.lat],
          { exaggerated: true },
        );
        if (typeof elev === "number") tokyoStateRef.current.altitude = elev;
      } catch { /* terrain not ready */ }

      setTokyoLoading(true);
      setTokyoProgress(null);
      const layer = createSpawnableLayer(LAYER_ID, tokyoStateRef.current, {
        modelUrl: "/models/littlest-tokyo.glb",
        onProgress: (loaded, total) => {
          setTokyoProgress(total ? loaded / total : null);
        },
        onLoaded: () => setTokyoLoading(false),
        onError: () => setTokyoLoading(false),
      });
      try {
        m.addLayer(layer);
        tokyoLayerRef.current = layer;
        m.triggerRepaint();
      } catch (e) {
        console.error("[LittlestTokyo] addLayer failed", e);
        setTokyoLoading(false);
      }
    } else if (!tokyoEnabled && tokyoLayerRef.current) {
      try { m.removeLayer(LAYER_ID); } catch { /* noop */ }
      tokyoLayerRef.current.dispose();
      tokyoLayerRef.current = null;
      setTokyoLoading(false);
      setTokyoProgress(null);
    }
  }, [tokyoEnabled, mapLoaded]);

  // ---- Helicopter: add/remove layer when enabled toggles ----------------
  useEffect(() => {
    const m = map.current;
    if (!m || !mapLoaded) return;
    const LAYER_ID = "structure-helicopter";

    if (heliUI.enabled && !heliLayerAddedRef.current) {
      try {
        const elev = m.queryTerrainElevation(
          [heliStateRef.current.lng, heliStateRef.current.lat],
          { exaggerated: true },
        );
        const groundAlt = typeof elev === "number" ? elev : 0;
        heliStateRef.current.altitude = groundAlt + 80;
      } catch { /* terrain not ready */ }
      heliStateRef.current.visible = true;

      try {
        m.addLayer(createHelicopterLayer(LAYER_ID, heliStateRef.current));
        heliLayerAddedRef.current = true;
        m.triggerRepaint();
      } catch { /* ignore */ }
    } else if (!heliUI.enabled && heliLayerAddedRef.current) {
      heliStateRef.current.visible = false;
      try { m.removeLayer(LAYER_ID); } catch { /* noop */ }
      heliLayerAddedRef.current = false;
    }
  }, [heliUI.enabled, mapLoaded]);

  // ---- Helicopter: keyboard input ---------------------------------------
  useEffect(() => {
    if (!heliUI.pilotMode) return;
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setHeliUI((s) => ({ ...s, pilotMode: false }));
        heliStateRef.current.pilotMode = false;
        return;
      }
      keysRef.current[e.key.toLowerCase()] = true;
      if (e.key.startsWith("Arrow")) e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => {
      keysRef.current[e.key.toLowerCase()] = false;
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      keysRef.current = {};
    };
  }, [heliUI.pilotMode]);

  // ---- Helicopter: flight + camera-follow loop --------------------------
  useEffect(() => {
    if (!heliUI.enabled) return;
    const m = map.current;
    if (!m) return;

    let raf = 0;
    let last = performance.now();
    let huiTick = 0;

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const s = heliStateRef.current;
      const k = keysRef.current;
      const vel = heliVelocityRef.current;

      if (heliUI.pilotMode) {
        s.pilotMode = true;
        s.rotorSpeed = 1.4;

        const turn = (k["arrowleft"] ? -1 : 0) + (k["arrowright"] ? 1 : 0);
        const throttle = (k["arrowup"] ? 1 : 0) + (k["arrowdown"] ? -0.6 : 0);
        const climb = (k["w"] ? 1 : 0) + (k["s"] ? -1 : 0);
        const strafe = (k["d"] ? 1 : 0) + (k["a"] ? -1 : 0);

        s.heading += turn * 1.1 * dt;

        const targetFwd = throttle * 60;
        const targetLat = strafe * 25;
        const targetVert = climb * 15;
        vel.forward += (targetFwd - vel.forward) * Math.min(1, dt * 2);
        vel.lateral += (targetLat - vel.lateral) * Math.min(1, dt * 2);
        vel.vertical += (targetVert - vel.vertical) * Math.min(1, dt * 2);

        const sinH = Math.sin(s.heading);
        const cosH = Math.cos(s.heading);
        const eastM = sinH * vel.forward + cosH * vel.lateral;
        const northM = cosH * vel.forward - sinH * vel.lateral;

        const dLat = (northM * dt) / 111320;
        const dLng = (eastM * dt) / (111320 * Math.cos((s.lat * Math.PI) / 180));
        s.lat += dLat;
        s.lng += dLng;
        s.altitude = Math.max(15, s.altitude + vel.vertical * dt);

        s.bank += (-turn * 0.4 - strafe * 0.25 - s.bank) * Math.min(1, dt * 4);
        s.pitch += (-throttle * 0.18 - s.pitch) * Math.min(1, dt * 4);

        // Chase cam: behind & above the helicopter
        const back = 90;
        const camLat = s.lat - (cosH * back) / 111320;
        const camLng = s.lng - (sinH * back) / (111320 * Math.cos((s.lat * Math.PI) / 180));
        m.jumpTo({
          center: [camLng, camLat],
          bearing: (s.heading * 180) / Math.PI,
          pitch: 70,
          zoom: 18.2,
        });
      } else {
        s.pilotMode = false;
        s.rotorSpeed = 1;
        vel.forward *= 0.9;
        vel.lateral *= 0.9;
        vel.vertical *= 0.9;
        s.bank += (0 - s.bank) * Math.min(1, dt * 3);
        s.pitch += (0 - s.pitch) * Math.min(1, dt * 3);
      }

      huiTick += dt;
      if (huiTick > 0.16) {
        huiTick = 0;
        const speedKts = Math.hypot(vel.forward, vel.lateral) * 1.94384;
        setHeliUI((u) =>
          Math.round(u.altitude) === Math.round(s.altitude) &&
          u.heading === s.heading &&
          Math.abs(u.speedKts - speedKts) < 0.5
            ? u
            : { ...u, altitude: s.altitude, heading: s.heading, speedKts },
        );
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [heliUI.enabled, heliUI.pilotMode]);

  const resetHelicopter = useCallback(() => {
    const m = map.current;
    const s = heliStateRef.current;
    s.lng = VILLAGE_CENTER.lng;
    s.lat = VILLAGE_CENTER.lat;
    s.heading = 0;
    s.bank = 0;
    s.pitch = 0;
    heliVelocityRef.current = { forward: 0, lateral: 0, vertical: 0 };
    if (m) {
      try {
        const elev = m.queryTerrainElevation([s.lng, s.lat], { exaggerated: true });
        const groundAlt = typeof elev === "number" ? elev : 0;
        s.altitude = groundAlt + 80;
      } catch { /* */ }
      m.flyTo({
        center: [s.lng, s.lat],
        zoom: VILLAGE_CENTER.zoom,
        pitch: 55,
        bearing: 0,
        duration: 1200,
      });
      m.triggerRepaint();
    }
  }, []);

  // ---- Nimbus VTOL: add/remove layer when enabled toggles ---------------
  useEffect(() => {
    const m = map.current;
    if (!m || !mapLoaded) return;
    const LAYER_ID = "structure-nimbus-vtol";

    if (nimbusUI.enabled && !nimbusLayerAddedRef.current) {
      try {
        const elev = m.queryTerrainElevation(
          [nimbusStateRef.current.lng, nimbusStateRef.current.lat],
          { exaggerated: true },
        );
        const groundAlt = typeof elev === "number" ? elev : 0;
        nimbusStateRef.current.altitude = groundAlt + 90;
      } catch { /* terrain not ready */ }
      nimbusStateRef.current.visible = true;

      try {
        m.addLayer(createNimbusVtolLayer(LAYER_ID, nimbusStateRef.current));
        nimbusLayerAddedRef.current = true;
        m.triggerRepaint();
      } catch { /* ignore */ }
    } else if (!nimbusUI.enabled && nimbusLayerAddedRef.current) {
      nimbusStateRef.current.visible = false;
      try { m.removeLayer(LAYER_ID); } catch { /* noop */ }
      nimbusLayerAddedRef.current = false;
    }
  }, [nimbusUI.enabled, mapLoaded]);

  // ---- Nimbus VTOL: keyboard input --------------------------------------
  useEffect(() => {
    if (!nimbusUI.pilotMode) return;
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setNimbusUI((s) => ({ ...s, pilotMode: false }));
        nimbusStateRef.current.pilotMode = false;
        return;
      }
      nimbusKeysRef.current[e.key.toLowerCase()] = true;
      if (e.key.startsWith("Arrow")) e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => {
      nimbusKeysRef.current[e.key.toLowerCase()] = false;
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      nimbusKeysRef.current = {};
    };
  }, [nimbusUI.pilotMode]);

  // ---- Nimbus VTOL: flight + chase camera loop --------------------------
  useEffect(() => {
    if (!nimbusUI.enabled) return;
    const m = map.current;
    if (!m) return;

    let raf = 0;
    let last = performance.now();
    let huiTick = 0;

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const s = nimbusStateRef.current;
      const k = nimbusKeysRef.current;
      const vel = nimbusVelocityRef.current;

      if (nimbusUI.pilotMode) {
        s.pilotMode = true;
        s.thrusterIntensity = 1;

        const turn = (k["arrowleft"] ? -1 : 0) + (k["arrowright"] ? 1 : 0);
        const throttle = (k["arrowup"] ? 1 : 0) + (k["arrowdown"] ? -0.6 : 0);
        const climb = (k["w"] ? 1 : 0) + (k["s"] ? -1 : 0);
        const strafe = (k["d"] ? 1 : 0) + (k["a"] ? -1 : 0);

        s.heading += turn * 1.3 * dt;

        // Nimbus is faster than the helicopter
        const targetFwd = throttle * 95;
        const targetLat = strafe * 35;
        const targetVert = climb * 22;
        vel.forward += (targetFwd - vel.forward) * Math.min(1, dt * 2.4);
        vel.lateral += (targetLat - vel.lateral) * Math.min(1, dt * 2.4);
        vel.vertical += (targetVert - vel.vertical) * Math.min(1, dt * 2.4);

        const sinH = Math.sin(s.heading);
        const cosH = Math.cos(s.heading);
        const eastM = sinH * vel.forward + cosH * vel.lateral;
        const northM = cosH * vel.forward - sinH * vel.lateral;

        const dLat = (northM * dt) / 111320;
        const dLng = (eastM * dt) / (111320 * Math.cos((s.lat * Math.PI) / 180));
        s.lat += dLat;
        s.lng += dLng;
        s.altitude = Math.max(20, s.altitude + vel.vertical * dt);

        s.bank += (-turn * 0.5 - strafe * 0.3 - s.bank) * Math.min(1, dt * 4);
        s.pitch += (-throttle * 0.22 - s.pitch) * Math.min(1, dt * 4);

        const back = 110;
        const camLat = s.lat - (cosH * back) / 111320;
        const camLng = s.lng - (sinH * back) / (111320 * Math.cos((s.lat * Math.PI) / 180));
        m.jumpTo({
          center: [camLng, camLat],
          bearing: (s.heading * 180) / Math.PI,
          pitch: 70,
          zoom: 18,
        });
      } else {
        s.pilotMode = false;
        s.thrusterIntensity = 0.6;
        vel.forward *= 0.92;
        vel.lateral *= 0.92;
        vel.vertical *= 0.92;
        s.bank += (0 - s.bank) * Math.min(1, dt * 3);
        s.pitch += (0 - s.pitch) * Math.min(1, dt * 3);
      }

      huiTick += dt;
      if (huiTick > 0.16) {
        huiTick = 0;
        const speedKts = Math.hypot(vel.forward, vel.lateral) * 1.94384;
        setNimbusUI((u) =>
          Math.round(u.altitude) === Math.round(s.altitude) &&
          u.heading === s.heading &&
          Math.abs(u.speedKts - speedKts) < 0.5
            ? u
            : { ...u, altitude: s.altitude, heading: s.heading, speedKts },
        );
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [nimbusUI.enabled, nimbusUI.pilotMode]);

  const resetNimbus = useCallback(() => {
    const m = map.current;
    const s = nimbusStateRef.current;
    s.lng = VILLAGE_CENTER.lng;
    s.lat = VILLAGE_CENTER.lat;
    s.heading = 0;
    s.bank = 0;
    s.pitch = 0;
    nimbusVelocityRef.current = { forward: 0, lateral: 0, vertical: 0 };
    if (m) {
      try {
        const elev = m.queryTerrainElevation([s.lng, s.lat], { exaggerated: true });
        const groundAlt = typeof elev === "number" ? elev : 0;
        s.altitude = groundAlt + 90;
      } catch { /* */ }
      m.flyTo({
        center: [s.lng, s.lat],
        zoom: VILLAGE_CENTER.zoom,
        pitch: 55,
        bearing: 0,
        duration: 1200,
      });
      m.triggerRepaint();
    }
  }, []);

  // ---- Vibey: walk-mode keyboard input ---------------------------------
  useEffect(() => {
    if (!vibeyUI.walkMode) return;
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setVibeyUI((s) => ({ ...s, walkMode: false }));
        vibeyStateRef.current.walkMode = false;
        return;
      }
      vibeyKeysRef.current[e.key.toLowerCase()] = true;
      if (e.key.startsWith("Arrow")) e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => {
      vibeyKeysRef.current[e.key.toLowerCase()] = false;
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      vibeyKeysRef.current = {};
    };
  }, [vibeyUI.walkMode]);

  // ---- Vibey: walk loop + first-person chase camera --------------------
  useEffect(() => {
    if (!vibeyUI.walkMode) return;
    const m = map.current;
    if (!m) return;

    let raf = 0;
    let last = performance.now();
    let huiTick = 0;
    const WALK_SPEED = 6; // m/s

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const s = vibeyStateRef.current;
      const k = vibeyKeysRef.current;

      const turn =
        (k["arrowleft"] || k["a"] ? -1 : 0) +
        (k["arrowright"] || k["d"] ? 1 : 0);
      const forward =
        (k["arrowup"] || k["w"] ? 1 : 0) +
        (k["arrowdown"] || k["s"] ? -0.6 : 0);

      s.heading += turn * 1.6 * dt;

      const sinH = Math.sin(s.heading);
      const cosH = Math.cos(s.heading);
      const eastM = sinH * forward * WALK_SPEED;
      const northM = cosH * forward * WALK_SPEED;
      s.lat += (northM * dt) / 111320;
      s.lng += (eastM * dt) / (111320 * Math.cos((s.lat * Math.PI) / 180));

      // Resample ground altitude as Vibey moves
      try {
        const elev = m.queryTerrainElevation([s.lng, s.lat], { exaggerated: true });
        if (typeof elev === "number") s.baseAltitude = elev;
      } catch { /* */ }

      // Move marker so click target follows
      vibeyMarkerRef.current?.setLngLat([s.lng, s.lat]);

      // Third-person chase cam from just behind & above Vibey
      const back = 12; // meters behind
      const camLat = s.lat - (cosH * back) / 111320;
      const camLng = s.lng - (sinH * back) / (111320 * Math.cos((s.lat * Math.PI) / 180));
      m.jumpTo({
        center: [camLng, camLat],
        bearing: (s.heading * 180) / Math.PI,
        pitch: 75,
        zoom: 20,
      });

      huiTick += dt;
      if (huiTick > 0.16) {
        huiTick = 0;
        setVibeyUI((u) => (u.heading === s.heading ? u : { ...u, heading: s.heading }));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [vibeyUI.walkMode]);

  // ---- Unit-7: walk-mode keyboard input --------------------------------
  useEffect(() => {
    if (!unit7WalkMode) return;
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setUnit7WalkMode(false);
        return;
      }
      unit7KeysRef.current[e.key.toLowerCase()] = true;
    };
    const onUp = (e: KeyboardEvent) => {
      unit7KeysRef.current[e.key.toLowerCase()] = false;
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      unit7KeysRef.current = {};
    };
  }, [unit7WalkMode]);

  // ---- Unit-7: walk loop + third-person chase camera -------------------
  useEffect(() => {
    if (!unit7WalkMode) return;
    const m = map.current;
    if (!m) return;

    let raf = 0;
    let last = performance.now();
    const WALK_SPEED = 6; // m/s, scaled by body size below

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const s = unit7StateRef.current;
      const k = unit7KeysRef.current;

      const turn =
        (k["arrowleft"] || k["a"] ? -1 : 0) +
        (k["arrowright"] || k["d"] ? 1 : 0);
      const forward =
        (k["arrowup"] || k["w"] ? 1 : 0) +
        (k["arrowdown"] || k["s"] ? -0.6 : 0);

      s.heading += turn * 1.6 * dt;

      const sinH = Math.sin(s.heading);
      const cosH = Math.cos(s.heading);
      const sizeFactor =
        (s.scaleMeters || UNIT7_DEFAULT_SCALE_METERS) / UNIT7_DEFAULT_SCALE_METERS;
      const speed = WALK_SPEED * sizeFactor;
      const eastM = sinH * forward * speed;
      const northM = cosH * forward * speed;
      s.lat += (northM * dt) / 111320;
      s.lng += (eastM * dt) / (111320 * Math.cos((s.lat * Math.PI) / 180));

      // Drive the right animation for what he's doing right now.
      const wantAnim = forward !== 0 ? "Walking" : "Idle";
      if (s.currentAnim !== wantAnim) {
        unit7BaseAnimRef.current = wantAnim;
        s.currentAnim = wantAnim;
        s.animPulse++;
      }

      try {
        const elev = m.queryTerrainElevation([s.lng, s.lat], { exaggerated: true });
        if (typeof elev === "number") s.baseAltitude = elev;
      } catch { /* */ }

      unit7MarkerRef.current?.setLngLat([s.lng, s.lat]);

      // Third-person chase cam: ~12m behind & above him.
      const back = 12;
      const camLat = s.lat - (cosH * back) / 111320;
      const camLng =
        s.lng - (sinH * back) / (111320 * Math.cos((s.lat * Math.PI) / 180));
      m.jumpTo({
        center: [camLng, camLat],
        bearing: (s.heading * 180) / Math.PI,
        pitch: 75,
        zoom: 20,
      });

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [unit7WalkMode]);

  const resetVibey = useCallback(() => {
    const m = map.current;
    const s = vibeyStateRef.current;
    s.lng = VIBEY_LOCATION.lng;
    s.lat = VIBEY_LOCATION.lat;
    s.heading = 0;
    try {
      const elev = m?.queryTerrainElevation([s.lng, s.lat], { exaggerated: true });
      if (typeof elev === "number") s.baseAltitude = elev;
    } catch { /* */ }
    vibeyMarkerRef.current?.setLngLat([s.lng, s.lat]);
    setVibeyUI((u) => ({ ...u, heading: 0 }));
    if (m && !vibeyUI.walkMode) {
      m.flyTo({
        center: [s.lng, s.lat],
        zoom: 18,
        pitch: 55,
        bearing: 0,
        duration: 1200,
      });
    }
  }, [vibeyUI.walkMode]);


  // Fallback for invalid token
  if (mapError) {
    return <FallbackMap onLocationSelect={onLocationSelect} selectedLocation={selectedLocation} />;
  }

  return (
    <div className="relative h-full w-full">
      <div ref={mapContainer} className="absolute inset-0" />

      {/* Inject marker pulse animation */}
      <style>{`
        @keyframes marker-pulse {
          0% { transform: scale(1); opacity: 1; }
          100% { transform: scale(2.5); opacity: 0; }
        }
        .mapboxgl-popup-content {
          background: transparent !important;
          padding: 0 !important;
          box-shadow: none !important;
          border-radius: 12px !important;
        }
        .mapboxgl-popup-tip {
          border-top-color: hsl(216, 40%, 14%) !important;
        }
        .mapboxgl-ctrl-group {
          background: hsl(216, 40%, 14%, 0.9) !important;
          border: 1px solid hsl(160, 20%, 20%) !important;
          backdrop-filter: blur(12px) !important;
          border-radius: 12px !important;
        }
        .mapboxgl-ctrl-group button {
          border-color: hsl(160, 20%, 20%) !important;
        }
        /* Lift Mapbox controls above the mobile bottom nav */
        .mapboxgl-ctrl-bottom-right,
        .mapboxgl-ctrl-bottom-left {
          margin-bottom: 88px !important;
        }
        @media (min-width: 768px) {
          .mapboxgl-ctrl-bottom-right,
          .mapboxgl-ctrl-bottom-left {
            margin-bottom: 0 !important;
          }
        }
        .mapboxgl-ctrl-group button span {
          filter: invert(1) !important;
        }
      `}</style>

      {/* Live counter — top-right (badge is rendered by the page shell) */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8 }}
        className="absolute top-4 right-4 z-10"
      >
        <div className="flex flex-col items-end gap-2">
          <div className="glass-panel rounded-full px-3 py-1.5 flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            <span className="text-xs font-body font-medium text-foreground">208 here now</span>
          </div>
          <div className="glass-panel rounded-full px-3 py-1.5 flex items-center gap-2">
            <span className="text-[11px] font-mono font-semibold text-primary tracking-wide">
              {clockLabel}
            </span>
            <span className="text-[9px] font-mono text-muted-foreground tracking-widest">PT</span>
          </div>
        </div>
      </motion.div>

      {/* Vibey chat dialog */}
      <VibeyDialog open={vibeyOpen} onClose={() => setVibeyOpen(false)} />

      {/* Unit-7 interaction dialog */}
      <Unit7Dialog
        open={unit7Open}
        onClose={() => {
          setUnit7Open(false);
          // Resume autonomous wandering after the dialog closes; clear face
          // morphs so he goes back to neutral.
          unit7BaseAnimRef.current = "Idle";
          unit7StateRef.current.currentAnim = "Idle";
          unit7StateRef.current.animPulse++;
          unit7StateRef.current.expressions.Angry = 0;
          unit7StateRef.current.expressions.Surprised = 0;
          unit7StateRef.current.expressions.Sad = 0;
        }}
        onEmote={(anim) => {
          // One-shots auto-revert via the layer's "finished" event.
          unit7StateRef.current.currentAnim = anim;
          unit7StateRef.current.animPulse++;
        }}
        onExpression={(expr, intensity) => {
          unit7StateRef.current.expressions[expr] = intensity;
        }}
      />

      {/* Sky Patrol — unified Vibey + Helicopter control */}
      <HelicopterControl
        state={heliUI}
        onToggleEnabled={() =>
          setHeliUI((s) => ({
            ...s,
            enabled: !s.enabled,
            pilotMode: s.enabled ? false : s.pilotMode,
          }))
        }
        onTogglePilot={() => {
          setHeliUI((s) => {
            const next = !s.pilotMode;
            heliStateRef.current.pilotMode = next;
            return { ...s, pilotMode: next };
          });
        }}
        onResetPosition={resetHelicopter}
        vibey={vibeyUI}
        onToggleVibeyWalk={() => {
          setVibeyUI((s) => {
            const next = !s.walkMode;
            vibeyStateRef.current.walkMode = next;
            // When entering walk mode, fly the camera into chase position
            if (next && map.current) {
              const vs = vibeyStateRef.current;
              try {
                const elev = map.current.queryTerrainElevation([vs.lng, vs.lat], { exaggerated: true });
                if (typeof elev === "number") vs.baseAltitude = elev;
              } catch { /* */ }
              map.current.flyTo({
                center: [vs.lng, vs.lat],
                zoom: 20,
                pitch: 75,
                bearing: (vs.heading * 180) / Math.PI,
                duration: 1100,
              });
            }
            return { ...s, walkMode: next };
          });
        }}
        onResetVibey={resetVibey}
        onMessageVibey={() => setVibeyOpen(true)}
        vibeyVisible={vibeyVisible}
        onToggleVibey={() => setVibeyVisible((v) => {
          // If turning off while walking, exit walk mode so the chase
          // camera doesn't try to follow a despawned character.
          if (v && vibeyUI.walkMode) {
            vibeyStateRef.current.walkMode = false;
            setVibeyUI((s) => ({ ...s, walkMode: false }));
          }
          return !v;
        })}
        unit7Visible={unit7Visible}
        onToggleUnit7={() => setUnit7Visible((v) => {
          if (v && unit7WalkMode) setUnit7WalkMode(false);
          return !v;
        })}
        vibePoliceVisible={vibePoliceVisible}
        onToggleVibePolice={() => setVibePoliceVisible((v) => !v)}
        unit7Scale={unit7Scale}
        unit7ScaleMin={UNIT7_MIN_SCALE_METERS}
        unit7ScaleMax={UNIT7_MAX_SCALE_METERS}
        onUnit7ScaleChange={(v) => {
          setUnit7Scale(v);
          unit7StateRef.current.scaleMeters = v;
        }}
        vibePoliceScale={vibePoliceScale}
        vibePoliceScaleMin={VIBE_POLICE_MIN_SCALE_METERS}
        vibePoliceScaleMax={VIBE_POLICE_MAX_SCALE_METERS}
        onVibePoliceScaleChange={(v) => {
          setVibePoliceScale(v);
          vibePoliceStateRef.current.scaleMeters = v;
        }}
        unit7WalkMode={unit7WalkMode}
        onToggleUnit7Walk={() => {
          const next = !unit7WalkMode;
          if (next && map.current) {
            const s = unit7StateRef.current;
            try {
              const elev = map.current.queryTerrainElevation([s.lng, s.lat], { exaggerated: true });
              if (typeof elev === "number") s.baseAltitude = elev;
            } catch { /* */ }
            map.current.flyTo({
              center: [s.lng, s.lat],
              zoom: 20,
              pitch: 75,
              bearing: (s.heading * 180) / Math.PI,
              duration: 1100,
            });
          }
          setUnit7WalkMode(next);
        }}
        onMessageUnit7={() => {
          // Third-person video-game-style framing: zoom way in, low-ish
          // pitch so we see his face/body, turn him to face the camera,
          // wave hello.
          if (map.current) {
            const s = unit7StateRef.current;
            const camBearing = map.current.getBearing();
            map.current.flyTo({
              center: [s.lng, s.lat],
              zoom: 19.5,
              pitch: 55,
              bearing: camBearing,
              duration: 1100,
            });
            // Camera bearing is degrees clockwise from north. Robot's heading
            // is radians, 0 = north (matches the wander loop's atan2 frame).
            // Add π so he faces TOWARD the camera, not away from it.
            unit7BaseAnimRef.current = "Idle";
            unit7TargetRef.current = null;
            s.heading = (camBearing * Math.PI) / 180 + Math.PI;
            s.currentAnim = "Wave";
            s.animPulse++;
          }
          setUnit7Open(true);
        }}
        nimbus={nimbusUI}
        onToggleNimbus={() =>
          setNimbusUI((s) => ({
            ...s,
            enabled: !s.enabled,
            pilotMode: s.enabled ? false : s.pilotMode,
          }))
        }
        onTogglePilotNimbus={() => {
          setNimbusUI((s) => {
            const next = !s.pilotMode;
            nimbusStateRef.current.pilotMode = next;
            return { ...s, pilotMode: next };
          });
        }}
        onResetNimbus={resetNimbus}
        places={[
          {
            id: "edge-esmeralda",
            label: "Edge Esmeralda",
            description: "Healdsburg, CA. The pop-up village — Vibey, Unit-7, Vibe Police, the plaza pavilion, and the meditation temple.",
            onFlyTo: () => {
              if (!map.current) return;
              map.current.flyTo({
                center: [VILLAGE_CENTER.lng, VILLAGE_CENTER.lat],
                zoom: VILLAGE_CENTER.zoom,
                pitch: 60,
                bearing: -20,
                duration: 2200,
              });
            },
          },
          {
            id: "san-francisco",
            label: "San Francisco",
            description: "Embarcadero waterfront. Mapbox renders the SF skyline, Bay Bridge, and downtown blocks in 3D.",
            onFlyTo: () => {
              if (!map.current) return;
              map.current.flyTo({
                // Looking northwest from the Embarcadero, framing the Ferry
                // Building + downtown skyline.
                center: [-122.3947, 37.7955],
                zoom: 16.2,
                pitch: 65,
                bearing: -50,
                duration: 3000,
              });
            },
          },
          {
            id: "outer-space",
            label: "Outer Space",
            description: "Vibey 2.0's late-night show. A floating asteroid platform with the Vibey Show, live community photos, member cards orbiting overhead, and Vibey's knowledge in the sky.",
            onFlyTo: () => navigate("/space"),
          },
        ]}
        spawnables={[
          {
            id: "plaza",
            label: "Central Plaza",
            description: "The fountain + pavilion structure at the plaza beacon. Spawn to see the full venue, despawn to keep just the beam of light.",
            enabled: plazaEnabled,
            loading: false,
            progress: null,
            onToggle: () => {
              if (!plazaEnabled && map.current) {
                const plaza = VILLAGE_LOCATIONS.find((l) => l.structure3d === "plaza");
                if (plaza) {
                  map.current.flyTo({
                    center: [plaza.lng, plaza.lat],
                    zoom: 18,
                    pitch: 65,
                    bearing: -20,
                    duration: 1500,
                  });
                }
              }
              setPlazaEnabled((v) => !v);
            },
          },
          {
            id: "temple",
            label: "Meditation Temple",
            description: "Pagoda-style temple at the meditation garden beacon. Spawn to bring it in.",
            enabled: templeEnabled,
            loading: false,
            progress: null,
            onToggle: () => {
              if (!templeEnabled && map.current) {
                const temple = VILLAGE_LOCATIONS.find((l) => l.structure3d === "temple");
                if (temple) {
                  map.current.flyTo({
                    center: [temple.lng, temple.lat],
                    zoom: 18,
                    pitch: 65,
                    bearing: -20,
                    duration: 1500,
                  });
                }
              }
              setTempleEnabled((v) => !v);
            },
          },
          {
            id: "island",
            label: "Edge Island",
            description: "A floating world above the village. Heavy asset (~272 MB) — only loads when you spawn it.",
            enabled: islandEnabled,
            loading: islandLoading,
            progress: islandProgress,
            onToggle: () => {
              if (!islandEnabled && map.current) {
                const s = islandStateRef.current;
                map.current.flyTo({
                  center: [s.lng, s.lat],
                  zoom: 14.5,
                  pitch: 70,
                  bearing: -25,
                  duration: 1500,
                });
              }
              setIslandEnabled((v) => !v);
            },
          },
          {
            id: "death-star",
            label: "Death Star",
            description: "Moon-sized space station hovering east of the village (~60 MB).",
            enabled: deathStarEnabled,
            loading: deathStarLoading,
            progress: deathStarProgress,
            onToggle: () => {
              if (!deathStarEnabled && map.current) {
                const s = deathStarStateRef.current;
                map.current.flyTo({
                  center: [s.lng, s.lat],
                  zoom: 13.5,
                  pitch: 70,
                  bearing: 35,
                  duration: 1500,
                });
              }
              setDeathStarEnabled((v) => !v);
            },
          },
          {
            id: "littlest-tokyo",
            label: "Tokyo Block",
            description: "Animated micro-city next to the plaza — keyframe traffic, neon, all looping (~4 MB).",
            enabled: tokyoEnabled,
            loading: tokyoLoading,
            progress: tokyoProgress,
            onToggle: () => {
              if (!tokyoEnabled && map.current) {
                const s = tokyoStateRef.current;
                map.current.flyTo({
                  center: [s.lng, s.lat],
                  zoom: 18,
                  pitch: 65,
                  bearing: -10,
                  duration: 1500,
                });
              }
              setTokyoEnabled((v) => !v);
            },
          },
        ]}
      />

      {/* Bottom controls — lifted on mobile so the bottom nav doesn't cover them */}
      <div className="absolute bottom-24 md:bottom-6 left-4 z-10 flex gap-2">
        <button
          onClick={trackLocation}
          className="glass-panel rounded-lg p-2.5 hover:bg-muted transition-colors"
          title="Find my location"
        >
          <Locate className="w-4 h-4 text-primary" />
        </button>
        <button
          onClick={() => setMapStyle(s => s === "dark" ? "satellite" : "dark")}
          className="glass-panel rounded-lg p-2.5 hover:bg-muted transition-colors"
          title="Toggle map style"
        >
          <Layers className="w-4 h-4 text-primary" />
        </button>
        <button
          onClick={() => map.current?.flyTo({
            center: [VILLAGE_CENTER.lng, VILLAGE_CENTER.lat],
            zoom: VILLAGE_CENTER.zoom,
            pitch: 45,
            bearing: -17,
            duration: 1200,
          })}
          className="glass-panel rounded-lg p-2.5 hover:bg-muted transition-colors"
          title="Reset view"
        >
          <Navigation className="w-4 h-4 text-primary" />
        </button>
      </div>

      {/* Map loading overlay */}
      <AnimatePresence>
        {!mapLoaded && (
          <motion.div
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-navy-deep flex items-center justify-center z-20"
          >
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <p className="font-heading text-sm text-muted-foreground">Loading map…</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Fallback stylized map if Mapbox token is invalid
function FallbackMap({ onLocationSelect, selectedLocation }: MapViewProps) {
  return (
    <div className="relative h-full w-full overflow-hidden bg-navy-deep">
      <div className="absolute inset-0" style={{
        backgroundImage: `
          radial-gradient(circle at 30% 40%, hsl(150, 40%, 18%, 0.4) 0%, transparent 50%),
          radial-gradient(circle at 70% 60%, hsl(160, 80%, 50%, 0.08) 0%, transparent 40%),
          linear-gradient(hsl(160, 20%, 20%, 0.15) 1px, transparent 1px),
          linear-gradient(90deg, hsl(160, 20%, 20%, 0.15) 1px, transparent 1px)
        `,
        backgroundSize: '100% 100%, 100% 100%, 40px 40px, 40px 40px',
      }} />

      <svg className="absolute inset-0 w-full h-full opacity-10" viewBox="0 0 100 100" preserveAspectRatio="none">
        <path d="M10,50 Q30,20 50,45 T90,40" fill="none" stroke="hsl(160,80%,50%)" strokeWidth="0.3" />
        <path d="M5,60 Q25,35 55,55 T95,50" fill="none" stroke="hsl(160,80%,50%)" strokeWidth="0.2" />
      </svg>

      <div className="absolute top-6 left-6 z-10 glass-panel rounded-xl px-4 py-2">
        <p className="font-heading text-xs font-semibold tracking-widest uppercase text-primary">Edge Esmeralda Village</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">Healdsburg, CA · Offline Mode</p>
      </div>

      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center glass-panel rounded-2xl p-6 max-w-xs">
        <p className="font-heading text-sm font-semibold text-foreground mb-1">Map Unavailable</p>
        <p className="text-xs text-muted-foreground">
          Update your Mapbox token in <code className="text-primary text-[11px]">src/config/mapbox.ts</code> to enable the interactive map.
        </p>
      </div>

      {/* Still show markers in fallback */}
      {VILLAGE_LOCATIONS.filter((l) => l.structure3d).map((loc, i) => {
        const x = 15 + ((loc.lng + 122.872) / 0.005) * 70;
        const y = 15 + ((38.615 - loc.lat) / 0.004) * 70;
        const isSelected = selectedLocation?.id === loc.id;
        const color = TYPE_COLORS[loc.type];

        return (
          <motion.div
            key={loc.id}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2 + i * 0.08, type: "spring" }}
            className="absolute z-20 cursor-pointer"
            style={{ left: `${x}%`, top: `${y}%`, transform: 'translate(-50%, -50%)' }}
            onClick={() => onLocationSelect(isSelected ? null : loc)}
          >
            <motion.div
              animate={{ scale: isSelected ? 1.2 : 1, boxShadow: isSelected ? `0 0 20px ${color}88` : "none" }}
              className="w-10 h-10 rounded-full border-2"
              style={{ borderColor: color, background: `${color}22` }}
            />
          </motion.div>
        );
      })}
    </div>
  );
}

export { VILLAGE_LOCATIONS };
export type { MapViewProps };
