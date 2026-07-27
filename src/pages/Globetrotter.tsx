/**
 * Vibe Globetrotter — the world, inside the world.
 *
 * You get dropped somewhere real on Earth in 3D (Mapbox satellite +
 * terrain DEM + extruded buildings). You can look around, pan, zoom,
 * and fly — but there are no labels, no compass, no coordinates. When
 * you think you know where you are, you open the guess map and drop a
 * pin. Score is 5000 points at a bullseye, decaying with distance.
 *
 * The deck is the studio's own network (SF, Lisbon, Vermont, Patagonia,
 * Edge Esmeralda) mixed with world landmarks and genuinely disorienting
 * wild cards — so the map you're playing on is the same one the Vibe
 * Ventures globe has been drawing all along.
 *
 * Two maps, deliberately: `roundMap` is the 3D drop (no labels, style
 * locked to satellite-streets with symbols stripped), `guessMap` is a
 * flat labelled world you only ever see when guessing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { MAPBOX_TOKEN } from "@/config/mapbox";
import {
  dealRounds,
  haversineKm,
  scoreFor,
  ROUNDS_PER_GAME,
  MAX_SCORE,
  type Place,
} from "@/lib/globetrotterPlaces";

type Phase = "intro" | "exploring" | "guessing" | "revealed" | "summary";

interface RoundResult {
  place: Place;
  guess: { lat: number; lng: number };
  distanceKm: number;
  score: number;
}

const fmtKm = (km: number) =>
  km < 1 ? `${Math.round(km * 1000)} m` : km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString()} km`;

/** Strip every label/symbol layer so the drop can't be read off the map. */
const hideLabels = (map: mapboxgl.Map) => {
  const style = map.getStyle();
  if (!style?.layers) return;
  for (const layer of style.layers) {
    if (layer.type === "symbol") {
      try {
        map.setLayoutProperty(layer.id, "visibility", "none");
      } catch {
        /* some layers refuse; harmless */
      }
    }
  }
};

