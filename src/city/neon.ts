/**
 * Neon signs on Vibe City's street fronts, and their reflections in the road.
 *
 * Two kinds, both hung on the ground-floor mass of a building and always on
 * a face that looks onto a street (a lot's outward faces, worked out from
 * where it sits in its block):
 *
 *  - blade signs, the tall vertical ones that stick out from a corner, with
 *    the letters stacked (HOTEL, RAMEN, ARCADE);
 *  - fascia signs, a long strip over the shopfront (OPEN 24H, PIZZA).
 *
 * Every word is one cell of a single atlas and every sign is a quad in one
 * merged mesh, so the whole city's neon is three draw calls: the steady
 * signs, the ones that flicker, and the reflections.
 *
 * The reflections are the wet-street half. Each sign drops a stretched,
 * soft streak of its own colour on the pavement and the road in front of it,
 * at zero opacity when the street is dry. `setWet` turns them up, which is
 * what makes a rainy night look like a rainy night.
 *
 * Seeded: the same city always gets the same signs.
 */
import * as THREE from "three";
import type { Footprint } from "./district";

const WORDS: Array<{ text: string; color: string }> = [
  { text: "HOTEL", color: "#ff3b6b" },
  { text: "RAMEN", color: "#ffb02e" },
  { text: "ARCADE", color: "#36e3ff" },
  { text: "VIBES", color: "#ff4fd8" },
  { text: "OPEN", color: "#ff3b3b" },
  { text: "PIZZA", color: "#ffd23f" },
  { text: "TACOS", color: "#7dff5a" },
  { text: "JAZZ", color: "#5a8bff" },
  { text: "BAR", color: "#ff5a36" },
  { text: "DINER", color: "#3dffc5" },
  { text: "KARAOKE", color: "#c86bff" },
  { text: "COFFEE", color: "#ffa45a" },
  { text: "NOODLES", color: "#ff6f9a" },
  { text: "DISCO", color: "#b14dff" },
  { text: "LIVE", color: "#3ee8ff" },
  { text: "24H", color: "#5aff9a" },
];

// Atlas: horizontal cells 512x128 in the top half (4 x 8), vertical cells
// 128x512 in the bottom half (16 x 2). 16 words, one of each.
const ATLAS = 2048;

function drawAtlas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = ATLAS;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, ATLAS, ATLAS);
  const tube = (color: string, draw: () => void) => {
    // Three passes: a wide coloured haze, the coloured tube, a white-hot core.
    g.save();
    g.shadowColor = color;
    g.shadowBlur = 28;
    g.fillStyle = color;
    g.globalAlpha = 0.9;
    draw();
    g.shadowBlur = 10;
    g.globalAlpha = 1;
    draw();
    g.shadowBlur = 0;
    g.fillStyle = "rgba(255,255,255,0.75)";
    g.globalCompositeOperation = "lighter";
    g.scale(1, 1);
    draw();
    g.restore();
  };
  WORDS.forEach((w, i) => {
    // Horizontal.
    {
      const x0 = (i % 4) * 512;
      const y0 = Math.floor(i / 4) * 128;
      g.save();
      g.beginPath();
      g.rect(x0, y0, 512, 128);
      g.clip();
      // A thin rounded frame tube.
      g.strokeStyle = w.color;
      g.lineWidth = 5;
      g.shadowColor = w.color;
      g.shadowBlur = 18;
      g.beginPath();
      g.roundRect(x0 + 14, y0 + 14, 484, 100, 22);
      g.stroke();
      const size = w.text.length > 5 ? 64 : 78;
      g.font = `bold ${size}px "Arial Rounded MT Bold", Arial, Helvetica, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      tube(w.color, () => g.fillText(w.text, x0 + 256, y0 + 68));
      g.restore();
    }
    // Vertical, letters stacked.
    {
      const x0 = (i % 16) * 128;
      const y0 = 1024 + Math.floor(i / 16) * 512;
      g.save();
      g.beginPath();
      g.rect(x0, y0, 128, 512);
      g.clip();
      g.strokeStyle = w.color;
      g.lineWidth = 5;
      g.shadowColor = w.color;
      g.shadowBlur = 16;
      g.beginPath();
      g.roundRect(x0 + 10, y0 + 10, 108, 492, 18);
      g.stroke();
      const letters = w.text.split("");
      const step = Math.min(78, 460 / letters.length);
      g.font = `bold ${Math.round(step * 0.86)}px Arial, Helvetica, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      const top = y0 + 256 - (step * (letters.length - 1)) / 2;
      tube(w.color, () => letters.forEach((ch, k) => g.fillText(ch, x0 + 64, top + k * step)));
      g.restore();
    }
  });
  return c;
}

