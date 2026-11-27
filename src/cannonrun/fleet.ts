/**
 * The space fleet: everything that flies past in outer space mode and is not
 * in the chase. None of it touches the simulation; it is scenery that shoots.
 *
 * - Your side: squadrons of four-wing starfighters that come in over your
 *   shoulder and strafe Mort, red bolts first.
 * - Mort's side: ball fighters with two flat wing panels, screaming up the
 *   lane at you in a loose three, green bolts.
 * - Far behind Mort: his flagship, a long arrowhead capital ship, with a
 *   bridge tower at the back.
 * - Up in the sky: the old moon with a rocket stuck in its eye (Méliès,
 *   1902, public domain), because Mort is not the first.
 *
 * All original builds in the spirit of the classics, not copies of anybody's
 * ship. Built facing +z, like every other builder here.
 */
import * as THREE from "three";
import { toWorld, heading, hash } from "./road";

const std = (color: number, roughness = 0.5, metalness = 0.4, emissive = 0x000000): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive });
const glow = (color: number, opacity = 1): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, blending: opacity < 1 ? THREE.AdditiveBlending : THREE.NormalBlending });
const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  return o;
};
const boxG = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

export interface Fighter {
  root: THREE.Group;
  /** the points bolts leave from, in the fighter's own space */
  guns: THREE.Vector3[];
  bolt: THREE.Material;
}

/** A four-wing starfighter: a long needle nose, a canopy, and two pairs of wings spread in an X with an engine at each root and a gun at each tip. */
export function buildStarfighter(stripe = 0xd83a2a): Fighter {
  const root = new THREE.Group();
  const white = std(0xe4e1d8, 0.55, 0.3);
  const grey = std(0x8a8d92, 0.6, 0.4);
  const red = std(stripe, 0.5, 0.2);
  const dark = std(0x1d2024, 0.7, 0.4);
  // fuselage: a box body tapering into a long nose
  root.add(mesh(boxG(0.7, 0.6, 2.2), white, 0, 0, -0.6));
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.36, 2.6, 4), white);
  nose.rotation.set(Math.PI / 2, Math.PI / 4, 0);
  nose.position.set(0, -0.05, 1.8);
  root.add(nose);
  root.add(mesh(boxG(0.72, 0.08, 1.0), red, 0, 0.3, 0.9));
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), std(0x10202c, 0.1, 0.7, 0x0a1e2c));
  canopy.scale.set(0.9, 0.8, 1.6);
  canopy.position.set(0, 0.28, 0.1);
  root.add(canopy);
  root.add(mesh(new THREE.SphereGeometry(0.16, 10, 8), std(0x3a6ad8, 0.4, 0.3), 0, 0.42, -0.9)); // the droid behind the pilot
  // four wings in an X
  const flame = glow(0xff7a4a);
  const halo = glow(0xff5a2a, 0.5);
  const guns: THREE.Vector3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(sx * 0.3, sy * 0.12, -1.1);
    arm.rotation.z = sx * sy * -0.32;
    const wing = mesh(boxG(2.8, 0.07, 1.1), white, sx * 1.5, 0, 0);
    arm.add(wing);
    arm.add(mesh(boxG(1.0, 0.075, 0.3), red, sx * 1.0, 0, 0.25));
    // engine at the root, pointing back
    const eng = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.5, 12), grey);
    eng.rotation.x = Math.PI / 2;
    eng.position.set(sx * 0.45, sy * 0.22, 0.1);
    arm.add(eng);
    const ex = mesh(new THREE.CircleGeometry(0.17, 12), flame, sx * 0.45, sy * 0.22, -0.66);
    ex.rotation.y = Math.PI;
    arm.add(ex);
    const hl = mesh(new THREE.CircleGeometry(0.42, 12), halo, sx * 0.45, sy * 0.22, -0.7);
    hl.rotation.y = Math.PI;
    arm.add(hl);
    // the long gun at the tip
    const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 2.4, 6), dark);
    gun.rotation.x = Math.PI / 2;
    gun.position.set(sx * 2.92, 0, 0.9);
    arm.add(gun);
    root.add(arm);
    arm.updateMatrix();
    guns.push(new THREE.Vector3(sx * 2.92, 0, 2.2).applyMatrix4(arm.matrix));
  }
  return { root, guns, bolt: glow(0xff3a2a) };
}

