/**
 * The ground the front is fought over.
 *
 * `world/Battlefield.js` is scenery, and scenery is normally not worth testing.
 * Four things about this scenery are, because each of them is a claim the file
 * makes that nothing else in the engine would notice breaking:
 *
 *   - it is the SAME field every visit, because the whole galaxy is seeded and
 *     a landing site that rearranges itself between two landings is the loudest
 *     possible tell that none of this is a place.
 *   - it sits on the terrain. `Game._maybeInvade` hands over the sampler the
 *     troopers walk on; a base authored at a fixed y is underground on one
 *     world and floating on the next, and neither is visible from the code.
 *   - the cover is where `Battle._planBound` can actually use it. That routine
 *     rejects anything over 24 m away, over 14 m off a soldier's lane, or
 *     inside STANDOFF of his target — so cover in a plausible-looking place
 *     that fails one of those filters is cover nobody ever gets behind, and the
 *     field looks identical either way.
 *   - it is a dozen draw calls and not a thousand, which is the only reason it
 *     runs on a phone at all.
 */
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three-ls";
import { Battlefield } from "@/longsilence/world/Battlefield.js";
import { Battle, Trooper, FACTION } from "@/longsilence/world/Troopers.js";

const flat = () => 0;
const scene = () => new THREE.Scene();

/** The lines Battle spawns by default, re-derived rather than imported. */
const AXIS = 84 * 0.36;
const ALLY_Z = -100;
const ENEMY_Z = -128;

type Row = { x: number; y: number; z: number };

/** Every instance on the field, in world space, in build order. */
function instances(bf: Battlefield): Row[] {
  const out: Row[] = [];
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  bf.group.traverse((o: THREE.Object3D) => {
    const im = o as THREE.InstancedMesh;
    if (!im.isInstancedMesh) return;
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m);
      m.decompose(p, q, s);
      out.push({ x: p.x, y: p.y, z: p.z });
    }
  });
  return out;
}

function drawCalls(bf: Battlefield) {
  let n = 0;
  bf.group.traverse((o: THREE.Object3D) => {
    if ((o as THREE.Mesh).isMesh || (o as THREE.LineSegments).isLineSegments) n++;
  });
  return n;
}

describe("the same world twice", () => {
  it("builds an identical field from the same planet seed", () => {
    const a = new Battlefield(scene(), flat, { seed: 61.25 });
    const b = new Battlefield(scene(), flat, { seed: 61.25 });
    const ia = instances(a);
    const ib = instances(b);
    expect(ia.length).toBeGreaterThan(600);
    expect(ib.length).toBe(ia.length);
    for (let i = 0; i < ia.length; i++) expect(ib[i]).toEqual(ia[i]);
    expect(b.coverPoints()).toEqual(a.coverPoints());
    a.dispose(); b.dispose();
  });

  it("builds a different field for the next planet along", () => {
    /* The seeds a spec carries are floats a fraction apart. Feeding one
       straight to mulberry32 truncates two neighbouring worlds to the same
       integer and gives them the same battlefield — which is the failure this
       is here to catch, not some abstract "is it random". */
    const a = new Battlefield(scene(), flat, { seed: 61.25 });
    const b = new Battlefield(scene(), flat, { seed: 61.31 });
    const ia = instances(a);
    const ib = instances(b);
    const same = ia.filter((r, i) => ib[i] && ib[i].x === r.x && ib[i].z === r.z).length;
    expect(same / ia.length).toBeLessThan(0.2);
    a.dispose(); b.dispose();
  });
});

describe("it sits on the terrain", () => {
  /* Slow and monotonic, so the height under any one cluster is close to the
     height under each of its parts: a base is thirty metres across and samples
     the ground once per building, not once per crate. */
  const slope = (x: number, z: number) => 40 + 0.05 * x - 0.03 * z;

  it("moves every object by exactly the ground under it", () => {
    const level = new Battlefield(scene(), flat, { seed: 12.5 });
    const hill = new Battlefield(scene(), slope, { seed: 12.5 });
    const a = instances(level);
    const b = instances(hill);
    expect(b.length).toBe(a.length);

    let lifted = 0;
    for (let i = 0; i < a.length; i++) {
      // Same seed, so the same object: x and z are untouched by the sampler.
      expect(b[i].x).toBeCloseTo(a[i].x, 6);
      expect(b[i].z).toBeCloseTo(a[i].z, 6);
      const want = slope(a[i].x, a[i].z);
      const got = b[i].y - a[i].y;
      // 1.5 m of slack is one cluster's worth of sampling error at this
      // gradient; a field authored at a fixed y misses by the whole 40.
      expect(Math.abs(got - want), `object ${i} is not on the ground`).toBeLessThan(1.5);
      if (got > 1) lifted++;
    }
    expect(lifted, "nothing moved, so the check above proved nothing").toBe(a.length);
    level.dispose(); hill.dispose();
  });

  it("puts cover points on the ground too, so a trooper at one is not floating", () => {
    const bf = new Battlefield(scene(), slope, { seed: 12.5 });
    for (const c of bf.coverPoints()) {
      expect(c.y).toBeCloseTo(slope(c.x, c.z), 6);
    }
    bf.dispose();
  });

  it("survives a sampler that returns nonsense", () => {
    /* One NaN in an instance matrix takes the bounding sphere with it and the
       whole batch — a thousand objects — culls out of the frame. */
    const bf = new Battlefield(scene(), () => NaN, { seed: 3 });
    for (const r of instances(bf)) {
      expect(Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)).toBe(true);
    }
    bf.dispose();
  });
});

