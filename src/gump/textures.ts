/**
 * The ground, drawn into canvases, once per chapter.
 *
 * The floor is two planes, and it took looking at a screenshot to learn why it
 * has to be. A single plane carrying one cross-section texture ties the width
 * of the *road* to the width of the *world*: make the road the right size and
 * the terrain ends forty metres out with trees floating past its edge; make
 * the terrain big enough and the road is ninety metres across. So:
 *
 *   - a **terrain** plane, hundreds of metres wide, with a tiling texture that
 *     repeats in both directions — grass, desert, jungle, turf;
 *   - a **road** strip laid on top at exactly the width the chapter wants,
 *     carrying a cross-section: shoulders, ruts, the centre line, yard lines.
 *
 * Both scroll by sliding their texture offset, which is why there is no tile
 * recycler in this game, no seam to hide, and no drift after five miles.
 */
import * as THREE from "three";

const cache = new Map<string, THREE.CanvasTexture>();

function draw(
  key: string,
  size: number,
  fn: (c: CanvasRenderingContext2D, w: number, h: number) => void,
  tiling: boolean,
) {
  const hit = cache.get(key);
  if (hit) return hit;
  const el = document.createElement("canvas");
  el.width = el.height = size;
  fn(el.getContext("2d")!, size, size);
  const tex = new THREE.CanvasTexture(el);
  tex.wrapS = tiling ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  cache.set(key, tex);
  return tex;
}

