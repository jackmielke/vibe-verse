/**
 * DROP ZERO — weapons.
 *
 * The arsenal, the ballistics, the recoil and the two viewmodels. Everything
 * is generated at boot: the guns are chamfered/extruded geometry authored in
 * code, the gunmetal and polymer surfaces are Canvas2D noise baked to
 * CanvasTextures, and the only outside dependency is the service registry.
 *
 * ── What this publishes ───────────────────────────────────────────────────
 * `ctx.services.weapons` — an EXTRA key, not declared in `WorldServices`.
 * `types.ts` is owned by the whole team and I must not edit it, so the key is
 * attached through the `WeaponServices` cast exported below. Loot uses it to
 * roll guns and mint `InventoryItem`s with the right name/mag/rarity; the HUD
 * uses it to name and tier whatever the player is holding.
 *
 * ── Architecture ──────────────────────────────────────────────────────────
 * The arsenal is pure data (`ARSENAL`). A `WeaponDef` describes role, fire
 * mode, ballistics, recoil pattern, reload beats and which builder assembles
 * its mesh, so adding a tenth gun is a data entry plus a builder function.
 * Rarity is a *scalar* on top of that: `statsFor(def, rarity)` returns the
 * damage/reload/spread the five tiers actually differ by, and nothing else in
 * the module ever reads a raw def field for those three numbers.
 *
 * ── Two viewmodels ────────────────────────────────────────────────────────
 * Third person is the default camera here (the player toggles with F), so the
 * gun has to exist twice:
 *
 *  - **Third person.** A clone of the same rig — `Object3D.clone()` shares
 *    geometry and materials, so the copy costs scene-graph nodes and nothing
 *    else — parented into the character's right hand, casting shadows, lit by
 *    the world. This is the one other players and the elimination cam see.
 *  - **First person.** The original rig, in its own `THREE.Scene` with its own
 *    near-clipped camera and its own three-point light rig, drawn in a second
 *    pass after the main frame with the depth buffer cleared. That is the only
 *    way a viewmodel *provably* cannot intersect world geometry, and it lets
 *    the gun be lit for the gun rather than for the island.
 *
 * The second pass needs the frame, and `postfx` owns `engine.renderOverride`
 * through the `dz:postfx` event. Rather than fight it, we wrap it: we listen
 * for `dz:postfx`, keep whatever function was published as our inner render,
 * and re-publish a composite. postfx keeps full control of the image; we just
 * draw the gun on top of the finished frame. If postfx never boots, the inner
 * render is a plain forward render and everything still works.
 *
 * ── Camera ownership ──────────────────────────────────────────────────────
 * The player controller owns pitch/yaw/FOV and writes them in `update()`. We
 * add recoil, shake and the per-weapon ADS FOV pull on top in `lateUpdate()`,
 * i.e. after it. Because the player rewrites the camera from its own state
 * every frame, our offsets never accumulate — they spring back to zero on
 * their own, which is the modern recoil-recovery model and the difference
 * between a gun that feels good and one that feels broken. Bullets are fired
 * along the *kicked* orientation, so the recoil genuinely moves the shots and
 * not just the picture.
 *
 * ── Audio names this module asks for ──────────────────────────────────────
 * shot-ar, shot-smg, shot-pump, shot-tac, shot-sniper, shot-burst,
 * shot-rocket, shot-pistol, shot-minigun, shot-tail, dry-fire, mag-out,
 * mag-in, bolt-back, bolt-forward, pump-action, shell-drop, weapon-swap,
 * spin-up, spin-down, hitmarker, hitmarker-shield, elim-confirm, explosion,
 * whizz, ads-in.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { RARITY_COLOR } from "../types";
import type {
  BuildPiece,
  DamageSource,
  DamageTarget,
  ImpactMaterial,
  InventoryItem,
  QualityTier,
  Rarity,
  RayHit,
  System,
  SystemFactory,
  WorldCtx,
  WorldServices,
} from "../types";
import {
  WATER,
  balloonSoakAt,
  soakAtRange,
  waterFor,
  waterStats,
  waterWeapon,
} from "../mode/water";
import type { WaterStats, WaterWeaponDef } from "../mode/water";

// ---------------------------------------------------------------- tuning

/**
 * Layer the first-person viewmodel lives on. It is already isolated in its own
 * scene; the layer is belt-and-braces so that if anything ever renders our
 * scene with a borrowed camera it still gets nothing.
 */
const VM_LAYER = 2;

/** Near/far for the viewmodel camera. A gun is 40 cm of frustum, not 8 km. */
const VM_NEAR = 0.008;
const VM_FAR = 6;

/**
 * Viewmodel FOV as a fraction of the world FOV while hip-firing. Slightly
 * narrower makes the weapon read as a real object at arm's length instead of
 * a fisheyed prop — the world runs at 80°, which is brutal on a near object.
 */
const VM_FOV_SCALE = 0.86;

/** How far in front of the eye the sight line sits when aiming. */
const ADS_Z = -0.2;

/** Metres of travel the sway/bob channels are allowed, total. */
const SWAY_LIMIT = 0.035;

/** Player speeds, mirrored from the controller so bob/spread agree with it. */
const WALK_SPEED = 5.6;
const SPRINT_SPEED = 8.4;

/**
 * Ranges past which hitscan damage starts to fall off, expressed as a fraction
 * of the weapon's own `falloffStart`/`falloffEnd`. Fortnite's shotguns lose
 * most of their damage by 15 m and its ARs keep ~75% at 100 m — that spread
 * between the classes is the whole reason engagements happen at the range
 * they do, so the curve is per-weapon rather than global.
 */
const MIN_FALLOFF = 0.28;

/** Gravity applied to sniper rounds and rockets, m/s². Lighter than the
 * player's 24 — a bullet that drops like a person is unreadable at 200 m. */
const BULLET_GRAVITY = -9.0;

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);

// Scratch. Nothing in the update or fixed path allocates.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
/** Private to the actor sweep — it nests inside hitscan and must not alias. */
const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e1 = new THREE.Euler(0, 0, 0, "YXZ");
const _mat4 = new THREE.Matrix4();
const _mat4b = new THREE.Matrix4();
const _color = new THREE.Color();
const _color2 = new THREE.Color();

/**
 * Reusable RayHit for actor hits. A 1400 rpm minigun would otherwise mint 24
 * throwaway hits and 48 vectors a second, all of which the GC then has to walk
 * during a firefight.
 */
const _actorHit: RayHit = {
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 0, 1),
  distance: 0,
  material: "flesh",
};

