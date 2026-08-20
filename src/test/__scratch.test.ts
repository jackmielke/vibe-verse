import { it } from "vitest";
import { groundHeight } from "@/empyrean/terrain";
it("profile", () => {
  const cx = -2241, cz = -517;
  // local grid, +u along the bearing to the island (unit), +v perpendicular
  const R = Math.hypot(cx, cz);
  const ux = -cx / R, uz = -cz / R;      // toward the island
  const vx = -uz, vz = ux;
  let out = "     ";
  for (let j = -6; j <= 6; j++) out += (j * 40).toString().padStart(6);
  console.log(out);
  for (let i = -6; i <= 6; i++) {
    let line = (i * 40).toString().padStart(5);
    for (let j = -6; j <= 6; j++) {
      const x = cx + ux * i * 40 + vx * j * 40;
      const z = cz + uz * i * 40 + vz * j * 40;
      line += groundHeight(x, z).toFixed(0).padStart(6);
    }
    console.log(line);
  }
  console.log("centre", groundHeight(cx, cz).toFixed(1), "R", R.toFixed(0), "az", (Math.atan2(cz, cx) * 180 / Math.PI).toFixed(1));
});
