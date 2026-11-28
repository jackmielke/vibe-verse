/**
 * danceFloor — a place in the plaza that is on the beat, and a crew that
 * dances with you.
 *
 * ## Why this exists
 *
 * The music is layered on how many people are dancing near you: hats at two,
 * the lead at three, the stabs at five. That is a good mechanic and, until
 * this, an unreachable one — Vibe City is usually empty, so the overwhelming
 * majority of players who ever press T hear layer one and nothing else, and
 * conclude the feature is a loop. A mechanic that only works when four
 * strangers happen to be online is a mechanic almost nobody has.
 *
 * So the floor comes with regulars. Four code-built pilots stand on it doing
 * nothing much, and when somebody dances near them they join in — staggered a
 * bar apart, so the mix builds over a few seconds instead of snapping on.
 * Dance here alone and you still get the full track, because you are not
 * alone; and the count is honest, because they really are dancing, on the same
 * clock, in the same rig, through the same code path as a remote player.
 *
 * ## The floor is the clock, made visible
 *
 * Every panel is driven by `cityBeats()` — the same absolute wall-clock beat
 * the dances and the music read. A checkerboard flips on each beat, a ring
 * travels out from the centre on each downbeat, and the colour follows the
 * four-bar chord cycle. None of that is decoration: it is the one place in the
 * world where you can *see* that the thing everybody is dancing to is a single
 * shared clock rather than a lot of local timers that happen to look alike.
 * Two players on two laptops see the same panel light at the same instant.
 *
 * Panels are one `InstancedMesh` with per-instance colour on an unlit
 * material, which is both the cheap way to do it and the right look — a floor
 * tile that glows in the dark rather than one that waits to be lit.
 */
import * as THREE from "three";
import { cityBeats } from "@/components/city/dances";
import { createDanceCrowd, crewHasJoined } from "@/components/city/danceCrowd";
import { registerPOI, unregisterPOI } from "@/world/worldIndex";

export { crewHasJoined };

export interface DanceFloorOpts {
  center: { x: number; y: number; z: number };
  /** Panels per side. The floor is `tiles * TILE` metres square. */
  tiles?: number;
  /** Which pilots stand on it. Ids from the shared character catalog. */
  crew?: string[];
  /** How close a dancer has to be for the crew to notice, in metres. */
  noticeRadius?: number;
}

export interface DanceFloor {
  group: THREE.Group;
  /**
   * Per-frame. `dancersNearby` is how many real people are dancing within
   * earshot; the crew joins when that is non-zero.
   *
   * Returns how many of the crew are currently dancing, for the music to add
   * to its headcount.
   */
  update(dt: number, playerPos: THREE.Vector3, dancersNearby: number): number;
  /** True while `pos` is over the panels. */
  contains(pos: THREE.Vector3): boolean;
  dispose(): void;
}

const TILE = 1.5;
/** Beyond this the floor stops animating entirely. */
const CULL_DIST = 90;

/**
 * How bright one panel is, from the absolute beat alone.
 *
 * Pure, and exported, because the interesting property is not "does it look
 * nice" — a screenshot answers that — but that it is a function of *nothing
 * except the shared clock*. Two players on two machines light the same panel
 * at the same instant, and a test can hold that to account in a way that
 * looking at two screenshots taken a second apart cannot.
 *
 * `dist` is the panel's distance from the centre, normalised to 0..1.
 * `heat` scales the whole thing: the floor idles low and comes up when
 * somebody is actually dancing on it.
 */
export function panelBrightness(
  i: number,
  j: number,
  dist: number,
  beat: number,
  heat: number,
): number {
  const beatInBar = Math.floor(beat) % 4;
  const phase = beat - Math.floor(beat);
  // Sharp attack, quick decay — so the brightest instant IS the beat, rather
  // than somewhere in the middle of it.
  const pulse = Math.pow(1 - phase, 2.4);
  const checker = (i + j + beatInBar) % 2 === 0 ? 1 : 0;
  // A ring leaving the centre once per beat.
  const ring = Math.max(0, 1 - Math.abs(dist - phase * 1.05) * 6);
  return heat * (0.12 + checker * 0.35 + ring * pulse * 0.9);
}

/**
 * The floor's four colours, one per bar — the chord cycle, as light. The
 * Vibe Arcade's palette (pink, cyan, violet, rose), because the floor sits
 * on the arcade's doorstep and four unrelated neons beside it read as noise.
 */
const BAR_COLORS = [
  new THREE.Color("#ff3fd1"),
  new THREE.Color("#38e8ff"),
  new THREE.Color("#a66bff"),
  new THREE.Color("#ff6aa8"),
];
const DARK = new THREE.Color("#120a24");

