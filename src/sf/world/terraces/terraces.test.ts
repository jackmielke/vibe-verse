/**
 * The Terraces, built without a browser.
 *
 * There is exactly one thing worth asserting about a landmark that is modelled
 * in code, and it is not that it produced triangles. It is that the triangles
 * face outwards.
 *
 * `loft()` derives its normals from ring winding, and every ring builder in
 * `kit.ts` winds the way that comes out pointing *inward*. Most of the
 * landmark directory never noticed, because a double-sided or matte material
 * hides it; the watercolour materials here are single-sided and lean on a
 * fresnel term, so an inverted wall does not look like an error — it looks
 * like a pale, oddly lit solid with black patches where you are seeing the
 * inside of the far wall through the culled near one. That is a very
 * expensive thing to diagnose from a screenshot at a third of a frame per
 * second, and it is one line to check here.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Batch } from "../landmarks/kit";
import { makeRng } from "../../math/rng";
import type { ColliderSink, LandmarkCtx } from "../landmarks/types";
import {
  clearLandmarkColliders,
  landmarkColliders,
  landmarkSurfaceHeight,
  makeColliderSink,
} from "../landmarks/types";
import type { LandmarkCollider } from "../landmarks/types";
import type { LandmarkDef } from "../../geo/sfGeo";
import { SPAWN_DEFS } from "../../geo/spawnList";
import { watercolourTerraces } from "./terraces";

const DEF: LandmarkDef = {
  key: "terraces",
  kind: "watercolour-terraces",
  name: "The Terraces",
  x: 0,
  z: 0,
  rotation: 0,
  height: 150,
  radius: 230,
  navpoint: true,
};

/** A flat 300 m hill, so the structure's own geometry is the only variable. */
const GROUND = 300;

/**
 * Build through the *real* collider registry rather than a stand-in.
 *
 * The first version of this test hand-rolled a sink and a point query, and it
 * passed while the summit was unstandable in the actual game — because the
 * thing that was wrong was in neither of them. Use `makeColliderSink` and
 * `landmarkSurfaceHeight`, and the test is testing what the player walks on.
 */
function build(detail: boolean): { root: THREE.Group; boxes: readonly LandmarkCollider[] } {
  clearLandmarkColliders();
  const batch = new Batch();
  const ctx: LandmarkCtx = {
    def: DEF,
    lod: detail ? 0 : 1,
    detail,
    rng: makeRng("terraces-test"),
    batch,
    yaw: 0,
    originY: GROUND,
    ground: () => GROUND,
    worldX: (lx) => lx,
    worldZ: (_lx, lz) => lz,
    localX: (wx) => wx,
    localZ: (_wx, wz) => wz,
    collide: makeColliderSink(DEF, 0, true),
    onFrame: () => {},
  };
  watercolourTerraces.build(ctx);
  const root = new THREE.Group();
  batch.flush(root, { name: "terraces" });
  return { root, boxes: landmarkColliders().slice() };
}

