/**
 * Builds the restaurant. One scene, twelve rooms, every wall a real wall.
 *
 * The only interesting idea in here is `wallRun`: a wall is described as a line
 * plus the holes in it, and the builder emits the segments *around* the holes
 * plus a header above each one. That is what lets the office's two doorways,
 * the supply closet's, and the openings into the dining room all be declared in
 * one line each instead of hand-placed as six boxes apiece.
 */
import * as THREE from "three";
import { DOORWAY, ROOMS, type Room, type RoomId } from "./rooms";
import {
  ceilingTile,
  poster,
  smallTile,
  stageCarpet,
  staticNoise,
  tileFloor,
  wallpaper,
  wood,
  type PosterKind,
} from "./textures";

export interface BuiltWorld {
  scene: THREE.Scene;
  /** The desk fan's blade assembly — spun every frame. */
  fan: THREE.Object3D;
  /** Sliding office doors, keyed by side. `y` is animated between the marks. */
  doors: { left: THREE.Mesh; right: THREE.Mesh };
  /** Hall lights, off until you hold the button. */
  hallLights: { left: THREE.SpotLight; right: THREE.SpotLight };
  /** The glow strip that fakes bounce light on the office wall by each door. */
  doorGlow: { left: THREE.PointLight; right: THREE.PointLight };
  /** Wall buttons; `mat` is re-tinted to show active state. */
  buttons: Array<{ mesh: THREE.Mesh; id: ButtonId; mat: THREE.MeshStandardMaterial }>;
  /** The office ceiling bulb — flickers, and dies when the power does. */
  officeLight: THREE.PointLight;
  /** Everything that should go dark at 0% power. */
  poweredLights: THREE.Light[];
  /** Desk monitor screens; they show static and switch off with the power. */
  screens: THREE.MeshStandardMaterial[];
  /** Anchors an animatronic can stand on, per room. */
  slots: Map<string, THREE.Object3D>;
  /** Pirate Cove's curtain — slides open as Foxy gets ready. */
  coveCurtain: THREE.Object3D;
  dispose: () => void;
}

export type ButtonId = "leftDoor" | "leftLight" | "rightDoor" | "rightLight";

export const DOOR_CLOSED_Y = 1.15;
export const DOOR_OPEN_Y = 3.6;

/* ---------------------------------------------------------------- helpers */

const WALL_T = 0.16;

/** Box with per-face UVs scaled to ~2 m of texture, so nothing looks stretched. */
function box(w: number, h: number, d: number, mat: THREE.Material, uPerM = 0.5) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const u = Math.max(w, d) * uPerM;
  const v = Math.max(h, Math.min(w, d)) * uPerM;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
  uv.needsUpdate = true;
  return new THREE.Mesh(g, mat);
}

/**
 * A wall along one axis with holes in it.
 *
 * `axis` is the direction the wall runs. `fixed` is its position on the other
 * axis. Holes are [from, to] spans in run-coordinates; each gets a header above
 * it so the wall still meets the ceiling.
 */
function wallRun(
  parent: THREE.Object3D,
  mat: THREE.Material,
  axis: "x" | "z",
  fixed: number,
  from: number,
  to: number,
  height: number,
  holes: Array<[number, number, number?]> = [],
) {
  const sorted = [...holes].sort((a, b) => a[0] - b[0]);
  let cursor = from;
  const place = (a: number, b: number, y0: number, y1: number) => {
    if (b - a < 0.01 || y1 - y0 < 0.01) return;
    const len = b - a;
    const h = y1 - y0;
    const m =
      axis === "x" ? box(len, h, WALL_T, mat) : box(WALL_T, h, len, mat);
    if (axis === "x") m.position.set((a + b) / 2, (y0 + y1) / 2, fixed);
    else m.position.set(fixed, (y0 + y1) / 2, (a + b) / 2);
    m.receiveShadow = true;
    parent.add(m);
  };
  for (const [a, b, hh] of sorted) {
    place(cursor, a, 0, height);
    place(a, b, hh ?? DOORWAY.height, height); // header over the opening
    cursor = b;
  }
  place(cursor, to, 0, height);
}

function floorAndCeiling(
  parent: THREE.Object3D,
  room: Room,
  floorMat: THREE.Material,
  ceilMat: THREE.Material | null,
) {
  const b = room.bounds;
  const w = b.x1 - b.x0;
  const d = b.z1 - b.z0;
  const f = box(w, 0.12, d, floorMat, 0.5);
  f.position.set((b.x0 + b.x1) / 2, -0.06, (b.z0 + b.z1) / 2);
  f.receiveShadow = true;
  parent.add(f);
  if (ceilMat) {
    const c = box(w, 0.12, d, ceilMat, 0.5);
    c.position.set((b.x0 + b.x1) / 2, room.height + 0.06, (b.z0 + b.z1) / 2);
    parent.add(c);
  }
}

