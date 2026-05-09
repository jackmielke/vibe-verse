import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ArrowLeft } from "lucide-react";

import wizardUrl from "@/assets/glb/characters/Wizard.glb";
import knightUrl from "@/assets/glb/characters/Knight_Male.glb";
import ninjaUrl from "@/assets/glb/characters/Ninja_Female.glb";
import chefUrl from "@/assets/glb/characters/Chef_Female.glb";
import cowboyUrl from "@/assets/glb/characters/Cowboy_Male.glb";
import goblinUrl from "@/assets/glb/characters/Goblin_Male.glb";
import casualUrl from "@/assets/glb/characters/Casual_Female.glb";
import cowUrl from "@/assets/glb/characters/Cow.glb";
import alienUrl from "@/assets/glb/alien.glb";
import vibeyUrl from "@/assets/glb/robot-expressive.glb";

type CharSpec = {
  id: string;
  url: string;
  label: string;
  emoji: string;
  blurb: string;
  accent: string;
};

const CHARACTERS: CharSpec[] = [
  { id: "vibey", url: vibeyUrl, label: "Vibey 2.0", emoji: "🤖", blurb: "Resident bot. Late-night host energy.", accent: "#73ffb8" },
  { id: "alien", url: alienUrl, label: "Alien", emoji: "👽", blurb: "Quaternius animated visitor.", accent: "#b392ff" },
  { id: "wizard", url: wizardUrl, label: "Wizard", emoji: "🧙", blurb: "Casts vibes. Beard included.", accent: "#a78bfa" },
  { id: "knight", url: knightUrl, label: "Knight", emoji: "🛡", blurb: "Square-jawed and shiny.", accent: "#6aa8ff" },
  { id: "ninja", url: ninjaUrl, label: "Ninja", emoji: "🥷", blurb: "Stealth + swagger.", accent: "#ff7e8a" },
  { id: "chef", url: chefUrl, label: "Chef", emoji: "🥘", blurb: "Cooks for the village.", accent: "#ffd166" },
  { id: "cowboy", url: cowboyUrl, label: "Cowboy", emoji: "🤠", blurb: "Strolled in from the vineyards.", accent: "#ff9f7a" },
  { id: "goblin", url: goblinUrl, label: "Goblin", emoji: "👺", blurb: "Mischief incarnate.", accent: "#8ad48a" },
  { id: "casual", url: casualUrl, label: "Casual", emoji: "🧍‍♀️", blurb: "Just somebody nice.", accent: "#eaeaf0" },
  { id: "cow", url: cowUrl, label: "Cow", emoji: "🐄", blurb: "It's a cow. From space, somehow.", accent: "#ffffff" },
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

export default function Lobby() {
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [charId, setCharId] = useState<string>(() =>
    localStorage.getItem("lobby.character") ?? "vibey",
  );
  const [vehicleId, setVehicleId] = useState<string>(() =>
    localStorage.getItem("lobby.vehicle") ?? "saucer",
  );
  const charRef = useRef<string>(charId);
  charRef.current = charId;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

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

    // Glowing pedestal disc.
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

    // Currently-shown model + its mixer.
    const turntable = new THREE.Group();
    scene.add(turntable);
    (window as unknown as { __lobbyTurntable: THREE.Group }).__lobbyTurntable = turntable;
    let mixer: THREE.AnimationMixer | null = null;
    let lastTime = performance.now();
    let loadGen = 0;
    let currentCharId = "";

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

      // Update accent ring color to match the character.
      (ring.material as THREE.MeshBasicMaterial).color.set(spec.accent);

      const loader = new GLTFLoader();
      loader.load(spec.url, (gltf) => {
        if (myGen !== loadGen) return; // a newer load won
        const model = gltf.scene;
        // Anchor the gltf root at origin so any baked offset doesn't
        // throw off the bbox math.
        model.position.set(0, 0, 0);
        // Quaternius FBX→GLB sometimes nests a 100x scaled armature
        // inside a 0.01 scaled root — the world matrix has to be
        // refreshed before the bbox is meaningful.
        model.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        box.getSize(size);
        // Use the largest dimension to account for sideways exports.
        const maxDim = Math.max(size.x, size.y, size.z, 0.0001);
        const fit = 2.2 / maxDim;
        model.scale.setScalar(fit);
        model.updateMatrixWorld(true);
        // Stand on the disc — lift by post-scale bbox min.
        const scaled = new THREE.Box3().setFromObject(model);
        model.position.y = 0.05 - scaled.min.y;
        // PBR clamp.
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

        // Play the first idle-ish animation if available.
        if (gltf.animations.length) {
          mixer = new THREE.AnimationMixer(model);
          const idle =
            gltf.animations.find((c) => /idle/i.test(c.name)) ?? gltf.animations[0];
          mixer.clipAction(idle).play();
        }
      });
    }

    // Initial load.
    loadCharacter(charRef.current);

    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(canvas);

    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const delta = (now - lastTime) / 1000;
      lastTime = now;

      // Re-load if the character changed.
      if (charRef.current !== currentCharId) loadCharacter(charRef.current);

      // Slow turntable spin + glowing ring pulse.
      turntable.rotation.y += delta * 0.6;
      const ringMat = ring.material as THREE.MeshBasicMaterial;
      ringMat.opacity = 0.6 + Math.sin(now * 0.002) * 0.25;
      if (mixer) mixer.update(delta);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
    };
  }, []);

  const selectedChar = CHARACTERS.find((c) => c.id === charId)!;
  const selectedVehicle = VEHICLES.find((v) => v.id === vehicleId)!;

  function launch() {
    localStorage.setItem("lobby.character", charId);
    localStorage.setItem("lobby.vehicle", vehicleId);
    navigate("/space");
  }

  return (
    <div className="relative w-full min-h-[100dvh] bg-black overflow-hidden text-foreground">
      {/* Star backdrop — pure CSS so the page paints fast. */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at top, hsl(216 60% 12%) 0%, hsl(220 50% 4%) 70%, #000 100%)",
        }}
      />

      <div className="relative z-10 flex flex-col gap-6 p-6 md:p-10 max-w-6xl mx-auto">
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
              Lobby · choose your fighter
            </span>
          </div>
        </div>

        <div className="grid md:grid-cols-[1.3fr_1fr] gap-6 items-start">
          {/* 3D preview */}
          <div className="glass-panel rounded-2xl border border-primary/30 overflow-hidden">
            <canvas
              ref={canvasRef}
              className="w-full block"
              style={{ aspectRatio: "16/12", height: "auto" }}
            />
            <div className="px-5 py-4 border-t border-border/50">
              <div className="flex items-center gap-3">
                <span className="text-3xl">{selectedChar.emoji}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-base font-heading font-semibold text-foreground">
                    {selectedChar.label}
                  </p>
                  <p className="text-xs text-muted-foreground">{selectedChar.blurb}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Pickers */}
          <div className="flex flex-col gap-4">
            <div className="glass-panel rounded-2xl border border-primary/30 p-4">
              <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary mb-3">
                Character
              </p>
              <div className="grid grid-cols-5 gap-1.5">
                {CHARACTERS.map((c) => {
                  const on = charId === c.id;
                  return (
                    <button
                      key={c.id}
                      onClick={() => setCharId(c.id)}
                      className={`flex flex-col items-center gap-1 rounded-lg border transition-all py-2 ${
                        on
                          ? "border-primary/70 bg-primary/15 scale-[1.05]"
                          : "border-border/60 bg-background/30 hover:border-primary/50 hover:bg-primary/10"
                      }`}
                      style={on ? { boxShadow: `0 0 18px ${c.accent}66` } : undefined}
                    >
                      <span className="text-2xl">{c.emoji}</span>
                      <span className="text-[9.5px] font-heading font-semibold text-foreground/85 leading-none">
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
          </div>
        </div>
      </div>
    </div>
  );
}
