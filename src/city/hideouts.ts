/**
 * hideouts — two buildings in Vibe City that are made by hand rather than by
 * the district generator: the bad guys' warehouse and the police station.
 *
 * Both sit on a whole block that `buildDistrict({ reserved })` leaves empty,
 * and both are hollow: walls are separate collision boxes with a doorway left
 * out, so you can walk (or drive) straight in. The warehouse has a staircase
 * up its south side to the roof, where the bad guys' spawn pad is; the police
 * station has a garage the cruisers come out of.
 *
 * Built in world space, +Y up. Everything here is static.
 */
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";

export interface Hideouts {
  group: THREE.Group;
  /** Collision for both buildings. Push these into the city's boxes. */
  boxes: WorldBox[];
  /** The middle of the warehouse roof, where bad guys are summoned: [x, y, z]. */
  hideout: [number, number, number];
  /** Just outside the station's garage, where a cruiser rolls out: [x, z, yaw]. */
  garage: [number, number, number];
  /** Where the two parked cruisers sit: [x, z, yaw] each. */
  parked: Array<[number, number, number]>;
  dispose(): void;
}

/** World centre of the warehouse block and the station block. */
export const WAREHOUSE_AT: [number, number] = [80, 0];
export const STATION_AT: [number, number] = [-80, 0];

