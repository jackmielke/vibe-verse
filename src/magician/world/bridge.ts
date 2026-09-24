/**
 * The bridge, and the river under it.
 *
 * A taiko-bashi, the arched "drum bridge" of a Japanese garden: vermilion
 * frame, gold caps on the posts, a deck steep enough that crossing it is a
 * little climb. It is turned square to the river's flow and it is walkable:
 * `deckAt` is the height of the planks, the world takes the higher of that
 * and the ground, and the railings hold you unless you jump them.
 *
 * Under it live the things that make a bridge somewhere to stop rather than
 * something to cross:
 *
 *  - koi, who drift about, gather under anybody standing on the bridge (they
 *    have learned what people on bridges are for), and race for food;
 *  - rings on the water wherever something touches it;
 *  - floating wish lanterns, toro nagashi, that anyone can set on the river.
 *    They are world state, so everyone in the valley sees every lantern,
 *    and their position is a function of the wall clock since they were
 *    released, so a newcomer sees them where they really are.
 *  - two tall posts at the ends with red paper lanterns and glass wind
 *    chimes under them.
 */
import * as THREE from "three";
import { heightAt, riverCentre } from "./noise";
import type { Wish } from "../state";
import type { PropContext, PropObject } from "./props";

export interface Bridge {
  group: THREE.Group;
  /** The top of the planks at (x, z), or null off the bridge. */
  deckAt(x: number, z: number): number | null;
  /** Keep somebody on the deck inside the railings, unless they are above them. */
  solve(pos: THREE.Vector3): void;
  /** The middle of the bridge, on the deck. */
  centre: THREE.Vector3;
  /** Where the wind chimes hang, for the ambience. */
  chimes: Array<{ x: number; z: number }>;
  /** The two end posts, as props: their lanterns join the world's lamp pool. */
  posts: PropObject[];
  update(dt: number, time: number, wind: number, windDir: number): void;
  dispose(): void;
}

const SHU = "#c23a2b"; // shu-iro, the vermilion of shrines and bridges

