/**
 * weapons/textures.ts — every sprite the gunplay needs, generated.
 *
 * No image files ship with this game, so muzzle flashes, smoke, sparks and
 * bullet holes are all drawn once into canvases at boot and cached. Two rules
 * make them look like assets rather than programmer art:
 *
 *   1. **Nothing is a clean gradient.** Every sprite gets noise, asymmetry and
 *      speckle. A perfectly radial puff reads as fake instantly.
 *   2. **Variants live in an atlas.** Four bullet holes in one 2×2 texture,
 *      picked per impact, so a wall never shows the same hole twice in a row —
 *      the single most obvious tell of a cheap decal system.
 *
 * All randomness is seeded, because the screenshot harness compares frames.
 *
 * Public API
 * ----------
 *   flashTexture() smokeTexture() sparkTexture() dustTexture()
 *   decalTexture(family)  — "hard" | "glass" | "metal" | "soft" | "scorch"
 *   disposeWeaponTextures()
 */
import * as THREE from "three";
import { makeRng, type Rng } from "../math/rng";

type Canvas = HTMLCanvasElement;

function makeCanvas(size: number): { c: Canvas; g: CanvasRenderingContext2D } | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  if (!g) return null;
  return { c, g };
}

function finish(c: Canvas, aniso = 4): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/** 1×1 white, for the headless case. Never null-checked at the call site. */
function fallback(): THREE.Texture {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

const cache = new Map<string, THREE.Texture>();

function cached(key: string, build: () => THREE.Texture): THREE.Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const t = build();
  cache.set(key, t);
  return t;
}

/* ------------------------------------------------------------------ *
 * Drawing helpers
 * ------------------------------------------------------------------ */

/** Speckled noise pass — the thing that stops a sprite reading as a gradient. */
function speckle(
  g: CanvasRenderingContext2D,
  rng: Rng,
  cx: number, cy: number, radius: number,
  count: number,
  alpha: number,
  colour = "255,255,255",
): void {
  for (let i = 0; i < count; i++) {
    const a = rng.next() * Math.PI * 2;
    const r = Math.sqrt(rng.next()) * radius;
    const s = 0.4 + rng.next() * 2.2;
    g.fillStyle = `rgba(${colour},${alpha * (0.25 + rng.next() * 0.75)})`;
    g.beginPath();
    g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, s, 0, Math.PI * 2);
    g.fill();
  }
}

/** A lumpy blob: overlapping soft circles, never one clean disc. */
function blob(
  g: CanvasRenderingContext2D,
  rng: Rng,
  cx: number, cy: number, radius: number,
  lobes: number,
  inner: string,
  outer: string,
): void {
  for (let i = 0; i < lobes; i++) {
    const a = rng.next() * Math.PI * 2;
    const d = rng.next() * radius * 0.45;
    const r = radius * (0.45 + rng.next() * 0.55);
    const x = cx + Math.cos(a) * d;
    const y = cy + Math.sin(a) * d;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, inner);
    grad.addColorStop(0.45, outer);
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
}

/* ------------------------------------------------------------------ *
 * Muzzle flash — a 2×2 atlas of four flash shapes
 * ------------------------------------------------------------------ */

/**
 * Real muzzle flash is not a star. It is a bright, short plume with a hot core
 * and a ragged corona, and the shape changes shot to shot with the powder
 * burn. Four variants: plume, star, ring-and-plume, and a wide fireball.
 */
