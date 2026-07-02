/**
 * skyIslands — four big, landable floating islands from the Vibeverse poster.
 *
 * Replaces the old miniIslands archipelago (six tiny non-landable rocks).
 * Each island is a proper destination you can jetpack to, stand on, and
 * walk around: a chunky grass cap with an organic noise-displaced rim, a
 * dirt-to-rock underside cone with dangling roots, and drifting rock
 * shards underneath for that "torn out of the earth" look.
 *
 * The bounce route (plaza → up and around the western sky):
 *   - "Lone Tree Island"  (y 55)  — a meadow with one giant hero tree
 *   - "Crystal Isle"      (y 85)  — a mini skyline of glowing blue towers
 *   - "Sky Shrine"        (y 115) — red three-tier pagoda + cherry trees
 *   - "Lantern Grove"     (y 80)  — pond, fireflies, glowing lanterns
 *
 * A cream-and-red zeppelin slowly circles the city between them (poster
 * nod) — and it's rideable: a plank deck runs along the top of the hull,
 * so you can jetpack onto it as it passes and cruise the whole loop.
 * Its live position/yaw are exposed via `zeppelin` so the player physics
 * in City can stick to (and be carried by) the moving deck.
 *
 * IMPORTANT collision semantics: WorldBox.height is the ABSOLUTE top Y of
 * the box, not a thickness — supportHeightAt() returns b.height directly
 * as the landing altitude. (The old miniIslands pushed height as a
 * thickness, which parked every collider at street level; that's why you
 * could never land on them.)
 */
import * as THREE from "three";
import type { WorldBox } from "./cardboardIsland";

/** Live ride state for the circling zeppelin's walkable deck. */
export interface ZeppelinRide {
  /** Hull center in world coords, updated every frame. */
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
  yaw: number;
  prevYaw: number;
  /** Local Y of the deck walking surface above the hull center. */
  deckY: number;
  /** Deck half-extents in the zeppelin's local frame. */
  halfW: number;
  halfL: number;
}

export interface SkyIslandsWorld {
  group: THREE.Group;
  update(dt: number, now: number): void;
  /** Landing pad centers, in world coords — used for fast-travel + POIs. */
  pads: { key: string; name: string; pos: THREE.Vector3 }[];
  /** The circling zeppelin — its deck is a moving platform you can ride. */
  zeppelin: ZeppelinRide;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Deterministic RNG so the islands look the same every visit. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A smooth looping noise over angle [0..2π). The same function is applied
 * to the grass cap AND the dirt cone so their silhouettes match at the rim.
 */
function makeRimNoise(rand: () => number, amp: number, knots = 10): (a: number) => number {
  const vals = Array.from({ length: knots }, () => (rand() * 2 - 1) * amp);
  return (a: number) => {
    const t = ((a / (Math.PI * 2)) % 1 + 1) % 1 * knots;
    const i = Math.floor(t);
    const f = t - i;
    const s = f * f * (3 - 2 * f); // smoothstep between knots
    return vals[i % knots] + (vals[(i + 1) % knots] - vals[i % knots]) * s;
  };
}

/** Push every vertex radially in/out by rimFn(angle) — organic, not a lathe. */
function displaceRadial(geo: THREE.BufferGeometry, rimFn: (a: number) => number) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 0.01) continue; // leave the apex alone
    const s = 1 + rimFn(Math.atan2(z, x));
    p.setX(i, x * s);
    p.setZ(i, z * s);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
}

// ---------------------------------------------------------------------------
// Island base: grass cap + dirt/rock underside + roots + drifting shards
// ---------------------------------------------------------------------------

interface Bobber {
  obj: THREE.Object3D;
  baseY: number;
  phase: number;
  amp: number;
  spin: number;
}

interface Pulser {
  mat: THREE.MeshStandardMaterial;
  base: number;
  amp: number;
  speed: number;
  phase: number;
}