export function buildTaikoBridge(nearZ: number): Bridge {
  const group = new THREE.Group();
  group.name = "bridge";
  const disposables: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(x: T) => { disposables.push(x); return x; };

  // Square to the flow: the river runs along +z, bending by riverCentre'(z).
  const cx = riverCentre(nearZ);
  const slope = (riverCentre(nearZ + 0.5) - riverCentre(nearZ - 0.5));
  const ux = 1 / Math.hypot(1, slope), uz = -slope / Math.hypot(1, slope);
  const yaw = Math.atan2(-uz, ux);
  const L = 19, W = 2.7, H = 2.2;
  const endA = { x: cx - ux * L / 2, z: nearZ - uz * L / 2 };
  const endB = { x: cx + ux * L / 2, z: nearZ + uz * L / 2 };
  // Each end meets its own bank; the arch rises over the line between them.
  const yA = heightAt(endA.x, endA.z) + 0.04, yB = heightAt(endB.x, endB.z) + 0.04;
  const y0 = (yA + yB) / 2;
  group.position.set(cx, y0, nearZ);
  group.rotation.y = yaw;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);

  const archY = (u: number) => H * (1 - (2 * u / L) ** 2) + (yB - yA) * (u / L);
  const archSlope = (u: number) => -8 * H * u / (L * L) + (yB - yA) / L;

  const shu = keep(new THREE.MeshStandardMaterial({ color: SHU, roughness: 0.55 }));
  const gold = keep(new THREE.MeshStandardMaterial({ color: "#d9a93c", roughness: 0.3, metalness: 0.75 }));
  const plank = keep(new THREE.MeshStandardMaterial({ color: "#8e6b4b", roughness: 0.85 }));
  const dark = keep(new THREE.MeshStandardMaterial({ color: "#2a1d16", roughness: 0.9 }));

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rz = 0) => {
    keep(geo);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.z = rz;
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };

  // Planks, each following the curve.
  const N = 46;
  const plankGeo = new THREE.BoxGeometry(L / N * 0.9, 0.09, W);
  for (let i = 0; i < N; i++) {
    const u = -L / 2 + (i + 0.5) * (L / N);
    add(i === 0 ? plankGeo : plankGeo.clone(), plank, u, archY(u) - 0.045, 0, Math.atan(archSlope(u)));
  }
  // Curves for the stringers and the rails.
  const curve = (v: number, dy: number, inset = 0) => new THREE.CatmullRomCurve3(
    Array.from({ length: 17 }, (_, k) => {
      const u = -L / 2 + inset + (k / 16) * (L - inset * 2);
      return new THREE.Vector3(u, archY(u) + dy, v);
    }),
  );
  for (const v of [-W / 2 + 0.12, W / 2 - 0.12]) {
    add(new THREE.TubeGeometry(curve(v, -0.22, 0.45), 48, 0.13, 8), shu, 0, 0, 0);
  }
  // Railings: posts, a top rail and a mid rail on each side.
  const postGeo = new THREE.BoxGeometry(0.13, 1.05, 0.13);
  const capGeo = new THREE.SphereGeometry(0.11, 12, 8);
  const tipGeo = new THREE.ConeGeometry(0.06, 0.16, 12);
  const P = 9;
  for (const v of [-W / 2 + 0.06, W / 2 - 0.06]) {
    for (let k = 0; k < P; k++) {
      const u = -L / 2 + 0.25 + (k / (P - 1)) * (L - 0.5);
      add(postGeo.clone(), shu, u, archY(u) + 0.5, v);
      if (k === 0 || k === P - 1) {
        // Giboshi: the gold onion caps on the principal posts.
        add(capGeo.clone(), gold, u, archY(u) + 1.1, v);
        add(tipGeo.clone(), gold, u, archY(u) + 1.25, v);
      }
    }
    add(new THREE.TubeGeometry(curve(v, 1.0, 0.25), 48, 0.055, 6), shu, 0, 0, 0);
    add(new THREE.TubeGeometry(curve(v, 0.55, 0.25), 48, 0.035, 6), shu, 0, 0, 0);
  }
  postGeo.dispose(); capGeo.dispose(); tipGeo.dispose();
  // Legs into the river, in braced pairs.
  for (const u of [-L * 0.32, -L * 0.13, L * 0.13, L * 0.32]) {
    const wx = cx + cos * u, wz = nearZ - sin * u;
    const bed = heightAt(wx, wz) - y0 - 0.4;
    const top = archY(u) - 0.3;
    const len = top - bed;
    for (const v of [-W / 2 + 0.2, W / 2 - 0.2]) add(new THREE.CylinderGeometry(0.13, 0.15, len, 10), shu, u, bed + len / 2, v);
    add(new THREE.BoxGeometry(0.16, 0.16, W - 0.3), shu, u, top - 0.45, 0);
    add(new THREE.BoxGeometry(0.2, 0.3, W - 0.2), dark, u, top - 0.05, 0);
  }

  // ---- end posts: a red chochin and a glass fuurin on each ----------------
  const paper = paperLantern();
  keep(paper.tex);
  const posts: PropObject[] = [];
  const chimes: Array<{ x: number; z: number }> = [];
  const tanzaku: THREE.Mesh[] = [];
  const glassMat = keep(new THREE.MeshPhysicalMaterial({ color: "#cfe9ff", roughness: 0.05, transmission: 0.6, transparent: true, opacity: 0.55, thickness: 0.02 }));
  const stripMat = keep(new THREE.MeshStandardMaterial({ color: "#f3e6c4", roughness: 0.9, side: THREE.DoubleSide }));
  for (const [side, end] of [[-1, endA], [1, endB]] as const) {
    const pg = new THREE.Group();
    const u = side * (L / 2 + 0.7);
    pg.position.set(u, 0, -W / 2 - 0.5);
    group.add(pg);
    const pole = new THREE.Mesh(keep(new THREE.BoxGeometry(0.16, 3.2, 0.16)), dark);
    pole.position.y = 1.6;
    pole.castShadow = true;
    const arm = new THREE.Mesh(keep(new THREE.BoxGeometry(0.1, 0.1, 1.0)), dark);
    arm.position.set(0, 3.05, 0.45);
    const lamp = new THREE.Mesh(keep(paper.geo.clone()), paper.mat);
    lamp.position.set(0, 2.55, 0.85);
    const bell = new THREE.Mesh(keep(new THREE.SphereGeometry(0.09, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55)), glassMat);
    bell.position.set(0, 3.0, 0.25);
    const strip = new THREE.Mesh(keep(new THREE.PlaneGeometry(0.07, 0.32)), stripMat);
    strip.geometry.translate(0, -0.16, 0);
    strip.position.set(0, 2.9, 0.25);
    tanzaku.push(strip);
    pg.add(pole, arm, lamp, bell, strip);
    const l = { glow: paper.mat, at: new THREE.Vector3(0, 2.55, 0.85), color: new THREE.Color("#ff7a4a"), power: 1.4, level: 0 };
    posts.push({
      group: pg,
      lamp: l,
      update(_dt: number, time: number, ctx: PropContext) {
        l.level += ((ctx.lanterns ? 0.85 + Math.sin(time * 5 + side) * 0.08 : 0) - l.level) * 0.05;
        paper.mat.emissiveIntensity = 0.15 + l.level * 1.8;
      },
      dispose() { /* shared with the bridge */ },
    });
    const wx = cx + cos * u + sin * (-W / 2 - 0.25);
    const wz = nearZ - sin * u + cos * (-W / 2 - 0.25);
    chimes.push({ x: wx, z: wz });
    void end;
  }

  const centre = new THREE.Vector3(cx, y0 + H, nearZ);

  return {
    group,
    centre,
    chimes,
    posts,
    deckAt(x, z) {
      const dx = x - cx, dz = z - nearZ;
      const u = dx * cos - dz * sin;
      const v = dx * sin + dz * cos;
      if (Math.abs(u) > L / 2 || Math.abs(v) > W / 2 + 0.05) return null;
      return y0 + archY(u);
    },
    solve(pos) {
      const dx = pos.x - cx, dz = pos.z - nearZ;
      const u = dx * cos - dz * sin;
      const v = dx * sin + dz * cos;
      if (Math.abs(u) > L / 2 - 0.3) return;
      const deck = y0 + archY(u);
      // Only somebody standing on the deck meets the railing; a jump clears it.
      if (pos.y < deck - 0.4 || pos.y > deck + 0.95) return;
      const lim = W / 2 - 0.32;
      if (Math.abs(v) <= lim || Math.abs(v) > W / 2 + 0.6) return;
      const nv = Math.sign(v) * lim;
      pos.x = cx + cos * u + sin * nv;
      pos.z = nearZ - sin * u + cos * nv;
    },
    update(_dt, time, wind, windDir) {
      // The chimes' paper strips catch the wind.
      for (let i = 0; i < tanzaku.length; i++) {
        const s = tanzaku[i];
        const g = Math.sin(time * (2.2 + i * 0.3) + i) * 0.5 + Math.sin(time * 5.3 + i * 2) * 0.2;
        s.rotation.x = (0.15 + g * 0.5) * (0.2 + wind);
        s.rotation.z = Math.sin(windDir - yaw) * 0.3 * wind;
      }
    },
    dispose() { for (const d of disposables) d.dispose(); },
  };
}