/** A poster, flat against a wall, with a hair of tilt so it reads as taped up. */
function addPoster(
  parent: THREE.Object3D,
  kind: PosterKind,
  x: number,
  y: number,
  z: number,
  rotY: number,
  size = 0.9,
) {
  const mat = new THREE.MeshStandardMaterial({
    map: poster(kind),
    roughness: 0.95,
    metalness: 0,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  m.position.set(x, y, z);
  m.rotation.y = rotY;
  m.rotation.z = (Math.random() - 0.5) * 0.05;
  parent.add(m);
  return m;
}

function slot(world: BuiltWorld, key: string, x: number, z: number, faceY: number, y = 0) {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  o.rotation.y = faceY;
  world.scene.add(o);
  world.slots.set(key, o);
}

/* ------------------------------------------------------------------ build */

export function buildWorld(): BuiltWorld {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x03040a);
  // Exponential fog is what makes a fifteen-metre hallway feel like a hundred.
  scene.fog = new THREE.FogExp2(0x05070f, 0.052);

  const texFloor = tileFloor();
  texFloor.repeat.set(1, 1);
  const matFloor = new THREE.MeshStandardMaterial({ map: texFloor, roughness: 0.72, metalness: 0.04 });
  const matWall = new THREE.MeshStandardMaterial({ map: wallpaper(1), roughness: 0.94 });
  const matWall2 = new THREE.MeshStandardMaterial({ map: wallpaper(2), roughness: 0.94 });
  const matCeil = new THREE.MeshStandardMaterial({ map: ceilingTile(), roughness: 1 });
  const matCarpet = new THREE.MeshStandardMaterial({ map: stageCarpet(), roughness: 1 });
  const matWood = new THREE.MeshStandardMaterial({ map: wood("#4a3220"), roughness: 0.8 });
  const matWoodDark = new THREE.MeshStandardMaterial({ map: wood("#3d2a19"), roughness: 0.75 });
  const matSteel = new THREE.MeshStandardMaterial({ color: 0x8d939c, roughness: 0.36, metalness: 0.85 });
  const matTileWall = new THREE.MeshStandardMaterial({ map: smallTile(), roughness: 0.5 });
  const matBlack = new THREE.MeshStandardMaterial({ color: 0x0d0e14, roughness: 0.9 });

  const world: BuiltWorld = {
    scene,
    fan: new THREE.Object3D(),
    doors: {} as BuiltWorld["doors"],
    hallLights: {} as BuiltWorld["hallLights"],
    doorGlow: {} as BuiltWorld["doorGlow"],
    buttons: [],
    officeLight: new THREE.PointLight(),
    poweredLights: [],
    screens: [],
    slots: new Map(),
    coveCurtain: new THREE.Object3D(),
    dispose: () => undefined,
  };

  scene.add(new THREE.AmbientLight(0x1d2740, 0.5));

  /* --- shell: floors, ceilings and every wall in the building ------------ */

  const R = ROOMS;
  const dz: [number, number] = [DOORWAY.z0, DOORWAY.z1];

  // Office.
  floorAndCeiling(scene, R.office, matFloor, matCeil);
  wallRun(scene, matWall, "x", R.office.bounds.z0, -2.7, 2.7, R.office.height); // front
  wallRun(scene, matWall, "x", R.office.bounds.z1, -2.7, 2.7, R.office.height); // behind you
  wallRun(scene, matWall, "z", DOORWAY.westX, -3, 3, R.office.height, [dz]);
  wallRun(scene, matWall, "z", DOORWAY.eastX, -3, 3, R.office.height, [dz]);

  // Hall corners — share the door wall with the office, open north to the halls.
  for (const side of ["west", "east"] as const) {
    const room = side === "west" ? R.westCorner : R.eastCorner;
    const b = room.bounds;
    floorAndCeiling(scene, room, matFloor, matCeil);
    wallRun(scene, matWall2, "x", b.z1, b.x0, b.x1, room.height); // south end wall
    wallRun(scene, matWall2, "z", side === "west" ? b.x0 : b.x1, b.z0, b.z1, room.height); // outer
  }

  // The halls themselves.
  for (const side of ["west", "east"] as const) {
    const room = side === "west" ? R.westHall : R.eastHall;
    const b = room.bounds;
    floorAndCeiling(scene, room, matFloor, matCeil);
    const outerX = side === "west" ? b.x0 : b.x1;
    const innerX = side === "west" ? b.x1 : b.x0;
    // The closet/kitchen doorway is cut into the outer wall.
    wallRun(scene, matWall2, "z", outerX, b.z0, b.z1, room.height, [[-9.5, -7.5]]);
    wallRun(scene, matWall2, "z", innerX, b.z0, b.z1, room.height);
  }

  // Supply closet + kitchen — mirrored side rooms hanging off the halls.
  for (const room of [R.supply, R.kitchen]) {
    const b = room.bounds;
    const west = room.id === "supply";
    floorAndCeiling(scene, room, room.id === "kitchen" ? matTileWall : matFloor, matCeil);
    const mat = room.id === "kitchen" ? matTileWall : matWall2;
    wallRun(scene, mat, "x", b.z0, b.x0, b.x1, room.height);
    wallRun(scene, mat, "x", b.z1, b.x0, b.x1, room.height);
    wallRun(scene, mat, "z", west ? b.x0 : b.x1, b.z0, b.z1, room.height);
    // No wall on the hall side: the hall already builds that one, with the
    // doorway in it. Building it twice put two surfaces in the same plane.
  }

  // Dining area — the hub of the building; four openings.
  {
    const b = R.dining.bounds;
    floorAndCeiling(scene, R.dining, matFloor, matCeil);
    wallRun(scene, matWall, "x", b.z1, b.x0, b.x1, R.dining.height, [
      [-7.2, -2.7, ROOMS.westHall.height],
      [2.7, 7.2, ROOMS.eastHall.height],
    ]);
    wallRun(scene, matWall, "x", b.z0, b.x0, b.x1, R.dining.height, [[-6, 6, 3.4]]);
    wallRun(scene, matWall, "z", b.x0, b.z0, b.z1, R.dining.height, [[-18, -14, 2.6]]);
    wallRun(scene, matWall, "z", b.x1, b.z0, b.z1, R.dining.height, [[-18, -14, 2.6]]);
  }

  // Show stage — open to the dining room across its whole south wall.
  {
    const b = R.stage.bounds;
    floorAndCeiling(scene, R.stage, matCarpet, matCeil);
    wallRun(scene, matWall, "x", b.z0, b.x0, b.x1, R.stage.height);
    wallRun(scene, matWall, "z", b.x1, b.z0, b.z1, R.stage.height);
    wallRun(scene, matWall, "z", b.x0, b.z0, b.z1, R.stage.height, [[-27, -24]]);
  }

  // Backstage.
  {
    const b = R.backstage.bounds;
    floorAndCeiling(scene, R.backstage, matFloor, matCeil);
    wallRun(scene, matWall2, "x", b.z0, b.x0, b.x1, R.backstage.height);
    wallRun(scene, matWall2, "x", b.z1, b.x0, b.x1, R.backstage.height);
    wallRun(scene, matWall2, "z", b.x0, b.z0, b.z1, R.backstage.height);
    wallRun(scene, matWall2, "z", b.x1, b.z0, b.z1, R.backstage.height, [[-27, -24]]);
  }

  // Pirate Cove + Restrooms.
  for (const room of [R.cove, R.restrooms]) {
    const b = room.bounds;
    const west = room.id === "cove";
    const mat = room.id === "restrooms" ? matTileWall : matWall;
    floorAndCeiling(scene, room, room.id === "restrooms" ? matTileWall : matFloor, matCeil);
    wallRun(scene, mat, "x", b.z0, b.x0, b.x1, room.height);
    wallRun(scene, mat, "x", b.z1, b.x0, b.x1, room.height);
    wallRun(scene, mat, "z", west ? b.x0 : b.x1, b.z0, b.z1, room.height);
    wallRun(scene, mat, "z", west ? b.x1 : b.x0, b.z0, b.z1, room.height, [[-18, -14, 2.6]]);
  }

  // Skirting board. Four strips in the office and two in each corner room is
  // all it takes for the walls to sit on the floor instead of ending at it.
  const matTrim = new THREE.MeshStandardMaterial({ map: wood("#2b1d12"), roughness: 0.85 });
  const trim = (axis: "x" | "z", fixed: number, from: number, to: number) => {
    const len = to - from;
    const t = axis === "x" ? box(len, 0.16, 0.06, matTrim, 1) : box(0.06, 0.16, len, matTrim, 1);
    if (axis === "x") t.position.set((from + to) / 2, 0.08, fixed);
    else t.position.set(fixed, 0.08, (from + to) / 2);
    scene.add(t);
  };
  trim("x", -2.92, -2.62, 2.62);
  trim("x", 2.92, -2.62, 2.62);
  trim("z", -2.62, -2.92, -2.45);
  trim("z", -2.62, -0.4, 2.92);
  trim("z", 2.62, -2.92, -2.45);
  trim("z", 2.62, -0.4, 2.92);

  /* --- the office ------------------------------------------------------- */

  buildOffice(world, { matWood, matWoodDark, matSteel, matBlack });

  /* --- everywhere else -------------------------------------------------- */

  buildStage(world, { matWoodDark, matBlack });
  buildDining(world, { matWood, matWoodDark, matBlack });
  buildCove(world, matBlack);
  buildBackstage(world, { matSteel, matBlack, matWoodDark });
  buildKitchen(world, matSteel);
  buildRestrooms(world, { matWoodDark, matBlack });
  buildSupply(world, { matSteel, matBlack });
  buildHalls(world);

  /* --- where the cast can stand ----------------------------------------- */

  // Stage: the three of them in a row, facing the room.
  slot(world, "stage:freddy", 0, -25.2, 0, 0.45);
  slot(world, "stage:bonnie", -2.1, -25.4, 0.1, 0.45);
  slot(world, "stage:chica", 2.1, -25.4, -0.1, 0.45);
  slot(world, "dining:freddy", -1.5, -17.5, 0.4);
  slot(world, "dining:bonnie", -5.5, -16.4, 0.9);
  slot(world, "dining:chica", 4.6, -16.8, -0.7);
  slot(world, "backstage:bonnie", -9.6, -26.4, 1.4);
  slot(world, "restrooms:freddy", 14.4, -17.2, 2.6);
  slot(world, "restrooms:chica", 13.2, -15.6, 2.2);
  slot(world, "kitchen:freddy", 9.6, -8.8, 1.6);
  slot(world, "kitchen:chica", 8.8, -9.4, 1.9);
  slot(world, "supply:bonnie", -9.4, -8.4, 1.6);
  slot(world, "westHall:bonnie", -5.1, -8.4, Math.PI);
  slot(world, "eastHall:freddy", 4.8, -8.6, Math.PI);
  slot(world, "eastHall:chica", 5.3, -7.4, Math.PI);
  // At the door: standing in the corner room, looking straight in at you.
  slot(world, "westCorner:bonnie", -3.05, -1.5, Math.PI / 2);
  slot(world, "eastCorner:chica", 3.05, -1.5, -Math.PI / 2);
  slot(world, "eastCorner:freddy", 3.45, -2.0, -Math.PI / 2.1);
  slot(world, "cove:foxy", -14.1, -17.1, 0.15, 0.4);
  slot(world, "westHall:foxy", -4.95, -7.0, Math.PI);

  world.dispose = () => {
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    scene.clear();
  };

  return world;
}

/* ------------------------------------------------------------ the office */

function buildOffice(
  w: BuiltWorld,
  m: {
    matWood: THREE.Material;
    matWoodDark: THREE.Material;
    matSteel: THREE.Material;
    matBlack: THREE.Material;
  },
) {
  const g = new THREE.Group();
  w.scene.add(g);

  // Desk: top, apron, two pedestals.
  const top = box(3.5, 0.09, 1.15, m.matWood, 0.4);
  top.position.set(0, 0.76, 0.95);
  top.receiveShadow = true;
  g.add(top);
  const apron = box(3.5, 0.56, 0.08, m.matWoodDark, 0.5);
  apron.position.set(0, 0.45, 0.42);
  g.add(apron);
  for (const x of [-1.45, 1.45]) {
    const ped = box(0.5, 0.72, 1.0, m.matWoodDark, 0.5);
    ped.position.set(x, 0.36, 1.0);
    g.add(ped);
  }

  // Two CRTs, angled in, showing static. These are the office's main light.
  for (const [x, rot] of [
    [-0.92, 0.5],
    [0.86, -0.46],
  ] as const) {
    const shell = box(0.52, 0.42, 0.42, m.matBlack, 1);
    shell.position.set(x, 1.02, 0.72);
    shell.rotation.y = rot;
    g.add(shell);
    const screenMat = new THREE.MeshStandardMaterial({
      map: staticNoise(x < 0 ? 1 : 2),
      emissive: new THREE.Color(0x9fd7ff),
      emissiveIntensity: 0.9,
      emissiveMap: staticNoise(x < 0 ? 1 : 2),
      roughness: 0.4,
    });
    w.screens.push(screenMat);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.3), screenMat);
    screen.position.set(x + Math.sin(rot) * 0.215, 1.04, 0.72 + Math.cos(rot) * 0.215);
    screen.rotation.y = rot;
    g.add(screen);
  }
  const monitorGlow = new THREE.PointLight(0x8fc8ff, 5.5, 4, 2);
  monitorGlow.position.set(0, 1.3, 0.7);
  g.add(monitorGlow);
  w.poweredLights.push(monitorGlow);

  // The desk fan. Everyone remembers the fan.
  {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.05, 20), m.matBlack);
    base.position.set(1.28, 0.83, 0.95);
    g.add(base);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.32, 10), m.matBlack);
    stem.position.set(1.28, 1.0, 0.95);
    g.add(stem);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.1, 12), m.matSteel);
    hub.rotation.x = Math.PI / 2;
    hub.position.set(1.28, 1.22, 0.95);
    g.add(hub);
    w.fan.position.set(1.28, 1.22, 0.95);
    g.add(w.fan);
    const bladeMat = new THREE.MeshStandardMaterial({
      color: 0xb9c0c9,
      roughness: 0.35,
      metalness: 0.6,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
    });
    for (let i = 0; i < 3; i++) {
      const blade = new THREE.Mesh(new THREE.CircleGeometry(0.19, 12, 0, 1.5), bladeMat);
      blade.rotation.z = (i / 3) * Math.PI * 2;
      w.fan.add(blade);
    }
    // Cage: two rings, because a bare fan reads as a pinwheel.
    for (const r of [0.1, 0.2]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.006, 6, 24), m.matSteel);
      ring.position.set(1.28, 1.22, 0.95);
      g.add(ring);
    }
  }

  // The cupcake, with a lit candle, because of course.
  {
    const cake = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.07, 0.09, 14), new THREE.MeshStandardMaterial({ color: 0xd9a05b, roughness: 0.9 }));
    cake.position.set(-1.3, 0.82, 0.95);
    g.add(cake);
    const icing = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), new THREE.MeshStandardMaterial({ color: 0xf2c8d8, roughness: 0.7 }));
    icing.position.set(-1.3, 0.9, 0.95);
    icing.scale.y = 0.75;
    g.add(icing);
    const candle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, 0.1, 8),
      new THREE.MeshStandardMaterial({ color: 0xfff4e0, emissive: 0xffb347, emissiveIntensity: 0.4 }),
    );
    candle.position.set(-1.3, 1.0, 0.95);
    g.add(candle);
    const flame = new THREE.PointLight(0xffa64d, 1.4, 1.8, 2);
    flame.position.set(-1.3, 1.08, 0.95);
    g.add(flame);
    w.poweredLights.push(flame);
  }

  // Paper, a mug, the clutter that says somebody works here.
  for (let i = 0; i < 6; i++) {
    const p = box(0.26, 0.004, 0.34, new THREE.MeshStandardMaterial({ color: 0xdad4c2, roughness: 1 }), 1);
    p.position.set(-0.1 + (Math.random() - 0.5) * 0.8, 0.81 + i * 0.005, 1.1 + (Math.random() - 0.5) * 0.35);
    p.rotation.y = (Math.random() - 0.5) * 0.6;
    g.add(p);
  }

  // Ceiling bulb in a wire cage.
  const bulb = new THREE.PointLight(0xffdfbe, 5.5, 7.5, 2);
  bulb.position.set(0, 2.62, -0.3);
  g.add(bulb);
  w.officeLight = bulb;
  w.poweredLights.push(bulb);
  const bulbMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xfff0cf, emissive: 0xffd9a0, emissiveIntensity: 1.4 }),
  );
  bulbMesh.position.copy(bulb.position);
  g.add(bulbMesh);

  // Front wall dressing.
  const z = ROOMS.office.bounds.z0 + 0.09;
  addPoster(g, "celebrate", -1.15, 1.68, z, 0, 0.85);
  addPoster(g, "kids", 1.1, 1.64, z, 0, 0.8);
  addPoster(g, "rules", 0.0, 2.16, z, 0, 0.55);
  addPoster(g, "band", 2.15, 1.5, z, 0, 0.6);
  addPoster(g, "missing", -2.2, 1.48, z, 0, 0.55);

  /* --- doors, doorframes, buttons --------------------------------------- */

  for (const side of ["left", "right"] as const) {
    const sx = side === "left" ? DOORWAY.westX : DOORWAY.eastX;
    const inward = side === "left" ? 1 : -1;

    // Steel frame + the housing the door retracts into.
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x5d636d, roughness: 0.5, metalness: 0.7 });
    const housing = box(0.3, 0.3, 2.6, frameMat, 1);
    housing.position.set(sx, DOORWAY.height + 0.16, (DOORWAY.z0 + DOORWAY.z1) / 2);
    g.add(housing);

    const door = box(0.14, 2.3, 1.78, new THREE.MeshStandardMaterial({ color: 0x767d88, roughness: 0.42, metalness: 0.8 }), 1);
    door.position.set(sx, DOOR_OPEN_Y, (DOORWAY.z0 + DOORWAY.z1) / 2);
    door.castShadow = true;
    g.add(door);
    w.doors[side] = door;

    // Button panel, inside the office, just south of the doorway.
    const panel = box(0.06, 0.72, 0.42, new THREE.MeshStandardMaterial({ color: 0x39404d, roughness: 0.7 }), 1);
    panel.position.set(sx + inward * 0.08, 1.42, DOORWAY.z1 + 0.42);
    g.add(panel);

    const mkButton = (id: ButtonId, y: number, label: number) => {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xb8493f,
        emissive: new THREE.Color(0x2a0705),
        emissiveIntensity: 1,
        roughness: 0.5,
      });
      const b = box(0.05, 0.24, 0.3, mat, 1);
      b.position.set(sx + inward * 0.13, y, DOORWAY.z1 + 0.42);
      b.userData.button = id;
      g.add(b);
      w.buttons.push({ mesh: b, id, mat });
      // The little engraved plate under each button.
      const plate = box(0.04, 0.06, 0.3, new THREE.MeshStandardMaterial({ color: label ? 0xd8d2b8 : 0xc8c2a8, roughness: 0.9 }), 1);
      plate.position.set(sx + inward * 0.13, y - 0.17, DOORWAY.z1 + 0.42);
      g.add(plate);
    };
    mkButton(side === "left" ? "leftDoor" : "rightDoor", 1.62, 0);
    mkButton(side === "left" ? "leftLight" : "rightLight", 1.18, 1);

    // The hall light hangs in the corner room and points at the floor just
    // outside the door — the exact patch something stands on when it is your
    // turn. Aiming it down the hall instead was the first version, and it lit
    // a wall you cannot see from the chair.
    const spot = new THREE.SpotLight(0xdcecff, 0, 9, 0.95, 0.5, 1.2);
    spot.position.set(sx - inward * 1.1, 2.6, -1.5);
    spot.target.position.set(sx - inward * 1.35, 0, -1.9);
    spot.castShadow = true;
    spot.shadow.mapSize.set(512, 512);
    spot.shadow.camera.far = 16;
    w.scene.add(spot);
    w.scene.add(spot.target);
    w.hallLights[side] = spot;

    // Bounce: a dim point light in the doorway so the office edge lifts too.
    const glow = new THREE.PointLight(0xbcd8ff, 0, 4.5, 2);
    glow.position.set(sx - inward * 0.3, 1.5, -1.7);
    w.scene.add(glow);
    w.doorGlow[side] = glow;
  }
}

