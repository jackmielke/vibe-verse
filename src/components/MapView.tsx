import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Navigation, Zap, Layers, Locate } from "lucide-react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { MAPBOX_TOKEN, VILLAGE_CENTER } from "@/config/mapbox";
import { createMeditationTempleLayer } from "./map/MeditationTempleLayer";
import { createPlazaLayer } from "./map/PlazaLayer";
import { createObservatoryLayer } from "./map/ObservatoryLayer";
import {
  createHelicopterLayer,
  createDefaultHelicopterState,
  type HelicopterState,
} from "./map/HelicopterLayer";
import HelicopterControl, {
  type HelicopterControlState,
} from "./HelicopterControl";

// Village locations with real coordinates around Healdsburg.
// `structure3d` marks locations that are rendered as a 3D model on the map
// instead of an emoji bubble — the marker becomes an invisible click target
// over the 3D asset, and the same selection/animation flow is used.
const VILLAGE_LOCATIONS = [
  { id: 1, name: "Main Stage", lat: 38.6132, lng: -122.8700, type: "venue", people: 42, emoji: "🎤" },
  { id: 2, name: "Hacker House", lat: 38.6140, lng: -122.8682, type: "workspace", people: 18, emoji: "💻" },
  { id: 3, name: "The Grove", lat: 38.6120, lng: -122.8715, type: "social", people: 27, emoji: "🌳" },
  { id: 4, name: "Dining Hall", lat: 38.6145, lng: -122.8698, type: "food", people: 55, emoji: "🍽️" },
  { id: 5, name: "Meditation Garden", lat: 38.6115, lng: -122.8688, type: "wellness", people: 8, emoji: "🧘", structure3d: "temple" as const, hitSize: 160 },
  { id: 6, name: "Co-working Barn", lat: 38.6128, lng: -122.8720, type: "workspace", people: 31, emoji: "🏠" },
  { id: 7, name: "Pool Deck", lat: 38.6148, lng: -122.8690, type: "social", people: 15, emoji: "🏊" },
  { id: 8, name: "Art Studio", lat: 38.6118, lng: -122.8672, type: "venue", people: 12, emoji: "🎨" },
  { id: 9, name: "Central Plaza", lat: 38.6130, lng: -122.8692, type: "social", people: 64, emoji: "⛲", structure3d: "plaza" as const, hitSize: 200 },
  { id: 10, name: "Observatory", lat: 38.6138, lng: -122.8710, type: "venue", people: 6, emoji: "🔭", structure3d: "observatory" as const, hitSize: 140 },
  { id: 11, name: "Sky Patrol Helicopter", lat: 38.6132, lng: -122.8695, type: "venue", people: 2, emoji: "🚁", structure3d: "helicopter" as const, hitSize: 180 },
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
  observatory: { layerId: "structure-observatory", create: createObservatoryLayer },
  helicopter: { layerId: "structure-helicopter", create: createHelicopterLayer },
};

// Adds every 3D structure layer for locations that have `structure3d` set.
// Safe to call multiple times — it skips layers that already exist (and is
// also called from `style.load` since custom layers are wiped on style change).
// Uses `queryTerrainElevation` so structures sit on the ground rather than
// sinking below an elevated terrain surface.
function addStructureLayers(m: mapboxgl.Map) {
  VILLAGE_LOCATIONS.forEach((loc) => {
    if (!loc.structure3d) return;
    const factory = STRUCTURE_FACTORIES[loc.structure3d];
    if (!factory || m.getLayer(factory.layerId)) return;
    let altitude = 0;
    try {
      // queryTerrainElevation returns meters above sea level at this lng/lat,
      // or null if terrain isn't ready yet. Add a tiny lift so the base of
      // the model isn't z-fighting with the terrain mesh.
      const elev = m.queryTerrainElevation([loc.lng, loc.lat], { exaggerated: true });
      if (typeof elev === "number") altitude = elev + 0.5;
    } catch {
      /* terrain not ready */
    }
    try {
      m.addLayer(factory.create(factory.layerId, { lng: loc.lng, lat: loc.lat }, altitude));
    } catch {
      /* ignore — layer may not be ready in this style */
    }
  });
}

