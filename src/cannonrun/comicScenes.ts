/**
 * The comic's pictures, rendered in 3D from the game's own models: Mort, Linda,
 * your truck, Grandpa's cannon and the station wagons. Each panel is a tiny
 * scene rendered once to an image; Comic.tsx letters it with SVG on top.
 */
import * as THREE from "three";
import { box, buildCannon, buildFoe, buildMort, buildTruck, glowTexture, type Mort } from "./models";

export const PANEL_W = 800;
export const PANEL_H = 600;

function disposeTree(o: THREE.Object3D): void {
  o.traverse((n) => {
    const m = n as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

function stage(bg: number, key = 0xfff0d8, keyI = 2.2): { scene: THREE.Scene; key: THREE.DirectionalLight } {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(bg);
  scene.add(new THREE.HemisphereLight(0x8aa0d8, 0x2a2018, 1.1));
  const k = new THREE.DirectionalLight(key, keyI);
  k.position.set(4, 7, 6);
  scene.add(k);
  const rim = new THREE.DirectionalLight(0x8ab8ff, 1.2);
  rim.position.set(-5, 4, -6);
  scene.add(rim);
  return { scene, key: k };
}

function cam(fov: number, pos: [number, number, number], look: [number, number, number], aspect = PANEL_W / PANEL_H): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(fov, aspect, 0.05, 400);
  c.position.set(...pos);
  c.lookAt(...look);
  return c;
}

/** A standing Mort or Linda, brows set and mouth open as asked. */
function figure(linda: boolean, mood: "asleep" | "furious" | "yell" | "grin"): Mort {
  const m = buildMort(linda);
  const fury = mood === "asleep" ? 0 : mood === "grin" ? 0.25 : 0.6;
  m.brows[0].rotation.z = -fury;
  m.brows[1].rotation.z = fury;
  if (!linda) m.mouth.scale.set(mood === "asleep" ? 0.7 : 1.5, mood === "yell" || mood === "furious" ? 3.2 : mood === "grin" ? 1.6 : 0.6, 1);
  if (mood === "asleep") {
    m.head.rotation.z = 0.35;
    m.head.rotation.x = 0.25;
    // eyes shut: squash the whites flat
    m.head.children.forEach((c) => { if ((c as THREE.Mesh).geometry instanceof THREE.SphereGeometry && Math.abs(c.position.z - 0.165) < 0.05 && c.position.y > 0.02) c.scale.y = 0.15; });
  }
  return m;
}

function phoneIn(m: Mort, color: number): void {
  // the receiver held to the right ear, the arm bent up to it, a curly cord hanging down
  m.armR.rotation.x = -0.6;
  m.armR.rotation.z = -2.45;
  const handset = new THREE.Group();
  handset.position.set(-0.21, -0.02, 0.05);
  handset.rotation.z = 0.25;
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4 });
  handset.add(box(0.06, 0.3, 0.07, 0, 0, 0, mat));
  handset.add(box(0.08, 0.07, 0.1, 0.01, 0.14, 0.03, mat));
  handset.add(box(0.08, 0.07, 0.1, 0.01, -0.14, 0.05, mat));
  for (let i = 0; i < 9; i++) {
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.008, 4, 10), mat);
    coil.position.set(-0.02, -0.2 - i * 0.04, 0.03);
    coil.rotation.x = Math.PI / 2;
    handset.add(coil);
  }
  m.head.add(handset);
}

function garageRoom(scene: THREE.Scene, doorOpen: boolean): void {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0x4a4440, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const wall = new THREE.MeshStandardMaterial({ color: 0x5a4a3a, roughness: 0.9 });
  scene.add(box(14, 6, 0.2, 0, 3, -4, wall));
  scene.add(box(0.2, 6, 14, -6, 3, 0, wall));
  // pegboard of tools
  const tool = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.4, metalness: 0.7 });
  for (let i = 0; i < 6; i++) scene.add(box(0.12, 0.6 + (i % 3) * 0.2, 0.06, -3 + i * 0.5, 2.6, -3.85, tool));
  scene.add(box(3.4, 1.6, 0.05, -1.75, 2.6, -3.88, new THREE.MeshStandardMaterial({ color: 0x8a6a4a })));
  if (!doorOpen) scene.add(box(0.2, 6, 14, 6, 3, 0, wall));
  // the bulb
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), new THREE.MeshBasicMaterial({ color: 0xfff2c0 }));
  bulb.position.set(0.4, 4.2, 0);
  scene.add(bulb);
  scene.add(box(0.02, 1.8, 0.02, 0.4, 5.1, 0, new THREE.MeshBasicMaterial({ color: 0x111111 })));
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xfff0b0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  glow.position.copy(bulb.position);
  glow.scale.setScalar(2.6);
  scene.add(glow);
  const pl = new THREE.PointLight(0xffd890, 40, 14, 1.6);
  pl.position.copy(bulb.position);
  scene.add(pl);
}

