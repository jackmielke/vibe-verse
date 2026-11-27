/**
 * VIBE HOOPS — the Vibe Dome itself.
 *
 * Everything that is not a player or the ball: the hardwood, the two
 * baskets, twenty-odd rows of crowd in a bowl, the suites, the ribbon boards,
 * the scorer's table, the jumbotron hanging over centre court, the lights and
 * the beams that sweep the place when somebody throws one down.
 *
 * Three.js space: x along the court (as the rules), y up, z across (the
 * rules' y). The TV side is +z.
 *
 * Cheap on purpose where it can be. The crowd is two instanced meshes (bodies
 * and heads, about four thousand people) that bounce in the vertex shader off
 * one `hype` uniform, so a dunk costs a uniform write rather than four
 * thousand matrix updates. The ribbon boards and the jumbotron are canvases
 * redrawn a few times a second, not every frame.
 */
import * as THREE from "three";
import {
  BOARD_BOT, BOARD_HW, BOARD_TOP, BOARD_X, CORNER_Y, COURT_L, COURT_W, HALF_L, HALF_W, HOOP_X, KEY_L, KEY_W, RIM_H, RIM_R, THREE_R,
} from "./game";
import type { Club } from "./teams";

export interface Arena {
  group: THREE.Group;
  /** Called once a frame. `hype` 0..1 makes the crowd bounce and the beams sweep. */
  update(dt: number, t: number, hype: number): void;
  /** Redraws the jumbotron and the shot clocks. */
  scoreboard(s: Board): void;
  /** Flashes the LEDs round a backboard and swishes its net (+1 or -1). */
  swish(side: number, big: boolean): void;
  /** Fire the pyro cannons. */
  pyro(): void;
  confetti(on: boolean): void;
  /** The jumbotron's live screen, for a camera to render into. */
  feed: THREE.WebGLRenderTarget;
  /** Where the jumbotron hangs, for the cameras that look at it. */
  jumbo: THREE.Object3D;
  dispose(): void;
}

export interface Board {
  clubs: [Club, Club];
  score: [number, number];
  clock: string;
  shot: number;
  /** Big text for the screen ("DUNK!"), or "". */
  shout: string;
  sub: string;
  replay: boolean;
  /** Seconds since the shout began, for the animation. */
  shoutT: number;
}

const canvas = (w: number, h: number) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

const tex = (c: HTMLCanvasElement) => {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
};

// ---------------------------------------------------------------- the floor

function courtTexture(clubs: [Club, Club]): HTMLCanvasElement {
  const PX = 64; // pixels a metre
  const W = Math.round(COURT_L * PX);
  const H = Math.round(COURT_W * PX);
  const c = canvas(W, H);
  const g = c.getContext("2d")!;
  // Maple planks running the length of the floor.
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const plank = 0.06 * PX;
  for (let y = 0; y < H; y += plank) {
    let x = -r() * 3 * PX;
    while (x < W) {
      const len = (1.2 + r() * 2.4) * PX;
      const l = 58 + r() * 10;
      g.fillStyle = `hsl(${30 + r() * 6}, ${52 + r() * 10}%, ${l}%)`;
      g.fillRect(x, y, len, plank);
      g.fillStyle = "rgba(90,50,20,0.10)";
      for (let k = 0; k < 3; k++) g.fillRect(x + r() * len, y + r() * plank, len * 0.3 * r(), 1);
      g.fillStyle = "rgba(60,30,10,0.35)";
      g.fillRect(x, y, 1.5, plank);
      x += len;
    }
    g.fillStyle = "rgba(60,30,10,0.25)";
    g.fillRect(0, y, W, 1);
  }
  const X = (m: number) => (m + HALF_L) * PX;
  const Y = (m: number) => (m + HALF_W) * PX;
  // Painted keys, in each club's colour at the end they defend.
  for (const side of [-1, 1]) {
    const club = clubs[side < 0 ? 0 : 1];
    const bx = side < 0 ? 0 : W - KEY_L * PX;
    g.fillStyle = club.color;
    g.globalAlpha = 0.82;
    g.fillRect(bx, Y(-KEY_W / 2), KEY_L * PX, KEY_W * PX);
    g.globalAlpha = 0.25;
    // The three-point area, tinted.
    g.beginPath();
    const hx = X(side * HOOP_X);
    g.arc(hx, Y(0), THREE_R * PX, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
  }
  // The centre circle and the Dome's mark.
  const grad = g.createRadialGradient(X(0), Y(0), 10, X(0), Y(0), 1.8 * PX);
  grad.addColorStop(0, "#2a1650");
  grad.addColorStop(1, "#140a2a");
  g.fillStyle = grad;
  g.beginPath();
  g.arc(X(0), Y(0), 1.8 * PX, 0, Math.PI * 2);
  g.fill();
  g.save();
  g.translate(X(0), Y(0));
  g.rotate(Math.PI / 2);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#facc15";
  g.font = `900 ${0.62 * PX}px system-ui, sans-serif`;
  g.fillText("VIBE", 0, -0.32 * PX);
  g.fillStyle = "#ffffff";
  g.fillText("DOME", 0, 0.36 * PX);
  g.restore();
  // Sidelines: the club names.
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (const side of [-1, 1]) {
    const club = clubs[side < 0 ? 0 : 1];
    g.save();
    g.translate(X(side * (HALF_L - 1.1)), Y(0));
    g.rotate(side < 0 ? -Math.PI / 2 : Math.PI / 2);
    g.fillStyle = "rgba(255,255,255,0.9)";
    g.font = `900 ${0.55 * PX}px system-ui, sans-serif`;
    g.fillText(club.short, 0, 0);
    g.restore();
  }
  // Lines.
  g.strokeStyle = "rgba(255,255,255,0.95)";
  g.lineWidth = 0.05 * PX;
  g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, W - g.lineWidth, H - g.lineWidth);
  g.beginPath();
  g.moveTo(X(0), 0);
  g.lineTo(X(0), H);
  g.stroke();
  for (const rr of [1.8, 0.6]) {
    g.beginPath();
    g.arc(X(0), Y(0), rr * PX, 0, Math.PI * 2);
    g.stroke();
  }
  for (const side of [-1, 1]) {
    const hx = X(side * HOOP_X);
    const base = side < 0 ? 0 : W;
    // Three-point line: straight in the corners, then the arc.
    const cornerEnd = X(side * (HALF_L - 3));
    g.beginPath();
    g.moveTo(base, Y(-CORNER_Y));
    g.lineTo(cornerEnd, Y(-CORNER_Y));
    g.moveTo(base, Y(CORNER_Y));
    g.lineTo(cornerEnd, Y(CORNER_Y));
    g.stroke();
    const a = Math.asin(CORNER_Y / THREE_R);
    g.beginPath();
    if (side < 0) g.arc(hx, Y(0), THREE_R * PX, -a, a, false);
    else g.arc(hx, Y(0), THREE_R * PX, Math.PI - a, Math.PI + a, false);
    g.stroke();
    // The key and the free-throw circle.
    const kx = side < 0 ? 0 : W - KEY_L * PX;
    g.strokeRect(kx, Y(-KEY_W / 2), KEY_L * PX, KEY_W * PX);
    g.beginPath();
    g.arc(X(side * (HALF_L - KEY_L)), Y(0), 1.8 * PX, 0, Math.PI * 2);
    g.stroke();
    // Restricted arc.
    g.beginPath();
    if (side < 0) g.arc(hx, Y(0), 1.25 * PX, -Math.PI / 2, Math.PI / 2);
    else g.arc(hx, Y(0), 1.25 * PX, Math.PI / 2, (Math.PI * 3) / 2);
    g.stroke();
  }
  return c;
}

