/**
 * The Monolith, as it stands in a host world.
 *
 * A host calls `mountMonolith` once with its scene, a feet position, a ground
 * function and (if it has a visible body) its avatar root, then `update(dt)`
 * every frame and `dispose()` on teardown. That is the whole integration.
 *
 * It does two jobs, and only the first depends on the date:
 *   1. If today's placement (`schedule.ts`) is this world, it raises the slab,
 *      shows a quiet distance chip, and when you walk into it or press Touch,
 *      it hums, flares and warps you to /beyond.
 *   2. If this device is starborn, it keeps your avatar wearing the star skin,
 *      every day, in every host world that has an avatar.
 *
 * Everything on screen is plain DOM appended to the host's container, so it
 * works the same over any engine and needs nothing from a page's React tree.
 */
import * as THREE from "three";
import { placementFor, type MonolithHost, type Placement } from "./schedule";
import { applyStarSkin, glowTexture, readStarborn, starTexture, tickStarSkin } from "./starSkin";
import { arrivedByWarp, warpIn, warpOut } from "./warp";

export interface MonolithOptions {
  host: MonolithHost;
  scene: THREE.Scene;
  /** DOM parent for the chip and the Touch button. */
  container: HTMLElement;
  /** The player's feet, in world coordinates. */
  feet: () => { x: number; y: number; z: number };
  /** Ground height in world coordinates. */
  groundAt: (x: number, z: number) => number;
  /** Where the host's spot coordinates are measured from (Vibe Island's plaza). */
  origin?: { x: number; z: number };
  /** The player's visible body, for the star skin. */
  avatar?: () => THREE.Object3D | null | undefined;
  /** How tall that body is, in its own units. */
  avatarHeight?: number;
  /** Return false while the player is mid-something (driving, flying). */
  canTouch?: () => boolean;
}

export interface MonolithHandle {
  /** Is it standing in this world right now? */
  readonly present: boolean;
  update(dt: number): void;
  dispose(): void;
}

const W = 1.5, H = 6.2, D = 0.32;
const HOVER = 0.35;

export interface MonolithMesh {
  group: THREE.Group;
  /** The dark pool on the ground under it. */
  shadow: THREE.Object3D;
  /** 0 = asleep, 1 = fully awake. */
  setWake(w: number): void;
  update(dt: number, time: number): void;
  dispose(): void;
}

