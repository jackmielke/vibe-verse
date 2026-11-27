/**
 * The Prism Skyway: a rainbow road high above Vibe Summit, a figure eight
 * that passes over itself above the summit deck with a 120 m gap between
 * the two decks.
 *
 * Driving happens in road space (arc length `s`, lateral offset `l`, height
 * `h` above the deck), so banking, hills and the crossing all come for free
 * and there is no collision search at all. The road is a table of frames
 * sampled once here; `frameAt` interpolates it.
 *
 * Rails run along most of both edges. Where they stop, the edge is open, and
 * driving off it is how you find out that the wingsuit was in the kart all
 * along.
 */
import * as THREE from "three";
import { SUMMIT } from "./world";

export const ROAD_W = 22;
export const SKY_Y = 2900;
const A = 1150;
const B = 1050;
const SAMPLES = 1600;

export interface Frame {
  p: THREE.Vector3;
  t: THREE.Vector3;
  r: THREE.Vector3;
  u: THREE.Vector3;
  /** Signed curvature of the horizontal path, 1/m, positive bends right. */
  k: number;
}

export interface Skyway {
  group: THREE.Group;
  length: number;
  frameAt(s: number, out?: Frame): Frame;
  /** Is there a rail at this arc length on this side (-1 left, +1 right)? */
  railAt(s: number, side: number): boolean;
  /** Is there road under you here? False across the gap. */
  deckAt(s: number): boolean;
  /** How far the deck is lifted here, in metres: the launch ramp before the gap. */
  liftAt(s: number): number;
  boosts: { s: number; l: number }[];
  stars: { s: number; l: number; mesh: THREE.Object3D; got: boolean }[];
  update(t: number): void;
  dispose(): void;
}

function centre(theta: number, out: THREE.Vector3) {
  // A Gerono lemniscate (a figure eight) over the summit, with hills.
  const x = A * Math.sin(theta);
  const z = B * Math.sin(theta) * Math.cos(theta) * 1.6;
  const y = SKY_Y + 60 * Math.cos(theta) + 38 * Math.sin(3 * theta) + 22 * Math.sin(5 * theta + 1);
  return out.set(SUMMIT.x + x, y, SUMMIT.z + z);
}

const wrap = (s: number, len: number) => ((s % len) + len) % len;