function signTexture(text: string, bg: string, fg: string, w = 1024, h = 256): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d")!;
  x.fillStyle = bg;
  x.fillRect(0, 0, w, h);
  x.fillStyle = fg;
  x.font = `bold ${Math.round(h * 0.56)}px system-ui, sans-serif`;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText(text, w / 2, h / 2 + h * 0.03);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function buildHideouts(): Hideouts {
  const group = new THREE.Group();
  group.name = "hideouts";
  const boxes: WorldBox[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const texs: THREE.Texture[] = [];
  const mat = <M extends THREE.Material>(m: M) => {
    mats.push(m);
    return m;
  };

  /** A solid block, drawn and collidable. */
  const solid = (
    m: THREE.Material, minX: number, maxX: number, minZ: number, maxZ: number, base: number, top: number,
    collide = true,
  ) => {
    const geo = new THREE.BoxGeometry(maxX - minX, top - base, maxZ - minZ);
    geos.push(geo);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set((minX + maxX) / 2, (base + top) / 2, (minZ + maxZ) / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (collide) boxes.push({ minX, maxX, minZ, maxZ, base, height: top });
    return mesh;
  };
  const sign = (tex: THREE.Texture, w: number, h: number, x: number, y: number, z: number, yaw: number) => {
    texs.push(tex);
    const geo = new THREE.PlaneGeometry(w, h);
    geos.push(geo);
    const mesh = new THREE.Mesh(geo, mat(new THREE.MeshBasicMaterial({ map: tex })));
    mesh.position.set(x, y, z);
    mesh.rotation.y = yaw;
    group.add(mesh);
    return mesh;
  };

  // ---- The warehouse -------------------------------------------------
  // 24 by 22 m and 12 m tall, corrugated grey with a red band, a big roll-up
  // door open on the west side facing town, and stairs up the south wall.
  {
    const [cx, cz] = WAREHOUSE_AT;
    const hx = 12;
    const hz = 11;
    const H = 12;
    const T = 0.4;
    const shed = mat(new THREE.MeshStandardMaterial({ color: 0x8b939c, roughness: 0.72, metalness: 0.35 }));
    const band = mat(new THREE.MeshStandardMaterial({ color: 0xa3262c, roughness: 0.6, metalness: 0.2 }));
    const floor = mat(new THREE.MeshStandardMaterial({ color: 0x55585c, roughness: 0.95 }));
    const roofM = mat(new THREE.MeshStandardMaterial({ color: 0x5e656d, roughness: 0.85, metalness: 0.3 }));
    const wood = mat(new THREE.MeshStandardMaterial({ color: 0xa57c4b, roughness: 0.9 }));
    const steel = mat(new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.5, metalness: 0.6 }));
    const yellow = mat(new THREE.MeshStandardMaterial({ color: 0xf2b417, roughness: 0.55 }));
    const lamp = mat(new THREE.MeshBasicMaterial({ color: 0xfff3d6 }));

    const x0 = cx - hx;
    const x1 = cx + hx;
    const z0 = cz - hz;
    const z1 = cz + hz;
    const door = 4;
    const doorH = 6;
    // Floor slab, flush with the pavement so nothing trips on it.
    solid(floor, x0, x1, z0, z1, 0, 0.03, false);
    // Walls: north, south, east whole, west with the door left out.
    solid(shed, x0, x1, z1 - T, z1, 0, H);
    solid(shed, x0, x1, z0, z0 + T, 0, H);
    solid(shed, x1 - T, x1, z0 + T, z1 - T, 0, H);
    solid(shed, x0, x0 + T, z0 + T, cz - door, 0, H);
    solid(shed, x0, x0 + T, cz + door, z1 - T, 0, H);
    solid(shed, x0, x0 + T, cz - door, cz + door, doorH, H);
    // The roll-up door, rolled up: a drum over the opening.
    {
      const geo = new THREE.CylinderGeometry(0.45, 0.45, door * 2 + 0.6, 16).rotateX(Math.PI / 2);
      geos.push(geo);
      const drum = new THREE.Mesh(geo, steel);
      drum.position.set(x0 - 0.35, doorH + 0.3, cz);
      group.add(drum);
    }
    // A red band round the top, just proud of the walls.
    solid(band, x0 - 0.05, x1 + 0.05, z1 - 0.05, z1 + 0.05, H - 1.6, H - 0.8, false);
    solid(band, x0 - 0.05, x1 + 0.05, z0 - 0.05, z0 + 0.05, H - 1.6, H - 0.8, false);
    solid(band, x1 - 0.05, x1 + 0.05, z0, z1, H - 1.6, H - 0.8, false);
    solid(band, x0 - 0.05, x0 + 0.05, z0, z1, H - 1.6, H - 0.8, false);
    // The roof: a slab you can stand on and a ceiling you can bump into.
    solid(roofM, x0, x1, z0, z1, H - 0.4, H);
    // A low lip round the roof that you can step over.
    for (const [a, b, c, d] of [
      [x0, x1, z1 - 0.3, z1], [x0, x1, z0, z0 + 0.3], [x0, x0 + 0.3, z0, z1], [x1 - 0.3, x1, z0, z1],
    ] as const) solid(steel, a, b, c, d, H, H + 0.35, false);
    sign(signTexture("WAREHOUSE 13", "#1d2024", "#f4f1ea"), 12, 3, x0 - 0.06, H - 3.8, cz, -Math.PI / 2);

    // Inside: pallets of crates, shelving, a forklift, strip lights.
    const crate = (x: number, z: number, s: number, y = 0) => solid(wood, x - s / 2, x + s / 2, z - s / 2, z + s / 2, y, y + s);
    const stacks: Array<[number, number, number]> = [
      [cx + 7, cz + 7, 3], [cx + 9, cz + 4.5, 2], [cx + 5, cz - 7.5, 2], [cx + 8, cz - 7, 3],
      [cx - 3, cz + 8, 2], [cx + 1, cz + 7.5, 1],
    ];
    for (const [x, z, n] of stacks) {
      for (let i = 0; i < n; i++) crate(x + (i % 2) * 0.15, z, 1.6 - i * 0.15, i * 1.6 - i * i * 0.08);
    }
    // Racking down the east wall.
    for (const z of [cz - 4, cz + 0.5]) {
      solid(steel, x1 - 2.2, x1 - 0.5, z - 1.6, z + 1.6, 0, 0.1, false);
      for (const lvl of [2, 4, 6]) solid(steel, x1 - 2.2, x1 - 0.5, z - 1.6, z + 1.6, lvl - 0.1, lvl, false);
      for (const px of [x1 - 2.15, x1 - 0.55]) for (const pz of [z - 1.55, z + 1.55]) {
        solid(steel, px - 0.05, px + 0.05, pz - 0.05, pz + 0.05, 0, 6.3, false);
      }
      boxes.push({ minX: x1 - 2.2, maxX: x1 - 0.5, minZ: z - 1.6, maxZ: z + 1.6, base: 0, height: 6.3 });
      for (const lvl of [0.1, 2, 4]) crate(x1 - 1.35, z + (lvl % 4 ? 0.6 : -0.6), 1.2, lvl);
    }
    // A forklift, parked.
    {
      const fx = cx - 2;
      const fz = cz - 5;
      solid(yellow, fx - 0.8, fx + 0.8, fz - 1.2, fz + 1.2, 0.25, 1.3);
      solid(steel, fx - 0.75, fx + 0.75, fz - 0.4, fz + 0.9, 1.3, 1.36, false);
      for (const px of [fx - 0.72, fx + 0.72]) for (const pz of [fz - 0.35, fz + 0.85]) solid(steel, px - 0.04, px + 0.04, pz - 0.04, pz + 0.04, 1.3, 2.4, false);
      solid(steel, fx - 0.8, fx + 0.8, fz - 0.4, fz + 0.9, 2.4, 2.48, false);
      solid(steel, fx - 0.7, fx + 0.7, fz + 1.2, fz + 1.35, 0.1, 2.6, false);
      solid(steel, fx - 0.6, fx - 0.4, fz + 1.35, fz + 2.6, 0.08, 0.16, false);
      solid(steel, fx + 0.4, fx + 0.6, fz + 1.35, fz + 2.6, 0.08, 0.16, false);
    }
    // Strip lights under the roof.
    for (const x of [cx - 6, cx, cx + 6]) solid(lamp, x - 0.15, x + 0.15, cz - 7, cz + 7, H - 0.75, H - 0.6, false);

    // Stairs up the outside of the south wall, bottom at the east end.
    {
      const steps = 34;
      const run = 0.62;
      const rise = H / steps;
      const sz0 = z0 - 1.9;
      const sz1 = z0;
      const start = x1 - 0.4;
      for (let i = 0; i < steps; i++) {
        const xb = start - run * (i + 1);
        solid(steel, xb, xb + run, sz0, sz1, 0, rise * (i + 1));
      }
      // A landing at the top, flush with the roof.
      const top = start - run * steps;
      solid(steel, top - 1.6, top, sz0, sz1, 0, H);
      // A handrail you can see, on the open side.
      const len = run * steps;
      const geo = new THREE.BoxGeometry(len * Math.hypot(1, rise / run) / 1, 0.08, 0.08);
      geos.push(geo);
      const rail = new THREE.Mesh(geo, yellow);
      rail.position.set(start - len / 2, H / 2 + 1, sz0 + 0.05);
      rail.rotation.z = -Math.atan2(rise, run);
      group.add(rail);
    }
  }

  // ---- The police station ---------------------------------------------
  // White with a blue band, POLICE across the front, and a garage open on the
  // east side, facing town, that the cruisers come out of.
  const [px, pz] = STATION_AT;
  {
    const hx = 10;
    const hz = 9;
    const H = 9;
    const T = 0.4;
    const white = mat(new THREE.MeshStandardMaterial({ color: 0xe9ecef, roughness: 0.7 }));
    const blue = mat(new THREE.MeshStandardMaterial({ color: 0x1f4fb8, roughness: 0.55 }));
    const glass = mat(new THREE.MeshStandardMaterial({ color: 0x24384d, roughness: 0.15, metalness: 0.4 }));
    const floor = mat(new THREE.MeshStandardMaterial({ color: 0x6a6e73, roughness: 0.95 }));
    const steel = mat(new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.5, metalness: 0.6 }));
    const x0 = px - hx;
    const x1 = px + hx;
    const z0 = pz - hz;
    const z1 = pz + hz;
    const door = 3.2;
    const doorH = 4.4;
    solid(floor, x0, x1, z0, z1, 0, 0.03, false);
    solid(white, x0, x1, z1 - T, z1, 0, H);
    solid(white, x0, x1, z0, z0 + T, 0, H);
    solid(white, x0, x0 + T, z0 + T, z1 - T, 0, H);
    solid(white, x1 - T, x1, z0 + T, pz - door, 0, H);
    solid(white, x1 - T, x1, pz + door, z1 - T, 0, H);
    solid(white, x1 - T, x1, pz - door, pz + door, doorH, H);
    solid(white, x0, x1, z0, z1, H - 0.4, H);
    // Blue band, windows, the sign, the light on the corner.
    solid(blue, x0 - 0.05, x1 + 0.05, z0 - 0.05, z1 + 0.05, H - 2.2, H - 1.4, false);
    for (const wz of [pz - 6.5, pz + 6.5]) solid(glass, x1 - 0.02, x1 + 0.06, wz - 1.6, wz + 1.6, 1.4, 3.6, false);
    for (const wx of [px - 6, px, px + 6]) {
      solid(glass, wx - 1.6, wx + 1.6, z1 - 0.02, z1 + 0.06, 1.4, 3.6, false);
      solid(glass, wx - 1.6, wx + 1.6, z0 - 0.06, z0 + 0.02, 1.4, 3.6, false);
    }
    sign(signTexture("POLICE", "#1f4fb8", "#ffffff"), 10, 2.4, x1 + 0.08, H - 3.3, pz, Math.PI / 2);
    sign(signTexture("POLICE", "#1f4fb8", "#ffffff"), 10, 2.4, px, H - 3.3, z1 + 0.08, 0);
    // Inside the garage: a painted floor bay and a desk.
    {
      const lineM = mat(new THREE.MeshBasicMaterial({ color: 0xf2f2f2 }));
      for (const lz of [pz - 3.4, pz + 3.4]) solid(lineM, px - 6, x1 - 1, lz - 0.08, lz + 0.08, 0.03, 0.05, false);
      solid(steel, x0 + 1.2, x0 + 2.4, pz - 2, pz + 2, 0, 1.0);
      solid(blue, x0 + 1.2, x0 + 2.4, pz - 2, pz + 2, 1.0, 1.08, false);
    }
    // A flagpole out front.
    {
      const fx = x1 + 2.5;
      const fz = z1 + 2.2;
      solid(steel, fx - 0.08, fx + 0.08, fz - 0.08, fz + 0.08, 0, 9);
      const flag = new THREE.PlaneGeometry(2.2, 1.3);
      geos.push(flag);
      const fm = new THREE.Mesh(flag, mat(new THREE.MeshStandardMaterial({ color: 0x1f4fb8, side: THREE.DoubleSide })));
      fm.position.set(fx + 1.15, 8.2, fz);
      group.add(fm);
    }
  }

  return {
    group,
    boxes,
    hideout: [WAREHOUSE_AT[0], 12, WAREHOUSE_AT[1]],
    garage: [px + 12.5, pz, Math.PI / 2],
    parked: [[px + 12.2, pz - 6.5, Math.PI], [px + 12.2, pz + 6.5, 0]],
    dispose() {
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      texs.forEach((t) => t.dispose());
      group.removeFromParent();
    },
  };
}
