import { describe, it } from "vitest";
import * as THREE from "three";
import { buildInteriors } from "@/empyrean/interiors";

function cost(root: THREE.Object3D) {
  let draws = 0, tris = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh; const inst = o as THREE.InstancedMesh;
    if (!m.isMesh || !o.visible) return;
    const geo = m.geometry as THREE.BufferGeometry; if (!geo) return;
    draws++;
    const idx = geo.getIndex();
    const verts = idx ? idx.count : (geo.getAttribute("position")?.count ?? 0);
    tris += (verts / 3) * (inst.isInstancedMesh ? inst.count : 1);
    console.log("  ", o.name, Math.round(verts/3) * (inst.isInstancedMesh ? inst.count : 1));
  });
  return { draws, tris: Math.round(tris) };
}

describe("scratch cost", () => {
  for (const q of ["high", "low"] as const) {
    it("interiors " + q, () => {
      const b = buildInteriors({ quality: q, seedSalt: "budget" });
      console.log(q, cost(b.group));
      console.log("blockers", b.blockers.length, "decks", b.decks.length);
      b.dispose();
    });
  }
});
