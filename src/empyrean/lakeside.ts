/**
 * THE EMPYREAN — the lakeside.
 *
 * Six hundred metres under the city there is a frozen lake, and until this
 * file existed there was nothing on it. That is a strange thing for a world
 * whose single most spectacular move is the *descent*: falling away from the
 * underside of the island, watching four hundred metres of keel and its
 * stalactites go past, and standing on the ice to look up at the whole thing
 * hanging in the sky. Nobody ever made that trip, because a mirror and a
 * snowfield are not a destination.
 *
 * So: **Mirrorfoot**. A small ice camp with warm windows, a viewing deck
 * called the Long Look aimed at the island, a skate loop, a cargo apron under
 * a beacon, and a supply tether running up to the promenade. Plus the ice
 * itself — pressure ridges, drifts, scoured patches, frozen-in bubbles and
 * cracks lit from beneath — because ice reads as ice through its *surface*,
 * never through its colour, and a flat mirror you can now walk on is still a
 * flat mirror.
 *
 * ## The two problems this file is really about
 *
 * **Scale.** From the deck, 600 m up, everything here is a few pixels; from
 * ten metres away one hut is the whole screen. Both have to work, and they
 * want opposite things. The answer is that the *long* read is carried
 * entirely by light — a Points cloud with a screen-space size floor, and one
 * soft beacon column over the apron — and the *close* read is carried by
 * geometry that does not exist until you are near enough to see it. A lit
 * camp at dusk is legible from the rim at a kilometre and a quarter; that is
 * the thing that pulls somebody over the parapet, and it costs three draw
 * calls.
 *
 * **Landing.** The player arrives by jetpack and may arrive fast. Before this
 * file, `surfaceAt` reported `void` for every point off the island and
 * `supportAt` therefore returned -Infinity over the whole lake: a descent to
 * the ice ended at `KILL_Y` and a respawn on the Halo. **The ice deck
 * published here is what makes the lake a floor at all** — see `ICE_DECK`. It
 * is the one thing in this file the world genuinely cannot do without.
 *
 * ## The reflection
 *
 * `reflected: false`, and not as a cost decision. The lake's reflection is a
 * real mirrored clone of the silhouette group; everything here is standing
 * *on* the mirror, at head height above it. Its reflection would be its own
 * feet, drawn a second time, one metre under a surface that is 30–55% opaque.
 * The one thing that has to be true is that this system does not *break* the
 * reflection, and the rule there is draw order: the lake is transparent with
 * `depthWrite: false` at `renderOrder` 10, so
 *
 *  - anything opaque here writes depth normally and correctly occludes the
 *    water fragment behind it, and
 *  - anything flat that belongs *on* the ice — scour, bubbles, cracks, the
 *    swept rink — is transparent, `depthWrite: false`, and sits at
 *    `renderOrder` 11 or 12 so it lands on top of the water rather than under
 *    it. At `renderOrder` 9 the same geometry is painted over by the lake and
 *    the ice goes blank again, which is a five-minute mistake and a two-hour
 *    diagnosis.
 *
 * ## What it costs
 *
 * Two tiers, and the cheap one is the one that is true nearly all the time.
 *
 * | camera | draws | triangles |
 * | --- | --- | --- |
 * | on the deck, camp in frame | 4 | ~7 k |
 * | on the deck, camp behind you | 0 | 0 |
 * | standing on the ice at the camp | 10 | ~15 k |
 *
 * The far tier is the shells, the lights, the beacon and nothing else. The
 * near tier — ice detail, cracks, skaters, the tether — switches in at
 * `NEAR_R` and is the only part that scales with how much ice you can
 * actually resolve.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { BuildContext, FrameContext, Interactable, InteractiveSystem } from "./types";
import { GROUND_Y, ISLAND_Y, LAKE_R, WATER_Y } from "./config";
import { clamp01, fbm2, makeRng, ridged2, smoothstep, type Rng } from "@/shared/proc/rng";

/* =========================================================================
 * Collision, in this file's own words
 *
 * `collide.ts` owns these two shapes and this file may not import it — a
 * system imports `types.ts`, `config.ts`, `cityplan.ts`, `three` and the
 * shared helpers, and nothing else. They are structural, so a local
 * declaration is assignable to the engine's list without a cast, exactly as
 * `buildings.ts` does it.
 * ====================================================================== */

/** An axis-aligned box you cannot walk through. */
export interface Blocker {
  x: number;
  z: number;
  hx: number;
  hz: number;
  top: number;
  bottom: number;
}

/** A flat surface you can stand on. Circular ones carry `r`. */
export interface Deck {
  y: number;
  r?: number;
  x?: number;
  z?: number;
  hx?: number;
  hz?: number;
}

/* =========================================================================
 * Where the ground is
 *
 * `terrain.ts` owns the snow and exports the very function this needs, and a
 * system may not import another system — so it is re-derived here, character
 * for character, exactly as `launchsite.ts` does. That is a copy, and copies
 * drift, so `empyreanLakeside.test.ts` imports *both* and asserts they agree
 * over a grid covering the lake and the shore. The test may cross the line
 * this file may not.
 *
 * It is load-bearing rather than decorative: `ICE_DECK` claims the whole lake
 * is a level floor at `WATER_Y`, and that claim is only true while
 * `groundHeight` returns `GROUND_Y` inside `LAKE_R`. Retune the ranges so the
 * lake basin acquires a slope and the ice becomes a sheet of glass hanging
 * over the terrain, with the player standing on the glass.
 * ====================================================================== */

const RANGE_INNER = LAKE_R * 1.3;
const RANGE_OUTER = 7800;

/** `terrain.ts`'s `groundHeight`, re-derived. Keep the two identical. */
export function snowHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r < LAKE_R) return GROUND_Y;
  const drift = fbm2(x * 0.0011, z * 0.0011, 4, 2, 0.5, 7) * 20;
  const t = (r - RANGE_INNER) / (RANGE_OUTER - RANGE_INNER);
  if (t <= 0 || t >= 1) {
    return GROUND_Y + drift * Math.min(1, Math.max(0, (r - LAKE_R) / 360));
  }
  const band = Math.sin(Math.PI * Math.min(1, t * 2.2)) ** 0.7;
  const ridge = ridged2(x * 0.00048, z * 0.00048, 4, 31);
  const teeth = ridged2(x * 0.0028, z * 0.0028, 3, 91);
  const h = (ridge ** 2.6 * 0.62 + teeth ** 1.9 * 0.72) * 560 * band;
  const CEIL = ISLAND_Y * 0.84;
  const raw = h + drift;
  const capped = raw < CEIL * 0.7 ? raw : CEIL - (CEIL * 0.3 * CEIL * 0.3) / (raw - CEIL * 0.4);
  return GROUND_Y + capped;
}

/* =========================================================================
 * Where the camp is
 *
 * Chosen for one photograph, and the photograph was taken four times before
 * the number was written down.
 *
 * At the signature hour the sun is on bearing 251°, so the island reads
 * against the sunset from bearing 71° — dead anti-solar, the island directly
 * in front of the sun. That was tried first and it is the wrong answer: the
 * glare road, the bloom and the sky's own sun disc wash the rock out to a
 * flat lilac ghost and the whole silhouette goes soft. Forty-five degrees off
 * — bearing 27° — is the shot: gold sky on the left, deep blue on the right,
 * the keel a hard dark spike between them, and the terraces catching a rim of
 * light. It is the same trade `launchsite.ts` made at 244°, for the same
 * reason, and the sun still wins any argument you have with it.
 *
 * 880 m out is the range. At a kilometre and a quarter the island is a
 * pleasant object in the middle of the frame; at 620 m the rim is overhead
 * and you have lost the keel, which is the half of the silhouette the world
 * is named for. At 880 the deck sits 35° up, the keel tip 3° above the
 * horizon, and the whole 1060 m of island fits a 58° lens with room. Two
 * things came free with the bearing: the spaceport at 1.87 km on 206° lands
 * almost exactly under the keel's point from here, so a launch climbs out
 * from behind the island; and the camp is 500 m clear of the island's own
 * axis, so nothing here is ever *under* the rock, in shadow, at any hour.
 * ====================================================================== */

/** Bearing and range of the camp, and the two world coordinates they give. */
export const CAMP_BEARING = (27 * Math.PI) / 180;
export const CAMP_RANGE = 880;
export const CAMP_X = Math.round(Math.sin(CAMP_BEARING) * CAMP_RANGE);
export const CAMP_Z = Math.round(Math.cos(CAMP_BEARING) * CAMP_RANGE);

/** The ice surface. The lake's own mesh sits here; so does everything below. */
export const ICE_Y = WATER_Y;

/** Height of the Long Look's deck above the ice. */
export const LOOK_DECK = 2.6;
/** Radius of the Long Look, to the outside of the rail. */
export const LOOK_R = 9;

/**
 * The floor of the world, below the island.
 *
 * One circular deck covering the lake. Without it `supportAt` answers
 * -Infinity everywhere off the island — `cityplan.ts` reports `void` past the
 * outermost promenade and nothing else claims the ground — so a descent from
 * the rim passes straight through the ice, through `KILL_Y` at -400, and the
 * player is put back on the Halo having seen the whole thing and landed on
 * none of it. That was the state of the world before this file, and it is
 * most of why nobody went down.
 *
 * It stops at the shore rather than covering the snowfield, because a deck is
 * flat and the snow is not: a disc out to `WORLD_R` would stand the player at
 * 0.35 m inside a four-hundred-metre mountain. The snowfield is still void
 * and still kills; see the note at the foot of this file.
 */
