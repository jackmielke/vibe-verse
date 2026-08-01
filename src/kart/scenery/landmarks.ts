/**
 * Vibe Kart — the middle distance and the skyline.
 *
 * Fog is a wonderful thing but it cannot hide an empty horizon: point the
 * camera anywhere outside the circuit and there has to be *something* out
 * there. This module builds the land the track sits in and the three or four
 * silhouettes that make a scenic pose worth taking.
 *
 * The layout is deliberately blind to the track's actual shape. Everything is
 * placed on a ring outside the circuit's bounding radius, so however the track
 * system laid its spline out, no hill and no castle can ever end up on the
 * racing line. The one thing that does follow the track is the inner lip of the
 * terrain ring, which drops away from the circuit like the run-off of a real
 * plateau course.
 *
 * Cost: the far ring is one flat-shaded draw call, the hills and mesas are two
 * instanced kinds, and each hero landmark is one to three merged meshes. The
 * Ferris wheel's twenty-four gondolas are a single `InstancedMesh` whose
 * matrices are rewritten each frame — twenty-four matrix composes, which is
 * cheaper than the branch that would avoid them.
 */
import * as THREE from "three";
import type { BuildCtx, SceneryPiece } from "./build";
import { scatter } from "./layout";
import {
  TAU,
  at,
  clamp01,
  fbm2,
  gBox,
  gCone,
  gCyl,
  gIco,
  gTorus,
  lerp,
  merge,
  rand,
  smoothstep,
  strut,
  type Part,
  type Rng,
} from "./util";

// ---------------------------------------------------------------------------
// The land
// ---------------------------------------------------------------------------

/**
 * The terrain ring.
 *
 * A polar grid from just outside the circuit out to the fog wall. Height is
 * fbm scaled by a ramp that grows with radius, so the ground rolls gently near
 * the track and rears into ridges at the horizon; one angular wedge is pushed
 * below sea level to carve the bay.
 *
 * Vertex colours do all the material work — meadow, scrub, rock, snow, chosen
 * by height and slope — because at 400 m through fog a texture is a waste of
 * bandwidth and flat shading reads the silhouette better anyway.
 */
function terrainRing(
  segments: number,
  inner: number,
  outer: number,
  baseY: number,
  seaY: number,
  bayAngle: number,
  bayWidth: number,
  /** Verge height in ring-local coordinates — the track's own run-off. */
  vergeHeight: (x: number, z: number) => number,
): { geometry: THREE.BufferGeometry; heightAt: (x: number, z: number) => number } {
  const rings = 16;
  const verts: number[] = [];
  const colors: number[] = [];
  const index: number[] = [];
  const col = new THREE.Color();

  const heightAt = (x: number, z: number): number => {
    const r = Math.hypot(x, z);
    const a = Math.atan2(z, x);
    // Ramp: nothing near the circuit, real relief past a couple of hundred
    // metres. Squared so the transition is a valley floor, not a wall.
    const k = clamp01((r - inner) / Math.max(1, outer - inner));
    const ramp = k * k * 150;
    const h = baseY - 3 + fbm2(x * 0.0038, z * 0.0038) * ramp + fbm2(x * 0.011, z * 0.011) * ramp * 0.22;
    // The bay: a smooth angular notch dropped below the water line.
    let da = Math.abs(((a - bayAngle + Math.PI * 3) % TAU) - Math.PI);
    da = Math.min(da, TAU - da);
    const bay = 1 - smoothstep(bayWidth * 0.45, bayWidth, da);
    const land = lerp(h, seaY - 14 - k * 40, bay * clamp01((r - inner - 60) / 220));
    // The inner rows are pinned to the track's own verge and released into the
    // noise over the first 25 % of the ring. Without this the ring's rim is a
    // metre-high step running all the way round the circuit — the single most
    // visible artefact of owning the scenery but not the ground it stands on.
    return lerp(vergeHeight(x, z), land, smoothstep(0, 0.22, k));
  };

  for (let ri = 0; ri <= rings; ri++) {
    // Geometric spacing: the near rings get the resolution, the far ones are
    // three kilometres of fog and do not need it.
    const f = ri / rings;
    const r = inner + (outer - inner) * f * f;
    for (let si = 0; si <= segments; si++) {
      const a = (si / segments) * TAU;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = heightAt(x, z);
      verts.push(x, y, z);

      // Palette by altitude, with the far field desaturating into the haze so
      // the horizon recedes instead of stacking up as a cardboard cut-out.
      const alt = clamp01((y - baseY) / 90);
      if (y < seaY + 3) col.setHex(0xd8c89a, THREE.SRGBColorSpace);
      else if (alt < 0.16) col.setHex(0x5f9e46, THREE.SRGBColorSpace);
      else if (alt < 0.42) col.setHex(0x4d8340, THREE.SRGBColorSpace);
      else if (alt < 0.7) col.setHex(0x7a7461, THREE.SRGBColorSpace);
      else col.setHex(0xd7dbe2, THREE.SRGBColorSpace);
      const haze = clamp01((r - inner) / (outer - inner));
      col.lerp(HAZE, haze * 0.55);
      colors.push(col.r, col.g, col.b);
    }
  }

  const stride = segments + 1;
  for (let ri = 0; ri < rings; ri++) {
    for (let si = 0; si < segments; si++) {
      const a = ri * stride + si;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((verts.length / 3) * 2), 2));
  g.setIndex(index);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return { geometry: g, heightAt };
}

