import { describe, it } from "vitest";
import { cityPlan, surfaceAt, walkableAt, clearanceAt } from "@/empyrean/cityplan";

describe("scratch", () => {
  it("dumps the chosen lot", () => {
    const plan = cityPlan();
    for (const id of ["b0-5-11", "b0-5-10", "b0-2-11"]) {
      const l = plan.lots.find((k) => k.id === id)!;
      console.log("=====", id, "h", l.height, "y", l.y, "a", l.a, "r", l.r, "frontEdge", l.frontEdge);
      console.log("centroid", l.centroid, "frontMid", l.frontMid, "frontNormal", l.frontNormal, "frontLen", l.frontLen, "door", l.door);
      console.log("poly", l.poly.map((p) => `(${p.x.toFixed(2)},${p.z.toFixed(2)})`).join(" "));
      const yaw = Math.atan2(l.frontNormal.z, l.frontNormal.x);
      console.log("yaw", yaw, "deg", (yaw * 180 / Math.PI).toFixed(1));
      // local frame: +Z out the door, +X = ?
      // toWorld(px,pz) = (ox + px*sin(yaw) + pz*cos(yaw), oz - px*cos(yaw) + pz*sin(yaw))
      const s = Math.sin(yaw), c = Math.cos(yaw);
      // project poly into local frame around centroid
      const loc = l.poly.map((p) => {
        const dx = p.x - l.centroid.x, dz = p.z - l.centroid.z;
        return { px: dx * s - dz * c, pz: dx * c + dz * s };
      });
      console.log("local poly", loc.map((p) => `(${p.px.toFixed(2)},${p.pz.toFixed(2)})`).join(" "));
      const dm = { x: l.frontMid.x - l.centroid.x, z: l.frontMid.z - l.centroid.z };
      console.log("frontMid local", (dm.x*s - dm.z*c).toFixed(2), (dm.x*c + dm.z*s).toFixed(2));
      const dd = { x: l.door.x - l.centroid.x, z: l.door.z - l.centroid.z };
      console.log("door local", (dd.x*s - dd.z*c).toFixed(2), (dd.x*c + dd.z*s).toFixed(2));
      console.log("surface at door", surfaceAt(l.door.x, l.door.z), "walkable", walkableAt(l.door.x, l.door.z));
      console.log("surface at frontMid", surfaceAt(l.frontMid.x, l.frontMid.z), "walkable", walkableAt(l.frontMid.x, l.frontMid.z));
      // walk outward from frontMid along frontNormal
      for (let t = 0; t <= 8; t += 1) {
        const x = l.frontMid.x + l.frontNormal.x * t, z = l.frontMid.z + l.frontNormal.z * t;
        console.log("  out", t, surfaceAt(x, z).kind, surfaceAt(x, z).y.toFixed(2), walkableAt(x, z));
      }
    }
  });
});