export const ICE_DECK: Deck = { y: ICE_Y, r: LAKE_R, x: 0, z: 0 };

/**
 * How near the camera has to be for the ice to grow a surface.
 *
 * Generous on purpose. The descent from the rim is 620 m of falling and the
 * ground has to be *becoming* something the whole way down, not snapping into
 * existence at the last second — so the near tier is already on well before
 * the player is committed to landing. Below this it is nine draws; above it,
 * three.
 */
const NEAR_R = 520;

/** Past this the camp is a light and nothing else is worth submitting. */
const SHELL_R = 3400;

/* =========================================================================
 * Geometry helpers
 *
 * The same shape `launchsite.ts` uses: build a primitive, tag every vertex
 * with a colour and an emissive weight, move it into place, and merge the lot
 * into one buffer. Everything static in this file is one draw because of it.
 * ====================================================================== */

type Geo = THREE.BufferGeometry;

const _m4 = new THREE.Matrix4();
const _eul = new THREE.Euler();

function tag(g: Geo, col: THREE.Color, emis = 0): Geo {
  const n = (g.attributes.position as THREE.BufferAttribute).count;
  const c = new Float32Array(n * 3);
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    c[i * 3] = col.r;
    c[i * 3 + 1] = col.g;
    c[i * 3 + 2] = col.b;
    e[i] = emis;
  }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  g.setAttribute("aEmis", new THREE.BufferAttribute(e, 1));
  g.deleteAttribute("uv");
  /* Everything going into one merge has to agree about having an index, and
   * `IcosahedronGeometry` is the one primitive used here that arrives without
   * one — `PolyhedronGeometry` emits raw triangles. `mergeGeometries` returns
   * *null* rather than throwing when they disagree, so the symptom is the
   * whole camp silently not existing, with one line on stderr naming an index
   * into an array nobody kept. A trivial sequential index costs nothing and
   * makes every primitive here interchangeable. */
  if (!g.getIndex()) {
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return g;
}

function put(g: Geo, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0): Geo {
  _eul.set(rx, ry, rz, "YXZ");
  _m4.makeRotationFromEuler(_eul);
  _m4.setPosition(x, y, z);
  g.applyMatrix4(_m4);
  return g;
}

const box = (w: number, h: number, d: number): Geo => new THREE.BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, seg = 8): Geo =>
  new THREE.CylinderGeometry(rt, rb, h, seg, 1);
const ico = (r: number, detail = 1): Geo => new THREE.IcosahedronGeometry(r, detail);

/** A partial ring lying flat: the deck rail, with a gap for the stair. */
const ring = (r: number, tube: number, arc: number, seg: number): Geo =>
  new THREE.TorusGeometry(r, tube, 4, seg, arc);

/**
 * The palette.
 *
 * Warm timber and painted steel against blue ice, which is the entire colour
 * argument of the place: the camp is the only warm thing for a kilometre and
 * a half, and that is what makes it read from the deck at dusk.
 */
const PAL = {
  deckWood: new THREE.Color("#8a6a4e"),
  deckWoodDark: new THREE.Color("#6a5039"),
  steel: new THREE.Color("#8b95a3"),
  steelDark: new THREE.Color("#49515c"),
  shellA: new THREE.Color("#e5643f"),
  shellB: new THREE.Color("#d9c46a"),
  shellC: new THREE.Color("#4fa3a8"),
  shellD: new THREE.Color("#c9d4e0"),
  skirt: new THREE.Color("#37414d"),
  glass: new THREE.Color("#ffcd8e"),
  lampGlass: new THREE.Color("#ffd9a0"),
  ember: new THREE.Color("#ff9a4a"),
  snow: new THREE.Color("#f2f6ff"),
  iceSlab: new THREE.Color("#cfe2f3"),
  iceSlabDeep: new THREE.Color("#9dc0dd"),
  crate: new THREE.Color("#b0793f"),
  crateB: new THREE.Color("#4d6f7a"),
  coat: new THREE.Color("#e0623d"),
  coatB: new THREE.Color("#3f7fb0"),
  coatC: new THREE.Color("#e3b64a"),
  skin: new THREE.Color("#c78e6a"),
};

/* =========================================================================
 * The handle
 * ====================================================================== */

export interface LakesideHandle extends InteractiveSystem {
  /** Boxes the body may not walk through. World space, axis aligned. */
  readonly blockers: Blocker[];
  /**
   * Standable surfaces. World space.
   *
   * The first of these is `ICE_DECK` and it is the reason the lake is a place
   * rather than a texture — see the note on the constant.
   */
  readonly decks: Deck[];
  /** Where the Long Look's deck is, for a camera that wants to stand on it. */
  readonly look: Readonly<THREE.Vector3>;
  /** True while anything at all is being submitted. */
  readonly onScreen: boolean;
  /** True while the close-range half of the world is built and drawing. */
  readonly detailed: boolean;
  /** Raised by the telescope and the brazier. The engine wires it to toasts. */
  onToast?: (text: string, tone?: "info" | "good" | "warn") => void;
}

/* =========================================================================
 * Build
 * ====================================================================== */

