/**
 * Every surface in the building is drawn here, into a 2D canvas, at boot.
 *
 * No image files. Partly because a world that ships zero bytes of art can be
 * edited by changing a number, but mostly because the look of this place is
 * *grime* — the checkerboard is never clean, the wallpaper is never flat, and
 * hand-authored noise per texel does that far better than a tiled JPEG.
 *
 * Everything returns a THREE.Texture with `dispose()` owned by the caller;
 * `disposeTextures()` at the bottom tears down the whole cache.
 */
import * as THREE from "three";

const cache = new Map<string, THREE.Texture>();

function canvas(size: number, draw: (c: CanvasRenderingContext2D, s: number) => void) {
  const el = document.createElement("canvas");
  el.width = el.height = size;
  const ctx = el.getContext("2d")!;
  draw(ctx, size);
  return el;
}

function make(key: string, size: number, draw: (c: CanvasRenderingContext2D, s: number) => void) {
  const hit = cache.get(key);
  if (hit) return hit;
  const tex = new THREE.CanvasTexture(canvas(size, draw));
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}

/** Deterministic hash-noise — same wallpaper every night, like a real building. */
function rnd(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Speckle a surface so flat paint reads as painted rather than as a material. */
function grain(c: CanvasRenderingContext2D, s: number, amount: number, seed: number) {
  const r = rnd(seed);
  const img = c.getImageData(0, 0, s, s);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  c.putImageData(img, 0, 0);
}

/**
 * The checkerboard. Black-and-white 2x2 tiles per texture tile, worn at the
 * grout lines — the wear is what stops it looking like a shader demo.
 */
export function tileFloor() {
  return make("floor", 512, (c, s) => {
    const half = s / 2;
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        const dark = (tx + ty) % 2 === 0;
        c.fillStyle = dark ? "#12131a" : "#c9c6bb";
        c.fillRect(tx * half, ty * half, half, half);
        // Mottling inside each tile: cheap lino never takes colour evenly.
        const r = rnd(tx * 977 + ty * 31 + 7);
        for (let i = 0; i < 260; i++) {
          const a = r() * 0.07;
          c.fillStyle = dark ? `rgba(120,124,150,${a})` : `rgba(60,58,52,${a})`;
          const px = tx * half + r() * half;
          const py = ty * half + r() * half;
          c.beginPath();
          c.ellipse(px, py, 2 + r() * 22, 2 + r() * 14, r() * 3, 0, Math.PI * 2);
          c.fill();
        }
      }
    }
    // Grout, and the dirt that collects in it.
    c.strokeStyle = "rgba(20,20,26,0.55)";
    c.lineWidth = 3;
    c.strokeRect(0, 0, half, half);
    c.strokeRect(half, 0, half, half);
    c.strokeRect(0, half, half, half);
    c.strokeRect(half, half, half, half);
    grain(c, s, 16, 4242);
  });
}

/**
 * The wallpaper: blue-grey, vertical pinstripe, and the confetti-and-star
 * print that every one of these places had in 1993.
 */
export function wallpaper(seed = 1) {
  return make(`wall${seed}`, 512, (c, s) => {
    c.fillStyle = "#222939";
    c.fillRect(0, 0, s, s);
    // Pinstripes.
    for (let x = 0; x < s; x += 32) {
      const g = c.createLinearGradient(x, 0, x + 32, 0);
      g.addColorStop(0, "rgba(255,255,255,0.045)");
      g.addColorStop(0.5, "rgba(0,0,0,0.05)");
      g.addColorStop(1, "rgba(255,255,255,0.045)");
      c.fillStyle = g;
      c.fillRect(x, 0, 32, s);
    }
    // Confetti + stars.
    const r = rnd(seed * 7919);
    const colors = ["#e8465e", "#f2c14e", "#4fb3d9", "#7bc86c", "#c47ad0"];
    for (let i = 0; i < 52; i++) {
      const x = r() * s;
      const y = r() * s;
      c.fillStyle = colors[Math.floor(r() * colors.length)];
      c.globalAlpha = 0.5 + r() * 0.3;
      if (r() < 0.4) {
        // five-point star
        c.save();
        c.translate(x, y);
        c.rotate(r() * Math.PI);
        c.beginPath();
        const R = 5 + r() * 5;
        for (let k = 0; k < 10; k++) {
          const rad = k % 2 ? R * 0.45 : R;
          const a = (k / 10) * Math.PI * 2 - Math.PI / 2;
          if (k) c.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
          else c.moveTo(Math.cos(a) * rad, Math.sin(a) * rad);
        }
        c.closePath();
        c.fill();
        c.restore();
      } else {
        c.save();
        c.translate(x, y);
        c.rotate(r() * Math.PI);
        c.fillRect(-4, -1.5, 8 + r() * 6, 3);
        c.restore();
      }
    }
    c.globalAlpha = 1;
    // Scuffs, scattered rather than graded. A vertical gradient was the first
    // attempt and it tiled: every wall grew a grey band across its middle.
    const sc = rnd(seed * 401 + 3);
    for (let i = 0; i < 40; i++) {
      c.fillStyle = `rgba(0,0,0,${0.05 + sc() * 0.13})`;
      c.beginPath();
      c.ellipse(sc() * s, sc() * s, 6 + sc() * 40, 3 + sc() * 12, sc() * 3, 0, Math.PI * 2);
      c.fill();
    }
    grain(c, s, 12, seed * 131);
  });
}

