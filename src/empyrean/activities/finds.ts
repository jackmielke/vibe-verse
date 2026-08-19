/**
 * SUNMOTES — forty-eight pieces of the sunset, snagged on the city.
 *
 * The ambient one. It is not an activity in the runner's sense: there is
 * nothing to start, nothing to abort, and it goes on quietly underneath
 * whatever else you are doing. Fly near one and it brightens and hums; fly
 * into it and it is yours, for good, in `localStorage`.
 *
 * ## Where they are, and why
 *
 * Placement is the entire design. A collectible on the pavement is a chore; a
 * collectible somewhere you would never otherwise go is a reason to go there.
 * So they are dealt out across every kind of place this island has, in
 * proportion to how much it deserves visiting:
 *
 * | where | how many | what it asks of you |
 * | --- | --- | --- |
 * | pavement and plaza | 14 | walk about; several are inside the market hall |
 * | rooftops | 8 | land on something tall |
 * | cornices | 6 | hover beside a wall, which is the hardest thing to do |
 * | promenade rings | 6 | find the stairs, or drop over the parapet |
 * | under the keel | 6 | leave the island entirely |
 * | the air | 6 | the Beacon's collar, the shaft, the station roof |
 * | inside the Market Hall | 2 | go indoors |
 *
 * Every one is derived from the plan — nav nodes, lot roofs, lot front edges,
 * the deck table — or from the keel envelope in `common.ts`, so none of them
 * can end up inside a wall, and `src/test/empyreanActivities.test.ts` checks
 * exactly that, one find at a time.
 *
 * ## Cost
 *
 * One instanced mesh, one material, two uniforms a frame. The spin, the bob
 * and the proximity glow all happen in the vertex shader from the clock and
 * the player's position, so forty-eight collectibles cost one draw call and
 * one distance loop, and nothing at all is written per instance until one of
 * them is picked up.
 */
import * as THREE from "three";
import { makeRng } from "@/shared/proc/rng";
import type { FrameContext } from "../types";
import { DECKS, ISLAND_Y } from "../config";
import { cityPlan, surfaceAt, LANDMARKS, type Lot } from "../cityplan";
import { DEG, keelBlockedNear, readStore, writeStore, tallLots } from "./common";

export const FINDS_KEY = "empyrean.sunmotes.v1";

export type FindKind = "deck" | "roof" | "cornice" | "promenade" | "keel" | "air" | "interior";

export interface Find {
  id: string;
  kind: FindKind;
  x: number;
  y: number;
  z: number;
  /**
   * The surface this one belongs to, if any — the roof it stands on, the
   * pavement under it, the wall it is stuck to. The reachability test in
   * `src/test/empyreanActivities.test.ts` is written against this: a find that
   * cannot name what holds it up is one nobody can be sure of reaching.
   */
  anchorY: number;
  /** For cornices and roofs: the lot it belongs to. */
  lot?: string;
}

/** Collection radius. Generous — this is not a precision game. */
export const PICKUP_R = 6;
/** Inside this you can hear it. */
export const SENSE_R = 26;

/* -------------------------------------------------------------------------
 * Placement
 * ---------------------------------------------------------------------- */

const marketHall = LANDMARKS.find((l) => l.id === "market-hall")!;

/**
 * Deal them out.
 *
 * Deterministic — the same forty-eight motes in the same places on every
 * machine and every reload, which is what makes "the one on the cornice above
 * the fish shop" a thing two people can say to each other.
 */
