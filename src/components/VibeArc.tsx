/**
 * VibeArc — the iridescent arch from /space, rendered standalone as
 * a hero ornament on /vibe. Same GLB + RoomEnvironment so the PBR
 * shimmer reads correctly.
 *
 * Idle behavior: slow Y rotation + gentle X bob + Y float.
 * Hover: rotation eases up to 4× and the canvas pops 1.04× scale.
 * Click: rolls a random "click animation" out of five — every click
 *        is one of:
 *          - pulse    : balloons to 1.8× then snaps back, spin x8
 *          - tumble   : multi-axis barrel roll, spin x6
 *          - dance    : canvas zooms out, traces a figure-8 around
 *                       its rest position, comes home
 *          - confetti : 14 sparks explode outward, fade
 *          - frenzy   : speed x12, jittery Z-shake, screen-shake
 *        Same anim never plays twice in a row.
 *
 * Drops anywhere a canvas can fit. Self-contained — no scene state
 * leaks in or out.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import iridescentArcUrl from "@/assets/glb/iridescent-arc.glb";
import { playSound, ensureAudioRunning } from "@/lib/vibey-sounds";

type ClickAnim = "pulse" | "tumble" | "dance" | "confetti" | "frenzy";
const ANIM_KINDS: ClickAnim[] = ["pulse", "tumble", "dance", "confetti", "frenzy"];
// Per-anim duration in seconds (must match the CSS keyframes for
// dance + confetti, and the math below for pulse / tumble / frenzy).
const ANIM_DURATION: Record<ClickAnim, number> = {
  pulse: 0.85,
  tumble: 1.6,
  dance: 2.2,
  confetti: 1.6,
  frenzy: 2.0,
};

interface Props {
  size?: number;
  rotateSeconds?: number;
  className?: string;
}

export default function VibeArc({ size = 260, rotateSeconds = 14, className = "" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Hover speed multiplier (4× when hovered, 1× idle). Ref so the
  // render loop reads fresh state without re-running the effect.
  const speedMultiplierRef = useRef(1);
  const [hovered, setHovered] = useState(false);
  // Click animation state — both a ref (for the Three.js loop) and
  // state (for CSS-driven animations like dance + confetti). Keys
  // increment on every click so re-triggering a CSS keyframe works.
  const clickAnimRef = useRef<{ kind: ClickAnim; startedAt: number } | null>(null);
  const [danceKey, setDanceKey] = useState(0);
  const [confettiKey, setConfettiKey] = useState(0);
  const [shakeKey, setShakeKey] = useState(0);
  const lastAnimRef = useRef<ClickAnim | null>(null);

  // Picks a random animation that isn't the one we just played, so
  // each click feels like a discovery.
  const pickNextAnim = (): ClickAnim => {
    const options = ANIM_KINDS.filter((a) => a !== lastAnimRef.current);
    return options[Math.floor(Math.random() * options.length)];
  };

  const handleClick = () => {
    const kind = pickNextAnim();
    lastAnimRef.current = kind;
    clickAnimRef.current = { kind, startedAt: performance.now() };
    // Sound + DOM key-bumps per kind.
    ensureAudioRunning();
    if (kind === "pulse") playSound("chirp");
    if (kind === "tumble") playSound("whoop");
    if (kind === "dance") {
      playSound("groove");
      setDanceKey((k) => k + 1);
    }
    if (kind === "confetti") {
      playSound("sparkle");
      setConfettiKey((k) => k + 1);
    }
    if (kind === "frenzy") {
      playSound("zip");
      setShakeKey((k) => k + 1);
    }
    // Auto-clear ref after duration so Three.js tick stops applying
    // the override. CSS-only effects clear themselves via keyframes.
    window.setTimeout(() => {
      if (clickAnimRef.current?.kind === kind) clickAnimRef.current = null;
    }, ANIM_DURATION[kind] * 1000 + 50);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size, size, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    const scene = new THREE.Scene();

    // RoomEnvironment makes iridescent PBR materials actually shimmer.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    // Camera framed loose so the arc has padding even at the bottom
    // of its bob.
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
    camera.position.set(0, 0.6, 9.4);
    camera.lookAt(0, 0, 0);

    const left = new THREE.DirectionalLight(0xff9bd8, 0.7);
    left.position.set(-5, 2, 4);
    scene.add(left);
    const right = new THREE.DirectionalLight(0x9be0ff, 0.7);
    right.position.set(5, 2, 4);
    scene.add(right);
    scene.add(new THREE.AmbientLight(0xffffff, 0.15));

    let arc: THREE.Group | null = null;
    // Baseline fit scale captured after the GLB loads so click anims
    // can scale relative to "rest" without losing the normalize.
    let fitScale = 1;

    new GLTFLoader().load(
      iridescentArcUrl,
      (gltf) => {
        arc = gltf.scene;
        const box = new THREE.Box3().setFromObject(arc);
        const sz = new THREE.Vector3();
        box.getSize(sz);
        const target = 4.5;
        fitScale = target / Math.max(sz.x, sz.y, sz.z, 0.0001);
        arc.scale.setScalar(fitScale);
        const center = new THREE.Vector3();
        box.getCenter(center);
        arc.position.x = -center.x * fitScale;
        arc.position.y = -center.y * fitScale;
        arc.position.z = -center.z * fitScale;
        arc.traverse((obj) => {
          const m = obj as THREE.Mesh;
          if (!m.isMesh) return;
          const apply = (mat: THREE.Material) => {
            const std = mat as THREE.MeshStandardMaterial;
            if (!std || !("metalness" in std)) return;
            std.metalness = Math.min(std.metalness, 0.3);
            std.roughness = Math.max(std.roughness, 0.35);
            if (std.map) {
              std.emissiveMap = std.map;
              std.emissive = new THREE.Color(0xffffff);
              std.emissiveIntensity = 0.55;
            }
            std.envMapIntensity = 1.2;
            std.needsUpdate = true;
          };
          const mat = m.material;
          if (Array.isArray(mat)) mat.forEach(apply);
          else if (mat) apply(mat);
        });
        scene.add(arc);
      },
      undefined,
      (err) => console.warn("[VibeArc] failed to load", err),
    );

    const clock = new THREE.Clock();
    const baseRate = (Math.PI * 2) / rotateSeconds;
    let currentMul = 1;
    let raf = 0;
    const tick = () => {
      const dt = clock.getDelta();
      const t = clock.elapsedTime;
      // Ease toward the hover speed multiplier.
      const target = speedMultiplierRef.current;
      currentMul += (target - currentMul) * Math.min(1, dt * 6);

      // Compute click-anim overrides per frame.
      let animScale = 1;
      let animSpeedMul = 1;
      let extraRotX = 0;
      let extraRotZ = 0;
      let extraEmissive = 0;
      const a = clickAnimRef.current;
      if (a && arc) {
        const elapsed = (performance.now() - a.startedAt) / 1000;
        const k = a.kind;
        if (k === "pulse") {
          // 0–0.18s: scale ramps to 1.85 (back-ease feel).
          // 0.18–0.85s: scale eases back to 1.0 with overshoot.
          // Speed multiplied throughout.
          if (elapsed < 0.18) {
            const p = elapsed / 0.18;
            animScale = 1 + 0.85 * (p * p);
          } else {
            const p = Math.min(1, (elapsed - 0.18) / 0.67);
            // Eased return with subtle bounce.
            const eased = 1 - Math.pow(1 - p, 3);
            animScale = 1.85 - 0.85 * eased + Math.sin(p * Math.PI) * 0.05;
          }
          animSpeedMul = 8;
          extraEmissive = (1 - Math.min(1, elapsed / 0.85)) * 0.6;
        } else if (k === "tumble") {
          // Full barrel roll on X, double-spin on Y, half on Z. All
          // ease together so the arc reads as gymnastic.
          const p = Math.min(1, elapsed / 1.6);
          const eased = p < 0.5
            ? 2 * p * p
            : 1 - Math.pow(-2 * p + 2, 2) / 2;
          extraRotX = eased * Math.PI * 1.4;
          extraRotZ = eased * Math.PI * 0.6;
          animSpeedMul = 6;
        } else if (k === "frenzy") {
          // Speed maxes out, Z shakes hard. Scale jitters slightly.
          animSpeedMul = 12;
          extraRotZ = Math.sin(elapsed * 22) * 0.35;
          animScale = 1 + Math.sin(elapsed * 24) * 0.06;
          extraEmissive = 0.35;
        }
        // dance + confetti are DOM-driven; no Three.js override.
      }

      if (arc) {
        arc.scale.setScalar(fitScale * animScale);
        arc.rotation.y += dt * baseRate * currentMul * animSpeedMul;
        arc.rotation.x = Math.sin(t * 0.5) * 0.08 + extraRotX;
        arc.rotation.z = extraRotZ;
        arc.position.y = Math.sin(t * 0.7) * 0.12;
        // Bump emissive on pulse/frenzy so the arc visibly flashes.
        if (extraEmissive !== 0) {
          arc.traverse((obj) => {
            const m = obj as THREE.Mesh;
            if (!m.isMesh) return;
            const apply = (mat: THREE.Material) => {
              const std = mat as THREE.MeshStandardMaterial;
              if (std && "emissiveIntensity" in std) {
                std.emissiveIntensity = 0.55 + extraEmissive;
              }
            };
            const mat = m.material;
            if (Array.isArray(mat)) mat.forEach(apply);
            else if (mat) apply(mat);
          });
        }
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      pmrem.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    };
  }, [size, rotateSeconds]);

  // Confetti palette + per-spark angle so each click looks unique.
  const CONFETTI_COUNT = 14;
  const CONFETTI_COLORS = ["#ff7fc8", "#8de3ff", "#a8ffd6", "#ffe27a", "#b392ff"];

  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: size,
        height: size,
        // Frenzy shakes the whole wrapper. Keyed so it restarts every
        // time frenzy fires.
        animation: shakeKey > 0 ? "vibe-arc-shake 0.5s ease-in-out" : undefined,
        // Restart the shake by keying the animation name → ensures
        // it replays on repeat frenzies.
        animationName: shakeKey > 0 ? `vibe-arc-shake-${shakeKey}` : undefined,
      }}
    >
      <canvas
        ref={canvasRef}
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
          display: "block",
          cursor: "pointer",
          // Hover scale + click-driven CSS dance path. The dance
          // keyframe handles the figure-8 movement on the canvas
          // itself, so the Three.js scene stays still and the
          // canvas as a whole rides the path.
          transform: hovered ? "scale(1.04)" : "scale(1)",
          transition: "transform 240ms cubic-bezier(.2,.7,.2,1)",
          animation:
            danceKey > 0
              ? `vibe-arc-dance ${ANIM_DURATION.dance}s cubic-bezier(.65,0,.35,1) ${danceKey}`
              : undefined,
          // Force keyframe restart by tagging a key into the name.
          animationName: danceKey > 0 ? `vibe-arc-dance-${danceKey}` : undefined,
        }}
        onMouseEnter={() => { speedMultiplierRef.current = 4; setHovered(true); }}
        onMouseLeave={() => { speedMultiplierRef.current = 1; setHovered(false); }}
        onClick={handleClick}
        aria-hidden="true"
      />

      {/* Confetti sparks — only mounted briefly. Key includes
          confettiKey so a re-trigger spawns a fresh set. */}
      {confettiKey > 0 && (
        <div
          key={confettiKey}
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
          }}
        >
          {Array.from({ length: CONFETTI_COUNT }).map((_, i) => {
            const angle = (i / CONFETTI_COUNT) * Math.PI * 2 + Math.random() * 0.4;
            const dist = 80 + Math.random() * 80;
            const dx = Math.cos(angle) * dist;
            const dy = Math.sin(angle) * dist;
            const rot = (Math.random() - 0.5) * 720;
            const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
            return (
              <span
                key={`${confettiKey}-${i}`}
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  width: 10,
                  height: 10,
                  marginLeft: -5,
                  marginTop: -5,
                  borderRadius: 9999,
                  background: color,
                  boxShadow: `0 0 10px ${color}`,
                  animation: `vibe-arc-spark-${confettiKey} ${ANIM_DURATION.confetti}s cubic-bezier(.2,.7,.2,1) forwards`,
                  // Each spark gets a custom translation via per-element keyframe
                  // injected via inline style — see <style> below.
                  ["--dx" as never]: `${dx}px`,
                  ["--dy" as never]: `${dy}px`,
                  ["--rot" as never]: `${rot}deg`,
                }}
              />
            );
          })}
          {/* Per-trigger keyframe injection — each confetti burst gets
              its own animation name so re-triggering restarts cleanly. */}
          <style>{`
            @keyframes vibe-arc-spark-${confettiKey} {
              0%   { transform: translate(0, 0) rotate(0deg) scale(0.4); opacity: 0; }
              15%  { transform: translate(calc(var(--dx) * 0.18), calc(var(--dy) * 0.18)) rotate(calc(var(--rot) * 0.18)) scale(1); opacity: 1; }
              100% { transform: translate(var(--dx), var(--dy)) rotate(var(--rot)) scale(0.6); opacity: 0; }
            }
          `}</style>
        </div>
      )}

      {/* Per-trigger CSS keyframes for dance + frenzy shake so the
          animations restart cleanly on each click. */}
      {danceKey > 0 && (
        <style>{`
          @keyframes vibe-arc-dance-${danceKey} {
            0%   { transform: translate(0, 0) scale(1); }
            15%  { transform: translate(-80px, -40px) scale(0.85) rotate(-12deg); }
            35%  { transform: translate(70px, -60px) scale(0.85) rotate(8deg); }
            55%  { transform: translate(80px, 50px) scale(0.85) rotate(14deg); }
            75%  { transform: translate(-70px, 30px) scale(0.9) rotate(-8deg); }
            100% { transform: translate(0, 0) scale(1) rotate(0deg); }
          }
        `}</style>
      )}
      {shakeKey > 0 && (
        <style>{`
          @keyframes vibe-arc-shake-${shakeKey} {
            0%   { transform: translate(0, 0); }
            15%  { transform: translate(-6px, 4px); }
            30%  { transform: translate(7px, -3px); }
            45%  { transform: translate(-4px, -5px); }
            60%  { transform: translate(5px, 6px); }
            75%  { transform: translate(-3px, -2px); }
            100% { transform: translate(0, 0); }
          }
        `}</style>
      )}
    </div>
  );
}
