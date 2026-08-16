/**
 * The Dune Sea — the ground, defined once.
 *
 * `duneHeight(x, z)` is the only description of this terrain that exists.
 * The mesh is that function sampled on a grid; the board's physics is that
 * function sampled under the board; the shadow the sand casts on itself is
 * that function marched toward the sun. There is no heightmap texture, no
 * collider baked from the visual mesh, and no second copy of the noise in
 * GLSL that has to be kept in step with this one.
 *
 * That last point is the whole reason it lives in TypeScript rather than in
 * the vertex shader where it would be faster. A dune field whose shader and
 * whose collider disagree by half a metre is a world where you ride along
 * six inches inside the sand, or six inches above it, and every fix makes
 * one of the two worse. Sampling one function twice cannot drift.
 *
 * The shape is a barchan field on a tilted plane: ridges perpendicular to
 * the prevailing wind, a long windward slope and a sharp lee face, laid
 * over a bowl that falls away toward the oasis at the origin. The tilt is
 * the level design — everywhere is downhill toward the place you are
 * trying to reach, so a player who does nothing but point downhill is
 * playing correctly.
 */

/** Where the world ends. Beyond this the sand climbs into an impassable rim. */
export const DUNE_RADIUS = 900;
/** The oasis sits at the origin, at the bottom of the bowl. */
export const OASIS_RADIUS = 46;

// ---------------------------------------------------------------------------
// Noise. Deliberately the same value-noise recipe the rest of the repo uses,
// so the dunes and the aurora are recognisably built by the same hand.
// ---------------------------------------------------------------------------

function hash21(x: number, y: number): number {
  let px = x * 123.34;
  let py = y * 456.21;
  px -= Math.floor(px);
  py -= Math.floor(py);
  const d = px * (px + 34.345) + py * (py + 34.345);
  px += d;
  py += d;
  const v = px * py;
  return v - Math.floor(v);
}

function noise2(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  // Quintic fade — the same one the aurora uses, and for the same reason:
  // cubic leaves grid creases visible at low frequencies, and a dune field
  // is nothing but low frequencies.
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash21(ix, iy);
  const b = hash21(ix + 1, iy);
  const c = hash21(ix, iy + 1);
  const d = hash21(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x: number, y: number, octaves: number): number {
  let v = 0;
  let a = 0.5;
  let px = x;
  let py = y;
  for (let i = 0; i < octaves; i++) {
    v += a * noise2(px, py);
    // Rotate between octaves so the lattice never lines up with itself.
    const nx = 0.8 * px + 0.6 * py;
    const ny = -0.6 * px + 0.8 * py;
    px = nx * 2.02;
    py = ny * 2.02;
    a *= 0.5;
  }
  return v;
}

// ---------------------------------------------------------------------------
// The dunes
// ---------------------------------------------------------------------------

/** Wind direction, as a unit vector in XZ. Dune crests run across it. */
const WIND_X = 0.87;
const WIND_Z = 0.49;

/**
 * The asymmetry that makes sand look like sand.
 *
 * A dune is not a sine wave. The wind drags grains up a long shallow face
 * and drops them over a short steep one, so the profile is a sawtooth with
 * a rounded top. `p` in 0..1 across one ridge returns the height of that
 * profile: a slow rise to 1 at 0.72, then a fast fall.
 */
function ridgeProfile(p: number): number {
  const t = p - Math.floor(p);
  const CREST = 0.72;
  if (t < CREST) {
    const u = t / CREST;
    // Smooth, slightly convex windward face.
    return u * u * (3 - 2 * u);
  }
  const u = (t - CREST) / (1 - CREST);
  // Slip face: steeper, and concave, because that is what a collapsing
  // pile of sand settles into.
  return 1 - u * u * (3 - 2 * u) * 0.98 - u * 0.02;
}

/** Ground height in metres at a world position. The whole terrain. */
export function duneHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);

  // The bowl. Everything falls toward the oasis, and climbs into a rim at
  // the edge of the world that is easier to respect than a wall.
  const bowl = Math.pow(r / DUNE_RADIUS, 1.7) * 210;
  const rim = Math.pow(Math.max(0, r - DUNE_RADIUS * 0.88) / (DUNE_RADIUS * 0.12), 2) * 260;

  // Dune ridges: the wind coordinate, warped by a slow noise so the crests
  // wander instead of running dead straight to the horizon.
  // 250 m between crests, not 80.
  //
  // The first pass used 80 m, which is a real barchan spacing and was also
  // completely invisible: the terrain mesh is radial, so out at 800 m its
  // vertices are 16 m apart along the ring, and three samples per dune
  // cannot describe a dune. The field rendered as a smooth bowl. Wavelength
  // is not just an art choice here — it has to clear the mesh that carries
  // it, and a dune sea reads better at this scale anyway.
  const along = (x * WIND_X + z * WIND_Z) * 0.0062;
  const across = (-x * WIND_Z + z * WIND_X) * 0.0062;
  const wander = fbm(across * 0.55, along * 0.22, 3) * 1.7;
  const crestHeight = 24 + fbm(across * 0.4 + 11.3, along * 0.3 - 4.1, 3) * 44;
  const dunes = ridgeProfile(along + wander) * crestHeight;

  // A second, much larger set of dunes so the field has a skyline.
  const bigAlong = along * 0.28;
  const big = ridgeProfile(bigAlong + fbm(across * 0.2, bigAlong * 0.4, 2) * 1.2) * 46;

  // Grain: the small stuff you feel through the board rather than see.
  const grain = fbm(x * 0.02, z * 0.02, 3) * 2.4;

  // The oasis is flat, and the dunes ease out of it rather than stopping.
  const flat = Math.min(1, Math.max(0, (r - OASIS_RADIUS) / 90));
  const soft = flat * flat * (3 - 2 * flat);

  return bowl + rim + (dunes + big + grain) * soft;
}

