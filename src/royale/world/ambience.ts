/**
 * DROP ZERO / SPLASH ROYALE — world life.
 *
 * The island was beautiful and *empty*: outside the match, nothing on it moved
 * that the player had not moved. That is the difference between a diorama and
 * a place, and it is a difference you feel before you can name it — a real
 * coast has gulls turning over it, a real lawn has something crossing it, and
 * real wind arrives rather than simply existing.
 *
 * Everything in this file is scenery in the strictest sense:
 *
 *   • Nothing here registers a collider, a damage target or an interaction.
 *   • Nothing here is in a raycast path — every object gets a no-op `raycast`
 *     so a stray scene-graph pick can't hit a butterfly and call it cover.
 *   • Nothing here reads input or writes to another system's state. The one
 *     thing it touches outside its own scene graph is the vegetation wind
 *     amplitude, and that is a *cosmetic* uniform, done in `lateUpdate`, on a
 *     handle found by name and skipped entirely if it isn't there.
 *
 * ## What is in here
 *
 *   BIRDS      one instanced mesh, three behaviours — gulls wheeling over the
 *              coast (and occasionally diving, which is where the splash rings
 *              come from), songbird flocks crossing the treeline, and birds
 *              that startle up out of the grass when somebody sprints past.
 *   INSECTS    butterflies over grass; midge columns near the water at low sun.
 *   WIND       gusts as *events*. A front crosses the neighbourhood, lifts
 *              leaves and dust as it goes, shoves the beach ball, and swells
 *              the vegetation a beat after it has passed you.
 *   WATER LIFE fish shoals in the shallows, expanding rings on the surface.
 *   DRIFT      leaves tumbling, litter turning in an eddy, a beach ball.
 *   SOUND      gull calls and songbird calls as positional one-shots. The
 *              *beds* (surf, cicadas, birdsong, forest) are already driven by
 *              the ambience director in `audio/audio.ts`, which knows where the
 *              shoreline is and how far through dusk we are — an `ambience()`
 *              request from here would be a floor under that and would jam the
 *              dusk crossfade open. So this file deliberately plays one-shots
 *              only. See the note above `scheduleCalls`.
 *
 * ## Cost
 *
 * Nine objects, one draw call each — birds, butterflies, midges, motes, drift,
 * fish, rings and the beach ball — and the ball again in each shadow cascade.
 * Measured back to back on `high` by toggling `root.visible`: 647 draw calls
 * without, 660 with, so **13**, of which four are that one ball in the shadow
 * map. Budget was 30.
 *
 * Every group is a fixed-size pool: instances are never allocated at runtime,
 * only recycled, and anything that wanders out of its LOD radius is re-seeded
 * near the camera rather than drawn at a distance nobody can resolve.
 *
 * ## Two rules this file was written around
 *
 *  - **Time comes from `dt`, never the wall clock.** Under the capture harness
 *    the simulation runs a few hundred times slower than real time, so
 *    anything scheduled off `Date.now()` fires once and never again.
 *  - **At-rest states are visible.** Screenshots are taken with animations
 *    disabled and only a handful of frames elapse, so nothing here fades in
 *    from alpha 0 — every pool is seeded *already alive and mid-life* at boot,
 *    and the LOD fades are the only alpha ramps in the file.
 */
import * as THREE from "three";
import type { QualityTier, SkyService, System, TerrainService, WorldCtx } from "../types";

const TWO_PI = Math.PI * 2;

/**
 * Population per quality tier. `low` is a phone: it keeps one of everything so
 * the island still reads as inhabited, and pays for none of the density.
 */
interface Tier {
  gulls: number;
  /** Songbirds, split across `flocks` formations. */
  flockBirds: number;
  flocks: number;
  /** Reserved pool slots that only ever hold startled birds. */
  startle: number;
  butterflies: number;
  midgeColumns: number;
  midgesPer: number;
  motes: number;
  drift: number;
  fish: number;
  shoals: number;
  rings: number;
  ball: boolean;
}

const TIERS: Record<QualityTier, Tier> = {
  low:    { gulls:  8, flockBirds: 10, flocks: 1, startle:  6, butterflies:  8, midgeColumns: 2, midgesPer: 34, motes: 130, drift:  40, fish: 14, shoals: 2, rings:  8, ball: false },
  medium: { gulls: 14, flockBirds: 18, flocks: 2, startle:  8, butterflies: 16, midgeColumns: 3, midgesPer: 48, motes: 230, drift:  75, fish: 22, shoals: 3, rings: 12, ball: true },
  high:   { gulls: 20, flockBirds: 26, flocks: 3, startle: 10, butterflies: 24, midgeColumns: 4, midgesPer: 62, motes: 340, drift: 110, fish: 32, shoals: 4, rings: 16, ball: true },
  ultra:  { gulls: 26, flockBirds: 34, flocks: 3, startle: 12, butterflies: 32, midgeColumns: 5, midgesPer: 80, motes: 460, drift: 150, fish: 42, shoals: 5, rings: 20, ball: true },
};

/** LOD radii, metres. Past these a thing is re-seeded rather than drawn. */
const R_GULL = 620;      // gulls read as specks a long way out and are worth it
const R_FLOCK = 420;
const R_BUTTERFLY = 55;  // a butterfly is 4 cm of wing; past this it is a pixel
const R_MIDGE = 90;
const R_MOTE = 42;
const R_DRIFT = 130;
const R_FISH = 210;
/**
 * Nothing on the water surface is drawn closer than this.
 *
 * The sea here is an opaque Gerstner surface with about 2.2 m of total swell
 * and it writes depth, so a fish shadow sitting 4 cm above nominal sea level —
 * which is where this started — spends its whole life inside the water and is
 * never rasterised at all. There is no way to sample that displacement from
 * JS without copying `water.ts`'s wave table, which is not this file's to own.
 *
 * So surface life rides at `WATER_LIFT` above the still-water line and is
 * simply never shown close enough for the offset to read: at 30 m and eye
 * height that is a two-degree error against a surface that is itself moving.
 * The one visible consequence is honest — when a crest rises past it, the
 * depth test hides it, and a fish disappearing under a wave is what fish do.
 */
const R_SURFACE_NEAR = 55;
/**
 * 2.4 m clears the sea's whole 2.2 m of swell. 0.9 m did not, and the result
 * was fish that the frustum test swore were on screen and that no crop of any
 * frame ever contained: they were inside the crests more often than not, and
 * an intermittently-visible fish reads as no fish at all.
 */
const WATER_LIFT = 2.4;
const R_BALL = 280;

/** Shoal cruise speed, m/s. Fish in shallows drift; they do not commute. */
const SHOAL_SPEED = 1.4;

/**
 * Terrain probes each group may spend re-seeding in one frame.
 *
 * This started as one budget for the whole system and that was a bug with a
 * very convincing disguise: the groups run in a fixed order, the early ones
 * (butterflies, motes, drift) spend the lot on a frame where the camera has
 * moved, and fish, splash rings and the beach ball — which are last — got a
 * hard zero *every* frame and never found a home. The census read `live: 0`
 * for three groups on a beach with the sea in shot, which looks exactly like
 * a broken effect and was a starved accountant.
 */
const PROBE_BUDGET = 44;

/**
 * The island's prevailing wind, matching `vegetation.ts`'s `uWind` default
 * (0.86, 0.51) so gusts, leaves and the canopy all agree about which way the
 * weather is going. Normalised.
 */
const WIND_DIR = new THREE.Vector2(0.86, 0.51).normalize();

// =========================================================================
// Shader patches
// =========================================================================

/**
 * Two tiny vertex/fragment additions shared by every instanced group here:
 *
 *   aWing  (vec3: phase, rate, amplitude) — folds the wings. The trick is that
 *          `abs(position.x)` is already the distance out along the wing, so a
 *          single line gives a hinged flap that graduates to the tip and
 *          leaves the body alone, with no extra attribute and no bones.
 *   aAlpha (float) — per-instance opacity, which `InstancedMesh` has no other
 *          way of expressing. It is what lets a leaf fade out at its LOD edge
 *          and a splash ring fade as it spreads.
 */
interface PatchOpts {
  flap?: boolean;
  alpha?: boolean;
}

function patchInstanced(
  mat: THREE.Material,
  key: string,
  uTime: { value: number },
  opts: PatchOpts,
): void {
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAmbTime = uTime;
    let vDecl = "uniform float uAmbTime;\n";
    let vBody = "";
    let fDecl = "";
    let fBody = "";
    if (opts.flap) {
      vDecl += "attribute vec3 aWing;\n";
      vBody += `
        float ambFlap = aWing.z * sin( uAmbTime * aWing.y + aWing.x );
        transformed.y += abs( position.x ) * ambFlap;`;
    }
    if (opts.alpha) {
      vDecl += "attribute float aAlpha;\nvarying float vAmbAlpha;\n";
      vBody += "\n        vAmbAlpha = aAlpha;";
      fDecl += "varying float vAmbAlpha;\n";
      fBody += "\n        diffuseColor.a *= vAmbAlpha;";
    }
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${vDecl}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>${vBody}`);
    if (opts.alpha) {
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${fDecl}`)
        .replace("#include <color_fragment>", `#include <color_fragment>${fBody}`);
    }
  };
}

// =========================================================================
// Procedural textures
// =========================================================================

