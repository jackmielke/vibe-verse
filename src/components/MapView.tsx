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

      if (is3d) {
        // Invisible click target sized to cover the 3D structure.
        const hitWidth = hitSize;
        const hitHeight = Math.round(hitSize * 1.6);
        el.style.cssText = `
          width: ${hitWidth}px; height: ${hitHeight}px;
          position: relative;
          cursor: pointer;
          pointer-events: auto;
        `;
        const inner = document.createElement("div");
        inner.style.cssText = `
          width: 100%; height: 100%;
          border-radius: 40% 40% 50% 50%;
          background: transparent;
          ${isSelected ? `box-shadow: inset 0 -20px 40px ${color}55, 0 0 30px ${color}66;` : ""}
          transition: box-shadow 0.2s ease;
        `;
        el.appendChild(inner);
      } else {
        // ── Beacon-style waypoint ──
        // A thin vertical light pillar rising from the ground with a
        // typographic label tag. Reads as a game HUD waypoint, not a pin.
        el.style.cssText = `
          position: relative;
          width: 140px; height: 64px;
          cursor: pointer;
          pointer-events: auto;
          font-family: 'Sora', sans-serif;
          transition: transform 0.2s ease;
          ${isSelected ? "transform: translateY(-2px) scale(1.05);" : ""}
        `;

        // Vertical beam
        const beam = document.createElement("div");
        beam.style.cssText = `
          position: absolute;
          left: 50%; bottom: 4px;
          transform: translateX(-50%);
          width: 2px; height: 28px;
          background: linear-gradient(to top, ${color}, ${color}00);
          box-shadow: 0 0 8px ${color}aa, 0 0 18px ${color}55;
          pointer-events: none;
        `;
        el.appendChild(beam);

        // Ground dot
        const dot = document.createElement("div");
        dot.style.cssText = `
          position: absolute;
          left: 50%; bottom: 0;
          transform: translateX(-50%);
          width: 8px; height: 8px;
          border-radius: 50%;
          background: ${color};
          box-shadow: 0 0 12px ${color};
          pointer-events: none;
        `;
        el.appendChild(dot);

        // Pulse ring on ground for busy locations
        if (loc.people > 20) {
          const pulse = document.createElement("div");
          pulse.style.cssText = `
            position: absolute;
            left: 50%; bottom: -3px;
            transform: translateX(-50%);
            width: 14px; height: 14px;
            border-radius: 50%;
            border: 1px solid ${color}88;
            animation: marker-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
            pointer-events: none;
          `;
          el.appendChild(pulse);
        }

        // Label tag at top of beam
        const tag = document.createElement("div");
        tag.style.cssText = `
          position: absolute;
          left: 50%; bottom: 30px;
          transform: translateX(-50%);
          display: flex; align-items: center; gap: 6px;
          padding: 4px 9px 4px 7px;
          border-radius: 999px;
          background: rgba(13, 27, 42, 0.78);
          border: 1px solid ${color}66;
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
          white-space: nowrap;
          transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
          ${isSelected ? `border-color: ${color}; box-shadow: 0 0 14px ${color}66;` : ""}
        `;

        const tick = document.createElement("span");
        tick.style.cssText = `
          width: 5px; height: 5px; border-radius: 50%;
          background: ${color};
          box-shadow: 0 0 6px ${color};
        `;
        tag.appendChild(tick);

        const name = document.createElement("span");
        name.textContent = loc.name;
        name.style.cssText = `
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.04em;
          color: #f0fdf9;
          text-transform: uppercase;
        `;
        tag.appendChild(name);

        const count = document.createElement("span");
        count.textContent = String(loc.people);
        count.style.cssText = `
          font-size: 9px;
          font-weight: 700;
          color: ${color};
          padding-left: 6px;
          margin-left: 2px;
          border-left: 1px solid ${color}44;
        `;
        tag.appendChild(count);

        el.appendChild(tag);

        el.addEventListener("mouseenter", () => {
          if (selectedLocation?.id !== loc.id) {
            el.style.transform = "translateY(-2px)";
            tag.style.borderColor = color;
            tag.style.boxShadow = `0 0 14px ${color}55`;
          }
        });
        el.addEventListener("mouseleave", () => {
          if (selectedLocation?.id !== loc.id) {
            el.style.transform = "";
            tag.style.borderColor = `${color}66`;
            tag.style.boxShadow = "";
          }
        });
      }

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

      {/* Helicopter control panel */}
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
