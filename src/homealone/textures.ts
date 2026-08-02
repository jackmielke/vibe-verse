/**
 * Every surface in Winnetka, drawn into a 2D canvas at boot. No image files.
 *
 * The look this is chasing is a specific one: a 1990 suburban Chicago house at
 * night, in snow, shot on film. That means three things the textures have to
 * carry on their own, because there is no lightmap and no photo source:
 *
 * - **Warmth indoors, blue outdoors.** The interior palette is oak, brass and
 *   cream; the exterior is slate blue and white. Half the "it looks like the
 *   movie" reaction is just that temperature split, and it is baked into the
 *   albedo rather than left to the lights, so it survives a phone GPU with the
 *   shadow map switched off.
 * - **Nothing is flat.** Brick has mortar, plaster has orange-peel, snow has a
 *   blue shadow under every drift. Per-texel noise does this far better than a
 *   tiled JPEG, and it costs nothing to tune.
 * - **Faces are drawn, not modelled.** Kevin's face is a 512px canvas on the
 *   front of a sphere. This is the single highest-leverage decision in the
 *   world: no arrangement of boxes was ever going to read as a specific blond
 *   eight-year-old, and a drawn face reads as one instantly.
 *
 * Everything is cached by key and torn down by `disposeTextures()`.
 */
import * as THREE from "three";

const cache = new Map<string, THREE.Texture>();

function canvas(w: number, h: number, draw: (c: CanvasRenderingContext2D, w: number, h: number) => void) {
  const el = document.createElement("canvas");
  el.width = w;
  el.height = h;
  const ctx = el.getContext("2d")!;
  draw(ctx, w, h);
  return el;
}

function make(
  key: string,
  w: number,
  h: number,
  draw: (c: CanvasRenderingContext2D, w: number, h: number) => void,
  wrap = true,
) {
  const hit = cache.get(key);
  if (hit) return hit;
  const tex = new THREE.CanvasTexture(canvas(w, h, draw));
  if (wrap) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  else tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, tex);
  return tex;
}

/** Deterministic hash-noise: the same brick every time you open the link. */
function rnd(seed: number) {
  let s = (seed | 0) >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Speckle a surface so flat paint reads as painted rather than as a material. */
function grain(c: CanvasRenderingContext2D, w: number, h: number, amount: number, seed: number) {
  const r = rnd(seed);
  const img = c.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  c.putImageData(img, 0, 0);
}

/* ------------------------------------------------------------------ *
 * EXTERIOR
 * ------------------------------------------------------------------ */

/**
 * The red brick. 671 Lincoln Ave is a big square red-brick Georgian, and the
 * brick is the first thing anybody recognises about it, so this gets the most
 * care: five clay tones mixed per course, a mortar line that is never straight,
 * and a wash of soot in the joints.
 */
export function brick() {
  return make("brick", 512, 512, (c, w, h) => {
    c.fillStyle = "#6d6360"; // mortar
    c.fillRect(0, 0, w, h);
    const rows = 16;
    const bh = h / rows;
    const bw = w / 6;
    const clay = ["#8f4034", "#9c4a37", "#7d3529", "#a35544", "#88392c", "#733026"];
    const r = rnd(9173);
    for (let row = 0; row < rows; row++) {
      const off = row % 2 ? bw / 2 : 0;
      for (let i = -1; i < 7; i++) {
        const x = i * bw + off + 1.5;
        const y = row * bh + 1.5;
        const bwid = bw - 3;
        const bhei = bh - 3;
        c.fillStyle = clay[Math.floor(r() * clay.length)];
        c.fillRect(x, y, bwid, bhei);
        // Face variation — the fired face of a brick is never one colour.
        for (let k = 0; k < 7; k++) {
          c.fillStyle = `rgba(${r() < 0.5 ? "40,26,22" : "210,170,150"},${0.03 + r() * 0.07})`;
          c.beginPath();
          c.ellipse(x + r() * bwid, y + r() * bhei, 2 + r() * 9, 1 + r() * 4, r() * 3, 0, Math.PI * 2);
          c.fill();
        }
        // Top edge catches light, bottom edge sits in its own shadow.
        c.fillStyle = "rgba(255,225,205,0.10)";
        c.fillRect(x, y, bwid, 1.5);
        c.fillStyle = "rgba(20,10,8,0.22)";
        c.fillRect(x, y + bhei - 2, bwid, 2);
      }
    }
    grain(c, w, h, 14, 55);
  });
}

/** White painted clapboard — the trim, the porch, the neighbour houses. */
export function clapboard(tone = "#e8e4d8") {
  return make(`clap${tone}`, 256, 256, (c, w, h) => {
    c.fillStyle = tone;
    c.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 32) {
      const g = c.createLinearGradient(0, y, 0, y + 32);
      g.addColorStop(0, "rgba(0,0,0,0.16)");
      g.addColorStop(0.18, "rgba(255,255,255,0.06)");
      g.addColorStop(1, "rgba(0,0,0,0.04)");
      c.fillStyle = g;
      c.fillRect(0, y, w, 32);
    }
    grain(c, w, h, 10, 771);
  });
}

