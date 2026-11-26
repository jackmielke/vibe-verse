/**
 * The Eiffel Tower.
 *
 * It stands over a crossroads, one leg in each of the four blocks round it,
 * so the traffic drives under the arches the way the Quai Branly does. That
 * is also what makes it big enough: a tower confined to one 28 m block would
 * be 70 m tall and lose to an office building.
 *
 * Structure: four curved legs of lattice that meet at the second platform,
 * one tapering shaft above that, three platforms and the lantern. The lattice
 * is a cutout texture on tapering panels, with real geometry only for the
 * corner members, which is what gives it its silhouette without drawing ten
 * thousand girders.
 *
 * Getting up is two lifts, as in Paris: an inclined lift up a leg to the
 * second platform, then the central lift to the summit, where there is a
 * champagne bar, Gustave's little office, and binoculars.
 *
 * At night the whole frame glows gold, the searchlight turns at the top, and
 * every couple of minutes it sparkles.
 */
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";
import { buildBinoculars } from "./empireState";
import { beam, canvas, Elevator, merge, quad, rng, signTexture, solid, squareRing, squareWall, tex, type Station, type Viewer } from "./common";

export interface Eiffel {
  group: THREE.Group;
  stations: Station[];
  viewers: Array<Viewer & { station: Station }>;
  elevators: Elevator[];
  /** The central lift, which waits at whichever end it was sent to. */
  central: Elevator;
  deckY: number;
  topY: number;
  setNight(night: boolean): void;
  update(dt: number, now: number): void;
  /** On the summit, where the chase camera has to come in close. */
  indoors(p: THREE.Vector3): boolean;
  /** Start a sparkle now, if it is dark. */
  sparkle(): void;
  sparkling(): boolean;
  roofs: THREE.Material[];
  dispose(): void;
}

const P1 = 23;
const P2 = 46;
const SUMMIT = 111;
const TIP = 131;
/** How far out a leg's centre stands at the ground, from the tower's axis. */
const FOOT = 20;

/** Leg centreline offset from the axis at height y (0..P2), per axis. */
const legC = (y: number) => 8.5 + (FOOT - 8.5) * Math.pow(1 - y / P2, 1.25);
/** Half the width of a leg's square section at height y. */
const legHW = (y: number) => 4.6 - 2.0 * (y / P2);
/** Half-width of the shaft above the second platform. */
const shaftHW = (y: number) => 2.2 + 8.9 * Math.exp(-(y - P2) / 21);

function latticeTexture() {
  const S = 256;
  const { c, x } = canvas(S);
  x.clearRect(0, 0, S, S);
  x.strokeStyle = "#fff";
  x.lineCap = "square";
  // Frame.
  x.lineWidth = 14;
  x.strokeRect(7, 7, S - 14, S - 14);
  // The big X.
  x.lineWidth = 9;
  x.beginPath();
  x.moveTo(0, 0);
  x.lineTo(S, S);
  x.moveTo(S, 0);
  x.lineTo(0, S);
  x.stroke();
  // And the small ones inside each quarter, which is what makes it lace.
  x.lineWidth = 4;
  for (const [ox, oy] of [
    [0, 0],
    [S / 2, 0],
    [0, S / 2],
    [S / 2, S / 2],
  ]) {
    x.beginPath();
    x.moveTo(ox + S / 4, oy);
    x.lineTo(ox + S / 4, oy + S / 2);
    x.moveTo(ox, oy + S / 4);
    x.lineTo(ox + S / 2, oy + S / 4);
    x.stroke();
  }
  const t = tex(c, true, false);
  return t;
}