/** Frame-rate independent exponential approach. */
function approach(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Smootherstep. Used wherever a linear blend reads as a switch being thrown. */
function ease(t: number): number {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

// ---------------------------------------------------------------- textures

function makeCanvas(size: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  if (!g) throw new Error("2d context unavailable");
  return { c, g };
}

/**
 * Brushed gunmetal roughness: horizontal machining grain, a scatter of
 * scratches, and blotchy polish. This map is the single biggest reason the
 * guns do not read as plastic — a receiver with one roughness value catches
 * light in a flat sheet no matter how good the albedo underneath it is.
 */
function makeMetalRoughness(rng: () => number, size: number): THREE.CanvasTexture {
  const { c, g } = makeCanvas(size);
  g.fillStyle = "#707070";
  g.fillRect(0, 0, size, size);

  for (let i = 0; i < size * 3; i++) {
    const y = rng() * size;
    const l = 20 + rng() * size;
    const v = 90 + rng() * 100;
    g.strokeStyle = `rgba(${v},${v},${v},0.15)`;
    g.lineWidth = 0.6 + rng() * 1.6;
    g.beginPath();
    g.moveTo(rng() * size, y);
    g.lineTo(rng() * size + l, y + (rng() - 0.5) * 2.5);
    g.stroke();
  }
  // Deeper scratches — these are the ones that catch a specular streak.
  for (let i = 0; i < 46; i++) {
    g.strokeStyle = `rgba(228,228,228,${0.1 + rng() * 0.24})`;
    g.lineWidth = 0.5 + rng();
    g.beginPath();
    const x = rng() * size;
    const y = rng() * size;
    g.moveTo(x, y);
    g.lineTo(x + (rng() - 0.5) * 100, y + (rng() - 0.5) * 30);
    g.stroke();
  }
  // Polish blotches, so the highlight breaks up across a flat panel.
  for (let i = 0; i < 110; i++) {
    const r = 4 + rng() * 30;
    const v = 36 + (rng() * 46) | 0;
    g.fillStyle = `rgba(${v},${v},${v},0.07)`;
    g.beginPath();
    g.arc(rng() * size, rng() * size, r, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.anisotropy = 4;
  return tex;
}

/** Stippled polymer — the moulded, slightly matte grip/handguard surface. */
function makePolymerRoughness(rng: () => number, size: number): THREE.CanvasTexture {
  const { c, g } = makeCanvas(size);
  g.fillStyle = "#bdbdbd";
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < size * 40; i++) {
    const v = 150 + rng() * 100;
    g.fillStyle = `rgba(${v},${v},${v},0.3)`;
    g.fillRect(rng() * size, rng() * size, 1 + rng() * 2, 1 + rng() * 2);
  }
  // Moulded checkering: the grip should catch light in a pattern, not a sheet.
  g.strokeStyle = "rgba(74,74,74,0.34)";
  g.lineWidth = 1;
  const step = Math.max(6, size / 28);
  for (let i = -size; i < size * 2; i += step) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + size, size);
    g.stroke();
    g.beginPath();
    g.moveTo(i + size, 0);
    g.lineTo(i, size);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  return tex;
}

/**
 * A normal map with the same grain as the roughness map. Without it every
 * chamfer is the only shape information the shading has, and the flat faces
 * between them go dead — which is the "untextured solid colour" tell.
 */
function makeSurfaceNormal(rng: () => number, size: number): THREE.CanvasTexture {
  const { c, g } = makeCanvas(size);
  // Height field first, in greyscale.
  g.fillStyle = "#808080";
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < size * 6; i++) {
    const v = 108 + rng() * 40;
    g.strokeStyle = `rgba(${v},${v},${v},0.2)`;
    g.lineWidth = 0.5 + rng();
    const y = rng() * size;
    g.beginPath();
    g.moveTo(rng() * size - size * 0.3, y);
    g.lineTo(rng() * size + size * 0.4, y + (rng() - 0.5) * 2);
    g.stroke();
  }
  for (let i = 0; i < 240; i++) {
    const r = 1 + rng() * 3.4;
    const v = rng() < 0.5 ? 96 : 160;
    g.fillStyle = `rgba(${v},${v},${v},0.5)`;
    g.beginPath();
    g.arc(rng() * size, rng() * size, r, 0, Math.PI * 2);
    g.fill();
  }

  const src = g.getImageData(0, 0, size, size);
  const out = g.createImageData(size, size);
  const at = (x: number, y: number): number => {
    const xx = (x + size) % size;
    const yy = (y + size) % size;
    return src.data[(yy * size + xx) * 4] / 255;
  };
  // Sobel → tangent-space normal. Strength is deliberately low: this is
  // micro-detail, and a loud normal map on a hard-surface prop reads as noise.
  const strength = 2.1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
      const dy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
      const nx = dx * strength;
      const ny = dy * strength;
      const len = Math.sqrt(nx * nx + ny * ny + 1);
      const i = (y * size + x) * 4;
      out.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      out.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      out.data[i + 2] = (1 / len) * 0.5 * 255 + 127;
      out.data[i + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  return tex;
}

/** Additive muzzle-flash star: hot core, four-point flare, soft halo. */
function makeFlashSprite(size: number): THREE.CanvasTexture {
  const { c, g } = makeCanvas(size);
  const h = size / 2;
  g.clearRect(0, 0, size, size);
  const halo = g.createRadialGradient(h, h, 0, h, h, h);
  halo.addColorStop(0, "rgba(255,251,228,1)");
  halo.addColorStop(0.16, "rgba(255,216,132,0.94)");
  halo.addColorStop(0.42, "rgba(255,142,44,0.34)");
  halo.addColorStop(1, "rgba(255,92,12,0)");
  g.fillStyle = halo;
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = "lighter";
  for (let i = 0; i < 4; i++) {
    g.save();
    g.translate(h, h);
    g.rotate((i * Math.PI) / 4 + Math.PI / 8);
    const spike = g.createLinearGradient(0, 0, h, 0);
    spike.addColorStop(0, "rgba(255,255,242,0.95)");
    spike.addColorStop(1, "rgba(255,164,64,0)");
    g.fillStyle = spike;
    g.beginPath();
    g.moveTo(0, -h * 0.065);
    g.lineTo(h, 0);
    g.lineTo(0, h * 0.065);
    g.closePath();
    g.fill();
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft round sprite — rocket exhaust and the sniper's tracer head. */
function makeGlowSprite(size: number): THREE.CanvasTexture {
  const { c, g } = makeCanvas(size);
  const h = size / 2;
  const grd = g.createRadialGradient(h, h, 0, h, h, h);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.25, "rgba(255,214,150,0.72)");
  grd.addColorStop(1, "rgba(255,120,40,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Scope reticle: a duplex crosshair with a mil-dot ladder, drawn on a
 * transparent canvas. Used as the sniper's ocular image so the scope is a
 * readable optic rather than a black disc with a dot in it.
 */
function makeReticleTexture(size: number): THREE.CanvasTexture {
  const { c, g } = makeCanvas(size);
  const h = size / 2;
  g.clearRect(0, 0, size, size);
  // Vignette: a real ocular darkens hard at the edge of the tube.
  const vig = g.createRadialGradient(h, h, h * 0.55, h, h, h);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(0,0,0,0.92)");
  g.fillStyle = vig;
  g.fillRect(0, 0, size, size);

  g.strokeStyle = "rgba(16,18,20,0.95)";
  g.lineWidth = Math.max(2, size / 90);
  // Duplex: thick outer posts, thin centre.
  const thick = Math.max(4, size / 34);
  g.lineWidth = thick;
  for (const [x0, y0, x1, y1] of [
    [0, h, h * 0.5, h],
    [size, h, h * 1.5, h],
    [h, 0, h, h * 0.5],
    [h, size, h, h * 1.5],
  ]) {
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  }
  g.lineWidth = Math.max(1.5, size / 128);
  g.beginPath();
  g.moveTo(h * 0.5, h);
  g.lineTo(h * 1.5, h);
  g.moveTo(h, h * 0.5);
  g.lineTo(h, h * 1.5);
  g.stroke();
  // Mil-dot ladder below centre — the drop compensation the round needs.
  for (let i = 1; i <= 4; i++) {
    const y = h + (i * h * 0.5) / 5;
    const w = h * (0.055 - i * 0.006);
    g.beginPath();
    g.moveTo(h - w, y);
    g.lineTo(h + w, y);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------- geometry

/**
 * A rounded rectangle in the XY plane, used as the profile every extruded
 * body part is built from. Corner radius is clamped so a thin part cannot
 * collapse into a lens.
 */
function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = w / 2;
  const y = h / 2;
  const c = Math.max(0.0003, Math.min(r, x * 0.85, y * 0.85));
  s.moveTo(-x + c, -y);
  s.lineTo(x - c, -y);
  s.quadraticCurveTo(x, -y, x, -y + c);
  s.lineTo(x, y - c);
  s.quadraticCurveTo(x, y, x - c, y);
  s.lineTo(-x + c, y);
  s.quadraticCurveTo(-x, y, -x, y - c);
  s.lineTo(-x, -y + c);
  s.quadraticCurveTo(-x, -y, -x + c, -y);
  return s;
}

/**
 * A box with a genuine chamfer on all twelve edges, centred on the origin and
 * extruded along Z. This is the workhorse: receivers, handguards, stocks and
 * magazines are all bevelled boxes in different proportions. Hard-edged boxes
 * are the "no bevel or thickness" tell — a chamfer catches a highlight and is
 * the cheapest AAA cue there is.
 */
function bevelBox(w: number, h: number, d: number, bevel: number, corner: number): THREE.BufferGeometry {
  const b = Math.max(0.0004, Math.min(bevel, w * 0.3, h * 0.3, d * 0.3));
  const shape = roundedRect(w - 2 * b, h - 2 * b, corner);
  const depth = Math.max(0.0008, d - 2 * b);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 1,
    curveSegments: 2,
    steps: 1,
  });
  geo.translate(0, 0, -depth / 2);
  geo.computeVertexNormals();
  return geo;
}

/** Cylinder along -Z (three's cylinders default to +Y, so we rotate). */
function tubeGeo(rTop: number, rBottom: number, len: number, seg: number, open: boolean): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(rTop, rBottom, len, seg, 1, open);
  geo.rotateX(Math.PI / 2);
  return geo;
}

/**
 * Strip a geometry down to the attribute set `mergeGeometries` will accept and
 * make it non-indexed, because it refuses to merge a mixed set and half the
 * primitives here are indexed while `ExtrudeGeometry` is not.
 */
function normalise(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geo;
  if (g.index) {
    const flat = g.toNonIndexed();
    g.dispose();
    g = flat;
  }
  for (const key of Object.keys(g.attributes)) {
    if (key !== "position" && key !== "normal" && key !== "uv") g.deleteAttribute(key);
  }
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  if (!g.getAttribute("uv")) {
    const n = g.getAttribute("position").count;
    g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  }
  return g;
}

// ---------------------------------------------------------------- surfaces

type SurfaceId = "steel" | "alloy" | "polymer" | "rubber" | "brass" | "accent" | "glass" | "reticle" | "hot";

interface SurfaceSpec {
  color: number;
  roughness: number;
  metalness: number;
  /** Which procedural roughness/normal pair the surface uses. */
  grain: "metal" | "polymer" | "none";
}

/**
 * The hardware palette. Deliberately not grey-on-grey: Drop Zero is a
 * saturated island and a gun that is six shades of charcoal disappears against
 * the character's navy drop suit. `accent` is overridden per rarity at
 * runtime, which is how a legendary reads as legendary at a glance.
 */
const SURFACES: Record<SurfaceId, SurfaceSpec> = {
  steel: { color: 0x33373d, roughness: 0.52, metalness: 0.9, grain: "metal" },
  alloy: { color: 0x707a86, roughness: 0.38, metalness: 0.95, grain: "metal" },
  polymer: { color: 0x2a2d33, roughness: 0.79, metalness: 0.05, grain: "polymer" },
  rubber: { color: 0x17181b, roughness: 0.95, metalness: 0.0, grain: "polymer" },
  brass: { color: 0xc7a04a, roughness: 0.29, metalness: 1.0, grain: "metal" },
  accent: { color: 0xb1b1b1, roughness: 0.34, metalness: 0.72, grain: "metal" },
  glass: { color: 0x9fdcff, roughness: 0.05, metalness: 0.15, grain: "none" },
  reticle: { color: 0xff4c33, roughness: 1, metalness: 0, grain: "none" },
  hot: { color: 0x1a1210, roughness: 0.55, metalness: 0.8, grain: "metal" },
};

interface Kit {
  material(id: SurfaceId): THREE.Material;
  /** Rarity-tinted anodising, cached per rarity. */
  accent(rarity: Rarity): THREE.Material;
  readonly hot: THREE.MeshStandardMaterial;
  track<T extends THREE.BufferGeometry>(g: T): T;
  dispose(): void;
}

function makeKit(ctx: WorldCtx): Kit {
  const size = ctx.quality === "ultra" ? 512 : ctx.quality === "low" ? 128 : 256;
  const rng = ctx.rng;
  const metalRough = makeMetalRoughness(rng, size);
  const polyRough = makePolymerRoughness(rng, size);
  const grainNormal = makeSurfaceNormal(rng, size);
  const env = ctx.services.materials?.env ?? null;

  const textures: THREE.Texture[] = [metalRough, polyRough, grainNormal];
  const materials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const cache = new Map<string, THREE.Material>();

  const build = (id: SurfaceId, color: number): THREE.Material => {
    const spec = SURFACES[id];
    if (id === "reticle") {
      // Unlit and untonemapped so the dot stays hot at dusk, which is when
      // half of this match is played.
      const m = new THREE.MeshBasicMaterial({ color, toneMapped: false });
      materials.push(m);
      return m;
    }
    const m = new THREE.MeshStandardMaterial({
      // White base: the albedo comes from vertex colour, which is how one
      // material covers every painted part on the gun without a texture atlas.
      color: 0xffffff,
      roughness: spec.roughness,
      metalness: spec.metalness,
      vertexColors: true,
      envMap: env,
      envMapIntensity: spec.metalness > 0.5 ? 1.15 : 0.5,
      dithering: true,
    });
    if (spec.grain === "metal") {
      m.roughnessMap = metalRough;
      m.normalMap = grainNormal;
      m.normalScale = new THREE.Vector2(0.55, 0.55);
    } else if (spec.grain === "polymer") {
      m.roughnessMap = polyRough;
      m.normalMap = grainNormal;
      m.normalScale = new THREE.Vector2(0.8, 0.8);
    }
    if (id === "glass") {
      m.transparent = true;
      m.opacity = 0.34;
      m.depthWrite = false;
    }
    if (id === "hot") {
      m.emissive = new THREE.Color(0xff5a18);
      m.emissiveIntensity = 0;
    }
    materials.push(m);
    return m;
  };

  const hot = build("hot", SURFACES.hot.color) as THREE.MeshStandardMaterial;
  cache.set("hot", hot);

  return {
    material(id) {
      let m = cache.get(id);
      if (!m) {
        m = build(id, SURFACES[id].color);
        cache.set(id, m);
      }
      return m;
    },
    accent(rarity) {
      const key = `accent:${rarity}`;
      let m = cache.get(key);
      if (!m) {
        m = build("accent", SURFACES.accent.color);
        // Rarity tint lives on the material colour rather than the vertex
        // colour so a single pair of merged meshes can be re-tiered the
        // instant the player picks up a better gun.
        _color.setHex(RARITY_COLOR[rarity]);
        // Pull it well down in value: full-chroma rarity paint on a whole
        // receiver looks like a toy. This is anodised trim, not a skin.
        _color2.setRGB(
          lerp(0.13, _color.r, 0.62),
          lerp(0.13, _color.g, 0.62),
          lerp(0.14, _color.b, 0.62),
        );
        (m as THREE.MeshStandardMaterial).color.copy(_color2);
        cache.set(key, m);
      }
      return m;
    },
    hot,
    track(g) {
      geometries.push(g);
      return g;
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
    },
  };
}

// ---------------------------------------------------------------- builder

/** Animated sub-assemblies. Everything else merges into one static body. */
type PartGroup = "body" | "slide" | "mag" | "barrels";

interface PartOpts {
  /** Chamfer size; defaults to a sensible fraction of the smallest extent. */
  bevel?: number;
  corner?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  /** Override the surface's base colour for this part. */
  tint?: number;
  /**
   * Fake ambient occlusion, 0..1. Darkens downward-facing vertices — the
   * single cheapest way to stop a prop reading as a flat-lit assembly of
   * boxes, and the reason the underside of a handguard is not the same value
   * as the top of it.
   */
  ao?: number;
  /** Polish at contact points, 0..1. Brightens upward/outward faces. */
  wear?: number;
  /** Flat multiplier — grime in a recess, soot at a muzzle. */
  dark?: number;
  /** Segment count override for round parts. */
  seg?: number;
  /** Mark the part as rarity-tinted trim. */
  accent?: boolean;
}

/**
 * Collects authored parts per (group, surface) so every weapon ends up as a
 * handful of merged meshes instead of eighty draw calls. A gun that costs 80
 * calls in the viewmodel *and* 80 in third person is a third of the frame
 * budget for two objects.
 */
class GunBuilder {
  private bins = new Map<string, THREE.BufferGeometry[]>();
  /** Bins whose material is the rarity accent rather than a fixed surface. */
  private accentBins = new Set<string>();

  constructor(private readonly rng: () => number, private readonly lod: number) {}

  private push(group: PartGroup, surface: SurfaceId, geo: THREE.BufferGeometry, o: PartOpts): void {
    const g = normalise(geo);
    if (o.rx || o.ry || o.rz) {
      _mat4.makeRotationFromEuler(_e1.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0, "YXZ"));
      g.applyMatrix4(_mat4);
    }
    this.paint(g, surface, o);
    const key = `${group}|${o.accent ? "accent" : surface}`;
    if (o.accent) this.accentBins.add(key);
    let bin = this.bins.get(key);
    if (!bin) {
      bin = [];
      this.bins.set(key, bin);
    }
    bin.push(g);
  }

  /**
   * Bake albedo + occlusion + wear into vertex colours. Doing it here rather
   * than with a texture is what lets nine weapons share nine materials: the
   * per-part variation that would otherwise need a unique map is carried by
   * the mesh itself, and it costs three floats a vertex.
   */
  private paint(g: THREE.BufferGeometry, surface: SurfaceId, o: PartOpts): void {
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    const nor = g.getAttribute("normal") as THREE.BufferAttribute;
    const n = pos.count;
    const col = new Float32Array(n * 3);
    _color.setHex(o.tint ?? SURFACES[surface].color);
    const ao = o.ao ?? 0.34;
    const wear = o.wear ?? 0;
    const dark = o.dark ?? 1;

    // Vertical extent of this part, so the occlusion gradient is relative to
    // the part rather than to the whole gun.
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const y = pos.getY(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const span = Math.max(1e-4, maxY - minY);

    for (let i = 0; i < n; i++) {
      const ny = nor.getY(i);
      const h = (pos.getY(i) - minY) / span;
      // Downward normals and low vertices sit in shadow.
      let k = 1 - ao * (0.5 - 0.5 * ny) * (1.25 - 0.5 * h);
      // Contact wear: the top of a rail, the edge of a charging handle, the
      // crown of a barrel. Brightened *and* desaturated toward bare metal.
      const up = Math.max(0, ny);
      const polish = wear * up * up * (0.35 + 0.65 * h);
      k *= dark;
      // A little per-vertex mottling: no real surface is uniform, and this is
      // free variation at a scale a texture would never resolve on a 2 cm part.
      k *= 0.955 + this.rng() * 0.09;
      const j = i * 3;
      col[j] = clamp01(_color.r * k + polish * 0.55);
      col[j + 1] = clamp01(_color.g * k + polish * 0.56);
      col[j + 2] = clamp01(_color.b * k + polish * 0.6);
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  }

  box(
    group: PartGroup,
    surface: SurfaceId,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    o: PartOpts = {},
  ): void {
    const bevel = o.bevel ?? Math.min(w, h, d) * 0.16;
    const geo = bevelBox(w, h, d, bevel, o.corner ?? bevel * 1.4);
    geo.translate(0, 0, 0);
    this.pushAt(group, surface, geo, x, y, z, o);
  }

  cyl(
    group: PartGroup,
    surface: SurfaceId,
    rTop: number,
    rBottom: number,
    len: number,
    x: number,
    y: number,
    z: number,
    o: PartOpts = {},
  ): void {
    const seg = o.seg ?? (this.lod > 0 ? 14 : 8);
    this.pushAt(group, surface, tubeGeo(rTop, rBottom, len, seg, false), x, y, z, o);
  }

  cone(
    group: PartGroup,
    surface: SurfaceId,
    r: number,
    len: number,
    x: number,
    y: number,
    z: number,
    o: PartOpts = {},
  ): void {
    const seg = o.seg ?? (this.lod > 0 ? 14 : 8);
    const geo = new THREE.ConeGeometry(r, len, seg, 1);
    geo.rotateX(-Math.PI / 2);
    this.pushAt(group, surface, geo, x, y, z, o);
  }

  sphere(
    group: PartGroup,
    surface: SurfaceId,
    r: number,
    x: number,
    y: number,
    z: number,
    o: PartOpts = {},
  ): void {
    const seg = o.seg ?? (this.lod > 0 ? 10 : 6);
    this.pushAt(group, surface, new THREE.SphereGeometry(r, seg, Math.max(4, seg - 2)), x, y, z, o);
  }

  torus(
    group: PartGroup,
    surface: SurfaceId,
    radius: number,
    tube: number,
    arc: number,
    x: number,
    y: number,
    z: number,
    o: PartOpts = {},
  ): void {
    const seg = o.seg ?? (this.lod > 0 ? 16 : 10);
    this.pushAt(group, surface, new THREE.TorusGeometry(radius, tube, 6, seg, arc), x, y, z, o);
  }

  private pushAt(
    group: PartGroup,
    surface: SurfaceId,
    geo: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    o: PartOpts,
  ): void {
    this.push(group, surface, geo, o);
    const bin = this.bins.get(`${group}|${o.accent ? "accent" : surface}`);
    if (!bin) return;
    bin[bin.length - 1].translate(x, y, z);
  }

  // ---- composite details -------------------------------------------------

  /**
   * Picatinny rail. Cheap, but a run of slots is exactly the small-scale trim
   * whose absence makes a prop look like a blockout.
   */
  rail(group: PartGroup, len: number, y: number, z: number, w = 0.021): void {
    this.box(group, "steel", w, 0.007, len, 0, y, z, { ao: 0.5, wear: 0.35 });
    // Slot pitch halves on the low tier: sixteen bevelled boxes per rail, nine
    // weapons deep, is real boot time for detail nobody resolves at 1× DPR.
    const n = Math.max(2, Math.floor(len / (this.lod > 0 ? 0.018 : 0.034)));
    for (let i = 0; i < n; i++) {
      this.box(group, "steel", w * 1.05, 0.0055, 0.0055, 0, y + 0.004, z - len / 2 + 0.009 + i * (len / n), {
        bevel: 0.0012,
        ao: 0.8,
        dark: 0.82,
      });
    }
  }

  /** A run of cooling slots or vents cut into a panel. */
  vents(
    group: PartGroup,
    surface: SurfaceId,
    count: number,
    w: number,
    h: number,
    x: number,
    y: number,
    z0: number,
    pitch: number,
    o: PartOpts = {},
  ): void {
    for (let i = 0; i < count; i++) {
      this.box(group, surface, w, h, pitch * 0.55, x, y, z0 + i * pitch, {
        bevel: Math.min(w, h) * 0.3,
        ao: 0.9,
        dark: 0.6,
        ...o,
      });
    }
  }

  /** Hex screw heads. Two of these on a receiver sell "assembled from parts". */
  screws(group: PartGroup, r: number, y: number, zs: number[], x = 0): void {
    for (const z of zs) {
      this.cyl(group, "alloy", r, r, 0.004, x, y, z, { seg: 6, rx: Math.PI / 2, ao: 0.7, wear: 0.5 });
      this.cyl(group, "steel", r * 0.5, r * 0.5, 0.005, x, y + 0.001, z, {
        seg: 6,
        rx: Math.PI / 2,
        ao: 1,
        dark: 0.55,
      });
    }
  }

  /** Sling loop — a torus on a lug. Reads at a glance, costs 60 triangles. */
  slingLoop(group: PartGroup, x: number, y: number, z: number, rz = 0): void {
    this.box(group, "steel", 0.012, 0.016, 0.012, x, y, z, { bevel: 0.002, ao: 0.6 });
    this.torus(group, "alloy", 0.011, 0.0022, Math.PI * 2, x, y - 0.014, z, {
      rx: Math.PI / 2,
      rz,
      ao: 0.5,
      wear: 0.6,
    });
  }

  /**
   * Trigger group: guard loop, blade, grip with a palm swell and a checkered
   * backstrap. Shared by every gun in the arsenal.
   */
  triggerGroup(group: PartGroup, z: number, gripLen = 0.115, tilt = 0.3): void {
    this.torus(group, "steel", 0.026, 0.005, Math.PI * 1.3, 0, -0.036, z, {
      ry: Math.PI / 2,
      rz: -Math.PI * 0.64,
      ao: 0.55,
      wear: 0.3,
    });
    this.box(group, "alloy", 0.006, 0.026, 0.008, 0, -0.03, z + 0.004, { bevel: 0.0015, ao: 0.7, wear: 0.4 });
    const gy = -0.036 - gripLen * 0.46;
    this.box(group, "polymer", 0.031, gripLen, 0.05, 0, gy, z + 0.05, {
      bevel: 0.008,
      corner: 0.012,
      rx: tilt,
      ao: 0.5,
    });
    // Backstrap: a rubber panel, slightly proud, so the grip is two materials.
    this.box(group, "rubber", 0.033, gripLen * 0.62, 0.014, 0, gy + gripLen * 0.02, z + 0.072, {
      bevel: 0.005,
      rx: tilt,
      ao: 0.6,
      wear: 0.15,
    });
    // Mag release + a screw, on the left where the thumb finds it.
    this.box(group, "accent", 0.007, 0.012, 0.012, -0.017, -0.03, z + 0.016, {
      bevel: 0.002,
      accent: true,
      ao: 0.4,
      wear: 0.5,
    });
    this.box(group, "polymer", 0.034, 0.012, 0.048, 0, gy - gripLen * 0.52, z + 0.052, {
      bevel: 0.004,
      rx: tilt,
      ao: 0.75,
      wear: 0.3,
    });
  }

  /**
   * Iron/red-dot sight. Returns the Y/Z the ADS pose must align to screen
   * centre; the caller turns that into the `optic` node.
   */
  optic(group: PartGroup, y: number, z: number, scale = 1): [number, number] {
    const s = scale;
    this.box(group, "steel", 0.038 * s, 0.04 * s, 0.086 * s, 0, y + 0.019 * s, z, {
      bevel: 0.004,
      ao: 0.55,
      wear: 0.25,
    });
    this.box(group, "alloy", 0.03 * s, 0.013, 0.05, 0, y - 0.002, z + 0.004, { bevel: 0.003, ao: 0.7 });
    this.cyl(group, "glass", 0.014 * s, 0.014 * s, 0.0018, 0, y + 0.019 * s, z - 0.04 * s, { ao: 0 });
    this.cyl(group, "glass", 0.014 * s, 0.014 * s, 0.0018, 0, y + 0.019 * s, z + 0.04 * s, { ao: 0 });
    this.sphere(group, "reticle", 0.0022, 0, y + 0.019 * s, z - 0.018, { ao: 0 });
    // Mount lugs + thumbscrews.
    this.box(group, "steel", 0.024, 0.015, 0.019, 0, y - 0.012, z - 0.026, { bevel: 0.003, ao: 0.75 });
    this.box(group, "steel", 0.024, 0.015, 0.019, 0, y - 0.012, z + 0.026, { bevel: 0.003, ao: 0.75 });
    this.screws(group, 0.0045, y - 0.012, [z - 0.026, z + 0.026], 0.013);
    return [y + 0.019 * s, z];
  }

  /**
   * Emit the merged meshes into `parent` groups and hand back the accent
   * meshes so rarity can re-tint them later.
   */
  finish(
    kit: Kit,
    groups: Record<PartGroup, THREE.Object3D | null>,
    accentOut: THREE.Mesh[],
  ): void {
    for (const [key, parts] of this.bins) {
      if (!parts.length) continue;
      const [group, surface] = key.split("|") as [PartGroup, SurfaceId];
      const parent = groups[group];
      if (!parent) continue;
      const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
      if (parts.length > 1) {
        for (const p of parts) p.dispose();
      }
      if (!merged) continue;
      merged.computeBoundingSphere();
      kit.track(merged);
      const isAccent = this.accentBins.has(key);
      const mat = isAccent ? kit.accent("common") : kit.material(surface);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      if (isAccent) {
        mesh.userData.accent = true;
        accentOut.push(mesh);
      }
      if (surface === "glass") mesh.renderOrder = 3;
      parent.add(mesh);
    }
    this.bins.clear();
  }
}

// ---------------------------------------------------------------- rigs

/** The animatable handles a builder must hand back. */
interface WeaponRig {
  root: THREE.Group;
  /** Everything that recoils as one mass. */
  body: THREE.Group;
  /** Reciprocating mass: slide, bolt carrier, pump. */
  slide: THREE.Group | null;
  /** Detachable magazine — animated out and back during a reload. */
  mag: THREE.Group | null;
  /** Spinning barrel cluster, if any. */
  barrels: THREE.Group | null;
  /** Muzzle tip: flash, projectile origin, tracer origin. */
  muzzle: THREE.Object3D;
  /** Ejection port. */
  eject: THREE.Object3D;
  /** Sight line — ADS aligns this with screen centre. */
  optic: THREE.Object3D;
  /** Meshes carrying the rarity tint. */
  accents: THREE.Mesh[];
  /** Scope ocular plane, shown only when this weapon is fully sighted. */
  ocular: THREE.Mesh | null;
}

/**
 * Wire up the shared skeleton every builder returns. `slide`, `mag` and
 * `barrels` are always created — a builder that authors nothing into them
 * leaves an empty group, which costs one matrix and keeps the animation code
 * free of null checks it would otherwise repeat nine times.
 */
function makeRigShell(): {
  rig: WeaponRig;
  groups: Record<PartGroup, THREE.Object3D | null>;
} {
  const root = new THREE.Group();
  const body = new THREE.Group();
  const slide = new THREE.Group();
  const mag = new THREE.Group();
  const barrels = new THREE.Group();
  root.add(body);
  body.add(slide, mag, barrels);

  const muzzle = new THREE.Object3D();
  const eject = new THREE.Object3D();
  const optic = new THREE.Object3D();
  body.add(muzzle, eject, optic);

  const rig: WeaponRig = {
    root,
    body,
    slide,
    mag,
    barrels,
    muzzle,
    eject,
    optic,
    accents: [],
    ocular: null,
  };
  return { rig, groups: { body, slide, mag, barrels } };
}

/**
 * A scope ocular: the reticle image on a plane inside the tube. Only made
 * visible once ADS has fully committed, because a reticle floating in the
 * middle of a hip-fire pose is the sort of thing that reads as a bug.
 */
function addOcular(
  rig: WeaponRig,
  reticleTex: THREE.Texture,
  radius: number,
  y: number,
  z: number,
): void {
  const mat = new THREE.MeshBasicMaterial({
    map: reticleTex,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    opacity: 0,
  });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 24), mat);
  mesh.position.set(0, y, z);
  mesh.rotation.y = Math.PI;
  mesh.renderOrder = 6;
  mesh.frustumCulled = false;
  mesh.visible = false;
  rig.body.add(mesh);
  rig.ocular = mesh;
}

type BuilderCtx = { kit: Kit; lod: number; rng: () => number; reticle: THREE.Texture };

// Local space for every builder: -Z is downrange, +Y up, +X right, origin at
// the top of the pistol grip. Real-world metres — the viewmodel scale is
// applied to the root, so the proportions stay honest.

function buildPistol(c: BuilderCtx): WeaponRig {
  const { rig, groups } = makeRigShell();
  const b = new GunBuilder(c.rng, c.lod);

  // Polymer frame + dust cover.
  b.box("body", "polymer", 0.026, 0.03, 0.168, 0, -0.016, -0.012, { bevel: 0.004, ao: 0.5 });
  b.box("body", "polymer", 0.028, 0.012, 0.07, 0, -0.028, -0.06, { bevel: 0.003, ao: 0.7 });
  // Accessory rail under the dust cover — the little detail that says "modern".
  b.vents("body", "steel", 3, 0.02, 0.005, 0, -0.035, -0.075, 0.016, { dark: 0.75 });
  b.triggerGroup("body", 0.012, 0.104, 0.24);

  // Slide: the reciprocating mass. Serrations front and rear.
  b.box("slide", "alloy", 0.028, 0.032, 0.182, 0, 0.012, -0.022, { bevel: 0.004, corner: 0.006, ao: 0.42, wear: 0.5 });
  for (let i = 0; i < 6; i++) {
    b.box("slide", "steel", 0.0292, 0.022, 0.003, 0, 0.012, 0.046 + i * 0.0072, {
      bevel: 0.001,
      ao: 0.85,
      dark: 0.78,
    });
  }
  for (let i = 0; i < 3; i++) {
    b.box("slide", "steel", 0.0292, 0.018, 0.003, 0, 0.012, -0.086 - i * 0.0072, {
      bevel: 0.001,
      ao: 0.85,
      dark: 0.78,
    });
  }
  // Ejection port, front sight, rear notch.
  b.box("slide", "steel", 0.02, 0.013, 0.03, 0.007, 0.021, 0.008, { bevel: 0.002, ao: 1, dark: 0.5 });
  b.box("slide", "steel", 0.004, 0.008, 0.004, 0, 0.03, -0.1, { bevel: 0.001, wear: 0.7 });
  b.box("slide", "steel", 0.016, 0.008, 0.006, 0, 0.03, 0.05, { bevel: 0.001, ao: 0.6, wear: 0.5 });
  b.box("slide", "accent", 0.03, 0.006, 0.05, 0, 0.026, -0.05, { bevel: 0.002, accent: true, ao: 0.3, wear: 0.4 });

  // Barrel crown, visible through the port.
  b.cyl("body", "alloy", 0.0082, 0.0082, 0.19, 0, 0.012, -0.05, { ao: 0.4, wear: 0.3 });
  b.cyl("body", "steel", 0.0105, 0.0105, 0.012, 0, 0.012, -0.142, { ao: 0.5, dark: 0.8 });

  // Magazine + floorplate.
  b.box("mag", "steel", 0.021, 0.098, 0.03, 0, -0.094, 0.06, { bevel: 0.003, ao: 0.55 });
  b.box("mag", "polymer", 0.027, 0.01, 0.04, 0, -0.147, 0.062, { bevel: 0.003, ao: 0.6, wear: 0.2 });
  b.box("mag", "accent", 0.023, 0.005, 0.006, 0, -0.055, 0.045, { bevel: 0.0015, accent: true, wear: 0.4 });

  const [oy, oz] = b.optic("body", 0.03, -0.03, 0.85);
  rig.optic.position.set(0, oy, oz);
  rig.muzzle.position.set(0, 0.012, -0.15);
  rig.eject.position.set(0.02, 0.026, 0.008);

  b.finish(c.kit, groups, rig.accents);
  return rig;
}

function buildAssaultRifle(c: BuilderCtx): WeaponRig {
  const { rig, groups } = makeRigShell();
  const b = new GunBuilder(c.rng, c.lod);

  // Upper + lower receiver. Two materials, two values — a one-piece grey
  // receiver is the flattest thing you can put in a player's hands.
  b.box("body", "alloy", 0.048, 0.054, 0.235, 0, 0.014, 0.02, { bevel: 0.005, corner: 0.008, ao: 0.42, wear: 0.3 });
  b.box("body", "polymer", 0.045, 0.048, 0.185, 0, -0.03, 0.03, { bevel: 0.005, corner: 0.008, ao: 0.55 });
  b.box("body", "accent", 0.05, 0.013, 0.098, 0, 0.04, -0.02, { bevel: 0.003, accent: true, ao: 0.3, wear: 0.45 });
  b.rail("body", 0.29, 0.045, -0.055);
  b.screws("body", 0.005, 0.0, [0.09, -0.04], 0.024);

  // Handguard with cooling slots top and bottom, plus a rubber hand stop.
  b.box("body", "polymer", 0.045, 0.05, 0.215, 0, 0.012, -0.205, { bevel: 0.006, corner: 0.01, ao: 0.5 });
  b.vents("body", "steel", 5, 0.049, 0.006, 0, 0.026, -0.275, 0.035, {});
  b.vents("body", "steel", 5, 0.049, 0.006, 0, -0.002, -0.275, 0.035, {});
  b.box("body", "rubber", 0.029, 0.028, 0.066, 0, -0.019, -0.19, { bevel: 0.008, rx: 0.22, ao: 0.65 });
  b.slingLoop("body", 0.024, -0.004, -0.13);

  // Barrel, gas block, muzzle brake with real ports.
  b.cyl("body", "steel", 0.0095, 0.0112, 0.35, 0, 0.012, -0.25, { ao: 0.45, wear: 0.2 });
  b.box("body", "alloy", 0.021, 0.029, 0.029, 0, 0.02, -0.305, { bevel: 0.004, ao: 0.5, wear: 0.35 });
  b.cyl("body", "alloy", 0.0155, 0.0175, 0.052, 0, 0.012, -0.437, { ao: 0.45, wear: 0.4, dark: 0.9 });
  for (let i = 0; i < 3; i++) {
    b.box("body", "steel", 0.037, 0.005, 0.006, 0, 0.012, -0.452 + i * 0.014, {
      bevel: 0.0012,
      ao: 0.9,
      dark: 0.55,
    });
  }
  // Soot at the crown — wear at contact points, and this contact is fire.
  b.cyl("body", "steel", 0.0125, 0.0125, 0.006, 0, 0.012, -0.462, { ao: 1, dark: 0.42 });

  // Bolt carrier group + charging handle. Polished, because a hand lives here.
  b.box("slide", "alloy", 0.038, 0.012, 0.05, 0, 0.044, 0.122, { bevel: 0.003, ao: 0.4, wear: 0.75 });
  b.box("slide", "steel", 0.058, 0.01, 0.014, 0, 0.044, 0.148, { bevel: 0.003, ao: 0.5, wear: 0.65 });
  b.box("slide", "steel", 0.012, 0.02, 0.034, 0.025, 0.02, 0.03, { bevel: 0.003, ao: 0.6, wear: 0.5 });

  // Canted magazine with a witness window.
  b.box("mag", "polymer", 0.027, 0.148, 0.072, 0, -0.128, 0.006, { bevel: 0.005, corner: 0.012, rx: 0.1, ao: 0.55 });
  b.box("mag", "rubber", 0.031, 0.011, 0.082, 0, -0.201, 0.014, { bevel: 0.003, rx: 0.1, ao: 0.7, wear: 0.25 });
  b.box("mag", "accent", 0.029, 0.046, 0.006, 0, -0.138, -0.032, { bevel: 0.002, rx: 0.1, accent: true, ao: 0.4 });

  b.triggerGroup("body", 0.052, 0.118, 0.3);

  // Stock: tube, cheek riser, rubber pad, sling slot.
  b.box("body", "alloy", 0.026, 0.028, 0.108, 0, 0.006, 0.172, { bevel: 0.005, ao: 0.55, wear: 0.3 });
  b.box("body", "polymer", 0.04, 0.05, 0.084, 0, 0.008, 0.242, { bevel: 0.006, corner: 0.012, ao: 0.5 });
  b.box("body", "polymer", 0.034, 0.023, 0.086, 0, 0.036, 0.218, { bevel: 0.009, ao: 0.4, wear: 0.3 });
  b.box("body", "rubber", 0.044, 0.06, 0.013, 0, 0.004, 0.282, { bevel: 0.004, ao: 0.6, wear: 0.2 });
  b.slingLoop("body", -0.021, 0.0, 0.2, Math.PI / 2);

  const [oy, oz] = b.optic("body", 0.056, -0.03, 1);
  rig.optic.position.set(0, oy, oz);
  rig.muzzle.position.set(0, 0.012, -0.468);
  rig.eject.position.set(0.028, 0.024, 0.03);

  b.finish(c.kit, groups, rig.accents);
  return rig;
}

function buildSmg(c: BuilderCtx): WeaponRig {
  const { rig, groups } = makeRigShell();
  const b = new GunBuilder(c.rng, c.lod);

  // Short, fat, and obviously a different silhouette from the AR at 30 m.
  b.box("body", "polymer", 0.05, 0.062, 0.19, 0, 0.008, 0.01, { bevel: 0.006, corner: 0.012, ao: 0.5 });
  b.box("body", "alloy", 0.044, 0.03, 0.12, 0, 0.032, -0.02, { bevel: 0.004, ao: 0.42, wear: 0.35 });
  b.box("body", "accent", 0.052, 0.01, 0.07, 0, 0.049, 0.0, { bevel: 0.003, accent: true, ao: 0.3, wear: 0.4 });
  b.rail("body", 0.15, 0.052, -0.06, 0.019);

  // Wrap-around handguard with finger grooves.
  b.box("body", "polymer", 0.042, 0.044, 0.13, 0, 0.004, -0.155, { bevel: 0.006, corner: 0.012, ao: 0.55 });
  for (let i = 0; i < 4; i++) {
    b.torus("body", "rubber", 0.021, 0.0035, Math.PI * 1.2, 0, -0.012, -0.11 - i * 0.028, {
      ry: Math.PI / 2,
      rz: Math.PI * 0.9,
      ao: 0.7,
    });
  }
  b.vents("body", "steel", 4, 0.043, 0.005, 0, 0.024, -0.19, 0.024, {});

  // Stubby barrel + flash hider.
  b.cyl("body", "steel", 0.0085, 0.0098, 0.2, 0, 0.006, -0.16, { ao: 0.45 });
  b.cyl("body", "alloy", 0.0135, 0.0125, 0.036, 0, 0.006, -0.245, { ao: 0.5, wear: 0.35 });
  for (let i = 0; i < 4; i++) {
    b.box("body", "steel", 0.0285, 0.004, 0.026, 0, 0.006, -0.247, {
      bevel: 0.001,
      rz: (i / 4) * Math.PI,
      ao: 0.9,
      dark: 0.5,
    });
  }

  // Side-charging bolt.
  b.box("slide", "steel", 0.014, 0.016, 0.05, -0.026, 0.03, 0.02, { bevel: 0.003, ao: 0.5, wear: 0.7 });
  b.cyl("slide", "alloy", 0.007, 0.007, 0.018, -0.036, 0.03, 0.02, { rz: Math.PI / 2, ry: Math.PI / 2, ao: 0.4, wear: 0.8 });

  // Long stick mag, canted forward, with a taped-on spare's ribbing.
  b.box("mag", "polymer", 0.026, 0.17, 0.052, 0, -0.128, 0.022, { bevel: 0.005, corner: 0.01, rx: -0.14, ao: 0.55 });
  for (let i = 0; i < 5; i++) {
    b.box("mag", "polymer", 0.028, 0.004, 0.05, 0, -0.07 - i * 0.03, 0.017 + i * 0.004, {
      bevel: 0.0012,
      rx: -0.14,
      ao: 0.85,
      dark: 0.8,
    });
  }
  b.box("mag", "accent", 0.028, 0.009, 0.014, 0, -0.212, 0.034, { bevel: 0.002, rx: -0.14, accent: true, wear: 0.4 });

  b.triggerGroup("body", 0.04, 0.108, 0.28);

  // Folding wire stock — three tubes and a pad, unmistakable in silhouette.
  b.cyl("body", "steel", 0.0075, 0.0075, 0.13, -0.022, 0.028, 0.11, { ao: 0.5, wear: 0.3 });
  b.cyl("body", "steel", 0.0075, 0.0075, 0.13, 0.022, 0.028, 0.11, { ao: 0.5, wear: 0.3 });
  b.box("body", "rubber", 0.056, 0.05, 0.014, 0, 0.028, 0.176, { bevel: 0.005, ao: 0.6, wear: 0.2 });
  b.slingLoop("body", 0.026, 0.0, 0.08);

  const [oy, oz] = b.optic("body", 0.055, -0.045, 0.9);
  rig.optic.position.set(0, oy, oz);
  rig.muzzle.position.set(0, 0.006, -0.262);
  rig.eject.position.set(0.026, 0.024, 0.02);

  b.finish(c.kit, groups, rig.accents);
  return rig;
}

function buildPumpShotgun(c: BuilderCtx): WeaponRig {
  const { rig, groups } = makeRigShell();
  const b = new GunBuilder(c.rng, c.lod);

  // Machined steel receiver — the pump is the heaviest thing in the game and
  // it has to look it.
  b.box("body", "alloy", 0.044, 0.056, 0.2, 0, 0.012, 0.03, { bevel: 0.005, corner: 0.008, ao: 0.45, wear: 0.35 });
  b.box("body", "steel", 0.046, 0.018, 0.09, 0, 0.038, 0.02, { bevel: 0.004, ao: 0.4, wear: 0.5 });
  b.box("body", "accent", 0.048, 0.008, 0.05, 0, 0.047, 0.03, { bevel: 0.002, accent: true, ao: 0.3, wear: 0.45 });
  b.screws("body", 0.005, 0.006, [-0.03, 0.09], 0.023);
  // Loading port and shell lifter, cut into the belly.
  b.box("body", "steel", 0.03, 0.014, 0.06, 0, -0.017, 0.05, { bevel: 0.002, ao: 1, dark: 0.45 });

  // Barrel + magazine tube, clamped together. Two parallel cylinders is the
  // whole silhouette read at range.
  b.cyl("body", "steel", 0.0155, 0.0165, 0.42, 0, 0.019, -0.24, { ao: 0.4, wear: 0.25 });
  b.cyl("body", "steel", 0.0125, 0.0125, 0.33, 0, -0.011, -0.195, { ao: 0.55 });
  b.cyl("body", "alloy", 0.0145, 0.0145, 0.02, 0, -0.011, -0.355, { ao: 0.5, wear: 0.4 });
  b.box("body", "alloy", 0.03, 0.05, 0.018, 0, 0.004, -0.31, { bevel: 0.004, ao: 0.6, wear: 0.3 });
  b.box("body", "alloy", 0.03, 0.05, 0.018, 0, 0.004, -0.13, { bevel: 0.004, ao: 0.6, wear: 0.3 });
  // Bead front sight on a ramp.
  b.box("body", "steel", 0.008, 0.012, 0.018, 0, 0.033, -0.42, { bevel: 0.002, ao: 0.5 });
  b.sphere("body", "brass", 0.0035, 0, 0.041, -0.424, { wear: 0.9 });
  b.cyl("body", "steel", 0.017, 0.014, 0.014, 0, 0.019, -0.448, { ao: 0.9, dark: 0.5 });

  // The pump itself — the reciprocating mass, ribbed polymer.
  b.box("slide", "polymer", 0.05, 0.044, 0.115, 0, -0.011, -0.2, { bevel: 0.008, corner: 0.014, ao: 0.5 });
  for (let i = 0; i < 6; i++) {
    b.box("slide", "polymer", 0.052, 0.006, 0.008, 0, -0.011, -0.245 + i * 0.018, {
      bevel: 0.0015,
      ao: 0.8,
      wear: 0.25,
    });
  }
  b.box("slide", "steel", 0.014, 0.03, 0.09, 0, 0.004, -0.2, { bevel: 0.003, ao: 0.7 });

  b.triggerGroup("body", 0.062, 0.112, 0.28);

  // Wood-toned polymer stock with a thick recoil pad — this thing kicks.
  b.box("body", "polymer", 0.036, 0.05, 0.12, 0, 0.0, 0.185, {
    bevel: 0.008,
    corner: 0.014,
    tint: 0x4b3626,
    ao: 0.5,
    wear: 0.3,
  });
  b.box("body", "polymer", 0.04, 0.056, 0.09, 0, -0.008, 0.27, {
    bevel: 0.01,
    corner: 0.016,
    tint: 0x4b3626,
    ao: 0.55,
    wear: 0.35,
  });
  b.box("body", "rubber", 0.046, 0.072, 0.016, 0, -0.012, 0.318, { bevel: 0.005, ao: 0.6 });
  b.slingLoop("body", 0, -0.03, 0.3, Math.PI / 2);

  const [oy, oz] = b.optic("body", 0.05, 0.0, 0.75);
  rig.optic.position.set(0, oy, oz);
  rig.muzzle.position.set(0, 0.019, -0.458);
  rig.eject.position.set(0.026, 0.018, 0.04);

  b.finish(c.kit, groups, rig.accents);
  return rig;
}

function buildTacticalShotgun(c: BuilderCtx): WeaponRig {
  const { rig, groups } = makeRigShell();
  const b = new GunBuilder(c.rng, c.lod);

  // Semi-auto: alloy receiver, no pump, a proper rail and a folding stock.
  b.box("body", "alloy", 0.046, 0.058, 0.22, 0, 0.012, 0.02, { bevel: 0.005, corner: 0.008, ao: 0.45, wear: 0.3 });
  b.box("body", "polymer", 0.044, 0.046, 0.17, 0, -0.028, 0.03, { bevel: 0.005, ao: 0.55 });
  b.box("body", "accent", 0.05, 0.012, 0.11, 0, 0.042, -0.01, { bevel: 0.003, accent: true, ao: 0.3, wear: 0.45 });
  b.rail("body", 0.2, 0.049, -0.03, 0.021);
  b.box("body", "steel", 0.028, 0.016, 0.05, 0.01, -0.006, 0.05, { bevel: 0.002, ao: 1, dark: 0.5 });

  // Heat shield over the barrel: a run of slots, the most legible trim there is.
  b.box("body", "steel", 0.038, 0.036, 0.2, 0, 0.014, -0.19, { bevel: 0.005, ao: 0.5, wear: 0.3 });
  b.vents("body", "steel", 6, 0.04, 0.007, 0, 0.032, -0.26, 0.028, {});
  b.vents("body", "steel", 6, 0.04, 0.007, 0, -0.004, -0.26, 0.028, {});
  b.cyl("body", "steel", 0.0145, 0.0155, 0.36, 0, 0.014, -0.2, { ao: 0.45 });
  b.cyl("body", "alloy", 0.0195, 0.0185, 0.045, 0, 0.014, -0.36, { ao: 0.5, wear: 0.4 });
  // Breacher teeth — the detail that makes it read "tactical" at a glance.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    b.box("body", "steel", 0.008, 0.008, 0.016, Math.cos(a) * 0.014, 0.014 + Math.sin(a) * 0.014, -0.385, {
      bevel: 0.0015,
      ao: 0.7,
      wear: 0.5,
    });
  }

  // Foregrip: an angled polymer block with a strap loop.
  b.box("body", "polymer", 0.03, 0.062, 0.05, 0, -0.03, -0.2, { bevel: 0.008, rx: 0.25, ao: 0.6 });
  b.box("body", "rubber", 0.032, 0.03, 0.03, 0, -0.05, -0.19, { bevel: 0.006, rx: 0.25, ao: 0.75 });

  b.box("slide", "steel", 0.012, 0.018, 0.038, 0.026, 0.026, 0.055, { bevel: 0.003, ao: 0.5, wear: 0.7 });

  // Box magazine — the tac loads from a mag here, which is what separates its
  // reload from the pump's shell-by-shell ritual.
  b.box("mag", "polymer", 0.03, 0.1, 0.086, 0, -0.104, 0.02, { bevel: 0.006, corner: 0.012, ao: 0.55 });
  b.box("mag", "rubber", 0.034, 0.01, 0.094, 0, -0.156, 0.02, { bevel: 0.003, ao: 0.7, wear: 0.25 });
  b.box("mag", "accent", 0.032, 0.03, 0.006, 0, -0.11, -0.026, { bevel: 0.002, accent: true, ao: 0.4 });

  b.triggerGroup("body", 0.05, 0.114, 0.3);

  b.box("body", "alloy", 0.024, 0.026, 0.1, 0, 0.006, 0.17, { bevel: 0.005, ao: 0.55, wear: 0.3 });
  b.box("body", "polymer", 0.038, 0.048, 0.08, 0, 0.006, 0.235, { bevel: 0.007, corner: 0.012, ao: 0.5 });
  b.box("body", "rubber", 0.044, 0.062, 0.014, 0, 0.004, 0.277, { bevel: 0.004, ao: 0.6 });
  b.slingLoop("body", 0.022, 0.0, 0.13);

  const [oy, oz] = b.optic("body", 0.058, -0.06, 0.85);
  rig.optic.position.set(0, oy, oz);
  rig.muzzle.position.set(0, 0.014, -0.395);
  rig.eject.position.set(0.028, 0.02, 0.05);

  b.finish(c.kit, groups, rig.accents);
  return rig;
}

