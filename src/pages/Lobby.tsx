import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ArrowLeft, ChevronLeft, ChevronRight, Dice5, LayoutGrid } from "lucide-react";
import VibeCoinPanel from "@/components/VibeCoinPanel";
import VibeAccountCard from "@/components/VibeAccountCard";
import VibeWalletLeaderboard from "@/components/VibeWalletLeaderboard";
import { enableVR } from "@/lib/webxr";
import { setActiveCharacter } from "@/hooks/use-active-character";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { generateCharacterName } from "@/lib/character-naming";

// Two characters live outside the Quaternius pack folder.
import alienUrl from "@/assets/glb/alien.glb";
import vibeyUrl from "@/assets/glb/robot-expressive.glb";

// Every Quaternius character — Vite resolves each .glb as an asset URL
// at build time so we don't have to maintain a hand-edited list.
const QUATERNIUS_URLS = import.meta.glob(
  "@/assets/glb/characters/*.glb",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;

// Per-character emoji + accent palette. Anything not listed falls back
// to a neutral default — the goal is just enough recognizable variety
// in the grid that you can tell them apart.
const CHAR_OVERRIDES: Record<string, { emoji?: string; accent?: string; blurb?: string }> = {
  Wizard: { emoji: "🧙", accent: "#a78bfa", blurb: "Casts vibes." },
  Witch: { emoji: "🧙‍♀️", accent: "#b392ff", blurb: "Pointy-hat energy." },
  Knight_Male: { emoji: "🛡", accent: "#6aa8ff", blurb: "Square-jawed and shiny." },
  Knight_Golden_Male: { emoji: "🥇", accent: "#ffd166", blurb: "Polished to a mirror." },
  Knight_Golden_Female: { emoji: "🥇", accent: "#ffd166", blurb: "Polished to a mirror." },
  Ninja_Male: { emoji: "🥷", accent: "#ff7e8a" },
  Ninja_Female: { emoji: "🥷", accent: "#ff7e8a" },
  Ninja_Sand: { emoji: "🥷", accent: "#e6c890" },
  Ninja_Sand_Female: { emoji: "🥷", accent: "#e6c890" },
  Chef_Male: { emoji: "🥘", accent: "#ffd166" },
  Chef_Female: { emoji: "🥘", accent: "#ffd166" },
  Cowboy_Male: { emoji: "🤠", accent: "#ff9f7a" },
  Cowboy_Female: { emoji: "🤠", accent: "#ff9f7a" },
  Goblin_Male: { emoji: "👺", accent: "#8ad48a" },
  Goblin_Female: { emoji: "👺", accent: "#8ad48a" },
  Casual_Male: { emoji: "🧍", accent: "#eaeaf0" },
  Casual_Female: { emoji: "🧍‍♀️", accent: "#eaeaf0" },
  Casual_Bald: { emoji: "🧑‍🦲", accent: "#eaeaf0" },
  Casual2_Male: { emoji: "🧍", accent: "#eaeaf0" },
  Casual2_Female: { emoji: "🧍‍♀️", accent: "#eaeaf0" },
  Casual3_Male: { emoji: "🧍", accent: "#eaeaf0" },
  Casual3_Female: { emoji: "🧍‍♀️", accent: "#eaeaf0" },
  Cow: { emoji: "🐄", accent: "#ffffff", blurb: "It's a cow. From space, somehow." },
  Pug: { emoji: "🐶", accent: "#ffd9b3", blurb: "Pug, just hanging out." },
  Elf: { emoji: "🧝", accent: "#a5d8ff" },
  Doctor_Female_Old: { emoji: "🧑‍⚕️", accent: "#a5d8ff" },
  Doctor_Female_Young: { emoji: "🧑‍⚕️", accent: "#a5d8ff" },
  Doctor_Male_Old: { emoji: "🧑‍⚕️", accent: "#a5d8ff" },
  Doctor_Male_Young: { emoji: "🧑‍⚕️", accent: "#a5d8ff" },
  Pirate_Male: { emoji: "🏴‍☠️", accent: "#ff7e8a" },
  Pirate_Female: { emoji: "🏴‍☠️", accent: "#ff7e8a" },
  Viking_Male: { emoji: "⚒", accent: "#c9a86a" },
  Viking_Female: { emoji: "⚒", accent: "#c9a86a" },
  Soldier_Male: { emoji: "🪖", accent: "#8ad48a" },
  Soldier_Female: { emoji: "🪖", accent: "#8ad48a" },
  BlueSoldier_Male: { emoji: "🪖", accent: "#6aa8ff" },
  BlueSoldier_Female: { emoji: "🪖", accent: "#6aa8ff" },
  Worker_Male: { emoji: "👷", accent: "#ffd166" },
  Worker_Female: { emoji: "👷", accent: "#ffd166" },
  Suit_Male: { emoji: "🕴", accent: "#9aa3b5" },
  Suit_Female: { emoji: "💼", accent: "#9aa3b5" },
  Kimono_Male: { emoji: "🎎", accent: "#ff7e8a" },
  Kimono_Female: { emoji: "🎎", accent: "#ff7e8a" },
  OldClassy_Male: { emoji: "🎩", accent: "#c9a86a" },
  OldClassy_Female: { emoji: "🎩", accent: "#c9a86a" },
  Zombie_Male: { emoji: "🧟", accent: "#8ad48a" },
  Zombie_Female: { emoji: "🧟‍♀️", accent: "#8ad48a" },
  Pirate_Anne: { emoji: "🏴‍☠️", accent: "#ff7e8a", blurb: "Anne, captain of the Esmeralda fleet." },
  Pirate_Captain_Barbarossa: { emoji: "🏴‍☠️", accent: "#c9a86a", blurb: "Barbarossa. Big beard, bigger plans." },
  Pirate_Henry: { emoji: "🏴‍☠️", accent: "#6aa8ff", blurb: "Henry. First mate." },
  Pirate_Mako: { emoji: "🦈", accent: "#a5d8ff", blurb: "Mako. Half pirate, half shark." },
  Pirate_Shark: { emoji: "🦈", accent: "#a5d8ff", blurb: "Just a shark." },
  Pirate_Sharky: { emoji: "🦈", accent: "#a5d8ff", blurb: "Sharky. Smaller, friendlier." },
  Pirate_Skeleton: { emoji: "💀", accent: "#eaeaf0", blurb: "Cursed crew member." },
  Pirate_Skeleton_Headless: { emoji: "🦴", accent: "#eaeaf0", blurb: "Lost his head, kept the vibe." },
  Pirate_Tentacle: { emoji: "🐙", accent: "#b392ff", blurb: "Kraken correspondent." },
};

type CharSpec = {
  id: string;
  url: string;
  label: string;
  emoji: string;
  blurb: string;
  accent: string;
};

function prettyName(filename: string) {
  return filename.replace(/_/g, " ");
}

const CHARACTERS: CharSpec[] = [
  { id: "vibey", url: vibeyUrl, label: "Vibey 2.0", emoji: "🤖", blurb: "Resident bot.", accent: "#73ffb8" },
  { id: "alien", url: alienUrl, label: "Alien", emoji: "👽", blurb: "Quaternius animated visitor.", accent: "#b392ff" },
  ...Object.entries(QUATERNIUS_URLS)
    .map(([path, url]) => {
      const filename = (path.split("/").pop() ?? "").replace(/\.glb$/, "");
      const o = CHAR_OVERRIDES[filename] ?? {};
      return {
        id: filename,
        url,
        label: prettyName(filename),
        emoji: o.emoji ?? "👤",
        blurb: o.blurb ?? "Quaternius character.",
        accent: o.accent ?? "#eaeaf0",
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label)),
];

type VehicleSpec = {
  id: string;
  label: string;
  emoji: string;
  blurb: string;
};

const VEHICLES: VehicleSpec[] = [
  { id: "saucer", label: "Saucer", emoji: "🛸", blurb: "Violet UFO. Banks into curves." },
  { id: "helicopter", label: "Helicopter", emoji: "🚁", blurb: "Classic chopper. Fly the village." },
  { id: "nimbus", label: "Nimbus VTOL", emoji: "🛩", blurb: "Concept jet. Vertical takeoff." },
  { id: "boots", label: "On Foot", emoji: "👟", blurb: "No vehicle. Walk it." },
];

function shortClipName(raw: string) {
  const afterPipe = raw.includes("|") ? raw.split("|")[1] : raw;
  return afterPipe.replace(/^Alien_/, "").replace(/^Character_/, "");
}

export default function Lobby() {
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [charId, setCharId] = useState<string>(() =>
    localStorage.getItem("lobby.character") ?? "vibey",
  );
  const [vehicleId, setVehicleId] = useState<string>(() =>
    localStorage.getItem("lobby.vehicle") ?? "saucer",
  );
  const [clipNames, setClipNames] = useState<string[]>([]);
  const [activeClip, setActiveClip] = useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);

  // Auto-name pre-filled from the picked character. If the user types
  // their own, we stop auto-rewriting on character changes so we don't
  // clobber their intent.
  const [name, setName] = useState<string>(() => {
    const stored =
      localStorage.getItem("city.playerName") ??
      localStorage.getItem("city.displayName");
    if (stored && stored.trim()) return stored;
    const initialId =
      localStorage.getItem("lobby.character") ?? "vibey";
    const initialSpec = CHARACTERS.find((c) => c.id === initialId) ?? CHARACTERS[0];
    return generateCharacterName(initialSpec.label);
  });
  const [userEditedName, setUserEditedName] = useState<boolean>(() => {
    return !!localStorage.getItem("city.playerName");
  });

  const charRef = useRef<string>(charId);
  charRef.current = charId;
  const playClipRef = useRef<((clipShortName: string) => void) | null>(null);

  // When the picked character changes, re-roll the auto-name unless the
  // visitor has typed their own. Keeps the field feeling alive without
  // being annoying.
  useEffect(() => {
    if (userEditedName) return;
    const spec = CHARACTERS.find((c) => c.id === charId) ?? CHARACTERS[0];
    setName(generateCharacterName(spec.label));
  }, [charId, userEditedName]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    const disposeVR = canvas.parentElement
      ? enableVR(renderer, canvas.parentElement, { referenceSpace: "local-floor" })
      : () => {};

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      30,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      100,
    );
    camera.position.set(0, 1.6, 5.5);
    let lookAtY = 1.1;
    camera.lookAt(0, lookAtY, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(-2, 4, 3);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x73ffb8, 0.6);
    rim.position.set(3, 2, -2);
    scene.add(rim);

    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(1.4, 1.6, 0.18, 48),
      new THREE.MeshStandardMaterial({
        color: 0x081224,
        metalness: 0.55,
        roughness: 0.35,
        emissive: 0x0a1530,
        emissiveIntensity: 0.4,
        transparent: true,
        opacity: 0.55,
      }),
    );
    disc.position.y = -0.05;
    scene.add(disc);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.55, 0.04, 16, 64),
      new THREE.MeshBasicMaterial({ color: 0x73ffb8, transparent: true, opacity: 0.85 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.05;
    scene.add(ring);

    const turntable = new THREE.Group();
    scene.add(turntable);

    let mixer: THREE.AnimationMixer | null = null;
    const actionByShortName = new Map<string, THREE.AnimationAction>();
    let activeAction: THREE.AnimationAction | null = null;
    let lastTime = performance.now();
    let loadGen = 0;
    let currentCharId = "";

    function playClip(shortName: string) {
      const next = actionByShortName.get(shortName);
      if (!next) return;
      if (activeAction === next) return;
      if (activeAction) activeAction.fadeOut(0.18);
      next.reset();
      const lower = shortName.toLowerCase();
      if (/idle|walk|run|swim|dance/.test(lower)) {
        next.setLoop(THREE.LoopRepeat, Infinity);
        next.clampWhenFinished = false;
      } else if (/sit|stand|death|die/.test(lower)) {
        next.setLoop(THREE.LoopOnce, 1);
        next.clampWhenFinished = true;
      } else {
        next.setLoop(THREE.LoopOnce, 1);
        next.clampWhenFinished = true;
        const onFinished = (e: { action: THREE.AnimationAction }) => {
          if (e.action !== next) return;
          mixer?.removeEventListener("finished", onFinished);
          const fallback =
            actionByShortName.get("Idle") ??
            actionByShortName.get("idle") ??
            actionByShortName.values().next().value;
          if (fallback) {
            next.fadeOut(0.18);
            fallback.reset();
            fallback.setLoop(THREE.LoopRepeat, Infinity);
            fallback.fadeIn(0.18).play();
            activeAction = fallback;
            for (const [k, v] of actionByShortName) {
              if (v === fallback) {
                setActiveClip(k);
                break;
              }
            }
          }
        };
        mixer?.addEventListener("finished", onFinished);
      }
      next.fadeIn(0.18).play();
      activeAction = next;
      setActiveClip(shortName);
    }
    playClipRef.current = playClip;

    function loadCharacter(id: string) {
      const spec = CHARACTERS.find((c) => c.id === id);
      if (!spec || currentCharId === id) return;
      currentCharId = id;
      const myGen = ++loadGen;
      while (turntable.children.length) {
        const child = turntable.children.pop();
        if (!child) break;
        child.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.geometry?.dispose();
            const mat = mesh.material as THREE.Material | THREE.Material[];
            if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
            else mat?.dispose();
          }
        });
      }
      mixer = null;
      activeAction = null;
      actionByShortName.clear();
      setClipNames([]);
      setActiveClip(null);

      (ring.material as THREE.MeshBasicMaterial).color.set(spec.accent);

      const loader = new GLTFLoader();
      loader.load(spec.url, (gltf) => {
        if (myGen !== loadGen) return;
        const model = gltf.scene;
        model.position.set(0, 0, 0);
        model.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z, 0.0001);
        const fit = 2.2 / maxDim;
        model.scale.setScalar(fit);
        model.updateMatrixWorld(true);
        const scaled = new THREE.Box3().setFromObject(model);
        const scaledSize = new THREE.Vector3();
        scaled.getSize(scaledSize);
        // Center horizontally on the turntable so the character isn't
        // hanging off to one side (some GLBs have off-origin pivots).
        model.position.x = -(scaled.min.x + scaledSize.x / 2);
        model.position.z = -(scaled.min.z + scaledSize.z / 2);
        model.position.y = 0.05 - scaled.min.y;
        // Re-aim the camera at the model's vertical center so short
        // characters (cow, pug) frame as well as tall ones (alien).
        lookAtY = 0.05 + scaledSize.y / 2;
        // Pull the camera back a touch for tall models so heads aren't clipped.
        const dist = 3.5 + Math.max(0, scaledSize.y - 1.6) * 1.4;
        camera.position.set(0, lookAtY + 0.35, Math.max(4.5, dist));
        camera.lookAt(0, lookAtY, 0);
        model.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          const apply = (mat: THREE.Material) => {
            const std = mat as THREE.MeshStandardMaterial;
            if (std && "metalness" in std) {
              std.metalness = Math.min(std.metalness, 0.3);
              std.roughness = Math.max(std.roughness, 0.45);
              std.envMapIntensity = 1.0;
              std.needsUpdate = true;
            }
          };
          const mat = mesh.material;
          if (Array.isArray(mat)) mat.forEach(apply);
          else if (mat) apply(mat);
        });
        turntable.add(model);

        if (gltf.animations.length) {
          mixer = new THREE.AnimationMixer(model);
          const shortNames: string[] = [];
          for (const clip of gltf.animations) {
            const short = shortClipName(clip.name);
            shortNames.push(short);
            actionByShortName.set(short, mixer.clipAction(clip));
          }
          setClipNames(shortNames);
          const startName =
            shortNames.find((n) => /idle/i.test(n)) ?? shortNames[0];
          if (startName) playClip(startName);
        }
      });
    }

    loadCharacter(charRef.current);

    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(canvas);

    const tick = () => {
      const now = performance.now();
      const delta = (now - lastTime) / 1000;
      lastTime = now;

      if (charRef.current !== currentCharId) loadCharacter(charRef.current);

      turntable.rotation.y += delta * 0.6;
      const ringMat = ring.material as THREE.MeshBasicMaterial;
      ringMat.opacity = 0.6 + Math.sin(now * 0.002) * 0.25;
      if (mixer) mixer.update(delta);
      renderer.render(scene, camera);
    };
    renderer.setAnimationLoop(tick);

    return () => {
      renderer.setAnimationLoop(null);
      disposeVR();
      ro.disconnect();
      renderer.dispose();
    };
  }, []);

  const selectedIdx = Math.max(0, CHARACTERS.findIndex((c) => c.id === charId));
  const selectedChar = CHARACTERS[selectedIdx] ?? CHARACTERS[0];
  const selectedVehicle = VEHICLES.find((v) => v.id === vehicleId)!;

  const cycleChar = (dir: 1 | -1) => {
    const n = CHARACTERS.length;
    const next = CHARACTERS[(selectedIdx + dir + n) % n];
    setCharId(next.id);
  };
  const randomChar = () => {
    let next = selectedChar;
    while (next.id === selectedChar.id) {
      next = CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)];
    }
    setCharId(next.id);
  };

  // Touch swipe support on the holographic preview.
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touchStartRef.current;
    touchStartRef.current = null;
    if (!s) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      cycleChar(dx < 0 ? 1 : -1);
    }
  };

  function persistAndEnter(destination: "island" | "space") {
    const cleanName =
      name.trim().slice(0, 32) || generateCharacterName(selectedChar.label);
    setActiveCharacter(charId);
    localStorage.setItem("lobby.vehicle", vehicleId);
    localStorage.setItem("city.playerName", cleanName);
    localStorage.setItem("city.displayName", cleanName);
    if (destination === "island") {
      navigate("/city?spawn=island&fresh=1");
    } else {
      navigate("/space");
    }
  }

  // Hex with alpha helper for the hologram glow.
  const accent = selectedChar.accent;
  const accentSoft = `${accent}33`;
  const accentGlow = `${accent}88`;

  return (
    <div className="relative w-full min-h-[100dvh] bg-black overflow-hidden text-foreground">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at top, hsl(216 60% 12%) 0%, hsl(220 50% 4%) 70%, #000 100%)",
        }}
      />

      {/* Scoped keyframes for the hologram scanline + glitch shimmer. */}
      <style>{`
        @keyframes holo-scan {
          0%   { background-position: 0 0; }
          100% { background-position: 0 100%; }
        }
        @keyframes holo-flicker {
          0%, 100% { opacity: 0.85; }
          47%      { opacity: 0.78; }
          48%      { opacity: 1; }
          49%      { opacity: 0.6; }
          50%      { opacity: 0.95; }
        }
        .holo-scanlines {
          background-image: repeating-linear-gradient(
            to bottom,
            rgba(115,255,184,0.06) 0px,
            rgba(115,255,184,0.06) 1px,
            transparent 1px,
            transparent 3px
          );
          background-size: 100% 6px;
          animation: holo-scan 8s linear infinite, holo-flicker 5s ease-in-out infinite;
          mix-blend-mode: screen;
        }
      `}</style>

      <div className="relative z-10 flex flex-col gap-4 px-3 md:px-10 pt-16 md:pt-10 pb-6 md:pb-10 max-w-6xl mx-auto">
        {/* Top bar */}
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to="/"
            className="glass-panel rounded-full px-3 py-2 flex items-center gap-2 hover:bg-muted transition-colors"
          >
            <ArrowLeft className="w-4 h-4 text-primary" />
            <span className="text-[11px] font-heading font-semibold tracking-widest uppercase">
              Back
            </span>
          </Link>
          <div className="glass-panel rounded-full px-3 py-2 flex items-center gap-2">
            <span className="text-[11px] font-heading font-semibold tracking-widest uppercase text-primary">
              Lobby · {CHARACTERS.length} chars
            </span>
          </div>
        </div>

        <div className="grid md:grid-cols-[1.3fr_1fr] gap-5 items-start">
          {/* ============ HOLOGRAPHIC SPAWN POD ============ */}
          <div className="flex flex-col gap-3">
            <div
              className="relative rounded-3xl overflow-hidden border"
              style={{
                borderColor: accentSoft,
                boxShadow: `0 0 60px ${accentSoft}, inset 0 0 40px ${accentSoft}`,
                background:
                  "radial-gradient(ellipse at center, rgba(8,16,28,0.95) 0%, rgba(2,6,14,0.98) 80%)",
              }}
            >
              <canvas
                ref={canvasRef}
                className="w-full block touch-none aspect-[4/5] max-h-[52vh] md:max-h-[60vh]"
                onTouchStart={onTouchStart}
                onTouchEnd={onTouchEnd}
              />


              {/* Scanline + flicker overlay */}
              <div className="absolute inset-0 pointer-events-none holo-scanlines" />

              {/* Top-edge soft accent vignette */}
              <div
                className="absolute inset-x-0 top-0 h-24 pointer-events-none"
                style={{
                  background: `linear-gradient(to bottom, ${accentGlow}, transparent)`,
                  opacity: 0.25,
                }}
              />

              {/* Count chip top-left */}
              <div className="absolute top-3 left-3 rounded-full px-2.5 py-1 text-[10px] font-mono tracking-widest uppercase backdrop-blur-md bg-black/40 border border-white/10 text-white/70">
                {String(selectedIdx + 1).padStart(2, "0")} / {CHARACTERS.length}
              </div>

              {/* Dice (re-roll random) top-right */}
              <button
                type="button"
                onClick={randomChar}
                title="Random character"
                className="absolute top-3 right-3 rounded-full w-9 h-9 flex items-center justify-center backdrop-blur-md bg-black/40 border border-white/15 text-white/80 hover:bg-black/60 hover:text-white transition"
              >
                <Dice5 className="w-4 h-4" />
              </button>

              {/* Prev / Next arrows */}
              <button
                type="button"
                onClick={() => cycleChar(-1)}
                aria-label="Previous character"
                className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full w-11 h-11 flex items-center justify-center backdrop-blur-md bg-black/40 border border-white/15 text-white/90 hover:bg-black/60 active:scale-95 transition"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={() => cycleChar(1)}
                aria-label="Next character"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full w-11 h-11 flex items-center justify-center backdrop-blur-md bg-black/40 border border-white/15 text-white/90 hover:bg-black/60 active:scale-95 transition"
              >
                <ChevronRight className="w-5 h-5" />
              </button>

              {/* Name plate */}
              <div className="absolute inset-x-0 bottom-0 px-4 py-3 backdrop-blur-md bg-gradient-to-t from-black/80 via-black/50 to-transparent">
                <div className="flex items-center gap-2.5">
                  <span className="text-2xl drop-shadow">{selectedChar.emoji}</span>
                  <div className="min-w-0 flex-1">
                    <p
                      className="text-sm font-heading font-bold leading-tight truncate"
                      style={{ color: accent, textShadow: `0 0 12px ${accentGlow}` }}
                    >
                      {selectedChar.label}
                    </p>
                    <p className="text-[10px] text-white/60 truncate">{selectedChar.blurb}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Animations strip (horizontal scroll on mobile) */}
            {clipNames.length > 0 && (
              <div className="-mx-1 px-1 overflow-x-auto" style={{ scrollbarWidth: "thin" }}>
                <div className="flex gap-1.5 w-max pb-1">
                  {clipNames.map((c) => {
                    const on = activeClip === c;
                    return (
                      <button
                        key={c}
                        onClick={() => playClipRef.current?.(c)}
                        className={`shrink-0 rounded-md border px-2.5 py-1 text-[10px] font-medium transition-colors ${
                          on
                            ? "border-primary/70 bg-primary/20 text-primary"
                            : "border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50"
                        }`}
                      >
                        {c}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* ============ NAME + ACTIONS ============ */}
          <div className="flex flex-col gap-3">
            {/* Auto-generated name */}
            <div className="glass-panel rounded-2xl border border-primary/30 p-4">
              <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary mb-2">
                Your name
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={name}
                  maxLength={32}
                  onChange={(e) => {
                    setUserEditedName(true);
                    setName(e.target.value.slice(0, 32));
                  }}
                  placeholder="Cosmic Vibey"
                  className="flex-1 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-foreground placeholder:text-white/30 focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
                <button
                  type="button"
                  title="Roll a new name"
                  onClick={() => {
                    setUserEditedName(false);
                    setName(generateCharacterName(selectedChar.label));
                  }}
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-base hover:bg-white/10"
                >
                  🎲
                </button>
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">
                Auto-rolls when you flip characters — edit any time.
              </p>
            </div>

            {/* Primary + secondary CTAs */}
            <button
              onClick={() => persistAndEnter("island")}
              className="rounded-2xl px-4 py-3.5 flex items-center justify-center gap-2 text-base font-heading font-bold text-primary-foreground transition-opacity hover:opacity-90"
              style={{
                background: `linear-gradient(135deg, hsl(var(--primary)), ${accent})`,
                boxShadow: `0 0 28px hsl(var(--primary) / 0.55), 0 0 20px ${accentSoft}`,
              }}
            >
              <span>✨ Enter Edge Island as</span>
              <span className="truncate">{name || selectedChar.label}</span>
            </button>

            <div className="grid grid-cols-2 gap-2">
              <Sheet open={browseOpen} onOpenChange={setBrowseOpen}>
                <SheetTrigger asChild>
                  <button className="glass-panel rounded-xl border border-primary/30 px-3 py-2.5 flex items-center justify-center gap-2 hover:bg-primary/10 transition-colors text-xs font-heading font-semibold uppercase tracking-wider">
                    <LayoutGrid className="w-3.5 h-3.5 text-primary" />
                    Browse all
                  </button>
                </SheetTrigger>
                <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto bg-background/95 backdrop-blur-xl border-primary/30">
                  <SheetHeader>
                    <SheetTitle className="text-primary font-heading uppercase tracking-widest text-sm">
                      Browse · {CHARACTERS.length} characters
                    </SheetTitle>
                  </SheetHeader>

                  <div className="mt-4 grid grid-cols-4 sm:grid-cols-6 gap-1.5">
                    {CHARACTERS.map((c) => {
                      const on = charId === c.id;
                      return (
                        <button
                          key={c.id}
                          onClick={() => {
                            setCharId(c.id);
                            setBrowseOpen(false);
                          }}
                          className={`flex flex-col items-center gap-0.5 rounded-lg border transition-all py-2 px-1 ${
                            on
                              ? "border-primary/70 bg-primary/15 scale-[1.05]"
                              : "border-border/60 bg-background/30 hover:border-primary/50 hover:bg-primary/10"
                          }`}
                          style={on ? { boxShadow: `0 0 18px ${c.accent}66` } : undefined}
                          title={c.label}
                        >
                          <span className="text-xl leading-none">{c.emoji}</span>
                          <span className="text-[9px] font-heading font-semibold text-foreground/85 leading-tight text-center break-words">
                            {c.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="mt-6">
                    <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary mb-2">
                      Vehicle
                    </p>
                    <div className="grid grid-cols-2 gap-1.5">
                      {VEHICLES.map((v) => {
                        const on = vehicleId === v.id;
                        return (
                          <button
                            key={v.id}
                            onClick={() => setVehicleId(v.id)}
                            className={`flex items-center gap-2 rounded-lg border transition-colors px-3 py-2 text-left ${
                              on
                                ? "border-primary/70 bg-primary/15"
                                : "border-border/60 bg-background/30 hover:border-primary/50 hover:bg-primary/10"
                            }`}
                          >
                            <span className="text-xl">{v.emoji}</span>
                            <div className="flex-1 min-w-0">
                              <p className="text-[12px] font-heading font-semibold text-foreground leading-none">
                                {v.label}
                              </p>
                              <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">
                                {v.blurb}
                              </p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </SheetContent>
              </Sheet>

              <button
                onClick={() => persistAndEnter("space")}
                className="glass-panel rounded-xl border border-primary/30 px-3 py-2.5 flex items-center justify-center gap-2 hover:bg-primary/10 transition-colors text-xs font-heading font-semibold uppercase tracking-wider"
                title="Launch into the space arcade"
              >
                <span>🚀</span> Space
              </button>
            </div>

            {/* Wallet / identity — collapsed visually on mobile by being below the CTA */}
            <div className="mt-2 flex flex-col gap-3">
              <VibeAccountCard variant="card" />
              <VibeCoinPanel />
              <VibeWalletLeaderboard defaultVisible={5} maxRows={30} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
