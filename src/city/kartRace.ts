/**
 * kartRace — the Vibe Kart Grand Prix: three laps of real Vibe City streets
 * against three rivals, with a bet if you want one.
 *
 * ## The course
 *
 * A loop of streets east and north of the plaza, laid on the street
 * centre-lines (blocks are 28 m on a 40 m pitch, so streets run along
 * x, z = ±20, ±60, ±100). It starts on the street between the plaza and the
 * Vibe Arcade, runs north past the Empire State, west to the police station,
 * south to the Eiffel Tower's street and back east. Traffic is real traffic:
 * it does not stop for the race.
 *
 * Gates stand across the road. The next one burns bright with a beam of
 * light over it; the rest are dim. A lap counts only when every gate was
 * driven through in order, so cutting across a block does not pay.
 *
 * ## The rivals
 *
 * Three karts that ride the course's smoothed centre-line. They are ghosts
 * as far as collision goes (the city has no moving collision boxes, see the
 * landmarks' note), and they rubber-band a little so a race stays a race:
 * the leader eases off when it is far ahead of you and the back of the field
 * pushes when it is far behind.
 *
 * ## How the city drives it
 *
 * The page owns the player's kart and its physics. This module only reads
 * the kart's position each frame (`update`), says when the kart must sit on
 * the grid (`holding`), and reports a result. Pure THREE, no React.
 */
import * as THREE from "three";
import { buildKart, type KartMesh } from "@/components/city/karts";

export const RACE_LAPS = 3;
const COUNTDOWN = 3.2;
/** Course corners, on street centre-lines, driven in this order. */
const CORNERS: Array<[number, number]> = [
  [20, 12],
  [20, -60],
  [-60, -60],
  [-60, 60],
  [60, 60],
  [60, 20],
  [20, 20],
];
const GATE_HALF = 6.6;
const GATE_REACH = 9;

export interface RaceRival {
  name: string;
  color: string;
  /** Average pace, m/s. */
  pace: number;
  lane: number;
}

const RIVALS: RaceRival[] = [
  { name: "Mad Mort", color: "#ff7a1a", pace: 19.2, lane: -2.2 },
  { name: "Linda", color: "#a66bff", pace: 18.4, lane: 2.2 },
  { name: "Vibey", color: "#ffe14d", pace: 17.6, lane: 0 },
];

export type RacePhase = "idle" | "countdown" | "racing" | "finished";

export interface RaceUi {
  phase: RacePhase;
  /** 3, 2, 1, GO during the countdown. */
  count: string | null;
  lap: number;
  laps: number;
  /** 1-based place, live. */
  place: number;
  field: number;
  time: number;
  best: number | null;
  nextGateDist: number;
  /** Index of the gate to drive through next (0 is the finish line). */
  gate: number;
  bet: number;
  result: { place: number; time: number; payout: number; best: boolean } | null;
}

export interface KartRace {
  group: THREE.Group;
  /** Where the kiosk is; E here opens the race board. */
  kiosk: THREE.Vector3;
  /** The player's grid slot: x, z, yaw. */
  grid: [number, number, number];
  nearKiosk(p: THREE.Vector3): boolean;
  start(bet: number): void;
  abort(): void;
  /** True while the player's kart must sit still on the grid. */
  holding(): boolean;
  active(): boolean;
  update(dt: number, now: number, kart: { x: number; z: number } | null): RaceEvent | null;
  ui(): RaceUi;
  /** Dev: jump the player's progress to the last gate of the last lap. */
  devFinish(): void;
  /** Dev: every gate's centre, [x, z], in driving order. */
  devGates(): Array<[number, number]>;
  dispose(): void;
}

export type RaceEvent =
  | { type: "go" }
  | { type: "gate"; gate: number; lap: number }
  | { type: "lap"; lap: number; time: number }
  | { type: "finish"; place: number; time: number; payout: number; best: boolean };

/** What a bet pays back for each place: 1st triples it, 2nd returns it. */
export function payoutFor(place: number, bet: number): number {
  if (bet <= 0) return place === 1 ? 15 : place === 2 ? 8 : 3;
  return place === 1 ? bet * 3 : place === 2 ? bet : 0;
}

