/**
 * VIBE GO — walk the real world, catch the VibeVerse.
 *
 * A Pokémon-GO-style mode that runs as part of the installed PWA:
 *   - Your real GPS position on a tilted Mapbox map (GO camera).
 *   - Wild VibeVerse characters (the same 58-strong catalog the worlds
 *     use) spawn around you. Spawns are DETERMINISTIC per geo-cell per
 *     30-minute window, so everyone standing on the same street corner
 *     sees the same wild Ninja — shared reality with zero servers.
 *   - Walk within range, tap, and play the timing ring to catch. Your
 *     collection lives in localStorage and catches pay ✦ into the same
 *     vibecoin balance the island uses.
 *   - No GPS (or on desktop)? Tap the map to stroll there. No Mapbox
 *     (offline)? A vibe-grid fallback keeps the game playable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import * as THREE from "three";
import { releaseRenderer } from "@/lib/quality";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { toast } from "sonner";
import { IOS_APP } from "@/lib/iosApp";
import { CHARACTERS, type CharSpec } from "@/lib/characters";
import { MAPBOX_TOKEN, VILLAGE_CENTER } from "@/config/mapbox";
import { useActiveCharacter } from "@/hooks/use-active-character";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------
const CATCH_RANGE_M = 45; // how close you must walk to attempt a catch
const SPAWN_EPOCH_MS = 30 * 60 * 1000; // spawn set refreshes every 30 min
const CELL_DEG = 1 / 300; // ~370m geo cells
const SPAWNS_PER_CELL = 4;
const WALK_SPEED_MPS = 2.2; // tap-to-walk stroll speed (no-GPS mode)

type Rarity = "common" | "uncommon" | "epic" | "legendary";
const RARITY_META: Record<Rarity, { label: string; color: string; baseCatch: number; coins: number }> = {
  common: { label: "Common", color: "#9ad0ff", baseCatch: 0.8, coins: 2 },
  uncommon: { label: "Uncommon", color: "#7bf1a8", baseCatch: 0.6, coins: 4 },
  epic: { label: "Epic", color: "#c9a2ff", baseCatch: 0.4, coins: 8 },
  legendary: { label: "LEGENDARY", color: "#ffd166", baseCatch: 0.25, coins: 20 },
};

function rarityOf(id: string): Rarity {
  if (id === "vibey" || id === "alien") return "legendary";
  if (/^(Ninja|Knight_Golden|Wizard|Witch|Pirate_Captain)/.test(id)) return "epic";
  if (/^(Pirate|Viking|Zombie|Goblin|Elf|Cowboy|Chef|Doctor|Soldier)/.test(id)) return "uncommon";
  return "common";
}

// Deterministic RNG — identical spawns for everyone in the same cell+epoch.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Wild {
  key: string;
  char: CharSpec;
  rarity: Rarity;
  lat: number;
  lng: number;
  misses: number;
  fled: boolean;
}

function spawnsForCell(cx: number, cy: number, epoch: number): Wild[] {
  const rand = mulberry32(((cx * 73856093) ^ (cy * 19349663) ^ (epoch * 83492791)) >>> 0);
  const wilds: Wild[] = [];
  for (let i = 0; i < SPAWNS_PER_CELL; i++) {
    const roll = rand();
    const tier: Rarity = roll < 0.02 ? "legendary" : roll < 0.1 ? "epic" : roll < 0.35 ? "uncommon" : "common";
    const pool = CHARACTERS.filter((c) => rarityOf(c.id) === tier);
    const char = pool[Math.floor(rand() * pool.length)] ?? CHARACTERS[0];
    wilds.push({
      key: `${cx}_${cy}_${epoch}_${i}`,
      char,
      rarity: rarityOf(char.id),
      lat: (cy + rand()) * CELL_DEG,
      lng: (cx + rand()) * CELL_DEG,
      misses: 0,
      fled: false,
    });
  }
  return wilds;
}

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const kx = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)) * 111320;
  const ky = 110574;
  return Math.hypot((a.lng - b.lng) * kx, (a.lat - b.lat) * ky);
}

// ---------------------------------------------------------------------------

export default function VibeGo() {
  const { character: myChar } = useActiveCharacter();
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<Map<string, mapboxgl.Marker>>(new Map());
  const playerMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const walkTargetRef = useRef<{ lat: number; lng: number } | null>(null);
  const posRef = useRef<{ lat: number; lng: number } | null>(null);

  const [started, setStarted] = useState(false);
  const [mapReady, setMapReady] = useState<null | boolean>(null); // null = loading
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsState, setGpsState] = useState<"off" | "on" | "denied">("off");
  const [epoch, setEpoch] = useState(() => Math.floor(Date.now() / SPAWN_EPOCH_MS));
  const [fledKeys, setFledKeys] = useState<Set<string>>(new Set());
  const [caughtKeys, setCaughtKeys] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<Wild | null>(null);
  const [charge, setCharge] = useState<number | null>(null); // 0..100 while holding
  const [throwing, setThrowing] = useState<"none" | "caught" | "escaped" | "fled">("none");
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [collection, setCollection] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem("vibego.collection") ?? "{}"); } catch { return {}; }
  });
  // Personal escort: 3 wilds guaranteed within walking distance, rolled
  // fresh each epoch from wherever you're standing.
  const [personalWilds, setPersonalWilds] = useState<Wild[]>([]);
  // Your real 3D avatar, rendered once to an image for the map marker.
  const [avatarImg, setAvatarImg] = useState<string | null>(null);
  // AR: live camera behind the catch screen.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [arOn, setArOn] = useState(false);

  posRef.current = pos;

  // Roll the personal escort when position first locks / epoch turns.
  useEffect(() => {
    if (!pos) return;
    const rand = mulberry32((epoch * 7919 + 13) >>> 0);
    const kx = Math.cos(pos.lat * (Math.PI / 180)) * 111320;
    const out: Wild[] = [];
    for (let i = 0; i < 3; i++) {
      const roll = rand();
      const tier: Rarity = roll < 0.03 ? "legendary" : roll < 0.15 ? "epic" : roll < 0.45 ? "uncommon" : "common";
      const pool = CHARACTERS.filter((c) => rarityOf(c.id) === tier);
      const char = pool[Math.floor(rand() * pool.length)] ?? CHARACTERS[0];
      const bearing = rand() * Math.PI * 2;
      const dist = 30 + rand() * 60; // 30–90m: always a short stroll
      out.push({
        key: `near_${epoch}_${i}`,
        char,
        rarity: rarityOf(char.id),
        lat: pos.lat + (Math.cos(bearing) * dist) / 110574,
        lng: pos.lng + (Math.sin(bearing) * dist) / kx,
        misses: 0,
        fled: false,
      });
    }
    setPersonalWilds(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch, pos === null]);

  // Render the chosen character's GLB to a little transparent portrait
  // so the player marker is YOUR avatar, not an emoji.
  useEffect(() => {
    let disposed = false;
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 160;
    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      renderer.setClearColor(0x000000, 0);
      const scene = new THREE.Scene();
      const cam = new THREE.PerspectiveCamera(30, 128 / 160, 0.1, 60);
      scene.add(new THREE.AmbientLight(0xffffff, 1.5));
      const dir = new THREE.DirectionalLight(0xffffff, 1.8);
      dir.position.set(2, 4, 3);
      scene.add(dir);
      new GLTFLoader().load(
        myChar.url,
        (gltf) => {
          if (disposed || !renderer) return;
          const m = gltf.scene;
          const box = new THREE.Box3().setFromObject(m);
          const size = new THREE.Vector3();
          box.getSize(size);
          const c = new THREE.Vector3();
          box.getCenter(c);
          m.position.sub(c);
          m.rotation.y = 0.35;
          scene.add(m);
          const h = Math.max(size.y, 0.3);
          cam.position.set(0, h * 0.06, h * 2.2);
          cam.lookAt(0, 0, 0);
          renderer.render(scene, cam);
          setAvatarImg(canvas.toDataURL("image/png"));
          /* releaseRenderer, not dispose: three r160's dispose() drops its own caches and
             leaves the GL context to the garbage collector. See docs/performance.md. */
          releaseRenderer(renderer);
        },
        undefined,
        () => { /* keep the emoji fallback */ },
      );
    } catch { /* emoji fallback */ }
    return () => {
      disposed = true;
      renderer?.dispose();
    };
  }, [myChar.url]);

  // AR camera behind the catch screen: acquire on open, release on close.
  useEffect(() => {
    if (!target) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setArOn(false);
      return;
    }
    let cancelled = false;
    navigator.mediaDevices
      ?.getUserMedia?.({ video: { facingMode: "environment" } })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = s;
        setArOn(true);
      })
      .catch(() => setArOn(false));
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target === null]);
  useEffect(() => {
    if (arOn && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      void videoRef.current.play().catch(() => { /* autoplay policies */ });
    }
  }, [arOn]);

  // ---- Wild set: shared cell spawns + your personal escort ----------------
  const wilds = useMemo(() => {
    if (!pos) return [] as Wild[];
    const cx = Math.floor(pos.lng / CELL_DEG);
    const cy = Math.floor(pos.lat / CELL_DEG);
    const out: Wild[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        out.push(...spawnsForCell(cx + dx, cy + dy, epoch));
      }
    }
    out.push(...personalWilds);
    return out.filter((w) => !fledKeys.has(w.key) && !caughtKeys.has(w.key));
  }, [pos ? Math.floor(pos.lng / CELL_DEG) : 0, pos ? Math.floor(pos.lat / CELL_DEG) : 0, epoch, fledKeys, caughtKeys, pos === null, personalWilds]);

  // Epoch ticker: new spawn set every 30 minutes.
  useEffect(() => {
    const t = window.setInterval(() => {
      const e = Math.floor(Date.now() / SPAWN_EPOCH_MS);
      setEpoch((prev) => (prev === e ? prev : e));
    }, 20_000);
    return () => window.clearInterval(t);
  }, []);

  // ---- Start: geolocation (fall back to the village + tap-to-walk) --------
  const begin = useCallback(() => {
    setStarted(true);
    if (!("geolocation" in navigator)) {
      setGpsState("denied");
      setPos({ lat: VILLAGE_CENTER.lat, lng: VILLAGE_CENTER.lng });
      return;
    }
    navigator.geolocation.watchPosition(
      (p) => {
        setGpsState("on");
        walkTargetRef.current = null;
        setPos({ lat: p.coords.latitude, lng: p.coords.longitude });
      },
      () => {
        setGpsState((s) => (s === "on" ? s : "denied"));
        setPos((prev) => prev ?? { lat: VILLAGE_CENTER.lat, lng: VILLAGE_CENTER.lng });
        toast("No GPS — stroll mode", {
          description: "Tap anywhere on the map and you'll walk there.",
        });
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 },
    );
  }, []);

  // Tap-to-walk simulation (desktop / GPS-denied). Steps are computed
  // from real elapsed time so throttled timers (backgrounded tabs,
  // low-power mode) don't slow the stroll.
  useEffect(() => {
    if (!started) return;
    let last = performance.now();
    const t = window.setInterval(() => {
      const nowMs = performance.now();
      const dtSec = Math.min(2.5, (nowMs - last) / 1000);
      last = nowMs;
      const tgt = walkTargetRef.current;
      const cur = posRef.current;
      if (!tgt || !cur) return;
      const d = metersBetween(cur, tgt);
      if (d < 2) { walkTargetRef.current = null; return; }
      const step = Math.min(1, (WALK_SPEED_MPS * dtSec) / d);
      setPos({ lat: cur.lat + (tgt.lat - cur.lat) * step, lng: cur.lng + (tgt.lng - cur.lng) * step });
    }, 250);
    return () => window.clearInterval(t);
  }, [started]);

  // ---- Mapbox map ----------------------------------------------------------
  useEffect(() => {
    if (!started || !pos || mapRef.current || !mapContainer.current) return;
    try {
      mapboxgl.accessToken = MAPBOX_TOKEN;
      const map = new mapboxgl.Map({
        container: mapContainer.current,
        style: "mapbox://styles/mapbox/outdoors-v12",
        center: [pos.lng, pos.lat],
        zoom: 17.2,
        pitch: 58,
        bearing: 0,
        attributionControl: false,
        antialias: false,
      });
      map.addControl(new mapboxgl.AttributionControl({ compact: true }));
      map.on("load", () => setMapReady(true));
      map.on("error", () => setMapReady((r) => (r === true ? r : false)));
      map.on("click", (e) => {
        // Stroll mode: tap the map, walk there.
        if (gpsState !== "on") {
          walkTargetRef.current = { lat: e.lngLat.lat, lng: e.lngLat.lng };
        }
      });
      window.setTimeout(() => setMapReady((r) => (r === null ? false : r)), 12000);
      mapRef.current = map;
    } catch {
      setMapReady(false);
    }
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, pos === null]);

  // Camera follows the player, GO style.
  useEffect(() => {
    if (!pos || !mapRef.current || mapReady !== true) return;
    mapRef.current.easeTo({ center: [pos.lng, pos.lat], duration: 400 });
    // Player marker.
    if (!playerMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "vibego-player";
      el.innerHTML = avatarImg
        ? `
        <div class="vibego-range"></div>
        <img class="vibego-me-img" src="${avatarImg}" alt="" />
      `
        : `
        <div class="vibego-range"></div>
        <div class="vibego-me" style="box-shadow:0 0 0 3px ${myChar.accent}cc, 0 4px 14px rgba(0,0,0,.5)">${myChar.emoji}</div>
      `;
      playerMarkerRef.current = new mapboxgl.Marker({ element: el }).setLngLat([pos.lng, pos.lat]).addTo(mapRef.current);
    } else {
      playerMarkerRef.current.setLngLat([pos.lng, pos.lat]);
    }
  }, [pos, mapReady, myChar, avatarImg]);

  // Swap the marker for the real avatar portrait once it's rendered.
  useEffect(() => {
    playerMarkerRef.current?.remove();
    playerMarkerRef.current = null;
  }, [avatarImg]);

  // Wild markers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapReady !== true) return;
    const live = new Set(wilds.map((w) => w.key));
    // Remove stale markers.
    for (const [key, m] of markersRef.current) {
      if (!live.has(key)) { m.remove(); markersRef.current.delete(key); }
    }
    for (const w of wilds) {
      if (markersRef.current.has(w.key)) continue;
      const meta = RARITY_META[w.rarity];
      const el = document.createElement("div");
      el.className = "vibego-wild";
      el.innerHTML = `
        <div class="vibego-wild-chip" style="border-color:${meta.color}">
          <span class="vibego-wild-emoji">${w.char.emoji}</span>
        </div>
        <div class="vibego-wild-shadow"></div>
      `;
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const cur = posRef.current;
        if (!cur) return;
        const d = metersBetween(cur, w);
        if (d > CATCH_RANGE_M) {
          toast(`${w.char.emoji} ${w.char.label} is ${Math.round(d)}m away`, {
            description: `Walk within ${CATCH_RANGE_M}m to catch it.`,
          });
          return;
        }
        setThrowing("none");
        setCharge(null);
        setTarget({ ...w });
      });
      markersRef.current.set(w.key, new mapboxgl.Marker({ element: el }).setLngLat([w.lng, w.lat]).addTo(map));
    }
  }, [wilds, mapReady]);

  // ---- Catch mechanics ------------------------------------------------------
  const chargeTimer = useRef<number | null>(null);
  const startCharge = () => {
    if (charge !== null || throwing !== "none") return;
    let v = 0;
    let dir = 1;
    setCharge(0);
    chargeTimer.current = window.setInterval(() => {
      v += dir * 4;
      if (v >= 100) { v = 100; dir = -1; }
      if (v <= 0) { v = 0; dir = 1; }
      setCharge(v);
    }, 30);
  };
  const releaseThrow = () => {
    if (charge === null || !target) return;
    if (chargeTimer.current) window.clearInterval(chargeTimer.current);
    chargeTimer.current = null;
    const accuracy = 1 - Math.abs(charge - 75) / 75; // sweet spot at 75
    const chance = RARITY_META[target.rarity].baseCatch * (0.45 + 0.55 * accuracy);
    setCharge(null);
    if (Math.random() < chance) {
      setThrowing("caught");
      const id = target.char.id;
      const next = { ...collection, [id]: (collection[id] ?? 0) + 1 };
      setCollection(next);
      try { localStorage.setItem("vibego.collection", JSON.stringify(next)); } catch { /* ignore */ }
      setCaughtKeys((s) => new Set(s).add(target.key));
      const isNew = !collection[id];
      const coins = RARITY_META[target.rarity].coins + (isNew ? 15 : 0);
      try {
        const bal = Number(localStorage.getItem("city.vibecoinBalance") ?? "0");
        localStorage.setItem("city.vibecoinBalance", String(Math.max(0, bal) + coins));
      } catch { /* ignore */ }
      toast.success(`${target.char.emoji} Caught ${target.char.label}!${IOS_APP ? "" : ` +${coins} ✦`}`, {
        description: isNew ? "NEW species for your Vibedex!" : undefined,
      });
    } else {
      const misses = (target.misses ?? 0) + 1;
      if (misses >= 3) {
        setThrowing("fled");
        setFledKeys((s) => new Set(s).add(target.key));
        window.setTimeout(() => setTarget(null), 1400);
      } else {
        setTarget({ ...target, misses });
        setThrowing("escaped");
        window.setTimeout(() => setThrowing("none"), 900);
      }
    }
  };

  const speciesCaught = Object.keys(collection).length;
  const totalCaught = Object.values(collection).reduce((a, b) => a + b, 0);
  const nearbySorted = useMemo(() => {
    if (!pos) return [] as Array<Wild & { d: number }>;
    return wilds
      .map((w) => ({ ...w, d: metersBetween(pos, w) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
  }, [wilds, pos]);

  // ---------------------------------------------------------------------------
  return (
    <div className="fixed inset-0 bg-[#0a1426] text-white overflow-hidden">
      <style>{`
        .vibego-player { position: relative; pointer-events: none; }
        .vibego-range { position:absolute; left:50%; top:50%; width:110px; height:110px; transform:translate(-50%,-50%);
          border-radius:9999px; background:rgba(122,215,255,.12); border:2px solid rgba(122,215,255,.45); animation: vibego-pulse 2.4s ease-in-out infinite; }
        .vibego-me { position:relative; width:44px; height:44px; border-radius:9999px; background:#101826; display:flex; align-items:center; justify-content:center; font-size:24px; }
        .vibego-me-img { position:relative; width:56px; height:70px; object-fit:contain; filter: drop-shadow(0 5px 9px rgba(0,0,0,.55)); }
        .vibego-wild { cursor:pointer; }
        .vibego-wild-chip { width:46px; height:46px; border-radius:9999px; background:rgba(10,16,30,.85); border:2.5px solid; display:flex; align-items:center; justify-content:center; animation: vibego-bob 2s ease-in-out infinite; }
        .vibego-wild-emoji { font-size:26px; }
        .vibego-wild-shadow { width:22px; height:7px; margin:2px auto 0; border-radius:9999px; background:rgba(0,0,0,.35); }
        @keyframes vibego-bob { 0%,100%{ transform:translateY(0);} 50%{ transform:translateY(-7px);} }
        @keyframes vibego-pulse { 0%,100%{ opacity:.6; transform:translate(-50%,-50%) scale(1);} 50%{ opacity:.25; transform:translate(-50%,-50%) scale(1.15);} }
        .mapboxgl-ctrl-logo { opacity:.4; }
      `}</style>

      {/* Map (or fallback vibe-grid). */}
      <div ref={mapContainer} className="absolute inset-0" />
      {started && mapReady === false && (
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(140% 100% at 50% 0%, #14351f 0%, #0d2417 55%, #081a10 100%)",
            backgroundSize: "cover",
          }}
        >
          <div
            className="absolute inset-0 opacity-25"
            style={{
              backgroundImage:
                "linear-gradient(rgba(122,215,255,.35) 1px, transparent 1px), linear-gradient(90deg, rgba(122,215,255,.35) 1px, transparent 1px)",
              backgroundSize: "56px 56px",
            }}
          />
          <div className="absolute top-20 left-1/2 -translate-x-1/2 text-xs text-white/60 glass-panel rounded-full px-4 py-2">
            map offline — vibe grid engaged (catching still works)
          </div>
          {/* Grid-mode renderer: player + wilds as DOM chips with a
              simple local meters→pixels projection; tap the grid to
              stroll there. */}
          {pos && (
            <div
              className="absolute inset-0"
              onClick={(e) => {
                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                const PXM = 1.15; // pixels per meter
                const kx = Math.cos(pos.lat * (Math.PI / 180)) * 111320;
                const dxm = (e.clientX - rect.left - rect.width / 2) / PXM;
                const dym = (e.clientY - rect.top - rect.height / 2) / PXM;
                walkTargetRef.current = {
                  lat: pos.lat - dym / 110574,
                  lng: pos.lng + dxm / kx,
                };
              }}
            >
              {wilds.map((w) => {
                const PXM = 1.15;
                const kx = Math.cos(pos.lat * (Math.PI / 180)) * 111320;
                const px = (w.lng - pos.lng) * kx * PXM;
                const py = -(w.lat - pos.lat) * 110574 * PXM;
                if (Math.abs(px) > 900 || Math.abs(py) > 900) return null;
                const meta = RARITY_META[w.rarity];
                return (
                  <div
                    key={w.key}
                    className="vibego-wild absolute"
                    style={{ left: `calc(50% + ${px}px)`, top: `calc(50% + ${py}px)`, transform: "translate(-50%,-50%)" }}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      const d = metersBetween(pos, w);
                      if (d > CATCH_RANGE_M) {
                        toast(`${w.char.emoji} ${w.char.label} is ${Math.round(d)}m away`, {
                          description: `Walk within ${CATCH_RANGE_M}m to catch it.`,
                        });
                        return;
                      }
                      setThrowing("none");
                      setCharge(null);
                      setTarget({ ...w });
                    }}
                  >
                    <div className="vibego-wild-chip" style={{ borderColor: meta.color }}>
                      <span className="vibego-wild-emoji">{w.char.emoji}</span>
                    </div>
                    <div className="vibego-wild-shadow" />
                  </div>
                );
              })}
              <div className="vibego-player absolute left-1/2 top-1/2" style={{ transform: "translate(-50%,-50%)" }}>
                <div className="vibego-range" />
                {avatarImg ? (
                  <img className="vibego-me-img" src={avatarImg} alt="" />
                ) : (
                  <div className="vibego-me" style={{ boxShadow: `0 0 0 3px ${myChar.accent}cc, 0 4px 14px rgba(0,0,0,.5)` }}>
                    {myChar.emoji}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Start screen. */}
      {!started && (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-6"
             style={{ background: "radial-gradient(120% 120% at 50% 0%, #103522 0%, #0a2416 55%, #071a0f 100%)" }}>
          <div className="max-w-sm text-center space-y-5">
            <div className="text-6xl">🧭</div>
            <h1 className="font-heading text-4xl font-bold tracking-[0.12em]">VIBE GO</h1>
            <p className="text-sm text-white/75 leading-relaxed">
              Walk the real world — wild VibeVerse characters are hiding on
              your streets. Get close, tap, and time your throw to catch
              them. Everyone nearby sees the same wilds.
            </p>
            <button
              onClick={begin}
              className="w-full h-13 py-3.5 rounded-2xl bg-emerald-400 text-emerald-950 font-bold text-lg hover:bg-emerald-300 transition-colors"
            >
              Start exploring
            </button>
            <p className="text-[11px] text-white/45">
              uses your location while the app is open · no GPS? you can
              tap-to-stroll instead
            </p>
            <Link to="/" className="block text-xs text-white/50 hover:text-white">← back to the VibeVerse</Link>
          </div>
        </div>
      )}

      {started && (
        <>
          {/* Top bar: back + status + vibedex progress. */}
          <div className="absolute top-3 left-3 right-3 z-10 flex items-center justify-between pointer-events-none">
            <Link
              to="/"
              className="pointer-events-auto glass-panel rounded-full px-3.5 py-2 text-xs text-white/85 hover:text-white"
            >
              ← VibeVerse
            </Link>
            <div className="glass-panel rounded-full px-3.5 py-2 text-[11px] text-white/70">
              {gpsState === "on" ? "📡 GPS live" : "🚶 stroll mode — tap the map"}
            </div>
          </div>

          {/* Nearby tracker (bottom-left, GO style). */}
          <div className="absolute bottom-24 left-3 z-10 space-y-1.5">
            {nearbySorted.map((w) => (
              <div key={w.key} className="glass-panel rounded-full pl-2 pr-3 py-1.5 flex items-center gap-2 text-xs">
                <span
                  className="w-7 h-7 rounded-full flex items-center justify-center text-base"
                  style={{ boxShadow: `0 0 0 2px ${RARITY_META[w.rarity].color}aa` }}
                >
                  {w.char.emoji}
                </span>
                <span className="text-white/85">{Math.round(w.d)}m</span>
              </div>
            ))}
          </div>

          {/* Vibedex button (bottom-center, the "pokéball"). */}
          <button
            onClick={() => setCollectionOpen(true)}
            className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 w-16 h-16 rounded-full bg-emerald-400 text-emerald-950 shadow-[0_6px_24px_rgba(52,211,153,0.5)] flex flex-col items-center justify-center font-bold hover:bg-emerald-300 transition-colors"
          >
            <span className="text-xl leading-none">📖</span>
            <span className="text-[10px] leading-tight">{speciesCaught}/{CHARACTERS.length}</span>
          </button>
        </>
      )}

      {/* Catch screen — with the real world behind it when the camera
          is available (AR mode), the vibe gradient when it isn't. */}
      {target && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-between py-10 px-6 overflow-hidden"
             style={!arOn ? { background: "radial-gradient(120% 90% at 50% 10%, rgba(16,53,34,.94) 0%, rgba(7,26,15,.97) 70%)" } : undefined}>
          {arOn && (
            <>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="absolute inset-0 w-full h-full object-cover -z-10"
              />
              <div
                className="absolute inset-0 -z-10"
                style={{ background: "radial-gradient(120% 90% at 50% 20%, rgba(4,12,8,0.15) 0%, rgba(4,12,8,0.62) 85%)" }}
              />
            </>
          )}
          <div className="text-center">
            <div className="text-xs uppercase tracking-[0.3em]" style={{ color: RARITY_META[target.rarity].color }}>
              {RARITY_META[target.rarity].label} · wild
            </div>
            <div className="font-heading text-2xl font-bold mt-1">{target.char.label}</div>
          </div>

          <div className="relative flex items-center justify-center">
            <div
              className="w-40 h-40 rounded-full flex items-center justify-center text-8xl"
              style={{
                background: "rgba(255,255,255,0.06)",
                boxShadow: `0 0 0 3px ${target.char.accent}55, 0 0 60px ${target.char.accent}33`,
                animation: throwing === "escaped" ? "vibego-bob 0.4s ease-in-out 2" : "vibego-bob 2.2s ease-in-out infinite",
              }}
            >
              {throwing === "caught" ? "✨" : target.char.emoji}
            </div>
            {throwing === "caught" && (
              <div className="absolute -bottom-10 text-emerald-300 font-semibold">Caught!</div>
            )}
            {throwing === "fled" && (
              <div className="absolute -bottom-10 text-rose-300 font-semibold">It fled…</div>
            )}
            {throwing === "escaped" && (
              <div className="absolute -bottom-10 text-amber-300 font-semibold">Broke free! ({3 - (target.misses ?? 0)} tries left)</div>
            )}
          </div>

          <div className="w-full max-w-xs space-y-3">
            {throwing !== "caught" && throwing !== "fled" ? (
              <>
                {/* Timing bar — release near the notch. */}
                <div className="relative h-4 rounded-full bg-white/10 overflow-hidden">
                  <div className="absolute inset-y-0 left-[72%] w-[6%] bg-emerald-300/60" />
                  {charge !== null && (
                    <div className="absolute inset-y-0 left-0 bg-emerald-400 transition-none" style={{ width: `${charge}%` }} />
                  )}
                </div>
                <button
                  onPointerDown={startCharge}
                  onPointerUp={releaseThrow}
                  onPointerLeave={() => charge !== null && releaseThrow()}
                  className="w-full py-4 rounded-2xl bg-emerald-400 text-emerald-950 font-bold text-lg active:scale-95 transition-transform select-none touch-none"
                >
                  {charge === null ? "Hold to charge · release to throw" : "Release!"}
                </button>
                <button onClick={() => setTarget(null)} className="w-full text-xs text-white/50 hover:text-white">
                  Run away
                </button>
              </>
            ) : (
              <button
                onClick={() => setTarget(null)}
                className="w-full py-4 rounded-2xl bg-white/90 text-emerald-950 font-bold text-lg"
              >
                {throwing === "caught" ? "Nice! Keep exploring" : "Keep exploring"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Vibedex. */}
      {collectionOpen && (
        <div className="absolute inset-0 z-30 bg-[#081a10]/97 flex flex-col">
          <div className="flex items-center justify-between px-5 pt-5 pb-3">
            <div>
              <h2 className="font-heading text-xl font-bold tracking-[0.12em]">VIBEDEX</h2>
              <p className="text-[11px] text-white/55">
                {speciesCaught}/{CHARACTERS.length} species · {totalCaught} total catches
              </p>
            </div>
            <button onClick={() => setCollectionOpen(false)} className="text-white/60 hover:text-white text-xl px-2">✕</button>
          </div>
          <div className="h-1.5 mx-5 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full bg-emerald-400" style={{ width: `${(speciesCaught / CHARACTERS.length) * 100}%` }} />
          </div>
          <div className="flex-1 overflow-y-auto p-5 grid grid-cols-4 sm:grid-cols-6 gap-2.5 content-start">
            {CHARACTERS.map((c) => {
              const n = collection[c.id] ?? 0;
              const meta = RARITY_META[rarityOf(c.id)];
              return (
                <div
                  key={c.id}
                  className={`rounded-xl p-2 flex flex-col items-center gap-0.5 ${n > 0 ? "bg-white/8" : "bg-white/[0.03] opacity-45"}`}
                  style={n > 0 ? { boxShadow: `0 0 0 1.5px ${meta.color}66` } : undefined}
                >
                  <span className="text-2xl">{n > 0 ? c.emoji : "❔"}</span>
                  <span className="text-[9px] text-center leading-tight text-white/75 truncate w-full">
                    {n > 0 ? c.label : "???"}
                  </span>
                  {n > 0 && <span className="text-[9px]" style={{ color: meta.color }}>×{n}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
