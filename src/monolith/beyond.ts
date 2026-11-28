/**
 * The Beyond: where the Monolith takes you.
 *
 * A plain of black glass with the night sky inside it, under a galaxy, with a
 * vast Monolith at the centre and smaller ones circling it. You arrive on the
 * rim. Walk into the light at the centre and you are lifted, turned, flooded
 * with white, and set back down starborn: your character now carries the
 * stars (see `starSkin.ts`) into every host world that shows your body.
 *
 * Plain three.js, like the other recent worlds; the page in
 * `src/pages/Beyond.tsx` owns the HUD. `window.__beyond` is the test hook.
 */
import * as THREE from "three";
import { loadCharacterRig, type CharacterRig } from "@/lib/characterRig";
import { findCharacter } from "@/lib/characters";
import { createMonolithMesh, type MonolithMesh } from "./monolith";
import { applyStarSkin, becomeStarborn, glowTexture, readStarborn, starTexture, tickStarSkin } from "./starSkin";

export type BeyondPhase = "arrive" | "walk" | "rising" | "reborn";

export interface BeyondHud {
  phase: BeyondPhase;
  /** Metres to the light. */
  distance: number;
  starOn: boolean;
}

export interface Beyond {
  setStick(x: number, y: number): void;
  dispose(): void;
}

interface Opts {
  charId: string;
  onHud?(h: BeyondHud): void;
  onReborn?(): void;
}

const SPAWN_R = 62;
const LIGHT_R = 8.5;
const SCALE = 5.2;
const PLAIN_R = 170;

