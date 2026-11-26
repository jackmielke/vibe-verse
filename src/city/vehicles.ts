/**
 * vehicles — what you can drive in Vibe City, how each one handles, and how
 * much punishment it takes before it goes up.
 *
 * The physics live in City's tick (they share its collision helpers and input
 * state); this file is the part of it that is data, plus the two models that
 * are not go-karts. Everything that decides an outcome — how much a hit
 * costs, when a car is smoking, when it explodes — is a pure function here so
 * it can be tested without a renderer.
 *
 * Conventions match `karts.ts`: forward is (sin yaw, 0, cos yaw), +Z.
 */
import * as THREE from "three";
import type { KartMesh } from "@/components/city/karts";

export type VehicleKind = "kart" | "monster" | "comet" | "car";

export interface VehicleSpec {
  label: string;
  /** Top speed, m/s, and with Shift held. */
  max: number;
  boost: number;
  /** Throttle acceleration, m/s². */
  accel: number;
  /** Yaw rate at full lock, rad/s. */
  steer: number;
  /** Speed at which steering reaches full authority. Heavier things need more. */
  gripSpeed: number;
  /** Damage multiplier on everything that hits it. */
  armour: number;
  /** Rides over and flattens other cars instead of bouncing off them. */
  crushes: boolean;
  /** Where the collision probe sits above the wheels: higher climbs more. */
  nose: number;
  /** How far ahead of the middle the collision probe sits: about half the length. */
  reach: number;
  /** Where the driver's body goes, above the vehicle's origin. */
  seat: number;
  /** Rolling radius, for spinning the wheels at the right rate. */
  wheelR: number;
  /** Closed cab: the driver is not drawn. */
  enclosed: boolean;
  /** Paint, for debris when it goes up. */
  paint: number;
}

export const VEHICLES: Record<VehicleKind, VehicleSpec> = {
  kart: {
    label: "vibe kart", max: 23, boost: 32, accel: 28, steer: 1.85, gripSpeed: 8,
    armour: 1, crushes: false, nose: 0.5, reach: 0.7, seat: 0.72, wheelR: 0.32, enclosed: false, paint: 0xff6b6b,
  },
  car: {
    label: "car", max: 23, boost: 32, accel: 28, steer: 1.85, gripSpeed: 8,
    armour: 0.9, crushes: false, nose: 0.5, reach: 1.5, seat: 0.72, wheelR: 0.32, enclosed: true, paint: 0x9aa2ab,
  },
  /**
   * The monster truck. Slow off the line, does not care what is in front of
   * it: cars go under it, trees go over, and it climbs anything up to about a
   * metre and a half, which is most of the street furniture and every car.
   */
  monster: {
    label: "monster truck", max: 21, boost: 28, accel: 20, steer: 1.35, gripSpeed: 10,
    armour: 0.3, crushes: true, nose: 1.0, reach: 2.1, seat: 2.25, wheelR: 1.05, enclosed: true, paint: 0x7b2ff7,
  },
  /**
   * The Comet. One per visit, parked somewhere different every time, under a
   * gold beam you can see from anywhere in the city. Roughly twice as fast as
   * anything else on the road and made of tinfoil: it is the car that teaches
   * you what the damage meter is for.
   */
  comet: {
    label: "Vibe Comet", max: 48, boost: 66, accel: 52, steer: 2.3, gripSpeed: 9,
    armour: 1.35, crushes: false, nose: 0.4, reach: 1.7, seat: 0.45, wheelR: 0.36, enclosed: true, paint: 0xffc531,
  },
};

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

export type ImpactSurface = "wall" | "car" | "tree" | "lamp" | "sign" | "signal" | "blast";

/** Health every vehicle starts with. */
export const MAX_HEALTH = 100;
/** Below this, black smoke. */
export const SMOKE_AT = 55;
/** Below this, it is on fire. */
export const FIRE_AT = 25;

/**
 * What one hit costs, in health.
 *
 * The shape that matters: tapping things is free, so parking is not a
 * minigame, and the cost climbs faster than the speed, so a head-on into a
 * tower at full chat is most of a car and three of them is certainly all of
 * it. Running down street furniture costs a little each time, which is what
 * makes "hit too many obstacles and it explodes" true without any single tree
 * being lethal.
 */
