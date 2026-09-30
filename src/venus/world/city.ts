/**
 * The city you can see.
 *
 * `CityView.sync(tiles)` is the only way in: it diffs the sim's tile list
 * against what is on screen, grows anything new and drops anything gone off
 * the edge. Everything else here is procedural geometry, because a cloud
 * city is mostly spheres, and spheres are the one thing three draws well
 * with no assets at all.
 *
 * `buildCity()` is also used for the neighbours on the horizon, with a random
 * layout — the same factory at a thousandth of the attention.
 */
import * as THREE from "three";
import { MODULES, hexToWorld, SLOT, type ModuleId, type Hex } from "../modules";
import type { Tile } from "../sim";
import { ENVELOPE_FRAG, ENVELOPE_VERT, GLASS_FRAG, GLASS_VERT } from "./shaders";

export interface Look {
  sunDir: THREE.Vector3;
  sunCol: THREE.Color;
  ceiling: THREE.Color;
  horizon: THREE.Color;
  night: number;
}

/* ----------------------------------------------------------- materials */

export class Palette {
  // Champagne ceramic, not black steel: this is a utopia, and it should look
  // like somewhere you would want to have breakfast.
  deck = new THREE.MeshStandardMaterial({ color: 0xcdbca2, roughness: 0.62, metalness: 0.12 });
  deckDark = new THREE.MeshStandardMaterial({ color: 0x8a7a66, roughness: 0.7, metalness: 0.2 });
  trim = new THREE.MeshStandardMaterial({ color: 0xd9b36c, roughness: 0.28, metalness: 0.92 });
  ceramic = new THREE.MeshStandardMaterial({ color: 0xf1ebe1, roughness: 0.42, metalness: 0.05 });
  carbon = new THREE.MeshStandardMaterial({ color: 0x2a2623, roughness: 0.5, metalness: 0.3 });
  copper = new THREE.MeshStandardMaterial({ color: 0xe0956a, roughness: 0.3, metalness: 0.8 });
  bronze = new THREE.MeshStandardMaterial({ color: 0xc8a070, roughness: 0.4, metalness: 0.6 });
  solar = new THREE.MeshStandardMaterial({ color: 0x2a4a8a, roughness: 0.16, metalness: 0.6, emissive: 0x0a1630, emissiveIntensity: 0.6 });
  grass = new THREE.MeshStandardMaterial({ color: 0x6f9c47, roughness: 0.9 });
  leaf = new THREE.MeshStandardMaterial({ color: 0x4f8c3a, roughness: 0.8 });
  leaf2 = new THREE.MeshStandardMaterial({ color: 0x8cb84e, roughness: 0.8 });
  blossom = new THREE.MeshStandardMaterial({ color: 0xf2a6c4, roughness: 0.75 });
  bark = new THREE.MeshStandardMaterial({ color: 0x5a4030, roughness: 0.9 });
  palace = new THREE.MeshStandardMaterial({ color: 0xf2c232, roughness: 0.55 });
  white = new THREE.MeshStandardMaterial({ color: 0xfbf7ee, roughness: 0.5 });
  gold = new THREE.MeshStandardMaterial({ color: 0xffcf5a, roughness: 0.22, metalness: 1.0 });
  pad = new THREE.MeshStandardMaterial({ color: 0x4a4540, roughness: 0.6, metalness: 0.4 });
  nano = new THREE.MeshStandardMaterial({ color: 0x15131a, roughness: 0.25, metalness: 0.85, flatShading: true });

  /** Emissive things that brighten after dark. [material, base colour, day floor] */
  glows: Array<[THREE.MeshBasicMaterial, THREE.Color, number]> = [];
  windowWarm = this.glow(0xffc27a, 0.25);
  windowCool = this.glow(0xbfe8ff, 0.25);
  beacon = this.glow(0xff5a3c, 1.0);
  cyan = this.glow(0x6ff6ff, 0.8);
  magenta = this.glow(0xff5ad2, 0.8);
  violet = this.glow(0xa77bff, 0.8);
  neon = this.glow(0xff8a4a, 0.6);
  water = this.glow(0x5fc8ff, 0.7);
  padLight = this.glow(0x9fffd6, 0.35);