/** The slab itself, scale 1. /beyond uses it too, much larger. */
export function createMonolithMesh(): MonolithMesh {
  const group = new THREE.Group();
  group.name = "monolith";
  const body = new THREE.Group();
  body.position.y = HOVER;
  group.add(body);

  const tex = starTexture().clone();
  tex.needsUpdate = true;
  tex.repeat.set(0.6, 2.2);
  const mat = new THREE.MeshPhysicalMaterial({
    color: "#030306",
    roughness: 0.12,
    metalness: 0.2,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    emissive: "#ffffff",
    emissiveMap: tex,
    emissiveIntensity: 0.06,
  });
  const geo = new THREE.BoxGeometry(W, H, D);
  geo.translate(0, H / 2, 0);
  const slab = new THREE.Mesh(geo, mat);
  slab.castShadow = true;
  body.add(slab);

  // Edges of light that wake as you come near.
  const edgeGeo = new THREE.EdgesGeometry(geo);
  const edgeMat = new THREE.LineBasicMaterial({ color: "#c9b8ff", transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false });
  const edges = new THREE.LineSegments(edgeGeo, edgeMat);
  body.add(edges);

  // A soft halo behind it, whichever side you look from: two one-sided
  // planes, each just behind the slab as seen from its own side. (A sprite
  // through the middle of the slab cuts it in half with a depth line.)
  const haloMat = new THREE.MeshBasicMaterial({ map: glowTexture(), color: "#8f7bff", transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const haloGeo = new THREE.PlaneGeometry(9, 11);
  const halo = new THREE.Group();
  for (const side of [-1, 1]) {
    const p = new THREE.Mesh(haloGeo, haloMat);
    p.position.set(0, H * 0.55 + HOVER, -side * (D / 2 + 0.25));
    if (side < 0) p.rotation.y = Math.PI;
    halo.add(p);
  }
  group.add(halo);
  const shadowTex = glowTexture();
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(4.2, 2.4).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: shadowTex, color: "#000000", transparent: true, opacity: 0.55, depthWrite: false }),
  );
  shadow.position.y = 0.04;
  group.add(shadow);

  // Motes drifting round it, slowly, like dust in a beam.
  const N = 70;
  const motes = new Float32Array(N * 3);
  const seeds = new Float32Array(N);
  for (let i = 0; i < N; i++) seeds[i] = Math.random();
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motes, 3));
  const moteMat = new THREE.PointsMaterial({ map: glowTexture(), color: "#e8deff", size: 0.12, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(moteGeo, moteMat);
  points.frustumCulled = false;
  group.add(points);

  let wake = 0;
  return {
    group,
    shadow,
    setWake(w) { wake = Math.max(0, Math.min(1, w)); },
    update(dt, time) {
      body.position.y = HOVER + Math.sin(time * 0.6) * 0.04;
      tex.offset.y = (time * 0.01) % 1;
      tex.offset.x = (time * 0.004) % 1;
      mat.emissiveIntensity = 0.03 + wake * 0.24 + Math.sin(time * 3.1) * 0.02 * wake;
      edgeMat.opacity = 0.1 + wake * 0.8;
      haloMat.opacity = 0.05 + wake * 0.55;
      moteMat.opacity = 0.25 + wake * 0.6;
      for (let i = 0; i < N; i++) {
        const s = seeds[i];
        const a = s * 50 + time * (0.08 + s * 0.15) * (1 + wake * 4);
        const r = 1.3 + s * 2.2 - wake * 0.6;
        motes[i * 3] = Math.cos(a) * r;
        motes[i * 3 + 1] = ((s * 13 + time * (0.05 + s * 0.08)) % 1) * H * 1.1;
        motes[i * 3 + 2] = Math.sin(a) * r;
      }
      moteGeo.attributes.position.needsUpdate = true;
      void dt;
    },
    dispose() {
      geo.dispose(); mat.dispose(); tex.dispose();
      edgeGeo.dispose(); edgeMat.dispose();
      haloMat.dispose(); haloGeo.dispose();
      shadow.geometry.dispose(); (shadow.material as THREE.Material).dispose();
      moteGeo.dispose(); moteMat.dispose();
    },
  };
}

/** The hum that builds as you touch it. */
function hum(ac: AudioContext, seconds: number) {
  const t0 = ac.currentTime;
  const out = ac.createGain();
  out.gain.setValueAtTime(0.0001, t0);
  out.gain.exponentialRampToValueAtTime(0.22, t0 + seconds * 0.8);
  out.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds + 0.6);
  out.connect(ac.destination);
  // A chord that slides up into itself.
  for (const [f, type] of [[65.4, "sine"], [98, "triangle"], [130.8, "sine"], [196, "sine"]] as const) {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f * 0.94, t0);
    o.frequency.exponentialRampToValueAtTime(f * 1.5, t0 + seconds);
    const g = ac.createGain();
    g.gain.value = f < 100 ? 0.5 : 0.25;
    o.connect(g).connect(out);
    o.start(t0);
    o.stop(t0 + seconds + 0.7);
  }
}

const CHARGE = 1.1;

