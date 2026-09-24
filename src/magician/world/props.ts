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
import { buildMinka, disposeMinkaMaterials } from "./house";
import { buildInterior, type Interior } from "./interior";
import { disposeSurfaces, surfaceMaterial } from "./textures";
import type { PropKind, Season } from "../state";

export interface PropObject {
  group: THREE.Group;
  /** Per-frame hook for things that move or glow. */
  update?(dt: number, time: number, ctx: PropContext): void;
  /** Whether this thing has foliage that follows the season. */
  foliage?: THREE.Material[];
  /** Lights that follow `lanternsLit`. */
  /**
   * Something that glows at dusk. It has no light of its own: the world
   * keeps a small pool of point lights and moves them to the lamps nearest
   * the player, because twenty lights in a forward renderer cost twenty
   * lights on every pixel, which a headset cannot pay. `level` is the
   * current glow, 0 to 1, for the pool to copy.
   */
  lamp?: { glow: THREE.Material; at: THREE.Vector3; color: THREE.Color; power: number; level: number };
  /** Half extents, in the prop's own frame and scale, of a footprint the player cannot walk through. */
  solid?: [number, number];
  /** A house you can walk into: its wall segments, its room and what is in it. */
  house?: { walls: Array<[number, number, number, number]>; room: NonNullable<ReturnType<typeof buildMinka>["room"]>; interior: Interior };
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
let lanternStoneMat: THREE.MeshStandardMaterial | null = null;
/** Weathered granite with moss, shared by every lantern. */
function lanternStone(): THREE.MeshStandardMaterial {
  if (!lanternStoneMat) lanternStoneMat = surfaceMaterial("stone", { color: "#b8b2a6", roughness: 0.95, bumpScale: 1.4 });
  return lanternStoneMat;
}

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

export function buildProp(kind: PropKind, season: Season, color?: string, opts: { open?: boolean } = {}): PropObject {
  const group = new THREE.Group();
  const mats: THREE.Material[] = [];
  const own: THREE.Material[] = [];
  let update: PropObject["update"];
  let lamp: PropObject["lamp"];
  let solid: PropObject["solid"];
  let house: PropObject["house"];
  let lampAlways = false;
  const disposers: Array<() => void> = [];
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
      // A kasuga-doro: hexagonal base, a slender post with a collar, a
      // platform, the fire box with its paper windows, a wide roof with
      // flared eaves, and the jewel on top. About 1.9 m tall.
      const stoneM = lanternStone();
      const hex = (r0: number, r1: number, h: number) => geo(`hex${r0}-${r1}-${h}`, () => new THREE.CylinderGeometry(r0, r1, h, 6));
      const collar = mesh(geo("lcollar", () => new THREE.TorusGeometry(0.115, 0.025, 6, 12)), stoneM, 0, 0.62, 0);
      collar.rotation.x = Math.PI / 2;
      group.add(
        mesh(hex(0.34, 0.4, 0.14), stoneM, 0, 0.07, 0),
        mesh(hex(0.26, 0.32, 0.12), stoneM, 0, 0.2, 0),
        mesh(geo("lpost", () => new THREE.CylinderGeometry(0.1, 0.12, 0.75, 10)), stoneM, 0, 0.63, 0),
        collar,
        mesh(hex(0.3, 0.24, 0.13), stoneM, 0, 1.06, 0),
      );
      const glowMat = new THREE.MeshStandardMaterial({ color: color ?? "#f6e2b8", emissive: color ?? "#ffb04a", emissiveIntensity: 0, roughness: 0.7 });
      own.push(glowMat);
      const fire = mesh(hex(0.17, 0.17, 0.3), glowMat, 0, 1.28, 0);
      fire.castShadow = false;
      group.add(fire);
      // Six stone posts around the fire box, so the paper shows between them.
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
        group.add(mesh(geo("lcorner", () => new THREE.BoxGeometry(0.05, 0.32, 0.05)), stoneM, Math.cos(a) * 0.19, 1.28, Math.sin(a) * 0.19));
      }
      const roofMesh = mesh(geo("lkasa", () => {
        const g = new THREE.CylinderGeometry(0.06, 0.5, 0.26, 6, 2);
        // Flare the eaves: push the bottom ring out and up at the corners.
        const p = g.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < p.count; i++) {
          if (p.getY(i) < -0.12) p.setXYZ(i, p.getX(i) * 1.08, p.getY(i) + 0.05, p.getZ(i) * 1.08);
        }
        g.computeVertexNormals();
        return g;
      }), stoneM, 0, 1.56, 0);
      group.add(roofMesh);
      group.add(mesh(geo("ljewel", () => new THREE.SphereGeometry(0.075, 10, 8)), stoneM, 0, 1.74, 0));
      group.add(mesh(geo("ltip", () => new THREE.ConeGeometry(0.04, 0.09, 8)), stoneM, 0, 1.83, 0));
      lamp = { glow: glowMat, at: new THREE.Vector3(0, 1.3, 0), color: new THREE.Color(color ?? "#ffb04a"), power: 2.4, level: 0 };
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
      // A full minka, merged to a handful of draw calls. See house.ts.
      const seed = Math.floor(Math.random() * 1e9);
      const minka = buildMinka(seed, { open: opts.open });
      group.add(minka.group);
      if (opts.open && minka.walls && minka.room) {
        // A house you can walk into: the hearth is its lamp, always lit, and
        // the shoji glow a little all day from the fire behind them.
        const interior = buildInterior(minka.room, seed);
        group.add(interior.group);
        house = { walls: minka.walls, room: minka.room, interior };
        disposers.push(() => interior.dispose());
        const l = { glow: minka.glow, at: interior.hearth.clone(), color: new THREE.Color("#ff9048"), power: 3.6, level: 0.9 };
        lamp = l;
        lampAlways = true;
        let shoji = 0;
        update = (dt, time, ctx) => {
          shoji += ((ctx.lanterns ? 1 : 0.22) - shoji) * Math.min(1, dt * 2);
          minka.glow.emissiveIntensity = shoji * (1.5 + Math.sin(time * 5.3) * 0.08);
          l.level = 0.85 + Math.sin(time * 7.1) * 0.06 + Math.sin(time * 13.7) * 0.04;
        };
      } else {
        lamp = { glow: minka.glow, at: minka.lampAt.clone(), color: new THREE.Color("#ffb866"), power: 1.8, level: 0 };
        solid = minka.half;
      }
      disposers.push(() => minka.dispose());
      break;
    }
    case "shrine": {
      solid = [2.1, 1.8];
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
    if (lamp && !lampAlways) {
      const target = ctx.lanterns ? 0.8 + Math.sin(time * 6 + swayPhase) * 0.1 + Math.sin(time * 17 + swayPhase * 3) * 0.05 : 0;
      lamp.level += (target - lamp.level) * Math.min(1, dt * 3);
      (lamp.glow as THREE.MeshStandardMaterial).emissiveIntensity = lamp.level * 1.6;
    }
  };

  return {
    group,
    update,
    foliage: mats,
    lamp,
    solid,
    house,
    dispose() {
      for (const f of disposers) f();
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
 * Hundreds of trees built one at a time would be thousands of meshes, fine on
 * a desktop and a slideshow on a headset. So the fixed forest is merged: one
 * geometry per species for the crowns (so a season recolours a species
 * through its one material) and one for every trunk.
 *
 * The crowns are what make or break a landscape, so each is built the way a
 * painter would: a cluster of lumpy clumps on an ellipsoid, lit as one soft
 * volume (normals point out from the crown's centre, not from each facet),
 * darker underneath and inside, lighter where the sky reaches, each clump a
 * little different in tone. Japanese cedar (sugi) is a stack of narrowing
 * tiers. Everything sways in the vertex shader, more at the top of a tree
 * than at the bottom, along the world's own wind.
 *
 * `far` trees are cheap three-tier cedars for the hillsides: a valley's
 * walls read as forest only when there are hundreds of them.
 */
export type TreeKind = "tree" | "sakura" | "maple" | "pine";

export interface Forest {
  group: THREE.Group;
  /** One material per species, for the season to recolour. */
  foliage: Record<TreeKind, THREE.MeshStandardMaterial>;
  /** Advance the sway. */
  update(time: number, windDir: number, wind: number): void;
  dispose(): void;
}

interface TreeSpec { kind: TreeKind; x: number; z: number; yaw: number; scale: number; far?: boolean }

const FOREST_WIND_VERT_HEAD = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform float uWindStrength;
attribute float aSway;
`;
const FOREST_WIND_VERT = /* glsl */ `
#include <begin_vertex>
float ph = transformed.x * 0.13 + transformed.z * 0.11;
float sway = (sin(uTime * 1.1 + ph) * 0.6 + sin(uTime * 2.3 + ph * 1.7) * 0.25) * (0.05 + uWindStrength * 0.32) * aSway;
transformed.xz += uWind * sway;
transformed.xz += vec2(sin(uTime * 3.1 + ph * 5.0), cos(uTime * 2.7 + ph * 4.0)) * 0.025 * aSway * (0.3 + uWindStrength);
`;

function crownMaterial(color: string, uniforms: Record<string, THREE.IUniform>): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.92, vertexColors: true });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + FOREST_WIND_VERT_HEAD)
      .replace("#include <begin_vertex>", FOREST_WIND_VERT);
  };
  m.customProgramCacheKey = () => "magician-crown";
  return m;
}

export function buildForest(trees: TreeSpec[], season: Season): Forest {
  const group = new THREE.Group();
  group.name = "forest";
  const windUniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(1, 0) }, uWindStrength: { value: 0.25 } };
  const foliage = {
    tree: crownMaterial(FOLIAGE[season].tree, windUniforms),
    sakura: crownMaterial(FOLIAGE[season].sakura, windUniforms),
    maple: crownMaterial(FOLIAGE[season].maple, windUniforms),
    pine: crownMaterial(FOLIAGE[season].pine, windUniforms),
  };
  const barkMat = surfaceMaterial("timber", { color: "#8a7462", roughness: 0.95 });
  const crowns: Record<TreeKind, THREE.BufferGeometry[]> = { tree: [], sakura: [], maple: [], pine: [] };
  const trunks: THREE.BufferGeometry[] = [];

  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const blobHi = new THREE.IcosahedronGeometry(1, 1);
  const blobLo = new THREE.IcosahedronGeometry(1, 0);
  const coneG = new THREE.ConeGeometry(1, 1, 9, 1).toNonIndexed();
  const coneLo = new THREE.ConeGeometry(1, 1, 6, 1).toNonIndexed();
  const trunkG = new THREE.CylinderGeometry(0.7, 1, 1, 7, 1);

  /**
   * One clump: a lumpy sphere at (cx, cy, cz) of radius r, with normals and
   * shade taken relative to the crown centre (ox, oy, oz), so the whole crown
   * lights as one volume.
   */
  const clump = (out: THREE.BufferGeometry[], lo: boolean, cx: number, cy: number, cz: number, r: number, crown: THREE.Vector3, crownR: number, treeBase: number, treeTop: number, tone: number) => {
    const g = (lo ? blobLo : blobHi).clone();
    const p = g.attributes.position as THREE.BufferAttribute;
    const n = new Float32Array(p.count * 3);
    const c = new Float32Array(p.count * 3);
    const sway = new Float32Array(p.count);
    const v = new THREE.Vector3();
    const j = rnd() * 100;
    for (let i = 0; i < p.count; i++) {
      v.set(p.getX(i), p.getY(i), p.getZ(i));
      // Position-keyed lumps, so duplicated corners of the non-indexed
      // geometry move together and the clump never tears.
      const bump = 0.82 + 0.3 * Math.abs(Math.sin(v.x * 7.1 + v.y * 5.3 + v.z * 3.7 + j));
      v.multiplyScalar(r * bump).add(new THREE.Vector3(cx, cy, cz));
      p.setXYZ(i, v.x, v.y, v.z);
      const out2 = v.clone().sub(crown);
      const nn = out2.clone().normalize();
      n[i * 3] = nn.x; n[i * 3 + 1] = nn.y * 0.8 + 0.2; n[i * 3 + 2] = nn.z;
      // Shade: dark underneath and deep inside, bright on top and outside.
      const up = Math.max(0, Math.min(1, (v.y - (crown.y - crownR)) / (crownR * 2)));
      const outside = Math.min(1, out2.length() / crownR);
      const shade = (0.62 + 0.38 * up) * (0.78 + 0.3 * outside) * tone;
      c[i * 3] = shade; c[i * 3 + 1] = shade; c[i * 3 + 2] = shade * 0.96;
      sway[i] = Math.max(0, Math.min(1, (v.y - treeBase) / Math.max(0.1, treeTop - treeBase))) ** 1.5;
    }
    g.setAttribute("normal", new THREE.BufferAttribute(n, 3));
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    g.setAttribute("aSway", new THREE.BufferAttribute(sway, 1));
    g.deleteAttribute("uv");
    out.push(g);
  };

  const cone = (out: THREE.BufferGeometry[], lo: boolean, cx: number, cy: number, cz: number, r: number, h: number, base: number, top: number, tone: number) => {
    const g = (lo ? coneLo : coneG).clone();
    g.scale(r, h, r);
    g.translate(cx, cy, cz);
    g.computeVertexNormals();
    const p = g.attributes.position as THREE.BufferAttribute;
    const c = new Float32Array(p.count * 3);
    const sway = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      const up = Math.max(0, Math.min(1, (y - base) / Math.max(0.1, top - base)));
      const rim = Math.min(1, Math.hypot(p.getX(i) - cx, p.getZ(i) - cz) / Math.max(0.01, r));
      const shade = (0.55 + 0.4 * up) * (0.8 + 0.25 * rim) * tone;
      c[i * 3] = shade; c[i * 3 + 1] = shade; c[i * 3 + 2] = shade;
      sway[i] = up ** 1.5;
    }
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    g.setAttribute("aSway", new THREE.BufferAttribute(sway, 1));
    g.deleteAttribute("uv");
    out.push(g);
  };

  const trunk = (x: number, y: number, z: number, r: number, h: number, lean: number, yaw: number) => {
    const g = trunkG.clone();
    g.scale(r, h, r);
    g.translate(0, h / 2, 0);
    g.rotateZ(lean);
    g.rotateY(yaw);
    g.translate(x, y, z);
    trunks.push(g);
  };

  for (const t of trees) {
    const gy = heightAt(t.x, t.z) - 0.05;
    const s = t.scale;
    const lo = Boolean(t.far);
    const tone = 0.85 + rnd() * 0.3;
    if (t.kind === "pine") {
      // Sugi: a straight trunk and narrowing tiers.
      const H = (t.far ? 9 + rnd() * 6 : 6 + rnd() * 3) * s;
      trunk(t.x, gy, t.z, 0.28 * s, H * 0.5, 0, 0);
      const tiers = t.far ? 3 : 6;
      for (let i = 0; i < tiers; i++) {
        const f = i / tiers;
        const r = (1.5 - f * 1.15) * s * (t.far ? 1.3 : 1);
        const cy = gy + H * (0.28 + f * 0.68);
        const jx = (rnd() - 0.5) * 0.25 * s, jz = (rnd() - 0.5) * 0.25 * s;
        cone(crowns.pine, lo, t.x + jx, cy, t.z + jz, r, H * (t.far ? 0.42 : 0.26), gy + H * 0.2, gy + H, tone * (0.85 + f * 0.2));
      }
      continue;
    }
    const sakura = t.kind === "sakura";
    const maple = t.kind === "maple";
    const H = (sakura ? 2.2 : maple ? 2.6 : 3) * s + rnd() * 0.8;
    const rx = (sakura ? 2.7 : maple ? 1.9 : 2.2) * s;
    const ry = (sakura ? 1.35 : 1.6) * s;
    const lean = (rnd() - 0.5) * (sakura ? 0.25 : 0.12);
    const yaw = rnd() * Math.PI * 2;
    trunk(t.x, gy, t.z, (sakura ? 0.2 : 0.22) * s, H + ry * 0.4, lean, yaw);
    // Two or three limbs reaching into the crown.
    const limbs = sakura ? 3 : 2;
    for (let k = 0; k < limbs; k++) trunk(t.x, gy + H * 0.55, t.z, 0.09 * s, ry * 1.6, 0.55 + rnd() * 0.35, yaw + (k / limbs) * Math.PI * 2);
    const crown = new THREE.Vector3(t.x + Math.sin(yaw) * lean * H, gy + H + ry * 0.55, t.z + Math.cos(yaw) * lean * H);
    const count = sakura ? 11 : maple ? 10 : 9;
    for (let k = 0; k < count; k++) {
      // Points on the crown's ellipsoid by a golden spiral, pulled in a bit.
      const f = (k + 0.5) / count;
      const phi = Math.acos(1 - 2 * f);
      const th = k * 2.39996 + yaw;
      const px = Math.sin(phi) * Math.cos(th) * rx * 0.62;
      const py = Math.cos(phi) * ry * 0.6;
      const pz = Math.sin(phi) * Math.sin(th) * rx * 0.62;
      const r = (sakura ? 0.95 : 0.9) * s * (0.8 + rnd() * 0.4);
      clump(crowns[t.kind], lo, crown.x + px, crown.y + py, crown.z + pz, r, crown, Math.max(rx, ry), gy, crown.y + ry, tone * (0.9 + rnd() * 0.2));
    }
    clump(crowns[t.kind], lo, crown.x, crown.y + ry * 0.55, crown.z, rx * 0.5, crown, Math.max(rx, ry), gy, crown.y + ry, tone);
  }

  const merged: THREE.BufferGeometry[] = [];
  for (const kind of Object.keys(crowns) as TreeKind[]) {
    const parts = crowns[kind];
    if (!parts.length) continue;
    const g = mergeGeometries(parts, false);
    for (const pg of parts) pg.dispose();
    if (!g) continue;
    const mesh = new THREE.Mesh(g, foliage[kind]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `forest-${kind}`;
    group.add(mesh);
    merged.push(g);
  }
  if (trunks.length) {
    const g = mergeGeometries(trunks, false);
    for (const pg of trunks) pg.dispose();
    if (g) {
      const mesh = new THREE.Mesh(g, barkMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = "forest-trunks";
      group.add(mesh);
      merged.push(g);
    }
  }
  blobHi.dispose(); blobLo.dispose(); coneG.dispose(); coneLo.dispose(); trunkG.dispose();
  return {
    group,
    foliage,
    update(time, windDir, wind) {
      windUniforms.uTime.value = time;
      windUniforms.uWind.value.set(Math.sin(windDir), Math.cos(windDir));
      windUniforms.uWindStrength.value = wind;
    },
    dispose() {
      for (const g of merged) g.dispose();
      for (const mat of Object.values(foliage)) mat.dispose();
      barkMat.dispose();
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
  group.add(board, roof);
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
export function disposeSharedProps(): void {
  for (const g of geoCache.values()) g.dispose();
  geoCache.clear();
  disposeMinkaMaterials();
  lanternStoneMat?.dispose();
  lanternStoneMat = null;
  disposeSurfaces();
}