/** A ball fighter: a round cockpit with a big window, slung between two flat six-sided wing panels. */
export function buildBallFighter(): Fighter {
  const root = new THREE.Group();
  const grey = std(0x6f747a, 0.55, 0.5);
  const dark = std(0x16181c, 0.6, 0.5);
  const ball = mesh(new THREE.SphereGeometry(0.62, 16, 12), grey);
  root.add(ball);
  const win = mesh(new THREE.CircleGeometry(0.4, 8), std(0x0c0e12, 0.2, 0.6, 0x1a2a10), 0, 0, 0.6);
  root.add(win);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const bar = mesh(boxG(0.04, 0.4, 0.03), grey, Math.cos(a) * 0.2, Math.sin(a) * 0.2, 0.62);
    bar.rotation.z = a + Math.PI / 2;
    root.add(bar);
  }
  const panelG = new THREE.CircleGeometry(1.9, 6);
  for (const sx of [-1, 1]) {
    root.add(mesh(new THREE.CylinderGeometry(0.16, 0.22, 1.5, 8).rotateZ(Math.PI / 2), grey, sx * 0.95, 0, 0));
    const panel = mesh(panelG, dark, sx * 1.75, 0, 0);
    panel.rotation.set(0, sx * Math.PI / 2, Math.PI / 2);
    const back = panel.clone();
    back.rotation.y += Math.PI;
    root.add(panel, back);
    // the frame and spokes on the panel
    const frame = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.06, 4, 6), grey);
    frame.position.x = sx * 1.75;
    frame.rotation.set(0, Math.PI / 2, Math.PI / 2);
    root.add(frame);
    for (let k = 0; k < 3; k++) {
      const sp = mesh(boxG(0.06, 3.7, 0.06), grey, sx * 1.75, 0, 0);
      sp.rotation.x = (k / 3) * Math.PI;
      root.add(sp);
    }
  }
  return { root, guns: [new THREE.Vector3(-0.25, -0.35, 0.6), new THREE.Vector3(0.25, -0.35, 0.6)], bolt: glow(0x5aff4a) };
}

/** Mort's flagship: a long arrowhead hull with a stepped deck and a bridge tower at the back. Point toward +z. */
export function buildFlagship(): THREE.Group {
  const root = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.6, metalness: 0.3, emissive: 0x3a4250, fog: false });
  const dark = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.7, metalness: 0.3, emissive: 0x1a1e26, fog: false });
  const tri = new THREE.Shape();
  tri.moveTo(0, 30); tri.lineTo(-14, -14); tri.lineTo(14, -14); tri.closePath();
  const deck = (s: number, h: number, y: number, m: THREE.Material) => {
    const g = new THREE.ExtrudeGeometry(tri, { depth: h, bevelEnabled: false });
    g.rotateX(Math.PI / 2);
    g.scale(s, 1, s);
    const o = new THREE.Mesh(g, m);
    o.position.y = y;
    return o;
  };
  root.add(deck(1, 2.4, 0, hull));
  root.add(deck(1, 1.4, -2.4, dark));
  root.add(deck(0.7, 1.6, 1.6, hull).translateZ(-3));
  root.add(deck(0.45, 1.6, 3.2, hull).translateZ(-6));
  // the bridge tower and its two domes
  root.add(mesh(boxG(5, 3, 3), hull, 0, 4.6, -11));
  root.add(mesh(boxG(9, 0.9, 1.8), hull, 0, 6.4, -11));
  for (const sx of [-1, 1]) root.add(mesh(new THREE.SphereGeometry(0.9, 12, 8), hull, sx * 3.6, 7.4, -11));
  // engines down the back
  const fire = new THREE.MeshBasicMaterial({ color: 0x8ad0ff, toneMapped: false, fog: false });
  for (const x of [-7, 0, 7]) {
    const e = new THREE.Mesh(new THREE.CircleGeometry(x ? 1.5 : 2.2, 16), fire);
    e.position.set(x, -0.6, -14.05);
    e.rotation.y = Math.PI;
    root.add(e);
  }
  // window lights along the edges
  const lit = new THREE.MeshBasicMaterial({ color: 0xffe9b0, toneMapped: false, fog: false });
  for (let k = 0; k < 22; k++) {
    const t = k / 22;
    for (const sx of [-1, 1]) root.add(mesh(boxG(0.25, 0.18, 0.25), lit, sx * (14 * (1 - t) - 0.5) * 0.98, -1.2, -14 + t * 43));
  }
  return root;
}