/** A displaced dome. Squashed and scaled per instance into a range of hills. */
function hillGeometry(rng: Rng): THREE.BufferGeometry {
  const g = gIco(1, 2);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const seed = rng() * 100;
  for (let i = 0; i < pos.count; i++) {
    const x = arr[i * 3];
    let y = arr[i * 3 + 1];
    const z = arr[i * 3 + 2];
    // Flatten the lower hemisphere onto the ground plane and push the rest out
    // with noise: a hill, not a buried ball.
    y = Math.max(0, y);
    const d = 1 + fbm2(x * 2.3 + seed, z * 2.3 + seed) * 0.42;
    arr[i * 3] = x * d;
    arr[i * 3 + 1] = y * d * 0.72;
    arr[i * 3 + 2] = z * d;
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();

  // Colour by height and slope, baked into the geometry rather than applied per
  // instance. `mats.distant` is vertex-coloured, so a hill with no `color`
  // attribute renders solid black — and one painted flat white renders as a
  // snowdrift in a summer meadow. Both of those were bugs; this ramp fixes them
  // and does the shading in the same pass.
  const nrm = (g.getAttribute("normal") as THREE.BufferAttribute).array as Float32Array;
  const col = new THREE.Color();
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const h = clamp01(arr[i * 3 + 1] / 0.72);
    if (h < 0.5) col.setHex(0x63a848, THREE.SRGBColorSpace);
    else if (h < 0.8) col.setHex(0x53914a, THREE.SRGBColorSpace);
    else col.setHex(0x7d8a5c, THREE.SRGBColorSpace);
    // Steep faces go stony: it is what stops a range of hills reading as a row
    // of green scoops of ice cream.
    const slope = 1 - Math.abs(nrm[i * 3 + 1]);
    col.lerp(ROCKY, clamp01(slope * 1.2 - 0.3));
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.computeBoundingSphere();
  return g;
}

/** A flat-topped mesa: hard silhouette, strata in the vertex colours. */
function mesaGeometry(rng: Rng): THREE.BufferGeometry {
  const sides = 9;
  const parts: Part[] = [];
  const layers = 4;
  let r = 1;
  let y = 0;
  for (let i = 0; i < layers; i++) {
    const h = 0.28 + rng() * 0.14;
    const rTop = r * (0.78 + rng() * 0.12);
    parts.push({
      geo: at(gCyl(rTop, r, h, sides, true), 0, y + h * 0.5, 0),
      color: i % 2 === 0 ? 0xb09274 : 0x9c7f63,
    });
    y += h;
    r = rTop;
  }
  parts.push({ geo: at(gCyl(r, r, 0.06, sides), 0, y, 0), color: 0x8e9c62 });
  return merge(parts);
}

// ---------------------------------------------------------------------------
// Hero landmarks
// ---------------------------------------------------------------------------

/** A castle: keep, four towers, curtain wall, gatehouse. Silhouette first. */
function castleGeometry(rng: Rng): THREE.BufferGeometry {
  const parts: Part[] = [];
  const stone = 0xd6cfc0;
  const roof = 0x3f5fa8;

  const tower = (x: number, z: number, r: number, h: number) => {
    parts.push({ geo: at(gCyl(r * 0.94, r, h, 10, true), x, h * 0.5, z), color: stone });
    // Machicolation ring — the flare under the battlement that reads as "old"
    // from a kilometre away.
    parts.push({ geo: at(gCyl(r * 1.22, r * 1.0, r * 0.4, 10), x, h + r * 0.2, z), color: 0xc4bcab });
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU;
      parts.push({
        geo: at(gBox(r * 0.34, r * 0.5, r * 0.34), x + Math.cos(a) * r * 1.1, h + r * 0.62, z + Math.sin(a) * r * 1.1, a),
        color: stone,
      });
    }
    parts.push({ geo: at(gCone(r * 1.35, h * 0.55, 10), x, h + r * 0.4 + h * 0.275, z), color: roof });
    parts.push({ geo: at(gCyl(0.1, 0.1, h * 0.2, 4), x, h + r * 0.4 + h * 0.62, z), color: 0x8a8a8a });
  };

  // Curtain wall between four corner towers.
  const w = 26;
  const wallH = 11;
  for (const [x0, z0, x1, z1] of [
    [-w, -w, w, -w],
    [w, -w, w, w],
    [w, w, -w, w],
    [-w, w, -w, -w],
  ] as const) {
    // A wall is a solid slab, not a bar: box length along local X, yawed onto
    // the run. `strut` would be the tool for a diagonal, but these are level.
    parts.push({
      geo: at(
        gBox(Math.hypot(x1 - x0, z1 - z0), wallH, 2.6),
        (x0 + x1) * 0.5,
        wallH * 0.5,
        (z0 + z1) * 0.5,
        Math.atan2(-(z1 - z0), x1 - x0),
      ),
      color: stone,
    });
    // Crenellations along the top.
    const n = 9;
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n;
      parts.push({
        geo: at(gBox(1.5, 1.5, 1.5), lerp(x0, x1, f), wallH + 0.75, lerp(z0, z1, f)),
        color: stone,
      });
    }
  }

  tower(-w, -w, 4.2, 20);
  tower(w, -w, 4.2, 20);
  tower(w, w, 3.6, 17);
  tower(-w, w, 3.6, 17);

  // The keep, tallest thing on the hill.
  parts.push({ geo: at(gBox(16, 30, 14), 0, 15, 3), color: 0xe0d9ca });
  for (let i = 0; i < 12; i++) {
    parts.push({ geo: at(gBox(1.7, 2.0, 1.7), -7.2 + (i % 6) * 2.9, 31, i < 6 ? -3.4 : 9.4), color: stone });
  }
  parts.push({ geo: at(gBox(18, 1.2, 16), 0, 30.3, 3), color: 0xcbc3b2 });
  tower(-8.5, -4.5, 3.2, 36);
  tower(8.5, -4.5, 3.2, 36);
  // Windows: dark slots that give the mass a scale reference.
  for (let i = 0; i < 8; i++) {
    parts.push({ geo: at(gBox(1.1, 2.6, 0.5), -6 + (i % 4) * 4, 10 + Math.floor(i / 4) * 8, -4.2), color: 0x2b3345 });
  }

  // Gatehouse and a bridge out toward the world.
  parts.push({ geo: at(gBox(10, 14, 5), 0, 7, -w - 1.6), color: 0xd9d2c3 });
  parts.push({ geo: at(gBox(4.4, 7.2, 1.2), 0, 3.6, -w - 4.2), color: 0x3a2b1c });
  parts.push({ geo: at(gBox(6, 0.7, 14), 0, 0.35, -w - 10), color: 0x8a7358 });

  // Pennants on the towers, painted so the castle is not one flat stone tone.
  for (const [x, z] of [[-w, -w], [w, -w]] as const) {
    parts.push({ geo: at(gBox(3.4, 1.6, 0.08), x + 1.9, 27.5, z, 0.6), color: rng() < 0.5 ? 0xe8402a : 0x1b57c4 });
  }

  return merge(parts);
}