/** A soft round dot, for point sprites. */
function dotTexture(): THREE.CanvasTexture {
  const s = 32;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A soft annulus — the ring a splash leaves on flat water. */
function ringTexture(): THREE.CanvasTexture {
  const s = 128;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  // Hollow middle, a bright crest just inside the edge, feathered out. The
  // crest sits at 0.82 rather than 1.0 so the ring never clips its own quad.
  grad.addColorStop(0.0, "rgba(255,255,255,0)");
  grad.addColorStop(0.62, "rgba(255,255,255,0)");
  grad.addColorStop(0.78, "rgba(255,255,255,0.30)");
  grad.addColorStop(0.86, "rgba(255,255,255,0.95)");
  grad.addColorStop(0.94, "rgba(255,255,255,0.22)");
  grad.addColorStop(1.0, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Beach-ball wedges. Six panels, the classic playground colours. */
function ballTexture(): THREE.CanvasTexture {
  const w = 192;
  const h = 96;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f6f4ee";
  g.fillRect(0, 0, w, h);
  const cols = ["#e8443c", "#f6f4ee", "#2f8fd8", "#f6f4ee", "#f2c53d", "#f6f4ee"];
  const panel = w / cols.length;
  for (let i = 0; i < cols.length; i++) {
    g.fillStyle = cols[i];
    // Lens-shaped panels: full width at the equator, pinched at the poles, so
    // the seams meet at the top and bottom instead of running off the edge.
    g.beginPath();
    for (let k = 0; k <= 16; k++) {
      const v = k / 16;
      const bulge = Math.sin(v * Math.PI);
      g.lineTo(i * panel + panel * 0.5 - (panel * 0.5) * bulge, v * h);
    }
    for (let k = 16; k >= 0; k--) {
      const v = k / 16;
      const bulge = Math.sin(v * Math.PI);
      g.lineTo(i * panel + panel * 0.5 + (panel * 0.5) * bulge, v * h);
    }
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

// =========================================================================
// Geometry
// =========================================================================

/**
 * A bird, nose along +Z, wings along ±X, flat enough to read as a silhouette
 * from any angle. 12 triangles. The wings are swept back and rise toward the
 * tip because a straight wing reads as a paper plane.
 */
function birdGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    pos.push(x, y, z);
    return pos.length / 3 - 1;
  };
  const tri = (a: number, b: number, c: number) => idx.push(a, b, c);

  // Body: a slim wedge with a pointed nose and a forked tail.
  const nose = push(0, 0, 0.62);
  const bl = push(-0.075, 0.015, 0.05);
  const br = push(0.075, 0.015, 0.05);
  const tail = push(0, 0, -0.58);
  const tl = push(-0.13, 0, -0.66);
  const trr = push(0.13, 0, -0.66);
  tri(nose, bl, br);
  tri(bl, tail, br);
  tri(tail, tl, trr);

  // Wings. `s` is the side; the flap in the shader keys off |x|, so the two
  // sides fold together with no per-side bookkeeping.
  for (const s of [-1, 1]) {
    const w0 = push(s * 0.055, 0.012, 0.20);   // leading root
    const w1 = push(s * 0.055, 0.012, -0.16);  // trailing root
    const w2 = push(s * 0.52, 0.035, 0.05);    // leading mid (swept back)
    const w3 = push(s * 0.50, 0.035, -0.26);   // trailing mid
    const w4 = push(s * 0.99, 0.085, -0.10);   // leading tip
    const w5 = push(s * 0.93, 0.085, -0.30);   // trailing tip
    tri(w0, w2, w1);
    tri(w1, w2, w3);
    tri(w2, w4, w3);
    tri(w3, w4, w5);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Two wing panels, nose along +Z. Folds almost shut at full flap. */
function butterflyGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    pos.push(x, y, z);
    return pos.length / 3 - 1;
  };
  for (const s of [-1, 1]) {
    const root = push(s * 0.02, 0, 0);
    const fwd = push(s * 0.42, 0, 0.34);   // forewing tip
    const out = push(s * 0.50, 0, -0.02);
    const aft = push(s * 0.34, 0, -0.36);  // hindwing tip
    idx.push(root, fwd, out, root, out, aft);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A fish seen from directly above: a lens with a forked tail, lying in the XZ
 * plane, nose along +Z. Drawn as a dark shape *over* the water surface rather
 * than under it — the sea in this world is an opaque shader that synthesises
 * its own seabed, so anything placed below it is simply never rasterised.
 * A dark, low-alpha shape sitting a couple of centimetres proud of the surface
 * is what actually reads as "something is down there".
 */
function fishGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const push = (x: number, z: number): number => {
    pos.push(x, 0, z);
    return pos.length / 3 - 1;
  };
  const nose = push(0, 0.5);
  const mid = push(0, 0.0);
  const l1 = push(-0.13, 0.16);
  const r1 = push(0.13, 0.16);
  const l2 = push(-0.10, -0.18);
  const r2 = push(0.10, -0.18);
  const waist = push(0, -0.34);
  const tl = push(-0.17, -0.5);
  const tr = push(0.17, -0.5);
  idx.push(nose, l1, mid, nose, mid, r1);
  idx.push(mid, l1, l2, mid, l2, waist, mid, waist, r2, mid, r2, r1);
  idx.push(waist, tl, tr);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A flat unit quad lying in the XZ plane. Leaves, litter, rings. */
function flatQuad(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}

// =========================================================================
// Pool records
// =========================================================================

type BirdKind = 0 | 1 | 2; // gull | flock | startled

interface Bird {
  kind: BirdKind;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Wander/orbit anchor. Gulls circle it; startled birds flee from it. */
  anchor: THREE.Vector3;
  /** Orbit radius and angle, gulls only. */
  orbit: number;
  angle: number;
  spin: number;
  /** Which flock (index) this bird belongs to; -1 otherwise. */
  flock: number;
  /** Slot inside its flock, so formation offsets are stable. */
  slot: number;
  scale: number;
  phase: number;
  rate: number;
  amp: number;
  roll: number;
  /** Seconds of life left for a temporary state (dive, startle). 0 = none. */
  timer: number;
  /** 0 = level flight, 1 = committed dive. */
  dive: number;
  alive: boolean;
}

interface Flock {
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  speed: number;
  /** Metres travelled per second of `t` — cached span so t is 0..1. */
  span: number;
}

interface Drifter {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  spin: THREE.Vector3;
  size: number;
  /** 0 = leaf (settles), 1 = litter (circles an eddy). */
  litter: number;
  eddy: THREE.Vector3;
  angle: number;
  grounded: number;
  alpha: number;
}

interface Fish {
  shoal: number;
  offset: THREE.Vector2;
  wiggle: number;
  /** Tail-beat rate, fixed at seed — see the note on Flutter. */
  rate: number;
  scale: number;
}

interface Shoal {
  center: THREE.Vector3;
  heading: number;
  turn: number;
  valid: boolean;
}

interface Ring {
  pos: THREE.Vector3;
  age: number;
  life: number;
  size: number;
}

// =========================================================================
// The system
// =========================================================================

export default function createAmbience(ctx: WorldCtx): System {
  const tier = TIERS[ctx.quality] ?? TIERS.high;
  const rng = ctx.rng;
  const rand = (a: number, b: number) => a + rng() * (b - a);

  const root = new THREE.Group();
  root.name = "dz:ambience";
  // Ambient life is never a raycast target, never a shadow caster (except the
  // ball, which needs one to sit on the sand) and never frustum-culled by its
  // own bounds, because every instance moves independently of the mesh origin.
  ctx.scene.add(root);

  const noRaycast = () => {};
  const disposables: Array<{ dispose(): void }> = [];
  const uTime = { value: 0 };

  const terrain = (): TerrainService | undefined => ctx.services.terrain;
  const sky = (): SkyService | undefined => ctx.services.sky;

  /** Terrain probes spent by the group currently re-seeding. */
  let probes = 0;
  /** Reset before each group, so no group can starve the ones after it. */
  const openBudget = (): void => {
    probes = 0;
  };
  const groundAt = (x: number, z: number): number => {
    const t = terrain();
    if (!t) return 0;
    // Deliberately NOT budgeted: `heightAt` is a bilinear tap on a baked
    // lattice and this world already takes tens of thousands of them a frame.
    // What needs rationing is rejection *sampling* — the searches below, which
    // can reject dozens of candidates before they find a beach.
    return t.heightAt(x, z);
  };

  // ---------------------------------------------------------------- birds

  const birdCount = tier.gulls + tier.flockBirds + tier.startle;
  const birdGeom = birdGeometry();
  const birdWing = new Float32Array(birdCount * 3);
  const birdAlpha = new Float32Array(birdCount);
  birdGeom.setAttribute("aWing", new THREE.InstancedBufferAttribute(birdWing, 3));
  birdGeom.setAttribute("aAlpha", new THREE.InstancedBufferAttribute(birdAlpha, 1));
  const birdMat = new THREE.MeshLambertMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    // Birds are drawn against sky more often than against anything else, and
    // a bird that writes depth over a cloud layer punches a hole in it.
    depthWrite: false,
  });
  patchInstanced(birdMat, "dz-amb-bird", uTime, { flap: true, alpha: true });
  const birds = new THREE.InstancedMesh(birdGeom, birdMat, birdCount);
  birds.frustumCulled = false;
  birds.castShadow = false;
  birds.receiveShadow = false;
  birds.raycast = noRaycast;
  birds.name = "dz:ambience.birds";
  root.add(birds);
  disposables.push(birdGeom, birdMat);

  const flock: Flock[] = [];
  const birdPool: Bird[] = [];

  // ------------------------------------------------------------ butterflies

  const flutterGeom = butterflyGeometry();
  const flutterWing = new Float32Array(tier.butterflies * 3);
  const flutterAlpha = new Float32Array(tier.butterflies);
  flutterGeom.setAttribute("aWing", new THREE.InstancedBufferAttribute(flutterWing, 3));
  flutterGeom.setAttribute("aAlpha", new THREE.InstancedBufferAttribute(flutterAlpha, 1));
  const flutterMat = new THREE.MeshLambertMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    // Wings are thin membranes lit from behind as often as in front.
    emissive: new THREE.Color(0x1a1408),
  });
  patchInstanced(flutterMat, "dz-amb-flutter", uTime, { flap: true, alpha: true });
  const butterflies = new THREE.InstancedMesh(flutterGeom, flutterMat, tier.butterflies);
  butterflies.frustumCulled = false;
  butterflies.castShadow = false;
  butterflies.raycast = noRaycast;
  butterflies.name = "dz:ambience.butterflies";
  root.add(butterflies);
  disposables.push(flutterGeom, flutterMat);

  interface Flutter {
    pos: THREE.Vector3;
    target: THREE.Vector3;
    yaw: number;
    bob: number;
    /** Wing-beat rate and body size, fixed at seed. Re-rolling either every
     *  frame is a flicker, not a variation. */
    bobRate: number;
    scale: number;
    alpha: number;
  }
  const flutters: Flutter[] = [];

  // ---------------------------------------------------------------- points

  const dotTex = dotTexture();
  disposables.push(dotTex);

  const midgeCount = tier.midgeColumns * tier.midgesPer;
  const midgePos = new Float32Array(midgeCount * 3);
  const midgeGeom = new THREE.BufferGeometry();
  midgeGeom.setAttribute("position", new THREE.BufferAttribute(midgePos, 3));
  const midgeMat = new THREE.PointsMaterial({
    map: dotTex,
    // Midges are only ever visible because they are catching a low sun, so
    // they are additive: they add light, they never occlude anything.
    blending: THREE.AdditiveBlending,
    color: new THREE.Color(0xffe6bd),
    size: 0.135,
    sizeAttenuation: true,
    transparent: true,
    depthWrite: false,
    opacity: 0.6,
  });
  const midges = new THREE.Points(midgeGeom, midgeMat);
  midges.frustumCulled = false;
  midges.raycast = noRaycast;
  midges.name = "dz:ambience.midges";
  root.add(midges);
  disposables.push(midgeGeom, midgeMat);

  interface Column {
    center: THREE.Vector3;
    valid: boolean;
  }
  const columns: Column[] = [];
  /** Per-midge orbit parameters — radius, height offset, speed, phase. */
  const midgeParam = new Float32Array(midgeCount * 4);

  const motePos = new Float32Array(tier.motes * 3);
  const moteVel = new Float32Array(tier.motes * 3);
  const moteGeom = new THREE.BufferGeometry();
  moteGeom.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  const moteMat = new THREE.PointsMaterial({
    map: dotTex,
    blending: THREE.AdditiveBlending,
    color: new THREE.Color(0xfff0cc),
    size: 0.075,
    sizeAttenuation: true,
    transparent: true,
    depthWrite: false,
    opacity: 0.5,
  });
  const motes = new THREE.Points(moteGeom, moteMat);
  motes.frustumCulled = false;
  motes.raycast = noRaycast;
  motes.name = "dz:ambience.motes";
  root.add(motes);
  disposables.push(moteGeom, moteMat);

  // ---------------------------------------------------------------- drift

  const driftGeom = flatQuad();
  const driftAlpha = new Float32Array(tier.drift);
  driftGeom.setAttribute("aAlpha", new THREE.InstancedBufferAttribute(driftAlpha, 1));
  const driftMat = new THREE.MeshLambertMaterial({
    side: THREE.DoubleSide,
    transparent: true,
  });
  patchInstanced(driftMat, "dz-amb-drift", uTime, { alpha: true });
  const drifts = new THREE.InstancedMesh(driftGeom, driftMat, tier.drift);
  drifts.frustumCulled = false;
  drifts.castShadow = false;
  drifts.raycast = noRaycast;
  drifts.name = "dz:ambience.drift";
  root.add(drifts);
  disposables.push(driftGeom, driftMat);
  const drifters: Drifter[] = [];

  // ---------------------------------------------------------------- fish

  const fishGeom = fishGeometry();
  const fishAlpha = new Float32Array(tier.fish);
  fishGeom.setAttribute("aAlpha", new THREE.InstancedBufferAttribute(fishAlpha, 1));
  const fishMat = new THREE.MeshLambertMaterial({
    color: 0x0a2420,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
  });
  patchInstanced(fishMat, "dz-amb-fish", uTime, { alpha: true });
  const fishes = new THREE.InstancedMesh(fishGeom, fishMat, tier.fish);
  fishes.frustumCulled = false;
  fishes.castShadow = false;
  fishes.raycast = noRaycast;
  // After the sea, which is opaque and writes depth at renderOrder 1.
  fishes.renderOrder = 2;
  fishes.name = "dz:ambience.fish";
  root.add(fishes);
  disposables.push(fishGeom, fishMat);
  const fishPool: Fish[] = [];
  const shoals: Shoal[] = [];

  // ---------------------------------------------------------------- rings

  const ringTex = ringTexture();
  const ringGeom = flatQuad();
  const ringAlpha = new Float32Array(tier.rings);
  ringGeom.setAttribute("aAlpha", new THREE.InstancedBufferAttribute(ringAlpha, 1));
  const ringMat = new THREE.MeshLambertMaterial({
    map: ringTex,
    color: 0xdff2ff,
    emissive: new THREE.Color(0x2a3c46),
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
  });
  patchInstanced(ringMat, "dz-amb-ring", uTime, { alpha: true });
  const rings = new THREE.InstancedMesh(ringGeom, ringMat, tier.rings);
  rings.frustumCulled = false;
  rings.castShadow = false;
  rings.raycast = noRaycast;
  rings.renderOrder = 2;
  rings.name = "dz:ambience.rings";
  root.add(rings);
  disposables.push(ringGeom, ringMat, ringTex);
  const ringPool: Ring[] = [];

  // ---------------------------------------------------------------- ball

  let ball: THREE.Mesh | null = null;
  const ballState = {
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    valid: false,
    /** Accumulated roll, so the ball turns with the ground it covers. */
    spin: new THREE.Quaternion(),
  };
  if (tier.ball) {
    const ballTex = ballTexture();
    const ballGeom = new THREE.SphereGeometry(0.3, 18, 12);
    const ballMat = new THREE.MeshStandardMaterial({
      map: ballTex,
      roughness: 0.42,
      metalness: 0,
    });
    ball = new THREE.Mesh(ballGeom, ballMat);
    ball.castShadow = true;
    ball.receiveShadow = false;
    ball.raycast = noRaycast;
    ball.name = "dz:ambience.ball";
    root.add(ball);
    disposables.push(ballGeom, ballMat, ballTex);
  }

  // =======================================================================
  // Placement helpers
  // =======================================================================

  const camPos = new THREE.Vector3();

  /**
   * Find a point near (cx, cz) that satisfies `ok`. Coarse rejection sampling
   * — a distance field would be better and is nowhere near worth it for
   * something that runs a handful of times a second.
   */
  function findNear(
    cx: number,
    cz: number,
    rMin: number,
    rMax: number,
    tries: number,
    ok: (x: number, z: number) => boolean,
    out: THREE.Vector3,
  ): boolean {
    for (let i = 0; i < tries; i++) {
      if (probes > PROBE_BUDGET) return false;
      const a = rng() * TWO_PI;
      const r = rMin + Math.sqrt(rng()) * (rMax - rMin);
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (ok(x, z)) {
        out.set(x, 0, z);
        return true;
      }
    }
    return false;
  }

  const isLand = (x: number, z: number): boolean => {
    const t = terrain();
    if (!t) return true;
    probes++;
    return !t.isWater(x, z);
  };

  /** Shallow water: deep enough to hide a fish, shallow enough to see one. */
  const isShallow = (x: number, z: number): boolean => {
    const t = terrain();
    if (!t) return false;
    probes++;
    if (!t.isWater(x, z)) return false;
    const d = t.seaLevel - t.heightAt(x, z);
    // Widened from 3.4 m because the band that shallow hugs the shore, and
    // the shore is inside `R_SURFACE_NEAR` from anybody standing on it.
    return d > 0.6 && d < 6;
  };

  const isSand = (x: number, z: number): boolean => {
    const t = terrain();
    if (!t) return false;
    probes++;
    if (t.isWater(x, z)) return false;
    return t.materialAt(x, z) === "sand";
  };

  const isGrass = (x: number, z: number): boolean => {
    const t = terrain();
    if (!t) return false;
    probes++;
    if (t.isWater(x, z)) return false;
    const m = t.materialAt(x, z);
    return m === "grass" || m === "dirt";
  };

  // =======================================================================
  // Seeding
  // =======================================================================

  const scratch = new THREE.Vector3();

  function seedGull(b: Bird): void {
    // Gulls belong to the coast, so anchor them on the waterline and let them
    // orbit out over both the sea and the beach.
    // Anchored well inside the LOD radius: a gull orbiting at 500 m is two
    // pixels of nothing. The ones you notice are the ones at 100–300 m.
    if (!findNear(camPos.x, camPos.z, 70, 340, 10, (x, z) => !isLand(x, z), scratch)) {
      scratch.set(camPos.x + rand(-300, 300), 0, camPos.z + rand(-300, 300));
    }
    const sea = terrain()?.seaLevel ?? 0;
    b.kind = 0;
    b.anchor.set(scratch.x, sea + rand(24, 78), scratch.z);
    b.orbit = rand(38, 110);
    b.angle = rng() * TWO_PI;
    b.spin = (rng() < 0.5 ? -1 : 1) * rand(0.06, 0.16);
    // ~3.5–5 m of wingspan. A real gull is 1.4 m and reads as nothing at
    // 200 m; this world's proportions are exaggerated everywhere else too.
    b.scale = rand(1.8, 2.5);
    b.phase = rng() * TWO_PI;
    b.rate = rand(4.2, 6.0);
    b.amp = rand(0.16, 0.34);
    b.timer = 0;
    b.dive = 0;
    b.flock = -1;
    b.alive = true;
    b.pos.set(
      b.anchor.x + Math.cos(b.angle) * b.orbit,
      b.anchor.y,
      b.anchor.z + Math.sin(b.angle) * b.orbit,
    );
  }

  function seedFlockRoute(f: Flock): void {
    // A crossing that passes near the camera rather than one that happens to
    // be somewhere on a 3 km island: a flock you never see is not scenery.
    const a = rng() * TWO_PI;
    const half = rand(260, 420);
    const offset = rand(-140, 140);
    const nx = -Math.sin(a);
    const nz = Math.cos(a);
    f.from.set(
      camPos.x - Math.cos(a) * half + nx * offset,
      0,
      camPos.z - Math.sin(a) * half + nz * offset,
    );
    f.to.set(
      camPos.x + Math.cos(a) * half + nx * offset,
      0,
      camPos.z + Math.sin(a) * half + nz * offset,
    );
    f.span = f.from.distanceTo(f.to);
    f.speed = rand(9, 15);
    // Start part-way in, so at boot the flock is already mid-crossing rather
    // than waiting off-screen for its cue.
    f.t = rng() * 0.55;
  }

  function seedFlockBird(b: Bird, flockIdx: number, slot: number): void {
    b.kind = 1;
    b.flock = flockIdx;
    b.slot = slot;
    b.scale = rand(0.62, 0.85);
    b.phase = rng() * TWO_PI;
    b.rate = rand(9, 13);
    b.amp = rand(0.42, 0.68);
    b.orbit = rand(3, 13);
    b.angle = rng() * TWO_PI;
    b.spin = rand(0.5, 1.4);
    b.timer = 0;
    b.dive = 0;
    b.alive = true;
  }

  function seedFlutter(f: Flutter): void {
    if (!findNear(camPos.x, camPos.z, 4, R_BUTTERFLY * 0.85, 12, isGrass, scratch)) {
      f.alpha = 0;
      f.pos.set(camPos.x, -9999, camPos.z);
      return;
    }
    f.pos.set(scratch.x, groundAt(scratch.x, scratch.z) + rand(0.35, 1.6), scratch.z);
    f.target.copy(f.pos);
    f.yaw = rng() * TWO_PI;
    f.bob = rng() * TWO_PI;
    f.bobRate = rand(7, 11);
    f.scale = rand(0.10, 0.135);
    f.alpha = 1;
  }

  function seedColumn(c: Column): void {
    // Midges hang over still water at the edge of the light — the shoreline
    // is where you actually see them, so that is where they go.
    if (findNear(camPos.x, camPos.z, 8, R_MIDGE * 0.8, 14, (x, z) => {
      const t = terrain();
      if (!t) return false;
      probes++;
      const d = t.seaLevel - t.heightAt(x, z);
      return d > -1.2 && d < 1.6;
    }, scratch)) {
      const t = terrain();
      const base = t ? Math.max(t.seaLevel, t.heightAt(scratch.x, scratch.z)) : 0;
      c.center.set(scratch.x, base + rand(0.8, 2.2), scratch.z);
      c.valid = true;
    } else {
      c.valid = false;
    }
  }

  function seedMote(i: number): void {
    const a = rng() * TWO_PI;
    const r = Math.sqrt(rng()) * R_MOTE;
    const x = camPos.x + Math.cos(a) * r;
    const z = camPos.z + Math.sin(a) * r;
    motePos[i * 3] = x;
    motePos[i * 3 + 1] = groundAt(x, z) + rand(0.2, 7);
    motePos[i * 3 + 2] = z;
    moteVel[i * 3] = rand(-0.15, 0.15);
    moteVel[i * 3 + 1] = rand(-0.05, 0.12);
    moteVel[i * 3 + 2] = rand(-0.15, 0.15);
  }

  const LEAF_COLORS = [0x5c7a33, 0x8a9a3f, 0xb98c34, 0xa05f28, 0x6f8f45];
  const LITTER_COLORS = [0xf2f0e6, 0xe8574a, 0x4aa8e0, 0xf2c53d];

  function seedDrifter(d: Drifter, i: number): void {
    const litter = rng() < 0.14 ? 1 : 0;
    if (!findNear(camPos.x, camPos.z, 6, R_DRIFT * 0.8, 10, isLand, scratch)) {
      d.alpha = 0;
      d.pos.set(camPos.x, -9999, camPos.z);
      return;
    }
    const gy = groundAt(scratch.x, scratch.z);
    d.litter = litter;
    d.size = litter ? rand(0.16, 0.3) : rand(0.1, 0.24);
    d.pos.set(scratch.x, gy + rand(0.02, 3.2), scratch.z);
    d.vel.set(rand(-0.4, 0.4), 0, rand(-0.4, 0.4));
    d.rot.set(rng() * TWO_PI, rng() * TWO_PI, rng() * TWO_PI);
    d.spin.set(rand(-2, 2), rand(-2, 2), rand(-2, 2));
    d.eddy.set(scratch.x, gy, scratch.z);
    d.angle = rng() * TWO_PI;
    d.grounded = d.pos.y - gy < 0.06 ? 1 : 0;
    d.alpha = 1;
    const c = litter
      ? LITTER_COLORS[Math.floor(rng() * LITTER_COLORS.length)]
      : LEAF_COLORS[Math.floor(rng() * LEAF_COLORS.length)];
    drifts.setColorAt(i, tmpColor.setHex(c));
  }

  function seedShoal(s: Shoal): void {
    if (findNear(camPos.x, camPos.z, 20, R_FISH * 0.8, 16, isShallow, scratch)) {
      const sea = terrain()?.seaLevel ?? 0;
      s.center.set(scratch.x, sea + WATER_LIFT, scratch.z);
      s.heading = rng() * TWO_PI;
      s.turn = rand(-0.3, 0.3);
      s.valid = true;
    } else {
      s.valid = false;
    }
  }

  function seedBall(): void {
    if (!ball) return;
    if (findNear(camPos.x, camPos.z, 25, R_BALL * 0.7, 20, isSand, scratch)) {
      ballState.pos.set(scratch.x, groundAt(scratch.x, scratch.z) + 0.3, scratch.z);
      ballState.vel.set(rand(-0.6, 0.6), 0, rand(-0.6, 0.6));
      ballState.valid = true;
    } else {
      ballState.valid = false;
    }
  }

  const tmpColor = new THREE.Color();

  // ---- initial population -------------------------------------------------
  //
  // Seeded around the camera's boot position and re-seeded on the first frames
  // once the player has actually dropped. Everything comes up *already alive*:
  // nothing here has a birth animation, because a screenshot taken three
  // frames in would photograph the birth and call it empty.
  //
  // Each group opens its own probe budget here for the same reason the update
  // loop does: without it the butterflies alone spend the lot, and every group
  // seeded after them — midges, drift, shoals, the ball, and the splash rings
  // that are only ever placed here — comes up empty on frame one.
  camPos.copy(ctx.camera.position);

  openBudget();
  for (let i = 0; i < tier.flocks; i++) {
    const f: Flock = { from: new THREE.Vector3(), to: new THREE.Vector3(), t: 0, speed: 12, span: 1 };
    seedFlockRoute(f);
    flock.push(f);
  }

  for (let i = 0; i < birdCount; i++) {
    const b: Bird = {
      kind: 0,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(0, 0, 1),
      anchor: new THREE.Vector3(),
      orbit: 60,
      angle: 0,
      spin: 0.1,
      flock: -1,
      slot: 0,
      scale: 1,
      phase: 0,
      rate: 5,
      amp: 0.2,
      roll: 0,
      timer: 0,
      dive: 0,
      alive: false,
    };
    if (i < tier.gulls) {
      seedGull(b);
      // Read from below against a bright sky, so the underside is what the
      // player sees: mid-grey silhouettes, not white ones.
      birds.setColorAt(i, tmpColor.setHex(rng() < 0.35 ? 0x7d8896 : 0xa9b4c0));
    } else if (i < tier.gulls + tier.flockBirds) {
      const fi = (i - tier.gulls) % tier.flocks;
      seedFlockBird(b, fi, i - tier.gulls);
      birds.setColorAt(i, tmpColor.setHex(0x2b3138));
    } else {
      b.kind = 2;
      b.alive = false;
      b.scale = rand(0.5, 0.7);
      b.rate = rand(11, 16);
      b.amp = rand(0.5, 0.8);
      b.phase = rng() * TWO_PI;
      birds.setColorAt(i, tmpColor.setHex(0x3a3128));
    }
    birdPool.push(b);
  }
  if (birds.instanceColor) birds.instanceColor.needsUpdate = true;

  openBudget();
  for (let i = 0; i < tier.butterflies; i++) {
    const f: Flutter = {
      pos: new THREE.Vector3(),
      target: new THREE.Vector3(),
      yaw: 0,
      bob: 0,
      bobRate: 9,
      scale: 0.12,
      alpha: 0,
    };
    seedFlutter(f);
    flutters.push(f);
    const hue = rng();
    butterflies.setColorAt(
      i,
      tmpColor.setHex(hue < 0.4 ? 0xf5c93a : hue < 0.7 ? 0xe98b3a : hue < 0.88 ? 0xf2efe4 : 0x6fa8e0),
    );
  }
  if (butterflies.instanceColor) butterflies.instanceColor.needsUpdate = true;

  openBudget();
  for (let i = 0; i < tier.midgeColumns; i++) {
    const c: Column = { center: new THREE.Vector3(), valid: false };
    seedColumn(c);
    columns.push(c);
  }
  for (let i = 0; i < midgeCount; i++) {
    midgeParam[i * 4] = rand(0.25, 1.5);      // orbit radius
    midgeParam[i * 4 + 1] = rand(-0.7, 1.5);  // height offset
    midgeParam[i * 4 + 2] = rand(0.8, 3.4);   // angular speed
    midgeParam[i * 4 + 3] = rng() * TWO_PI;   // phase
  }

  openBudget();
  for (let i = 0; i < tier.motes; i++) seedMote(i);

  openBudget();
  for (let i = 0; i < tier.drift; i++) {
    const d: Drifter = {
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      rot: new THREE.Euler(),
      spin: new THREE.Vector3(),
      size: 0.2,
      litter: 0,
      eddy: new THREE.Vector3(),
      angle: 0,
      grounded: 0,
      alpha: 0,
    };
    seedDrifter(d, i);
    drifters.push(d);
  }
  if (drifts.instanceColor) drifts.instanceColor.needsUpdate = true;

  openBudget();
  for (let i = 0; i < tier.shoals; i++) {
    const s: Shoal = { center: new THREE.Vector3(), heading: 0, turn: 0, valid: false };
    seedShoal(s);
    shoals.push(s);
  }
  for (let i = 0; i < tier.fish; i++) {
    fishPool.push({
      shoal: i % Math.max(1, tier.shoals),
      offset: new THREE.Vector2(rand(-6, 6), rand(-6, 6)),
      wiggle: rng() * TWO_PI,
      rate: rand(5, 9),
      scale: rand(0.5, 1.15),
    });
  }

  openBudget();
  for (let i = 0; i < tier.rings; i++) {
    // A third of the pool starts mid-life so the first frame after boot
    // already has water moving in it — but only where there is water to move.
    // The first version of this set the age and left the position at the
    // parking spot below the world, so every one of them was hidden by the
    // "off-world" test on the very first update and the pool read as empty.
    const shoal = shoals.find((sh) => sh.valid);
    const live = i < Math.ceil(tier.rings / 3) && !!shoal;
    ringPool.push({
      pos: live && shoal
        ? new THREE.Vector3(shoal.center.x + rand(-14, 14), shoal.center.y, shoal.center.z + rand(-14, 14))
        : new THREE.Vector3(0, -9999, 0),
      age: live ? rand(0.2, 1.6) : 1e9,
      life: rand(2.4, 3.8),
      size: rand(1.2, 3.4),
    });
  }
  openBudget();
  seedBall();

  // =======================================================================
  // Wind gusts
  // =======================================================================

  /**
   * A gust is a *front*, not a level. It starts upwind of the camera, walks
   * downwind at a walking-pace-plus speed, lifts whatever it passes over, and
   * expires once it is clear. Because the front is always seeded relative to
   * the camera, the player is always somewhere in its path — a gust crossing
   * the far side of a 3 km island is a gust nobody experiences.
   */
  const gust = {
    active: false,
    /** Origin projected onto the wind axis; `s` is distance travelled from it. */
    ox: 0,
    oz: 0,
    s: 0,
    speed: 16,
    strength: 1,
    width: 90,
    /** Total run length before the front is retired. */
    run: 520,
  };
  /**
   * Simulated seconds until the next gust. The first one is almost immediate:
   * a player who lands and stands still for ten seconds should have felt the
   * weather do something, and the schedule below is slow enough afterwards
   * that a gust still reads as an event rather than as a texture.
   */
  let gustIn = 0.6;

  function startGust(): void {
    const back = 180;
    gust.ox = camPos.x - WIND_DIR.x * back;
    gust.oz = camPos.z - WIND_DIR.y * back;
    gust.s = 0;
    gust.speed = rand(12, 22);
    gust.strength = rand(0.65, 1.15);
    gust.width = rand(70, 130);
    gust.run = back + rand(240, 420);
    gust.active = true;
    // Published so the vegetation shader (or anything else) can adopt the same
    // front without this file reaching into it. Nothing consumes it yet; the
    // canopy is driven through the uniform handle below instead.
    ctx.emit("dz:gust", {
      x: gust.ox,
      z: gust.oz,
      dirX: WIND_DIR.x,
      dirZ: WIND_DIR.y,
      speed: gust.speed,
      strength: gust.strength,
      width: gust.width,
    });
  }

  /** How hard the front is blowing over an XZ point, 0..1. */
  function gustAt(x: number, z: number): number {
    if (!gust.active) return 0;
    const d = (x - gust.ox) * WIND_DIR.x + (z - gust.oz) * WIND_DIR.y;
    const f = 1 - Math.abs(d - gust.s) / gust.width;
    if (f <= 0) return 0;
    // Smoothstep, so the leading edge arrives rather than switches on.
    return f * f * (3 - 2 * f) * gust.strength;
  }

  // ---- the canopy handle --------------------------------------------------
  //
  // `vegetation.ts` owns the wind uniform and this file does not own that
  // file, so the coupling is done by finding its material by name and wrapping
  // the compile hook to capture the uniform object. Boot order guarantees the
  // program has not been linked yet (nothing renders until `engine.start()`,
  // which the page calls after every system is up), so the wrapper always
  // runs. If the name ever changes, `vegWind` stays null and the gust simply
  // stops moving the canopy — everything else here is unaffected.
  let vegWind: { value: THREE.Vector4 } | null = null;
  /** The amplitude vegetation itself wrote, before we scaled it. */
  let vegBase = 0.14;
  /** What we wrote last frame, to tell "vegetation updated" from "it didn't". */
  let vegLast = Number.NaN;

  function linkCanopy(): void {
    ctx.scene.traverse((o) => {
      if (vegWind) return;
      const mesh = o as THREE.Mesh;
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      const list = Array.isArray(mat) ? mat : [mat];
      for (const m of list) {
        if (m.name !== "dz.vegetation") continue;
        const prev = m.onBeforeCompile;
        m.onBeforeCompile = (shader, renderer) => {
          prev?.call(m, shader, renderer);
          const u = shader.uniforms.uWind as unknown as { value: THREE.Vector4 } | undefined;
          if (u && u.value instanceof THREE.Vector4) vegWind = u;
        };
        // Costs nothing in the shipped path — boot finishes before the first
        // render, so this only bumps a version counter on a program that has
        // not been linked yet. It matters when the system is added to an
        // already-running engine (which is how it gets probed), where without
        // it the compile hook would never fire again and the canopy would
        // never see a gust.
        m.needsUpdate = true;
        return;
      }
    });
  }
  linkCanopy();

  /** First-order lag on the gust envelope: the trees answer a beat late. */
  let canopySwell = 0;

  // =======================================================================
  // Audio
  // =======================================================================
  //
  // ONE-SHOTS ONLY, and deliberately. `audio.ts` runs an ambience director
  // that already sets the surf, cicada, birdsong, forest and night beds from
  // the listener's distance to the shoreline, altitude, POI weight and time of
  // day — including the dusk crossfade that thins the cicadas out. An
  // `ambience()` call from here would register a *floor* under that (see
  // `mixBeds`), which would hold a bed open through dusk and undo the single
  // clearest read of time of day in the mix. So the beds are left alone and
  // this file contributes only what the director cannot know: where the birds
  // physically are, and when one of them hits the water.
  //
  // Both cue names are verified present in `CUES`: `gull` (max 700 m) and
  // `bird` (max 260 m). `splash-in` is the distant plop.
  let gullCallIn = rand(1.5, 5);
  let songCallIn = rand(2, 6);

  function playAt(name: string, p: THREE.Vector3, volume: number, maxDistance?: number): void {
    ctx.services.audio?.play(name, { position: p, volume, maxDistance });
  }

  // =======================================================================
  // Startle
  // =======================================================================

  const lastPlayer = new THREE.Vector3();
  let havePlayer = false;
  let startleCooldown = 3;

  function startleAt(x: number, z: number, count: number): void {
    const y = groundAt(x, z);
    let spawned = 0;
    for (let i = tier.gulls + tier.flockBirds; i < birdCount && spawned < count; i++) {
      const b = birdPool[i];
      if (b.alive) continue;
      const a = rng() * TWO_PI;
      const r = rand(2, 11);
      b.pos.set(x + Math.cos(a) * r, y + rand(0.15, 0.9), z + Math.sin(a) * r);
      // Away from the disturbance and steeply up: the read is "something burst
      // out of the grass", and that is entirely in the first half second.
      const away = Math.atan2(b.pos.x - x, b.pos.z - z);
      const sp = rand(7, 12);
      b.vel.set(Math.sin(away) * sp, rand(5.5, 9), Math.cos(away) * sp);
      b.timer = rand(4.5, 7);
      b.alive = true;
      b.kind = 2;
      spawned++;
    }
    if (spawned > 0) {
      playAt("bird", scratch.set(x, y + 1, z), 0.55, 240);
    }
  }

  // =======================================================================
  // Per-frame update
  // =======================================================================

  const mat4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, "YXZ");
  const vScale = new THREE.Vector3();
  const tmpA = new THREE.Vector3();
  let disposed = false;

  function writeBird(i: number, b: Bird, alpha: number): void {
    const speed = b.vel.length();
    if (speed > 0.001) {
      const yaw = Math.atan2(b.vel.x, b.vel.z);
      // Rotating about X maps +Z to (0, -sin, cos), so a climb is a negative
      // pitch. Getting this backwards makes every bird dive when it climbs.
      const pitch = -Math.asin(THREE.MathUtils.clamp(b.vel.y / speed, -1, 1));
      euler.set(pitch * 0.75, yaw, b.roll, "YXZ");
      quat.setFromEuler(euler);
    }
    vScale.setScalar(b.scale);
    mat4.compose(b.pos, quat, vScale);
    birds.setMatrixAt(i, mat4);
    birdWing[i * 3] = b.phase;
    birdWing[i * 3 + 1] = b.rate;
    birdWing[i * 3 + 2] = b.amp;
    birdAlpha[i] = alpha;
  }

  function hideInstance(mesh: THREE.InstancedMesh, i: number): void {
    mat4.makeScale(0, 0, 0);
    mesh.setMatrixAt(i, mat4);
  }

  function spawnRing(x: number, z: number, size: number, volume: number): void {
    let best = -1;
    let bestAge = -1;
    for (let i = 0; i < ringPool.length; i++) {
      const r = ringPool[i];
      if (r.age >= r.life && r.age > bestAge) {
        best = i;
        bestAge = r.age;
      }
    }
    if (best < 0) return;
    const sea = terrain()?.seaLevel ?? 0;
    const r = ringPool[best];
    r.pos.set(x, sea + WATER_LIFT, z);
    r.age = 0;
    r.life = rand(2.4, 3.8);
    r.size = size;
    if (volume > 0) playAt("splash-in", r.pos, volume, 520);
  }

  const sys: System = {
    name: "ambience",

    /**
     * Everything here is cosmetic, so it all runs on the render clock. Nothing
     * in this file integrates anything gameplay reads, which is exactly why it
     * is allowed to be frame-rate dependent.
     */
    update(dt, c) {
      if (disposed) return;
      // The engine clamps dt to 1/15; clamp again so a single long frame can't
      // teleport a flock across the island.
      const d = Math.min(dt, 1 / 15);
      uTime.value += d;

      camPos.copy(c.camera.position);
      const t = terrain();
      const sea = t?.seaLevel ?? 0;
      const skySvc = sky();
      const daylight = skySvc ? THREE.MathUtils.clamp(skySvc.daylight, 0, 1) : 1;
      // Sun elevation drives the midges: they are only visible because they
      // are backlit, and a sun overhead does not backlight anything.
      const sunY = skySvc ? skySvc.sunDirection.y : 0.6;
      const lowSun = THREE.MathUtils.clamp(1 - (sunY - 0.18) / 0.42, 0, 1);

      // ---- gusts ----------------------------------------------------------
      if (gust.active) {
        gust.s += gust.speed * d;
        if (gust.s > gust.run) gust.active = false;
      } else {
        gustIn -= d;
        if (gustIn <= 0) {
          startGust();
          gustIn = rand(14, 30);
        }
      }
      const gustHere = gustAt(camPos.x, camPos.z);
      // Trees answer about a third of a second after the dust reaches you.
      canopySwell += (gustHere - canopySwell) * Math.min(1, d * 3.0);

      openBudget();
      // ---- birds ----------------------------------------------------------
      for (let i = 0; i < tier.flocks; i++) {
        const f = flock[i];
        f.t += (f.speed / Math.max(1, f.span)) * d;
        if (f.t > 1) seedFlockRoute(f);
      }

      for (let i = 0; i < birdCount; i++) {
        const b = birdPool[i];

        if (b.kind === 0) {
          // Gulls: a lazy circle that drifts, plus the occasional plunge.
          if (b.dive > 0) {
            b.timer -= d;
            const desc = b.timer > 0.55;
            b.vel.y = desc ? -12 : 9;
            b.pos.addScaledVector(b.vel, d);
            if (desc && b.pos.y <= sea + WATER_LIFT + 0.3) {
              b.timer = 0.5;
              spawnRing(b.pos.x, b.pos.z, rand(1.6, 3.0), 0.5);
              playAt("gull", b.pos, 0.5, 700);
              b.pos.y = sea + WATER_LIFT + 0.3;
            }
            if (b.timer <= 0) {
              b.dive = 0;
              b.pos.y = Math.max(b.pos.y, sea + 6);
            }
            b.amp = 0.55;
            b.rate = 8;
            b.roll = 0;
          } else {
            b.angle += b.spin * d;
            b.anchor.x += WIND_DIR.x * 1.6 * d;
            b.anchor.z += WIND_DIR.y * 1.6 * d;
            tmpA.set(
              b.anchor.x + Math.cos(b.angle) * b.orbit,
              b.anchor.y + Math.sin(uTime.value * 0.23 + b.phase) * 3.5,
              b.anchor.z + Math.sin(b.angle) * b.orbit,
            );
            b.vel.subVectors(tmpA, b.pos).multiplyScalar(1 / Math.max(0.016, d));
            if (b.vel.length() > 26) b.vel.setLength(26);
            b.pos.addScaledVector(b.vel, d);
            // Bank into the turn. A gull that circles flat is a paper plane.
            b.roll += (-b.spin * 7 - b.roll) * Math.min(1, d * 2);
            // Mostly gliding, flapping in bursts — the amplitude cycle is what
            // makes a distant silhouette read as a seabird and not a bat.
            const glide = 0.5 + 0.5 * Math.sin(uTime.value * 0.31 + b.phase * 2.1);
            b.amp = 0.07 + 0.3 * Math.pow(glide, 3);
            b.timer -= d;
            if (b.timer <= 0) {
              b.timer = rand(9, 26);
              // Only plunge if there is water under this bird right now.
              if (rng() < 0.35 && t && t.isWater(b.pos.x, b.pos.z)) {
                b.dive = 1;
                b.timer = 1.4;
              }
            }
          }
          const dist = Math.hypot(b.pos.x - camPos.x, b.pos.z - camPos.z);
          if (dist > R_GULL && probes < PROBE_BUDGET) seedGull(b);
          writeBird(i, b, THREE.MathUtils.clamp((R_GULL - dist) / 90, 0, 1));
          continue;
        }

        if (b.kind === 1) {
          const f = flock[b.flock] ?? flock[0];
          b.angle += b.spin * d;
          // Loose V-ish formation: a lateral spread from the slot index and a
          // small independent orbit so no two birds hold station perfectly.
          const lead = tmpA.lerpVectors(f.from, f.to, f.t);
          const dir = Math.atan2(f.to.x - f.from.x, f.to.z - f.from.z);
          const lat = ((b.slot % 7) - 3) * 5.5;
          const back = Math.abs((b.slot % 7) - 3) * 4.5 + (b.slot % 3) * 3;
          const px = lead.x + Math.sin(dir + Math.PI / 2) * lat - Math.sin(dir) * back
            + Math.cos(b.angle) * b.orbit * 0.35;
          const pz = lead.z + Math.cos(dir + Math.PI / 2) * lat - Math.cos(dir) * back
            + Math.sin(b.angle) * b.orbit * 0.35;
          // Follow the ground rather than a fixed altitude: a flock that flies
          // through a hill is worse than no flock.
          const gy = groundAt(px, pz);
          const py = Math.max(gy, sea) + 22 + Math.sin(uTime.value * 0.7 + b.phase) * 2.2;
          tmpA.set(px, py, pz);
          b.vel.subVectors(tmpA, b.pos).multiplyScalar(1 / Math.max(0.016, d));
          if (b.vel.length() > 34) b.vel.setLength(34);
          b.pos.copy(tmpA);
          b.roll += (Math.sin(uTime.value * 0.9 + b.phase) * 0.25 - b.roll) * Math.min(1, d * 3);
          const dist = Math.hypot(b.pos.x - camPos.x, b.pos.z - camPos.z);
          writeBird(i, b, THREE.MathUtils.clamp((R_FLOCK - dist) / 80, 0, 1));
          continue;
        }

        // Startled birds: a burst of speed, drag, then they simply leave.
        if (!b.alive) {
          hideInstance(birds, i);
          birdAlpha[i] = 0;
          continue;
        }
        b.timer -= d;
        b.vel.y += (2.2 - b.vel.y) * Math.min(1, d * 0.6);
        b.vel.multiplyScalar(1 - Math.min(0.9, d * 0.55));
        b.pos.addScaledVector(b.vel, d);
        b.roll += (Math.sin(uTime.value * 5 + b.phase) * 0.4 - b.roll) * Math.min(1, d * 6);
        if (b.timer <= 0) {
          b.alive = false;
          hideInstance(birds, i);
          birdAlpha[i] = 0;
          continue;
        }
        writeBird(i, b, THREE.MathUtils.clamp(b.timer / 1.2, 0, 1));
      }
      birds.instanceMatrix.needsUpdate = true;
      (birdGeom.getAttribute("aWing") as THREE.InstancedBufferAttribute).needsUpdate = true;
      (birdGeom.getAttribute("aAlpha") as THREE.InstancedBufferAttribute).needsUpdate = true;

      openBudget();
      // ---- startle trigger -------------------------------------------------
      const player = c.services.player;
      startleCooldown -= d;
      if (player) {
        if (!havePlayer) {
          lastPlayer.copy(player.position);
          havePlayer = true;
        }
        const moved = lastPlayer.distanceTo(player.position);
        lastPlayer.copy(player.position);
        const running = moved / Math.max(0.016, d) > 4.5;
        const grounded = player.state === "ground" || player.state === "sprint";
        if (running && grounded && startleCooldown <= 0 && probes < PROBE_BUDGET) {
          // Near a POI, or on open grass — either way something was sitting
          // there a moment ago and is not any more.
          let near = isGrass(player.position.x, player.position.z);
          const pois = c.services.pois;
          if (!near && pois) {
            for (const p of pois) {
              if (p.center.distanceTo(player.position) < p.radius) {
                near = true;
                break;
              }
            }
          }
          if (near && rng() < 0.5) {
            const ahead = player.look(tmpA).setY(0);
            if (ahead.lengthSq() < 0.01) ahead.set(0, 0, 1);
            ahead.normalize().multiplyScalar(rand(9, 16));
            startleAt(
              player.position.x + ahead.x,
              player.position.z + ahead.z,
              2 + Math.floor(rng() * 4),
            );
            startleCooldown = rand(7, 16);
          } else {
            startleCooldown = rand(2, 4);
          }
        }
      }

      openBudget();
      // ---- butterflies -----------------------------------------------------
      for (let i = 0; i < tier.butterflies; i++) {
        const f = flutters[i];
        const dist = Math.hypot(f.pos.x - camPos.x, f.pos.z - camPos.z);
        if ((dist > R_BUTTERFLY || f.alpha <= 0) && probes < PROBE_BUDGET) {
          seedFlutter(f);
        }
        if (f.pos.y < -1000) {
          hideInstance(butterflies, i);
          flutterAlpha[i] = 0;
          continue;
        }
        // Butterflies do not fly, they *fall upward in a random direction*.
        // Reaching a target and immediately picking another one, with a heavy
        // vertical bob, is the whole read.
        if (f.pos.distanceToSquared(f.target) < 0.35) {
          const a = rng() * TWO_PI;
          const r = rand(1.5, 6);
          const nx = f.pos.x + Math.cos(a) * r;
          const nz = f.pos.z + Math.sin(a) * r;
          const gy = groundAt(nx, nz);
          f.target.set(nx, gy + rand(0.3, 1.9), nz);
        }
        tmpA.subVectors(f.target, f.pos);
        const len = tmpA.length();
        if (len > 0.001) tmpA.multiplyScalar(1 / len);
        f.bob += d * f.bobRate;
        // Gusts blow them sideways — a butterfly in wind is not in charge.
        const g = gustAt(f.pos.x, f.pos.z);
        f.pos.x += (tmpA.x * 1.1 + WIND_DIR.x * g * 4.5) * d;
        f.pos.z += (tmpA.z * 1.1 + WIND_DIR.y * g * 4.5) * d;
        f.pos.y += (tmpA.y * 0.9 + Math.sin(f.bob) * 1.5 + g * 1.6) * d;
        f.yaw = Math.atan2(tmpA.x, tmpA.z);
        euler.set(0.35, f.yaw, 0, "YXZ");
        quat.setFromEuler(euler);
        vScale.setScalar(f.scale);
        mat4.compose(f.pos, quat, vScale);
        butterflies.setMatrixAt(i, mat4);
        flutterWing[i * 3] = f.bob * 0.6;
        flutterWing[i * 3 + 1] = 26;
        flutterWing[i * 3 + 2] = 0.62;
        // Daylight only: a butterfly at midnight is a bug report.
        flutterAlpha[i] = THREE.MathUtils.clamp((R_BUTTERFLY - dist) / 10, 0, 1) * daylight;
      }
      butterflies.instanceMatrix.needsUpdate = true;
      (flutterGeom.getAttribute("aWing") as THREE.InstancedBufferAttribute).needsUpdate = true;
      (flutterGeom.getAttribute("aAlpha") as THREE.InstancedBufferAttribute).needsUpdate = true;

      openBudget();
      // ---- midges ----------------------------------------------------------
      for (let i = 0; i < tier.midgeColumns; i++) {
        const col = columns[i];
        if ((!col.valid || col.center.distanceTo(camPos) > R_MIDGE) && probes < PROBE_BUDGET) {
          seedColumn(col);
        }
      }
      for (let i = 0; i < midgeCount; i++) {
        const col = columns[Math.floor(i / tier.midgesPer)];
        if (!col || !col.valid) {
          midgePos[i * 3 + 1] = -9999;
          continue;
        }
        const r = midgeParam[i * 4];
        const hy = midgeParam[i * 4 + 1];
        const sp = midgeParam[i * 4 + 2];
        const ph = midgeParam[i * 4 + 3];
        const a = uTime.value * sp + ph;
        // A midge column is a slow rise with a fast jitter on top; the jitter
        // is what makes a cloud of dots read as alive rather than as dust.
        midgePos[i * 3] = col.center.x + Math.cos(a) * r + Math.sin(a * 5.3) * 0.09;
        midgePos[i * 3 + 1] = col.center.y + hy + Math.sin(a * 0.61 + ph) * 0.55
          + Math.sin(a * 7.1) * 0.05;
        midgePos[i * 3 + 2] = col.center.z + Math.sin(a) * r + Math.cos(a * 4.7) * 0.09;
      }
      midgeGeom.attributes.position.needsUpdate = true;
      // A floor of 0.14 rather than 0: at noon the swarm is faint, not absent,
      // which is both true and keeps them out of the "photographs as missing"
      // trap when a capture lands at midday.
      midgeMat.opacity = (0.14 + 0.66 * lowSun) * daylight;

      openBudget();
      // ---- motes -----------------------------------------------------------
      for (let i = 0; i < tier.motes; i++) {
        const x = motePos[i * 3];
        const y = motePos[i * 3 + 1];
        const z = motePos[i * 3 + 2];
        const g = gustAt(x, z);
        // Brownian drift plus the front. The vertical term is buoyancy, not
        // gravity — pollen and dust in sunlight do not fall, they hang.
        moteVel[i * 3] += (rng() - 0.5) * 0.5 * d + WIND_DIR.x * g * 9 * d;
        moteVel[i * 3 + 1] += ((rng() - 0.5) * 0.35 + g * 3.2 - moteVel[i * 3 + 1] * 0.6) * d;
        moteVel[i * 3 + 2] += (rng() - 0.5) * 0.5 * d + WIND_DIR.y * g * 9 * d;
        moteVel[i * 3] *= 1 - Math.min(0.9, d * 0.9);
        moteVel[i * 3 + 2] *= 1 - Math.min(0.9, d * 0.9);
        motePos[i * 3] = x + moteVel[i * 3] * d;
        motePos[i * 3 + 1] = y + moteVel[i * 3 + 1] * d;
        motePos[i * 3 + 2] = z + moteVel[i * 3 + 2] * d;
        if (
          Math.hypot(motePos[i * 3] - camPos.x, motePos[i * 3 + 2] - camPos.z) > R_MOTE
          && probes < PROBE_BUDGET
        ) {
          seedMote(i);
        }
      }
      moteGeom.attributes.position.needsUpdate = true;
      moteMat.opacity = 0.16 + 0.42 * daylight;

      openBudget();
      // ---- drift -----------------------------------------------------------
      for (let i = 0; i < tier.drift; i++) {
        const dr = drifters[i];
        if (dr.pos.y < -1000) {
          hideInstance(drifts, i);
          driftAlpha[i] = 0;
          if (probes < PROBE_BUDGET) {
            seedDrifter(dr, i);
            if (drifts.instanceColor) drifts.instanceColor.needsUpdate = true;
          }
          continue;
        }
        const g = gustAt(dr.pos.x, dr.pos.z);
        const gy = groundAt(dr.pos.x, dr.pos.z);

        if (dr.litter) {
          // Litter caught in an eddy: it orbits a fixed point rather than
          // going anywhere, which is exactly what a bag in a corner does.
          dr.angle += (0.9 + g * 3) * d;
          const r = 0.7 + Math.sin(dr.angle * 0.37) * 0.45;
          dr.pos.x = dr.eddy.x + Math.cos(dr.angle) * r;
          dr.pos.z = dr.eddy.z + Math.sin(dr.angle) * r;
          dr.pos.y = gy + 0.15 + Math.abs(Math.sin(dr.angle * 0.8)) * (0.5 + g * 1.4);
        } else if (dr.grounded && g < 0.08) {
          // Lying still. Sitting flat on the ground is a valid at-rest state
          // and is what most leaves are doing most of the time.
          dr.pos.y = gy + 0.02;
          dr.rot.set(0, dr.rot.y, 0);
        } else {
          dr.grounded = 0;
          dr.vel.x += (WIND_DIR.x * (1.5 + g * 14) - dr.vel.x) * Math.min(1, d * 1.6);
          dr.vel.z += (WIND_DIR.y * (1.5 + g * 14) - dr.vel.z) * Math.min(1, d * 1.6);
          dr.vel.y += (-1.4 + g * 5.5 - dr.vel.y) * Math.min(1, d * 2.2);
          dr.pos.addScaledVector(dr.vel, d);
          dr.rot.x += dr.spin.x * (0.5 + g * 2) * d;
          dr.rot.y += dr.spin.y * (0.5 + g * 2) * d;
          dr.rot.z += dr.spin.z * (0.5 + g * 2) * d;
          if (dr.pos.y <= gy + 0.02) {
            dr.pos.y = gy + 0.02;
            dr.vel.set(0, 0, 0);
            dr.grounded = 1;
          }
        }

        const dist = Math.hypot(dr.pos.x - camPos.x, dr.pos.z - camPos.z);
        if (dist > R_DRIFT && probes < PROBE_BUDGET) {
          seedDrifter(dr, i);
          if (drifts.instanceColor) drifts.instanceColor.needsUpdate = true;
        }
        quat.setFromEuler(dr.rot);
        vScale.set(dr.size, dr.size, dr.size * (dr.litter ? 1.5 : 1.25));
        mat4.compose(dr.pos, quat, vScale);
        drifts.setMatrixAt(i, mat4);
        driftAlpha[i] = THREE.MathUtils.clamp((R_DRIFT - dist) / 25, 0, 1);
      }
      drifts.instanceMatrix.needsUpdate = true;
      (driftGeom.getAttribute("aAlpha") as THREE.InstancedBufferAttribute).needsUpdate = true;

      openBudget();
      // ---- fish ------------------------------------------------------------
      for (let i = 0; i < tier.shoals; i++) {
        const s = shoals[i];
        if ((!s.valid || s.center.distanceTo(camPos) > R_FISH) && probes < PROBE_BUDGET) {
          seedShoal(s);
          continue;
        }
        if (!s.valid) continue;
        s.turn += (rng() - 0.5) * d * 1.4;
        s.turn = THREE.MathUtils.clamp(s.turn, -0.6, 0.6);
        s.heading += s.turn * d;
        const nx = s.center.x + Math.sin(s.heading) * SHOAL_SPEED * d;
        const nz = s.center.z + Math.cos(s.heading) * SHOAL_SPEED * d;
        // Shoals stay in the shallows: if the next step leaves them, turn hard
        // rather than swim up the beach.
        if (probes < PROBE_BUDGET && !isShallow(nx, nz)) {
          s.heading += Math.PI * 0.5;
        } else {
          s.center.x = nx;
          s.center.z = nz;
        }
        s.center.y = sea + WATER_LIFT;
        // Occasional rise: a fish breaks the surface and leaves a ring.
        if (rng() < d * 0.12) {
          spawnRing(
            s.center.x + rand(-4, 4),
            s.center.z + rand(-4, 4),
            rand(0.7, 1.6),
            0.22,
          );
        }
      }
      for (let i = 0; i < tier.fish; i++) {
        const f = fishPool[i];
        const s = shoals[f.shoal];
        if (!s || !s.valid) {
          hideInstance(fishes, i);
          fishAlpha[i] = 0;
          continue;
        }
        f.wiggle += d * f.rate;
        const c1 = Math.cos(s.heading);
        const s1 = Math.sin(s.heading);
        // Formation offsets are in the shoal's own frame, so the school turns
        // as one body instead of shearing.
        const ox = f.offset.x * c1 - f.offset.y * s1;
        const oz = -f.offset.x * s1 - f.offset.y * c1;
        tmpA.set(
          s.center.x + ox + Math.sin(f.wiggle) * 0.25,
          s.center.y,
          s.center.z + oz + Math.cos(f.wiggle) * 0.25,
        );
        euler.set(0, s.heading + Math.sin(f.wiggle) * 0.22, 0, "YXZ");
        quat.setFromEuler(euler);
        vScale.set(f.scale * 0.55, 1, f.scale * 1.5);
        mat4.compose(tmpA, quat, vScale);
        fishes.setMatrixAt(i, mat4);
        const dist = Math.hypot(tmpA.x - camPos.x, tmpA.z - camPos.z);
        // Nearly invisible far out and clearly there up close, because that is
        // how looking into water works.
        fishAlpha[i] = THREE.MathUtils.clamp((R_FISH - dist) / 110, 0, 1)
          * THREE.MathUtils.clamp((dist - R_SURFACE_NEAR) / 15, 0, 1)
          * 0.6 * (0.4 + 0.6 * daylight);
      }
      fishes.instanceMatrix.needsUpdate = true;
      (fishGeom.getAttribute("aAlpha") as THREE.InstancedBufferAttribute).needsUpdate = true;

      // ---- rings -----------------------------------------------------------
      for (let i = 0; i < tier.rings; i++) {
        const r = ringPool[i];
        r.age += d;
        if (r.age >= r.life || r.pos.y < -1000) {
          hideInstance(rings, i);
          ringAlpha[i] = 0;
          continue;
        }
        const k = r.age / r.life;
        const size = r.size * (1 + k * 5.5);
        quat.identity();
        vScale.set(size, 1, size);
        mat4.compose(r.pos, quat, vScale);
        rings.setMatrixAt(i, mat4);
        // Ramps in fast and decays — a ring that fades linearly reads as a
        // dissolve rather than as water settling.
        const ringDist = Math.hypot(r.pos.x - camPos.x, r.pos.z - camPos.z);
        ringAlpha[i] = Math.min(1, k * 9) * (1 - k) * (1 - k) * 0.85
          * THREE.MathUtils.clamp((ringDist - R_SURFACE_NEAR) / 15, 0, 1);
      }
      rings.instanceMatrix.needsUpdate = true;
      (ringGeom.getAttribute("aAlpha") as THREE.InstancedBufferAttribute).needsUpdate = true;

      openBudget();
      // ---- beach ball ------------------------------------------------------
      if (ball) {
        if (!ballState.valid || ballState.pos.distanceTo(camPos) > R_BALL) {
          if (probes < PROBE_BUDGET) seedBall();
        }
        if (!ballState.valid) {
          ball.visible = false;
        } else {
          ball.visible = true;
          const g = gustAt(ballState.pos.x, ballState.pos.z);
          // A beach ball weighs nothing: the wind owns it, and rolling
          // resistance is what stops it, not mass.
          ballState.vel.x += (WIND_DIR.x * (0.6 + g * 11) - ballState.vel.x) * Math.min(1, d * 1.3);
          ballState.vel.z += (WIND_DIR.y * (0.6 + g * 11) - ballState.vel.z) * Math.min(1, d * 1.3);
          ballState.vel.multiplyScalar(1 - Math.min(0.9, d * 0.55));
          const step = tmpA.copy(ballState.vel).multiplyScalar(d);
          ballState.pos.add(step);
          const gy = groundAt(ballState.pos.x, ballState.pos.z);
          // Floats when it reaches the sea, and bobs rather than sinking.
          const rest = Math.max(gy, sea - 0.12) + 0.3;
          ballState.pos.y += (rest - ballState.pos.y) * Math.min(1, d * 6)
            + (gy < sea ? Math.sin(uTime.value * 1.7) * 0.02 : 0);
          // Roll = travel / radius, about the axis perpendicular to travel.
          const travel = Math.hypot(step.x, step.z);
          if (travel > 1e-5) {
            tmpA.set(-step.z, 0, step.x).normalize();
            quat.setFromAxisAngle(tmpA, travel / 0.3);
            ballState.spin.premultiply(quat);
          }
          ball.position.copy(ballState.pos);
          ball.quaternion.copy(ballState.spin);
        }
      }

      openBudget();
      // ---- one-shot calls --------------------------------------------------
      gullCallIn -= d;
      if (gullCallIn <= 0) {
        gullCallIn = rand(4, 12);
        if (tier.gulls > 0) {
          const b = birdPool[Math.floor(rng() * tier.gulls)];
          playAt("gull", b.pos, rand(0.3, 0.75), 700);
        }
      }
      songCallIn -= d;
      if (songCallIn <= 0) {
        songCallIn = rand(3.5, 11);
        // Songbirds go quiet at dusk, which the bed does too — this is the
        // punctuation on top of it, not a replacement for it.
        if (daylight > 0.3 && probes < PROBE_BUDGET
          && findNear(camPos.x, camPos.z, 12, 70, 6, isGrass, scratch)) {
          scratch.y = groundAt(scratch.x, scratch.z) + rand(3, 9);
          playAt("bird", scratch, rand(0.3, 0.6) * daylight, 260);
        }
      }
    },

    /**
     * The canopy swell.
     *
     * `vegetation.ts` writes `uWind.z` from its own slow breeze envelope every
     * `update`, so this runs in `lateUpdate` — after that write and before the
     * render — and scales it. Reading the value back each frame is what keeps
     * it a scale rather than an accumulation: if vegetation ever stops writing
     * (disposed, or failed), the value we find is the one we wrote last frame
     * and we hold the base instead of compounding it into a hurricane.
     */
    lateUpdate() {
      if (disposed || !vegWind) return;
      const cur = vegWind.value.z;
      if (cur !== vegLast) vegBase = cur;
      const next = vegBase * (1 + 2.4 * canopySwell);
      vegWind.value.z = next;
      vegLast = next;
    },

    dispose() {
      disposed = true;
      if (vegWind) vegWind.value.z = vegBase;
      root.removeFromParent();
      root.clear();
      for (const d of disposables) d.dispose();
      birds.dispose();
      butterflies.dispose();
      drifts.dispose();
      fishes.dispose();
      rings.dispose();
    },
  };

  console.info(
    `[Drop Zero] ambience: ${birdCount} birds, ${tier.butterflies} butterflies, ` +
    `${midgeCount} midges, ${tier.motes} motes, ${tier.drift} drifters, ` +
    `${tier.fish} fish, ${tier.rings} rings — ${tier.ball ? 9 : 8} scene draws ` +
    `(+4 shadow-cascade draws for the ball), ` +
    `quality "${ctx.quality}".`,
  );

  return sys;
}