export function buildLakeside(ctx: BuildContext): LakesideHandle {
  const low = ctx.quality === "low";
  const rng = makeRng(`empyrean-lakeside-${ctx.seedSalt}`);

  const group = new THREE.Group();
  group.name = "empyrean-lakeside";

  /* ---- the frame the camp is built in ---------------------------------- */

  /** Yaw that points camp-local +Z at the island. Same convention as the pad. */
  const faceYaw = Math.atan2(-CAMP_X, -CAMP_Z);
  const cy = Math.cos(faceYaw);
  const sy = Math.sin(faceYaw);

  group.position.set(CAMP_X, ICE_Y, CAMP_Z);
  group.rotation.y = faceYaw;

  const toWorldX = (lx: number, lz: number): number => CAMP_X + lx * cy + lz * sy;
  const toWorldZ = (lx: number, lz: number): number => CAMP_Z + -lx * sy + lz * cy;

  /**
   * The yaw that makes a child of this group sit square to the *world*.
   *
   * Every blocker in this world is an axis-aligned box in world space, and an
   * AABB around a hut turned 27° off the axes over-covers its corners by
   * something like half a metre — which is an invisible wall you cannot walk
   * up to a door through. Rather than fudge the half-extents, everything that
   * publishes a blocker is *built* square to the world and only the things
   * that publish nothing — the viewing deck, the lamps, the rails, the rink —
   * follow the camp's own facing. A camp of modules parked square to the
   * prevailing wind is what an ice camp looks like anyway; the one thing that
   * genuinely must aim at the island is the deck, and it is a circle.
   */
  const SQUARE = -faceYaw;
  const sq = (quarter: number): number => SQUARE + quarter * (Math.PI / 2);

  /* ---- materials ------------------------------------------------------- */

  const shared = {
    uNight: { value: 0 },
    uTime: { value: 0 },
    uSun: { value: new THREE.Vector3(0, 1, 0) },
    uCamDist: { value: 0 },
  };

  const shellMat = new THREE.MeshStandardMaterial({
    name: "EmpyreanLakesideShell",
    vertexColors: true,
    roughness: 0.74,
    metalness: 0.06,
    emissive: new THREE.Color(0x000000),
  });
  shellMat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = shared.uNight;
    shader.vertexShader = `attribute float aEmis;\nvarying float vEmis;\n${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n  vEmis = aEmis;",
    );
    shader.fragmentShader = `uniform float uNight;\nvarying float vEmis;\n${shader.fragmentShader}`.replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * (vEmis * (0.20 + uNight * 1.55));",
    );
  };
  shellMat.customProgramCacheKey = () => "empyrean-lakeside-shell-v1";

  /**
   * Snow and ice, tinted the way the snowfield is.
   *
   * `terrain.ts` grafts a warm/cool split onto its standard material at the
   * fog chunk — gold on the faces turned to the sun, the sky's lavender on
   * the ones turned away — and a drift built here without it is a chalk-white
   * lump sitting on a snowfield that is neither. This is the same graft,
   * shortened, and injected in the same place for the same reason: anything
   * added after the fog chunk is immune to fog, which on a surface you can
   * see from a kilometre up is a bright hole in the picture.
   */
  const iceMat = new THREE.MeshStandardMaterial({
    name: "EmpyreanLakesideIce",
    vertexColors: true,
    roughness: 0.66,
    metalness: 0.0,
  });
  iceMat.onBeforeCompile = (shader) => {
    shader.uniforms.uSun = shared.uSun;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWNrm;")
      .replace(
        "#include <worldpos_vertex>",
        "#include <worldpos_vertex>\n  vWNrm = normalize(mat3(modelMatrix) * objectNormal);",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uSun;\nvarying vec3 vWNrm;")
      .replace(
        "#include <fog_fragment>",
        `
         float sunlit = clamp(dot(normalize(vWNrm), normalize(uSun)) * 0.5 + 0.5, 0.0, 1.0);
         vec3 warm = vec3(1.06, 0.97, 0.86);
         vec3 cool = vec3(0.80, 0.82, 1.02);
         gl_FragColor.rgb *= mix(cool, warm, pow(sunlit, 1.2));
         gl_FragColor.rgb += vec3(0.26, 0.10, 0.20) * pow(1.0 - sunlit, 3.0) * 0.34;
         gl_FragColor.rgb += vec3(0.075, 0.070, 0.115);
#include <fog_fragment>`,
      );
  };
  iceMat.customProgramCacheKey = () => "empyrean-lakeside-ice-v1";

  /* =======================================================================
   * The shells: one merged mesh, everything that does not move
   * ==================================================================== */

  const parts: Geo[] = [];
  const blockers: Blocker[] = [];
  const decks: Deck[] = [ICE_DECK];

  /** A world-square box, its blocker and (optionally) its roof deck. */
  function solid(
    lx: number,
    lz: number,
    hx: number,
    hz: number,
    bottom: number,
    top: number,
    standable = true,
  ): void {
    const wx = toWorldX(lx, lz);
    const wz = toWorldZ(lx, lz);
    blockers.push({ x: wx, z: wz, hx, hz, bottom: ICE_Y + bottom, top: ICE_Y + top });
    if (standable) {
      decks.push({ x: wx, z: wz, hx: hx * 0.86, hz: hz * 0.86, y: ICE_Y + top });
    }
  }

  /* ---- the Long Look ---------------------------------------------------
   *
   * An octagonal deck on eight legs, aimed at the island, with the rail open
   * on the side the stair comes up. It is 2.6 m up rather than flush with the
   * ice for two reasons and neither is the view: it puts a dark horizontal
   * line under the lamps so the whole thing reads as a *structure* from the
   * rim rather than as four loose lights, and it gives the ice somewhere to
   * run underneath, which is what makes standing on it feel like standing
   * over a lake instead of on a floor.
   */
  const LOOK_LZ = 26;

  parts.push(tag(put(cyl(LOOK_R, LOOK_R, 0.34, 8), 0, LOOK_DECK - 0.17, LOOK_LZ), PAL.deckWood));
  parts.push(
    tag(put(cyl(LOOK_R * 0.92, LOOK_R * 0.98, 0.24, 8), 0, LOOK_DECK - 0.42, LOOK_LZ), PAL.deckWoodDark),
  );
  // The compass rose. A disc and eight spokes, and it is the one thing on the
  // deck that tells you which way you are looking without a word on it.
  parts.push(tag(put(cyl(3.4, 3.4, 0.05, low ? 12 : 24), 0, LOOK_DECK + 0.03, LOOK_LZ), PAL.deckWoodDark));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    parts.push(
      tag(
        put(box(0.22, 0.06, 3.0), Math.sin(a) * 1.7, LOOK_DECK + 0.05, LOOK_LZ + Math.cos(a) * 1.7, a),
        i === 0 ? PAL.glass : PAL.deckWood,
        i === 0 ? 0.7 : 0,
      ),
    );
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    parts.push(
      tag(
        put(cyl(0.2, 0.26, LOOK_DECK, 6), Math.sin(a) * LOOK_R * 0.78, LOOK_DECK / 2, LOOK_LZ + Math.cos(a) * LOOK_R * 0.78),
        PAL.steelDark,
      ),
    );
  }
  /* The rail. Two rings and a ring of posts, open over 90° at the back where
     the stair lands — a closed rail is a deck you can only reach by air. */
  for (const h of [0.55, 1.06]) {
    parts.push(
      tag(
        put(ring(LOOK_R - 0.35, 0.055, Math.PI * 1.5, low ? 14 : 26), 0, LOOK_DECK + h, LOOK_LZ, 0, Math.PI / 2),
        PAL.steel,
      ),
    );
  }
  for (let i = 0; i < (low ? 8 : 13); i++) {
    const a = -Math.PI * 0.75 + (i / (low ? 7 : 12)) * Math.PI * 1.5;
    parts.push(
      tag(
        put(cyl(0.05, 0.06, 1.12, 5), Math.sin(a) * (LOOK_R - 0.35), LOOK_DECK + 0.56, LOOK_LZ + Math.cos(a) * (LOOK_R - 0.35)),
        PAL.steel,
      ),
    );
  }
  // The deck is a circle, so it is a circular deck: no half-extents, no
  // over-coverage, exact at every bearing.
  decks.push({ x: toWorldX(0, LOOK_LZ), z: toWorldZ(0, LOOK_LZ), r: LOOK_R - 0.5, y: ICE_Y + LOOK_DECK });

  /* ---- the stair -------------------------------------------------------
   *
   * Built square to the world, and running out along world +Z, which from
   * here is 27° off "straight back from the deck" and lands where the ice is
   * clear. Square, because a tread is a `Deck` and a `Deck` is an AABB: turn
   * a 4 m by 2 m tread 27° and its box grows 0.6 m at each end, which is
   * enough for the box of the tread above to reach out over the tread below
   * — and a body walking *down* then finds the higher tread still under it
   * and hovers off the edge of every step. Square treads do not overlap and
   * the flight simply works, up and down.
   *
   * Five risers of 0.52 m and 2 m of tread. The riser is set by `CLIMB`, not
   * by taste: a body walks up anything under 0.62 m and has to *jump*
   * anything over it, and a flight of four risers on a 2.6 m deck comes to
   * 0.65 — three centimetres over, which is a stair you cannot climb and a
   * number that looks perfectly reasonable in the source. `empyreanLakeside`
   * walks the centre line and would have caught it; it did.
   */
  {
    const STEPS = 5;
    const RISE = LOOK_DECK / STEPS;
    const TREAD = 2.0;
    const HW = 2.1;
    // Where the flight meets the deck, in local coordinates: the deck edge,
    // offset along world +Z. Derived rather than typed, so it survives the
    // camp being turned.
    const ax = -(LOOK_R - 1.2) * sy;
    const az = LOOK_LZ + (LOOK_R - 1.2) * cy;
    for (let i = 0; i < STEPS; i++) {
      const y = LOOK_DECK - i * RISE;
      const d = i * TREAD;
      const lx = ax - d * sy;
      const lz = az + d * cy;
      parts.push(tag(put(box(HW * 2, RISE + 0.12, TREAD), lx, y - (RISE + 0.12) / 2, lz, SQUARE), PAL.deckWood));
      const wx = toWorldX(lx, lz);
      const wz = toWorldZ(lx, lz);
      decks.push({ x: wx, z: wz, hx: HW, hz: TREAD / 2, y: ICE_Y + y });
    }
  }

  /* ---- the telescope ---------------------------------------------------
   *
   * On the island side of the deck, on a yoke, tilted up at the rim. It is
   * the reason to walk to this exact spot rather than any other spot on a
   * frozen lake, and it is the one interactable here.
   */
  const SCOPE_LZ = LOOK_LZ + 4.6;
  {
    parts.push(tag(put(cyl(0.16, 0.34, 1.15, 8), 0, LOOK_DECK + 0.58, SCOPE_LZ), PAL.steelDark));
    for (const s of [-1, 1]) {
      parts.push(tag(put(box(0.12, 0.9, 0.12), s * 0.42, LOOK_DECK + 1.6, SCOPE_LZ), PAL.steel));
    }
    /* The tube goes into the same merge as everything else. It was a mesh of
       its own for a while so that it could swing when somebody used it, and a
       mesh of its own is a draw call of its own — which the camp pays from
       the city deck, a kilometre and a quarter away, for a 2.4 m tube nobody
       up there can resolve. Tilt it once at build time and merge it. */
    const TILT = -0.62;
    const cs = Math.cos(TILT);
    const sn = Math.sin(TILT);
    const tube = (lz: number, g: Geo): Geo =>
      put(g, 0, LOOK_DECK + 1.95 + lz * -sn, SCOPE_LZ + lz * cs, 0, TILT);
    parts.push(tag(tube(0, put(cyl(0.24, 0.3, 2.4, 10), 0, 0, 0, 0, Math.PI / 2)), PAL.steel));
    parts.push(tag(tube(1.24, cyl(0.31, 0.31, 0.22, 10)), PAL.steelDark));
    parts.push(tag(tube(-1.4, cyl(0.1, 0.14, 0.5, 8)), PAL.steelDark));
    parts.push(tag(tube(1.35, cyl(0.26, 0.26, 0.04, 10)), PAL.glass, 0.5));
  }

  /* ---- the modules -----------------------------------------------------
   *
   * Five habs and a mess dome, on skids, in a loose arc *behind* the deck so
   * nothing stands between the Long Look and the island. Warm window bands on
   * both long sides: from a kilometre and a quarter up those bands are the
   * camp, and they are what a chip of light at dusk is made of.
   */
  interface Hab {
    lx: number;
    lz: number;
    q: number;
    w: number;
    d: number;
    col: THREE.Color;
  }
  /* Laid out around a gap, not in a row.
   *
   * The first pass put the mess dome on the camp's own axis and a hab beside
   * it, and from anywhere behind the camp — which is where you land, because
   * the deck faces the island and the ice behind it is the clear ground — the
   * dome stood squarely in front of the one structure the place exists for.
   * Everything now keeps out of a five-metre-wide corridor up the middle, so
   * the Long Look is visible from the moment you touch down. */
  const HABS: Hab[] = [
    { lx: 9, lz: -6, q: 0, w: 5.6, d: 8.4, col: PAL.shellA },
    { lx: -9, lz: -13, q: 1, w: 5.2, d: 7.6, col: PAL.shellC },
    { lx: 22, lz: -12, q: 1, w: 5.2, d: 7.2, col: PAL.shellB },
    { lx: 33, lz: -2, q: 0, w: 4.8, d: 6.8, col: PAL.shellD },
    { lx: -25, lz: -4, q: 0, w: 4.8, d: 6.6, col: PAL.shellA },
  ];
  for (const h of HABS) {
    const yaw = sq(h.q);
    const H = 2.9;
    const hw = h.w / 2;
    const hd = h.d / 2;
    // Skids, so the hut sits on the ice rather than in it.
    for (const s of [-1, 1]) {
      parts.push(tag(put(box(0.5, 0.42, h.d * 0.9), h.lx + s * hw * 0.72, 0.21, h.lz, yaw), PAL.steelDark));
    }
    parts.push(tag(put(box(h.w, H, h.d), h.lx, 0.42 + H / 2, h.lz, yaw), h.col));
    // A curved roof: a low half-cylinder lying along the module, its lower
    // half buried in the box below it.
    parts.push(
      tag(put(cyl(hw, hw, h.d, low ? 6 : 10), h.lx, 0.42 + H - hw * 0.28, h.lz, yaw, Math.PI / 2), PAL.shellD),
    );
    /* Window bands, on both long sides — a hut lit on one side only is a hut
     * that goes dark from half the compass, and half the compass here is the
     * half the city is on.
     *
     * Offset first, place second. `put` composes, so an inner call puts the
     * band out along the module's *own* X and the outer call then carries it
     * round with the module's yaw. Doing the offset in the outer call instead
     * puts every band inside its own wall, which renders as a hut with no
     * windows at all and no error anywhere. */
    for (const s of [-1, 1]) {
      parts.push(
        tag(
          put(
            put(box(0.1, 0.8, h.d * 0.6), s * (hw + 0.03), 0, 0),
            h.lx,
            0.42 + H * 0.62,
            h.lz,
            yaw,
          ),
          PAL.glass,
          1,
        ),
      );
    }
    // The door end, and the light over it.
    parts.push(
      tag(put(put(box(1.05, 1.9, 0.1), 0, 0, -(hd + 0.03)), h.lx, 0.42 + 0.95, h.lz, yaw), PAL.steelDark),
    );
    parts.push(
      tag(put(put(box(0.5, 0.12, 0.14), 0, 1.15, -(hd + 0.06)), h.lx, 0.42 + 0.95, h.lz, yaw), PAL.lampGlass, 1),
    );
    // The blocker is the box plus the roof; the deck is the crown of the
    // roof, so landing on a hut puts you on top of it rather than inside it.
    const q = h.q % 2 === 0;
    solid(h.lx, h.lz, q ? hw : hd, q ? hd : hw, 0, 0.42 + H + hw * 0.72);
  }

  /* ---- the mess dome ---------------------------------------------------
   *
   * The big one, and the only round building here. It gets a glazed band all
   * the way round rather than windows, so that from any bearing at all it is
   * a ring of warm light — which is the shape the camp is recognised by from
   * the deck.
   */
  const DOME_LX = -19;
  const DOME_LZ = -21;
  const DOME_R = 5.6;
  {
    const dome = new THREE.SphereGeometry(DOME_R, low ? 10 : 16, low ? 5 : 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
    parts.push(tag(put(dome, DOME_LX, 1.5, DOME_LZ), PAL.shellD));
    parts.push(tag(put(cyl(DOME_R, DOME_R * 1.02, 1.0, low ? 10 : 16), DOME_LX, 1.0, DOME_LZ), PAL.glass, 1));
    parts.push(tag(put(cyl(DOME_R * 1.06, DOME_R * 1.06, 0.5, low ? 10 : 16), DOME_LX, 0.25, DOME_LZ), PAL.skirt));
    // One band of colour. A white dome on a white lake under a white sky is
    // a hole in the picture; the rest of the camp is the only warm thing for
    // a kilometre and a half and the biggest building should say so.
    parts.push(tag(put(cyl(DOME_R * 0.995, DOME_R * 1.03, 0.42, low ? 10 : 16), DOME_LX, 1.72, DOME_LZ), PAL.shellC));
    // Instrument mast and a chimney, so it reads as somebody's workplace.
    parts.push(tag(put(cyl(0.07, 0.09, 4.2, 5), DOME_LX + 2.2, DOME_R + 3.0, DOME_LZ - 1.4), PAL.steel));
    parts.push(tag(put(box(1.5, 0.1, 0.1), DOME_LX + 2.2, DOME_R + 5.0, DOME_LZ - 1.4), PAL.steel));
    parts.push(tag(put(cyl(0.22, 0.26, 1.6, 6), DOME_LX - 2.4, DOME_R + 1.2, DOME_LZ + 1.0), PAL.steelDark));
    solid(DOME_LX, DOME_LZ, DOME_R * 0.72, DOME_R * 0.72, 0, 1.5 + DOME_R * 0.86);
  }

  /* ---- the winch house and the tether ----------------------------------
   *
   * The supply line. It comes down from the outer promenade at 362 m radius
   * and 582 m — six metres clear of the ring in both directions, which is the
   * whole of the clearance argument: the island's outermost walkable edge is
   * at 356 and its deck at 588, and a cable that ends *inside* either of them
   * is a cable that ends inside the rock on a day somebody retunes the skirt.
   *
   * It answers the question the camp otherwise begs — why is anybody down
   * here — and it costs one tapered tube and a pod. It is in the near tier
   * only: 760 m of 30 cm cable is a third of a pixel wide from the city, and
   * a sub-pixel line is not a cable, it is a crawling dotted artefact across
   * the one view this world exists for.
   */
  const WINCH_LX = 26;
  const WINCH_LZ = 22;
  const WINCH_TOP = 6.4;
  {
    parts.push(tag(put(box(7, 4.6, 5), WINCH_LX, 2.3, WINCH_LZ, SQUARE), PAL.steelDark));
    parts.push(tag(put(box(7.4, 0.35, 5.4), WINCH_LX, 4.65, WINCH_LZ, SQUARE), PAL.steel));
    parts.push(tag(put(box(1.6, 1.05, 0.12), WINCH_LX, 2.2, WINCH_LZ - 2.55, SQUARE), PAL.glass, 1));
    // The drum, lying across the house, and the fairlead the cable leaves by.
    parts.push(tag(put(cyl(1.5, 1.5, 3.2, low ? 8 : 14), WINCH_LX, 5.9, WINCH_LZ, SQUARE, 0, Math.PI / 2), PAL.steel));
    for (const s of [-1, 1]) {
      parts.push(tag(put(cyl(1.75, 1.75, 0.24, low ? 8 : 14), WINCH_LX + s * 1.7 * Math.cos(SQUARE), 5.9, WINCH_LZ - s * 1.7 * Math.sin(SQUARE), SQUARE, 0, Math.PI / 2), PAL.steelDark));
    }
    parts.push(tag(put(cyl(0.5, 0.75, 1.4, 8), WINCH_LX, WINCH_TOP + 0.7, WINCH_LZ + 1.6), PAL.steelDark));
    solid(WINCH_LX, WINCH_LZ, 3.5, 2.5, 0, 4.83);
  }

  /* ---- the cargo apron -------------------------------------------------
   *
   * Where the tether puts things down, marked out on the ice and lit by the
   * beacon column. Crates are square to the world for the same reason the
   * huts are.
   */
  const APRON_LX = 26;
  const APRON_LZ = 42;
  {
    const crates: Array<[number, number, number, number, number, THREE.Color]> = [
      [-6, -4, 1.8, 1.6, 1.8, PAL.crate],
      [-6, -4 + 1.9, 1.4, 1.2, 1.4, PAL.crateB],
      [-3.4, -6.2, 2.2, 1.5, 1.8, PAL.crateB],
      [5.4, -3.0, 1.9, 1.7, 1.9, PAL.crate],
      [5.4, -3.0, 1.5, 1.3, 1.5, PAL.crateB],
      [6.6, 4.4, 2.4, 1.4, 2.0, PAL.crate],
      [-5.0, 5.8, 1.7, 1.5, 1.7, PAL.crateB],
    ];
    let stackY = 0;
    let lastKey = "";
    for (const [dx, dz, w, h, d, col] of crates) {
      const key = `${dx},${dz}`;
      const y = key === lastKey ? stackY : 0;
      lastKey = key;
      stackY = y + h;
      parts.push(tag(put(box(w, h, d), APRON_LX + dx, y + h / 2, APRON_LZ + dz, SQUARE), col));
      solid(APRON_LX + dx, APRON_LZ + dz, w / 2, d / 2, y, y + h);
    }
  }

  /* ---- lamps -----------------------------------------------------------
   *
   * A post, a hood and a glass. Eighteen of them: round the rink, along the
   * path from the huts to the stair, and on the apron. They are the reason
   * the camp has a *shape* at night rather than being a heap of lit windows,
   * and each one also contributes a point to the light cloud below.
   */
  const RINK_LX = -27;
  const RINK_LZ = 31;
  const RINK_A = 16;
  const RINK_B = 10.5;

  const lampAt: Array<[number, number]> = [];
  for (let i = 0; i < (low ? 8 : 12); i++) {
    const a = (i / (low ? 8 : 12)) * Math.PI * 2;
    lampAt.push([RINK_LX + Math.sin(a) * (RINK_A + 2.4), RINK_LZ + Math.cos(a) * (RINK_B + 2.4)]);
  }
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    lampAt.push([-1.8 + t * 1.0, 4 + t * 13]);
  }
  lampAt.push([APRON_LX - 9, APRON_LZ - 8]);
  lampAt.push([APRON_LX + 9, APRON_LZ + 8]);
  lampAt.push([WINCH_LX - 5.5, WINCH_LZ - 4]);
  for (const [lx, lz] of lampAt) {
    parts.push(tag(put(cyl(0.075, 0.11, 3.3, 5), lx, 1.65, lz), PAL.steelDark));
    parts.push(tag(put(cyl(0.34, 0.16, 0.3, 6), lx, 3.5, lz), PAL.steelDark));
    parts.push(tag(put(ico(0.22, 0), lx, 3.24, lz), PAL.lampGlass, 1));
  }

  /* ---- braziers --------------------------------------------------------
   *
   * Two, one on the deck and one by the huts, and they are the warmest thing
   * in the frame. The fire itself is in the light cloud, where it can flicker
   * without costing a draw of its own.
   */
  const BRAZIERS: Array<[number, number, number]> = [
    [-4.4, LOOK_LZ - 3.6, LOOK_DECK],
    [0, -2, 0],
  ];
  for (const [lx, lz, base] of BRAZIERS) {
    parts.push(tag(put(cyl(0.62, 0.42, 0.7, 8), lx, base + 0.75, lz), PAL.steelDark));
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      parts.push(tag(put(cyl(0.05, 0.07, 0.9, 4), lx + Math.sin(a) * 0.34, base + 0.45, lz + Math.cos(a) * 0.34, 0, 0, 0), PAL.steelDark));
    }
    parts.push(tag(put(cyl(0.5, 0.5, 0.12, 8), lx, base + 1.06, lz), PAL.ember, 1));
  }

  /* ---- the sign --------------------------------------------------------
   * A lit board at the foot of the stair. No text — there is no way to draw a
   * legible word procedurally at this size — but a board with a warm face and
   * a coloured bar on it says "somebody put this here", which is the whole
   * job. */
  {
    const lx = 3.2;
    const lz = 12;
    for (const s of [-1, 1]) parts.push(tag(put(cyl(0.06, 0.08, 2.1, 5), lx + s * 0.75, 1.05, lz), PAL.steelDark));
    parts.push(tag(put(box(2.0, 0.9, 0.08), lx, 1.75, lz, faceYaw * 0 + 0), PAL.glass, 0.8));
    parts.push(tag(put(box(1.7, 0.16, 0.1), lx, 1.98, lz - 0.02), PAL.shellA, 0.9));
  }

  const shellGeo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!shellGeo) throw new Error("lakeside: nothing to merge");
  shellGeo.computeBoundingSphere();
  const shells = new THREE.Mesh(shellGeo, shellMat);
  shells.name = "lakeside-shells";
  group.add(shells);

  /* =======================================================================
   * The ice: ridges, drifts, and the things that are only in the surface
   * ==================================================================== */

  /**
   * Keep a scatter off the built ground. Circles, in camp-local metres.
   *
   * Derived from the layout rather than typed a second time. A hand-written
   * copy of five hut coordinates is a list that goes stale the first time
   * anybody moves a hut, and the symptom is a two-metre pressure ridge
   * standing through somebody's kitchen — visible from exactly one angle, on
   * an ice sheet nobody photographs twice.
   */
  const KEEP_OUT: Array<[number, number, number]> = [
    [0, LOOK_LZ, LOOK_R + 3],
    ...HABS.map((h) => [h.lx, h.lz, Math.max(h.w, h.d) * 0.5 + 5] as [number, number, number]),
    [DOME_LX, DOME_LZ, DOME_R + 5],
    [WINCH_LX, WINCH_LZ, 9],
    [APRON_LX, APRON_LZ, 13],
    // The lantern path and the foot of the stair.
    [0, 12, 8],
  ];
  const clearOf = (lx: number, lz: number, pad: number): boolean => {
    for (const [cx, cz, r] of KEEP_OUT) {
      if ((lx - cx) ** 2 + (lz - cz) ** 2 < (r + pad) ** 2) return false;
    }
    // Not on the rink either.
    const ex = (lx - RINK_LX) / (RINK_A + 3);
    const ez = (lz - RINK_LZ) / (RINK_B + 3);
    return ex * ex + ez * ez > 1;
  };

  const iceParts: Geo[] = [];

  /**
   * Pressure ridges.
   *
   * Where two sheets of lake ice push against each other they buckle and
   * throw up a broken wall of slabs — the one feature that makes a frozen
   * lake look frozen rather than paved. Three long shallow arcs of tilted
   * slabs, each slab a box turned at a random angle about all three axes,
   * with the tallest in the middle of the run and the ends dying away into
   * rubble. They are also the only thing here that reads from directly above,
   * because they are the only thing that casts a line.
   */
  function ridgeRun(x0: number, z0: number, x1: number, z1: number, peak: number, r: Rng): void {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(4, Math.round(len / (low ? 5.2 : 3.1)));
    const dx = (x1 - x0) / n;
    const dz = (z1 - z0) / n;
    const ang = Math.atan2(x1 - x0, z1 - z0);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      // A raised sine along the run, so a ridge has a middle.
      const env = Math.sin(Math.PI * t) ** 0.6;
      const h = peak * env * r.range(0.55, 1.25);
      if (h < 0.16) continue;
      const lx = x0 + dx * i + r.gauss() * 0.9;
      const lz = z0 + dz * i + r.gauss() * 0.9;
      if (!clearOf(lx, lz, 2)) continue;
      const w = r.range(0.7, 2.1);
      const d = r.range(0.5, 1.5);
      iceParts.push(
        tag(
          put(
            box(w, h * r.range(1.1, 1.9), d),
            lx,
            h * 0.28,
            lz,
            ang + r.gauss() * 0.6,
            r.gauss() * 0.42,
            r.gauss() * 0.5,
          ),
          r.chance(0.32) ? PAL.iceSlabDeep : PAL.iceSlab,
        ),
      );
    }
  }
  {
    const r = rng.fork("ridges");
    ridgeRun(-95, -40, 60, -75, 1.5, r);
    ridgeRun(52, 62, 150, 10, 1.9, r);
    ridgeRun(-140, 60, -46, 96, 1.25, r);
    if (!low) {
      ridgeRun(-42, 128, 118, 150, 1.7, r);
      ridgeRun(120, -110, 205, -22, 2.1, r);
    }
  }

  /**
   * Drifts.
   *
   * Snow does not lie evenly on lake ice; it collects in long tails downwind
   * of anything standing up, and scours to bare ice everywhere else. So the
   * drifts here are deliberately *not* a uniform scatter: they trail off the
   * huts and the ridges, which is what makes the wind on this lake read as
   * having a direction.
   */
  {
    const r = rng.fork("drifts");
    const n = low ? 22 : 44;
    for (let i = 0; i < n; i++) {
      const a = r.range(0, Math.PI * 2);
      const d = 14 + r.next() ** 0.6 * (low ? 150 : 250);
      const lx = Math.sin(a) * d;
      const lz = Math.cos(a) * d;
      if (!clearOf(lx, lz, 3)) continue;
      const g = ico(r.range(1.6, 5.2), low ? 0 : 1);
      g.scale(r.range(0.9, 2.4), r.range(0.12, 0.3), 1);
      iceParts.push(tag(put(g, lx, -0.1, lz, r.range(0, Math.PI)), PAL.snow));
    }
    // Tails against the windward side of every hut, which is what a camp
    // actually looks like after a night of it.
    for (const h of HABS) {
      const g = ico(3.2, low ? 0 : 1);
      g.scale(2.6, 0.16, 0.9);
      iceParts.push(tag(put(g, h.lx + h.w * 0.5 + 3.4, -0.12, h.lz + 3.6, sq(h.q) + 0.4), PAL.snow));
    }
  }

  const iceGeo = mergeGeometries(iceParts, false);
  for (const p of iceParts) p.dispose();
  const icework = iceGeo ? new THREE.Mesh(iceGeo, iceMat) : null;
  if (icework && iceGeo) {
    iceGeo.computeBoundingSphere();
    icework.name = "lakeside-icework";
    group.add(icework);
  }

  /* =======================================================================
   * The surface of the ice
   *
   * Everything here is flat, transparent, writes no depth, and sits at a
   * render order *above* the lake — see the note at the top of the file.
   * One instanced quad, four kinds, one draw.
   * ==================================================================== */

  const DECAL_VERT = /* glsl */ `
    attribute float aKind;
    attribute float aSeed;
    attribute vec3 aTint;
    varying vec2 vUv;
    varying float vKind;
    varying float vSeed;
    varying vec3 vTint;
    void main() {
      vUv = uv;
      vKind = aKind;
      vSeed = aSeed;
      vTint = aTint;
      vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const DECAL_FRAG = /* glsl */ `
    precision highp float;
    uniform float uNight;
    uniform float uTime;
    varying vec2 vUv;
    varying float vKind;
    varying float vSeed;
    varying vec3 vTint;

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p); vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash21(i), hash21(i + vec2(1,0)), f.x),
                 mix(hash21(i + vec2(0,1)), hash21(i + vec2(1,1)), f.x), f.y);
    }

    void main() {
      vec2 p = vUv - 0.5;
      /* Every kind is masked by the same soft ellipse. A decal with a corner
         on it is a square of paint lying on a lake, and one of them in a
         frame is enough to tell you the ice is a texture. */
      float mask = pow(clamp(1.0 - length(p) * 2.0, 0.0, 1.0), 1.4);
      float a = 0.0;
      vec3 col = vTint;

      if (vKind < 0.5) {
        /* Wind scour: streaks running one way, hard-edged across and soft
           along, which is what the wind leaves. */
        float s = vnoise(vec2(p.x * 26.0 + vSeed, p.y * 3.0));
        a = smoothstep(0.42, 0.78, s) * 0.55;
      } else if (vKind < 1.5) {
        /* Swept ice: the rink. Slightly darker and bluer than the lake, with
           arcs cut into it. Nothing says "somebody skates here" like the
           marks of somebody skating. */
        float rr = length(p * vec2(1.0, 1.55));
        float arcs = vnoise(vec2(atan(p.y, p.x) * 3.4 + vSeed, rr * 34.0));
        a = 0.34 + smoothstep(0.55, 0.95, arcs) * 0.4;
      } else if (vKind < 2.5) {
        /* Frozen-in bubbles: stacks of gas caught in the ice as it made. Read
           from directly above and almost invisible from a low angle, which is
           exactly right — you find them by looking down at your feet. */
        float b = 0.0;
        for (int i = 0; i < 5; i++) {
          float fi = float(i);
          vec2 c = vec2(hash21(vec2(vSeed + fi, 3.1)), hash21(vec2(vSeed + fi, 7.7))) - 0.5;
          float rad = 0.06 + hash21(vec2(vSeed + fi, 11.3)) * 0.13;
          b = max(b, smoothstep(rad, rad * 0.35, length(p - c * 0.72)));
        }
        a = b * 0.7;
      } else {
        /* Melt-and-refreeze: a smooth clear pane, brighter at the rim. */
        float rr = length(p) * 2.0;
        a = (smoothstep(0.15, 0.95, rr) * 0.5 + 0.16) * (1.0 - smoothstep(0.92, 1.0, rr));
      }

      /* At night the ice keeps only what the camp is throwing at it. Without
         this the scour marks stay as bright at midnight as at sunset and the
         lake glows faintly all night for no reason anybody can point at. */
      float lit = mix(0.34, 1.0, 1.0 - uNight * 0.66);
      gl_FragColor = vec4(col, a * mask * lit);
      if (gl_FragColor.a < 0.004) discard;
    }
  `;

  const decalMat = new THREE.ShaderMaterial({
    name: "EmpyreanLakesideDecal",
    vertexShader: DECAL_VERT,
    fragmentShader: DECAL_FRAG,
    uniforms: { uNight: shared.uNight, uTime: shared.uTime },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    /* No fog, for the same reason the lake itself has none: these are the
       surface of a transparent plane that is already unfogged, and a fogged
       decal on an unfogged mirror is a scour mark that goes grey while the
       ice under it does not. */
    fog: false,
  });

  const decalPlane = new THREE.PlaneGeometry(1, 1);
  decalPlane.rotateX(-Math.PI / 2);
  const DECAL_N = low ? 58 : 118;
  const decals = new THREE.InstancedMesh(decalPlane, decalMat, DECAL_N);
  decals.name = "lakeside-decals";
  decals.frustumCulled = false;
  /* Above the lake, which is at 10. The lake is transparent with no depth
     write, so anything at a lower render order is simply painted over by it
     and the ice loses its surface again. */
  decals.renderOrder = 11;
  {
    const kinds = new Float32Array(DECAL_N);
    const seeds = new Float32Array(DECAL_N);
    const tints = new Float32Array(DECAL_N * 3);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const e = new THREE.Euler();
    const r = rng.fork("decals");
    const set = (i: number, lx: number, lz: number, w: number, d: number, yaw: number, kind: number, tint: THREE.Color) => {
      e.set(0, yaw, 0);
      q.setFromEuler(e);
      pos.set(lx, 0.06, lz);
      scl.set(w, 1, d);
      m.compose(pos, q, scl);
      decals.setMatrixAt(i, m);
      kinds[i] = kind;
      seeds[i] = r.range(0, 40);
      tints[i * 3] = tint.r;
      tints[i * 3 + 1] = tint.g;
      tints[i * 3 + 2] = tint.b;
    };
    const scour = new THREE.Color("#dceaf6");
    const rinkCol = new THREE.Color("#bcd8ee");
    const bubble = new THREE.Color("#eaf5ff");
    const pane = new THREE.Color("#a9c9e4");
    let i = 0;
    // The rink first, so it is never crowded out by the scatter.
    set(i++, RINK_LX, RINK_LZ, RINK_A * 2.2, RINK_B * 2.2, 0.2, 1, rinkCol);
    while (i < DECAL_N) {
      const a = r.range(0, Math.PI * 2);
      const d = 10 + r.next() ** 0.55 * (low ? 165 : 275);
      const lx = Math.sin(a) * d;
      const lz = Math.cos(a) * d;
      if (!clearOf(lx, lz, 1)) {
        set(i++, lx, lz, 0.001, 0.001, 0, 0, scour);
        continue;
      }
      const roll = r.next();
      if (roll < 0.46) set(i++, lx, lz, r.range(9, 26), r.range(4, 12), r.range(0, Math.PI), 0, scour);
      else if (roll < 0.74) set(i++, lx, lz, r.range(2.2, 6), r.range(2.2, 6), r.range(0, Math.PI), 2, bubble);
      else set(i++, lx, lz, r.range(5, 15), r.range(4, 12), r.range(0, Math.PI), 3, pane);
    }
    decals.geometry.setAttribute("aKind", new THREE.InstancedBufferAttribute(kinds, 1));
    decals.geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
    decals.geometry.setAttribute("aTint", new THREE.InstancedBufferAttribute(tints, 3));
    decals.instanceMatrix.needsUpdate = true;
  }
  group.add(decals);

  /* ---- cracks lit from beneath -----------------------------------------
   *
   * Thin ribbons following broken polylines out from under the camp,
   * additive, pulsing very slowly. They are nearly invisible at the signature
   * hour and they are the best thing on the ice at midnight, which is the
   * correct way round: the sunset already has the sky, and the night has
   * nothing until you give the ground something.
   */
  const crackParts: Geo[] = [];
  {
    const r = rng.fork("cracks");
    const runs = low ? 5 : 11;
    for (let k = 0; k < runs; k++) {
      let a = r.range(0, Math.PI * 2);
      let x = Math.sin(a) * r.range(16, 34);
      let z = Math.cos(a) * r.range(16, 34);
      const segs = low ? 5 : 9;
      const pos: number[] = [];
      const idx: number[] = [];
      const uv: number[] = [];
      for (let i = 0; i <= segs; i++) {
        const w = 0.16 * (1 - i / (segs + 2)) + 0.05;
        const nx = Math.cos(a);
        const nz = -Math.sin(a);
        pos.push(x + nx * w, 0.07, z + nz * w, x - nx * w, 0.07, z - nz * w);
        const t = i / segs;
        uv.push(t, 0, t, 1);
        if (i > 0) {
          const b = (i - 1) * 2;
          idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
        }
        const step = r.range(7, 17);
        x += Math.sin(a) * step;
        z += Math.cos(a) * step;
        a += r.gauss() * 0.35;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      const n = pos.length / 3;
      const seed = new Float32Array(n).fill(r.range(0, 20));
      g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
      crackParts.push(g);
    }
  }
  const crackGeo = mergeGeometries(crackParts, false);
  for (const p of crackParts) p.dispose();

  const crackMat = new THREE.ShaderMaterial({
    name: "EmpyreanLakesideCracks",
    uniforms: { uNight: shared.uNight, uTime: shared.uTime },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    vertexShader: /* glsl */ `
      attribute float aSeed;
      varying vec2 vUv;
      varying float vSeed;
      void main() {
        vUv = uv;
        vSeed = aSeed;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uNight;
      uniform float uTime;
      varying vec2 vUv;
      varying float vSeed;
      void main() {
        /* Bright down the spine, gone at the edges, and dying away along the
           run so a crack ends rather than stopping. */
        float across = 1.0 - abs(vUv.y - 0.5) * 2.0;
        float along = (1.0 - vUv.x) * smoothstep(0.0, 0.12, vUv.x);
        float pulse = 0.62 + 0.38 * sin(uTime * 0.55 + vSeed + vUv.x * 3.0);
        vec3 col = mix(vec3(0.42, 0.78, 1.0), vec3(0.72, 0.92, 1.0), across);
        /* Half the strength it was first built at. Additive light on a lake
           that is already the brightest thing in the frame at dusk clips
           straight to white, and eleven white lines radiating from a camp
           read as light beams rather than as cracks with something under
           them. They should be almost invisible at the signature hour and
           the best thing on the ice at midnight. */
        float a = pow(across, 2.2) * along * pulse * (0.05 + uNight * 0.38);
        gl_FragColor = vec4(col * (0.35 + across * 0.5), a);
        if (gl_FragColor.a < 0.004) discard;
      }
    `,
  });
  const cracks = crackGeo ? new THREE.Mesh(crackGeo, crackMat) : null;
  if (cracks) {
    cracks.name = "lakeside-cracks";
    cracks.renderOrder = 12;
    cracks.frustumCulled = false;
    group.add(cracks);
  }

  /* =======================================================================
   * People
   *
   * Ten skaters on the rink and five standing about — at the rail looking up,
   * which is the thing this whole place is for, and round the brazier. One
   * instanced mesh; a population is instanced or it is a mistake.
   * ==================================================================== */

  const SKATE_N = low ? 8 : 15;
  const STILL_N = 5;
  const figureParts: Geo[] = [];
  figureParts.push(tag(put(cyl(0.19, 0.26, 0.78, 6), 0, 1.02, 0), PAL.coat));
  figureParts.push(tag(put(ico(0.155, 0), 0, 1.56, 0), PAL.skin));
  figureParts.push(tag(put(cyl(0.17, 0.2, 0.12, 6), 0, 1.66, 0), PAL.coatC));
  for (const s of [-1, 1]) {
    figureParts.push(tag(put(cyl(0.085, 0.075, 0.66, 5), s * 0.11, 0.33, 0), PAL.coatB));
    figureParts.push(tag(put(box(0.11, 0.06, 0.34), s * 0.11, 0.03, 0.02), PAL.steel));
  }
  const figureGeo = mergeGeometries(figureParts, false);
  for (const p of figureParts) p.dispose();
  const figures = figureGeo ? new THREE.InstancedMesh(figureGeo, shellMat, SKATE_N + STILL_N) : null;
  if (figures) {
    figures.name = "lakeside-people";
    figures.frustumCulled = false;
    figures.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(figures);
  }

  /** One skater's lap: phase, rate, and how far off the centre line it runs. */
  const laps: Array<{ p: number; rate: number; wob: number; lane: number; tilt: number }> = [];
  {
    const r = rng.fork("skaters");
    for (let i = 0; i < SKATE_N; i++) {
      laps.push({
        p: r.range(0, Math.PI * 2),
        rate: r.range(0.16, 0.30) * (r.chance(0.25) ? -1 : 1),
        wob: r.range(0.4, 2.6),
        lane: r.range(0.42, 0.98),
        tilt: r.range(0.1, 0.26),
      });
    }
  }
  /** The five who are not skating: at the rail, at the fire, on the apron. */
  const STILLS: Array<[number, number, number, number]> = [
    [3.0, LOOK_LZ + 6.4, LOOK_DECK, 0.1],
    [-2.4, LOOK_LZ + 6.9, LOOK_DECK, -0.2],
    [-4.4, LOOK_LZ - 2.2, LOOK_DECK, 2.5],
    [2.6, -3.4, 0, -1.4],
    [APRON_LX - 3.4, APRON_LZ - 2.0, 0, 1.9],
  ];

  /* =======================================================================
   * The tether
   * ==================================================================== */

  /** World radius and height the cable is moored at, on the outer promenade. */
  const ANCHOR_R = 362;
  const ANCHOR_Y = 582;
  const headL = new THREE.Vector3(WINCH_LX, WINCH_TOP + 1.1, WINCH_LZ);
  const anchorL = new THREE.Vector3(
    WINCH_LX,
    ANCHOR_Y - ICE_Y,
    CAMP_RANGE - Math.sqrt(ANCHOR_R * ANCHOR_R - WINCH_LX * WINCH_LX),
  );
  const cableLen = headL.distanceTo(anchorL);

  /* A stock material rather than a shader of its own, and deliberately.
   *
   * A `ShaderMaterial` with `fog: true` and no `UniformsLib.fog` merged into
   * its uniforms does not render without fog — it throws on the first frame,
   * inside `refreshFogUniforms`, reaching through a uniform that is not
   * there. The cable wants nothing a basic material cannot do: one colour,
   * proper fog, and an opacity the frame writes. */
  const cableMat = new THREE.MeshBasicMaterial({
    name: "EmpyreanLakesideCable",
    color: new THREE.Color("#2b313b"),
    transparent: true,
    opacity: 1,
    side: THREE.DoubleSide,
    fog: true,
  });

  const cableGeo = new THREE.CylinderGeometry(0.22, 0.34, cableLen, 6, 1, true);
  const cable = new THREE.Mesh(cableGeo, cableMat);
  cable.name = "lakeside-cable";
  cable.position.copy(headL).add(anchorL).multiplyScalar(0.5);
  cable.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    anchorL.clone().sub(headL).normalize(),
  );
  group.add(cable);

  /** The climber: a lit pod that goes up the line and comes back down. */
  const podParts: Geo[] = [];
  podParts.push(tag(box(2.4, 2.6, 2.4), PAL.shellB));
  podParts.push(tag(put(box(2.6, 0.3, 2.6), 0, 1.45, 0), PAL.steelDark));
  podParts.push(tag(put(box(1.7, 0.9, 0.1), 0, 0.2, 1.25), PAL.glass, 1));
  podParts.push(tag(put(box(0.1, 0.9, 1.7), 1.25, 0.2, 0), PAL.glass, 1));
  const podGeo = mergeGeometries(podParts, false);
  for (const p of podParts) p.dispose();
  const pod = podGeo ? new THREE.Mesh(podGeo, shellMat) : null;
  if (pod) {
    pod.name = "lakeside-pod";
    group.add(pod);
  }

  /* =======================================================================
   * The beacon column, and the lights
   *
   * These two are the entire long-range read, and between them they are two
   * draw calls. Everything else in this file can be switched off without the
   * camp disappearing from the deck.
   * ==================================================================== */

  const beaconMat = new THREE.ShaderMaterial({
    name: "EmpyreanLakesideBeacon",
    uniforms: { uNight: shared.uNight, uTime: shared.uTime },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    vertexShader: /* glsl */ `
      varying float vH;
      varying vec3 vNrm;
      varying vec3 vView;
      void main() {
        /* The gradient runs on the object's own height, never on world Y.
           Nothing here is reflected, but the rule is cheap to keep and the
           day somebody does put a column in the lake is not the day to find
           out it comes out upside down. */
        vH = uv.y;
        vNrm = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uNight;
      uniform float uTime;
      varying float vH;
      varying vec3 vNrm;
      varying vec3 vView;
      void main() {
        float up = pow(1.0 - vH, 1.7);
        /* Edge-on is where a light shaft is brightest; face-on you are
           looking through the least of it. */
        float rim = pow(1.0 - abs(dot(normalize(vNrm), normalize(vView))), 1.6);
        float pulse = 0.84 + 0.16 * sin(uTime * 0.9);
        vec3 col = mix(vec3(1.0, 0.74, 0.40), vec3(0.55, 0.86, 1.0), vH * 0.75);
        gl_FragColor = vec4(col, up * rim * pulse * (0.10 + uNight * 0.5) * 0.55);
        if (gl_FragColor.a < 0.003) discard;
      }
    `,
  });
  const beaconGeo = new THREE.CylinderGeometry(2.4, 5.4, 68, low ? 8 : 14, 1, true);
  const beacon = new THREE.Mesh(beaconGeo, beaconMat);
  beacon.name = "lakeside-beacon";
  beacon.position.set(APRON_LX, 34, APRON_LZ);
  beacon.renderOrder = 13;
  group.add(beacon);

  /* ---- the light cloud ------------------------------------------------- */

  const lightPos: number[] = [];
  const lightCol: number[] = [];
  const lightSize: number[] = [];
  const lightFlick: number[] = [];
  const addLight = (lx: number, y: number, lz: number, c: THREE.Color, size: number, flick = 0) => {
    lightPos.push(lx, y, lz);
    lightCol.push(c.r, c.g, c.b);
    lightSize.push(size);
    lightFlick.push(flick);
  };
  const warm = new THREE.Color("#ffc07a");
  const cool = new THREE.Color("#8fd6ff");
  for (const [lx, lz] of lampAt) addLight(lx, 3.3, lz, warm, 1.5);
  for (const h of HABS) addLight(h.lx, 2.2, h.lz, warm, 2.6);
  addLight(DOME_LX, 1.4, DOME_LZ, warm, 4.4);
  addLight(WINCH_LX, 2.2, WINCH_LZ - 2.6, warm, 2.0);
  addLight(APRON_LX, 1.0, APRON_LZ, cool, 5.0, 1);
  addLight(0, LOOK_DECK + 1.2, LOOK_LZ, warm, 3.0);
  for (const [lx, lz, base] of BRAZIERS) addLight(lx, base + 1.35, lz, new THREE.Color("#ff8a3a"), 3.4, 2);
  addLight(WINCH_LX, WINCH_TOP + 1.4, WINCH_LZ, cool, 1.8, 1);

  const lightGeo = new THREE.BufferGeometry();
  lightGeo.setAttribute("position", new THREE.Float32BufferAttribute(lightPos, 3));
  lightGeo.setAttribute("aColor", new THREE.Float32BufferAttribute(lightCol, 3));
  lightGeo.setAttribute("aSize", new THREE.Float32BufferAttribute(lightSize, 1));
  lightGeo.setAttribute("aFlick", new THREE.Float32BufferAttribute(lightFlick, 1));
  lightGeo.computeBoundingSphere();

  const lightMat = new THREE.ShaderMaterial({
    name: "EmpyreanLakesideLights",
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: { uNight: shared.uNight, uTime: shared.uTime },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aFlick;
      uniform float uTime;
      varying vec3 vCol;
      varying float vOn;
      void main() {
        vCol = aColor;
        /* 0 steady, 1 slow beacon blink, 2 firelight. The fire is the only
           one that is allowed to be irregular; a lamp that flickers reads as
           a lamp about to fail, which is not this world's mood. */
        vOn = aFlick < 0.5
          ? 1.0
          : (aFlick < 1.5
              ? 0.35 + 0.65 * step(0.5, fract(uTime * 0.42))
              : 0.72 + 0.28 * sin(uTime * 7.3 + position.x));
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        /* The same screen-space floor the spaceport uses, and for the same
           reason: a 30 cm porch light a kilometre and a quarter away is a
           third of a pixel, and a third of a pixel with a radial falloff on
           it is nothing at all. The whole argument for building a camp down
           here is that somebody standing on the rim can see it. */
        gl_PointSize = clamp(aSize * 620.0 / max(-mv.z, 1.0), 2.6, 42.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uNight;
      varying vec3 vCol;
      varying float vOn;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float f = pow(clamp(1.0 - length(d) * 2.0, 0.0, 1.0), 2.0);
        gl_FragColor = vec4(vCol * (0.5 + f) * 2.4, f * (0.16 + uNight * 0.84) * vOn);
        if (gl_FragColor.a < 0.006) discard;
      }
    `,
  });
  const lights = new THREE.Points(lightGeo, lightMat);
  lights.name = "lakeside-lights";
  lights.renderOrder = 14;
  group.add(lights);

  /* =======================================================================
   * State and frame
   * ==================================================================== */

  const lookWorld = new THREE.Vector3(
    toWorldX(0, LOOK_LZ),
    ICE_Y + LOOK_DECK,
    toWorldZ(0, LOOK_LZ),
  );
  const scopeWorld = new THREE.Vector3(
    toWorldX(0, SCOPE_LZ),
    ICE_Y + LOOK_DECK + 1.9,
    toWorldZ(0, SCOPE_LZ),
  );
  const fireWorld = new THREE.Vector3(
    toWorldX(BRAZIERS[1][0], BRAZIERS[1][1]),
    ICE_Y + 1.0,
    toWorldZ(BRAZIERS[1][0], BRAZIERS[1][1]),
  );

  let onScreen = true;
  let detailed = true;
  let scopeLine = 0;

  /* Scratch. Hoisted, because `update` runs for every frame of the descent
     and a fresh Vector3 per skater per frame is a collector pause you can
     see on the one shot this feature exists for. */
  const _fwd = new THREE.Vector3();
  const _mat = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3(1, 1, 1);

  const handle: LakesideHandle = {
    name: "lakeside",
    group,
    /**
     * Not in the lake, and not for cost.
     *
     * Everything here stands *on* the mirror. Its reflection is its own
     * underside, one metre below a surface that keeps 30–55% of its own
     * colour: invisible, and drawn twice.
     */
    reflected: false,
    blockers,
    decks,
    look: lookWorld as Readonly<THREE.Vector3>,
    get onScreen(): boolean {
      return onScreen;
    },
    get detailed(): boolean {
      return detailed;
    },

    interactables(): Interactable[] {
      return [
        {
          id: "lakeside-scope",
          x: scopeWorld.x,
          y: scopeWorld.y,
          z: scopeWorld.z,
          radius: 5,
          label: "Look through the glass",
          detail: "The Long Look, Mirrorfoot",
          activate: () => {
            const lines = [
              "Six hundred and twenty metres of clear air, and a city on top of it.",
              "That spike under the rock is four hundred metres of keel. It has never touched anything.",
              "The lit ring on the near terrace is the promenade. The tether lands just under it.",
              "Kestrel Field is the dark oval under the keel's point, on the far shore.",
            ];
            handle.onToast?.(lines[scopeLine % lines.length], "info");
            scopeLine++;
          },
        },
        {
          id: "lakeside-fire",
          x: fireWorld.x,
          y: fireWorld.y,
          z: fireWorld.z,
          radius: 4,
          label: "Warm your hands",
          detail: "Mirrorfoot camp",
          activate: () => {
            handle.onToast?.("Somebody hands you a cup. Nobody down here asks why you came.", "good");
          },
        },
      ];
    },

    update(frame: FrameContext): void {
      const cam = frame.camera;
      const dx = cam.position.x - CAMP_X;
      const dz = cam.position.z - CAMP_Z;
      const dy = cam.position.y - ICE_Y;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      /* Is the camp worth submitting at all?
       *
       * Within 900 m the answer is always yes — you may be looking at your
       * own feet standing in the middle of it. Beyond that it is a cone test
       * about the camera's forward, generous enough that the camp is already
       * drawn by the time it enters the frame rather than popping into it. */
      if (dist < 900) {
        onScreen = true;
      } else {
        cam.getWorldDirection(_fwd);
        const limit = Math.cos(Math.min(Math.PI * 0.98, ((cam.fov * Math.PI) / 180) * 0.9 + 0.55));
        /* (dx, dy, dz) points from the camp *to* the camera, so the vector
           the camera is asking about is its negation. */
        onScreen = (-dx * _fwd.x - dy * _fwd.y - dz * _fwd.z) / dist > limit;
      }
      group.visible = onScreen;
      if (!onScreen) return;

      shared.uTime.value = frame.time;
      shared.uNight.value = clamp01(1 - (frame.daylight - 0.28) / 0.46);
      (shared.uSun.value as THREE.Vector3).copy(frame.sunDir);

      shells.visible = dist < SHELL_R;

      /* The near tier. Everything that only means anything at close range,
         switched as one so there is a single number to reason about. */
      detailed = dist < NEAR_R;
      if (icework) icework.visible = detailed;
      decals.visible = detailed;
      if (cracks) cracks.visible = detailed;
      if (figures) figures.visible = detailed;
      /* The tether is near-tier and nothing else, because 760 m of 30 cm
         cable is a third of a pixel from the rim: sub-pixel geometry does not
         render as a thin line, it renders as a crawling dotted artefact drawn
         across the one view this world exists for. What carries the camp at
         that range is the beacon and the lights. Faded rather than switched,
         so it arrives over the last hundred metres of the descent instead of
         appearing in one frame. */
      cable.visible = dist < NEAR_R;
      if (pod) pod.visible = cable.visible;
      cableMat.opacity = 1 - smoothstep(NEAR_R * 0.78, NEAR_R, dist);

      /* ---- the climber ---- */
      if (pod && pod.visible) {
        // Up in ninety seconds, a pause at each end, down in ninety.
        const cyc = (frame.time % 210) / 210;
        let t: number;
        if (cyc < 0.42) t = cyc / 0.42;
        else if (cyc < 0.5) t = 1;
        else if (cyc < 0.92) t = 1 - (cyc - 0.5) / 0.42;
        else t = 0;
        const ease = t * t * (3 - 2 * t);
        pod.position.lerpVectors(headL, anchorL, ease * 0.985 + 0.005);
        pod.quaternion.copy(cable.quaternion);
      }

      /* ---- the skaters ---- */
      if (figures && figures.visible) {
        for (let i = 0; i < SKATE_N; i++) {
          const l = laps[i];
          const a = l.p + frame.time * l.rate;
          const wob = Math.sin(a * 3 + l.wob) * 1.6;
          const ax = RINK_LX + Math.sin(a) * (RINK_A * l.lane + wob);
          const az = RINK_LZ + Math.cos(a) * (RINK_B * l.lane + wob * 0.6);
          // Facing: the tangent of the ellipse, which is not the tangent of a
          // circle, and a skater who faces the wrong way is the only thing on
          // this rink anybody would notice.
          const tx = Math.cos(a) * RINK_A * l.lane * Math.sign(l.rate);
          const tz = -Math.sin(a) * RINK_B * l.lane * Math.sign(l.rate);
          _e.set(Math.sin(a * 2 + l.wob) * 0.05, Math.atan2(tx, tz), Math.sin(a) * l.tilt * Math.sign(l.rate));
          _q.setFromEuler(_e);
          _p.set(ax, Math.abs(Math.sin(a * 6 + l.wob)) * 0.05, az);
          _mat.compose(_p, _q, _s);
          figures.setMatrixAt(i, _mat);
        }
        for (let i = 0; i < STILL_N; i++) {
          const [lx, lz, base, yaw] = STILLS[i];
          _e.set(0, yaw, 0);
          _q.setFromEuler(_e);
          _p.set(lx, base, lz);
          _mat.compose(_p, _q, _s);
          figures.setMatrixAt(SKATE_N + i, _mat);
        }
        figures.instanceMatrix.needsUpdate = true;
      }
    },

    dispose(): void {
      decals.dispose();
      figures?.dispose();
      shellGeo.dispose();
      iceGeo?.dispose();
      figureGeo?.dispose();
      podGeo?.dispose();
      crackGeo?.dispose();
      decalPlane.dispose();
      cableGeo.dispose();
      beaconGeo.dispose();
      lightGeo.dispose();
      shellMat.dispose();
      iceMat.dispose();
      decalMat.dispose();
      crackMat.dispose();
      cableMat.dispose();
      beaconMat.dispose();
      lightMat.dispose();
    },
  };

  return handle;
}

/* =========================================================================
 * Known, and not fixed here
 *
 * **The snowfield is still void.** `ICE_DECK` stops at `LAKE_R`, so a body
 * that walks off the ice onto the snow falls through it to `KILL_Y` and is
 * put back on the Halo. That was true of the whole world before this file and
 * is still true 620 m below and 1.5 km out; what has changed is that it is
 * now *reachable on foot*, because there is finally a reason to be standing
 * on the lake. The real fix is not another deck — the snow is a height field
 * and a `Deck` is flat — it is a ground hook on `CollisionWorld` that
 * `terrain.ts` can answer, and that is `collide.ts`'s call to make.
 * ====================================================================== */
