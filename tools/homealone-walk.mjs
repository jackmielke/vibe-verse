/**
 * Walks Pip round the awkward corners of the house with the real controls and
 * checks he ends up where a person would: up the stairs and not inside them,
 * down the cellar flight, and never out of the bottom of the map.
 */
import { open } from "./hr-lib.mjs";
const h = await open();
await h.load(100);
let bad = 0;
const check = (name, ok, extra = "") => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${name} ${extra}`); };
/** Stand at a spot, face `yaw` (0 = south, +z), push forward for `t` seconds. */
const walk = (x, y, z, legs) => h.page.evaluate(([x, y, z, legs]) => {
  const e = window.__homeAlone;
  e.teleport(x, y, z, 0);
  e.settle(0.2);
  for (const [yaw, t] of legs) {
    e.camYaw = yaw;
    e.setStick(0, -1);
    e.settle(t);
  }
  e.setStick(0, 0);
  e.settle(0.3);
  const p = e.debug().pos;
  return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) };
}, [x, y, z, legs]);
const N = Math.PI, S = 0, E = Math.PI / 2, W = -Math.PI / 2;
const f = (p) => `(${p.x}, ${p.y}, ${p.z})`;

let p = await walk(0.4, 0, 4.7, [[W, 1.4], [N, 4.0]]);
check("front hall, through the opening, up the stairs to the landing", p.y > 3.1 && p.z < 0.5, f(p));
p = await walk(-2.6, 3.15, -0.4, [[S, 3.5]]);
check("back down the stairs to the foot", p.y < 0.05 && p.z > 4.0, f(p));
p = await walk(0.4, 0, 2.6, [[W, 2.0]]);
check("the hall wall beside the flight is a wall", p.x > -1.5 && p.y < 0.05, f(p));
p = await walk(-5.0, 0, 3.0, [[E, 2.0]]);
check("so is the den wall", p.x < -3.7 && p.y < 0.05, f(p));
p = await walk(-5.0, 0, 4.7, [[E, 1.6]]);
check("den to the foot of the stairs through the new doorway", p.x > -3.4 && p.y < 0.05, f(p));
p = await walk(-2.15, 0, -3.3, [[N, 0.6], [W, 4.5]]);
check("back hall, through the cellar door, down to the basement", p.y < -2.9, f(p));
p = await walk(-6.6, -2.95, -3.5, [[N, 0.6], [E, 3.5]]);
check("and back up", p.y > -0.05 && p.x > -2.9, f(p));
p = await walk(-4.5, -2.95, -3.2, [[N, 2.0]]);
check("cannot walk in under the cellar stairs", p.z > -4.05 && Math.abs(p.y + 2.95) < 0.05, f(p));
p = await walk(-4.5, 0, -3.2, [[N, 2.0]]);
check("the rail keeps you out of the stairwell", p.z > -4.0 && p.y > -0.05, f(p));
p = await walk(-4.0, -2.95, -2.0, [[S, 3.0]]);
check("the basement has a south wall", p.y > -3.0 && p.z < -1.0, f(p));
p = await walk(3.2, 0, -4.6, [[N, 0.35]]);
const q = await h.page.evaluate(() => { const e = window.__homeAlone; e.settle(3); return e.debug().pos.y; });
check("standing in the back doorway", q > -0.1, `${f(p)} then y ${q.toFixed(2)}`);
p = await walk(3.2, 0, -4.6, [[N, 3.0]]);
check("out of the back door onto the lawn", p.z < -6 && p.y > -0.1, f(p));
p = await walk(0.4, 0, 4.6, [[S, 2.5]]);
check("out of the front door onto the path", p.z > 6 && p.y > -0.1, f(p));
// The fall that used to go through the floor: down both flights at a sprint,
// and off the landing rail side from a height.
const sprint = (x, y, z, legs) => h.page.evaluate(([x, y, z, legs]) => {
  const e = window.__homeAlone;
  e.teleport(x, y, z, 0); e.settle(0.2); e.setSprint(true);
  let low = 99;
  for (const [yaw, t] of legs) {
    e.camYaw = yaw; e.setStick(0, -1);
    for (let i = 0; i < t * 10; i++) { e.settle(0.1); low = Math.min(low, e.debug().pos.y); }
  }
  e.setStick(0, 0); e.setSprint(false); e.settle(0.3);
  const p = e.debug().pos;
  return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), low: +low.toFixed(2) };
}, [x, y, z, legs]);
p = await sprint(-2.6, 3.15, -0.4, [[S, 1.6]]);
check("sprinting down the main stairs lands on the hall floor", p.y === 0 && p.low > -0.05, `${f(p)} lowest ${p.low}`);
p = await sprint(-2.15, 0, -4.7, [[W, 1.6]]);
check("sprinting down the cellar stairs lands on the basement floor", Math.abs(p.y + 2.95) < 0.01 && p.low > -3.0, `${f(p)} lowest ${p.low}`);
p = await h.page.evaluate(() => { const e = window.__homeAlone; e.teleport(4, 9, 3, 0); e.settle(3); return e.debug().pos; });
check("dropped from the sky onto the bedroom floor, not through it", Math.abs(p.y - 3.15) < 0.01, `y ${p.y.toFixed(2)}`);
p = await h.page.evaluate(() => { const e = window.__homeAlone; e.teleport(0.4, 0, 2.6, 0); e.settle(1); e.pos.set(0.4, -30, 2.6); e.grounded = false; e.settle(1); return e.debug().pos; });
check("the net: dropped under the house, put back on the floor", p.y > -0.1, f({ x: p.x, y: +p.y.toFixed(2), z: p.z }));
console.log(h.errors.join("\n"));
await h.close();
process.exit(bad ? 1 : 0);