/** Asphalt shingles under a week of Illinois snow. */
export function shingles() {
  return make("shingle", 256, 256, (c, w, h) => {
    c.fillStyle = "#3a3b42";
    c.fillRect(0, 0, w, h);
    const r = rnd(4411);
    const rows = 8;
    const rh = h / rows;
    for (let row = 0; row < rows; row++) {
      const off = (row % 2) * 24;
      for (let i = -1; i < 6; i++) {
        c.fillStyle = ["#33343b", "#3d3e46", "#2c2d34", "#43444d"][Math.floor(r() * 4)];
        c.fillRect(i * 48 + off, row * rh, 46, rh - 2);
      }
      c.fillStyle = "rgba(0,0,0,0.35)";
      c.fillRect(0, row * rh + rh - 3, w, 3);
    }
    // Snow that has slid and caught on each course.
    for (let row = 0; row < rows; row++) {
      c.fillStyle = "rgba(226,236,248,0.82)";
      c.fillRect(0, row * rh, w, 5 + r() * 4);
    }
    grain(c, w, h, 12, 88);
  });
}

/**
 * Snow. The trap here is that white-on-white reads as an untextured plane, so
 * the value range is deliberately wide: near-white crust, a genuine blue in the
 * hollows, and a scatter of specular sparkle that catches the street lights.
 */
export function snow() {
  return make("snow", 512, 512, (c, w, h) => {
    c.fillStyle = "#dfe7f3";
    c.fillRect(0, 0, w, h);
    const r = rnd(2027);
    // Drifts.
    for (let i = 0; i < 200; i++) {
      const x = r() * w;
      const y = r() * h;
      const rad = 16 + r() * 70;
      const g = c.createRadialGradient(x, y, 0, x, y, rad);
      const blue = r() < 0.5;
      g.addColorStop(0, blue ? "rgba(150,172,206,0.20)" : "rgba(255,255,255,0.34)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, y, rad, 0, Math.PI * 2);
      c.fill();
    }
    // Sparkle.
    for (let i = 0; i < 900; i++) {
      c.fillStyle = `rgba(255,255,255,${0.3 + r() * 0.7})`;
      c.fillRect(r() * w, r() * h, 1 + r(), 1 + r());
    }
    grain(c, w, h, 8, 313);
  });
}

/** Ploughed street: black ice, salt, and grey slush at the kerb. */
export function street() {
  return make("street", 512, 512, (c, w, h) => {
    c.fillStyle = "#2b2d33";
    c.fillRect(0, 0, w, h);
    const r = rnd(6161);
    for (let i = 0; i < 700; i++) {
      c.fillStyle = `rgba(${r() < 0.6 ? "200,205,215" : "70,72,80"},${r() * 0.35})`;
      c.beginPath();
      c.ellipse(r() * w, r() * h, 1 + r() * 26, 1 + r() * 9, r() * 3, 0, Math.PI * 2);
      c.fill();
    }
    // Wheel tracks, snow pressed into the tread lines.
    for (const x of [130, 380]) {
      const g = c.createLinearGradient(x - 40, 0, x + 40, 0);
      g.addColorStop(0, "rgba(210,220,235,0)");
      g.addColorStop(0.5, "rgba(210,220,235,0.30)");
      g.addColorStop(1, "rgba(210,220,235,0)");
      c.fillStyle = g;
      c.fillRect(x - 40, 0, 80, h);
    }
    grain(c, w, h, 16, 1212);
  });
}

/* ------------------------------------------------------------------ *
 * INTERIOR
 * ------------------------------------------------------------------ */

/** Oak strip floor. Warm, and the single biggest contributor to "indoors". */
export function hardwood() {
  return make("wood", 512, 512, (c, w, h) => {
    c.fillStyle = "#6b431f";
    c.fillRect(0, 0, w, h);
    const r = rnd(3301);
    const pw = 64;
    for (let i = 0; i < w / pw; i++) {
      const base = ["#7a4d24", "#6a4020", "#83552a", "#5e381c", "#8a5c31"][Math.floor(r() * 5)];
      c.fillStyle = base;
      c.fillRect(i * pw, 0, pw - 1, h);
      // Grain: long thin arcs down the plank.
      for (let g2 = 0; g2 < 26; g2++) {
        c.strokeStyle = `rgba(${r() < 0.5 ? "45,25,10" : "160,115,65"},${0.05 + r() * 0.18})`;
        c.lineWidth = 0.5 + r() * 1.8;
        c.beginPath();
        const x0 = i * pw + r() * pw;
        c.moveTo(x0, 0);
        c.bezierCurveTo(x0 + (r() - 0.5) * 22, h * 0.33, x0 + (r() - 0.5) * 22, h * 0.66, x0 + (r() - 0.5) * 10, h);
        c.stroke();
      }
      // Board seam.
      c.fillStyle = "rgba(25,12,4,0.55)";
      c.fillRect(i * pw + pw - 2, 0, 2, h);
      // Butt joints, staggered, so it is not four infinite boards.
      const j = Math.floor(r() * 3) * (h / 3) + h / 3;
      c.fillRect(i * pw, j, pw, 2);
    }
    // Wax sheen.
    const g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "rgba(255,225,180,0.09)");
    g.addColorStop(0.5, "rgba(0,0,0,0.05)");
    g.addColorStop(1, "rgba(255,225,180,0.07)");
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    grain(c, w, h, 9, 707);
  });
}

