/**
 * Ships: galleys with striped square sails and banks of oars, fishing boats,
 * and the one moored at the mole that you can walk aboard.
 *
 * Hulls are lofted from cross-sections, with the high curled stern and the
 * bronze ram that every ship in the painting has. The sailing ones follow
 * closed curves through deep water, banking into turns, sails bellied, oars
 * sweeping when the wind is light.
 */
import * as THREE from "three";
import { makeRng } from "@/shared/proc/rng";
import { MOLE, heightAt } from "./map";
import { box, kit, mergeStatic, sailTexture } from "./kit";
import type { BuildCtx, FrameCtx, Part } from "./types";

interface ShipSpec {
  length: number;
  beam: number;
  sail: [string, string] | null;
  band: string;
  oars: number; // per side
  shields: boolean;
}

interface Ship {
  group: THREE.Group;
  oars: THREE.Group[];
  sail: THREE.Mesh | null;
  deckY: number;
  spec: ShipSpec;
}

const HULL = "#6b4429";
const HULL_DARK = "#3e2717";

function hullGeometry(L: number, B: number, depth: number): THREE.BufferGeometry {
  const N = 28, M = 12;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const cA = new THREE.Color(HULL), cB = new THREE.Color(HULL_DARK);
  for (let i = 0; i <= N; i++) {
    const t = i / N; // 0 stern .. 1 bow
    const x = (t - 0.5) * L;
    const beam = B / 2 * Math.pow(Math.sin(Math.PI * Math.min(0.97, Math.max(0.03, t))), 0.55);
    // The sheer rises toward both ends, more at the stern.
    const sheer = 1.0 + Math.pow(Math.abs(t - 0.45) * 2, 3) * (t < 0.45 ? 1.6 : 0.9);
    const keel = -depth * Math.pow(Math.sin(Math.PI * t), 0.35);
    for (let j = 0; j <= M; j++) {
      const phi = -Math.PI / 2 + (j / M) * Math.PI;
      const z = Math.sin(phi) * beam;
      const yb = keel * Math.pow(Math.cos(phi), 0.7);
      const y = j === 0 || j === M ? sheer : yb + (sheer - 0) * (1 - Math.pow(Math.cos(phi), 3)) * 0.0;
      // Sides rise straight from the turn of the bilge to the sheer.
      const side = Math.abs(Math.sin(phi));
      const yy = j === 0 || j === M ? sheer : side > 0.7 ? yb + (sheer - yb) * ((side - 0.7) / 0.3) : yb;
      pos.push(x, j === 0 || j === M ? y : yy, z);
      const c = yy < 0.1 ? cB : cA;
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) {
    const a = i * (M + 1) + j, b = a + M + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function colored(g: THREE.BufferGeometry, c: string): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const col = new THREE.Color(c);
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = col.r; a[i * 3 + 1] = col.g; a[i * 3 + 2] = col.b; }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return g;
}

function buildShip(spec: ShipSpec, mats: { hull: THREE.Material; paint: THREE.Material; wood: THREE.Material; cloth: THREE.Material; gold: THREE.Material }, rnd: () => number): Ship {
  const { length: L, beam: B } = spec;
  const group = new THREE.Group();
  const depth = B * 0.42;
  const hull = new THREE.Mesh(hullGeometry(L, B, depth), mats.hull);
  hull.castShadow = true;
  hull.receiveShadow = true;
  group.add(hull);
  const deckY = 0.85;
  // Deck.
  const deck = new THREE.Mesh(colored(box(L * 0.8, 0.12, B * 0.86, 2), "#c9a77a"), mats.wood);
  deck.position.y = deckY;
  deck.receiveShadow = true;
  group.add(deck);
  // A coloured band along the gunwale.
  for (const side of [-1, 1]) {
    const band = new THREE.Mesh(colored(box(L * 0.74, 0.32, 0.08), spec.band), mats.paint);
    band.position.set(L * 0.02, 0.86, side * (B / 2 - 0.02));
    group.add(band);
    // The eye on the bow.
    const eye = new THREE.Mesh(colored(new THREE.CircleGeometry(0.28, 14), "#f4efe2"), mats.paint);
    eye.position.set(L * 0.4, 0.55, side * (B * 0.3 + 0.03));
    eye.rotation.y = side > 0 ? 0.25 : Math.PI - 0.25;
    group.add(eye);
    const pupil = new THREE.Mesh(colored(new THREE.CircleGeometry(0.12, 10), "#1f2a36"), mats.paint);
    pupil.position.set(L * 0.4 + 0.05, 0.55, side * (B * 0.3 + 0.05));
    pupil.rotation.y = eye.rotation.y;
    group.add(pupil);
  }
  // The ram, bronze, at the waterline.
  const ram = new THREE.Mesh(new THREE.ConeGeometry(0.32, 1.6, 8).rotateZ(-Math.PI / 2), mats.gold);
  ram.position.set(L / 2 + 0.5, -0.15, 0);
  group.add(ram);
  // The stern curls up and over, like a scorpion's tail.
  const curl = new THREE.Mesh(colored(new THREE.TorusGeometry(B * 0.42, 0.22, 8, 16, Math.PI * 1.1), HULL), mats.paint);
  curl.position.set(-L / 2 + B * 0.1, 1.9 + B * 0.2, 0);
  curl.rotation.z = Math.PI * 0.05;
  group.add(curl);
  // Shields along the rails.
  if (spec.shields) {
    const sc = ["#c9442f", "#f2c641", "#2f5a92", "#efe6cf"];
    for (const side of [-1, 1]) for (let i = 0; i < 7; i++) {
      const s = new THREE.Mesh(colored(new THREE.CircleGeometry(0.42, 14), sc[(i + (side > 0 ? 1 : 0)) % sc.length]), mats.paint);
      s.position.set(-L * 0.28 + i * (L * 0.09), 1.25, side * (B / 2 + 0.02));
      s.rotation.y = side > 0 ? 0 : Math.PI;
      group.add(s);
    }
  }
  // Mast, yard and sail.
  const mastH = L * 0.62;
  const mast = new THREE.Mesh(colored(new THREE.CylinderGeometry(0.13, 0.18, mastH, 8), "#7b5a3a"), mats.wood);
  mast.position.set(L * 0.04, deckY + mastH / 2, 0);
  mast.castShadow = true;
  group.add(mast);
  let sail: THREE.Mesh | null = null;
  if (spec.sail) {
    const yardW = B * 2.4;
    const yard = new THREE.Mesh(colored(new THREE.CylinderGeometry(0.09, 0.09, yardW, 6).rotateX(Math.PI / 2), "#7b5a3a"), mats.wood);
    yard.position.set(L * 0.04 + 0.2, deckY + mastH * 0.92, 0);
    group.add(yard);
    const sh = mastH * 0.62;
    const sg = new THREE.PlaneGeometry(yardW * 0.94, sh, 8, 6);
    const sp = sg.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < sp.count; i++) {
      const u = sp.getX(i) / (yardW * 0.94), v = sp.getY(i) / sh;
      sp.setZ(i, (1 - (2 * u) ** 2) * (0.6 - v * 0.3) * B * 0.32);
    }
    sg.rotateY(Math.PI / 2);
    sg.computeVertexNormals();
    const sm = new THREE.MeshStandardMaterial({ map: sailTexture(spec.sail[0], spec.sail[1], 4), side: THREE.DoubleSide, roughness: 1 });
    sail = new THREE.Mesh(sg, sm);
    sail.position.set(L * 0.04 + 0.35, deckY + mastH * 0.92 - sh / 2 - 0.1, 0);
    sail.castShadow = true;
    group.add(sail);
    // A pennant.
    const pen = new THREE.Mesh(colored(new THREE.PlaneGeometry(1.4, 0.35).translate(-0.7, 0, 0), "#c9442f"), mats.cloth);
    pen.position.set(L * 0.04, deckY + mastH + 0.1, 0);
    group.add(pen);
  }
  // Oars: one group per side, so a single rotation sweeps the bank.
  const oars: THREE.Group[] = [];
  if (spec.oars > 0) {
    for (const side of [-1, 1]) {
      const bank = new THREE.Group();
      for (let i = 0; i < spec.oars; i++) {
        const pivot = new THREE.Group();
        pivot.position.set(-L * 0.3 + i * (L * 0.6 / Math.max(1, spec.oars - 1)), 0.75, side * (B / 2));
        const oar = new THREE.Mesh(colored(new THREE.CylinderGeometry(0.05, 0.05, B * 1.3, 5).rotateX(Math.PI / 2), "#a07a50"), mats.wood);
        oar.position.z = side * B * 0.55;
        oar.rotation.x = side * 0.5;
        oar.position.y = -B * 0.28;
        pivot.add(oar);
        const blade = new THREE.Mesh(colored(box(0.08, 0.25, 0.6, 1), "#a07a50"), mats.wood);
        blade.position.set(0, -B * 0.58, side * B * 1.1);
        pivot.add(blade);
        bank.add(pivot);
      }
      group.add(bank);
      oars.push(bank);
    }
  }
  // Steering oars at the stern.
  for (const side of [-1, 1]) {
    const so = new THREE.Mesh(colored(new THREE.CylinderGeometry(0.07, 0.07, 3.2, 6), "#7b5a3a"), mats.wood);
    so.position.set(-L * 0.42, 0.2, side * (B / 2 + 0.2));
    so.rotation.z = 0.8;
    group.add(so);
  }
  void rnd;
  for (const bank of oars) mergeStatic(bank);
  mergeStatic(group, new Set<THREE.Object3D>([...oars, ...(sail ? [sail] : [])]));
  return { group, oars, sail, deckY, spec };
}