/** A chochin: red paper on bamboo ribs, a black band top and bottom, a character. */
function paperLantern(): { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial; tex: THREE.Texture } {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    pts.push(new THREE.Vector2(0.06 + Math.sin(t * Math.PI) * 0.2, t * 0.62 - 0.31));
  }
  const geo = new THREE.LatheGeometry(pts, 20);
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 128;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#d8402e";
  g.fillRect(0, 0, 256, 128);
  g.strokeStyle = "rgba(60,10,5,0.35)";
  g.lineWidth = 2;
  for (let y = 10; y < 128; y += 9) { g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke(); }
  g.fillStyle = "#1a1210";
  g.fillRect(0, 0, 256, 10);
  g.fillRect(0, 118, 256, 10);
  g.font = "bold 58px serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (const x of [64, 192]) g.fillText("星", x, 66);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new THREE.Color("#ffffff"), emissiveIntensity: 0.15, roughness: 0.8, side: THREE.DoubleSide });
  return { geo, mat, tex };
}

// ---------------------------------------------------------------------------
// The river's life: rings, koi, food, and wish lanterns.
// ---------------------------------------------------------------------------

export interface RiverLife {
  group: THREE.Group;
  /** Throw a handful of food onto the water in front of somebody. */
  feed(from: THREE.Vector3, yaw: number): void;
  /** A ring on the water. */
  ripple(x: number, z: number, size?: number): void;
  syncWishes(wishes: Wish[]): void;
  /** Called when a koi eats, for a sound. */
  onEat?: (x: number, z: number) => void;
  /** What is on the water, for scripts. */
  debug(): { wishes: Array<{ id: number; visible: boolean; x: number; y: number; z: number }>; food: number; koi: Array<[number, number]> };
  update(dt: number, time: number, opts: { waterY: number; player: THREE.Vector3; onBridge: boolean; night: number }): void;
  dispose(): void;
}

