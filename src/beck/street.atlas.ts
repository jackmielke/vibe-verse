/**
 * Everything printed at the side of a Beck Road: the county's green street
 * blades, the regulatory signs, the reflective digits on a mailbox, the
 * beach access board. All of it is drawn once into a single canvas atlas and
 * shown on quads merged into one geometry, so a hundred and fifty printed
 * surfaces cost one texture and one draw call instead of one of each.
 */
import * as THREE from "three";

export interface Cell {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** Shelf-packed canvas atlas. Cells are allocated top-down in rows of equal height. */
export class SignAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  private shelfY = 0;
  private shelfH = 0;
  private shelfX = 0;
  private cache = new Map<string, Cell>();

  constructor(readonly w = 2048, readonly h = 3072) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
  }

  /** Draw into a fresh cell (or reuse the one already drawn for `key`). */
  cell(key: string, cw: number, ch: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): Cell {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const pad = 4;
    if (this.shelfH === 0 || this.shelfX + cw + pad > this.w || ch + pad > this.shelfH) {
      this.shelfY += this.shelfH;
      this.shelfH = ch + pad;
      this.shelfX = 0;
    }
    if (this.shelfY + ch + pad > this.h) {
      // Out of room: reuse the first cell rather than draw off the canvas.
      const first = this.cache.values().next().value as Cell | undefined;
      if (first) return first;
    }
    const x = this.shelfX;
    const y = this.shelfY;
    this.shelfX += cw + pad;
    const g = this.ctx;
    g.save();
    g.translate(x, y);
    g.beginPath();
    g.rect(0, 0, cw, ch);
    g.clip();
    g.clearRect(0, 0, cw, ch);
    draw(g, cw, ch);
    g.restore();
    // Canvas y runs down; texture v runs up.
    const c: Cell = { u0: x / this.w, v0: 1 - (y + ch) / this.h, u1: (x + cw) / this.w, v1: 1 - y / this.h };
    this.cache.set(key, c);
    return c;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/** Quads referencing the atlas, merged into one geometry. */
export class SignQuads {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private idx: number[] = [];
  private n = 0;

  /**
   * A quad centred at `c`, spanning `right` (unit) by `w` and `up` (unit) by `h`.
   * Its normal is right x up. `mirror` flips the image so the back of a
   * two-sided sign still reads left to right.
   */
  add(c: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, w: number, h: number, cell: Cell, mirror = false): void {
    const nx = right.y * up.z - right.z * up.y;
    const ny = right.z * up.x - right.x * up.z;
    const nz = right.x * up.y - right.y * up.x;
    const hw = w / 2;
    const hh = h / 2;
    const corners = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ];
    const us = mirror ? [cell.u1, cell.u0, cell.u0, cell.u1] : [cell.u0, cell.u1, cell.u1, cell.u0];
    const vs = [cell.v0, cell.v0, cell.v1, cell.v1];
    for (let i = 0; i < 4; i++) {
      const [a, b] = corners[i];
      this.pos.push(c.x + right.x * a + up.x * b, c.y + right.y * a + up.y * b, c.z + right.z * a + up.z * b);
      this.nrm.push(nx, ny, nz);
      this.uv.push(us[i], vs[i]);
    }
    const k = this.n;
    this.idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
    this.n += 4;
  }

  /** A sign printed on both faces (a street blade), or with a plain back. */
  addTwoSided(c: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, w: number, h: number, front: Cell, back: Cell, mirrorBack: boolean): void {
    this.add(c, right, up, w, h, front);
    const r2 = right.clone().negate();
    this.add(c.clone().addScaledVector(right.clone().cross(up), -0.004), r2, up, w, h, back, mirrorBack);
  }

  get count(): number {
    return this.n / 4;
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setIndex(this.idx);
    return geo;
  }
}

// ---- The faces -------------------------------------------------------------

const GREEN = "#0f5f36";
const WHITE = "#f4f4f0";
const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";

function fit(g: CanvasRenderingContext2D, text: string, maxW: number, px: number, weight = "bold"): void {
  let size = px;
  do {
    g.font = `${weight} ${size}px ${FONT}`;
    if (g.measureText(text).width <= maxW) break;
    size -= 2;
  } while (size > 10);
}