const CAP_H = 2.6; // grass cap thickness

function makeIslandBase(
  radius: number,
  rand: () => number,
  bobbers: Bobber[],
): THREE.Group {
  const g = new THREE.Group();
  const rim = makeRimNoise(rand, 0.1);

  // Grass cap — flat walkable top, wobbly organic rim with a slight lip
  // overhanging the dirt below.
  const capGeo = new THREE.CylinderGeometry(radius, radius * 0.95, CAP_H, 28, 1);
  displaceRadial(capGeo, rim);
  const cap = new THREE.Mesh(
    capGeo,
    new THREE.MeshStandardMaterial({ color: 0x74c94e, roughness: 0.95, flatShading: true }),
  );
  cap.position.y = -CAP_H / 2; // top surface sits exactly at local y=0
  cap.castShadow = true;
  cap.receiveShadow = true;
  g.add(cap);

  // Lighter meadow patch so the top isn't one flat green.
  const patchGeo = new THREE.CircleGeometry(radius * 0.55, 20);
  displaceRadial(patchGeo, makeRimNoise(rand, 0.22, 6));
  const patch = new THREE.Mesh(
    patchGeo,
    new THREE.MeshStandardMaterial({ color: 0x8fdb6a, roughness: 1 }),
  );
  patch.rotation.x = -Math.PI / 2;
  patch.position.y = 0.03;
  patch.receiveShadow = true;
  g.add(patch);

  // Dirt-to-rock underside: a chunky inverted cone with vertex colors
  // fading from topsoil brown at the rim to cold rock at the tip.
  const depth = radius * 1.7;
  const dirtGeo = new THREE.ConeGeometry(radius * 0.93, depth, 28, 4);
  dirtGeo.rotateX(Math.PI); // point down; base ring at +depth/2
  displaceRadial(dirtGeo, rim);
  {
    const p = dirtGeo.attributes.position;
    const colors = new Float32Array(p.count * 3);
    const soil = new THREE.Color(0x8a6242);
    const rock = new THREE.Color(0x5b5148);
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      // Jitter the mid rows for a hewn-rock feel (skip apex + base ring).
      const y = p.getY(i);
      const t = THREE.MathUtils.clamp((y + depth / 2) / depth, 0, 1); // 0 tip → 1 rim
      if (t > 0.05 && t < 0.95) {
        p.setX(i, p.getX(i) + (rand() - 0.5) * radius * 0.09);
        p.setZ(i, p.getZ(i) + (rand() - 0.5) * radius * 0.09);
        p.setY(i, y + (rand() - 0.5) * depth * 0.05);
      }
      c.lerpColors(rock, soil, Math.pow(t, 1.6));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    p.needsUpdate = true;
    dirtGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    dirtGeo.computeVertexNormals();
  }
  const dirt = new THREE.Mesh(
    dirtGeo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }),
  );
  dirt.position.y = -CAP_H - depth / 2 + 0.6; // tuck the rim under the cap lip
  dirt.castShadow = true;
  g.add(dirt);

  // Dangling roots around the rim.
  const rootMat = new THREE.MeshStandardMaterial({ color: 0x5a3d26, roughness: 1 });
  const roots = 4 + Math.floor(rand() * 3);
  for (let i = 0; i < roots; i++) {
    const a = (i / roots) * Math.PI * 2 + rand() * 0.8;
    const r = radius * (0.55 + rand() * 0.3);
    const len = 2.5 + rand() * radius * 0.35;
    const root = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.04, len, 5), rootMat);
    root.position.set(Math.cos(a) * r, -CAP_H - len / 2, Math.sin(a) * r);
    root.rotation.z = (rand() - 0.5) * 0.35;
    g.add(root);
  }

  // Rock shards drifting below — the poster's floating debris.
  const shardMat = new THREE.MeshStandardMaterial({
    color: 0x6f6357,
    roughness: 1,
    flatShading: true,
  });
  const shards = 3 + Math.floor(rand() * 2);
  for (let i = 0; i < shards; i++) {
    const a = rand() * Math.PI * 2;
    const r = radius * (1.1 + rand() * 0.5);
    const y = -depth * (0.3 + rand() * 0.6);
    const shard = new THREE.Mesh(new THREE.DodecahedronGeometry(0.7 + rand() * 1.1, 0), shardMat);
    shard.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    shard.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
    g.add(shard);
    bobbers.push({
      obj: shard,
      baseY: y,
      phase: rand() * Math.PI * 2,
      amp: 0.5 + rand() * 0.6,
      spin: (rand() - 0.5) * 0.4,
    });
  }

  return g;
}

