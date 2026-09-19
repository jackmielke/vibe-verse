/**
 * Everything that stands on the ground: the fixed village and the things
 * Vibey conjures. All of it is procedural — boxes, cones, spheres and a
 * little care — because a world that has to be rebuilt by voice in a second
 * cannot wait for a download, and because the low-poly look is the look.
 *
 * `buildProp(kind)` makes one thing at the origin, sized so that `scale = 1`
 * is its natural size. `Magician.ts` places it on `heightAt`.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { heightAt, riverCentre, WATER_LEVEL } from "./noise";
import type { PropKind, Season } from "../state";

export interface PropObject {
  group: THREE.Group;
  /** Per-frame hook for things that move or glow. */
  update?(dt: number, time: number, ctx: PropContext): void;
  /** Whether this thing has foliage that follows the season. */
  foliage?: THREE.Material[];
  /** Lights that follow `lanternsLit`. */
  lamp?: { light: THREE.PointLight; glow: THREE.Material; base: number };
  dispose(): void;
}

export interface PropContext {
  wind: number;
  windDir: number;
  season: Season;
  lanterns: boolean;
  night: number;
  snow: number;
}

const wood = new THREE.MeshStandardMaterial({ color: "#6b4a2e", roughness: 0.9 });
const darkWood = new THREE.MeshStandardMaterial({ color: "#3b2818", roughness: 0.9 });
const trunk = new THREE.MeshStandardMaterial({ color: "#5a4030", roughness: 1 });
const stone = new THREE.MeshStandardMaterial({ color: "#8d8a82", roughness: 0.95 });
const paper = new THREE.MeshStandardMaterial({ color: "#f3ead6", roughness: 0.8 });
const plaster = new THREE.MeshStandardMaterial({ color: "#e9e2d0", roughness: 0.9 });
const tile = new THREE.MeshStandardMaterial({ color: "#3d4550", roughness: 0.7 });
const vermilion = new THREE.MeshStandardMaterial({ color: "#c8342a", roughness: 0.6 });
const bambooMat = new THREE.MeshStandardMaterial({ color: "#7fae4e", roughness: 0.7 });

export const FOLIAGE: Record<Season, { tree: string; sakura: string; maple: string; pine: string; bamboo: string }> = {
  spring: { tree: "#6fbf5a", sakura: "#ffb7d5", maple: "#8cc46a", pine: "#2f6b45", bamboo: "#7fae4e" },
  summer: { tree: "#3f9a3e", sakura: "#5faa55", maple: "#4f9c45", pine: "#245a3a", bamboo: "#6ea43f" },
  autumn: { tree: "#d78a2c", sakura: "#e0a050", maple: "#d6342a", pine: "#2c5f3f", bamboo: "#9fae4e" },
  winter: { tree: "#7c6c5a", sakura: "#8c7a6a", maple: "#7a5a4a", pine: "#2a5038", bamboo: "#8ea67a" },
};

function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const me = new THREE.Mesh(g, m);
  me.position.set(x, y, z);
  me.castShadow = true;
  me.receiveShadow = true;
  return me;
}

function canopyMaterial(color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true });
}

const geoCache = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) { g = make(); geoCache.set(key, g); }
  return g;
}

function blobCanopy(mat: THREE.Material, r: number, y: number, n = 4): THREE.Group {
  const g = new THREE.Group();
  const s = geo("blob", () => new THREE.IcosahedronGeometry(1, 1));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.7;
    const m = mesh(s, mat, Math.cos(a) * r * 0.45, y + (i % 2) * r * 0.3, Math.sin(a) * r * 0.45);
    m.scale.setScalar(r * (0.7 + (i % 3) * 0.12));
    g.add(m);
  }
  const top = mesh(s, mat, 0, y + r * 0.5, 0);
  top.scale.setScalar(r * 0.85);
  g.add(top);
  return g;
}