export function placeFinds(): Find[] {
  const plan = cityPlan();
  const rng = makeRng("empyrean-sunmotes-v1");
  const out: Find[] = [];
  const push = (f: Find) => out.push(f);
  const far = (x: number, z: number, y: number, m: number) =>
    out.every((f) => Math.hypot(f.x - x, f.z - z, f.y - y) > m);

  /* ---- 14 on the pavement, spread across the nav graph ---- */
  {
    const nodes = plan.nav;
    let placed = 0;
    // Walk the node list on a stride that is co-prime with its length, so the
    // picks are spread right round the city rather than clustered where the
    // graph was built first.
    const stride = 37;
    for (let i = 0; placed < 14 && i < nodes.length; i++) {
      const n = nodes[(i * stride) % nodes.length];
      const s = surfaceAt(n.x, n.z);
      if (s.kind === "void" || s.kind === "parapet") continue;
      if (!far(n.x, n.z, s.y + 1.2, 55)) continue;
      push({
        id: `deck-${placed}`,
        kind: "deck",
        x: n.x,
        y: s.y + 1.2,
        z: n.z,
        anchorY: s.y,
      });
      placed++;
    }
  }

  /* ---- 8 on roofs, the tallest first but spread round the compass ---- */
  {
    const tall = tallLots(24);
    const taken: number[] = [];
    let placed = 0;
    for (const lot of tall) {
      if (placed >= 8) break;
      // At least forty degrees from every roof already used, so the set is not
      // eight towers in one block.
      const ok = taken.every((a) => {
        let d = Math.abs(a - lot.a);
        if (d > Math.PI) d = Math.PI * 2 - d;
        return d > 40 * DEG;
      });
      if (!ok) continue;
      taken.push(lot.a);
      push({
        id: `roof-${placed}`,
        kind: "roof",
        x: lot.centroid.x,
        y: lot.y + lot.height + 1.3,
        z: lot.centroid.z,
        anchorY: lot.y + lot.height,
        lot: lot.id,
      });
      placed++;
    }
  }

  /* ---- 6 on cornices: outside the wall, halfway up ---- */
  {
    const mid: Lot[] = plan.lots
      .filter((l) => l.use !== "garden" && l.height >= 26 && l.height <= 150)
      .sort((a, b) => a.id.localeCompare(b.id));
    let placed = 0;
    for (let i = 0; placed < 6 && i < mid.length; i++) {
      const lot = mid[i];
      const x = lot.frontMid.x + lot.frontNormal.x * 2.8;
      const z = lot.frontMid.z + lot.frontNormal.z * 2.8;
      const y = lot.y + lot.height * 0.55;
      if (!far(x, z, y, 60)) continue;
      push({ id: `cornice-${placed}`, kind: "cornice", x, y, z, anchorY: lot.y, lot: lot.id });
      placed++;
    }
  }

  /* ---- 6 on the promenade rings, two per ring ---- */
  {
    let placed = 0;
    for (let d = 1; d < DECKS.length; d++) {
      const deck = DECKS[d];
      const r = deck.outer - deck.width / 2;
      for (let k = 0; k < 2; k++) {
        // Off the avenue ends, so they are a walk along the ring rather than a
        // step off the stairs.
        const a = (d * 61 + k * 180 + 23) * DEG;
        push({
          id: `promenade-${placed}`,
          kind: "promenade",
          x: Math.cos(a) * r,
          y: deck.y + 1.2,
          z: Math.sin(a) * r,
          anchorY: deck.y,
        });
        placed++;
      }
    }
  }

  /* ---- 6 under the keel, in air the rock cannot reach ---- */
  {
    const spots: Array<[number, number, number]> = [
      [30, 450, 470],
      [150, 420, 430],
      [250, 390, 350],
      [320, 385, 250],
      [200, 380, 150],
      [75, 130, 100],
    ];
    spots.forEach(([a, r, y], i) => {
      push({
        id: `keel-${i}`,
        kind: "keel",
        x: Math.cos(a * DEG) * r,
        y,
        z: Math.sin(a * DEG) * r,
        // Nothing holds these up. They are reachable because a jetpack is.
        anchorY: y,
      });
    });
  }

  /* ---- 6 in the air: the Beacon's collar, the shaft, the station roof ---- */
  {
    const spots: Array<[number, number, number]> = [
      [-40, 40, 1110],
      [120, 52, 700],
      [300, 52, 830],
      [200, 52, 960],
      [180, 96, 637],
      [-120, 300, 700],
    ];
    spots.forEach(([a, r, y], i) => {
      push({
        id: `air-${i}`,
        kind: "air",
        x: Math.cos(a * DEG) * r,
        y,
        z: Math.sin(a * DEG) * r,
        anchorY: y,
      });
    });
  }

  /* ---- 2 indoors, under the Market Hall's glass ---- */
  {
    for (let i = 0; i < 2; i++) {
      const a = marketHall.yaw + (i === 0 ? 1.9 : -1.9);
      push({
        id: `interior-${i}`,
        kind: "interior",
        x: marketHall.x + Math.cos(a) * 12,
        y: ISLAND_Y + 2.6 + i * 1.4,
        z: marketHall.z + Math.sin(a) * 12,
        anchorY: ISLAND_Y,
      });
    }
  }

  // A stable jitter so a rank of them never lines up perfectly.
  for (const f of out) {
    f.x += rng.range(-0.8, 0.8);
    f.z += rng.range(-0.8, 0.8);
  }
  return out;
}