/** Scatter little stem-and-bloom flowers on the meadow. */
function scatterFlowers(g: THREE.Group, radius: number, count: number, rand: () => number) {
  const palette = [0xffd166, 0xff6b9d, 0xf4f1ea, 0xb388ff];
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2;
    const r = radius * (0.2 + rand() * 0.65);
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 0.5, 4),
      new THREE.MeshStandardMaterial({ color: 0x3e7d2f }),
    );
    stem.position.set(Math.cos(a) * r, 0.25, Math.sin(a) * r);
    g.add(stem);
    const bloom = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 6, 5),
      new THREE.MeshStandardMaterial({
        color: palette[Math.floor(rand() * palette.length)],
        roughness: 0.7,
      }),
    );
    bloom.position.set(stem.position.x, 0.55, stem.position.z);
    g.add(bloom);
  }
}

function makeBoulder(size: number, rand: () => number): THREE.Mesh {
  const b = new THREE.Mesh(
    new THREE.DodecahedronGeometry(size, 0),
    new THREE.MeshStandardMaterial({ color: 0x8d8579, roughness: 1, flatShading: true }),
  );
  b.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
  b.position.y = size * 0.55;
  b.castShadow = true;
  return b;
}

/** A stylized blob tree: trunk + clustered foliage spheres, two-tone green. */
function makeTree(
  height: number,
  spread: number,
  rand: () => number,
  colors: [number, number] = [0x4e9d3c, 0x63b84a],
): THREE.Group {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(height * 0.045, height * 0.075, height * 0.55, 7),
    new THREE.MeshStandardMaterial({ color: 0x6a4a2a, roughness: 1 }),
  );
  trunk.position.y = height * 0.275;
  trunk.rotation.z = (rand() - 0.5) * 0.12;
  trunk.castShadow = true;
  g.add(trunk);
  const blobs = 3 + Math.floor(rand() * 2);
  for (let i = 0; i < blobs; i++) {
    const s = spread * (0.55 + rand() * 0.45);
    const leaf = new THREE.Mesh(
      new THREE.SphereGeometry(s, 10, 8),
      new THREE.MeshStandardMaterial({
        color: colors[i % 2],
        roughness: 0.85,
        flatShading: true,
      }),
    );
    leaf.position.set(
      (rand() - 0.5) * spread * 0.9,
      height * 0.62 + rand() * height * 0.25,
      (rand() - 0.5) * spread * 0.9,
    );
    leaf.scale.y = 0.85 + rand() * 0.25;
    leaf.castShadow = true;
    g.add(leaf);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Theme builders — each dresses an island top and may add collision boxes
// ---------------------------------------------------------------------------

interface ThemeCtx {
  island: THREE.Group; // local y=0 is the walkable top
  radius: number;
  x: number;
  y: number; // world Y of the walkable top
  z: number;
  rand: () => number;
  boxes: WorldBox[];
  pulsers: Pulser[];
  bobbers: Bobber[];
}

/** One giant hero tree on a meadow — the poster's left island. */
function themeLoneTree({ island, radius, rand }: ThemeCtx) {
  const hero = makeTree(radius * 0.95, radius * 0.42, rand);
  hero.scale.setScalar(1); // ~19m tall on a 20m island: properly giant
  hero.position.set(-radius * 0.15, 0, -radius * 0.1);
  island.add(hero);

  for (let i = 0; i < 3; i++) {
    const bush = new THREE.Mesh(
      new THREE.SphereGeometry(0.9 + rand() * 0.6, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0x57a844, roughness: 0.9, flatShading: true }),
    );
    const a = rand() * Math.PI * 2;
    bush.position.set(Math.cos(a) * radius * 0.6, 0.55, Math.sin(a) * radius * 0.6);
    bush.scale.y = 0.7;
    island.add(bush);
  }
  const rock = makeBoulder(1.3, rand);
  rock.position.x = radius * 0.55;
  rock.position.z = radius * 0.35;
  island.add(rock);
  scatterFlowers(island, radius, 14, rand);
}