export function buildProp(kind: PropKind, season: Season, color?: string): PropObject {
  const group = new THREE.Group();
  const mats: THREE.Material[] = [];
  const own: THREE.Material[] = [];
  let update: PropObject["update"];
  let lamp: PropObject["lamp"];
  const sway: THREE.Object3D[] = [];

  switch (kind) {
    case "tree":
    case "sakura":
    case "maple": {
      const h = 2.2 + Math.random() * 1.2;
      const t = mesh(geo("trunk", () => new THREE.CylinderGeometry(0.12, 0.22, 1, 7)), trunk, 0, h / 2, 0);
      t.scale.y = h;
      group.add(t);
      const col = color ?? FOLIAGE[season][kind];
      const m = canopyMaterial(col);
      own.push(m);
      if (!color) mats.push(m);
      const c = blobCanopy(m, kind === "sakura" ? 1.7 : 1.5, h - 0.4, 5);
      group.add(c);
      sway.push(c);
      break;
    }
    case "pine": {
      const h = 3 + Math.random() * 2;
      const t = mesh(geo("trunk", () => new THREE.CylinderGeometry(0.12, 0.22, 1, 7)), trunk, 0, h * 0.35, 0);
      t.scale.y = h * 0.7;
      group.add(t);
      const m = canopyMaterial(color ?? FOLIAGE[season].pine);
      own.push(m);
      if (!color) mats.push(m);
      const cone = geo("cone", () => new THREE.ConeGeometry(1, 1, 8));
      const tiers = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        const c = mesh(cone, m, 0, h * 0.45 + i * h * 0.22, 0);
        c.scale.set(1.5 - i * 0.35, h * 0.45, 1.5 - i * 0.35);
        tiers.add(c);
      }
      group.add(tiers);
      sway.push(tiers);
      break;
    }
    case "bamboo": {
      const m = new THREE.MeshStandardMaterial({ color: color ?? FOLIAGE[season].bamboo, roughness: 0.7 });
      own.push(m);
      if (!color) mats.push(m);
      const stalk = geo("stalk", () => new THREE.CylinderGeometry(0.06, 0.08, 1, 6));
      const cl = new THREE.Group();
      for (let i = 0; i < 7; i++) {
        const h = 4 + Math.random() * 3;
        const s = mesh(stalk, m, (Math.random() - 0.5) * 1.4, h / 2, (Math.random() - 0.5) * 1.4);
        s.scale.y = h;
        s.rotation.z = (Math.random() - 0.5) * 0.1;
        cl.add(s);
        const leaf = mesh(geo("leaf", () => new THREE.ConeGeometry(0.5, 0.9, 5)), m, s.position.x, h + 0.2, s.position.z);
        leaf.rotation.x = Math.PI;
        cl.add(leaf);
      }
      group.add(cl);
      sway.push(cl);
      break;
    }
    case "lantern": {
      const base = mesh(geo("lbase", () => new THREE.BoxGeometry(0.7, 0.3, 0.7)), stone, 0, 0.15, 0);
      const post = mesh(geo("lpost", () => new THREE.CylinderGeometry(0.12, 0.16, 1.1, 8)), stone, 0, 0.85, 0);
      const box = mesh(geo("lbox", () => new THREE.BoxGeometry(0.46, 0.5, 0.46)), stone, 0, 1.65, 0);
      const glowMat = new THREE.MeshStandardMaterial({ color: color ?? "#ffd28a", emissive: color ?? "#ffb347", emissiveIntensity: 0, roughness: 0.5 });
      own.push(glowMat);
      const glow = mesh(geo("lglow", () => new THREE.BoxGeometry(0.5, 0.4, 0.5)), glowMat, 0, 1.65, 0);
      glow.castShadow = false;
      const roof = mesh(geo("lroof", () => new THREE.ConeGeometry(0.62, 0.45, 4)), stone, 0, 2.12, 0);
      roof.rotation.y = Math.PI / 4;
      const light = new THREE.PointLight(color ?? "#ffb347", 0, 9, 2);
      light.position.set(0, 1.7, 0);
      group.add(base, post, box, glow, roof, light);
      lamp = { light, glow: glowMat, base: 2.6 };
      break;
    }
    case "torii": {
      const col = color ? new THREE.MeshStandardMaterial({ color, roughness: 0.6 }) : vermilion;
      if (color) own.push(col);
      const post = geo("tpost", () => new THREE.CylinderGeometry(0.22, 0.26, 4.2, 10));
      group.add(mesh(post, col, -1.6, 2.1, 0), mesh(post, col, 1.6, 2.1, 0));
      const beam = mesh(geo("tbeam", () => new THREE.BoxGeometry(4.8, 0.32, 0.4)), col, 0, 4.35, 0);
      const top = mesh(geo("ttop", () => new THREE.BoxGeometry(5.4, 0.4, 0.5)), darkWood, 0, 4.85, 0);
      const mid = mesh(geo("tmid", () => new THREE.BoxGeometry(3.4, 0.28, 0.3)), col, 0, 3.55, 0);
      const plaque = mesh(geo("tplaque", () => new THREE.BoxGeometry(0.5, 0.7, 0.12)), paper, 0, 3.95, 0.1);
      group.add(beam, top, mid, plaque);
      break;
    }
    case "house": {
      const w = 4 + Math.random() * 1.5;
      const d = 3.5 + Math.random();
      const wallMat = color ? new THREE.MeshStandardMaterial({ color, roughness: 0.9 }) : plaster;
      if (color) own.push(wallMat);
      const body = mesh(new THREE.BoxGeometry(w, 2.4, d), wallMat, 0, 1.2, 0);
      const beams = mesh(new THREE.BoxGeometry(w + 0.1, 0.18, d + 0.1), darkWood, 0, 2.45, 0);
      const roofG = new THREE.ConeGeometry(1, 1, 4);
      const roof = mesh(roofG, tile, 0, 3.15, 0);
      roof.rotation.y = Math.PI / 4;
      roof.scale.set(w * 0.86, 1.5, d * 0.86);
      const door = mesh(geo("door", () => new THREE.BoxGeometry(0.9, 1.7, 0.08)), darkWood, w * 0.15, 0.85, d / 2 + 0.03);
      const win = mesh(geo("win", () => new THREE.BoxGeometry(0.8, 0.7, 0.06)), paper, -w * 0.25, 1.4, d / 2 + 0.03);
      const winMat = new THREE.MeshStandardMaterial({ color: "#f8e7b8", emissive: "#ffb866", emissiveIntensity: 0, roughness: 0.8 });
      own.push(winMat);
      win.material = winMat;
      const light = new THREE.PointLight("#ffb866", 0, 7, 2);
      light.position.set(-w * 0.25, 1.4, d / 2 + 0.6);
      group.add(body, beams, roof, door, win, light);
      lamp = { light, glow: winMat, base: 1.2 };
      break;
    }
    case "shrine": {
      const plinth = mesh(new THREE.BoxGeometry(4.2, 0.5, 3.6), stone, 0, 0.25, 0);
      const steps = mesh(new THREE.BoxGeometry(2, 0.25, 0.9), stone, 0, 0.12, 2.2);
      const body = mesh(new THREE.BoxGeometry(3, 2.2, 2.6), wood, 0, 1.6, 0);
      const veranda = mesh(new THREE.BoxGeometry(4, 0.15, 3.4), darkWood, 0, 0.55, 0);
      const roof = mesh(new THREE.ConeGeometry(1, 1, 4), tile, 0, 3.4, 0);
      roof.rotation.y = Math.PI / 4;
      roof.scale.set(3.6, 1.4, 3.2);
      const ridge = mesh(new THREE.BoxGeometry(3.4, 0.2, 0.3), darkWood, 0, 4.1, 0);
      const doorL = mesh(geo("sdoor", () => new THREE.BoxGeometry(0.7, 1.5, 0.08)), vermilion, -0.4, 1.35, 1.34);
      const doorR = mesh(geo("sdoor", () => new THREE.BoxGeometry(0.7, 1.5, 0.08)), vermilion, 0.4, 1.35, 1.34);
      const rope = mesh(geo("rope", () => new THREE.CylinderGeometry(0.06, 0.06, 2.6, 6)), paper, 0, 2.55, 1.4);
      rope.rotation.z = Math.PI / 2;
      const bell = mesh(geo("bell", () => new THREE.SphereGeometry(0.22, 10, 8)), new THREE.MeshStandardMaterial({ color: "#c9a04a", metalness: 0.7, roughness: 0.3 }), 0, 2.3, 1.42);
      group.add(plinth, steps, body, veranda, roof, ridge, doorL, doorR, rope, bell);
      break;
    }
    case "pagoda": {
      for (let i = 0; i < 3; i++) {
        const s = 1 - i * 0.22;
        const body = mesh(new THREE.BoxGeometry(3 * s, 1.6, 3 * s), wood, 0, 0.8 + i * 2.1, 0);
        const roof = mesh(new THREE.ConeGeometry(1, 1, 4), tile, 0, 1.9 + i * 2.1, 0);
        roof.rotation.y = Math.PI / 4;
        roof.scale.set(3.4 * s, 0.9, 3.4 * s);
        group.add(body, roof);
      }
      const spire = mesh(geo("spire", () => new THREE.ConeGeometry(0.15, 1.6, 6)), new THREE.MeshStandardMaterial({ color: "#c9a04a", metalness: 0.7, roughness: 0.3 }), 0, 7.1, 0);
      group.add(spire);
      break;
    }
    case "rock":
    case "boulder": {
      const r = kind === "rock" ? 0.6 : 1.8;
      const m = new THREE.MeshStandardMaterial({ color: color ?? "#7d7a72", roughness: 1, flatShading: true });
      own.push(m);
      const g = new THREE.IcosahedronGeometry(r, 1);
      const p = g.attributes.position as THREE.BufferAttribute;
      // The geometry is non-indexed, so shared corners are duplicated: the
      // displacement has to be a function of position, not of index, or the
      // rock tears open along every edge.
      const seed = Math.random() * 100;
      const jitter = (x: number, y: number, z: number, k: number) => 0.8 + 0.4 * Math.abs(Math.sin(x * 12.9 + y * 78.2 + z * 37.7 + seed + k));
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        p.setXYZ(i, x * jitter(x, y, z, 1), y * (0.7 + 0.3 * jitter(x, y, z, 2)) * 0.8, z * jitter(x, y, z, 3));
      }
      g.computeVertexNormals();
      const mm = mesh(g, m, 0, r * 0.45, 0);
      group.add(mm);
      break;
    }
    case "campfire": {
      const log = geo("log", () => new THREE.CylinderGeometry(0.1, 0.1, 1.1, 6));
      for (let i = 0; i < 4; i++) {
        const l = mesh(log, darkWood, 0, 0.12, 0);
        l.rotation.z = Math.PI / 2;
        l.rotation.y = (i / 4) * Math.PI;
        group.add(l);
      }
      const ring = geo("fring", () => new THREE.TorusGeometry(0.75, 0.12, 6, 12));
      const rm = mesh(ring, stone, 0, 0.08, 0);
      rm.rotation.x = Math.PI / 2;
      group.add(rm);
      const fireMat = new THREE.MeshBasicMaterial({ color: color ?? "#ff8a2a", transparent: true, opacity: 0.9 });
      own.push(fireMat);
      const flames: THREE.Mesh[] = [];
      const flameG = geo("flame", () => new THREE.ConeGeometry(0.25, 0.9, 6));
      for (let i = 0; i < 5; i++) {
        const f = new THREE.Mesh(flameG, fireMat);
        f.position.set((Math.random() - 0.5) * 0.4, 0.5, (Math.random() - 0.5) * 0.4);
        flames.push(f);
        group.add(f);
      }
      const light = new THREE.PointLight(color ?? "#ff9a3a", 2.6, 12, 2);
      light.position.y = 1;
      group.add(light);
      update = (dt, time) => {
        flames.forEach((f, i) => {
          f.scale.y = 0.8 + Math.sin(time * 9 + i * 1.7) * 0.3;
          f.scale.x = f.scale.z = 0.9 + Math.sin(time * 7 + i) * 0.15;
        });
        light.intensity = 2.2 + Math.sin(time * 13) * 0.5 + Math.sin(time * 5.3) * 0.3;
      };
      break;
    }
    case "flowers": {
      const palette = color ? [color] : ["#ff6b9d", "#ffd166", "#ffffff", "#c77dff", "#ff8c42"];
      const petalG = geo("petal", () => new THREE.SphereGeometry(0.12, 6, 5));
      const stemG = geo("stem", () => new THREE.CylinderGeometry(0.02, 0.02, 0.35, 4));
      const stemM = new THREE.MeshStandardMaterial({ color: "#4f8a3a", roughness: 0.9 });
      own.push(stemM);
      for (let i = 0; i < 14; i++) {
        const x = (Math.random() - 0.5) * 2.4;
        const z = (Math.random() - 0.5) * 2.4;
        const m = new THREE.MeshStandardMaterial({ color: palette[i % palette.length], roughness: 0.8 });
        own.push(m);
        const s = mesh(stemG, stemM, x, 0.17, z);
        const p = mesh(petalG, m, x, 0.38, z);
        p.castShadow = false;
        s.castShadow = false;
        group.add(s, p);
      }
      break;
    }
    case "crystal": {
      const col = color ?? "#7fd8ff";
      const m = new THREE.MeshPhysicalMaterial({ color: col, emissive: col, emissiveIntensity: 0.7, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.85 });
      own.push(m);
      const oct = geo("oct", () => new THREE.OctahedronGeometry(1, 0));
      const main = mesh(oct, m, 0, 1.1, 0);
      main.scale.set(0.6, 1.3, 0.6);
      const side = mesh(oct, m, 0.6, 0.5, 0.2);
      side.scale.set(0.3, 0.7, 0.3);
      side.rotation.z = -0.5;
      const light = new THREE.PointLight(col, 1.6, 10, 2);
      light.position.y = 1.2;
      group.add(main, side, light);
      update = (dt, time) => {
        main.rotation.y = time * 0.6;
        m.emissiveIntensity = 0.6 + Math.sin(time * 2.2) * 0.25;
        light.intensity = 1.3 + Math.sin(time * 2.2) * 0.5;
      };
      break;
    }
    case "fox": {
      const m = color ? new THREE.MeshStandardMaterial({ color, roughness: 0.9 }) : stone;
      if (color) own.push(m);
      const plinth = mesh(geo("fplinth", () => new THREE.BoxGeometry(0.9, 0.5, 0.9)), stone, 0, 0.25, 0);
      const body = mesh(geo("fbody", () => new THREE.CylinderGeometry(0.25, 0.35, 0.9, 8)), m, 0, 0.95, 0);
      const head = mesh(geo("fhead", () => new THREE.ConeGeometry(0.25, 0.5, 6)), m, 0, 1.55, 0.12);
      head.rotation.x = Math.PI / 2 - 0.3;
      const earG = geo("fear", () => new THREE.ConeGeometry(0.08, 0.25, 4));
      const e1 = mesh(earG, m, -0.13, 1.72, -0.05);
      const e2 = mesh(earG, m, 0.13, 1.72, -0.05);
      const tail = mesh(geo("ftail", () => new THREE.ConeGeometry(0.16, 0.8, 6)), m, 0, 0.9, -0.42);
      tail.rotation.x = -0.6;
      const bib = mesh(geo("fbib", () => new THREE.BoxGeometry(0.34, 0.25, 0.1)), vermilion, 0, 1.25, 0.32);
      group.add(plinth, body, head, e1, e2, tail, bib);
      break;
    }
    case "snowman": {
      const snow = new THREE.MeshStandardMaterial({ color: color ?? "#f4f7fb", roughness: 0.95 });
      own.push(snow);
      const sph = geo("sphere", () => new THREE.SphereGeometry(1, 12, 10));
      const a = mesh(sph, snow, 0, 0.6, 0); a.scale.setScalar(0.65);
      const b = mesh(sph, snow, 0, 1.55, 0); b.scale.setScalar(0.48);
      const c = mesh(sph, snow, 0, 2.25, 0); c.scale.setScalar(0.34);
      const nose = mesh(geo("nose", () => new THREE.ConeGeometry(0.06, 0.35, 5)), new THREE.MeshStandardMaterial({ color: "#ff7a1a" }), 0, 2.25, 0.4);
      nose.rotation.x = Math.PI / 2;
      const hat = mesh(geo("hat", () => new THREE.CylinderGeometry(0.22, 0.22, 0.35, 10)), darkWood, 0, 2.72, 0);
      const brim = mesh(geo("brim", () => new THREE.CylinderGeometry(0.36, 0.36, 0.05, 10)), darkWood, 0, 2.56, 0);
      const armG = geo("arm", () => new THREE.CylinderGeometry(0.03, 0.03, 0.9, 4));
      const l = mesh(armG, darkWood, -0.55, 1.7, 0); l.rotation.z = 0.9;
      const r = mesh(armG, darkWood, 0.55, 1.7, 0); r.rotation.z = -0.9;
      group.add(a, b, c, nose, hat, brim, l, r);
      break;
    }
    case "mushroom": {
      const cap = new THREE.MeshStandardMaterial({ color: color ?? "#e0392b", roughness: 0.7 });
      own.push(cap);
      const stemG = geo("mstem", () => new THREE.CylinderGeometry(0.16, 0.22, 0.7, 8));
      const capG = geo("mcap", () => new THREE.SphereGeometry(0.5, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2));
      const spot = geo("spot", () => new THREE.SphereGeometry(0.06, 5, 4));
      for (let i = 0; i < 3; i++) {
        const s = 0.6 + Math.random() * 0.7;
        const x = (Math.random() - 0.5) * 1.2, z = (Math.random() - 0.5) * 1.2;
        const st = mesh(stemG, paper, x, 0.35 * s, z); st.scale.setScalar(s);
        const cp = mesh(capG, cap, x, 0.6 * s, z); cp.scale.setScalar(s);
        group.add(st, cp);
        for (let k = 0; k < 4; k++) {
          const a = Math.random() * Math.PI * 2;
          const sp = mesh(spot, paper, x + Math.cos(a) * 0.3 * s, 0.6 * s + 0.3 * s, z + Math.sin(a) * 0.3 * s);
          sp.castShadow = false;
          group.add(sp);
        }
      }
      break;
    }
    case "rocket": {
      const bodyMat = new THREE.MeshStandardMaterial({ color: color ?? "#e9e6dd", roughness: 0.5, metalness: 0.2 });
      own.push(bodyMat);
      const ship = new THREE.Group();
      const hull = mesh(new THREE.CylinderGeometry(0.5, 0.6, 3.2, 14), bodyMat, 0, 2.2, 0);
      const nose = mesh(new THREE.ConeGeometry(0.5, 1.2, 14), vermilion, 0, 4.4, 0);
      const finG = geo("fin", () => new THREE.BoxGeometry(0.1, 1.1, 0.7));
      for (let i = 0; i < 3; i++) {
        const f = mesh(finG, vermilion, 0, 0.9, 0);
        const h = new THREE.Group();
        f.position.set(0.7, 0.9, 0);
        h.add(f);
        h.rotation.y = (i / 3) * Math.PI * 2;
        ship.add(h);
      }
      const win = mesh(geo("rwin", () => new THREE.SphereGeometry(0.22, 10, 8)), new THREE.MeshStandardMaterial({ color: "#5ec8ff", emissive: "#5ec8ff", emissiveIntensity: 0.4 }), 0, 3, 0.5);
      const flameMat = new THREE.MeshBasicMaterial({ color: "#ffb03a", transparent: true, opacity: 0.9 });
      own.push(flameMat);
      const flame = mesh(new THREE.ConeGeometry(0.45, 1.6, 10), flameMat, 0, -0.4, 0);
      flame.rotation.x = Math.PI;
      flame.castShadow = false;
      const light = new THREE.PointLight("#ffa33a", 0, 14, 2);
      light.position.y = -0.5;
      ship.add(hull, nose, win, flame, light);
      group.add(ship);
      let age = -1.5; // a moment on the pad before the launch
      update = (dt, time) => {
        age += dt;
        const t = Math.max(0, age);
        // Climbs fast for a few seconds, then hovers high and slowly circles.
        const climb = Math.min(46, t * t * 2.2);
        ship.position.y = climb + (t > 5 ? Math.sin(time * 0.6) * 1.2 : 0);
        ship.rotation.y = time * 0.3;
        ship.rotation.z = t > 5 ? Math.sin(time * 0.4) * 0.12 : Math.sin(time * 40) * 0.01;
        const thrust = t > 0 && t < 5 ? 1 : 0.35;
        flame.scale.set(thrust, 0.8 + Math.sin(time * 30) * 0.3 * thrust + thrust * 0.6, thrust);
        light.intensity = t > 0 ? 3 * thrust + Math.sin(time * 25) * 0.6 : 0;
      };
      break;
    }
    case "ufo": {
      const shell = new THREE.MeshStandardMaterial({ color: color ?? "#9aa4b5", roughness: 0.35, metalness: 0.7 });
      own.push(shell);
      const saucer = new THREE.Group();
      const disc = mesh(new THREE.CylinderGeometry(2.6, 1.6, 0.5, 24), shell, 0, 0, 0);
      const dome = mesh(new THREE.SphereGeometry(1, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshPhysicalMaterial({ color: "#8fe3ff", transparent: true, opacity: 0.55, roughness: 0.1 }), 0, 0.25, 0);
      const lightsMat = new THREE.MeshBasicMaterial({ color: "#ff5cf3" });
      own.push(lightsMat);
      const lg = geo("ulight", () => new THREE.SphereGeometry(0.14, 8, 6));
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        const l = mesh(lg, lightsMat, Math.cos(a) * 2.2, -0.05, Math.sin(a) * 2.2);
        l.castShadow = false;
        saucer.add(l);
      }
      const beamMat = new THREE.MeshBasicMaterial({ color: "#a8ffdc", transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide });
      own.push(beamMat);
      const beam = mesh(new THREE.ConeGeometry(2.4, 22, 20, 1, true), beamMat, 0, -11.2, 0);
      beam.castShadow = false;
      const light = new THREE.PointLight("#a8ffdc", 2.5, 30, 2);
      light.position.y = -1;
      saucer.add(disc, dome, beam, light);
      group.add(saucer);
      update = (dt, time) => {
        saucer.position.y = 22 + Math.sin(time * 0.7) * 1.5;
        saucer.position.x = Math.sin(time * 0.25) * 4;
        saucer.position.z = Math.cos(time * 0.2) * 4;
        saucer.rotation.y = time * 1.6;
        saucer.rotation.z = Math.sin(time * 0.9) * 0.08;
        beamMat.opacity = 0.1 + Math.sin(time * 2.4) * 0.06;
      };
      break;
    }
    case "balloon": {
      const envMat = new THREE.MeshStandardMaterial({ color: color ?? "#ff6b6b", roughness: 0.6 });
      own.push(envMat);
      const stripe = new THREE.MeshStandardMaterial({ color: "#fff1a8", roughness: 0.6 });
      own.push(stripe);
      const rig = new THREE.Group();
      const env = mesh(new THREE.SphereGeometry(2.4, 18, 14), envMat, 0, 4.6, 0);
      env.scale.y = 1.15;
      const band = mesh(new THREE.TorusGeometry(2.42, 0.18, 8, 24), stripe, 0, 4.6, 0);
      band.rotation.x = Math.PI / 2;
      const skirt = mesh(new THREE.ConeGeometry(1.6, 1.4, 14, 1, true), envMat, 0, 2.2, 0);
      skirt.rotation.x = Math.PI;
      const basket = mesh(new THREE.BoxGeometry(1.1, 0.8, 1.1), wood, 0, 0.6, 0);
      const ropeG = geo("brope", () => new THREE.CylinderGeometry(0.02, 0.02, 1.5, 4));
      for (const [x, z] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) rig.add(mesh(ropeG, darkWood, x, 1.6, z));
      const burner = new THREE.PointLight("#ffb347", 0, 8, 2);
      burner.position.y = 1.8;
      rig.add(env, band, skirt, basket, burner);
      group.add(rig);
      let age = 0;
      const phase = Math.random() * 10;
      update = (dt, time, ctx) => {
        age += dt;
        const rise = Math.min(26, age * 1.6);
        rig.position.y = rise + Math.sin(time * 0.5 + phase) * 0.8;
        rig.position.x += Math.sin(ctx.windDir) * (0.3 + ctx.wind * 2.5) * dt;
        rig.position.z += Math.cos(ctx.windDir) * (0.3 + ctx.wind * 2.5) * dt;
        rig.rotation.z = Math.sin(time * 0.7 + phase) * 0.04 * (1 + ctx.wind * 3);
        burner.intensity = (Math.sin(time * 3 + phase) > 0.7 ? 2.5 : 0) * (ctx.night > 0.3 ? 1 : 0.4);
      };
      break;
    }
    case "birds": {
      const birdMat = new THREE.MeshStandardMaterial({ color: color ?? "#2a2a30", roughness: 0.9, side: THREE.DoubleSide });
      own.push(birdMat);
      const flock = new THREE.Group();
      const birds: Array<{ g: THREE.Group; l: THREE.Mesh; r: THREE.Mesh; r0: number; a0: number; y0: number; spd: number }> = [];
      const wingG = geo("wing", () => { const g = new THREE.PlaneGeometry(0.55, 0.22); g.translate(0.27, 0, 0); return g; });
      const n = 12;
      for (let i = 0; i < n; i++) {
        const g = new THREE.Group();
        const l = new THREE.Mesh(wingG, birdMat);
        l.rotation.y = Math.PI;
        const r = new THREE.Mesh(wingG, birdMat);
        g.add(l, r);
        flock.add(g);
        birds.push({ g, l, r, r0: 4 + Math.random() * 9, a0: Math.random() * Math.PI * 2, y0: 12 + Math.random() * 6, spd: 0.5 + Math.random() * 0.4 });
      }
      group.add(flock);
      update = (dt, time) => {
        for (const b of birds) {
          const a = b.a0 + time * b.spd;
          b.g.position.set(Math.cos(a) * b.r0, b.y0 + Math.sin(time * 1.3 + b.a0) * 0.8, Math.sin(a) * b.r0);
          b.g.rotation.y = -a;
          const flap = Math.sin(time * 9 + b.a0) * 0.7;
          b.l.rotation.z = flap;
          b.r.rotation.z = -flap;
        }
      };
      break;
    }
    case "windmill": {
      const tower = mesh(new THREE.CylinderGeometry(0.7, 1.1, 5, 8), plaster, 0, 2.5, 0);
      const roof = mesh(new THREE.ConeGeometry(1, 1.2, 8), tile, 0, 5.6, 0);
      const hub = new THREE.Group();
      hub.position.set(0, 4.6, 0.9);
      const bladeG = geo("blade", () => new THREE.BoxGeometry(0.5, 3.4, 0.06));
      const bladeMat = color ? new THREE.MeshStandardMaterial({ color, roughness: 0.8 }) : wood;
      if (color) own.push(bladeMat);
      for (let i = 0; i < 4; i++) {
        const b = mesh(bladeG, bladeMat, 0, 1.7, 0);
        const holder = new THREE.Group();
        holder.add(b);
        holder.rotation.z = (i / 4) * Math.PI * 2;
        hub.add(holder);
      }
      group.add(tower, roof, hub);
      update = (dt, _time, ctx) => { hub.rotation.z += dt * (0.3 + ctx.wind * 3); };
      break;
    }
  }

  const swayPhase = Math.random() * 10;
  const baseUpdate = update;
  update = (dt, time, ctx) => {
    baseUpdate?.(dt, time, ctx);
    if (sway.length) {
      const a = Math.sin(time * (1.1 + ctx.wind * 2) + swayPhase) * (0.01 + ctx.wind * 0.07);
      for (const s of sway) { s.rotation.z = a * Math.cos(ctx.windDir); s.rotation.x = a * Math.sin(ctx.windDir); }
    }
    if (lamp) {
      const target = ctx.lanterns ? lamp.base * (0.75 + Math.sin(time * 6 + swayPhase) * 0.12) : 0;
      lamp.light.intensity += (target - lamp.light.intensity) * Math.min(1, dt * 3);
      (lamp.glow as THREE.MeshStandardMaterial).emissiveIntensity = lamp.light.intensity / lamp.base;
    }
  };

  return {
    group,
    update,
    foliage: mats,
    lamp,
    dispose() {
      for (const m of own) m.dispose();
      group.traverse((o) => {
        const me = o as THREE.Mesh;
        if (me.isMesh && !geoCache.has(me.geometry.uuid) && ![...geoCache.values()].includes(me.geometry)) me.geometry.dispose();
      });
    },
  };
}