const KOI_KINDS = [
  { base: "#f4efe6", spots: ["#e0482b"] }, // kohaku
  { base: "#f1ece4", spots: ["#e0482b", "#161412"] }, // taisho sanke
  { base: "#1c1a18", spots: ["#e0482b", "#f1ece4"] }, // showa
  { base: "#f2b33a", spots: [] }, // yamabuki ogon
  { base: "#e2672d", spots: [] }, // orange
  { base: "#7e8fa0", spots: ["#d9542e"] }, // asagi
  { base: "#a57b4a", spots: [] }, // chagoi
];

/** Where a lantern released at `born` is now, and whether it still is. */
export function wishPosition(w: Wish, now: number, startZ: number): { x: number; y: number | null; z: number; yaw: number; alive: number } | null {
  const age = (now - w.born) / 1000;
  const seed = (w.id % 97) / 97;
  if (w.sky) {
    // A sky lantern: lifts slowly off the hands, then climbs and drifts on
    // the air, turning, until it is a star among the stars.
    const LIFE = 200;
    if (age < 0 || age > LIFE) return null;
    const rise = age < 3 ? age * age * 0.12 : 1.08 + (age - 3) * (0.55 + seed * 0.35);
    const drift = age * (0.18 + seed * 0.12);
    const a = seed * 6.283;
    const x = w.sky.x + Math.cos(a) * (0.6 + drift) + Math.sin(age * 0.3 + seed * 9) * 0.4;
    const z = w.sky.z + Math.sin(a) * (0.6 + drift) + Math.cos(age * 0.27 + seed * 7) * 0.4;
    const alive = Math.min(1, age / 1.5) * Math.min(1, (LIFE - age) / 40);
    return { x, y: heightAt(w.sky.x, w.sky.z) + 1.3 + rise, z, yaw: age * 0.25 + seed * 6, alive };
  }
  const LIFE = 300;
  if (age < 0 || age > LIFE) return null;
  const s = age * 0.42;
  let z = startZ + s;
  let x = riverCentre(z) + Math.sin(age * 0.07 + seed * 6) * 1.6 + (seed - 0.5) * 1.5;
  // Past the paddies the river opens into the lake, and the lantern drifts on.
  if (z > 50) {
    const over = z - 50;
    z = 50 + over * 0.55;
    x = riverCentre(50) + Math.min(14, over * 0.35) + Math.sin(age * 0.05 + seed * 9) * 3;
  }
  const alive = Math.min(1, age / 2) * Math.min(1, (LIFE - age) / 20);
  return { x, y: null, z, yaw: age * 0.08 + seed * 6, alive };
}

