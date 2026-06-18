import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ArrowLeft } from "lucide-react";
import VibeCoinPanel from "@/components/VibeCoinPanel";
import VibeAccountCard from "@/components/VibeAccountCard";
import VibeWalletLeaderboard from "@/components/VibeWalletLeaderboard";
import { enableVR } from "@/lib/webxr";
import { setActiveCharacter } from "@/hooks/use-active-character";

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
  // Pirate Kit additions.
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
  // Casual2_Female → "Casual2 Female"; trims the .glb path.
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

// Strip the armature prefix many Quaternius/animation rigs add before
// the underscore — "AlienArmature|Alien_Idle" → "Idle",
// "CharacterArmature|Walk" → "Walk".
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
  // List of available animation clip names for the current character
  // (stripped of armature prefix). Updated whenever the model loads.
  const [clipNames, setClipNames] = useState<string[]>([]);
  // The clip currently playing, for highlighting in the UI.
  const [activeClip, setActiveClip] = useState<string | null>(null);

  const charRef = useRef<string>(charId);
  charRef.current = charId;
  // Imperative handle the page renders into — playing a clip is a
  // function the canvas useEffect installs once it has a mixer.
  const playClipRef = useRef<((clipShortName: string) => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    // Enable WebXR — Quest / Pico / Index browsers will show an
    // "Enter VR" pill in the bottom-right of the canvas. The button
    // mounts to the canvas's parent so it sits over the preview frame.
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
    camera.lookAt(0, 1.1, 0);

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
        color: 0x141a30,
        metalness: 0.55,
        roughness: 0.35,
        emissive: 0x0a1530,
        emissiveIntensity: 0.4,
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
    // Maps short-clip-name → action so the play handler can find them.
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
      // Loop the obvious looping clips, hold the held poses, one-shot
      // the rest. Same semantics as the playground emote system.
      const lower = shortName.toLowerCase();
      if (/idle|walk|run|swim|dance/.test(lower)) {
        next.setLoop(THREE.LoopRepeat, Infinity);
        next.clampWhenFinished = false;
      } else if (/sit|stand|death|die/.test(lower)) {
        next.setLoop(THREE.LoopOnce, 1);
        next.clampWhenFinished = true;
      } else {
        // One-shot — fall back to first idle/loop after.
        next.setLoop(THREE.LoopOnce, 1);
        next.clampWhenFinished = true;
        const onFinished = (e: { action: THREE.AnimationAction }) => {
          if (e.action !== next) return;
          mixer?.removeEventListener("finished", onFinished);
          // Look for a sensible fallback to resume.
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
            // Find which key it is to update the badge.
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
      // Clear the turntable.
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
        model.position.y = 0.05 - scaled.min.y;
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

        // Wire animations: build action map keyed by short clip name,
        // play the first idle-ish clip if there is one.
        if (gltf.animations.length) {
          mixer = new THREE.AnimationMixer(model);
          const shortNames: string[] = [];
          for (const clip of gltf.animations) {
            const short = shortClipName(clip.name);
            shortNames.push(short);
            actionByShortName.set(short, mixer.clipAction(clip));
          }
          setClipNames(shortNames);
          // Start on something idle-ish.
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

    // setAnimationLoop (instead of requestAnimationFrame) is required
    // for WebXR — three drives the loop from the headset's vsync when
    // a session is active and from rAF otherwise.
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

  const selectedChar = CHARACTERS.find((c) => c.id === charId)!;
  const selectedVehicle = VEHICLES.find((v) => v.id === vehicleId)!;

  function launch() {
    setActiveCharacter(charId);
    localStorage.setItem("lobby.vehicle", vehicleId);
    navigate("/space");
  }

  return (
    <div className="relative w-full min-h-[100dvh] bg-black overflow-hidden text-foreground">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at top, hsl(216 60% 12%) 0%, hsl(220 50% 4%) 70%, #000 100%)",
        }}
      />

      <div className="relative z-10 flex flex-col gap-6 px-6 md:px-10 pt-16 md:pt-10 pb-6 md:pb-10 max-w-6xl mx-auto">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="glass-panel rounded-full px-3 py-2 flex items-center gap-2 hover:bg-muted transition-colors"
          >
            <ArrowLeft className="w-4 h-4 text-primary" />
            <span className="text-[11px] font-heading font-semibold tracking-widest uppercase">
              Back to village
            </span>
          </Link>
          <div className="glass-panel rounded-full px-3 py-2 flex items-center gap-2">
            <span className="text-[11px] font-heading font-semibold tracking-widest uppercase text-primary">
              Lobby · choose your fighter · {CHARACTERS.length} chars
            </span>
          </div>
        </div>

        <div className="grid md:grid-cols-[1.3fr_1fr] gap-6 items-start">
          {/* 3D preview + animation buttons */}
          <div className="glass-panel rounded-2xl border border-primary/30 overflow-hidden">
            <canvas
              ref={canvasRef}
              className="w-full block"
              style={{ aspectRatio: "16/12", height: "auto" }}
            />
            <div className="px-5 py-4 border-t border-border/50">
              <div className="flex items-center gap-3 mb-3">
                <span className="text-3xl">{selectedChar.emoji}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-base font-heading font-semibold text-foreground">
                    {selectedChar.label}
                  </p>
                  <p className="text-xs text-muted-foreground">{selectedChar.blurb}</p>
                </div>
              </div>
              {clipNames.length > 0 ? (
                <>
                  <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-muted-foreground mb-1.5">
                    Animations
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {clipNames.map((c) => {
                      const on = activeClip === c;
                      return (
                        <button
                          key={c}
                          onClick={() => playClipRef.current?.(c)}
                          className={`rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${
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
                </>
              ) : (
                <p className="text-[10px] text-muted-foreground italic">
                  No baked clips on this model.
                </p>
              )}
            </div>
          </div>

          {/* Pickers */}
          <div className="flex flex-col gap-4">
            <div className="glass-panel rounded-2xl border border-primary/30 p-4">
              <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary mb-3">
                Character ({CHARACTERS.length})
              </p>
              <div
                className="grid grid-cols-5 gap-1.5 max-h-[420px] overflow-y-auto pr-1"
                style={{ scrollbarWidth: "thin" }}
              >
                {CHARACTERS.map((c) => {
                  const on = charId === c.id;
                  return (
                    <button
                      key={c.id}
                      onClick={() => setCharId(c.id)}
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
            </div>

            <div className="glass-panel rounded-2xl border border-primary/30 p-4">
              <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary mb-3">
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

            <button
              onClick={launch}
              className="glass-panel rounded-2xl border border-primary/60 px-4 py-3 flex items-center justify-center gap-2 hover:bg-primary/15 transition-colors text-base font-heading font-semibold text-foreground"
            >
              <span>Launch into space</span>
              <span className="text-primary">{selectedChar.emoji}</span>
              <span className="opacity-50">·</span>
              <span>{selectedVehicle.emoji}</span>
            </button>

            {/* Sign in + paste your Base address. No wallet popup,
                no transactions — strictly opt-in identity. */}
            <VibeAccountCard variant="card" />

            {/* $VIBE live ticker + calculator. Pulls from GeckoTerminal
                directly; no auth, no key. */}
            <VibeCoinPanel />

            {/* Top 5 holders by default with "Show all" expand — full
                view is on /vibe. */}
            <VibeWalletLeaderboard defaultVisible={5} maxRows={30} />
          </div>
        </div>
      </div>
    </div>
  );
}