/** A mini skyline of glowing blue glass towers — the poster's city island. */
function themeCrystalCity({ island, radius, x, y, z, rand, boxes, pulsers }: ThemeCtx) {
  const glass = new THREE.MeshStandardMaterial({
    color: 0xaedcff,
    emissive: 0x2f8fd8,
    emissiveIntensity: 0.35,
    roughness: 0.18,
    metalness: 0.25,
  });
  const trim = new THREE.MeshStandardMaterial({ color: 0xf2f7fb, roughness: 0.5 });

  // Stone plaza underfoot so it reads as a city block, not a lawn.
  const plaza = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 0.8, 24),
    new THREE.MeshStandardMaterial({ color: 0xb9c4cd, roughness: 0.9 }),
  );
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.y = 0.05;
  plaza.receiveShadow = true;
  island.add(plaza);

  // Towers on a ring; the center stays clear for landings. Every rooftop
  // is a collision box, so the skyline itself is parkour terrain.
  const towers = 7;
  for (let i = 0; i < towers; i++) {
    const a = (i / towers) * Math.PI * 2 + 0.35;
    const ringR = radius * (0.42 + (i % 2) * 0.16);
    const tx = Math.cos(a) * ringR;
    const tz = Math.sin(a) * ringR;
    const w = 3.2 + rand() * 2.6;
    const d = 3.2 + rand() * 2.6;
    const h = i === 0 ? 26 + rand() * 5 : 8 + rand() * 14;

    const tower = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), glass);
    tower.position.set(tx, h / 2, tz);
    tower.castShadow = true;
    island.add(tower);

    // White roof slab + occasional setback tier for skyline variety.
    const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.5, d + 0.3), trim);
    roof.position.set(tx, h + 0.25, tz);
    island.add(roof);
    if (rand() < 0.45) {
      const th = 2.5 + rand() * 3;
      const tier = new THREE.Mesh(new THREE.BoxGeometry(w * 0.55, th, d * 0.55), glass);
      tier.position.set(tx, h + 0.5 + th / 2, tz);
      island.add(tier);
    }

    // Absolute-Y collision: stand between towers or on their roofs.
    boxes.push({
      minX: x + tx - w / 2,
      maxX: x + tx + w / 2,
      minZ: z + tz - d / 2,
      maxZ: z + tz + d / 2,
      base: y,
      height: y + h + 0.5,
    });

    // The tallest tower gets a blinking beacon antenna.
    if (i === 0) {
      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.12, 4, 5),
        new THREE.MeshStandardMaterial({ color: 0xd8e2ea }),
      );
      mast.position.set(tx, h + 2.5, tz);
      island.add(mast);
      const beaconMat = new THREE.MeshStandardMaterial({
        color: 0xff5a4e,
        emissive: 0xff2d1e,
        emissiveIntensity: 1.5,
      });
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), beaconMat);
      beacon.position.set(tx, h + 4.6, tz);
      island.add(beacon);
      pulsers.push({ mat: beaconMat, base: 1.5, amp: 1.2, speed: 2.4, phase: 0 });
    }
  }

  // A soft cyan glow rising from the block at dusk.
  const glow = new THREE.PointLight(0x63c4ff, 1.1, radius * 3.2, 2);
  glow.position.y = 8;
  island.add(glow);
}