// Re-create structure layers (e.g. once terrain has loaded) so altitude
// reflects current ground elevation.
function refreshStructureLayers(m: mapboxgl.Map) {
  VILLAGE_LOCATIONS.forEach((loc) => {
    if (!loc.structure3d) return;
    const factory = STRUCTURE_FACTORIES[loc.structure3d];
    if (!factory) return;
    if (m.getLayer(factory.layerId)) {
      try { m.removeLayer(factory.layerId); } catch { /* noop */ }
    }
  });
  addStructureLayers(m);
}

interface MapViewProps {
  onLocationSelect: (location: typeof VILLAGE_LOCATIONS[0] | null) => void;
  selectedLocation: typeof VILLAGE_LOCATIONS[0] | null;
}

export default function MapView({ onLocationSelect, selectedLocation }: MapViewProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  const userMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapStyle, setMapStyle] = useState<"satellite" | "dark">("dark");
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [mapError, setMapError] = useState(false);

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

        // Set Standard style config for colorful, immersive 3D look
        try {
          m.setConfigProperty("basemap", "lightPreset", "dusk");
          m.setConfigProperty("basemap", "showPointOfInterestLabels", true);
          m.setConfigProperty("basemap", "showTransitLabels", false);
          m.setConfigProperty("basemap", "showPlaceLabels", true);
          m.setConfigProperty("basemap", "show3dObjects", true);
        } catch (e) {
          // Config properties may not be available on all versions
        }

        // Re-add 3D structures (custom layers are wiped on style change).
        // Wait one tick for terrain tiles before sampling elevation.
        addStructureLayers(m);
        m.once("idle", () => refreshStructureLayers(m));
      });

      // When new terrain tiles load near our structures, re-seat them on the
      // ground so they don't appear to sink as the user pans/zooms.
      m.on("sourcedata", (e) => {
        if (e.sourceId === "mapbox-dem" && e.isSourceLoaded) {
          refreshStructureLayers(m);
        }
      });

      m.addControl(new mapboxgl.NavigationControl({ showCompass: true, visualizePitch: true }), "bottom-right");

      m.on("load", () => {
        setMapLoaded(true);

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

        // Add 3D buildings (kept as fallback for non-Standard styles like satellite)
        const layers = m.getStyle()?.layers;
        if (layers) {
          const labelLayer = layers.find(
            (layer) => layer.type === "symbol" && (layer.layout as any)?.["text-field"]
          );
          if (labelLayer && !m.getLayer("3d-buildings")) {
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
                    "fill-extrusion-color": "#2dd4a8",
                    "fill-extrusion-height": ["*", ["get", "height"], 1.5],
                    "fill-extrusion-base": ["get", "min_height"],
                    "fill-extrusion-opacity": 0.7,
                  },
                },
                labelLayer.id
              );
            } catch {
              // Standard style doesn't expose composite source — ignore
            }
          }
        }

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

        // 3D structure overlays (also re-added on style.load)
        addStructureLayers(m);
      });

      m.on("error", () => {
        setMapError(true);
      });

      map.current = m;
    } catch {
      setMapError(true);
    }

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Update map style
  useEffect(() => {
    if (!map.current || !mapLoaded) return;
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
      // Any location backed by a 3D model uses an invisible click target
      // sized to cover that model — no emoji bubble.
      const is3d = Boolean(loc.structure3d);
      const hitSize = loc.hitSize ?? 44;

      // Outer wrapper — Mapbox owns this element's transform for positioning.
      // DO NOT set `transform` on this element or markers will snap to (0,0).
      const el = document.createElement("div");
      el.className = "village-marker";
      // For 3D structures we make the hit area TALL so it covers the model
      // that rises upward in screen space from the ground anchor.
      const hitWidth = hitSize;
      const hitHeight = is3d ? Math.round(hitSize * 1.6) : hitSize;
      el.style.cssText = `
        width: ${hitWidth}px; height: ${hitHeight}px;
        position: relative;
        cursor: pointer;
        will-change: transform;
        pointer-events: auto;
      `;

      // Inner scale wrapper — safe to transform/scale here.
      const inner = document.createElement("div");
      if (is3d) {
        // Invisible click target sized to cover the 3D structure.
        // Selected state still gets a soft glow ring around the model base.
        inner.style.cssText = `
          width: 100%; height: 100%;
          border-radius: 40% 40% 50% 50%;
          background: transparent;
          position: relative;
          ${isSelected ? `box-shadow: inset 0 -20px 40px ${color}55, 0 0 30px ${color}66;` : ""}
          transition: box-shadow 0.2s ease;
        `;
      } else {
        inner.style.cssText = `
          width: 100%; height: 100%;
          display: flex; align-items: center; justify-content: center;
          border-radius: 50%;
          border: 2px solid ${color};
          background: ${color}22;
          font-size: 20px;
          position: relative;
          transition: transform 0.2s ease, box-shadow 0.2s ease;
          ${isSelected ? `box-shadow: 0 0 20px ${color}88, 0 0 40px ${color}44; transform: scale(1.2);` : ""}
        `;
        inner.textContent = loc.emoji;
      }
      el.appendChild(inner);

      // Pulse ring for busy locations (skip on 3D structures — they have their own glow)
      if (loc.people > 20 && !is3d) {
        const pulse = document.createElement("div");
        pulse.style.cssText = `
          position: absolute; inset: -4px;
          border-radius: 50%;
          border: 1px solid ${color}44;
          animation: marker-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
          pointer-events: none;
        `;
        inner.appendChild(pulse);
      }

      // People count badge (skip on 3D structures to keep the model clean)
      if (!is3d) {
        const badge = document.createElement("div");
        badge.style.cssText = `
          position: absolute; top: -6px; right: -6px;
          background: ${color};
          color: #0d1b2a;
          font-size: 9px; font-weight: 700;
          padding: 1px 5px;
          border-radius: 999px;
          font-family: 'Sora', sans-serif;
          pointer-events: none;
        `;
        badge.textContent = String(loc.people);
        inner.appendChild(badge);
      }

      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onLocationSelect(selectedLocation?.id === loc.id ? null : loc);
        map.current?.flyTo({ center: [loc.lng, loc.lat], zoom: 17, duration: 800 });
      });

      if (!is3d) {
        inner.addEventListener("mouseenter", () => {
          if (selectedLocation?.id !== loc.id) {
            inner.style.transform = "scale(1.15)";
            inner.style.boxShadow = `0 0 16px ${color}66`;
          }
        });

        inner.addEventListener("mouseleave", () => {
          if (selectedLocation?.id !== loc.id) {
            inner.style.transform = "scale(1)";
            inner.style.boxShadow = "none";
          }
        });
      }

      const marker = new mapboxgl.Marker({
        element: el,
        anchor: is3d ? (loc.structure3d === "helicopter" ? "center" : "bottom") : "center",
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
        <div className="glass-panel rounded-full px-3 py-1.5 flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
          </span>
          <span className="text-xs font-body font-medium text-foreground">208 here now</span>
        </div>
      </motion.div>

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
      {VILLAGE_LOCATIONS.map((loc, i) => {
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
              className="flex items-center justify-center w-10 h-10 rounded-full border-2"
              style={{ borderColor: color, background: `${color}22` }}
            >
              <span className="text-lg">{loc.emoji}</span>
            </motion.div>
          </motion.div>
        );
      })}
    </div>
  );
}

export { VILLAGE_LOCATIONS };
export type { MapViewProps };