/** Windmill: static tower, rotating sail assembly. */
function windmillParts(): { tower: THREE.BufferGeometry; sails: THREE.BufferGeometry } {
  const parts: Part[] = [];
  const h = 17;
  parts.push({ geo: at(gCyl(2.6, 4.6, h, 10, true), 0, h * 0.5, 0), color: 0xf0ece2 });
  // Painted plinth and a stripe: a plain white cone is a traffic cone.
  parts.push({ geo: at(gCyl(4.8, 5.4, 1.6, 10), 0, 0.8, 0), color: 0xc9b393 });
  parts.push({ geo: at(gCyl(3.1, 3.3, 1.1, 10), 0, h * 0.42, 0), color: 0x2c6a8c });
  parts.push({ geo: at(gCone(3.4, 4.2, 10), 0, h + 1.6, 0), color: 0x8a3b2a });
  parts.push({ geo: at(gCyl(0.6, 0.6, 2.4, 8), 0, h + 0.6, -2.6, 0, Math.PI / 2), color: 0x5a4330 });
  // A little gallery balcony, the detail that gives the tower its scale.
  parts.push({ geo: at(gCyl(4.2, 4.2, 0.2, 12), 0, h * 0.58, 0), color: 0x7a5c3c });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    parts.push({
      geo: at(gBox(0.12, 0.9, 0.12), Math.cos(a) * 4.0, h * 0.58 + 0.45, Math.sin(a) * 4.0),
      color: 0x7a5c3c,
    });
  }
  const tower = merge(parts);

  const sailParts: Part[] = [{ geo: at(gCyl(0.7, 0.7, 0.9, 10), 0, 0, 0, 0, Math.PI / 2), color: 0x4a3826 }];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // Spar, then the lattice of the sail cloth frame.
    sailParts.push({
      geo: at(gBox(0.34, 13, 0.34), ca * 6.5, sa * 6.5, 0, 0, 0, a + Math.PI / 2),
      color: 0x4a3826,
    });
    for (let k = 1; k <= 7; k++) {
      const f = k / 8;
      const r = f * 13;
      sailParts.push({
        geo: at(gBox(2.6, 0.16, 0.16), ca * r + sa * 1.1, sa * r - ca * 1.1, 0, 0, 0, a + Math.PI / 2),
        color: 0xefe7d4,
      });
    }
    sailParts.push({
      geo: at(gBox(0.9, 13, 0.12), ca * 6.5 + sa * 2.0, sa * 6.5 - ca * 2.0, 0.05, 0, 0, a + Math.PI / 2),
      color: 0xf7f2e4,
    });
  }
  return { tower, sails: merge(sailParts) };
}

