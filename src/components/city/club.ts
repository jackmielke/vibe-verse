/**
 * club — THE BASEMENT: a room in Vibe City where the music is the point.
 *
 * Everything built for dancing so far has been outdoors, in a plaza, at
 * whatever time of day the world happens to be in, with four regulars and a
 * lit square of floor. That is a good demo of a system and it is not a place.
 * A club is: enclosed, dark, loud, and full — the room does the work that
 * daylight and open sky were fighting.
 *
 * It is its own realm in the same world. Reached by `/city?spawn=club` or by
 * stepping onto the stairwell disc beside the plaza dance floor, and left the
 * same way. Physically it is three hundred metres under the sea floor, which
 * is where Vibe City keeps its other interiors — the Gremlin Mines are at the
 * same depth on the opposite side. That is not arbitrary. The world is a 360m
 * square of streets ringed by open ocean, so there is no quiet patch of ground
 * to build on: the first version of this stood at sea level out past the city
 * and players spawned *swimming*, inside a windowless black box, which is a
 * very funny screenshot and not a nightclub. Below -40 the swim solver stops
 * looking, and the "you have fallen out of the world" net is told to skip this
 * room the same way it already skips the mines.
 *
 * What is in here:
 *   • a floor of panels on the same `cityBeats()` clock as everything else
 *   • a DJ on a riser behind decks, and stacks that pulse on the kick
 *   • four beams that sweep the room and change colour with the chord
 *   • twenty regulars, from `danceCrowd.ts` — the same behaviour as the
 *     plaza's four, which is the whole reason that module exists
 *
 * The crowd is the part that matters. Twenty dancers means the music's top
 * layer is not something you unlock, it is the room you walked into.
 */
import * as THREE from "three";
import type { WorldBox } from "./cardboardIsland";
import { cityBeats } from "@/components/city/dances";
import { createDanceCrowd, ringSpots } from "@/components/city/danceCrowd";
import { panelBrightness } from "@/components/city/danceFloor";
import { buildProceduralPilot } from "@/components/city/proceduralPilot";

export interface ClubOpts {
  centerX: number;
  centerZ: number;
  floorY: number;
  /** Collision boxes to push the room's floor and walls into. */
  boxes: WorldBox[];
}

export interface ClubWorld {
  group: THREE.Group;
  /** `playerPos` is world-space. Returns how many regulars are dancing. */
  update(dt: number, playerPos: THREE.Vector3, playerDancing: boolean): number;
  /** Where `?spawn=club` drops you — just inside the door, facing the DJ. */
  spawn: THREE.Vector3;
  /** Standing here sends you back to the plaza. */
  exit: THREE.Vector3;
  /** True while the player is inside the four walls. */
  contains(pos: THREE.Vector3): boolean;
  dispose(): void;
}

/** Interior half-extents. The room is 34 × 26 with a 7m ceiling. */
const HALF_X = 17;
const HALF_Z = 13;
const CEIL = 7;
const WALL = 1;
/** Dance floor panels. */
const TILE = 1.7;
const COLS = 11;
const ROWS = 8;

const BEAM_COLORS = [0xff4fd8, 0x7df0ff, 0x8bf07a, 0xffc94a];
const DARK = new THREE.Color("#0a0c14");

const CROWD_DESIGNS = [
  "pixel", "bumble", "chrome", "sable", "aurora", "grimlock",
  "voltaic", "seraph", "stinger", "jelly", "mothling", "phase",
];