export function flashTexture(): THREE.Texture {
  return cached("flash", () => {
    const S = 256;
    const made = makeCanvas(S);
    if (!made) return fallback();
    const { c, g } = made;
    const rng = makeRng("sf-muzzle-flash");
    const half = S / 2;

    for (let tile = 0; tile < 4; tile++) {
      const ox = (tile % 2) * half;
      const oy = Math.floor(tile / 2) * half;
      const cx = ox + half / 2;
      const cy = oy + half / 2;
      g.save();
      g.beginPath();
      g.rect(ox, oy, half, half);
      g.clip();
      g.globalCompositeOperation = "lighter";

      // Hot core.
      const core = g.createRadialGradient(cx, cy, 0, cx, cy, half * 0.2);
      core.addColorStop(0, "rgba(255,255,250,1)");
      core.addColorStop(0.4, "rgba(255,236,190,0.85)");
      core.addColorStop(1, "rgba(255,170,80,0)");
      g.fillStyle = core;
      g.fillRect(ox, oy, half, half);

      // Spikes — count and length vary per tile so no two shots match.
      const spikes = 5 + tile * 2 + (rng.next() * 3) | 0;
      for (let i = 0; i < spikes; i++) {
        const a = rng.next() * Math.PI * 2;
        const len = half * (0.16 + rng.next() * 0.3) * (tile === 3 ? 1.25 : 1);
        const w = half * (0.02 + rng.next() * 0.05);
        g.save();
        g.translate(cx, cy);
        g.rotate(a);
        const gr = g.createLinearGradient(0, 0, len, 0);
        gr.addColorStop(0, "rgba(255,244,214,0.95)");
        gr.addColorStop(0.35, "rgba(255,196,110,0.45)");
        gr.addColorStop(1, "rgba(255,120,40,0)");
        g.fillStyle = gr;
        g.beginPath();
        g.moveTo(0, -w);
        g.lineTo(len, -w * 0.18);
        g.lineTo(len, w * 0.18);
        g.lineTo(0, w);
        g.closePath();
        g.fill();
        g.restore();
      }

      // Corona: ragged burning gas.
      blob(g, rng, cx, cy, half * 0.3, 6,
        "rgba(255,214,150,0.5)", "rgba(255,140,50,0.18)");

      // Unburnt powder sparks.
      speckle(g, rng, cx, cy, half * 0.42, 90, 0.5, "255,215,150");
      g.restore();
    }
    return finish(c, 2);
  });
}

/* ------------------------------------------------------------------ *
 * Smoke / dust
 * ------------------------------------------------------------------ */

/** Turbulent soft puff. One tile, rotated per particle. */
export function smokeTexture(): THREE.Texture {
  return cached("smoke", () => {
    const S = 256;
    const made = makeCanvas(S);
    if (!made) return fallback();
    const { c, g } = made;
    const rng = makeRng("sf-weapon-smoke");
    g.clearRect(0, 0, S, S);
    const cx = S / 2;
    const cy = S / 2;
    blob(g, rng, cx, cy, S * 0.34, 14, "rgba(255,255,255,0.55)", "rgba(255,255,255,0.2)");
    // Erode the edge so the silhouette is not a circle.
    g.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 42; i++) {
      const a = rng.next() * Math.PI * 2;
      const r = S * (0.26 + rng.next() * 0.2);
      const s = S * (0.04 + rng.next() * 0.11);
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      const gr = g.createRadialGradient(x, y, 0, x, y, s);
      gr.addColorStop(0, "rgba(0,0,0,0.9)");
      gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, s, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = "source-over";
    speckle(g, rng, cx, cy, S * 0.3, 260, 0.06);
    return finish(c, 4);
  });
}

/** Dust: tighter, grittier, browner in the alpha falloff than smoke. */
export function dustTexture(): THREE.Texture {
  return cached("dust", () => {
    const S = 192;
    const made = makeCanvas(S);
    if (!made) return fallback();
    const { c, g } = made;
    const rng = makeRng("sf-weapon-dust");
    const cx = S / 2;
    const cy = S / 2;
    blob(g, rng, cx, cy, S * 0.3, 9, "rgba(255,255,255,0.75)", "rgba(255,255,255,0.25)");
    speckle(g, rng, cx, cy, S * 0.34, 420, 0.16);
    return finish(c, 4);
  });
}

/* ------------------------------------------------------------------ *
 * Sparks and chips
 * ------------------------------------------------------------------ */