function cellUV(i: number, vertical: boolean): [number, number, number, number] {
  // [u0, v0, u1, v1] with v measured from the bottom, as three wants it.
  if (!vertical) {
    const x0 = (i % 4) * 512;
    const y0 = Math.floor(i / 4) * 128;
    return [x0 / ATLAS, 1 - (y0 + 128) / ATLAS, (x0 + 512) / ATLAS, 1 - y0 / ATLAS];
  }
  const x0 = (i % 16) * 128;
  const y0 = 1024 + Math.floor(i / 16) * 512;
  return [x0 / ATLAS, 1 - (y0 + 512) / ATLAS, (x0 + 128) / ATLAS, 1 - y0 / ATLAS];
}

function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface NeonSigns {
  group: THREE.Group;
  /** How many signs went up, for the dev hook. */
  count: number;
  setDay(day: boolean): void;
  /** 0 (dry) to 1 (soaked): how strongly the signs show in the street. */
  setWet(wet: number): void;
  update(dt: number): void;
  dispose(): void;
}

interface Quad {
  // Four corners, counter-clockwise from bottom-left, and the UV rect.
  p: THREE.Vector3[];
  uv: [number, number, number, number];
  color: THREE.Color;
}

function quadsToGeometry(quads: Quad[]): THREE.BufferGeometry {
  const pos = new Float32Array(quads.length * 4 * 3);
  const uv = new Float32Array(quads.length * 4 * 2);
  const col = new Float32Array(quads.length * 4 * 3);
  const idx: number[] = [];
  quads.forEach((q, n) => {
    const [u0, v0, u1, v1] = q.uv;
    const uvs = [u0, v0, u1, v0, u1, v1, u0, v1];
    for (let k = 0; k < 4; k++) {
      pos.set([q.p[k].x, q.p[k].y, q.p[k].z], (n * 4 + k) * 3);
      uv.set([uvs[k * 2], uvs[k * 2 + 1]], (n * 4 + k) * 2);
      col.set([q.color.r, q.color.g, q.color.b], (n * 4 + k) * 3);
    }
    const b = n * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export function buildNeon(opts: { footprints: Footprint[]; seed: string; lowDetail?: boolean }): NeonSigns {
  const r = rng(opts.seed + "-neon");
  const group = new THREE.Group();
  group.name = "neon-signs";

  const atlas = new THREE.CanvasTexture(drawAtlas());
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;

  const steady: Quad[] = [];
  const flicker: Quad[] = [];
  const pools: Quad[] = [];
  const WHITE = new THREE.Color(1, 1, 1);

  const U = new THREE.Vector3();
  const N = new THREE.Vector3();
  const C = new THREE.Vector3();
  const quad = (center: THREE.Vector3, right: THREE.Vector3, w: number, h: number) => {
    const hx = right.clone().multiplyScalar(w / 2);
    return [
      center.clone().sub(hx).setY(center.y - h / 2),
      center.clone().add(hx).setY(center.y - h / 2),
      center.clone().add(hx).setY(center.y + h / 2),
      center.clone().sub(hx).setY(center.y + h / 2),
    ];
  };

  let count = 0;
  for (const f of opts.footprints) {
    if (f.y1 < 6.5 || r() > 0.42) continue;
    // Which faces look onto a street: away from the block centre.
    const dx = f.cx - f.cellX;
    const dz = f.cz - f.cellZ;
    const faces: Array<[number, number]> = [];
    if (Math.abs(dx) > 1) faces.push([Math.sign(dx), 0]);
    if (Math.abs(dz) > 1) faces.push([0, Math.sign(dz)]);
    if (!faces.length) faces.push(...([[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>));
    const [nx, nz] = faces[Math.floor(r() * faces.length)];
    N.set(nx, 0, nz);
    U.set(-nz, 0, nx); // along the wall
    const halfAlong = nx !== 0 ? f.d / 2 : f.w / 2;
    const wallOff = nx !== 0 ? f.w / 2 : f.d / 2;
    const wordIdx = Math.floor(r() * WORDS.length);
    const word = WORDS[wordIdx];
    const color = new THREE.Color(word.color);
    const list = r() < 0.12 ? flicker : steady;
    const blade = f.y1 > 11 && r() < 0.5;
    let footX: number;
    let footZ: number;
    if (blade) {
      // Near one end of the wall, sticking straight out of it.
      const along = (r() < 0.5 ? -1 : 1) * Math.max(0, halfAlong - 1.6);
      const h = Math.min(7.5, f.y1 - 4.5);
      const w = h / 4;
      C.set(f.cx, 4 + h / 2, f.cz).addScaledVector(N, wallOff + w / 2 + 0.25).addScaledVector(U, along);
      // Both faces, so it reads from either way down the street.
      const uv = cellUV(wordIdx, true);
      list.push({ p: quad(C.clone().addScaledVector(U, 0.06), N, w, h), uv, color: WHITE });
      const back = quad(C.clone().addScaledVector(U, -0.06), N.clone().negate(), w, h);
      list.push({ p: back, uv, color: WHITE });
      footX = C.x + N.x * 1.5;
      footZ = C.z + N.z * 1.5;
    } else {
      const w = Math.min(halfAlong * 2 * 0.7, 9);
      const h = w / 4;
      const along = (r() - 0.5) * Math.max(0, halfAlong * 2 - w - 1);
      C.set(f.cx, 4.3 + h / 2, f.cz).addScaledVector(N, wallOff + 0.12).addScaledVector(U, along);
      // Face outward: `right` is the along-wall vector seen from the street.
      list.push({ p: quad(C, U.clone().negate(), w, h), uv: cellUV(wordIdx, false), color: WHITE });
      footX = C.x + N.x * 2.5;
      footZ = C.z + N.z * 2.5;
    }
    // The streak in the wet street: long across the pavement into the road.
    {
      const len = 9;
      const wid = blade ? 2.2 : 5;
      const c0 = new THREE.Vector3(footX, 0.165, footZ).addScaledVector(N, len / 2 - 1);
      const along = N.clone().multiplyScalar(len / 2);
      const side = U.clone().multiplyScalar(wid / 2);
      pools.push({
        p: [
          c0.clone().sub(along).sub(side),
          c0.clone().sub(along).add(side),
          c0.clone().add(along).add(side),
          c0.clone().add(along).sub(side),
        ],
        uv: [0, 0, 1, 1],
        color,
      });
    }
    count++;
  }

  const signMat = new THREE.MeshBasicMaterial({
    map: atlas,
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    toneMapped: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const flickerMat = signMat.clone();
  const steadyMesh = new THREE.Mesh(quadsToGeometry(steady), signMat);
  const flickerMesh = new THREE.Mesh(quadsToGeometry(flicker), flickerMat);
  steadyMesh.renderOrder = flickerMesh.renderOrder = 5;
  group.add(steadyMesh, flickerMesh);

  // A soft streak, bright near the wall, fading out into the road.
  const streakTex = (() => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 128;
    const g = c.getContext("2d")!;
    const img = g.createImageData(64, 128);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 64; x++) {
        const u = (x + 0.5) / 64;
        const v = (y + 0.5) / 128;
        const across = Math.pow(Math.sin(Math.PI * u), 2.2);
        const ripple = 0.7 + 0.3 * Math.sin(v * 60 + Math.sin(u * 9) * 2);
        const a = across * Math.pow(1 - v, 1.4) * ripple;
        const i = (y * 64 + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.flipY = false;
    return t;
  })();
  const poolMat = new THREE.MeshBasicMaterial({
    map: streakTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    opacity: 0,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -6,
  });
  const poolMesh = new THREE.Mesh(quadsToGeometry(pools), poolMat);
  poolMesh.visible = false;
  poolMesh.renderOrder = 4;
  group.add(poolMesh);

  let day = false;
  let wet = 0;
  const refresh = () => {
    // By day neon is a coloured tube, not a light: still there, much dimmer.
    signMat.color.setScalar(day ? 0.55 : 1.35);
    poolMat.opacity = wet * (day ? 0.18 : 0.85);
    poolMesh.visible = poolMat.opacity > 0.01;
  };
  refresh();

  let t = 0;
  let nextBlink = 0;
  return {
    group,
    count,
    setDay(d) {
      day = d;
      refresh();
    },
    setWet(w) {
      if (Math.abs(w - wet) < 0.005) return;
      wet = w;
      refresh();
    },
    update(dt) {
      t += dt;
      // Old tubes: mostly on, now and then a stutter of dropouts.
      if (t > nextBlink) {
        const on = Math.random() < 0.55;
        flickerMat.color.setScalar(on ? signMat.color.r : signMat.color.r * 0.15);
        nextBlink = t + (on ? 0.5 + Math.random() * 3.5 : 0.04 + Math.random() * 0.12);
      }
    },
    dispose() {
      steadyMesh.geometry.dispose();
      flickerMesh.geometry.dispose();
      poolMesh.geometry.dispose();
      signMat.dispose();
      flickerMat.dispose();
      poolMat.dispose();
      atlas.dispose();
      streakTex.dispose();
    },
  };
}