/** Cut-pile carpet for the bedrooms and the stair runner. */
export function carpet(hex: string, seed = 5) {
  return make(`carpet${hex}${seed}`, 256, 256, (c, w, h) => {
    c.fillStyle = hex;
    c.fillRect(0, 0, w, h);
    const r = rnd(seed * 3931);
    for (let i = 0; i < 9000; i++) {
      const dark = r() < 0.5;
      c.fillStyle = dark ? `rgba(0,0,0,${r() * 0.22})` : `rgba(255,255,255,${r() * 0.16})`;
      c.fillRect(r() * w, r() * h, 1.6, 2.4);
    }
    grain(c, w, h, 10, seed * 31);
  });
}

/**
 * Plaster wall with a period wallpaper over it. Four prints, because a house
 * where every room has the same walls reads as a level and not as a home.
 *
 * 0 cream damask (hall) · 1 hunter-green stripe (dining) · 2 kitchen tile
 * 3 pale blue with a small print (Kevin's room)
 */
export function wallpaper(kind = 0) {
  return make(`paper${kind}`, 256, 256, (c, w, h) => {
    const r = rnd(1300 + kind * 977);
    if (kind === 2) {
      // Kitchen: glossy square tile, cream with a cornflower border.
      c.fillStyle = "#e6e0cf";
      c.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 32) {
        for (let x = 0; x < w; x += 32) {
          c.fillStyle = (x / 32 + y / 32) % 5 === 0 ? "#c3d3e8" : "#efeade";
          c.fillRect(x + 1.5, y + 1.5, 29, 29);
          c.fillStyle = "rgba(255,255,255,0.35)";
          c.fillRect(x + 1.5, y + 1.5, 29, 5);
        }
      }
      c.strokeStyle = "rgba(140,135,120,0.5)";
      c.lineWidth = 1;
      for (let y = 0; y <= h; y += 32) {
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(w, y);
        c.stroke();
      }
      for (let x = 0; x <= w; x += 32) {
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, h);
        c.stroke();
      }
      grain(c, w, h, 7, 44);
      return;
    }
    const base = kind === 0 ? "#d8cbb0" : kind === 1 ? "#2f4436" : "#c3d2e2";
    c.fillStyle = base;
    c.fillRect(0, 0, w, h);
    if (kind === 1) {
      // Vertical stripe.
      for (let x = 0; x < w; x += 24) {
        c.fillStyle = "rgba(255,240,210,0.10)";
        c.fillRect(x, 0, 10, h);
        c.fillStyle = "rgba(0,0,0,0.10)";
        c.fillRect(x + 12, 0, 3, h);
      }
    }
    // A small repeating motif — damask-ish fleur for the hall, sprigs elsewhere.
    const ink = kind === 0 ? "rgba(160,132,92,0.5)" : kind === 1 ? "rgba(200,180,130,0.28)" : "rgba(120,150,185,0.45)";
    for (let gy = 0; gy < 4; gy++) {
      for (let gx = 0; gx < 4; gx++) {
        const x = gx * 64 + 32 + (gy % 2 ? 32 : 0);
        const y = gy * 64 + 32;
        c.strokeStyle = ink;
        c.fillStyle = ink;
        c.lineWidth = 1.6;
        c.beginPath();
        c.ellipse(x, y, 9, 15, 0, 0, Math.PI * 2);
        c.stroke();
        c.beginPath();
        c.ellipse(x, y, 3.4, 6, 0, 0, Math.PI * 2);
        c.fill();
        for (const s of [-1, 1]) {
          c.beginPath();
          c.moveTo(x, y + 14);
          c.quadraticCurveTo(x + s * 16, y + 12, x + s * 13, y - 4);
          c.stroke();
        }
      }
    }
    // Plaster orange-peel under the paper, and a little age at the edges.
    for (let i = 0; i < 400; i++) {
      c.fillStyle = `rgba(0,0,0,${r() * 0.05})`;
      c.beginPath();
      c.arc(r() * w, r() * h, 1 + r() * 6, 0, Math.PI * 2);
      c.fill();
    }
    grain(c, w, h, 12, kind * 61 + 9);
  });
}

/** Flat ceiling plaster. Barely seen, but a pure colour reads as a hole. */
export function ceilingPlaster() {
  return make("ceil", 128, 128, (c, w, h) => {
    c.fillStyle = "#efe9dc";
    c.fillRect(0, 0, w, h);
    const r = rnd(818);
    for (let i = 0; i < 700; i++) {
      c.fillStyle = `rgba(0,0,0,${r() * 0.05})`;
      c.beginPath();
      c.arc(r() * w, r() * h, 0.6 + r() * 3, 0, Math.PI * 2);
      c.fill();
    }
    grain(c, w, h, 8, 3);
  });
}