describe("the cover is cover the fight can use", () => {
  it("gives both sides somewhere, on their own side of the field", () => {
    const bf = new Battlefield(scene(), flat, { seed: 61.25 });
    const cover = bf.coverPoints();
    const ally = cover.filter((c) => c.faction === FACTION.ALLY);
    const enemy = cover.filter((c) => c.faction === FACTION.ENEMY);
    expect(ally.length).toBeGreaterThanOrEqual(6);
    expect(enemy.length).toBeGreaterThanOrEqual(6);
    // Never null. A bound claims a spot, and Troopers asserts a claimed spot
    // belongs to the claimant.
    expect(cover.length).toBe(ally.length + enemy.length);
    const mid = (ALLY_Z + ENEMY_Z) / 2;
    for (const c of ally) expect(c.z, "allied cover past the midline").toBeGreaterThan(mid);
    for (const c of enemy) expect(c.z, "hostile cover past the midline").toBeLessThan(mid);
    // Facing downrange: allies look down -Z, hostiles look back up +Z.
    for (const c of ally) expect(Math.cos(c.yaw)).toBeLessThan(0);
    for (const c of enemy) expect(Math.cos(c.yaw)).toBeGreaterThan(0);
    bf.dispose();
  });

  it("puts it inside the filters _planBound actually applies", () => {
    /* The three that reject a piece of cover: over 24 m from the soldier, over
       14 m off his lane, or inside STANDOFF (28 m) of the man he is shooting
       at. Cover that fails any of them is invisible to the AI while looking
       perfectly reasonable on screen, so it is checked directly here as well as
       through the simulation below. */
    const bf = new Battlefield(scene(), flat, { seed: 61.25 });
    const reachable = { ally: 0, enemy: 0 };
    for (const c of bf.coverPoints()) {
      const line = c.faction === FACTION.ALLY ? ALLY_Z + 5 : ENEMY_Z - 7;
      const foe = c.faction === FACTION.ALLY ? ENEMY_Z - 7 : ALLY_Z + 5;
      const d = Math.abs(c.z - line);
      if (d > 24 || d < 3) continue;
      if (Math.abs(c.z - foe) < 28) continue;
      reachable[c.faction as "ally" | "enemy"]++;
    }
    expect(reachable.ally, "no allied cover is reachable from the allied line").toBeGreaterThanOrEqual(5);
    expect(reachable.enemy, "no hostile cover is reachable from the hostile line").toBeGreaterThanOrEqual(5);
    bf.dispose();
  });

  it("gets real troopers behind it, on a phone budget too", () => {
    /* The end-to-end claim, and the only one that would survive every filter
       above being satisfied by cover in the wrong lane. Both counts were zero
       before the cover bands were moved onto the lines. */
    for (const mobile of [false, true]) {
      const s = scene();
      const bf = new Battlefield(s, flat, { seed: 61.25, mobile });
      const battle = new Battle(s, flat, {
        count: mobile ? 6 : 9,
        cover: () => bf.coverPoints(),
      });
      let ally = 0;
      let enemy = 0;
      for (let i = 0; i < 30 * 60 && !battle.over; i++) {
        battle.update(1 / 30, null);
        for (const t of battle.troopers as Trooper[]) {
          if (!t.inCover) continue;
          if (t.faction === FACTION.ALLY) ally++; else enemy++;
        }
      }
      expect(ally, `no ally reached cover (mobile=${mobile})`).toBeGreaterThan(0);
      expect(enemy, `no hostile reached cover (mobile=${mobile})`).toBeGreaterThan(0);
      battle.dispose();
      bf.dispose();
    }
  });
});