export function buildSkyway(scene: THREE.Scene): Skyway {
  const group = new THREE.Group();
  scene.add(group);
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);

  // ---- Sample the centre line and measure it -----------------------------
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= SAMPLES; i++) pts.push(centre((i / SAMPLES) * Math.PI * 2, new THREE.Vector3()));
  const sAt: number[] = [0];
  for (let i = 1; i <= SAMPLES; i++) sAt.push(sAt[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const length = sAt[SAMPLES];

  // Re-sample evenly by arc length so frame lookups are an index, not a search.
  const N = 1400;
  const step = length / N;
  const P: THREE.Vector3[] = [];
  {
    let j = 0;
    for (let i = 0; i < N; i++) {
      const s = i * step;
      while (sAt[j + 1] < s) j++;
      const f = (s - sAt[j]) / (sAt[j + 1] - sAt[j]);
      P.push(pts[j].clone().lerp(pts[j + 1], f));
    }
  }
  const T: THREE.Vector3[] = [], Rr: THREE.Vector3[] = [], U: THREE.Vector3[] = [], K: number[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < N; i++) {
    const a = P[(i - 1 + N) % N], b = P[(i + 1) % N];
    T.push(b.clone().sub(a).normalize());
  }
  for (let i = 0; i < N; i++) {
    const t0 = T[(i - 2 + N) % N], t1 = T[(i + 2) % N];
    const h0 = Math.atan2(t0.x, t0.z), h1 = Math.atan2(t1.x, t1.z);
    let dh = h1 - h0;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    // Heading measured as atan2(x, z) grows turning left (toward +x from +z), so right is negative.
    K.push(-dh / (4 * step));
  }
  // Smooth curvature, then bank into the turn.
  const Ks = K.map((_, i) => {
    let sum = 0;
    for (let d = -12; d <= 12; d++) sum += K[(i + d + N) % N];
    return sum / 25;
  });
  for (let i = 0; i < N; i++) {
    const t = T[i];
    const r = t.clone().cross(up).normalize();
    const bank = THREE.MathUtils.clamp(Ks[i] * 9000, -0.42, 0.42);
    r.applyAxisAngle(t, bank);
    const u = r.clone().cross(t).normalize();
    Rr.push(r);
    U.push(u);
  }

  const frameAt = (s: number, out?: Frame): Frame => {
    const o = out ?? { p: new THREE.Vector3(), t: new THREE.Vector3(), r: new THREE.Vector3(), u: new THREE.Vector3(), k: 0 };
    const w = wrap(s, length) / step;
    const i = Math.floor(w) % N, j = (i + 1) % N, f = w - Math.floor(w);
    o.p.copy(P[i]).lerp(P[j], f);
    o.t.copy(T[i]).lerp(T[j], f).normalize();
    o.r.copy(Rr[i]).lerp(Rr[j], f).normalize();
    o.u.copy(U[i]).lerp(U[j], f).normalize();
    o.k = Ks[i] + (Ks[j] - Ks[i]) * f;
    return o;
  };

  // ---- Features along the lap --------------------------------------------
  const GAP = { s0: length * 0.31, len: 38 };
  const RAMP = { s0: GAP.s0 - 30, len: 30 };
  // Stretches with no rail: [from, to, side], side 0 meaning both edges.
  const openEdges: [number, number, number][] = [
    [length * 0.12, length * 0.2, 1],
    [length * 0.42, length * 0.5, -1],
    [length * 0.66, length * 0.72, 0],
    [length * 0.86, length * 0.92, 1],
  ];
  const railAt = (s: number, side: number) => {
    const w = wrap(s, length);
    for (const [a, b, sd] of openEdges) if (w > a && w < b && (sd === 0 || sd === side)) return false;
    return true;
  };
  const deckAt = (s: number) => {
    const w = wrap(s, length);
    return !(w > GAP.s0 && w < GAP.s0 + GAP.len);
  };
  const liftAt = (s: number) => {
    const w = wrap(s, length);
    return w > RAMP.s0 && w < RAMP.s0 + RAMP.len ? ((w - RAMP.s0) / RAMP.len) ** 2 * 3.5 : 0;
  };

  // ---- The road surface --------------------------------------------------
  const uniforms = { uTime: { value: 0 } };
  const roadMat = keep(new THREE.ShaderMaterial({
    uniforms,
    side: THREE.DoubleSide,
    transparent: true,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      vec3 hue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
      float h21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        float across = vUv.x;
        float band = floor(across * 7.0) / 7.0;
        vec3 col = mix(hue(band * 0.86), vec3(1.0), 0.18);
        // Soft seams between the bands.
        float seam = abs(fract(across * 7.0) - 0.5);
        col *= 0.82 + 0.18 * smoothstep(0.5, 0.42, seam);
        // Light chevrons running forward.
        float along = vUv.y;
        float chev = fract(along * 0.25 - abs(across - 0.5) * 0.6 - uTime * 0.9);
        col += vec3(1.0) * smoothstep(0.92, 1.0, chev) * 0.35;
        // Glitter.
        vec2 g = floor(vec2(across * 90.0, along * 30.0));
        float sp = h21(g + floor(uTime * 6.0));
        col += vec3(1.0) * step(0.985, sp) * 0.8;
        // Bright edges.
        float edge = smoothstep(0.035, 0.0, min(across, 1.0 - across));
        col = mix(col, vec3(1.0), edge);
        gl_FragColor = vec4(col, 0.94);
      }
    `,
  }));
  {
    const verts: number[] = [];
    const uvs: number[] = [];
    const idx: number[] = [];
    const ACROSS = 8;
    const f: Frame = { p: new THREE.Vector3(), t: new THREE.Vector3(), r: new THREE.Vector3(), u: new THREE.Vector3(), k: 0 };
    const segs: [number, number][] = [[GAP.s0 + GAP.len, length + GAP.s0]];
    for (const [a, b] of segs) {
      const n = Math.ceil((b - a) / 6);
      const base = verts.length / 3;
      for (let i = 0; i <= n; i++) {
        const s = a + ((b - a) * i) / n;
        frameAt(s, f);
        // The ramp lifts the deck before the gap.
        const lift = liftAt(s);
        for (let j = 0; j <= ACROSS; j++) {
          const l = (j / ACROSS - 0.5) * ROAD_W;
          verts.push(f.p.x + f.r.x * l + f.u.x * lift, f.p.y + f.r.y * l + f.u.y * lift, f.p.z + f.r.z * l + f.u.z * lift);
          uvs.push(j / ACROSS, s / ROAD_W);
        }
      }
      for (let i = 0; i < n; i++) for (let j = 0; j < ACROSS; j++) {
        const a0 = base + i * (ACROSS + 1) + j, b0 = a0 + 1, c0 = a0 + ACROSS + 1, d0 = c0 + 1;
        idx.push(a0, c0, b0, b0, c0, d0);
      }
    }
    const g = keep(new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    const road = new THREE.Mesh(g, roadMat);
    road.frustumCulled = false;
    group.add(road);

    // Rails: low glowing walls where the edge is guarded.
    const railVerts: number[] = [];
    const railIdx: number[] = [];
    for (const side of [-1, 1]) {
      let run: number[] | null = null;
      const flush = () => {
        if (!run || run.length < 2) { run = null; return; }
        const base = railVerts.length / 3;
        for (const s of run) {
          frameAt(s, f);
          const l = side * (ROAD_W / 2 + 0.3);
          for (const hh of [0, 1.1]) railVerts.push(f.p.x + f.r.x * l + f.u.x * hh, f.p.y + f.r.y * l + f.u.y * hh, f.p.z + f.r.z * l + f.u.z * hh);
        }
        for (let i = 0; i < run.length - 1; i++) {
          const a0 = base + i * 2;
          railIdx.push(a0, a0 + 1, a0 + 2, a0 + 2, a0 + 1, a0 + 3);
        }
        run = null;
      };
      for (let s = 0; s <= length; s += 8) {
        if (railAt(s, side) && deckAt(s)) { (run ??= []).push(s); } else flush();
      }
      flush();
    }
    const rg = keep(new THREE.BufferGeometry());
    rg.setAttribute("position", new THREE.Float32BufferAttribute(railVerts, 3));
    rg.setIndex(railIdx);
    const rail = new THREE.Mesh(rg, keep(new THREE.MeshBasicMaterial({ color: "#fff6ff", transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, toneMapped: false })));
    rail.frustumCulled = false;
    group.add(rail);
  }

  // ---- Start arch, boost pads, stars -------------------------------------
  const f0 = frameAt(0);
  {
    const archMat = keep(new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false }));
    const c = document.createElement("canvas");
    c.width = 512; c.height = 64;
    const g = c.getContext("2d")!;
    for (let i = 0; i < 32; i++) for (let j = 0; j < 4; j++) {
      g.fillStyle = (i + j) % 2 ? "#111" : "#fff";
      g.fillRect(i * 16, j * 16, 16, 16);
    }
    const tex = keep(new THREE.CanvasTexture(c));
    const arch = new THREE.Group();
    const top = new THREE.Mesh(keep(new THREE.BoxGeometry(ROAD_W + 4, 2, 1)), keep(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })));
    top.position.y = 9;
    arch.add(top);
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(keep(new THREE.BoxGeometry(1, 10, 1)), archMat);
      post.position.set(s * (ROAD_W / 2 + 1.5), 5, 0);
      arch.add(post);
    }
    arch.position.copy(f0.p);
    arch.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f0.r, f0.u, f0.t));
    group.add(arch);
  }

  const boosts: { s: number; l: number }[] = [];
  const boostGeo = keep(new THREE.PlaneGeometry(6, 8));
  const boostTex = (() => {
    const c = document.createElement("canvas");
    c.width = 64; c.height = 96;
    const g = c.getContext("2d")!;
    g.fillStyle = "rgba(0,0,0,0)";
    g.fillRect(0, 0, 64, 96);
    g.strokeStyle = "#fff";
    g.lineWidth = 10;
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      g.moveTo(8, 80 - k * 28);
      g.lineTo(32, 56 - k * 28);
      g.lineTo(56, 80 - k * 28);
      g.stroke();
    }
    return keep(new THREE.CanvasTexture(c));
  })();
  const boostMat = keep(new THREE.MeshBasicMaterial({ map: boostTex, color: "#ffe14d", transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
  const boostAt = [0.05, 0.17, 0.25, 0.38, 0.55, 0.63, 0.78, 0.9];
  boostAt.forEach((u, i) => {
    const s = u * length, l = ((i % 3) - 1) * 6;
    boosts.push({ s, l });
    const f = frameAt(s);
    const m = new THREE.Mesh(boostGeo, boostMat);
    m.position.copy(f.p).addScaledVector(f.r, l).addScaledVector(f.u, 0.06);
    // Plane faces +z; lay it flat with its "up" (the chevron tip) along the road.
    m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.r.clone().negate(), f.t, f.u));
    group.add(m);
  });

  const stars: Skyway["stars"] = [];
  {
    const shape = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
      const r = i % 2 ? 0.7 : 1.6;
      if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    const sg = keep(new THREE.ExtrudeGeometry(shape, { depth: 0.4, bevelEnabled: false }));
    sg.translate(0, 0, -0.2);
    const sm = keep(new THREE.MeshBasicMaterial({ color: "#ffe14d", toneMapped: false }));
    for (let i = 0; i < 60; i++) {
      const s = ((i + 0.5) / 60) * length;
      if (!deckAt(s)) continue;
      const l = Math.sin(i * 1.3) * 7;
      const f = frameAt(s);
      const m = new THREE.Mesh(sg, sm);
      m.position.copy(f.p).addScaledVector(f.r, l).addScaledVector(f.u, 1.6);
      group.add(m);
      stars.push({ s, l, mesh: m, got: false });
    }
  }

  // Big floating decorations: rings of light the road threads through.
  {
    const hoopMat = keep(new THREE.MeshBasicMaterial({ color: "#c7a6ff", transparent: true, opacity: 0.5, toneMapped: false, depthWrite: false }));
    const hoopGeo = keep(new THREE.TorusGeometry(ROAD_W * 0.9, 0.6, 6, 48));
    for (let i = 0; i < 14; i++) {
      const s = ((i + 0.25) / 14) * length;
      const f = frameAt(s);
      const m = new THREE.Mesh(hoopGeo, hoopMat);
      m.position.copy(f.p).addScaledVector(f.u, 4);
      m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.r, f.u, f.t));
      group.add(m);
    }
  }

  return {
    group,
    length,
    frameAt,
    railAt,
    deckAt,
    liftAt,
    boosts,
    stars,
    update(t) {
      uniforms.uTime.value = t;
      for (const st of stars) {
        st.mesh.visible = !st.got;
        st.mesh.rotation.y = t * 2 + st.s;
      }
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
      scene.remove(group);
    },
  };
}
