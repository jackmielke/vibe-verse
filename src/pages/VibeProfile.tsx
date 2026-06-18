/**
 * VibeProfile — `/profile`. Mobile-first "choose your character + edit
 * your vibe" hub. Reuses the same Quaternius roster as /lobby (~58
 * characters) via the shared `src/lib/characters.ts` catalog, with a
 * 3D turntable preview tuned for portrait screens.
 *
 * Sections (single column, scrollable):
 *   1. 3D character preview turntable (touch-rotate friendly)
 *   2. Character grid — every character, big tap targets
 *   3. Display name editor
 *   4. Vibe color (used by 2D penguin avatars / chat dots)
 *   5. Account info + sign out (only when signed in)
 *
 * The picked character id is mirrored to `localStorage.lobby.character`
 * so spawning into /city, /space, etc. uses the same avatar.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ArrowLeft, Check, LogOut, Loader2 } from "lucide-react";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";
import VibeAvatar, { VIBE_COLORS } from "@/components/vibe-auth/VibeAvatar";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { CHARACTERS, findCharacter } from "@/lib/characters";

export default function VibeProfile() {
  const id = useVibeIdentity();
  const navigate = useNavigate();
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);

  // Character pick — shared with /lobby and the worlds via localStorage.
  const [charId, setCharIdState] = useState<string>(() => {
    if (typeof window === "undefined") return "vibey";
    return localStorage.getItem("lobby.character") ?? "vibey";
  });
  const setCharId = (next: string) => {
    setCharIdState(next);
    try { localStorage.setItem("lobby.character", next); } catch {}
  };
  const selectedChar = findCharacter(charId);

  useEffect(() => {
    setNameDraft(id.displayName === "Guest" ? "" : id.displayName);
  }, [id.displayName]);

  const saveName = async () => {
    const next = nameDraft.trim();
    if (!next) return;
    setSavingName(true);
    try {
      id.setGuestName(next);
      if (id.user) {
        const { error } = await supabase
          .from("users")
          .update({ name: next })
          .eq("auth_user_id", id.user.id);
        if (error) throw error;
        await id.refresh();
      }
      toast.success("Saved");
    } catch (e: any) {
      toast.error(e.message ?? "Couldn't save your name");
    } finally {
      setSavingName(false);
    }
  };

  // ---------- 3D preview turntable ----------
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const charRef = useRef(charId);
  useEffect(() => { charRef.current = charId; }, [charId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const scene = new THREE.Scene();
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    const camera = new THREE.PerspectiveCamera(
      32,
      canvas.clientWidth / Math.max(1, canvas.clientHeight),
      0.1,
      100,
    );
    camera.position.set(0, 1.2, 4.4);
    camera.lookAt(0, 1.0, 0);

    scene.add(new THREE.AmbientLight(0xb6c6ff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(2, 4, 3);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x73ffb8, 0.5);
    rim.position.set(-3, 2, -2);
    scene.add(rim);

    // Subtle ground disc.
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(1.3, 64),
      new THREE.MeshBasicMaterial({ color: 0x0e1424, transparent: true, opacity: 0.7 }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -0.01;
    scene.add(disc);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.28, 1.42, 96),
      new THREE.MeshBasicMaterial({ color: 0x73ffb8, transparent: true, opacity: 0.85 }),
    );
    ring.rotation.x = -Math.PI / 2;
    scene.add(ring);

    const turntable = new THREE.Group();
    scene.add(turntable);

    let currentId = "";
    let mixer: THREE.AnimationMixer | null = null;
    let loadGen = 0;

    const loadCharacter = (id: string) => {
      const spec = findCharacter(id);
      currentId = id;
      loadGen++;
      const myGen = loadGen;
      // Clear previous model.
      while (turntable.children.length) turntable.remove(turntable.children[0]);
      mixer = null;
      (ring.material as THREE.MeshBasicMaterial).color.set(spec.accent);

      new GLTFLoader().load(spec.url, (gltf) => {
        if (myGen !== loadGen) return;
        const model = gltf.scene;
        model.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        box.getSize(size);
        const fit = 2.0 / Math.max(size.x, size.y, size.z, 0.0001);
        model.scale.setScalar(fit);
        model.updateMatrixWorld(true);
        const scaled = new THREE.Box3().setFromObject(model);
        model.position.y = 0.05 - scaled.min.y;
        turntable.add(model);

        if (gltf.animations.length) {
          mixer = new THREE.AnimationMixer(model);
          const idle =
            gltf.animations.find((c) => /idle/i.test(c.name)) ?? gltf.animations[0];
          mixer.clipAction(idle).play();
        }
      });
    };
    loadCharacter(charRef.current);

    // Touch / pointer rotate.
    let dragging = false;
    let dragStartX = 0;
    let dragStartRot = 0;
    let manualSpin = 0;
    const onDown = (e: PointerEvent) => {
      dragging = true;
      dragStartX = e.clientX;
      dragStartRot = turntable.rotation.y;
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - dragStartX;
      turntable.rotation.y = dragStartRot + dx * 0.012;
      manualSpin = performance.now();
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch {}
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);

    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    });
    ro.observe(canvas);

    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;

      if (charRef.current !== currentId) loadCharacter(charRef.current);
      // Idle auto-spin pauses for a beat after manual drag.
      if (!dragging && now - manualSpin > 600) turntable.rotation.y += dt * 0.5;
      const rm = ring.material as THREE.MeshBasicMaterial;
      rm.opacity = 0.55 + Math.sin(now * 0.002) * 0.25;
      if (mixer) mixer.update(dt);
      renderer.render(scene, camera);
    };
    renderer.setAnimationLoop(tick);

    return () => {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      renderer.dispose();
    };
  }, []);

  return (
    <div className="relative min-h-[100dvh] bg-black text-white overflow-x-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at top, hsl(216 60% 12%) 0%, hsl(220 50% 4%) 70%, #000 100%)",
        }}
      />

      <div className="relative z-10 max-w-md mx-auto px-4 pt-6 pb-12 flex flex-col gap-5">
        {/* Top bar */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-1.5 text-xs text-white/60 hover:text-white transition"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          <span className="text-[10px] font-heading font-semibold tracking-[0.25em] uppercase text-primary/80">
            Choose your fighter · {CHARACTERS.length}
          </span>
        </div>

        {/* 3D preview */}
        <div className="rounded-2xl border border-primary/30 bg-white/[0.03] overflow-hidden">
          <canvas
            ref={canvasRef}
            className="w-full block touch-none select-none cursor-grab active:cursor-grabbing"
            style={{ aspectRatio: "1/1", height: "auto" }}
          />
          <div className="px-4 py-3 border-t border-white/10 flex items-center gap-3">
            <span className="text-2xl">{selectedChar.emoji}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-heading font-semibold truncate">{selectedChar.label}</p>
              <p className="text-[11px] text-white/55 truncate">{selectedChar.blurb}</p>
            </div>
          </div>
        </div>

        {/* Character grid */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 flex flex-col gap-2">
          <div className="flex items-baseline justify-between px-1">
            <label className="text-[10px] uppercase tracking-[0.2em] text-white/45 font-semibold">
              Character
            </label>
            <span className="text-[10px] text-white/40">drag to rotate</span>
          </div>
          <div
            className="grid grid-cols-4 sm:grid-cols-5 gap-1.5 max-h-[44vh] overflow-y-auto pr-1"
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
                      ? "border-primary/70 bg-primary/15 scale-[1.04]"
                      : "border-white/10 bg-white/[0.02] hover:border-primary/40 hover:bg-primary/5"
                  }`}
                  style={on ? { boxShadow: `0 0 16px ${c.accent}66` } : undefined}
                  title={c.label}
                >
                  <span className="text-xl leading-none">{c.emoji}</span>
                  <span className="text-[9px] font-heading font-semibold text-white/85 leading-tight text-center break-words">
                    {c.label}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Name */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 flex flex-col gap-2">
          <label className="text-[10px] uppercase tracking-[0.2em] text-white/45 font-semibold">
            Display name
          </label>
          <div className="flex items-center gap-2">
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="What should we call you?"
              className="flex-1 bg-transparent border border-white/15 rounded-xl h-11 px-3 text-sm placeholder:text-white/30 focus:outline-none focus:border-primary/60"
              maxLength={40}
            />
            <button
              onClick={saveName}
              disabled={savingName || !nameDraft.trim() || nameDraft.trim() === id.displayName}
              className="h-11 px-4 rounded-xl bg-white text-black text-sm font-semibold hover:bg-white/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {savingName ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </button>
          </div>
        </section>

        {/* Vibe color (for 2D penguin avatar / chat dots) */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <label className="text-[10px] uppercase tracking-[0.2em] text-white/45 font-semibold">
              Vibe color
            </label>
            <VibeAvatar colorId={id.colorId} size={32} animated={false} />
          </div>
          <div className="grid grid-cols-6 sm:grid-cols-8 gap-2">
            {VIBE_COLORS.map((c) => {
              const active = id.colorId === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => id.setColor(c.id)}
                  className={`relative aspect-square rounded-lg border-2 transition-transform active:scale-95 ${
                    active
                      ? "border-white shadow-[0_0_0_2px_rgba(255,255,255,0.15)]"
                      : "border-white/10"
                  }`}
                  style={{ background: c.hex }}
                  title={c.name}
                  aria-label={c.name}
                  aria-pressed={active}
                >
                  {active && (
                    <Check className="absolute inset-0 m-auto h-4 w-4 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]" />
                  )}
                </button>
              );
            })}
          </div>
        </section>

        {/* Account */}
        {id.user ? (
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 flex flex-col gap-3">
            <label className="text-[10px] uppercase tracking-[0.2em] text-white/45 font-semibold">
              Account
            </label>
            <div className="text-xs text-white/70 truncate">{id.user.email}</div>
            <button
              onClick={() => id.signOut()}
              className="self-start inline-flex items-center gap-1.5 text-xs text-rose-300 hover:text-rose-200 transition"
            >
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </button>
          </section>
        ) : (
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-xs text-white/60 leading-relaxed">
            You're browsing as a guest. Your character is saved on this
            device — sign in from the top nav to keep it across devices.
          </section>
        )}
      </div>
    </div>
  );
}