/* ------------------------------------------------------------- the rooms */

function buildStage(w: BuiltWorld, m: { matWoodDark: THREE.Material; matBlack: THREE.Material }) {
  const g = new THREE.Group();
  w.scene.add(g);
  // Riser.
  const riser = box(9.5, 0.45, 3.6, m.matWoodDark, 0.5);
  riser.position.set(0, 0.22, -25.6);
  riser.receiveShadow = true;
  g.add(riser);
  // Curtain backdrop.
  const curtain = new THREE.Mesh(
    new THREE.PlaneGeometry(11, 3.2, 24, 1),
    new THREE.MeshStandardMaterial({ color: 0x6d1220, roughness: 1, side: THREE.DoubleSide }),
  );
  const pos = curtain.geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin(pos.getX(i) * 3.1) * 0.16);
  pos.needsUpdate = true;
  curtain.geometry.computeVertexNormals();
  curtain.position.set(0, 1.7, -28.6);
  g.add(curtain);

  // "LET'S EAT!!!" banner.
  const banner = new THREE.Mesh(
    new THREE.PlaneGeometry(4.6, 1.1),
    new THREE.MeshStandardMaterial({ map: bannerTexture(), transparent: true, roughness: 1 }),
  );
  banner.position.set(0, 3.05, -28.4);
  g.add(banner);

  // Three coloured spots, always on, always too dim.
  const cols = [0xff7a5c, 0x6ad0ff, 0xffe08a];
  cols.forEach((c, i) => {
    const s = new THREE.SpotLight(c, 45, 14, 0.62, 0.6, 1.6);
    s.position.set((i - 1) * 3.2, 3.3, -22.6);
    s.target.position.set((i - 1) * 2.4, 0.8, -25.6);
    g.add(s, s.target);
    w.poweredLights.push(s);
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.3, 10), m.matBlack);
    can.position.copy(s.position);
    can.rotation.x = 0.5;
    g.add(can);
  });

  // Star cutouts on the back wall — flat, unlit, very 1993.
  for (let i = 0; i < 7; i++) {
    const star = new THREE.Mesh(
      new THREE.CircleGeometry(0.22, 5),
      new THREE.MeshStandardMaterial({ color: [0xf2c14e, 0x4fb3d9, 0xe8465e][i % 3], roughness: 1 }),
    );
    star.position.set(-4.5 + i * 1.5, 2.55 + Math.sin(i) * 0.25, -28.55);
    star.rotation.z = i * 0.7;
    g.add(star);
  }
}