/** Panelled door face — six panels, oak stain, brass plate. */
export function doorPanel(hex = "#5a3a1e") {
  return make(`door${hex}`, 128, 256, (c, w, h) => {
    c.fillStyle = hex;
    c.fillRect(0, 0, w, h);
    const r = rnd(1901);
    for (let i = 0; i < 300; i++) {
      c.strokeStyle = `rgba(${r() < 0.5 ? "30,16,6" : "150,110,60"},${r() * 0.14})`;
      c.lineWidth = 0.7;
      c.beginPath();
      const x = r() * w;
      c.moveTo(x, 0);
      c.lineTo(x + (r() - 0.5) * 14, h);
      c.stroke();
    }
    const panel = (x: number, y: number, pw: number, ph: number) => {
      c.fillStyle = "rgba(0,0,0,0.28)";
      c.fillRect(x, y, pw, ph);
      c.fillStyle = "rgba(255,220,170,0.16)";
      c.fillRect(x + 3, y + 3, pw - 6, ph - 6);
      c.fillStyle = hex;
      c.fillRect(x + 6, y + 6, pw - 12, ph - 12);
    };
    panel(18, 16, 92, 64);
    panel(18, 96, 92, 64);
    panel(18, 176, 92, 64);
    grain(c, w, h, 10, 66);
  }, false);
}

