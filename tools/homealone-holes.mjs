/**
 * Floor map for House Rules: probes groundAt on a grid for each storey and
 * prints where there is nothing underfoot. `#` wall, `.` floor, `/` stair,
 * `v` a lower floor is what catches you, `X` nothing at all (the bottom of the
 * map). Any X a player can reach is a bug. Exits non-zero if one is found
 * inside the lot.
 */
import { open } from "./hr-lib.mjs";
const h = await open();
await h.load(100);
const out = await h.page.evaluate(() => {
  const e = window.__homeAlone;
  const floors = [["basement", -2.95], ["ground", 0], ["upper", 3.15]];
  const res = {};
  for (const [name, fy] of floors) {
    const rows = [];
    let bad = 0;
    for (let z = -7.0; z <= 7.01; z += 0.2) {
      let row = "";
      for (let x = -8.0; x <= 8.01; x += 0.2) {
        const g = e.groundAt(x, z, fy + 0.62);
        const wall = e.blocked(x, fy + 0.6, z);
        let ch;
        if (wall) ch = "#";
        else if (g <= -50) { ch = "X"; bad++; }
        else if (Math.abs(g - fy) < 0.05) ch = ".";
        else if (g > fy - 0.65) ch = "/";
        else ch = "v";
        row += ch;
      }
      rows.push(row);
    }
    res[name] = { rows, bad };
  }
  return res;
});
// Only holes somebody can walk to count: flood out from a spot on each storey
// through everything that is not a wall, and see whether the flood meets one.
const SEEDS = { basement: [-4.4, -3.0], ground: [0.4, 2.6], upper: [0.4, -0.4] };
let total = 0;
for (const [name, { rows }] of Object.entries(out)) {
  const grid = rows.map((r) => [...r]);
  const [sx, sz] = SEEDS[name];
  const start = [Math.round((sz + 7) / 0.2), Math.round((sx + 8) / 0.2)];
  const seen = new Set([start.join()]);
  const todo = [start];
  const found = [];
  while (todo.length) {
    const [r, c] = todo.pop();
    const ch = grid[r]?.[c];
    if (!ch || ch === "#") continue;
    if (ch === "X") { found.push([(-8 + c * 0.2).toFixed(1), (-7 + r * 0.2).toFixed(1)]); continue; }
    // A drop to the storey below is that storey's business, and the lawn is
    // not part of the upstairs.
    if (ch === "v" && name === "upper") continue;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = [r + dr, c + dc];
      if (!seen.has(k.join())) { seen.add(k.join()); todo.push(k); }
    }
  }
  console.log(`\n== ${name}: ${found.length} reachable holes ${found.slice(0, 6).map((f) => `(${f})`).join(" ")} ==`);
  if (process.argv.includes("--map")) console.log(rows.join("\n"));
  total += found.length;
}
await h.close();
if (total) { console.log(`FAIL: ${total} reachable cells with no floor`); process.exit(1); }
console.log("ok: no holes");