function buildSniper(c: BuilderCtx): WeaponRig {
  const { rig, groups } = makeRigShell();
  const b = new GunBuilder(c.rng, c.lod);

  // Chassis rifle: alloy spine, polymer furniture, a scope you can read.
  b.box("body", "alloy", 0.04, 0.05, 0.28, 0, 0.012, 0.03, { bevel: 0.005, corner: 0.008, ao: 0.45, wear: 0.3 });
  b.box("body", "polymer", 0.052, 0.038, 0.24, 0, -0.024, 0.04, { bevel: 0.006, corner: 0.012, ao: 0.55 });
  b.box("body", "accent", 0.044, 0.01, 0.13, 0, 0.04, 0.06, { bevel: 0.003, accent: true, ao: 0.3, wear: 0.4 });
  b.screws("body", 0.005, -0.02, [-0.03, 0.06, 0.14], 0.026);

  // Heavy fluted barrel — the flutes are four boxes and they pay for
  // themselves the moment light moves across the barrel.
  b.cyl("body", "steel", 0.0125, 0.0175, 0.5, 0, 0.014, -0.32, { ao: 0.42, wear: 0.2 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    b.box("body", "steel", 0.006, 0.006, 0.34, Math.cos(a) * 0.014, 0.014 + Math.sin(a) * 0.014, -0.33, {
      bevel: 0.0018,
      ao: 0.9,
      dark: 0.72,
    });
  }
  b.cyl("body", "alloy", 0.019, 0.021, 0.075, 0, 0.014, -0.55, { ao: 0.45, wear: 0.35 });
  for (let i = 0; i < 5; i++) {
    b.box("body", "steel", 0.044, 0.005, 0.007, 0, 0.014, -0.575 + i * 0.013, { bevel: 0.0012, ao: 0.9, dark: 0.5 });
  }
  b.cyl("body", "steel", 0.014, 0.014, 0.008, 0, 0.014, -0.588, { ao: 1, dark: 0.4 });

  // Scope: tube, bells, turrets, sunshade. This is the hero detail.
  b.cyl("body", "steel", 0.019, 0.019, 0.2, 0, 0.078, -0.03, { ao: 0.4, wear: 0.25 });
  b.cyl("body", "steel", 0.026, 0.021, 0.06, 0, 0.078, -0.15, { ao: 0.45, wear: 0.3 });
  b.cyl("body", "steel", 0.024, 0.02, 0.05, 0, 0.078, 0.09, { ao: 0.45, wear: 0.3 });
  b.cyl("body", "steel", 0.027, 0.027, 0.035, 0, 0.078, -0.192, { ao: 0.6, dark: 0.8 });
  b.cyl("body", "glass", 0.023, 0.023, 0.002, 0, 0.078, -0.207, { ao: 0 });
  b.cyl("body", "glass", 0.018, 0.018, 0.002, 0, 0.078, 0.113, { ao: 0 });
  // Turrets, capped and knurled.
  b.cyl("body", "alloy", 0.011, 0.012, 0.022, 0, 0.098, -0.04, { rx: Math.PI / 2, ao: 0.5, wear: 0.45 });
  b.cyl("body", "alloy", 0.011, 0.012, 0.022, 0.02, 0.078, -0.04, { rz: Math.PI / 2, ry: Math.PI / 2, ao: 0.5, wear: 0.45 });
  b.cyl("body", "accent", 0.0075, 0.0075, 0.012, 0, 0.109, -0.04, { rx: Math.PI / 2, accent: true, wear: 0.5 });
  // Magnification ring.
  b.cyl("body", "polymer", 0.022, 0.022, 0.018, 0, 0.078, 0.06, { ao: 0.55 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.box("body", "polymer", 0.004, 0.004, 0.018, Math.cos(a) * 0.022, 0.078 + Math.sin(a) * 0.022, 0.06, {
      bevel: 0.001,
      ao: 0.8,
    });
  }
  // Rings + rail.
  b.box("body", "alloy", 0.03, 0.03, 0.024, 0, 0.058, -0.09, { bevel: 0.004, ao: 0.6, wear: 0.3 });
  b.box("body", "alloy", 0.03, 0.03, 0.024, 0, 0.058, 0.03, { bevel: 0.004, ao: 0.6, wear: 0.3 });
  b.rail("body", 0.19, 0.042, -0.03, 0.02);

  // Bolt handle — the animated mass. Ball on a stalk, unmistakable.
  b.box("slide", "alloy", 0.03, 0.03, 0.09, 0, 0.026, 0.12, { bevel: 0.004, ao: 0.45, wear: 0.5 });
  b.cyl("slide", "steel", 0.006, 0.006, 0.05, 0.03, 0.03, 0.14, { rz: Math.PI / 2, ry: Math.PI / 2, ao: 0.5, wear: 0.7 });
  b.sphere("slide", "alloy", 0.011, 0.054, 0.03, 0.14, { wear: 0.9, ao: 0.35 });

  // Internal magazine + floorplate.
  b.box("mag", "steel", 0.03, 0.05, 0.09, 0, -0.058, 0.0, { bevel: 0.004, ao: 0.6 });
  b.box("mag", "accent", 0.032, 0.008, 0.08, 0, -0.084, 0.0, { bevel: 0.002, accent: true, ao: 0.5, wear: 0.3 });

  b.triggerGroup("body", 0.07, 0.12, 0.26);

  // Adjustable stock: cheek riser on posts, hooked butt, bipod stub.
  b.box("body", "polymer", 0.034, 0.05, 0.16, 0, 0.006, 0.21, { bevel: 0.007, corner: 0.012, ao: 0.5 });
  b.box("body", "polymer", 0.038, 0.026, 0.1, 0, 0.04, 0.2, { bevel: 0.009, ao: 0.4, wear: 0.35 });
  b.cyl("body", "alloy", 0.005, 0.005, 0.05, -0.012, 0.024, 0.2, { rx: Math.PI / 2, ao: 0.6 });
  b.cyl("body", "alloy", 0.005, 0.005, 0.05, 0.012, 0.024, 0.2, { rx: Math.PI / 2, ao: 0.6 });
  b.box("body", "polymer", 0.04, 0.075, 0.03, 0, -0.008, 0.3, { bevel: 0.008, ao: 0.55 });
  b.box("body", "rubber", 0.042, 0.08, 0.014, 0, -0.008, 0.322, { bevel: 0.004, ao: 0.6 });
  b.box("body", "alloy", 0.03, 0.02, 0.04, 0, -0.05, -0.22, { bevel: 0.004, ao: 0.7 });
  b.cyl("body", "steel", 0.005, 0.005, 0.09, -0.02, -0.086, -0.24, { rx: 0.5, rz: 0.25, ao: 0.6 });
  b.cyl("body", "steel", 0.005, 0.005, 0.09, 0.02, -0.086, -0.24, { rx: 0.5, rz: -0.25, ao: 0.6 });
  b.slingLoop("body", 0, -0.03, 0.26, Math.PI / 2);

  rig.optic.position.set(0, 0.078, -0.03);
  rig.muzzle.position.set(0, 0.014, -0.592);
  rig.eject.position.set(0.026, 0.03, 0.1);
  addOcular(rig, c.reticle, 0.0175, 0.078, 0.112);

  b.finish(c.kit, groups, rig.accents);
  return rig;
}

function buildBurstRifle(c: BuilderCtx): WeaponRig {
  const { rig, groups } = makeRigShell();
  const b = new GunBuilder(c.rng, c.lod);

  // Bullpup: magazine behind the trigger, carry handle on top. Reads as a
  // completely different weapon from the AR at 200 m, which is the point.
  b.box("body", "polymer", 0.05, 0.07, 0.34, 0, -0.004, 0.08, { bevel: 0.007, corner: 0.014, ao: 0.5 });
  b.box("body", "polymer", 0.052, 0.03, 0.12, 0, 0.026, 0.19, { bevel: 0.006, ao: 0.45, wear: 0.3 });
  b.box("body", "accent", 0.054, 0.012, 0.1, 0, 0.033, 0.03, { bevel: 0.003, accent: true, ao: 0.3, wear: 0.45 });
  // Carry handle: two posts and a bridge, with the rail on top of the bridge.
  b.box("body", "alloy", 0.02, 0.05, 0.02, 0, 0.055, -0.05, { bevel: 0.004, ao: 0.6 });
  b.box("body", "alloy", 0.02, 0.05, 0.02, 0, 0.055, 0.12, { bevel: 0.004, ao: 0.6 });
  b.box("body", "alloy", 0.026, 0.016, 0.2, 0, 0.084, 0.035, { bevel: 0.004, ao: 0.4, wear: 0.5 });
  b.rail("body", 0.17, 0.096, 0.035, 0.02);
  b.screws("body", 0.005, 0.02, [0.14, 0.2], 0.026);

  // Forward handguard with a vertical grip.
  b.box("body", "polymer", 0.044, 0.05, 0.16, 0, 0.0, -0.16, { bevel: 0.006, corner: 0.012, ao: 0.52 });
  b.vents("body", "steel", 4, 0.045, 0.006, 0, 0.02, -0.21, 0.03, {});
  b.box("body", "polymer", 0.028, 0.075, 0.032, 0, -0.058, -0.15, { bevel: 0.008, corner: 0.012, rx: 0.1, ao: 0.6 });
  b.box("body", "rubber", 0.03, 0.03, 0.034, 0, -0.086, -0.147, { bevel: 0.007, ao: 0.75 });

  // Barrel + three-prong flash hider.
  b.cyl("body", "steel", 0.0095, 0.011, 0.3, 0, 0.0, -0.24, { ao: 0.45 });
  b.box("body", "alloy", 0.02, 0.026, 0.026, 0, 0.008, -0.27, { bevel: 0.004, ao: 0.5, wear: 0.3 });
  b.cyl("body", "alloy", 0.014, 0.013, 0.03, 0, 0.0, -0.372, { ao: 0.5, wear: 0.4 });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    b.box("body", "steel", 0.005, 0.005, 0.03, Math.cos(a) * 0.011, Math.sin(a) * 0.011, -0.398, {
      bevel: 0.0012,
      ao: 0.7,
      wear: 0.4,
    });
  }

  // Bolt handle up front on the left, bullpup style.
  b.box("slide", "steel", 0.012, 0.014, 0.04, -0.028, 0.03, -0.06, { bevel: 0.003, ao: 0.5, wear: 0.7 });

  // Magazine behind the grip, nearly vertical.
  b.box("mag", "polymer", 0.028, 0.13, 0.062, 0, -0.086, 0.15, { bevel: 0.005, corner: 0.01, rx: 0.06, ao: 0.55 });
  b.box("mag", "rubber", 0.032, 0.01, 0.07, 0, -0.15, 0.154, { bevel: 0.003, ao: 0.7, wear: 0.25 });
  b.box("mag", "accent", 0.03, 0.04, 0.006, 0, -0.096, 0.116, { bevel: 0.002, accent: true, ao: 0.4 });

  b.triggerGroup("body", -0.055, 0.115, 0.28);

  // Butt pad is part of the receiver on a bullpup.
  b.box("body", "rubber", 0.048, 0.07, 0.014, 0, -0.006, 0.253, { bevel: 0.005, ao: 0.6 });
  b.slingLoop("body", 0.024, 0.0, 0.16);

  const [oy, oz] = b.optic("body", 0.1, 0.0, 0.9);
  rig.optic.position.set(0, oy, oz);
  rig.muzzle.position.set(0, 0.0, -0.412);
  rig.eject.position.set(0.028, 0.01, 0.13);

  b.finish(c.kit, groups, rig.accents);
  return rig;
}

function buildRocketLauncher(c: BuilderCtx): WeaponRig {
  const { rig, groups } = makeRigShell();
  const b = new GunBuilder(c.rng, c.lod);

  // A tube. But a tube with a shoulder rest, a heat shield, an optic bridge
  // and a warhead sticking out of the front — silhouette does all the work.
  b.cyl("body", "polymer", 0.048, 0.048, 0.86, 0, 0.02, -0.13, { seg: c.lod > 0 ? 18 : 10, ao: 0.5 });
  b.cyl("body", "steel", 0.052, 0.052, 0.05, 0, 0.02, -0.5, { ao: 0.6, wear: 0.3 });
  b.cyl("body", "steel", 0.052, 0.052, 0.05, 0, 0.02, 0.2, { ao: 0.6, wear: 0.3 });
  // Blast cone at the rear — this is a recoilless launcher and it must vent.
  b.cone("body", "steel", 0.075, 0.13, 0, 0.02, 0.36, { rx: Math.PI, ao: 0.7, dark: 0.7 });
  b.cyl("body", "steel", 0.05, 0.05, 0.02, 0, 0.02, 0.3, { ao: 0.85, dark: 0.5 });

  // Heat shield: a half-shell of slats over the top of the tube.
  for (let i = 0; i < 7; i++) {
    b.box("body", "steel", 0.07, 0.006, 0.052, 0, 0.072, -0.32 + i * 0.062, {
      bevel: 0.0015,
      ao: 0.7,
      wear: 0.25,
    });
  }
  b.box("body", "steel", 0.005, 0.05, 0.5, -0.036, 0.05, -0.13, { bevel: 0.0015, ao: 0.7 });
  b.box("body", "steel", 0.005, 0.05, 0.5, 0.036, 0.05, -0.13, { bevel: 0.0015, ao: 0.7 });
  b.box("body", "accent", 0.03, 0.008, 0.24, 0, 0.078, -0.13, { bevel: 0.002, accent: true, ao: 0.3, wear: 0.4 });

  // Warhead in the tube, nose out. Yellow band, because that is what a live
  // round looks like and the colour block reads instantly.
  b.cyl("mag", "alloy", 0.042, 0.042, 0.2, 0, 0.02, -0.56, { ao: 0.45, wear: 0.3 });
  b.cone("mag", "steel", 0.043, 0.12, 0, 0.02, -0.72, { ao: 0.4, wear: 0.4 });
  b.cyl("mag", "accent", 0.0435, 0.0435, 0.022, 0, 0.02, -0.62, { accent: true, ao: 0.35, wear: 0.4 });
  b.cyl("mag", "steel", 0.0435, 0.0435, 0.012, 0, 0.02, -0.5, { ao: 0.6, dark: 0.85 });

  // Trigger group, foregrip, shoulder rest.
  b.box("body", "polymer", 0.05, 0.05, 0.14, 0, -0.02, 0.05, { bevel: 0.007, corner: 0.012, ao: 0.55 });
  b.triggerGroup("body", 0.05, 0.12, 0.3);
  b.box("body", "polymer", 0.03, 0.085, 0.036, 0, -0.05, -0.16, { bevel: 0.008, corner: 0.012, rx: 0.18, ao: 0.6 });
  b.box("body", "rubber", 0.032, 0.03, 0.038, 0, -0.086, -0.152, { bevel: 0.007, ao: 0.75 });
  b.box("body", "rubber", 0.09, 0.02, 0.09, 0, 0.062, 0.24, { bevel: 0.006, rx: -0.2, ao: 0.65 });
  b.box("body", "polymer", 0.05, 0.04, 0.09, 0, 0.05, 0.24, { bevel: 0.006, ao: 0.6 });

  // Optic bridge with a ranging ladder.
  b.box("body", "alloy", 0.02, 0.04, 0.02, 0, 0.1, -0.14, { bevel: 0.004, ao: 0.6 });
  b.box("body", "alloy", 0.02, 0.04, 0.02, 0, 0.1, 0.02, { bevel: 0.004, ao: 0.6 });
  const [oy, oz] = b.optic("body", 0.115, -0.06, 1.15);
  b.slingLoop("body", 0.05, 0.02, -0.2);
  b.slingLoop("body", 0.05, 0.02, 0.18);

  rig.optic.position.set(0, oy, oz);
  rig.muzzle.position.set(0, 0.02, -0.58);
  rig.eject.position.set(0, 0.02, 0.4);

  b.finish(c.kit, groups, rig.accents);
  return rig;
}

function buildMinigun(c: BuilderCtx): WeaponRig {
  const { rig, groups } = makeRigShell();
  const b = new GunBuilder(c.rng, c.lod);

  // Housing, drum, spade grips. Every line of it says "too heavy to sprint".
  b.box("body", "alloy", 0.1, 0.1, 0.26, 0, 0.0, 0.03, { bevel: 0.01, corner: 0.016, ao: 0.5, wear: 0.3 });
  b.box("body", "steel", 0.104, 0.03, 0.16, 0, 0.056, 0.02, { bevel: 0.005, ao: 0.45, wear: 0.4 });
  b.box("body", "accent", 0.09, 0.012, 0.1, 0, 0.073, 0.02, { bevel: 0.003, accent: true, ao: 0.3, wear: 0.45 });
  b.screws("body", 0.006, 0.0, [-0.06, 0.02, 0.1], 0.052);
  b.vents("body", "steel", 5, 0.006, 0.05, 0.052, 0.0, -0.05, 0.03, { dark: 0.55 });
  b.vents("body", "steel", 5, 0.006, 0.05, -0.052, 0.0, -0.05, 0.03, { dark: 0.55 });

  // Ammo drum on the left, with a feed chute into the housing.
  b.cyl("mag", "steel", 0.085, 0.085, 0.12, -0.1, -0.05, 0.09, {
    seg: c.lod > 0 ? 18 : 10,
    rz: Math.PI / 2,
    ry: Math.PI / 2,
    ao: 0.55,
  });
  b.cyl("mag", "alloy", 0.06, 0.06, 0.126, -0.1, -0.05, 0.09, {
    seg: c.lod > 0 ? 16 : 10,
    rz: Math.PI / 2,
    ry: Math.PI / 2,
    ao: 0.5,
    wear: 0.3,
  });
  b.cyl("mag", "accent", 0.03, 0.03, 0.132, -0.1, -0.05, 0.09, {
    rz: Math.PI / 2,
    ry: Math.PI / 2,
    accent: true,
    ao: 0.4,
    wear: 0.4,
  });
  b.box("mag", "steel", 0.09, 0.05, 0.05, -0.055, 0.0, 0.06, { bevel: 0.005, rz: -0.5, ao: 0.65 });
  // Belt of visible rounds feeding in — brass reads at any distance.
  for (let i = 0; i < 6; i++) {
    b.cyl("mag", "brass", 0.006, 0.005, 0.026, -0.03 - i * 0.011, 0.014 - i * 0.006, 0.055, {
      seg: 6,
      rz: Math.PI / 2,
      ry: Math.PI / 2,
      ao: 0.4,
      wear: 0.5,
    });
  }

  // Rotating barrel cluster: six barrels on a hub, in their own group.
  b.cyl("barrels", "alloy", 0.036, 0.036, 0.05, 0, 0, -0.12, { ao: 0.55 });
  b.cyl("barrels", "alloy", 0.03, 0.03, 0.05, 0, 0, -0.44, { ao: 0.55 });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const x = Math.cos(a) * 0.026;
    const y = Math.sin(a) * 0.026;
    b.cyl("barrels", "steel", 0.008, 0.0085, 0.42, x, y, -0.28, { seg: 8, ao: 0.5, wear: 0.2 });
    b.cyl("barrels", "hot", 0.0088, 0.0088, 0.05, x, y, -0.45, { seg: 8, ao: 0.6 });
  }
  // Barrel clamp, mid-span, so the cluster is not six loose tubes.
  b.cyl("barrels", "steel", 0.035, 0.035, 0.018, 0, 0, -0.32, { ao: 0.65, dark: 0.85 });

  // Front shroud and carry handle over the cluster.
  b.cyl("body", "steel", 0.05, 0.05, 0.06, 0, 0, -0.115, { ao: 0.6, wear: 0.25 });
  b.box("body", "steel", 0.02, 0.03, 0.16, 0, 0.07, -0.16, { bevel: 0.004, ao: 0.5, wear: 0.45 });
  b.box("body", "rubber", 0.024, 0.016, 0.1, 0, 0.086, -0.16, { bevel: 0.005, ao: 0.55, wear: 0.3 });

  // Spade grips: two vertical handles with thumb triggers between them.
  for (const side of [-1, 1]) {
    b.box("body", "polymer", 0.03, 0.11, 0.036, side * 0.06, -0.075, 0.13, {
      bevel: 0.008,
      corner: 0.012,
      rx: 0.16,
      ao: 0.55,
    });
    b.box("body", "rubber", 0.032, 0.05, 0.038, side * 0.06, -0.09, 0.135, { bevel: 0.007, rx: 0.16, ao: 0.7 });
    b.box("body", "alloy", 0.036, 0.03, 0.03, side * 0.06, -0.012, 0.12, { bevel: 0.005, ao: 0.6 });
  }
  b.box("body", "alloy", 0.09, 0.012, 0.02, 0, -0.03, 0.15, { bevel: 0.003, ao: 0.7, wear: 0.5 });

  const [oy, oz] = b.optic("body", 0.09, -0.04, 1.1);
  rig.optic.position.set(0, oy, oz);
  rig.muzzle.position.set(0, 0.026, -0.47);
  rig.eject.position.set(0.055, -0.03, 0.02);

  b.finish(c.kit, groups, rig.accents);
  return rig;
}

// ---------------------------------------------------------------- data

export type FireMode = "auto" | "semi" | "burst" | "pump" | "spin";
export type Ballistic = "hitscan" | "bullet" | "rocket";
export type AmmoType = "light" | "medium" | "heavy" | "shells" | "rockets";
export type ShellKind = "none" | "brass" | "hull" | "link";

/**
 * Every field is a *peak* displacement — radians or metres at the top of the
 * spring's first swing. `fireShot` converts them into impulses using the
 * spring's own natural frequency, so retuning stiffness never silently
 * changes how far the gun kicks.
 */
export interface RecoilProfile {
  /** Viewmodel kick: metres back, radians of muzzle climb, yaw, roll. */
  back: number;
  vmPitch: number;
  vmYaw: number;
  vmRoll: number;
  /** Camera kick in radians. This is the part that moves the bullets. */
  camPitch: number;
  camYaw: number;
  /** Positional camera shake, metres. */
  shake: number;
  /**
   * Per-shot multipliers `[horizontal, vertical]`, cycled by shot index. This
   * is the *pattern*: hold the trigger on the AR and the muzzle walks up and
   * to the right, then hooks left — learnable, which is the entire skill
   * ceiling of a spray. `jitter` keeps it from reading as canned.
   */
  pattern: [number, number][];
  jitter: number;
  /** Spring constants for the recovery. Higher = snappier. */
  stiffness: number;
  damping: number;
  /** How much of the camera kick springs back rather than staying as aim. */
  recovery: number;
}

export interface WeaponDef {
  id: string;
  name: string;
  /** Short tag for the HUD. */
  short: string;
  role: string;
  ammoType: AmmoType;

  ballistic: Ballistic;
  mode: FireMode;
  /** Rounds per minute. For `burst`, the in-burst rate. */
  rpm: number;
  /** Rounds per burst, and the gap after one. */
  burst: number;
  burstDelay: number;
  /** Base damage per bullet/pellet at the common tier. */
  damage: number;
  pellets: number;
  headshot: number;
  /** Max reach in metres. */
  range: number;
  /** Falloff window: full damage until `falloffStart`, `MIN_FALLOFF` past end. */
  falloffStart: number;
  falloffEnd: number;

  /** Cone half-angles in radians. */
  spread: number;
  spreadAds: number;
  /** Extra cone at full sprint, and while airborne. */
  spreadMove: number;
  spreadAir: number;
  /** Bloom added per shot, its decay rate and its ceiling. */
  bloom: number;
  bloomDecay: number;
  bloomMax: number;
  /** First-shot accuracy: this weapon ignores bloom while the spring is at rest. */
  firstShot: boolean;

  magSize: number;
  reload: number;
  /** Fraction of the reload spent on mag drop / insert / charge. */
  reloadBeats: [number, number, number];
  /** Shotguns that load one shell at a time: seconds per shell. */
  shellReload: number;

  recoil: RecoilProfile;

  /** Slide/bolt travel in metres, and how long a full cycle takes. */
  slideTravel: number;
  slideTime: number;
  shell: ShellKind;
  shellEjectSpeed: number;

  /** Projectile ballistics, for `bullet` and `rocket`. */
  projectile?: { speed: number; gravity: number; drag: number };
  explosive?: { radius: number; damage: number; playerForce: number; fuse: number };
  spinUp?: number;
  spinDown?: number;

  adsAllowed: boolean;
  adsTime: number;
  /** Extra FOV the world camera pulls while sighted, degrees (negative = in). */
  adsFovPull: number;
  /** Viewmodel FOV while sighted. */
  adsVmFov: number;
  /** True when ADS swaps to a scope overlay rather than an iron sight. */
  scoped: boolean;

  /** How heavy it feels: drives sway lag, bob amplitude and swap speed. */
  weight: number;
  swapTime: number;

  sound: string;
  soundVolume: number;
  flashScale: number;
  /** Draw a tracer every Nth shot. 0 = never. */
  tracerEvery: number;

  build: (c: BuilderCtx) => WeaponRig;
  /** Hip-fire pose in camera space, metres, and its Euler. */
  hip: [number, number, number];
  hipRot: [number, number, number];
  /** Metres of scale applied to the (real-size) rig for the viewmodel. */
  vmScale: number;
  /** Third-person scale — full size, since it is a real object out there. */
  tpScale: number;
}

/**
 * The arsenal. Balance is Fortnite-shaped: an AR that always works, an SMG
 * that wins the first two seconds of a close fight, a pump that ends one, and
 * a sniper you have to earn. Numbers are the *common* tier; rarity scales
 * damage up and reload down from here.
 */