/** True where a find is in air the island cannot be occupying. Test-facing. */
export function findIsClearOfRock(f: Find): boolean {
  return !keelBlockedNear(f.x, f.z, f.y, 4);
}

/* -------------------------------------------------------------------------
 * The field
 * ---------------------------------------------------------------------- */

const FIND_VERT = /* glsl */ `
attribute float aSeed;
attribute float aGot;
uniform float uTime;
uniform vec3 uPlayer;
varying float vGlow;
varying float vSeed;
void main() {
  vSeed = aSeed;
  vec3 centre = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  float d = distance(uPlayer, centre);
  /* The tell: a mote you are near burns brighter and turns faster. It is the
   * only hint you get, and it has to be legible out of the corner of an eye at
   * thirty metres a second. */
  vGlow = (1.0 - smoothstep(6.0, 34.0, d)) * (1.0 - aGot);

  float spin = uTime * (0.7 + 1.8 * vGlow) + aSeed * 6.2831;
  float c = cos(spin);
  float s = sin(spin);
  vec3 p = vec3(position.x * c - position.z * s, position.y, position.x * s + position.z * c);
  p *= 1.0 + 0.16 * vGlow;
  p *= 1.0 - aGot;                       // collected: gone, without a rebuild
  p.y += sin(uTime * 1.6 + aSeed * 8.0) * 0.55;

  vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FIND_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
varying float vGlow;
varying float vSeed;
void main() {
  /* Sunset colours, one per mote, all of them warm. */
  vec3 warm = mix(vec3(1.0, 0.72, 0.34), vec3(1.0, 0.42, 0.52), fract(vSeed * 7.3));
  float pulse = 0.75 + 0.25 * sin(uTime * 2.4 + vSeed * 12.0);
  gl_FragColor = vec4(warm * (1.1 + 2.2 * vGlow) * pulse, 0.72 + 0.28 * vGlow);
}
`;

export interface FindsHooks {
  toast(text: string, tone?: "info" | "good" | "warn", ttl?: number): void;
  pay(coins: number): void;
  chime(freq: number, dur?: number, gain?: number): void;
  fanfare(): void;
}

export interface FindsField {
  group: THREE.Object3D;
  update(ctx: FrameContext): void;
  readonly got: number;
  readonly total: number;
  /** The nearest uncollected one within earshot, for the HUD. Null if none. */
  nearest(): Find | null;
  dispose(): void;
}

/** Coins for the milestones, at 10, 24, 36 and all 48. */
const MILESTONES: Array<[number, number]> = [
  [10, 15],
  [24, 30],
  [36, 50],
  [48, 90],
];

