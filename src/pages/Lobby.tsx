import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import * as THREE from "three";
import { releaseRenderer } from "@/lib/quality";
import { loadCharacterRig, type CharacterRig } from "@/lib/characterRig";
import { ArrowLeft, ChevronLeft, ChevronRight, Dice5, LayoutGrid } from "lucide-react";
import VibeCoinPanel from "@/components/VibeCoinPanel";
import VibeAccountCard from "@/components/VibeAccountCard";
import VibeWalletLeaderboard from "@/components/VibeWalletLeaderboard";
import { enableVR } from "@/lib/webxr";
import { setActiveCharacter } from "@/hooks/use-active-character";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { generateCharacterName } from "@/lib/character-naming";
import { CHARACTERS } from "@/lib/characters";

// The playable roster lives in one place — src/lib/characters.ts — so
// /lobby, /profile, /character-select and the worlds can never drift
// apart. This file used to carry its own byte-identical copy of the
// table, which is exactly how Flux ended up missing from the lobby.
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
    let rig: CharacterRig | null = null;
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
      rig?.dispose();
      rig = null;
      mixer = null;
      activeAction = null;
      actionByShortName.clear();
      setClipNames([]);
      setActiveClip(null);

      (ring.material as THREE.MeshBasicMaterial).color.set(spec.accent);

      // fitBy "max" keeps short wide characters (the cow, the pug) from
      // blowing up trying to reach a target height. Characters with no
      // model file are built in code rather than fetched — they arrive
      // with no clips, so the emote list below is simply empty for them
      // and the rig animates itself.
      void loadCharacterRig(spec, {
        height: 2.2, fitBy: "max", castShadow: false,
      }).then((r) => {
        if (myGen !== loadGen) return r.dispose();
        rig = r;
        mixer = r.mixer;
        const model = r.object;
        const scaledSize = r.size;
        model.position.y += 0.05;
        // Re-aim the camera at the model's vertical center so short
        // characters (cow, pug) frame as well as tall ones (alien).
        lookAtY = 0.05 + scaledSize.y / 2;
        // Pull the camera back a touch for tall models so heads aren't clipped.
        const dist = 3.5 + Math.max(0, scaledSize.y - 1.6) * 1.4;
        camera.position.set(0, lookAtY + 0.35, Math.max(4.5, dist));
        camera.lookAt(0, lookAtY, 0);
        turntable.add(model);

        // The emote browser drives clips by hand, so it takes over the
        // mixer the rig set up rather than using setLocomotion().
        if (mixer && r.clips.length) {
          const shortNames: string[] = [];
          for (const clip of r.clips) {
            const short = shortClipName(clip.name);
            shortNames.push(short);
            actionByShortName.set(short, mixer.clipAction(clip));
          }
          setClipNames(shortNames);
          const startName =
            shortNames.find((n) => /idle/i.test(n)) ?? shortNames[0];
          if (startName) playClip(startName);
        } else {
          // No clips: either a rigless GLB or a character that animates
          // itself. Give the latter a gentle walk so the turntable isn't
          // showing a statue.
          r.setLocomotion(r.animated ? 0.55 : 0);
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
      rig?.update(delta);
      renderer.render(scene, camera);
    };
    renderer.setAnimationLoop(tick);

    return () => {
      renderer.setAnimationLoop(null);
      disposeVR();
      ro.disconnect();
      /* releaseRenderer, not dispose: three r160's dispose() drops its own caches and
         leaves the GL context to the garbage collector. See docs/performance.md. */
      releaseRenderer(renderer);
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
      navigate("/city?spawn=hub&fresh=1");
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
