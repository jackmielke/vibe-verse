/**
 * Vibe Commons — two blocks of green on the west side of town: a five-a-side
 * soccer pitch with a ball you can actually play, and a lush garden with a
 * pond, a fountain, flower beds and more trees than the rest of the district
 * put together.
 *
 * The ball is a little physics toy of its own: walk or run into it and it is
 * kicked the way you were going, harder the faster you were moving. It
 * bounces off the posts and the low fence, and a ball over the goal line
 * between the posts is a goal, which the scoreboard counts.
 */
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";
import { canvas, merge, rng, signTexture, solid, tex } from "./common";
import { buildMatch, MATCH_RUN_CAP, type MatchEvent, type MatchHuman, type MatchUi } from "./match";

export interface Park {
  group: THREE.Group;
  /** The pitch's centre, for "take me to the soccer field". */
  pitch: THREE.Vector3;
  garden: THREE.Vector3;
  update(
    dt: number,
    now: number,
    player: THREE.Vector3,
    busy: boolean,
  ): { goal: "home" | "away" | null; place: THREE.Vector3 | null; events: MatchEvent[] };
  score(): [number, number];
  /** Where E starts a match: beside the scoreboard. */
  matchSpot: THREE.Vector3;
  startMatch(): MatchEvent;
  matchUi(): MatchUi | null;
  /** E during a match. */
  shoot(): boolean;
  canShoot(): boolean;
  /** A match is on and you are in it: your top speed, m/s. */
  speedCap(): number | null;
  devMatch(op?: string, arg?: number): unknown;
  /** Dev: put the ball somewhere with a velocity. */
  kick(x: number, z: number, vx: number, vz: number): void;
  ball(): number[];
  dispose(): void;
}

const PL = 24; // pitch length (x)
const PW = 15; // pitch width (z)
const GOAL_W = 4.2;
const GOAL_H = 1.9;
const BALL_R = 0.24;
const FENCE_X = 13.2;
const FENCE_Z = 9.4;

function pitchTexture() {
  const W = 1024;
  const H = Math.round((W * (PW + 3)) / (PL + 3));
  const { c, x } = canvas(W, H);
  // Mowing stripes.
  const stripes = 12;
  for (let i = 0; i < stripes; i++) {
    x.fillStyle = i % 2 ? "#3f9a3c" : "#358a34";
    x.fillRect((i * W) / stripes, 0, W / stripes + 1, H);
  }
  const sx = W / (PL + 3);
  const sz = H / (PW + 3);
  const X = (m: number) => (m + (PL + 3) / 2) * sx;
  const Z = (m: number) => (m + (PW + 3) / 2) * sz;
  x.strokeStyle = "rgba(255,255,255,0.92)";
  x.lineWidth = 5;
  x.strokeRect(X(-PL / 2), Z(-PW / 2), PL * sx, PW * sz);
  x.beginPath();
  x.moveTo(X(0), Z(-PW / 2));
  x.lineTo(X(0), Z(PW / 2));
  x.stroke();
  x.beginPath();
  x.arc(X(0), Z(0), 2.6 * sx, 0, Math.PI * 2);
  x.stroke();
  x.fillStyle = "#fff";
  x.beginPath();
  x.arc(X(0), Z(0), 5, 0, Math.PI * 2);
  x.fill();
  for (const s of [-1, 1]) {
    // Penalty area as a D, the five-a-side way.
    x.beginPath();
    x.arc(X((s * PL) / 2), Z(0), 5 * sx, s > 0 ? Math.PI / 2 : -Math.PI / 2, s > 0 ? (3 * Math.PI) / 2 : Math.PI / 2);
    x.stroke();
    x.beginPath();
    x.arc(X(s * (PL / 2 - 3.6)), Z(0), 5, 0, Math.PI * 2);
    x.fill();
  }
  return tex(c, false);
}