function canvasTex(w: number, h: number, draw: (x: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const BEST_KEY = "city.kartgp.best";
function readBest(): number | null {
  try {
    const v = Number(localStorage.getItem(BEST_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
function writeBest(t: number) {
  try {
    localStorage.setItem(BEST_KEY, String(t));
  } catch {
    /* private mode */
  }
}

export function buildKartRace(opts: { lowDetail?: boolean } = {}): KartRace {
  const group = new THREE.Group();
  group.name = "kart-gp";
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const texs: THREE.Texture[] = [];
  const mat = <M extends THREE.Material>(m: M) => (mats.push(m), m);

  // ---- The course ----------------------------------------------------------
  // Corners are rounded with a short quadratic fillet so the rivals take a
  // line through each junction instead of pivoting on the spot.
  const pts: THREE.Vector3[] = [];
  const R = 9;
  for (let i = 0; i < CORNERS.length; i++) {
    const p = new THREE.Vector2(...CORNERS[i]);
    const a = new THREE.Vector2(...CORNERS[(i - 1 + CORNERS.length) % CORNERS.length]);
    const b = new THREE.Vector2(...CORNERS[(i + 1) % CORNERS.length]);
    const ia = a.clone().sub(p);
    const ib = b.clone().sub(p);
    const ra = Math.min(R, ia.length() / 2);
    const rb = Math.min(R, ib.length() / 2);
    const pa = p.clone().add(ia.normalize().multiplyScalar(ra));
    const pb = p.clone().add(ib.normalize().multiplyScalar(rb));
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      const x = (1 - t) * (1 - t) * pa.x + 2 * (1 - t) * t * p.x + t * t * pb.x;
      const z = (1 - t) * (1 - t) * pa.y + 2 * (1 - t) * t * p.y + t * t * pb.y;
      pts.push(new THREE.Vector3(x, 0, z));
    }
  }
  // Arc-length table over the closed polyline.
  const cum: number[] = [0];
  for (let i = 1; i <= pts.length; i++) cum.push(cum[i - 1] + pts[i % pts.length].distanceTo(pts[i - 1]));
  const LEN = cum[cum.length - 1];
  // Distance along the loop of the start corner's fillet start, so s = 0 is
  // just past the start line. The start line is the first corner's point
  // itself (a straight, since it is only a jog of 8 m), so offset to it.
  const startS = (() => {
    let best = 0;
    let bd = Infinity;
    const sp = new THREE.Vector3(CORNERS[0][0], 0, CORNERS[0][1] - 4);
    for (let i = 0; i < pts.length; i++) {
      const d = pts[i].distanceTo(sp);
      if (d < bd) {
        bd = d;
        best = cum[i];
      }
    }
    return best;
  })();
  const at = (s: number, out: THREE.Vector3, tan?: THREE.Vector3) => {
    let u = (((s + startS) % LEN) + LEN) % LEN;
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (cum[m] <= u) lo = m;
      else hi = m;
    }
    const a = pts[lo % pts.length];
    const b = pts[(lo + 1) % pts.length];
    const seg = cum[lo + 1] - cum[lo] || 1;
    u = (u - cum[lo]) / seg;
    out.lerpVectors(a, b, u);
    if (tan) tan.subVectors(b, a).normalize();
    return out;
  };
  /** Nearest course distance to a point, searched near a hint. */
  const project = (x: number, z: number, hint: number) => {
    const p = new THREE.Vector3();
    let best = hint;
    let bd = Infinity;
    for (let d = -40; d <= 40; d += 1) {
      const s = hint + d;
      at(s, p);
      const dd = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (dd < bd) {
        bd = dd;
        best = s;
      }
    }
    return best;
  };

  // ---- Gates ---------------------------------------------------------------
  const GATES = 12;
  const checker = canvasTex(512, 128, (x) => {
    for (let i = 0; i < 16; i++) for (let j = 0; j < 4; j++) {
      x.fillStyle = (i + j) % 2 ? "#111" : "#fff";
      x.fillRect(i * 32, j * 32, 32, 32);
    }
  });
  const bannerTex = canvasTex(1024, 160, (x) => {
    x.fillStyle = "#12082a";
    x.fillRect(0, 0, 1024, 160);
    x.font = "900 96px system-ui, sans-serif";
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.shadowColor = "#38e8ff";
    x.shadowBlur = 24;
    x.fillStyle = "#ffffff";
    x.fillText("VIBE KART GP", 512, 86);
  });
  texs.push(checker, bannerTex);
  const pylonGeo = new THREE.CylinderGeometry(0.35, 0.45, 5.2, 10);
  const barGeo = new THREE.BoxGeometry(GATE_HALF * 2 + 0.8, 0.9, 0.25);
  const beamGeo = new THREE.CylinderGeometry(0.6, 0.6, 60, 10, 1, true);
  geos.push(pylonGeo, barGeo, beamGeo);
  const dim = mat(new THREE.MeshBasicMaterial({ color: 0x3b2a6a }));
  const lit = mat(new THREE.MeshBasicMaterial({ color: 0x38e8ff }));
  const finishMat = mat(new THREE.MeshBasicMaterial({ map: checker }));
  const bannerMat = mat(new THREE.MeshBasicMaterial({ map: bannerTex }));
  const beamMat = mat(new THREE.MeshBasicMaterial({ color: 0x38e8ff, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }));
  type Gate = { s: number; pos: THREE.Vector3; pylons: THREE.Mesh[]; bar: THREE.Mesh };
  const gates: Gate[] = [];
  const tmp = new THREE.Vector3();
  const tan = new THREE.Vector3();
  for (let g = 0; g < GATES; g++) {
    const s = (g / GATES) * LEN;
    const pos = at(s, new THREE.Vector3(), tan).clone();
    const yaw = Math.atan2(tan.x, tan.z);
    const nx = Math.cos(yaw);
    const nz = -Math.sin(yaw);
    const pylons: THREE.Mesh[] = [];
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(pylonGeo, g === 0 ? finishMat : dim);
      m.position.set(pos.x + nx * GATE_HALF * side, 2.6, pos.z + nz * GATE_HALF * side);
      group.add(m);
      pylons.push(m);
    }
    const bar = new THREE.Mesh(barGeo, g === 0 ? finishMat : dim);
    bar.position.set(pos.x, 5.0, pos.z);
    bar.rotation.y = yaw + Math.PI / 2;
    group.add(bar);
    if (g === 0) {
      // The start/finish banner, both faces.
      const bGeo = new THREE.PlaneGeometry(GATE_HALF * 2, GATE_HALF * 2 * (160 / 1024));
      geos.push(bGeo);
      for (const flip of [0, Math.PI]) {
        const b = new THREE.Mesh(bGeo, bannerMat);
        b.position.set(pos.x, 6.1, pos.z);
        b.rotation.y = yaw + flip;
        group.add(b);
      }
    }
    gates.push({ s, pos, pylons, bar });
  }
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.visible = false;
  group.add(beam);
  // Start line paint.
  {
    const p = at(0, new THREE.Vector3(), tan);
    const yaw = Math.atan2(tan.x, tan.z);
    const geo = new THREE.PlaneGeometry(GATE_HALF * 2, 1.2).rotateX(-Math.PI / 2);
    geos.push(geo);
    const m = new THREE.Mesh(geo, mat(new THREE.MeshBasicMaterial({ map: checker, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 })));
    m.position.set(p.x, 0.03, p.z);
    m.rotation.y = yaw;
    group.add(m);
  }

  // ---- The kiosk on the plaza's east edge ---------------------------------
  // Clear of Granny (10.5, 5), whose E is the lost-pets quest.
  const kiosk = new THREE.Vector3(11.5, 0, 12.5);
  {
    const post = mat(new THREE.MeshStandardMaterial({ color: 0x1a1030, roughness: 0.5 }));
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.2, 0.6), post);
    geos.push(body.geometry);
    body.position.set(kiosk.x, 1.1, kiosk.z);
    body.rotation.y = Math.PI / 2;
    group.add(body);
    const signTex = canvasTex(512, 512, (x) => {
      x.fillStyle = "#12082a";
      x.fillRect(0, 0, 512, 512);
      x.font = "200px system-ui, sans-serif";
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.fillText("🏁", 256, 190);
      x.font = "900 64px system-ui, sans-serif";
      x.fillStyle = "#38e8ff";
      x.fillText("KART GP", 256, 360);
      x.font = "700 36px system-ui, sans-serif";
      x.fillStyle = "#ffe14d";
      x.fillText("PRESS E TO RACE", 256, 440);
    });
    texs.push(signTex);
    const sm = mat(new THREE.MeshBasicMaterial({ map: signTex }));
    const sg = new THREE.PlaneGeometry(1.4, 1.4);
    geos.push(sg);
    for (const [dx, yaw] of [[0.31, Math.PI / 2], [-0.31, -Math.PI / 2]] as const) {
      const s = new THREE.Mesh(sg, sm);
      s.position.set(kiosk.x + dx, 1.35, kiosk.z);
      s.rotation.y = yaw;
      group.add(s);
    }
  }

  // ---- Rivals --------------------------------------------------------------
  type Rival = RaceRival & { mesh: KartMesh; s: number; lapS: number; finish: number | null; v: number };
  const rivals: Rival[] = RIVALS.map((r) => {
    const mesh = buildKart(r.color);
    mesh.group.visible = false;
    group.add(mesh.group);
    return { ...r, mesh, s: 0, lapS: 0, finish: null, v: 0 };
  });
  const GRID: Array<[number, number]> = [
    [-2.2, -7], // player: left lane, second row
    [2.2, -3],
    [-2.2, -3],
    [2.2, -7],
  ];
  const gridPose = (slot: number): [number, number, number] => {
    const [lane, back] = GRID[slot];
    const p = at(back, new THREE.Vector3(), tan);
    const yaw = Math.atan2(tan.x, tan.z);
    return [p.x + Math.cos(yaw) * lane, p.z - Math.sin(yaw) * lane, yaw];
  };

  // ---- State ---------------------------------------------------------------
  let phase: RacePhase = "idle";
  let t0 = 0;
  let clock = 0;
  let countdown = 0;
  let bet = 0;
  let nextGate = 1;
  let lap = 1;
  let playerS = GRID[0][1];
  let best = readBest();
  let result: RaceUi["result"] = null;
  let place = 1;
  let gateDist = 0;
  let finishHold = 0;

  const placeRivals = () => {
    rivals.forEach((r, i) => {
      const [lane, back] = GRID[i + 1];
      r.s = back;
      r.lane = lane;
      r.finish = null;
      r.v = 0;
      r.mesh.group.visible = true;
    });
  };
  const playerTotal = () => (lap - 1) * LEN + Math.max(0, playerS);

  const update: KartRace["update"] = (dt, now, kart) => {
    void now;
    // Gate glow.
    const tt = performance.now() / 1000;
    if (phase === "countdown" || phase === "racing") {
      const g = gates[nextGate % GATES];
      beam.visible = true;
      beam.position.set(g.pos.x, 30, g.pos.z);
      beamMat.opacity = 0.2 + 0.1 * Math.sin(tt * 6);
      gates.forEach((gt, i) => {
        if (i === 0) return;
        const m = i === nextGate % GATES ? lit : dim;
        gt.pylons[0].material = m;
        gt.pylons[1].material = m;
        gt.bar.material = m;
      });
    } else {
      beam.visible = false;
    }

    if (phase === "idle") return null;
    if (phase === "finished") {
      finishHold -= dt;
      // Rivals cruise on for a few seconds, then park out of the way.
      for (const r of rivals) {
        r.s += r.v * 0.6 * dt;
        poseRival(r);
      }
      if (finishHold <= 0) {
        rivals.forEach((r) => (r.mesh.group.visible = false));
        phase = "idle";
      }
      return null;
    }
    if (phase === "countdown") {
      countdown -= dt;
      rivals.forEach(poseRival);
      if (countdown <= 0) {
        phase = "racing";
        t0 = performance.now();
        clock = 0;
        return { type: "go" };
      }
      return null;
    }

    // Racing.
    clock = (performance.now() - t0) / 1000;
    let ev: RaceEvent | null = null;
    if (kart) {
      playerS = project(kart.x, kart.z, playerS);
      const g = gates[nextGate % GATES];
      gateDist = Math.hypot(kart.x - g.pos.x, kart.z - g.pos.z);
      if (gateDist < GATE_REACH) {
        if (nextGate % GATES === 0) {
          if (lap >= RACE_LAPS) {
            ev = finish();
          } else {
            lap += 1;
            playerS -= LEN;
            nextGate = 1;
            ev = { type: "lap", lap, time: clock };
          }
        } else {
          ev = { type: "gate", gate: nextGate, lap };
          nextGate += 1;
        }
      }
    }
    // Rivals, with a light rubber band against the player.
    const me = playerTotal();
    for (const r of rivals) {
      if (r.finish !== null) {
        r.s += r.v * 0.5 * dt;
        poseRival(r);
        continue;
      }
      const lead = r.s - me;
      const band = THREE.MathUtils.clamp(-lead / 120, -0.14, 0.12);
      // Slower through the corners: read how sharply the line turns ahead.
      at(r.s, tmp, tan);
      const ty = Math.atan2(tan.x, tan.z);
      at(r.s + 10, tmp, tan);
      const turn = Math.abs(Math.atan2(Math.sin(Math.atan2(tan.x, tan.z) - ty), Math.cos(Math.atan2(tan.x, tan.z) - ty)));
      const target = r.pace * (1 + band) * (1 - Math.min(0.35, turn * 0.5));
      r.v += (target - r.v) * Math.min(1, dt * 1.6);
      r.s += r.v * dt;
      if (r.s >= RACE_LAPS * LEN) r.finish = clock;
      poseRival(r);
    }
    place = 1 + rivals.filter((r) => (r.finish !== null ? 1e9 - r.finish : r.s) > me).length;
    return ev;
  };

  const poseRival = (r: Rival) => {
    at(r.s, tmp, tan);
    const yaw = Math.atan2(tan.x, tan.z);
    r.mesh.group.position.set(tmp.x + Math.cos(yaw) * r.lane, 0, tmp.z - Math.sin(yaw) * r.lane);
    r.mesh.group.rotation.y = yaw;
    for (const w of r.mesh.wheels) w.rotation.x += r.v * 0.05;
  };

  const finish = (): RaceEvent => {
    const time = clock;
    const ahead = rivals.filter((r) => r.finish !== null && r.finish < time).length;
    place = 1 + ahead;
    const payout = payoutFor(place, bet);
    const isBest = best === null || time < best;
    if (isBest) {
      best = time;
      writeBest(time);
    }
    result = { place, time, payout, best: isBest };
    phase = "finished";
    finishHold = 6;
    beam.visible = false;
    return { type: "finish", place, time, payout, best: isBest };
  };

  return {
    group,
    kiosk,
    grid: gridPose(0),
    nearKiosk(p) {
      return phase === "idle" && Math.hypot(p.x - kiosk.x, p.z - kiosk.z) < 3 && p.y < 3;
    },
    start(b) {
      bet = Math.max(0, Math.floor(b));
      phase = "countdown";
      countdown = COUNTDOWN;
      nextGate = 1;
      lap = 1;
      playerS = GRID[0][1];
      result = null;
      place = 4;
      clock = 0;
      placeRivals();
    },
    abort() {
      phase = "idle";
      beam.visible = false;
      rivals.forEach((r) => (r.mesh.group.visible = false));
    },
    holding() {
      return phase === "countdown";
    },
    active() {
      return phase === "countdown" || phase === "racing";
    },
    update,
    ui() {
      const c = Math.ceil(countdown);
      return {
        phase,
        count: phase === "countdown" ? (c >= 1 && c <= 3 ? String(c) : "GO") : null,
        lap: Math.min(lap, RACE_LAPS),
        laps: RACE_LAPS,
        place,
        field: rivals.length + 1,
        time: clock,
        best,
        nextGateDist: gateDist,
        gate: nextGate % GATES,
        bet,
        result,
      };
    },
    devGates() {
      return gates.map((g) => [g.pos.x, g.pos.z] as [number, number]);
    },
    devFinish() {
      lap = RACE_LAPS;
      nextGate = 0;
      playerS = LEN - 10;
    },
    dispose() {
      for (const r of rivals) {
        r.mesh.group.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.geometry.dispose();
          (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
        });
      }
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      texs.forEach((t) => t.dispose());
      void opts;
    },
  };
}