function bannerTexture() {
  const el = document.createElement("canvas");
  el.width = 512;
  el.height = 128;
  const c = el.getContext("2d")!;
  c.clearRect(0, 0, 512, 128);
  c.fillStyle = "#f2ead0";
  c.beginPath();
  c.moveTo(0, 8);
  c.lineTo(512, 0);
  c.lineTo(512, 118);
  c.lineTo(0, 128);
  c.closePath();
  c.fill();
  c.fillStyle = "#c0182c";
  c.font = "bold 76px Impact, sans-serif";
  c.textAlign = "center";
  c.fillText("LET'S EAT!!!", 256, 92);
  const t = new THREE.CanvasTexture(el);
  return t;
}

function buildDining(
  w: BuiltWorld,
  m: { matWood: THREE.Material; matWoodDark: THREE.Material; matBlack: THREE.Material },
) {
  const g = new THREE.Group();
  w.scene.add(g);
  const clothMats = [0xd93b4e, 0x3d8fd0, 0x6fbf5c].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.95 }),
  );
  const chairMat = new THREE.MeshStandardMaterial({ color: 0x2f3a4d, roughness: 0.85 });

  let n = 0;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 5; col++) {
      const x = -8 + col * 4;
      const z = -15.6 - row * 3.6;
      const cloth = clothMats[n % clothMats.length];
      n++;
      const t = box(2.4, 0.08, 1.2, cloth, 0.6);
      t.position.set(x, 0.72, z);
      t.receiveShadow = true;
      g.add(t);
      for (const lx of [-1, 1]) {
        const leg = box(0.09, 0.72, 0.09, m.matWoodDark, 1);
        leg.position.set(x + lx * 1.0, 0.36, z);
        g.add(leg);
      }
      // Party hats and cups, still out from the last party.
      for (let k = 0; k < 4; k++) {
        const hat = new THREE.Mesh(
          new THREE.ConeGeometry(0.08, 0.2, 10),
          new THREE.MeshStandardMaterial({ color: [0xf2c14e, 0x4fb3d9, 0xe8465e, 0x7bc86c][k], roughness: 0.9 }),
        );
        hat.position.set(x - 0.9 + k * 0.6, 0.86, z + (k % 2 ? 0.28 : -0.28));
        g.add(hat);
        const plate = new THREE.Mesh(
          new THREE.CylinderGeometry(0.13, 0.13, 0.012, 12),
          new THREE.MeshStandardMaterial({ color: 0xf3efe2, roughness: 1 }),
        );
        plate.position.set(x - 0.7 + k * 0.5, 0.77, z + (k % 2 ? -0.3 : 0.3));
        g.add(plate);
      }
      // Chairs.
      for (const cx of [-0.8, 0.8]) {
        for (const cz of [-1.05, 1.05]) {
          const seat = box(0.42, 0.06, 0.42, chairMat, 1);
          seat.position.set(x + cx, 0.45, z + cz);
          g.add(seat);
          const back = box(0.42, 0.5, 0.06, chairMat, 1);
          back.position.set(x + cx, 0.7, z + cz + Math.sign(cz) * 0.2);
          g.add(back);
        }
      }
    }
  }

  // Streamers across the ceiling.
  for (let i = 0; i < 10; i++) {
    const s = box(20, 0.05, 0.05, new THREE.MeshStandardMaterial({ color: [0xf2c14e, 0xe8465e, 0x4fb3d9][i % 3], roughness: 1 }), 1);
    s.position.set(0, 3.3 - (i % 3) * 0.12, -13.6 - i * 0.75);
    s.rotation.z = (i % 2 ? 1 : -1) * 0.02;
    g.add(s);
  }

  // Weak overheads — enough to read the room on camera, not enough to feel safe.
  for (const [x, z] of [
    [-6, -16],
    [6, -16],
    [0, -19.5],
  ]) {
    const l = new THREE.PointLight(0xffe4b8, 20, 14, 2);
    l.position.set(x, 3.2, z);
    g.add(l);
    w.poweredLights.push(l);
  }

  const zb = ROOMS.dining.bounds;
  addPoster(g, "band", -3.5, 2.2, zb.z1 - 0.1, Math.PI, 1.3);
  addPoster(g, "celebrate", 7.5, 2.1, zb.z1 - 0.1, Math.PI, 1.1);
  addPoster(g, "kids", -10.85, 2.0, -19.6, Math.PI / 2, 1.2);
  addPoster(g, "rules", 10.85, 2.0, -19.6, -Math.PI / 2, 1.0);
}