export function mountMonolith(opts: MonolithOptions): MonolithHandle {
  const placement: Placement | null = placementFor(opts.host);
  const ox = opts.origin?.x ?? 0, oz = opts.origin?.z ?? 0;
  let time = 0;
  let updates = 0;
  let mesh: MonolithMesh | null = null;
  let pos: THREE.Vector3 | null = null;
  let chip: HTMLDivElement | null = null;
  let button: HTMLButtonElement | null = null;
  let toast: HTMLDivElement | null = null;
  let charging = -1;
  let warping = false;
  let audio: AudioContext | null = null;
  let starOn = readStarborn().on;
  const onStar = () => { starOn = readStarborn().on; };
  window.addEventListener("vibe:starborn", onStar);

  if (arrivedByWarp()) void warpOut();

  const css = (el: HTMLElement, s: Partial<CSSStyleDeclaration>) => Object.assign(el.style, s);

  const touch = () => {
    if (!mesh || charging >= 0 || warping) return;
    charging = 0;
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AC) { audio = new AC(); hum(audio, CHARGE); }
    } catch { /* no audio */ }
  };

  if (placement) {
    const { spot, host } = placement;
    pos = new THREE.Vector3(ox + spot.x, opts.groundAt(ox + spot.x, oz + spot.z), oz + spot.z);
    mesh = createMonolithMesh();
    mesh.group.position.copy(pos);
    mesh.group.rotation.y = spot.yaw;
    opts.scene.add(mesh.group);

    chip = document.createElement("div");
    chip.setAttribute("data-ui", "1");
    css(chip, {
      position: "absolute", top: "calc(env(safe-area-inset-top, 0px) + 58px)", left: "50%", transform: "translateX(-50%)",
      padding: "6px 12px", borderRadius: "999px", background: "rgba(6,5,16,0.72)", color: "#e7defc",
      font: "600 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace", letterSpacing: "0.08em",
      border: "1px solid rgba(190,170,255,0.35)", pointerEvents: "none", zIndex: "40", display: "none",
      whiteSpace: "nowrap", backdropFilter: "blur(6px)",
    });
    opts.container.appendChild(chip);

    button = document.createElement("button");
    button.setAttribute("data-ui", "1");
    button.textContent = "✋ Touch the Monolith";
    css(button, {
      position: "absolute", left: "50%", bottom: "calc(env(safe-area-inset-bottom, 0px) + 150px)", transform: "translateX(-50%)",
      padding: "12px 20px", borderRadius: "999px", border: "1px solid rgba(200,180,255,0.7)",
      background: "rgba(10,8,26,0.85)", color: "#fff", font: "700 15px/1 system-ui, sans-serif",
      boxShadow: "0 0 24px rgba(150,120,255,0.55)", zIndex: "41", display: "none", cursor: "pointer",
    });
    button.addEventListener("click", (e) => { e.stopPropagation(); touch(); });
    button.addEventListener("pointerdown", (e) => e.stopPropagation());
    opts.container.appendChild(button);

    toast = document.createElement("div");
    toast.setAttribute("data-ui", "1");
    toast.textContent = `Something tall and dark has appeared in ${host.name}, ${spot.where}.`;
    css(toast, {
      position: "absolute", top: "calc(env(safe-area-inset-top, 0px) + 92px)", left: "50%", transform: "translateX(-50%)",
      maxWidth: "min(90vw, 460px)", textAlign: "center", padding: "10px 16px", borderRadius: "14px",
      background: "rgba(6,5,16,0.78)", color: "#efe9ff", font: "500 14px/1.35 system-ui, sans-serif",
      zIndex: "40", pointerEvents: "none", opacity: "0", transition: "opacity 1.2s",
    });
    opts.container.appendChild(toast);
    window.setTimeout(() => { if (toast) toast.style.opacity = "1"; }, 2500);
    window.setTimeout(() => { if (toast) toast.style.opacity = "0"; }, 11000);
  }

  const go = async () => {
    warping = true;
    const from = window.location.pathname + window.location.search;
    await warpIn();
    window.location.assign(`/beyond?from=${encodeURIComponent(from)}`);
  };

  (window as unknown as { __monolith?: unknown }).__monolith = {
    placement: () => placement && { host: placement.host.key, where: placement.spot.where, x: pos?.x, y: pos?.y, z: pos?.z },
    distance: () => {
      if (!pos) return null;
      const f = opts.feet();
      return Math.hypot(f.x - pos.x, f.z - pos.z);
    },
    touch,
    debug: () => ({ updates, starOn, avatar: !!opts.avatar?.(), skinned: (() => { let n = 0; opts.avatar?.()?.traverse((o) => { if (o.userData.starOrig !== undefined) n++; }); return n; })() }),
  };

  return {
    present: !!placement,
    update(dt) {
      updates++;
      time += dt;
      tickStarSkin(dt);
      if (opts.avatar) applyStarSkin(opts.avatar(), starOn, opts.avatarHeight ?? 1.8);
      if (!mesh || !pos) return;
      const f = opts.feet();
      // Distance to the slab's footprint, not its centre.
      const dx = f.x - pos.x, dz = f.z - pos.z;
      const c = Math.cos(-mesh.group.rotation.y), s = Math.sin(-mesh.group.rotation.y);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      const edge = Math.hypot(Math.max(0, Math.abs(lx) - W / 2), Math.max(0, Math.abs(lz) - D / 2));
      const dist = Math.hypot(dx, dz);
      const nearY = Math.abs(f.y - pos.y) < 4;
      const allowed = opts.canTouch?.() ?? true;
      if (charging >= 0) {
        charging += dt;
        mesh.setWake(0.6 + charging / CHARGE);
        if (charging >= CHARGE && !warping) void go();
      } else {
        mesh.setWake(Math.max(0, 1 - dist / 14) * 0.6);
        // Walking into it is touching it.
        if (edge < 0.45 && nearY && allowed) touch();
      }
      mesh.update(dt, time);
      if (chip) {
        const show = dist < 180 && dist > 5 && !warping;
        chip.style.display = show ? "block" : "none";
        if (show) chip.textContent = `◼ THE MONOLITH · ${Math.round(dist)} m`;
      }
      if (button) button.style.display = dist < 5 && nearY && allowed && charging < 0 ? "block" : "none";
    },
    dispose() {
      window.removeEventListener("vibe:starborn", onStar);
      if (mesh) { opts.scene.remove(mesh.group); mesh.dispose(); }
      chip?.remove(); button?.remove(); toast?.remove();
      void audio?.close().catch(() => undefined);
      delete (window as unknown as { __monolith?: unknown }).__monolith;
    },
  };
}