/** Ceiling: acoustic tile, water-stained. */
export function ceilingTile() {
  return make("ceil", 256, (c, s) => {
    c.fillStyle = "#3a3b40";
    c.fillRect(0, 0, s, s);
    const r = rnd(99);
    for (let i = 0; i < 2200; i++) {
      c.fillStyle = `rgba(0,0,0,${r() * 0.18})`;
      c.fillRect(r() * s, r() * s, 2, 2);
    }
    c.strokeStyle = "rgba(20,20,20,0.7)";
    c.lineWidth = 4;
    c.strokeRect(0, 0, s, s);
    // One stain, off-centre, because a perfectly clean ceiling reads as new.
    const g = c.createRadialGradient(s * 0.66, s * 0.3, 4, s * 0.66, s * 0.3, s * 0.34);
    g.addColorStop(0, "rgba(120,95,50,0.5)");
    g.addColorStop(1, "rgba(120,95,50,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);
  });
}

/** Stage carpet — deep red, worn where the three of them stand. */
export function stageCarpet() {
  return make("stagecarpet", 256, (c, s) => {
    c.fillStyle = "#5c1620";
    c.fillRect(0, 0, s, s);
    const r = rnd(5150);
    for (let i = 0; i < 6000; i++) {
      const a = r() * 0.16;
      c.fillStyle = r() < 0.5 ? `rgba(255,180,180,${a})` : `rgba(0,0,0,${a})`;
      c.fillRect(r() * s, r() * s, 2, 3);
    }
  });
}

/** Wood: the desk, the stage skirt, the bar counter. */
export function wood(tint = "#6b4a2c") {
  return make(`wood${tint}`, 256, (c, s) => {
    c.fillStyle = tint;
    c.fillRect(0, 0, s, s);
    const r = rnd(1234);
    for (let i = 0; i < 70; i++) {
      c.strokeStyle = `rgba(0,0,0,${0.04 + r() * 0.12})`;
      c.lineWidth = 1 + r() * 3;
      c.beginPath();
      const y = r() * s;
      c.moveTo(0, y);
      c.bezierCurveTo(s * 0.3, y + (r() - 0.5) * 18, s * 0.7, y + (r() - 0.5) * 18, s, y + (r() - 0.5) * 8);
      c.stroke();
    }
    grain(c, s, 14, 77);
  });
}

/** Kitchen / restroom tiling — small white square tile, dirty grout. */
export function smallTile(base = "#b9bcae") {
  return make(`smalltile${base}`, 256, (c, s) => {
    c.fillStyle = "#4b4a45";
    c.fillRect(0, 0, s, s);
    const n = 8;
    const cell = s / n;
    const r = rnd(31337);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        c.fillStyle = base;
        c.globalAlpha = 0.82 + r() * 0.18;
        c.fillRect(x * cell + 1.5, y * cell + 1.5, cell - 3, cell - 3);
      }
    }
    c.globalAlpha = 1;
    grain(c, s, 18, 8);
  });
}

/**
 * The posters. Five of them, drawn as flat kid-art because that is exactly
 * what they were — crayon animatronics and a slogan in a font nobody licensed.
 */
export type PosterKind = "celebrate" | "band" | "foxy" | "kids" | "rules" | "missing";

