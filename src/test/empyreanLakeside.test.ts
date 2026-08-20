/**
 * The lakeside, and the four things about it that no render can check.
 *
 * 1. **The ground.** `lakeside.ts` may not import `terrain.ts` — a system may
 *    not import another system — so it carries its own copy of the height
 *    function, exactly as `launchsite.ts` does. A copy drifts. This file may
 *    import both, so it does. It matters more here than at the spaceport:
 *    `ICE_DECK` claims the entire lake is a level floor at `WATER_Y`, and that
 *    claim is only true while the terrain says the basin is flat.
 *
 * 2. **Landing.** Before this system there was no support anywhere off the
 *    island: `surfaceAt` reports `void` past the last promenade, so a descent
 *    to the ice fell through it, through `KILL_Y`, and respawned on the Halo.
 *    The ice deck is the fix and it is worth a test of its own, because the
 *    symptom of losing it is not an exception — it is a player who flies down
 *    for two minutes and is silently teleported home.
 *
 * 3. **The stair.** A `Deck` is an axis-aligned box, and a flight of treads
 *    turned off the axes over-covers itself: the box of the tread above
 *    reaches out over the tread below, and a body walking down hovers off the
 *    edge of every step. The flight here is built square to the world to
 *    avoid that, and the assertion below is the thing that says so — it walks
 *    the centre line and checks every rise against `CLIMB`.
 *
 * 4. **The black-screen failures.** A NaN in a position buffer collapses a
 *    bounding sphere and the mesh silently stops drawing; geometry left in
 *    local space puts the whole camp at the origin, 880 m from where it
 *    belongs and directly under the island. Neither throws.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { BuildContext, FrameContext } from "@/empyrean/types";
import { GROUND_Y, ISLAND_Y, LAKE_R, WATER_Y, WORLD_R } from "@/empyrean/config";
import { CLIMB } from "@/empyrean/flight";
import { groundHeight } from "@/empyrean/terrain";
import {
  CAMP_BEARING,
  CAMP_RANGE,
  CAMP_X,
  CAMP_Z,
  ICE_DECK,
  ICE_Y,
  LOOK_DECK,
  LOOK_R,
  buildLakeside,
  snowHeight,
  type Deck,
} from "@/empyrean/lakeside";

const ctx: BuildContext = { quality: "high", seedSalt: "test" };

function frame(at: THREE.Vector3, lookAt = new THREE.Vector3(CAMP_X, 0, CAMP_Z)): FrameContext {
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.3, 26000);
  camera.position.copy(at);
  camera.lookAt(lookAt);
  camera.updateMatrixWorld(true);
  return {
    time: 12,
    dt: 1 / 60,
    camera,
    player: {
      position: new THREE.Vector3(CAMP_X, ICE_Y, CAMP_Z),
      velocity: new THREE.Vector3(),
      yaw: 0,
      grounded: true,
      burn: 0,
      altitude: 0,
    },
    quality: "high",
    dayPhase: 0.75,
    sunDir: new THREE.Vector3(-0.946, 0.0, -0.324).normalize(),
    daylight: 0.32,
    gradeDaylight: 1,
    camRadiusSq: at.x * at.x + at.z * at.z,
  };
}

/* -------------------------------------------------------------------------
 * The ground
 * ---------------------------------------------------------------------- */

describe("the ground under the camp", () => {
  it("is the terrain's own, not a second opinion", () => {
    /* Over the lake, the shore and well out into the ranges: the two agree
       trivially on the ice, and it is the ranges that get retuned. */
    let worst = 0;
    let where = "";
    for (let x = -2600; x <= 2600; x += 131) {
      for (let z = -2600; z <= 2600; z += 127) {
        const d = Math.abs(snowHeight(x, z) - groundHeight(x, z));
        if (d > worst) {
          worst = d;
          where = `(${x}, ${z})`;
        }
      }
    }
    expect(worst, `lakeside's copy of groundHeight has drifted at ${where}`).toBe(0);
  });

  it("keeps the lake basin flat, which is what the ice deck claims", () => {
    /* `ICE_DECK` is one circular deck at a single height. If the terrain ever
       puts a slope under the lake, the ice becomes a sheet of glass hanging
       over the ground with the player standing on the glass — and it would
       look completely fine from every angle. */
    for (let r = 0; r < LAKE_R; r += 37) {
      for (let a = 0; a < Math.PI * 2; a += 0.31) {
        const h = groundHeight(Math.cos(a) * r, Math.sin(a) * r);
        expect(h, `the lake floor is not level at r=${r.toFixed(0)}`).toBe(GROUND_Y);
      }
    }
    expect(ICE_DECK.y).toBe(WATER_Y);
    expect(ICE_DECK.r).toBe(LAKE_R);
  });
});