function buildCove(w: BuiltWorld, matBlack: THREE.Material) {
  const g = new THREE.Group();
  w.scene.add(g);
  // The stage sits at the back of the room so the camera has somewhere to
  // stand. Everything in here is arranged around that one sightline.
  const riser = box(5, 0.4, 3.4, new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 1 }), 0.5);
  riser.position.set(-14, 0.2, -17.2);
  g.add(riser);

  // The curtain: two halves that part as Foxy gets ready. That reveal is the
  // whole tell, so it is a real animated object rather than a texture swap.
  w.coveCurtain = new THREE.Group();
  w.coveCurtain.position.set(-14, 0, -15.35);
  g.add(w.coveCurtain);
  const curtainMat = new THREE.MeshStandardMaterial({ color: 0x5b2d8f, roughness: 1, side: THREE.DoubleSide });
  for (const dir of [-1, 1]) {
    const half = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.7, 12, 1), curtainMat);
    const pos = half.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin(pos.getX(i) * 5) * 0.12);
    pos.needsUpdate = true;
    half.geometry.computeVertexNormals();
    half.position.set(dir * 1.3, 1.45, 0);
    half.userData.side = dir;
    w.coveCurtain.add(half);
    // Gold stars stitched on. Parented to the fabric, not to the group: on the
    // group they stayed hanging in mid-air in the gap while the curtain slid
    // out from behind them.
    for (let i = 0; i < 5; i++) {
      const star = new THREE.Mesh(
        new THREE.CircleGeometry(0.16, 5),
        new THREE.MeshStandardMaterial({ color: 0xe8c15a, roughness: 1 }),
      );
      star.position.set((Math.random() - 0.5) * 1.9, (Math.random() - 0.5) * 2.1, 0.14);
      star.rotation.z = Math.random() * 3;
      half.add(star);
    }
  }
  // The out-of-order sign, free-standing in front of the curtain and turned
  // to face the camera — on the side wall it was edge-on and unreadable.
  {
    const sign = new THREE.Group();
    sign.position.set(-12.5, 0, -14.6);
    sign.rotation.y = 0.8;
    g.add(sign);
    const board = addPoster(sign, "foxy", 0, 1.62, 0, 0, 1.3);
    board.rotation.z = 0.03;
    for (const lx of [-0.52, 0.52]) {
      const leg = box(0.07, 1.0, 0.07, matBlack, 1);
      leg.position.set(lx, 0.5, 0);
      sign.add(leg);
    }
  }
  // Two lamps: one on the front of the curtain so the cove reads as a place
  // even when it is shut, one behind it so that what is standing back there
  // is a silhouette rather than nothing the moment it opens.
  const l = new THREE.PointLight(0x8f6bd0, 11, 8, 2);
  l.position.set(-13.7, 2.5, -14.5);
  g.add(l);
  w.poweredLights.push(l);
  const back = new THREE.PointLight(0x6f57b0, 7, 7, 2);
  back.position.set(-14, 2.4, -17.6);
  g.add(back);
  w.poweredLights.push(back);
}