/** Kitsap County street blade: green, white border, the county's abbreviations, the suffix smaller. */
export function bladeFace(atlas: SignAtlas, name: string): Cell {
  return atlas.cell(`blade:${name}`, 448, 112, (g, w, h) => {
    g.fillStyle = GREEN;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = WHITE;
    g.lineWidth = 5;
    g.strokeRect(6, 6, w - 12, h - 12);
    g.fillStyle = WHITE;
    g.textBaseline = "middle";
    // Split "NE Beck Rd" into prefix, body, suffix so the small parts read like the real blades.
    const parts = name.toUpperCase().split(" ");
    const dirs = new Set(["NE", "NW", "SE", "SW", "N", "S", "E", "W"]);
    const sufs = new Set(["RD", "AVE", "DR", "LN", "CT", "PL", "ST", "WAY", "LOOP"]);
    let pre = "";
    let suf = "";
    if (parts.length > 1 && dirs.has(parts[0])) pre = parts.shift()!;
    if (parts.length > 1 && dirs.has(parts[parts.length - 1])) suf = parts.pop()!;
    if (parts.length > 1 && sufs.has(parts[parts.length - 1])) suf = (parts.pop()! + " " + suf).trim();
    const body = parts.join(" ");
    g.font = `bold 40px ${FONT}`;
    const preW = pre ? g.measureText(pre).width + 12 : 0;
    const sufW = suf ? g.measureText(suf).width + 12 : 0;
    fit(g, body, w - 40 - preW - sufW, 74);
    const bodyW = g.measureText(body).width;
    const total = preW + bodyW + sufW;
    let x = (w - total) / 2;
    if (pre) {
      g.font = `bold 40px ${FONT}`;
      g.textAlign = "left";
      g.fillText(pre, x, h / 2 + 2);
      x += preW;
    }
    fit(g, body, w - 40 - preW - sufW, 74);
    g.textAlign = "left";
    g.fillText(body, x, h / 2 + 3);
    x += bodyW + 12;
    if (suf) {
      g.font = `bold 40px ${FONT}`;
      g.fillText(suf, x, h / 2 + 2);
    }
  });
}