describe("neither line can see straight through to the other", () => {
  it("interrupts most of the sightlines between the two lines, but not all", () => {
    /* The reason the middle of the field is full of containers, dead armour and
       ruins. All of them open is a shooting gallery pointed both ways; all of
       them shut is a fence, and standing at the ramp you would see your own
       line, a wall, and no hostiles at all — which is worse than the empty
       field it replaced. */
    const bf = new Battlefield(scene(), flat, { seed: 61.25 });
    const rnd = mulberry(9);
    let blocked = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const ax = AXIS + (rnd() - 0.5) * 40;
      const az = ALLY_Z + rnd() * 10;
      const ex = AXIS + (rnd() - 0.5) * 80;
      const ez = ENEMY_Z - rnd() * 14;
      if (bf.blocksSight(ax, az, ex, ez)) blocked++;
    }
    expect(blocked / N).toBeGreaterThan(0.5);
    expect(blocked / N).toBeLessThan(0.95);
    bf.dispose();
  });

  it("leaves lanes open between the ramp and your own line", () => {
    /* The first thirty metres of a contested landing. There is cover to move
       between out there — that is the point of it — but a player who steps out
       and cannot see their own line has been walled in rather than given a
       route. */
    const bf = new Battlefield(scene(), flat, { seed: 61.25 });
    let open = 0;
    for (let i = 0; i < 40; i++) {
      const to = AXIS + (i / 39 - 0.5) * 36;
      if (!bf.blocksSight(AXIS, -84 * 0.74, to, ALLY_Z + 6)) open++;
    }
    expect(open, "the walk out from the ship is walled off").toBeGreaterThan(10);
    bf.dispose();
  });
});

describe("what it costs", () => {
  it("draws a whole warzone in about a dozen calls", () => {
    const bf = new Battlefield(scene(), flat, { seed: 61.25 });
    expect(instances(bf).length).toBeGreaterThan(900);
    // Everything is instanced; a Mesh per object would be four figures of these.
    expect(drawCalls(bf)).toBeLessThanOrEqual(16);
    bf.dispose();
  });

  it("puts fewer objects on a phone", () => {
    const desk = new Battlefield(scene(), flat, { seed: 61.25 });
    const phone = new Battlefield(scene(), flat, { seed: 61.25, mobile: true });
    expect(instances(phone).length).toBeLessThan(instances(desk).length * 0.8);
    desk.dispose(); phone.dispose();
  });

  it("wears the faction's own colours, the ones on the troopers", () => {
    /* Battlefield keeps its own copy of the hue table because Troopers does not
       export one. This is the thing that stops the copy drifting: the blue on
       an allied wall panel is read back off a live allied trooper's armour. */
    const hues = (o: THREE.Object3D) => {
      const out = new Set<number>();
      o.traverse((n: THREE.Object3D) => {
        const m = (n as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && m.color) out.add(m.color.getHex());
      });
      return out;
    };
    const bf = new Battlefield(scene(), flat, { seed: 61.25 });
    const field = hues(bf.group);
    for (const f of [FACTION.ALLY, FACTION.ENEMY]) {
      const t = new Trooper(f, 0, 0, flat);
      const worn = hues(t.object);
      /* Both of them: the helmet and the chest plate carry different shades of
         the same faction, and the base uses one for its panels and the other
         for the lamps that have to read from the far end of the field. */
      const shared = [...worn].filter((h) => field.has(h));
      expect(shared.length, `${f} base wears none of the ${f} livery`).toBeGreaterThanOrEqual(2);
    }
    bf.dispose();
  });
});

describe("leaving", () => {
  it("drops every geometry and material it allocated", () => {
    const s = scene();
    const bf = new Battlefield(s, flat, { seed: 61.25 });
    /* Deduplicated by uuid, because the whole point of this file is that one
       BoxGeometry is shared by six batches — and spying on the same method
       twice replaces the first spy rather than chaining onto it. */
    const spies: ReturnType<typeof vi.spyOn>[] = [];
    const seen = new Set<string>();
    const watch = (r: { uuid: string; dispose?: () => void }) => {
      if (!r || !r.dispose || seen.has(r.uuid)) return;
      seen.add(r.uuid);
      spies.push(vi.spyOn(r as { dispose: () => void }, "dispose"));
    };
    bf.group.traverse((o: THREE.Object3D) => {
      const mesh = o as THREE.Mesh;
      watch(mesh.geometry as unknown as { uuid: string; dispose: () => void });
      watch(mesh.material as unknown as { uuid: string; dispose: () => void });
    });
    expect(spies.length).toBeGreaterThan(10);
    bf.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalled();
    expect(s.children).not.toContain(bf.group);
    vi.restoreAllMocks();
  });

  it("is safe to dispose twice, which is how the double-free got in last time", () => {
    const s = scene();
    const bf = new Battlefield(s, flat, { seed: 61.25 });
    bf.dispose();
    expect(() => bf.dispose()).not.toThrow();
    // And the cover handed to a Battle that outlives it is empty, not stale.
    expect(bf.coverPoints()).toHaveLength(0);
  });

  it("lets a Battle holding its cover keep running after it is gone", () => {
    const s = scene();
    const bf = new Battlefield(s, flat, { seed: 61.25 });
    const battle = new Battle(s, flat, { count: 3, cover: () => bf.coverPoints() });
    bf.dispose();
    expect(() => { for (let i = 0; i < 300; i++) battle.update(1 / 30, null); }).not.toThrow();
    battle.dispose();
  });
});

/** A local PRNG so the sampling above does not depend on Math.random. */
function mulberry(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