/** A hot streak, brighter at the leading end. Stretched by the shader. */
export function sparkTexture(): THREE.Texture {
  return cached("spark", () => {
    const S = 128;
    const made = makeCanvas(S);
    if (!made) return fallback();
    const { c, g } = made;
    g.clearRect(0, 0, S, S);
    const gr = g.createLinearGradient(0, 0, 0, S);
    gr.addColorStop(0, "rgba(255,255,255,0)");
    gr.addColorStop(0.32, "rgba(255,230,170,0.55)");
    gr.addColorStop(0.62, "rgba(255,255,240,1)");
    gr.addColorStop(0.78, "rgba(255,200,120,0.6)");
    gr.addColorStop(1, "rgba(255,120,40,0)");
    g.fillStyle = gr;
    // Taper: a lozenge, not a bar.
    g.beginPath();
    g.moveTo(S * 0.5, 0);
    g.quadraticCurveTo(S * 0.72, S * 0.5, S * 0.5, S);
    g.quadraticCurveTo(S * 0.28, S * 0.5, S * 0.5, 0);
    g.fill();
    return finish(c, 2);
  });
}

/* ------------------------------------------------------------------ *
 * Decals
 * ------------------------------------------------------------------ */

export type DecalFamily = "hard" | "glass" | "metal" | "soft" | "scorch";

/**
 * A 2×2 atlas of four bullet-hole variants per surface family.
 *
 * The families differ in ways that read at a glance from three metres:
 * concrete craters and dusts, metal dents with a bright torn lip, glass
 * spiders, flesh and dirt splat wet and dark, explosives scorch.
 */