export function stopFace(atlas: SignAtlas): Cell {
  return atlas.cell("stop", 256, 256, (g, w, h) => {
    octagon(g, w, h, "#b01e23");
    g.strokeStyle = WHITE;
    g.lineWidth = 9;
    g.stroke();
    g.fillStyle = WHITE;
    g.font = `bold 88px ${FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("STOP", w / 2, h / 2 + 4);
  });
}

/** The unprinted aluminium back of a sign, in the same outline. */
export function backFace(atlas: SignAtlas, shape: "oct" | "rect" | "diamond" | "pent"): Cell {
  return atlas.cell(`back:${shape}`, 128, 128, (g, w, h) => {
    if (shape === "oct") octagon(g, w, h, "#9ea3a6");
    else if (shape === "diamond") diamond(g, w, h, "#9ea3a6");
    else if (shape === "pent") pentagon(g, w, h, "#9ea3a6");
    else {
      g.fillStyle = "#9ea3a6";
      g.fillRect(0, 0, w, h);
    }
  });
}

function octagon(g: CanvasRenderingContext2D, w: number, h: number, fill: string): void {
  g.fillStyle = fill;
  g.beginPath();
  for (let k = 0; k < 8; k++) {
    const ang = (k / 8) * Math.PI * 2 + Math.PI / 8;
    g.lineTo(w / 2 + Math.cos(ang) * (w / 2 - 6), h / 2 + Math.sin(ang) * (h / 2 - 6));
  }
  g.closePath();
  g.fill();
}

function diamond(g: CanvasRenderingContext2D, w: number, h: number, fill: string): void {
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(w / 2, 4);
  g.lineTo(w - 4, h / 2);
  g.lineTo(w / 2, h - 4);
  g.lineTo(4, h / 2);
  g.closePath();
  g.fill();
}

function pentagon(g: CanvasRenderingContext2D, w: number, h: number, fill: string): void {
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(w / 2, 4);
  g.lineTo(w - 4, h * 0.38);
  g.lineTo(w * 0.86, h - 4);
  g.lineTo(w * 0.14, h - 4);
  g.lineTo(4, h * 0.38);
  g.closePath();
  g.fill();
}

export function speedFace(atlas: SignAtlas, mph: number): Cell {
  return atlas.cell(`speed:${mph}`, 224, 288, (g, w, h) => {
    g.fillStyle = WHITE;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "#111";
    g.lineWidth = 7;
    g.strokeRect(9, 9, w - 18, h - 18);
    g.fillStyle = "#111";
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    g.font = `bold 40px ${FONT}`;
    g.fillText("SPEED", w / 2, 62);
    g.fillText("LIMIT", w / 2, 106);
    g.font = `bold 136px ${FONT}`;
    g.fillText(String(mph), w / 2, 248);
  });
}

/** Yellow warning diamond: DEAD END, NO OUTLET. */
export function warningFace(atlas: SignAtlas, lines: string[]): Cell {
  return atlas.cell(`warn:${lines.join("/")}`, 256, 256, (g, w, h) => {
    diamond(g, w, h, "#f2b800");
    g.strokeStyle = "#111";
    g.lineWidth = 5;
    g.stroke();
    g.fillStyle = "#111";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `bold 46px ${FONT}`;
    const y0 = h / 2 - ((lines.length - 1) * 50) / 2;
    lines.forEach((t, i) => g.fillText(t, w / 2, y0 + i * 50 + 2));
  });
}

/** White regulatory rectangle with black text: PRIVATE ROAD, BUS STOP, NO PARKING. */
export function noticeFace(atlas: SignAtlas, lines: string[], accent = "#111"): Cell {
  return atlas.cell(`notice:${lines.join("/")}:${accent}`, 224, 288, (g, w, h) => {
    g.fillStyle = WHITE;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = accent;
    g.lineWidth = 6;
    g.strokeRect(8, 8, w - 16, h - 16);
    g.fillStyle = accent;
    g.textAlign = "center";
    g.textBaseline = "middle";
    const size = lines.length > 3 ? 36 : 44;
    const y0 = h / 2 - ((lines.length - 1) * (size + 8)) / 2;
    lines.forEach((t, i) => {
      fit(g, t, w - 30, size);
      g.fillText(t, w / 2, y0 + i * (size + 8));
    });
  });
}

/** Fluorescent yellow-green school pentagon, with or without the walkers. */
export function schoolFace(atlas: SignAtlas, label: string): Cell {
  return atlas.cell(`school:${label}`, 256, 256, (g, w, h) => {
    pentagon(g, w, h, "#c8f000");
    g.strokeStyle = "#111";
    g.lineWidth = 5;
    g.stroke();
    g.fillStyle = "#111";
    if (label === "SCHOOL") {
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = `bold 58px ${FONT}`;
      g.fillText("SCHOOL", w / 2, h / 2 + 18);
    } else {
      // Two walking figures: an adult and a child, as on the crossing sign.
      const person = (x: number, y: number, s: number) => {
        g.beginPath();
        g.arc(x, y - 22 * s, 8 * s, 0, Math.PI * 2);
        g.fill();
        g.fillRect(x - 7 * s, y - 12 * s, 14 * s, 26 * s);
        g.fillRect(x - 9 * s, y + 14 * s, 6 * s, 26 * s);
        g.fillRect(x + 3 * s, y + 14 * s, 6 * s, 26 * s);
      };
      person(w * 0.42, h * 0.5, 1.5);
      person(w * 0.62, h * 0.58, 1.05);
    }
  });
}

/** Supplemental plaque under a school sign. */
export function plaqueFace(atlas: SignAtlas, lines: string[], bg = "#c8f000"): Cell {
  return atlas.cell(`plaque:${lines.join("/")}:${bg}`, 256, 160, (g, w, h) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "#111";
    g.lineWidth = 5;
    g.strokeRect(6, 6, w - 12, h - 12);
    g.fillStyle = "#111";
    if (lines[0] === "ARROW") {
      // Diagonal arrow down toward the crossing.
      g.lineWidth = 14;
      g.strokeStyle = "#111";
      g.beginPath();
      g.moveTo(w * 0.68, h * 0.22);
      g.lineTo(w * 0.32, h * 0.78);
      g.stroke();
      g.beginPath();
      g.moveTo(w * 0.24, h * 0.86);
      g.lineTo(w * 0.28, h * 0.5);
      g.lineTo(w * 0.6, h * 0.82);
      g.closePath();
      g.fill();
      return;
    }
    g.textAlign = "center";
    g.textBaseline = "middle";
    const size = 34;
    const y0 = h / 2 - ((lines.length - 1) * (size + 4)) / 2;
    lines.forEach((t, i) => {
      fit(g, t, w - 26, size);
      g.fillText(t, w / 2, y0 + i * (size + 4));
    });
  });
}

/** Reflective stick-on digits on the side of a mailbox. */
export function digitsFace(atlas: SignAtlas, digits: string, dark: boolean): Cell {
  return atlas.cell(`digits:${digits}:${dark}`, 160, 40, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = dark ? "#f6f6f2" : "#151515";
    g.textAlign = "center";
    g.textBaseline = "middle";
    fit(g, digits, w - 8, 36);
    g.fillText(digits, w / 2, h / 2 + 1);
  });
}

/** A post-and-panel board: brown and routed at the beach access, white and blue at the school. */
export function boardFace(atlas: SignAtlas, title: string, lines: string[], bg = "#4e3a26", fg = "#f0e6cf"): Cell {
  return atlas.cell(`board:${title}:${bg}`, 448, 288, (g, w, h) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = fg;
    g.lineWidth = 6;
    g.strokeRect(10, 10, w - 20, h - 20);
    g.fillStyle = fg;
    g.textAlign = "center";
    g.textBaseline = "middle";
    fit(g, title, w - 40, 64);
    g.fillText(title, w / 2, 70);
    g.font = `bold 30px ${FONT}`;
    lines.forEach((t, i) => {
      fit(g, t, w - 40, 30);
      g.fillText(t, w / 2, 140 + i * 40);
    });
  });
}

/** The flag on the school's pole. */
export function flagFace(atlas: SignAtlas): Cell {
  return atlas.cell("flag", 256, 136, (g, w, h) => {
    const stripe = h / 13;
    for (let i = 0; i < 13; i++) {
      g.fillStyle = i % 2 ? "#f4f4f2" : "#b22234";
      g.fillRect(0, i * stripe, w, stripe + 1);
    }
    g.fillStyle = "#3c3b6e";
    g.fillRect(0, 0, w * 0.4, stripe * 7);
    g.fillStyle = "#f4f4f2";
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 6; c++) {
        const x = 8 + c * ((w * 0.4 - 16) / 5) + (r % 2 ? 6 : 0);
        const y = 8 + r * ((stripe * 7 - 16) / 4);
        g.beginPath();
        g.arc(x, y, 3, 0, Math.PI * 2);
        g.fill();
      }
    }
  });
}

/** BEWARE OF DOG, on a gate. */
export function dogFace(atlas: SignAtlas): Cell {
  return atlas.cell("dog", 192, 128, (g, w, h) => {
    g.fillStyle = "#f2b800";
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "#111";
    g.lineWidth = 5;
    g.strokeRect(6, 6, w - 12, h - 12);
    g.fillStyle = "#111";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `bold 40px ${FONT}`;
    g.fillText("BEWARE", w / 2, 44);
    g.fillText("OF DOG", w / 2, 88);
  });
}

/** Kitsap Transit stop flag: white, blue band, the bus. */
export function busStopFace(atlas: SignAtlas): Cell {
  return atlas.cell("busstop", 192, 256, (g, w, h) => {
    g.fillStyle = WHITE;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#1b4f9c";
    g.fillRect(0, 0, w, 84);
    g.fillStyle = WHITE;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `bold 40px ${FONT}`;
    g.fillText("BUS", w / 2, 30);
    g.fillText("STOP", w / 2, 64);
    g.fillStyle = "#1b4f9c";
    g.fillRect(28, 116, w - 56, 70);
    g.fillStyle = WHITE;
    g.fillRect(40, 128, 32, 24);
    g.fillRect(80, 128, 32, 24);
    g.fillRect(120, 128, 32, 24);
    g.fillStyle = "#1b4f9c";
    g.font = `bold 26px ${FONT}`;
    g.fillText("KITSAP TRANSIT", w / 2, 222);
  });
}