  shared: Record<string, { value: unknown }> = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color(1, 1, 1) },
    uCeiling: { value: new THREE.Color(1, 1, 1) },
    uHorizon: { value: new THREE.Color(1, 1, 1) },
    uNight: { value: 0 },
  };

  glass = this.makeGlass(0xbfe6ff, 0);
  glassGhost = this.makeGlass(0x8ff0ff, 1);
  envelopes = new Map<number, THREE.ShaderMaterial>();

  private accents = new Map<string, THREE.MeshBasicMaterial>();
  /** A module's own signal colour, as a light strip that comes up at dusk. */
  accent(hex: string) {
    let m = this.accents.get(hex);
    if (!m) { m = this.glow(new THREE.Color(hex).getHex(), 0.15); this.accents.set(hex, m); }
    return m;
  }

  private glow(hex: number, dayFloor: number) {
    const base = new THREE.Color(hex);
    const m = new THREE.MeshBasicMaterial({ color: base.clone(), fog: true });
    this.glows.push([m, base, dayFloor]);
    return m;
  }

  makeGlass(tint: number, ghost: number) {
    return new THREE.ShaderMaterial({
      uniforms: {
        ...this.shared,
        uTint: { value: new THREE.Color(tint) },
        uGhost: { value: ghost },
      },
      vertexShader: GLASS_VERT,
      fragmentShader: GLASS_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  envelope(hex: number) {
    let m = this.envelopes.get(hex);
    if (!m) {
      m = new THREE.ShaderMaterial({
        uniforms: { ...this.shared, uColor: { value: new THREE.Color(hex) } },
        vertexShader: ENVELOPE_VERT,
        fragmentShader: ENVELOPE_FRAG,
      });
      this.envelopes.set(hex, m);
    }
    return m;
  }

  update(look: Look) {
    (this.shared.uSunDir.value as THREE.Vector3).copy(look.sunDir);
    (this.shared.uSunCol.value as THREE.Color).copy(look.sunCol);
    (this.shared.uCeiling.value as THREE.Color).copy(look.ceiling);
    (this.shared.uHorizon.value as THREE.Color).copy(look.horizon);
    this.shared.uNight.value = look.night;
    for (const [m, base, floor] of this.glows) {
      const k = floor + (1 - floor) * look.night * 2.4 + (1 - look.night) * 0.4;
      m.color.copy(base).multiplyScalar(k);
    }
  }

  dispose() {
    for (const v of Object.values(this)) {
      if (v instanceof THREE.Material) v.dispose();
    }
    for (const [m] of this.glows) m.dispose();
    for (const m of this.envelopes.values()) m.dispose();
  }
}

/* ------------------------------------------------------------ geometry */

const G = {
  hexPlate: new THREE.CylinderGeometry(SLOT * 0.995, SLOT * 0.9, 2.4, 6, 1),
  hexEdge: new THREE.CylinderGeometry(SLOT * 1.0, SLOT * 1.0, 0.5, 6, 1, true),
  truss: new THREE.ConeGeometry(SLOT * 0.7, 14, 6, 1, true),
  sphere: new THREE.SphereGeometry(1, 32, 20),
  sphereLo: new THREE.SphereGeometry(1, 14, 10),
  hemi: new THREE.SphereGeometry(1, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 20),
  cylLo: new THREE.CylinderGeometry(1, 1, 1, 8),
  cone: new THREE.ConeGeometry(1, 1, 16),
  box: new THREE.BoxGeometry(1, 1, 1),
  torus: new THREE.TorusGeometry(1, 0.08, 8, 40),
  /** Lying flat, round the Y axis: scale x/z for radius, y for thickness. */
  torusFlat: new THREE.TorusGeometry(1, 0.05, 6, 48),
  ring: new THREE.RingGeometry(0.82, 1, 6, 1),
  ico: new THREE.IcosahedronGeometry(1, 0),
  halfCyl: new THREE.CylinderGeometry(1, 1, 1, 24, 1, true, 0, Math.PI),
  disc: new THREE.CircleGeometry(1, 32),
};
// Cylinders put a corner at +z, which is exactly the pointy-top layout
// hexToWorld uses, so the plates need no turning to tile.
G.truss.rotateX(Math.PI);
G.ring.rotateX(-Math.PI / 2);
G.ring.rotateY(Math.PI / 2);
G.disc.rotateX(-Math.PI / 2);
G.torusFlat.rotateX(Math.PI / 2);
G.halfCyl.rotateZ(Math.PI / 2);

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, sx = 1, sy = sx, sz = sx) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function tether(from: THREE.Vector3, to: THREE.Vector3, mat: THREE.Material) {
  const d = to.clone().sub(from);
  const len = d.length();
  const m = new THREE.Mesh(G.cylLo, mat);
  m.scale.set(0.18, len, 0.18);
  m.position.copy(from).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return m;
}

function tree(p: Palette, x: number, z: number, s: number, rnd: () => number) {
  const g = new THREE.Group();
  const h = 3 + rnd() * 3;
  g.add(mesh(G.cylLo, p.bark, 0, h / 2, 0, 0.35 * s, h * s, 0.35 * s));
  const r = rnd();
  const mat = r < 0.2 ? p.blossom : r < 0.6 ? p.leaf : p.leaf2;
  g.add(mesh(G.sphereLo, mat, 0, h * s + 1.6 * s, 0, 2.4 * s, 2.0 * s, 2.4 * s));
  g.position.set(x, 0, z);
  return g;
}

export interface ModuleParts {
  group: THREE.Group;
  spin: THREE.Object3D[];
  bob?: THREE.Object3D;
  track?: THREE.Object3D[];
  notes?: boolean;
}

/** One module, sitting on its own hex plate, centred on the origin. */
export function buildModule(p: Palette, id: ModuleId, level = 1, seed = 1, plate = true): ModuleParts {
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const g = new THREE.Group();
  const spin: THREE.Object3D[] = [];
  const track: THREE.Object3D[] = [];
  let bob: THREE.Object3D | undefined;
  let notes = false;
  const L = 1 + (level - 1) * 0.28;

  if (plate) {
    g.add(mesh(G.hexPlate, id === "core" ? p.deckDark : p.deck, 0, -1.1, 0));
    const edge = mesh(G.hexEdge, p.trim, 0, 0.1, 0);
    g.add(edge);
    const tr = mesh(G.truss, p.carbon, 0, -10, 0);
    tr.castShadow = false;
    g.add(tr);
    if (id !== "core") {
      // Under-deck light in the module's colour: at night the city's plan
      // reads from a kilometre off.
      const strip = mesh(G.torusFlat, p.accent(MODULES[id].color), 0, -2.6, 0, SLOT * 0.8, 10, SLOT * 0.8);
      strip.castShadow = false;
      g.add(strip);
    }
  }

  switch (id) {
    case "core": {
      // The spire: white ceramic, gold bands, a beacon.
      g.add(mesh(G.cyl, p.deckDark, 0, 3, 0, 14, 6, 14));
      g.add(mesh(G.cone, p.ceramic, 0, 34, 0, 7, 56, 7));
      for (let i = 0; i < 4; i++) g.add(mesh(G.torusFlat, p.trim, 0, 12 + i * 11, 0, 6.3 - i * 1.25, 8, 6.3 - i * 1.25));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const w = mesh(G.box, p.windowWarm, Math.cos(a) * 14.2, 3.5, Math.sin(a) * 14.2, 2.6, 2.2, 2.6);
        w.lookAt(0, 3.5, 0);
        g.add(w);
      }
      const beacon = mesh(G.sphereLo, p.beacon, 0, 63, 0, 1.3);
      beacon.castShadow = false;
      g.add(beacon);
      // The founding envelope: a lens of air over the whole seed.
      const env = new THREE.Group();
      // High enough that the default camera looks at the city under it, not
      // at the underside of a balloon.
      const ER = 40 * (1 + (level - 1) * 0.18);
      const e = mesh(G.sphere, p.envelope(0xfff4e4), 0, 0, 0, ER, ER * 0.42, ER);
      env.add(e);
      env.add(mesh(G.torusFlat, p.trim, 0, 0, 0, ER * 1.006, 14, ER * 1.006));
      env.position.y = 175;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.3;
        env.add(tether(new THREE.Vector3(Math.cos(a) * ER * 0.8, -6, Math.sin(a) * ER * 0.8), new THREE.Vector3(Math.cos(a) * 6, -118, Math.sin(a) * 6), p.carbon));
      }
      g.add(env);
      bob = env;
      break;
    }
    case "dome": {
      const R = 15 * L;
      g.add(mesh(G.cyl, p.trim, 0, 0.6, 0, R + 0.6, 1.2, R + 0.6));
      const grass = mesh(G.disc, p.grass, 0, 1.25, 0, R, 1, R);
      g.add(grass);
      const n = 5 + level * 2;
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * R * 0.72;
        g.add(tree(p, Math.cos(a) * r, Math.sin(a) * r, 0.8 + rnd() * 0.5, rnd));
      }
      // A few houses, with windows that light up.
      for (let i = 0; i < 2 + level; i++) {
        const a = rnd() * Math.PI * 2, r = R * (0.35 + rnd() * 0.35);
        const hx = Math.cos(a) * r, hz = Math.sin(a) * r;
        const hh = 3 + rnd() * 3 * level;
        const h = mesh(G.box, p.white, hx, hh / 2 + 1.2, hz, 4, hh, 4);
        h.rotation.y = rnd() * 3;
        g.add(h);
        const w = mesh(G.box, p.windowWarm, hx, hh * 0.6 + 1.2, hz, 4.1, 0.8, 1.2);
        w.rotation.y = h.rotation.y;
        g.add(w);
      }
      const dome = new THREE.Mesh(G.hemi, p.glass);
      dome.scale.set(R, R * 0.82, R);
      dome.position.y = 1.2;
      dome.renderOrder = 2;
      g.add(dome);
      break;
    }
    case "bladder": {
      const b = new THREE.Group();
      const R = 10 * L;
      const tones = [0xfff2dc, 0xffffff, 0xffe3b8, 0xffd9d0, 0xf4e8ff, 0xfff0c0];
      b.add(mesh(G.sphere, p.envelope(tones[seed % tones.length]), 0, 0, 0, R, R * 1.25, R));
      b.add(mesh(G.torusFlat, p.trim, 0, 0, 0, R * 1.02, 8, R * 1.02));
      b.position.y = 42 * L;
      g.add(b);
      g.add(mesh(G.cyl, p.carbon, 0, 1.5, 0, 3, 3, 3));
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        g.add(tether(new THREE.Vector3(Math.cos(a) * 2, 2, Math.sin(a) * 2), new THREE.Vector3(Math.cos(a) * R * 0.6, b.position.y - R * 1.1, Math.sin(a) * R * 0.6), p.carbon));
      }
      bob = b;
      break;
    }
    case "solar": {
      const rows = 2 + level;
      for (let i = 0; i < rows; i++) {
        const arm = new THREE.Group();
        arm.position.set(0, 5 + i * 0.2, (i - (rows - 1) / 2) * 8.5);
        const panel = mesh(G.box, p.solar, 0, 0, 0, 26, 0.5, 7);
        arm.add(panel);
        arm.add(mesh(G.box, p.trim, 0, 0.3, 0, 26.2, 0.2, 0.4));
        g.add(arm);
        g.add(mesh(G.cylLo, p.carbon, 0, 2.5, arm.position.z, 0.6, 5, 0.6));
        track.push(arm);
      }
      break;
    }
    case "kite": {
      // A winch drum and a mast on deck; the kite itself flies below and
      // behind, down in the slower air, on a long tether.
      g.add(mesh(G.cyl, p.trim, 0, 2.5, 0, 4, 5, 4));
      g.add(mesh(G.cyl, p.carbon, 0, 7, 0, 3.2, 4, 3.2));
      g.add(mesh(G.cylLo, p.ceramic, 0, 14, 0, 0.6, 18, 0.6));
      const kite = new THREE.Group();
      const R = 9 * L;
      const wing = mesh(G.halfCyl, p.envelope(0x9fffd0), 0, 0, 0, R * 2.6, R * 0.5, R);
      wing.castShadow = false;
      kite.add(wing);
      kite.position.set(0, -95, 60);
      kite.rotation.x = -0.35;
      g.add(kite);
      const tl = tether(new THREE.Vector3(0, -2, 0), new THREE.Vector3(0, -95, 60), p.carbon);
      tl.castShadow = false;
      g.add(tl);
      bob = kite;
      break;
    }
    case "harvester": {
      // Slim white intake towers with copper caps and a glowing band: they
      // breathe the sky in and the carbon comes out as fibre.
      const n = 2 + level;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const x = Math.cos(a) * 8, z = Math.sin(a) * 8;
        const h = 20 + i * 3;
        g.add(mesh(G.cyl, p.ceramic, x, h / 2, z, 2.2, h, 2.2));
        g.add(mesh(G.cyl, p.copper, x, h + 0.6, z, 2.8, 1.2, 2.8));
        const band = mesh(G.cyl, p.windowCool, x, h * 0.72, z, 2.3, 0.8, 2.3);
        band.castShadow = false;
        g.add(band);
        const fan = new THREE.Group();
        fan.position.set(x, h + 1.6, z);
        for (let k = 0; k < 3; k++) {
          const blade = mesh(G.box, p.ceramic, 0, 0, 0, 10, 0.25, 1.3);
          blade.rotation.y = (k / 3) * Math.PI;
          fan.add(blade);
        }
        g.add(fan);
        spin.push(fan);
      }
      g.add(mesh(G.cyl, p.trim, 0, 1.4, 0, 5, 2.8, 5));
      break;
    }
    case "still": {
      // A condenser column in glass, two copper boilers on legs, and the
      // cloud water, faintly blue, standing in the tube.
      for (const [x, z, r] of [[-7.5, -3, 5.6], [7, 4, 4.8]] as const) {
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2;
          g.add(mesh(G.cylLo, p.trim, x + Math.cos(a) * r * 0.6, r * 0.55, z + Math.sin(a) * r * 0.6, 0.35, r * 1.1, 0.35));
        }
        g.add(mesh(G.sphere, p.copper, x, r * 1.25, z, r));
        g.add(mesh(G.torusFlat, p.trim, x, r * 1.25, z, r * 1.01, 8, r * 1.01));
      }
      const glass = new THREE.Mesh(G.cyl, p.glass);
      glass.scale.set(3, 20 * L, 3);
      glass.position.y = 10 * L + 1;
      glass.renderOrder = 2;
      g.add(glass);
      const col = mesh(G.cyl, p.water, 0, 7 * L + 1, 0, 2.3, 14 * L, 2.3);
      col.castShadow = false;
      g.add(col);
      g.add(mesh(G.cyl, p.copper, 0, 20 * L + 1.6, 0, 3.3, 1.2, 3.3));
      g.add(tether(new THREE.Vector3(-7.5, 8, -3), new THREE.Vector3(0, 12, 0), p.copper));
      g.add(tether(new THREE.Vector3(7, 7, 4), new THREE.Vector3(0, 9, 0), p.copper));
      break;
    }
    case "moxie": {
      // Two pill-shaped electrolysis tanks and a glass core glowing cyan.
      for (const side of [-1, 1]) {
        const tank = mesh(G.sphere, p.ceramic, side * 7, 7 * L, 0, 5, 7 * L, 5);
        g.add(tank);
        g.add(mesh(G.torusFlat, p.trim, side * 7, 7 * L, 0, 5.05, 8, 5.05));
      }
      const core = mesh(G.cyl, p.cyan, 0, 6 * L, 0, 2.2, 10 * L, 2.2);
      core.castShadow = false;
      g.add(core);
      g.add(mesh(G.cyl, p.copper, 0, 11.5 * L, 0, 2.8, 1, 2.8));
      g.add(tether(new THREE.Vector3(-7, 10 * L, 0), new THREE.Vector3(0, 10 * L, 0), p.copper));
      g.add(tether(new THREE.Vector3(7, 10 * L, 0), new THREE.Vector3(0, 10 * L, 0), p.copper));
      break;
    }
    case "greenhouse": {
      const len = 26, R = 9 * L;
      g.add(mesh(G.box, p.trim, 0, 0.6, 0, len + 1, 1.2, R * 2 + 1));
      for (let i = 0; i < 4; i++) {
        g.add(mesh(G.box, i % 2 ? p.leaf : p.leaf2, 0, 2, (i - 1.5) * (R * 0.45), len - 3, 1.8 + rnd() * 1.5, 2.2));
      }
      const vault = new THREE.Mesh(G.halfCyl, p.glass);
      vault.scale.set(len, R, R);
      vault.position.y = 1.2;
      vault.renderOrder = 2;
      g.add(vault);
      break;
    }
    case "biolab": {
      g.add(mesh(G.cyl, p.white, 0, 5, 0, 11, 10, 11));
      const band = mesh(G.cyl, p.magenta, 0, 6, 0, 11.2, 2.2, 11.2);
      band.castShadow = false;
      g.add(band);
      g.add(mesh(G.hemi, p.white, 0, 10, 0, 11, 6, 11));
      g.add(mesh(G.torusFlat, p.beacon, 0, 1.5, 0, 12.5, 10, 12.5));
      const orb = mesh(G.sphereLo, p.magenta, 0, 20, 0, 2.2);
      orb.castShadow = false;
      g.add(orb);
      bob = orb;
      break;
    }
    case "nanofab": {
      const core = mesh(G.ico, p.nano, 0, 14 * L, 0, 10 * L);
      g.add(core);
      spin.push(core);
      const wire = new THREE.LineSegments(new THREE.EdgesGeometry(G.ico), new THREE.LineBasicMaterial({ color: 0xc8a8ff }));
      wire.scale.setScalar(10.3 * L);
      wire.position.y = 14 * L;
      g.add(wire);
      spin.push(wire);
      g.add(mesh(G.cyl, p.carbon, 0, 2, 0, 8, 4, 8));
      break;
    }
    case "jazz": {
      g.add(mesh(G.cyl, p.carbon, 0, 4, 0, 12, 8, 12));
      g.add(mesh(G.cone, p.bronze, 0, 11, 0, 13, 6, 13));
      const ring = mesh(G.torusFlat, p.neon, 0, 7.5, 0, 12.4, 16, 12.4);
      ring.castShadow = false;
      g.add(ring);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        g.add(mesh(G.box, p.windowWarm, Math.cos(a) * 12.1, 3.5, Math.sin(a) * 12.1, 2, 3, 2));
      }
      notes = true;
      break;
    }
    case "ballroom": {
      // Schönbrunn yellow: a centre pavilion and two wings, white pilasters,
      // a grey mansard roof, and a gilded cupola. Lit windows all round.
      const H = 12 * L;
      for (const [x, w, h] of [[0, 14, H + 4], [-12, 10, H], [12, 10, H]] as const) {
        g.add(mesh(G.box, p.palace, x, h / 2, 0, w, h, 13));
        g.add(mesh(G.box, p.white, x, h + 0.4, 0, w + 0.6, 0.8, 13.6));
        const roof = mesh(G.cone, p.deckDark, x, h + 2.4, 0, w * 0.72, 3.2, 9.4);
        roof.rotation.y = Math.PI / 4;
        g.add(roof);
        const n = Math.round(w / 3.4);
        for (let i = 0; i < n; i++) {
          const wx = x - w / 2 + (i + 0.5) * (w / n);
          g.add(mesh(G.box, p.white, wx - (w / n) / 2 + 0.3, h / 2, 6.6, 0.6, h * 0.95, 0.4));
          g.add(mesh(G.box, p.windowWarm, wx, h * 0.55, 6.55, 1.6, h * 0.42, 0.3));
          g.add(mesh(G.box, p.windowWarm, wx, h * 0.55, -6.55, 1.6, h * 0.42, 0.3));
        }
      }
      g.add(mesh(G.cyl, p.white, 0, H + 6.2, 0, 3.4, 2.2, 3.4));
      g.add(mesh(G.hemi, p.gold, 0, H + 7.2, 0, 3.4, 4, 3.4));
      g.add(mesh(G.cone, p.gold, 0, H + 12.4, 0, 0.5, 3, 0.5));
      // A terrace of lanterns out front: the Season is outdoors too.
      for (let i = 0; i < 6; i++) g.add(mesh(G.sphereLo, p.windowWarm, -12.5 + i * 5, 3.2, 10.5, 0.55));
      break;
    }
    case "skyport": {
      g.add(mesh(G.cyl, p.pad, 0, 3, 0, 16, 1.4, 16));
      const lights = mesh(G.torusFlat, p.padLight, 0, 3.8, 0, 14, 6, 14);
      lights.castShadow = false;
      g.add(lights);
      g.add(mesh(G.box, p.white, -3, 3.8, 0, 1.4, 0.1, 9));
      g.add(mesh(G.box, p.white, 3, 3.8, 0, 1.4, 0.1, 9));
      g.add(mesh(G.box, p.white, 0, 3.8, 0, 6, 0.1, 1.4));
      g.add(mesh(G.cyl, p.ceramic, 13, 10, -9, 2.2, 20, 2.2));
      g.add(mesh(G.sphereLo, p.windowCool, 13, 21, -9, 3.4));
      break;
    }
  }

  g.userData.id = id;
  return { group: g, spin, bob, track, notes };
}

