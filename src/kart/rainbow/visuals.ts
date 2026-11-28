/**
 * PRISM SKYWAY: everything you can see.
 *
 * The road is a lit `MeshStandardMaterial` with a patched colour and emissive,
 * so Vibe Kart's own image-based lighting, shadows, tone mapping and bloom do
 * the rest: the bands glow because the post stack blooms whatever burns past
 * one, not because this file fakes a glow.
 *
 * No backticks inside the GLSL below; it is a template literal.
 */
import * as THREE from "three";
import type { KartQuality } from "../types";
import { ALT, HALF_WIDTH, MOUNTAIN_OFFSET, RAIL_HEIGHT, RAIL_OFFSET, liftAt, type Course } from "./course";
import { buildGrid, gridHeight, SUMMIT } from "../../summit/world";
import { buildSnowField } from "../../summit/scenery";

interface Queries {
  sample(s: number, P: THREE.Vector3, F: THREE.Vector3, R: THREE.Vector3, U: THREE.Vector3): void;
  solidAt(s: number): boolean;
  railAt(s: number, side: 0 | 1): boolean;
}

export interface SkywayVisuals {
  root: THREE.Group;
  update(dt: number, elapsed: number, camera: THREE.Camera): void;
  dispose(): void;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROAD_GLSL_PARS = /* glsl */ `
uniform float uTime;
vec3 prismHsv(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
float prismHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
vec3 prismBand(vec2 uv) {
  float bands = 7.0;
  float b = floor(uv.x * bands);
  vec3 c = prismHsv(vec3(b / bands * 0.83, 0.8, 1.0));
  float f = fract(uv.x * bands);
  float seam = smoothstep(0.0, 0.07, f) * smoothstep(1.0, 0.93, f);
  return c * mix(0.3, 1.0, seam);
}
float prismPulse(vec2 uv) {
  float ch = fract(uv.y * 0.07 - abs(uv.x - 0.5) * 0.9 - uTime * 0.85);
  return smoothstep(0.0, 0.04, ch) * smoothstep(0.2, 0.08, ch);
}
float prismEdge(vec2 uv) {
  return smoothstep(0.04, 0.0, uv.x) + smoothstep(0.96, 1.0, uv.x);
}
float prismSpark(vec2 uv) {
  vec2 cell = floor(vec2(uv.x * 46.0, uv.y * 1.6));
  float h = prismHash(cell);
  float tw = 0.5 + 0.5 * sin(uTime * (2.0 + h * 5.0) + h * 40.0);
  return step(0.93, h) * tw * tw;
}
`;

function makeRoadMaterial(time: { value: number }): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.26,
    metalness: 0.05,
    emissive: 0xffffff,
    emissiveIntensity: 1,
  });
  mat.defines = { ...(mat.defines ?? {}), USE_UV: "" };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + ROAD_GLSL_PARS)
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\n  vec3 prismC = prismBand(vUv);\n  diffuseColor.rgb = prismC * 0.62;",
      )
      .replace(
        "#include <emissivemap_fragment>",
        [
          "#include <emissivemap_fragment>",
          "  float prismP = prismPulse(vUv);",
          "  totalEmissiveRadiance = prismC * (0.42 + prismP * 1.1) + vec3(1.0) * prismEdge(vUv) * 2.4 + vec3(1.0, 0.95, 0.9) * prismSpark(vUv) * 1.6;",
        ].join("\n"),
      );
  };
  mat.customProgramCacheKey = () => "prism-road";
  return mat;
}

