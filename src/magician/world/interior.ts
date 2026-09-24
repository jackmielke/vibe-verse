/**
 * Inside a minka: the room you walk into out of the weather.
 *
 * A farmhouse's main room is built around the irori, the sunken hearth: a
 * square of ash in a wooden frame in the floor, a few embers, and an iron
 * kettle hanging over it from a hook on a pole from the beams, steaming.
 * Around it, tatami; in the back wall the tokonoma, the alcove for one
 * hanging scroll and one arrangement of flowers; paper floor lamps in the
 * corners; cushions and a low table with tea; and, because this is the
 * detail that makes a room somewhere somebody lives, a cat asleep by the
 * fire, breathing.
 *
 * Everything is in the house's own frame (see house.ts: front is +z, the
 * floor is at `FH`), merged per material. The hearth is a lamp for the
 * world's lamp pool and is always lit, so the room glows warm even at noon.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export interface Interior {
  group: THREE.Group;
  /** The hearth's glow, house space: the lamp pool's light goes here. */
  hearth: THREE.Vector3;
  /** Where the cat is, house space. */
  cat: THREE.Vector3;
  /** The room's floor rectangle, house space: |x| < hw, |z| < hd. */
  hw: number;
  hd: number;
  floor: number;
  update(dt: number, time: number, near: boolean): void;
  /** The cat is petted: it stretches, and says so. */
  pet(): void;
  dispose(): void;
}