/** Red three-tier pagoda with cherry trees — the poster's right island. */
function themeSkyShrine({ island, radius, x, y, z, rand, boxes, pulsers }: ThemeCtx) {
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xd0483a, roughness: 0.6, flatShading: true });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xf1e4cc, roughness: 0.9 });
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x4a2f1a, roughness: 1 });

  // Stone platform the pagoda sits on.
  const platform = new THREE.Mesh(new THREE.CylinderGeometry(6.4, 6.8, 0.7, 8), new THREE.MeshStandardMaterial({ color: 0xcfc8ba, roughness: 1 }));
  platform.position.y = 0.35;
  platform.receiveShadow = true;
  island.add(platform);

  // Three tiers, shrinking as they climb; 4-sided cone roofs read as the
  // classic upturned pagoda silhouette when squashed + overhung.
  const tiers: Array<[number, number]> = [
    [6.2, 3.0], // [wall width, wall height]
    [4.6, 2.5],
    [3.2, 2.2],
  ];
  let cursorY = 0.7;
  for (let i = 0; i < tiers.length; i++) {
    const [w, h] = tiers[i];
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), wallMat);
    wall.position.y = cursorY + h / 2;
    wall.castShadow = true;
    island.add(wall);
    // Dark wood band at each floor line.
    const band = new THREE.Mesh(new THREE.BoxGeometry(w + 0.25, 0.28, w + 0.25), woodMat);
    band.position.y = cursorY + 0.14;
    island.add(band);
    // Overhanging squashed pyramid roof.
    const roof = new THREE.Mesh(new THREE.ConeGeometry(w * 0.98, 1.9, 4), roofMat);
    roof.rotation.y = Math.PI / 4;
    roof.position.y = cursorY + h + 0.85;
    roof.castShadow = true;
    island.add(roof);
    cursorY += h + 1.35;
  }
  // Gold finial catching the sun.
  const finialMat = new THREE.MeshStandardMaterial({
    color: 0xffc94d,
    emissive: 0xff9a1f,
    emissiveIntensity: 0.6,
    roughness: 0.35,
    metalness: 0.6,
  });
  const finial = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), finialMat);
  finial.position.y = cursorY + 0.9;
  island.add(finial);
  const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.6, 5), finialMat);
  spire.position.y = cursorY + 0.2;
  island.add(spire);
  pulsers.push({ mat: finialMat, base: 0.6, amp: 0.35, speed: 1.1, phase: 1.7 });

  // Stepped colliders matching the three roof tiers, so the pagoda is
  // climbable parkour: hop roof → roof → spire instead of hitting one
  // invisible block (or clipping through a roof you landed on).
  const steps: Array<[number, number]> = [
    [3.4, 5.4], // [half-width, absolute top offset] — tier 1 roof edge
    [2.4, 9.0], // tier 2 roof edge
    [1.6, 12.3], // tier 3 roof top
  ];
  for (const [half, top] of steps) {
    boxes.push({
      minX: x - half,
      maxX: x + half,
      minZ: z - half,
      maxZ: z + half,
      base: y,
      height: y + top,
    });
  }

  // Cherry trees flanking the shrine.
  for (const side of [-1, 1]) {
    const cherry = makeTree(7, 2.6, rand, [0xf2a9c4, 0xe98db4]);
    cherry.position.set(side * radius * 0.55, 0, radius * 0.25 * side);
    island.add(cherry);
  }

  // Torii gate at the rim, welcoming flyers in from the plaza.
  const torii = new THREE.Group();
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 4.6, 8), roofMat);
    post.position.set(side * 2.1, 2.3, 0);
    torii.add(post);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.45, 0.5), roofMat);
  lintel.position.y = 4.7;
  torii.add(lintel);
  const beam = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.32, 0.4), roofMat);
  beam.position.y = 3.9;
  torii.add(beam);
  torii.position.set(0, 0, radius * 0.72);
  island.add(torii);

  // Two glowing stone lanterns along the approach.
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 1.6, 6), new THREE.MeshStandardMaterial({ color: 0x9a938a, roughness: 1 }));
    post.position.set(side * 1.6, 0.8, radius * 0.5);
    island.add(post);
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xffe6a0,
      emissive: 0xffb84a,
      emissiveIntensity: 1.1,
    });
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), lampMat);
    lamp.position.set(side * 1.6, 1.85, radius * 0.5);
    island.add(lamp);
    pulsers.push({ mat: lampMat, base: 1.1, amp: 0.35, speed: 1.6, phase: side });
  }
}