/** Ferris wheel: static towers, a rotating rim, counter-rotated gondolas. */
function ferrisParts(cabins: number): {
  base: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry;
  cabin: THREE.BufferGeometry;
  radius: number;
  hubY: number;
} {
  const radius = 30;
  const hubY = 34;
  const base: Part[] = [];
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      base.push({
        geo: strut(gBox(1, 1, 1), sx * 15, 0, sz * 9, sx * 1.4, hubY, sz * 1.6, 1.1, 1.1),
        color: 0xe6e9ee,
      });
    }
    base.push({ geo: at(gBox(34, 1.2, 4), 0, 0.6, sz * 9), color: 0xb8bec6 });
  }
  base.push({ geo: at(gCyl(1.9, 1.9, 5.4, 12), 0, hubY, 0, 0, Math.PI / 2), color: 0xd0d6de });
  // Cross-bracing between the A-frames, and the boarding platform.
  for (const sx of [-1, 1]) {
    base.push({ geo: strut(gBox(1, 1, 1), sx * 8, hubY * 0.5, -9, sx * 8, hubY * 0.5, 9, 0.7, 0.7), color: 0xc6ccd4 });
  }
  base.push({ geo: at(gBox(16, 0.6, 9), 0, 3.2, 0), color: 0xdfd6c4 });
  base.push({ geo: at(gBox(16, 3.4, 0.3), 0, 5, -4.4), color: 0xe8402a });

  const wheel: Part[] = [];
  for (const sz of [-1.9, 1.9]) {
    wheel.push({ geo: at(gTorus(radius, 0.42, 6, cabins * 2), 0, 0, sz), color: 0xf2f4f7 });
    wheel.push({ geo: at(gTorus(radius * 0.42, 0.3, 6, cabins), 0, 0, sz), color: 0xe4e8ee });
  }
  for (let i = 0; i < cabins; i++) {
    const a = (i / cabins) * TAU;
    const x = Math.cos(a) * radius;
    const y = Math.sin(a) * radius;
    for (const sz of [-1.9, 1.9]) {
      wheel.push({ geo: strut(gBox(1, 1, 1), 0, 0, sz, x, y, sz, 0.16, 0.16), color: 0xdfe4ea });
    }
    // Bracing between the two rims, so the wheel has depth from the side.
    wheel.push({ geo: strut(gBox(1, 1, 1), x, y, -1.9, x, y, 1.9, 0.16, 0.16), color: 0xdfe4ea });
    // Rim lamps: with bloom on, the wheel reads as lit even at midday.
    wheel.push({ geo: at(gIco(0.36), x * 1.03, y * 1.03, 0), color: 0xfff0b8 });
  }

  const cabin: Part[] = [
    { geo: at(gBox(2.6, 0.3, 2.4), 0, -2.4, 0), color: 0xdfe4ea },
    { geo: at(gCyl(1.35, 1.5, 2.2, 8), 0, -1.2, 0), color: 0xffffff },
    { geo: at(gCyl(1.5, 1.2, 0.7, 8), 0, 0.2, 0), color: 0xffffff },
    { geo: at(gBox(0.16, 2.2, 0.16), 0, -3.4, 0), color: 0xc6ccd4 },
    // Window band, dark: it is what makes the pod read as a thing you sit in.
    { geo: at(gCyl(1.42, 1.42, 0.9, 8, true), 0, -1.3, 0), color: 0x2a3a4a },
  ];

  return { base: merge(base), wheel: merge(wheel), cabin: merge(cabin), radius, hubY };
}