function armchair(scene: THREE.Scene, x: number, z: number, ry: number): THREE.Group {
  const g = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ color: 0x8a2a1e, roughness: 0.9 });
  g.add(box(1.3, 0.5, 1.1, 0, 0.25, 0, cloth));
  g.add(box(1.3, 1.3, 0.3, 0, 0.9, -0.45, cloth));
  for (const sx of [-1, 1]) g.add(box(0.25, 0.8, 1.1, sx * 0.6, 0.6, 0, cloth));
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  scene.add(g);
  return g;
}

function desertNight(scene: THREE.Scene): void {
  const sand = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x3a2c24, roughness: 1 }));
  sand.rotation.x = -Math.PI / 2;
  scene.add(sand);
  const road = new THREE.Mesh(new THREE.PlaneGeometry(9, 400), new THREE.MeshStandardMaterial({ color: 0x24242a, roughness: 0.9 }));
  road.rotation.x = -Math.PI / 2;
  road.position.y = 0.01;
  scene.add(road);
  for (let i = -20; i < 20; i++) scene.add(box(0.18, 0.02, 2.2, 0, 0.02, i * 6, new THREE.MeshBasicMaterial({ color: 0xffc23a })));
  const moon = new THREE.Mesh(new THREE.CircleGeometry(6, 32), new THREE.MeshBasicMaterial({ color: 0xf4f1e4 }));
  moon.position.set(30, 40, -120);
  scene.add(moon);
  scene.fog = new THREE.Fog(scene.background as THREE.Color, 40, 160);
  for (let i = 0; i < 6; i++) {
    const mesa = box(30 + i * 6, 10 + (i % 3) * 5, 10, -90 + i * 36, 5, -150, new THREE.MeshStandardMaterial({ color: 0x1a1830 }));
    scene.add(mesa);
  }
}

function headlights(scene: THREE.Scene, root: THREE.Object3D, len: number, wid: number): void {
  const glow = glowTexture();
  for (const sx of [-1, 1]) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xfff2d0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.position.set(sx * wid * 0.33, 0.9, len / 2 + 0.2);
    s.scale.setScalar(2.4);
    root.add(s);
    const sp = new THREE.SpotLight(0xfff0d0, 14, 30, 0.45, 0.6, 1.6);
    sp.position.set(sx * wid * 0.33, 0.9, len / 2);
    sp.target.position.set(sx * wid * 0.33, 0, len / 2 + 15);
    root.add(sp, sp.target);
  }
  void scene;
}

type Painter = (r: THREE.WebGLRenderer) => void;