export function createRiverLife(bridgeZ: number): RiverLife {
  const group = new THREE.Group();
  group.name = "river-life";
  const disposables: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(x: T) => { disposables.push(x); return x; };

  // ---- rings ---------------------------------------------------------------
  const ringGeo = keep(new THREE.RingGeometry(0.9, 1, 40));
  ringGeo.rotateX(-Math.PI / 2);
  const rings: Array<{ m: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; size: number; x: number; z: number }> = [];
  for (let i = 0; i < 24; i++) {
    const mat = keep(new THREE.MeshBasicMaterial({ color: "#eaf6ff", transparent: true, opacity: 0, depthWrite: false }));
    const m = new THREE.Mesh(ringGeo, mat);
    m.visible = false;
    m.renderOrder = 3;
    group.add(m);
    rings.push({ m, mat, age: 99, size: 1, x: 0, z: 0 });
  }
  let ringNext = 0;
  const ripple = (x: number, z: number, size = 1) => {
    const r = rings[ringNext++ % rings.length];
    r.age = 0; r.size = size; r.x = x; r.z = z;
    r.m.visible = true;
  };

  // ---- koi -------------------------------------------------------------------
  const koiBody = keep(new THREE.SphereGeometry(1, 18, 10));
  koiBody.scale(0.34, 0.1, 0.13);
  {
    // Taper toward the tail (-x) and flatten the belly a little.
    const p = koiBody.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const k = x < 0 ? 1 + (x / 0.34) * 0.55 : 1;
      p.setY(i, p.getY(i) * k * (p.getY(i) < 0 ? 0.8 : 1));
      p.setZ(i, p.getZ(i) * k);
    }
    koiBody.computeVertexNormals();
  }
  const tailGeo = keep(new THREE.PlaneGeometry(0.2, 0.18));
  tailGeo.translate(-0.1, 0, 0);
  tailGeo.rotateX(Math.PI / 2);
  const koiMats = KOI_KINDS.map((k) => {
    const tex = keep(koiTexture(k.base, k.spots));
    // Drawn after the water and a little toward its colour, so they read as
    // just under the surface rather than on top of it.
    return keep(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.85, depthWrite: true }));
  });
  const finMat = keep(new THREE.MeshStandardMaterial({ color: "#f4e6d8", roughness: 0.6, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
  const koi: Array<{ g: THREE.Group; tail: THREE.Mesh; x: number; z: number; h: number; speed: number; tx: number; tz: number; retarget: number; phase: number; size: number }> = [];
  const band = (z: number) => riverCentre(z);
  for (let i = 0; i < 14; i++) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(koiBody, koiMats[i % koiMats.length]);
    const tail = new THREE.Mesh(tailGeo, finMat);
    tail.position.x = -0.32;
    // Two draw calls a fish: the pectoral fins are invisible from the bank
    // and were half the koi's cost in a headset.
    g.add(body, tail);
    for (const c of g.children) c.renderOrder = 2;
    const size = 0.75 + Math.random() * 0.6;
    g.scale.setScalar(size);
    group.add(g);
    const z = bridgeZ + (Math.random() - 0.5) * 24;
    koi.push({ g, tail, x: band(z) + (Math.random() - 0.5) * 4, z, h: Math.random() * 6.28, speed: 0.4, tx: 0, tz: 0, retarget: 0, phase: Math.random() * 6, size });
  }

  // ---- food -----------------------------------------------------------------
  const foodGeo = keep(new THREE.SphereGeometry(0.035, 6, 4));
  const foodMat = keep(new THREE.MeshStandardMaterial({ color: "#8a5a2b", roughness: 1 }));
  const food: Array<{ m: THREE.Mesh; x: number; y: number; z: number; vx: number; vy: number; vz: number; floating: boolean; age: number }> = [];

  // ---- wish lanterns ----------------------------------------------------------
  const lanternBase = keep(new THREE.BoxGeometry(0.52, 0.07, 0.52));
  const lanternBox = keep(new THREE.BoxGeometry(0.4, 0.46, 0.4));
  const baseMat = keep(new THREE.MeshStandardMaterial({ color: "#3a2a1c", roughness: 0.9 }));
  const haloTex = keep(glowTexture());
  const wishes = new Map<number, { g: THREE.Group; paper: THREE.MeshStandardMaterial; halo: THREE.SpriteMaterial; tex: THREE.Texture; wish: Wish }>();

  const life: RiverLife = {
    group,
    ripple,
    debug: () => ({
      wishes: [...wishes.entries()].map(([id, w]) => ({ id, visible: w.g.visible, x: +w.g.position.x.toFixed(1), y: +w.g.position.y.toFixed(2), z: +w.g.position.z.toFixed(1) })),
      food: food.length,
      koi: koi.slice(0, 4).map((k) => [+k.x.toFixed(1), +k.z.toFixed(1)] as [number, number]),
    }),
    feed(from, yaw) {
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      for (let i = 0; i < 9; i++) {
        const m = new THREE.Mesh(foodGeo, foodMat);
        const sp = 2.2 + Math.random() * 1.6;
        const side = (Math.random() - 0.5) * 1.4;
        group.add(m);
        food.push({ m, x: from.x + fx * 0.4, y: from.y + 1.2, z: from.z + fz * 0.4, vx: fx * sp - fz * side, vy: 1.6 + Math.random(), vz: fz * sp + fx * side, floating: false, age: 0 });
      }
    },
    syncWishes(list) {
      const ids = new Set(list.map((w) => w.id));
      for (const [id, w] of wishes) {
        if (ids.has(id)) continue;
        group.remove(w.g);
        w.paper.dispose(); w.halo.dispose(); w.tex.dispose();
        wishes.delete(id);
      }
      for (const w of list) {
        if (wishes.has(w.id)) continue;
        const tex = wishTexture(w.text);
        const paper = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new THREE.Color("#ffc873"), emissiveIntensity: 1.2, roughness: 0.9, transparent: true });
        const g = new THREE.Group();
        const base = new THREE.Mesh(lanternBase, baseMat);
        const box = new THREE.Mesh(lanternBox, paper);
        box.position.y = 0.27;
        if (w.sky) {
          // Sky lanterns are taller paper and no raft, open at the bottom.
          base.visible = false;
          box.scale.set(1.1, 1.6, 1.1);
        }
        const halo = new THREE.SpriteMaterial({ map: haloTex, color: "#ffb45c", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.8 });
        const sprite = new THREE.Sprite(halo);
        sprite.scale.set(2.2, 2.2, 1);
        sprite.position.y = 0.3;
        g.add(base, box, sprite);
        g.visible = false;
        group.add(g);
        wishes.set(w.id, { g, paper, halo, tex, wish: w });
      }
    },
    update(dt, time, o) {
      const wy = o.waterY;
      // Rings.
      for (const r of rings) {
        if (!r.m.visible) continue;
        r.age += dt;
        const k = r.age / 2.2;
        if (k >= 1) { r.m.visible = false; continue; }
        r.m.position.set(r.x, wy + 0.02, r.z);
        r.m.scale.setScalar(r.size * (0.15 + k * 1.3));
        r.mat.opacity = (1 - k) * 0.45;
      }
      // Food: arcs through the air, lands with a ring, floats and drifts.
      for (let i = food.length - 1; i >= 0; i--) {
        const f = food[i];
        f.age += dt;
        if (!f.floating) {
          f.vy -= 9.8 * dt;
          f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
          if (f.y <= wy) {
            f.y = wy;
            if (heightAt(f.x, f.z) < wy) { f.floating = true; ripple(f.x, f.z, 0.35); }
            else f.age = 99; // landed on the bank
          }
        } else {
          f.z += dt * 0.12;
          f.y = wy + 0.01;
        }
        f.m.position.set(f.x, f.y, f.z);
        if (f.age > 40) { group.remove(f.m); food.splice(i, 1); }
      }
      // Koi.
      for (const k of koi) {
        k.retarget -= dt;
        let hungry = false;
        let best = 36;
        for (const f of food) {
          if (!f.floating) continue;
          const d = (f.x - k.x) ** 2 + (f.z - k.z) ** 2;
          if (d < best) { best = d; k.tx = f.x; k.tz = f.z; hungry = true; }
        }
        if (!hungry && k.retarget <= 0) {
          k.retarget = 3 + Math.random() * 5;
          // Somebody on the bridge is somebody who might have food.
          const near = o.onBridge && Math.hypot(o.player.x - k.x, o.player.z - k.z) < 22;
          const z = near ? o.player.z + (Math.random() - 0.5) * 4 : bridgeZ + (Math.random() - 0.5) * 26;
          k.tz = z;
          k.tx = (near ? o.player.x : band(z)) + (Math.random() - 0.5) * 3;
        }
        const want = Math.atan2(k.tz - k.z, k.tx - k.x);
        let dh = want - k.h;
        while (dh > Math.PI) dh -= Math.PI * 2;
        while (dh < -Math.PI) dh += Math.PI * 2;
        k.h += Math.max(-1, Math.min(1, dh)) * dt * (hungry ? 3 : 1.2);
        const target = hungry ? 1.5 : Math.hypot(k.tx - k.x, k.tz - k.z) < 0.6 ? 0.08 : 0.42;
        k.speed += (target - k.speed) * Math.min(1, dt * 2);
        const nx = k.x + Math.cos(k.h) * k.speed * dt, nz = k.z + Math.sin(k.h) * k.speed * dt;
        // Stay in the water.
        if (heightAt(nx, nz) < wy - 0.25) { k.x = nx; k.z = nz; } else { k.h += Math.PI * 0.6 * dt * 4; k.retarget = 0; }
        k.phase += dt * (3 + k.speed * 9);
        k.g.position.set(k.x, wy - (hungry ? 0.05 : 0.18) * k.size, k.z);
        k.g.rotation.set(0, -k.h, Math.sin(k.phase * 0.5) * 0.04);
        k.tail.rotation.y = Math.sin(k.phase) * 0.45;
        if (hungry) {
          for (let i = food.length - 1; i >= 0; i--) {
            const f = food[i];
            if (f.floating && (f.x - k.x) ** 2 + (f.z - k.z) ** 2 < 0.09 * k.size) {
              group.remove(f.m);
              food.splice(i, 1);
              ripple(k.x, k.z, 0.5);
              life.onEat?.(k.x, k.z);
            }
          }
        }
      }
      // Wish lanterns, where the clock says they have drifted to.
      const now = Date.now();
      for (const w of wishes.values()) {
        const p = wishPosition(w.wish, now, bridgeZ);
        if (!p) { w.g.visible = false; continue; }
        w.g.visible = true;
        if (p.y !== null) {
          w.g.position.set(p.x, p.y, p.z);
          w.g.rotation.set(Math.sin(time * 0.7 + w.wish.id) * 0.06, p.yaw, Math.cos(time * 0.6 + w.wish.id) * 0.06);
        } else {
          w.g.position.set(p.x, wy + 0.02 + Math.sin(time * 1.3 + w.wish.id) * 0.025, p.z);
          w.g.rotation.set(Math.sin(time * 0.9 + w.wish.id) * 0.04, p.yaw, Math.cos(time * 0.8 + w.wish.id) * 0.04);
        }
        w.paper.opacity = p.alive;
        w.paper.emissiveIntensity = (0.5 + o.night * 1.1) * p.alive * (0.92 + Math.sin(time * 7 + w.wish.id) * 0.08);
        w.halo.opacity = p.alive * (0.25 + o.night * 0.6) * (p.y !== null ? 1.3 : 1);
      }
    },
    dispose() {
      for (const w of wishes.values()) { w.paper.dispose(); w.halo.dispose(); w.tex.dispose(); }
      for (const d of disposables) d.dispose();
    },
  };
  return life;
}

