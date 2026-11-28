/**
 * Starborn: the skin the Monolith gives you.
 *
 * Your body turns to night sky: deep indigo with stars drifting through it,
 * a soft halo, and a few sparks trailing off you. It is applied by swapping
 * materials on whatever avatar root a world hands over, idempotently, so a
 * world can call `applyStarSkin` every frame and only pays once per mesh;
 * a character swap brings new meshes, which are simply picked up next call.
 *
 * Originals are kept on the mesh (`userData.starOrig`) so turning the skin
 * off restores exactly what was there. This device only: it lives in
 * localStorage and other players see your ordinary character.
 *
 * No real lights here, on purpose: a PointLight would change the light count
 * of every material in the host world and recompile all of them.
 */
import * as THREE from "three";

const KEY = "monolith.starborn";

export interface StarbornState {
  /** Has this device ever been reborn? */
  earned: boolean;
  /** Is the skin on right now? */
  on: boolean;
  /** YYYY-MM-DD of the first rebirth. */
  since?: string;
  /** How many times you have touched it. */
  touches?: number;
}

export function readStarborn(): StarbornState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { earned: false, on: false };
    const v = JSON.parse(raw) as Partial<StarbornState>;
    return { earned: !!v.earned, on: !!v.on, since: v.since, touches: v.touches ?? 0 };
  } catch {
    return { earned: false, on: false };
  }
}

export function writeStarborn(next: StarbornState): void {
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  try { window.dispatchEvent(new CustomEvent("vibe:starborn", { detail: next })); } catch { /* no window */ }
}

export function becomeStarborn(): StarbornState {
  const cur = readStarborn();
  const next: StarbornState = {
    earned: true,
    on: true,
    since: cur.since ?? new Date().toISOString().slice(0, 10),
    touches: (cur.touches ?? 0) + 1,
  };
  writeStarborn(next);
  return next;
}

export function setStarlight(on: boolean): StarbornState {
  const cur = readStarborn();
  const next = { ...cur, on: cur.earned && on };
  writeStarborn(next);
  return next;
}

/* ---- the look ------------------------------------------------------------ */

let starTex: THREE.CanvasTexture | null = null;
let glowTex: THREE.CanvasTexture | null = null;
let skinMat: THREE.MeshStandardMaterial | null = null;

function rand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A tile of night sky: nebula wash and stars, black where nothing shines. */
export function starTexture(): THREE.CanvasTexture {
  if (starTex) return starTex;
  const S = 512;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, S, S);
  const r = rand(20011);
  // Nebula: big soft blobs in violet, teal and rose. Drawn wrapped so the
  // tile has no seam.
  const hues = ["rgba(120,70,255,", "rgba(40,200,230,", "rgba(255,90,190,", "rgba(90,120,255,"];
  for (let i = 0; i < 18; i++) {
    const x = r() * S, y = r() * S, rad = 60 + r() * 140;
    const col = hues[i % hues.length];
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      const grad = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad);
      grad.addColorStop(0, col + (0.22 + r() * 0.1) + ")");
      grad.addColorStop(1, col + "0)");
      g.fillStyle = grad;
      g.fillRect(x + ox - rad, y + oy - rad, rad * 2, rad * 2);
    }
  }
  // Stars: many faint, a few bright with a cross glint.
  for (let i = 0; i < 900; i++) {
    const x = r() * S, y = r() * S;
    const b = r();
    const tint = b > 0.9 ? "#ffe2a8" : b > 0.75 ? "#bcd6ff" : "#ffffff";
    g.globalAlpha = 0.35 + b * 0.65;
    g.fillStyle = tint;
    const sz = b > 0.97 ? 2.6 : b > 0.85 ? 1.6 : 1;
    g.beginPath();
    g.arc(x, y, sz, 0, Math.PI * 2);
    g.fill();
    if (b > 0.97) {
      g.globalAlpha = 0.5;
      g.fillRect(x - 7, y - 0.5, 14, 1);
      g.fillRect(x - 0.5, y - 7, 1, 14);
    }
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2.5, 2.5);
  starTex = t;
  return t;
}