const ARSENAL: WeaponDef[] = [
  {
    id: "ar",
    name: "Assault Rifle",
    short: "AR",
    role: "all-round",
    ammoType: "medium",
    ballistic: "hitscan",
    mode: "auto",
    rpm: 330,
    burst: 0,
    burstDelay: 0,
    damage: 31,
    pellets: 1,
    headshot: 1.75,
    range: 420,
    falloffStart: 90,
    falloffEnd: 240,
    spread: 0.026,
    spreadAds: 0.0055,
    spreadMove: 0.03,
    spreadAir: 0.045,
    bloom: 0.0055,
    bloomDecay: 3.4,
    bloomMax: 0.05,
    firstShot: true,
    magSize: 30,
    reload: 2.3,
    reloadBeats: [0.2, 0.56, 0.84],
    shellReload: 0,
    recoil: {
      back: 0.02,
      vmPitch: 0.1,
      vmYaw: 0.035,
      vmRoll: 0.05,
      camPitch: 0.0135,
      camYaw: 0.0045,
      shake: 0.008,
      // Up hard for four, then it hooks right and settles — the classic
      // learnable AR climb.
      pattern: [
        [0.05, 1],
        [-0.1, 1],
        [0.15, 0.95],
        [0.45, 0.8],
        [0.7, 0.62],
        [0.85, 0.5],
        [0.55, 0.44],
        [-0.35, 0.42],
        [-0.75, 0.4],
        [-0.6, 0.38],
      ],
      jitter: 0.34,
      stiffness: 190,
      damping: 21,
      recovery: 0.86,
    },
    slideTravel: 0.02,
    slideTime: 0.06,
    shell: "brass",
    shellEjectSpeed: 3.4,
    adsAllowed: true,
    adsTime: 0.22,
    adsFovPull: -6,
    adsVmFov: 46,
    scoped: false,
    weight: 1,
    swapTime: 0.5,
    sound: "shot-ar",
    soundVolume: 0.85,
    flashScale: 1,
    tracerEvery: 2,
    build: buildAssaultRifle,
    hip: [0.13, -0.13, -0.22],
    hipRot: [0.02, -0.06, 0.015],
    vmScale: 0.78,
    tpScale: 1,
  },
  {
    id: "smg",
    name: "Submachine Gun",
    short: "SMG",
    role: "close-quarters",
    ammoType: "light",
    ballistic: "hitscan",
    mode: "auto",
    rpm: 640,
    burst: 0,
    burstDelay: 0,
    damage: 16,
    pellets: 1,
    headshot: 1.5,
    range: 260,
    falloffStart: 26,
    falloffEnd: 90,
    spread: 0.042,
    spreadAds: 0.019,
    spreadMove: 0.02,
    spreadAir: 0.03,
    bloom: 0.0042,
    bloomDecay: 4.6,
    bloomMax: 0.07,
    firstShot: false,
    magSize: 30,
    reload: 2.2,
    reloadBeats: [0.22, 0.6, 0.86],
    shellReload: 0,
    recoil: {
      back: 0.014,
      vmPitch: 0.07,
      vmYaw: 0.04,
      vmRoll: 0.045,
      camPitch: 0.008,
      camYaw: 0.005,
      shake: 0.006,
      // Loose and wide: an SMG should feel like it is trying to get away.
      pattern: [
        [0.2, 1],
        [-0.5, 0.9],
        [0.7, 0.8],
        [-0.8, 0.7],
        [0.4, 0.75],
        [1, 0.6],
        [-0.3, 0.7],
        [-1, 0.55],
      ],
      jitter: 0.85,
      stiffness: 230,
      damping: 24,
      recovery: 0.9,
    },
    slideTravel: 0.018,
    slideTime: 0.05,
    shell: "brass",
    shellEjectSpeed: 3.1,
    adsAllowed: true,
    adsTime: 0.18,
    adsFovPull: -4,
    adsVmFov: 50,
    scoped: false,
    weight: 0.75,
    swapTime: 0.42,
    sound: "shot-smg",
    soundVolume: 0.7,
    flashScale: 0.85,
    tracerEvery: 3,
    build: buildSmg,
    hip: [0.12, -0.125, -0.2],
    hipRot: [0.03, -0.07, 0.02],
    vmScale: 0.82,
    tpScale: 1,
  },
  {
    id: "pump",
    name: "Pump Shotgun",
    short: "PUMP",
    role: "burst damage",
    ammoType: "shells",
    ballistic: "hitscan",
    mode: "pump",
    rpm: 48,
    burst: 0,
    burstDelay: 0,
    damage: 10.5,
    pellets: 9,
    headshot: 1.5,
    range: 60,
    falloffStart: 7,
    falloffEnd: 26,
    spread: 0.062,
    spreadAds: 0.045,
    spreadMove: 0.012,
    spreadAir: 0.02,
    bloom: 0,
    bloomDecay: 5,
    bloomMax: 0,
    firstShot: true,
    magSize: 5,
    reload: 0,
    reloadBeats: [0.3, 0.62, 0.9],
    shellReload: 0.62,
    recoil: {
      back: 0.07,
      vmPitch: 0.34,
      vmYaw: 0.05,
      vmRoll: 0.14,
      camPitch: 0.05,
      camYaw: 0.008,
      shake: 0.03,
      pattern: [
        [0.35, 1],
        [-0.4, 1],
      ],
      jitter: 0.3,
      stiffness: 105,
      damping: 15,
      recovery: 0.8,
    },
    slideTravel: 0.075,
    slideTime: 0.55,
    shell: "hull",
    shellEjectSpeed: 2.6,
    adsAllowed: true,
    adsTime: 0.24,
    adsFovPull: -3,
    adsVmFov: 52,
    scoped: false,
    weight: 1.5,
    swapTime: 0.62,
    sound: "shot-pump",
    soundVolume: 1,
    flashScale: 1.6,
    tracerEvery: 0,
    build: buildPumpShotgun,
    hip: [0.135, -0.14, -0.22],
    hipRot: [0.02, -0.05, 0.01],
    vmScale: 0.74,
    tpScale: 1,
  },
  {
    id: "tac",
    name: "Tactical Shotgun",
    short: "TAC",
    role: "sustained close",
    ammoType: "shells",
    ballistic: "hitscan",
    mode: "auto",
    rpm: 105,
    burst: 0,
    burstDelay: 0,
    damage: 7.4,
    pellets: 9,
    headshot: 1.5,
    range: 55,
    falloffStart: 6,
    falloffEnd: 22,
    spread: 0.07,
    spreadAds: 0.055,
    spreadMove: 0.014,
    spreadAir: 0.022,
    bloom: 0.004,
    bloomDecay: 3.2,
    bloomMax: 0.02,
    firstShot: false,
    magSize: 8,
    reload: 3.3,
    reloadBeats: [0.24, 0.62, 0.88],
    shellReload: 0,
    recoil: {
      back: 0.045,
      vmPitch: 0.2,
      vmYaw: 0.04,
      vmRoll: 0.09,
      camPitch: 0.028,
      camYaw: 0.007,
      shake: 0.02,
      pattern: [
        [0.3, 1],
        [-0.35, 0.9],
        [0.15, 0.95],
        [-0.6, 0.85],
      ],
      jitter: 0.4,
      stiffness: 130,
      damping: 17,
      recovery: 0.84,
    },
    slideTravel: 0.03,
    slideTime: 0.09,
    shell: "hull",
    shellEjectSpeed: 2.8,
    adsAllowed: true,
    adsTime: 0.2,
    adsFovPull: -3,
    adsVmFov: 52,
    scoped: false,
    weight: 1.2,
    swapTime: 0.55,
    sound: "shot-tac",
    soundVolume: 0.92,
    flashScale: 1.35,
    tracerEvery: 0,
    build: buildTacticalShotgun,
    hip: [0.13, -0.135, -0.21],
    hipRot: [0.02, -0.055, 0.012],
    vmScale: 0.76,
    tpScale: 1,
  },
  {
    id: "sniper",
    name: "Bolt-Action Sniper",
    short: "BOLT",
    role: "long range",
    ammoType: "heavy",
    ballistic: "bullet",
    mode: "semi",
    rpm: 22,
    burst: 0,
    burstDelay: 0,
    damage: 105,
    pellets: 1,
    headshot: 2.5,
    range: 1400,
    falloffStart: 1400,
    falloffEnd: 1600,
    // Hip-firing a bolt gun is meant to be a mistake, not a playstyle.
    spread: 0.11,
    spreadAds: 0,
    spreadMove: 0.05,
    spreadAir: 0.06,
    bloom: 0,
    bloomDecay: 2,
    bloomMax: 0,
    firstShot: true,
    magSize: 1,
    reload: 2.9,
    reloadBeats: [0.24, 0.58, 0.86],
    shellReload: 0,
    recoil: {
      back: 0.085,
      vmPitch: 0.4,
      vmYaw: 0.04,
      vmRoll: 0.12,
      camPitch: 0.062,
      camYaw: 0.006,
      shake: 0.034,
      pattern: [
        [0.2, 1],
        [-0.25, 1],
      ],
      jitter: 0.2,
      stiffness: 92,
      damping: 13,
      recovery: 0.7,
    },
    slideTravel: 0.075,
    slideTime: 0.7,
    shell: "brass",
    shellEjectSpeed: 2.4,
    projectile: { speed: 460, gravity: BULLET_GRAVITY, drag: 0.02 },
    adsAllowed: true,
    adsTime: 0.34,
    adsFovPull: -46,
    adsVmFov: 26,
    scoped: true,
    weight: 1.6,
    swapTime: 0.7,
    sound: "shot-sniper",
    soundVolume: 1,
    flashScale: 1.5,
    tracerEvery: 1,
    build: buildSniper,
    hip: [0.135, -0.145, -0.24],
    hipRot: [0.015, -0.05, 0.01],
    vmScale: 0.7,
    tpScale: 1,
  },
  {
    id: "burst",
    name: "Burst Rifle",
    short: "BURST",
    role: "mid range",
    ammoType: "medium",
    ballistic: "hitscan",
    mode: "burst",
    rpm: 620,
    burst: 3,
    burstDelay: 0.34,
    damage: 32,
    pellets: 1,
    headshot: 1.75,
    range: 400,
    falloffStart: 110,
    falloffEnd: 260,
    spread: 0.023,
    spreadAds: 0.004,
    spreadMove: 0.028,
    spreadAir: 0.042,
    bloom: 0.004,
    bloomDecay: 5.5,
    bloomMax: 0.03,
    firstShot: true,
    magSize: 30,
    reload: 2.4,
    reloadBeats: [0.2, 0.58, 0.86],
    shellReload: 0,
    recoil: {
      back: 0.024,
      vmPitch: 0.13,
      vmYaw: 0.03,
      vmRoll: 0.05,
      camPitch: 0.018,
      camYaw: 0.004,
      shake: 0.009,
      // A burst walks straight up so the third round is a head at range —
      // which is exactly what makes the weapon worth learning.
      pattern: [
        [0, 1],
        [0.12, 1.1],
        [-0.18, 1.2],
      ],
      jitter: 0.18,
      stiffness: 175,
      damping: 20,
      recovery: 0.82,
    },
    slideTravel: 0.018,
    slideTime: 0.05,
    shell: "brass",
    shellEjectSpeed: 3.5,
    adsAllowed: true,
    adsTime: 0.24,
    adsFovPull: -12,
    adsVmFov: 40,
    scoped: false,
    weight: 1.1,
    swapTime: 0.52,
    sound: "shot-burst",
    soundVolume: 0.86,
    flashScale: 1,
    tracerEvery: 1,
    build: buildBurstRifle,
    hip: [0.125, -0.13, -0.21],
    hipRot: [0.02, -0.06, 0.015],
    vmScale: 0.78,
    tpScale: 1,
  },
  {
    id: "rocket",
    name: "Rocket Launcher",
    short: "RPG",
    role: "anti-structure",
    ammoType: "rockets",
    ballistic: "rocket",
    mode: "semi",
    rpm: 40,
    burst: 0,
    burstDelay: 0,
    damage: 100,
    pellets: 1,
    headshot: 1,
    range: 1200,
    falloffStart: 1200,
    falloffEnd: 1400,
    spread: 0.012,
    spreadAds: 0.002,
    spreadMove: 0.01,
    spreadAir: 0.012,
    bloom: 0,
    bloomDecay: 2,
    bloomMax: 0,
    firstShot: true,
    magSize: 1,
    reload: 3.1,
    reloadBeats: [0.18, 0.6, 0.9],
    shellReload: 0,
    recoil: {
      back: 0.1,
      vmPitch: 0.3,
      vmYaw: 0.05,
      vmRoll: 0.1,
      camPitch: 0.045,
      camYaw: 0.01,
      shake: 0.05,
      pattern: [[0.3, 1]],
      jitter: 0.35,
      stiffness: 80,
      damping: 12,
      recovery: 0.75,
    },
    slideTravel: 0,
    slideTime: 0,
    shell: "none",
    shellEjectSpeed: 0,
    projectile: { speed: 62, gravity: -3.2, drag: 0.06 },
    explosive: { radius: 5.2, damage: 92, playerForce: 15, fuse: 8 },
    adsAllowed: true,
    adsTime: 0.34,
    adsFovPull: -8,
    adsVmFov: 46,
    scoped: false,
    weight: 1.9,
    swapTime: 0.78,
    sound: "shot-rocket",
    soundVolume: 1,
    flashScale: 2.4,
    tracerEvery: 0,
    build: buildRocketLauncher,
    hip: [0.115, -0.115, -0.16],
    hipRot: [0.01, -0.03, 0.0],
    vmScale: 0.5,
    tpScale: 1,
  },
  {
    id: "pistol",
    name: "Pistol",
    short: "PISTOL",
    role: "sidearm",
    ammoType: "light",
    ballistic: "hitscan",
    mode: "semi",
    rpm: 400,
    burst: 0,
    burstDelay: 0,
    damage: 24,
    pellets: 1,
    headshot: 2,
    range: 300,
    falloffStart: 45,
    falloffEnd: 140,
    spread: 0.02,
    spreadAds: 0.005,
    spreadMove: 0.026,
    spreadAir: 0.035,
    bloom: 0.007,
    bloomDecay: 5.5,
    bloomMax: 0.05,
    firstShot: true,
    magSize: 16,
    reload: 1.5,
    reloadBeats: [0.24, 0.62, 0.9],
    shellReload: 0,
    recoil: {
      back: 0.026,
      vmPitch: 0.16,
      vmYaw: 0.03,
      vmRoll: 0.06,
      camPitch: 0.017,
      camYaw: 0.004,
      shake: 0.01,
      pattern: [
        [0.15, 1],
        [-0.2, 0.95],
        [0.3, 0.9],
        [-0.1, 1],
      ],
      jitter: 0.4,
      stiffness: 215,
      damping: 22,
      recovery: 0.88,
    },
    slideTravel: 0.03,
    slideTime: 0.07,
    shell: "brass",
    shellEjectSpeed: 3,
    adsAllowed: true,
    adsTime: 0.16,
    adsFovPull: -4,
    adsVmFov: 50,
    scoped: false,
    weight: 0.55,
    swapTime: 0.34,
    sound: "shot-pistol",
    soundVolume: 0.72,
    flashScale: 0.9,
    tracerEvery: 2,
    build: buildPistol,
    hip: [0.115, -0.135, -0.22],
    hipRot: [0.04, -0.1, 0.02],
    vmScale: 0.95,
    tpScale: 1,
  },
  {
    id: "minigun",
    name: "Minigun",
    short: "MINI",
    role: "suppression",
    ammoType: "light",
    ballistic: "hitscan",
    mode: "spin",
    rpm: 780,
    burst: 0,
    burstDelay: 0,
    damage: 17,
    pellets: 1,
    headshot: 1.25,
    range: 300,
    falloffStart: 40,
    falloffEnd: 130,
    spread: 0.035,
    spreadAds: 0.028,
    spreadMove: 0.02,
    spreadAir: 0.04,
    bloom: 0.003,
    bloomDecay: 2.6,
    bloomMax: 0.055,
    firstShot: false,
    magSize: 150,
    reload: 4.4,
    reloadBeats: [0.2, 0.62, 0.9],
    shellReload: 0,
    recoil: {
      back: 0.012,
      vmPitch: 0.05,
      vmYaw: 0.04,
      vmRoll: 0.03,
      camPitch: 0.005,
      camYaw: 0.0045,
      shake: 0.011,
      // No learnable pattern by design: this is a suppression weapon and the
      // reticle should wander.
      pattern: [
        [1, 0.6],
        [0.4, 0.9],
        [-0.6, 0.8],
        [-1, 0.5],
        [-0.3, 0.9],
        [0.7, 0.7],
      ],
      jitter: 1.1,
      stiffness: 210,
      damping: 24,
      recovery: 0.94,
    },
    slideTravel: 0,
    slideTime: 0,
    shell: "link",
    shellEjectSpeed: 3.6,
    spinUp: 0.72,
    spinDown: 1.1,
    adsAllowed: false,
    adsTime: 0.3,
    adsFovPull: 0,
    adsVmFov: 55,
    scoped: false,
    weight: 2.1,
    swapTime: 0.85,
    sound: "shot-minigun",
    soundVolume: 0.66,
    flashScale: 1.5,
    tracerEvery: 2,
    build: buildMinigun,
    hip: [0.08, -0.145, -0.19],
    hipRot: [0.01, -0.02, 0.0],
    vmScale: 0.62,
    tpScale: 1,
  },
];

const DEF_BY_ID = new Map<string, WeaponDef>(ARSENAL.map((d) => [d.id, d]));

// ---------------------------------------------------------------- rarity

export const RARITY_ORDER: Rarity[] = ["common", "uncommon", "rare", "epic", "legendary"];

/**
 * What the five tiers actually change. Fortnite's ladder is ~+5% damage a tier
 * with a shorter reload at the top, which is small enough that a common AR is
 * still a real weapon and large enough that you always swap up. Anything
 * steeper turns the whole game into a loot lottery.
 */
const RARITY_DAMAGE = [1, 1.05, 1.11, 1.17, 1.24];
const RARITY_RELOAD = [1, 0.95, 0.9, 0.86, 0.82];
/** Higher tiers are also a touch tighter, which is what "feels better" means. */
const RARITY_SPREAD = [1, 0.98, 0.95, 0.92, 0.89];

export interface WeaponStats {
  def: WeaponDef;
  rarity: Rarity;
  /** Damage per bullet (or per pellet, for shotguns). */
  damage: number;
  /** Damage of one complete trigger pull — the number worth showing a player. */
  burstDamage: number;
  headshot: number;
  reload: number;
  shellReload: number;
  spread: number;
  spreadAds: number;
  magSize: number;
  /** Seconds between shots. */
  interval: number;
  dps: number;
  displayName: string;
  color: number;
}

function rarityIndex(r: Rarity): number {
  const i = RARITY_ORDER.indexOf(r);
  return i < 0 ? 0 : i;
}

const RARITY_LABEL: Record<Rarity, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

/**
 * The single place rarity is resolved. Nothing else in this module reads
 * `def.damage` or `def.reload` directly — the whole point of routing it here
 * is that the HUD, the loot table and the ballistics can never disagree about
 * what a Legendary Pump does.
 */
function statsFor(def: WeaponDef, rarity: Rarity): WeaponStats {
  const i = rarityIndex(rarity);
  const damage = def.damage * RARITY_DAMAGE[i];
  const interval = 60 / Math.max(1, def.rpm);
  const shotDamage = damage * def.pellets;
  const cycle =
    def.mode === "burst" ? (def.burst - 1) * interval + def.burstDelay : Math.max(interval, def.slideTime);
  return {
    def,
    rarity,
    damage,
    burstDamage: def.mode === "burst" ? shotDamage * def.burst : shotDamage,
    headshot: def.headshot,
    reload: def.reload * RARITY_RELOAD[i],
    shellReload: def.shellReload * RARITY_RELOAD[i],
    spread: def.spread * RARITY_SPREAD[i],
    spreadAds: def.spreadAds * RARITY_SPREAD[i],
    magSize: def.magSize,
    interval,
    dps: (def.mode === "burst" ? shotDamage * def.burst : shotDamage) / Math.max(0.05, cycle),
    displayName: `${RARITY_LABEL[rarity]} ${def.name}`,
    color: RARITY_COLOR[rarity],
  };
}

/**
 * The definition table, exported directly as well as through the service.
 * Loot and the HUD both want to name and tier a gun before this system has
 * necessarily booted (a chest can be authored during worldgen), and a static
 * import costs them nothing — the table is data, not state.
 */
export const WEAPON_DEFS: readonly WeaponDef[] = ARSENAL;

export function weaponDef(id: string): WeaponDef | null {
  return DEF_BY_ID.get(id) ?? null;
}

export function weaponStats(id: string, rarity: Rarity): WeaponStats | null {
  const def = DEF_BY_ID.get(id);
  return def ? statsFor(def, rarity) : null;
}

/**
 * Loot weighting. A legendary rocket launcher on the floor of the first house
 * is not a fun match, so the heavy hitters are rare-and-up only and the
 * sidearms thin out as the tiers climb.
 */
const LOOT_WEIGHTS: Record<string, [number, number, number, number, number]> = {
  //         common uncommon rare epic legendary
  ar: [30, 30, 26, 20, 14],
  smg: [26, 24, 20, 15, 10],
  pump: [18, 18, 18, 16, 12],
  tac: [16, 16, 15, 13, 10],
  sniper: [0, 6, 10, 12, 12],
  burst: [14, 14, 14, 12, 10],
  rocket: [0, 0, 4, 6, 8],
  pistol: [24, 16, 10, 6, 3],
  minigun: [0, 0, 5, 7, 8],
};

/** Starting reserve per ammo type, and the ceiling a player may carry. */
const AMMO_START: Record<AmmoType, number> = {
  light: 120,
  medium: 120,
  heavy: 12,
  shells: 24,
  rockets: 4,
};
const AMMO_CAP: Record<AmmoType, number> = {
  light: 999,
  medium: 999,
  heavy: 60,
  shells: 120,
  rockets: 12,
};

// ---------------------------------------------------------------- springs

/** Damped harmonic spring on three axes — one per recoil channel. */
class Spring3 {
  value = new THREE.Vector3();
  vel = new THREE.Vector3();

  kick(x: number, y: number, z: number): void {
    this.vel.x += x;
    this.vel.y += y;
    this.vel.z += z;
  }

  reset(): void {
    this.value.set(0, 0, 0);
    this.vel.set(0, 0, 0);
  }

  /** Semi-implicit Euler, substepped so a stiff spring cannot blow up at 20 fps. */
  step(dt: number, stiffness: number, damping: number): void {
    const steps = dt > 0.02 ? 3 : 1;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.vel.x += (-stiffness * this.value.x - damping * this.vel.x) * h;
      this.vel.y += (-stiffness * this.value.y - damping * this.vel.y) * h;
      this.vel.z += (-stiffness * this.value.z - damping * this.vel.z) * h;
      this.value.x += this.vel.x * h;
      this.value.y += this.vel.y * h;
      this.value.z += this.vel.z * h;
    }
  }
}

// ---------------------------------------------------------------- pools

interface Shell {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  rot: THREE.Euler;
  life: number;
  bounces: number;
  resting: boolean;
}

/** Instanced brass. One draw call for every casing on the ground. */
class ShellPool {
  readonly mesh: THREE.InstancedMesh;
  private shells: Shell[] = [];
  private cursor = 0;
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3(1, 1, 1);

