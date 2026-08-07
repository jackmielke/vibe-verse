/**
 * Scatter — the rocks, boulders, tufts and debris lying on the ground.
 *
 * This is the highest ratio of "reads as a real place" to lines of code in the
 * whole world, and it is worth saying why, because it is not obvious from a
 * screenshot: **an empty ground plane has no scale.** A terrain with hills on
 * it is still just a shape until there is something on it whose size the eye
 * already knows. Put a fist-sized rock in the foreground and the hill behind it
 * is suddenly two hundred metres away, the pillar is eight metres tall, and the
 * person standing between them is a person. Take it away and all three of those
 * facts go with it.
 *
 * Three bands, and the sizes are chosen so the eye can ladder between them:
 * gravel you almost step on, cobbles at a stride, and boulders you would walk
 * around. Each band is one `InstancedMesh` — so the whole thing is three draw
 * calls for two and a half thousand objects — and each band's density falls off
 * with distance so the near ground is busy and the far ground is not paying for
 * detail nobody can resolve.
 *
 * Two rules that keep it from looking like confetti:
 *
 * **Nothing is a sphere.** Each band bakes one low-poly shape whose vertices
 * have been pushed around by the same seeded noise the terrain uses, then every
 * instance gets its own non-uniform scale and a random rotation on all three
 * axes. Two hundred copies of one rock at one size is worse than no rocks.
 *
 * **Everything is bedded in.** Instances sit slightly *below* the height field
 * rather than on it. A rock resting exactly on a surface reads as dropped; a
 * rock with its bottom third buried reads as having been there a while, and it
 * also hides the fact that the terrain under it is a 6 m quad.
 */
import * as THREE from "three";
import { makeRng } from "../types";
import { surfaced, type SurfaceFamily } from "../gfx/surfacing";

export interface ScatterOptions {
  /** Where the ground is. The same function the terrain and the kit use. */
  height: (x: number, z: number) => number;
  /** Base colour, usually a shade off the terrain's own tint. */
  color: number;
  family: SurfaceFamily;
  seed: number;
  /** 0-1. Risa's beach wants a third of what Vulcan's mountain does. */
  density?: number;
  /** Radius to cover. Beyond this the fog has it anyway. */
  radius?: number;
  /** A second, sparser band in a different colour — lichen, ice, scrub. */
  accent?: { color: number; family: SurfaceFamily; density: number };
}

export interface Scatter {
  group: THREE.Group;
  dispose(): void;
}

interface Band {
  /** Metres. min, max. */
  size: [number, number];
  count: number;
  /** How far out this band is placed. */
  reach: number;
  /** Faces on the base shape. More for the big ones — a boulder's silhouette
   *  is visible and a pebble's is two pixels. */
  detail: number;
  /** How deep it sits in the ground, as a fraction of its own height. */
  bury: number;
}

const BANDS: Band[] = [
  { size: [0.09, 0.28], count: 1500, reach: 40, detail: 0, bury: 0.4 },
  { size: [0.35, 1.1], count: 800, reach: 120, detail: 1, bury: 0.3 },
  { size: [1.6, 5.5], count: 230, reach: 300, detail: 2, bury: 0.22 },
];

export function createScatter(opts: ScatterOptions): Scatter {
  const group = new THREE.Group();
  const rng = makeRng(opts.seed ^ 0x5ca77e);
  const density = opts.density ?? 1;
  const owned: { dispose(): void }[] = [];

  /* The scatter has to sit *off* the ground's own value, not on it.
   *
   * The first pass tinted the rocks with a shade of the terrain colour, which
   * is what a real geologist would tell you to do and which rendered two and a
   * half thousand objects completely invisible: same hue, same value, same
   * material, lying on top of each other. They are darkened here on purpose —
   * loose rock is shadowed on every face the sky cannot see, and reading as
   * separate objects matters more than reading as the same mineral. */
  const mat = surfaced({
    color: opts.color,
    family: opts.family,
    // A tighter tile than the ground's: these are small objects and they need
    // their grain to read at arm's length, not at ten metres.
    tile: 0.7,
    macro: 0.3,
    bump: 1.1,
  });
  owned.push(mat);

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();

  const build = (band: Band, material: THREE.Material, dens: number, tag: string) => {
    const n = Math.max(1, Math.round(band.count * dens));
    const geo = rockGeometry(band.detail, makeRng(opts.seed ^ (tag.length * 7717) ^ band.count));
    owned.push(geo);
    const mesh = new THREE.InstancedMesh(geo, material, n);
    mesh.castShadow = band.detail > 0;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    for (let i = 0; i < n; i++) {
      // sqrt on the radius gives uniform area density; without it everything
      // piles up at the origin and the far ground is bare.
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * Math.min(band.reach, opts.radius ?? 300);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;

      const s = band.size[0] + rng() * (band.size[1] - band.size[0]);
      scl.set(s * (0.7 + rng() * 0.6), s * (0.5 + rng() * 0.7), s * (0.7 + rng() * 0.6));
      pos.set(x, opts.height(x, z) - scl.y * band.bury, z);
      e.set(rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2);
      q.setFromEuler(e);
      m4.compose(pos, q, scl);
      mesh.setMatrixAt(i, m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  };

  for (const band of BANDS) build(band, mat, density, "base");

  if (opts.accent) {
    const aMat = surfaced({
      color: opts.accent.color,
      family: opts.accent.family,
      tile: 0.55,
      macro: 0.35,
    });
    owned.push(aMat);
    build(BANDS[1], aMat, opts.accent.density, "accent");
  }

  return {
    group,
    dispose() {
      for (const o of owned) o.dispose();
      group.parent?.remove(group);
    },
  };
}

/**
 * One irregular lump.
 *
 * An icosahedron with every vertex pushed along its own normal by a seeded
 * noise, then re-normalled. The point is that it has no axis of symmetry and
 * no flat face large enough to catch a specular highlight the same way twice —
 * a scaled sphere reads as a bubble at any size, and a scaled cube reads as a
 * crate.
 */
function rockGeometry(detail: number, rng: () => number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(0.5, detail);
  const p = geo.attributes.position as THREE.BufferAttribute;
  // A small random basis per shape so two shapes at the same detail level are
  // not the same rock.
  const ax = rng() * 10;
  const ay = rng() * 10;
  const az = rng() * 10;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const n =
      Math.sin(x * 7.3 + ax) * Math.cos(y * 6.1 + ay) * Math.sin(z * 5.7 + az) * 0.5 +
      Math.sin(x * 15.1 + az) * Math.cos(z * 13.3 + ax) * 0.22;
    const k = 1 + n * 0.32;
    p.setXYZ(i, x * k, y * k, z * k);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}