/** Pond, fireflies, and warm hanging lanterns — the twilight island. */
function themeLanternGrove({ island, radius, rand, pulsers, bobbers }: ThemeCtx) {
  // Still pond at the center.
  const pond = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 0.32, 18),
    new THREE.MeshStandardMaterial({
      color: 0x69c4e8,
      emissive: 0x2b7fa8,
      emissiveIntensity: 0.3,
      roughness: 0.15,
    }),
  );
  pond.rotation.x = -Math.PI / 2;
  pond.position.y = 0.06;
  island.add(pond);

  // A ring of small trees around the pond.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4;
    const tree = makeTree(4.5 + rand() * 1.5, 1.7, rand, [0x4f9d3a, 0x5fb24a]);
    tree.position.set(Math.cos(a) * radius * 0.6, 0, Math.sin(a) * radius * 0.6);
    island.add(tree);
  }

  // Lantern posts with warm hanging lights.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 1.1;
    const px = Math.cos(a) * radius * 0.42;
    const pz = Math.sin(a) * radius * 0.42;
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.13, 2.6, 5),
      new THREE.MeshStandardMaterial({ color: 0x2a1e14, roughness: 1 }),
    );
    post.position.set(px, 1.3, pz);
    island.add(post);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.9, 4), post.material);
    arm.rotation.z = Math.PI / 2;
    arm.position.set(px + 0.45, 2.55, pz);
    island.add(arm);
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xffe6a0,
      emissive: 0xffb84a,
      emissiveIntensity: 1.4,
      roughness: 0.4,
    });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), lampMat);
    lamp.position.set(px + 0.85, 2.3, pz);
    island.add(lamp);
    pulsers.push({ mat: lampMat, base: 1.4, amp: 0.45, speed: 1.8, phase: i * 2.1 });
  }
  const glow = new THREE.PointLight(0xffb84a, 1.2, radius * 2.6, 2);
  glow.position.y = 3;
  island.add(glow);

  // Fireflies drifting over the meadow.
  for (let i = 0; i < 8; i++) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xfff2b0,
      emissive: 0xffe28a,
      emissiveIntensity: 1.6,
    });
    const fly = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 5), mat);
    const a = rand() * Math.PI * 2;
    const r = radius * (0.25 + rand() * 0.55);
    const yy = 0.8 + rand() * 2.2;
    fly.position.set(Math.cos(a) * r, yy, Math.sin(a) * r);
    island.add(fly);
    bobbers.push({ obj: fly, baseY: yy, phase: rand() * Math.PI * 2, amp: 0.5 + rand() * 0.5, spin: 0 });
    pulsers.push({ mat, base: 1.6, amp: 1.0, speed: 2.6, phase: rand() * Math.PI * 2 });
  }

  const rock = makeBoulder(1.1, rand);
  rock.position.set(-radius * 0.35, rock.position.y, radius * 0.45);
  island.add(rock);
  scatterFlowers(island, radius, 10, rand);
}

// ---------------------------------------------------------------------------
// Zeppelin — cream hull, red fins, endlessly circling the city. Rideable:
// hop onto the plank deck along the top of the hull and it carries you.
// ---------------------------------------------------------------------------

