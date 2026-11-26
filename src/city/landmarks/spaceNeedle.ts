/**
 * The Space Needle.
 *
 * Three pairs of legs pinched at the waist, the saucer, the halo and the
 * spire, with the roof in the original 1962 Galaxy Gold. Two glass elevators
 * run up the outside of the core, the way the real ones do, so the ride is
 * the city dropping away under you; one waits at the street and one at the
 * top, so there is always a car where you are.
 *
 * Up top: an inner ring you step out onto, the Loupe (a glass floor that
 * slowly turns and carries you round with it, with the street 104 m straight
 * down through it), and the open-air deck outside behind the glass barrier,
 * with binoculars pointed at the other two landmarks and at Vibe Island.
 *
 * At night the saucer is underlit, the halo glows and the Legacy Light shines
 * straight up from the spire.
 */
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";
import { buildBinoculars } from "./empireState";
import { canvas, discFloor, Elevator, merge, ringWall, signTexture, solid, tex, type Station, type Viewer } from "./common";

export interface SpaceNeedle {
  group: THREE.Group;
  stations: Station[];
  viewers: Array<Viewer & { station: Station }>;
  elevators: Elevator[];
  deckY: number;
  topY: number;
  /** Turn the Loupe, and the player on it. */
  update(dt: number, now: number, player: THREE.Vector3, grounded: boolean): void;
  setNight(night: boolean): void;
  roofs: THREE.Material[];
  dispose(): void;
}

const DECK = 104;
const ROOF = 108;
const SPIRE0 = 113.5;
const TIP = 128;
const CORE_R = 2.0;
const CAR_R = 3.4;
const LOUPE_IN = 5;
const LOUPE_OUT = 11;
const RIM = 15.2;
/** One turn of the Loupe, seconds. The real one takes 45 minutes; this is a game. */
const LOUPE_PERIOD = 120;