export function impactDamage(kind: VehicleKind, surface: ImpactSurface, speed: number): number {
  const spec = VEHICLES[kind];
  const s = Math.abs(speed);
  let raw: number;
  switch (surface) {
    case "wall":
      raw = s < 5 ? 0 : (s - 5) * 2.1 + ((s - 5) * (s - 5)) / 22;
      break;
    case "car":
      raw = s < 4 ? 0 : (s - 4) * 1.3;
      break;
    case "tree":
      raw = s < 3 ? 0 : 5 + s * 0.15;
      break;
    case "lamp":
    case "signal":
      raw = s < 3 ? 0 : 4 + s * 0.12;
      break;
    case "sign":
      raw = s < 3 ? 0 : 2.5;
      break;
    case "blast":
      raw = s;
      break;
  }
  // The monster truck does not notice furniture at all.
  if (spec.crushes && surface !== "wall" && surface !== "blast") return 0;
  return raw * spec.armour;
}

/** 0..1 how much smoke and fire a car at this health should be pouring out. */
export function distress(health: number): { smoke: number; fire: number } {
  const smoke = health >= SMOKE_AT ? 0 : THREE.MathUtils.clamp((SMOKE_AT - health) / SMOKE_AT, 0, 1);
  const fire = health >= FIRE_AT ? 0 : THREE.MathUtils.clamp((FIRE_AT - health) / FIRE_AT, 0.15, 1);
  return { smoke, fire };
}

/** Where the rare Comet may turn up. Kerbside spots on the grid's streets. */
export function cometSpot(seed: number, pitch: number, grid: number): { x: number; z: number; yaw: number } {
  const centre = (grid - 1) / 2;
  let s = (seed >>> 0) || 1;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  // A street (between blocks), and a point along it inside a block, so it is
  // never parked in a junction. Not the middle street: that is the plaza's.
  let g = 1 + Math.floor(rnd() * (grid - 1));
  if (g === Math.floor(grid / 2) || g === Math.ceil(grid / 2)) g = 1;
  const street = (g - centre - 0.5) * pitch;
  const k = Math.floor(rnd() * grid);
  const along = (k - centre) * pitch + (rnd() - 0.5) * pitch * 0.3;
  const axis = rnd() < 0.5 ? 0 : 1;
  const kerb = (rnd() < 0.5 ? -1 : 1) * 3.6;
  return axis === 0
    ? { x: street + kerb, z: along, yaw: rnd() < 0.5 ? 0 : Math.PI }
    : { x: along, z: street + kerb, yaw: rnd() < 0.5 ? Math.PI / 2 : -Math.PI / 2 };
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const std = (color: number | string, roughness = 0.5, metalness = 0.2) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });

function wheelSet(
  g: THREE.Group, r: number, w: number, xs: number, zf: number, zr: number,
  tyreMat: THREE.Material, hubMat: THREE.Material, treads = 0,
) {
  const wheels: THREE.Mesh[] = [];
  const frontPivots: THREE.Group[] = [];
  const tyreGeo = new THREE.CylinderGeometry(r, r, w, 20);
  const hubGeo = new THREE.CylinderGeometry(r * 0.48, r * 0.48, w + 0.04, 10);
  // Radial, axial (the cylinder's own Y), tangential.
  const lugGeo = treads ? new THREE.BoxGeometry(r * 0.18, w * 1.02, r * 0.32) : null;
  for (const [x, z, front] of [[-xs, zf, true], [xs, zf, true], [-xs, zr, false], [xs, zr, false]] as const) {
    const wheel = new THREE.Mesh(tyreGeo, tyreMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.castShadow = true;
    const hub = new THREE.Mesh(hubGeo, hubMat);
    wheel.add(hub);
    if (lugGeo) {
      // Chunky tread blocks round the rim: what makes a big wheel read as a
      // monster-truck tyre rather than a large black disc.
      for (let i = 0; i < treads; i++) {
        const a = (i / treads) * Math.PI * 2;
        const lug = new THREE.Mesh(lugGeo, tyreMat);
        // Wheel-local: the cylinder's axis is Y, the tread runs around X/Z.
        lug.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
        lug.rotation.y = -a;
        wheel.add(lug);
      }
    }
    if (front) {
      const pivot = new THREE.Group();
      pivot.position.set(x, r, z);
      pivot.add(wheel);
      g.add(pivot);
      frontPivots.push(pivot);
    } else {
      wheel.position.set(x, r, z);
      g.add(wheel);
    }
    wheels.push(wheel);
  }
  return { wheels, frontPivots };
}

function glowUnder(g: THREE.Group, color: number, w: number, l: number) {
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(w, l),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.06;
  g.add(glow);
  return glow;
}

/** A purple monster truck on 2.1 m tyres, with a roll cage and roof lights. */
export function buildMonsterTruck(): KartMesh {
  const g = new THREE.Group();
  g.name = "city/monster-truck";
  const paint = std(0x7b2ff7, 0.35, 0.35);
  const flame = std(0xff7a1a, 0.4, 0.2);
  const dark = std(0x1a1d22, 0.7, 0.3);
  const chrome = std(0xd8dde2, 0.2, 0.95);
  const glass = std(0x1c2a33, 0.1, 0.3);
  const rubber = std(0x111316, 0.9, 0);
  const R = 1.05;

  const { wheels, frontPivots } = wheelSet(g, R, 0.9, 1.45, 1.75, -1.75, rubber, chrome, 14);

  // Chassis rails and the suspension you are supposed to see.
  const rail = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.3, 4.4), dark);
  rail.position.y = R + 0.15;
  g.add(rail);
  for (const z of [1.75, -1.75]) {
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.9, 8), dark);
    axle.rotation.z = Math.PI / 2;
    axle.position.set(0, R, z);
    g.add(axle);
    for (const x of [-0.7, 0.7]) {
      const spring = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.8, 8), flame);
      spring.position.set(x, R + 0.45, z);
      spring.rotation.z = x < 0 ? 0.35 : -0.35;
      g.add(spring);
    }
  }

  // Body: pickup bed, cab, bonnet, all sitting high.
  const bodyY = R + 0.85;
  const tub = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.75, 4.6), paint);
  tub.position.y = bodyY;
  g.add(tub);
  const bonnet = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.32, 1.5), paint);
  bonnet.position.set(0, bodyY + 0.5, 1.45);
  bonnet.rotation.x = 0.06;
  g.add(bonnet);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.95, 1.6), paint);
  cab.position.set(0, bodyY + 0.85, -0.1);
  g.add(cab);
  const screen = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.62, 0.06), glass);
  screen.position.set(0, bodyY + 0.95, 0.72);
  screen.rotation.x = -0.25;
  g.add(screen);
  for (const x of [-1.06, 1.06]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.5, 1.2), glass);
    side.position.set(x, bodyY + 0.95, -0.1);
    g.add(side);
    // Flame stripe down each flank.
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.22, 3.6), flame);
    stripe.position.set(x * 1.09, bodyY, 0.1);
    g.add(stripe);
  }
  // Grille and bull bar.
  const grille = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 0.1), chrome);
  grille.position.set(0, bodyY + 0.05, 2.32);
  g.add(grille);
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.4, 8), chrome);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0, bodyY - 0.25, 2.55);
  g.add(bar);
  // Roll bar over the bed, light bar on the roof.
  const hoop = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.07, 8, 18, Math.PI), chrome);
  hoop.position.set(0, bodyY + 0.38, -1.4);
  g.add(hoop);
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff3c4 });
  for (let i = 0; i < 4; i++) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.18, 0.12), lightMat);
    l.position.set(-0.6 + i * 0.4, bodyY + 1.42, 0.55);
    g.add(l);
  }
  for (const x of [-0.75, 0.75]) {
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), lightMat);
    head.position.set(x, bodyY + 0.2, 2.33);
    g.add(head);
  }
  // Exhaust stacks either side of the cab.
  for (const x of [-1.0, 1.0]) {
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 1.4, 8), chrome);
    stack.position.set(x, bodyY + 1.0, -0.95);
    g.add(stack);
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
  });
  const glow = glowUnder(g, 0x9b5cff, 3.2, 5.2);
  return { group: g, wheels, frontPivots, glow };
}