/**
 * Surface normal, from finite differences of the same function.
 *
 * `eps` is a metre by default: small enough to follow a dune, wide enough
 * that the board is not thrown by the grain noise. The renderer asks for a
 * much smaller one, because the eye does want the grain.
 */
export function duneNormal(x: number, z: number, eps = 1, out = { x: 0, y: 1, z: 0 }) {
  const hL = duneHeight(x - eps, z);
  const hR = duneHeight(x + eps, z);
  const hD = duneHeight(x, z - eps);
  const hU = duneHeight(x, z + eps);
  const nx = hL - hR;
  const nz = hD - hU;
  const ny = 2 * eps;
  const len = Math.hypot(nx, ny, nz) || 1;
  out.x = nx / len;
  out.y = ny / len;
  out.z = nz / len;
  return out;
}

/**
 * How much of the sun this point can see, 0..1.
 *
 * Marched along the sun direction through the same height function — so a
 * dune crest genuinely shadows its own lee face, and the shadow moves as
 * the sun goes down. At a low sun this is most of what the picture is:
 * without it, sunset dunes read as an orange carpet.
 *
 * Baked into a vertex attribute at build time and refreshed as the sun
 * drops, because doing it per pixel would mean a second copy of the height
 * function in GLSL — the one thing this module exists to avoid.
 */
export function sunVisibility(
  x: number,
  z: number,
  sunX: number,
  sunY: number,
  sunZ: number,
): number {
  const h0 = duneHeight(x, z) + 0.3;
  let shadow = 0;
  // Long steps: a shadow at sunset is hundreds of metres, and the terrain
  // between here and the crest that casts it is smooth at that scale.
  for (let i = 1; i <= 8; i++) {
    const t = i * i * 3.5;
    const hx = x + sunX * t;
    const hz = z + sunZ * t;
    const ray = h0 + sunY * t;
    const ground = duneHeight(hx, hz);
    if (ground > ray) {
      // Soften with distance so the shadow edge is not a razor.
      shadow = Math.max(shadow, Math.min(1, (ground - ray) / 6) * (1 - i / 11));
    }
  }
  return 1 - shadow;
}