function hoopColors(geo: THREE.BufferGeometry) {
  const p = geo.getAttribute("position");
  const col = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const a = Math.atan2(p.getY(i), p.getX(i));
    c.setHSL(((a / (Math.PI * 2) + 1) % 1) * 0.85, 0.9, 0.6);
    col[i * 3] = c.r * 2.2;
    col[i * 3 + 1] = c.g * 2.2;
    col[i * 3 + 2] = c.b * 2.2;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.Texture {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d");
  if (g) draw(g);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function buildSkywayVisuals(c: Course, q: Queries, quality: KartQuality): SkywayVisuals {
  const root = new THREE.Group();
  root.name = "track/Prism Skyway";
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const texs: THREE.Texture[] = [];
  const time = { value: 0 };

  const P = new THREE.Vector3();
  const F = new THREE.Vector3();
  const R = new THREE.Vector3();
  const U = new THREE.Vector3();
  const count = c.count;
  const ds = c.ds;
  const step = quality === "low" ? 2 : 1;
  const stations: number[] = [];
  for (let i = 0; i <= count; i += step) stations.push(Math.min(i, count) * ds);
  if (stations[stations.length - 1] !== c.length) stations.push(c.length);

  // --- the road ------------------------------------------------------------
  {
    const NL = 11;
    const W = HALF_WIDTH + 0.35;
    const posA: number[] = [];
    const nrmA: number[] = [];
    const uvA: number[] = [];
    const idx: number[] = [];
    const under: number[] = [];
    const underN: number[] = [];
    const underIdx: number[] = [];
    const THICK = 0.9;
    for (let k = 0; k < stations.length; k++) {
      const s = stations[k] % c.length;
      q.sample(s, P, F, R, U);
      const lift = liftAt(c, s);
      for (let j = 0; j < NL; j++) {
        const l = -W + (2 * W * j) / (NL - 1);
        posA.push(P.x + R.x * l + U.x * lift, P.y + R.y * l + U.y * lift, P.z + R.z * l + U.z * lift);
        nrmA.push(U.x, U.y, U.z);
        uvA.push(j / (NL - 1), stations[k]);
      }
      // Underside: a shallow keel so the road reads as a solid thing from below.
      const ring = [
        [-W, 0],
        [-W + 0.4, -THICK * 0.7],
        [0, -THICK],
        [W - 0.4, -THICK * 0.7],
        [W, 0],
      ];
      for (const [l, d] of ring) {
        under.push(
          P.x + R.x * l + U.x * (lift + d - 0.02),
          P.y + R.y * l + U.y * (lift + d - 0.02),
          P.z + R.z * l + U.z * (lift + d - 0.02),
        );
        const nx = R.x * Math.sign(l) * 0.6 - U.x;
        const ny = R.y * Math.sign(l) * 0.6 - U.y;
        const nz = R.z * Math.sign(l) * 0.6 - U.z;
        const n = Math.hypot(nx, ny, nz) || 1;
        underN.push(nx / n, ny / n, nz / n);
      }
    }
    for (let k = 0; k < stations.length - 1; k++) {
      const mid = (stations[k] + stations[k + 1]) * 0.5;
      if (!q.solidAt(mid)) continue;
      for (let j = 0; j < NL - 1; j++) {
        const a = k * NL + j;
        const b = (k + 1) * NL + j;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
      for (let j = 0; j < 4; j++) {
        const a = k * 5 + j;
        const b = (k + 1) * 5 + j;
        underIdx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(posA, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrmA, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvA, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mat = makeRoadMaterial(time);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = "prism/road";
    root.add(mesh);
    geos.push(geo);
    mats.push(mat);

    const ug = new THREE.BufferGeometry();
    ug.setAttribute("position", new THREE.Float32BufferAttribute(under, 3));
    ug.setAttribute("normal", new THREE.Float32BufferAttribute(underN, 3));
    ug.setIndex(underIdx);
    ug.computeBoundingSphere();
    const um = new THREE.MeshStandardMaterial({
      color: 0x241446,
      roughness: 0.35,
      metalness: 0.6,
      emissive: 0x3a1c7a,
      emissiveIntensity: 0.55,
    });
    const umesh = new THREE.Mesh(ug, um);
    umesh.name = "prism/keel";
    root.add(umesh);
    geos.push(ug);
    mats.push(um);
  }

  // --- rails ---------------------------------------------------------------
  {
    const barMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xbff4ff,
      emissiveIntensity: 2.4,
      roughness: 0.3,
      side: THREE.DoubleSide,
    });
    const glassMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    mats.push(barMat, glassMat);
    const barPos: number[] = [];
    const barIdx: number[] = [];
    const glassPos: number[] = [];
    const glassCol: number[] = [];
    const glassIdx: number[] = [];
    const posts: THREE.Matrix4[] = [];
    const SIDES = 6;
    const RAD = 0.13;
    const col = new THREE.Color();

    for (const side of [0, 1] as const) {
      const sign = side === 1 ? 1 : -1;
      let runStart = -1;
      let barBase = 0;
      let glassBase = 0;
      const flush = () => {
        runStart = -1;
      };
      for (let k = 0; k < stations.length; k++) {
        const s = stations[k] % c.length;
        const on = q.railAt(s, side) && q.solidAt(s);
        if (!on) {
          flush();
          continue;
        }
        q.sample(s, P, F, R, U);
        const lift = liftAt(c, s);
        const lat = sign * (HALF_WIDTH + RAIL_OFFSET + 0.08);
        const cx = P.x + R.x * lat + U.x * (lift + RAIL_HEIGHT);
        const cy = P.y + R.y * lat + U.y * (lift + RAIL_HEIGHT);
        const cz = P.z + R.z * lat + U.z * (lift + RAIL_HEIGHT);
        const vb = barPos.length / 3;
        for (let j = 0; j < SIDES; j++) {
          const a = (j / SIDES) * Math.PI * 2;
          const ca = Math.cos(a) * RAD;
          const sa = Math.sin(a) * RAD;
          barPos.push(cx + R.x * ca + U.x * sa, cy + R.y * ca + U.y * sa, cz + R.z * ca + U.z * sa);
        }
        const vg = glassPos.length / 3;
        const bx = P.x + R.x * lat + U.x * lift;
        const by = P.y + R.y * lat + U.y * lift;
        const bz = P.z + R.z * lat + U.z * lift;
        glassPos.push(bx, by, bz, cx, cy, cz);
        col.setHSL(((stations[k] / 90) % 1) * 0.85, 0.85, 0.55);
        glassCol.push(col.r * 0.5, col.g * 0.5, col.b * 0.5, col.r * 0.05, col.g * 0.05, col.b * 0.05);
        if (runStart >= 0) {
          for (let j = 0; j < SIDES; j++) {
            const a0 = barBase + j;
            const a1 = barBase + ((j + 1) % SIDES);
            const b0 = vb + j;
            const b1 = vb + ((j + 1) % SIDES);
            barIdx.push(a0, b0, a1, a1, b0, b1);
          }
          glassIdx.push(glassBase, vg, glassBase + 1, glassBase + 1, vg, vg + 1);
        } else runStart = k;
        barBase = vb;
        glassBase = vg;
        if (Math.round(stations[k]) % 8 === 0) {
          const m = new THREE.Matrix4().makeBasis(R, U, F);
          m.setPosition(
            P.x + R.x * lat + U.x * (lift + RAIL_HEIGHT * 0.5),
            P.y + R.y * lat + U.y * (lift + RAIL_HEIGHT * 0.5),
            P.z + R.z * lat + U.z * (lift + RAIL_HEIGHT * 0.5),
          );
          posts.push(m);
        }
      }
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.Float32BufferAttribute(barPos, 3));
    bg.setIndex(barIdx);
    bg.computeVertexNormals();
    root.add(new THREE.Mesh(bg, barMat));
    const gg = new THREE.BufferGeometry();
    gg.setAttribute("position", new THREE.Float32BufferAttribute(glassPos, 3));
    gg.setAttribute("color", new THREE.Float32BufferAttribute(glassCol, 3));
    gg.setIndex(glassIdx);
    const glass = new THREE.Mesh(gg, glassMat);
    glass.renderOrder = 2;
    root.add(glass);
    geos.push(bg, gg);

    const postGeo = new THREE.BoxGeometry(0.16, RAIL_HEIGHT, 0.16);
    const postMat = new THREE.MeshStandardMaterial({ color: 0xe8e4ff, roughness: 0.4, metalness: 0.5, emissive: 0x6a5cff, emissiveIntensity: 0.6 });
    const inst = new THREE.InstancedMesh(postGeo, postMat, Math.max(1, posts.length));
    posts.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.count = posts.length;
    root.add(inst);
    geos.push(postGeo);
    mats.push(postMat);
  }

  // --- boost pads ------------------------------------------------------------
  {
    const padMat = new THREE.ShaderMaterial({
      uniforms: { uTime: time },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          float ch = fract(vUv.y * 0.55 - abs(vUv.x - 0.5) * 0.8 - uTime * 2.2);
          float arrow = smoothstep(0.0, 0.08, ch) * smoothstep(0.45, 0.3, ch);
          float rim = smoothstep(0.08, 0.0, vUv.x) + smoothstep(0.92, 1.0, vUv.x);
          vec3 col = mix(vec3(1.0, 0.55, 0.1), vec3(1.0, 0.95, 0.4), arrow);
          gl_FragColor = vec4(col * (0.35 + arrow * 2.2 + rim * 1.2), 1.0);
        }
      `,
    });
    mats.push(padMat);
    const pos: number[] = [];
    const uv: number[] = [];
    const ix: number[] = [];
    let i = 0;
    while (i < count) {
      if (!Number.isFinite(c.boost0[i])) {
        i++;
        continue;
      }
      const start = i;
      while (i < count && Number.isFinite(c.boost0[i])) i++;
      const l0 = c.boost0[start];
      const l1 = c.boost1[start];
      for (let k = start; k <= i; k++) {
        const s = k * ds;
        q.sample(s, P, F, R, U);
        const lift = liftAt(c, s) + 0.04;
        const v0 = pos.length / 3;
        for (const l of [l0, l1]) pos.push(P.x + R.x * l + U.x * lift, P.y + R.y * l + U.y * lift, P.z + R.z * l + U.z * lift);
        uv.push(0, s - start * ds, 1, s - start * ds);
        if (k > start) ix.push(v0 - 2, v0, v0 - 1, v0 - 1, v0, v0 + 1);
      }
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    pg.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    pg.setIndex(ix);
    const pads = new THREE.Mesh(pg, padMat);
    pads.renderOrder = 3;
    root.add(pads);
    geos.push(pg);
  }

  // --- start gantry ----------------------------------------------------------
  {
    q.sample(0, P, F, R, U);
    const g = new THREE.Group();
    const basis = new THREE.Matrix4().makeBasis(R, U, F.clone().multiplyScalar(-1));
    g.quaternion.setFromRotationMatrix(basis);
    g.position.copy(P);
    const pylonMat = new THREE.MeshStandardMaterial({ color: 0x1b1238, roughness: 0.3, metalness: 0.8, emissive: 0xff3cc8, emissiveIntensity: 0.25 });
    const glowMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 2.2 });
    const pylon = new THREE.BoxGeometry(1.4, 11, 1.4);
    const strip = new THREE.BoxGeometry(0.3, 10, 0.3);
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(pylon, pylonMat);
      m.position.set(sx * (HALF_WIDTH + 2.2), 5.5, 0);
      m.castShadow = true;
      g.add(m);
      const st = new THREE.Mesh(strip, glowMat);
      st.position.set(sx * (HALF_WIDTH + 2.2) - sx * 0.6, 5.5, 0.6);
      g.add(st);
    }
    const bar = new THREE.BoxGeometry(2 * (HALF_WIDTH + 2.9), 1.6, 1.2);
    const barM = new THREE.Mesh(bar, pylonMat);
    barM.position.set(0, 10.4, 0);
    g.add(barM);
    const banner = canvasTexture(1024, 160, (ctx2) => {
      for (let x = 0; x < 1024; x += 32) {
        for (let y = 0; y < 160; y += 32) {
          ctx2.fillStyle = ((x + y) / 32) % 2 === 0 ? "#ffffff" : "#16102c";
          ctx2.fillRect(x, y, 32, 32);
        }
      }
      ctx2.fillStyle = "rgba(22,16,44,0.92)";
      ctx2.fillRect(150, 22, 724, 116);
      const grad = ctx2.createLinearGradient(170, 0, 860, 0);
      ["#ff4d6d", "#ffa94d", "#ffe066", "#69db7c", "#4dabf7", "#9775fa", "#f783ac"].forEach((col, i, a) =>
        grad.addColorStop(i / (a.length - 1), col),
      );
      ctx2.fillStyle = grad;
      ctx2.font = "900 84px system-ui, sans-serif";
      ctx2.textAlign = "center";
      ctx2.textBaseline = "middle";
      ctx2.fillText("PRISM SKYWAY", 512, 84);
    });
    texs.push(banner);
    const bannerMat = new THREE.MeshStandardMaterial({ map: banner, emissiveMap: banner, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.6 });
    const bannerGeo = new THREE.PlaneGeometry(2 * (HALF_WIDTH + 1.4), 2.6);
    for (const face of [1, -1]) {
      const b = new THREE.Mesh(bannerGeo, bannerMat);
      b.position.set(0, 8.4, face * 0.62);
      if (face < 0) b.rotation.y = Math.PI;
      g.add(b);
    }
    // The line itself: a white bar across the road.
    const lineGeo = new THREE.PlaneGeometry(2 * HALF_WIDTH, 1.2);
    const line = new THREE.Mesh(lineGeo, glowMat);
    line.rotation.x = -Math.PI / 2;
    line.position.y = 0.05;
    g.add(line);
    root.add(g);
    geos.push(pylon, strip, bar, bannerGeo, lineGeo);
    mats.push(pylonMat, glowMat, bannerMat);
  }

  // --- hoops ---------------------------------------------------------------
  {
    const hoopGeo = new THREE.TorusGeometry(HALF_WIDTH + 3.2, 0.32, 8, 72);
    hoopColors(hoopGeo);
    const hoopMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    const at = [
      c.spans.aurora.start + 60,
      c.spans.aurora.start + 140,
      c.spans.aurora.start + 220,
      c.spans.hairpin.start + 120,
      c.spans.helix.start + 120,
      c.spans.helix.start + 200,
      c.spans.helix.start + 280,
      c.spans.helix.start + 360,
    ];
    for (const s of at) {
      q.sample(s, P, F, R, U);
      const h = new THREE.Mesh(hoopGeo, hoopMat);
      const m = new THREE.Matrix4().makeBasis(R, U, F);
      h.quaternion.setFromRotationMatrix(m);
      h.position.copy(P).addScaledVector(U, 3.0);
      root.add(h);
    }
    geos.push(hoopGeo);
    mats.push(hoopMat);
  }

  // --- Vibe Summit, far below ---------------------------------------------
  // The very mountain from /summit, built by the same code, with its 5,000 ft
  // peak right under the middle of the lap.
  const grid = buildGrid();
  {
    const field = buildSnowField(grid);
    field.mesh.position.set(MOUNTAIN_OFFSET.x, 0, MOUNTAIN_OFFSET.z);
    field.mesh.name = "prism/vibe-summit";
    root.add(field.mesh);
    geos.push({ dispose: field.dispose } as unknown as THREE.BufferGeometry);

    // The rainbow beam rises off the summit deck, the way it does on the mountain.
    const sx = SUMMIT.x + MOUNTAIN_OFFSET.x - 70;
    const sz = SUMMIT.z + MOUNTAIN_OFFSET.z - 6;
    const top = 560 + ALT + 40;
    const beamGeo = new THREE.CylinderGeometry(3.2, 3.2, top - SUMMIT.y, 24, 1, true);
    const beamCol = new Float32Array(beamGeo.getAttribute("position").count * 3);
    {
      const bp = beamGeo.getAttribute("position");
      const cc = new THREE.Color();
      for (let i = 0; i < bp.count; i++) {
        cc.setHSL(((Math.atan2(bp.getZ(i), bp.getX(i)) / (Math.PI * 2) + 1) % 1) * 0.85, 0.9, 0.55);
        const fade = (0.1 + 0.3 * (bp.getY(i) / (top - SUMMIT.y) + 0.5)) * 0.8;
        beamCol[i * 3] = cc.r * fade;
        beamCol[i * 3 + 1] = cc.g * fade;
        beamCol[i * 3 + 2] = cc.b * fade;
      }
    }
    beamGeo.setAttribute("color", new THREE.BufferAttribute(beamCol, 3));
    const beamMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.set(sx, (SUMMIT.y + top) / 2, sz);
    root.add(beam);
    geos.push(beamGeo);
    mats.push(beamMat);
  }

  // --- the sky around it -----------------------------------------------------
  const spin: THREE.Object3D[] = [];
  {
    // A ringed planet low over the west, where the light is going.
    const planetTex = canvasTexture(512, 256, (g) => {
      const bands = ["#ffb3c7", "#f7a072", "#ffd6a5", "#e0b1cb", "#9d8cd8", "#cdb4db", "#ffc8dd", "#a2d2ff"];
      for (let y = 0; y < 256; y += 4) {
        const k = Math.floor((y / 256) * 40 + Math.sin(y * 0.11) * 2);
        g.fillStyle = bands[((k % bands.length) + bands.length) % bands.length];
        g.fillRect(0, y, 512, 4);
      }
    });
    texs.push(planetTex);
    const pGeo = new THREE.SphereGeometry(340, 48, 32);
    const pMat = new THREE.MeshBasicMaterial({ map: planetTex, fog: false, color: 0xb9b0d8 });
    const planet = new THREE.Mesh(pGeo, pMat);
    planet.position.set(-3400, 980 + ALT, -2600);
    planet.rotation.z = 0.35;
    root.add(planet);
    spin.push(planet);
    const ringTex = canvasTexture(512, 8, (g) => {
      for (let x = 0; x < 512; x++) {
        const a = 0.25 + 0.5 * Math.abs(Math.sin(x * 0.07)) * (x > 60 && x < 500 ? 1 : 0);
        g.fillStyle = "rgba(255,230,240," + a.toFixed(3) + ")";
        g.fillRect(x, 0, 1, 8);
      }
    });
    texs.push(ringTex);
    const rGeo = new THREE.RingGeometry(430, 720, 96, 1);
    // Map the texture radially.
    {
      const p = rGeo.getAttribute("position");
      const uvs = rGeo.getAttribute("uv");
      for (let i = 0; i < p.count; i++) {
        const r = Math.hypot(p.getX(i), p.getY(i));
        uvs.setXY(i, (r - 430) / 290, 0.5);
      }
    }
    const rMat = new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, side: THREE.DoubleSide, fog: false, depthWrite: false, color: 0xd8c8f0 });
    const ring = new THREE.Mesh(rGeo, rMat);
    ring.position.copy(planet.position);
    ring.rotation.set(-Math.PI / 2 + 0.28, 0.2, 0.35);
    root.add(ring);
    geos.push(pGeo, rGeo);
    mats.push(pMat, rMat);

    // A small moon to the south east.
    const mGeo = new THREE.SphereGeometry(90, 32, 16);
    const mMat = new THREE.MeshBasicMaterial({ color: 0xe9f1ff, fog: false });
    const moon = new THREE.Mesh(mGeo, mMat);
    moon.position.set(2800, 1300 + ALT, 2600);
    root.add(moon);
    geos.push(mGeo);
    mats.push(mMat);

    // Floating crystal islands, never close to the road.
    const rand = rng(0x9e37);
    const rockGeo = new THREE.ConeGeometry(1, 1.6, 7, 1);
    rockGeo.rotateX(Math.PI);
    rockGeo.translate(0, -0.8, 0);
    const topGeo = new THREE.CylinderGeometry(1, 1, 0.25, 7);
    const crystalGeo = new THREE.OctahedronGeometry(1, 0);
    crystalGeo.scale(0.35, 1.2, 0.35);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x3b2a5c, roughness: 0.85, flatShading: true });
    const topMat = new THREE.MeshStandardMaterial({ color: 0x8be0c8, roughness: 0.7, flatShading: true, emissive: 0x1a5f55, emissiveIntensity: 0.4 });
    const crystalMats = [0xff7bd5, 0x7bdcff, 0xc79bff, 0xffe17b].map(
      (col) => new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 1.6, roughness: 0.2, flatShading: true }),
    );
    geos.push(rockGeo, topGeo, crystalGeo);
    mats.push(rockMat, topMat, ...crystalMats);
    let placed = 0;
    for (let tries = 0; tries < 400 && placed < (quality === "low" ? 10 : 22); tries++) {
      const a = rand() * Math.PI * 2;
      const r = 120 + rand() * 520;
      const x = 60 + Math.cos(a) * r;
      const z = -40 + Math.sin(a) * r;
      const y = 470 + ALT + rand() * 170;
      const size = 9 + rand() * 22;
      let near = Infinity;
      for (let i = 0; i < count; i += 6) {
        near = Math.min(near, Math.hypot(c.pos[i * 3] - x, (c.pos[i * 3 + 1] - y) * 1.4, c.pos[i * 3 + 2] - z));
      }
      if (near < size * 1.7 + 34) continue;
      if (gridHeight(grid, x - MOUNTAIN_OFFSET.x, z - MOUNTAIN_OFFSET.z) > y - size * 2.2 - 20) continue;
      const isle = new THREE.Group();
      isle.position.set(x, y, z);
      isle.rotation.y = rand() * Math.PI * 2;
      const rock = new THREE.Mesh(rockGeo, rockMat);
      rock.scale.set(size, size * (0.9 + rand() * 0.8), size);
      isle.add(rock);
      const top = new THREE.Mesh(topGeo, topMat);
      top.scale.set(size, size * 0.4, size);
      isle.add(top);
      const n = 2 + Math.floor(rand() * 4);
      for (let k = 0; k < n; k++) {
        const cr = new THREE.Mesh(crystalGeo, crystalMats[Math.floor(rand() * crystalMats.length)]);
        const ca = rand() * Math.PI * 2;
        const cd = rand() * size * 0.6;
        const cs = size * (0.18 + rand() * 0.22);
        cr.scale.setScalar(cs);
        cr.position.set(Math.cos(ca) * cd, cs * 1.1, Math.sin(ca) * cd);
        cr.rotation.set((rand() - 0.5) * 0.5, rand() * 3, (rand() - 0.5) * 0.5);
        isle.add(cr);
      }
      isle.userData.bob = rand() * Math.PI * 2;
      isle.userData.baseY = y;
      root.add(isle);
      spin.push(isle);
      placed++;
    }

    // Aurora curtains over the north.
    const auroraMat = new THREE.ShaderMaterial({
      uniforms: { uTime: time },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          float x = vUv.x * 9.0;
          float wave = sin(x * 2.1 + uTime * 0.25) * 0.5 + sin(x * 5.3 - uTime * 0.4) * 0.25;
          float curtain = pow(0.5 + 0.5 * sin(x * 13.0 + wave * 3.0 + uTime * 0.6), 3.0);
          float fadeY = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.45, vUv.y);
          float fadeX = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x);
          vec3 col = mix(vec3(0.15, 1.0, 0.6), vec3(0.75, 0.35, 1.0), vUv.y);
          gl_FragColor = vec4(col * curtain * fadeY * fadeX * 0.55, 1.0);
        }
      `,
    });
    const aGeo = new THREE.CylinderGeometry(4200, 4200, 1400, 96, 1, true, -Math.PI * 0.78, Math.PI * 0.75);
    const aurora = new THREE.Mesh(aGeo, auroraMat);
    aurora.position.set(0, 1250 + ALT, 0);
    aurora.renderOrder = -10;
    root.add(aurora);
    geos.push(aGeo);
    mats.push(auroraMat);
  }

  return {
    root,
    update(dt, elapsed) {
      time.value = elapsed;
      for (const o of spin) {
        if (o.userData.baseY !== undefined) {
          o.position.y = o.userData.baseY + Math.sin(elapsed * 0.4 + o.userData.bob) * 1.6;
          o.rotation.y += dt * 0.03;
        } else o.rotation.y += dt * 0.01;
      }
    },
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      for (const t of texs) t.dispose();
    },
  };
}