function buildBackstage(
  w: BuiltWorld,
  m: { matSteel: THREE.Material; matBlack: THREE.Material; matWoodDark: THREE.Material },
) {
  const g = new THREE.Group();
  w.scene.add(g);
  // Workbench with spare heads on it. This is the shot everybody remembers.
  const bench = box(4.6, 0.09, 0.9, m.matSteel, 0.6);
  bench.position.set(-9, 0.92, -27.6);
  g.add(bench);
  for (const x of [-11, -7]) {
    const leg = box(0.08, 0.9, 0.8, m.matSteel, 1);
    leg.position.set(x, 0.45, -27.6);
    g.add(leg);
  }
  const headMat = new THREE.MeshStandardMaterial({ color: 0x6f4a29, roughness: 0.85 });
  const endoMat = new THREE.MeshStandardMaterial({ color: 0x9aa1a9, roughness: 0.35, metalness: 0.75 });
  for (let i = 0; i < 4; i++) {
    const isEndo = i % 2 === 1;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 14, 12), isEndo ? endoMat : headMat);
    head.position.set(-10.6 + i * 1.05, 1.2, -27.6);
    head.scale.set(1, 0.95, 1.05);
    g.add(head);
    for (const ex of [-0.11, 0.11]) {
      const eye = new THREE.Mesh(
        new THREE.SphereGeometry(0.055, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 0.6 }),
      );
      eye.position.set(head.position.x + ex, 1.24, -27.36);
      g.add(eye);
    }
  }
  // A full endoskeleton, standing against the wall, doing nothing at all.
  const endo = new THREE.Group();
  endo.position.set(-11.2, 0, -25.2);
  g.add(endo);
  const torso = box(0.5, 0.85, 0.34, endoMat, 1);
  torso.position.y = 1.15;
  endo.add(torso);
  const eh = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 12), endoMat);
  eh.position.y = 1.78;
  endo.add(eh);
  for (const s of [-1, 1]) {
    const arm = box(0.11, 0.78, 0.11, endoMat, 1);
    arm.position.set(s * 0.33, 1.15, 0);
    endo.add(arm);
    const leg = box(0.13, 0.72, 0.13, endoMat, 1);
    leg.position.set(s * 0.15, 0.36, 0);
    endo.add(leg);
  }
  const l = new THREE.PointLight(0xa8c0d8, 12, 9, 2);
  l.position.set(-9, 2.4, -26);
  g.add(l);
  w.poweredLights.push(l);
}