/** Lighthouse on the headland: banded tower, glazed lamp room, emissive lens. */
function lighthouseGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [];
  const h = 26;
  for (let i = 0; i < 7; i++) {
    const y0 = (i / 7) * h;
    const y1 = ((i + 1) / 7) * h;
    parts.push({
      geo: at(gCyl(3.6 - (y1 / h) * 1.9, 3.6 - (y0 / h) * 1.9, y1 - y0, 12, true), 0, (y0 + y1) * 0.5, 0),
      color: i % 2 === 0 ? 0xf6f4ee : 0xe03c2c,
    });
  }
  parts.push({ geo: at(gCyl(3.0, 2.6, 0.6, 12), 0, h + 0.3, 0), color: 0xd7d2c6 });
  parts.push({ geo: at(gCyl(2.0, 2.0, 3.0, 10, true), 0, h + 2.1, 0), color: 0x2b3542 });
  parts.push({ geo: at(gCone(2.6, 2.4, 10), 0, h + 4.8, 0), color: 0x2c6a8c });
  parts.push({ geo: at(gCyl(0.9, 0.9, 1.4, 8), 0, h + 2.1, 0), color: 0xfff0b8 });
  parts.push({ geo: at(gBox(9, 0.6, 7), 0, 0.3, 4), color: 0xe8e3d6 });
  parts.push({ geo: at(gBox(7, 3.4, 5), 0, 1.9, 5), color: 0xf1ece0 });
  parts.push({ geo: at(gBox(7.6, 0.4, 5.6), 0, 3.7, 5, 0, 0.12), color: 0xc0392b });
  return merge(parts);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const HAZE = new THREE.Color(0.62, 0.72, 0.82);
const ROCKY = new THREE.Color().setHex(0x8f8574, THREE.SRGBColorSpace);

