/**
 * The Vibe Gate Bridge and The Rock.
 *
 * A suspension bridge in international orange runs west from the end of the
 * z = -140 street, over the bay, to a small rocky island with an old prison
 * on it: a cellhouse you can stand on, a lighthouse that sweeps the water at
 * night, a water tower and a little dock.
 *
 * Everything you stand on is ordinary collision (`WorldBox`), so the bridge
 * is walked, driven and jumped off like any street. The ramps up to the deck
 * are runs of thin steps (0.15 m, under the 0.4 m a walker or a car steps up
 * on its own) drawn as one smooth slope, the trick the marina ramp uses.
 *
 * Geometry is merged per material, so the whole thing is a handful of draw
 * calls however many suspender cables it has.
 */
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";
import { beam, canvas, merge, signTexture, tex } from "../landmarks/common";

/** Street the bridge leaves from, and where it lands. */
export const BRIDGE_Z = -140;
const SHORE_X = -176; // end of the city street
const DECK_Y = 11;
const RAMP_END = -236; // top of the city-side approach
const TOWER_E = -262;
const TOWER_W = -402;
const DECK_END = -428; // start of the island-side descent
export const ROCK_X = -492;
export const ROCK_Z = BRIDGE_Z + 6;
const ROCK_TOP = 4.2;
const ROCK_R = 46;
const DECK_W = 12;
const TOWER_H = 62;

export interface Bay {
  group: THREE.Group;
  /** Where "take me to the bridge" or "the rock" goes. */
  spots: { bridge: THREE.Vector3; rock: THREE.Vector3 };
  setDay(day: boolean): void;
  update(dt: number): void;
  dispose(): void;
}

