/**
 * FruitNinja — a tiny Beat-Saber-style VR mini-game with full game loop.
 *
 * Game rules:
 *   - 60-second round. Click "Start" (or pull trigger in VR) to begin.
 *   - Slice fruits with the right controller blade for +points.
 *   - Slice multiple fruits within 1.2s to build a combo multiplier.
 *   - Avoid bombs (dark spiky orbs) — slicing one costs 5 points
 *     AND breaks your combo.
 *   - Missed fruits (fall to floor) cost 1 point.
 *   - When the timer hits zero, the round ends, score is locked,
 *     and best score is saved to localStorage.
 *
 * Desktop preview still spawns fruits so you can see it working;
 * the blade and slicing only happen in VR.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { releaseRenderer } from "@/lib/quality";
import { Link } from "react-router-dom";
import { ArrowLeft, Play, RotateCcw, Trophy, Clock } from "lucide-react";
import { enableVR } from "@/lib/webxr";

type Fruit = {
  group: THREE.Group;
  vel: THREE.Vector3;
  radius: number;
  alive: boolean;
  sliced: boolean;
  color: THREE.Color;
  isBomb: boolean;
};

type Shard = {
  mesh: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
};

const FRUIT_PALETTE = [
  { name: "watermelon", color: 0x2ecc40, inner: 0xff5577, points: 1 },
  { name: "orange", color: 0xff8c1a, inner: 0xffd27f, points: 1 },
  { name: "lime", color: 0x99e550, inner: 0xeaffc9, points: 1 },
  { name: "berry", color: 0x8e44ad, inner: 0xd6a3ff, points: 2 },
  { name: "lemon", color: 0xffd84d, inner: 0xfff4b0, points: 1 },
  { name: "gold", color: 0xffcf3a, inner: 0xfff1a8, points: 5 },
];

const ROUND_SECONDS = 60;
const COMBO_WINDOW = 1.2;
const BEST_KEY = "fruitninja.best";

type GameState = "idle" | "playing" | "ended";

export default function FruitNinja() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [score, setScore] = useState(0);
  const [misses, setMisses] = useState(0);
  const [combo, setCombo] = useState(0);
  const [timeLeft, setTimeLeft] = useState(ROUND_SECONDS);
  const [state, setState] = useState<GameState>("idle");
  const [best, setBest] = useState<number>(() => {
    const v = typeof window !== "undefined" ? Number(localStorage.getItem(BEST_KEY) || 0) : 0;
    return Number.isFinite(v) ? v : 0;
  });
  const [inVR, setInVR] = useState(false);

  // refs mirror state so the render loop reads fresh values without re-binding
  const stateRef = useRef<GameState>("idle");
  const scoreRef = useRef(0);
  const comboRef = useRef(0);
  const comboTimerRef = useRef(0);
  const timeLeftRef = useRef(ROUND_SECONDS);

  const startGame = () => {
    scoreRef.current = 0;
    comboRef.current = 0;
    comboTimerRef.current = 0;
    timeLeftRef.current = ROUND_SECONDS;
    setScore(0);
    setMisses(0);
    setCombo(0);
    setTimeLeft(ROUND_SECONDS);
    stateRef.current = "playing";
    setState("playing");
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1020);
    scene.fog = new THREE.Fog(0x0b1020, 12, 40);

    const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 200);
    camera.position.set(0, 1.6, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    scene.add(new THREE.HemisphereLight(0x88aaff, 0x222244, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(4, 8, 3);
    scene.add(sun);

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(6, 64),
      new THREE.MeshStandardMaterial({
        color: 0x1a2247,
        emissive: 0x1f2a55,
        emissiveIntensity: 0.4,
        roughness: 0.9,
      }),
    );
    disc.rotation.x = -Math.PI / 2;
    scene.add(disc);

    for (let i = 1; i <= 3; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(i * 1.4, i * 1.4 + 0.03, 64),
        new THREE.MeshBasicMaterial({ color: 0x4af0c4, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.005;
      scene.add(ring);
    }

    const stars = new THREE.Points(
      (() => {
        const g = new THREE.BufferGeometry();
        const N = 800;
        const arr = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
          const r = 30 + Math.random() * 20;
          const t = Math.random() * Math.PI * 2;
          const p = Math.acos(2 * Math.random() - 1);
          arr[i * 3] = r * Math.sin(p) * Math.cos(t);
          arr[i * 3 + 1] = Math.abs(r * Math.cos(p));
          arr[i * 3 + 2] = r * Math.sin(p) * Math.sin(t);
        }
        g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
        return g;
      })(),
      new THREE.PointsMaterial({ color: 0xffffff, size: 0.08 }),
    );
    scene.add(stars);

    const cleanupVR = enableVR(renderer, mount, { referenceSpace: "local-floor" });

    const buildBlade = () => {
      const g = new THREE.Group();
      const handle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.025, 0.14, 16),
        new THREE.MeshStandardMaterial({ color: 0x222233, roughness: 0.5 }),
      );
      handle.position.set(0, 0, -0.07);
      handle.rotation.x = Math.PI / 2;
      g.add(handle);
      const blade = new THREE.Mesh(
        new THREE.BoxGeometry(0.025, 0.012, 0.7),
        new THREE.MeshStandardMaterial({
          color: 0x66ffe0,
          emissive: 0x4af0c4,
          emissiveIntensity: 2.2,
          roughness: 0.2,
          metalness: 0.4,
        }),
      );
      blade.position.set(0, 0, -0.5);
      g.add(blade);
      const tip = new THREE.Object3D();
      tip.position.set(0, 0, -0.85);
      g.add(tip);
      (g as any).__tip = tip;
      return g;
    };

    let activeBlade: THREE.Group | null = null;
    const tipPrev = new THREE.Vector3();
    const tipNow = new THREE.Vector3();

    const setupController = (idx: number) => {
      const c = renderer.xr.getController(idx);
      scene.add(c);
      // Trigger to start / restart a round.
      c.addEventListener("selectstart", () => {
        if (stateRef.current !== "playing") startGame();
      });
      c.addEventListener("connected", (ev: any) => {
        const hand = ev?.data?.handedness;
        if (hand === "right" || !activeBlade) {
          if (activeBlade && activeBlade.parent) activeBlade.parent.remove(activeBlade);
          const blade = buildBlade();
          c.add(blade);
          activeBlade = blade;
          const tip = (blade as any).__tip as THREE.Object3D;
          tip.getWorldPosition(tipPrev);
        }
      });
      c.addEventListener("disconnected", () => {
        if (activeBlade && activeBlade.parent === c) {
          c.remove(activeBlade);
          activeBlade = null;
        }
      });
    };
    setupController(0);
    setupController(1);

    renderer.xr.addEventListener("sessionstart", () => setInVR(true));
    renderer.xr.addEventListener("sessionend", () => setInVR(false));

    const fruits: Fruit[] = [];
    const shards: Shard[] = [];

    const spawnFruit = () => {
      // 12% chance to spawn a bomb once we're a bit warmed up.
      const isBomb = Math.random() < 0.12;
      const palette = FRUIT_PALETTE[Math.floor(Math.random() * FRUIT_PALETTE.length)];
      const radius = 0.13 + Math.random() * 0.07;
      const group = new THREE.Group();

      if (isBomb) {
        const bomb = new THREE.Mesh(
          new THREE.IcosahedronGeometry(radius, 0),
          new THREE.MeshStandardMaterial({
            color: 0x1a1a22,
            emissive: 0xff2244,
            emissiveIntensity: 0.6,
            roughness: 0.4,
            metalness: 0.6,
          }),
        );
        group.add(bomb);
        const fuse = new THREE.Mesh(
          new THREE.SphereGeometry(radius * 0.18, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0xff6622 }),
        );
        fuse.position.y = radius;
        group.add(fuse);
      } else {
        const ball = new THREE.Mesh(
          new THREE.SphereGeometry(radius, 24, 18),
          new THREE.MeshStandardMaterial({
            color: palette.color,
            roughness: 0.55,
            emissive: palette.color,
            emissiveIntensity: 0.18,
          }),
        );
        group.add(ball);
        const leaf = new THREE.Mesh(
          new THREE.ConeGeometry(radius * 0.4, radius * 0.6, 8),
          new THREE.MeshStandardMaterial({ color: 0x2ecc40, roughness: 0.7 }),
        );
        leaf.position.y = radius * 0.95;
        leaf.rotation.z = 0.3;
        group.add(leaf);
      }

      const side = (Math.random() - 0.5) * 2.4;
      group.position.set(side, 0.2, -3.2 - Math.random() * 0.8);
      const vy = 4.2 + Math.random() * 0.8;
      const vx = -side * 0.25;
      const vz = 1.6 + Math.random() * 0.8;
      const vel = new THREE.Vector3(vx, vy, vz);

      scene.add(group);
      fruits.push({
        group,
        vel,
        radius,
        alive: true,
        sliced: false,
        color: new THREE.Color(isBomb ? 0xff2244 : palette.color),
        isBomb,
      });
      (fruits[fruits.length - 1] as any).__points = palette.points;
    };

    const burst = (pos: THREE.Vector3, color: THREE.Color, radius: number, sliceDir: THREE.Vector3) => {
      const perp = new THREE.Vector3(-sliceDir.z, 0, sliceDir.x).normalize();
      for (let s = -1; s <= 1; s += 2) {
        const half = new THREE.Mesh(
          new THREE.SphereGeometry(radius, 18, 12, 0, Math.PI),
          new THREE.MeshStandardMaterial({
            color,
            roughness: 0.55,
            emissive: color,
            emissiveIntensity: 0.25,
            side: THREE.DoubleSide,
          }),
        );
        half.position.copy(pos);
        half.rotation.y = s > 0 ? 0 : Math.PI;
        scene.add(half);
        const v = sliceDir.clone().multiplyScalar(0.4);
        v.addScaledVector(perp, s * 1.6);
        v.y += 1.2;
        shards.push({
          mesh: half,
          vel: v,
          spin: new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6),
          life: 1.4,
        });
      }
    };

    const sliceFruit = (f: Fruit, sliceDir: THREE.Vector3) => {
      f.sliced = true;
      f.alive = false;
      scene.remove(f.group);
      burst(f.group.position, f.color, f.radius, sliceDir);

      if (f.isBomb) {
        // Penalty: lose 5, break combo.
        comboRef.current = 0;
        comboTimerRef.current = 0;
        scoreRef.current = Math.max(0, scoreRef.current - 5);
        setCombo(0);
        setScore(scoreRef.current);
        return;
      }

      // Build combo
      comboRef.current = comboRef.current + 1;
      comboTimerRef.current = COMBO_WINDOW;
      const mult = Math.min(5, 1 + Math.floor((comboRef.current - 1) / 2));
      const base = (f as any).__points ?? 1;
      scoreRef.current += base * mult;
      setCombo(comboRef.current);
      setScore(scoreRef.current);
    };

    const tmpSeg = new THREE.Vector3();
    const tmpAB = new THREE.Vector3();
    const tmpAP = new THREE.Vector3();
    const segDist = (a: THREE.Vector3, b: THREE.Vector3, p: THREE.Vector3) => {
      tmpAB.subVectors(b, a);
      tmpAP.subVectors(p, a);
      const len2 = tmpAB.lengthSq();
      if (len2 < 1e-6) return tmpAP.length();
      const t = Math.max(0, Math.min(1, tmpAP.dot(tmpAB) / len2));
      tmpSeg.copy(a).addScaledVector(tmpAB, t);
      return tmpSeg.distanceTo(p);
    };

    let lastTime = 0;
    let spawnTimer = 0;
    let firstFrame = true;

    renderer.setAnimationLoop((time) => {
      const t = time * 0.001;
      const dt = Math.min(0.05, t - lastTime || 0.016);
      lastTime = t;

      const playing = stateRef.current === "playing";

      // Tick timer
      if (playing) {
        timeLeftRef.current -= dt;
        if (timeLeftRef.current <= 0) {
          timeLeftRef.current = 0;
          stateRef.current = "ended";
          setState("ended");
          setBest((prev) => {
            const next = Math.max(prev, scoreRef.current);
            try {
              localStorage.setItem(BEST_KEY, String(next));
            } catch {
              /* */
            }
            return next;
          });
        }
        setTimeLeft(Math.ceil(timeLeftRef.current));

        // Combo decay
        if (comboTimerRef.current > 0) {
          comboTimerRef.current -= dt;
          if (comboTimerRef.current <= 0) {
            comboRef.current = 0;
            setCombo(0);
          }
        }
      }

      // Spawn (slightly faster as round progresses)
      if (playing) {
        spawnTimer -= dt;
        if (spawnTimer <= 0) {
          spawnFruit();
          const elapsed = ROUND_SECONDS - timeLeftRef.current;
          const cadence = Math.max(0.45, 0.95 - elapsed * 0.008);
          spawnTimer = cadence + Math.random() * 0.4;
        }
      } else if (stateRef.current === "idle") {
        // Idle preview: gently spawn fruit so it looks alive.
        spawnTimer -= dt;
        if (spawnTimer <= 0) {
          spawnFruit();
          spawnTimer = 1.4 + Math.random() * 0.8;
        }
      }

      // Blade tip sample
      let haveBlade = false;
      const sliceDir = new THREE.Vector3();
      if (activeBlade) {
        const tip = (activeBlade as any).__tip as THREE.Object3D;
        tip.getWorldPosition(tipNow);
        if (firstFrame) tipPrev.copy(tipNow);
        sliceDir.subVectors(tipNow, tipPrev);
        haveBlade = sliceDir.length() > 0.02;
      }

      // Update fruits
      const g = 9.8;
      for (const f of fruits) {
        if (!f.alive) continue;
        f.vel.y -= g * dt;
        f.group.position.addScaledVector(f.vel, dt);
        f.group.rotation.x += dt * 1.6;
        f.group.rotation.z += dt * 1.2;

        if (playing && haveBlade && activeBlade) {
          const d = segDist(tipPrev, tipNow, f.group.position);
          if (d < f.radius + 0.04) {
            sliceFruit(f, sliceDir.clone().normalize());
            continue;
          }
        }

        if (f.group.position.y < -0.5) {
          f.alive = false;
          scene.remove(f.group);
          if (playing && !f.isBomb) {
            comboRef.current = 0;
            comboTimerRef.current = 0;
            scoreRef.current = Math.max(0, scoreRef.current - 1);
            setCombo(0);
            setScore(scoreRef.current);
            setMisses((n) => n + 1);
          }
        }
      }
      for (let i = fruits.length - 1; i >= 0; i--) if (!fruits[i].alive) fruits.splice(i, 1);

      for (const s of shards) {
        s.vel.y -= g * dt;
        s.mesh.position.addScaledVector(s.vel, dt);
        s.mesh.rotation.x += s.spin.x * dt;
        s.mesh.rotation.y += s.spin.y * dt;
        s.mesh.rotation.z += s.spin.z * dt;
        s.life -= dt;
      }
      for (let i = shards.length - 1; i >= 0; i--) {
        if (shards[i].life <= 0 || shards[i].mesh.position.y < -1) {
          scene.remove(shards[i].mesh);
          shards.splice(i, 1);
        }
      }

      if (!renderer.xr.isPresenting) {
        camera.position.set(Math.sin(t * 0.3) * 0.3, 1.6, 0.4);
        camera.lookAt(0, 1.4, -3);
      }

      tipPrev.copy(tipNow);
      firstFrame = false;

      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      cleanupVR();
      try {
        mount.removeChild(renderer.domElement);
      } catch {
        /* */
      }
      /* releaseRenderer, not dispose: three r160's dispose() drops its own caches and
         leaves the GL context to the garbage collector. See docs/performance.md. */
      releaseRenderer(renderer);
    };
  }, []);

  const mm = Math.floor(timeLeft / 60);
  const ss = (timeLeft % 60).toString().padStart(2, "0");

  return (
    <div className="fixed inset-0 bg-background">
      <div ref={mountRef} className="absolute inset-0" />

      {/* Top HUD */}
      <div className="absolute top-16 left-1/2 -translate-x-1/2 z-10 flex gap-2 pointer-events-none flex-wrap justify-center">
        <div className="glass-panel rounded-full px-4 py-2 border border-border/60 backdrop-blur flex items-center gap-2">
          <Clock className="w-3.5 h-3.5 text-primary" />
          <span className="text-foreground font-bold tabular-nums">
            {mm}:{ss}
          </span>
        </div>
        <div className="glass-panel rounded-full px-4 py-2 border border-border/60 backdrop-blur">
          <span className="text-[10.5px] font-heading font-semibold tracking-wider uppercase text-muted-foreground mr-2">
            Score
          </span>
          <span className="text-foreground font-bold tabular-nums">{score}</span>
        </div>
        {combo > 1 && (
          <div className="glass-panel rounded-full px-4 py-2 border border-primary/60 backdrop-blur animate-pulse">
            <span className="text-primary font-bold">×{combo} combo</span>
          </div>
        )}
        <div className="glass-panel rounded-full px-4 py-2 border border-border/60 backdrop-blur flex items-center gap-1.5">
          <Trophy className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-foreground font-bold tabular-nums">{best}</span>
        </div>
        <div className="glass-panel rounded-full px-4 py-2 border border-border/60 backdrop-blur">
          <span className="text-[10.5px] font-heading font-semibold tracking-wider uppercase text-muted-foreground mr-2">
            Missed
          </span>
          <span className="text-foreground font-bold tabular-nums">{misses}</span>
        </div>
      </div>

      <Link
        to="/"
        className="absolute top-3 left-3 z-10 glass-panel rounded-full px-3 py-2 border border-border/60 backdrop-blur flex items-center gap-1.5 text-xs font-heading font-semibold tracking-wider uppercase hover:bg-muted/50"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back
      </Link>

      {/* Start / End overlay */}
      {state !== "playing" && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <div className="glass-panel pointer-events-auto rounded-3xl px-8 py-7 border border-border/60 backdrop-blur max-w-sm text-center shadow-2xl">
            <div className="text-[10.5px] font-heading font-semibold tracking-[0.2em] uppercase text-primary mb-2">
              Fruit Ninja · VR
            </div>
            {state === "idle" ? (
              <>
                <h1 className="text-2xl font-heading font-bold mb-2">Slice as many as you can in 60s</h1>
                <p className="text-xs text-muted-foreground leading-relaxed mb-5">
                  Build combos for multipliers. Avoid the red spiky <span className="text-foreground font-semibold">bombs</span> —
                  they cost 5 points. Missed fruit costs 1.
                  {!inVR && <> Put on your Quest and tap <span className="text-foreground font-semibold">ENTER VR</span> to play.</>}
                </p>
              </>
            ) : (
              <>
                <h1 className="text-2xl font-heading font-bold mb-1">Time&apos;s up!</h1>
                <p className="text-xs text-muted-foreground mb-1">
                  Final score
                </p>
                <div className="text-4xl font-heading font-bold text-primary mb-1 tabular-nums">{score}</div>
                <p className="text-[11px] text-muted-foreground mb-5 flex items-center justify-center gap-1.5">
                  <Trophy className="w-3 h-3 text-amber-400" /> Best {best}
                </p>
              </>
            )}
            <button
              onClick={startGame}
              className="inline-flex items-center gap-2 rounded-full bg-primary text-primary-foreground px-5 py-2.5 text-sm font-heading font-semibold tracking-wider uppercase hover:opacity-90 transition"
            >
              {state === "idle" ? <Play className="w-4 h-4" /> : <RotateCcw className="w-4 h-4" />}
              {state === "idle" ? "Start round" : "Play again"}
            </button>
            {inVR && (
              <p className="mt-3 text-[10px] text-muted-foreground">Or pull the trigger to start</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