function closedCurve(points: Array<[number, number]>): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3(points.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, "centripetal");
}

export function createShips(ctx: BuildCtx): Part {
  const k = kit();
  const rng = makeRng("thalassa-ships");
  const r = () => rng.next();
  const group = new THREE.Group();
  group.name = "ships";
  const hullMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
  const mats = { hull: hullMat, paint: k.paint, wood: k.wood, cloth: k.cloth, gold: k.gold };

  interface Sailing { ship: Ship; curve: THREE.CatmullRomCurve3; speed: number; t: number; len: number; rowing: boolean }
  const sailing: Sailing[] = [];
  const moored: Array<{ ship: Ship; phase: number; base: THREE.Vector3; yaw: number }> = [];

  const big = (sail: [string, string], band: string): ShipSpec => ({ length: 19, beam: 4.4, sail, band, oars: 11, shields: true });

  // Two galleys working the coast, one round the island and up the inlet, one far out.
  const routes: Array<{ pts: Array<[number, number]>; spec: ShipSpec; speed: number; rowing: boolean }> = [
    { pts: [[96, -150], [92, -95], [112, -62], [168, -58], [226, -20], [238, 50], [214, 92], [150, 70], [118, 50], [110, -20], [104, -60], [100, -120]], spec: big(["#efe3c8", "#9b5a34"], "#2f5a92"), speed: 3.2, rowing: false },
    { pts: [[-160, 175], [0, 150], [150, 135], [260, 120], [300, 40], [260, -30], [210, 10], [190, 110], [60, 170], [-120, 200]], spec: big(["#f2ead6", "#c9442f"], "#c9442f"), speed: 4.0, rowing: true },
  ];
  for (const rt of routes) {
    const ship = buildShip(rt.spec, mats, r);
    group.add(ship.group);
    const curve = closedCurve(rt.pts);
    sailing.push({ ship, curve, speed: rt.speed, t: r(), len: curve.getLength(), rowing: rt.rowing });
  }
  // A fishing boat with a little sail, tacking about the bay.
  {
    const ship = buildShip({ length: 6.5, beam: 2.1, sail: ["#f4ead2", "#e9862e"], band: "#3d7fb8", oars: 0, shields: false }, mats, r);
    group.add(ship.group);
    const curve = closedCurve([[-40, 18], [-10, 8], [20, 20], [22, 50], [-6, 62], [-40, 52]]);
    sailing.push({ ship, curve, speed: 2.2, t: 0, len: curve.getLength(), rowing: false });
  }
  // And one rowing out through the harbour mouth and back.
  {
    const ship = buildShip({ length: 5.5, beam: 1.9, sail: null, band: "#c9442f", oars: 3, shields: false }, mats, r);
    group.add(ship.group);
    const curve = closedCurve([[10, 40], [40, 62], [80, 82], [110, 72], [70, 50], [36, 36]]);
    sailing.push({ ship, curve, speed: 1.4, t: 0.4, len: curve.getLength(), rowing: true });
  }

  // The galley at the mole, sail furled, with a gangplank: walk aboard.
  {
    const ship = buildShip({ ...big(["#efe3c8", "#9b5a34"], "#c9442f"), sail: null }, mats, r);
    const ax = MOLE.a.x, az = MOLE.a.z, bx = MOLE.b.x, bz = MOLE.b.z;
    const len = Math.hypot(bx - ax, bz - az);
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    const nx = uz, nz = -ux; // toward the bay
    const off = MOLE.width / 2 + 0.8 + ship.spec.beam / 2;
    const cx = (ax + bx) / 2 + ux * 3 + nx * off, cz = (az + bz) / 2 + uz * 3 + nz * off;
    const yaw = -Math.atan2(uz, ux);
    ship.group.position.set(cx, 0.15, cz);
    ship.group.rotation.y = yaw;
    group.add(ship.group);
    moored.push({ ship, phase: 0, base: new THREE.Vector3(cx, 0.15, cz), yaw });
    // The deck is walkable.
    const L = ship.spec.length * 0.78, W = ship.spec.beam * 0.8;
    const deckY = 0.15 + ship.deckY + 0.06;
    ctx.surfaces.push((x, z) => {
      const dx = x - cx, dz = z - cz;
      const lx = dx * ux + dz * uz, lz = -dx * uz + dz * ux;
      return Math.abs(lx) < L / 2 && Math.abs(lz) < W / 2 ? deckY : null;
    });
    // Rails you cannot walk off.
    for (const side of [-1, 1]) {
      const rx = cx + nx * side * (W / 2 + 0.15), rz = cz + nz * side * (W / 2 + 0.15);
      ctx.colliders.box(rx, rz, L, 0.3, Math.atan2(uz, ux), deckY - 0.3, deckY + 1.2);
    }
    // The gangplank from the mole.
    const gx = cx - nx * (off - ship.spec.beam / 2 + 0.3) * 0.5 - nx * 0.4, gz = cz - nz * (off - ship.spec.beam / 2 + 0.3) * 0.5 - nz * 0.4;
    const plankLen = off - ship.spec.beam * 0.3;
    const plank = new THREE.Mesh(colored(box(1.4, 0.12, plankLen, 1), "#b98d5c"), k.wood);
    const py = (MOLE.y + deckY) / 2;
    plank.position.set(gx, py + 0.05, gz);
    plank.rotation.order = "YXZ";
    plank.rotation.y = Math.atan2(nx, nz);
    plank.rotation.x = Math.atan2(MOLE.y - deckY, plankLen) * (1);
    group.add(plank);
    ctx.surfaces.push((x, z) => {
      const dx = x - gx, dz = z - gz;
      const v = dx * nx + dz * nz, u = -dx * nz + dz * nx;
      if (Math.abs(u) > 0.8 || Math.abs(v) > plankLen / 2 + 0.2) return null;
      const t = (v + plankLen / 2) / plankLen; // 0 at the mole .. 1 at the ship
      return MOLE.y + (deckY - MOLE.y) * Math.max(0, Math.min(1, t));
    });
    // Cargo on deck.
    for (let i = 0; i < 5; i++) {
      const c = new THREE.Mesh(colored(box(0.9, 0.8, 0.9, 0.9), r() < 0.5 ? "#c08a52" : "#a8743f"), k.wood);
      c.position.set(-ship.spec.length * 0.25 + i * 1.6, ship.deckY + 0.46, (r() - 0.5) * 1.2);
      c.rotation.y = r();
      c.castShadow = true;
      ship.group.add(c);
    }
  }

  // Rowing boats tied up along the docks and the quay.
  const tie: Array<[number, number, number]> = [[-58, 40, 0.3], [-56, 58, 1.0], [-30, 72, 1.6], [-4, 71, 1.4], [20, 70, 1.8], [30, -4, -0.4], [-40, -5, 0.1], [-55, 12, -1.2]];
  for (const [x, z, yaw] of tie) {
    if (heightAt(x, z) > -0.8) continue;
    const ship = buildShip({ length: 4.6, beam: 1.7, sail: null, band: ["#3d7fb8", "#c9442f", "#4aa59a", "#f2c641"][Math.floor(r() * 4)], oars: 0, shields: false }, mats, r);
    ship.group.position.set(x, 0.05, z);
    ship.group.rotation.y = yaw;
    ship.group.scale.setScalar(0.9);
    group.add(ship.group);
    moored.push({ ship, phase: r() * 6, base: new THREE.Vector3(x, 0.05, z), yaw });
  }

  const p = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  return {
    group,
    update(dt: number, time: number, _ctx: FrameCtx) {
      for (const s of sailing) {
        s.t = (s.t + (s.speed * dt) / s.len) % 1;
        s.curve.getPointAt(s.t, p);
        s.curve.getPointAt((s.t + 0.004) % 1, ahead);
        const g = s.ship.group;
        g.position.set(p.x, Math.sin(time * 0.9 + s.t * 40) * 0.12, p.z);
        const yaw = Math.atan2(-(ahead.z - p.z), ahead.x - p.x);
        g.rotation.set(Math.sin(time * 0.7 + s.t * 30) * 0.03, yaw, Math.sin(time * 0.55) * 0.015);
        if (s.ship.sail) s.ship.sail.scale.x = 1 + Math.sin(time * 1.3 + s.t * 10) * 0.05;
        if (s.rowing) {
          const stroke = Math.sin(time * 2.2 + s.t * 50);
          s.ship.oars.forEach((bank, i) => {
            const side = i === 0 ? -1 : 1;
            for (const pivot of bank.children) { pivot.rotation.y = stroke * 0.35 * side; pivot.rotation.x = Math.cos(time * 2.2 + s.t * 50) * 0.12 * side; }
          });
        }
      }
      for (const m of moored) {
        const g = m.ship.group;
        g.position.y = m.base.y + Math.sin(time * 0.8 + m.phase) * 0.07;
        g.rotation.x = Math.sin(time * 0.6 + m.phase) * 0.02;
        g.rotation.z = Math.sin(time * 0.5 + m.phase * 1.3) * 0.015;
      }
    },
    dispose() {
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry.dispose();
        const mat = m.material as THREE.MeshStandardMaterial;
        if (mat.map && mat !== k.wood && mat !== k.paint && mat !== k.cloth) { mat.map.dispose(); mat.dispose(); }
      });
      hullMat.dispose();
      k.dispose();
    },
  };
}