export function createClub(opts: ClubOpts): ClubWorld {
  const { centerX, centerZ, floorY, boxes } = opts;
  const group = new THREE.Group();
  group.position.set(centerX, floorY, centerZ);

  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const G = <T extends THREE.BufferGeometry>(g: T) => (geos.push(g), g);
  const M = <T extends THREE.Material>(m: T) => (mats.push(m), m);

  // ---- The room ------------------------------------------------------------
  /* Unlit materials throughout. The city's sun and its day/night cycle have no
     business in here — an interior that dims when the world outside does is an
     interior with a hole in the roof. Everything you can see is either painted
     dark or lit by the club's own fixtures. */
  const wallMat = M(new THREE.MeshBasicMaterial({ color: 0x20263a }));
  const floorMat = M(new THREE.MeshBasicMaterial({ color: 0x0d1018 }));

  const floor = new THREE.Mesh(G(new THREE.BoxGeometry(HALF_X * 2, 0.4, HALF_Z * 2)), floorMat);
  floor.position.y = -0.2;
  group.add(floor);
  boxes.push({
    minX: centerX - HALF_X, maxX: centerX + HALF_X,
    minZ: centerZ - HALF_Z, maxZ: centerZ + HALF_Z,
    base: floorY - 4, height: floorY,
  });

  const ceiling = new THREE.Mesh(G(new THREE.BoxGeometry(HALF_X * 2, 0.4, HALF_Z * 2)), wallMat);
  ceiling.position.y = CEIL;
  group.add(ceiling);

  /* Walls, with collision, so the room is a room. Without boxes you can walk
     straight out of the back of it and stand in the sea looking at the set
     from behind, which is the single fastest way to stop believing in a
     place. */
  const wallSpecs: [number, number, number, number][] = [
    [0, -HALF_Z - WALL / 2, HALF_X * 2 + WALL * 2, WALL],
    [0, HALF_Z + WALL / 2, HALF_X * 2 + WALL * 2, WALL],
    [-HALF_X - WALL / 2, 0, WALL, HALF_Z * 2],
    [HALF_X + WALL / 2, 0, WALL, HALF_Z * 2],
  ];
  for (const [wx, wz, sx, sz] of wallSpecs) {
    const w = new THREE.Mesh(G(new THREE.BoxGeometry(sx, CEIL, sz)), wallMat);
    w.position.set(wx, CEIL / 2, wz);
    group.add(w);
    boxes.push({
      minX: centerX + wx - sx / 2, maxX: centerX + wx + sx / 2,
      minZ: centerZ + wz - sz / 2, maxZ: centerZ + wz + sz / 2,
      base: floorY, height: floorY + CEIL,
    });
  }

  // ---- Dance floor panels --------------------------------------------------
  const panelMat = M(new THREE.MeshBasicMaterial({ toneMapped: false }));
  const panels = new THREE.InstancedMesh(
    G(new THREE.BoxGeometry(TILE * 0.93, 0.08, TILE * 0.93)),
    panelMat,
    COLS * ROWS,
  );
  const m4 = new THREE.Matrix4();
  const panelDist: number[] = [];
  const maxD = Math.hypot((COLS * TILE) / 2, (ROWS * TILE) / 2);
  for (let i = 0; i < COLS; i++) {
    for (let j = 0; j < ROWS; j++) {
      const idx = i * ROWS + j;
      const x = (i - (COLS - 1) / 2) * TILE;
      const z = (j - (ROWS - 1) / 2) * TILE + 1.5;
      m4.makeTranslation(x, 0.045, z);
      panels.setMatrixAt(idx, m4);
      panels.setColorAt(idx, DARK);
      panelDist.push(Math.hypot(x, z - 1.5) / maxD);
    }
  }
  panels.instanceMatrix.needsUpdate = true;
  group.add(panels);

  // ---- Stage, decks and DJ -------------------------------------------------
  const riserMat = M(new THREE.MeshBasicMaterial({ color: 0x1d2235 }));
  const riser = new THREE.Mesh(G(new THREE.BoxGeometry(12, 0.9, 4)), riserMat);
  riser.position.set(0, 0.45, -HALF_Z + 2.6);
  group.add(riser);
  boxes.push({
    minX: centerX - 6, maxX: centerX + 6,
    minZ: centerZ - HALF_Z + 0.6, maxZ: centerZ - HALF_Z + 4.6,
    base: floorY, height: floorY + 0.9,
  });

  const deckMat = M(new THREE.MeshBasicMaterial({ color: 0x0b0e16 }));
  const decks = new THREE.Mesh(G(new THREE.BoxGeometry(3.4, 0.85, 1.1)), deckMat);
  decks.position.set(0, 1.32, -HALF_Z + 3.9);
  group.add(decks);

  /* The DJ is a pilot like everybody else, but deliberately NOT part of the
     crowd: they do one thing, behind the decks, whether or not anybody has
     turned up. A DJ who only starts working when a player arrives is a DJ who
     is obviously waiting for a player to arrive. */
  const dj = buildProceduralPilot(undefined, "eddie");
  dj.group.position.set(0, 0.9, -HALF_Z + 4.9);
  group.add(dj.group);

  // Speaker stacks, which pulse on the kick.
  const speakerMat = M(new THREE.MeshBasicMaterial({ color: 0x11141f }));
  const coneMat = M(new THREE.MeshBasicMaterial({ color: 0x2a3350 }));
  const stacks: THREE.Object3D[] = [];
  for (const sx of [-8.5, 8.5]) {
    const stack = new THREE.Group();
    stack.position.set(sx, 0, -HALF_Z + 3.2);
    for (let k = 0; k < 3; k++) {
      const box = new THREE.Mesh(G(new THREE.BoxGeometry(2.2, 1.5, 1.6)), speakerMat);
      box.position.y = 0.8 + k * 1.55;
      stack.add(box);
      const cone = new THREE.Mesh(G(new THREE.CircleGeometry(0.5, 18)), coneMat);
      cone.position.set(0, 0.8 + k * 1.55, 0.81);
      stack.add(cone);
    }
    group.add(stack);
    stacks.push(stack);
  }

  // ---- Lights --------------------------------------------------------------
  /* Beams are cones with additive blending rather than real spotlights: a
     volumetric-looking shaft costs one transparent mesh here, and four real
     shadow-casting spots in an interior costs a frame budget the city does not
     have to spare. */
  const beams: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; phase: number }[] = [];
  for (let i = 0; i < 4; i++) {
    const mat = M(
      new THREE.MeshBasicMaterial({
        color: BEAM_COLORS[i],
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    /* Long enough to reach the floor from the ceiling, and then some, so a
       swept beam still lands on the boards at the end of its arc. The first
       pass sized the cone to the room height exactly and every beam stopped
       in mid-air the moment it tilted. */
    const geo = G(new THREE.ConeGeometry(2.4, CEIL + 3, 18, 1, true));
    const mesh = new THREE.Mesh(geo, mat);
    // Cone points +Y by default; flipping it puts the narrow end at the rig.
    mesh.position.set((i - 1.5) * 7.5, CEIL - (CEIL + 3) / 2 - 0.2, -HALF_Z + 5.5);
    mesh.rotation.z = Math.PI;
    group.add(mesh);
    beams.push({ mesh, mat, phase: i * 1.7 });
  }

  /* ---- Actual light ------------------------------------------------------
     The first version of this room had none, on the theory that unlit
     materials were enough. They are enough for the *fixtures* — panels, beams,
     kerbs are all things that emit — and useless for everybody standing on the
     floor, because a procedural pilot is `MeshStandard` and a standard
     material with nothing shining on it is black. Twenty dancers rendered as
     twenty silhouettes. So: a dim cool wash so nothing is ever pure black, two
     coloured lamps over the floor that pulse on the beat and take their hue
     from the bar, and a warm one on the DJ. */
  const wash = new THREE.HemisphereLight(0x8899cc, 0x141826, 0.85);
  group.add(wash);
  const lamps: THREE.PointLight[] = [];
  for (const [lx, lz] of [[-6, 2], [6, 2], [0, -HALF_Z + 5]] as const) {
    const lamp = new THREE.PointLight(0xffffff, 30, 34, 1.5);
    lamp.position.set(lx, CEIL - 1.2, lz);
    group.add(lamp);
    lamps.push(lamp);
  }
  const djLamp = new THREE.PointLight(0xffd6a0, 16, 14, 1.6);
  djLamp.position.set(0, 3.4, -HALF_Z + 6.2);
  group.add(djLamp);

  // A ceiling wash that flashes on the downbeat.
  const strobeMat = M(
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, toneMapped: false }),
  );
  const strobe = new THREE.Mesh(G(new THREE.PlaneGeometry(HALF_X * 2, HALF_Z * 2)), strobeMat);
  strobe.rotation.x = Math.PI / 2;
  strobe.position.y = CEIL - 0.35;
  group.add(strobe);

  // ---- The crowd -----------------------------------------------------------
  /* Twenty regulars, minus anybody who would be standing in the doorway.
     Without the keep-out, arriving put a dancer inside the player and another
     one on the exit pad — you walked in wearing somebody, and the first thing
     you saw was a stranger's back filling the screen. Over-generate and filter
     rather than nudging offenders aside, so the ones that survive keep the
     uneven spacing that makes the room read as people. */
  const DOOR_Z = HALF_Z - 4;
  const DOOR_KEEPOUT = 4.5;
  const spots = ringSpots({
    count: 26,
    radius: 9.5,
    designs: CROWD_DESIGNS,
    stageBias: 0.55,
    minGap: 1.6,
    seed: 3,
  })
    .map((sp) => ({ ...sp, z: sp.z + 1.5 }))
    .filter((sp) => Math.hypot(sp.x, sp.z - DOOR_Z) > DOOR_KEEPOUT)
    .slice(0, 20)
    .map((sp, i) => ({ ...sp, order: i % 6 }));

  const crowd = createDanceCrowd({ seed: 7, sway: 0.22, spots });
  group.add(crowd.group);

  // ---- Doors ---------------------------------------------------------------
  /* A ring, not a disc, and half-lit. A filled pad this bright is the
     loudest thing on screen from the one place every visitor starts, so the
     first thing they look at is the way out. */
  const exitMat = M(
    new THREE.MeshBasicMaterial({ color: 0x73ffb8, toneMapped: false, transparent: true, opacity: 0.55 }),
  );
  const exitPad = new THREE.Mesh(G(new THREE.RingGeometry(1.15, 1.6, 28)), exitMat);
  exitPad.rotation.x = -Math.PI / 2;
  exitPad.position.set(0, 0.06, HALF_Z - 2.4);
  group.add(exitPad);

  const spawn = new THREE.Vector3(centerX, floorY + 0.2, centerZ + HALF_Z - 5);
  const exit = new THREE.Vector3(centerX, floorY, centerZ + HALF_Z - 2.4);

  const color = new THREE.Color();
  const watch = new THREE.Vector3();
  const djFrame = { speed: 0, grounded: true, verticalVel: 0, yawRate: 0, thrusting: false };

  return {
    group,
    spawn,
    exit,
    contains(pos) {
      return (
        Math.abs(pos.x - centerX) < HALF_X &&
        Math.abs(pos.z - centerZ) < HALF_Z &&
        pos.y > floorY - 3 &&
        pos.y < floorY + CEIL
      );
    },
    update(dt, playerPos, playerDancing) {
      const inside =
        Math.abs(playerPos.x - centerX) < HALF_X + 40 &&
        Math.abs(playerPos.z - centerZ) < HALF_Z + 40;
      group.visible = inside;
      if (!inside) {
        crowd.update(dt, watch, false);
        return 0;
      }

      const b = cityBeats();
      const bar = Math.floor(b / 4);
      const phase = b - Math.floor(b);

      /* The room is always going. A club that stands still until a player
         presses a key is a diorama of a club — and unlike the plaza floor,
         where the regulars waiting for you is the joke, in here the whole
         premise is that you walked in on something already happening. */
      watch.set(playerPos.x - centerX, 0, playerPos.z - centerZ);
      const dancing = crowd.update(dt, watch, true);
      dj.update(dt, djFrame);
      // The DJ works: a bob on the beat and a hand on the deck.
      dj.group.position.y = 0.9 + Math.pow(1 - phase, 2.2) * 0.06;
      dj.group.rotation.y = Math.PI + Math.sin(b * 0.7) * 0.25;

      // Panels.
      const tint = color.setHex(BEAM_COLORS[bar % BEAM_COLORS.length]);
      const c2 = new THREE.Color();
      for (let i = 0; i < COLS; i++) {
        for (let j = 0; j < ROWS; j++) {
          const idx = i * ROWS + j;
          // Not full heat: at 1 the panels are so saturated they read as
          // paint rather than as light, and they fight the lamps for the eye.
          const lit = panelBrightness(i, j, panelDist[idx], b, 0.78);
          c2.copy(DARK).lerp(tint, Math.min(1, lit));
          panels.setColorAt(idx, c2);
        }
      }
      if (panels.instanceColor) panels.instanceColor.needsUpdate = true;

      // Beams sweep, and change colour with the chord.
      for (let i = 0; i < beams.length; i++) {
        const bm = beams[i];
        bm.mesh.rotation.x = Math.sin(b * 0.6 + bm.phase) * 0.5;
        bm.mesh.rotation.z = Math.PI + Math.sin(b * 0.41 + bm.phase * 1.3) * 0.55;
        bm.mat.color.setHex(BEAM_COLORS[(bar + i) % BEAM_COLORS.length]);
        bm.mat.opacity = 0.1 + Math.pow(1 - phase, 3) * 0.16;
      }

      // Lamps: hue from the bar, brightness punched on every beat. Bright
      // enough to read a face by at the peak, never so dim that the crowd
      // disappears between beats.
      const punchLight = 22 + Math.pow(1 - phase, 2.6) * 34;
      for (let i = 0; i < lamps.length; i++) {
        lamps[i].color.setHex(BEAM_COLORS[(bar + i) % BEAM_COLORS.length]);
        lamps[i].intensity = punchLight;
      }
      djLamp.intensity = 14 + Math.pow(1 - phase, 3) * 8;

      // Strobe on the downbeat only — every beat is a headache.
      strobeMat.opacity =
        Math.floor(b) % 4 === 0 ? Math.pow(1 - phase, 6) * 0.32 : 0;

      // Stacks pulse on the kick.
      const punch = 1 + Math.pow(1 - phase, 3) * 0.06;
      for (const st of stacks) st.scale.set(punch, 1, punch);

      return dancing + (playerDancing ? 0 : 0);
    },
    dispose() {
      crowd.dispose();
      dj.dispose();
      panels.dispose();
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      geos.length = 0;
      mats.length = 0;
    },
  };
}