export function buildEiffel(opts: { boxes: WorldBox[]; cx: number; cz: number; lowDetail: boolean; lookAt: number[] }): Eiffel {
  const { boxes, cx, cz } = opts;
  const group = new THREE.Group();
  group.position.set(cx, 0, cz);
  const trash: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(t: T) => (trash.push(t), t);
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // "Eiffel Tower Brown", the colour it has been painted since 1968.
  const BRONZE = "#6e5139";
  const lattice = keep(latticeTexture());
  const latticeMat = keep(
    new THREE.MeshStandardMaterial({
      color: BRONZE,
      alphaMap: lattice,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: 0.75,
      metalness: 0.3,
      emissive: "#ffb24a",
      emissiveMap: lattice,
      emissiveIntensity: 0,
    }),
  );
  const ironMat = keep(new THREE.MeshStandardMaterial({ color: BRONZE, roughness: 0.7, metalness: 0.35, emissive: "#ffb24a", emissiveIntensity: 0 }));
  const deckMat = keep(new THREE.MeshStandardMaterial({ color: "#8d7a66", roughness: 0.9 }));

  const members: THREE.BufferGeometry[] = [];
  const panels: THREE.BufferGeometry[] = [];
  /** Lattice panels on the four faces between two square rings. */
  const skin = (a: Array<[number, number]>, b: Array<[number, number]>, y0: number, y1: number, tile: number) => {
    for (let k = 0; k < 4; k++) {
      const n = (k + 1) % 4;
      panels.push(quad(V(a[k][0], y0, a[k][1]), V(a[n][0], y0, a[n][1]), V(b[n][0], y1, b[n][1]), V(b[k][0], y1, b[k][1]), tile));
    }
  };
  const ringAt = (ox: number, oz: number, hw: number): Array<[number, number]> => [
    [ox - hw, oz - hw],
    [ox + hw, oz - hw],
    [ox + hw, oz + hw],
    [ox - hw, oz + hw],
  ];

  // ---- Legs ----------------------------------------------------------------
  const LEG_STEPS = opts.lowDetail ? 4 : 6;
  const legs: Array<[number, number]> = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (const [sx, sz] of legs) {
    let prev: Array<[number, number]> | null = null;
    let prevY = 0;
    for (let i = 0; i <= LEG_STEPS; i++) {
      const y = (i / LEG_STEPS) * P2;
      const c = legC(y);
      const ring = ringAt(sx * c, sz * c, legHW(y));
      if (prev) {
        skin(prev, ring, prevY, y, 3.2);
        for (let k = 0; k < 4; k++) members.push(beam(V(prev[k][0], prevY, prev[k][1]), V(ring[k][0], y, ring[k][1]), 0.32));
      }
      prev = ring;
      prevY = y;
    }
    // Footings: the four stone piers each leg stands on. Solid.
    const c0 = legC(0);
    for (const [fx, fz] of ringAt(sx * c0, sz * c0, legHW(0))) {
      solid(boxes, cx + fx, cz + fz, 1.6, 1.6, 0, 2.4);
      const g = new THREE.BoxGeometry(1.8, 2.4, 1.8);
      g.translate(fx, 1.2, fz);
      members.push(g);
    }
  }

  // ---- Shaft ---------------------------------------------------------------
  {
    const STEPS = opts.lowDetail ? 8 : 13;
    let prev = ringAt(0, 0, shaftHW(P2));
    let prevY = P2;
    for (let i = 1; i <= STEPS; i++) {
      // Spaced closer near the bottom, where the curve is.
      const y = P2 + (SUMMIT - P2) * Math.pow(i / STEPS, 1.35);
      const ring = ringAt(0, 0, shaftHW(y));
      skin(prev, ring, prevY, y, 2.6);
      for (let k = 0; k < 4; k++) members.push(beam(V(prev[k][0], prevY, prev[k][1]), V(ring[k][0], y, ring[k][1]), 0.26));
      // A horizontal belt every other step.
      if (i % 2 === 0) for (let k = 0; k < 4; k++) members.push(beam(V(ring[k][0], y, ring[k][1]), V(ring[(k + 1) % 4][0], y, ring[(k + 1) % 4][1]), 0.18));
      prev = ring;
      prevY = y;
    }
  }

  // ---- Arches under the first platform ---------------------------------------
  {
    const SPAN = 14.6;
    const FACE = 16.8;
    const arch = (x: number) => 2 + 19.4 * Math.sqrt(Math.max(0, 1 - (x / SPAN) ** 2));
    for (let k = 0; k < 4; k++) {
      // Build on the +z face and rotate round.
      const parts: THREE.BufferGeometry[] = [];
      const N = opts.lowDetail ? 14 : 24;
      for (let i = 0; i < N; i++) {
        const x0 = -SPAN + (2 * SPAN * i) / N;
        const x1 = -SPAN + (2 * SPAN * (i + 1)) / N;
        parts.push(beam(V(x0, arch(x0), FACE), V(x1, arch(x1), FACE), 0.28, 5));
        const top0 = Math.min(P1 - 0.4, arch(x0) + 1.6);
        const top1 = Math.min(P1 - 0.4, arch(x1) + 1.6);
        panels.push(quad(V(x0, arch(x0), FACE), V(x1, arch(x1), FACE), V(x1, top1, FACE), V(x0, top0, FACE), 1.6));
      }
      const g = merge(parts);
      g.rotateY((k * Math.PI) / 2);
      members.push(g);
      // The panels were pushed straight into `panels`; rotate those too.
      for (let i = panels.length - N; i < panels.length; i++) panels[i].rotateY((k * Math.PI) / 2);
    }
  }

  // ---- Platforms ---------------------------------------------------------------
  const platform = (y: number, ho: number, hi: number, skirt: number) => {
    // Floor slab and a decorated skirt round the outside.
    const g = new THREE.BoxGeometry(ho * 2, 0.5, ho * 2);
    g.translate(0, y - 0.25, 0);
    const slab: THREE.BufferGeometry[] = [];
    // Hollow square: four bars.
    const band = ho - hi;
    for (const [x, z, w, d] of [
      [0, hi + band / 2, ho * 2, band],
      [0, -hi - band / 2, ho * 2, band],
      [hi + band / 2, 0, band, hi * 2],
      [-hi - band / 2, 0, band, hi * 2],
    ]) {
      const b = new THREE.BoxGeometry(w, 0.5, d);
      b.translate(x, y - 0.25, z);
      slab.push(b);
    }
    g.dispose();
    const m = new THREE.Mesh(keep(merge(slab)), deckMat);
    m.receiveShadow = true;
    m.castShadow = true;
    group.add(m);
    const sk = ringAt(0, 0, ho + 0.05);
    skin(sk, sk, y - skirt, y + 0.9, 1.2);
    squareRing(boxes, cx, cz, ho, hi, y);
    // Railing: outer and inner. Collision to 1.2 m.
    squareWall(boxes, cx, cz, ho - 0.2, y, y + 1.25, 0.3);
  };
  platform(P1, 18.4, 9.2, 3.2);
  platform(P2, 12.4, 6.0, 2.4);
  // The second platform's inner rail has a gap where the bridge to the central
  // lift goes (the -x side).
  squareWall(boxes, cx, cz, 6.2, P2, P2 + 1.25, 0.3, [3], 2.8);
  {
    // The bridge.
    solid(boxes, cx - 3.6, cz, 4.8, 2.6, P2 - 0.5, P2);
    const g = new THREE.BoxGeometry(4.8, 0.4, 2.6);
    g.translate(-3.6, P2 - 0.2, 0);
    group.add(new THREE.Mesh(keep(g), deckMat));
  }
  // First platform's inner rail.
  squareWall(boxes, cx, cz, 9.4, P1, P1 + 1.25, 0.3);

  // ---- Summit ----------------------------------------------------------------------
  {
    const HO = 4.8;
    const HI = 3.0;
    const floor = new THREE.BoxGeometry(HO * 2, 0.5, HO * 2);
    floor.translate(0, SUMMIT - 0.25, 0);
    const f = new THREE.Mesh(keep(floor), deckMat);
    f.receiveShadow = true;
    group.add(f);
    solid(boxes, cx, cz, HO * 2, HO * 2, SUMMIT - 0.5, SUMMIT);
    // The enclosed room: glazed, with a doorway in each wall.
    squareWall(boxes, cx, cz, HI, SUMMIT, SUMMIT + 3, 0.3, [0, 1, 2, 3], 2.0);
    squareWall(boxes, cx, cz, HO - 0.2, SUMMIT, SUMMIT + 1.3, 0.3);
    const roof = new THREE.BoxGeometry(HI * 2 + 0.6, 0.4, HI * 2 + 0.6);
    roof.translate(0, SUMMIT + 3.2, 0);
    group.add(new THREE.Mesh(keep(roof), ironMat));
    solid(boxes, cx, cz, HI * 2 + 0.6, HI * 2 + 0.6, SUMMIT + 3, SUMMIT + 3.4);
    // Windows: a pane band on each wall, either side of the doorway.
    const win = keep(new THREE.MeshStandardMaterial({ color: "#b9d9e6", transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
    const panes: THREE.BufferGeometry[] = [];
    const posts: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 4; k++) {
      for (const s of [-1, 1]) {
        const g = new THREE.PlaneGeometry(HI - 1.0, 2.6);
        g.translate(s * (1.0 + (HI - 1.0) / 2), SUMMIT + 1.6, HI);
        g.rotateY((k * Math.PI) / 2);
        panes.push(g);
      }
      for (const px of [-HI, -1.0, 1.0, HI]) {
        const p = new THREE.BoxGeometry(0.16, 3, 0.16);
        p.translate(px, SUMMIT + 1.5, HI);
        p.rotateY((k * Math.PI) / 2);
        posts.push(p);
      }
    }
    group.add(new THREE.Mesh(keep(merge(panes)), win));
    group.add(new THREE.Mesh(keep(merge(posts)), ironMat));
    // Outer railing posts and rail.
    const rails: THREE.BufferGeometry[] = [];
    const r = ringAt(0, 0, HO - 0.2);
    for (let k = 0; k < 4; k++) {
      const a = r[k];
      const b = r[(k + 1) % 4];
      rails.push(beam(V(a[0], SUMMIT + 1.2, a[1]), V(b[0], SUMMIT + 1.2, b[1]), 0.06, 4));
      for (let i = 0; i < 8; i++) {
        const t = i / 8;
        const px = a[0] + (b[0] - a[0]) * t;
        const pz = a[1] + (b[1] - a[1]) * t;
        rails.push(beam(V(px, SUMMIT, pz), V(px, SUMMIT + 1.2, pz), 0.04, 4));
      }
    }
    group.add(new THREE.Mesh(keep(merge(rails)), ironMat));
    // The lantern and the antenna.
    const lantern = new THREE.CylinderGeometry(1.3, 1.9, 4, 8);
    lantern.translate(0, SUMMIT + 5.4, 0);
    const cap = new THREE.CylinderGeometry(0.4, 1.4, 2.4, 8);
    cap.translate(0, SUMMIT + 8.6, 0);
    const mast = new THREE.CylinderGeometry(0.06, 0.32, TIP - SUMMIT - 9.8, 6);
    mast.translate(0, (SUMMIT + 9.8 + TIP) / 2, 0);
    group.add(new THREE.Mesh(keep(merge([lantern, cap, mast])), ironMat));

    // The champagne bar, and Gustave's office in the corner.
    const bar = new THREE.BoxGeometry(2.6, 1.05, 0.6);
    bar.translate(1.2, SUMMIT + 0.52, -2.2);
    const wood = keep(new THREE.MeshStandardMaterial({ color: "#5b3a22", roughness: 0.55 }));
    group.add(new THREE.Mesh(keep(bar), wood));
    solid(boxes, cx + 1.2, cz - 2.2, 2.6, 0.6, SUMMIT, SUMMIT + 1.05);
    const sign = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(2.2, 0.42)),
      keep(new THREE.MeshBasicMaterial({ map: keep(signTexture([{ text: "BAR À CHAMPAGNE", size: 96, color: "#f6d27a" }], "#1b120b", 1024, 196)) })),
    );
    sign.position.set(1.2, SUMMIT + 2.3, -2.7);
    group.add(sign);
    const glassMat = keep(new THREE.MeshStandardMaterial({ color: "#fff6d0", transparent: true, opacity: 0.6, emissive: "#ffcf5a", emissiveIntensity: 0.4 }));
    const flutes: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 5; i++) {
      const g = new THREE.CylinderGeometry(0.035, 0.02, 0.22, 6);
      g.translate(0.3 + i * 0.42, SUMMIT + 1.17, -2.15);
      flutes.push(g);
    }
    group.add(new THREE.Mesh(keep(merge(flutes)), glassMat));
  }

  // ---- Meshes ------------------------------------------------------------------------
  const frame = new THREE.Mesh(keep(merge(members)), ironMat);
  frame.castShadow = true;
  group.add(frame);
  const lace = new THREE.Mesh(keep(merge(panels)), latticeMat);
  lace.castShadow = true;
  // Without this the shadow pass ignores the cutout and every lattice panel
  // throws a solid black slab across the street.
  lace.customDepthMaterial = keep(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaMap: lattice, alphaTest: 0.5 }));
  group.add(lace);

  // ---- The ground round the legs: gravel, a crêpe cart, a sign ---------------------------
  {
    const { c, x } = canvas(256);
    const r = rng(1889);
    x.fillStyle = "#d8c7a2";
    x.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2400; i++) {
      x.fillStyle = `rgba(${120 + r() * 70},${100 + r() * 60},${70 + r() * 40},0.5)`;
      x.fillRect(r() * 256, r() * 256, 2, 2);
    }
    const t = keep(tex(c));
    const m = keep(new THREE.MeshStandardMaterial({ map: t, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 }));
    const parts: THREE.BufferGeometry[] = [];
    for (const [sx, sz] of legs) {
      const g = new THREE.PlaneGeometry(19, 19);
      g.rotateX(-Math.PI / 2);
      g.translate(sx * FOOT, 0.035, sz * FOOT);
      const uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 4, uv.getY(i) * 4);
      parts.push(g);
    }
    const gr = new THREE.Mesh(keep(merge(parts)), m);
    gr.receiveShadow = true;
    group.add(gr);
  }
  {
    // A crêpe cart by the north-west leg, under a striped awning.
    const cart = new THREE.Group();
    const body = new THREE.BoxGeometry(2.2, 1.0, 1.1);
    body.translate(0, 0.75, 0);
    const wheels = [-0.8, 0.8].map((x) => {
      const w = new THREE.CylinderGeometry(0.3, 0.3, 0.1, 12);
      w.rotateX(Math.PI / 2);
      w.translate(x, 0.3, 0.6);
      return w;
    });
    const posts = [-1, 1].map((x) => {
      const p = new THREE.CylinderGeometry(0.04, 0.04, 1.3, 6);
      p.translate(x * 1.0, 1.9, 0);
      return p;
    });
    cart.add(new THREE.Mesh(keep(merge([body, ...wheels, ...posts])), keep(new THREE.MeshStandardMaterial({ color: "#2f5d8a", roughness: 0.6 }))));
    const { c, x } = canvas(256, 64);
    for (let i = 0; i < 8; i++) {
      x.fillStyle = i % 2 ? "#ffffff" : "#d62839";
      x.fillRect(i * 32, 0, 32, 64);
    }
    const awn = new THREE.BoxGeometry(2.6, 0.12, 1.6);
    awn.translate(0, 2.6, 0);
    cart.add(new THREE.Mesh(keep(awn), keep(new THREE.MeshStandardMaterial({ map: keep(tex(c, false)) }))));
    const sign = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(1.8, 0.4)),
      keep(new THREE.MeshBasicMaterial({ map: keep(signTexture([{ text: "CRÊPES", size: 130, color: "#ffffff" }], "#d62839", 1024, 220)) })),
    );
    sign.position.set(0, 1.45, 0.56);
    cart.add(sign);
    cart.position.set(-FOOT + 7.5, 0, -FOOT + 10.5);
    cart.rotation.y = Math.PI / 4;
    group.add(cart);
    solid(boxes, cx - FOOT + 7.5, cz - FOOT + 10.5, 2.2, 1.6, 0, 1.25);
  }
  {
    const sTex = keep(
      signTexture(
        [
          { text: "TOUR EIFFEL", size: 120, color: "#f6d27a" },
          { text: "LIFT TO THE 2ND FLOOR · THEN THE SUMMIT", size: 44, color: "#ffffff", font: "600" },
        ],
        "#1b120b",
        1280,
        300,
        "#c99a3a",
      ),
    );
    const sign = new THREE.Mesh(keep(new THREE.PlaneGeometry(6, 1.4)), keep(new THREE.MeshBasicMaterial({ map: sTex, side: THREE.DoubleSide })));
    sign.position.set(-FOOT + 5.4, 2.4, -FOOT + 5.4);
    sign.rotation.y = Math.PI / 4;
    group.add(sign);
  }

  // ---- Night: sparkle and searchlight -------------------------------------------------------
  const night = new THREE.Group();
  night.visible = false;
  group.add(night);
  const SPARKS = opts.lowDetail ? 400 : 900;
  const sparkPos = new Float32Array(SPARKS * 3);
  const sparkCol = new Float32Array(SPARKS * 3);
  {
    const r = rng(1889);
    for (let i = 0; i < SPARKS; i++) {
      const y = Math.pow(r(), 1.3) * (SUMMIT + 4);
      let hw: number;
      let ox = 0;
      let oz = 0;
      if (y < P2) {
        const [sx, sz] = legs[Math.floor(r() * 4)];
        hw = legHW(y);
        ox = sx * legC(y);
        oz = sz * legC(y);
      } else {
        hw = shaftHW(Math.min(y, SUMMIT));
      }
      // A point on one face of the square section.
      const face = Math.floor(r() * 4);
      const t = (r() * 2 - 1) * hw;
      const px = face < 2 ? t : face === 2 ? hw : -hw;
      const pz = face < 2 ? (face === 0 ? hw : -hw) : t;
      sparkPos.set([ox + px, y, oz + pz], i * 3);
    }
  }
  const sparkGeo = keep(new THREE.BufferGeometry());
  sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
  sparkGeo.setAttribute("color", new THREE.BufferAttribute(sparkCol, 3));
  const sparkMat = keep(
    new THREE.PointsMaterial({ size: 0.9, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }),
  );
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.frustumCulled = false;
  night.add(sparks);
  const beamMat = keep(
    new THREE.MeshBasicMaterial({ color: "#fff2c0", transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  const searchlight = new THREE.Group();
  searchlight.position.set(0, SUMMIT + 5.4, 0);
  for (const s of [0, Math.PI]) {
    const g = new THREE.CylinderGeometry(0.4, 9, 240, 14, 1, true);
    g.translate(0, 120, 0);
    g.rotateZ(-Math.PI / 2 + 0.06);
    g.rotateY(s);
    searchlight.add(new THREE.Mesh(keep(g), beamMat));
  }
  night.add(searchlight);

  // ---- Lifts ---------------------------------------------------------------------------------
  const cageMat = keep(new THREE.MeshStandardMaterial({ color: "#8a2f24", roughness: 0.55, metalness: 0.3 }));
  const cageGlass = keep(new THREE.MeshStandardMaterial({ color: "#e8d9b0", transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide }));
  const makeCar = () => {
    const car = new THREE.Group();
    const parts: THREE.BufferGeometry[] = [];
    const f = new THREE.BoxGeometry(2.4, 0.2, 2.4);
    f.translate(0, -0.1, 0);
    const rf = new THREE.BoxGeometry(2.5, 0.25, 2.5);
    rf.translate(0, 2.85, 0);
    parts.push(f, rf);
    for (const [px, pz] of [
      [1.15, 1.15],
      [-1.15, 1.15],
      [1.15, -1.15],
      [-1.15, -1.15],
    ]) {
      const p = new THREE.BoxGeometry(0.14, 2.8, 0.14);
      p.translate(px, 1.4, pz);
      parts.push(p);
    }
    car.add(new THREE.Mesh(keep(merge(parts)), cageMat));
    const w = new THREE.BoxGeometry(2.34, 2.7, 2.34);
    w.translate(0, 1.4, 0);
    car.add(new THREE.Mesh(keep(w), cageGlass));
    group.add(car);
    return car;
  };
  const origin = V(cx, 0, cz);
  const world = (v: THREE.Vector3) => v.clone().add(origin);
  const legPath = (sx: number, sz: number) => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const y = (i / 8) * P2;
      const c = legC(y);
      pts.push(V(sx * c, y + 0.05, sz * c));
    }
    return pts;
  };
  const elevators: Elevator[] = [];
  for (const [i, [sx, sz]] of (
    [
      [-1, -1],
      [1, 1],
    ] as Array<[number, number]>
  ).entries()) {
    const path = legPath(sx, sz);
    const bottom = path[0];
    const top = path[path.length - 1];
    elevators.push(
      new Elevator({
        id: `eiffel-leg-${i}`,
        car: makeCar(),
        path,
        origin,
        exits: [world(V(bottom.x - sx * 2.6, 0.05, bottom.z - sz * 2.6)), world(V(top.x, P2 + 0.05, top.z - sz * 1.9))],
        startAtTop: i === 1,
        speed: 6,
      }),
    );
  }
  const central = new Elevator({
    id: "eiffel-central",
    car: makeCar(),
    path: [V(0, P2 + 0.05, 0), V(0, SUMMIT + 0.05, 0)],
    origin,
    exits: [world(V(-3.4, P2 + 0.05, 0)), world(V(0, SUMMIT + 0.05, 2.0))],
    speed: 8,
  });
  elevators.push(central);

  // ---- Stations ---------------------------------------------------------------------------------
  const stations: Station[] = [];
  const viewers: Array<Viewer & { station: Station }> = [];
  const scopeMat = keep(new THREE.MeshStandardMaterial({ color: "#2e6b4f", metalness: 0.5, roughness: 0.4 }));
  for (const a of opts.lookAt) {
    // On the summit's outer walk, in the direction it looks.
    const dir = V(Math.cos(a), 0, Math.sin(a));
    const r = 4.1 / Math.max(Math.abs(dir.x), Math.abs(dir.z));
    const p = dir.clone().multiplyScalar(r).setY(SUMMIT);
    const s = buildBinoculars(scopeMat, trash);
    s.position.copy(p);
    s.rotation.y = Math.atan2(dir.x, dir.z);
    group.add(s);
    const station: Station = {
      id: `eiffel-scope-${a.toFixed(2)}`,
      label: "Look through the binoculars",
      emoji: "🔭",
      pos: world(p),
      radius: 1.2,
      act: () => {},
    };
    viewers.push({ eye: world(p.clone().addScaledVector(dir, 0.9).setY(SUMMIT + 1.6)), yaw: Math.atan2(-dir.x, -dir.z), station });
    stations.push(station);
  }

  let isNight = false;
  let sparkUntil = 0;
  let sparkNow = false;
  let clock = 0;
  const r = rng(7);
  return {
    group,
    stations,
    viewers,
    elevators,
    central,
    deckY: SUMMIT,
    topY: TIP,
    roofs: [deckMat],
    setNight(n) {
      isNight = n;
      night.visible = n;
      latticeMat.emissiveIntensity = n ? 1.05 : 0;
      ironMat.emissiveIntensity = n ? 0.55 : 0;
    },
    sparkle() {
      if (isNight) sparkUntil = clock + 20;
    },
    sparkling: () => sparkNow,
    indoors: (p) => p.y > SUMMIT - 0.5 && p.y < SUMMIT + 3.2 && Math.abs(p.x - cx) < 4.8 && Math.abs(p.z - cz) < 4.8,
    update(dt, now) {
      clock += dt;
      if (!isNight) return;
      searchlight.rotation.y = now * 0.00035;
      // Every two minutes, twenty seconds of sparkle.
      const scheduled = (now / 1000) % 120 < 20;
      sparkNow = scheduled || clock < sparkUntil;
      sparks.visible = sparkNow;
      if (sparkNow) {
        for (let i = 0; i < SPARKS; i++) {
          const on = r() < 0.12 ? 1 : 0;
          sparkCol[i * 3] = on;
          sparkCol[i * 3 + 1] = on * 0.97;
          sparkCol[i * 3 + 2] = on * 0.88;
        }
        (sparkGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
      }
    },
    dispose() {
      trash.forEach((t) => t.dispose());
    },
  };
}