  constructor(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    readonly capacity: number,
    readonly ttl: number,
  ) {
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.count = capacity;
    for (let i = 0; i < capacity; i++) {
      this.shells.push({
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        rot: new THREE.Euler(),
        life: 0,
        bounces: 0,
        resting: false,
      });
      _mat4.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, _mat4);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  spawn(pos: THREE.Vector3, vel: THREE.Vector3, rng: () => number): void {
    const s = this.shells[this.cursor];
    this.cursor = (this.cursor + 1) % this.capacity;
    s.pos.copy(pos);
    s.vel.copy(vel);
    s.spin.set((rng() - 0.5) * 34, (rng() - 0.5) * 26, (rng() - 0.5) * 40);
    s.rot.set(rng() * 6.28, rng() * 6.28, rng() * 6.28);
    s.life = this.ttl;
    s.bounces = 0;
    s.resting = false;
  }

  update(
    dt: number,
    groundAt: (x: number, z: number) => number,
    onBounce: (p: THREE.Vector3, hard: boolean) => void,
  ): void {
    let dirty = false;
    for (let i = 0; i < this.capacity; i++) {
      const s = this.shells[i];
      if (s.life <= 0) continue;
      dirty = true;
      s.life -= dt;

      if (!s.resting) {
        s.vel.y -= 24 * dt;
        s.pos.addScaledVector(s.vel, dt);
        s.rot.x += s.spin.x * dt;
        s.rot.y += s.spin.y * dt;
        s.rot.z += s.spin.z * dt;

        const gy = groundAt(s.pos.x, s.pos.z);
        if (s.pos.y <= gy + 0.008) {
          s.pos.y = gy + 0.008;
          if (s.vel.y < -0.4 && s.bounces < 3) {
            onBounce(s.pos, s.bounces === 0);
            s.vel.y = -s.vel.y * 0.34;
            s.vel.x *= 0.55;
            s.vel.z *= 0.55;
            s.spin.multiplyScalar(0.5);
            s.bounces++;
          } else {
            // Settled: lie flat and stop paying for it.
            s.vel.set(0, 0, 0);
            s.spin.set(0, 0, 0);
            s.rot.x = Math.PI / 2;
            s.resting = true;
          }
        }
      }

      // Fade by shrinking — InstancedMesh has no per-instance alpha.
      const fade = Math.min(1, s.life / (this.ttl * 0.25));
      this.q.setFromEuler(s.rot);
      this.s.setScalar(Math.max(0, fade));
      _mat4.compose(s.pos, this.q, this.s);
      this.mesh.setMatrixAt(i, _mat4);
      if (s.life <= 0) {
        _mat4.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _mat4);
      }
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** A sniper round or a rocket in flight. Stepped in `fixed`. */
interface Projectile {
  active: boolean;
  kind: "bullet" | "rocket";
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  trail: number;
  damage: number;
  headshot: number;
  def: WeaponDef;
  source: DamageSource;
  mesh: THREE.Object3D | null;
}

// ---------------------------------------------------------------- water
//
// SPLASH ROYALE. Everything from here to the end of this block is inert in `classic`
// — none of it is constructed, none of it is stepped, and `ctx.mode` is read
// once into a const so the branch is a single boolean test rather than a
// string compare in the hot path.
//
// The one structural difference from DROP ZERO's ballistics: a soaker has no
// hitscan. Every shot is a *travelling* body of water with its own gravity
// (`WaterWeaponDef.arc`), swept against the world a segment at a time exactly
// the way rockets are, and drawn as a stretched droplet that catches the sun.
// Leading a target is the skill of the mode, so the flight has to be real.

/** What a live water body is. Drives its physics, its render and its impact. */
type WaterKind = "stream" | "balloon" | "glue";

/**
 * One body of water in flight: a stream slug, a thrown balloon or a glue blob.
 * Pooled and reused; nothing in `stepWater` allocates.
 */
interface WaterShot {
  active: boolean;
  kind: WaterKind;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  /** Downward acceleration, m/s². Positive number, applied as -y. */
  gravity: number;
  drag: number;
  /** Simulated seconds left before it gives up / the fuse blows. */
  life: number;
  /** Metres travelled, for range falloff. */
  travelled: number;
  /** Soak this body delivers on a direct hit, before falloff. */
  soak: number;
  faceful: number;
  knockback: number;
  /** Radius of the wet patch it leaves, and how much water that is. */
  splashRadius: number;
  splashAmount: number;
  /** Render size in metres and the colour it catches light with. */
  size: number;
  color: number;
  /** Wobble phase — a balloon is a bag of water and must read as one. */
  wobble: number;
  /** The weapon that fired it, for range falloff. Null for thrown balloons. */
  def: WaterWeaponDef | null;
  source: DamageSource;
  /** True once it has stopped moving (a balloon rolling to a halt). */
  resting: boolean;
  bounces: number;
}

/** A splash droplet: pure cosmetics, real gravity, dies on the ground. */
interface Droplet {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
  color: number;
}

/**
 * A glue strand. The *coupling* — the pull, the slow, the stumble — is the
 * player system's job (`WATER.glue` has every constant it needs). This module
 * owns only the shot that created it and the rope you can see, because the
 * rope has to be anchored to the muzzle it left, and that is here.
 */
interface Strand {
  active: boolean;
  /** Follow an actor when it is one, else a fixed world point. */
  aTarget: DamageTarget | null;
  bTarget: DamageTarget | null;
  aPoint: THREE.Vector3;
  bPoint: THREE.Vector3;
  /** True when end A is the local player — its anchor is the chest, not a box. */
  aIsPlayer: boolean;
  life: number;
  /** Simulated seconds spent stretched past `maxLength`. */
  over: number;
  /** Peer/actor id of the far end, for the net event and the break event. */
  toId: string;
}

/**
 * Pool sizes. The Firehose alone puts ~23 slugs a second in the air with a 1.4 s
 * flight time, and a pump blaster throws eleven at once, so the stream pool is
 * the one that has to be generous. Both pools are single InstancedMeshes: the
 * whole water fight costs two draw calls no matter how many people are shooting.
 */
const WATER_SHOT_CAPACITY: Record<QualityTier, number> = {
  low: 56,
  medium: 110,
  high: 190,
  ultra: 280,
};
const DROPLET_CAPACITY: Record<QualityTier, number> = {
  low: 96,
  medium: 240,
  high: 420,
  ultra: 640,
};

/** Droplets thrown by one stream impact, one balloon burst, at `high`. */
const SPLASH_DROPS = 9;
const BURST_DROPS = 34;

/** Seconds a splash droplet lives before it has evaporated off the screen. */
const DROP_LIFE = 0.85;

/** How far a stream slug may be from the muzzle before we stop caring. */
const WATER_MAX_LIFE = 6;

/**
 * Metres within which `wetness.sourceNear` counts as "standing at a hydrant".
 * Generous — hunting for the exact pixel of a fire hydrant while your tank is
 * empty and someone is hosing you is not the game.
 */
const SOURCE_RANGE = 4.5;

/**
 * Water you carry, per ammo type, and the ceiling a refill fills it to. These
 * are deliberately NOT `AMMO_START`/`AMMO_CAP`: those are balanced around
 * magazines of bullets, and 999 rounds of reserve would mean nobody ever walks
 * to a water source, which is the loop the whole mode is built on.
 */
const WATER_RESERVE_START: Record<AmmoType, number> = {
  light: 90,
  medium: 72,
  heavy: 10,
  shells: 14,
  rockets: 6,
};
const WATER_RESERVE_CAP: Record<AmmoType, number> = {
  light: 180,
  medium: 150,
  heavy: 20,
  shells: 30,
  rockets: 12,
};

/** Segments drawn per glue strand, and how many strands may exist at once. */
const STRAND_CAP = 6;

/** Scratch owned by the water code alone — it nests inside the actor sweep. */
const _w1 = new THREE.Vector3();
const _w2 = new THREE.Vector3();
const _w3 = new THREE.Vector3();
const _w4 = new THREE.Vector3();
const _w5 = new THREE.Vector3();
/**
 * Private to `soakActor` and `burstBalloon`. They are handed `point`/`normal`
 * that the *caller* is still holding in `_w2`/`_w3`, so borrowing those here
 * would let a callee quietly rewrite its own arguments — which is exactly the
 * class of bug that costs a cycle to find.
 */
const _wpush = new THREE.Vector3();
const _wb1 = new THREE.Vector3();
const _wb2 = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _wm = new THREE.Matrix4();
const _wc = new THREE.Color();
const _wscale = new THREE.Vector3();
/** Reusable RayHit for water impacts on built pieces. */
const _waterHit: RayHit = {
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  distance: 0,
  material: "water",
};

/** The inventory `def` ids that mean "a water balloon in your hand". */
function isBalloonItem(item: InventoryItem | null): boolean {
  if (!item || item.kind !== "throwable") return false;
  return item.def === WATER.balloon.id || item.def === "water-balloon" || item.def === "grenade";
}

/**
 * Which water gun an inventory item is. Loot may mint either spelling — a water
 * id (`"soaker9000"`) or the DROP ZERO archetype it re-skins (`"ar"`) — and a
 * mode seam that only accepts one of those is a mode seam that breaks the first
 * time somebody else's system is written to the other.
 */
function waterDefFor(defId: string): WaterWeaponDef | null {
  return waterWeapon(defId) ?? waterFor(defId);
}

// ---------------------------------------------------------------- service

/**
 * Published on `ctx.services.weapons`. Not part of `WorldServices` — that
 * interface is shared and I must not edit it — so consumers reach it through
 * the `WeaponServices` cast exported alongside.
 */
export interface WeaponsService {
  /** The whole table, for a HUD that wants to list what exists. */
  readonly defs: readonly WeaponDef[];
  def(id: string): WeaponDef | null;
  /** Resolved numbers for a gun at a tier. The only balance authority. */
  stats(id: string, rarity: Rarity): WeaponStats | null;
  /** "Legendary Pump Shotgun". */
  displayName(id: string, rarity: Rarity): string;
  /** Mint an inventory item — loot calls this so mags and names are right. */
  makeItem(id: string, rarity: Rarity): InventoryItem | null;
  /** Weighted pick for a loot roll at a tier, or null if nothing qualifies. */
  rollWeapon(rng: () => number, rarity: Rarity): string | null;
  /** Reserve ammo the player is carrying. */
  ammo(type: AmmoType): number;
  addAmmo(type: AmmoType, amount: number): number;
  readonly ammoTypes: readonly AmmoType[];
  /** Live state, for a HUD that wants a crosshair that breathes. */
  readonly adsT: number;
  readonly bloom: number;
  readonly reloading: boolean;
  readonly firing: boolean;

  // ---- SPLASH ROYALE ----------------------------------------------------------
  /**
   * The water gun a def id re-skins, or null in `classic`. Accepts either
   * spelling of the id — a water id or the archetype it rides on.
   */
  waterDef(id: string): WaterWeaponDef | null;
  /** Tank/soak numbers for a def id at a tier, or null in `classic`. */
  waterStats(id: string, rarity: Rarity): WaterStats | null;
  /** Live tank level and capacity of whatever is in the player's hands. */
  readonly tank: number;
  readonly tankMax: number;
  /** True while the tank is filling — pumping, or standing at a source. */
  readonly refilling: boolean;
}

/** `ctx.services` plus this module's extra key. */
export type WeaponServices = WorldServices & { weapons?: WeaponsService };

/** What `dz:weapon` carries. The HUD reads engine events, never this module. */
export interface WeaponHudPayload {
  id: string | null;
  name: string;
  short: string;
  rarity: Rarity;
  color: number;
  mode: FireMode;
  ammo: number;
  magSize: number;
  reserve: number;
  ammoType: AmmoType | null;
  reloading: boolean;
  reloadProgress: number;
  lowAmmo: boolean;
  empty: boolean;
  scoped: boolean;
  ads: number;

  // ---- SPLASH ROYALE. Absent in `classic`; a HUD that ignores them is still correct.
  /** True when this payload describes a soaker rather than a gun. */
  water?: boolean;
  /** Tank units left and capacity. Mirrors `ammo`/`magSize` for a water HUD. */
  tank?: number;
  tankMax?: number;
  /** Water carried in the backpack, and what it tops out at. */
  carried?: number;
  carriedMax?: number;
  /** True while the tank is filling (pumping, or standing at a source). */
  refilling?: boolean;
  /** 0..1 across the wind-up, then across the fill itself. */
  refillProgress?: number;
  /** True when a water source is in reach, so the HUD can prompt for it. */
  atSource?: boolean;
  /** Stream colour, for a HUD that tints the tank gauge to the gun. */
  streamColor?: number;
  /** Soak one full trigger pull delivers at point blank. */
  soak?: number;
  /** Balloons in hand, when the active item is the throwable. */
  balloons?: number;
}

// ---------------------------------------------------------------- system

const SHELL_CAPACITY: Record<QualityTier, number> = { low: 18, medium: 40, high: 72, ultra: 110 };
const PROJECTILE_CAPACITY: Record<QualityTier, number> = { low: 8, medium: 14, high: 22, ultra: 32 };

interface WeaponEntry {
  def: WeaponDef;
  /** First-person rig, in the viewmodel scene. */
  vm: WeaponRig;
  /** Third-person clone, in the world scene. Shares geometry and materials. */
  tp: THREE.Object3D;
  tpMuzzle: THREE.Object3D;
  tpAccents: THREE.Mesh[];
  /** The clone's animated sub-assemblies, so third person cycles too. */
  tpSlide: THREE.Object3D | null;
  tpMag: THREE.Object3D | null;
  tpBarrels: THREE.Object3D | null;
  /** ADS pose, precomputed from the optic. */
  ads: THREE.Vector3;
}

/** Per-item runtime state that does not fit in `InventoryItem`. */
interface ItemState {
  /** Rolling shot index — drives the recoil pattern. */
  shotIndex: number;
  /** Shells already chambered during a shell-by-shell reload. */
  seen: number;
}

interface FixedSystem extends System {
  fixed(dt: number, ctx: WorldCtx): void;
}

const createWeapons: SystemFactory = (ctx: WorldCtx): System => {
  const services = ctx.services as WeaponServices;
  const quality = ctx.quality;
  const lod = quality === "low" ? 0 : 1;

  /**
   * The mode seam. Read once: `/drop-zero` is live and its loop is verified,
   * so every water behaviour in this file sits behind this boolean and classic
   * takes the exact code path it took before SPLASH ROYALE existed.
   */
  const isWater = ctx.mode === "water";

  // ---- state the service reads. Declared before the service so the getters
  // ---- can close over it, and before any expensive work so a failure in the
  // ---- mesh bake still leaves later systems a usable weapons service.
  let adsT = 0;
  let bloom = 0;
  let reloadT = 0;
  let reloadTotal = 0;
  let firing = false;

  // The tank is the magazine, restated. `refillT` counts the wind-up down;
  // once it hits zero water flows continuously, so a refill interrupted
  // halfway keeps whatever it got — the one mechanical difference from a mag.
  let refillT = 0;
  let refilling = false;
  let autoRefill = false;
  let atSource = false;
  let sourceRate = 0;

  const reserve: Record<AmmoType, number> = isWater
    ? { ...WATER_RESERVE_START }
    : { ...AMMO_START };
  const reserveCap: Record<AmmoType, number> = isWater ? WATER_RESERVE_CAP : AMMO_CAP;

  /** The water gun in the player's hands, and its rarity-resolved numbers. */
  let wdef: WaterWeaponDef | null = null;
  let wstats: WaterStats | null = null;

  /** Tank capacity of whatever is held — the water-mode `stats.magSize`. */
  function magOf(): number {
    if (isWater) return wstats ? wstats.tank : 0;
    return stats ? stats.magSize : 0;
  }

  const service: WeaponsService = {
    defs: ARSENAL,
    def(id) {
      return DEF_BY_ID.get(id) ?? null;
    },
    stats(id, rarity) {
      const def = DEF_BY_ID.get(id);
      return def ? statsFor(def, rarity) : null;
    },
    displayName(id, rarity) {
      if (isWater) {
        const w = waterStats(waterDefFor(id)?.id ?? id, rarity);
        if (w) return w.displayName;
      }
      const def = DEF_BY_ID.get(id);
      return def ? `${RARITY_LABEL[rarity]} ${def.name}` : "";
    },
    makeItem(id, rarity) {
      // In water mode the item is minted with a TANK rather than a magazine,
      // and carries the soaker's name. The `def` written onto the item is
      // whatever the caller asked for — loot may key off either spelling and
      // rewriting it here would silently break the one that did not ask.
      const w = isWater ? waterDefFor(id) : null;
      const def = DEF_BY_ID.get(w ? w.archetype : id) ?? DEF_BY_ID.get(id);
      if (!def) return null;
      const ws = w ? waterStats(w.id, rarity) : null;
      return {
        id: `${id}-${rarity}-${Math.floor(ctx.rng() * 0xffffff).toString(36)}`,
        kind: "weapon",
        def: id,
        name: w ? w.name : def.name,
        rarity,
        ammo: ws ? ws.tank : def.magSize,
      };
    },
    rollWeapon(rng, rarity) {
      const i = rarityIndex(rarity);
      let total = 0;
      for (const def of ARSENAL) total += LOOT_WEIGHTS[def.id]?.[i] ?? 0;
      if (total <= 0) return null;
      let pick = rng() * total;
      for (const def of ARSENAL) {
        pick -= LOOT_WEIGHTS[def.id]?.[i] ?? 0;
        if (pick <= 0) return def.id;
      }
      return ARSENAL[0].id;
    },
    ammo(type) {
      return reserve[type] ?? 0;
    },
    addAmmo(type, amount) {
      reserve[type] = clamp((reserve[type] ?? 0) + amount, 0, reserveCap[type] ?? 999);
      hudDirty = true;
      return reserve[type];
    },
    ammoTypes: ["light", "medium", "heavy", "shells", "rockets"],
    get adsT() {
      return adsT;
    },
    get bloom() {
      return bloom;
    },
    get reloading() {
      return reloadT > 0 || refilling;
    },
    get firing() {
      return firing;
    },
    waterDef(id) {
      return isWater ? waterDefFor(id) : null;
    },
    waterStats(id, r) {
      if (!isWater) return null;
      const w = waterDefFor(id);
      return w ? waterStats(w.id, r) : null;
    },
    get tank() {
      return isWater ? ammoOf() : 0;
    },
    get tankMax() {
      return isWater ? magOf() : 0;
    },
    get refilling() {
      return refilling;
    },
  };
  services.weapons = service;

  // ---- viewmodel scene ---------------------------------------------------
  // Its own scene and its own near-clipped camera. The viewmodel is drawn in a
  // second pass with the depth buffer cleared, which is the only construction
  // that makes "the gun never clips into a wall" a guarantee rather than a
  // tuning exercise.
  const vmScene = new THREE.Scene();
  const vmCamera = new THREE.PerspectiveCamera(
    ctx.camera.fov * VM_FOV_SCALE,
    ctx.camera.aspect,
    VM_NEAR,
    VM_FAR,
  );
  vmCamera.layers.set(VM_LAYER);
  vmCamera.rotation.order = "YXZ";

  /** Everything in the viewmodel scene gets the layer, lights included. */
  const toVmLayer = (o: THREE.Object3D): void => {
    o.traverse((c) => {
      c.layers.set(VM_LAYER);
      c.frustumCulled = false;
    });
  };

  // Three-point rig, sized for one object 40 cm from the lens. A viewmodel lit
  // by the world's sun alone goes black every time the player steps indoors,
  // which is exactly when they need to read their ammo state off the gun.
  const vmKey = new THREE.DirectionalLight(0xfff0d8, 2.6);
  vmKey.position.set(0.6, 0.9, 0.5);
  const vmFill = new THREE.HemisphereLight(0x9dc4ff, 0x3a3228, 1.15);
  const vmRim = new THREE.DirectionalLight(0x9fc6ff, 1.9);
  vmRim.position.set(-0.7, 0.25, -0.9);
  const vmBounce = new THREE.PointLight(0xffd9a8, 0.55, 2.4, 2);
  vmBounce.position.set(0.1, -0.5, 0.1);
  vmScene.add(vmKey, vmFill, vmRim, vmBounce);
  toVmLayer(vmKey);
  toVmLayer(vmFill);
  toVmLayer(vmRim);
  toVmLayer(vmBounce);

  // ---- assets ------------------------------------------------------------
  const kit = makeKit(ctx);
  const texSize = quality === "ultra" ? 512 : quality === "low" ? 128 : 256;
  const reticleTex = makeReticleTexture(texSize);
  const flashTex = makeFlashSprite(quality === "low" ? 64 : 128);
  const glowTex = makeGlowSprite(64);
  const extraTextures: THREE.Texture[] = [reticleTex, flashTex, glowTex];
  const extraMaterials: THREE.Material[] = [];
  const extraGeometries: THREE.BufferGeometry[] = [];

  const builderCtx: BuilderCtx = { kit, lod, rng: ctx.rng, reticle: reticleTex };

  // ---- build the arsenal -------------------------------------------------
  const entries = new Map<string, WeaponEntry>();
  const tpRoot = new THREE.Group();
  tpRoot.name = "dz-weapon-tp";
  tpRoot.visible = false;
  ctx.scene.add(tpRoot);

  for (const def of ARSENAL) {
    let vm: WeaponRig;
    try {
      vm = def.build(builderCtx);
    } catch (err) {
      // One bad builder must not cost the player every other gun.
      console.error(`[Drop Zero] weapon "${def.id}" failed to build:`, err);
      continue;
    }
    vm.root.scale.setScalar(def.vmScale);
    vm.root.visible = false;
    vmScene.add(vm.root);
    toVmLayer(vm.root);

    // Third person shares geometry and materials with the viewmodel — the
    // clone is scene-graph nodes and nothing else.
    const tp = vm.root.clone(true);
    tp.scale.setScalar(def.tpScale);
    tp.visible = false;
    const tpAccents: THREE.Mesh[] = [];
    tp.traverse((o) => {
      o.layers.set(0);
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        // A weapon casts into every shadow cascade; on the low tier that is
        // several dozen draws for a shadow the size of a stick.
        m.castShadow = quality !== "low";
        m.receiveShadow = true;
        m.frustumCulled = true;
        if (m.userData.accent) tpAccents.push(m);
      }
    });
    // The scope ocular is a first-person conceit — the clone inherits it
    // already switched off and nothing ever turns the copy back on, which is
    // what we want: out in the world it would be a disc floating in a tube.
    tpRoot.add(tp);

    // Third-person muzzle: mirror the viewmodel's local muzzle so tracers and
    // flashes leave the actual barrel of the object other players can see.
    const tpMuzzle = new THREE.Object3D();
    tpMuzzle.position.copy(vm.muzzle.position);
    tp.add(tpMuzzle);

    // `makeRigShell` adds body first, then slide/mag/barrels into it, before
    // anything else touches the graph — so these indices are stable for every
    // weapon, and a clone preserves child order exactly.
    const tpBody = tp.children[0] ?? null;
    const tpSlide = tpBody?.children[0] ?? null;
    const tpMag = tpBody?.children[1] ?? null;
    const tpBarrels = tpBody?.children[2] ?? null;

    entries.set(def.id, {
      def,
      vm,
      tp,
      tpMuzzle,
      tpAccents,
      tpSlide,
      tpMag,
      tpBarrels,
      ads: new THREE.Vector3(
        -vm.optic.position.x * def.vmScale,
        -vm.optic.position.y * def.vmScale,
        ADS_Z,
      ),
    });
  }

  // ---- first-person muzzle flash ----------------------------------------
  const flashMat = new THREE.MeshBasicMaterial({
    map: flashTex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    opacity: 0,
  });
  extraMaterials.push(flashMat);
  const flashGeo = new THREE.PlaneGeometry(1, 1);
  extraGeometries.push(flashGeo);
  const flash = new THREE.Mesh(flashGeo, flashMat);
  flash.renderOrder = 20;
  flash.visible = false;
  vmScene.add(flash);
  toVmLayer(flash);

  const flashLight = new THREE.PointLight(0xffb257, 0, 2.6, 2);
  flashLight.intensity = 0;
  vmScene.add(flashLight);
  toVmLayer(flashLight);

  // ---- shells ------------------------------------------------------------
  const shellCap = SHELL_CAPACITY[quality] ?? 48;
  const brassGeo = tubeGeo(0.0052, 0.0058, 0.024, 7, false);
  const hullGeo = tubeGeo(0.0094, 0.0094, 0.052, 8, false);
  extraGeometries.push(brassGeo, hullGeo);
  const brassMat = new THREE.MeshStandardMaterial({
    color: 0xc7a04a,
    metalness: 1,
    roughness: 0.3,
    envMap: ctx.services.materials?.env ?? null,
    envMapIntensity: 1.2,
  });
  const hullMat = new THREE.MeshStandardMaterial({
    color: 0x912a1d,
    metalness: 0.12,
    roughness: 0.72,
  });
  extraMaterials.push(brassMat, hullMat);
  const brassShells = new ShellPool(brassGeo, brassMat, shellCap, 7);
  const hullShells = new ShellPool(hullGeo, hullMat, Math.max(8, shellCap >> 2), 9);
  ctx.scene.add(brassShells.mesh, hullShells.mesh);

  // ---- projectiles -------------------------------------------------------
  // Rockets are modelled objects; sniper rounds are a stretched additive
  // sprite, because a 460 m/s bullet is a streak and nothing else.
  const projCap = PROJECTILE_CAPACITY[quality] ?? 16;
  const rocketBody = tubeGeo(0.055, 0.055, 0.34, 10, false);
  const rocketNose = new THREE.ConeGeometry(0.06, 0.17, 10);
  rocketNose.rotateX(-Math.PI / 2);
  const rocketFin = bevelBox(0.007, 0.075, 0.1, 0.002, 0.003);
  // A one-metre streak along -Z, scaled per frame to the round's own travel.
  // A billboard would vanish edge-on, which is exactly the angle you are at
  // when someone snipes past your ear.
  const bulletGeo = tubeGeo(0.022, 0.022, 1, 6, true);
  const plumeGeo = new THREE.SphereGeometry(0.09, 8, 6);
  extraGeometries.push(rocketBody, rocketNose, rocketFin, bulletGeo, plumeGeo);

  const rocketSkin = new THREE.MeshStandardMaterial({
    color: 0x4d5560,
    metalness: 0.75,
    roughness: 0.42,
    envMap: ctx.services.materials?.env ?? null,
  });
  extraMaterials.push(rocketSkin);
  const plumeMat = new THREE.MeshBasicMaterial({
    map: glowTex,
    color: 0xffc070,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const bulletMat = new THREE.MeshBasicMaterial({
    map: glowTex,
    color: 0xffe6b0,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  extraMaterials.push(plumeMat, bulletMat);

  const projectiles: Projectile[] = [];
  for (let i = 0; i < projCap; i++) {
    const isRocket = i < Math.max(3, projCap >> 2);
    let mesh: THREE.Object3D;
    if (isRocket) {
      const g = new THREE.Group();
      const bodyMesh = new THREE.Mesh(rocketBody, rocketSkin);
      const nose = new THREE.Mesh(rocketNose, rocketSkin);
      nose.position.z = -0.25;
      g.add(bodyMesh, nose);
      for (let f = 0; f < 4; f++) {
        const a = (f / 4) * Math.PI * 2;
        const fin = new THREE.Mesh(rocketFin, rocketSkin);
        fin.position.set(Math.cos(a) * 0.05, Math.sin(a) * 0.05, 0.16);
        fin.rotation.z = a;
        g.add(fin);
      }
      const plume = new THREE.Mesh(plumeGeo, plumeMat);
      plume.scale.set(1, 1, 2.6);
      plume.position.z = 0.28;
      g.add(plume);
      mesh = g;
    } else {
      mesh = new THREE.Mesh(bulletGeo, bulletMat);
    }
    mesh.visible = false;
    mesh.frustumCulled = false;
    ctx.scene.add(mesh);
    projectiles.push({
      active: false,
      kind: isRocket ? "rocket" : "bullet",
      pos: new THREE.Vector3(),
      prev: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      life: 0,
      trail: 0,
      damage: 0,
      headshot: 1,
      def: ARSENAL[0],
      source: { by: "player" },
      mesh,
    });
  }

  // ---- water ------------------------------------------------------------
  // Three InstancedMeshes and two pools, and only in SPLASH ROYALE: `classic` never
  // allocates a byte of this. Water reads through transparency, a very low
  // roughness and the environment map — never as blue paint — so the same
  // material serves a stream slug, a splash droplet and a thrown balloon, and
  // per-instance colour does the rest.
  const waterShots: WaterShot[] = [];
  const droplets: Droplet[] = [];
  const strands: Strand[] = [];
  let waterMesh: THREE.InstancedMesh | null = null;
  let dropMesh: THREE.InstancedMesh | null = null;
  let strandMesh: THREE.InstancedMesh | null = null;

  if (isWater) {
    const shotCap = WATER_SHOT_CAPACITY[quality] ?? 110;
    const dropCap = DROPLET_CAPACITY[quality] ?? 240;

    // An icosahedron, not a UV sphere: at the size a droplet renders (a few
    // centimetres, usually motion-stretched) the tessellation is invisible and
    // an ico at detail 1 is 80 triangles against a sphere's 400.
    const dropGeo = new THREE.IcosahedronGeometry(0.5, quality === "low" ? 0 : 1);
    // Radius 0.5 so a unit scale is a one-metre body and `size` reads as a
    // diameter everywhere below.
    extraGeometries.push(dropGeo);

    const waterSkin = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      // Water is a mirror with a hole in it. Near-zero roughness plus the
      // island's own env map is what makes a droplet catch the sun; going any
      // rougher and the whole fight turns into blue plastic pellets.
      roughness: 0.04,
      metalness: 0,
      transparent: true,
      opacity: 0.72,
      envMap: ctx.services.materials?.env ?? null,
      envMapIntensity: 2.1,
      // Hundreds of overlapping translucent bodies with depth writes on would
      // punch holes in each other; without them they composite like spray.
      depthWrite: false,
      side: THREE.FrontSide,
    });
    extraMaterials.push(waterSkin);

    waterMesh = new THREE.InstancedMesh(dropGeo, waterSkin, shotCap);
    dropMesh = new THREE.InstancedMesh(dropGeo, waterSkin, dropCap);
    for (const m of [waterMesh, dropMesh]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      // Transparent and unsorted, so draw it after the opaque world.
      m.renderOrder = 6;
      m.count = 0;
      ctx.scene.add(m);
    }
    // Per-instance colour: a Hydro Lance jet and a pink balloon share one draw
    // call and still look like different liquids.
    waterMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(shotCap * 3), 3);
    waterMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    dropMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(dropCap * 3), 3);
    dropMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    for (let i = 0; i < shotCap; i++) {
      waterShots.push({
        active: false,
        kind: "stream",
        pos: new THREE.Vector3(),
        prev: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        gravity: 0,
        drag: 0,
        life: 0,
        travelled: 0,
        soak: 0,
        faceful: 1,
        knockback: 0,
        splashRadius: 0.6,
        splashAmount: 0.3,
        size: 0.12,
        color: 0x4fc3f7,
        wobble: 0,
        def: null,
        source: { by: "player" },
        resting: false,
        bounces: 0,
      });
    }
    for (let i = 0; i < dropCap; i++) {
      droplets.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: DROP_LIFE,
        size: 0.05,
        color: 0xdff4ff,
      });
    }

    // ---- glue strands ----------------------------------------------------
    // One capped rope: STRAND_CAP × segments cylinder instances, all in one
    // draw call, repositioned along a sagging curve every frame.
    const strandGeo = new THREE.CylinderGeometry(
      WATER.glue.strandRadius,
      WATER.glue.strandRadius,
      1,
      quality === "low" ? 4 : 6,
      1,
      true,
    );
    extraGeometries.push(strandGeo);
    const strandSkin = new THREE.MeshStandardMaterial({
      color: WATER.glue.color,
      emissive: new THREE.Color(WATER.glue.glowColor),
      // Glue is not a light source, but it is tacky and slightly luminous —
      // enough that a strand across a shaded doorway still reads.
      emissiveIntensity: 0.35,
      roughness: 0.32,
      metalness: 0,
      transparent: true,
      opacity: 0.88,
    });
    extraMaterials.push(strandSkin);
    strandMesh = new THREE.InstancedMesh(strandGeo, strandSkin, STRAND_CAP * WATER.glue.segments);
    strandMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    strandMesh.frustumCulled = false;
    strandMesh.castShadow = false;
    strandMesh.renderOrder = 5;
    strandMesh.count = 0;
    ctx.scene.add(strandMesh);

    for (let i = 0; i < STRAND_CAP; i++) {
      strands.push({
        active: false,
        aTarget: null,
        bTarget: null,
        aPoint: new THREE.Vector3(),
        bPoint: new THREE.Vector3(),
        aIsPlayer: false,
        life: 0,
        over: 0,
        toId: "",
      });
    }
  }

  // ---- second render pass ------------------------------------------------
  // We wrap whatever postfx published rather than replacing it. See the module
  // header: postfx owns the image, we own the twelve inches in front of the
  // lens. The identity check on `composite` is what stops our own re-emit from
  // recursing through the listener list.
  let innerRender: ((dt: number) => void) | null = null;
  let vmVisible = false;

  const composite = (dt: number): void => {
    const renderer = ctx.renderer;
    if (innerRender) innerRender(dt);
    else renderer.render(ctx.scene, ctx.camera);
    if (!vmVisible) return;
    const prevAutoClear = renderer.autoClear;
    renderer.setRenderTarget(null);
    renderer.autoClear = false;
    // The depth clear is the whole trick: the viewmodel is composited over a
    // finished frame with no depth history, so no wall can ever be in front
    // of it and no barrel can ever poke through one.
    renderer.clearDepth();
    renderer.render(vmScene, vmCamera);
    renderer.autoClear = prevAutoClear;
  };

  const offPostfx = ctx.on("dz:postfx", (fn) => {
    if (fn === composite) return;
    innerRender = typeof fn === "function" ? (fn as (dt: number) => void) : null;
    ctx.emit("dz:postfx", composite);
  });
  ctx.emit("dz:postfx", composite);

  // ---- runtime state -----------------------------------------------------
  let activeItem: InventoryItem | null = null;
  let entry: WeaponEntry | null = null;
  let stats: WeaponStats | null = null;
  let rarity: Rarity = "common";
  let firstPerson = false;

  let pendingItem: InventoryItem | null = null;
  let swapT = 0;
  let swapTotal = 0;
  let cooldown = 0;
  let shellMode = false;
  let burstLeft = 0;
  let burstTimer = 0;
  let spin = 0;
  let spinAngle = 0;
  let heat = 0;
  let slidePhase = 0;
  let slideTimer = 0;
  let sprintT = 0;
  let hitstop = 0;
  let flashTime = 0;
  let shotsSinceTracer = 0;
  let lastFireHeld = false;
  let lastReloadHeld = false;
  let fovDelta = 0;
  /** Our contribution to the world FOV last frame, and the value we left. */
  let fovApplied = 0;
  let fovLeft = -1;
  let hudDirty = true;
  let hudKey = "";
  let lastCrosshair = -1;
  let dryClick = 0;

  /** The balloon stack in the player's hands, when that is what they hold. */
  let balloonItem: InventoryItem | null = null;
  /** Seconds until the next balloon may be thrown. */
  let throwCooldown = 0;
  let lastThrowHeld = false;

  const itemState = new Map<string, ItemState>();

  // Feel channels.
  const recoilPos = new Spring3();
  const recoilRot = new Spring3();
  const camKick = new Spring3();
  const sway = new THREE.Vector2();
  const swayVel = new THREE.Vector2();
  const shake = new THREE.Vector3();
  const shakeVel = new THREE.Vector3();
  let bobPhase = 0;
  let bobAmp = 0;

  const posePos = new THREE.Vector3();
  const poseRot = new THREE.Euler(0, 0, 0, "YXZ");
  const aimQuat = new THREE.Quaternion();
  const source: DamageSource = { by: "player", name: "You", weapon: "" };

  /** Third-person anchor: the character's right hand, found once, lazily. */
  let handNode: THREE.Object3D | null = null;
  let handSearched = false;

  const offCamera = ctx.on("dz:camera", (payload) => {
    const p = payload as { firstPerson?: boolean } | undefined;
    if (typeof p?.firstPerson === "boolean") firstPerson = p.firstPerson;
  });
  // The player also republishes the camera mode on every HUD tick. Reading it
  // there as well means a weapon that booted after a toggle still agrees with
  // the camera, instead of showing a viewmodel in third person until the
  // player presses F twice.
  const offHud = ctx.on("dz:hud", (payload) => {
    const p = payload as { firstPerson?: boolean } | undefined;
    if (typeof p?.firstPerson === "boolean") firstPerson = p.firstPerson;
  });

  // ---- helpers -----------------------------------------------------------

  function stateFor(item: InventoryItem): ItemState {
    let s = itemState.get(item.id);
    if (!s) {
      s = { shotIndex: 0, seen: 0 };
      // Bounded: a match hands out a lot of guns and this map must not become
      // a leak. Oldest first — Map preserves insertion order.
      if (itemState.size > 64) {
        const first = itemState.keys().next();
        if (!first.done) itemState.delete(first.value);
      }
      itemState.set(item.id, s);
    }
    return s;
  }

  function ammoOf(): number {
    if (!activeItem || !stats) return 0;
    const a = activeItem.ammo;
    return typeof a === "number" ? a : magOf();
  }

  function setAmmo(n: number): void {
    if (!activeItem) return;
    // Rounds are whole; water is not. A tank filling at 12 units a second in
    // 1/120 s steps would never move at all if every write floored.
    activeItem.ammo = isWater ? Math.max(0, n) : Math.max(0, Math.floor(n));
    hudDirty = true;
  }

  /**
   * Are we allowed to be holding a gun at all? Building, the pickaxe, the
   * skydive and being dead all stow it. Note the build check reads the service
   * *and* the raw input: if the build system failed to boot, a player pressing
   * Z would otherwise fire a wall's worth of bullets.
   */
  function stowed(): boolean {
    const player = ctx.services.player;
    if (!player) return true;
    if (player.state === "dead" || player.state === "down") return true;
    if (player.state === "bus" || player.state === "skydive" || player.state === "glide") return true;
    if (ctx.services.build?.selected || ctx.input.buildKind) return true;
    // In SPLASH ROYALE a fistful of water balloons is a live weapon even though there
    // is no gun entry behind it. Classic has no throwables and is unchanged.
    if (isWater && balloonItem) return false;
    return !entry;
  }

  function applyRarity(e: WeaponEntry, r: Rarity): void {
    const mat = kit.accent(r);
    for (const m of e.vm.accents) m.material = mat;
    for (const m of e.tpAccents) m.material = mat;
  }

  function commitItem(item: InventoryItem | null): void {
    if (entry) {
      entry.vm.root.visible = false;
      entry.tp.visible = false;
    }
    activeItem = item;
    entry = item ? entries.get(entryIdFor(item.def)) ?? null : null;
    stats = entry ? statsFor(entry.def, item ? item.rarity : "common") : null;
    // The water table overrides everything the re-theme changes; the archetype
    // keeps the ballistics timing, the mesh, the recoil and the reload beats.
    wdef = isWater && item ? waterDefFor(item.def) : null;
    wstats = wdef && item ? waterStats(wdef.id, item.rarity) : null;
    rarity = item?.rarity ?? "common";
    // The elimination feed should say "Super Soaker 9000", and combat's
    // headshot table should MISS on a water id — see COMBAT_HEAD_DEFAULT.
    source.weapon = (wdef ? wdef.id : entry?.def.id) ?? "";
    refilling = false;
    refillT = 0;
    autoRefill = false;
    burstLeft = 0;
    burstTimer = 0;
    slidePhase = 0;
    slideTimer = 0;
    bloom = 0;
    spin = 0;
    cooldown = 0;
    recoilPos.reset();
    recoilRot.reset();
    if (entry) {
      applyRarity(entry, rarity);
      // A gun picked up with an empty mag should not need a manual reload —
      // that is a hidden state the HUD cannot explain. Same for a dry tank.
      if (activeItem && typeof activeItem.ammo !== "number") {
        activeItem.ammo = wstats ? wstats.tank : entry.def.magSize;
      }
    }
    hudDirty = true;
  }

  /**
   * The aim basis. Built from the player's yaw/pitch plus the camera-recoil
   * spring rather than from `camera.quaternion`, because firing happens in
   * `fixed()` — before the camera has been written this frame — and because
   * this way the bullets follow the same kick the picture does, exactly.
   */
  function aimBasis(): THREE.Quaternion {
    const player = ctx.services.player;
    const yaw = player ? player.yaw : 0;
    const pitch = player ? player.pitch : 0;
    _e1.set(pitch + camKick.value.x, yaw + camKick.value.y, 0, "YXZ");
    return aimQuat.setFromEuler(_e1);
  }

  /** Uniform cone jitter around `dir`, written back into `dir`. */
  function coneJitter(dir: THREE.Vector3, halfAngle: number): void {
    if (halfAngle <= 1e-5) return;
    _t1.copy(Math.abs(dir.y) > 0.95 ? _v4.set(1, 0, 0) : UP)
      .cross(dir)
      .normalize();
    _t2.crossVectors(dir, _t1).normalize();
    const ang = ctx.rng() * Math.PI * 2;
    // sqrt so the samples are uniform over the disc rather than clustered at
    // the centre — a Gaussian-looking cone is what makes spread feel unfair.
    const rad = Math.sqrt(ctx.rng()) * halfAngle;
    const t = Math.tan(rad);
    dir
      .addScaledVector(_t1, t * Math.cos(ang))
      .addScaledVector(_t2, t * Math.sin(ang))
      .normalize();
  }

  /** Damage multiplier at a distance. */
  function falloff(def: WeaponDef, dist: number): number {
    if (dist <= def.falloffStart) return 1;
    if (dist >= def.falloffEnd) return MIN_FALLOFF;
    return lerp(1, MIN_FALLOFF, (dist - def.falloffStart) / (def.falloffEnd - def.falloffStart));
  }

  /**
   * Ray vs a vertical capsule. Actors are registered as `{ radius, height }`
   * with `object.position` at the feet, so this is the exact hitbox the rest
   * of the game agrees on — approximating it with a sphere is how you get
   * "I shot them in the legs and nothing happened".
   */
  function rayCapsule(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    base: THREE.Vector3,
    radius: number,
    height: number,
    limit: number,
  ): number {
    const ox = origin.x - base.x;
    const oz = origin.z - base.z;
    const a = dir.x * dir.x + dir.z * dir.z;
    const top = base.y + height;

    if (a < 1e-9) {
      // Straight up or down: only the caps can be hit.
      if (ox * ox + oz * oz > radius * radius) return -1;
      const t = dir.y > 0 ? (base.y - origin.y) / dir.y : (top - origin.y) / dir.y;
      return t >= 0 && t <= limit ? t : -1;
    }

    const b = 2 * (ox * dir.x + oz * dir.z);
    const c = ox * ox + oz * oz - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return -1;
    const sq = Math.sqrt(disc);
    const inv = 1 / (2 * a);
    let t = (-b - sq) * inv;
    if (t < 0) t = (-b + sq) * inv;
    if (t < 0 || t > limit) return -1;

    const y = origin.y + dir.y * t;
    if (y >= base.y && y <= top) return t;

    // Missed the barrel — try the cap plane the ray is heading toward.
    const planeY = y < base.y ? base.y : top;
    if (Math.abs(dir.y) < 1e-9) return -1;
    const tc = (planeY - origin.y) / dir.y;
    if (tc < 0 || tc > limit) return -1;
    const cx = origin.x + dir.x * tc - base.x;
    const cz = origin.z + dir.z * tc - base.z;
    return cx * cx + cz * cz <= radius * radius ? tc : -1;
  }