/** A soft round glow, for halos and sparks. */
export function glowTexture(): THREE.CanvasTexture {
  if (glowTex) return glowTex;
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(220,210,255,0.55)");
  grad.addColorStop(0.6, "rgba(150,120,255,0.15)");
  grad.addColorStop(1, "rgba(120,90,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  glowTex = t;
  return t;
}

function starMaterial(): THREE.MeshStandardMaterial {
  if (skinMat) return skinMat;
  skinMat = new THREE.MeshStandardMaterial({
    color: "#2a2f7a",
    emissive: "#ffffff",
    emissiveMap: starTexture(),
    emissiveIntensity: 1.6,
    roughness: 0.35,
    metalness: 0.1,
  });
  skinMat.name = "starborn";
  // A rim of violet light round the silhouette, so the body reads as glowing
  // from any distance, whatever its UVs do to the stars. Uses the local
  // normal (normal_fragment_begin), never the vNormal varying, which does
  // not exist on flat-shaded materials.
  skinMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      [
        "#include <emissivemap_fragment>",
        "float starRim = 1.0 - abs(dot(normal, normalize(vViewPosition)));",
        "totalEmissiveRadiance += vec3(0.62, 0.5, 1.0) * pow(starRim, 2.2) * 1.4;",
      ].join("\n"),
    );
  };
  return skinMat;
}

interface Aura {
  group: THREE.Group;
  halo: THREE.Sprite;
  sparks: THREE.Points;
  seeds: Float32Array;
}

function makeAura(height: number): Aura {
  const group = new THREE.Group();
  group.name = "starborn-aura";
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: "#b9a6ff", transparent: true, opacity: 0.55,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  halo.scale.set(height * 1.5, height * 1.5, 1);
  halo.position.y = height * 0.55;
  group.add(halo);
  const N = 26;
  const pos = new Float32Array(N * 3);
  const seeds = new Float32Array(N);
  for (let i = 0; i < N; i++) seeds[i] = Math.random();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const sparks = new THREE.Points(geo, new THREE.PointsMaterial({
    map: glowTexture(), color: "#fff1c9", size: 0.16, transparent: true, opacity: 0.9,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  }));
  sparks.frustumCulled = false;
  group.add(sparks);
  return { group, halo, sparks, seeds };
}

let clock = 0;

/** Move the shared stars and every live aura. Once per frame per world. */
export function tickStarSkin(dt: number): void {
  clock += dt;
  if (starTex) {
    starTex.offset.x = (clock * 0.012) % 1;
    starTex.offset.y = (clock * 0.02) % 1;
  }
  if (skinMat) skinMat.emissiveIntensity = 1.2 + Math.sin(clock * 1.7) * 0.25;
}

function updateAura(a: Aura, height: number) {
  const arr = (a.sparks.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
  for (let i = 0; i < a.seeds.length; i++) {
    const s = a.seeds[i];
    const life = (clock * (0.25 + s * 0.3) + s * 7) % 1;
    const ang = s * 40 + clock * (0.6 + s);
    const rr = 0.25 + s * 0.35 + life * 0.25;
    arr[i * 3] = Math.cos(ang) * rr;
    arr[i * 3 + 1] = height * (0.1 + life * 1.05);
    arr[i * 3 + 2] = Math.sin(ang) * rr;
  }
  a.sparks.geometry.attributes.position.needsUpdate = true;
  (a.sparks.material as THREE.PointsMaterial).opacity = 0.75;
  (a.halo.material as THREE.SpriteMaterial).opacity = 0.42 + Math.sin(clock * 2.1) * 0.12;
}

/**
 * Put the skin on (or take it off) `root`'s meshes. Cheap to call every
 * frame: a mesh that already wears the right thing is skipped.
 */
export function applyStarSkin(root: THREE.Object3D | null | undefined, on: boolean, height = 1.8): void {
  if (!root) return;
  const mat = on ? starMaterial() : null;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || o.userData.starAuraPart) return;
    if (on) {
      if (m.material === mat) return;
      if (o.userData.starOrig === undefined) o.userData.starOrig = m.material;
      m.material = mat!;
    } else if (o.userData.starOrig !== undefined) {
      m.material = o.userData.starOrig as THREE.Material;
      delete o.userData.starOrig;
    }
  });
  let aura = root.userData.starAura as Aura | undefined;
  if (on) {
    if (!aura) {
      aura = makeAura(height);
      aura.group.traverse((o) => { o.userData.starAuraPart = true; });
      root.add(aura.group);
      root.userData.starAura = aura;
    }
    updateAura(aura, height);
  } else if (aura) {
    root.remove(aura.group);
    aura.sparks.geometry.dispose();
    (aura.sparks.material as THREE.Material).dispose();
    (aura.halo.material as THREE.Material).dispose();
    delete root.userData.starAura;
  }
}