/**
 * A forest as a handful of draw calls.
 *
 * Two hundred and forty trees built one at a time are seventeen hundred
 * meshes, which is fine on a desktop GPU and a slideshow on a headset. So the
 * fixed forest is merged: one geometry per species for the canopies (so the
 * season can still recolour each species through its one material) and one
 * for all the trunks. These trees do not sway; the conjured ones still do.
 */
export type TreeKind = "tree" | "sakura" | "maple" | "pine";

export interface Forest {
  group: THREE.Group;
  /** One material per species, for the season to recolour. */
  foliage: Record<TreeKind, THREE.MeshStandardMaterial>;
  dispose(): void;
}

export function buildForest(trees: Array<{ kind: TreeKind; x: number; z: number; yaw: number; scale: number }>, season: Season): Forest {
  const group = new THREE.Group();
  const foliage = {
    tree: canopyMaterial(FOLIAGE[season].tree),
    sakura: canopyMaterial(FOLIAGE[season].sakura),
    maple: canopyMaterial(FOLIAGE[season].maple),
    pine: canopyMaterial(FOLIAGE[season].pine),
  };
  const canopyParts: Record<TreeKind, THREE.BufferGeometry[]> = { tree: [], sakura: [], maple: [], pine: [] };
  const trunkParts: THREE.BufferGeometry[] = [];
  const blob = new THREE.IcosahedronGeometry(1, 1);
  const cone = new THREE.ConeGeometry(1, 1, 8);
  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.22, 1, 7);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const tree = new THREE.Matrix4();
  const part = (g: THREE.BufferGeometry, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    m.compose(p.set(x, y, z), q.identity(), s.set(sx, sy, sz)).premultiply(tree);
    const c = g.clone();
    c.applyMatrix4(m);
    return c;
  };
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  for (const t of trees) {
    tree.compose(p.set(t.x, heightAt(t.x, t.z), t.z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.yaw), s.set(t.scale, t.scale, t.scale));
    if (t.kind === "pine") {
      const h = 3 + rnd() * 2;
      trunkParts.push(part(trunkGeo, 0, h * 0.35, 0, 1, h * 0.7, 1));
      for (let i = 0; i < 3; i++) canopyParts.pine.push(part(cone, 0, h * 0.45 + i * h * 0.22, 0, 1.5 - i * 0.35, h * 0.45, 1.5 - i * 0.35));
    } else {
      const h = 2.2 + rnd() * 1.2;
      trunkParts.push(part(trunkGeo, 0, h / 2, 0, 1, h, 1));
      const r = t.kind === "sakura" ? 1.7 : 1.5;
      const y = h - 0.4;
      const n = 5;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + 0.7;
        const k = r * (0.7 + (i % 3) * 0.12);
        canopyParts[t.kind].push(part(blob, Math.cos(a) * r * 0.45, y + (i % 2) * r * 0.3, Math.sin(a) * r * 0.45, k, k, k));
      }
      canopyParts[t.kind].push(part(blob, 0, y + r * 0.5, 0, r * 0.85, r * 0.85, r * 0.85));
    }
  }
  const merged: THREE.BufferGeometry[] = [];
  for (const kind of Object.keys(canopyParts) as TreeKind[]) {
    const parts = canopyParts[kind];
    if (!parts.length) continue;
    const g = mergeGeometries(parts, false);
    if (!g) continue;
    const mesh = new THREE.Mesh(g, foliage[kind]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `forest-${kind}`;
    group.add(mesh);
    merged.push(g);
    for (const pg of parts) pg.dispose();
  }
  if (trunkParts.length) {
    const g = mergeGeometries(trunkParts, false);
    if (g) {
      const mesh = new THREE.Mesh(g, trunk);
      mesh.castShadow = true;
      mesh.name = "forest-trunks";
      group.add(mesh);
      merged.push(g);
    }
    for (const pg of trunkParts) pg.dispose();
  }
  blob.dispose(); cone.dispose(); trunkGeo.dispose();
  return {
    group,
    foliage,
    dispose() {
      for (const g of merged) g.dispose();
      for (const mat of Object.values(foliage)) mat.dispose();
    },
  };
}