function buildKitchen(w: BuiltWorld, matSteel: THREE.Material) {
  const g = new THREE.Group();
  w.scene.add(g);
  const counter = box(3.4, 0.08, 0.7, matSteel, 0.6);
  counter.position.set(9.4, 0.92, -9.9);
  g.add(counter);
  const under = box(3.4, 0.85, 0.6, matSteel, 0.6);
  under.position.set(9.4, 0.45, -9.9);
  g.add(under);
  for (let i = 0; i < 5; i++) {
    const pan = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.16, 0.08, 14), matSteel);
    pan.position.set(8.2 + i * 0.55, 2.15, -7.4);
    pan.rotation.x = Math.PI / 2;
    g.add(pan);
  }
  const l = new THREE.PointLight(0xbfd4e0, 9, 8, 2);
  l.position.set(9.2, 2.3, -8.5);
  g.add(l);
  w.poweredLights.push(l);
}

function buildRestrooms(w: BuiltWorld, m: { matWoodDark: THREE.Material; matBlack: THREE.Material }) {
  const g = new THREE.Group();
  w.scene.add(g);
  for (const [x, label] of [
    [13.2, 0],
    [15.4, 1],
  ] as const) {
    const door = box(1.0, 2.1, 0.1, m.matWoodDark, 0.6);
    door.position.set(x, 1.05, -18.9);
    g.add(door);
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(0.34, 0.34),
      new THREE.MeshStandardMaterial({ color: label ? 0xe8628a : 0x5c9fe0, roughness: 1 }),
    );
    sign.position.set(x, 1.9, -18.83);
    g.add(sign);
  }
  const l = new THREE.PointLight(0xd6e4ee, 11, 9, 2);
  l.position.set(14, 2.6, -16);
  g.add(l);
  w.poweredLights.push(l);
}

