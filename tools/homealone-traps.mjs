/**
 * The second round's promises, checked in the running game: traps go down on
 * the stairs and go off there, honey sticks and then slows, the BB gun hurts,
 * and nobody in the house moves faster than a brisk walk.
 */
import { open } from "./hr-lib.mjs";
const h = await open();
await h.load(100);
let bad = 0;
const check = (name, ok, extra = "") => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${name} ${extra}`); };
const ev = (fn, arg) => h.page.evaluate(fn, arg);
const N = Math.PI;

/* ---- stairs ---- */
let r = await ev(() => {
  const e = window.__homeAlone;
  const out = {};
  e.teleport(-2.6, 0, 4.9, Math.PI); e.settle(0.2);
  e.selectKit("marbles"); out.foot = e.place(); out.footWhy = e.snapshot().placeHint;
  e.selectKit(null);
  e.teleport(-2.6, 1.6, 2.2, Math.PI); e.settle(0.3);
  e.selectKit("slick"); out.mid = e.place(); out.midWhy = e.snapshot().placeHint;
  e.selectKit(null);
  out.placed = e.debug().placed.map((p) => ({ kind: p.kind, y: +p.y.toFixed(2), z: +p.z.toFixed(2), tiltX: +(p.tiltX ?? 0).toFixed(2) }));
  return out;
});
check("a trap goes down from the foot of the stairs onto the flight", r.foot && r.placed[0].y > 0.2 && r.placed[0].tiltX !== 0, JSON.stringify(r.placed[0] ?? r.footWhy));
check("and from half-way up", r.mid && r.placed[1]?.y > 1.5, JSON.stringify(r.placed[1] ?? r.midWhy));

r = await ev(() => {
  const e = window.__homeAlone;
  e.teleport(5, 0, 3, 0); e.settle(0.1);
  e.callIn(); e.settle(0.2);
  const b = e.burglars[e.burglars.length - 1];
  const slick = e.debug().placed.find((p) => p.kind === "slick");
  b.pos.set(slick.x, slick.y - 0.15, slick.z + 0.2); b.yaw = Math.PI; b.state = "prowl";
  e.settle(0.15);
  const mid = { y: b.pos.y, flung: !!b.flung, state: b.state };
  e.settle(4);
  return { mid, y: b.pos.y, z: b.pos.z, state: b.state, feed: e.snapshot().feed.map((f) => f.text) };
});
check("somebody who treads on it half-way up goes to the bottom", r.y < 0.3 && r.z > 3.5, `y ${r.y.toFixed(2)} z ${r.z.toFixed(2)} ${r.feed.join(" | ")}`);
check("and that is a chain", r.feed.some((f) => /TUMBLE|Marbles/.test(f)), r.feed.join(" | "));

/* ---- honey ---- */
await h.load(100);
await h.lay("honey", 0.4, 0, 3.4);
await h.lay("mousetrap", 4.4, 0, 3.0);
await h.lay("rake", 4.6, 0, -1.2);
r = await ev(() => {
  const e = window.__homeAlone;
  e.teleport(-5, 0, 3, 0); e.settle(0.1);
  e.callIn(); e.settle(0.2);
  const b = e.burglars[e.burglars.length - 1];
  const at = (kind) => e.debug().placed.find((p) => p.kind === kind);
  const out = { laid: e.debug().placed.map((p) => p.kind) };
  let p = at("honey");
  b.pos.set(p.x, 0, p.z); b.state = "prowl"; e.settle(0.2);
  out.stuck = { rooted: b.rooted, honeyed: b.honeyed, slowed: b.slowed, x: b.pos.x, z: b.pos.z };
  e.settle(2);
  out.still = Math.hypot(b.pos.x - p.x, b.pos.z - p.z);
  e.settle(2.5);
  out.free = { rooted: b.rooted, slowed: b.slowed, honeyed: b.honeyed, fx: !!b.honeyFx?.visible };
  p = at("mousetrap"); const n0 = b.nerve;
  b.pos.set(p.x, 0, p.z); b.state = "prowl"; b.slowed = 0; e.settle(0.2);
  out.snap = { slowed: b.slowed, state: b.state, lost: n0 - b.nerve };
  p = at("rake"); const n1 = b.nerve;
  b.pos.set(p.x, 0, p.z); b.state = "prowl"; e.settle(0.2);
  out.rake = { state: b.state, stun: b.stun, lost: n1 - b.nerve };
  out.feed = e.snapshot().feed.map((f) => f.text);
  return out;
});
check("all three new traps lay", r.laid.join() === "honey,mousetrap,rake", r.laid.join());
check("honey: stuck fast and covered in it", r.stuck.rooted > 3 && r.stuck.honeyed > 0 && r.still < 0.3, JSON.stringify(r.stuck));
check("honey: lets go, and he is slow and still wearing it", r.free.rooted === 0 && r.free.slowed > 0 && r.free.fx, JSON.stringify(r.free));
check("mousetraps: hobbled, still on his feet", r.snap.slowed > 4 && r.snap.state !== "down" && r.snap.lost > 0, JSON.stringify(r.snap));
check("rake: out cold on the spot", r.rake.state === "down" && r.rake.stun > 3 && r.rake.lost > 0, JSON.stringify(r.rake));

/* ---- BB gun ---- */
await h.load(100);
r = await ev(() => {
  const e = window.__homeAlone;
  e.teleport(0.4, 0, 4.6, Math.PI); e.settle(0.1);
  e.callIn(); e.settle(0.2);
  const b = e.burglars[e.burglars.length - 1];
  b.pos.set(0.4, 0, 1.4); b.yaw = Math.PI; b.state = "prowl";
  const n0 = b.nerve;
  e.camYaw = Math.PI; e.camPitch = 0;
  let fired = 0;
  for (let i = 0; i < 5; i++) { b.pos.set(0.4, 0, 1.4); e.throwBrick(); fired++; e.settle(0.6); }
  const d = e.debug();
  return { n0, n1: b.nerve, shots: d.shots, hit: d.shotsHit, state: b.state };
});
check("the BB gun fires, and it lands", r.shots === 5 && r.hit >= 4, JSON.stringify(r));
check("every BB costs him nerve", r.n0 - r.n1 >= r.hit * 7 - 0.01, `${r.n0} -> ${r.n1}`);

/* ---- nobody runs ---- */
r = await ev(() => {
  const e = window.__homeAlone;
  e.spectator = false; e.grace = 0;
  const b = e.burglars[e.burglars.length - 1];
  b.nerve = b.kind.nerve; b.stun = 0;
  e.teleport(0.4, 0, 5.0, Math.PI);
  b.pos.set(0.4, 0, -2.2); b.yaw = 0; b.state = "prowl"; b.char.down = 0;
  e.settle(0.5);
  const z0 = b.pos.z, s0 = b.state;
  e.settle(1.5);
  const hunt = (b.pos.z - z0) / 1.5;
  e.spectator = true;
  b.nerve = 0; b.state = "flee"; b.pos.set(0.4, 0, 1.0); e.settle(0.3);
  const p0 = b.pos.clone(); e.settle(1.0);
  return { state: s0, hunt, flee: b.pos.distanceTo(p0) };
});
check("coming for you is a walk", r.state === "hunt" && r.hunt > 1.5 && r.hunt < 3.3, `${r.hunt.toFixed(2)} m/s, ${r.state}`);
check("and so is leaving", r.flee > 1.5 && r.flee < 3.7, `${r.flee.toFixed(2)} m/s`);

if (h.errors.length) { bad++; console.log(h.errors.join("\n")); }
await h.close();
process.exit(bad ? 1 : 0);
