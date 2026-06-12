/**
 * FruitNinja — a tiny Beat-Saber-style VR mini-game.
 *
 * Goal: prove out single-controller VR interaction on the Quest with
 * the existing tech stack. Put on the headset, hit "Enter VR", and
 * swing the right controller through fruits as they fly up.
 *
 * How it works:
 *   - Standard Three.js renderer + enableVR() helper (already used
 *     by Museum / Garden) so we get a VRButton on supported devices.
 *   - We mount the right XR controller via renderer.xr.getController(1)
 *     AND getController(0) — Quest enumerates either side first, so
 *     we just attach a blade to whichever controller reports
 *     handedness === "right" (falling back to controller 0).
 *   - Each frame we sample the blade tip's world position and compare
 *     to the previous frame. If that line segment passes within a
 *     fruit's radius, we count it as a slice: fruit splits into two
 *     halves with a quick physics arc, score ticks up.
 *   - Desktop preview (no headset) still renders the scene with an
 *     orbit-ish fixed camera so you can see fruits flying and verify
 *     it builds. The blade only appears once you enter VR.
 *
 * No new deps — everything is built-in three.js.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { enableVR } from "@/lib/webxr";

type Fruit = {
  group: THREE.Group;
  vel: THREE.Vector3;
  radius: number;
  alive: boolean;
  sliced: boolean;
  color: THREE.Color;
};

type Shard = {
  mesh: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
};

const FRUIT_PALETTE = [
  { name: "watermelon", color: 0x2ecc40, inner: 0xff5577 },
  { name: "orange", color: 0xff8c1a, inner: 0xffd27f },
  { name: "lime", color: 0x99e550, inner: 0xeaffc9 },
  { name: "berry", color: 0x8e44ad, inner: 0xd6a3ff },
  { name: "lemon", color: 0xffd84d, inner: 0xfff4b0 },
];

export default function FruitNinja() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [score, setScore] = useState(0);
  const [misses, setMisses] = useState(0);
  const [inVR, setInVR] = useState(false);

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

    // -- world --------------------------------------------------------
    scene.add(new THREE.HemisphereLight(0x88aaff, 0x222244, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(4, 8, 3);
    scene.add(sun);

    // Soft glowing arena disc on the floor for orientation in VR.
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

    // Concentric neon rings (cheap "stage" vibe).
    for (let i = 1; i <= 3; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(i * 1.4, i * 1.4 + 0.03, 64),
        new THREE.MeshBasicMaterial({ color: 0x4af0c4, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.005;
      scene.add(ring);
    }

    // Starfield backdrop.
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

    // -- VR + controller blade ---------------------------------------
    const cleanupVR = enableVR(renderer, mount, { referenceSpace: "local-floor" });

    const buildBlade = () => {
      const g = new THREE.Group();
      // Handle
      const handle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.025, 0.14, 16),
        new THREE.MeshStandardMaterial({ color: 0x222233, roughness: 0.5 }),
      );
      handle.position.set(0, 0, -0.07);
      handle.rotation.x = Math.PI / 2;
      g.add(handle);
      // Glow blade — long thin box pointing -Z (controller forward).
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
      // Tip marker — invisible, used for collision sampling.
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
      c.addEventListener("connected", (ev: any) => {
        const hand = ev?.data?.handedness;
        // Prefer right hand. If we haven't picked one yet, accept any.
        if (hand === "right" || !activeBlade) {
          if (activeBlade && activeBlade.parent) activeBlade.parent.remove(activeBlade);
          const blade = buildBlade();
          c.add(blade);
          activeBlade = blade;
          // Reset prev so the very first frame doesn't draw a huge segment.
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

    // -- fruits -------------------------------------------------------
    const fruits: Fruit[] = [];
    const shards: Shard[] = [];

    const spawnFruit = () => {
      const palette = FRUIT_PALETTE[Math.floor(Math.random() * FRUIT_PALETTE.length)];
      const radius = 0.13 + Math.random() * 0.07;
      const group = new THREE.Group();
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
      // Tiny leaf so it reads as fruit, not just a ball.
      const leaf = new THREE.Mesh(
        new THREE.ConeGeometry(radius * 0.4, radius * 0.6, 8),
        new THREE.MeshStandardMaterial({ color: 0x2ecc40, roughness: 0.7 }),
      );
      leaf.position.y = radius * 0.95;
      leaf.rotation.z = 0.3;
      group.add(leaf);

      // Launch from ~3m away, in front of the player, arcing up & toward them.
      const side = (Math.random() - 0.5) * 2.4;
      group.position.set(side, 0.2, -3.2 - Math.random() * 0.8);
      const toward = new THREE.Vector3(-side * 0.25, 4.2 + Math.random() * 0.8, 2.4 + Math.random() * 0.8);
      // Convert "target velocity" — pretend gravity = 9.8, choose vy so peak ~ 1.8-2.2 m
      const vy = 4.2 + Math.random() * 0.8;
      const vx = (-side) * 0.25;
      const vz = 1.6 + Math.random() * 0.8; // toward camera (camera looks -Z, fruit at -Z, so +Z moves toward 0)
      const vel = new THREE.Vector3(vx, vy, vz);
      void toward;

      scene.add(group);
      fruits.push({
        group,
        vel,
        radius,
        alive: true,
        sliced: false,
        color: new THREE.Color(palette.color),
      });
    };

    const sliceFruit = (f: Fruit, sliceDir: THREE.Vector3) => {
      f.sliced = true;
      f.alive = false;
      scene.remove(f.group);
      // Two halves: hemispheres flying apart along sliceDir's perpendicular.
      const perp = new THREE.Vector3(-sliceDir.z, 0, sliceDir.x).normalize();
      for (let s = -1; s <= 1; s += 2) {
        const half = new THREE.Mesh(
          new THREE.SphereGeometry(f.radius, 18, 12, 0, Math.PI),
          new THREE.MeshStandardMaterial({
            color: f.color,
            roughness: 0.55,
            emissive: f.color,
            emissiveIntensity: 0.25,
            side: THREE.DoubleSide,
          }),
        );
        half.position.copy(f.group.position);
        half.rotation.y = s > 0 ? 0 : Math.PI;
        scene.add(half);
        const v = f.vel.clone().multiplyScalar(0.4);
        v.addScaledVector(perp, s * 1.6);
        v.y += 1.2;
        shards.push({
          mesh: half,
          vel: v,
          spin: new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6),
          life: 1.4,
        });
      }
      setScore((n) => n + 1);
    };

    // -- main loop ----------------------------------------------------
    const tmpSeg = new THREE.Vector3();
    const tmpAB = new THREE.Vector3();
    const tmpAP = new THREE.Vector3();

    /** Distance from point P to segment AB. */
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

      // Spawn fruits at a chill cadence.
      spawnTimer -= dt;
      if (spawnTimer <= 0) {
        spawnFruit();
        spawnTimer = 0.9 + Math.random() * 0.6;
      }

      // Sample blade tip world position this frame.
      let haveBlade = false;
      const sliceDir = new THREE.Vector3();
      if (activeBlade) {
        const tip = (activeBlade as any).__tip as THREE.Object3D;
        tip.getWorldPosition(tipNow);
        if (firstFrame) tipPrev.copy(tipNow);
        sliceDir.subVectors(tipNow, tipPrev);
        haveBlade = sliceDir.length() > 0.02; // must actually swing
      }

      // Update fruits.
      const g = 9.8;
      for (const f of fruits) {
        if (!f.alive) continue;
        f.vel.y -= g * dt;
        f.group.position.addScaledVector(f.vel, dt);
        f.group.rotation.x += dt * 1.6;
        f.group.rotation.z += dt * 1.2;

        // Slice test
        if (haveBlade && activeBlade) {
          const d = segDist(tipPrev, tipNow, f.group.position);
          if (d < f.radius + 0.04) {
            sliceFruit(f, sliceDir.clone().normalize());
            continue;
          }
        }

        // Missed (fell below floor)
        if (f.group.position.y < -0.5) {
          f.alive = false;
          scene.remove(f.group);
          setMisses((n) => n + 1);
        }
      }
      // Cleanup
      for (let i = fruits.length - 1; i >= 0; i--) if (!fruits[i].alive) fruits.splice(i, 1);

      // Update shards.
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

      // Gentle camera bob on desktop preview (camera is static in VR — headset drives it).
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
      renderer.dispose();
    };
  }, []);

  return (
    <div className="fixed inset-0 bg-background">
      <div ref={mountRef} className="absolute inset-0" />

      {/* HUD */}
      <div className="absolute top-16 left-1/2 -translate-x-1/2 z-10 flex gap-3 pointer-events-none">
        <div className="glass-panel rounded-full px-4 py-2 border border-border/60 backdrop-blur">
          <span className="text-[10.5px] font-heading font-semibold tracking-wider uppercase text-muted-foreground mr-2">
            Sliced
          </span>
          <span className="text-foreground font-bold">{score}</span>
        </div>
        <div className="glass-panel rounded-full px-4 py-2 border border-border/60 backdrop-blur">
          <span className="text-[10.5px] font-heading font-semibold tracking-wider uppercase text-muted-foreground mr-2">
            Missed
          </span>
          <span className="text-foreground font-bold">{misses}</span>
        </div>
      </div>

      <Link
        to="/"
        className="absolute top-3 left-3 z-10 glass-panel rounded-full px-3 py-2 border border-border/60 backdrop-blur flex items-center gap-1.5 text-xs font-heading font-semibold tracking-wider uppercase hover:bg-muted/50"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back
      </Link>

      {!inVR && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-10 max-w-md text-center px-4 pointer-events-none">
          <div className="glass-panel rounded-2xl px-5 py-3 border border-border/60 backdrop-blur">
            <div className="text-[10.5px] font-heading font-semibold tracking-wider uppercase text-primary mb-1">
              Fruit Ninja · VR
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Put on your Quest, tap <span className="text-foreground font-semibold">ENTER VR</span> (bottom-right),
              then swing your right controller through the fruits. A glowing blade attaches automatically.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