function buildZeppelin(): { group: THREE.Group; update: (now: number) => void; ride: ZeppelinRide } {
  const g = new THREE.Group();
  const cream = new THREE.MeshStandardMaterial({ color: 0xe9e2d2, roughness: 0.65 });
  const red = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.7 });

  // Long axis along +Z so yaw math stays simple.
  const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), cream);
  hull.scale.set(4.2, 4.2, 14);
  g.add(hull);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), red);
  nose.scale.set(2.1, 2.1, 2.6);
  nose.position.z = 12.1;
  g.add(nose);
  // Tail fins: one vertical, two horizontal.
  const finGeo = new THREE.BoxGeometry(0.3, 4.4, 3.6);
  const finV = new THREE.Mesh(finGeo, red);
  finV.position.set(0, 0, -11.5);
  finV.rotation.z = Math.PI / 2;
  g.add(finV);
  for (const side of [-1, 1]) {
    const fin = new THREE.Mesh(finGeo, red);
    fin.position.set(side * 2.2, 0, -11.5);
    g.add(fin);
  }
  // Gondola cabin slung underneath.
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.5, 4.4), new THREE.MeshStandardMaterial({ color: 0x6b5138, roughness: 0.9 }));
  cabin.position.y = -4.6;
  g.add(cabin);

  // Walkable plank deck along the top of the hull, with rope-rail posts
  // so it reads as "you can stand here" from a distance.
  const DECK_Y = 4.3;
  const DECK_HALF_W = 1.8;
  const DECK_HALF_L = 5.75;
  const wood = new THREE.MeshStandardMaterial({ color: 0x8b6a45, roughness: 0.85 });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(DECK_HALF_W * 2, 0.24, DECK_HALF_L * 2), wood);
  deck.position.y = DECK_Y;
  g.add(deck);
  // Plank seams.
  const seamMat = new THREE.MeshStandardMaterial({ color: 0x6f5233, roughness: 0.9 });
  for (let i = -4; i <= 4; i++) {
    const seam = new THREE.Mesh(new THREE.BoxGeometry(DECK_HALF_W * 2 + 0.02, 0.02, 0.07), seamMat);
    seam.position.set(0, DECK_Y + 0.13, i * 1.25);
    g.add(seam);
  }
  // Rail posts + top rail on both sides.
  const railMat = new THREE.MeshStandardMaterial({ color: 0x4a3a26, roughness: 0.8 });
  for (const side of [-1, 1]) {
    for (let i = -2; i <= 2; i++) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.85, 8), railMat);
      post.position.set(side * (DECK_HALF_W - 0.12), DECK_Y + 0.54, i * 2.6);
      g.add(post);
    }
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, DECK_HALF_L * 2 - 0.4, 8), railMat);
    rail.rotation.x = Math.PI / 2;
    rail.position.set(side * (DECK_HALF_W - 0.12), DECK_Y + 0.95, 0);
    g.add(rail);
  }
  // Little pennant at the bow of the deck.
  const flagPole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.2, 6), railMat);
  flagPole.position.set(0, DECK_Y + 0.72, DECK_HALF_L - 0.25);
  g.add(flagPole);
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(0.7, 0.4),
    new THREE.MeshBasicMaterial({ color: 0xe94f8a, side: THREE.DoubleSide }),
  );
  flag.position.set(0.36, DECK_Y + 1.15, DECK_HALF_L - 0.25);
  flag.rotation.y = Math.PI / 2;
  g.add(flag);

  // OMEGA tuned so deck speed (~14.5 m/s) sits under jetpack cruise
  // (22 m/s) — you can actually chase it down and hop on.
  const CX = 40, CZ = -60, CY = 148, R = 230, OMEGA = 0.01;
  const ride: ZeppelinRide = {
    pos: new THREE.Vector3(CX + R, CY, CZ),
    prevPos: new THREE.Vector3(CX + R, CY, CZ),
    yaw: Math.atan2(-0, 1),
    prevYaw: Math.atan2(-0, 1),
    deckY: DECK_Y + 0.12, // top of the plank slab
    halfW: DECK_HALF_W,
    halfL: DECK_HALF_L,
  };
  return {
    group: g,
    ride,
    update(now: number) {
      ride.prevPos.copy(ride.pos);
      ride.prevYaw = ride.yaw;
      const a = now * 0.001 * OMEGA * Math.PI * 2;
      g.position.set(CX + Math.cos(a) * R, CY + Math.sin(now * 0.0005) * 2.5, CZ + Math.sin(a) * R);
      // Face along the orbit tangent (-sin a, 0, cos a).
      g.rotation.y = Math.atan2(-Math.sin(a), Math.cos(a));
      ride.pos.copy(g.position);
      ride.yaw = g.rotation.y;
    },
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface Spec {
  key: string;
  name: string;
  x: number;
  y: number; // world Y of the walkable top
  z: number;
  radius: number;
  seed: number;
  theme: (ctx: ThemeCtx) => void;
}

// A rising bounce arc through the western sky: plaza → tree → crystal
// city → shrine → grove → onward to the moons. All outside or above the
// city grid (±180m, towers max ~88m).
const SPECS: Spec[] = [
  { key: "sky-lone-tree", name: "Lone Tree Island", x: -140, y: 55, z: 130, radius: 20, seed: 101, theme: themeLoneTree },
  { key: "sky-crystal", name: "Crystal Isle", x: -240, y: 85, z: -20, radius: 26, seed: 202, theme: themeCrystalCity },
  { key: "sky-shrine", name: "Sky Shrine", x: -140, y: 115, z: -180, radius: 18, seed: 303, theme: themeSkyShrine },
  { key: "sky-grove", name: "Lantern Grove", x: 40, y: 80, z: -230, radius: 16, seed: 404, theme: themeLanternGrove },
];

export function buildSkyIslands({ boxes }: { boxes: WorldBox[] }): SkyIslandsWorld {
  const root = new THREE.Group();
  const bobbers: Bobber[] = [];
  const pulsers: Pulser[] = [];
  const pads: SkyIslandsWorld["pads"] = [];

  for (const s of SPECS) {
    const rand = mulberry32(s.seed);
    const island = new THREE.Group();
    // The group origin IS the walkable top surface (local y=0).
    island.position.set(s.x, s.y, s.z);
    root.add(island);

    island.add(makeIslandBase(s.radius, rand, bobbers));
    s.theme({ island, radius: s.radius, x: s.x, y: s.y, z: s.z, rand, boxes, pulsers, bobbers });

    // Ground collider. height is the ABSOLUTE top Y (see header comment).
    // The island itself never moves — a solid floor beats a bobbing one.
    const half = s.radius * 0.72;
    boxes.push({
      minX: s.x - half,
      maxX: s.x + half,
      minZ: s.z - half,
      maxZ: s.z + half,
      base: s.y - CAP_H - 1,
      height: s.y,
    });

    pads.push({ key: s.key, name: s.name, pos: new THREE.Vector3(s.x, s.y + 0.6, s.z) });
  }

  const zeppelin = buildZeppelin();
  root.add(zeppelin.group);

  return {
    group: root,
    pads,
    zeppelin: zeppelin.ride,
    update(_dt, now) {
      const t = now * 0.001;
      for (const b of bobbers) {
        b.obj.position.y = b.baseY + Math.sin(t * 0.6 + b.phase) * b.amp;
        if (b.spin !== 0) b.obj.rotation.y += b.spin * 0.016;
      }
      for (const p of pulsers) {
        p.mat.emissiveIntensity = p.base + Math.sin(t * p.speed + p.phase) * p.amp;
      }
      zeppelin.update(now);
    },
  };
}