/** Deterministic noise so the same road is the same road every run. */
function rnd(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function speckle(
  c: CanvasRenderingContext2D,
  w: number,
  h: number,
  n: number,
  colors: string[],
  seed: number,
  size = 2,
) {
  const r = rnd(seed);
  for (let i = 0; i < n; i++) {
    c.fillStyle = colors[Math.floor(r() * colors.length)];
    const s = size * (0.4 + r());
    c.fillRect(r() * w, r() * h, s, s);
  }
}

/* ================================================================ terrain */

/**
 * A tiling ground cover. Tiles in *both* axes, so one 8 m square covers a
 * four-hundred-metre plain for the price of one texture — and it scrolls with
 * everything else, which is what stops the horizon feeling nailed down while
 * the road rushes past.
 */
function terrain(key: string, base: string, specks: string[], seed: number, n = 3400) {
  return draw(
    `t-${key}`,
    256,
    (c, w, h) => {
      c.fillStyle = base;
      c.fillRect(0, 0, w, h);
      speckle(c, w, h, n, specks, seed, 3);
    },
    true,
  );
}

export const grassGround = () =>
  terrain("grass", "#4e6b33", ["#456129", "#59763b", "#3d5527", "#6b8a44"], 7);

export const turfGround = () =>
  terrain("turf", "#2f7a3a", ["#2a6d34", "#348441", "#276230"], 31, 2200);

export const jungleGround = () =>
  terrain("jungle", "#2c4626", ["#24391f", "#35522c", "#1d3019", "#406034"], 5);

export const desertGround = () =>
  terrain("desert", "#c2a071", ["#b3915f", "#d0b083", "#a8845190", "#8f7248"], 13);

/* =================================================================== road */

/**
 * The dirt road out of Greenbow. Ruts down the middle where the trucks go,
 * gravel across the whole thing, and shoulders that feather out into the
 * grass instead of ending on a razor edge.
 */
export function dirtRoad() {
  return draw(
    "r-dirt",
    256,
    (c, w, h) => {
      c.fillStyle = "#9d7f52";
      c.fillRect(0, 0, w, h);
      speckle(c, w, h, 1800, ["#8d7048", "#ad8f60", "#7d6440", "#c0a878"], 11, 3);
      // Shoulders: grass creeping in from both edges.
      for (let i = 0; i < 26; i++) {
        const a = 1 - i / 26;
        c.fillStyle = `rgba(78,107,51,${a * 0.85})`;
        c.fillRect(i, 0, 1.4, h);
        c.fillRect(w - i - 1.4, 0, 1.4, h);
      }
      // Two ruts, and the crown of grass between them.
      c.fillStyle = "rgba(120,96,60,0.5)";
      c.fillRect(w * 0.24, 0, 26, h);
      c.fillRect(w * 0.64, 0, 26, h);
      c.fillStyle = "rgba(96,116,64,0.25)";
      c.fillRect(w * 0.47, 0, 14, h);
      speckle(c, w, h, 500, ["#6d5a3c", "#c0a878"], 23, 2);
    },
    false,
  );
}

/** The field. Mowed stripes, a yard line every 5, hashes down the middle. */
export function footballField() {
  return draw(
    "r-field",
    256,
    (c, w, h) => {
      c.fillStyle = "#2f7a3a";
      c.fillRect(0, 0, w, h);
      for (let i = 0; i < 4; i++) {
        c.fillStyle = i % 2 ? "#2a6d34" : "#348441";
        c.fillRect(0, (i * h) / 4, w, h / 4);
      }
      speckle(c, w, h, 1500, ["#2c7038", "#3a8a46"], 31, 2);
      c.fillStyle = "#f0f0ea";
      // 256 px along = 20 yards, so a line every 5 yards is every 64 px.
      for (const y of [0, 64, 128, 192]) c.fillRect(0, y, w, y % 128 === 0 ? 5 : 3);
      for (const y of [0, 64, 128, 192]) {
        for (const x of [w * 0.32, w * 0.68]) c.fillRect(x, y - 11, 4, 22);
      }
      c.fillRect(4, 0, 5, h);
      c.fillRect(w - 9, 0, 5, h);
    },
    false,
  );
}

/** Jungle track: churned mud, standing water in the ruts, grass at the edges. */
export function jungleTrack() {
  return draw(
    "r-jungle",
    256,
    (c, w, h) => {
      c.fillStyle = "#4a3c28";
      c.fillRect(0, 0, w, h);
      speckle(c, w, h, 2200, ["#3d3122", "#57462d", "#2f2619", "#61503a"], 17, 3);
      for (let i = 0; i < 30; i++) {
        const a = 1 - i / 30;
        c.fillStyle = `rgba(44,70,38,${a * 0.9})`;
        c.fillRect(i, 0, 1.4, h);
        c.fillRect(w - i - 1.4, 0, 1.4, h);
      }
      c.fillStyle = "rgba(96,120,102,0.4)";
      for (let i = 0; i < 12; i++) {
        const r = rnd(i * 91)();
        c.beginPath();
        c.ellipse(w * (0.22 + r * 0.56), r * h, 18 + r * 26, 8 + r * 9, 0, 0, Math.PI * 2);
        c.fill();
      }
    },
    false,
  );
}

/** Two lanes of blacktop and a broken yellow line. The finale runs on this. */
export function highway() {
  return draw(
    "r-highway",
    256,
    (c, w, h) => {
      c.fillStyle = "#3f4247";
      c.fillRect(0, 0, w, h);
      speckle(c, w, h, 1600, ["#484b50", "#37393d", "#55575c"], 3, 3);
      // Gravel shoulder, then the fog line.
      for (let i = 0; i < 18; i++) {
        const a = 1 - i / 18;
        c.fillStyle = `rgba(138,125,94,${a * 0.9})`;
        c.fillRect(i, 0, 1.4, h);
        c.fillRect(w - i - 1.4, 0, 1.4, h);
      }
      c.fillStyle = "#e8e2d4";
      c.fillRect(22, 0, 4, h);
      c.fillRect(w - 26, 0, 4, h);
      c.fillStyle = "#e0b53a";
      // 256 px = 16 m along, which lands the dashes at highway spacing.
      for (let i = 0; i < 4; i++) c.fillRect(w / 2 - 3, i * 64 + 10, 6, 40);
    },
    false,
  );
}

/** Open gulf water. Deep blue with chop that catches the light. */
export function gulfWater() {
  return draw(
    "t-water",
    256,
    (c, w, h) => {
      const grad = c.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, "#0d3c52");
      grad.addColorStop(0.5, "#12546f");
      grad.addColorStop(1, "#0d3c52");
      c.fillStyle = grad;
      c.fillRect(0, 0, w, h);
      const r = rnd(41);
      for (let i = 0; i < 400; i++) {
        c.fillStyle = `rgba(190,225,235,${0.05 + r() * 0.16})`;
        c.fillRect(r() * w, r() * h, 4 + r() * 22, 1.6);
      }
      for (let i = 0; i < 60; i++) {
        c.fillStyle = `rgba(255,255,255,${0.06 + r() * 0.1})`;
        c.fillRect(r() * w, r() * h, 10 + r() * 30, 2.6);
      }
    },
    true,
  );
}

/** The gym in Peking. A sprung wood floor with the court taped out on it. */
export function gymFloor() {
  return draw(
    "t-gym",
    256,
    (c, w, h) => {
      c.fillStyle = "#b98b4e";
      c.fillRect(0, 0, w, h);
      const r = rnd(61);
      for (let i = 0; i < 16; i++) {
        c.fillStyle = `rgba(${120 + r() * 40},${80 + r() * 30},${40 + r() * 25},0.5)`;
        c.fillRect(0, i * 16, w, 15);
      }
      speckle(c, w, h, 900, ["#a87a44", "#c79a5c"], 71, 2);
    },
    true,
  );
}

export function disposeTextureCache() {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