/** Fieldstone for the fireplace, and the front steps. */
export function stone() {
  return make("stone", 256, 256, (c, w, h) => {
    c.fillStyle = "#5c574f";
    c.fillRect(0, 0, w, h);
    const r = rnd(717);
    for (let i = 0; i < 90; i++) {
      const x = r() * w;
      const y = r() * h;
      const rx = 12 + r() * 26;
      const ry = 8 + r() * 16;
      c.fillStyle = ["#8a8073", "#736a5e", "#9a9083", "#645c52", "#a29684"][Math.floor(r() * 5)];
      c.beginPath();
      c.ellipse(x, y, rx, ry, r() * 3, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = "rgba(30,26,22,0.5)";
      c.lineWidth = 2;
      c.stroke();
      c.fillStyle = "rgba(255,240,220,0.10)";
      c.beginPath();
      c.ellipse(x, y - ry * 0.35, rx * 0.8, ry * 0.35, 0, 0, Math.PI * 2);
      c.fill();
    }
    grain(c, w, h, 14, 21);
  });
}

/* ------------------------------------------------------------------ *
 * FACES
 *
 * The three of them, drawn head-on into a 512 canvas that gets wrapped round
 * the front of a sphere. Everything specific about a character lives here:
 * Kevin's blond bowl cut and the eyebrows he raises at everything, Harry's
 * five o'clock shadow and gold tooth, Marv's nose and his gormless grin.
 * ------------------------------------------------------------------ */

interface FaceOpts {
  skin: string;
  shade: string;
  brow: string;
  eyeW: number;
  mouth: "flat" | "scream" | "grin" | "sneer";
  stubble?: boolean;
  gold?: boolean;
  bigNose?: boolean;
  freckles?: boolean;
}

const FACES: Record<string, FaceOpts> = {
  // Wide-open eyes, high brows, freckles. Everything about the drawing is
  // pushed young — a kid's face is eyes and forehead, an adult's is jaw.
  kevin: { skin: "#f4c9a4", shade: "#d99f78", brow: "#c99a4e", eyeW: 1.16, mouth: "flat", freckles: true },
  kevinScream: { skin: "#f4c9a4", shade: "#d99f78", brow: "#c99a4e", eyeW: 1.3, mouth: "scream", freckles: true },
  harry: { skin: "#dba97f", shade: "#b07c53", brow: "#2b1d13", eyeW: 0.86, mouth: "sneer", stubble: true, gold: true },
  marv: { skin: "#e8c39a", shade: "#c0906a", brow: "#3a2a1a", eyeW: 0.94, mouth: "grin", bigNose: true },
};

export function face(kind: keyof typeof FACES | string) {
  const o = FACES[kind] ?? FACES.kevin;
  return make(
    `face:${kind}`,
    512,
    512,
    (c, w, h) => {
      // The sphere maps u across the whole head, so the face occupies the
      // middle third and the rest is scalp/skin that the hair sits over.
      c.fillStyle = o.skin;
      c.fillRect(0, 0, w, h);
      // Soft form shading: temples and jaw fall away.
      const g = c.createRadialGradient(w / 2, h * 0.5, w * 0.1, w / 2, h * 0.5, w * 0.55);
      g.addColorStop(0, "rgba(255,240,225,0.30)");
      g.addColorStop(0.65, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(120,72,48,0.26)");
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);

      const cx = w / 2;
      const eyeY = h * 0.5;
      const eyeDx = w * 0.098;
      const eyeRx = 30 * o.eyeW;
      const eyeRy = 23 * o.eyeW;

      if (o.stubble) {
        c.fillStyle = "rgba(40,32,26,0.34)";
        c.beginPath();
        c.ellipse(cx, h * 0.705, w * 0.2, h * 0.115, 0, 0, Math.PI * 2);
        c.fill();
        const rs = rnd(4242);
        for (let i = 0; i < 1400; i++) {
          const a = rs() * Math.PI * 2;
          const rr = Math.sqrt(rs());
          const x = cx + Math.cos(a) * rr * w * 0.19;
          const y = h * 0.705 + Math.sin(a) * rr * h * 0.115;
          c.fillStyle = `rgba(25,18,12,${0.25 + rs() * 0.4})`;
          c.fillRect(x, y, 1.6, 1.6);
        }
      }

      if (o.freckles) {
        const rf = rnd(99);
        for (let i = 0; i < 40; i++) {
          const side = i % 2 ? 1 : -1;
          c.fillStyle = `rgba(180,120,80,${0.25 + rf() * 0.3})`;
          c.beginPath();
          c.arc(cx + side * (w * 0.06 + rf() * w * 0.06), h * 0.585 + rf() * h * 0.045, 1.7 + rf() * 1.7, 0, Math.PI * 2);
          c.fill();
        }
      }

      // Eyes. Sclera, iris, pupil, a catchlight — the catchlight is what makes
      // them look wet instead of printed.
      for (const s of [-1, 1]) {
        const ex = cx + s * eyeDx;
        c.fillStyle = "rgba(160,110,80,0.35)";
        c.beginPath();
        c.ellipse(ex, eyeY + eyeRy * 0.9, eyeRx * 0.9, eyeRy * 0.45, 0, 0, Math.PI * 2);
        c.fill(); // under-eye
        c.fillStyle = "#fbf7f1";
        c.beginPath();
        c.ellipse(ex, eyeY, eyeRx, eyeRy, 0, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = kind.startsWith("kevin") ? "#4b7fbd" : "#4a3a26";
        c.beginPath();
        c.arc(ex, eyeY + 1, eyeRy * 0.78, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = "#120d0a";
        c.beginPath();
        c.arc(ex, eyeY + 1, eyeRy * 0.36, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = "rgba(255,255,255,0.92)";
        c.beginPath();
        c.arc(ex - eyeRy * 0.3, eyeY - eyeRy * 0.35, eyeRy * 0.22, 0, Math.PI * 2);
        c.fill();
        // Lid line + lashes.
        c.strokeStyle = "rgba(60,38,24,0.75)";
        c.lineWidth = 4;
        c.beginPath();
        c.ellipse(ex, eyeY, eyeRx, eyeRy, 0, Math.PI * 1.05, Math.PI * 1.95);
        c.stroke();
      }

      // Brows.
      c.strokeStyle = o.brow;
      c.lineWidth = kind.startsWith("kevin") ? 7 : 12;
      c.lineCap = "round";
      for (const s of [-1, 1]) {
        const ex = cx + s * eyeDx;
        const lift = o.mouth === "scream" ? 58 : kind.startsWith("kevin") ? 52 : 40;
        c.beginPath();
        if (kind === "harry") {
          // Harry's brows come down in the middle. He is always annoyed.
          c.moveTo(ex - s * eyeRx, eyeY - lift - 8);
          c.quadraticCurveTo(ex, eyeY - lift - 12, ex + s * eyeRx, eyeY - lift + 6);
        } else {
          c.moveTo(ex - s * eyeRx, eyeY - lift + 4);
          c.quadraticCurveTo(ex, eyeY - lift - 10, ex + s * eyeRx, eyeY - lift + 2);
        }
        c.stroke();
      }

      // Nose.
      const noseY = h * 0.6;
      const nw = o.bigNose ? 30 : 18;
      c.fillStyle = o.shade;
      c.beginPath();
      c.moveTo(cx, noseY - (o.bigNose ? 52 : 34));
      c.quadraticCurveTo(cx + nw * 0.9, noseY, cx, noseY + 8);
      c.quadraticCurveTo(cx - nw * 0.9, noseY, cx, noseY - (o.bigNose ? 52 : 34));
      c.fill();
      c.fillStyle = "rgba(90,50,32,0.55)";
      for (const s of [-1, 1]) {
        c.beginPath();
        c.ellipse(cx + s * nw * 0.5, noseY + 2, 5, 3.4, 0, 0, Math.PI * 2);
        c.fill();
      }

      // Mouth.
      const my = h * 0.7;
      c.lineCap = "round";
      if (o.mouth === "scream") {
        c.fillStyle = "#5c1f22";
        c.beginPath();
        c.ellipse(cx, my, 34, 52, 0, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = "#f4efe6";
        c.fillRect(cx - 26, my - 46, 52, 13);
        c.fillStyle = "rgba(0,0,0,0.35)";
        c.beginPath();
        c.ellipse(cx, my + 26, 16, 14, 0, 0, Math.PI * 2);
        c.fill(); // tongue shadow
      } else if (o.mouth === "grin") {
        c.fillStyle = "#4a1b1e";
        c.beginPath();
        c.ellipse(cx, my, 46, 22, 0, 0, Math.PI);
        c.fill();
        c.fillStyle = "#efe6d6";
        c.fillRect(cx - 42, my, 84, 11);
        c.fillStyle = "rgba(0,0,0,0.4)";
        for (let i = -2; i <= 2; i++) c.fillRect(cx + i * 17, my, 2, 11);
      } else if (o.mouth === "sneer") {
        c.strokeStyle = "#6d3226";
        c.lineWidth = 9;
        c.beginPath();
        c.moveTo(cx - 40, my + 6);
        c.quadraticCurveTo(cx, my - 10, cx + 40, my + 12);
        c.stroke();
        if (o.gold) {
          c.fillStyle = "#d9b23a";
          c.fillRect(cx + 14, my - 2, 13, 12);
          c.fillStyle = "rgba(255,245,190,0.8)";
          c.fillRect(cx + 15, my - 1, 5, 5);
        }
      } else {
        c.strokeStyle = "#a35c48";
        c.lineWidth = 8;
        c.beginPath();
        c.moveTo(cx - 30, my);
        c.quadraticCurveTo(cx, my + 12, cx + 30, my);
        c.stroke();
      }

      // Cheeks — cold outside, and it is the last 5% of "this is a child".
      if (o.freckles) {
        for (const s of [-1, 1]) {
          const cg = c.createRadialGradient(cx + s * w * 0.16, h * 0.625, 2, cx + s * w * 0.16, h * 0.625, 48);
          cg.addColorStop(0, "rgba(214,108,92,0.42)");
          cg.addColorStop(1, "rgba(214,108,92,0)");
          c.fillStyle = cg;
          c.fillRect(cx + s * w * 0.16 - 52, h * 0.625 - 52, 104, 104);
        }
      }
    },
    false,
  );
}

/**
 * Kevin's sweater: cream with the red-and-navy Nordic band. Wrapped round a
 * torso box, so the band has to land horizontally across the chest.
 */
export function nordicSweater() {
  return make("sweater", 256, 256, (c, w, h) => {
    c.fillStyle = "#e9e0cc";
    c.fillRect(0, 0, w, h);
    const r = rnd(5150);
    // Knit texture.
    for (let y = 0; y < h; y += 4) {
      for (let x = 0; x < w; x += 4) {
        c.fillStyle = `rgba(${r() < 0.5 ? "255,255,255" : "150,138,116"},${0.06 + r() * 0.1})`;
        c.fillRect(x, y, 3, 3);
      }
    }
    // Bands.
    const band = (y: number, hgt: number, col: string) => {
      c.fillStyle = col;
      c.fillRect(0, y, w, hgt);
    };
    band(96, 8, "#a8202c");
    band(150, 8, "#a8202c");
    band(110, 34, "#2b3a63");
    // Nordic snowflake row inside the navy band.
    c.fillStyle = "#e9e0cc";
    for (let i = 0; i < 8; i++) {
      const x = i * 32 + 16;
      const y = 127;
      c.save();
      c.translate(x, y);
      for (let a = 0; a < 6; a++) {
        c.rotate(Math.PI / 3);
        c.fillRect(-1.6, -12, 3.2, 24);
        c.fillRect(-5, -8, 10, 2.6);
      }
      c.restore();
    }
    // Zig-zag above and below.
    c.strokeStyle = "#a8202c";
    c.lineWidth = 3;
    for (const y0 of [76, 178]) {
      c.beginPath();
      for (let x = 0; x <= w; x += 16) c.lineTo(x, y0 + (x / 16 % 2 ? 8 : 0));
      c.stroke();
    }
    grain(c, w, h, 8, 12);
  });
}

/** Denim, wool coats, and the burglars' knit caps all come off this one. */
export function cloth(hex: string, seed = 1, weave = 0.12) {
  return make(`cloth${hex}${seed}`, 128, 128, (c, w, h) => {
    c.fillStyle = hex;
    c.fillRect(0, 0, w, h);
    const r = rnd(seed * 4133);
    for (let y = 0; y < h; y += 3) {
      c.fillStyle = `rgba(0,0,0,${weave * 0.5})`;
      c.fillRect(0, y, w, 1);
    }
    for (let x = 0; x < w; x += 3) {
      c.fillStyle = `rgba(255,255,255,${weave * 0.35})`;
      c.fillRect(x, 0, 1, h);
    }
    for (let i = 0; i < 900; i++) {
      c.fillStyle = `rgba(${r() < 0.5 ? "255,255,255" : "0,0,0"},${r() * weave})`;
      c.fillRect(r() * w, r() * h, 2, 2);
    }
  });
}

/**
 * A lit window seen from the street — the neighbours', and the McCallister
 * house's own once you start switching lights on. Warm rectangle, a mullion
 * cross, and a curtain silhouette so it is not a glowing hole.
 */
export function litWindow(seed = 1) {
  return make(
    `lit${seed}`,
    128,
    128,
    (c, w, h) => {
      const r = rnd(seed * 313);
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#ffe6ad");
      g.addColorStop(0.6, "#ffcf82");
      g.addColorStop(1, "#e9a95c");
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      // Curtains.
      c.fillStyle = "rgba(120,70,30,0.42)";
      c.fillRect(0, 0, 22 + r() * 14, h);
      c.fillRect(w - (22 + r() * 14), 0, 40, h);
      c.fillStyle = "rgba(90,50,20,0.30)";
      c.fillRect(0, 0, w, 14);
      // Mullions.
      c.fillStyle = "#3a2a18";
      c.fillRect(w / 2 - 3, 0, 6, h);
      c.fillRect(0, h / 2 - 3, w, 6);
      c.fillRect(0, 0, 7, h);
      c.fillRect(w - 7, 0, 7, h);
      c.fillRect(0, 0, w, 7);
      c.fillRect(0, h - 7, w, 7);
    },
    false,
  );
}

/** A dark window: cold glass with a sky reflection in it. */
export function darkWindow(seed = 1) {
  return make(
    `dark${seed}`,
    128,
    128,
    (c, w, h) => {
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#243044");
      g.addColorStop(1, "#0e141f");
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      const r = rnd(seed * 71);
      c.fillStyle = "rgba(150,180,220,0.10)";
      c.beginPath();
      c.moveTo(0, h * (0.2 + r() * 0.3));
      c.lineTo(w, 0);
      c.lineTo(w, h * 0.4);
      c.lineTo(0, h * 0.8);
      c.fill();
      c.fillStyle = "#2c2418";
      c.fillRect(w / 2 - 3, 0, 6, h);
      c.fillRect(0, h / 2 - 3, w, 6);
      c.fillRect(0, 0, 7, h);
      c.fillRect(w - 7, 0, 7, h);
      c.fillRect(0, 0, w, 7);
      c.fillRect(0, h - 7, w, 7);
    },
    false,
  );
}

/** The winter night sky: deep blue at the zenith, sodium haze at the horizon. */
export function nightSky() {
  return make(
    "sky",
    64,
    256,
    (c, w, h) => {
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0.0, "#05070f");
      g.addColorStop(0.42, "#101a33");
      g.addColorStop(0.72, "#27334f");
      g.addColorStop(0.9, "#5a5468");
      g.addColorStop(1.0, "#7d6a63");
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      const r = rnd(2112);
      for (let i = 0; i < 220; i++) {
        const y = r() * h * 0.6;
        c.fillStyle = `rgba(255,255,245,${(1 - y / (h * 0.6)) * (0.2 + r() * 0.7)})`;
        c.fillRect(r() * w, y, 1, 1);
      }
    },
    false,
  );
}

/** A single soft round blob — snowflakes, sparks, and the dust in a torchbeam. */
export function softDot() {
  return make(
    "dot",
    64,
    64,
    (c, w, h) => {
      const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.35, "rgba(255,255,255,0.7)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    },
    false,
  );
}

/**
 * A framed family photograph. Eight of these go up the stairs and along the
 * landing, and they are the cheapest possible way to say *nine people live
 * here*. Faces are three dots and a curve at this size; what reads is the
 * arrangement — a row of adults with a row of smaller heads in front.
 */
export function familyPhoto(seed = 1) {
  return make(
    `photo${seed}`,
    192,
    144,
    (c, w, h) => {
      const r = rnd(seed * 6247 + 11);
      // Warm 1980s print stock: never white, always a bit orange and faded.
      c.fillStyle = "#d9c9a8";
      c.fillRect(0, 0, w, h);
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "rgba(190,150,90,0.35)");
      g.addColorStop(1, "rgba(60,40,20,0.18)");
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      // A wall or a hedge behind them.
      c.fillStyle = r() < 0.5 ? "#7e8a5e" : "#8a7a63";
      c.fillRect(0, 0, w, h * 0.55);
      const skins = ["#e8c39c", "#f0cba6", "#d9ab7f", "#eac194"];
      const tops = ["#9c3b3b", "#3b5b9c", "#3b7a4a", "#8a6ca8", "#c0a24a", "#5c5c66"];
      const person = (x: number, base: number, scale: number) => {
        const hr = 9 * scale;
        c.fillStyle = tops[Math.floor(r() * tops.length)];
        c.fillRect(x - 11 * scale, base - 30 * scale, 22 * scale, 32 * scale);
        c.fillStyle = skins[Math.floor(r() * skins.length)];
        c.beginPath();
        c.arc(x, base - 34 * scale, hr, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = ["#3a2a18", "#6b4a24", "#1d1510", "#c9a24a"][Math.floor(r() * 4)];
        c.beginPath();
        c.arc(x, base - 36 * scale, hr, Math.PI, Math.PI * 2);
        c.fill();
        c.fillStyle = "rgba(40,25,15,0.75)";
        c.fillRect(x - 3.4 * scale, base - 36 * scale, 1.8 * scale, 1.8 * scale);
        c.fillRect(x + 1.6 * scale, base - 36 * scale, 1.8 * scale, 1.8 * scale);
        c.strokeStyle = "rgba(120,50,40,0.8)";
        c.lineWidth = 1.4 * scale;
        c.beginPath();
        c.arc(x, base - 31 * scale, 3.4 * scale, 0.2, Math.PI - 0.2);
        c.stroke();
      };
      const backs = 3 + Math.floor(r() * 2);
      for (let i = 0; i < backs; i++) person(w * (0.2 + (i / (backs - 1)) * 0.6), h * 0.82, 1);
      const fronts = 2 + Math.floor(r() * 3);
      for (let i = 0; i < fronts; i++) person(w * (0.24 + (i / Math.max(1, fronts - 1)) * 0.52), h * 0.98, 0.72);
      // Print wear.
      grain(c, w, h, 22, seed * 13);
      c.fillStyle = "rgba(255,240,210,0.10)";
      c.fillRect(0, 0, w, h * 0.2);
    },
    false,
  );
}

/**
 * The hall mirror. There is no reflection probe here and there is not going to
 * be one, so this is a *painted* reflection: a dark vertical smear of the hall
 * behind you, a bright rectangle where the fanlight is, and a lot of silvering.
 * At the angles you ever see it from, that reads as a mirror; a flat grey
 * rectangle reads as a hole in the wall.
 */
export function mirrorGlass() {
  return make(
    "mirror",
    128,
    192,
    (c, w, h) => {
      const g = c.createLinearGradient(0, 0, w * 0.7, h);
      g.addColorStop(0, "#4a4f5c");
      g.addColorStop(0.45, "#2b303b");
      g.addColorStop(1, "#171b24");
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      // A doorway and a warm lamp, blurred to nothing.
      c.fillStyle = "rgba(255,210,150,0.20)";
      c.fillRect(w * 0.18, h * 0.12, w * 0.24, h * 0.34);
      c.fillStyle = "rgba(255,225,180,0.12)";
      c.beginPath();
      c.ellipse(w * 0.72, h * 0.3, w * 0.2, h * 0.12, 0, 0, Math.PI * 2);
      c.fill();
      // Silvering, foxed at the edges as old mirrors are.
      const r = rnd(4242);
      for (let i = 0; i < 160; i++) {
        const x = r() * w;
        const y = r() * h;
        const edge = Math.min(x, y, w - x, h - y) / (w * 0.5);
        c.fillStyle = `rgba(90,90,80,${(1 - Math.min(1, edge)) * 0.35 * r()})`;
        c.beginPath();
        c.arc(x, y, 1 + r() * 7, 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = "rgba(255,255,255,0.06)";
      c.beginPath();
      c.moveTo(0, h * 0.75);
      c.lineTo(w, h * 0.1);
      c.lineTo(w, h * 0.3);
      c.lineTo(0, h * 0.95);
      c.fill();
    },
    false,
  );
}

/**
 * A frame of the black-and-white gangster picture on the television.
 *
 * Three frames, cycled. It only ever occupies about eighty pixels on screen,
 * so what has to read is *black and white, hard contrast, a man in a hat* —
 * and that is enough for anybody to know exactly which film Kevin is watching.
 */
export function filmFrame(i: number) {
  return make(
    `film${i}`,
    128,
    96,
    (c, w, h) => {
      c.fillStyle = "#12120f";
      c.fillRect(0, 0, w, h);
      const r = rnd(900 + i * 37);
      // Key light from the left, hard.
      const g = c.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, "rgba(230,230,220,0.5)");
      g.addColorStop(0.55, "rgba(120,120,115,0.12)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      // Two men: hat, shoulders, and on frame 2 a muzzle flash.
      const man = (x: number, s: number) => {
        c.fillStyle = "#0a0a09";
        c.fillRect(x - 15 * s, h - 46 * s, 30 * s, 46 * s);
        c.beginPath();
        c.arc(x, h - 48 * s, 9 * s, 0, Math.PI * 2);
        c.fill();
        c.fillRect(x - 16 * s, h - 56 * s, 32 * s, 5 * s); // brim
        c.fillRect(x - 9 * s, h - 64 * s, 18 * s, 9 * s); // crown
      };
      man(w * 0.32, 1);
      man(w * 0.72, 0.92);
      if (i === 1) {
        c.fillStyle = "rgba(255,255,240,0.95)";
        c.beginPath();
        c.arc(w * 0.52, h * 0.52, 13, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = "rgba(255,255,255,0.35)";
        c.fillRect(0, 0, w, h);
      }
      // Print damage and scan lines.
      for (let y = 0; y < h; y += 2) {
        c.fillStyle = "rgba(0,0,0,0.18)";
        c.fillRect(0, y, w, 1);
      }
      for (let k = 0; k < 40; k++) {
        c.fillStyle = `rgba(255,255,255,${r() * 0.25})`;
        c.fillRect(r() * w, r() * h, 1, 1 + r() * 3);
      }
    },
    false,
  );
}

export function disposeTextures() {
  cache.forEach((t) => t.dispose());
  cache.clear();
}