function buildSupply(w: BuiltWorld, m: { matSteel: THREE.Material; matBlack: THREE.Material }) {
  const g = new THREE.Group();
  w.scene.add(g);
  for (let s = 0; s < 3; s++) {
    const shelf = box(3.4, 0.06, 0.55, m.matSteel, 0.6);
    shelf.position.set(-9.4, 0.5 + s * 0.72, -6.9);
    g.add(shelf);
    for (let i = 0; i < 4; i++) {
      const boxo = box(0.4, 0.32, 0.4, new THREE.MeshStandardMaterial({ color: 0x9a7a52, roughness: 1 }), 1);
      boxo.position.set(-10.7 + i * 0.85, 0.69 + s * 0.72, -6.9);
      boxo.rotation.y = Math.random() * 0.4;
      g.add(boxo);
    }
  }
  const mop = box(0.05, 1.5, 0.05, m.matBlack, 1);
  mop.position.set(-7.6, 0.75, -10.1);
  mop.rotation.z = 0.14;
  g.add(mop);
  const l = new THREE.PointLight(0xc0c8d0, 8, 7, 2);
  l.position.set(-9.2, 2.3, -8.5);
  g.add(l);
  w.poweredLights.push(l);
}

function buildHalls(w: BuiltWorld) {
  const g = new THREE.Group();
  w.scene.add(g);
  // Dead fluorescents at intervals — they light the hall just enough that a
  // silhouette standing in it is a silhouette rather than a black rectangle.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const z = -5.5 - i * 3.2;
      const l = new THREE.PointLight(0x9fb4cc, 8, 8, 2);
      l.position.set(side * 4.95, 2.55, z);
      g.add(l);
      w.poweredLights.push(l);
      const tube = box(0.12, 0.06, 1.1, new THREE.MeshStandardMaterial({ color: 0xf2f6ff, emissive: 0xbcd0e8, emissiveIntensity: 0.5 }), 1);
      tube.position.set(side * 4.95, 2.68, z);
      g.add(tube);
    }
    addPoster(g, side < 0 ? "foxy" : "celebrate", side * 7.05, 1.7, -6.2, side < 0 ? Math.PI / 2 : -Math.PI / 2, 0.85);
    addPoster(g, side < 0 ? "kids" : "band", side * 7.05, 1.7, -11.4, side < 0 ? Math.PI / 2 : -Math.PI / 2, 0.85);
    // Corner rooms get a poster too — it is what your hall light lands on.
    addPoster(g, side < 0 ? "missing" : "rules", side * 7.1, 1.6, -2.2, side < 0 ? Math.PI / 2 : -Math.PI / 2, 0.8);
  }
}