export function buildSpaceNeedle(opts: { boxes: WorldBox[]; cx: number; cz: number; lowDetail: boolean; faceAngle: number; lookAt: number[] }): SpaceNeedle {
  const { boxes, cx, cz } = opts;
  const seg = opts.lowDetail ? 36 : 64;
  const group = new THREE.Group();
  group.position.set(cx, 0, cz);
  const trash: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(t: T) => (trash.push(t), t);

  const white = keep(new THREE.MeshStandardMaterial({ color: "#eef1f4", roughness: 0.42, metalness: 0.35, emissive: "#9cc8ff", emissiveIntensity: 0 }));
  const gold = keep(new THREE.MeshStandardMaterial({ color: "#f0a43a", roughness: 0.45, metalness: 0.25 }));
  const steel = keep(new THREE.MeshStandardMaterial({ color: "#9aa3ad", roughness: 0.5, metalness: 0.6 }));
  const glass = keep(
    new THREE.MeshStandardMaterial({ color: "#a8dcf0", transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.3, side: THREE.DoubleSide, depthWrite: false }),
  );
  const deckMat = keep(new THREE.MeshStandardMaterial({ color: "#c7ccd2", roughness: 0.85 }));

  const at = (a: number, r: number, y: number) => new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);

  // ---- Legs ----------------------------------------------------------------
  const carAngles = [opts.faceAngle, opts.faceAngle + (2 * Math.PI) / 3];
  const legAngles = [1, 3, 5].map((k) => opts.faceAngle + (k * Math.PI) / 3);
  const legParts: THREE.BufferGeometry[] = [];
  const profile: Array<[number, number, number]> = [
    // radius, y, half-spread of the pair in radians
    [10.5, 0, 0.13],
    [6.6, 16, 0.1],
    [3.4, 38, 0.07],
    [4.6, 62, 0.08],
    [7.3, 86, 0.1],
    [9.2, 100.4, 0.12],
  ];
  for (const a of legAngles) {
    for (const side of [-1, 1]) {
      const pts = profile.map(([r, y, s]) => at(a + side * s, r, y));
      const curve = new THREE.CatmullRomCurve3(pts);
      legParts.push(new THREE.TubeGeometry(curve, opts.lowDetail ? 24 : 48, 0.55, 8, false));
      solid(boxes, cx + pts[0].x, cz + pts[0].z, 1.4, 1.4, 0, 5);
    }
    // Cross-bracing between the two legs of a pair.
    for (const y of [10, 26, 50, 72, 92]) {
      const k = profile.findIndex(([, py]) => py > y);
      const [r0, y0, s0] = profile[k - 1];
      const [r1, y1, s1] = profile[k];
      const f = (y - y0) / (y1 - y0);
      const r = THREE.MathUtils.lerp(r0, r1, f);
      const s = THREE.MathUtils.lerp(s0, s1, f);
      const g = new THREE.CylinderGeometry(0.22, 0.22, 2 * r * Math.sin(s), 6);
      g.rotateZ(Math.PI / 2);
      g.rotateY(a - Math.PI / 2);
      const p = at(a, r * Math.cos(s), y);
      g.translate(p.x, p.y, p.z);
      legParts.push(g);
    }
  }
  // The waist ring and the ring the legs land on under the saucer.
  {
    const waist = new THREE.TorusGeometry(3.7, 0.32, 8, seg);
    waist.rotateX(Math.PI / 2);
    waist.translate(0, 38, 0);
    const crown = new THREE.TorusGeometry(9.2, 0.55, 8, seg);
    crown.rotateX(Math.PI / 2);
    crown.translate(0, 100.4, 0);
    legParts.push(waist, crown);
  }
  const legs = new THREE.Mesh(keep(merge(legParts)), white);
  legs.castShadow = true;
  group.add(legs);

  // ---- Core and elevator rails -------------------------------------------------
  {
    const core = new THREE.CylinderGeometry(CORE_R * 0.8, CORE_R, ROOF + 2, 16);
    core.translate(0, (ROOF + 2) / 2, 0);
    const parts: THREE.BufferGeometry[] = [core];
    for (const a of carAngles) {
      for (const t of [-1, 1]) {
        const p = at(a, CAR_R, 0).add(at(a + Math.PI / 2, 1.3 * t, 0));
        const g = new THREE.BoxGeometry(0.18, DECK + 0.4, 0.18);
        g.translate(p.x, (DECK + 0.4) / 2, p.z);
        parts.push(g);
      }
    }
    const m = new THREE.Mesh(keep(merge(parts)), steel);
    m.castShadow = true;
    group.add(m);
    solid(boxes, cx, cz, CORE_R * 2, CORE_R * 2, 0, ROOF + 2);
  }

  // ---- The saucer -------------------------------------------------------------
  // Underside: a flared ring from the leg crown out to the rim, and steel ribs
  // under the glass floor so you can see what holds you up.
  {
    const under = new THREE.LatheGeometry(
      [new THREE.Vector2(10.6, 100.3), new THREE.Vector2(12.8, 101.6), new THREE.Vector2(14.6, 103.0), new THREE.Vector2(RIM, 103.7), new THREE.Vector2(RIM, 104.0)],
      seg,
    );
    const m = new THREE.Mesh(keep(under), white);
    m.castShadow = true;
    group.add(m);
    const ribs: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const g = new THREE.BoxGeometry(LOUPE_OUT - CORE_R, 0.45, 0.3);
      g.translate((LOUPE_OUT + CORE_R) / 2, DECK - 0.6, 0);
      g.rotateY(-a);
      ribs.push(g);
    }
    const ring = new THREE.TorusGeometry(LOUPE_IN, 0.3, 6, seg);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, DECK - 0.6, 0);
    ribs.push(ring);
    group.add(new THREE.Mesh(keep(merge(ribs)), steel));
  }
  // Floors: the inner landing ring, the outer deck (both opaque), and the
  // Loupe between them.
  {
    const inner = new THREE.RingGeometry(CORE_R, LOUPE_IN, seg, 1);
    inner.rotateX(-Math.PI / 2);
    inner.translate(0, DECK + 0.02, 0);
    const outer = new THREE.RingGeometry(LOUPE_OUT, RIM, seg, 1);
    outer.rotateX(-Math.PI / 2);
    outer.translate(0, DECK + 0.02, 0);
    const m = new THREE.Mesh(keep(merge([inner, outer])), deckMat);
    m.receiveShadow = true;
    group.add(m);
    discFloor(boxes, cx, cz, RIM, DECK, 14);
  }
  const loupe = new THREE.Group();
  loupe.position.y = DECK;
  {
    const g = new THREE.RingGeometry(LOUPE_IN, LOUPE_OUT, seg, 1);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.03, 0);
    const loupeGlass = keep(
      new THREE.MeshStandardMaterial({ color: "#7fd0ff", transparent: true, opacity: 0.3, roughness: 0.02, metalness: 0.2, depthWrite: false }),
    );
    loupe.add(new THREE.Mesh(keep(g), loupeGlass));
    // Opaque spokes in the glass, so you can see it turning.
    const spokes: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 12; k++) {
      const s = new THREE.BoxGeometry(LOUPE_OUT - LOUPE_IN, 0.06, 0.18);
      s.translate((LOUPE_OUT + LOUPE_IN) / 2, 0.05, 0);
      s.rotateY((k / 12) * Math.PI * 2);
      spokes.push(s);
    }
    const ring = new THREE.TorusGeometry((LOUPE_IN + LOUPE_OUT) / 2, 0.08, 4, seg);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, 0.05, 0);
    spokes.push(ring);
    loupe.add(new THREE.Mesh(keep(merge(spokes)), gold));
  }
  group.add(loupe);

  // The glass wall round the Loupe, open at four doorways, and the barrier at
  // the rim of the open-air deck.
  {
    const DOOR = 0.34; // radians either side of each doorway's centre
    const doors = [0, 1, 2, 3].map((k) => opts.faceAngle + Math.PI / 4 + (k * Math.PI) / 2);
    const isDoor = (a: number) =>
      doors.some((d) => Math.abs(Math.atan2(Math.sin(a - d), Math.cos(a - d))) < DOOR);
    // Collision: the segments' angles are measured the same way as here.
    ringWall(boxes, cx, cz, LOUPE_OUT, DECK, ROOF, 32, 0.35, (a) => isDoor(a));
    ringWall(boxes, cx, cz, RIM - 0.25, DECK, DECK + 2.5, 40, 0.4);
    // Drawn: the inner wall in panels, skipping the doorways.
    const panels: THREE.BufferGeometry[] = [];
    const frames: THREE.BufferGeometry[] = [];
    const N = 32;
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2;
      const a1 = ((i + 1) / N) * Math.PI * 2;
      if (isDoor((a0 + a1) / 2)) continue;
      const p0 = at(a0, LOUPE_OUT, 0);
      const p1 = at(a1, LOUPE_OUT, 0);
      const g = new THREE.PlaneGeometry(p0.distanceTo(p1), ROOF - DECK);
      g.rotateY((a0 + a1) / 2 - Math.PI / 2);
      g.translate((p0.x + p1.x) / 2, DECK + (ROOF - DECK) / 2, (p0.z + p1.z) / 2);
      panels.push(g);
      const f = new THREE.BoxGeometry(0.12, ROOF - DECK, 0.12);
      f.translate(p0.x, DECK + (ROOF - DECK) / 2, p0.z);
      frames.push(f);
    }
    // The rim barrier: a glass band leaning out a touch, on posts.
    const band = new THREE.CylinderGeometry(RIM - 0.1, RIM - 0.3, 2.4, seg, 1, true);
    band.translate(0, DECK + 1.2, 0);
    panels.push(band);
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const p = at(a, RIM - 0.2, 0);
      const f = new THREE.BoxGeometry(0.1, 2.5, 0.1);
      f.translate(p.x, DECK + 1.25, p.z);
      frames.push(f);
    }
    const rail = new THREE.TorusGeometry(RIM - 0.15, 0.07, 4, seg);
    rail.rotateX(Math.PI / 2);
    rail.translate(0, DECK + 2.45, 0);
    frames.push(rail);
    group.add(new THREE.Mesh(keep(merge(panels)), glass));
    group.add(new THREE.Mesh(keep(merge(frames)), steel));
  }

  // ---- Roof, halo, spire ---------------------------------------------------------
  const haloLightMat = keep(new THREE.MeshBasicMaterial({ color: "#fff6dc" }));
  {
    const roof = new THREE.LatheGeometry(
      [
        new THREE.Vector2(0.01, ROOF - 0.2),
        new THREE.Vector2(12.2, ROOF - 0.2),
        new THREE.Vector2(12.2, ROOF + 0.3),
        new THREE.Vector2(8.5, ROOF + 2.3),
        new THREE.Vector2(4.2, ROOF + 4.3),
        new THREE.Vector2(1.6, SPIRE0),
      ],
      seg,
    );
    const m = new THREE.Mesh(keep(roof), gold);
    m.castShadow = true;
    group.add(m);
    // The halo: a flat ring round the roof on spokes.
    const parts: THREE.BufferGeometry[] = [];
    const halo = new THREE.RingGeometry(12.9, 16.4, seg, 1);
    halo.rotateX(-Math.PI / 2);
    halo.translate(0, ROOF + 0.9, 0);
    const haloUnder = halo.clone();
    haloUnder.rotateX(Math.PI);
    haloUnder.translate(0, 2 * (ROOF + 0.9) - 0.3, 0);
    parts.push(halo, haloUnder);
    const edge = new THREE.CylinderGeometry(16.4, 16.4, 0.3, seg, 1, true);
    edge.translate(0, ROOF + 0.75, 0);
    parts.push(edge);
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      parts.push(beamXZ(at(a, 9.4, ROOF + 1.9), at(a, 16.2, ROOF + 0.8), 0.14));
    }
    group.add(new THREE.Mesh(keep(merge(parts)), white));
    // A line of lights round the halo's edge, for the night.
    const lights = new THREE.TorusGeometry(16.45, 0.12, 4, seg);
    lights.rotateX(Math.PI / 2);
    lights.translate(0, ROOF + 0.75, 0);
    const lm = new THREE.Mesh(keep(lights), haloLightMat);
    lm.userData.night = true;
    group.add(lm);
    const spire = new THREE.CylinderGeometry(0.05, 0.55, TIP - SPIRE0, 8);
    spire.translate(0, (SPIRE0 + TIP) / 2, 0);
    group.add(new THREE.Mesh(keep(spire), white));
    // Walkable roof, stepped to the cone.
    discFloor(boxes, cx, cz, 12.2, ROOF + 0.4, 10, 0.6);
    discFloor(boxes, cx, cz, 8.2, ROOF + 2.4, 8, 2.0);
    discFloor(boxes, cx, cz, 4.0, ROOF + 4.4, 6, 2.0);
  }

  // ---- Base plaza and sign ------------------------------------------------------------
  {
    const { c, x } = canvas(1024);
    x.fillStyle = "#c9c3b8";
    x.fillRect(0, 0, 1024, 1024);
    x.strokeStyle = "#a59d90";
    x.lineWidth = 6;
    for (let k = 1; k < 7; k++) {
      x.beginPath();
      x.arc(512, 512, k * 72, 0, Math.PI * 2);
      x.stroke();
    }
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      x.beginPath();
      x.moveTo(512 + Math.cos(a) * 72, 512 + Math.sin(a) * 72);
      x.lineTo(512 + Math.cos(a) * 500, 512 + Math.sin(a) * 500);
      x.stroke();
    }
    const t = keep(tex(c, false));
    const m = keep(new THREE.MeshStandardMaterial({ map: t, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 }));
    const g = new THREE.CircleGeometry(13.4, seg);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.03, 0);
    const disc = new THREE.Mesh(keep(g), m);
    disc.receiveShadow = true;
    group.add(disc);
  }
  {
    const sTex = keep(
      signTexture(
        [
          { text: "SPACE NEEDLE", size: 120, color: "#ffffff" },
          { text: "GLASS ELEVATORS TO THE TOP · 104 M", size: 46, color: "#ffd27a", font: "600" },
        ],
        "#1d3557",
        1280,
        300,
        "#f0a43a",
      ),
    );
    const sign = new THREE.Mesh(keep(new THREE.PlaneGeometry(6, 1.4)), keep(new THREE.MeshBasicMaterial({ map: sTex, side: THREE.DoubleSide })));
    const a = opts.faceAngle;
    const p = at(a, 9.2, 0);
    sign.position.set(p.x + Math.cos(a + Math.PI / 2) * 3.4, 2.6, p.z + Math.sin(a + Math.PI / 2) * 3.4);
    sign.rotation.y = -a + Math.PI / 2;
    group.add(sign);
    const post = new THREE.BoxGeometry(0.16, 1.9, 0.16);
    post.translate(sign.position.x, 0.95, sign.position.z);
    group.add(new THREE.Mesh(keep(post), steel));
  }

  // ---- Night: underlight, uplights and the Legacy Light ------------------------------
  const nightGroup = new THREE.Group();
  nightGroup.visible = false;
  group.add(nightGroup);
  const beamMat = keep(
    new THREE.MeshBasicMaterial({ color: "#cfe8ff", transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  {
    const beamGeo = new THREE.CylinderGeometry(3.2, 0.35, 260, 16, 1, true);
    beamGeo.translate(0, TIP + 130, 0);
    nightGroup.add(new THREE.Mesh(keep(beamGeo), beamMat));
    const underGlow = keep(
      new THREE.MeshBasicMaterial({ color: "#ffe7b0", transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    const ring = new THREE.LatheGeometry([new THREE.Vector2(10.7, 100.2), new THREE.Vector2(12.9, 101.5), new THREE.Vector2(14.7, 102.9), new THREE.Vector2(RIM + 0.05, 103.6)], seg);
    nightGroup.add(new THREE.Mesh(keep(ring), underGlow));
  }

  // ---- Elevators ------------------------------------------------------------------------------
  const elevators: Elevator[] = [];
  const carGlass = glass;
  carAngles.forEach((a, i) => {
    const car = new THREE.Group();
    const frame = new THREE.Group();
    const floorG = new THREE.BoxGeometry(2.4, 0.18, 2.4);
    floorG.translate(0, -0.09, 0);
    const roofG = new THREE.BoxGeometry(2.4, 0.22, 2.4);
    roofG.translate(0, 2.9, 0);
    const posts: THREE.BufferGeometry[] = [floorG, roofG];
    for (const [px, pz] of [
      [1.15, 1.15],
      [-1.15, 1.15],
      [1.15, -1.15],
      [-1.15, -1.15],
    ]) {
      const p = new THREE.BoxGeometry(0.12, 2.9, 0.12);
      p.translate(px, 1.45, pz);
      posts.push(p);
    }
    frame.add(new THREE.Mesh(keep(merge(posts)), gold));
    const walls = new THREE.BoxGeometry(2.36, 2.8, 2.36);
    walls.translate(0, 1.45, 0);
    frame.add(new THREE.Mesh(keep(walls), carGlass));
    frame.rotation.y = -a;
    car.add(frame);
    group.add(car);
    const bottom = at(a, CAR_R, 0.05);
    const top = at(a, CAR_R, DECK + 0.05);
    const W = (v: THREE.Vector3) => v.clone().add(new THREE.Vector3(cx, 0, cz));
    const e = new Elevator({
      id: `needle-${i}`,
      car,
      path: [bottom, top],
      origin: new THREE.Vector3(cx, 0, cz),
      exits: [W(at(a, 6.4, 0.05)), W(at(a, 6.4, DECK + 0.05))],
      startAtTop: i === 1,
      speed: 11,
    });
    elevators.push(e);
  });

  // ---- Stations ------------------------------------------------------------------------------
  const stations: Station[] = [];
  const viewers: Array<Viewer & { station: Station }> = [];
  const scopeMat = keep(new THREE.MeshStandardMaterial({ color: "#f0a43a", metalness: 0.5, roughness: 0.35 }));
  for (const a of opts.lookAt) {
    const s = buildBinoculars(scopeMat, trash);
    const p = at(a, RIM - 1.0, DECK);
    s.position.copy(p);
    s.rotation.y = Math.atan2(Math.cos(a), Math.sin(a));
    group.add(s);
    const station: Station = {
      id: `needle-scope-${a.toFixed(2)}`,
      label: "Look through the binoculars",
      emoji: "🔭",
      pos: new THREE.Vector3(cx + p.x, DECK, cz + p.z),
      radius: 1.3,
      act: () => {},
    };
    const eye = at(a, RIM + 0.3, DECK + 1.6).add(new THREE.Vector3(cx, 0, cz));
    viewers.push({ eye, yaw: Math.atan2(-Math.cos(a), -Math.sin(a)), station });
    stations.push(station);
  }

  let spin = 0;
  return {
    group,
    stations,
    viewers,
    elevators,
    deckY: DECK,
    topY: TIP,
    roofs: [deckMat],
    update(dt, now, player, grounded) {
      const w = (Math.PI * 2) / LOUPE_PERIOD;
      spin += w * dt;
      loupe.rotation.y = -spin;
      // Carry whoever is standing on the glass.
      if (grounded && Math.abs(player.y - DECK) < 0.35) {
        const dx = player.x - cx;
        const dz = player.z - cz;
        const r = Math.hypot(dx, dz);
        if (r > LOUPE_IN && r < LOUPE_OUT - 0.3) {
          const c = Math.cos(w * dt);
          const s = Math.sin(w * dt);
          // The mesh turns by -spin about +y, which in three's convention
          // takes (x, z) to (x c - z s, x s + z c). Same for the rider.
          player.x = cx + dx * c - dz * s;
          player.z = cz + dx * s + dz * c;
        }
      }
      void now;
    },
    setNight(n) {
      nightGroup.visible = n;
      white.emissiveIntensity = n ? 0.16 : 0;
      haloLightMat.color.set(n ? "#fff6dc" : "#d9dee4");
    },
    dispose() {
      trash.forEach((t) => t.dispose());
    },
  };
}

/** A member between two points that need not be vertical, for the halo spokes. */
function beamXZ(a: THREE.Vector3, b: THREE.Vector3, r: number) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, 5);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  const m = a.clone().add(b).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  return g;
}
