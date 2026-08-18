/**
 * StartBackdrop — a live 3D postcard of the VibeVerse behind /start.
 *
 * The onboarding used to lean on the poster image, which doesn't load
 * on every host (mobile on myvibeverse.com saw a flat gradient). This
 * replaces it with the real thing in miniature: a procedural floating
 * island with a tiny glowing town, sister islets, drifting clouds, a
 * zeppelin on patrol and a slow orbiting camera. No assets to fetch —
 * it works everywhere, first paint, phone-cheap (~40 low-poly meshes,
 * pixel ratio capped).
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { releaseRenderer } from "@/lib/quality";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export default function StartBackdrop({ companionUrl }: { companionUrl?: string }) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        // Kept on so headless tests (and photo mode) can read the canvas.
        preserveDrawingBuffer: true,
        powerPreference: "low-power",
      });
    } catch {
      return; // no WebGL — the CSS gradient behind us carries the scene
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog("#79b7ec", 60, 210);
    const camera = new THREE.PerspectiveCamera(
      52,
      mount.clientWidth / Math.max(1, mount.clientHeight),
      0.1,
      400,
    );

    scene.add(new THREE.AmbientLight(0xbfd9ff, 1.1));
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.9);
    sun.position.set(40, 60, 25);
    scene.add(sun);

    // ---- An island factory: rock cone, grass cap, tiny town ----------
    const makeIsland = (r: number, withTown: boolean) => {
      const g = new THREE.Group();
      const rock = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r * 0.22, r * 1.15, 8, 1),
        new THREE.MeshLambertMaterial({ color: "#8a6a4d", flatShading: true }),
      );
      rock.position.y = -r * 0.58;
      g.add(rock);
      const grass = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 1.04, r * 1.0, r * 0.16, 10),
        new THREE.MeshLambertMaterial({ color: "#63c56c", flatShading: true }),
      );
      g.add(grass);
      if (withTown) {
        const roofColors = ["#ff7a5c", "#7ad7ff", "#ffd166", "#b78aff", "#5fd068"];
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + 0.4;
          const rr = r * (0.28 + (i % 3) * 0.18);
          const hx = Math.cos(a) * rr;
          const hz = Math.sin(a) * rr;
          const h = 1.1 + (i % 3) * 0.5;
          const house = new THREE.Mesh(
            new THREE.BoxGeometry(1.2, h, 1.2),
            new THREE.MeshLambertMaterial({ color: "#f0e6d2" }),
          );
          house.position.set(hx, h / 2 + r * 0.08, hz);
          g.add(house);
          const roof = new THREE.Mesh(
            new THREE.ConeGeometry(1.05, 0.9, 4),
            new THREE.MeshLambertMaterial({ color: roofColors[i % roofColors.length], flatShading: true }),
          );
          roof.position.set(hx, h + 0.5 + r * 0.08, hz);
          roof.rotation.y = Math.PI / 4;
          g.add(roof);
        }
        // A tiny welcome arch at the rim + the god orb above it all.
        const archMat = new THREE.MeshLambertMaterial({ color: "#f6f2ff" });
        for (const s of [-1, 1]) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.2, 0.3), archMat);
          post.position.set(r * 0.82, 1.1 + r * 0.08, s * 1.1);
          g.add(post);
        }
        const lintel = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.4, 2.7), archMat);
        lintel.position.set(r * 0.82, 2.3 + r * 0.08, 0);
        g.add(lintel);
        const orb = new THREE.Mesh(
          new THREE.SphereGeometry(1.15, 16, 12),
          new THREE.MeshBasicMaterial({ color: "#ffe9b3", transparent: true, opacity: 0.95 }),
        );
        orb.position.set(0, r * 0.95, 0);
        g.add(orb);
        // Additive halo so it reads as a glowing wish-orb, not a tan
        // ball — the pulse is driven from the tick via this name.
        const haloCanvas = document.createElement("canvas");
        haloCanvas.width = haloCanvas.height = 64;
        const hx = haloCanvas.getContext("2d")!;
        const grad = hx.createRadialGradient(32, 32, 2, 32, 32, 31);
        grad.addColorStop(0, "rgba(255,236,190,0.95)");
        grad.addColorStop(0.4, "rgba(255,214,120,0.45)");
        grad.addColorStop(1, "rgba(255,209,102,0)");
        hx.fillStyle = grad;
        hx.fillRect(0, 0, 64, 64);
        const halo = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: new THREE.CanvasTexture(haloCanvas),
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            fog: false,
          }),
        );
        halo.name = "orbHalo";
        halo.scale.setScalar(6);
        halo.position.copy(orb.position);
        g.add(halo);
        const orbGlow = new THREE.PointLight(0xffd166, 12, 26, 2);
        orbGlow.position.copy(orb.position);
        g.add(orbGlow);
      }
      return g;
    };

    const island = makeIsland(9, true);
    island.position.set(0, 2, 0);
    scene.add(island);

    // Sister islets straight off the poster: the great tree, the neon
    // city, the red pagoda.
    const treeIslet = makeIsland(4.2, false);
    treeIslet.position.set(-24, 9, -16);
    {
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.7, 3.4, 8),
        new THREE.MeshLambertMaterial({ color: "#7a5433", flatShading: true }),
      );
      trunk.position.y = 1.9;
      treeIslet.add(trunk);
      const leaf = new THREE.MeshLambertMaterial({ color: "#4aa554", flatShading: true });
      for (const [lx, ly, lz, r] of [
        [0, 4.4, 0, 2.4],
        [-1.6, 3.4, 0.4, 1.5],
        [1.5, 3.6, -0.5, 1.6],
      ] as const) {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), leaf);
        puff.position.set(lx, ly, lz);
        treeIslet.add(puff);
      }
    }
    scene.add(treeIslet);

    const cityIslet = makeIsland(5, false);
    cityIslet.position.set(20, 14, -30);
    {
      const glass = new THREE.MeshLambertMaterial({ color: "#9fd4ff", emissive: "#2a6cb0" });
      for (let i = 0; i < 6; i++) {
        const h = 2 + (i % 4) * 1.4;
        const tower = new THREE.Mesh(new THREE.BoxGeometry(1, h, 1), glass);
        const a = (i / 6) * Math.PI * 2;
        tower.position.set(Math.cos(a) * 2.2, h / 2 + 0.4, Math.sin(a) * 2.2);
        cityIslet.add(tower);
      }
    }
    scene.add(cityIslet);

    const pagodaIslet = makeIsland(3.4, false);
    pagodaIslet.position.set(26, 6, -8);
    {
      const wall = new THREE.MeshLambertMaterial({ color: "#e8dcc4" });
      const roof = new THREE.MeshLambertMaterial({ color: "#c0392b", flatShading: true });
      for (let lvl = 0; lvl < 3; lvl++) {
        const w = 2.4 - lvl * 0.6;
        const box = new THREE.Mesh(new THREE.BoxGeometry(w, 0.9, w), wall);
        box.position.y = 0.75 + lvl * 1.35;
        pagodaIslet.add(box);
        const cap = new THREE.Mesh(new THREE.ConeGeometry(w * 0.95, 0.7, 4), roof);
        cap.position.y = 1.45 + lvl * 1.35;
        cap.rotation.y = Math.PI / 4;
        pagodaIslet.add(cap);
      }
    }
    scene.add(pagodaIslet);

    // Moon, far and high.
    const moon = new THREE.Mesh(
      new THREE.SphereGeometry(4, 14, 12),
      new THREE.MeshLambertMaterial({ color: "#cfd4dd", flatShading: true }),
    );
    moon.position.set(34, 30, -60);
    scene.add(moon);

    // Zeppelin on patrol.
    const zep = new THREE.Group();
    const hull = new THREE.Mesh(
      new THREE.CapsuleGeometry(1.4, 4.4, 6, 10),
      new THREE.MeshLambertMaterial({ color: "#e8e2d4" }),
    );
    hull.rotation.z = Math.PI / 2;
    zep.add(hull);
    const gondola = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.5, 0.7),
      new THREE.MeshLambertMaterial({ color: "#6b4f35" }),
    );
    gondola.position.y = -1.6;
    zep.add(gondola);
    scene.add(zep);

    // Puffy clouds — opaque lambert clusters, VibeVerse house style.
    const cloudMat = new THREE.MeshLambertMaterial({ color: "#ffffff" });
    const clouds: Array<{ g: THREE.Group; speed: number }> = [];
    for (let i = 0; i < 9; i++) {
      const c = new THREE.Group();
      const n = 3 + (i % 3);
      for (let p = 0; p < n; p++) {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(1.6 + (p % 2), 10, 8), cloudMat);
        puff.position.set(p * 1.9 - n, (p % 2) * 0.7, (p % 3) * 0.8);
        puff.scale.y = 0.72;
        c.add(puff);
      }
      const a = (i / 9) * Math.PI * 2;
      c.position.set(Math.cos(a) * (26 + (i % 4) * 9), 8 + (i % 5) * 4.5, Math.sin(a) * (26 + (i % 3) * 11));
      scene.add(c);
      clouds.push({ g: c, speed: 0.35 + (i % 3) * 0.22 });
    }

    // Vibey rides along in the corner of the frame — your guide, seen
    // slightly from behind, looking into the vista like on the poster.
    scene.add(camera);
    let companionMixer: THREE.AnimationMixer | null = null;
    if (companionUrl) {
      new GLTFLoader().load(
        companionUrl,
        (gltf) => {
          const model = gltf.scene;
          model.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(model);
          const size = new THREE.Vector3();
          box.getSize(size);
          const fit = 1.5 / Math.max(size.x, size.y, size.z, 0.0001);
          model.scale.setScalar(fit);
          model.updateMatrixWorld(true);
          const scaled = new THREE.Box3().setFromObject(model);
          const holder = new THREE.Group();
          model.position.y = -(scaled.min.y + scaled.max.y) / 2;
          holder.add(model);
          holder.position.set(-1.15, -1.05, -3.4);
          holder.rotation.y = 0.55; // three-quarter back view, gazing in
          camera.add(holder);
          (camera as unknown as { __companion?: THREE.Group }).__companion = holder;
          if (gltf.animations.length) {
            companionMixer = new THREE.AnimationMixer(model);
            const idle =
              gltf.animations.find((a) => /idle/i.test(a.name)) ?? gltf.animations[0];
            if (idle) companionMixer.clipAction(idle).reset().play();
          }
        },
        undefined,
        () => { /* no companion — the vista carries it */ },
      );
    }

    // Slow orbit + gentle bob, always looking at the island town.
    let raf = 0;
    const t0 = performance.now();
    let lastT = 0;
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      const dt = Math.min(t - lastT, 0.1);
      lastT = t;
      const a = t * 0.055;
      camera.position.set(Math.sin(a) * 34, 12 + Math.sin(t * 0.35) * 1.6, Math.cos(a) * 34);
      camera.lookAt(0, 4, 0);
      companionMixer?.update(dt);
      const comp = (camera as unknown as { __companion?: THREE.Group }).__companion;
      if (comp) comp.position.y = -1.05 + Math.sin(t * 1.3) * 0.05;
      const halo = island.getObjectByName("orbHalo") as THREE.Sprite | undefined;
      if (halo) {
        halo.scale.setScalar(6 + Math.sin(t * 1.7) * 0.8);
        (halo.material as THREE.SpriteMaterial).opacity = 0.8 + Math.sin(t * 1.7) * 0.15;
      }
      zep.position.set(Math.cos(-t * 0.09 + 1) * 24, 16 + Math.sin(t * 0.4) * 0.8, Math.sin(-t * 0.09 + 1) * 24);
      zep.rotation.y = -(-t * 0.09 + 1) - Math.PI / 2;
      for (const c of clouds) {
        c.g.position.x += c.speed * 0.016;
        if (c.g.position.x > 60) c.g.position.x = -60;
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const onResize = () => {
      const w = mount.clientWidth;
      const h = Math.max(1, mount.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      /* Not `renderer.dispose()` — that drops three's caches and leaves the GL
         context for the garbage collector, which may never come. These are
         decorative canvases that mount and unmount with the pages around them,
         so each visit stranded one: measured, the hub leaked a context every
         single time a visitor came back to it from a world. Browsers cap live
         contexts near sixteen and evict the *oldest*, so the world that broke
         was whichever one had been open longest. */
      releaseRenderer(renderer);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose();
          const mat = m.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat?.dispose();
        }
      });
      mount.removeChild(renderer.domElement);
    };
    // companionUrl is stable for the page's life — rebuilding the whole
    // scene on identity changes would flicker for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={mountRef}
      className="absolute inset-0 [&>canvas]:w-full [&>canvas]:h-full"
      aria-hidden
      data-testid="start-backdrop"
    />
  );
}