export function poster(kind: PosterKind) {
  return make(`poster-${kind}`, 512, (c, s) => {
    c.fillStyle = "#e9e3cf";
    c.fillRect(0, 0, s, s);

    // Everybody on a poster shares one face, the way kid-art does: a round
    // head, a pale muzzle, two big eyes. What tells them apart is what sits on
    // top of it, which is also how you tell them apart on the cameras.
    const face = (cx: number, cy: number, R: number, fur: string, muzzle = true) => {
      c.fillStyle = fur;
      c.beginPath();
      c.arc(cx, cy, R, 0, Math.PI * 2);
      c.fill();
      if (muzzle) {
        c.fillStyle = "rgba(255,255,255,0.28)";
        c.beginPath();
        c.ellipse(cx, cy + R * 0.32, R * 0.62, R * 0.42, 0, 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = "#fff";
      c.beginPath();
      c.arc(cx - R * 0.36, cy - R * 0.2, R * 0.2, 0, Math.PI * 2);
      c.arc(cx + R * 0.36, cy - R * 0.2, R * 0.2, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#111";
      c.beginPath();
      c.arc(cx - R * 0.34, cy - R * 0.18, R * 0.09, 0, Math.PI * 2);
      c.arc(cx + R * 0.34, cy - R * 0.18, R * 0.09, 0, Math.PI * 2);
      c.fill();
    };
    const smile = (cx: number, cy: number, R: number) => {
      c.fillStyle = "#111";
      c.beginPath();
      c.ellipse(cx, cy + R * 0.14, R * 0.13, R * 0.1, 0, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = "#111";
      c.lineWidth = R * 0.07;
      c.beginPath();
      c.arc(cx, cy + R * 0.3, R * 0.34, 0.2 * Math.PI, 0.8 * Math.PI);
      c.stroke();
    };
    const bowTie = (cx: number, cy: number, R: number, color: string) => {
      c.fillStyle = color;
      c.beginPath();
      c.moveTo(cx, cy + R * 0.92);
      c.lineTo(cx - R * 0.32, cy + R * 0.74);
      c.lineTo(cx - R * 0.32, cy + R * 1.1);
      c.closePath();
      c.moveTo(cx, cy + R * 0.92);
      c.lineTo(cx + R * 0.32, cy + R * 0.74);
      c.lineTo(cx + R * 0.32, cy + R * 1.1);
      c.closePath();
      c.fill();
    };

    /** Freddy: round ears, top hat, bow tie. The only bear in the band. */
    const bear = (cx: number, cy: number, R: number, fur: string, hat: boolean, accent: string) => {
      c.fillStyle = fur;
      c.beginPath();
      c.arc(cx - R * 0.72, cy - R * 0.66, R * 0.34, 0, Math.PI * 2);
      c.arc(cx + R * 0.72, cy - R * 0.66, R * 0.34, 0, Math.PI * 2);
      c.fill();
      face(cx, cy, R, fur);
      smile(cx, cy, R);
      if (hat) {
        c.fillStyle = "#1b1b22";
        c.fillRect(cx - R * 0.85, cy - R * 1.02, R * 1.7, R * 0.16);
        c.fillRect(cx - R * 0.5, cy - R * 1.62, R * 1.0, R * 0.62);
        c.fillStyle = accent;
        c.fillRect(cx - R * 0.5, cy - R * 1.2, R * 1.0, R * 0.14);
      }
      bowTie(cx, cy, R, accent);
    };

    /**
     * Bonnie: a rabbit. Two tall ears standing straight off the crown with a
     * lining just off the fur tone (as on the model, where a bright lining made
     * them glow), a red bow tie, and the buck teeth.
     */
    const bunny = (cx: number, cy: number, R: number) => {
      const fur = "#6b4f9e";
      const lining = "#8a6fbc";
      for (const s of [-1, 1]) {
        c.save();
        c.translate(cx + s * R * 0.42, cy - R * 0.7);
        c.rotate(s * 0.12);
        c.fillStyle = fur;
        c.beginPath();
        c.ellipse(0, -R * 0.75, R * 0.24, R * 0.9, 0, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = lining;
        c.beginPath();
        c.ellipse(0, -R * 0.72, R * 0.11, R * 0.66, 0, 0, Math.PI * 2);
        c.fill();
        c.restore();
      }
      face(cx, cy, R, fur);
      smile(cx, cy, R);
      // Buck teeth, the one detail every kid draws on a rabbit.
      c.fillStyle = "#fff";
      c.fillRect(cx - R * 0.13, cy + R * 0.52, R * 0.12, R * 0.16);
      c.fillRect(cx + R * 0.01, cy + R * 0.52, R * 0.12, R * 0.16);
      bowTie(cx, cy, R, "#d8324a");
    };

    /**
     * Chica: a chicken. No ears at all (she had a bear's once, on the model,
     * and it was most of why she read wrong): three feathers on the crown, a
     * wide orange beak where the muzzle would be, and the bib.
     */
    const chick = (cx: number, cy: number, R: number) => {
      const fur = "#e0c33a";
      c.fillStyle = fur;
      for (let i = -1; i <= 1; i++) {
        c.save();
        c.translate(cx + i * R * 0.3, cy - R * 0.8);
        c.rotate(i * 0.45);
        c.beginPath();
        c.ellipse(0, -R * 0.32, R * 0.13, R * 0.42, 0, 0, Math.PI * 2);
        c.fill();
        c.restore();
      }
      face(cx, cy, R, fur, false);
      // The bill: an upper and a lower half, so it reads as a beak and not a nose.
      c.fillStyle = "#ee8f2c";
      c.beginPath();
      c.moveTo(cx - R * 0.42, cy + R * 0.12);
      c.quadraticCurveTo(cx, cy - R * 0.02, cx + R * 0.42, cy + R * 0.12);
      c.quadraticCurveTo(cx, cy + R * 0.5, cx - R * 0.42, cy + R * 0.12);
      c.fill();
      c.fillStyle = "#d4701f";
      c.beginPath();
      c.moveTo(cx - R * 0.3, cy + R * 0.3);
      c.quadraticCurveTo(cx, cy + R * 0.66, cx + R * 0.3, cy + R * 0.3);
      c.quadraticCurveTo(cx, cy + R * 0.4, cx - R * 0.3, cy + R * 0.3);
      c.fill();
      // The bib, under the chin. Too small to read, which is right for a poster.
      c.fillStyle = "#f0ead4";
      c.beginPath();
      c.moveTo(cx - R * 0.62, cy + R * 0.82);
      c.lineTo(cx + R * 0.62, cy + R * 0.82);
      c.lineTo(cx + R * 0.48, cy + R * 1.34);
      c.lineTo(cx - R * 0.48, cy + R * 1.34);
      c.closePath();
      c.fill();
      c.fillStyle = "#c8202c";
      c.font = `bold ${R * 0.26}px Impact, sans-serif`;
      c.textAlign = "center";
      c.fillText("LET'S EAT!", cx, cy + R * 1.16);
    };

    if (kind === "celebrate") {
      const g = c.createLinearGradient(0, 0, 0, s);
      g.addColorStop(0, "#f4ecd2");
      g.addColorStop(1, "#d9cfae");
      c.fillStyle = g;
      c.fillRect(0, 0, s, s);
      bear(s / 2, s * 0.45, s * 0.19, "#8a5a2b", true, "#111");
      c.fillStyle = "#c02638";
      c.font = `bold ${s * 0.15}px Impact, sans-serif`;
      c.textAlign = "center";
      c.fillText("CELEBRATE!", s / 2, s * 0.88);
    } else if (kind === "band") {
      c.fillStyle = "#1f2a3d";
      c.fillRect(0, 0, s, s);
      bear(s * 0.28, s * 0.46, s * 0.12, "#8a5a2b", true, "#111");
      bunny(s * 0.55, s * 0.5, s * 0.12);
      chick(s * 0.82, s * 0.5, s * 0.12);
      c.fillStyle = "#f2c14e";
      c.font = `bold ${s * 0.085}px Impact, sans-serif`;
      c.textAlign = "center";
      c.fillText("THE FAZBEAR BAND", s / 2, s * 0.86);
    } else if (kind === "foxy") {
      c.fillStyle = "#26333f";
      c.fillRect(0, 0, s, s);
      // A crude pirate fox, all triangles.
      c.fillStyle = "#a33726";
      c.beginPath();
      c.moveTo(s * 0.5, s * 0.18);
      c.lineTo(s * 0.26, s * 0.56);
      c.lineTo(s * 0.74, s * 0.56);
      c.closePath();
      c.fill();
      c.fillStyle = "#f5e9c8";
      c.beginPath();
      c.arc(s * 0.42, s * 0.42, s * 0.05, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#111";
      c.beginPath();
      c.arc(s * 0.42, s * 0.42, s * 0.02, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#111";
      c.fillRect(s * 0.5, s * 0.36, s * 0.16, s * 0.12);
      c.fillStyle = "#f2c14e";
      c.font = `bold ${s * 0.105}px Impact, sans-serif`;
      c.textAlign = "center";
      c.fillText("PIRATE COVE", s / 2, s * 0.76);
      c.font = `bold ${s * 0.07}px Impact, sans-serif`;
      c.fillStyle = "#e8465e";
      c.fillText("SORRY! OUT OF ORDER", s / 2, s * 0.87);
    } else if (kind === "kids") {
      c.fillStyle = "#efe7cd";
      c.fillRect(0, 0, s, s);
      const r = rnd(808);
      // Children's crayon drawings, pinned in a grid.
      for (let i = 0; i < 4; i++) {
        const px = (i % 2) * s * 0.5 + s * 0.06;
        const py = Math.floor(i / 2) * s * 0.5 + s * 0.06;
        c.fillStyle = "#fffdf2";
        c.fillRect(px, py, s * 0.38, s * 0.38);
        c.strokeStyle = "rgba(0,0,0,0.25)";
        c.strokeRect(px, py, s * 0.38, s * 0.38);
        c.lineWidth = 4;
        for (let k = 0; k < 5; k++) {
          c.strokeStyle = ["#e8465e", "#4fb3d9", "#7bc86c", "#f2c14e", "#6b3f9e"][k];
          c.beginPath();
          c.moveTo(px + r() * s * 0.35, py + r() * s * 0.35);
          c.lineTo(px + r() * s * 0.35, py + r() * s * 0.35);
          c.lineTo(px + r() * s * 0.35, py + r() * s * 0.35);
          c.stroke();
        }
        c.fillStyle = "#8a5a2b";
        c.beginPath();
        c.arc(px + s * 0.19, py + s * 0.19, s * 0.07, 0, Math.PI * 2);
        c.fill();
      }
    } else if (kind === "rules") {
      c.fillStyle = "#f6f2e2";
      c.fillRect(0, 0, s, s);
      c.strokeStyle = "#2b3347";
      c.lineWidth = 8;
      c.strokeRect(14, 14, s - 28, s - 28);
      c.fillStyle = "#222939";
      c.font = `bold ${s * 0.085}px Impact, sans-serif`;
      c.textAlign = "center";
      c.fillText("RULES FOR SAFETY", s / 2, s * 0.16);
      c.font = `${s * 0.058}px Georgia, serif`;
      c.textAlign = "left";
      const rules = [
        "1. Don't run",
        "2. Don't yell",
        "3. Don't scream",
        "4. Don't poop on floor",
        "5. Stay close to mom",
        "6. Don't touch Freddy",
        "7. Don't hit",
        "8. Leave before dark",
      ];
      rules.forEach((t, i) => c.fillText(t, s * 0.12, s * 0.28 + i * s * 0.085));
    } else {
      // "missing" — the newspaper clipping, deliberately unreadable.
      c.fillStyle = "#d8d2c0";
      c.fillRect(0, 0, s, s);
      c.fillStyle = "#2a2a2a";
      c.font = `bold ${s * 0.11}px Georgia, serif`;
      c.textAlign = "center";
      c.fillText("FIVE MISSING", s / 2, s * 0.16);
      c.font = `${s * 0.05}px Georgia, serif`;
      const r = rnd(6);
      for (let i = 0; i < 22; i++) {
        c.fillStyle = `rgba(40,40,40,${0.35 + r() * 0.3})`;
        c.fillRect(s * 0.1, s * 0.24 + i * s * 0.03, s * 0.8 * (0.5 + r() * 0.5), 4);
      }
      c.fillStyle = "rgba(120,90,50,0.25)";
      c.fillRect(0, 0, s, s);
    }
    grain(c, s, 16, 5);
  });
}

/** The camera monitor's own screen, when it is showing nothing. */
export function staticNoise(seed: number) {
  return make(`static${seed}`, 256, (c, s) => {
    const r = rnd(seed * 313 + 1);
    const img = c.createImageData(s, s);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = r() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  });
}

export function disposeTextures() {
  cache.forEach((t) => t.dispose());
  cache.clear();
}