/** The wooden sign by the bridge: a canvas texture so Vibey can rewrite it. */
export interface Sign {
  group: THREE.Group;
  setText(text: string): void;
  dispose(): void;
}

export function buildSign(): Sign {
  const group = new THREE.Group();
  const post = mesh(new THREE.CylinderGeometry(0.07, 0.09, 1.6, 6), darkWood, 0, 0.8, 0);
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 192;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const boardMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
  const board = mesh(new THREE.BoxGeometry(1.6, 0.6, 0.06), boardMat, 0, 1.55, 0);
  group.add(post, board);
  const draw = (text: string) => {
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#8a6238";
    ctx.fillRect(0, 0, 512, 192);
    ctx.strokeStyle = "#5a3d20";
    ctx.lineWidth = 10;
    ctx.strokeRect(6, 6, 500, 180);
    ctx.fillStyle = "#f6e9c8";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let size = 54;
    ctx.font = `600 ${size}px Georgia, serif`;
    while (ctx.measureText(text).width > 460 && size > 20) { size -= 4; ctx.font = `600 ${size}px Georgia, serif`; }
    ctx.fillText(text, 256, 96);
    tex.needsUpdate = true;
  };
  draw("Welcome");
  return {
    group,
    setText: draw,
    dispose() { tex.dispose(); boardMat.dispose(); },
  };
}