export function buildBay(opts: { boxes: WorldBox[]; lowDetail?: boolean }): Bay {
  const { boxes } = opts;
  const group = new THREE.Group();
  group.name = "vibe-gate-bay";
  const trash: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(t: T) => (trash.push(t), t);

  const orange = keep(new THREE.MeshStandardMaterial({ color: 0xc0362c, roughness: 0.55, metalness: 0.2 }));
  const asphalt = keep(new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.9 }));
  const concrete = keep(new THREE.MeshStandardMaterial({ color: 0x9ea3a8, roughness: 0.9 }));
  const paint = keep(new THREE.MeshBasicMaterial({ color: 0xf2e9c9 }));
  const lampMat = keep(new THREE.MeshStandardMaterial({ color: 0xfff1c9, emissive: 0xffc77a, emissiveIntensity: 0 }));

  // ---- Collision helpers ----------------------------------------------------
  const zs = BRIDGE_Z - DECK_W / 2;
  const ze = BRIDGE_Z + DECK_W / 2;
  /** Thin steps from (xLow, yLow) to (xHigh, yHigh), x may run either way. */
  const stepRamp = (xLow: number, yLow: number, xHigh: number, yHigh: number) => {
    const n = Math.max(2, Math.ceil((yHigh - yLow) / 0.15));
    for (let i = 1; i <= n; i++) {
      const top = yLow + ((yHigh - yLow) * i) / n;
      const xa = xLow + ((xHigh - xLow) * (i - 1)) / n;
      // Each step runs from its own start all the way to the high end, so
      // they overlap and there is never a slot between two of them.
      boxes.push({ minX: Math.min(xa, xHigh), maxX: Math.max(xa, xHigh), minZ: zs, maxZ: ze, base: top - 1.2, height: top });
    }
  };
  stepRamp(SHORE_X, 0.14, RAMP_END, DECK_Y);
  boxes.push({ minX: DECK_END, maxX: RAMP_END, minZ: zs, maxZ: ze, base: DECK_Y - 1.2, height: DECK_Y });
  stepRamp(ROCK_X + ROCK_R - 8, ROCK_TOP, DECK_END, DECK_Y);
  // Kerb walls the length of the bridge, so a car stays on it.
  for (const z of [zs - 0.3, ze]) {
    boxes.push({ minX: DECK_END - 2, maxX: RAMP_END + 2, minZ: z, maxZ: z + 0.3, base: DECK_Y - 1, height: DECK_Y + 1.1 });
  }

  // ---- Deck and ramps (drawn) -------------------------------------------------
  const deckParts: THREE.BufferGeometry[] = [];
  const slab = (x0: number, y0: number, x1: number, y1: number) => {
    const run = x1 - x0;
    const len = Math.hypot(run, y1 - y0);
    const g = new THREE.BoxGeometry(len, 0.9, DECK_W);
    g.rotateZ(Math.atan2(y1 - y0, run));
    g.translate((x0 + x1) / 2, (y0 + y1) / 2 - 0.45, BRIDGE_Z);
    deckParts.push(g);
  };
  slab(SHORE_X, 0.14, RAMP_END, DECK_Y);
  slab(RAMP_END, DECK_Y, DECK_END, DECK_Y);
  slab(DECK_END, DECK_Y, ROCK_X + ROCK_R - 8, ROCK_TOP);
  const deck = new THREE.Mesh(keep(merge(deckParts)), asphalt);
  deck.receiveShadow = true;
  group.add(deck);

  // Lane paint on the level span.
  {
    const parts: THREE.BufferGeometry[] = [];
    for (let x = RAMP_END - 2; x > DECK_END + 2; x -= 6) {
      const g = new THREE.PlaneGeometry(3, 0.18);
      g.rotateX(-Math.PI / 2);
      g.translate(x, DECK_Y + 0.02, BRIDGE_Z);
      parts.push(g);
    }
    for (const s of [-1, 1]) {
      const g = new THREE.PlaneGeometry(RAMP_END - DECK_END, 0.15);
      g.rotateX(-Math.PI / 2);
      g.translate((RAMP_END + DECK_END) / 2, DECK_Y + 0.02, BRIDGE_Z + s * (DECK_W / 2 - 0.8));
      parts.push(g);
    }
    group.add(new THREE.Mesh(keep(merge(parts)), paint));
  }

  // ---- Steel: towers, truss, rails, cables, suspenders -----------------------
  const steel: THREE.BufferGeometry[] = [];
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // Stiffening truss under the level deck and along its edges.
  for (const s of [-1, 1]) {
    const z = BRIDGE_Z + s * (DECK_W / 2 + 0.1);
    const g = new THREE.BoxGeometry(DECK_END - RAMP_END, 1.6, 0.4);
    g.translate((RAMP_END + DECK_END) / 2, DECK_Y - 1.6, z);
    steel.push(g);
    const rail = new THREE.BoxGeometry(Math.abs(DECK_END - RAMP_END), 0.12, 0.12);
    rail.translate((RAMP_END + DECK_END) / 2, DECK_Y + 1.05, z);
    steel.push(rail);
  }
  for (let x = RAMP_END; x >= DECK_END; x -= 8) {
    for (const s of [-1, 1]) {
      const z = BRIDGE_Z + s * (DECK_W / 2 + 0.1);
      steel.push(beam(V(x, DECK_Y - 2.4, z), V(x - 4, DECK_Y - 0.8, z), 0.12));
      steel.push(beam(V(x - 4, DECK_Y - 0.8, z), V(x - 8, DECK_Y - 2.4, z), 0.12));
      steel.push(beam(V(x, DECK_Y, z), V(x, DECK_Y + 1.05, z), 0.06));
    }
  }
  // Towers: two stepped legs each side of the deck, Art Deco portals between.
  const towerBoxes: Array<[number, number, number, number, number, number]> = [];
  for (const tx of [TOWER_E, TOWER_W]) {
    for (const s of [-1, 1]) {
      const z = BRIDGE_Z + s * (DECK_W / 2 + 1.6);
      const stages: Array<[number, number, number]> = [
        [-6, 22, 3.2],
        [22, 44, 2.7],
        [44, TOWER_H, 2.2],
      ];
      for (const [y0, y1, w] of stages) {
        const g = new THREE.BoxGeometry(w, y1 - y0, w * 1.25);
        g.translate(tx, (y0 + y1) / 2, z);
        steel.push(g);
      }
      towerBoxes.push([tx - 1.6, tx + 1.6, z - 2, z + 2, -6, TOWER_H]);
    }
    for (const y of [DECK_Y + 13, 36, 50, TOWER_H - 2]) {
      const g = new THREE.BoxGeometry(2, y > 40 ? 2.6 : 3.4, DECK_W + 3.2);
      g.translate(tx, y, BRIDGE_Z);
      steel.push(g);
    }
    // The pier the tower stands on.
    const pier = new THREE.CylinderGeometry(6.5, 7.5, 12, 18);
    pier.scale(1, 1, 2.2);
    pier.translate(tx, -4.5, BRIDGE_Z);
    steel.push(pier);
  }
  for (const [x0, x1, z0, z1, y0, y1] of towerBoxes) boxes.push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1, base: y0, height: y1 });

  // Main cables: a sag between the towers, a straight run to each anchorage.
  const cableTop = TOWER_H - 1.2;
  const sagLow = DECK_Y + 3;
  const cableY = (x: number) => {
    if (x <= TOWER_E && x >= TOWER_W) {
      const t = (x - TOWER_E) / (TOWER_W - TOWER_E);
      return sagLow + (cableTop - sagLow) * Math.pow(2 * t - 1, 2);
    }
    if (x > TOWER_E) return cableTop + ((sagLow - 2 - cableTop) * (x - TOWER_E)) / (RAMP_END + 6 - TOWER_E);
    return cableTop + ((sagLow - 2 - cableTop) * (TOWER_W - x)) / (TOWER_W - (DECK_END - 6));
  };
  const cables: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const z = BRIDGE_Z + s * (DECK_W / 2 + 1.6);
    const pts: THREE.Vector3[] = [];
    for (let x = RAMP_END + 6; x >= DECK_END - 6; x -= 4) pts.push(V(x, cableY(x), z));
    const curve = new THREE.CatmullRomCurve3(pts);
    cables.push(new THREE.TubeGeometry(curve, 90, 0.42, 6, false));
    // Suspenders every 5 m.
    for (let x = RAMP_END + 2; x >= DECK_END - 2; x -= 5) {
      const top = cableY(x);
      if (top - DECK_Y < 1.4) continue;
      cables.push(beam(V(x, DECK_Y + 0.2, z - s * 0.4), V(x, top, z), 0.07, 4));
    }
  }
  const steelMesh = new THREE.Mesh(keep(merge([...steel, ...cables])), orange);
  steelMesh.castShadow = !opts.lowDetail;
  group.add(steelMesh);

  // The city-side abutment and the approach columns.
  {
    const parts: THREE.BufferGeometry[] = [];
    for (let x = RAMP_END + 4; x < SHORE_X - 10; x += 12) {
      const top = ((SHORE_X - x) / (SHORE_X - RAMP_END)) * DECK_Y - 0.9;
      for (const s of [-1, 1]) {
        const g = new THREE.BoxGeometry(1.4, top + 6, 1.4);
        g.translate(x, (top - 6) / 2, BRIDGE_Z + s * (DECK_W / 2 - 1.5));
        parts.push(g);
      }
    }
    group.add(new THREE.Mesh(keep(merge(parts)), concrete));
  }

  // Deck lamps, both sides, every 20 m.
  const lampParts: THREE.BufferGeometry[] = [];
  const postParts: THREE.BufferGeometry[] = [];
  for (let x = RAMP_END - 6; x > DECK_END; x -= 20) {
    for (const s of [-1, 1]) {
      const z = BRIDGE_Z + s * (DECK_W / 2 - 0.3);
      const p = new THREE.CylinderGeometry(0.07, 0.09, 5, 6);
      p.translate(x, DECK_Y + 2.5, z);
      postParts.push(p);
      const h = new THREE.BoxGeometry(0.9, 0.25, 0.4);
      h.translate(x, DECK_Y + 5, z - s * 0.4);
      lampParts.push(h);
    }
  }
  group.add(new THREE.Mesh(keep(merge(postParts)), orange));
  group.add(new THREE.Mesh(keep(merge(lampParts)), lampMat));

  // A sign over the city-side approach.
  {
    const t = keep(signTexture([{ text: "VIBE GATE BRIDGE", size: 92, color: "#ffe9c2" }, { text: "TO THE ROCK  ➜", size: 54, color: "#ffffff" }], "#7a1d17", 1024, 256, "#ffe9c2"));
    const m = keep(new THREE.MeshStandardMaterial({ map: t, roughness: 0.6, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.15 }));
    const sign = new THREE.Mesh(keep(new THREE.PlaneGeometry(10, 2.5)), m);
    sign.position.set(SHORE_X - 4, 6.2, BRIDGE_Z);
    sign.rotation.y = Math.PI / 2;
    group.add(sign);
    const back = new THREE.Mesh(sign.geometry, m);
    back.position.set(SHORE_X - 4.05, 6.2, BRIDGE_Z);
    back.rotation.y = -Math.PI / 2;
    group.add(back);
    const g = new THREE.BoxGeometry(0.3, 7.5, 0.3);
    const posts = merge([g.clone().translate(SHORE_X - 4, 3.75, BRIDGE_Z - 5.6), g.clone().translate(SHORE_X - 4, 3.75, BRIDGE_Z + 5.6)]);
    g.dispose();
    group.add(new THREE.Mesh(keep(posts), orange));
  }

  // ---- The Rock -----------------------------------------------------------------
  const rockMat = keep(new THREE.MeshStandardMaterial({ color: 0x7c7266, roughness: 1, flatShading: true }));
  const grassMat = keep(new THREE.MeshStandardMaterial({ color: 0x5d7d4a, roughness: 1 }));
  {
    // A lumpy cliff from the seabed to the plateau.
    const g = new THREE.CylinderGeometry(ROCK_R, ROCK_R + 14, 30, 28, 4);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const a = Math.atan2(z, x);
      const n = Math.sin(a * 5) * 2.2 + Math.sin(a * 11 + 1.3) * 1.2 + Math.sin(y * 0.4 + a * 3) * 1.1;
      const k = 1 + (y < 14 ? n / ROCK_R : 0);
      pos.setXYZ(i, x * k, y, z * k);
    }
    g.computeVertexNormals();
    g.translate(ROCK_X, ROCK_TOP - 15, ROCK_Z);
    const cliff = new THREE.Mesh(keep(g), rockMat);
    cliff.receiveShadow = true;
    group.add(cliff);
    const top = new THREE.Mesh(keep(new THREE.CircleGeometry(ROCK_R - 0.5, 40).rotateX(-Math.PI / 2).translate(ROCK_X, ROCK_TOP + 0.02, ROCK_Z)), grassMat);
    top.receiveShadow = true;
    group.add(top);
    // Walkable plateau, as strips so the round edge holds.
    const strips = 14;
    const step = (2 * ROCK_R) / strips;
    for (let i = 0; i < strips; i++) {
      const z0 = -ROCK_R + i * step;
      const zm = z0 <= 0 && z0 + step >= 0 ? 0 : Math.min(Math.abs(z0), Math.abs(z0 + step));
      const half = Math.sqrt(Math.max(0, ROCK_R * ROCK_R - zm * zm)) - 1;
      boxes.push({ minX: ROCK_X - half, maxX: ROCK_X + half, minZ: ROCK_Z + z0, maxZ: ROCK_Z + z0 + step, base: ROCK_TOP - 3, height: ROCK_TOP });
    }
  }

  // The cellhouse: long, white, rows of barred windows, walkable roof.
  const cellX = ROCK_X - 6;
  const cellZ = ROCK_Z - 8;
  const cellW = 44;
  const cellD = 14;
  const cellH = 11;
  {
    const { c, x } = canvas(512, 128);
    x.fillStyle = "#e9e4d8";
    x.fillRect(0, 0, 512, 128);
    for (let i = 0; i < 16; i++) {
      for (const row of [20, 72]) {
        x.fillStyle = "#2a2d33";
        x.fillRect(10 + i * 32, row, 18, 34);
        x.fillStyle = "#9aa0a6";
        for (let b = 0; b < 4; b++) x.fillRect(12 + i * 32 + b * 5, row, 1.5, 34);
      }
    }
    const wallTex = keep(tex(c));
    wallTex.repeat.set(1, 1);
    const wallMat = keep(new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.85 }));
    const roofMat = keep(new THREE.MeshStandardMaterial({ color: 0x8e8a82, roughness: 0.95 }));
    const body = new THREE.Mesh(keep(new THREE.BoxGeometry(cellW, cellH, cellD)), [wallMat, wallMat, roofMat, roofMat, wallMat, wallMat]);
    body.position.set(cellX, ROCK_TOP + cellH / 2, cellZ);
    body.castShadow = body.receiveShadow = true;
    group.add(body);
    boxes.push({ minX: cellX - cellW / 2, maxX: cellX + cellW / 2, minZ: cellZ - cellD / 2, maxZ: cellZ + cellD / 2, base: ROCK_TOP, height: ROCK_TOP + cellH });
    // A sign on the side facing the bridge.
    const st = keep(signTexture([{ text: "THE ROCK", size: 120, color: "#2a2d33" }, { text: "VIBE CITY PENITENTIARY", size: 46, color: "#5a1e18" }], "#efe9da", 1024, 256));
    const sign = new THREE.Mesh(keep(new THREE.PlaneGeometry(14, 3.5)), keep(new THREE.MeshStandardMaterial({ map: st, roughness: 0.8 })));
    sign.position.set(cellX + cellW / 2 + 0.06, ROCK_TOP + cellH - 2.6, cellZ);
    sign.rotation.y = Math.PI / 2;
    group.add(sign);
    // Steps up to the roof at the east end, for the view.
    for (let i = 0; i < 16; i++) {
      const top = ROCK_TOP + ((i + 1) * cellH) / 16;
      const x1 = cellX + cellW / 2 + 1 + (16 - i) * 0.9;
      const g = new THREE.BoxGeometry(0.9, 0.25, 2.4);
      g.translate(x1 - 0.45, top - 0.125, cellZ + cellD / 2 + 1.4);
      const m = new THREE.Mesh(keep(g), concrete);
      group.add(m);
      boxes.push({ minX: x1 - 0.9, maxX: x1, minZ: cellZ + cellD / 2 + 0.2, maxZ: cellZ + cellD / 2 + 2.6, base: top - 0.3, height: top });
    }
    // A walkway from the top step back onto the roof.
    boxes.push({ minX: cellX + cellW / 2 - 2, maxX: cellX + cellW / 2 + 1.9, minZ: cellZ + cellD / 2 - 0.5, maxZ: cellZ + cellD / 2 + 2.6, base: ROCK_TOP + cellH - 0.4, height: ROCK_TOP + cellH });
  }

  // The water tower.
  {
    const tx = ROCK_X + 24;
    const tz = ROCK_Z + 18;
    const legs: THREE.BufferGeometry[] = [];
    for (const [dx, dz] of [[-2.5, -2.5], [2.5, -2.5], [2.5, 2.5], [-2.5, 2.5]]) {
      legs.push(beam(V(tx + dx * 1.2, ROCK_TOP, tz + dz * 1.2), V(tx + dx, ROCK_TOP + 14, tz + dz), 0.22));
    }
    legs.push(new THREE.CylinderGeometry(3.6, 3.6, 5.5, 16).translate(tx, ROCK_TOP + 16.7, tz));
    legs.push(new THREE.ConeGeometry(3.9, 1.8, 16).translate(tx, ROCK_TOP + 20.3, tz));
    const m = new THREE.Mesh(keep(merge(legs)), keep(new THREE.MeshStandardMaterial({ color: 0xb9b2a2, roughness: 0.8 })));
    m.castShadow = true;
    group.add(m);
    boxes.push({ minX: tx - 3.6, maxX: tx + 3.6, minZ: tz - 3.6, maxZ: tz + 3.6, base: ROCK_TOP + 14, height: ROCK_TOP + 19.5 });
  }

  // The lighthouse, and its beam.
  const lhX = ROCK_X - 22;
  const lhZ = ROCK_Z + 16;
  const lhTop = ROCK_TOP + 24;
  const beamGroup = new THREE.Group();
  const lensMat = keep(new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xffe9a8, emissiveIntensity: 0.3 }));
  const beamMat = keep(new THREE.MeshBasicMaterial({ color: 0xfff1c0, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }));
  {
    const white = keep(new THREE.MeshStandardMaterial({ color: 0xf1efe8, roughness: 0.7 }));
    const tower = new THREE.Mesh(keep(new THREE.CylinderGeometry(1.7, 2.6, 22, 12).translate(lhX, ROCK_TOP + 11, lhZ)), white);
    tower.castShadow = true;
    group.add(tower);
    const lens = new THREE.Mesh(keep(new THREE.CylinderGeometry(1.4, 1.4, 2.2, 12).translate(lhX, lhTop, lhZ)), lensMat);
    group.add(lens);
    const cap = new THREE.Mesh(keep(new THREE.ConeGeometry(2, 1.8, 12).translate(lhX, lhTop + 2, lhZ)), keep(new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.6 })));
    group.add(cap);
    boxes.push({ minX: lhX - 2, maxX: lhX + 2, minZ: lhZ - 2, maxZ: lhZ + 2, base: ROCK_TOP, height: ROCK_TOP + 22 });
    // Two opposed cones of light, 160 m long.
    const cone = new THREE.ConeGeometry(14, 160, 20, 1, true);
    // Bright at the lamp, gone by the far end: additive, so black is clear.
    {
      const uv = cone.attributes.uv as THREE.BufferAttribute;
      const col = new Float32Array(uv.count * 3);
      for (let i = 0; i < uv.count; i++) col.fill(Math.pow(uv.getY(i), 2.2), i * 3, i * 3 + 3);
      cone.setAttribute("color", new THREE.BufferAttribute(col, 3));
    }
    cone.translate(0, -80, 0);
    cone.rotateZ(Math.PI / 2);
    const a = new THREE.Mesh(keep(cone), beamMat);
    const b = new THREE.Mesh(cone, beamMat);
    b.rotation.y = Math.PI;
    beamGroup.add(a, b);
    beamGroup.position.set(lhX, lhTop, lhZ);
    beamGroup.visible = false;
    group.add(beamGroup);
  }

  // A small dock on the south side.
  {
    const dx = ROCK_X + 6;
    const dz = ROCK_Z + ROCK_R + 4;
    const g = new THREE.BoxGeometry(6, 0.4, 14);
    g.translate(dx, 1.3, dz);
    group.add(new THREE.Mesh(keep(g), keep(new THREE.MeshStandardMaterial({ color: 0x8a6b4c, roughness: 0.95 }))));
    boxes.push({ minX: dx - 3, maxX: dx + 3, minZ: dz - 7, maxZ: dz + 7, base: 0.9, height: 1.5 });
    // Steps from the dock up the cliff path.
    for (let i = 0; i < 18; i++) {
      const top = 1.5 + ((ROCK_TOP - 1.5) * (i + 1)) / 18;
      const z1 = dz - 7 - i * 0.25;
      boxes.push({ minX: dx - 1.5, maxX: dx + 1.5, minZ: ROCK_Z + ROCK_R - 6, maxZ: z1, base: top - 1, height: top });
    }
    const path = new THREE.BoxGeometry(3, 0.4, 7);
    path.rotateX(Math.atan2(ROCK_TOP - 1.5, 7));
    path.translate(dx, (ROCK_TOP + 1.5) / 2, ROCK_Z + ROCK_R - 2.5);
    group.add(new THREE.Mesh(keep(path), concrete));
  }

  let day = true;
  let t = 0;
  return {
    group,
    spots: {
      bridge: new THREE.Vector3((TOWER_E + TOWER_W) / 2, DECK_Y + 0.2, BRIDGE_Z),
      rock: new THREE.Vector3(ROCK_X + 20, ROCK_TOP + 0.2, ROCK_Z),
    },
    setDay(d) {
      day = d;
      lampMat.emissiveIntensity = d ? 0 : 2.2;
      lensMat.emissiveIntensity = d ? 0.3 : 3;
      beamGroup.visible = !d;
      beamMat.opacity = d ? 0 : 0.35;
    },
    update(dt) {
      t += dt;
      if (!day) beamGroup.rotation.y = t * 0.6;
    },
    dispose() {
      trash.forEach((x) => x.dispose());
    },
  };
}