export function buildLandmarks(b: BuildCtx): SceneryPiece {
  const { sampler, mats, res, density, field, plan, root } = b;
  const rng: Rng = b.rng("landmarks");

  const inner = sampler.farRadius(55);
  const outer = sampler.farRadius(1150);
  const baseY = sampler.meanY;
  const seaY = baseY - 26;
  const bayAngle = rand(rng, 0, TAU);
  const bayWidth = 1.15;

  // --- the land ------------------------------------------------------------
  const { geometry: ringGeo, heightAt } = terrainRing(
    density.farSegments,
    inner,
    outer,
    baseY,
    seaY,
    bayAngle,
    bayWidth,
    (x, z) => sampler.groundAt(x + sampler.centre.x, z + sampler.centre.z),
  );
  res.geo(ringGeo);
  const ring = new THREE.Mesh(ringGeo, mats.distant);
  ring.name = "scenery/terrain-ring";
  ring.position.set(sampler.centre.x, 0, sampler.centre.z);
  ring.receiveShadow = false;
  ring.castShadow = false;
  // The ring is a bowl around the camera and is essentially always on screen;
  // culling it costs a bounding test and saves nothing.
  ring.frustumCulled = false;
  root.add(ring);

  /** Ground height in the far field, in world space. */
  const groundFar = (x: number, z: number) => heightAt(x - sampler.centre.x, z - sampler.centre.z);

  // --- the sea -------------------------------------------------------------
  // A disc sitting in the notch, big enough to run past the fog wall. It never
  // reaches the circuit, so it can never fight the track's own ground for depth.
  // Sized and pushed out so its near edge is always well past the circuit: the
  // bay is a view, not a hazard, and a sea disc that reaches the track turns
  // every low camera into an aquarium.
  const seaR = (outer - inner) * 0.38;
  const seaDist = inner + (outer - inner) * 0.7;
  const seaGeo = res.geo(new THREE.CircleGeometry(seaR, 48));
  seaGeo.rotateX(-Math.PI / 2);
  const sea = new THREE.Mesh(seaGeo, mats.water);
  sea.name = "scenery/sea";
  sea.position.set(
    sampler.centre.x + Math.cos(bayAngle) * seaDist,
    seaY,
    sampler.centre.z + Math.sin(bayAngle) * seaDist,
  );
  sea.receiveShadow = false;
  root.add(sea);

  // --- hills and mesas -----------------------------------------------------
  const kHill = field.define({
    name: "hill",
    geometry: res.geo(hillGeometry(b.rng("landmarks/hill"))),
    material: mats.distant,
    viewDistance: 2400,
    castShadow: false,
    receiveShadow: false,
    colored: true,
  });
  const kMesa = field.define({
    name: "mesa",
    geometry: res.geo(mesaGeometry(b.rng("landmarks/mesa"))),
    material: mats.rock,
    viewDistance: 2400,
    castShadow: false,
    receiveShadow: false,
    colored: true,
  });

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const tint = new THREE.Color();

  const addRelief = (kind: number, x: number, y: number, z: number, r: number, h: number, hue: THREE.Color) => {
    e.set(0, rng() * TAU, 0, "YXZ");
    q.setFromEuler(e);
    p.set(x, y, z);
    s.set(r, h, r * rand(rng, 0.8, 1.25));
    m.compose(p, q, s);
    field.add(kind, sampler.sectorAtPoint(x, z), m, hue);
  };

  // Mid-distance relief: just past the treeline, where it fills the gap between
  // the circuit and the horizon that fog alone leaves looking empty.
  scatter(
    sampler,
    b.rng("landmarks/near-hills"),
    { count: Math.round(density.hills * 0.45), minOffset: 110, maxOffset: 280, falloff: 0.2, spacing: 70, clearance: 95 },
    plan.keepOut,
    (hit) => {
      // The instance tint only nudges the baked ramp: the hill's actual colour
      // lives in its vertices, so a near-white tint here would erase it.
      const green = rand(rng, -0.07, 0.07);
      tint.setRGB(1 - green, 1 + green * 0.4, 1 - green * 1.3);
      addRelief(kHill, hit.x, hit.y - 3, hit.z, rand(rng, 26, 60), rand(rng, 12, 34), tint);
    },
  );

  // The far ring: a proper skyline of ridges and buttes.
  const farCount = Math.round(density.hills * 0.55);
  for (let i = 0; i < farCount; i++) {
    const a = rng() * TAU;
    const r = inner + (outer - inner) * Math.pow(rand(rng, 0.12, 0.85), 0.7);
    const x = sampler.centre.x + Math.cos(a) * r;
    const z = sampler.centre.z + Math.sin(a) * r;
    const y = groundFar(x, z);
    if (y < seaY + 2) continue;
    const far = clamp01((r - inner) / (outer - inner));
    tint.setRGB(1, 1, 1).lerp(HAZE, far * 0.5);
    if (rng() < 0.25) {
      addRelief(kMesa, x, y - 2, z, rand(rng, 30, 78), rand(rng, 26, 70), tint);
    } else {
      addRelief(kHill, x, y - 4, z, rand(rng, 60, 190), rand(rng, 30, 130), tint);
    }
  }

  // --- hero silhouettes ----------------------------------------------------
  // Spread around the compass so no scenic pose looks at bare horizon. Angles
  // are offset from the bay so the castle never ends up in the water.
  const heroAngle = (offset: number) => bayAngle + Math.PI + offset;

  const placeHero = (
    geo: THREE.BufferGeometry,
    material: THREE.Material,
    angle: number,
    dist: number,
    scale: number,
    name: string,
  ): THREE.Group => {
    const g = new THREE.Group();
    g.name = name;
    const x = sampler.centre.x + Math.cos(angle) * dist;
    const z = sampler.centre.z + Math.sin(angle) * dist;
    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = true;
    g.add(mesh);
    g.position.set(x, groundFar(x, z) - 2, z);
    g.rotation.y = rand(rng, 0, TAU);
    g.scale.setScalar(scale);
    root.add(g);
    return g;
  };

  const castleGeo = res.geo(castleGeometry(b.rng("landmarks/castle")));
  // The castle sits on its own knoll so it is not a wall standing in a field.
  const castleAngle = heroAngle(rand(rng, -0.5, 0.5));
  const castleDist = sampler.farRadius(rand(rng, 320, 460));
  const castleGroup = placeHero(castleGeo, mats.painted, castleAngle, castleDist, 1.5, "scenery/castle");
  addRelief(
    kHill,
    castleGroup.position.x,
    castleGroup.position.y - 26,
    castleGroup.position.z,
    150,
    46,
    tint.setRGB(0.92, 0.98, 0.9),
  );

  const mill = windmillParts();
  res.geo(mill.tower);
  res.geo(mill.sails);
  const millGroup = placeHero(mill.tower, mats.painted, heroAngle(rand(rng, 1.7, 2.3)), sampler.farRadius(rand(rng, 180, 260)), 1.6, "scenery/windmill");
  const sails = new THREE.Mesh(mill.sails, mats.painted);
  sails.position.set(0, 17.6, -3.6);
  millGroup.add(sails);

  const cabins = 22;
  const ferris = ferrisParts(cabins);
  res.geo(ferris.base);
  res.geo(ferris.wheel);
  res.geo(ferris.cabin);
  const ferrisGroup = placeHero(ferris.base, mats.painted, heroAngle(rand(rng, -2.3, -1.7)), sampler.farRadius(rand(rng, 220, 300)), 1.7, "scenery/ferris");
  const wheelPivot = new THREE.Group();
  wheelPivot.position.y = ferris.hubY;
  ferrisGroup.add(wheelPivot);
  const wheelMesh = new THREE.Mesh(ferris.wheel, mats.painted);
  wheelPivot.add(wheelMesh);
  // Gondolas hang from the rim but must stay level, so they cannot be children
  // of the pivot. One InstancedMesh, twenty-two matrices a frame.
  const gondolas = new THREE.InstancedMesh(ferris.cabin, mats.painted, cabins);
  gondolas.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  gondolas.frustumCulled = false;
  ferrisGroup.add(gondolas);

  const lighthouseGeo = res.geo(lighthouseGeometry());
  // On the headland: at the edge of the bay, where a lighthouse belongs.
  const lhAngle = bayAngle + bayWidth * 0.85;
  const lhDist = sampler.farRadius(rand(rng, 420, 560));
  placeHero(lighthouseGeo, mats.painted, lhAngle, lhDist, 1.5, "scenery/lighthouse");

  // --- per-frame -----------------------------------------------------------
  const gm = new THREE.Matrix4();
  const gp = new THREE.Vector3();
  const gq = new THREE.Quaternion();
  const gs = new THREE.Vector3(1, 1, 1);
  let wheelAngle = 0;
  let sailAngle = 0;

  return {
    update(dt, elapsed) {
      // A big wheel turns once every couple of minutes; anything faster reads
      // as a fairground ride on fast-forward and breaks the sense of distance.
      wheelAngle += dt * 0.055;
      wheelPivot.rotation.z = wheelAngle;
      // The sails catch the same gust the trees do, so the world breathes as
      // one thing rather than as a set of independently animated props.
      sailAngle += dt * (0.42 + Math.sin(elapsed * 0.13) * 0.16);
      sails.rotation.z = sailAngle;

      for (let i = 0; i < cabins; i++) {
        const a = (i / cabins) * TAU + wheelAngle;
        gp.set(Math.cos(a) * ferris.radius, ferris.hubY + Math.sin(a) * ferris.radius, 0);
        // Level, with a lazy swing lagging the rim — the detail that makes the
        // wheel look like it is carrying weight.
        gq.setFromAxisAngle(FORWARD, Math.sin(a + 1.2) * 0.06);
        gm.compose(gp, gq, gs);
        gondolas.setMatrixAt(i, gm);
      }
      gondolas.instanceMatrix.needsUpdate = true;
    },
  };
}

const FORWARD = new THREE.Vector3(0, 0, 1);