function paintSky(): THREE.CanvasTexture {
  const Wd = 2048, Ht = 1024;
  const c = document.createElement("canvas");
  c.width = Wd; c.height = Ht;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, Ht);
  grad.addColorStop(0, "#020107");
  grad.addColorStop(0.42, "#0b0626");
  grad.addColorStop(0.5, "#1b0f45");
  grad.addColorStop(0.58, "#0b0626");
  grad.addColorStop(1, "#020107");
  g.fillStyle = grad;
  g.fillRect(0, 0, Wd, Ht);
  let s = 7;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // The galaxy: a tilted band of coloured cloud.
  for (let i = 0; i < 260; i++) {
    const x = r() * Wd;
    const y = Ht * 0.5 + Math.sin((x / Wd) * Math.PI * 2) * Ht * 0.12 + (r() - 0.5) * Ht * 0.14;
    const rad = 30 + r() * 120;
    const hue = [265, 200, 320, 230][i % 4];
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, `hsla(${hue},80%,${55 + r() * 20}%,${0.05 + r() * 0.09})`);
    gr.addColorStop(1, `hsla(${hue},80%,50%,0)`);
    g.fillStyle = gr;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  for (let i = 0; i < 5000; i++) {
    const x = r() * Wd, y = r() * Ht;
    const b = r();
    g.globalAlpha = 0.2 + b * 0.8;
    g.fillStyle = b > 0.92 ? "#ffe5b5" : b > 0.8 ? "#c4dcff" : "#ffffff";
    g.fillRect(x, y, b > 0.97 ? 2 : 1, b > 0.97 ? 2 : 1);
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createBeyond(mount: HTMLElement, opts: Opts): Beyond {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(mount.clientWidth, mount.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  canvas.style.touchAction = "none";
  mount.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#020107");
  scene.fog = new THREE.FogExp2("#0a0620", 0.0042);
  const camera = new THREE.PerspectiveCamera(60, mount.clientWidth / Math.max(1, mount.clientHeight), 0.1, 3000);

  const disposables: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(x: T) => { disposables.push(x); return x; };

  // ---- Sky ---------------------------------------------------------------
  const skyTex = keep(paintSky());
  const skyGeo = keep(new THREE.SphereGeometry(1400, 48, 24));
  const skyMat = keep(new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false }));
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.rotation.z = 0.35;
  scene.add(sky);

  const hemi = new THREE.HemisphereLight("#9d8cff", "#0a0820", 0.9);
  scene.add(hemi);
  const key = new THREE.DirectionalLight("#cfc2ff", 0.8);
  key.position.set(-40, 80, 60);
  scene.add(key);

  // ---- The plain: night sky underfoot ------------------------------------
  const floorTex = starTexture().clone();
  floorTex.needsUpdate = true;
  floorTex.repeat.set(22, 22);
  floorTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  keep(floorTex);
  const floorGeo = keep(new THREE.CircleGeometry(PLAIN_R, 96).rotateX(-Math.PI / 2));
  const floorMat = keep(new THREE.MeshStandardMaterial({
    color: "#07051a", roughness: 0.18, metalness: 0.7,
    emissive: "#ffffff", emissiveMap: floorTex, emissiveIntensity: 0.4,
  }));
  const floor = new THREE.Mesh(floorGeo, floorMat);
  scene.add(floor);

  // Rings of light that ripple outward from the centre.
  const rings: THREE.Mesh[] = [];
  for (let i = 0; i < 6; i++) {
    const m = keep(new THREE.MeshBasicMaterial({ color: "#a58cff", transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
    const ring = new THREE.Mesh(keep(new THREE.RingGeometry(0.985, 1, 128).rotateX(-Math.PI / 2)), m);
    ring.position.y = 0.03;
    scene.add(ring);
    rings.push(ring);
  }

  // The way in: a line of glowing stepping lights from the rim to the centre.
  const stepGeo = keep(new THREE.CircleGeometry(0.55, 24).rotateX(-Math.PI / 2));
  const stepMat = keep(new THREE.MeshBasicMaterial({ map: glowTexture(), color: "#ffe9b8", transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
  const steps = new THREE.InstancedMesh(stepGeo, stepMat, 24);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < 24; i++) {
    const z = SPAWN_R - 4 - i * ((SPAWN_R - LIGHT_R - 6) / 23);
    m4.makeTranslation(Math.sin(i * 0.7) * 0.6, 0.04, z);
    steps.setMatrixAt(i, m4);
  }
  scene.add(steps);

  // ---- The great Monolith and its court ----------------------------------
  const great: MonolithMesh = createMonolithMesh();
  great.group.scale.setScalar(SCALE);
  great.group.rotation.y = 0;
  great.setWake(1);
  great.shadow.visible = false;
  scene.add(great.group);

  // The light: a pool on the floor round the great slab. Walk into it.
  const poolGeo = keep(new THREE.CircleGeometry(LIGHT_R * 1.6, 64).rotateX(-Math.PI / 2));
  const poolMat = keep(new THREE.MeshBasicMaterial({ map: glowTexture(), color: "#c9b8ff", transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
  const pool = new THREE.Mesh(poolGeo, poolMat);
  pool.position.y = 0.06;
  scene.add(pool);
  const edgeGeo = keep(new THREE.RingGeometry(LIGHT_R - 0.12, LIGHT_R, 128).rotateX(-Math.PI / 2));
  const edgeMat = keep(new THREE.MeshBasicMaterial({ color: "#ffe9b8", transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  const poolEdge = new THREE.Mesh(edgeGeo, edgeMat);
  poolEdge.position.y = 0.07;
  scene.add(poolEdge);

  const court: MonolithMesh[] = [];
  for (let i = 0; i < 8; i++) {
    const m = createMonolithMesh();
    m.group.scale.setScalar(1.4);
    m.setWake(0.5);
    scene.add(m.group);
    court.push(m);
  }

  // Drifting star motes all over the plain.
  const N = 900;
  const dust = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2, rr = 6 + Math.random() * PLAIN_R;
    dust[i * 3] = Math.cos(a) * rr;
    dust[i * 3 + 1] = Math.random() * 40;
    dust[i * 3 + 2] = Math.sin(a) * rr;
  }
  const dustGeo = keep(new THREE.BufferGeometry());
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dust, 3));
  const dustMat = keep(new THREE.PointsMaterial({ map: glowTexture(), color: "#d9ceff", size: 0.35, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(new THREE.Points(dustGeo, dustMat));

  // ---- You -----------------------------------------------------------------
  const body = new THREE.Group();
  body.position.set(0, 0, SPAWN_R);
  scene.add(body);
  const holder = new THREE.Group();
  body.add(holder);
  let rig: CharacterRig | null = null;
  let disposed = false;
  const spec = findCharacter(opts.charId);
  loadCharacterRig({ url: spec.url, id: spec.id }, { height: 1.8, center: true, castShadow: false })
    .then((r) => {
      if (disposed) { r.dispose(); return; }
      rig = r;
      holder.add(r.object);
    })
    .catch(() => {
      const cap = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 1.0, 4, 10), new THREE.MeshStandardMaterial({ color: "#c9b8ff" }));
      cap.position.y = 0.9;
      holder.add(cap);
    });

  // ---- Input -----------------------------------------------------------------
  const keys = new Set<string>();
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
    if (e.type === "keydown") keys.add(e.code); else keys.delete(e.code);
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  const stick = { x: 0, y: 0 };
  let camYaw = 0; // camera sits at +z of the player looking toward -z
  let camPitch = 0.22;
  let drag: { id: number; x: number; y: number; moved: number } | null = null;
  let walkTo: THREE.Vector3 | null = null;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement) !== canvas) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 };
  };
  const onMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    camYaw -= dx * 0.006;
    camPitch = Math.max(-0.05, Math.min(0.9, camPitch + dy * 0.004));
  };
  const onUp = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.moved < 8) {
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObject(floor, false)[0];
      if (hit) walkTo = hit.point.clone();
    }
    drag = null;
  };
  canvas.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);

  // ---- State -----------------------------------------------------------------
  let phase: BeyondPhase = "arrive";
  let phaseT = 0;
  let time = 0;
  let heading = Math.PI; // facing -z (toward the centre)
  let starOn = readStarborn().on;
  let rebornNow = false;
  const onStar = () => { starOn = readStarborn().on; };
  window.addEventListener("vibe:starborn", onStar);
  const flash = document.createElement("div");
  Object.assign(flash.style, { position: "absolute", inset: "0", background: "#fff", opacity: "0", pointerEvents: "none", zIndex: "5" } as CSSStyleDeclaration);
  mount.appendChild(flash);

  const camPos = new THREE.Vector3(0, 6, SPAWN_R + 14);
  const camLook = new THREE.Vector3();
  let hudT = 0;
  const pushHud = () => opts.onHud?.({ phase, distance: Math.max(0, Math.hypot(body.position.x, body.position.z) - LIGHT_R), starOn });

  const advance = (dt: number) => {
    time += dt;
    phaseT += dt;
    tickStarSkin(dt);
    // Movement.
    let mx = 0, my = 0;
    if (keys.has("KeyW") || keys.has("ArrowUp")) my += 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) my -= 1;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) mx -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) mx += 1;
    mx += stick.x; my += stick.y;
    const free = phase === "arrive" || phase === "walk" || phase === "reborn";
    if (phase === "arrive" && phaseT > 1.2) { phase = "walk"; phaseT = 0; }
    let speed = 0;
    if (free) {
      let vx = 0, vz = 0;
      const len = Math.hypot(mx, my);
      if (len > 0.05) {
        walkTo = null;
        const f = Math.min(1, len);
        // Forward is away from the camera.
        const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
        const rx = Math.cos(camYaw), rz = -Math.sin(camYaw);
        vx = (fx * my + rx * mx) / len * f;
        vz = (fz * my + rz * mx) / len * f;
      } else if (walkTo) {
        const dx = walkTo.x - body.position.x, dz = walkTo.z - body.position.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.4) walkTo = null; else { vx = dx / d; vz = dz / d; }
      }
      speed = Math.hypot(vx, vz);
      if (speed > 0.01) {
        const run = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 1.7 : 1;
        body.position.x += vx * 5.2 * run * dt;
        body.position.z += vz * 5.2 * run * dt;
        const target = Math.atan2(vx, vz);
        let dh = target - heading;
        while (dh > Math.PI) dh -= Math.PI * 2;
        while (dh < -Math.PI) dh += Math.PI * 2;
        heading += dh * (1 - Math.exp(-10 * dt));
      }
      // Keep to the plain, and outside the slab itself.
      const r = Math.hypot(body.position.x, body.position.z);
      if (r > PLAIN_R - 4) body.position.multiplyScalar((PLAIN_R - 4) / r);
      if (r < 4.5 && r > 0.001) { body.position.x *= 4.5 / r; body.position.z *= 4.5 / r; }
      // The light.
      if (phase === "walk" && r < LIGHT_R) { phase = "rising"; phaseT = 0; walkTo = null; }
    }
    if (phase === "rising") {
      // Lifted, turned, flooded with white; reborn at the peak.
      const t = phaseT;
      body.position.y = Math.min(1, t / 2.2) ** 2 * 4.5;
      heading += dt * (1.5 + t * 3);
      flash.style.opacity = String(Math.max(0, Math.min(1, (t - 1.6) / 0.6)));
      if (t > 2.3 && !rebornNow) { rebornNow = true; becomeStarborn(); starOn = true; opts.onReborn?.(); }
      if (t > 2.6) { phase = "reborn"; phaseT = 0; }
    } else if (phase === "reborn") {
      body.position.y = Math.max(0, body.position.y - dt * 3);
      flash.style.opacity = String(Math.max(0, 1 - phaseT / 1.4));
    } else {
      body.position.y = 0;
    }
    body.rotation.y = heading;
    if (rig) {
      rig.setLocomotion(phase === "rising" ? 0 : Math.min(1, speed));
      rig.update(dt);
    }
    applyStarSkin(holder, starOn, 1.8);

    // The world breathes.
    great.update(dt, time);
    poolMat.opacity = 0.85 + Math.sin(time * 1.3) * 0.15 + (phase === "rising" ? 0.45 : 0);
    edgeMat.opacity = 0.6 + Math.sin(time * 2.1) * 0.25;
    for (let i = 0; i < court.length; i++) {
      const a = (i / court.length) * Math.PI * 2 + time * 0.03;
      const c = court[i];
      c.group.position.set(Math.cos(a) * 34, 6 + Math.sin(time * 0.4 + i) * 1.5, Math.sin(a) * 34);
      c.group.rotation.y = -a + Math.PI / 2;
      c.update(dt, time + i * 3);
    }
    for (let i = 0; i < rings.length; i++) {
      const k = ((time * 0.06 + i / rings.length) % 1);
      const rr = LIGHT_R + k * (PLAIN_R - LIGHT_R);
      rings[i].scale.set(rr, 1, rr);
      (rings[i].material as THREE.MeshBasicMaterial).opacity = 0.45 * (1 - k);
    }
    floorTex.offset.x = (time * 0.002) % 1;
    sky.rotation.y = time * 0.004;

    // Camera: behind and above, easing; pulls back while you rise.
    const back = phase === "rising" ? 16 : 9.5;
    const up = phase === "rising" ? 0.35 : camPitch;
    const want = new THREE.Vector3(
      body.position.x + Math.sin(camYaw) * Math.cos(up) * back,
      body.position.y + 1.6 + Math.sin(up) * back,
      body.position.z + Math.cos(camYaw) * Math.cos(up) * back,
    );
    camPos.lerp(want, 1 - Math.exp(-6 * dt));
    camera.position.copy(camPos);
    camLook.set(body.position.x, body.position.y + 1.4, body.position.z);
    // Look a little toward the great slab so it is always in the frame.
    camLook.lerp(new THREE.Vector3(0, 12, 0), 0.12);
    camera.lookAt(camLook);

    hudT -= dt;
    if (hudT <= 0) { hudT = 0.15; pushHud(); }
  };

  let raf = 0;
  let last = performance.now();
  let paused = false;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (paused) return;
    advance(dt);
    renderer.render(scene, camera);
  };
  advance(0.016);
  renderer.render(scene, camera);
  loop();

  const onResize = () => {
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    camera.aspect = mount.clientWidth / Math.max(1, mount.clientHeight);
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", onResize);

  (window as unknown as { __beyond?: unknown }).__beyond = {
    state: () => ({ phase, x: body.position.x, y: body.position.y, z: body.position.z, starOn, rig: !!rig }),
    settle(seconds: number, hold: string[] = []) {
      hold.forEach((k) => keys.add(k));
      paused = true;
      for (let t = 0; t < seconds; t += 1 / 30) advance(1 / 30);
      hold.forEach((k) => keys.delete(k));
      paused = false;
      last = performance.now();
    },
    teleport(x: number, z: number) { body.position.set(x, 0, z); walkTo = null; },
    look(yaw: number, pitch = camPitch) { camYaw = yaw; camPitch = pitch; },
    snapshot: () => { renderer.render(scene, camera); return canvas.toDataURL("image/jpeg", 0.88); },
  };

  return {
    setStick(x, y) { stick.x = x; stick.y = y; },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("vibe:starborn", onStar);
      canvas.removeEventListener("pointerdown", onDown);
      rig?.dispose();
      great.dispose();
      court.forEach((c) => c.dispose());
      steps.dispose();
      disposables.forEach((d) => d.dispose());
      flash.remove();
      renderer.dispose();
      canvas.remove();
      delete (window as unknown as { __beyond?: unknown }).__beyond;
    },
  };
}