/** The old moon, face and all, with a rocket stuck in its right eye. */
export function buildMoonFace(): THREE.Group {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(110, 100, 20, 128, 128, 128);
  g.addColorStop(0, "#fbf6e4"); g.addColorStop(1, "#c9c0a4");
  x.fillStyle = g; x.beginPath(); x.arc(128, 128, 126, 0, Math.PI * 2); x.fill();
  x.fillStyle = "rgba(120,110,90,0.35)";
  for (const [cx, cy, r] of [[60, 70, 14], [190, 190, 18], [70, 200, 10], [200, 60, 9]]) { x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill(); }
  x.strokeStyle = "#5a5040"; x.lineWidth = 5; x.lineCap = "round";
  // left eye open, right eye squeezed shut round the rocket
  x.beginPath(); x.arc(92, 104, 13, 0, Math.PI * 2); x.stroke();
  x.fillStyle = "#3a3428"; x.beginPath(); x.arc(94, 106, 5, 0, Math.PI * 2); x.fill();
  x.beginPath(); x.moveTo(146, 96); x.quadraticCurveTo(166, 112, 186, 96); x.stroke();
  x.beginPath(); x.moveTo(126, 120); x.lineTo(120, 150); x.lineTo(132, 152); x.stroke();
  x.beginPath(); x.moveTo(90, 180); x.quadraticCurveTo(128, 166, 166, 186); x.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshBasicMaterial({ map: tex, transparent: true, fog: false })));
  // the shell-shaped rocket, nose in the eye
  const shell = new THREE.MeshBasicMaterial({ color: 0xd8d4c8, fog: false });
  const rocket = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.32, 12), shell);
  body.rotation.z = Math.PI / 2;
  rocket.add(body);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.12, 12), shell);
  tip.rotation.z = -Math.PI / 2;
  tip.position.x = 0.21;
  rocket.add(tip);
  for (const a of [0, 2.1, 4.2]) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.004, 0.08), new THREE.MeshBasicMaterial({ color: 0x9a3a2a, fog: false }));
    fin.position.set(-0.16, Math.sin(a) * 0.08, Math.cos(a) * 0.08);
    fin.rotation.x = a;
    rocket.add(fin);
  }
  rocket.position.set(0.12, 0.2, 0.12);
  rocket.rotation.set(0, 0.6, -0.35);
  rocket.scale.setScalar(1.3);
  root.add(rocket);
  return root;
}

/* ---------------------------------------------------------------- flying it */

interface Pass {
  side: "ally" | "mort";
  t: number;
  dur: number;
  lat: number;
  y: number;
  ships: { f: Fighter; dx: number; dy: number; ds: number; bolts: THREE.Mesh[] }[];
}

export interface Fleet {
  /** advance the clock, once per simulation step */
  advance(dt: number): void;
  /** place everything, every drawn frame, after the camera has moved */
  update(camS: number, time: number, camera: THREE.Camera): void;
  /** start a pass right now (for films and for testing) */
  pass(side: "ally" | "mort", slow?: number): void;
  /** what is flying, for scripts */
  info(): { side: string; t: number; x: number; y: number; z: number }[];
  dispose(): void;
}

const BOLT = new THREE.BoxGeometry(0.09, 0.09, 2.2);