const PAINTERS: Painter[] = [
  // 1. Midnight in the garage: Grandpa's cannon, Mort asleep in his chair
  (r) => {
    const { scene } = stage(0x1a1622, 0xffe0b0, 0.8);
    garageRoom(scene, false);
    const cannon = buildCannon();
    cannon.root.position.set(1.6, 0, -1.2);
    cannon.root.rotation.y = -2.3;
    cannon.root.scale.setScalar(1.6);
    scene.add(cannon.root);
    const chair = armchair(scene, -2.2, 0.6, 0.6);
    const m = figure(false, "asleep");
    m.legL.rotation.x = m.legR.rotation.x = -1.4;
    m.armL.rotation.x = m.armR.rotation.x = -0.4;
    m.root.position.set(0, -0.35, 0.05);
    chair.add(m.root);
    r.render(scene, cam(42, [1.2, 2.6, 7.2], [-0.6, 1.1, -0.6]));
    disposeTree(scene);
  },
  // 2. Then a noise: your pickup rolls out of the door with the cannon in the bed
  (r) => {
    const { scene } = stage(0x0e1430, 0xaab8ff, 0.7);
    desertNight(scene);
    const truck = buildTruck(0x2f6d8c, "ARRR");
    truck.root.position.set(1.2, 0, 3.5);
    truck.root.rotation.y = 1.25;
    truck.tail.color.setRGB(3, 0.2, 0.1);
    scene.add(truck.root);
    // the garage behind it, door wide open and lit
    const shed = new THREE.MeshStandardMaterial({ color: 0x6a5a48, roughness: 0.9 });
    scene.add(box(8, 4.5, 0.3, -2, 2.25, -6, shed));
    scene.add(box(8.4, 0.6, 7, -2, 4.6, -2.6, shed));
    scene.add(box(0.3, 4.5, 7, -6, 2.25, -2.6, shed));
    const inside = new THREE.PointLight(0xffd890, 60, 12, 1.4);
    inside.position.set(-2, 3, -3);
    scene.add(inside);
    const m = figure(false, "furious");
    m.root.position.set(-2.4, 0, -3.4);
    m.armL.rotation.x = -2.6;
    m.armR.rotation.x = -2.4;
    scene.add(m.root);
    r.render(scene, cam(42, [7.5, 4.6, 10.5], [-0.8, 1.0, 0.5]));
    disposeTree(scene);
  },
  // 3. Grandpa's cannon... GONE?! Mort, close, red with rage
  (r) => {
    const { scene } = stage(0x7a1410, 0xffb080, 2.6);
    const back = new THREE.Mesh(new THREE.CircleGeometry(4, 48), new THREE.MeshBasicMaterial({ color: 0xff6a2a }));
    back.position.set(0, 1.6, -2.5);
    scene.add(back);
    for (let i = 0; i < 24; i++) {
      const ray = box(0.12, 9, 0.01, 0, 0, 0, new THREE.MeshBasicMaterial({ color: 0xffc080, transparent: true, opacity: 0.5 }));
      ray.position.set(0, 1.6, -2.4);
      ray.rotation.z = (i / 24) * Math.PI;
      scene.add(ray);
    }
    const m = figure(false, "furious");
    m.armL.rotation.x = -0.9;
    m.armL.rotation.z = 0.9;
    m.armR.rotation.x = -0.9;
    m.armR.rotation.z = -0.9;
    scene.add(m.root);
    r.render(scene, cam(34, [0.35, 1.62, 2.9], [0, 1.6, 0]));
    disposeTree(scene);
  },
  // 4. He calls Linda. Split panel: him in the garage, her answering
  (r) => {
    const halves: [boolean, number][] = [[false, 0x2a2a4a], [true, 0x4a1a5a]];
    r.setScissorTest(true);
    halves.forEach(([linda, bg], i) => {
      const { scene } = stage(bg, linda ? 0xffc0f0 : 0xffe0b0, 2.4);
      const m = figure(linda, linda ? "grin" : "yell");
      phoneIn(m, linda ? 0xff4fb0 : 0xd8261a);
      if (linda) { m.armL.rotation.x = -2.9; m.armL.rotation.z = 0.5; } else { m.armL.rotation.x = -1.2; m.armL.rotation.z = 1.0; }
      scene.add(m.root);
      const w = PANEL_W / 2;
      r.setViewport(i * w, 0, w, PANEL_H);
      r.setScissor(i * w, 0, w, PANEL_H);
      r.render(scene, cam(34, [linda ? -0.6 : 0.6, 1.65, 2.6], [0, 1.45, 0], w / PANEL_H));
      disposeTree(scene);
    });
    r.setScissorTest(false);
    r.setViewport(0, 0, PANEL_W, PANEL_H);
  },
  // 5. She is there before he hangs up: two station wagons, lights blazing, the chase begins
  (r) => {
    const { scene } = stage(0x101428, 0xaab8ff, 0.8);
    desertNight(scene);
    const a = buildFoe(1, false);
    a.root.position.set(-1.9, 0, 0);
    scene.add(a.root);
    headlights(scene, a.root, a.len, a.wid);
    const b = buildFoe(1, true);
    b.root.position.set(2.0, 0, -1.2);
    b.root.rotation.y = -0.18;
    scene.add(b.root);
    headlights(scene, b.root, b.len, b.wid);
    for (const f of [a, b]) {
      f.mort.armL.rotation.z = 2.35;
      f.mort.armL.rotation.x = -0.15;
      f.mort.brows[0].rotation.z = -0.6;
      f.mort.brows[1].rotation.z = 0.6;
    }
    a.mort.mouth.scale.y = 3;
    r.render(scene, cam(40, [0.3, 2.0, 8.6], [0, 1.4, -0.6]));
    disposeTree(scene);
  },
];

// 6 (solo ending). Mort alone in his wagon, lights on, coming for you
PAINTERS.push((r) => {
  const { scene } = stage(0x101428, 0xaab8ff, 0.8);
  desertNight(scene);
  const a = buildFoe(1, false);
  scene.add(a.root);
  headlights(scene, a.root, a.len, a.wid);
  a.mort.armL.rotation.z = 2.35;
  a.mort.armL.rotation.x = -0.15;
  a.mort.brows[0].rotation.z = -0.6;
  a.mort.brows[1].rotation.z = 0.6;
  a.mort.mouth.scale.y = 3;
  r.render(scene, cam(36, [-0.4, 1.9, 7.4], [0.3, 1.3, 0]));
  disposeTree(scene);
});

/** Which panels each version tells: alone, Mort sets off by himself; with two, he calls Linda. */
export const STORY = { solo: [0, 1, 2, 5], duo: [0, 1, 2, 3, 4] };

/** Render the chosen panels to image URLs. One renderer, made and thrown away here. */
export async function renderComic(panels: number[]): Promise<string[]> {
  const canvas = document.createElement("canvas");
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1);
  r.setSize(PANEL_W, PANEL_H, false);
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.15;
  const out: string[] = [];
  try {
    for (const paint of panels.map((i) => PAINTERS[i])) {
      r.setClearColor(0x000000, 1);
      r.clear();
      paint(r);
      out.push(canvas.toDataURL("image/jpeg", 0.86));
      // give the page a breath between panels
      await new Promise((res) => setTimeout(res, 0));
    }
  } finally {
    r.dispose();
    r.forceContextLoss();
  }
  return out;
}