/** The Comet: a low gold wedge with a canopy, a wing and a lot of light. */
export function buildComet(): KartMesh {
  const g = new THREE.Group();
  g.name = "city/comet";
  const paint = std(0xffc531, 0.22, 0.75);
  const carbon = std(0x15171b, 0.45, 0.5);
  const glass = std(0x101820, 0.05, 0.6);
  const rubber = std(0x101214, 0.85, 0);
  const rim = std(0x2a2d33, 0.25, 0.9);
  const R = 0.36;
  const { wheels, frontPivots } = wheelSet(g, R, 0.34, 0.95, 1.35, -1.3, rubber, rim);

  // Wedge body: lofted from a side profile so it has a real nose.
  const shape = new THREE.Shape();
  shape.moveTo(-2.25, 0.25);
  shape.lineTo(2.25, 0.22);
  shape.lineTo(2.3, 0.42);
  shape.lineTo(0.9, 0.78);
  shape.lineTo(-1.6, 0.86);
  shape.lineTo(-2.25, 0.72);
  shape.closePath();
  const bodyGeo = new THREE.ExtrudeGeometry(shape, { depth: 1.9, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.08, bevelSegments: 2 });
  bodyGeo.translate(0, 0, -0.95);
  bodyGeo.rotateY(-Math.PI / 2);
  const body = new THREE.Mesh(bodyGeo, paint);
  g.add(body);
  // Canopy.
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.75, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), glass);
  canopy.scale.set(0.95, 0.55, 1.7);
  canopy.position.set(0, 0.82, -0.15);
  g.add(canopy);
  // Splitter, side skirts, rear wing.
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.06, 0.5), carbon);
  splitter.position.set(0, 0.22, 2.2);
  g.add(splitter);
  for (const x of [-1.02, 1.02]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 2.2), carbon);
    skirt.position.set(x, 0.3, 0);
    g.add(skirt);
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.45, 0.12), carbon);
    strut.position.set(x * 0.6, 1.05, -2.0);
    g.add(strut);
  }
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.07, 0.5), carbon);
  wing.position.set(0, 1.3, -2.05);
  g.add(wing);
  // Light: a thin bar across the nose and twin tail strips.
  const head = new THREE.MeshBasicMaterial({ color: 0xe8fbff });
  const tail = new THREE.MeshBasicMaterial({ color: 0xff3048 });
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.05, 0.05), head);
  nose.position.set(0, 0.45, 2.33);
  g.add(nose);
  for (const x of [-0.6, 0.6]) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.06, 0.05), tail);
    t.position.set(x, 0.72, -2.3);
    g.add(t);
  }
  // Exhaust nozzles, where the afterburn comes out.
  for (const x of [-0.35, 0.35]) {
    const n = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.25, 10), rim);
    n.rotation.x = Math.PI / 2;
    n.position.set(x, 0.42, -2.32);
    g.add(n);
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
  });
  const glow = glowUnder(g, 0xffd34d, 2.4, 4.8);
  return { group: g, wheels, frontPivots, glow };
}

/**
 * The beam over the Comet, so a rare car is a thing you can go and find
 * rather than a thing you might stumble on. Additive, unlit, no shadow.
 */
export function buildBeacon(color = 0xffd34d): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(0.9, 1.6, 140, 16, 1, true);
  geo.translate(0, 70, 0);
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  const m = new THREE.Mesh(geo, mat);
  m.name = "city/comet-beacon";
  return m;
}

/** Char a vehicle that has exploded: every material goes dark. Reversible. */
export function scorch(group: THREE.Object3D, on: boolean) {
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const sm = m as THREE.MeshStandardMaterial & { userData: { base?: number } };
      if (!sm.color) continue;
      if (on) {
        if (sm.userData.base === undefined) sm.userData.base = sm.color.getHex();
        sm.color.setRGB(0.12, 0.11, 0.1);
      } else if (sm.userData.base !== undefined) {
        sm.color.setHex(sm.userData.base);
      }
    }
  });
}