function netTexture() {
  const { c, x } = canvas(128);
  x.clearRect(0, 0, 128, 128);
  x.strokeStyle = "#fff";
  x.lineWidth = 3;
  for (let k = 0; k <= 128; k += 16) {
    x.beginPath();
    x.moveTo(k, 0);
    x.lineTo(k, 128);
    x.moveTo(0, k);
    x.lineTo(128, k);
    x.stroke();
  }
  return tex(c, true, false);
}

export function buildPark(opts: { boxes: WorldBox[]; pitchAt: { x: number; z: number }; gardenAt: { x: number; z: number }; lowDetail: boolean }): Park {
  const { boxes } = opts;
  const group = new THREE.Group();
  group.name = "vibe-commons";
  const trash: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(t: T) => (trash.push(t), t);
  const P = opts.pitchAt;
  const G = opts.gardenAt;

  // ---- The pitch -------------------------------------------------------------
  const pitch = new THREE.Group();
  pitch.position.set(P.x, 0, P.z);
  group.add(pitch);
  {
    const g = new THREE.PlaneGeometry(PL + 3, PW + 3);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.045, 0);
    const m = keep(new THREE.MeshStandardMaterial({ map: keep(pitchTexture()), roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -10 }));
    const mesh = new THREE.Mesh(keep(g), m);
    mesh.receiveShadow = true;
    pitch.add(mesh);
  }
  const white = keep(new THREE.MeshStandardMaterial({ color: "#f4f6f7", roughness: 0.4, metalness: 0.2 }));
  const netMat = keep(new THREE.MeshStandardMaterial({ color: "#ffffff", alphaMap: keep(netTexture()), alphaTest: 0.4, transparent: false, side: THREE.DoubleSide }));
  /** Goal posts, as circles the ball bounces off: [x, z] in pitch space. */
  const posts: Array<[number, number]> = [];
  for (const s of [-1, 1]) {
    const gx = (s * PL) / 2;
    const frame: THREE.BufferGeometry[] = [];
    for (const pz of [-GOAL_W / 2, GOAL_W / 2]) {
      const p = new THREE.CylinderGeometry(0.07, 0.07, GOAL_H, 8);
      p.translate(gx, GOAL_H / 2, pz);
      frame.push(p);
      posts.push([gx, pz]);
    }
    const bar = new THREE.CylinderGeometry(0.07, 0.07, GOAL_W, 8);
    bar.rotateX(Math.PI / 2);
    bar.translate(gx, GOAL_H, 0);
    frame.push(bar);
    pitch.add(new THREE.Mesh(keep(merge(frame)), white));
    // Net: back, top and two sides.
    const depth = 1.3;
    const nets: THREE.BufferGeometry[] = [];
    const back = new THREE.PlaneGeometry(GOAL_W, GOAL_H);
    back.rotateY(Math.PI / 2);
    back.translate(gx + s * depth, GOAL_H / 2, 0);
    const top = new THREE.PlaneGeometry(depth, GOAL_W);
    top.rotateX(-Math.PI / 2);
    top.translate(gx + (s * depth) / 2, GOAL_H, 0);
    nets.push(back, top);
    for (const pz of [-GOAL_W / 2, GOAL_W / 2]) {
      const side = new THREE.PlaneGeometry(depth, GOAL_H);
      side.translate(gx + (s * depth) / 2, GOAL_H / 2, pz);
      nets.push(side);
    }
    const scale = (g: THREE.BufferGeometry, w: number, h: number) => {
      const uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w * 3, uv.getY(i) * h * 3);
    };
    scale(back, GOAL_W, GOAL_H);
    scale(top, depth, GOAL_W);
    nets.slice(2).forEach((n) => scale(n, depth, GOAL_H));
    pitch.add(new THREE.Mesh(keep(merge(nets)), netMat));
  }
  // A low fence round the pitch, gaps at the corners to walk in.
  {
    const wood = keep(new THREE.MeshStandardMaterial({ color: "#e8e1d0", roughness: 0.7 }));
    const parts: THREE.BufferGeometry[] = [];
    const rail = (x0: number, z0: number, x1: number, z1: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      for (const h of [0.35, 0.75]) {
        const g = new THREE.BoxGeometry(len, 0.08, 0.06);
        g.rotateY(-Math.atan2(z1 - z0, x1 - x0));
        g.translate((x0 + x1) / 2, h, (z0 + z1) / 2);
        parts.push(g);
      }
      const n = Math.max(2, Math.round(len / 2));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const g = new THREE.BoxGeometry(0.1, 0.85, 0.1);
        g.translate(x0 + (x1 - x0) * t, 0.42, z0 + (z1 - z0) * t);
        parts.push(g);
      }
    };
    const gap = 2.2;
    rail(-FENCE_X + gap, FENCE_Z, FENCE_X - gap, FENCE_Z);
    rail(-FENCE_X + gap, -FENCE_Z, FENCE_X - gap, -FENCE_Z);
    rail(FENCE_X, -FENCE_Z + gap, FENCE_X, FENCE_Z - gap);
    rail(-FENCE_X, -FENCE_Z + gap, -FENCE_X, FENCE_Z - gap);
    pitch.add(new THREE.Mesh(keep(merge(parts)), wood));
  }
  // Scoreboard on the north side, facing the pitch.
  const board = canvas(512, 192);
  const boardTex = keep(tex(board.c, false));
  const drawBoard = (h: number, a: number, sub?: string) => {
    const x = board.x;
    x.fillStyle = "#0b1a12";
    x.fillRect(0, 0, 512, 192);
    x.strokeStyle = "#2dd4a8";
    x.lineWidth = 6;
    x.strokeRect(6, 6, 500, 180);
    x.fillStyle = "#7dfce0";
    x.font = "700 30px Georgia, serif";
    x.textAlign = "center";
    x.fillText(sub ? "COMMONS  v  ROVERS" : "VIBE COMMONS FC", 256, 44);
    x.font = `700 ${sub ? 80 : 96}px ui-monospace, monospace`;
    x.fillStyle = "#ffd27a";
    x.fillText(`${h} – ${a}`, 256, sub ? 128 : 150);
    if (sub) {
      x.font = "700 34px ui-monospace, monospace";
      x.fillStyle = "#7dfce0";
      x.fillText(sub, 256, 172);
    }
    boardTex.needsUpdate = true;
  };
  drawBoard(0, 0);
  {
    const sign = new THREE.Mesh(keep(new THREE.PlaneGeometry(4, 1.5)), keep(new THREE.MeshBasicMaterial({ map: boardTex, side: THREE.DoubleSide })));
    sign.position.set(0, 3.1, -FENCE_Z - 0.6);
    pitch.add(sign);
    const legs: THREE.BufferGeometry[] = [];
    for (const sx of [-1.7, 1.7]) {
      const g = new THREE.BoxGeometry(0.14, 2.4, 0.14);
      g.translate(sx, 1.2, -FENCE_Z - 0.65);
      legs.push(g);
    }
    pitch.add(new THREE.Mesh(keep(merge(legs)), white));
  }
  // Benches either side of halfway.
  const benchMat = keep(new THREE.MeshStandardMaterial({ color: "#7a4b2a", roughness: 0.7 }));
  const bench = (x: number, z: number, rot: number, parent: THREE.Object3D, worldX: number, worldZ: number) => {
    const parts: THREE.BufferGeometry[] = [];
    const seat = new THREE.BoxGeometry(2.2, 0.08, 0.5);
    seat.translate(0, 0.48, 0);
    const back = new THREE.BoxGeometry(2.2, 0.45, 0.06);
    back.translate(0, 0.8, -0.24);
    parts.push(seat, back);
    for (const lx of [-0.95, 0.95]) {
      const l = new THREE.BoxGeometry(0.08, 0.48, 0.45);
      l.translate(lx, 0.24, 0);
      parts.push(l);
    }
    const m = new THREE.Mesh(keep(merge(parts)), benchMat);
    m.position.set(x, 0, z);
    m.rotation.y = rot;
    m.castShadow = true;
    parent.add(m);
    const w = Math.abs(Math.cos(rot)) * 2.2 + Math.abs(Math.sin(rot)) * 0.5;
    const d = Math.abs(Math.sin(rot)) * 2.2 + Math.abs(Math.cos(rot)) * 0.5;
    solid(boxes, worldX + x, worldZ + z, w, d, 0, 0.5);
  };
  bench(-5, FENCE_Z + 1.4, Math.PI, pitch, P.x, P.z);
  bench(5, FENCE_Z + 1.4, Math.PI, pitch, P.x, P.z);

  // ---- The ball ------------------------------------------------------------------
  const ballTex = (() => {
    const { c, x } = canvas(256, 128);
    x.fillStyle = "#ffffff";
    x.fillRect(0, 0, 256, 128);
    x.fillStyle = "#111";
    const r = rng(10);
    for (let i = 0; i < 12; i++) {
      const cx = (i % 6) * 44 + 22 + (Math.floor(i / 6) ? 22 : 0);
      const cy = Math.floor(i / 6) ? 92 : 36;
      x.beginPath();
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 + r() * 0.2;
        const px = cx + Math.cos(a) * 12;
        const py = cy + Math.sin(a) * 12;
        if (k) x.lineTo(px, py);
        else x.moveTo(px, py);
      }
      x.fill();
    }
    return keep(tex(c, false));
  })();
  const ball = new THREE.Mesh(keep(new THREE.SphereGeometry(BALL_R, 18, 12)), keep(new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.5 })));
  ball.castShadow = true;
  pitch.add(ball);
  const b = { x: 0, y: BALL_R, z: 0, vx: 0, vy: 0, vz: 0 };
  const spin = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  let score: [number, number] = [0, 0];
  let resetIn = 0;
  const lastPlayer = new THREE.Vector3(1e9, 0, 0);

  // ---- The match -----------------------------------------------------------------
  const match = buildMatch({ parent: pitch, dims: { PL, PW, GOAL_W, BALL_R }, keep });
  const human: MatchHuman = { x: 0, z: 0, vx: 0, vz: 0, present: false };
  let boardKey = "";
  const refreshBoard = () => {
    const u = match.ui();
    const key = u ? `${u.home}-${u.away}-${u.clock}-${u.phase}` : `free-${score[0]}-${score[1]}`;
    if (key === boardKey) return;
    boardKey = key;
    if (u) drawBoard(u.home, u.away, u.phase === "over" ? "FULL TIME" : u.clock);
    else drawBoard(score[0], score[1]);
  };

  // ---- The garden --------------------------------------------------------------------
  const garden = new THREE.Group();
  garden.position.set(G.x, 0, G.z);
  group.add(garden);
  const waterMat = keep(new THREE.MeshStandardMaterial({ color: "#3d8fb8", roughness: 0.08, metalness: 0.35, transparent: true, opacity: 0.85 }));
  const stone = keep(new THREE.MeshStandardMaterial({ color: "#cdc6b8", roughness: 0.85 }));
  {
    // Winding gravel path, as a ring with a cross through it.
    const { c, x } = canvas(512);
    x.clearRect(0, 0, 512, 512);
    x.strokeStyle = "#d9c9a3";
    x.lineCap = "round";
    x.lineWidth = 44;
    x.beginPath();
    x.arc(256, 256, 170, 0, Math.PI * 2);
    x.stroke();
    x.beginPath();
    x.moveTo(256, 0);
    x.bezierCurveTo(200, 120, 320, 140, 256, 256);
    x.moveTo(0, 256);
    x.bezierCurveTo(120, 300, 140, 200, 256, 256);
    x.moveTo(512, 256);
    x.bezierCurveTo(400, 210, 380, 320, 256, 256);
    x.moveTo(256, 512);
    x.bezierCurveTo(300, 400, 210, 380, 256, 256);
    x.stroke();
    const t = keep(tex(c, false));
    const g = new THREE.PlaneGeometry(27, 27);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.04, 0);
    const m = keep(new THREE.MeshStandardMaterial({ map: t, transparent: true, alphaTest: 0.3, roughness: 1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -10 }));
    const mesh = new THREE.Mesh(keep(g), m);
    mesh.receiveShadow = true;
    garden.add(mesh);
  }
  // Pond with a stone rim and a three-tier fountain.
  const POND_R = 4.6;
  {
    const rim = new THREE.TorusGeometry(POND_R, 0.35, 8, 40);
    rim.rotateX(Math.PI / 2);
    rim.translate(0, 0.3, 0);
    garden.add(new THREE.Mesh(keep(rim), stone));
    const w = new THREE.CircleGeometry(POND_R, 40);
    w.rotateX(-Math.PI / 2);
    w.translate(0, 0.22, 0);
    garden.add(new THREE.Mesh(keep(w), waterMat));
    const tiers: THREE.BufferGeometry[] = [];
    const col = new THREE.CylinderGeometry(0.28, 0.4, 2.2, 12);
    col.translate(0, 1.1, 0);
    tiers.push(col);
    for (const [r, y] of [
      [1.8, 1.0],
      [1.1, 1.7],
      [0.6, 2.3],
    ]) {
      const bowl = new THREE.CylinderGeometry(r, r * 0.7, 0.25, 20);
      bowl.translate(0, y, 0);
      tiers.push(bowl);
    }
    garden.add(new THREE.Mesh(keep(merge(tiers)), stone));
    // Rim is waist-high collision; the water itself you can wade into.
    solid(boxes, G.x, G.z, 1.2, 1.2, 0, 2.4);
  }
  // Fountain spray: points arcing out and falling back, animated in place.
  const JETS = opts.lowDetail ? 120 : 260;
  const jetPos = new Float32Array(JETS * 3);
  const jetSeed = new Float32Array(JETS * 2);
  {
    const r = rng(42);
    for (let i = 0; i < JETS; i++) {
      jetSeed[i * 2] = r() * Math.PI * 2;
      jetSeed[i * 2 + 1] = r();
    }
  }
  const jetGeo = keep(new THREE.BufferGeometry());
  jetGeo.setAttribute("position", new THREE.BufferAttribute(jetPos, 3));
  const jets = new THREE.Points(jetGeo, keep(new THREE.PointsMaterial({ color: "#dff4ff", size: 0.14, transparent: true, opacity: 0.85, depthWrite: false })));
  jets.frustumCulled = false;
  garden.add(jets);

  // Lush trees: round crowns in four greens, clustered round the edges, and
  // flower beds in the gaps.
  {
    const r = rng(77);
    const crowns: THREE.Matrix4[] = [];
    const trunks: THREE.Matrix4[] = [];
    const colors: THREE.Color[] = [];
    const greens = ["#2f7d32", "#3d9440", "#256b2c", "#4caf50", "#1f5f2a"].map((c) => new THREE.Color(c));
    const M = new THREE.Matrix4();
    const S = new THREE.Vector3();
    const Q = new THREE.Quaternion();
    const plant = (x: number, z: number, big: number) => {
      const h = 2.4 + r() * 2 * big;
      const cr = (1.6 + r() * 1.3) * big;
      M.compose(new THREE.Vector3(x, h / 2, z), Q.identity(), S.set(1, h, 1));
      trunks.push(M.clone());
      M.compose(new THREE.Vector3(x, h + cr * 0.55, z), Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6), S.set(cr, cr * (0.85 + r() * 0.3), cr));
      crowns.push(M.clone());
      colors.push(greens[Math.floor(r() * greens.length)]);
    };
    const N = opts.lowDetail ? 26 : 44;
    for (let i = 0; i < N; i++) {
      const a = r() * Math.PI * 2;
      const rad = 8.5 + r() * 4.5;
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      // Keep the four paths clear where they meet the edge.
      const nearPath = Math.min(Math.abs(x), Math.abs(z)) < 2.4 && Math.max(Math.abs(x), Math.abs(z)) > 9;
      if (nearPath || Math.abs(Math.hypot(x, z) - 10.6) < 1.3) continue;
      plant(x, z, 1);
    }
    // And a few along the pitch's long sides, for shade.
    for (const sx of [-10, -3.5, 3.5, 10]) {
      plant(P.x - G.x + sx, P.z - G.z + FENCE_Z + 3.4, 0.85);
      plant(P.x - G.x + sx + 1.5, P.z - G.z - FENCE_Z - 3.2, 0.85);
    }
    const crownGeo = keep(new THREE.IcosahedronGeometry(1, 1));
    const trunkGeo = keep(new THREE.CylinderGeometry(0.16, 0.24, 1, 7));
    trunkGeo.translate(0, 0, 0);
    const crownMesh = new THREE.InstancedMesh(crownGeo, keep(new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true })), crowns.length);
    const trunkMesh = new THREE.InstancedMesh(trunkGeo, keep(new THREE.MeshStandardMaterial({ color: "#6b4a2f", roughness: 0.9 })), trunks.length);
    crowns.forEach((m, i) => {
      crownMesh.setMatrixAt(i, m);
      crownMesh.setColorAt(i, colors[i]);
    });
    trunks.forEach((m, i) => trunkMesh.setMatrixAt(i, m));
    crownMesh.castShadow = trunkMesh.castShadow = true;
    garden.add(crownMesh, trunkMesh);
    trash.push({ dispose: () => (crownMesh.dispose(), trunkMesh.dispose()) });

    // Flower beds: little blobs of colour in rings round the pond.
    const blooms: THREE.Matrix4[] = [];
    const bloomCol: THREE.Color[] = [];
    const palette = ["#ff6b9a", "#ffd23f", "#ffffff", "#b388ff", "#ff8a3d", "#ff3b3b"].map((c) => new THREE.Color(c));
    const F = opts.lowDetail ? 160 : 340;
    for (let i = 0; i < F; i++) {
      const a = r() * Math.PI * 2;
      const rad = POND_R + 0.9 + r() * 2.2;
      const s = 0.14 + r() * 0.12;
      M.compose(new THREE.Vector3(Math.cos(a) * rad, 0.12 + r() * 0.25, Math.sin(a) * rad), Q.identity(), S.set(s, s, s));
      blooms.push(M.clone());
      // Beds in colour runs, not confetti.
      bloomCol.push(palette[Math.floor(((a / (Math.PI * 2)) * 8 + r() * 0.3) % palette.length)]);
    }
    const bloomMesh = new THREE.InstancedMesh(keep(new THREE.IcosahedronGeometry(1, 0)), keep(new THREE.MeshStandardMaterial({ roughness: 0.6 })), blooms.length);
    blooms.forEach((m, i) => {
      bloomMesh.setMatrixAt(i, m);
      bloomMesh.setColorAt(i, bloomCol[i]);
    });
    garden.add(bloomMesh);
    // Hedge ring between the beds and the path.
    const hedge = new THREE.TorusGeometry(POND_R + 3.5, 0.45, 6, 48, Math.PI * 2);
    hedge.rotateX(Math.PI / 2);
    hedge.scale(1, 1.4, 1);
    hedge.translate(0, 0.35, 0);
    const hm = new THREE.Mesh(keep(hedge), keep(new THREE.MeshStandardMaterial({ color: "#2e6b30", roughness: 0.9, flatShading: true })));
    hm.castShadow = true;
    garden.add(hm);
    trash.push({ dispose: () => bloomMesh.dispose() });
    for (const a of [0.6, 2.2, 3.8, 5.3]) bench(Math.cos(a) * 9.2, Math.sin(a) * 9.2, -a - Math.PI / 2, garden, G.x, G.z);
  }
  {
    const sign = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(4.4, 1.1)),
      keep(
        new THREE.MeshBasicMaterial({
          map: keep(signTexture([{ text: "VIBE COMMONS", size: 110, color: "#ffffff" }, { text: "PARK · GARDENS · SOCCER", size: 46, color: "#bff5d8", font: "600" }], "#1f5f2a", 1280, 320, "#ffd27a")),
          side: THREE.DoubleSide,
        }),
      ),
    );
    sign.position.set(0, 1.7, 13.4);
    garden.add(sign);
  }

  const ballWorld = () => [P.x + b.x, b.y, P.z + b.z];
  return {
    group,
    pitch: new THREE.Vector3(P.x, 0, P.z + 4),
    garden: new THREE.Vector3(G.x, 0, G.z + 11),
    score: () => score,
    ball: ballWorld,
    // By the scoreboard, just inside the fence.
    matchSpot: new THREE.Vector3(P.x, 0, P.z - FENCE_Z + 1.2),
    startMatch: () => {
      resetIn = 0;
      return match.start(b);
    },
    matchUi: () => match.ui(),
    shoot: () => match.shoot(b, human),
    canShoot: () => match.canShoot(b, human),
    speedCap: () => (match.live() && human.present ? MATCH_RUN_CAP : null),
    devMatch(op, arg) {
      if (op === "start") match.start(b);
      else if (op === "stop") match.stop();
      else if (op === "clock") match.devClock(arg ?? 0);
      else if (op === "shoot") return match.shoot(b, human);
      return { ...match.dev(), ball: ballWorld(), human: { ...human } };
    },
    kick(x, z, vx, vz) {
      b.x = x - P.x;
      b.z = z - P.z;
      b.y = BALL_R;
      b.vx = vx;
      b.vz = vz;
      b.vy = 0;
    },
    update(dt, now, player, busy) {
      const t = now / 1000;
      // Fountain.
      for (let i = 0; i < JETS; i++) {
        const a = jetSeed[i * 2];
        const ph = (t * 0.6 + jetSeed[i * 2 + 1]) % 1;
        const tier = i % 3;
        const r0 = [0.6, 1.1, 1.8][tier];
        const y0 = [2.4, 1.8, 1.1][tier];
        const out = r0 + ph * (1.2 + tier * 0.5);
        jetPos[i * 3] = Math.cos(a) * out;
        jetPos[i * 3 + 1] = y0 + ph * 1.6 - ph * ph * (2.6 + tier * 0.6);
        jetPos[i * 3 + 2] = Math.sin(a) * out;
      }
      (jetGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;

      // Ball.
      let goal: "home" | "away" | null = null;
      const step = Math.min(dt, 0.05);
      const px = player.x - P.x;
      const pz = player.z - P.z;
      const pvx = lastPlayer.x < 1e8 ? (player.x - lastPlayer.x) / Math.max(dt, 1e-3) : 0;
      const pvz = lastPlayer.x < 1e8 ? (player.z - lastPlayer.z) / Math.max(dt, 1e-3) : 0;
      lastPlayer.copy(player);
      const live = match.live();
      human.x = px;
      human.z = pz;
      human.vx = pvx;
      human.vz = pvz;
      human.present = !busy && player.y < 1.2 && player.y > -0.5 && Math.abs(px) < FENCE_X + 1 && Math.abs(pz) < FENCE_Z + 1;
      if (resetIn > 0 && !live) {
        resetIn -= dt;
        if (resetIn <= 0) Object.assign(b, { x: 0, y: BALL_R + 2, z: 0, vx: 0, vy: 0, vz: 0 });
      }
      const dx = b.x - px;
      const dz = b.z - pz;
      const d = Math.hypot(dx, dz);
      if (!busy && d < 0.7 && player.y < b.y + 0.6 && player.y > -0.5) {
        const pv = Math.min(12, Math.hypot(pvx, pvz));
        const nx = d > 1e-4 ? dx / d : 1;
        const nz = d > 1e-4 ? dz / d : 0;
        // Toward the way you were going, a little toward where it was hit.
        // In a match it is a dribble: the ball stays a stride ahead of you.
        const kick = live ? 1.4 + pv * 1.12 : 3.5 + pv * 1.15;
        if (live) match.touched();
        const dirx = pv > 0.5 ? (pvx / pv) * 0.7 + nx * 0.3 : nx;
        const dirz = pv > 0.5 ? (pvz / pv) * 0.7 + nz * 0.3 : nz;
        const l = Math.hypot(dirx, dirz) || 1;
        b.vx = (dirx / l) * kick;
        b.vz = (dirz / l) * kick;
        b.vy = live ? 0.4 : 1.2 + pv * 0.35;
        b.x = px + nx * 0.72;
        b.z = pz + nz * 0.72;
      }
      const m = match.update(step, b, human, Math.hypot(px, pz) > 26 || busy);
      const events = m.events;
      const place = m.place ? new THREE.Vector3(P.x + m.place.x, 0.05, P.z + m.place.z) : null;
      if (m.hold) Object.assign(b, { x: 0, y: BALL_R, z: 0, vx: 0, vy: 0, vz: 0 });
      b.vy -= 9.8 * step;
      b.x += b.vx * step;
      b.y += b.vy * step;
      b.z += b.vz * step;
      if (b.y < BALL_R) {
        b.y = BALL_R;
        b.vy = Math.abs(b.vy) > 1.2 ? -b.vy * 0.5 : 0;
        const f = Math.pow(0.55, step);
        b.vx *= f;
        b.vz *= f;
      }
      // Goal: over the line, between the posts, under the bar.
      if (resetIn <= 0 && Math.abs(b.x) > PL / 2 + BALL_R && Math.abs(b.z) < GOAL_W / 2 && b.y < GOAL_H) {
        if (match.live()) {
          const e = match.goal(b.x > 0 ? "home" : "away");
          if (e) events.push(e);
        } else {
          goal = b.x > 0 ? "home" : "away";
          score = goal === "home" ? [score[0] + 1, score[1]] : [score[0], score[1] + 1];
          resetIn = 2.5;
        }
      }
      refreshBoard();
      // The back of the net stops it.
      if (Math.abs(b.x) > PL / 2 + 1.2 && Math.abs(b.z) < GOAL_W / 2) {
        b.x = Math.sign(b.x) * (PL / 2 + 1.2);
        b.vx *= -0.2;
      }
      // Posts.
      for (const [qx, qz] of posts) {
        const ex = b.x - qx;
        const ez = b.z - qz;
        const e = Math.hypot(ex, ez);
        if (e < BALL_R + 0.07 && b.y < GOAL_H) {
          const nx = ex / (e || 1);
          const nz = ez / (e || 1);
          const vn = b.vx * nx + b.vz * nz;
          if (vn < 0) {
            b.vx -= 1.7 * vn * nx;
            b.vz -= 1.7 * vn * nz;
          }
          b.x = qx + nx * (BALL_R + 0.08);
          b.z = qz + nz * (BALL_R + 0.08);
        }
      }
      // Fence: the ball stays in the ground, bar the corner gaps.
      if (Math.abs(b.x) > FENCE_X - BALL_R && Math.abs(b.z) > GOAL_W / 2 + 0.2) {
        b.x = Math.sign(b.x) * (FENCE_X - BALL_R);
        b.vx *= -0.6;
      }
      if (Math.abs(b.z) > FENCE_Z - BALL_R) {
        b.z = Math.sign(b.z) * (FENCE_Z - BALL_R);
        b.vz *= -0.6;
      }
      ball.position.set(b.x, b.y, b.z);
      // Roll.
      const sp = Math.hypot(b.vx, b.vz);
      if (sp > 0.01 && b.y <= BALL_R + 0.01) {
        axis.set(b.vz, 0, -b.vx).normalize();
        spin.setFromAxisAngle(axis, (sp * step) / BALL_R);
        ball.quaternion.premultiply(spin);
      }
      return { goal, place, events };
    },
    dispose() {
      trash.forEach((x) => x.dispose());
    },
  };
}