export function createDanceFloor(opts: DanceFloorOpts): DanceFloor {
  const tiles = opts.tiles ?? 7;
  const half = (tiles * TILE) / 2;
  const noticeRadius = opts.noticeRadius ?? 14;

  const group = new THREE.Group();
  group.position.set(opts.center.x, opts.center.y, opts.center.z);

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const track = <T extends THREE.BufferGeometry>(g: T) => (geometries.push(g), g);
  const trackM = <T extends THREE.Material>(m: T) => (materials.push(m), m);

  // ---- Panels -------------------------------------------------------------
  const panelGeo = track(new THREE.BoxGeometry(TILE * 0.94, 0.08, TILE * 0.94));
  const panelMat = trackM(
    new THREE.MeshBasicMaterial({ toneMapped: false }),
  );
  const panels = new THREE.InstancedMesh(panelGeo, panelMat, tiles * tiles);
  panels.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const m4 = new THREE.Matrix4();
  /** Normalised distance from the centre, per panel — drives the ring. */
  const panelDist: number[] = [];
  for (let i = 0; i < tiles; i++) {
    for (let j = 0; j < tiles; j++) {
      const idx = i * tiles + j;
      const x = (i - (tiles - 1) / 2) * TILE;
      const z = (j - (tiles - 1) / 2) * TILE;
      m4.makeTranslation(x, 0.04, z);
      panels.setMatrixAt(idx, m4);
      panels.setColorAt(idx, DARK);
      panelDist.push(Math.hypot(x, z) / (half * Math.SQRT2));
    }
  }
  panels.instanceMatrix.needsUpdate = true;
  group.add(panels);

  // A neon kerb, so the floor reads as somewhere to stand rather than as a
  // texture on the plaza.
  const kerbMat = trackM(new THREE.MeshBasicMaterial({ color: 0x38e8ff, toneMapped: false }));
  for (const [dx, dz, w, d] of [
    [0, half + 0.12, half * 2 + 0.36, 0.12],
    [0, -half - 0.12, half * 2 + 0.36, 0.12],
    [half + 0.12, 0, 0.12, half * 2 + 0.36],
    [-half - 0.12, 0, 0.12, half * 2 + 0.36],
  ] as const) {
    const bar = new THREE.Mesh(track(new THREE.BoxGeometry(w, 0.1, d)), kerbMat);
    bar.position.set(dx, 0.06, dz);
    group.add(bar);
  }

  // ---- The regulars -------------------------------------------------------
  /* Four people who already live here. Placed around the edge and facing in,
     which is what makes the middle of the floor read as somewhere to go and
     stand — and placed *unevenly*, because four people at exactly 90° on a
     circle of exactly one radius is the one arrangement no group has ever
     stood in. The behaviour itself lives in `danceCrowd.ts`, shared with the
     club. */
  const crewIds = opts.crew ?? ["pixel", "bumble", "chrome", "sable"];
  const crowd = createDanceCrowd({
    seed: 1,
    spots: crewIds.map((design, i) => {
      const wobble = (n: number) => (Math.sin(n * 12.9898 + i * 78.233) * 43758.5453) % 1;
      const angle = (i / crewIds.length) * Math.PI * 2 + Math.PI / 4 + wobble(1) * 0.5;
      const r = half - TILE * 0.7 - Math.abs(wobble(2)) * TILE * 0.5;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      return {
        design,
        x,
        z,
        y: 0.1,
        yaw: Math.atan2(-x, -z) + wobble(3) * 0.45,
        order: i,
      };
    }),
  });
  group.add(crowd.group);

  registerPOI({
    key: "city-dance-floor",
    name: "The Dance Floor",
    region: "Vibe City",
    kind: "landmark",
    aliases: ["dance floor", "disco", "the floor", "club"],
    position: new THREE.Vector3(opts.center.x, opts.center.y, opts.center.z),
  });

  const color = new THREE.Color();
  /** Scratch, so the per-frame look-at target costs no allocation. */
  const _watch = new THREE.Vector3();
  /** Beat at which the crew started joining, so the stagger is musical. */
  let joinStartBar = 0;
  let wasBusy = false;

  const update = (dt: number, playerPos: THREE.Vector3, dancersNearby: number) => {
    /* Nothing here is visible from across the city, and all of it costs
       something every frame: four solved rigs and forty-nine instance colours.
       Same convention the NPC crew uses — distant things still exist, they
       just stop paying for animation. */
    const far =
      (playerPos.x - group.position.x) ** 2 + (playerPos.z - group.position.z) ** 2 >
      CULL_DIST * CULL_DIST;
    group.visible = !far;
    if (far) {
      /* Zero, and reset. The count this returns feeds the *listener's* music,
         and the listener is ninety metres away — the regulars are not near
         them by any definition, so contributing to their mix would be a party
         they cannot see. State is cleared rather than frozen so that walking
         back does the stagger again from the top. */
      wasBusy = false;
      return 0;
    }

    const b = cityBeats();
    const bar = Math.floor(b / 4);

    // ---- Who is dancing --------------------------------------------------
    const dx = playerPos.x - group.position.x;
    const dz = playerPos.z - group.position.z;
    const near = dx * dx + dz * dz < noticeRadius * noticeRadius;
    const busy = near && dancersNearby > 0;
    // The bar somebody first started is the anchor for the stagger, so the
    // second regular comes in on a bar line rather than 1.7s after the first.
    if (busy && !wasBusy) joinStartBar = bar;
    wasBusy = busy;

    const dancing = crowd.update(dt, _watch.set(playerPos.x - group.position.x, 0, playerPos.z - group.position.z), busy);

    // ---- Panels ----------------------------------------------------------
    /* Idle, the floor breathes on the bar so it still reads as alive and still
       reads as being on a clock. Busy, it takes the full treatment: a
       checkerboard flipping on every beat and a ring leaving the centre on
       each one, decaying so the brightest instant IS the beat. */
    const heat = busy ? 1 : 0.22;
    const tint = BAR_COLORS[bar % BAR_COLORS.length];
    for (let i = 0; i < tiles; i++) {
      for (let j = 0; j < tiles; j++) {
        const idx = i * tiles + j;
        const lit = panelBrightness(i, j, panelDist[idx], b, heat);
        color.copy(DARK).lerp(tint, Math.min(1, lit));
        panels.setColorAt(idx, color);
      }
    }
    if (panels.instanceColor) panels.instanceColor.needsUpdate = true;

    return dancing;
  };

  return {
    group,
    update,
    contains(pos) {
      return (
        Math.abs(pos.x - group.position.x) < half &&
        Math.abs(pos.z - group.position.z) < half
      );
    },
    dispose() {
      unregisterPOI("city-dance-floor");
      crowd.dispose();
      panels.dispose();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      geometries.length = 0;
      materials.length = 0;
    },
  };
}

