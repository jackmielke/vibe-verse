/**
 * Everything on the mountain that does not move on its own: the snow, the
 * forest, the village at 300 ft, the summit deck at 5,000 ft, the gondola,
 * the kickers on the Main Run, the wingsuit rings and the thermals.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  CELL, GRID, HALF, KICKERS, SUMMIT, VILLAGE, THERMALS, type Grid,
  gridHeight, kickerAt, ringPath, runX, treeOk, rawHeight,
} from "./world";

export interface Pad {
  key: "ski" | "board" | "wingsuit" | "paraglider" | "skyway" | "gondola-up" | "gondola-down";
  label: string;
  x: number;
  z: number;
  y: number;
  r: number;
}

export interface Scenery {
  group: THREE.Group;
  pads: Pad[];
  rings: { x: number; y: number; z: number; yaw: number; mesh: THREE.Mesh }[];
  /** The gondola cable as a polyline, village to summit. */
  cable: THREE.Vector3[];
  /** Tree trunks for collisions: a coarse grid of [x, z, radius] buckets. */
  treeNear(x: number, z: number): { x: number; z: number; r: number } | null;
  update(t: number, dt: number): void;
  dispose(): void;
}

export function signTexture(lines: string[], opts: { bg?: string; fg?: string; w?: number; h?: number; font?: string } = {}) {
  const w = opts.w ?? 512, h = opts.h ?? 256;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = opts.bg ?? "#173048";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(255,255,255,0.85)";
  g.lineWidth = 10;
  g.strokeRect(8, 8, w - 16, h - 16);
  g.fillStyle = opts.fg ?? "#ffffff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  const size = lines.length > 1 ? h * 0.3 : h * 0.42;
  lines.forEach((l, i) => {
    g.font = `${i === 0 ? 900 : 600} ${i === 0 ? size : size * 0.62}px ${opts.font ?? "Inter, system-ui, sans-serif"}`;
    g.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * size * 1.05);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function buildScenery(grid: Grid, scene: THREE.Scene): Scenery {
  const group = new THREE.Group();
  scene.add(group);
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);
  const H = (x: number, z: number) => gridHeight(grid, x, z);

  // ---- The snow ----------------------------------------------------------
  const geo = keep(new THREE.PlaneGeometry(HALF * 2, HALF * 2, GRID, GRID));
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setY(i, grid.h[i]);
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const snow = new THREE.Color(0.96, 0.975, 1.0);
  const shade = new THREE.Color(0.80, 0.87, 0.98);
  const rock = new THREE.Color(0.36, 0.35, 0.38);
  const rockWarm = new THREE.Color(0.48, 0.43, 0.40);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const ny = nrm.getY(i);
    const y = pos.getY(i);
    const x = pos.getX(i), z = pos.getZ(i);
    const speck = (Math.sin(x * 0.37 + z * 0.11) * Math.sin(z * 0.29 - x * 0.07)) * 0.5 + 0.5;
    const lo = 0.6 + 0.2 * THREE.MathUtils.smoothstep(y, 700, 1450);
    const steep = THREE.MathUtils.smoothstep(ny, lo, lo + 0.12); // 0 = rock, 1 = holds snow
    tmp.copy(rock).lerp(rockWarm, speck);
    const s = tmp.clone().lerp(snow, steep);
    // A touch of blue in the valley and on north faces.
    s.lerp(shade, (1 - THREE.MathUtils.smoothstep(y, 80, 500)) * 0.35 + Math.max(0, -nrm.getZ(i)) * 0.15);
    col[i * 3] = s.r;
    col[i * 3 + 1] = s.g;
    col[i * 3 + 2] = s.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const snowMat = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 }));
  // Close up, a plain white heightfield reads as plastic. Wind-blown drifts and
  // a fine grain in world space give the eye something to measure speed by.
  snowMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSnowW;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvSnowW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec3 vSnowW;