export function createFleet(scene: THREE.Scene): Fleet {
  const group = new THREE.Group();
  scene.add(group);
  const passes: Pass[] = [];
  let allyCd = 9, mortCd = 17, seed = 1;
  const flag = buildFlagship();
  flag.scale.setScalar(4);
  scene.add(flag);
  const moonFace = buildMoonFace();
  moonFace.scale.setScalar(26);
  scene.add(moonFace);
  const v = new THREE.Vector3(), q = new THREE.Vector3(), fwd = new THREE.Vector3(), right = new THREE.Vector3();

  function pass(side: "ally" | "mort", slow = 1) {
    seed++;
    const n = side === "ally" ? 4 : 3;
    const ships: Pass["ships"] = [];
    const slots = side === "ally"
      ? [[0, 0, 0], [-5, 1.2, -4], [5, -0.6, -4.5], [-10, 2, -9]]
      : [[0, 0, 0], [-4.5, 0.8, -5], [4.5, -0.4, -6]];
    for (let i = 0; i < n; i++) {
      const f = side === "ally" ? buildStarfighter(i === 0 ? 0xd83a2a : i % 2 ? 0xe8a020 : 0xd83a2a) : buildBallFighter();
      f.root.scale.setScalar(side === "ally" ? 1.4 : 1.3);
      group.add(f.root);
      const bolts = f.guns.map(() => { const b = new THREE.Mesh(BOLT, f.bolt); b.visible = false; group.add(b); return b; });
      ships.push({ f, dx: slots[i][0], dy: slots[i][1], ds: slots[i][2], bolts });
    }
    passes.push({ side, t: 0, dur: (side === "ally" ? 5 : 4.2) * slow, lat: side === "ally" ? (hash(seed) - 0.5) * 8 : (hash(seed) > 0.5 ? 1 : -1) * (5 + hash(seed + 5) * 3), y: side === "ally" ? 6 + hash(seed + 1) * 2.5 : 3.2 + hash(seed + 2) * 1.2, ships });
  }

  function advance(dt: number) {
    allyCd -= dt; mortCd -= dt;
    if (allyCd <= 0) { pass("ally"); allyCd = 15 + hash(seed * 7) * 12; }
    if (mortCd <= 0) { pass("mort"); mortCd = 19 + hash(seed * 11) * 14; }
    for (let i = passes.length - 1; i >= 0; i--) {
      const p = passes[i];
      p.t += dt;
      if (p.t >= p.dur) {
        for (const s of p.ships) { group.remove(s.f.root); for (const b of s.bolts) group.remove(b); }
        passes.splice(i, 1);
      }
    }
  }

  function update(camS: number, time: number, camera: THREE.Camera) {
    for (let i = 0; i < passes.length; i++) {
      const p = passes[i];
      const u = p.t / p.dur;
      // allies come in over your shoulder and dive down the lane at Mort;
      // Mort's lot come up the lane at you and pull up over your head
      const ally = p.side === "ally";
      const s0 = ally ? camS + 30 - u * 260 : camS - 230 + u * 290;
      const y = ally ? p.y - u * 2 : p.y + Math.max(0, u - 0.86) * 40;
      const bank = Math.sin(time * 1.3 + i) * 0.25;
      for (const s of p.ships) {
        const ss = s0 + (ally ? -s.ds : s.ds);
        toWorld(ss, p.lat + s.dx, y + s.dy, v);
        s.f.root.position.copy(v);
        s.f.root.rotation.set(ally ? 0.08 : -0.05 - Math.max(0, u - 0.86) * 1.6, heading(ss) + (ally ? Math.PI : 0), bank);
        s.f.root.updateMatrixWorld();
        // bolts: each gun fires every 0.5 s, the bolt flying 80 m/s ahead of the ship
        for (let g = 0; g < s.bolts.length; g++) {
          const b = s.bolts[g];
          const age = (p.t + g * 0.13 + s.ds * 0.05) % 0.5;
          b.visible = p.t > 0.4 && u < 0.85;
          q.copy(s.f.guns[g]).add(v.set(0, 0, 1.4 + age * 80));
          b.position.copy(q.applyMatrix4(s.f.root.matrixWorld));
          b.quaternion.copy(s.f.root.quaternion);
        }
      }
    }
    // the flagship hangs far behind Mort and the moon above it, both placed
    // off the camera rather than the lane, which curves away out of shot
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    right.set(-fwd.z, 0, fwd.x);
    const yaw = Math.atan2(fwd.x, fwd.z);
    flag.position.copy(camera.position).addScaledVector(fwd, 460).addScaledVector(right, -170 + Math.sin(time * 0.05) * 25);
    flag.position.y += 55;
    flag.rotation.set(0.05, yaw + Math.PI + 0.5, 0.04);
    moonFace.position.copy(camera.position).addScaledVector(fwd, 820).addScaledVector(right, 240);
    moonFace.position.y += 190;
    moonFace.lookAt(camera.position);
  }

  function dispose() {
    scene.remove(group, flag, moonFace);
  }
  const info = () => passes.map((p) => ({ side: p.side, t: +p.t.toFixed(2), x: +p.ships[0].f.root.position.x.toFixed(1), y: +p.ships[0].f.root.position.y.toFixed(1), z: +p.ships[0].f.root.position.z.toFixed(1) }));
  return { advance, update, pass, info, dispose };
}