/* ----------------------------------------------------------- the view */

interface Live {
  tile: Tile;
  level: number;
  parts: ModuleParts;
  born: number;
}

interface Falling {
  group: THREE.Group;
  v: number;
  spin: THREE.Vector3;
  t: number;
  hot: THREE.MeshBasicMaterial;
  glow: THREE.Mesh;
}

export class CityView {
  root = new THREE.Group();
  private live = new Map<string, Live>();
  private falling: Falling[] = [];
  private slots = new THREE.Group();
  private slotMat = new THREE.MeshBasicMaterial({ color: 0x8ff6ff, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
  private slotHoverMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
  private selMat = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
  private ghost: THREE.Group | null = null;
  private ghostKey = "";
  private sel = new THREE.Mesh(G.ring, this.selMat);
  private notes: THREE.Sprite[] = [];
  private noteTex: THREE.Texture;
  private printRings: Array<{ m: THREE.Mesh; t: number }> = [];
  private printMat = new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending });

  /** Railings along every edge with nothing on the other side. */
  private posts: THREE.InstancedMesh;
  private bars: THREE.InstancedMesh;

  constructor(public palette: Palette) {
    const MAXE = 91 * 6;
    this.posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.12, 1.1, 5), palette.trim, MAXE * 3);
    this.bars = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.1, 0.1), palette.trim, MAXE * 2);
    this.posts.count = 0;
    this.bars.count = 0;
    this.posts.frustumCulled = this.bars.frustumCulled = false;
    this.root.add(this.posts, this.bars);
    this.root.add(this.slots);
    this.sel.visible = false;
    this.sel.scale.setScalar(SLOT * 0.98);
    this.root.add(this.sel);
    this.noteTex = noteTexture();
  }

  /** Forget everything on screen, without dropping it off the edge. */
  reset() {
    for (const l of this.live.values()) this.root.remove(l.parts.group);
    this.live.clear();
    this.select(null);
    this.showSlots(null, null);
    this.showGhost(null, null);
  }

  private rails(tiles: Tile[]) {
    const have = new Set(tiles.map((t) => `${t.q},${t.r}`));
    // Pointy-top hex: corner k at angle 90° - 60°k (x = sin, z = cos), which is
    // where the cylinder puts them; edge k runs from corner k to k+1 and faces
    // the neighbour in that direction.
    const corner = (k: number) => ({ x: Math.sin((k * Math.PI) / 3) * SLOT, z: Math.cos((k * Math.PI) / 3) * SLOT });
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    let np = 0, nb = 0;
    for (const t of tiles) {
      const c = hexToWorld(t.q, t.r);
      for (let k = 0; k < 6; k++) {
        const a = corner(k), b = corner(k + 1);
        const mid = { x: c.x + (a.x + b.x) / 2, z: c.z + (a.z + b.z) / 2 };
        // The neighbour across this edge is one full step away along the edge normal.
        const nx = c.x + (a.x + b.x), nz = c.z + (a.z + b.z);
        const nq = ((Math.sqrt(3) / 3) * nx - (1 / 3) * nz) / SLOT, nr = ((2 / 3) * nz) / SLOT;
        const key = `${Math.round(nq)},${Math.round(nr)}`;
        if (have.has(key)) continue;
        const ax = c.x + a.x * 0.985, az = c.z + a.z * 0.985, bx = c.x + b.x * 0.985, bz = c.z + b.z * 0.985;
        for (let i = 0; i < 3; i++) {
          const f = i / 3;
          p.set(ax + (bx - ax) * f, 0.65, az + (bz - az) * f);
          m.compose(p, q.identity(), sc.set(1, 1, 1));
          this.posts.setMatrixAt(np++, m);
        }
        const ang = Math.atan2(bz - az, bx - ax);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -ang);
        for (const y of [0.6, 1.15]) {
          p.set((ax + bx) / 2, y, (az + bz) / 2);
          m.compose(p, q, sc.set(SLOT, 1, 1));
          this.bars.setMatrixAt(nb++, m);
        }
        void mid;
      }
    }
    this.posts.count = np;
    this.bars.count = nb;
    this.posts.instanceMatrix.needsUpdate = true;
    this.bars.instanceMatrix.needsUpdate = true;
  }

  sync(tiles: Tile[], now: number) {
    this.rails(tiles);
    const seen = new Set<string>();
    for (const t of tiles) {
      const key = `${t.q},${t.r}`;
      seen.add(key);
      const cur = this.live.get(key);
      const level = t.level ?? 1;
      if (cur && cur.tile.n === t.n && cur.level === level) continue;
      if (cur) this.root.remove(cur.parts.group);
      const parts = buildModule(this.palette, t.id, level, t.n + 3);
      const { x, z } = hexToWorld(t.q, t.r);
      parts.group.position.set(x, 0, z);
      parts.group.rotation.y = ((t.q * 7 + t.r * 13) % 6) * (Math.PI / 3);
      this.root.add(parts.group);
      const fresh = !cur || cur.tile.n !== t.n || cur.level !== level;
      this.live.set(key, { tile: { ...t }, level, parts, born: fresh && now > 0.5 ? now : -99 });
      if (fresh && now > 0.5) this.print(x, z, now);
    }
    for (const [key, l] of this.live) {
      if (!seen.has(key)) {
        this.live.delete(key);
        this.drop(l.parts.group);
      }
    }
  }

  /** A module going over the side. */
  private drop(group: THREE.Group) {
    const hot = new THREE.MeshBasicMaterial({ color: 0xff6a20, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    const glow = new THREE.Mesh(G.sphereLo, hot);
    glow.scale.setScalar(26);
    group.add(glow);
    this.falling.push({ group, v: 0, spin: new THREE.Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.6), t: 0, hot, glow });
  }

  private print(x: number, z: number, now: number) {
    const m = new THREE.Mesh(G.ring, this.printMat.clone());
    m.position.set(x, 0.5, z);
    m.scale.setScalar(SLOT);
    this.root.add(m);
    this.printRings.push({ m, t: now });
  }

  showSlots(free: Hex[] | null, hover: Hex | null) {
    this.slots.clear();
    if (!free) return;
    for (const h of free) {
      const { x, z } = hexToWorld(h.q, h.r);
      const on = hover && hover.q === h.q && hover.r === h.r;
      const m = new THREE.Mesh(G.ring, on ? this.slotHoverMat : this.slotMat);
      m.position.set(x, 0.4, z);
      m.scale.setScalar(SLOT * (on ? 0.96 : 0.9));
      this.slots.add(m);
    }
  }

  showGhost(id: ModuleId | null, at: Hex | null) {
    const key = id && at ? `${id}@${at.q},${at.r}` : "";
    if (key === this.ghostKey) return;
    this.ghostKey = key;
    if (this.ghost) { this.root.remove(this.ghost); this.ghost = null; }
    if (!id || !at) return;
    const parts = buildModule(this.palette, id, 1, 5);
    parts.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.material = this.palette.glassGhost;
        m.castShadow = false;
        m.receiveShadow = false;
      }
    });
    const { x, z } = hexToWorld(at.q, at.r);
    parts.group.position.set(x, 0, z);
    this.ghost = parts.group;
    this.root.add(parts.group);
  }

  select(at: Hex | null) {
    this.sel.visible = !!at;
    if (at) {
      const { x, z } = hexToWorld(at.q, at.r);
      this.sel.position.set(x, 0.6, z);
    }
  }

  worldOf(at: Hex): THREE.Vector3 {
    const { x, z } = hexToWorld(at.q, at.r);
    return new THREE.Vector3(x, 0, z).applyMatrix4(this.root.matrixWorld);
  }

  update(dt: number, now: number, look: Look, deckY: number) {
    const sunAz = Math.atan2(look.sunDir.x, look.sunDir.z);
    for (const l of this.live.values()) {
      const g = l.parts.group;
      // Grow in, with a little overshoot.
      const age = now - l.born;
      if (age < 1.4) {
        const k = Math.max(0, age / 1.4);
        const s = k < 1 ? 1 - Math.pow(1 - k, 3) * Math.cos(k * 7) : 1;
        g.scale.setScalar(Math.max(0.001, s));
      } else if (g.scale.x !== 1) g.scale.setScalar(1);
      for (const o of l.parts.spin) o.rotation.y += dt * 0.9;
      if (l.parts.bob) l.parts.bob.position.y += Math.sin(now * 0.7 + l.tile.n) * 0.012;
      if (l.parts.track) {
        const el = Math.max(0.1, look.sunDir.y);
        for (const a of l.parts.track) {
          a.rotation.set(0, 0, 0);
          a.rotation.y = sunAz - g.rotation.y;
          a.rotateX(-(Math.PI / 2 - Math.asin(Math.min(1, el))) * 0.7);
        }
      }
      if (l.parts.notes && Math.random() < dt * 0.9 * (0.3 + look.night)) this.note(g.position);
    }
    for (const n of [...this.notes]) {
      n.position.y += dt * 6;
      n.position.x += Math.sin(now * 2 + n.id) * dt * 2;
      const m = n.material as THREE.SpriteMaterial;
      m.opacity -= dt * 0.25;
      if (m.opacity <= 0) {
        this.root.remove(n);
        m.dispose();
        this.notes.splice(this.notes.indexOf(n), 1);
      }
    }
    for (const r of [...this.printRings]) {
      const k = (now - r.t) / 1.6;
      r.m.position.y = 0.5 + k * 30;
      (r.m.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.8 * (1 - k));
      if (k >= 1) {
        this.root.remove(r.m);
        (r.m.material as THREE.Material).dispose();
        this.printRings.splice(this.printRings.indexOf(r), 1);
      }
    }
    for (const f of [...this.falling]) {
      f.t += dt;
      f.v += 9.8 * 0.9 * dt * 6;
      f.group.position.y -= f.v * dt;
      f.group.rotation.x += f.spin.x * dt;
      f.group.rotation.z += f.spin.z * dt;
      // It heats as it goes down.
      const depth = Math.max(0, -f.group.position.y);
      f.hot.opacity = Math.min(0.85, depth / 600);
      if (f.group.position.y < deckY - 500 || f.t > 20) {
        this.root.remove(f.group);
        f.hot.dispose();
        this.falling.splice(this.falling.indexOf(f), 1);
      }
    }
  }

  private note(at: THREE.Vector3) {
    const m = new THREE.SpriteMaterial({ map: this.noteTex, transparent: true, opacity: 0.9, depthWrite: false, color: 0xffc080 });
    const s = new THREE.Sprite(m);
    s.position.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * 16, 16, (Math.random() - 0.5) * 16));
    s.scale.setScalar(5);
    this.root.add(s);
    this.notes.push(s);
  }

  dispose() {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry && !Object.values(G).includes(m.geometry as never)) m.geometry.dispose();
    });
    this.noteTex.dispose();
    this.slotMat.dispose();
    this.slotHoverMat.dispose();
    this.selMat.dispose();
    this.printMat.dispose();
  }
}

function noteTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d")!;
  x.fillStyle = "#fff";
  x.font = "48px serif";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText("♪", 32, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ------------------------------------------------- a city on the horizon */

const LAYOUT: ModuleId[] = ["dome", "dome", "bladder", "solar", "dome", "greenhouse", "harvester", "bladder", "moxie", "dome", "jazz", "solar", "still", "bladder", "dome", "greenhouse"];

/** A neighbour: the same parts, a random plan, no plates to save draw calls. */
export function buildNeighbour(p: Palette, seed: number, size: number): THREE.Group {
  const g = new THREE.Group();
  const core = buildModule(p, "core", 2, seed, true);
  g.add(core.group);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const ring: Hex[] = [];
  for (let q = -3; q <= 3; q++) for (let r = -3; r <= 3; r++) {
    const k = (Math.abs(q) + Math.abs(r) + Math.abs(-q - r)) / 2;
    if (k >= 1 && k <= 3) ring.push({ q, r });
  }
  ring.sort((a, b) => (Math.abs(a.q) + Math.abs(a.r) + Math.abs(a.q + a.r)) - (Math.abs(b.q) + Math.abs(b.r) + Math.abs(b.q + b.r)) || rnd() - 0.5);
  for (let i = 0; i < size && i < ring.length; i++) {
    const id = LAYOUT[Math.floor(rnd() * LAYOUT.length)];
    const m = buildModule(p, id, 1 + Math.floor(rnd() * 2), seed + i, true);
    const { x, z } = hexToWorld(ring[i].q, ring[i].r);
    m.group.position.set(x, 0, z);
    m.group.rotation.y = Math.floor(rnd() * 6) * (Math.PI / 3);
    g.add(m.group);
  }
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; }
  });
  return g;
}
