/**
 * The Deep — a realm you reach by swimming down, and only by swimming down.
 *
 * Vibe City's other realms are places you travel TO: the island, the moons,
 * Mars, the mines. Each is somewhere else with its own ground and its own sky,
 * and getting there is a journey across a map. This one is underneath the map.
 * The bay is twelve metres deep and floored everywhere — except at one point
 * offshore, where the sand gives out and drops eighty metres into the dark.
 *
 * It is a separate realm by every measure that matters — different light,
 * different life, different rules about how far you can see — and there is no
 * portal, no loading, no teleport. You dive, the walls close in, the sun goes
 * out, and the only light left is the light things make for themselves.
 *
 * ## What makes it a place rather than a hole
 *
 *  - **The sun stops.** The atmosphere model already dims the key light as
 *    `1 / (1 + depth · 0.16)`; at eighty metres that is four percent. Nothing
 *    special is needed to make it dark down there — it is dark by the same
 *    arithmetic that dims the shallows, followed far enough.
 *  - **So everything visible is bioluminescent.** Polyps on the walls, motes
 *    drifting up the column, jellies pulsing past. All emissive, which is the
 *    only kind of light that survives having no light: emissive needs no lamp,
 *    so a scene with nothing lighting it still has something in it.
 *  - **The walls funnel.** The physics floor and the visible wall follow the
 *    same profile, so you slide in rather than clipping through a cylinder.
 *
 * ## The one hard constraint
 *
 * Four separate bounds in `City.tsx` assume nobody is ever below −40 m: you
 * stop swimming, the seabed support clamps at −80, and the underwater
 * atmosphere switches off (that last one on purpose, so a mineshaft under the
 * ocean is not treated as being underwater). All four have to consult
 * `inside()` — which is why this module exports a footprint test as a
 * first-class thing and not as an afterthought.
 */
import * as THREE from "three";
import { waterDepthAt, CITY_HALF } from "@/city/ocean";
import { softDot } from "@/city/softDot";

const STORE = "city.trench.claimed";

/** Bearing of the mouth. Deliberately between two wreck bearings. */
const BEARING = 3.5;
/** How deep below the seabed the floor sits. */
const DROP = 78;
/** Radius of the mouth at the seabed. */
const RIM = 26;
/** The funnel closes to this fraction of the rim at the floor. */
const TAPER = 0.62;

export interface TrenchPrize {
  label: string;
  reward: number;
}

export interface Trench {
  group: THREE.Group;
  /** Where the hole is, so callers can signpost it. */
  readonly mouth: { x: number; z: number; y: number; rim: number };
  /** The floor of the world at this point, or null outside the trench. */
  floorAt(x: number, z: number): number | null;
  /** Inside the footprint at all — the predicate every relaxed bound uses. */
  inside(x: number, z: number): boolean;
  /**
   * Drive it. Returns the prize if it was just claimed, or null.
   * `depth` is how far the CAMERA is below the sea surface.
   */
  update(
    dt: number, timeSec: number, swimmer: THREE.Vector3, eye: THREE.Vector3,
  ): TrenchPrize | null;
  /** How far down the shaft the swimmer is, 0 at the mouth, 1 on the floor. */
  descent(y: number): number;
  /** Where the prize sits, and whether it is still there. For harnesses. */
  prize(): { x: number; y: number; z: number; claimed: boolean };
  reset(): void;
  dispose(): void;
}

/** Cheap deterministic hash noise — no texture, no import, same every load. */
function hash3(x: number, y: number, z: number) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/** Walk out along the bearing to water deep enough to be worth a hole in. */
function findMouth() {
  const dx = Math.sin(BEARING);
  const dz = Math.cos(BEARING);
  let r = CITY_HALF + 60;
  for (let i = 0; i < 300; i++) {
    if (waterDepthAt(dx * r, dz * r) > 12) break;
    r += 5;
  }
  r += 40;
  const x = dx * r;
  const z = dz * r;
  return { x, z, y: -waterDepthAt(x, z), rim: RIM };
}