/* -------------------------------------------------------------------------
 * Where it is
 * ---------------------------------------------------------------------- */

describe("where the camp is", () => {
  it("stands on the ice, clear of the island and clear of the shore", () => {
    const r = Math.hypot(CAMP_X, CAMP_Z);
    expect(r).toBeCloseTo(CAMP_RANGE, 0);
    // Well outside the island's own footprint, so nothing here is ever under
    // the rock in the rock's shadow, and 600 m short of the shore.
    expect(r).toBeGreaterThan(600);
    expect(r).toBeLessThan(LAKE_R - 500);
    expect(r).toBeLessThan(WORLD_R);
  });

  it("is off the sunset bearing rather than on it", () => {
    /* Dead anti-solar washes the island out to a flat ghost — the sun disc,
       the glare road and the bloom all land on the same pixels as the rock.
       Forty-five degrees off is the shot. This pins the *relationship*, not
       the number, so retuning the sun moves the argument rather than silently
       invalidating it. */
    const p = 0.75;
    const a = (p - 0.25) * Math.PI * 2;
    const azim = -Math.PI * 0.72 + Math.cos(a) * 0.55;
    const elev = Math.sin(a) * 0.78;
    const c = Math.cos(Math.asin(elev));
    const sunBearing = Math.atan2(Math.cos(azim) * c, Math.sin(azim) * c);
    const anti = sunBearing + Math.PI;
    let off = Math.abs(((CAMP_BEARING - anti + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    off = (off * 180) / Math.PI;
    expect(off, "the camp has drifted onto the sun's own bearing").toBeGreaterThan(20);
    expect(off, "the camp has drifted off the sunset altogether").toBeLessThan(75);
  });
});

/* -------------------------------------------------------------------------
 * Landing
 * ---------------------------------------------------------------------- */

/** `collide.ts`'s deck rules, small enough to run here without a renderer. */
function supportOf(decks: Deck[], x: number, z: number, fromY: number): number {
  let best = -Infinity;
  for (const d of decks) {
    if (d.y > fromY || d.y <= best) continue;
    if (d.r !== undefined) {
      const dx = x - (d.x ?? 0);
      const dz = z - (d.z ?? 0);
      if (dx * dx + dz * dz <= d.r * d.r) best = d.y;
    } else if (
      Math.abs(x - (d.x ?? 0)) <= (d.hx ?? 0) &&
      Math.abs(z - (d.z ?? 0)) <= (d.hz ?? 0)
    ) {
      best = d.y;
    }
  }
  return best;
}

describe("landing on it", () => {
  const site = buildLakeside(ctx);

  it("makes the whole lake a floor, which it was not before", () => {
    /* The one thing in this file the world cannot do without. Sampled right
       out to the shore, because a deck that only covers the camp is a lake
       you fall through everywhere else — which is worse than falling through
       all of it, since it works where you tested it. */
    for (let r = 0; r < LAKE_R - 2; r += 61) {
      for (let a = 0; a < Math.PI * 2; a += 0.7) {
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        expect(supportOf(site.decks, x, z, ISLAND_Y)).toBe(WATER_Y);
      }
    }
  });

  it("does not put a floor under the mountains", () => {
    // A disc out to WORLD_R would stand a body at 0.35 m inside a peak.
    expect(supportOf(site.decks, LAKE_R + 60, 0, ISLAND_Y)).toBe(-Infinity);
  });

  it("has a stair to the Long Look that a body can walk up and back down", () => {
    /* The flight runs along world +Z from the deck edge — see the note in
       `lakeside.ts` about why it is square to the world and not to the camp.
       Walking in: every rise has to be inside `CLIMB` or it is a step you can
       only jump. Walking out: the support must come back *down* the same way,
       which is the assertion that catches over-covering treads. */
    const x = site.look.x;
    const z0 = site.look.z;
    const heights: number[] = [];
    for (let d = 22; d >= -1; d -= 0.25) {
      heights.push(supportOf(site.decks, x, z0 + d, ISLAND_Y));
    }
    expect(heights[0]).toBe(WATER_Y);
    expect(heights[heights.length - 1]).toBeCloseTo(ICE_Y + LOOK_DECK, 5);

    let prev = heights[0];
    for (let i = 1; i < heights.length; i++) {
      const h = supportOf(site.decks, x, z0 + 22 - i * 0.25, prev + CLIMB);
      expect(h, `a ${(h - prev).toFixed(2)} m rise at step ${i} is not walkable`).toBeLessThanOrEqual(
        prev + CLIMB + 1e-6,
      );
      expect(Number.isFinite(h), "the flight has a hole in it").toBe(true);
      prev = h;
    }
    expect(prev).toBeCloseTo(ICE_Y + LOOK_DECK, 5);

    /* And back out. A tread whose box reaches over the tread below leaves the
       body standing at the higher height with nothing under it. */
    let out = ICE_Y + LOOK_DECK;
    for (let i = 0; i <= 88; i++) {
      out = supportOf(site.decks, x, z0 + i * 0.25, out + CLIMB);
      expect(Number.isFinite(out)).toBe(true);
    }
    expect(out, "the way down off the deck does not reach the ice").toBe(WATER_Y);
  });

  it("puts a deck on top of every blocker, so nothing is a box you sink into", () => {
    /* A blocker with no deck is a hut whose walls stop you and whose roof does
       not hold you: land on it and you slide down inside its own walls, which
       reads as clipping through the world. */
    for (const b of site.blockers) {
      const top = supportOf(site.decks, b.x, b.z, b.top + 0.01);
      expect(top, `nothing to stand on over the blocker at ${b.x.toFixed(0)}, ${b.z.toFixed(0)}`).toBeCloseTo(
        b.top,
        4,
      );
    }
  });

  it("keeps every box finite, positive, above the ice and the right way up", () => {
    expect(site.blockers.length).toBeGreaterThan(6);
    for (const b of site.blockers) {
      for (const v of [b.x, b.z, b.hx, b.hz, b.top, b.bottom]) expect(Number.isFinite(v)).toBe(true);
      expect(b.hx).toBeGreaterThan(0);
      expect(b.hz).toBeGreaterThan(0);
      expect(b.top).toBeGreaterThan(b.bottom);
      expect(b.bottom).toBeGreaterThanOrEqual(ICE_Y - 0.001);
      // Nothing here may be tall enough to be seen as a building from the
      // deck: the island is the subject of every frame and a mast on the ice
      // that out-climbs the keel's tip is a second thing in the picture.
      expect(b.top).toBeLessThan(60);
      // And on the ice, not out on the snow.
      expect(Math.hypot(b.x, b.z)).toBeLessThan(LAKE_R);
    }
    for (const d of site.decks) {
      expect(Number.isFinite(d.y)).toBe(true);
    }
    site.dispose();
  });
});

/* -------------------------------------------------------------------------
 * The build, and the failures whose symptom is a black screen
 * ---------------------------------------------------------------------- */

describe("what it builds", () => {
  it("puts its geometry at the camp and not at the origin", () => {
    const site = buildLakeside(ctx);
    site.update?.(frame(new THREE.Vector3(CAMP_X, 6, CAMP_Z + 40)));
    site.group.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(site.group);
    expect(b.isEmpty()).toBe(false);
    const c = new THREE.Vector3();
    b.getCenter(c);
    /* Geometry left in local space centres on the world origin — which here
       is directly under the island, 880 m away, and looks from most angles
       like the camp simply not being there. */
    expect(Math.hypot(c.x - CAMP_X, c.z - CAMP_Z)).toBeLessThan(320);
    // And it sits on the lake rather than in it or over it.
    expect(b.min.y).toBeGreaterThan(ICE_Y - 6);
    site.dispose();
  });

  it("has no NaN in any position buffer", () => {
    /* One NaN collapses a bounding sphere and the mesh stops drawing, with no
       error anywhere. It is the single most expensive silent failure in this
       world and it costs a traversal to rule out. */
    const site = buildLakeside(ctx);
    for (let i = 0; i < 6; i++) site.update?.(frame(new THREE.Vector3(CAMP_X + 20, 4, CAMP_Z + 30)));
    const bad: string[] = [];
    site.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh && !(o as THREE.Points).isPoints) return;
      const geo = m.geometry as THREE.BufferGeometry;
      for (const name of Object.keys(geo.attributes)) {
        const a = geo.getAttribute(name) as THREE.BufferAttribute;
        const arr = a.array as ArrayLike<number>;
        for (let i = 0; i < arr.length; i++) {
          if (!Number.isFinite(arr[i])) {
            bad.push(`${o.name || o.type}.${name}[${i}]`);
            break;
          }
        }
      }
      const inst = o as THREE.InstancedMesh;
      if (inst.isInstancedMesh) {
        const arr = inst.instanceMatrix.array;
        for (let i = 0; i < arr.length; i++) {
          if (!Number.isFinite(arr[i])) {
            bad.push(`${o.name}.instanceMatrix[${i}]`);
            break;
          }
        }
      }
    });
    expect(bad).toEqual([]);
    site.dispose();
  });

  it("instances its population rather than drawing it one body at a time", () => {
    const site = buildLakeside(ctx);
    site.update?.(frame(new THREE.Vector3(CAMP_X, 4, CAMP_Z + 30)));
    let instanced = 0;
    let bodies = 0;
    site.group.traverse((o) => {
      const inst = o as THREE.InstancedMesh;
      if (inst.isInstancedMesh) {
        instanced += 1;
        bodies += inst.count;
      }
    });
    expect(instanced).toBeGreaterThanOrEqual(2);
    expect(bodies).toBeGreaterThan(20);
    site.dispose();
  });

  it("is cheap from the deck and only detailed when somebody is down there", () => {
    const site = buildLakeside(ctx);

    // Standing on the rim, looking at the camp: the shells and the lights.
    site.update?.(new THREE.Vector3(0, ISLAND_Y - 32, 0) && frame(new THREE.Vector3(160, ISLAND_Y - 30, 314)));
    expect(site.onScreen).toBe(true);
    expect(site.detailed, "the close-range ice is being built from the city").toBe(false);
    const far = cost(site.group);

    // Standing on the ice at the camp.
    site.update?.(frame(new THREE.Vector3(CAMP_X + 14, 4, CAMP_Z + 26)));
    expect(site.detailed).toBe(true);
    const near = cost(site.group);

    expect(far.draws, `far tier draws ${far.draws}`).toBeLessThanOrEqual(4);
    expect(near.draws, `near tier draws ${near.draws}`).toBeLessThanOrEqual(11);
    expect(near.tris).toBeGreaterThan(far.tris);

    // Looking the other way from the plaza: nothing at all.
    site.update?.(
      frame(new THREE.Vector3(0, ISLAND_Y + 6, 0), new THREE.Vector3(-CAMP_X * 4, ISLAND_Y, -CAMP_Z * 4)),
    );
    expect(site.onScreen).toBe(false);
    expect(cost(site.group).draws).toBe(0);
    site.dispose();
  });

  it("builds a cheaper low tier", () => {
    const hi = buildLakeside({ quality: "high", seedSalt: "test" });
    const lo = buildLakeside({ quality: "low", seedSalt: "test" });
    const f = frame(new THREE.Vector3(CAMP_X + 14, 4, CAMP_Z + 26));
    hi.update?.(f);
    lo.update?.(f);
    expect(cost(lo.group).tris).toBeLessThan(cost(hi.group).tris * 0.8);
    hi.dispose();
    lo.dispose();
  });

  it("is deterministic", () => {
    const a = buildLakeside(ctx);
    const b = buildLakeside(ctx);
    expect(a.blockers).toEqual(b.blockers);
    expect(a.decks).toEqual(b.decks);
    a.dispose();
    b.dispose();
  });

  it("stays out of the lake's reflection", () => {
    /* Everything here stands *on* the mirror. In the reflected group it would
       be its own underside, drawn a second time, under a surface that keeps a
       third of its own colour — and every gradient in this file runs on world
       Y, which mirrored is the one bug the reflection has ever had. */
    const site = buildLakeside(ctx);
    expect(site.reflected).toBeFalsy();
    site.dispose();
  });

  it("offers the telescope and the fire where somebody standing there can reach them", () => {
    const site = buildLakeside(ctx);
    const offers = site.interactables();
    expect(offers.length).toBeGreaterThanOrEqual(2);
    const scope = offers.find((o) => o.id === "lakeside-scope");
    expect(scope).toBeTruthy();
    // On the deck, within arm's reach of the middle of it.
    expect(Math.hypot(scope!.x - site.look.x, scope!.z - site.look.z)).toBeLessThan(LOOK_R + 1);
    expect(scope!.y).toBeGreaterThan(ICE_Y + LOOK_DECK);
    const said: string[] = [];
    site.onToast = (t) => said.push(t);
    for (const o of offers) o.activate();
    expect(said.length).toBe(offers.length);
    site.dispose();
  });
});

/** Draws and triangles under an object, counted the way the driver would. */
function cost(root: THREE.Object3D): { draws: number; tris: number } {
  let draws = 0;
  let tris = 0;
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    const inst = o as THREE.InstancedMesh;
    const pts = o as THREE.Points;
    if (!(m.isMesh || pts.isPoints) || !o.visible) return;
    let p: THREE.Object3D | null = o.parent;
    while (p) {
      if (!p.visible) return;
      p = p.parent;
    }
    const geo = m.geometry as THREE.BufferGeometry | undefined;
    if (!geo) return;
    draws += 1;
    const index = geo.getIndex();
    const verts = index ? index.count : (geo.getAttribute("position")?.count ?? 0);
    const per = m.isMesh ? verts / 3 : 0;
    tris += per * (inst.isInstancedMesh ? inst.count : 1);
  });
  return { draws, tris: Math.round(tris) };
}