const Globetrotter = () => {
  const [phase, setPhase] = useState<Phase>("intro");
  const [rounds, setRounds] = useState<Place[]>([]);
  const [roundIdx, setRoundIdx] = useState(0);
  const [results, setResults] = useState<RoundResult[]>([]);
  const [pendingGuess, setPendingGuess] = useState<{ lat: number; lng: number } | null>(null);
  const [lastResult, setLastResult] = useState<RoundResult | null>(null);
  const [loadingShot, setLoadingShot] = useState(true);
  const [mapTrouble, setMapTrouble] = useState(false);
  const veilTimerRef = useRef<number | null>(null);

  const roundHostRef = useRef<HTMLDivElement>(null);
  const guessHostRef = useRef<HTMLDivElement>(null);
  const roundMapRef = useRef<mapboxgl.Map | null>(null);
  const guessMapRef = useRef<mapboxgl.Map | null>(null);
  const guessMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const pendingGuessRef = useRef<{ lat: number; lng: number } | null>(null);

  const place = rounds[roundIdx] ?? null;
  const totalScore = results.reduce((s, r) => s + r.score, 0);

  // ---- The 3D drop map -------------------------------------------------
  useEffect(() => {
    if (phase === "intro" || phase === "summary") return;
    const host = roundHostRef.current;
    if (!host || roundMapRef.current) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container: host,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [0, 20],
      zoom: 2,
      pitch: 0,
      bearing: 0,
      antialias: true,
      attributionControl: false,
    });
    roundMapRef.current = map;

    map.on("error", () => setMapTrouble(true));

    map.on("style.load", () => {
      setMapTrouble(false);
      hideLabels(map);
      if (!map.getSource("mapbox-dem")) {
        map.addSource("mapbox-dem", {
          type: "raster-dem",
          url: "mapbox://mapbox.mapbox-terrain-dem-v1",
          tileSize: 512,
          maxzoom: 14,
        });
      }
      map.setTerrain({ source: "mapbox-dem", exaggeration: 1.4 });
      map.setFog({
        range: [1, 12],
        color: "#dbeafe",
        "horizon-blend": 0.22,
        "high-color": "#7fb8ff",
        "space-color": "#0b1220",
        "star-intensity": 0.12,
      });
      // 3D buildings, tinted the studio's emerald so cities read as
      // "Vibe" rather than stock Mapbox.
      try {
        if (!map.getLayer("gt-buildings")) {
          map.addLayer({
            id: "gt-buildings",
            source: "composite",
            "source-layer": "building",
            filter: ["==", "extrude", "true"],
            type: "fill-extrusion",
            minzoom: 13,
            paint: {
              "fill-extrusion-color": [
                "interpolate",
                ["linear"],
                ["get", "height"],
                0, "#a7f3d8",
                60, "#34d399",
                200, "#0f766e",
              ],
              "fill-extrusion-height": ["get", "height"],
              "fill-extrusion-base": ["get", "min_height"],
              "fill-extrusion-opacity": 0.92,
              "fill-extrusion-vertical-gradient": true,
            },
          });
        }
      } catch {
        /* composite not ready on some styles — the drop still works */
      }
    });

    return () => {
      map.remove();
      roundMapRef.current = null;
    };
  }, [phase]);

  // Fly to the current round's opening shot.
  useEffect(() => {
    const map = roundMapRef.current;
    if (!map || !place || phase === "intro" || phase === "summary") return;
    setLoadingShot(true);
    const run = () => {
      map.jumpTo({ center: [place.lng, place.lat], zoom: Math.max(3, place.zoom - 4), pitch: 0, bearing: place.bearing });
      map.easeTo({
        center: [place.lng, place.lat],
        zoom: place.zoom,
        pitch: place.pitch,
        bearing: place.bearing,
        duration: 3800,
        essential: true,
      });
      window.setTimeout(() => setLoadingShot(false), 1200);
    };
    if (map.isStyleLoaded()) run();
    else map.once("idle", run);

    // Never trap the player behind the veil. If tiles are slow or the
    // network is refusing Mapbox outright, lift it anyway — the guess
    // map and scoring work regardless of whether imagery ever arrives.
    // (Same defensive pattern as MapView's mapReady timeout.)
    if (veilTimerRef.current) window.clearTimeout(veilTimerRef.current);
    veilTimerRef.current = window.setTimeout(() => setLoadingShot(false), 6500);
    return () => {
      if (veilTimerRef.current) window.clearTimeout(veilTimerRef.current);
    };
  }, [place, phase]);

  // ---- The flat guess map ---------------------------------------------
  useEffect(() => {
    if (phase !== "guessing" && phase !== "revealed") return;
    const host = guessHostRef.current;
    if (!host || guessMapRef.current) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container: host,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [0, 20],
      zoom: 0.6,
      attributionControl: false,
      // A guess map you can spin forever is a guess map you can't read.
      renderWorldCopies: true,
    });
    guessMapRef.current = map;

    map.on("click", (e) => {
      const g = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      pendingGuessRef.current = g;
      setPendingGuess(g);
      if (!guessMarkerRef.current) {
        const el = document.createElement("div");
        el.style.cssText =
          "width:16px;height:16px;border-radius:9999px;background:#34d399;box-shadow:0 0 0 3px rgba(52,211,153,.35),0 0 14px rgba(52,211,153,.9);cursor:grab";
        guessMarkerRef.current = new mapboxgl.Marker({ element: el, draggable: true })
          .setLngLat([g.lng, g.lat])
          .addTo(map);
        guessMarkerRef.current.on("dragend", () => {
          const p = guessMarkerRef.current!.getLngLat();
          const moved = { lat: p.lat, lng: p.lng };
          pendingGuessRef.current = moved;
          setPendingGuess(moved);
        });
      } else {
        guessMarkerRef.current.setLngLat([g.lng, g.lat]);
      }
    });

    return () => {
      guessMarkerRef.current?.remove();
      guessMarkerRef.current = null;
      map.remove();
      guessMapRef.current = null;
    };
  }, [phase]);

  // ---- Flow ------------------------------------------------------------
  const startGame = () => {
    setRounds(dealRounds(ROUNDS_PER_GAME));
    setRoundIdx(0);
    setResults([]);
    setLastResult(null);
    setPendingGuess(null);
    pendingGuessRef.current = null;
    setPhase("exploring");
  };

  const lockGuess = useCallback(() => {
    const guess = pendingGuessRef.current;
    if (!guess || !place) return;
    const distanceKm = haversineKm(guess, place);
    const result: RoundResult = { place, guess, distanceKm, score: scoreFor(distanceKm) };
    setResults((r) => [...r, result]);
    setLastResult(result);
    setPhase("revealed");

    // Draw the answer: truth pin + the line you were off by.
    const map = guessMapRef.current;
    if (map) {
      const truth = document.createElement("div");
      truth.style.cssText =
        "width:18px;height:18px;border-radius:9999px;background:#f472b6;box-shadow:0 0 0 3px rgba(244,114,182,.35),0 0 16px rgba(244,114,182,.9)";
      new mapboxgl.Marker({ element: truth }).setLngLat([place.lng, place.lat]).addTo(map);
      const line: GeoJSON.Feature<GeoJSON.LineString> = {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: [[guess.lng, guess.lat], [place.lng, place.lat]] },
      };
      try {
        if (map.getSource("gt-line")) {
          (map.getSource("gt-line") as mapboxgl.GeoJSONSource).setData(line);
        } else {
          map.addSource("gt-line", { type: "geojson", data: line });
          map.addLayer({
            id: "gt-line",
            type: "line",
            source: "gt-line",
            paint: {
              "line-color": "#facc15",
              "line-width": 2,
              "line-dasharray": [2, 2],
              "line-opacity": 0.9,
            },
          });
        }
        map.fitBounds(
          [
            [Math.min(guess.lng, place.lng), Math.min(guess.lat, place.lat)],
            [Math.max(guess.lng, place.lng), Math.max(guess.lat, place.lat)],
          ],
          { padding: 80, duration: 1400, maxZoom: 6 },
        );
      } catch {
        /* style still settling — the numbers still tell the story */
      }
    }
  }, [place]);

  const nextRound = () => {
    // Tear the guess map down so the next round starts clean.
    guessMarkerRef.current?.remove();
    guessMarkerRef.current = null;
    guessMapRef.current?.remove();
    guessMapRef.current = null;
    setPendingGuess(null);
    pendingGuessRef.current = null;
    setLastResult(null);
    if (roundIdx + 1 >= rounds.length) {
      setPhase("summary");
    } else {
      setRoundIdx((i) => i + 1);
      setPhase("exploring");
    }
  };

  // Keyboard: space to open the guess map, enter to lock it in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && phase === "exploring") {
        e.preventDefault();
        setPhase("guessing");
      } else if (e.code === "Enter") {
        if (phase === "guessing" && pendingGuessRef.current) lockGuess();
        else if (phase === "revealed") nextRound();
      } else if (e.code === "Escape" && phase === "guessing") {
        setPhase("exploring");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const chip =
    "font-mono text-[11px] uppercase tracking-widest rounded-full border px-3 py-1.5 transition-colors cursor-pointer";

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#05080d] text-white">
      {/* The 3D drop */}
      <div ref={roundHostRef} className="absolute inset-0" />

      {/* Opening-shot veil so you can't peek at the wide establishing frame */}
      {loadingShot && phase === "exploring" && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#05080d]/85 backdrop-blur-sm pointer-events-none">
          <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-white/60 animate-pulse">
            dropping you somewhere on earth…
          </p>
        </div>
      )}

      {/* ---- Intro ---- */}
      {phase === "intro" && (
        <div className="absolute inset-0 z-40 flex items-center justify-center p-6 bg-[#05080d]/92 backdrop-blur-md">
          <div className="max-w-lg text-center space-y-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.35em] text-emerald-300/80">
              a vibeverse world
            </p>
            <h1 className="font-mono text-3xl md:text-4xl uppercase tracking-[0.2em]">Globetrotter</h1>
            <p className="font-sans text-sm leading-relaxed text-white/70">
              You'll be dropped somewhere real on Earth, in 3D. No labels, no compass, no coordinates —
              just the ground, the buildings, and the terrain. Look around, then drop a pin on the world
              map where you think you are.
            </p>
            <p className="font-sans text-sm leading-relaxed text-white/50">
              Five rounds. 5,000 points for a bullseye, less the further you are. The deck is stacked with
              the Vibe network's own cities — Edge Esmeralda, San Francisco, Lisbon, Vermont, Patagonia —
              mixed with landmarks and places designed to lose you completely.
            </p>
            <button
              onClick={startGame}
              className="mt-2 rounded-full border border-emerald-400/60 bg-emerald-400/10 px-6 py-2.5 font-mono text-[12px] uppercase tracking-[0.25em] text-emerald-200 hover:bg-emerald-400/20 transition-colors cursor-pointer"
            >
              drop me somewhere →
            </button>
            <div className="pt-2">
              <Link
                to="/"
                className="font-mono text-[10px] uppercase tracking-widest text-white/35 hover:text-white/70 transition-colors"
              >
                ← back to the vibeverse
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* ---- HUD while exploring ---- */}
      {(phase === "exploring" || phase === "guessing" || phase === "revealed") && (
        <div className="absolute top-0 left-0 right-0 z-30 p-4 md:p-5 flex items-start justify-between pointer-events-none">
          <div className="rounded-xl border border-white/12 bg-black/55 backdrop-blur-xl px-4 py-2.5">
            <p className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/45">Globetrotter</p>
            <p className="font-mono text-sm mt-0.5">
              Round {roundIdx + 1}
              <span className="text-white/35">/{rounds.length}</span>
              <span className="text-white/25 mx-2">·</span>
              <span className="text-emerald-300">{totalScore.toLocaleString()}</span>
              <span className="text-white/35 text-[11px]"> pts</span>
            </p>
          </div>
          <div className="flex items-center gap-2 pointer-events-auto">
            {phase === "exploring" && (
              <button
                onClick={() => setPhase("guessing")}
                className={`${chip} border-emerald-400/60 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20`}
              >
                ✦ make a guess
              </button>
            )}
            <Link to="/" className={`${chip} border-white/15 text-white/45 hover:text-white`}>
              ← exit
            </Link>
          </div>
        </div>
      )}

      {phase === "exploring" && !loadingShot && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
          <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/45 bg-black/45 backdrop-blur rounded-full px-4 py-2">
            drag to look · scroll to zoom · ctrl+drag to tilt · space to guess
          </p>
        </div>
      )}

      {/* Imagery couldn't load — say so instead of showing a black void */}
      {mapTrouble && phase === "exploring" && !loadingShot && (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-6 pointer-events-none">
          <div className="max-w-sm text-center rounded-xl border border-amber-400/30 bg-black/70 backdrop-blur-xl px-5 py-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-amber-300/90">no satellite signal</p>
            <p className="font-sans text-[12px] text-white/60 mt-2 leading-relaxed">
              Map imagery couldn't load from here — check the connection. You can still guess, but you'd
              be guessing blind.
            </p>
          </div>
        </div>
      )}

      {/* ---- Guess map ---- */}
      <div
        className={`absolute z-30 transition-all duration-300 ${
          phase === "guessing" || phase === "revealed"
            ? "inset-3 md:inset-8 opacity-100"
            : "inset-x-3 bottom-3 h-0 opacity-0 pointer-events-none"
        }`}
      >
        <div className="relative w-full h-full rounded-2xl overflow-hidden border border-white/15 bg-[#05080d] shadow-2xl">
          <div ref={guessHostRef} className="absolute inset-0" />

          {phase === "guessing" && (
            <>
              <div className="absolute top-3 left-1/2 -translate-x-1/2 pointer-events-none">
                <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/70 bg-black/60 backdrop-blur rounded-full px-4 py-2">
                  {pendingGuess ? "drag the pin to fine-tune · enter to lock it in" : "click the map — where are you?"}
                </p>
              </div>
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2">
                <button
                  onClick={() => setPhase("exploring")}
                  className={`${chip} border-white/20 bg-black/60 text-white/70 hover:text-white`}
                >
                  ← keep looking
                </button>
                <button
                  onClick={lockGuess}
                  disabled={!pendingGuess}
                  className={`${chip} ${
                    pendingGuess
                      ? "border-emerald-400/70 bg-emerald-400/15 text-emerald-100 hover:bg-emerald-400/25"
                      : "border-white/10 bg-black/50 text-white/25 cursor-not-allowed"
                  }`}
                >
                  lock in guess ✦
                </button>
              </div>
            </>
          )}

          {phase === "revealed" && lastResult && (
            <div className="absolute inset-x-3 bottom-3 md:inset-x-auto md:right-4 md:bottom-4 md:w-96 rounded-xl border border-white/15 bg-black/80 backdrop-blur-xl p-5">
              <p className="font-mono text-[9px] uppercase tracking-[0.3em] text-emerald-300/80">
                {lastResult.place.tier === "hub" ? "◉ a studio hub" : lastResult.place.tier === "landmark" ? "★ landmark" : "✦ wild card"}
              </p>
              <h2 className="font-mono text-base uppercase tracking-[0.12em] mt-1.5">{lastResult.place.name}</h2>
              <p className="font-mono text-[11px] text-white/45 mt-0.5">{lastResult.place.country}</p>
              <p className="font-sans text-[12px] leading-relaxed text-white/65 mt-3">{lastResult.place.blurb}</p>
              <div className="flex items-end justify-between mt-4 pt-3 border-t border-white/10">
                <div>
                  <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-white/40">you were off by</p>
                  <p className="font-mono text-lg text-white">{fmtKm(lastResult.distanceKm)}</p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-white/40">points</p>
                  <p className="font-mono text-2xl text-emerald-300">+{lastResult.score.toLocaleString()}</p>
                </div>
              </div>
              <button
                onClick={nextRound}
                className="w-full mt-4 rounded-full border border-emerald-400/60 bg-emerald-400/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.25em] text-emerald-200 hover:bg-emerald-400/20 transition-colors cursor-pointer"
              >
                {roundIdx + 1 >= rounds.length ? "see the final score →" : "next drop →"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ---- Summary ---- */}
      {phase === "summary" && (
        <div className="absolute inset-0 z-40 flex items-center justify-center p-6 bg-[#05080d]/93 backdrop-blur-md overflow-y-auto">
          <div className="w-full max-w-lg space-y-5 py-8">
            <div className="text-center">
              <p className="font-mono text-[10px] uppercase tracking-[0.35em] text-emerald-300/80">final score</p>
              <p className="font-mono text-5xl mt-2">{totalScore.toLocaleString()}</p>
              <p className="font-mono text-[11px] text-white/40 mt-1">out of {MAX_SCORE.toLocaleString()}</p>
              <p className="font-sans text-sm text-white/60 mt-3">
                {totalScore > 20000
                  ? "You have been places. Genuinely impressive."
                  : totalScore > 12000
                  ? "Solid globetrotting — you know a skyline when you see one."
                  : totalScore > 6000
                  ? "The Earth is big and you found some of it."
                  : "Lost, but beautifully lost."}
              </p>
            </div>
            <div className="space-y-1.5">
              {results.map((r, i) => (
                <div
                  key={r.place.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-2.5"
                >
                  <span className="font-mono text-[10px] text-white/30 w-4 shrink-0">{i + 1}</span>
                  <span className="font-mono text-[11px] uppercase tracking-wider truncate flex-1">
                    {r.place.tier === "hub" && <span className="text-emerald-300/80">◉ </span>}
                    {r.place.name}
                  </span>
                  <span className="font-mono text-[10px] text-white/40 shrink-0">{fmtKm(r.distanceKm)}</span>
                  <span className="font-mono text-[11px] text-emerald-300 shrink-0 w-14 text-right">
                    {r.score.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-center gap-2 pt-1">
              <button
                onClick={startGame}
                className="rounded-full border border-emerald-400/60 bg-emerald-400/10 px-5 py-2 font-mono text-[11px] uppercase tracking-[0.25em] text-emerald-200 hover:bg-emerald-400/20 transition-colors cursor-pointer"
              >
                play again →
              </button>
              <Link
                to="/"
                className="rounded-full border border-white/15 px-5 py-2 font-mono text-[11px] uppercase tracking-[0.25em] text-white/50 hover:text-white transition-colors"
              >
                ← the vibeverse
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Globetrotter;