// ---------------------------------------------------------------- the crowd

const SHIRTS = [0xffffff, 0x1e293b, 0xef4444, 0xfacc15, 0x22d3ee, 0x8b5cf6, 0xf97316, 0x10b981, 0xec4899, 0x3b82f6, 0x111827, 0xe5e7eb];
const SKIN = [0xf1c7a0, 0xd9a07a, 0xa86b43, 0x7a4a2a, 0x5a3520, 0xf7d9bd];

function crowdMaterial(color: number, uniforms: { uTime: { value: number }; uHype: { value: number } }) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uHype = uniforms.uHype;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aSeed;\nuniform float uTime;\nuniform float uHype;")
      .replace(
        "#include <begin_vertex>",
        [
          "#include <begin_vertex>",
          "float bob = max(0.0, sin(uTime * (5.0 + aSeed * 5.0) + aSeed * 61.0));",
          "float on = step(0.55 - uHype * 0.5, fract(aSeed * 13.7));",
          "transformed.y += bob * (0.04 + uHype * 0.42 * on) / 0.55;",
          "transformed.x += sin(uTime * 1.3 + aSeed * 20.0) * 0.03;",
        ].join("\n"),
      );
  };
  return m;
}

/** Rows of seats round a rounded rectangle, and somebody in most of them. */
function buildBowl(group: THREE.Group, uniforms: { uTime: { value: number }; uHype: { value: number } }, clubs: [Club, Club]) {
  type Seat = { x: number; y: number; z: number; face: number };
  const seats: Seat[] = [];
  const tiers = [
    { first: 0, rows: 14, gap: 3.4, rise: 0.42, run: 0.82, y0: 0.5 },
    { first: 14, rows: 11, gap: 16.5, rise: 0.62, run: 0.86, y0: 9.4 },
  ];
  for (const tier of tiers) {
    for (let row = 0; row < tier.rows; row++) {
      const off = tier.gap + row * tier.run;
      const y = tier.y0 + row * tier.rise;
      const hl = HALF_L + off * 0.55;
      const hw = HALF_W + off;
      const rad = off * 0.9;
      // Walk the rounded rectangle.
      const straightL = Math.max(0, (hl - rad) * 2);
      const straightW = Math.max(0, (hw - rad) * 2);
      const per = 2 * straightL + 2 * straightW + 2 * Math.PI * rad;
      const n = Math.floor(per / 0.62);
      for (let k = 0; k < n; k++) {
        let s = (k / n) * per;
        let x = 0;
        let z = 0;
        let nx = 0;
        let nz = 0;
        const seg = [straightL, Math.PI * rad * 0.5, straightW, Math.PI * rad * 0.5, straightL, Math.PI * rad * 0.5, straightW, Math.PI * rad * 0.5];
        let idx = 0;
        while (idx < seg.length && s > seg[idx]) {
          s -= seg[idx];
          idx++;
        }
        const cx = hl - rad;
        const cz = hw - rad;
        switch (idx) {
          case 0: x = -cx + s; z = hw; nz = 1; break;
          case 1: { const a = s / rad; x = cx + Math.sin(a) * rad; z = cz + Math.cos(a) * rad; nx = Math.sin(a); nz = Math.cos(a); break; }
          case 2: x = hl; z = cz - s; nx = 1; break;
          case 3: { const a = s / rad; x = cx + Math.cos(a) * rad; z = -cz - Math.sin(a) * rad; nx = Math.cos(a); nz = -Math.sin(a); break; }
          case 4: x = cx - s; z = -hw; nz = -1; break;
          case 5: { const a = s / rad; x = -cx - Math.sin(a) * rad; z = -cz - Math.cos(a) * rad; nx = -Math.sin(a); nz = -Math.cos(a); break; }
          case 6: x = -hl; z = -cz + s; nx = -1; break;
          default: { const a = s / rad; x = -cx - Math.cos(a) * rad; z = cz + Math.sin(a) * rad; nx = -Math.cos(a); nz = Math.sin(a); break; }
        }
        // Leave the tunnels and the camera well open.
        if (tier.first === 0 && Math.abs(z) < 2 && Math.abs(x) > HALF_L) continue;
        seats.push({ x, y, z, face: Math.atan2(-nx, -nz) });
      }
    }
  }

  // The concrete steps under them, one slab per row per tier.
  const stepMat = new THREE.MeshStandardMaterial({ color: 0x15121f, roughness: 0.95 });
  for (const tier of tiers) {
    for (let row = 0; row < tier.rows; row++) {
      const off = tier.gap + row * tier.run;
      const y = tier.y0 + row * tier.rise;
      const shape = roundedRect(HALF_L + off * 0.55 + tier.run * 0.6, HALF_W + off + tier.run * 0.5, off * 0.9 + 0.4);
      const hole = roundedRect(HALF_L + off * 0.55 - 0.4, HALF_W + off - 0.4, Math.max(0.2, off * 0.9 - 0.4));
      shape.holes.push(hole);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: y + 0.05, bevelEnabled: false, curveSegments: 10 });
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, stepMat);
      mesh.position.y = tier.y0 - (tier === tiers[1] ? 2.2 : 0.4);
      mesh.scale.y = (y + 0.45 - mesh.position.y) / (y + 0.05);
      group.add(mesh);
    }
  }

  const seatGeo = new THREE.BoxGeometry(0.5, 0.42, 0.5);
  seatGeo.translate(0, 0.21, 0);
  const seatsMesh = new THREE.InstancedMesh(seatGeo, new THREE.MeshStandardMaterial({ color: 0x3b1d6e, roughness: 0.7 }), seats.length);
  const bodyGeo = new THREE.BoxGeometry(0.44, 0.62, 0.3);
  bodyGeo.translate(0, 0.72, 0.05);
  const headGeo = new THREE.SphereGeometry(0.13, 8, 6);
  headGeo.translate(0, 1.18, 0.05);
  const fill = seats.filter((_, k) => (k * 2654435761) % 100 < 93);
  const seedAttr = new Float32Array(fill.length);
  const bodies = new THREE.InstancedMesh(bodyGeo, crowdMaterial(0xffffff, uniforms), fill.length);
  const heads = new THREE.InstancedMesh(headGeo, crowdMaterial(0xffffff, uniforms), fill.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  seats.forEach((s, k) => {
    q.setFromAxisAngle(up, s.face);
    m.compose(new THREE.Vector3(s.x, s.y, s.z), q, new THREE.Vector3(1, 1, 1));
    seatsMesh.setMatrixAt(k, m);
  });
  let rs = 11;
  const r = () => ((rs = (rs * 16807) % 2147483647) / 2147483647);
  const home = new THREE.Color(clubs[0].color).getHex();
  const away = new THREE.Color(clubs[1].color).getHex();
  fill.forEach((s, k) => {
    q.setFromAxisAngle(up, s.face + (r() - 0.5) * 0.4);
    const sc = 0.9 + r() * 0.2;
    m.compose(new THREE.Vector3(s.x + (r() - 0.5) * 0.08, s.y, s.z), q, new THREE.Vector3(sc, sc, sc));
    bodies.setMatrixAt(k, m);
    heads.setMatrixAt(k, m);
    // Fans in club colours on their club's half, everybody else in whatever.
    const pick = r();
    const shirt = pick < 0.3 ? (s.x < 0 ? home : away) : SHIRTS[Math.floor(r() * SHIRTS.length)];
    bodies.setColorAt(k, col.setHex(shirt));
    heads.setColorAt(k, col.setHex(SKIN[Math.floor(r() * SKIN.length)]));
    seedAttr[k] = r();
  });
  bodies.geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seedAttr, 1));
  heads.geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seedAttr, 1));
  for (const im of [seatsMesh, bodies, heads]) {
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.frustumCulled = false;
    group.add(im);
  }

  // Phone flashes: a point per few seats that winks when the place goes up.
  const flashPos = new Float32Array(fill.length * 3);
  const flashSeed = new Float32Array(fill.length);
  fill.forEach((s, k) => {
    flashPos[k * 3] = s.x;
    flashPos[k * 3 + 1] = s.y + 1.2;
    flashPos[k * 3 + 2] = s.z;
    flashSeed[k] = seedAttr[k];
  });
  const fg = new THREE.BufferGeometry();
  fg.setAttribute("position", new THREE.BufferAttribute(flashPos, 3));
  fg.setAttribute("aSeed", new THREE.BufferAttribute(flashSeed, 1));
  const flashMat = new THREE.ShaderMaterial({
    uniforms: { uTime: uniforms.uTime, uHype: uniforms.uHype },
    vertexShader: [
      "attribute float aSeed; uniform float uTime; uniform float uHype; varying float vOn;",
      "void main(){",
      "  float slot = floor(uTime * 9.0 + aSeed * 97.0);",
      "  float h = fract(sin(slot * 12.9898 + aSeed * 78.233) * 43758.5453);",
      "  vOn = step(1.0 - (0.004 + uHype * 0.05), h);",
      "  vec4 mv = modelViewMatrix * vec4(position, 1.0);",
      "  gl_PointSize = vOn * 260.0 / -mv.z;",
      "  gl_Position = projectionMatrix * mv;",
      "}",
    ].join("\n"),
    fragmentShader: [
      "varying float vOn;",
      "void main(){ vec2 c = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(c)); if (vOn < 0.5 || a < 0.01) discard; gl_FragColor = vec4(vec3(1.6), a); }",
    ].join("\n"),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const flashes = new THREE.Points(fg, flashMat);
  flashes.frustumCulled = false;
  group.add(flashes);
  return [seatsMesh, bodies, heads, flashes];
}

function roundedRect(hl: number, hw: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  r = Math.min(r, hl, hw);
  s.moveTo(-hl + r, -hw);
  s.lineTo(hl - r, -hw);
  s.quadraticCurveTo(hl, -hw, hl, -hw + r);
  s.lineTo(hl, hw - r);
  s.quadraticCurveTo(hl, hw, hl - r, hw);
  s.lineTo(-hl + r, hw);
  s.quadraticCurveTo(-hl, hw, -hl, hw - r);
  s.lineTo(-hl, -hw + r);
  s.quadraticCurveTo(-hl, -hw, -hl + r, -hw);
  return s;
}

// ---------------------------------------------------------------- ribbons

const ADS = ["VIBE VERSE", "VIBEY COINS ACCEPTED", "MORT'S JUNKYARD · WE BUY CANNONS", "8-BALL CLUB", "CANNON CHASE TONIGHT", "FOG CITY TAXI", "VIBE CUP", "MAKE SOME NOISE", "DEFENSE!"];

function ribbon(w: number, h: number) {
  const c = canvas(w, h);
  const t = tex(c);
  t.wrapS = THREE.RepeatWrapping;
  return { c, t, g: c.getContext("2d")! };
}

// ---------------------------------------------------------------- build

export function buildArena(clubs: [Club, Club], quality: "high" | "low"): Arena {
  const group = new THREE.Group();
  const uniforms = { uTime: { value: 0 }, uHype: { value: 0 } };
  const disposables: Array<{ dispose(): void }> = [];

  // Apron and floor.
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(80, 60), new THREE.MeshStandardMaterial({ color: 0x0c0a14, roughness: 0.5, metalness: 0.1 }));
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.01;
  apron.receiveShadow = true;
  group.add(apron);
  const border = new THREE.Mesh(new THREE.PlaneGeometry(COURT_L + 3.2, COURT_W + 3.2), new THREE.MeshStandardMaterial({ color: 0x1b0f33, roughness: 0.35 }));
  border.rotation.x = -Math.PI / 2;
  border.position.y = -0.005;
  border.receiveShadow = true;
  group.add(border);
  const courtTex = tex(courtTexture(clubs));
  const floorMat = new THREE.MeshStandardMaterial({ map: courtTex, roughness: 0.22, metalness: 0.0 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(COURT_L, COURT_W), floorMat);
  floor.name = "court";
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);
  disposables.push(courtTex, floorMat);

  // Baskets.
  const nets: THREE.LineSegments[] = [];
  const boardLeds: THREE.MeshBasicMaterial[] = [];
  const shotClocks: { c: HTMLCanvasElement; t: THREE.CanvasTexture }[] = [];
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.05, transparent: true, opacity: 0.18, metalness: 0, depthWrite: false });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const orange = new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.4, metalness: 0.6, emissive: 0x401000 });
  for (const side of [-1, 1]) {
    const club = clubs[side < 0 ? 0 : 1];
    const pad = new THREE.MeshStandardMaterial({ color: club.color, roughness: 0.6 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.4, metalness: 0.7 });
    // The stanchion: a padded base off the baseline, an arm up and over.
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.1, 2.2), pad);
    base.position.set(side * (HALF_L + 1.6), 0.55, 0);
    base.castShadow = true;
    group.add(base);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 3.4), steel);
    arm.rotation.z = side * 0.62;
    arm.rotation.y = Math.PI / 2;
    arm.position.set(side * (HALF_L + 0.6), 2.4, 0);
    group.add(arm);
    const arm2 = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.16, 0.16), steel);
    arm2.position.set(side * (BOARD_X + 0.6), (BOARD_BOT + BOARD_TOP) / 2, 0);
    group.add(arm2);
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.32, 2.2, 0.32), pad);
    pole.position.set(side * (HALF_L + 1.2), 1.6, 0);
    group.add(pole);
    // The glass and its frame.
    const bw = BOARD_HW * 2;
    const bh = BOARD_TOP - BOARD_BOT;
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.04, bh, bw), glass);
    board.position.set(side * (BOARD_X + 0.02), BOARD_BOT + bh / 2, 0);
    group.add(board);
    const led = new THREE.MeshBasicMaterial({ color: 0xffffff });
    boardLeds.push(led);
    const edge = (w: number, h: number, y: number, z: number) => {
      const e = new THREE.Mesh(new THREE.BoxGeometry(0.05, h, w), led);
      e.position.set(side * (BOARD_X + 0.02), y, z);
      group.add(e);
    };
    edge(bw, 0.05, BOARD_TOP, 0);
    edge(bw, 0.05, BOARD_BOT, 0);
    edge(0.05, bh, BOARD_BOT + bh / 2, BOARD_HW);
    edge(0.05, bh, BOARD_BOT + bh / 2, -BOARD_HW);
    // The inner square.
    const sq = (w: number, h: number, y: number, z: number) => {
      const e = new THREE.Mesh(new THREE.BoxGeometry(0.045, h, w), white);
      e.position.set(side * (BOARD_X + 0.0), y, z);
      group.add(e);
    };
    sq(0.59, 0.04, RIM_H + 0.15, 0);
    sq(0.59, 0.04, RIM_H + 0.6, 0);
    sq(0.04, 0.45, RIM_H + 0.375, 0.295);
    sq(0.04, 0.45, RIM_H + 0.375, -0.295);
    // The rim, and the bracket to the glass.
    const rim = new THREE.Mesh(new THREE.TorusGeometry(RIM_R, 0.012, 8, 32), orange);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(side * HOOP_X, RIM_H, 0);
    group.add(rim);
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(BOARD_X - HOOP_X - RIM_R, 0.03, 0.12), orange);
    bracket.position.set(side * (HOOP_X + RIM_R + (BOARD_X - HOOP_X - RIM_R) / 2), RIM_H, 0);
    group.add(bracket);
    // The net: a tapered mesh of lines.
    const pts: number[] = [];
    const N = 14;
    const ring = (k: number) => {
      const t = k / 4;
      return { r: RIM_R * (1 - t * 0.42), y: -t * 0.42 };
    };
    for (let k = 0; k < 4; k++) {
      const a0 = ring(k);
      const a1 = ring(k + 1);
      for (let i = 0; i < N; i++) {
        const t0 = ((i + (k % 2) * 0.5) / N) * Math.PI * 2;
        const t1 = ((i + 0.5 + (k % 2) * 0.5) / N) * Math.PI * 2;
        const t2 = ((i - 0.5 + (k % 2) * 0.5) / N) * Math.PI * 2;
        pts.push(Math.cos(t0) * a0.r, a0.y, Math.sin(t0) * a0.r, Math.cos(t1) * a1.r, a1.y, Math.sin(t1) * a1.r);
        pts.push(Math.cos(t0) * a0.r, a0.y, Math.sin(t0) * a0.r, Math.cos(t2) * a1.r, a1.y, Math.sin(t2) * a1.r);
      }
    }
    const ng = new THREE.BufferGeometry();
    ng.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const net = new THREE.LineSegments(ng, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
    net.position.set(side * HOOP_X, RIM_H, 0);
    net.userData.kick = 0;
    nets.push(net);
    group.add(net);
    // The shot clock on top of the glass.
    const sc = canvas(128, 64);
    const st = tex(sc);
    shotClocks.push({ c: sc, t: st });
    const scBox = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.42, 0.9), [
      new THREE.MeshBasicMaterial({ map: st }),
      new THREE.MeshBasicMaterial({ map: st }),
      new THREE.MeshStandardMaterial({ color: 0x111 }),
      new THREE.MeshStandardMaterial({ color: 0x111 }),
      new THREE.MeshStandardMaterial({ color: 0x111 }),
      new THREE.MeshStandardMaterial({ color: 0x111 }),
    ]);
    scBox.position.set(side * (BOARD_X + 0.1), BOARD_TOP + 0.3, 0);
    group.add(scBox);
  }

  // Courtside: ad boards along the far side and both ends, the scorer's table, benches.
  const adRib = ribbon(2048, 64);
  const adMat = new THREE.MeshBasicMaterial({ map: adRib.t });
  const ad = (len: number, x: number, z: number, ry: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.75), adMat);
    m.position.set(x, 0.42, z);
    m.rotation.y = ry;
    group.add(m);
  };
  ad(COURT_L + 2, 0, -HALF_W - 2.6, 0);
  ad(COURT_W + 2, -HALF_L - 3.1, 0, Math.PI / 2);
  ad(COURT_W + 2, HALF_L + 3.1, 0, -Math.PI / 2);
  const table = new THREE.Mesh(new THREE.BoxGeometry(8, 0.85, 0.9), new THREE.MeshStandardMaterial({ color: 0x0b0b12, roughness: 0.5 }));
  table.position.set(0, 0.42, -HALF_W - 1.7);
  group.add(table);
  const tableFace = new THREE.Mesh(new THREE.PlaneGeometry(8, 0.7), adMat);
  tableFace.position.set(0, 0.45, -HALF_W - 1.24);
  group.add(tableFace);
  for (const side of [-1, 1]) {
    const club = clubs[side < 0 ? 0 : 1];
    const chairMat = new THREE.MeshStandardMaterial({ color: club.color, roughness: 0.6 });
    for (let k = 0; k < 7; k++) {
      const ch = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.9, 0.55), chairMat);
      ch.position.set(side * (5.5 + k * 0.75), 0.45, -HALF_W - 1.8);
      group.add(ch);
    }
  }

  // The bowl.
  const crowd = buildBowl(group, uniforms, clubs);

  // Suites between the tiers: a band of lit glass.
  const suiteTex = ribbon(1024, 64);
  {
    const g = suiteTex.g;
    g.fillStyle = "#0b0716";
    g.fillRect(0, 0, 1024, 64);
    for (let x = 0; x < 1024; x += 32) {
      g.fillStyle = `hsl(${40 + (x % 96)}, 80%, ${50 + ((x * 7) % 20)}%)`;
      g.fillRect(x + 3, 10, 26, 44);
    }
    suiteTex.t.repeat.set(10, 1);
    suiteTex.t.needsUpdate = true;
  }
  const suiteShape = roundedRect(HALF_L + 15.2 * 0.55 + 0.5, HALF_W + 15.2 + 0.5, 15.2 * 0.9);
  const suitePts = suiteShape.getSpacedPoints(160);
  const suiteGeo = new THREE.BufferGeometry();
  {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    let acc = 0;
    suitePts.forEach((p, k) => {
      if (k > 0) acc += p.distanceTo(suitePts[k - 1]);
      pos.push(p.x, 6.4, -p.y, p.x, 8.4, -p.y);
      uv.push(acc / 12, 0, acc / 12, 1);
      if (k > 0) {
        const a = (k - 1) * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    });
    suiteGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    suiteGeo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    suiteGeo.setIndex(idx);
  }
  suiteTex.t.repeat.set(1, 1);
  const suites = new THREE.Mesh(suiteGeo, new THREE.MeshBasicMaterial({ map: suiteTex.t, side: THREE.DoubleSide, color: 0xbbbbbb }));
  group.add(suites);
  // And the ribbon board right under them, which scrolls.
  const ribTex = ribbon(2048, 64);
  const ribGeo = suiteGeo.clone();
  {
    const p = ribGeo.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) p.setY(i, i % 2 === 0 ? 5.4 : 6.3);
    p.needsUpdate = true;
    const uv = ribGeo.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 0.25);
  }
  const ribbonMesh = new THREE.Mesh(ribGeo, new THREE.MeshBasicMaterial({ map: ribTex.t, side: THREE.DoubleSide }));
  group.add(ribbonMesh);

  // The roof: dark trusses, and banners hanging from them.
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(48, 48, 0.5, 48, 1, true), new THREE.MeshStandardMaterial({ color: 0x07060c, side: THREE.BackSide, roughness: 1 }));
  roof.position.y = 21;
  group.add(roof);
  const ceiling = new THREE.Mesh(new THREE.CircleGeometry(50, 40), new THREE.MeshStandardMaterial({ color: 0x06050a, roughness: 1, side: THREE.DoubleSide }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = 24;
  group.add(ceiling);
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(44, 44, 26, 48, 1, true), new THREE.MeshStandardMaterial({ color: 0x0a0812, side: THREE.BackSide, roughness: 1 }));
  wall.position.y = 11;
  group.add(wall);
  const trussMat = new THREE.MeshStandardMaterial({ color: 0x1a1a24, roughness: 0.6, metalness: 0.6 });
  for (let k = -3; k <= 3; k++) {
    const tr = new THREE.Mesh(new THREE.BoxGeometry(60, 0.5, 0.5), trussMat);
    tr.position.set(0, 21, k * 6);
    group.add(tr);
  }
  const bannerNames = ["VIBE VERSE CHAMPIONS", "JUNKYARD DOGS '25", "VOLTS '24", "RONIN '23", "PIRATES '22", "WIZARDS '21"];
  bannerNames.forEach((name, k) => {
    const c = canvas(128, 320);
    const g = c.getContext("2d")!;
    const club = [clubs[0], clubs[1]][k % 2];
    g.fillStyle = k === 0 ? "#facc15" : club.color;
    g.fillRect(0, 0, 128, 320);
    g.fillStyle = k === 0 ? "#1f1300" : club.ink;
    g.textAlign = "center";
    g.font = "900 22px system-ui";
    name.split(" ").forEach((w, i) => g.fillText(w, 64, 60 + i * 34));
    g.font = "900 54px system-ui";
    g.fillText("★", 64, 270);
    const t = tex(c);
    const ban = new THREE.Mesh(new THREE.PlaneGeometry(2, 5), new THREE.MeshStandardMaterial({ map: t, roughness: 0.9, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.25, side: THREE.DoubleSide }));
    ban.position.set(-12 + k * 4.8, 17.5, -HALF_W - 14);
    group.add(ban);
  });

  // The jumbotron: four screens round a box, LED rings above and below.
  const jumbo = new THREE.Group();
  jumbo.position.set(0, 14.5, 0);
  group.add(jumbo);
  const feed = new THREE.WebGLRenderTarget(quality === "high" ? 512 : 256, quality === "high" ? 288 : 144, { colorSpace: THREE.SRGBColorSpace });
  disposables.push(feed);
  const over = canvas(512, 288);
  const overTex = tex(over);
  const frame = new THREE.MeshStandardMaterial({ color: 0x101018, roughness: 0.4, metalness: 0.6 });
  const JW = 7.2;
  const JD = 4.6;
  const JH = 3.8;
  const shell = new THREE.Mesh(new THREE.BoxGeometry(JW + 0.3, JH + 0.3, JD + 0.3), frame);
  jumbo.add(shell);
  const feedMat = new THREE.MeshBasicMaterial({ map: feed.texture, toneMapped: false });
  const overMat = new THREE.MeshBasicMaterial({ map: overTex, transparent: true, toneMapped: false });
  const faces: Array<[number, number, number, number]> = [
    [0, JD / 2 + 0.16, 0, JW],
    [0, -JD / 2 - 0.16, Math.PI, JW],
    [JW / 2 + 0.16, 0, Math.PI / 2, JD],
    [-JW / 2 - 0.16, 0, -Math.PI / 2, JD],
  ];
  for (const [x, z, ry, w] of faces) {
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(w, JH), feedMat);
    scr.position.set(x, 0, z);
    scr.rotation.y = ry;
    jumbo.add(scr);
    const ov = new THREE.Mesh(new THREE.PlaneGeometry(w, JH), overMat);
    ov.position.set(x * 1.002, 0, z * 1.002);
    ov.rotation.y = ry;
    jumbo.add(ov);
  }
  const ledRib = ribbon(1024, 64);
  const ledMat = new THREE.MeshBasicMaterial({ map: ledRib.t, toneMapped: false });
  for (const y of [JH / 2 + 0.55, -JH / 2 - 0.55]) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.6, 0.7, 40, 1, true), ledMat);
    ring.position.y = y;
    jumbo.add(ring);
  }
  const cables = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 8, 4), trussMat);
  cables.position.y = JH / 2 + 4.6;
  jumbo.add(cables);

  // Lights. A dim house, a key light with shadows over the floor, four warm
  // spots from the catwalk for the shine, and four coloured show beams.
  const hemi = new THREE.HemisphereLight(0x3b3560, 0x100810, 0.55);
  group.add(hemi);
  const key = new THREE.DirectionalLight(0xfff3e0, 1.5);
  key.position.set(4, 22, 8);
  key.target.position.set(0, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(quality === "high" ? 2048 : 1024, quality === "high" ? 2048 : 1024);
  const sc = key.shadow.camera as THREE.OrthographicCamera;
  sc.left = -HALF_L - 2;
  sc.right = HALF_L + 2;
  sc.top = HALF_W + 3;
  sc.bottom = -HALF_W - 3;
  sc.near = 5;
  sc.far = 40;
  key.shadow.bias = -0.0006;
  group.add(key, key.target);
  for (const [x, z] of [[-9, 6], [9, 6], [-9, -6], [9, -6]]) {
    const s = new THREE.SpotLight(0xfff1d6, 140, 40, 0.5, 0.6, 1.6);
    s.position.set(x * 1.3, 18, z * 1.6);
    s.target.position.set(x * 0.6, 0, z * 0.5);
    group.add(s, s.target);
  }
  const beamMat = (c: number) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const beams: Array<{ pivot: THREE.Group; light: THREE.SpotLight; phase: number; mat: THREE.MeshBasicMaterial }> = [];
  const beamColors = [0x8b5cf6, 0x22d3ee, 0xf43f5e, 0xfacc15];
  beamColors.forEach((c, k) => {
    const pivot = new THREE.Group();
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    pivot.position.set(Math.cos(a) * 18, 19, Math.sin(a) * 14);
    const coneGeo = new THREE.ConeGeometry(3.2, 24, 24, 1, true);
    coneGeo.translate(0, -12, 0);
    const mat = beamMat(c);
    const cone = new THREE.Mesh(coneGeo, mat);
    pivot.add(cone);
    group.add(pivot);
    const light = new THREE.SpotLight(c, 0, 50, 0.22, 0.5, 1.2);
    light.position.copy(pivot.position);
    group.add(light, light.target);
    beams.push({ pivot, light, phase: k * 1.7, mat });
  });

  // Pyro: four cannons at the corners of the floor.
  const pyroPos: THREE.Vector3[] = [
    new THREE.Vector3(-HALF_L - 2.2, 0, HALF_W + 1.4),
    new THREE.Vector3(HALF_L + 2.2, 0, HALF_W + 1.4),
    new THREE.Vector3(-HALF_L - 2.2, 0, -HALF_W - 1.4),
    new THREE.Vector3(HALF_L + 2.2, 0, -HALF_W - 1.4),
  ];
  const flames: THREE.Mesh[] = [];
  const flameGeo = new THREE.ConeGeometry(0.45, 4, 12, 1, true);
  flameGeo.translate(0, 2, 0);
  for (const p of pyroPos) {
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 0.6, 12), frame);
    can.position.copy(p).setY(0.3);
    group.add(can);
    const f = new THREE.Mesh(flameGeo, new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    f.position.copy(p).setY(0.55);
    f.scale.set(1, 0.01, 1);
    group.add(f);
    flames.push(f);
  }
  const pyroLight = new THREE.PointLight(0xff8a3a, 0, 30, 1.5);
  pyroLight.position.set(0, 3, 0);
  group.add(pyroLight);
  let pyroT = 99;

  // Confetti: instanced squares that fall from the roof.
  const CONF = quality === "high" ? 900 : 400;
  const confGeo = new THREE.PlaneGeometry(0.14, 0.09);
  const confMesh = new THREE.InstancedMesh(confGeo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }), CONF);
  const confState = Array.from({ length: CONF }, (_, k) => ({ x: 0, y: -10, z: 0, vy: 0, spin: k, ax: Math.random() * 6, color: 0 }));
  const confColors = [0xfacc15, 0x22d3ee, 0xf43f5e, 0x8b5cf6, 0xffffff, new THREE.Color(clubs[0].color).getHex(), new THREE.Color(clubs[1].color).getHex()];
  confState.forEach((c, k) => confMesh.setColorAt(k, new THREE.Color(confColors[k % confColors.length])));
  confMesh.frustumCulled = false;
  group.add(confMesh);
  let confOn = false;

  // ---- drawing

  let ribbonOff = 0;
  const ribbonText = ADS.join("   ✦   ");
  const drawRibbon = (r: { c: HTMLCanvasElement; g: CanvasRenderingContext2D; t: THREE.CanvasTexture }, text: string, bg: string, fg: string) => {
    const { c, g } = r;
    g.fillStyle = bg;
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = fg;
    g.font = `900 ${c.height * 0.62}px system-ui, sans-serif`;
    g.textBaseline = "middle";
    const w = g.measureText(text + "   ✦   ").width;
    for (let x = -((ribbonOff * 60) % w); x < c.width; x += w) g.fillText(text + "   ✦   ", x, c.height / 2 + 2);
    r.t.needsUpdate = true;
  };

  let lastBoard: Board | null = null;
  const drawOverlay = (b: Board) => {
    const g = over.getContext("2d")!;
    g.clearRect(0, 0, 512, 288);
    // Score strip along the bottom.
    g.fillStyle = "rgba(6,4,14,0.86)";
    g.fillRect(0, 232, 512, 56);
    const half = (k: 0 | 1, x: number) => {
      const club = b.clubs[k];
      g.fillStyle = club.color;
      g.fillRect(x, 236, 150, 48);
      g.fillStyle = club.ink;
      g.font = "900 22px system-ui";
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillText(`${club.emoji} ${club.short}`, x + 8, 260);
      g.textAlign = "right";
      g.font = "900 34px system-ui";
      g.fillText(String(b.score[k]), x + 145, 261);
    };
    half(0, 6);
    half(1, 356);
    g.fillStyle = "#ffffff";
    g.textAlign = "center";
    g.font = "900 30px ui-monospace, monospace";
    g.fillText(b.clock, 256, 254);
    g.fillStyle = b.shot <= 5 ? "#f87171" : "#facc15";
    g.font = "800 16px ui-monospace, monospace";
    g.fillText(`SHOT ${Math.max(0, Math.ceil(b.shot))}`, 256, 276);
    if (b.replay) {
      g.fillStyle = "#f43f5e";
      g.fillRect(12, 12, 108, 30);
      g.fillStyle = "#fff";
      g.font = "900 20px system-ui";
      g.textAlign = "center";
      g.fillText("REPLAY", 66, 28);
    }
    if (b.shout) {
      const k = Math.min(1, b.shoutT * 4);
      const s = 0.6 + 0.4 * k + Math.sin(b.shoutT * 10) * 0.03;
      g.save();
      g.translate(256, 112);
      g.scale(s, s);
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = "900 86px system-ui";
      g.lineWidth = 10;
      g.strokeStyle = "rgba(0,0,0,0.8)";
      g.strokeText(b.shout, 0, 0);
      const grad = g.createLinearGradient(0, -40, 0, 40);
      grad.addColorStop(0, "#fff7ae");
      grad.addColorStop(1, "#f59e0b");
      g.fillStyle = grad;
      g.fillText(b.shout, 0, 0);
      if (b.sub) {
        g.font = "900 26px system-ui";
        g.lineWidth = 6;
        g.strokeText(b.sub, 0, 62);
        g.fillStyle = "#ffffff";
        g.fillText(b.sub, 0, 62);
      }
      g.restore();
    }
    overTex.needsUpdate = true;
    // The shot clocks.
    shotClocks.forEach(({ c, t }) => {
      const sg = c.getContext("2d")!;
      sg.fillStyle = "#050505";
      sg.fillRect(0, 0, 128, 64);
      sg.fillStyle = b.shot <= 5 ? "#ff3b3b" : "#ffb020";
      sg.font = "900 52px ui-monospace, monospace";
      sg.textAlign = "center";
      sg.textBaseline = "middle";
      sg.fillText(String(Math.max(0, Math.ceil(b.shot))).padStart(2, "0"), 64, 34);
      t.needsUpdate = true;
    });
  };

  let redraw = 0;
  const flash = [0, 0];
  const arena: Arena = {
    group,
    feed,
    jumbo,
    update(dt, t, hype) {
      uniforms.uTime.value = t;
      uniforms.uHype.value += (hype - uniforms.uHype.value) * Math.min(1, dt * 4);
      const h = uniforms.uHype.value;
      ribbonOff += dt;
      redraw -= dt;
      if (redraw <= 0) {
        redraw = 0.08;
        drawRibbon(adRib, ADS.join("   ✦   "), "#07040f", "#ffffff");
        drawRibbon(ribTex, h > 0.5 ? "MAKE SOME NOISE   ✦   VIBE DOME   ✦   " + ribbonText : ribbonText, h > 0.5 ? "#f43f5e" : "#0d0920", h > 0.5 ? "#ffffff" : "#facc15");
        drawRibbon(ledRib, lastBoard ? `${lastBoard.clubs[0].short} ${lastBoard.score[0]}  ·  ${lastBoard.clubs[1].short} ${lastBoard.score[1]}  ·  ${lastBoard.clock}` : "VIBE DOME", "#05030a", "#22d3ee");
        if (lastBoard) drawOverlay(lastBoard);
      }
      // Net kicks and backboard LEDs.
      nets.forEach((n, k) => {
        const kick = (n.userData.kick = Math.max(0, n.userData.kick - dt * 2.2));
        n.scale.set(1 - kick * 0.25, 1 + kick * 0.6 * Math.sin(kick * 18), 1 - kick * 0.25);
        flash[k] = Math.max(0, flash[k] - dt * 0.8);
        const on = flash[k] > 0 && Math.floor(t * 12) % 2 === 0;
        boardLeds[k].color.setHex(on ? 0xff3b3b : 0xffffff);
      });
      // Beams: idle drift, a real sweep when the place is up.
      for (const b of beams) {
        const sw = 0.25 + h * 0.9;
        b.pivot.rotation.x = Math.sin(t * (0.3 + h * 1.4) + b.phase) * sw;
        b.pivot.rotation.z = Math.cos(t * (0.24 + h * 1.1) + b.phase * 1.3) * sw;
        b.mat.opacity = 0.03 + h * 0.12;
        const dir = new THREE.Vector3(0, -1, 0).applyEuler(b.pivot.rotation);
        b.light.target.position.copy(b.pivot.position).addScaledVector(dir, 20);
        b.light.intensity = h * 160;
      }
      // Pyro.
      pyroT += dt;
      const fl = pyroT < 1.6 ? Math.sin((pyroT / 1.6) * Math.PI) : 0;
      flames.forEach((f, k) => {
        f.scale.set(1 + Math.sin(t * 40 + k) * 0.1, Math.max(0.01, fl * (1 + Math.sin(t * 30 + k * 2) * 0.15)), 1);
        (f.material as THREE.MeshBasicMaterial).opacity = fl * 0.9;
      });
      pyroLight.intensity = fl * 220;
      // Confetti.
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const one = new THREE.Vector3(1, 1, 1);
      const pos = new THREE.Vector3();
      confState.forEach((c, k) => {
        if (c.y < -1) {
          if (!confOn) {
            m.makeScale(0, 0, 0);
            confMesh.setMatrixAt(k, m);
            return;
          }
          c.x = (Math.random() - 0.5) * 34;
          c.z = (Math.random() - 0.5) * 22;
          c.y = 16 + Math.random() * 8;
          c.vy = 1.2 + Math.random() * 1.2;
        }
        c.y -= c.vy * dt;
        c.spin += dt * 5;
        c.x += Math.sin(c.spin * 0.7 + c.ax) * dt * 0.6;
        e.set(c.spin, c.spin * 0.6 + c.ax, 0);
        q.setFromEuler(e);
        pos.set(c.x, c.y, c.z);
        m.compose(pos, q, one);
        confMesh.setMatrixAt(k, m);
      });
      confMesh.instanceMatrix.needsUpdate = true;
    },
    scoreboard(b) {
      lastBoard = b;
    },
    swish(side, big) {
      const k = side < 0 ? 0 : 1;
      nets[k].userData.kick = 1;
      if (big) flash[k] = 2.4;
    },
    pyro() {
      pyroT = 0;
    },
    confetti(on) {
      if (on && !confOn) confState.forEach((c) => (c.y = 16 + Math.random() * 14));
      confOn = on;
    },
    dispose() {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      for (const d of disposables) d.dispose();
      for (const r of [adRib, ribTex, ledRib, suiteTex]) r.t.dispose();
      overTex.dispose();
      shotClocks.forEach((s) => s.t.dispose());
      void crowd;
    },
  };
  return arena;
}