function canvasTex(w: number, h: number, paint: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  paint(cv.getContext("2d")!);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function buildInterior(room: { FH: number; WH: number; w: number; d: number; doorX: number; ceiling: number }, seed: number): Interior {
  const { FH, w, d, doorX } = room;
  const group = new THREE.Group();
  group.name = "interior";
  const disposables: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(x: T) => { disposables.push(x); return x; };
  const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const put = (mat: THREE.Material, g: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0, rx = 0) => {
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    const list = parts.get(mat) ?? [];
    list.push(g.index ? g.toNonIndexed() : g);
    if (g.index) g.dispose();
    parts.set(mat, list);
  };
  const box = (mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, ry = 0) => put(mat, new THREE.BoxGeometry(sx, sy, sz), x, y, z, ry);

  const hw = w / 2 - 0.1, hd = d / 2 - 0.1;
  const floorY = FH + 0.01;

  // ---- materials ------------------------------------------------------------------
  const tatamiTex = keep(canvasTex(512, 256, (g) => {
    // Two mats side by side: woven rush in a warm straw green, cloth edges.
    g.fillStyle = "#b7b27a"; g.fillRect(0, 0, 512, 256);
    for (let y = 0; y < 256; y += 3) { g.fillStyle = y % 6 ? "rgba(120,110,60,0.18)" : "rgba(255,250,210,0.12)"; g.fillRect(0, y, 512, 1.5); }
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(90,80,40,${Math.random() * 0.08})`; g.fillRect(Math.random() * 512, Math.random() * 256, 8 + Math.random() * 30, 1); }
    g.fillStyle = "#2a2e3a";
    g.fillRect(0, 0, 512, 10); g.fillRect(0, 246, 512, 10);
    g.fillRect(0, 123, 512, 10);
  }));
  tatamiTex.wrapS = tatamiTex.wrapT = THREE.RepeatWrapping;
  const tatami = keep(new THREE.MeshStandardMaterial({ map: tatamiTex, roughness: 0.95 }));
  const boards = keep(new THREE.MeshStandardMaterial({ color: "#7a5a3c", roughness: 0.8 }));
  const darkWood = keep(new THREE.MeshStandardMaterial({ color: "#2a1c14", roughness: 0.75 }));
  const beam = keep(new THREE.MeshStandardMaterial({ color: "#3a2819", roughness: 0.9 }));
  const ash = keep(new THREE.MeshStandardMaterial({ color: "#8e8a84", roughness: 1 }));
  const ember = keep(new THREE.MeshStandardMaterial({ color: "#3a1a0c", emissive: new THREE.Color("#ff5a1a"), emissiveIntensity: 1.6, roughness: 1 }));
  const iron = keep(new THREE.MeshStandardMaterial({ color: "#23211f", roughness: 0.5, metalness: 0.6 }));
  const bamboo = keep(new THREE.MeshStandardMaterial({ color: "#8a7a3e", roughness: 0.7 }));
  const indigo = keep(new THREE.MeshStandardMaterial({ color: "#2c3e6b", roughness: 0.95 }));
  const madder = keep(new THREE.MeshStandardMaterial({ color: "#8e2f2a", roughness: 0.95 }));
  const clay = keep(new THREE.MeshStandardMaterial({ color: "#c9b79c", roughness: 0.6 }));
  const paper = keep(new THREE.MeshStandardMaterial({ color: "#fff3dc", emissive: new THREE.Color("#ffb766"), emissiveIntensity: 1.1, roughness: 0.9, side: THREE.DoubleSide }));
  const scrollTex = keep(canvasTex(128, 320, (g) => {
    g.fillStyle = "#6b4a2e"; g.fillRect(0, 0, 128, 320);
    g.fillStyle = "#efe6d2"; g.fillRect(10, 22, 108, 276);
    // Ink mountains in washes, a moon, and one character: wa, harmony.
    g.fillStyle = "rgba(40,40,50,0.18)";
    g.beginPath(); g.moveTo(10, 250); g.quadraticCurveTo(50, 150, 80, 210); g.quadraticCurveTo(100, 170, 118, 220); g.lineTo(118, 298); g.lineTo(10, 298); g.fill();
    g.fillStyle = "rgba(40,40,50,0.35)";
    g.beginPath(); g.moveTo(10, 280); g.quadraticCurveTo(60, 215, 118, 270); g.lineTo(118, 298); g.lineTo(10, 298); g.fill();
    g.fillStyle = "rgba(200,60,40,0.8)"; g.beginPath(); g.arc(88, 120, 12, 0, 7); g.fill();
    g.fillStyle = "#1a1512"; g.font = "bold 56px serif"; g.textAlign = "center"; g.fillText("和", 52, 100);
    g.fillStyle = "#b8322a"; g.fillRect(20, 272, 10, 10);
  }));
  const scroll = keep(new THREE.MeshStandardMaterial({ map: scrollTex, roughness: 0.9 }));
  const blossom = keep(new THREE.MeshStandardMaterial({ color: "#ffc0d6", emissive: new THREE.Color("#3a1020"), roughness: 0.8 }));
  const catFur = keep(new THREE.MeshStandardMaterial({ color: "#d99a52", roughness: 1 }));
  const catWhite = keep(new THREE.MeshStandardMaterial({ color: "#f3ece2", roughness: 1 }));

  // ---- floor: boards at the entrance, tatami for the rest ------------------------------
  const entry = 1.3; // the genkan: where shoes come off
  put(boards, new THREE.PlaneGeometry(w - 0.2, entry), 0, floorY, hd - entry / 2, 0, -Math.PI / 2);
  const tg = new THREE.PlaneGeometry(w - 0.2, d - 0.2 - entry);
  const uv = tg.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w - 0.2) / 1.8, uv.getY(i) * (d - 0.2 - entry) / 1.8);
  put(tatami, tg, 0, floorY + 0.004, -entry / 2, 0, -Math.PI / 2);
  box(darkWood, w - 0.2, 0.05, 0.08, 0, floorY + 0.02, hd - entry); // the step edge

  // ---- the irori -----------------------------------------------------------------------
  const hx = 0.4, hz = -0.35, H = 1.1;
  for (const [sx, sz, lx, lz] of [[0, -H / 2, H + 0.16, 0.16], [0, H / 2, H + 0.16, 0.16], [-H / 2, 0, 0.16, H], [H / 2, 0, 0.16, H]]) box(darkWood, lx, 0.1, lz, hx + sx, floorY + 0.03, hz + sz);
  box(ash, H - 0.02, 0.02, H - 0.02, hx, floorY - 0.02, hz);
  const rnd = (() => { let s = (seed * 9301 + 49297) >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
  for (let i = 0; i < 9; i++) put(ember, new THREE.DodecahedronGeometry(0.035 + rnd() * 0.03, 0), hx + (rnd() - 0.5) * 0.35, floorY + 0.01, hz + (rnd() - 0.5) * 0.35, rnd() * 3);
  for (let i = 0; i < 3; i++) { const g = new THREE.CylinderGeometry(0.03, 0.035, 0.5, 6); g.rotateZ(Math.PI / 2); put(darkWood, g, hx, floorY + 0.03, hz + (i - 1) * 0.08, 0.5 + i * 0.9); }
  // The jizai-kagi: a pole from the beam, a wooden fish, the kettle on the hook.
  const kettleY = floorY + 0.42;
  const top = room.ceiling - 0.05;
  put(bamboo, new THREE.CylinderGeometry(0.03, 0.03, top - (kettleY + 0.25), 8), hx, (top + kettleY + 0.25) / 2, hz);
  box(darkWood, 0.34, 0.1, 0.05, hx, kettleY + 0.72, hz);
  put(iron, new THREE.CylinderGeometry(0.008, 0.008, 0.28, 4), hx, kettleY + 0.28, hz);
  const kettle = new THREE.SphereGeometry(0.16, 16, 10); kettle.scale(1, 0.78, 1);
  put(iron, kettle, hx, kettleY, hz);
  put(iron, new THREE.CylinderGeometry(0.05, 0.06, 0.04, 12), hx, kettleY + 0.13, hz);
  const spout = new THREE.CylinderGeometry(0.018, 0.028, 0.16, 8); spout.rotateZ(-0.9);
  put(iron, spout, hx + 0.19, kettleY + 0.04, hz);
  const handle = new THREE.TorusGeometry(0.13, 0.008, 6, 20, Math.PI); put(iron, handle, hx, kettleY + 0.12, hz);

  // ---- beams across the ceiling ------------------------------------------------------------
  for (const z of [-d * 0.25, d * 0.2]) box(beam, w - 0.1, 0.24, 0.22, 0, room.ceiling - 0.15, z);
  box(beam, 0.22, 0.2, d - 0.1, hx, room.ceiling - 0.3, 0);

  // ---- the tokonoma, in the back wall --------------------------------------------------------
  const tx = -w * 0.26, tz = -hd + 0.28;
  box(darkWood, 1.4, 0.14, 0.52, tx, floorY + 0.07, tz);
  box(darkWood, 0.1, 2.2, 0.1, tx + 0.72, floorY + 1.1, tz + 0.2); // the toko-bashira, the alcove's post
  put(scroll, new THREE.PlaneGeometry(0.46, 1.15), tx, floorY + 1.3, -hd + 0.02);
  const vase = new THREE.CylinderGeometry(0.06, 0.09, 0.26, 12);
  put(clay, vase, tx + 0.35, floorY + 0.27, tz);
  const stem = new THREE.CylinderGeometry(0.01, 0.012, 0.8, 5); stem.rotateZ(0.3);
  put(darkWood, stem, tx + 0.25, floorY + 0.7, tz);
  for (let i = 0; i < 14; i++) put(blossom, new THREE.IcosahedronGeometry(0.045 + rnd() * 0.02, 0), tx + 0.12 + rnd() * 0.3 - (i / 14) * 0.2, floorY + 0.55 + (i / 14) * 0.55 + rnd() * 0.06, tz + (rnd() - 0.5) * 0.2);

  // ---- andon: paper floor lamps in the corners -------------------------------------------------
  for (const [ax, az] of [[w / 2 - 0.45, -hd + 0.45], [-w / 2 + 0.45, hd - entry - 0.35]]) {
    box(darkWood, 0.34, 0.04, 0.34, ax, floorY + 0.02, az);
    for (const [px, pz] of [[-0.15, -0.15], [0.15, -0.15], [-0.15, 0.15], [0.15, 0.15]]) box(darkWood, 0.03, 0.62, 0.03, ax + px, floorY + 0.33, az + pz);
    box(paper, 0.28, 0.42, 0.28, ax, floorY + 0.42, az);
    box(darkWood, 0.34, 0.03, 0.34, ax, floorY + 0.64, az);
  }

  // ---- cushions and the tea table ------------------------------------------------------------------
  const zab = (x: number, z: number, mat: THREE.Material, ry = 0) => { const g = new THREE.BoxGeometry(0.55, 0.07, 0.6, 2, 1, 2); put(mat, g, x, floorY + 0.035, z, ry); };
  zab(hx - 0.95, hz, indigo, 0.1); zab(hx + 0.95, hz + 0.1, madder, -0.1); zab(hx, hz + 0.95, indigo, 0.05);
  const cx = -w * 0.22, cz = hd - entry - 1.0;
  put(darkWood, new THREE.CylinderGeometry(0.42, 0.42, 0.04, 24), cx, floorY + 0.3, cz);
  for (let i = 0; i < 4; i++) box(darkWood, 0.05, 0.28, 0.05, cx + Math.cos(i * 1.57 + 0.78) * 0.3, floorY + 0.14, cz + Math.sin(i * 1.57 + 0.78) * 0.3);
  for (const [ox, oz] of [[0.14, 0.05], [-0.12, -0.1]]) put(clay, new THREE.CylinderGeometry(0.035, 0.03, 0.07, 10), cx + ox, floorY + 0.355, cz + oz);
  const pot = new THREE.SphereGeometry(0.07, 12, 8); pot.scale(1, 0.8, 1); put(clay, pot, cx - 0.02, floorY + 0.37, cz + 0.14);
  // A tansu chest against the right wall.
  box(darkWood, 0.5, 0.9, 1.1, w / 2 - 0.35, floorY + 0.45, 0.4);
  for (let i = 0; i < 3; i++) box(iron, 0.02, 0.04, 0.2, w / 2 - 0.6, floorY + 0.2 + i * 0.28, 0.4);

  // Merge by material.
  for (const [mat, list] of parts) {
    const g = mergeGeometries(list, false);
    for (const p of list) p.dispose();
    if (!g) continue;
    keep(g);
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    m.castShadow = mat !== paper && mat !== tatami && mat !== boards;
    group.add(m);
  }

  // ---- the cat, asleep by the fire (separate: it breathes) -------------------------------------------
  const cat = new THREE.Group();
  const body = new THREE.Mesh(keep(new THREE.SphereGeometry(0.2, 16, 10)), catFur);
  body.scale.set(1.2, 0.55, 0.9);
  const head = new THREE.Mesh(keep(new THREE.SphereGeometry(0.1, 14, 10)), catFur);
  head.position.set(0.19, 0.02, 0.08);
  const muzzle = new THREE.Mesh(keep(new THREE.SphereGeometry(0.05, 10, 8)), catWhite);
  muzzle.position.set(0.26, -0.01, 0.1);
  const earGeo = keep(new THREE.ConeGeometry(0.035, 0.07, 6));
  const ear1 = new THREE.Mesh(earGeo, catFur); ear1.position.set(0.17, 0.1, 0.03); ear1.rotation.z = -0.3;
  const ear2 = new THREE.Mesh(earGeo, catFur); ear2.position.set(0.2, 0.09, 0.14); ear2.rotation.set(0.4, 0, -0.3);
  const tail = new THREE.Mesh(keep(new THREE.TorusGeometry(0.2, 0.03, 6, 16, Math.PI * 1.1)), catFur);
  tail.rotation.x = Math.PI / 2; tail.position.set(-0.02, -0.07, 0.02);
  cat.add(body, head, muzzle, ear1, ear2, tail);
  for (const c of cat.children) { c.castShadow = true; }
  const catAt = new THREE.Vector3(hx + 0.95, floorY + 0.14, hz + 0.1);
  cat.position.copy(catAt);
  cat.rotation.y = 2.4;
  group.add(cat);

  // ---- steam from the spout and a little flame over the embers -----------------------------------------
  const puffTex = keep(canvasTex(64, 64, (g) => {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, "rgba(255,255,255,0.8)"); gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  }));
  const steam: Array<{ s: THREE.Sprite; m: THREE.SpriteMaterial; age: number }> = [];
  for (let i = 0; i < 7; i++) {
    const m = keep(new THREE.SpriteMaterial({ map: puffTex, color: "#ffffff", transparent: true, opacity: 0, depthWrite: false }));
    const s = new THREE.Sprite(m);
    group.add(s);
    steam.push({ s, m, age: i * 0.5 });
  }
  const flameMat = keep(new THREE.SpriteMaterial({ map: puffTex, color: "#ff8a3a", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.8 }));
  const flame = new THREE.Sprite(flameMat);
  flame.position.set(hx, floorY + 0.12, hz);
  group.add(flame);

  let petted = 0;
  return {
    group,
    hearth: new THREE.Vector3(hx, floorY + 0.5, hz),
    cat: catAt.clone(),
    hw, hd,
    floor: floorY,
    update(dt, time, near) {
      if (!near) { group.visible = false; return; }
      group.visible = true;
      // Breathing, and a slow stretch after being petted.
      petted = Math.max(0, petted - dt);
      const breath = 1 + Math.sin(time * 1.6) * 0.04;
      body.scale.set(1.2 + petted * 0.25, 0.55 * breath, 0.9);
      head.rotation.z = Math.sin(time * 0.3) * 0.05 + petted * 0.4;
      ear1.rotation.x = Math.sin(time * 7) > 0.97 ? 0.4 : 0;
      tail.rotation.z = Math.sin(time * 0.8) * 0.15 + petted * Math.sin(time * 6) * 0.3;
      ember.emissiveIntensity = 1.3 + Math.sin(time * 3.1) * 0.2 + Math.sin(time * 7.3) * 0.15;
      const f = 0.3 + Math.sin(time * 11) * 0.05 + Math.sin(time * 17) * 0.04;
      flame.scale.set(f, f * 1.5, 1);
      flameMat.opacity = 0.55 + Math.sin(time * 9) * 0.1;
      for (const p of steam) {
        p.age += dt;
        const life = 3.5;
        if (p.age > life) p.age -= life;
        const k = p.age / life;
        p.s.position.set(hx + 0.26 + k * 0.25 + Math.sin(time + p.age * 3) * 0.04, kettleY + 0.12 + k * 0.9, hz + Math.sin(p.age * 2) * 0.05);
        const sz = 0.08 + k * 0.35;
        p.s.scale.set(sz, sz, 1);
        p.m.opacity = Math.sin(k * Math.PI) * 0.28;
      }
    },
    pet() { petted = 2.5; },
    dispose() { for (const x of disposables) x.dispose(); },
  };
}