/** The supporters' board: a taller sign with up to eight lines on it. */
export interface Board {
  group: THREE.Group;
  setLines(title: string, lines: string[]): void;
  dispose(): void;
}

export function buildBoard(): Board {
  const group = new THREE.Group();
  const postG = new THREE.BoxGeometry(0.12, 2.6, 0.12);
  group.add(mesh(postG, darkWood, -0.9, 1.3, 0), mesh(postG, darkWood, 0.9, 1.3, 0));
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 640;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const boardMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
  const board = mesh(new THREE.BoxGeometry(2.1, 1.75, 0.06), boardMat, 0, 1.75, 0);
  const roof = mesh(new THREE.BoxGeometry(2.4, 0.08, 0.5), tile, 0, 2.68, 0);
  const lamp = new THREE.PointLight("#ffd28a", 0.8, 5, 2);
  lamp.position.set(0, 2.5, 0.5);
  group.add(board, roof, lamp);
  const draw = (title: string, lines: string[]) => {
    const c = canvas.getContext("2d")!;
    c.fillStyle = "#8a6238";
    c.fillRect(0, 0, 768, 640);
    c.strokeStyle = "#5a3d20";
    c.lineWidth = 12;
    c.strokeRect(8, 8, 752, 624);
    c.fillStyle = "#f6e9c8";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.font = "600 44px Georgia, serif";
    c.fillText(title, 384, 60);
    c.font = "400 30px Georgia, serif";
    const shown = lines.slice(0, 9);
    if (!shown.length) { c.font = "italic 30px Georgia, serif"; c.fillText("Your name could be first.", 384, 320); }
    shown.forEach((l, i) => {
      let t = l;
      while (c.measureText(t).width > 700 && t.length > 4) t = t.slice(0, -4) + "…";
      c.fillText(t, 384, 120 + i * 56);
    });
    tex.needsUpdate = true;
  };
  draw("Supporters of Hoshimura", []);
  return {
    group,
    setLines: draw,
    dispose() { tex.dispose(); boardMat.dispose(); postG.dispose(); },
  };
}