function koiTexture(base: string, spots: string[]): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 128; cv.height = 64;
  const g = cv.getContext("2d")!;
  g.fillStyle = base;
  g.fillRect(0, 0, 128, 64);
  for (const c of spots) {
    g.fillStyle = c;
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      g.ellipse(Math.random() * 128, 10 + Math.random() * 28, 8 + Math.random() * 18, 5 + Math.random() * 10, Math.random() * 3, 0, Math.PI * 2);
      g.fill();
    }
  }
  // A lighter belly.
  const grad = g.createLinearGradient(0, 32, 0, 64);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(1, "rgba(255,250,240,0.6)");
  g.fillStyle = grad;
  g.fillRect(0, 32, 128, 32);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function wishTexture(text: string): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 128; cv.height = 128;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#fff4dc";
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = "rgba(90,50,20,0.5)";
  g.lineWidth = 4;
  g.strokeRect(2, 2, 124, 124);
  g.fillStyle = "#3a1e10";
  g.textAlign = "center";
  g.textBaseline = "middle";
  const words = (text || "願").slice(0, 60).split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > 12 && line) { lines.push(line); line = w; } else line = (line + " " + w).trim();
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, 5);
  const size = shown.length > 3 ? 15 : 19;
  g.font = `${size}px serif`;
  shown.forEach((l, i) => g.fillText(l, 64, 64 + (i - (shown.length - 1) / 2) * (size + 4)));
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function glowTexture(): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 64; cv.height = 64;
  const g = cv.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.3, "rgba(255,255,255,0.35)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}