export function buildFinds(hooks: FindsHooks): FindsField {
  const finds = placeFinds();
  const total = finds.length;

  const group = new THREE.Group();
  group.name = "empyrean-sunmotes";

  const geo = new THREE.OctahedronGeometry(1.15, 0);
  const seed = new THREE.InstancedBufferAttribute(new Float32Array(total), 1);
  const got = new THREE.InstancedBufferAttribute(new Float32Array(total), 1);
  geo.setAttribute("aSeed", seed);
  geo.setAttribute("aGot", got);

  const mat = new THREE.ShaderMaterial({
    name: "EmpyreanSunmote",
    vertexShader: FIND_VERT,
    fragmentShader: FIND_FRAG,
    uniforms: { uTime: { value: 0 }, uPlayer: { value: new THREE.Vector3() } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.InstancedMesh(geo, mat, total);
  // The vertex shader moves every instance, so the bounds three would compute
  // are not the bounds that get drawn. One instanced draw for the whole island
  // is cheap enough that culling it is not worth being wrong about.
  mesh.frustumCulled = false;
  group.add(mesh);

  const m4 = new THREE.Matrix4();
  const collected = new Set<string>(readStore<{ got: string[] }>(FINDS_KEY, { got: [] }).got ?? []);
  let count = 0;

  for (let i = 0; i < total; i++) {
    const f = finds[i];
    m4.makeTranslation(f.x, f.y, f.z);
    mesh.setMatrixAt(i, m4);
    seed.setX(i, (i * 0.618033) % 1);
    const done = collected.has(f.id);
    got.setX(i, done ? 1 : 0);
    if (done) count++;
  }
  mesh.instanceMatrix.needsUpdate = true;
  seed.needsUpdate = true;
  got.needsUpdate = true;

  let near: Find | null = null;
  let humming: string | null = null;

  function persist(): void {
    const list: string[] = [];
    collected.forEach((id) => list.push(id));
    writeStore(FINDS_KEY, { got: list });
  }

  return {
    group,
    get got() {
      return count;
    },
    get total() {
      return total;
    },
    nearest() {
      return near;
    },

    update(ctx) {
      mat.uniforms.uTime.value = ctx.time;
      (mat.uniforms.uPlayer.value as THREE.Vector3).copy(ctx.player.position);

      const p = ctx.player.position;
      near = null;
      let bestD = SENSE_R;
      for (let i = 0; i < total; i++) {
        const f = finds[i];
        if (got.getX(i) > 0.5) continue;
        const dx = f.x - p.x;
        if (dx > SENSE_R || dx < -SENSE_R) continue;
        const dz = f.z - p.z;
        if (dz > SENSE_R || dz < -SENSE_R) continue;
        const dy = f.y - p.y;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > SENSE_R) continue;

        if (d <= PICKUP_R) {
          got.setX(i, 1);
          got.needsUpdate = true;
          collected.add(f.id);
          count++;
          persist();
          hooks.pay(3);
          hooks.chime(784 + (count % 5) * 64, 0.35, 0.05);
          const milestone = MILESTONES.find(([n]) => n === count);
          if (milestone) {
            hooks.pay(milestone[1]);
            hooks.fanfare();
            hooks.toast(
              count === total
                ? `Every sunmote on the island — all ${total} · +${milestone[1]} ✦`
                : `${count} sunmotes · +${milestone[1]} ✦`,
              "good",
              5,
            );
          } else {
            hooks.toast(`Sunmote · ${count} of ${total} · +3 ✦`, "good", 2.4);
          }
          humming = null;
          continue;
        }
        if (d < bestD) {
          bestD = d;
          near = f;
        }
      }

      // One hum per mote, on the way in. Repeating it every time you drift
      // across the boundary is how a nice sound becomes an irritating one.
      if (near && near.id !== humming && bestD < SENSE_R * 0.75) {
        humming = near.id;
        hooks.chime(392, 0.5, 0.02);
      } else if (!near) {
        humming = null;
      }
    },

    dispose() {
      geo.dispose();
      mat.dispose();
      group.clear();
    },
  };
}