  let sweepTarget: DamageTarget | null = null;

  /**
   * Nearest damageable actor along a segment. `CombatService` has no ray query,
   * so we take every actor whose sphere could touch the segment in one
   * broadphase call and do exact ray/capsule on the shortlist.
   */
  function sweepActors(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number {
    sweepTarget = null;
    const combat = ctx.services.combat;
    if (!combat || maxDist <= 0) return -1;
    _sa.copy(origin).addScaledVector(dir, maxDist * 0.5);
    let list: DamageTarget[];
    try {
      list = combat.queryTargets(_sa, maxDist * 0.5 + 3);
    } catch {
      return -1;
    }
    if (!list || !list.length) return -1;

    let best = -1;
    for (const t of list) {
      if (!t.alive || t.faction === "player") continue;
      t.object.getWorldPosition(_sb);
      const d = rayCapsule(origin, dir, _sb, t.radius, t.height, maxDist);
      if (d < 0) continue;
      if (best < 0 || d < best) {
        best = d;
        sweepTarget = t;
      }
    }
    return best;
  }

  function emitHitmarker(kind: "hit" | "shield" | "elim", amount: number): void {
    ctx.emit("dz:hitmarker", { kind, amount });
    const audio = ctx.services.audio;
    if (kind === "elim") {
      // Deliberately its own sound and its own hitmarker kind: the elimination
      // confirm is the most important piece of feedback in a battle royale and
      // it must never be mistaken for a body shot. We do NOT emit
      // `dz:eliminate` — combat owns the death and the kill feed, and a second
      // announcement from here would double every entry in it.
      audio?.play("elim-confirm", { volume: 0.85 });
    } else {
      audio?.play(kind === "shield" ? "hitmarker-shield" : "hitmarker", { volume: 0.4 });
    }
  }

  /** Route damage into an actor and report what came back out. */
  function damageActor(
    target: DamageTarget,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    dist: number,
    amount: number,
    headMult: number,
    impact: ImpactMaterial = "flesh",
  ): void {
    const combat = ctx.services.combat;
    target.object.getWorldPosition(_sc);
    const headshot = point.y - _sc.y >= target.headY - 0.16;
    const hadShield = target.shield > 0;
    const wasAlive = target.alive && target.hp > 0;

    // Nobody gets hurt in SPLASH ROYALE, so a faceful is worth far less than a
    // headshot is. Combat will apply its own default multiplier to a weapon id
    // it does not know; undo it and apply the water table's instead.
    if (impact === "water" && headshot && combat) {
      amount = (amount * headMult) / COMBAT_HEAD_DEFAULT;
    }

    _actorHit.point.copy(point);
    _actorHit.normal.copy(normal);
    _actorHit.distance = dist;
    _actorHit.material = impact;
    _actorHit.target = target;
    _actorHit.object = target.object;
    _actorHit.piece = undefined;
    _actorHit.tag = "actor";

    if (combat) {
      // Combat owns the headshot multiplier, the shield split and the damage
      // number. See the report: `applyHit` has no per-weapon head multiplier,
      // so `def.headshot` only drives the fallback path below.
      combat.applyHit(_actorHit, amount, source);
    } else {
      target.onDamage(amount * (headshot ? headMult : 1), point, source, headshot);
    }

    // A splash, not a blood puff. Nobody bleeds here; they get drenched, and
    // the droplets that sell it are spawned by `splashAt` on the way out.
    ctx.services.vfx?.impact(point, normal, impact);
    hitstop = Math.max(hitstop, headshot ? 0.055 : 0.035);
    const dead = !target.alive || target.hp <= 0;
    emitHitmarker(dead && wasAlive ? "elim" : hadShield ? "shield" : "hit", amount);
  }

  /** One hitscan ray: world hit, actor hit, decal, tracer. */
  function hitscan(origin: THREE.Vector3, dir: THREE.Vector3, def: WeaponDef, damage: number): void {
    const collision = ctx.services.collision;
    const vfx = ctx.services.vfx;

    let worldHit: RayHit | null = null;
    try {
      worldHit = collision?.raycast(origin, dir, def.range) ?? null;
    } catch {
      worldHit = null;
    }
    let end = worldHit ? worldHit.distance : def.range;

    // An actor in front of the wall wins; the collision broadphase may already
    // carry the target on the hit, in which case we do not double-count it.
    const actorDist = sweepActors(origin, dir, end);
    if (actorDist >= 0 && sweepTarget && (!worldHit || actorDist <= worldHit.distance)) {
      _v1.copy(origin).addScaledVector(dir, actorDist);
      _v2.copy(dir).negate();
      damageActor(sweepTarget, _v1, _v2, actorDist, damage * falloff(def, actorDist), def.headshot);
      end = actorDist;
    } else if (worldHit) {
      const mat: ImpactMaterial = worldHit.material ?? "concrete";
      vfx?.impact(worldHit.point, worldHit.normal, mat);
      if (worldHit.target) {
        damageActor(
          worldHit.target,
          worldHit.point,
          worldHit.normal,
          worldHit.distance,
          damage * falloff(def, worldHit.distance),
          def.headshot,
        );
      } else if (worldHit.piece) {
        // Built pieces take full damage regardless of range — shooting out the
        // wall under a tower is a tactic, not a damage race.
        ctx.services.combat?.applyHit(worldHit, damage, source);
      }
      end = worldHit.distance;
    }

    if (def.tracerEvery > 0 && shotsSinceTracer % def.tracerEvery === 0) {
      muzzleWorld(_v3);
      _v1.copy(origin).addScaledVector(dir, end);
      vfx?.tracer(_v3, _v1, { width: def.id === "sniper" ? 0.05 : 0.03 });
    }
    shotsSinceTracer++;
  }

  /** Spawn a real projectile — sniper rounds and rockets travel and drop. */
  function launchProjectile(origin: THREE.Vector3, dir: THREE.Vector3, def: WeaponDef, damage: number): void {
    const want: Projectile["kind"] = def.ballistic === "rocket" ? "rocket" : "bullet";
    let p = projectiles.find((x) => !x.active && x.kind === want);
    // Recycle the oldest of the right kind rather than dropping the shot: a
    // sniper round that silently never existed is unforgivable.
    if (!p) p = projectiles.find((x) => x.kind === want) ?? projectiles[0];
    p.active = true;
    p.def = def;
    p.damage = damage;
    p.headshot = def.headshot;
    p.source = source;
    muzzleWorld(_v1);
    p.pos.copy(_v1);
    p.prev.copy(_v1);
    p.vel.copy(dir).multiplyScalar(def.projectile?.speed ?? 100);
    // Inherit the shooter's momentum: firing while strafing should lead.
    const pv = ctx.services.player?.velocity;
    if (pv) p.vel.addScaledVector(pv, 0.35);
    p.life = def.explosive?.fuse ?? 4;
    p.trail = 0;
    if (p.mesh) {
      p.mesh.visible = true;
      p.mesh.position.copy(p.pos);
    }
  }

  function detonate(p: Projectile, point: THREE.Vector3): void {
    p.active = false;
    if (p.mesh) p.mesh.visible = false;
    const spec = p.def.explosive;
    if (!spec) return;
    ctx.services.combat?.explode(point, spec.radius, spec.damage, p.source);
    ctx.services.vfx?.explosion(point, 1.6);
    ctx.services.vfx?.smoke(point, 14);
    ctx.services.audio?.play("explosion", { position: point, volume: 1, maxDistance: 400 });

    const player = ctx.services.player;
    if (player) {
      const d = player.position.distanceTo(point);
      const reach = spec.radius * 1.7;
      if (d < reach) {
        const f = 1 - d / reach;
        _v1.copy(player.position).sub(point);
        if (_v1.lengthSq() < 0.01) _v1.set(0, 1, 0);
        _v1.normalize();
        // Rocket riding: shove the player, do not merely hurt them.
        player.velocity.addScaledVector(_v1, f * spec.playerForce);
        player.velocity.y += f * spec.playerForce * 0.45;
        addShake(f * 0.2, f * 0.06);
      }
    }
  }

  function addShake(amount: number, rot: number): void {
    shakeVel.x += (ctx.rng() - 0.5) * amount * 60;
    shakeVel.y += (ctx.rng() - 0.5) * amount * 60;
    shakeVel.z += (ctx.rng() - 0.5) * amount * 40;
    camKick.kick((ctx.rng() - 0.5) * rot * 8, (ctx.rng() - 0.5) * rot * 8, 0);
  }

  /**
   * World-space muzzle. First person reads the viewmodel through the camera
   * matrix; third person reads the object other players can actually see.
   */
  function muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    if (!entry) return out.copy(ctx.camera.position);
    // Firing runs in fixed(), before the renderer refreshes a camera that is
    // not in the scene graph — so ask for the matrix rather than trusting it.
    ctx.camera.updateMatrixWorld();
    if (firstPerson && vmVisible) {
      entry.vm.muzzle.updateWorldMatrix(true, false);
      out.setFromMatrixPosition(entry.vm.muzzle.matrixWorld);
      // Viewmodel space is camera space, so one transform puts it in the world.
      return out.applyMatrix4(ctx.camera.matrixWorld);
    }
    entry.tpMuzzle.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(entry.tpMuzzle.matrixWorld);
  }

  /** Full world matrix of the muzzle, for `vfx.muzzleFlash`. */
  function muzzleMatrix(out: THREE.Matrix4): THREE.Matrix4 {
    ctx.camera.updateMatrixWorld();
    if (!entry) return out.copy(ctx.camera.matrixWorld);
    if (firstPerson && vmVisible) {
      entry.vm.muzzle.updateWorldMatrix(true, false);
      return out.multiplyMatrices(ctx.camera.matrixWorld, entry.vm.muzzle.matrixWorld);
    }
    entry.tpMuzzle.updateWorldMatrix(true, false);
    return out.copy(entry.tpMuzzle.matrixWorld);
  }

  function ejectShell(def: WeaponDef): void {
    if (def.shell === "none") return;
    const pool = def.shell === "hull" ? hullShells : brassShells;
    // Eject point, in world space, from whichever gun is on screen.
    if (firstPerson && vmVisible && entry) {
      entry.vm.eject.updateWorldMatrix(true, false);
      _v1.setFromMatrixPosition(entry.vm.eject.matrixWorld).applyMatrix4(ctx.camera.matrixWorld);
    } else if (entry) {
      entry.tp.updateWorldMatrix(true, false);
      _v1.copy(entry.vm.eject.position).applyMatrix4(entry.tp.matrixWorld);
    } else {
      _v1.copy(ctx.camera.position);
    }
    // Out to the shooter's right, up, with a little forward carry.
    _v2.set(1, 0, 0)
      .applyQuaternion(aimQuat)
      .multiplyScalar(def.shellEjectSpeed * (0.8 + ctx.rng() * 0.5));
    _v2.y += 1.5 + ctx.rng() * 0.9;
    _v3.copy(FORWARD).applyQuaternion(aimQuat).multiplyScalar(0.4);
    _v2.add(_v3);
    const pv = ctx.services.player?.velocity;
    if (pv) _v2.addScaledVector(pv, 0.85);
    pool.spawn(_v1, _v2, ctx.rng);
  }

  // ---- firing ------------------------------------------------------------

  function fireShot(): void {
    if (!entry || !stats) return;
    const def = entry.def;
    const player = ctx.services.player;
    const st = activeItem ? stateFor(activeItem) : null;

    aimBasis();
    if (player) player.eye(_origin);
    else _origin.copy(ctx.camera.position);

    // Cone: base blended by ADS, plus movement, plus bloom. First-shot
    // accuracy means a patient player is rewarded for stopping and aiming.
    const speed = player ? Math.hypot(player.velocity.x, player.velocity.z) : 0;
    const airborne = player?.state === "air";
    // In water mode the cone comes from the water table — a Pump Blaster is a
    // wide cone of spray and a Hydro Lance is a needle, and those numbers live
    // in `mode/water.ts`, not here.
    const base = lerp(
      wstats ? wstats.spread : stats.spread,
      wstats ? wstats.spreadAds : stats.spreadAds,
      adsT,
    );
    const moveCone =
      (wdef ? wdef.spreadMove : def.spreadMove) * clamp01(speed / SPRINT_SPEED) * (0.35 + 0.65 * (1 - adsT)) +
      (airborne ? def.spreadAir : 0);
    const rested = recoilRot.value.lengthSq() < 1e-5 && bloom <= 1e-5;
    const adsFloor = wstats ? wstats.spreadAds : stats.spreadAds;
    const cone = def.firstShot && rested && adsT > 0.85 ? adsFloor : base + moveCone + bloom;
    const pellets = wdef ? wdef.pellets : def.pellets;

    if (wdef && wstats) {
      // STREAMS, not bullets. Every droplet is a real body with real gravity,
      // swept against the world in `stepWater`; nothing here is hitscan.
      const kind: WaterKind = wdef.stream === "strand" ? "glue" : "stream";
      for (let p = 0; p < pellets; p++) {
        _dir.copy(FORWARD).applyQuaternion(aimQuat);
        // The middle of a spray cone stays honest, exactly as for buckshot.
        coneJitter(_dir, p === 0 && pellets > 1 ? cone * 0.2 : cone);
        spawnStream(_dir, wdef, wstats, kind);
      }
      // The Firehose pushes YOU as well. It is a free movement tech the moment
      // anyone works it out, and that is the good kind of emergent.
      if (wdef.selfPush > 0 && player) {
        _w1.copy(FORWARD).applyQuaternion(aimQuat).negate();
        player.velocity.addScaledVector(_w1, wdef.selfPush);
      }
      netSend("shot", {
        w: wdef.id,
        x: _origin.x,
        y: _origin.y,
        z: _origin.z,
        dx: _dir.x,
        dy: _dir.y,
        dz: _dir.z,
      });
    } else if (def.ballistic === "hitscan") {
      for (let p = 0; p < def.pellets; p++) {
        _dir.copy(FORWARD).applyQuaternion(aimQuat);
        // The first pellet of a shotgun goes down the middle: a spread that
        // can miss at point-blank reads as a broken gun, not as randomness.
        coneJitter(_dir, p === 0 && def.pellets > 1 ? cone * 0.2 : cone);
        hitscan(_origin, _dir, def, stats.damage);
      }
    } else {
      _dir.copy(FORWARD).applyQuaternion(aimQuat);
      coneJitter(_dir, cone);
      launchProjectile(_origin, _dir, def, stats.damage);
    }

    // ---- reaction --------------------------------------------------------
    const r = def.recoil;
    const idx = st ? st.shotIndex : 0;
    const pat = r.pattern[idx % r.pattern.length];
    if (st) st.shotIndex++;
    const jY = 1 + (ctx.rng() - 0.5) * r.jitter;
    const jX = 1 + (ctx.rng() - 0.5) * r.jitter * 0.5;
    // Aiming plants the gun: less kick, and a tighter pattern to learn.
    const adsDamp = 1 - adsT * 0.35;

    // Peak displacement → spring impulse. For a lightly damped oscillator the
    // first peak is v0/ω, so v0 = peak · ω. Retuning stiffness therefore never
    // silently changes how far the gun kicks.
    const wPos = Math.sqrt(r.stiffness);
    const wRot = Math.sqrt(r.stiffness * 1.15);
    const wCam = Math.sqrt(r.stiffness * 0.5);

    recoilPos.kick(
      (ctx.rng() - 0.5) * r.back * 0.4 * wPos,
      r.back * 0.25 * wPos,
      r.back * wPos * adsDamp,
    );
    recoilRot.kick(
      r.vmPitch * wRot * pat[1] * adsDamp,
      r.vmYaw * wRot * pat[0] * jY * adsDamp,
      r.vmRoll * wRot * pat[0] * jX * adsDamp,
    );
    camKick.kick(
      r.camPitch * wCam * pat[1] * jX * adsDamp,
      r.camYaw * wCam * pat[0] * jY * adsDamp,
      0,
    );
    addShake(r.shake * adsDamp, r.shake * 0.4);

    bloom = Math.min(def.bloomMax, bloom + def.bloom);
    flashTime = 0.055;

    if (wdef) {
      // No muzzle flare on a water gun — a nozzle glow in the stream's own
      // colour, which is the light a jet of water actually throws.
      flashLight.color.setHex(wdef.mistColor);
      flashLight.intensity = 3.2 * wdef.nozzleGlow;
    } else {
      flashLight.color.setHex(0xffb257);
      flashLight.intensity = 7 * def.flashScale;
      // World-space flash, so the shot is visible from outside the shooter's
      // head — muzzle flare through a window is how you spot a camper.
      ctx.services.vfx?.muzzleFlash(muzzleMatrix(_mat4b), def.flashScale);
    }

    if (def.slideTravel > 0 && def.mode !== "pump") {
      slidePhase = 1;
      slideTimer = def.slideTime;
    }
    // A soaker has no brass. The pump action still cycles, because that is the
    // gun's whole character and a water pump blaster genuinely has one.
    if (!wdef) ejectShell(def);

    ctx.services.audio?.play(wdef ? wdef.sound : def.sound, {
      volume: def.soundVolume,
      rate: 0.96 + ctx.rng() * 0.08,
      position: _origin,
      maxDistance: 500,
    });

    // The player controller listens for this and adds its own camera dip; it
    // only wants a magnitude, so give it one it can scale.
    ctx.emit("dz:shot", { weapon: wdef ? wdef.id : def.id, recoil: r.camPitch * 40 });

    setAmmo(ammoOf() - (wdef ? wdef.costPerShot : 1));
    // Running dry mid-fight is the point; start pumping on its own so the
    // player is never left holding an empty gun waiting to be told about it.
    if (wdef && ammoOf() <= 0) autoRefill = true;
    if (def.mode === "pump" && ammoOf() > 0) {
      slidePhase = 1;
      slideTimer = def.slideTime;
    }
  }

  // ---- reloading ---------------------------------------------------------

  function beginReload(): void {
    if (!entry || !stats || !activeItem) return;
    // A soaker is never reloaded, it is pumped. `refillControl` owns the whole
    // state machine; R just asks for it and the mag machinery stays untouched.
    if (isWater) {
      if (wstats && ammoOf() < wstats.tank) autoRefill = true;
      return;
    }
    if (reloadT > 0 || swapT > 0) return;
    const def = entry.def;
    if (ammoOf() >= stats.magSize) return;
    if ((reserve[def.ammoType] ?? 0) <= 0) return;

    shellMode = def.shellReload > 0;
    reloadTotal = shellMode ? stats.shellReload : stats.reload;
    reloadT = reloadTotal;
    burstLeft = 0;
    ctx.services.audio?.play(shellMode ? "shell-drop" : "mag-out", { volume: 0.5 });
    hudDirty = true;
  }

  function finishReload(): void {
    if (!entry || !stats || !activeItem) {
      reloadT = 0;
      return;
    }
    const def = entry.def;
    const want = shellMode ? 1 : stats.magSize - ammoOf();
    const take = Math.min(want, reserve[def.ammoType] ?? 0);
    setAmmo(ammoOf() + take);
    reserve[def.ammoType] = (reserve[def.ammoType] ?? 0) - take;
    const st = activeItem ? stateFor(activeItem) : null;
    if (st) st.shotIndex = 0;

    if (shellMode && ammoOf() < stats.magSize && (reserve[def.ammoType] ?? 0) > 0) {
      // Keep feeding shells one at a time until full or empty — and let the
      // player cancel out of it by firing, which is the whole point of a
      // shell-by-shell reload.
      reloadT = reloadTotal;
      ctx.services.audio?.play("shell-drop", { volume: 0.42, rate: 0.9 + ctx.rng() * 0.2 });
    } else {
      reloadT = 0;
      shellMode = false;
      slidePhase = 0;
      ctx.services.audio?.play("bolt-forward", { volume: 0.45 });
    }
    hudDirty = true;
  }

  // ---- fire control ------------------------------------------------------

  /**
   * Everything that decides whether a round leaves the barrel lives here and
   * runs in `fixed()`, so the rate of fire is exactly `rpm` whether the frame
   * rate is 144 or 24 — a shooter whose DPS depends on your monitor is a
   * shooter nobody can balance.
   */
  function fireControl(dt: number): void {
    cooldown = Math.max(0, cooldown - dt);
    burstTimer = Math.max(0, burstTimer - dt);
    dryClick = Math.max(0, dryClick - dt);

    const input = ctx.input;
    const player = ctx.services.player;
    // Balloons are their own control path: no gun entry, no tank, one verb.
    if (isWater && balloonItem) {
      throwControl(dt);
      lastFireHeld = false;
      firing = false;
      return;
    }

    const away = stowed() || !entry || !stats;
    const controllable = player ? player.controllable : input.locked;

    if (away || !controllable) {
      lastFireHeld = false;
      firing = false;
      burstLeft = 0;
      spin = approach(spin, 0, 3, dt);
      if (isWater) {
        refilling = false;
        refillT = 0;
        atSource = false;
      }
      return;
    }

    // The tank fills in `fixed` so a pump takes the same simulated time on
    // every machine — a refill rate that depends on the frame rate is a refill
    // rate nobody can balance.
    if (isWater) refillControl(dt);

    const def = entry!.def;
    const held = input.fire && reloadT <= 0 && swapT <= 0 && sprintT < 0.55;
    const edge = held && !lastFireHeld;
    // Track the *gated* trigger, not the raw button. A player who holds fire
    // through a weapon swap or a reload — which is everyone, always — would
    // otherwise come out the far side with the trigger already "down" and no
    // rising edge, and every semi-auto weapon in the game would refuse to
    // fire until they let go and clicked again.
    lastFireHeld = held;

    // Reload is edge-triggered off a level flag: the key stays down for
    // several fixed steps and we only want one reload out of it.
    if (input.reload && !lastReloadHeld) beginReload();
    lastReloadHeld = input.reload;

    // Firing cancels a shell-by-shell reload the moment there is a round up
    // the spout. That cancel is the entire skill expression of a pump.
    if (shellMode && reloadT > 0 && input.fire && ammoOf() > 0) {
      reloadT = 0;
      shellMode = false;
      ctx.services.audio?.play("pump-action", { volume: 0.5 });
    }

    // Minigun spool. It spins on the trigger and only fires at full speed,
    // which is the whole character of the weapon.
    if (def.mode === "spin") {
      const wantSpin = input.fire && ammoOf() > 0 && reloadT <= 0 && swapT <= 0;
      const rate = wantSpin ? 1 / Math.max(0.05, def.spinUp ?? 0.7) : -1 / Math.max(0.05, def.spinDown ?? 1.1);
      const before = spin;
      spin = clamp01(spin + rate * dt);
      if (before < 0.02 && spin >= 0.02) ctx.services.audio?.play("spin-up", { volume: 0.5 });
      if (before > 0.02 && spin <= 0.02) ctx.services.audio?.play("spin-down", { volume: 0.42 });
      heat = clamp01(heat + (spin > 0.9 && wantSpin ? dt * 0.6 : -dt * 0.35));
    } else {
      spin = approach(spin, 0, 4, dt);
      heat = approach(heat, 0, 1.2, dt);
    }

    const ammo = ammoOf();
    firing = held && ammo > 0;

    // Burst: once committed, the burst finishes whether or not the trigger is
    // still down. That commitment is what makes a burst rifle a burst rifle.
    if (def.mode === "burst") {
      if (burstLeft > 0 && cooldown <= 0 && reloadT <= 0 && swapT <= 0) {
        if (ammo > 0) {
          fireShot();
          burstLeft--;
          cooldown = stats!.interval;
          if (burstLeft <= 0) cooldown = Math.max(cooldown, def.burstDelay);
        } else {
          burstLeft = 0;
        }
      } else if (held && cooldown <= 0 && burstTimer <= 0) {
        // Held, not edge-triggered: the burst rifle repeats on a held trigger
        // at exactly `burstDelay`, which is the cadence the weapon is balanced
        // around. Requiring a click per burst just adds finger noise.
        if (ammo > 0) burstLeft = def.burst;
        else if (edge) dryFire();
      }
      if (ammoOf() <= 0 && burstLeft <= 0 && reloadT <= 0) beginReload();
      return;
    }

    let wantsShot = false;
    if (held && ammo > 0 && cooldown <= 0) {
      switch (def.mode) {
        case "auto":
          wantsShot = true;
          break;
        case "semi":
        case "pump":
          wantsShot = edge;
          break;
        case "spin":
          wantsShot = spin >= 0.995;
          break;
      }
    }

    if (wantsShot) {
      fireShot();
      cooldown =
        def.mode === "pump" ? Math.max(stats!.interval, def.slideTime + 0.05) : stats!.interval;
      if (ammoOf() <= 0) beginReload();
    } else if (edge && ammo <= 0 && reloadT <= 0 && def.mode !== "spin") {
      dryFire();
    }
  }

  function dryFire(): void {
    if (dryClick > 0) return;
    dryClick = 0.28;
    // An empty soaker sputters and dribbles; it does not click.
    ctx.services.audio?.play(isWater ? "tank-dry" : "dry-fire", { volume: 0.42 });
    if (isWater && wdef) {
      muzzleWorld(_w1);
      spawnDroplets(_w1, UP, 3, wdef.mistColor, 1.2, 0.035);
    }
    recoilPos.kick(0, 0, 2.5);
    beginReload();
  }

  // ---- projectiles -------------------------------------------------------

  /**
   * Sniper rounds and rockets, stepped at the fixed rate. Substeps are not
   * needed at 120 Hz — a 460 m/s round covers 3.8 m a step and the collision
   * raycast is swept over exactly that segment, so nothing tunnels.
   */
  function stepProjectiles(dt: number): void {
    const collision = ctx.services.collision;
    const terrain = ctx.services.terrain;
    const player = ctx.services.player;

    for (const p of projectiles) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        if (p.def.explosive) detonate(p, p.pos);
        else {
          p.active = false;
          if (p.mesh) p.mesh.visible = false;
        }
        continue;
      }

      const spec = p.def.projectile;
      if (spec) {
        p.vel.multiplyScalar(Math.max(0, 1 - spec.drag * dt));
        p.vel.y += spec.gravity * dt;
      }

      const speed = p.vel.length();
      const step = speed * dt;
      if (step < 1e-5) continue;
      _dir.copy(p.vel).divideScalar(speed);
      p.prev.copy(p.pos);

      // Actors first: a rocket should detonate on the thing you aimed at, and
      // a bullet should not pass through a player to hit the wall behind them.
      const margin = p.kind === "rocket" ? 0.6 : 0.15;
      const actorDist = sweepActors(p.pos, _dir, step + margin);
      if (actorDist >= 0 && sweepTarget) {
        _v1.copy(p.pos).addScaledVector(_dir, actorDist);
        if (p.def.explosive) {
          detonate(p, _v1);
        } else {
          _v2.copy(_dir).negate();
          damageActor(sweepTarget, _v1, _v2, actorDist, p.damage, p.headshot);
          p.active = false;
          if (p.mesh) p.mesh.visible = false;
        }
        continue;
      }

      let hit: RayHit | null = null;
      try {
        hit = collision?.raycast(p.pos, _dir, step + margin) ?? null;
      } catch {
        hit = null;
      }
      if (hit) {
        if (p.def.explosive) {
          _v1.copy(hit.point).addScaledVector(hit.normal, 0.15);
          detonate(p, _v1);
        } else {
          ctx.services.vfx?.impact(hit.point, hit.normal, hit.material ?? "concrete");
          if (hit.piece) ctx.services.combat?.applyHit(hit, p.damage, p.source);
          else if (hit.target) damageActor(hit.target, hit.point, hit.normal, hit.distance, p.damage, p.headshot);
          p.active = false;
          if (p.mesh) p.mesh.visible = false;
        }
        continue;
      }

      p.pos.addScaledVector(p.vel, dt);

      if (terrain && p.pos.y <= terrain.heightAt(p.pos.x, p.pos.z)) {
        p.pos.y = terrain.heightAt(p.pos.x, p.pos.z);
        if (p.def.explosive) {
          detonate(p, p.pos);
        } else {
          terrain.normalAt(p.pos.x, p.pos.z, _v2);
          ctx.services.vfx?.impact(p.pos, _v2, terrain.materialAt(p.pos.x, p.pos.z));
          p.active = false;
          if (p.mesh) p.mesh.visible = false;
        }
        continue;
      }

      // Supersonic crack as a round goes past your head. Cheap, and it is the
      // only warning a sniped player ever gets.
      if (player && p.kind === "bullet") {
        const d = p.pos.distanceTo(player.position);
        if (d < 6 && p.prev.distanceTo(player.position) > d) {
          ctx.services.audio?.play("whizz", { position: p.pos, volume: clamp01(1 - d / 6) * 0.5 });
        }
      }