describe("The Terraces", () => {
  it("builds at both levels of detail", () => {
    for (const detail of [true, false]) {
      const { root } = build(detail);
      expect(root.children.length).toBeGreaterThan(3);
      let tris = 0;
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.geometry) return;
        const idx = m.geometry.getIndex();
        const n = idx ? idx.count : (m.geometry.getAttribute("position")?.count ?? 0);
        tris += (n / 3) * ((m as THREE.InstancedMesh).count || 1);
      });
      expect(tris).toBeGreaterThan(detail ? 20000 : 1000);
    }
  });

  it("faces outward, everywhere on the retaining walls", () => {
    /* Sample every vertex on the near-vertical surfaces and check its normal
       agrees with the direction away from the mountain's axis. Near-horizontal
       surfaces (decks, roofs, the pool) are excluded: their normals are
       vertical and have nothing to say about which way round the ring went. */
    const { root } = build(true);
    let checked = 0;
    let wrong = 0;
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const radial = new THREE.Vector3();

    root.traverse((o) => {
      const m = o as THREE.Mesh;
      // Instanced pieces (vines, lanterns, figures, panels) are boxes and
      // lathes, whose winding never came from a ring.
      if (!m.geometry || (m as THREE.InstancedMesh).isInstancedMesh) return;
      const pos = m.geometry.getAttribute("position");
      const nor = m.geometry.getAttribute("normal");
      if (!pos || !nor) return;
      for (let i = 0; i < pos.count; i += 7) {
        p.fromBufferAttribute(pos, i);
        n.fromBufferAttribute(nor, i);
        // Only the walls: steep faces, out where the terraces are.
        if (Math.abs(n.y) > 0.35) continue;
        radial.set(p.x, 0, p.z);
        if (radial.length() < 60) continue;
        radial.normalize();
        checked++;
        if (n.dot(radial) < -0.25) wrong++;
      }
    });

    expect(checked).toBeGreaterThan(200);
    /* Not zero: the pool basin is deliberately inside-out — you look down into
       it — and the pagoda and the model city have vertical faces on all four
       sides that have nothing to do with the mountain's axis. A handful is
       fine; a wall the wrong way round is thousands. */
    expect(wrong / checked).toBeLessThan(0.12);
  });

  it("gives every terrace something to stand on", () => {
    /* Colliders are recorded from the *far* build — `Landmarks.tsx` passes
       `record: true` for lod 1 — so a builder that puts them behind a `detail`
       check registers none at all, and the summit spawn drops the player a
       hundred and forty metres through the mountain. That is exactly what
       happened. */
    const { boxes } = build(false);
    const decks = boxes.filter((b) => b.walkable);
    expect(decks.length).toBeGreaterThan(100);

    // Seven distinct deck elevations, one per level, all above the hill.
    const tops = new Set(decks.map((b) => Math.round(b.y + b.hy)));
    expect(tops.size).toBeGreaterThanOrEqual(7);
    for (const t of tops) expect(t).toBeGreaterThanOrEqual(GROUND);
  });

  it("puts a walkable surface directly under the summit spawn", () => {
    /* The `terraces` spawn sets `walkY`, and it has to agree with the
       structure or the spawn is inside the mountain — which is precisely what
       happened, twice: first because the summit is 52 m back from the
       landmark's anchor and the spawn was over the anchor, and then because
       the sector colliders were declared with the wrong yaw sign for the query
       that decides what you are standing on. Both are invisible from a
       screenshot; both are one line here. */
    const spawn = SPAWN_DEFS.find((s) => s.key === "terraces")!;
    expect(spawn.walkY).toBeDefined();
    // The spawn in this landmark's frame: the anchor is at (-4073, 4364) and
    // the group yaw is zero, and `DEF` above is anchored at the origin.
    const sx = spawn.x! - -4073;
    const sz = spawn.z! - 4364;

    build(false);
    const spawnY = GROUND + spawn.walkY!;
    const deck = landmarkSurfaceHeight(sx, sz, spawnY + 6);
    expect(deck).not.toBeNull();
    expect(deck!).toBeGreaterThan(GROUND + 140);
    // Land on it, rather than inside the mountain or forty metres above it.
    expect(spawnY).toBeGreaterThan(deck! - 1);
    expect(spawnY).toBeLessThan(deck! + 6);
  });

  it("is standable all the way up, not only at the summit", () => {
    /* One sample per level, on the widest part of each deck. A hole in a
       terrace is a fall of up to 148 m and the player has no way to see it
       coming. */
    build(false);
    for (let i = 0; i < 7; i++) {
      const y = GROUND + [16, 38, 60, 82, 104, 126, 148][i];
      let found = 0;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        // Halfway between this level's edge and the next level's wall.
        const r = [190, 152, 118, 88, 62, 40, 22][i] * 0.88;
        const back = [0, 9, 19, 29, 38, 46, 52][i];
        const cx = -back * Math.cos(-0.68);
        const cz = -back * Math.sin(-0.68);
        const h = landmarkSurfaceHeight(cx + Math.cos(a) * r, cz + Math.sin(a) * r, y + 4);
        if (h !== null && Math.abs(h - y) < 2) found++;
      }
      expect(found, `level ${i}`).toBeGreaterThanOrEqual(11);
    }
  });
});