export function createTrench(): Trench {
  const group = new THREE.Group();
  /**
   * Everything you can see, under a switch — and the lamp deliberately not.
   *
   * The contents are hidden wholesale when nobody is near, because the shaft
   * is one place in a two-kilometre world. A light cannot go in there: an
   * invisible light is not merely dark, it is *absent* — three.js skips
   * invisible objects when it gathers lights, so the point-light count changes
   * and every material in the city recompiles. Twice, on the way in and on the
   * way out. The lamp therefore hangs off `group` directly and is dimmed to
   * zero instead, which is the same picture and no recompiles.
   */
  const body = new THREE.Group();
  group.add(body);
  const trash: Array<{ dispose(): void }> = [];
  const mouth = findMouth();
  const floorY = mouth.y - DROP;

  let claimed = false;
  try {
    claimed = localStorage.getItem(STORE) === "1";
  } catch { /* private mode; the abyss is still there */ }

  /**
   * The funnel, as one function.
   *
   * Physics and geometry both read it, which is the only reason you can trust
   * the floor you are standing on to be the floor you can see. Two profiles
   * that merely resemble each other is how you get a player hovering a metre
   * above visible rock, or falling through it.
   */
  const profile = (d: number) => {
    // 0 at the rim, 1 well inside it.
    const t = THREE.MathUtils.clamp((RIM - d) / (RIM * (1 - TAPER)), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const distTo = (x: number, z: number) => Math.hypot(x - mouth.x, z - mouth.z);
  const floorAt = (x: number, z: number) => {
    const d = distTo(x, z);
    if (d > RIM) return null;
    return mouth.y - DROP * profile(d);
  };

  // Scratch objects, shared by everything that composes a matrix — declared up
  // here because the boulders are placed once at build time and the polyps,
  // jellies and lamp are moved every frame, and they may as well not each keep
  // their own.
  const M = new THREE.Matrix4();
  const P = new THREE.Vector3();
  const Q = new THREE.Quaternion();
  const S = new THREE.Vector3();
  const E = new THREE.Euler();
  const ONE = new THREE.Quaternion();
  const UP_TO_EYE = new THREE.Vector3();

  // ---- The shaft ---------------------------------------------------------
  /**
   * An open cone, seen from the inside.
   *
   * `BackSide`, because you are always in it — a front-faced cone is invisible
   * from within and the abyss reads as a hole in the world with the sky
   * showing through, which is exactly the bug the sea's own underside had.
   */
  const wallGeo = new THREE.CylinderGeometry(RIM, RIM * TAPER, DROP, 48, 24, true);
  {
    const pos = wallGeo.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const a = Math.atan2(z, x);
      const r = Math.hypot(x, z);
      // Rock, not a lathe: push each ring in and out by a couple of metres at
      // two scales, and let the seam close by keying the noise off the ANGLE
      // rather than off x/z, which would tear where the cylinder wraps.
      const n =
        (hash3(Math.cos(a) * 3, y * 0.09, Math.sin(a) * 3) - 0.5) * 3.4 +
        (hash3(Math.cos(a) * 11, y * 0.31, Math.sin(a) * 11) - 0.5) * 1.3;
      const rr = Math.max(2, r + n);
      pos.setX(i, Math.cos(a) * rr);
      pos.setZ(i, Math.sin(a) * rr);
    }
    wallGeo.computeVertexNormals();
  }
  /**
   * Rock you can see without a light on it.
   *
   * Physically this wall should be invisible: the sun is down to four percent
   * at eighty metres and a diver's lamp at sixteen metres with inverse-square
   * falloff delivers nothing. So it WAS invisible — and the result was not a
   * dark shaft, it was no shaft at all. The polyps and jellies hung in a black
   * rectangle looking like debris in space, because nothing behind them said
   * "wall". The dark can only be oppressive if you can tell there is something
   * close.
   *
   * The faint emissive is what fixes it, and it is not a cheat so much as the
   * consequence of the colonies already established: the rock is covered in
   * bioluminescent life, so the rock glows a little. It is far too dim to light
   * the diver — that is still the lamp's job — and the abyss fog eats it at
   * about twenty metres, so you see the wall you are next to and the far side
   * of the shaft stays gone.
   */
  const rockMat = new THREE.MeshStandardMaterial({
    color: "#1b2a30",
    emissive: "#0d2b33",
    emissiveIntensity: 0.85,
    roughness: 0.95,
    metalness: 0.02,
    side: THREE.BackSide,
  });
  const wall = new THREE.Mesh(wallGeo, rockMat);
  wall.position.set(mouth.x, mouth.y - DROP / 2, mouth.z);
  body.add(wall);
  trash.push(wallGeo, rockMat);

  const floorGeo = new THREE.CircleGeometry(RIM * TAPER + 1, 40);
  floorGeo.rotateX(-Math.PI / 2);
  {
    const pos = floorGeo.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, (hash3(x * 0.7, 4.2, z * 0.7) - 0.5) * 1.6);
    }
    floorGeo.computeVertexNormals();
  }
  const floorMat = new THREE.MeshStandardMaterial({
    color: "#16232a",
    // Same argument as the wall, a shade weaker: the floor is what tells you
    // the fall has ended, and it is the one surface the lamp does reach, so it
    // needs less help.
    emissive: "#0a2028",
    emissiveIntensity: 0.7,
    roughness: 1,
    metalness: 0,
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.position.set(mouth.x, floorY, mouth.z);
  body.add(floor);
  trash.push(floorGeo, floorMat);

  // ---- Polyps: the only thing lighting the walls -------------------------
  /**
   * Emissive, not lit.
   *
   * There is one lamp down here and there is never going to be a second — a
   * light per glowing thing would be a hundred forward lights in every material
   * in the city, and this world already carries twenty-nine. Emissive costs
   * nothing and is the only kind of brightness that survives having nothing to
   * light it, which is the whole visual argument of the place. What the diver's
   * lamp is for is the opposite job: giving the *unlit* things down here — the
   * rock, the diver — a surface.
   */
  const POLYPS = 260;
  // Subdivided once: at zero it is twenty flat faces and a polyp two metres
  // across reads as a floating hexagon — which is exactly what the first
  // capture of the floor came back full of.
  const polypGeo = new THREE.IcosahedronGeometry(0.34, 1);
  /**
   * Unlit, and that is not laziness — it is the only way the colours survive.
   *
   * These were `MeshStandardMaterial` with an emissive, and the per-instance
   * colour below was supposed to give two colonies, teal and violet. It gave
   * one: `instanceColor` multiplies the DIFFUSE term, and an emissive is added
   * after it and never sees it. So every polyp emitted exactly the same
   * `#3ff2d8`, at an intensity high enough to clip, and they all came back as
   * identical white balls stuck to the wall.
   *
   * `MeshBasicMaterial` IS its colour — nothing lights it, nothing adds to it,
   * and the instance colour is the whole answer. Which is also what a
   * bioluminescent thing looks like: it has no lit side and no shadow side.
   * Cheaper, too, and there are two hundred and sixty of them.
   */
  const polypMat = new THREE.MeshBasicMaterial({ color: "#ffffff" });
  const polyps = new THREE.InstancedMesh(polypGeo, polypMat, POLYPS);
  polyps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  body.add(polyps);
  trash.push(polypGeo, polypMat);
  const polypSeed = Array.from({ length: POLYPS }, (_, i) => {
    const t = (i + 0.5) / POLYPS;
    return {
      a: hash3(i, 1, 2) * Math.PI * 2,
      // Denser lower down: the deeper it gets the more of the light is theirs.
      t: Math.pow(t, 0.7),
      size: 0.3 + hash3(i, 3, 4) * 0.8,
      phase: hash3(i, 5, 6) * Math.PI * 2,
      hue: hash3(i, 7, 8),
    };
  });
  const polypColor = new THREE.Color();

  // ---- Motes drifting up the column --------------------------------------
  const MOTES = 300;
  const motePos = new Float32Array(MOTES * 3);
  const moteRise = new Float32Array(MOTES);
  for (let i = 0; i < MOTES; i++) {
    const a = hash3(i, 11, 12) * Math.PI * 2;
    const r = Math.sqrt(hash3(i, 13, 14)) * RIM * 0.8;
    motePos[i * 3] = mouth.x + Math.cos(a) * r;
    motePos[i * 3 + 1] = floorY + hash3(i, 15, 16) * DROP;
    motePos[i * 3 + 2] = mouth.z + Math.sin(a) * r;
    moteRise[i] = 0.25 + hash3(i, 17, 18) * 0.7;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  moteGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(mouth.x, mouth.y - DROP / 2, mouth.z), DROP);
  /**
   * Marine snow needs a soft edge, and a `Points` sprite has none by default.
   *
   * An untextured point is a hard square, and a hard white square hanging in
   * open water does not read as a drifting particle — it reads as a dead pixel
   * or a missing texture. In the first capture of the trench mouth the two
   * nearest motes were 14 px blocks and were by some distance the most
   * eye-catching thing in the frame. One radial gradient fixes it; there is no
   * asset to load because it is drawn here.
   */
  const moteTex = softDot();
  const moteMat = new THREE.PointsMaterial({
    color: "#6ff5e4",
    size: 0.42,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    ...(moteTex ? { map: moteTex } : {}),
  });
  if (moteTex) trash.push(moteTex);
  const motes = new THREE.Points(moteGeo, moteMat);
  body.add(motes);
  trash.push(moteGeo, moteMat);

  // ---- Jellies ------------------------------------------------------------
  const JELLIES = 14;
  /**
   * A bell, and the tentacles under it.
   *
   * The bell alone, at 0.55 opacity against a near-black background, came back
   * as a thin white circle — you were seeing the silhouette edge and nothing
   * else, so it read as a wireframe rather than as an animal. Two changes: the
   * bell is more opaque so it has an inside, and there is now a trailing
   * cluster below it, which is most of what makes a jelly recognisable at a
   * glance. Both instanced off the same seeds, so it is one extra draw call
   * for fourteen of them.
   */
  const bellGeo = new THREE.SphereGeometry(1, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62);
  const bellMat = new THREE.MeshStandardMaterial({
    color: "#123a49",
    // Keeps its colour. Pushed to 1.6 the bell clipped to white and the whole
    // animal read as a mushroom: an opaque pale cap on a pale stalk.
    emissive: "#7be0ff",
    emissiveIntensity: 0.75,
    transparent: true,
    opacity: 0.5,
    roughness: 0.35,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  /**
   * Long, thin and nearly invisible — which is what makes it a jellyfish.
   *
   * It went through two wrong shapes first. At 0.42 × 3.4 it was an
   * eight-metre solid teal wedge, brighter than the diver. Shortened to 2.1 it
   * became a stubby stalk under a flat cap, and the whole animal read as a
   * MUSHROOM — which is the failure mode to watch for here, because a
   * squashed dome on a short thick stem is exactly that silhouette. The trail
   * has to be much longer than the bell and much fainter than it.
   */
  const tentGeo = new THREE.ConeGeometry(0.26, 5, 6, 1, true);
  tentGeo.translate(0, -2.5, 0);
  const tentMat = new THREE.MeshStandardMaterial({
    color: "#0d2f3d",
    emissive: "#4fc7e8",
    emissiveIntensity: 0.5,
    transparent: true,
    opacity: 0.22,
    roughness: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const bells = new THREE.InstancedMesh(bellGeo, bellMat, JELLIES);
  bells.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bells.frustumCulled = false;
  body.add(bells);
  const tents = new THREE.InstancedMesh(tentGeo, tentMat, JELLIES);
  tents.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  tents.frustumCulled = false;
  // After the bell, so the translucent trail sorts behind the translucent
  // bell it hangs from rather than through it.
  body.add(tents);
  trash.push(bellGeo, bellMat, tentGeo, tentMat);
  const jellySeed = Array.from({ length: JELLIES }, (_, i) => ({
    a: hash3(i, 21, 22) * Math.PI * 2,
    r: 3 + hash3(i, 23, 24) * (RIM * 0.7),
    y: floorY + 4 + hash3(i, 25, 26) * (DROP - 8),
    rise: 0.35 + hash3(i, 27, 28) * 0.5,
    size: 0.7 + hash3(i, 29, 30) * 1.1,
    phase: hash3(i, 31, 32) * Math.PI * 2,
  }));

  // ---- Boulders on the floor ---------------------------------------------
  /**
   * Something for the lamp to fall across.
   *
   * The floor is the one surface down here the lamp actually reaches, and a
   * flat disc lit evenly by a point light is a grey sheet with a gradient on
   * it — it gave no sense of standing anywhere. Rubble is what makes a light
   * source legible: the shadow sides and the near-far falloff are the whole
   * reason to be carrying one.
   */
  const ROCKS = 44;
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  /**
   * The same rock, seen from the outside.
   *
   * `rockMat` is `BackSide` because you are always inside the shaft and a
   * front-faced cone is invisible from within. A boulder is the opposite case
   * — you are outside it — so sharing the material renders every one of them
   * inside out: you see the far wall of each stone lit from behind, which
   * looks like flat grey paper cut-outs lying on the floor and gives the lamp
   * nothing to model.
   */
  const bouldMat = new THREE.MeshStandardMaterial({
    // Darker than the wall it broke off. The lamp is a few metres away and
    // inverse-square, so anything with a mid-grey albedo down here comes back
    // white and the floor reads as snow.
    color: "#182228",
    emissive: "#0a1c22",
    emissiveIntensity: 0.45,
    roughness: 1,
    metalness: 0,
    flatShading: true,
  });
  const boulders = new THREE.InstancedMesh(rockGeo, bouldMat, ROCKS);
  for (let i = 0; i < ROCKS; i++) {
    const a = hash3(i, 41, 42) * Math.PI * 2;
    const r = Math.sqrt(hash3(i, 43, 44)) * (RIM * TAPER);
    const sz = 0.5 + hash3(i, 45, 46) * 2.3;
    P.set(mouth.x + Math.cos(a) * r, floorY + sz * 0.35, mouth.z + Math.sin(a) * r);
    E.set(hash3(i, 47, 48) * 3, hash3(i, 49, 50) * 3, hash3(i, 51, 52) * 3);
    // Squashed, not spherical: boulders that have been sitting somewhere for
    // a geological while are wider than they are tall.
    S.set(sz, sz * (0.45 + hash3(i, 53, 54) * 0.4), sz * (0.8 + hash3(i, 55, 56) * 0.5));
    boulders.setMatrixAt(i, M.compose(P, Q.setFromEuler(E), S));
  }
  boulders.instanceMatrix.needsUpdate = true;
  body.add(boulders);
  trash.push(rockGeo, bouldMat);

  // ---- The vent, and what is sitting beside it ---------------------------
  /**
   * A black smoker, which is a chimney of cooled rock and not a glowing cone.
   *
   * It was one fully-emissive orange cone, and at any distance that is a flat
   * orange polygon — the shading is gone, so it reads as a piece of card
   * standing on the floor. Real ones are almost black; what you see is the
   * mouth and the plume coming out of it, and the rock around it only where
   * the glow catches it.
   */
  const ventPos = new THREE.Vector3(mouth.x + 7, floorY, mouth.z - 5);
  const ventMat = new THREE.MeshStandardMaterial({
    // Basalt, and barely warm. The first version was a warm brown with a
    // strong orange emissive, which with the diver's lamp two metres away came
    // back as a flat maroon cape — saturated, unshaded, and the brightest
    // object in the frame. The chimney is meant to be the dark thing the
    // plume comes out of.
    color: "#20232a",
    emissive: "#2e0f05",
    emissiveIntensity: 0.3,
    roughness: 0.95,
    // Faceted, so the lamp has edges to catch. Smooth-shaded, a cylinder lit
    // by a single nearby point light is one continuous gradient and reads as
    // a cut-out however much noise is in the geometry.
    flatShading: true,
    // Open-ended, so without this you see straight through the far wall of it.
    side: THREE.DoubleSide,
  });
  const ventGeo = new THREE.CylinderGeometry(1.1, 3.4, 6.2, 11, 4, true);
  {
    const pos = ventGeo.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const a = Math.atan2(z, x);
      const r = Math.hypot(x, z);
      const rr = Math.max(0.5, r + (hash3(Math.cos(a) * 5, y * 0.8, Math.sin(a) * 5) - 0.5) * 1.5);
      pos.setX(i, Math.cos(a) * rr);
      pos.setZ(i, Math.sin(a) * rr);
    }
    ventGeo.computeVertexNormals();
  }
  const vent = new THREE.Mesh(ventGeo, ventMat);
  vent.position.set(ventPos.x, ventPos.y + 3.1, ventPos.z);
  body.add(vent);
  trash.push(ventGeo, ventMat);

  // The mouth itself: small, and the only part that is actually bright.
  const ventCoreGeo = new THREE.SphereGeometry(0.75, 10, 8);
  const ventCoreMat = new THREE.MeshBasicMaterial({ color: "#ff7a28", fog: true });
  const ventCore = new THREE.Mesh(ventCoreGeo, ventCoreMat);
  ventCore.position.set(ventPos.x, ventPos.y + 5.7, ventPos.z);
  body.add(ventCore);
  trash.push(ventCoreGeo, ventCoreMat);

  /**
   * The plume. This is the part that says "vent" rather than "rock".
   *
   * Additive and warm at the mouth, going cold and thin as it climbs, because
   * that is the whole tell: the water above a smoker shimmers for twenty
   * metres. It shares the soft dot with the motes, so there is still no
   * texture to load.
   */
  const PLUME = 110;
  const plumePos = new Float32Array(PLUME * 3);
  const plumeSeed = Array.from({ length: PLUME }, (_, i) => ({
    a: hash3(i, 61, 62) * Math.PI * 2,
    r: hash3(i, 63, 64),
    y: hash3(i, 65, 66),
    rise: 0.9 + hash3(i, 67, 68) * 1.5,
  }));
  const plumeGeo = new THREE.BufferGeometry();
  plumeGeo.setAttribute("position", new THREE.BufferAttribute(plumePos, 3));
  plumeGeo.boundingSphere = new THREE.Sphere(ventPos.clone().setY(ventPos.y + 12), 22);
  const plumeMat = new THREE.PointsMaterial({
    color: "#ffb070",
    // Small enough to read as smoke rather than as bokeh: at 1.5 m the nearer
    // specks were 40-pixel soft discs and looked like a lens effect.
    size: 0.9,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.24,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    ...(moteTex ? { map: moteTex } : {}),
  });
  const plume = new THREE.Points(plumeGeo, plumeMat);
  body.add(plume);
  trash.push(plumeGeo, plumeMat);

  /**
   * The prize: a pearl on the floor of the world.
   *
   * Claimed once per browser, like the wrecks, and for the same reason — a
   * payout you can farm by reloading is a button, not a discovery. This one is
   * worth several of them, because getting here is worth several of them.
   */
  const pearlGeo = new THREE.IcosahedronGeometry(1.1, 2);
  const pearlMat = new THREE.MeshStandardMaterial({
    color: "#dff6ff",
    emissive: "#bfe9ff",
    emissiveIntensity: claimed ? 0.05 : 1.7,
    roughness: 0.15,
    metalness: 0.4,
  });
  const pearl = new THREE.Mesh(pearlGeo, pearlMat);
  pearl.position.set(mouth.x - 4, floorY + 1.4, mouth.z + 3);
  body.add(pearl);
  trash.push(pearlGeo, pearlMat);

  /**
   * The lamp you take with you.
   *
   * Everything else down here is emissive, and emissive geometry lights
   * nothing — so with the sun down to four percent the polyps glowed, the
   * jellies glowed, and the diver between them was a black cut-out. That is
   * not what the deep looks like in any footage of it, because nobody films
   * the deep without a lamp on the rig.
   *
   * So: exactly one light, and it earns its place twice. It gives the player a
   * body instead of a silhouette, and it puts a moving pool of light on rock
   * that is otherwise a flat fog-coloured wall — which is the only thing that
   * makes the shaft read as having a surface at all.
   *
   * It is never added or removed, only dimmed. Changing the number of lights
   * in a scene recompiles every material in it, and doing that on the frame
   * the player crosses the rim would hitch the whole city; holding one light
   * at zero intensity costs a few instructions and no recompiles.
   */
  const lamp = new THREE.PointLight(0xd8f4ff, 0, 30, 2);
  group.add(lamp);
  /** Where the lamp wants to be, before the ease. */
  const lampTo = new THREE.Vector3();


  return {
    group,
    mouth,

    floorAt,
    inside: (x, z) => distTo(x, z) <= RIM,
    descent: (y) => THREE.MathUtils.clamp((mouth.y - y) / DROP, 0, 1),
    prize: () => ({ x: pearl.position.x, y: pearl.position.y, z: pearl.position.z, claimed }),

    update(dt, timeSec, swimmer, eye) {
      void dt;
      // Nothing down here is worth a frame of anyone's time unless somebody is
      // near enough to see it. The shaft is one place in a two-kilometre world.
      const near = Math.hypot(eye.x - mouth.x, eye.z - mouth.z) < RIM + 70;
      body.visible = near;
      if (!near) {
        lamp.intensity = 0;
        return null;
      }

      // Polyps cling to the wall, so their radius follows the same funnel the
      // wall does — anything else and half of them float in the middle.
      for (let i = 0; i < POLYPS; i++) {
        const s = polypSeed[i];
        const y = mouth.y - s.t * DROP;
        const r = THREE.MathUtils.lerp(RIM, RIM * TAPER, s.t) - 0.6;
        P.set(mouth.x + Math.cos(s.a) * r, y, mouth.z + Math.sin(s.a) * r);
        const pulse = 0.75 + 0.45 * Math.sin(timeSec * 0.9 + s.phase);
        S.setScalar(s.size * pulse);
        polyps.setMatrixAt(i, M.compose(P, ONE, S));
        // Two colonies, teal and violet, so the walls are not one flat hue.
        // This is now the literal output colour, so it can be a real colour
        // rather than a multiplier: saturated, and only about half-bright, so
        // the pulse has somewhere to go and neither colony clips to white.
        polypColor.setHSL(s.hue > 0.65 ? 0.79 : 0.47, 0.95, 0.3 + pulse * 0.22);
        polyps.setColorAt(i, polypColor);
      }
      polyps.instanceMatrix.needsUpdate = true;
      if (polyps.instanceColor) polyps.instanceColor.needsUpdate = true;

      for (let i = 0; i < MOTES; i++) {
        let y = motePos[i * 3 + 1] + moteRise[i] * dt;
        if (y > mouth.y) y = floorY;
        motePos[i * 3 + 1] = y;
      }
      (moteGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;

      for (let i = 0; i < JELLIES; i++) {
        const j = jellySeed[i];
        j.y += j.rise * dt;
        if (j.y > mouth.y - 2) j.y = floorY + 3;
        const beat = Math.sin(timeSec * 1.5 + j.phase);
        const a = j.a + timeSec * 0.05;
        P.set(mouth.x + Math.cos(a) * j.r, j.y, mouth.z + Math.sin(a) * j.r);
        // A jelly swims by squashing: wider on the push, taller on the
        // recovery. Scaling it uniformly gives a balloon — but squashing it as
        // hard as this first did (0.7× at full push) flattens the dome into a
        // disc, and a disc over a stem is a mushroom. It stays a dome.
        // The 1.35 is the dome. A unit sphere cut at 0.62π is 2 wide and 1.2
        // tall, which is a plate; taken straight it is the single biggest
        // reason the thing photographed as a mushroom.
        S.set(j.size * (1 + beat * 0.16), j.size * 1.35 * (1.02 - beat * 0.18), j.size * (1 + beat * 0.16));
        E.set(0, a, 0);
        Q.setFromEuler(E);
        bells.setMatrixAt(i, M.compose(P, Q, S));
        // The tentacles lag the bell: they stream out when it pushes and
        // gather when it recovers, which is the reason the animal reads as
        // swimming rather than as bobbing.
        P.y -= j.size * (0.5 + beat * 0.1);
        S.set(j.size * (1 - beat * 0.15), j.size * (1 + beat * 0.35), j.size * (1 - beat * 0.15));
        tents.setMatrixAt(i, M.compose(P, Q, S));
      }
      bells.instanceMatrix.needsUpdate = true;
      tents.instanceMatrix.needsUpdate = true;

      /**
       * Aim the lamp, and fade it in as the light fails.
       *
       * It sits a little way along the line from the swimmer toward the eye,
       * and a little above it — so it lights the diver's back and throws past
       * them onto whatever they are facing. Put it AT the camera and you get
       * flash photography: everything evenly lit, no shape, no shadow side.
       *
       * The fade is keyed to the camera rather than the swimmer because the
       * atmosphere is, and a lamp coming on while the water is still bright
       * blue looks like a bug. By the time it is at full there is essentially
       * no sun left, so it is not competing with anything.
       */
      lampTo.copy(swimmer).addScaledVector(
        UP_TO_EYE.copy(eye).sub(swimmer).setY(0).normalize(),
        1.5,
      );
      lampTo.y = swimmer.y + 1.4;
      lamp.position.lerp(lampTo, 1 - Math.pow(0.002, Math.min(dt, 0.1)));
      const lit = THREE.MathUtils.clamp((mouth.y + 6 - eye.y) / 16, 0, 1);
      // Not perfectly steady — a lamp underwater flickers through the silt it
      // is stirring up, and a light that holds one value reads as a shader
      // constant rather than as an object somebody is carrying.
      const flicker = 0.94 + 0.06 * Math.sin(timeSec * 7.3) * Math.sin(timeSec * 2.1);
      lamp.intensity = 46 * lit * lit * flicker;

      /**
       * The plume, as a fountain rather than a drift.
       *
       * Each speck is a pure function of time and its seed, so nothing
       * integrates and nothing accumulates error over a long session — and it
       * widens as it rises, which is the shape smoke makes in water. Recycling
       * by modulo means no particle ever needs a "respawn" branch.
       */
      for (let i = 0; i < PLUME; i++) {
        const q = plumeSeed[i];
        const h = ((q.y + timeSec * q.rise * 0.06) % 1) * 17;
        const spread = 0.7 + h * 0.42;
        const a = q.a + h * 0.09;
        plumePos[i * 3] = ventPos.x + Math.cos(a) * q.r * spread;
        plumePos[i * 3 + 1] = ventPos.y + 6 + h;
        plumePos[i * 3 + 2] = ventPos.z + Math.sin(a) * q.r * spread;
      }
      (plumeGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;

      pearl.rotation.y += dt * 0.35;
      if (!claimed) {
        pearl.position.y = floorY + 1.4 + Math.sin(timeSec * 0.8) * 0.18;
        if (swimmer.distanceTo(pearl.position) < 3.4) {
          claimed = true;
          pearlMat.emissiveIntensity = 0.05;
          try { localStorage.setItem(STORE, "1"); } catch { /* fine */ }
          return { label: "The Pearl of the Deep", reward: 120 };
        }
      }
      return null;
    },

    reset() {
      claimed = false;
      pearlMat.emissiveIntensity = 1.7;
      try { localStorage.removeItem(STORE); } catch { /* fine */ }
    },

    dispose() {
      trash.forEach((t) => t.dispose());
    },
  };
}