      if (!p.mesh) continue;
      p.mesh.position.copy(p.pos);
      if (p.kind === "rocket") {
        _v1.copy(p.pos).add(p.vel);
        p.mesh.lookAt(_v1);
        // Geometry points down -Z, which `lookAt` already faces; no flip.
        p.trail += dt;
        const trailStep = quality === "low" ? 0.1 : 0.04;
        if (p.trail >= trailStep) {
          p.trail = 0;
          ctx.services.vfx?.smoke(p.pos, 1);
        }
      } else {
        _v1.copy(p.pos).addScaledVector(p.vel, 0.02);
        p.mesh.lookAt(_v1);
        // Stretch the streak to roughly one frame of travel so the round reads
        // as a tracer rather than as a bead.
        p.mesh.scale.set(1, 1, clamp(speed * 0.02, 0.6, 6));
      }
    }
  }

  // ---- water --------------------------------------------------------------
  //
  // Nothing below runs in `classic`: every entry point is guarded by `isWater`
  // and every pool it touches is empty there.

  /**
   * Mirror of `HEADSHOT_MULT_DEFAULT` in `fx/combat.ts`.
   *
   * Combat owns the face multiplier and looks it up by `source.weapon`; water
   * ids are not in its table, so a faceful gets combat's default. The water
   * arsenal deliberately runs much gentler multipliers than the gun table does
   * (a faceful is funny, not fatal — see `WaterWeaponDef.faceful`), so we
   * pre-divide by combat's default and multiply by ours. If combat retunes its
   * default this constant has to follow, exactly the way combat's own
   * `HEADSHOT_MULT` table has to follow `WeaponDef.headshot`.
   */
  const COMBAT_HEAD_DEFAULT = 1.75;

  /** Fire-and-forget net event. Offline, absent and throwing all mean "solo". */
  function netSend(kind: "shot" | "splash" | "balloon" | "glue" | "soaked", payload: unknown): void {
    try {
      ctx.services.net?.send(kind, payload);
    } catch {
      /* a dead socket must never break the game */
    }
  }

  /** Which entry (i.e. which mesh and which ballistics) a def id resolves to. */
  function entryIdFor(defId: string): string {
    if (!isWater) return defId;
    return waterDefFor(defId)?.archetype ?? defId;
  }

  /**
   * Throw droplets off an impact. Cosmetic, but the whole art direction lives
   * here: water reads because the spray leaves the surface in a hemisphere
   * around the normal, catches the sun, and then FALLS. Droplets that fade in
   * place look like a particle system; droplets that arc look like water.
   */
  function spawnDroplets(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    count: number,
    color: number,
    speed: number,
    size: number,
  ): void {
    if (!dropMesh || count <= 0) return;
    let made = 0;
    for (const d of droplets) {
      if (made >= count) break;
      if (d.active) continue;
      d.active = true;
      d.pos.copy(point);
      _w4.set(ctx.rng() * 2 - 1, ctx.rng() * 2 - 1, ctx.rng() * 2 - 1);
      if (_w4.lengthSq() < 1e-6) _w4.set(0, 1, 0);
      _w4.normalize();
      if (_w4.dot(normal) < 0) _w4.negate();
      // Bias toward the surface normal so spray comes off a wall rather than
      // through it, but keep enough scatter that no two splashes look alike.
      _w4.lerp(normal, 0.35).normalize();
      d.vel.copy(_w4).multiplyScalar(speed * (0.35 + ctx.rng() * 0.95));
      d.vel.y += speed * 0.3;
      d.maxLife = DROP_LIFE * (0.55 + ctx.rng() * 0.8);
      d.life = d.maxLife;
      d.size = size * (0.45 + ctx.rng() * 0.95);
      d.color = color;
      made++;
    }
  }

  /**
   * Water landed here. One call does all four things a splash owes the world:
   * it wets the ground so puddles form where the fight happened, it throws
   * droplets, it asks vfx for an impact, and it tells the other players.
   */
  function splashAt(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    radius: number,
    amount: number,
    color: number,
    drops: number,
    dropSpeed: number,
    dropSize: number,
    broadcast: number,
  ): void {
    // The wetness system may not have booted, and is inert in classic anyway.
    ctx.services.wetness?.splash(point, radius, amount);
    spawnDroplets(point, normal, drops, color, dropSpeed, dropSize);
    // A firehose lands 23 impacts a second; asking vfx for a full impact on
    // every one of them would cost more than the water does. Big splashes
    // always get one, stream ticks get one in three.
    if (drops >= BURST_DROPS >> 1 || ctx.rng() < 0.34) {
      ctx.services.vfx?.impact(point, normal, "water");
    }
    if (broadcast > 0) {
      netSend("splash", { x: point.x, y: point.y, z: point.z, strength: broadcast });
    }
    ctx.emit("dz:splash", {
      x: point.x,
      y: point.y,
      z: point.z,
      radius,
      amount,
      color,
    });
  }

  function freeShot(): WaterShot | null {
    for (const s of waterShots) if (!s.active) return s;
    // Recycle the oldest rather than dropping the shot — a trigger pull that
    // silently produced no water is the worst bug this system could have.
    const s = waterShots[0];
    return s ?? null;
  }

  function retire(s: WaterShot): void {
    s.active = false;
    s.resting = false;
  }

  /**
   * One body of water leaves the nozzle. `dir` is already coned; the slug
   * inherits a slice of the shooter's own velocity so strafing leads properly.
   */
  function spawnStream(
    dir: THREE.Vector3,
    wd: WaterWeaponDef,
    ws: WaterStats,
    kind: WaterKind,
  ): void {
    const s = freeShot();
    if (!s) return;
    s.active = true;
    s.kind = kind;
    muzzleWorld(_w1);
    s.pos.copy(_w1);
    s.prev.copy(_w1);
    s.vel.copy(dir).multiplyScalar(wd.speed);
    const pv = ctx.services.player?.velocity;
    if (pv) s.vel.addScaledVector(pv, 0.3);
    s.gravity = wd.arc;
    s.drag = 0;
    s.life = Math.min(WATER_MAX_LIFE, wd.range / Math.max(1, wd.speed) + 0.6);
    s.travelled = 0;
    s.soak = ws.soak;
    s.faceful = ws.faceful;
    s.knockback = wd.knockback;
    s.splashRadius = kind === "glue" ? 0.9 : 0.55 + wd.knockback * 0.12;
    s.splashAmount = kind === "glue" ? 0.2 : 0.28 + wd.soak * 0.006;
    // A thin fast jet is a needle; a wide slow spray is a fat gobbet.
    s.size = kind === "glue" ? 0.16 : clamp(0.055 + wd.soak * 0.0016, 0.05, 0.17);
    s.color = wd.streamColor;
    s.wobble = ctx.rng() * Math.PI * 2;
    s.def = wd;
    s.source = source;
    s.resting = false;
    s.bounces = 0;
  }

  /** A thrown water balloon. Its own gravity, its own drag, its own wobble. */
  function spawnBalloon(origin: THREE.Vector3, dir: THREE.Vector3): void {
    const s = freeShot();
    if (!s) return;
    const b = WATER.balloon;
    s.active = true;
    s.kind = "balloon";
    s.pos.copy(origin);
    s.prev.copy(origin);
    s.vel.copy(dir).multiplyScalar(b.speed);
    // `lift` is a fraction of the launch speed added upward — that is the lob,
    // and it is why you can put one over your own wall.
    s.vel.y += b.speed * b.lift;
    const pv = ctx.services.player?.velocity;
    if (pv) s.vel.addScaledVector(pv, 0.5);
    s.gravity = b.gravity;
    s.drag = b.drag;
    s.life = b.fuse;
    s.travelled = 0;
    s.soak = b.soak;
    s.faceful = 1;
    s.knockback = b.knockback;
    s.splashRadius = b.radius * 0.55;
    s.splashAmount = 9;
    s.size = 0.3;
    s.color = b.colors[Math.floor(ctx.rng() * b.colors.length) % b.colors.length];
    s.wobble = ctx.rng() * Math.PI * 2;
    s.def = null;
    s.source = source;
    s.resting = false;
    s.bounces = 0;
  }

  /** Route soak into an actor and tell everyone about it. */
  function soakActor(
    s: WaterShot,
    target: DamageTarget,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    dist: number,
    amount: number,
  ): void {
    if (amount <= 0) return;
    damageActor(target, point, normal, dist, amount, s.faceful, "water");
    // Knockback belongs to whoever owns the actor's movement — we only say how
    // hard it was pushed and in which direction. The Firehose is a shove, and
    // shoving someone off their ramp tower is the funniest thing in the mode.
    if (s.knockback > 0) {
      _wpush.copy(normal).negate();
      ctx.emit("dz:soak", {
        id: target.id,
        amount,
        x: point.x,
        y: point.y,
        z: point.z,
        px: _wpush.x * s.knockback,
        py: Math.abs(_wpush.y) * s.knockback * 0.3 + s.knockback * 0.12,
        pz: _wpush.z * s.knockback,
        weapon: s.def?.id ?? WATER.balloon.id,
      });
    }
    splashAt(
      point,
      normal,
      s.splashRadius,
      s.splashAmount,
      s.def?.mistColor ?? WATER.balloon.splashColor,
      s.kind === "balloon" ? BURST_DROPS : SPLASH_DROPS,
      s.kind === "balloon" ? 5.5 : 3.2,
      0.05,
      clamp(amount / 40, 0.25, 3),
    );
  }

  /**
   * A water balloon lets go. Not `combat.explode` — that spawns a fireball, a
   * smoke plume and a scorch mark, none of which belong at a block party. The
   * area query is the same shape; the payload is water.
   */
  function burstBalloon(s: WaterShot, point: THREE.Vector3, normal: THREE.Vector3): void {
    const b = WATER.balloon;
    const combat = ctx.services.combat;

    if (combat) {
      let list: DamageTarget[] = [];
      try {
        list = combat.queryTargets(point, b.radius) ?? [];
      } catch {
        list = [];
      }
      for (const t of list) {
        if (!t.alive) continue;
        t.object.getWorldPosition(_wb1);
        // Measure to the middle of the capsule, not its feet: a burst at head
        // height over someone standing on a roof should still count.
        _wb1.y += t.height * 0.5;
        const d = _wb1.distanceTo(point);
        const soak = balloonSoakAt(d, b);
        if (soak <= 0) continue;
        _wb2.copy(_wb1).sub(point);
        if (_wb2.lengthSq() < 1e-6) _wb2.set(0, 1, 0);
        _wb2.normalize();
        soakActor(s, t, _wb1, _wb2, d, soak);
      }
    }

    // Structures: a balloon is water, so it soaks a wall rather than blowing a
    // hole in it — but a tarp shed absolutely gets rinsed off its frame.
    const build = ctx.services.build;
    if (build && combat) {
      let pieces: BuildPiece[] = [];
      try {
        pieces = build.queryPieces(point, b.radius) ?? [];
      } catch {
        pieces = [];
      }
      for (const piece of pieces) {
        piece.box.getCenter(_wb1);
        const soak = balloonSoakAt(_wb1.distanceTo(point), b);
        if (soak <= 0) continue;
        _waterHit.point.copy(_wb1);
        _waterHit.normal.copy(normal);
        _waterHit.distance = 0;
        _waterHit.piece = piece;
        _waterHit.target = undefined;
        _waterHit.tag = "water";
        try {
          combat.applyHit(_waterHit, soak, s.source);
        } catch {
          /* a piece that vanished mid-burst is not our problem */
        }
      }
      _waterHit.piece = undefined;
    }

    // Shove the local player — the one actor we can push directly. Riding your
    // own balloon is a movement tech and it should be discovered, not taught.
    const player = ctx.services.player;
    if (player) {
      const d = player.position.distanceTo(point);
      if (d < b.radius) {
        const f = 1 - d / b.radius;
        _wb1.copy(player.position).sub(point);
        if (_wb1.lengthSq() < 0.01) _wb1.set(0, 1, 0);
        _wb1.normalize();
        player.velocity.addScaledVector(_wb1, f * b.knockback);
        player.velocity.y += f * b.knockback * 0.4;
      }
    }

    splashAt(
      point,
      normal,
      b.radius * 0.5,
      9,
      b.splashColor,
      BURST_DROPS,
      6.5,
      0.07,
      b.radius / 3.2,
    );
    ctx.services.audio?.play(b.soundBurst, { position: point, volume: 0.9, maxDistance: 260 });
    netSend("balloon", { x: point.x, y: point.y, z: point.z, burst: true });
    retire(s);
  }

  /** A glue blob found something. Link it and let the player system feel it. */
  function stickGlue(s: WaterShot, point: THREE.Vector3, target: DamageTarget | null): void {
    const g = WATER.glue;

    // The glue gun barely soaks and must never become a damage weapon — its
    // whole value is the strand. This is the token splat, nothing more.
    if (target && s.soak > 0) {
      // Splat normal: straight back down the blob's own flight path.
      _wb2.copy(s.vel);
      if (_wb2.lengthSq() < 1e-6) _wb2.set(0, 1, 0);
      _wb2.normalize().negate();
      damageActor(target, point, _wb2, s.travelled, s.soak, s.faceful, "water");
      splashAt(point, _wb2, 0.7, 0.4, g.glowColor, 6, 2.4, 0.05, 0.3);
    }

    // Past `maxStrands` the shortest-lived one gives way. A player wrapped in
    // six ropes is not stuck, they are deleted, and this mode never removes
    // control — it only makes moving expensive.
    let live = 0;
    let shortest: Strand | null = null;
    let strand: Strand | null = null;
    for (const st of strands) {
      if (!st.active) {
        if (!strand) strand = st;
        continue;
      }
      live++;
      if (!shortest || st.life < shortest.life) shortest = st;
    }
    if (live >= g.maxStrands && shortest) {
      breakStrand(shortest, "expired");
      strand = shortest;
    }
    if (!strand) return;

    strand.active = true;
    strand.aTarget = null;
    strand.aIsPlayer = true;
    strand.bTarget = target;
    strand.bPoint.copy(point);
    strand.life = g.duration;
    strand.over = 0;
    strand.toId = target?.id ?? "world";

    const netId = ctx.services.net?.selfId ?? "player";
    netSend("glue", {
      from: netId,
      to: target?.id,
      x: point.x,
      y: point.y,
      z: point.z,
      duration: g.duration,
    });
    // The movement coupling — the pull, the slow, the stumble — is the player
    // system's. Everything it needs is in `WATER.glue`; this is the trigger.
    ctx.emit("dz:glue", {
      from: netId,
      to: target?.id ?? null,
      anchor: target ? "player" : "ground",
      x: point.x,
      y: point.y,
      z: point.z,
      duration: g.duration,
    });
    ctx.services.audio?.play(g.soundStick, { position: point, volume: 0.7, maxDistance: 120 });
    retire(s);
  }

  function breakStrand(strand: Strand, reason: string): void {
    if (!strand.active) return;
    strand.active = false;
    const netId = ctx.services.net?.selfId ?? "player";
    netSend("glue", { from: netId, to: strand.toId, broken: true });
    ctx.emit("dz:glue-break", { from: netId, to: strand.toId, reason });
    ctx.services.audio?.play(WATER.glue.soundSnap, { volume: 0.55 });
  }

  /** Resolve one end of a strand into `out`. False when it no longer exists. */
  function strandEnd(strand: Strand, far: boolean, out: THREE.Vector3): boolean {
    if (!far && strand.aIsPlayer) {
      const player = ctx.services.player;
      if (!player) return false;
      // Chest height, not the feet: a rope out of somebody's ankles reads as
      // a bug rather than as glue.
      out.set(player.position.x, player.position.y + 1.15, player.position.z);
      return true;
    }
    const t = far ? strand.bTarget : strand.aTarget;
    if (t) {
      if (!t.alive) return false;
      t.object.getWorldPosition(out);
      out.y += t.height * 0.55;
      return true;
    }
    out.copy(far ? strand.bPoint : strand.aPoint);
    return true;
  }

  /**
   * Strand bookkeeping, in `fixed` because the stretch test is simulation:
   * whether a strand snaps decides whether a player is still tethered, and
   * that must not depend on the frame rate.
   */
  function stepStrands(dt: number): void {
    const g = WATER.glue;
    for (const strand of strands) {
      if (!strand.active) continue;
      strand.life -= dt;
      if (strand.life <= 0) {
        breakStrand(strand, "expired");
        continue;
      }
      if (!strandEnd(strand, false, _w1) || !strandEnd(strand, true, _w2)) {
        breakStrand(strand, "eliminated");
        continue;
      }
      const d = _w1.distanceTo(_w2);
      if (d > g.maxLength) {
        strand.over += dt;
        if (strand.over >= g.snapHold) breakStrand(strand, "stretched");
      } else {
        strand.over = 0;
      }
    }
  }

  /** What a shot does when it reaches something solid. */
  function impactWater(
    s: WaterShot,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    piece: BuildPiece | null,
  ): void {
    if (s.kind === "balloon") {
      if (!WATER.balloon.burstOnImpact && s.bounces < 3) {
        // Bounce. Only reachable if the table says balloons survive contact —
        // the physics is here so that flag is a real switch and not a lie.
        const b = WATER.balloon;
        s.pos.copy(point).addScaledVector(normal, 0.12);
        const vn = s.vel.dot(normal);
        s.vel.addScaledVector(normal, -vn * (1 + b.restitution));
        s.vel.multiplyScalar(b.friction);
        s.bounces++;
        if (s.vel.lengthSq() < 0.5) s.resting = true;
        return;
      }
      burstBalloon(s, point, normal);
      return;
    }

    if (s.kind === "glue") {
      stickGlue(s, point, null);
      return;
    }

    // A stream slug. Soak the piece it hit, wet the surface, and burst.
    const soak = s.def ? soakAtRange(s.def, s.soak, s.travelled) : s.soak;
    if (piece && soak > 0) {
      _waterHit.point.copy(point);
      _waterHit.normal.copy(normal);
      _waterHit.distance = s.travelled;
      _waterHit.piece = piece;
      _waterHit.target = undefined;
      _waterHit.tag = "water";
      try {
        ctx.services.combat?.applyHit(_waterHit, soak, s.source);
      } catch {
        /* ignore */
      }
      _waterHit.piece = undefined;
    }
    splashAt(
      point,
      normal,
      s.splashRadius,
      s.splashAmount,
      s.def?.mistColor ?? 0xdff4ff,
      SPLASH_DROPS,
      3.0,
      0.045,
      0,
    );
    retire(s);
  }

  /**
   * Every water body in flight, one fixed step. Same sweep order rockets use:
   * actors first (a stream should soak the person, not the wall behind them),
   * then world collision, then the terrain.
   */
  function stepWater(dt: number): void {
    if (!isWater) return;
    const collision = ctx.services.collision;
    const terrain = ctx.services.terrain;

    for (const s of waterShots) {
      if (!s.active) continue;
      s.life -= dt;
      if (s.life <= 0) {
        // A balloon's fuse is a real timer: it pops in the air, or where it
        // came to rest under somebody's ramp.
        if (s.kind === "balloon") burstBalloon(s, s.pos, UP);
        else retire(s);
        continue;
      }
      if (s.resting) continue;

      if (s.drag > 0) s.vel.multiplyScalar(Math.max(0, 1 - s.drag * dt));
      s.vel.y -= s.gravity * dt;

      const speed = s.vel.length();
      const step = speed * dt;
      if (step < 1e-5) continue;
      _w1.copy(s.vel).divideScalar(speed);
      s.prev.copy(s.pos);

      const margin = s.kind === "stream" ? 0.12 : 0.32;
      const actorDist = sweepActors(s.pos, _w1, step + margin);
      if (actorDist >= 0 && sweepTarget) {
        _w2.copy(s.pos).addScaledVector(_w1, actorDist);
        _w3.copy(_w1).negate();
        if (s.kind === "balloon") {
          burstBalloon(s, _w2, _w3);
        } else if (s.kind === "glue") {
          stickGlue(s, _w2, sweepTarget);
        } else {
          const soak = s.def ? soakAtRange(s.def, s.soak, s.travelled + actorDist) : s.soak;
          soakActor(s, sweepTarget, _w2, _w3, s.travelled + actorDist, soak);
          retire(s);
        }
        continue;
      }

      let hit: RayHit | null = null;
      try {
        hit = collision?.raycast(s.pos, _w1, step + margin) ?? null;
      } catch {
        hit = null;
      }
      if (hit) {
        _w2.copy(hit.point);
        _w3.copy(hit.normal);
        if (_w3.lengthSq() < 1e-6) _w3.copy(UP);
        s.travelled += hit.distance;
        impactWater(s, _w2, _w3, hit.piece ?? null);
        continue;
      }

      s.pos.addScaledVector(s.vel, dt);
      s.travelled += step;

      if (terrain) {
        // The sea first: `heightAt` returns the SEABED, so a jet fired out over
        // the water would otherwise carry on happily two metres under it.
        if (s.pos.y <= terrain.seaLevel && terrain.isWater(s.pos.x, s.pos.z)) {
          s.pos.y = terrain.seaLevel;
          impactWater(s, s.pos, UP, null);
          continue;
        }
        const gy = terrain.heightAt(s.pos.x, s.pos.z);
        if (s.pos.y <= gy) {
          s.pos.y = gy;
          terrain.normalAt(s.pos.x, s.pos.z, _w3);
          if (_w3.lengthSq() < 1e-6) _w3.copy(UP);
          impactWater(s, s.pos, _w3, null);
          continue;
        }
      }

      // Past its own effective reach the stream has fallen apart. Fizzle it
      // rather than letting a spent jet soak someone at 400 m.
      if (s.def && s.travelled > s.def.range) {
        splashAt(s.pos, UP, 0.3, 0.1, s.def.mistColor, 3, 1.4, 0.03, 0);
        retire(s);
      }
    }
  }

  /**
   * Droplets and instance buffers. Cosmetics, so `update` — a droplet is a
   * decoration and nothing in the game reads its position.
   */
  function renderWater(dt: number): void {
    if (!isWater) return;

    if (dropMesh) {
      let n = 0;
      const cap = droplets.length;
      for (const d of droplets) {
        if (!d.active) continue;
        d.life -= dt;
        if (d.life <= 0) {
          d.active = false;
          continue;
        }
        // Real gravity, light drag. Water that hangs looks like dust.
        d.vel.y -= 21 * dt;
        d.vel.multiplyScalar(Math.max(0, 1 - 0.9 * dt));
        d.pos.addScaledVector(d.vel, dt);
        if (n >= cap) break;
        // Stretch along travel: a falling droplet is a teardrop, not a bead.
        const sp = d.vel.length();
        if (sp > 1e-4) {
          _w1.copy(d.vel).divideScalar(sp);
          _wq.setFromUnitVectors(UP, _w1);
        } else {
          _wq.identity();
        }
        const fade = clamp01(d.life / Math.max(1e-3, d.maxLife));
        const size = d.size * (0.35 + fade * 0.65);
        _wscale.set(size, size * clamp(1 + sp * 0.05, 1, 3), size);
        _wm.compose(d.pos, _wq, _wscale);
        dropMesh.setMatrixAt(n, _wm);
        _wc.setHex(d.color);
        dropMesh.setColorAt(n, _wc);
        n++;
      }
      dropMesh.count = n;
      if (n > 0) {
        dropMesh.instanceMatrix.needsUpdate = true;
        if (dropMesh.instanceColor) dropMesh.instanceColor.needsUpdate = true;
      }
    }

    if (waterMesh) {
      let n = 0;
      const cap = waterShots.length;
      for (const s of waterShots) {
        if (!s.active || n >= cap) continue;
        const sp = s.vel.length();
        if (sp > 1e-4) {
          _w1.copy(s.vel).divideScalar(sp);
          _wq.setFromUnitVectors(UP, _w1);
        } else {
          _wq.identity();
        }
        if (s.kind === "balloon") {
          // A balloon is a bag of water: it wobbles, and the wobble is 90% of
          // why it reads as one rather than as a beach ball.
          s.wobble += dt * 11;
          const w = Math.sin(s.wobble) * 0.2;
          _wscale.set(s.size * (1 + w), s.size * (1 - w), s.size * (1 - w * 0.6));
        } else {
          // Stretch the slug to roughly a frame of travel — that is what turns
          // a stream of discrete droplets into a continuous ribbon of water.
          const stretch = clamp((sp * 0.032) / Math.max(0.01, s.size), 1, 9);
          _wscale.set(s.size, s.size * stretch, s.size);
        }
        _wm.compose(s.pos, _wq, _wscale);
        waterMesh.setMatrixAt(n, _wm);
        _wc.setHex(s.color);
        waterMesh.setColorAt(n, _wc);
        n++;
      }
      waterMesh.count = n;
      if (n > 0) {
        waterMesh.instanceMatrix.needsUpdate = true;
        if (waterMesh.instanceColor) waterMesh.instanceColor.needsUpdate = true;
      }
    }

    if (strandMesh) {
      const g = WATER.glue;
      let n = 0;
      for (const strand of strands) {
        if (!strand.active) continue;
        if (!strandEnd(strand, false, _w1) || !strandEnd(strand, true, _w2)) continue;
        const span = _w1.distanceTo(_w2);
        // Slack sags; taut does not. That is the entire read of "you are about
        // to be yanked off your feet".
        const slack = clamp01(1 - span / Math.max(0.01, g.maxLength)) * g.sag;
        for (let i = 0; i < g.segments; i++) {
          if (n >= strandMesh.instanceMatrix.count) break;
          const t0 = i / g.segments;
          const t1 = (i + 1) / g.segments;
          _w3.lerpVectors(_w1, _w2, t0);
          _w3.y -= slack * 4 * t0 * (1 - t0) * span;
          _w4.lerpVectors(_w1, _w2, t1);
          _w4.y -= slack * 4 * t1 * (1 - t1) * span;
          const len = _w3.distanceTo(_w4);
          if (len < 1e-5) continue;
          _w5.copy(_w4).sub(_w3).divideScalar(len);
          _wq.setFromUnitVectors(UP, _w5);
          _wscale.set(1, len, 1);
          _w3.lerp(_w4, 0.5);
          _wm.compose(_w3, _wq, _wscale);
          strandMesh.setMatrixAt(n, _wm);
          n++;
        }
      }
      strandMesh.count = n;
      if (n > 0) strandMesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ---- tank + refill -------------------------------------------------------

  /**
   * The tank, not the magazine.
   *
   * Two ways to get water back, and they are the reason SPLASH ROYALE has a map loop
   * at all:
   *
   *  - **Pump (R).** Draws on the water you are carrying, at `refillRate` a
   *    second after a `refillDelay` wind-up. Interruptible, and it KEEPS what
   *    it got — that is the one mechanical difference from swapping a mag, and
   *    it turns every fight into "do I have enough for one more push".
   *  - **A source.** Stand at a hydrant, a pool, a fountain or in the sea and
   *    the tank fills on its own at `dunkTime`, and your backpack fills with
   *    it. This is the only thing that makes a spent player leave cover, and
   *    sprinting for a hydrant mid-fight is the best moment in the mode.
   */
  function refillControl(dt: number): void {
    const wd = wdef;
    const ws = wstats;
    atSource = false;
    sourceRate = 0;
    if (!wd || !ws || !activeItem) {
      refilling = false;
      refillT = 0;
      return;
    }

    const tank = ws.tank;
    const have = ammoOf();
    const player = ctx.services.player;

    // A source in reach fills you whether or not you asked, because standing
    // in a fountain and not filling up would be a bug in everyone's head.
    const wetness = ctx.services.wetness;
    if (player && wetness) {
      let src = null;
      try {
        src = wetness.sourceNear(player.position, SOURCE_RANGE);
      } catch {
        src = null;
      }
      if (src) {
        atSource = true;
        sourceRate = (tank / Math.max(0.2, wd.dunkTime)) * Math.max(0.1, src.refillRate);
      }
    }

    if (have >= tank) {
      refilling = false;
      refillT = 0;
      autoRefill = false;
      // Topped off and still standing in it — fill the backpack instead.
      if (atSource) {
        const cap = reserveCap[waterAmmoType()] ?? 0;
        const cur = reserve[waterAmmoType()] ?? 0;
        if (cur < cap) {
          reserve[waterAmmoType()] = Math.min(cap, cur + sourceRate * dt);
          hudDirty = true;
        }
      }
      return;
    }

    // Firing always wins. Pulling the trigger with water in the tank cancels
    // the pump and keeps every unit of what it managed to put in — that is the
    // whole point of a tank you top up rather than a mag you swap.
    //
    // Standing in a fountain is the exception: the water is coming in whether
    // you shoot or not, and cancelling there would restart the refill on every
    // fixed step and re-trigger its sound 120 times a second.
    if (ctx.input.fire && have > 0 && !atSource) {
      refilling = false;
      refillT = 0;
      autoRefill = false;
      return;
    }

    const want = atSource || autoRefill || ctx.input.reload;
    if (!want) {
      refilling = false;
      refillT = 0;
      return;
    }

    if (!refilling) {
      refilling = true;
      refillT = atSource ? 0 : wd.refillDelay;
      ctx.services.audio?.play(atSource ? "dunk-start" : wd.soundRefill, { volume: 0.5 });
    }
    if (refillT > 0) {
      refillT = Math.max(0, refillT - dt);
      hudDirty = true;
      return;
    }

    const type = waterAmmoType();
    if (atSource) {
      // Free water. Fill the tank first — you want to be able to shoot again
      // before you want a full backpack.
      setAmmo(Math.min(tank, have + sourceRate * dt));
    } else {
      const carried = reserve[type] ?? 0;
      if (carried <= 0) {
        refilling = false;
        autoRefill = false;
        return;
      }
      const flow = Math.min(ws.refillRate * dt, tank - have, carried);
      setAmmo(have + flow);
      reserve[type] = carried - flow;
    }
    hudDirty = true;
    if (ammoOf() >= tank) {
      refilling = false;
      autoRefill = false;
      ctx.services.audio?.play("bolt-forward", { volume: 0.35 });
    }
  }

  /** The archetype's ammo type — water is carried in the same five buckets. */
  function waterAmmoType(): AmmoType {
    return entry?.def.ammoType ?? "medium";
  }

  // ---- balloons ------------------------------------------------------------

  /**
   * The throwable. Fire throws, and that is the whole control scheme — a
   * balloon is not a gun and does not need a second verb.
   */
  function throwControl(dt: number): void {
    throwCooldown = Math.max(0, throwCooldown - dt);
    const item = balloonItem;
    const player = ctx.services.player;
    if (!item) {
      lastThrowHeld = false;
      return;
    }
    const controllable = player ? player.controllable : ctx.input.locked;
    if (!controllable || stowedState()) {
      lastThrowHeld = false;
      return;
    }
    const held = ctx.input.fire && swapT <= 0;
    const edge = held && !lastThrowHeld;
    lastThrowHeld = held;
    if (!edge || throwCooldown > 0) return;

    const count = typeof item.count === "number" ? item.count : 1;
    if (count <= 0) return;

    aimBasis();
    if (player) player.eye(_origin);
    else _origin.copy(ctx.camera.position);
    _dir.copy(FORWARD).applyQuaternion(aimQuat);
    // Out of the hand rather than out of the eye, so the arc starts where the
    // throw animation would put it.
    _w1.copy(_origin).addScaledVector(_dir, 0.5);
    _w1.y -= 0.12;
    spawnBalloon(_w1, _dir);

    item.count = count - 1;
    throwCooldown = WATER.balloon.cooldown;
    ctx.services.audio?.play(WATER.balloon.sound, { volume: 0.6 });
    netSend("balloon", {
      x: _w1.x,
      y: _w1.y,
      z: _w1.z,
      dx: _dir.x,
      dy: _dir.y,
      dz: _dir.z,
      burst: false,
    });
    // A spent stack should leave your hands; inventory owns the slot, so tell
    // it rather than reaching in.
    if (item.count <= 0) ctx.emit("dz:throwable-spent", { id: item.id, def: item.def });
    hudDirty = true;
  }

  /** The player-state half of `stowed()` — shared with the balloon path. */
  function stowedState(): boolean {
    const player = ctx.services.player;
    if (!player) return true;
    if (player.state === "dead" || player.state === "down") return true;
    if (player.state === "bus" || player.state === "skydive" || player.state === "glide") return true;
    return !!(ctx.services.build?.selected || ctx.input.buildKind);
  }

  // ---- viewmodel pose ----------------------------------------------------

  /**
   * Build the first-person transform for this frame. Every channel is additive
   * so they layer cleanly: base pose → ADS blend → sprint → sway → bob →
   * recoil → reload choreography → swap dive.
   */
  function poseViewmodel(dt: number): void {
    if (!entry || !stats) return;
    const def = entry.def;
    const rig = entry.vm;

    posePos.copy(_v1.set(def.hip[0], def.hip[1], def.hip[2])).lerp(entry.ads, adsT);
    poseRot.set(
      lerp(def.hipRot[0], 0, adsT),
      lerp(def.hipRot[1], 0, adsT),
      lerp(def.hipRot[2], 0, adsT),
    );

    // Sprint: drop and cant the weapon out of the way. Reads instantly, and it
    // is the visual contract for "you cannot shoot right now".
    if (sprintT > 0.001) {
      posePos.y -= 0.075 * sprintT;
      posePos.z += 0.05 * sprintT;
      posePos.x += 0.02 * sprintT;
      poseRot.x -= 0.5 * sprintT;
      poseRot.y -= 0.55 * sprintT;
      poseRot.z += 0.42 * sprintT;
    }

    // Sway: the viewmodel lags the mouse, heavier guns lag more. Most of the
    // read is rotational — positional sway is capped so the gun cannot swing
    // out of frame on a fast flick.
    const swayScale = 1 - adsT * 0.62;
    posePos.x += clamp(sway.x * SWAY_LIMIT, -SWAY_LIMIT, SWAY_LIMIT) * swayScale;
    posePos.y += clamp(sway.y * SWAY_LIMIT, -SWAY_LIMIT, SWAY_LIMIT) * swayScale;
    poseRot.y += sway.x * 0.2 * swayScale;
    poseRot.x += -sway.y * 0.17 * swayScale;
    poseRot.z += sway.x * 0.13 * swayScale;

    // Walk bob — a figure eight, halved while aiming.
    const amp = bobAmp * (1 - adsT * 0.75);
    posePos.x += Math.sin(bobPhase) * 0.016 * amp;
    posePos.y += Math.sin(bobPhase * 2) * 0.011 * amp;
    poseRot.z += Math.sin(bobPhase) * 0.05 * amp;
    poseRot.x += Math.sin(bobPhase * 2) * 0.022 * amp;

    // Recoil.
    posePos.add(recoilPos.value);
    poseRot.x += recoilRot.value.x;
    poseRot.y += recoilRot.value.y;
    poseRot.z += recoilRot.value.z;

    // Reload choreography.
    if (reloadT > 0 && reloadTotal > 0) {
      const t = 1 - reloadT / reloadTotal;
      if (shellMode) {
        // One shell at a time: the gun rolls toward the loading port and the
        // off hand comes up, which is all we can show without a hand rig.
        const k = Math.sin(clamp01(t) * Math.PI);
        posePos.y -= 0.045 * k;
        posePos.x -= 0.03 * k;
        poseRot.z += 0.5 * k;
        poseRot.x -= 0.16 * k;
      } else {
        const [dropAt, insertAt, chargeAt] = def.reloadBeats;
        const tilt = Math.sin(Math.min(1, t / 0.18) * Math.PI * 0.5) * (1 - Math.max(0, (t - 0.82) / 0.18));
        posePos.y -= 0.06 * tilt;
        posePos.x -= 0.02 * tilt;
        poseRot.z += 0.55 * tilt;
        poseRot.x -= 0.25 * tilt;
        poseRot.y += 0.3 * tilt;

        if (rig.mag) {
          let magY = 0;
          let magT = 0;
          if (t >= dropAt && t < insertAt) {
            // Free-fall out of frame.
            const k = (t - dropAt) / Math.max(1e-3, insertAt - dropAt);
            magY = -k * k * 0.42;
            magT = k * 0.6;
          } else if (t >= insertAt) {
            // The fresh mag rises into the well and seats with a snap.
            const k = clamp01((t - insertAt) / Math.max(1e-3, chargeAt - insertAt));
            const e = 1 - Math.pow(1 - k, 3);
            magY = -0.42 * (1 - e);
            magT = 0.6 * (1 - e);
          }
          rig.mag.position.y = magY;
          rig.mag.rotation.x = magT;
          // One frame of nothing at the hand-off sells the swap.
          rig.mag.visible = !(t >= insertAt - 0.02 && t < insertAt + 0.015);
        }
        // Charge the bolt at the end of the sequence.
        if (def.slideTravel > 0) {
          const k = (t - chargeAt) / Math.max(1e-3, 1 - chargeAt);
          if (k > 0 && k < 1) slidePhase = Math.sin(k * Math.PI);
        }
      }
    } else if (rig.mag) {
      rig.mag.position.y = 0;
      rig.mag.rotation.x = 0;
      rig.mag.visible = true;
    }

    // Swap: dive out of frame, switch, rise back in.
    if (swapT > 0 && swapTotal > 0) {
      const t = 1 - swapT / swapTotal;
      const k = t < 0.5 ? t / 0.5 : 1 - (t - 0.5) / 0.5;
      const e = k * k;
      posePos.y -= 0.22 * e;
      posePos.z += 0.06 * e;
      poseRot.x -= 1.15 * e;
      poseRot.z += 0.35 * e;
    }

    rig.root.position.copy(posePos);
    rig.root.rotation.copy(poseRot);

    // Reciprocating mass — slide, bolt carrier or pump, all travel rearward.
    if (rig.slide) rig.slide.position.z = def.slideTravel * slidePhase;

    // Rotary barrels.
    if (rig.barrels && def.mode === "spin") {
      spinAngle += spin * 46 * dt;
      rig.barrels.rotation.z = spinAngle;
    }

    // Heat glow on the minigun's barrel shrouds.
    kit.hot.emissiveIntensity = heat * 3.4 + flashTime * 6;

    // Scope ocular: only once the sight picture has actually settled.
    if (rig.ocular) {
      const on = def.scoped && adsT > 0.9;
      rig.ocular.visible = on;
      const mat = rig.ocular.material as THREE.MeshBasicMaterial;
      mat.opacity = ease((adsT - 0.9) / 0.1);
    }

    // Muzzle flash billboard, placed at the real muzzle in viewmodel space.
    if (flashTime > 0) {
      const s = (0.13 + ctx.rng() * 0.09) * def.flashScale * def.vmScale * 3.4;
      flash.visible = true;
      flash.position
        .copy(rig.muzzle.position)
        .multiplyScalar(def.vmScale)
        .applyEuler(poseRot)
        .add(posePos);
      flash.rotation.set(0, 0, ctx.rng() * Math.PI * 2);
      flash.scale.setScalar(s);
      flashMat.opacity = Math.min(1, flashTime * 20);
      // Push the light slightly downrange of the flash so the bloom lands on
      // the barrel and the hand, not on the back of the receiver.
      flashLight.position.copy(flash.position).addScaledVector(FORWARD, 0.2);
    } else if (flash.visible) {
      flash.visible = false;
    }
  }

  // ---- third person ------------------------------------------------------

  /**
   * Where the right hand grips each weapon, in gun-local metres. Taken from
   * the trigger-group placement in each builder — the third-person weapon is
   * positioned so *this* point lands in the character's hand rather than the
   * gun's origin, which is what stops a bullpup from floating a foot forward.
   */
  const TP_GRIP: Record<string, [number, number, number]> = {
    ar: [0, -0.09, 0.102],
    smg: [0, -0.086, 0.09],
    pump: [0, -0.088, 0.112],
    tac: [0, -0.088, 0.1],
    sniper: [0, -0.091, 0.12],
    burst: [0, -0.089, -0.005],
    rocket: [0, -0.091, 0.1],
    pistol: [0, -0.084, 0.062],
    minigun: [0, -0.075, 0.13],
  };
  const gripOffset = new THREE.Vector3();
  let tpAimT = 0;

  /**
   * Find the character's right hand. The rig's joints are unnamed, but their
   * rest offsets are fixed proportions of the character, so the shoulder is
   * identifiable by its local translation and the chain below it by theirs.
   * If the search fails we fall back to a chest anchor rather than guessing —
   * a weapon parented to the wrong joint is worse than one held at the chest.
   */
  function findHand(root: THREE.Object3D): THREE.Object3D | null {
    let shoulder: THREE.Object3D | null = null;
    root.traverse((o) => {
      if (shoulder) return;
      const p = o.position;
      if (Math.abs(p.x - 0.215) < 0.003 && Math.abs(p.y - 0.14) < 0.003 && Math.abs(p.z) < 0.003) {
        shoulder = o;
      }
    });
    if (!shoulder) return null;
    const down = (node: THREE.Object3D, y: number): THREE.Object3D | null => {
      for (const child of node.children) {
        if (Math.abs(child.position.y - y) < 0.004 && Math.abs(child.position.x) < 0.004) return child;
      }
      return null;
    };
    const arm = down(shoulder, 0);
    const fore = arm ? down(arm, -0.32) : null;
    return fore ? down(fore, -0.3) : null;
  }

  function updateThirdPerson(dt: number): void {
    const player = ctx.services.player;
    const show = !!entry && !!player && !firstPerson && !stowed();
    tpRoot.visible = show;
    if (!show || !entry || !player) return;

    if (!handSearched) {
      handSearched = true;
      handNode = findHand(player.rig);
    }

    // Aim blend: the weapon comes up when the player aims, fires or builds a
    // sight picture, and rides at a low ready otherwise.
    const wantAim = ctx.input.aim || firing || reloadT > 0 ? 1 : 0;
    tpAimT = approach(tpAimT, wantAim, 9, dt);

    // Orientation from the aim basis, so the gun points exactly where the
    // bullets go. Recoil rides on top of it, which is why the third-person
    // weapon jumps in someone else's killcam too.
    _e1.set(
      lerp(player.pitch * 0.35 + 0.42, player.pitch, tpAimT) + recoilRot.value.x * 0.4,
      player.yaw + camKick.value.y + recoilRot.value.y * 0.3,
      recoilRot.value.z * 0.5 + lerp(0.25, 0, tpAimT),
      "YXZ",
    );
    tpRoot.quaternion.setFromEuler(_e1);

    const g = TP_GRIP[entry.def.id] ?? [0, -0.09, 0.1];
    gripOffset.set(g[0], g[1], g[2]).multiplyScalar(entry.def.tpScale).applyQuaternion(tpRoot.quaternion);

    if (handNode) {
      // The player animates in update(); we run in lateUpdate, so forcing the
      // ancestor chain here is what keeps the gun in the hand instead of one
      // frame behind it.
      handNode.updateWorldMatrix(true, false);
      tpRoot.position.setFromMatrixPosition(handNode.matrixWorld);
    } else {
      // Chest anchor: shoulder height, slightly right of the spine.
      tpRoot.position.copy(player.position);
      tpRoot.position.y += 1.32;
      _v2.set(0.16, 0, 0.05).applyQuaternion(tpRoot.quaternion);
      tpRoot.position.add(_v2);
    }
    tpRoot.position.sub(gripOffset);
    // Recoil shoves the whole weapon back along its own axis.
    _v2.set(0, 0, 1).applyQuaternion(tpRoot.quaternion).multiplyScalar(recoilPos.value.z * 0.6);
    tpRoot.position.add(_v2);

    entry.tp.visible = true;
    // The clone runs the same mechanical animation as the viewmodel: a bolt
    // that cycles and a mag that drops out there too is most of what makes a
    // third-person shooter read as a shooter.
    if (entry.tpSlide) entry.tpSlide.position.z = entry.def.slideTravel * slidePhase * entry.def.tpScale;
    if (entry.tpBarrels && entry.def.mode === "spin") entry.tpBarrels.rotation.z = spinAngle;
    if (entry.tpMag && entry.vm.mag) {
      entry.tpMag.position.y = entry.vm.mag.position.y;
      entry.tpMag.rotation.x = entry.vm.mag.rotation.x;
      entry.tpMag.visible = entry.vm.mag.visible;
    }
  }

  // ---- HUD ---------------------------------------------------------------

  function emitHud(): void {
    const def = entry?.def ?? null;
    const cap = magOf();
    // Tanks are continuous; the HUD is not. `ammo` is the counter a player
    // reads, so it is a whole number — rounded UP, because a gauge that says
    // 0 while there is still a squirt in the tank is a gauge that lies. The
    // exact level rides along in `payload.tank` for anything that wants it.
    const ammo = isWater ? Math.ceil(ammoOf() - 1e-6) : ammoOf();
    const res = def ? reserve[def.ammoType] ?? 0 : 0;
    const resShown = isWater ? Math.round(res) : res;
    const key = `${def?.id ?? "-"}|${wdef?.id ?? "-"}|${balloonItem?.id ?? "-"}|${rarity}|${ammo}|${resShown}|${
      reloadT > 0 || refilling ? 1 : 0
    }|${atSource ? 1 : 0}`;
    if (hudDirty || key !== hudKey) {
      hudKey = key;
      hudDirty = false;
      const payload: WeaponHudPayload = {
        id: wdef?.id ?? def?.id ?? (balloonItem ? WATER.balloon.id : null),
        name: wstats
          ? wstats.displayName
          : balloonItem
            ? WATER.balloon.name
            : def && stats
              ? stats.displayName
              : "",
        short: wdef?.short ?? (balloonItem ? "BALL" : def?.short ?? ""),
        rarity,
        color: RARITY_COLOR[rarity],
        mode: def?.mode ?? "semi",
        ammo,
        magSize: cap,
        reserve: resShown,
        ammoType: def?.ammoType ?? null,
        reloading: reloadT > 0 || refilling,
        reloadProgress: reloadT > 0 && reloadTotal > 0 ? 1 - reloadT / reloadTotal : 0,
        lowAmmo: cap > 0 && ammo <= Math.max(1, Math.ceil(cap * 0.25)),
        empty: ammo <= 0,
        scoped: !!def?.scoped,
        ads: adsT,
      };
      if (isWater) {
        payload.water = true;
        payload.tank = Math.round(ammoOf() * 100) / 100;
        payload.tankMax = cap;
        payload.carried = resShown;
        payload.carriedMax = def ? reserveCap[def.ammoType] ?? 0 : 0;
        payload.refilling = refilling;
        payload.refillProgress = refilling
          ? refillT > 0 && wdef
            ? 1 - refillT / Math.max(1e-3, wdef.refillDelay)
            : cap > 0
              ? clamp01(ammoOf() / cap)
              : 0
          : 0;
        payload.atSource = atSource;
        payload.streamColor = wdef?.streamColor ?? WATER.balloon.splashColor;
        payload.soak = wstats ? wstats.pullSoak : 0;
        if (balloonItem) payload.balloons = balloonItem.count ?? 0;
      }
      ctx.emit("dz:weapon", payload);
    }

    // Crosshair bloom is its own cheaper channel: it changes every frame while
    // shooting and the HUD wants it without a full weapon payload.
    const spreadNorm = stats
      ? clamp01(
          (lerp(
            wstats ? wstats.spread : stats.spread,
            wstats ? wstats.spreadAds : stats.spreadAds,
            adsT,
          ) +
            bloom) /
            0.09,
        )
      : 0;
    const quantised = Math.round(spreadNorm * 60) / 60;
    if (quantised !== lastCrosshair || hudDirty) {
      lastCrosshair = quantised;
      ctx.emit("dz:crosshair", {
        spread: quantised,
        ads: adsT,
        scoped: !!entry?.def.scoped && adsT > 0.9,
        spin,
        heat,
        hidden: sprintT > 0.5 || stowed(),
      });
    }
  }

  // ---- inventory ---------------------------------------------------------

  let swapPending = false;

  /**
   * Follow whatever the inventory says is in the player's hands. Weapons never
   * choose their own slot — that is the inventory's job — so all this does is
   * notice the change and play the swap through.
   */
  function syncInventory(dt: number): void {
    const inv = ctx.services.inventory;
    const held = inv?.active ?? null;
    // A water gun may be held under either spelling of its id, so resolve to
    // the archetype whose mesh and ballistics it rides on before looking it up.
    const target = held && held.kind === "weapon" && entries.has(entryIdFor(held.def)) ? held : null;
    // A stack of balloons in hand is a weapon with no gun behind it.
    const balloon = isWater && isBalloonItem(held) ? held : null;
    if (balloon !== balloonItem) {
      balloonItem = balloon;
      lastThrowHeld = false;
      hudDirty = true;
    }

    if (target !== activeItem && (!swapPending || target !== pendingItem)) {
      if (!activeItem) {
        // Coming from bare hands or a pickaxe: bring the gun straight up, no
        // stow animation to wait through.
        commitItem(target);
        swapPending = false;
        swapT = swapTotal = target ? 0.22 : 0;
        if (target) ctx.services.audio?.play("weapon-swap", { volume: 0.4 });
      } else {
        pendingItem = target;
        swapPending = true;
        swapTotal = Math.max(0.14, entry?.def.swapTime ?? 0.4);
        swapT = swapTotal;
        reloadT = 0;
        shellMode = false;
        burstLeft = 0;
        ctx.services.audio?.play("weapon-swap", { volume: 0.42 });
      }
    }

    if (swapT > 0) {
      swapT = Math.max(0, swapT - dt);
      if (swapPending && swapT <= swapTotal * 0.5) {
        commitItem(pendingItem);
        pendingItem = null;
        swapPending = false;
      }
    }
  }

  // ---- system ------------------------------------------------------------

  const WHITE = new THREE.Color(0xffffff);
  const groundAt = (x: number, z: number): number => ctx.services.terrain?.heightAt(x, z) ?? 0;

  const sys: FixedSystem = {
    name: "weapons",

    fixed(dt) {
      fireControl(dt);
      stepProjectiles(dt);
      // Water bodies and glue strands are simulation, not decoration: whether
      // a jet connects and whether a strand snaps must not depend on fps.
      if (isWater) {
        stepWater(dt);
        stepStrands(dt);
      }
    },

    update(dt) {
      const input = ctx.input;
      const player = ctx.services.player;

      // Hitstop: freeze the *viewmodel* for a few frames on a confirmed hit.
      // The world keeps running; only the gun hangs. It is nearly free and it
      // is most of why a connecting shot feels solid.
      hitstop = Math.max(0, hitstop - dt);
      const vdt = hitstop > 0 ? dt * 0.2 : dt;

      syncInventory(dt);

      const def = entry?.def ?? null;
      const away = stowed();

      // ---- reload timing -------------------------------------------------
      if (reloadT > 0 && def && stats) {
        const prev = 1 - reloadT / reloadTotal;
        reloadT = Math.max(0, reloadT - dt);
        const now = 1 - reloadT / reloadTotal;
        if (!shellMode) {
          const [dropAt, insertAt, chargeAt] = def.reloadBeats;
          if (prev < dropAt && now >= dropAt) ctx.services.audio?.play("mag-out", { volume: 0.45 });
          if (prev < insertAt && now >= insertAt) ctx.services.audio?.play("mag-in", { volume: 0.55 });
          if (prev < chargeAt && now >= chargeAt) ctx.services.audio?.play("bolt-back", { volume: 0.5 });
        }
        if (reloadT <= 0) finishReload();
        hudDirty = true;
      }

      // ---- sprint / ADS --------------------------------------------------
      const speed = player ? Math.hypot(player.velocity.x, player.velocity.z) : 0;
      const sprinting =
        !away && input.sprint && input.moveZ > 0.2 && speed > WALK_SPEED * 0.85 && !input.aim && reloadT <= 0;
      sprintT = approach(sprintT, sprinting ? 1 : 0, 11, dt);

      const wantAds = !away && !!def && input.aim && def.adsAllowed && sprintT < 0.4 && reloadT <= 0;
      const adsRate = def ? 1 / Math.max(0.02, def.adsTime * 0.34) : 12;
      const before = adsT;
      adsT = approach(adsT, wantAds ? 1 : 0, adsRate, dt);
      if (before < 0.1 && adsT >= 0.1) ctx.services.audio?.play("ads-in", { volume: 0.3 });

      // ---- bloom ---------------------------------------------------------
      if (def) {
        bloom = Math.max(0, bloom - def.bloomDecay * bloom * dt - 0.0004 * dt);
        if (bloom < 5e-5) bloom = 0;
      }

      // ---- springs -------------------------------------------------------
      if (def) {
        const r = def.recoil;
        recoilPos.step(vdt, r.stiffness, r.damping);
        recoilRot.step(vdt, r.stiffness * 1.15, r.damping * 1.05);
        // The camera spring is softer and recovers most, but not all, of the
        // kick: `recovery` below 1 leaves a sliver of the climb in the aim,
        // which is what makes a long spray something you have to fight.
        camKick.step(dt, r.stiffness * 0.5, r.damping * 0.8);
        camKick.value.multiplyScalar(lerp(1, 0.999, 1 - r.recovery));
        // Pattern resets once the player stops shooting and the gun settles.
        if (!firing && cooldown <= 0 && recoilRot.value.lengthSq() < 4e-4 && activeItem) {
          stateFor(activeItem).shotIndex = 0;
        }
      }

      // ---- sway / bob ----------------------------------------------------
      const weight = def?.weight ?? 1;
      const lag = 1 / (0.055 + weight * 0.055);
      const swayTargetX = clamp(-input.lookX * 12, -1, 1);
      const swayTargetY = clamp(input.lookY * 12, -1, 1);
      swayVel.x += (swayTargetX - sway.x) * lag * 8 * vdt;
      swayVel.y += (swayTargetY - sway.y) * lag * 8 * vdt;
      swayVel.multiplyScalar(Math.max(0, 1 - 11 * vdt));
      sway.x += swayVel.x * vdt;
      sway.y += swayVel.y * vdt;

      const grounded = player ? player.state !== "air" : false;
      const bobSpeed = grounded ? Math.min(speed / SPRINT_SPEED, 1.3) : 0;
      bobPhase += vdt * (4.2 + bobSpeed * 7.5) * (bobSpeed > 0.05 ? 1 : 0);
      bobAmp = approach(bobAmp, grounded ? bobSpeed : 0, 8, dt);

      // ---- shake ---------------------------------------------------------
      shakeVel.multiplyScalar(Math.max(0, 1 - 9 * dt));
      shake.addScaledVector(shakeVel, dt);
      shake.multiplyScalar(Math.max(0, 1 - 13 * dt));

      // ---- slide cycle ---------------------------------------------------
      if (slideTimer > 0 && def) {
        slideTimer = Math.max(0, slideTimer - vdt);
        const k = slideTimer / Math.max(1e-4, def.slideTime);
        // Snap back fast, return slower. That asymmetry is the whole read.
        slidePhase = k > 0.6 ? (1 - k) / 0.4 : k / 0.6;
        if (slideTimer <= 0) {
          slidePhase = 0;
          if (def.mode === "pump") ctx.services.audio?.play("pump-action", { volume: 0.5 });
        }
      } else if (reloadT <= 0 && def && def.slideTravel > 0 && ammoOf() <= 0) {
        // Bolt locked back on empty — the most readable ammo counter there is.
        slidePhase = 1;
      }

      flashTime = Math.max(0, flashTime - dt);
      flashLight.intensity = Math.max(0, flashLight.intensity - dt * 160);

      // ---- pools ---------------------------------------------------------
      brassShells.update(dt, groundAt, (p, hard) => {
        if (hard && ctx.rng() < 0.4) {
          ctx.services.audio?.play("shell-drop", { position: p, volume: 0.14, maxDistance: 22 });
        }
      });
      hullShells.update(dt, groundAt, (p, hard) => {
        if (hard) ctx.services.audio?.play("shell-drop", { position: p, volume: 0.2, rate: 0.75, maxDistance: 22 });
      });
      renderWater(dt);

      emitHud();
    },

    lateUpdate(dt) {
      const player = ctx.services.player;
      const cam = ctx.camera;
      const away = stowed();

      // ---- camera layer --------------------------------------------------
      // The player controller has already written pitch/yaw/FOV this frame; we
      // add recoil and shake on top of it. Because it rewrites from its own
      // state every frame, none of this accumulates — it springs back on its
      // own, which is the recoil-recovery model the whole module is built on.
      if (player && !away) {
        cam.rotation.x += camKick.value.x + shake.x * 0.3;
        cam.rotation.y += camKick.value.y + shake.y * 0.3;
        cam.rotation.z += shake.z * 0.55 + camKick.value.y * 0.45;
        cam.position.x += shake.x * 0.02;
        cam.position.y += shake.y * 0.02;
      }

      // ---- ADS field of view ---------------------------------------------
      // The player controller owns the camera's FOV and rewrites it from its
      // own state every frame; the scope pull is ours and rides on top. We
      // cannot simply add, because if the controller ever *doesn't* rewrite
      // (it skips sub-0.005 changes, and it may not have booted at all) the
      // addition compounds and the scope zooms to infinity. So: recover the
      // base by subtracting our own last contribution, but only if the value
      // we left behind is still there.
      const pull = player && !away ? (entry?.def.adsFovPull ?? 0) * ease(adsT) : 0;
      fovDelta = approach(fovDelta, pull, 14, dt);
      const baseFov = fovLeft >= 0 && Math.abs(cam.fov - fovLeft) < 1e-4 ? cam.fov - fovApplied : cam.fov;
      const wantWorldFov = baseFov + fovDelta;
      if (Math.abs(cam.fov - wantWorldFov) > 0.01) {
        cam.fov = wantWorldFov;
        cam.updateProjectionMatrix();
      }
      fovApplied = fovDelta;
      fovLeft = cam.fov;

      // ---- viewmodel -----------------------------------------------------
      vmVisible = !away && firstPerson && !!entry;
      if (entry) {
        entry.vm.root.visible = vmVisible;
        // Posed even when third person is showing: the third-person clone
        // mirrors the mag and bolt from these values, and a camera toggle
        // mid-reload must not reveal a gun frozen at its rest pose.
        poseViewmodel(hitstop > 0 ? dt * 0.2 : dt);
      }

      // Off the *un-pulled* world FOV: the scope pull is already expressed in
      // the viewmodel's own ADS target, and applying both narrows twice.
      const wantFov = lerp(baseFov * VM_FOV_SCALE, entry?.def.adsVmFov ?? 45, ease(adsT));
      if (Math.abs(vmCamera.fov - wantFov) > 0.01) {
        vmCamera.fov = wantFov;
        vmCamera.updateProjectionMatrix();
      }
      if (vmCamera.aspect !== cam.aspect) {
        vmCamera.aspect = cam.aspect;
        vmCamera.updateProjectionMatrix();
      }

      // Relight the viewmodel from the sky so the gun belongs to the same time
      // of day as the island — but only halfway, because a key light that
      // follows the sun exactly leaves the weapon black whenever the player
      // turns their back on it, which is half the time.
      const sky = ctx.services.sky;
      if (sky) {
        _color.copy(sky.sunColor).lerp(WHITE, 0.4);
        vmKey.color.copy(_color);
        vmKey.intensity = 0.9 + sky.daylight * 2.1;
        vmFill.intensity = 0.5 + sky.daylight * 0.8;
        vmRim.intensity = 0.7 + sky.daylight * 1.4;
        _q1.copy(cam.quaternion).invert();
        _v1.copy(sky.sunDirection).applyQuaternion(_q1);
        vmKey.position.set(
          lerp(0.6, _v1.x * 2, 0.5),
          lerp(0.9, Math.max(0.2, _v1.y * 2), 0.5),
          lerp(0.5, _v1.z * 2, 0.5),
        );
      }
      vmScene.updateMatrixWorld(true);

      updateThirdPerson(dt);
    },

    resize(width, height) {
      vmCamera.aspect = width / Math.max(1, height);
      vmCamera.updateProjectionMatrix();
    },

    dispose() {
      // Hand the render override back before we stop listening, so postfx (or
      // the forward path) owns the frame again the instant we are gone.
      offPostfx();
      ctx.emit("dz:postfx", innerRender);
      offCamera();
      offHud();

      ctx.scene.remove(tpRoot, brassShells.mesh, hullShells.mesh);
      for (const p of projectiles) {
        if (p.mesh) ctx.scene.remove(p.mesh);
      }
      brassShells.mesh.dispose();
      hullShells.mesh.dispose();

      // Water. The geometries and materials are already tracked in
      // `extraGeometries`/`extraMaterials` and disposed below; what has to
      // happen here is releasing the instance buffers and leaving the scene.
      for (const m of [waterMesh, dropMesh, strandMesh]) {
        if (!m) continue;
        ctx.scene.remove(m);
        m.dispose();
      }
      waterShots.length = 0;
      droplets.length = 0;
      strands.length = 0;
      balloonItem = null;
      wdef = null;
      wstats = null;

      // Geometry and materials are shared between the viewmodel and its clone,
      // so walk both graphs through one seen-set rather than disposing twice.
      const seen = new Set<unknown>();
      const scrub = (root: THREE.Object3D): void => {
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          if (m.geometry && !seen.has(m.geometry)) {
            seen.add(m.geometry);
            m.geometry.dispose();
          }
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mat of mats) {
            if (!mat || seen.has(mat)) continue;
            seen.add(mat);
            mat.dispose();
          }
        });
      };
      scrub(vmScene);
      scrub(tpRoot);
      for (const p of projectiles) {
        if (p.mesh) scrub(p.mesh);
      }

      for (const g of extraGeometries) g.dispose();
      for (const m of extraMaterials) m.dispose();
      for (const t of extraTextures) t.dispose();
      kit.dispose();

      vmScene.clear();
      tpRoot.clear();
      entries.clear();
      itemState.clear();

      if (services.weapons === service) services.weapons = undefined;
    },
  };

  // A weapon that boots mid-match should not have the player staring at an
  // empty HUD until they fire, so publish the initial state immediately.
  emitHud();

  return sys;
};

export default createWeapons;