export function decalTexture(family: DecalFamily): THREE.Texture {
  return cached(`decal:${family}`, () => {
    const S = 256;
    const made = makeCanvas(S);
    if (!made) return fallback();
    const { c, g } = made;
    const rng = makeRng(`sf-decal-${family}`);
    const half = S / 2;

    for (let tile = 0; tile < 4; tile++) {
      const ox = (tile % 2) * half;
      const oy = Math.floor(tile / 2) * half;
      const cx = ox + half / 2;
      const cy = oy + half / 2;
      g.save();
      g.beginPath();
      g.rect(ox, oy, half, half);
      g.clip();

      switch (family) {
        case "glass": {
          // Spider: radial cracks plus two concentric fracture rings.
          g.strokeStyle = "rgba(236,244,255,0.85)";
          g.lineWidth = 1.15;
          const arms = 9 + ((rng.next() * 6) | 0);
          const ends: [number, number][] = [];
          for (let i = 0; i < arms; i++) {
            const a = (i / arms) * Math.PI * 2 + rng.next() * 0.3;
            const len = half * (0.16 + rng.next() * 0.28);
            let x = cx;
            let y = cy;
            g.beginPath();
            g.moveTo(x, y);
            const segs = 4;
            for (let s = 1; s <= segs; s++) {
              const t = (s / segs) * len;
              x = cx + Math.cos(a + rng.gauss() * 0.09) * t;
              y = cy + Math.sin(a + rng.gauss() * 0.09) * t;
              g.lineTo(x, y);
            }
            g.stroke();
            ends.push([x, y]);
          }
          g.lineWidth = 0.8;
          for (let ring = 0; ring < 2; ring++) {
            const rr = half * (0.08 + ring * 0.09 + rng.next() * 0.03);
            g.beginPath();
            for (let i = 0; i <= arms; i++) {
              const a = (i / arms) * Math.PI * 2;
              const r = rr * (0.85 + rng.next() * 0.3);
              const x = cx + Math.cos(a) * r;
              const y = cy + Math.sin(a) * r;
              if (i === 0) g.moveTo(x, y);
              else g.lineTo(x, y);
            }
            g.closePath();
            g.stroke();
          }
          // Punched-out hole.
          const hole = g.createRadialGradient(cx, cy, 0, cx, cy, half * 0.07);
          hole.addColorStop(0, "rgba(20,24,30,0.95)");
          hole.addColorStop(0.7, "rgba(210,230,255,0.6)");
          hole.addColorStop(1, "rgba(255,255,255,0)");
          g.fillStyle = hole;
          g.beginPath();
          g.arc(cx, cy, half * 0.09, 0, Math.PI * 2);
          g.fill();
          break;
        }
        case "metal": {
          const dent = g.createRadialGradient(cx, cy, 0, cx, cy, half * 0.16);
          dent.addColorStop(0, "rgba(12,12,14,0.95)");
          dent.addColorStop(0.45, "rgba(70,68,66,0.7)");
          dent.addColorStop(0.75, "rgba(200,198,192,0.5)");
          dent.addColorStop(1, "rgba(255,255,255,0)");
          g.fillStyle = dent;
          g.beginPath();
          g.arc(cx, cy, half * 0.18, 0, Math.PI * 2);
          g.fill();
          // Torn lip: bright scratches radiating from the hole.
          g.strokeStyle = "rgba(226,228,232,0.55)";
          g.lineWidth = 1.1;
          for (let i = 0; i < 12; i++) {
            const a = rng.next() * Math.PI * 2;
            const r0 = half * 0.07;
            const r1 = half * (0.1 + rng.next() * 0.14);
            g.beginPath();
            g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
            g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
            g.stroke();
          }
          speckle(g, rng, cx, cy, half * 0.2, 40, 0.2, "180,180,185");
          break;
        }
        case "soft": {
          // Wet splat: an off-centre core with running droplets.
          g.globalAlpha = 1;
          blob(g, rng, cx, cy, half * 0.19, 7,
            "rgba(46,10,10,0.92)", "rgba(80,16,16,0.45)");
          for (let i = 0; i < 14; i++) {
            const a = rng.next() * Math.PI * 2;
            const d = half * (0.12 + rng.next() * 0.22);
            const r = half * (0.012 + rng.next() * 0.035);
            const x = cx + Math.cos(a) * d;
            const y = cy + Math.sin(a) * d;
            const gr = g.createRadialGradient(x, y, 0, x, y, r);
            gr.addColorStop(0, "rgba(58,12,12,0.8)");
            gr.addColorStop(1, "rgba(58,12,12,0)");
            g.fillStyle = gr;
            g.beginPath();
            g.arc(x, y, r, 0, Math.PI * 2);
            g.fill();
          }
          break;
        }
        case "scorch": {
          blob(g, rng, cx, cy, half * 0.36, 11,
            "rgba(14,12,11,0.9)", "rgba(38,32,28,0.4)");
          speckle(g, rng, cx, cy, half * 0.42, 300, 0.1, "20,18,16");
          // A faint hot rim, as if the paint cooked.
          g.strokeStyle = "rgba(120,80,40,0.18)";
          g.lineWidth = 3;
          g.beginPath();
          g.arc(cx, cy, half * 0.3, 0, Math.PI * 2);
          g.stroke();
          break;
        }
        default: {
          // "hard": concrete/brick/stone. Dark crater, dusty halo, chip flecks.
          const crater = g.createRadialGradient(cx, cy, 0, cx, cy, half * 0.15);
          crater.addColorStop(0, "rgba(16,15,14,0.94)");
          crater.addColorStop(0.55, "rgba(52,49,45,0.66)");
          crater.addColorStop(1, "rgba(120,116,110,0)");
          g.fillStyle = crater;
          g.beginPath();
          g.arc(cx, cy, half * 0.17, 0, Math.PI * 2);
          g.fill();

          const halo = g.createRadialGradient(cx, cy, half * 0.1, cx, cy, half * 0.36);
          halo.addColorStop(0, "rgba(214,208,196,0.34)");
          halo.addColorStop(1, "rgba(214,208,196,0)");
          g.fillStyle = halo;
          g.beginPath();
          g.arc(cx, cy, half * 0.36, 0, Math.PI * 2);
          g.fill();

          // Radial chips — asymmetric, which is what sells a real hole.
          g.strokeStyle = "rgba(30,28,26,0.5)";
          for (let i = 0; i < 9; i++) {
            const a = rng.next() * Math.PI * 2;
            const r0 = half * 0.09;
            const r1 = half * (0.11 + rng.next() * 0.16);
            g.lineWidth = 0.6 + rng.next() * 1.6;
            g.beginPath();
            g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
            g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
            g.stroke();
          }
          speckle(g, rng, cx, cy, half * 0.34, 140, 0.16, "40,38,36");
          break;
        }
      }
      g.restore();
    }
    return finish(c, 8);
  });
}

export function disposeWeaponTextures(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