/** The bridge over the river at the east end of the village road. */
export function buildBridge(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const rc = riverCentre(z);
  const span = 24;
  const deck = mesh(new THREE.BoxGeometry(span, 0.25, 3), wood, 0, 0, 0);
  deck.receiveShadow = true;
  g.add(deck);
  for (let i = -1; i <= 1; i += 2) {
    const rail = mesh(new THREE.BoxGeometry(span, 0.08, 0.08), darkWood, 0, 1, i * 1.4);
    g.add(rail);
    for (let k = -5; k <= 5; k++) {
      const p = mesh(geo("bpost", () => new THREE.BoxGeometry(0.1, 1, 0.1)), darkWood, k * (span / 11), 0.5, i * 1.4);
      g.add(p);
    }
  }
  // Pilings down into the water.
  for (let k = -2; k <= 2; k++) {
    const p = mesh(geo("piling", () => new THREE.CylinderGeometry(0.16, 0.18, 3, 6)), darkWood, k * 5, -1.4, 0);
    g.add(p);
  }
  const y = Math.max(heightAt(rc - 12, z), heightAt(rc + 12, z)) + 0.35;
  g.position.set(rc, Math.max(y, WATER_LEVEL + 1.4), z);
  void x;
  return g;
}

export function disposeSharedProps(): void {
  for (const g of geoCache.values()) g.dispose();
  geoCache.clear();
}