float snH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float snN(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(snH(i), snH(i + vec2(1.0, 0.0)), f.x), mix(snH(i + vec2(0.0, 1.0)), snH(i + vec2(1.0, 1.0)), f.x), f.y);
}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
{
  vec2 w = vSnowW.xz;
  float drift = snN(vec2(w.x * 0.05 + w.y * 0.02, w.y * 0.11));
  float grain = snN(w * 0.9) * 0.6 + snN(w * 3.7) * 0.4;
  float fade = 1.0 - smoothstep(60.0, 400.0, length(vSnowW - cameraPosition));
  diffuseColor.rgb *= 1.0 - fade * (0.07 * drift + 0.06 * grain) + (1.0 - fade) * 0.0;
}`);
  };
  const terrain = new THREE.Mesh(geo, snowMat);
  terrain.receiveShadow = true;
  group.add(terrain);

  const BUCKET = 40;
  const buckets = new Map<number, number[]>();
  const bkey = (i: number, j: number) => i * 100003 + j;
  const treeAdd = (x: number, z: number, r: number) => {
    const k = bkey(Math.floor(x / BUCKET), Math.floor(z / BUCKET));
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(x, z, r);
  };
  const treeNear = (x: number, z: number) => {
    const i0 = Math.floor(x / BUCKET), j0 = Math.floor(z / BUCKET);
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) {
      const b = buckets.get(bkey(i, j));
      if (!b) continue;
      for (let t = 0; t < b.length; t += 3) {
        const dx = x - b[t], dz = z - b[t + 1];
        if (dx * dx + dz * dz < b[t + 2] * b[t + 2]) return { x: b[t], z: b[t + 1], r: b[t + 2] };
      }
    }
    return null;
  };

  // ---- The forest --------------------------------------------------------
  {
    const parts: THREE.BufferGeometry[] = [];
    const paint = (g: THREE.BufferGeometry, c: THREE.Color) => {
      const n = g.attributes.position.count;
      const a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
      g.setAttribute("color", new THREE.BufferAttribute(a, 3));
      return g;
    };
    const trunk = new THREE.CylinderGeometry(0.35, 0.5, 2.4, 6);
    trunk.translate(0, 1.2, 0);
    parts.push(paint(trunk, new THREE.Color("#4b3422")));
    const tiers = [[3.4, 4.2, 3.6], [2.7, 3.8, 6.0], [1.9, 3.4, 8.3], [1.1, 2.8, 10.4]];
    for (const [r, h, y] of tiers) {
      const c = new THREE.ConeGeometry(r, h, 8);
      c.translate(0, y, 0);
      parts.push(paint(c, new THREE.Color("#1f4a35")));
      const cap = new THREE.ConeGeometry(r * 0.82, h * 0.52, 8);
      cap.translate(0, y + h * 0.3, 0);
      parts.push(paint(cap, new THREE.Color("#eef4fb")));
    }
    const treeGeo = keep(mergeGeometries(parts.map((p) => p.toNonIndexed()))!);
    parts.forEach((p) => p.dispose());
    const treeMat = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }));
    const MAX = 9000;
    const trees = new THREE.InstancedMesh(treeGeo, treeMat, MAX);
    trees.castShadow = true;
    trees.receiveShadow = true;
    let seed = 1234;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    let n = 0;
    for (let tries = 0; tries < 110000 && n < MAX; tries++) {
      // Bias toward the lower mountain and the forest hill.
      const onHill = rnd() < 0.28;
      const hr = 820 * Math.sqrt(rnd()), ha = rnd() * Math.PI * 2;
      const x = onHill ? 1500 + Math.cos(ha) * hr : (rnd() - 0.5) * 7600;
      const z = onHill ? 1500 + Math.sin(ha) * hr * 0.8 : -2200 + rnd() * 6400;
      // Clumps: a slow noise decides where the stands are.
      const clump = Math.sin(x * 0.006 + 1.3) * Math.sin(z * 0.0055 - 0.4) + Math.sin(x * 0.017 + z * 0.013) * 0.4;
      if (!onHill && clump < 0.05) continue;
      if (!treeOk(grid, x, z, rnd())) continue;
      const k = 1.1 + rnd() * 1.1;
      p.set(x, H(x, z) - 0.4, z);
      q.setFromAxisAngle(up, rnd() * Math.PI * 2);
      s.set(k, k * (0.9 + rnd() * 0.3), k);
      trees.setMatrixAt(n++, m.compose(p, q, s));
      treeAdd(x, z, 1.1 * k);
    }
    trees.count = n;
    trees.instanceMatrix.needsUpdate = true;
    trees.computeBoundingSphere();
    group.add(trees);
  }

  // ---- Shared materials for buildings ------------------------------------
  const wood = keep(new THREE.MeshStandardMaterial({ color: "#7a4e32", roughness: 0.85 }));
  const woodDark = keep(new THREE.MeshStandardMaterial({ color: "#4d3020", roughness: 0.9 }));
  const roofSnow = keep(new THREE.MeshStandardMaterial({ color: "#f4f8fd", roughness: 0.8 }));
  const stone = keep(new THREE.MeshStandardMaterial({ color: "#8a8a92", roughness: 0.95 }));
  const glow = keep(new THREE.MeshStandardMaterial({ color: "#ffd59a", emissive: "#ffb347", emissiveIntensity: 1.2 }));
  const steel = keep(new THREE.MeshStandardMaterial({ color: "#c9ced6", metalness: 0.6, roughness: 0.35 }));
  const red = keep(new THREE.MeshStandardMaterial({ color: "#d8342c", roughness: 0.5 }));

  const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, ry = 0, parent: THREE.Object3D = group) => {
    const g = keep(new THREE.BoxGeometry(w, h, d));
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const sign = (lines: string[], w: number, h: number, x: number, y: number, z: number, ry: number, opts: Parameters<typeof signTexture>[1] = {}) => {
    const tex = keep(signTexture(lines, opts));
    const mat = keep(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    const g = keep(new THREE.PlaneGeometry(w, h));
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry;
    group.add(mesh);
    const back = new THREE.Mesh(g, woodDark);
    back.position.set(x, y, z);
    back.rotation.y = ry + Math.PI;
    group.add(back);
    return mesh;
  };

  /** A chalet: body, gable roof with snow, lit windows, a chimney. */
  const chalet = (x: number, z: number, w: number, d: number, h: number, ry: number) => {
    const g = new THREE.Group();
    g.position.set(x, H(x, z), z);
    g.rotation.y = ry;
    group.add(g);
    box(w, 1.2, d, stone, 0, 0.3, 0, 0, g);
    box(w, h, d, wood, 0, h / 2 + 0.6, 0, 0, g);
    const roofLen = Math.hypot(w / 2 + 0.8, h * 0.55);
    const ang = Math.atan2(h * 0.55, w / 2 + 0.8);
    for (const sgn of [-1, 1]) {
      const r = box(roofLen, 0.5, d + 1.6, roofSnow, sgn * (w / 4 + 0.4), h + 0.6 + h * 0.275, 0, 0, g);
      r.rotation.z = -sgn * ang;
    }
    for (let i = 0; i < Math.max(1, Math.floor(w / 3.2)); i++) {
      const wx = -w / 2 + 1.8 + i * 3.2;
      if (wx > w / 2 - 1) break;
      box(1.3, 1.5, 0.15, glow, wx, h * 0.55 + 0.6, d / 2 + 0.05, 0, g);
      box(1.3, 1.5, 0.15, glow, wx, h * 0.55 + 0.6, -d / 2 - 0.05, 0, g);
    }
    box(1.1, h * 0.9, 1.1, stone, w * 0.25, h * 1.3, d * 0.2, 0, g);
    return g;
  };

  // ---- The village at 300 ft ---------------------------------------------
  const VX = VILLAGE.x, VZ = VILLAGE.z;
  {
    // The lodge, facing the mountain.
    const lodge = chalet(VX + 70, VZ + 110, 34, 18, 11, 0);
    void lodge;
    sign(["VIBE SUMMIT", "LODGE · 300 FT"], 14, 4.2, VX + 70, VILLAGE.y + 15.5, VZ + 100.5, Math.PI, { bg: "#7a1f1a" });
    const spots: [number, number, number, number, number][] = [
      [-80, 120, 12, 10, 7], [-120, 60, 10, 9, 6], [140, 40, 12, 10, 7], [120, 170, 10, 9, 6],
      [-40, 190, 11, 9, 7], [10, 230, 12, 10, 7], [-150, 170, 9, 8, 6], [170, 110, 10, 9, 6],
    ];
    for (const [dx, dz, w, d, h] of spots) chalet(VX + dx, VZ + dz, w, d, h, Math.atan2(-dx, -dz) + Math.PI);

    // The finish arch across the bottom of the Main Run.
    const az = VZ - 170, ax = runX(az);
    const ay = H(ax, az);
    box(1.6, 12, 1.6, red, ax - 22, ay + 6, az);
    box(1.6, 12, 1.6, red, ax + 22, ay + 6, az);
    box(46, 3, 1.4, red, ax, ay + 12.5, az);
    sign(["FINISH", "300 FT"], 22, 3.2, ax, ay + 12.5, az - 0.75, Math.PI, { bg: "#d8342c" });
    sign(["FINISH", "300 FT"], 22, 3.2, ax, ay + 12.5, az + 0.75, 0, { bg: "#d8342c" });
  }

  // ---- The summit deck at 5,000 ft ---------------------------------------
  const SX = SUMMIT.x, SZ = SUMMIT.z, SY = SUMMIT.y;
  const pads: Pad[] = [];
  {
    const deck = new THREE.Mesh(keep(new THREE.CylinderGeometry(44, 46, 1.2, 40)), keep(new THREE.MeshStandardMaterial({ color: "#c9a27a", roughness: 0.8 })));
    deck.position.set(SX, SY - 0.55, SZ);
    deck.receiveShadow = true;
    group.add(deck);
    sign(["SUMMIT", "5,000 FT"], 10, 5, SX, SY + 6, SZ - 30, 0, { bg: "#173048" });
    box(0.5, 6, 0.5, woodDark, SX - 4, SY + 3, SZ - 30.3);
    box(0.5, 6, 0.5, woodDark, SX + 4, SY + 3, SZ - 30.3);

    // Choose your way down. Pads sit along the south edge, facing the drop.
    const choices: { key: Pad["key"]; label: string; lines: string[]; bg: string; dx: number }[] = [
      { key: "ski", label: "Skis", lines: ["⛷ SKIS", "the Main Run"], bg: "#1d5fa8", dx: 24 },
      { key: "board", label: "Snowboard", lines: ["🏂 BOARD", "the Main Run"], bg: "#6b2fb3", dx: 8 },
      { key: "wingsuit", label: "Wingsuit", lines: ["🪂 WINGSUIT", "fly the rings"], bg: "#d8342c", dx: -8 },
      { key: "paraglider", label: "Paraglider", lines: ["🪁 PARAGLIDER", "ride the thermals"], bg: "#d98a1a", dx: -24 },
    ];
    const padMat = keep(new THREE.MeshBasicMaterial({ color: "#7fe7ff", transparent: true, opacity: 0.55, toneMapped: false }));
    const padGeo = keep(new THREE.RingGeometry(3.2, 4.2, 40));
    padGeo.rotateX(-Math.PI / 2);
    for (const c of choices) {
      const x = SX + c.dx, z = SZ + 26;
      sign(c.lines, 7.5, 3.75, x, SY + 4.2, z - 5, Math.PI, { bg: c.bg });
      box(0.35, 4, 0.35, woodDark, x - 3.2, SY + 2, z - 4.8);
      box(0.35, 4, 0.35, woodDark, x + 3.2, SY + 2, z - 4.8);
      const ring = new THREE.Mesh(padGeo, padMat);
      ring.position.set(x, SY + 0.12, z);
      group.add(ring);
      pads.push({ key: c.key, label: c.label, x, z, y: SY, r: 5 });
    }
  }

  // ---- The rainbow lift: a beam from the deck up to the Prism Skyway -----
  const beamUniforms = { uTime: { value: 0 } };
  {
    const bx = SX - 30, bz = SZ - 6;
    const beam = new THREE.Mesh(
      keep(new THREE.CylinderGeometry(4.5, 4.5, 1400, 24, 1, true)),
      keep(new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: beamUniforms,
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          varying vec2 vUv;
          vec3 hue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
          void main() {
            float h = fract(vUv.x * 2.0 + vUv.y * 6.0 - uTime * 0.25);
            float a = 0.35 + 0.25 * sin(vUv.y * 300.0 - uTime * 8.0);
            a *= smoothstep(0.0, 0.02, vUv.y) * (1.0 - smoothstep(0.85, 1.0, vUv.y));
            gl_FragColor = vec4(hue(h) * a, 1.0);
          }
        `,
      })),
    );
    beam.position.set(bx, SY + 700, bz);
    beam.frustumCulled = false;
    group.add(beam);
    const base = new THREE.Mesh(keep(new THREE.CylinderGeometry(6, 6.5, 0.6, 32)), keep(new THREE.MeshStandardMaterial({ color: "#ffffff", emissive: "#d9b3ff", emissiveIntensity: 0.6 })));
    base.position.set(bx, SY + 0.2, bz);
    group.add(base);
    sign(["🌈 PRISM SKYWAY", "the rainbow road up there"], 9, 4.5, bx, SY + 4.5, bz + 9, 0, { bg: "#4a1d7a" });
    pads.push({ key: "skyway", label: "Prism Skyway", x: bx, z: bz, y: SY, r: 7 });
  }

  // ---- The gondola -------------------------------------------------------
  const cable: THREE.Vector3[] = [];
  const cabins: THREE.Group[] = [];
  {
    const a = new THREE.Vector3(VX - 90, VILLAGE.y + 14, VZ - 40);
    const b = new THREE.Vector3(SX + 38, SY + 12, SZ - 14);
    const N = 40;
    for (let i = 0; i <= N; i++) {
      const p = a.clone().lerp(b, i / N);
      const clear = rawHeight(p.x, p.z) + 32;
      p.y = Math.max(p.y, clear);
      cable.push(p);
    }
    // Smooth the clearance bumps so the cable sags rather than kinks.
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 1; i < N; i++) {
        const m = (cable[i - 1].y + cable[i + 1].y) / 2;
        cable[i].y = Math.max(m, rawHeight(cable[i].x, cable[i].z) + 26);
      }
    }
    const line = new THREE.Line(keep(new THREE.BufferGeometry().setFromPoints(cable)), keep(new THREE.LineBasicMaterial({ color: "#2b2f36" })));
    group.add(line);
    // Towers every few points.
    for (let i = 4; i < N; i += 5) {
      const p = cable[i];
      const g = H(p.x, p.z);
      const h = p.y - g + 2;
      box(1.2, h, 1.2, steel, p.x, g + h / 2, p.z);
      box(7, 0.6, 1, steel, p.x, p.y + 1, p.z);
    }
    // Stations.
    for (const [p, ry] of [[a, 0], [b, 0]] as [THREE.Vector3, number][]) {
      const g = H(p.x, p.z);
      box(14, 1, 10, stone, p.x, g + 0.5, p.z, ry);
      box(1, p.y - g + 3, 1, steel, p.x - 6, g + (p.y - g + 3) / 2, p.z - 4, ry);
      box(1, p.y - g + 3, 1, steel, p.x + 6, g + (p.y - g + 3) / 2, p.z - 4, ry);
      box(1, p.y - g + 3, 1, steel, p.x - 6, g + (p.y - g + 3) / 2, p.z + 4, ry);
      box(1, p.y - g + 3, 1, steel, p.x + 6, g + (p.y - g + 3) / 2, p.z + 4, ry);
      box(15, 0.8, 11, red, p.x, p.y + 3, p.z, ry);
    }
    sign(["🚡 GONDOLA", "to the summit"], 8, 4, a.x, H(a.x, a.z) + 3.5, a.z + 7, 0, { bg: "#d8342c" });
    sign(["🚡 GONDOLA", "back to the village"], 8, 4, b.x, H(b.x, b.z) + 3.5, b.z + 7, 0, { bg: "#d8342c" });
    pads.push({ key: "gondola-up", label: "Gondola up", x: a.x, z: a.z + 4, y: H(a.x, a.z), r: 9 });
    pads.push({ key: "gondola-down", label: "Gondola down", x: b.x, z: b.z + 4, y: H(b.x, b.z), r: 9 });

    const cabinGeo = keep(new THREE.BoxGeometry(2.6, 2.4, 2.6));
    const cabinMat = keep(new THREE.MeshStandardMaterial({ color: "#e2382f", roughness: 0.4 }));
    for (let i = 0; i < 12; i++) {
      const g = new THREE.Group();
      const c = new THREE.Mesh(cabinGeo, cabinMat);
      c.position.y = -3;
      c.castShadow = true;
      g.add(c);
      const arm = new THREE.Mesh(keep(new THREE.BoxGeometry(0.2, 2, 0.2)), steel);
      arm.position.y = -1;
      g.add(arm);
      group.add(g);
      cabins.push(g);
    }
  }

  // ---- Kickers on the Main Run ------------------------------------------
  {
    const kickMat = keep(new THREE.MeshStandardMaterial({ color: "#e6eef8", roughness: 0.75 }));
    const lipMat = keep(new THREE.MeshBasicMaterial({ color: "#1d8bff", toneMapped: false }));
    for (const k of KICKERS) {
      const cx = runX(k.z);
      const nu = 10, nv = 14;
      const verts: number[] = [];
      const idx: number[] = [];
      for (let j = 0; j <= nv; j++) {
        for (let i = 0; i <= nu; i++) {
          const x = cx - k.w / 2 + (i / nu) * k.w;
          const z = k.z - k.len + (j / nv) * k.len;
          verts.push(x, gridHeight(grid, x, z) + kickerAt(x, z - 1e-3) + 0.05, z);
        }
      }
      for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
        const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
      // The lip face, dropping back to the snow.
      const base = verts.length / 3;
      for (let i = 0; i <= nu; i++) {
        const x = cx - k.w / 2 + (i / nu) * k.w;
        const z = k.z;
        verts.push(x, gridHeight(grid, x, z) + kickerAt(x, z - 1e-3) + 0.05, z);
        verts.push(x, gridHeight(grid, x, z) - 0.3, z + 0.2);
      }
      for (let i = 0; i < nu; i++) {
        const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, b, c, c, b, d);
      }
      const g = keep(new THREE.BufferGeometry());
      g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, kickMat);
      mesh.castShadow = mesh.receiveShadow = true;
      group.add(mesh);
      const lip = new THREE.Mesh(keep(new THREE.BoxGeometry(k.w, 0.25, 0.4)), lipMat);
      lip.position.set(cx, gridHeight(grid, cx, k.z) + k.lip + 0.1, k.z - 0.2);
      group.add(lip);
      // Flags either side.
      for (const s of [-1, 1]) {
        box(0.2, 3.2, 0.2, woodDark, cx + s * (k.w / 2 + 1.5), gridHeight(grid, cx + s * (k.w / 2 + 1.5), k.z) + 1.6, k.z);
        box(1.4, 0.9, 0.05, red, cx + s * (k.w / 2 + 1.5) + 0.7, gridHeight(grid, cx + s * (k.w / 2 + 1.5), k.z) + 2.8, k.z);
      }
    }
    // Run markers: blue poles every 120 m down both edges, so the run reads from the air.
    const poleGeo = keep(new THREE.CylinderGeometry(0.18, 0.18, 3, 6));
    const poleMat = keep(new THREE.MeshBasicMaterial({ color: "#2a6cff", toneMapped: false }));
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, 160);
    let n = 0;
    const m = new THREE.Matrix4();
    for (let z = SUMMIT.z + 140; z < VILLAGE.z - 180 && n < 158; z += 120) {
      for (const s of [-1, 1]) {
        const x = runX(z) + s * RUN_EDGE;
        m.makeTranslation(x, gridHeight(grid, x, z) + 1.5, z);
        poles.setMatrixAt(n++, m);
      }
    }
    poles.count = n;
    group.add(poles);
  }

  // ---- Wingsuit rings ----------------------------------------------------
  const ringMat = keep(new THREE.MeshBasicMaterial({ color: "#ff8a1f", toneMapped: false, transparent: true, opacity: 0.92 }));
  const ringGeo = keep(new THREE.TorusGeometry(11, 0.8, 8, 40));
  const rings = ringPath().map((r) => {
    const mesh = new THREE.Mesh(ringGeo, ringMat.clone());
    keep(mesh.material as THREE.Material);
    mesh.position.set(r.x, r.y, r.z);
    mesh.rotation.y = r.yaw;
    group.add(mesh);
    return { ...r, mesh };
  });

  // ---- Birds: a few flocks wheeling over the valley and the thermals ------
  const birdGeo = keep(new THREE.BufferGeometry());
  birdGeo.setAttribute("position", new THREE.Float32BufferAttribute([-1.2, 0.3, -0.2, 0, 0, 0.3, 0, 0, -0.3, 1.2, 0.3, -0.2, 0, 0, 0.3, 0, 0, -0.3], 3));
  birdGeo.computeVertexNormals();
  const BIRDS = 48;
  const birds = new THREE.InstancedMesh(birdGeo, keep(new THREE.MeshBasicMaterial({ color: "#2a2f3a", side: THREE.DoubleSide })), BIRDS);
  birds.frustumCulled = false;
  group.add(birds);
  const flocks = [
    { x: 0, z: 1700, y: 260, r: 160 },
    { x: 1500, z: 1500, y: 520, r: 120 },
    { x: 520, z: 100, y: 620, r: 90 },
    { x: -420, z: -800, y: 920, r: 80 },
  ];
  const birdM = new THREE.Matrix4(), birdQ = new THREE.Quaternion(), birdS = new THREE.Vector3(), birdP = new THREE.Vector3(), birdE = new THREE.Euler();

  // ---- Thermals: rising sparkles -----------------------------------------
  const sparkN = 90;
  const sparkGeo = keep(new THREE.BufferGeometry());
  const sparkPos = new Float32Array(THERMALS.length * sparkN * 3);
  const sparkSeed = new Float32Array(THERMALS.length * sparkN);
  for (let i = 0; i < sparkSeed.length; i++) sparkSeed[i] = Math.random();
  sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
  const sparks = new THREE.Points(sparkGeo, keep(new THREE.PointsMaterial({ color: "#fff1b8", size: 2.4, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending })));
  sparks.frustumCulled = false;
  group.add(sparks);
  const thermalBase = THERMALS.map((t) => rawHeight(t.x, t.z));

  return {
    group,
    pads,
    rings,
    cable,
    treeNear,
    update(t) {
      beamUniforms.uTime.value = t;
      // Cabins loop the cable: half going up, half coming down.
      const N = cable.length - 1;
      cabins.forEach((c, i) => {
        let u = ((t * 0.006 + i / cabins.length) % 1);
        const down = u > 0.5;
        u = down ? (1 - u) * 2 : u * 2;
        const f = u * N, k = Math.min(N - 1, Math.floor(f));
        c.position.copy(cable[k]).lerp(cable[k + 1], f - k);
        c.position.x += down ? 3 : -3;
      });
      for (const r of rings) r.mesh.rotation.z = t * 0.4;
      for (let i = 0; i < BIRDS; i++) {
        const f = flocks[i % flocks.length];
        const k = Math.floor(i / flocks.length);
        const a = t * (0.18 + (k % 3) * 0.02) + k * 0.5;
        const rr = f.r + Math.sin(k * 2.1) * 25;
        birdP.set(f.x + Math.cos(a) * rr, f.y + Math.sin(t * 0.7 + k) * 6 + k * 1.5, f.z + Math.sin(a) * rr);
        const flap = Math.sin(t * 9 + i) * 0.5;
        birdE.set(0, -a, -0.3);
        birdQ.setFromEuler(birdE);
        birdS.set(1.6, 1.6 + flap, 1.6);
        birds.setMatrixAt(i, birdM.compose(birdP, birdQ, birdS));
      }
      birds.instanceMatrix.needsUpdate = true;
      let o = 0;
      THERMALS.forEach((th, ti) => {
        for (let i = 0; i < sparkN; i++) {
          const s = sparkSeed[ti * sparkN + i];
          const life = (t * 0.05 + s) % 1;
          const a = s * 40 + t * 0.6;
          const rr = th.r * (0.2 + 0.8 * ((s * 7.3) % 1));
          sparkPos[o++] = th.x + Math.cos(a) * rr;
          sparkPos[o++] = thermalBase[ti] + 20 + life * 900;
          sparkPos[o++] = th.z + Math.sin(a) * rr;
        }
      });
      sparkGeo.attributes.position.needsUpdate = true;
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
      scene.remove(group);
    },
  };
}

const RUN_EDGE = 150;
void CELL;
