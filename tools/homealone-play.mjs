#!/usr/bin/env node
/**
 * homealone-play: run whole nights, headless, and assert on what happened.
 *
 * A screenshot proves the house renders. It proves nothing about whether a
 * trap fires when somebody walks over it, whether one trap throws him onto the
 * next, or whether a night can end at all. Those are the failures that waste a
 * player's evening, and none of them show up in `npm run build`.
 *
 * The sandbox draws this house at about a frame a second, so everything here
 * goes through `engine.settle()`, which steps the simulation without drawing.
 *
 *   node tools/homealone-play.mjs
 */
import { open } from "./hr-lib.mjs";

const { page, errors, load, lay, close } = await open();
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : "FAIL  "} ${name}${detail ? `  (${detail})` : ""}`);
};
const settle = (s) => page.evaluate((s) => window.__homeAlone.settle(s), s);
const snap = () => page.evaluate(() => window.__homeAlone.snapshot());

/** Step until the night is over or `max` seconds pass, collecting what the HUD said. */
async function runNight(max) {
  return page.evaluate((max) => {
    const e = window.__homeAlone;
    const seen = { banners: new Set(), feed: new Map(), minLoot: 6, states: new Set() };
    for (let t = 0; t < max; t += 0.5) {
      e.settle(0.5);
      const s = e.snapshot();
      if (s.banner) seen.banners.add(s.banner);
      for (const f of s.feed) seen.feed.set(f.id, `${f.who}: ${f.text} (${f.chain}x)`);
      for (const b of s.intruders) seen.states.add(b.state);
      seen.minLoot = Math.min(seen.minLoot, s.loot.filter((l) => l.state === "safe").length);
      if (s.phase !== "playing") break;
    }
    const s = e.snapshot();
    return {
      phase: s.phase, result: s.result, bestChain: s.bestChain, hearts: s.hearts, parts: s.parts,
      banners: [...seen.banners], feed: [...seen.feed.values()], states: [...seen.states], minLoot: seen.minLoot,
    };
  }, max);
}

/* ---- 1. Do nothing, and they take everything ------------------------------ */
await load(1);
let s = await snap();
check("night 1 opens in the planning stage", s.stage === "plan" && s.parts === 12 && s.kit.length === 4, `${s.stage}, ${s.parts} parts, ${s.kit.length} traps`);
check("the list shows who is coming and when", s.intruders.length === 2 && s.intruders.every((b) => b.eta > 0));
await page.evaluate(() => window.__homeAlone.ready());
let r = await runNight(400);
check("an undefended house is cleaned out", r.phase === "lost" && r.result?.won === false, r.phase);
check("they carry things out and come back for more", r.banners.some((b) => /GOT AWAY WITH/.test(b)) && r.banners.some((b) => /BACK FOR MORE/.test(b)));

/* ---- 2. Night 1 with a sensible layout and nobody at the controls --------- */
await load(1);
const plan1 = [
  ["tripwire", 0.4, 0, 5.4], ["marbles", 0.4, 0, 3.6], ["tripwire", 0.4, 0, 1.6],
  ["glue", 2.2, 0, 3.4], ["marbles", 3.4, 0, 3.2],
  ["tripwire", 3.6, 0, -3.0], ["tripwire", 4.2, 0, -2.0],
];
let laid = 0;
for (const [k, x, y, z] of plan1) if ((await lay(k, x, y, z)).ok) laid++;
s = await snap();
check("traps can be laid and cost parts", laid === plan1.length && s.laid === laid && s.parts === 2, `${laid} laid, ${s.parts} parts left`);
await page.evaluate(() => { const e = window.__homeAlone; e.teleport(-5.5, 3.1, -3.0, 0); e.ready(); });
r = await runNight(400);
console.log(r.feed.map((f) => `        ${f}`).join("\n"));
check("traps fire on people walking the routes", r.feed.length >= 4, `${r.feed.length} lines`);
check("a body thrown onto another trap is a chain", r.bestChain >= 2, `best ${r.bestChain}x`);
check("hits pay parts back", r.parts > 2, `${r.parts}`);
check("somebody lost his nerve and ran", r.banners.some((b) => /HAS HAD ENOUGH/.test(b)));

/* ---- 3. Being caught costs a heart, not the night -------------------------- */
await load(1);
await page.evaluate(() => { const e = window.__homeAlone; e.spectator = false; e.teleport(0.4, 0, 2.6, 0); e.ready(); });
await settle(14);
s = await snap();
const d = await page.evaluate(() => window.__homeAlone.debug().pos);
check("caught: one heart gone, back in your own room", s.hearts === 2 && s.phase === "playing" && d.y > 2.5, `${s.hearts} hearts, y ${d.y.toFixed(1)}`);

/* ---- 4. Night 4: every trap, the stairs, and Nell --------------------------- */
await load(4);
const plan4 = [
  ["slick", 0.4, 0, 3.8, 0], ["spring", 0.4, 0, 0.9, Math.PI / 2], ["sack", 3.4, 0, -3.6, Math.PI],
  ["flour", 2.2, 0, 3.4, 0], ["marbles", -2.6, 0, 3.4, 0], ["spring", -2.6, 3.1, -0.2, 0],
];
laid = 0;
for (const [k, x, y, z, yaw] of plan4) if ((await lay(k, x, y, z, yaw)).ok) laid++;
check("night 4 has the whole box", laid === plan4.length && (await snap()).kit.length === 8);
await page.evaluate(() => { const e = window.__homeAlone; e.teleport(-5.5, 3.1, -3.0, 0); e.ready(); });
r = await runNight(500);
console.log(r.feed.map((f) => `        ${f}`).join("\n"));
check("a three-link chain lands", r.bestChain >= 3, `best ${r.bestChain}x`);
check("walls and stairs count as links", r.feed.some((f) => /WALL SLAM|TUMBLE|BOWLING/.test(f)));
check("the night ends", r.phase !== "playing", r.phase);
check("the scorecard is filled in", !!r.result && r.result.lines.length === 3, JSON.stringify(r.result?.stars));

/* ---- 5. The sandbox --------------------------------------------------------- */
await load(100);
await lay("clock", 0.4, 0, 1.0);
await lay("glue", 0.4, 0, 3.8);
await page.evaluate(() => { const e = window.__homeAlone; e.callIn("moose"); e.settle(5); e.ring(); e.settle(6); });
s = await snap();
check("sandbox: everything in the box, somebody came when called", s.kit.length === 8 && s.intruders.length === 1 && s.sandbox);
check("sandbox: the glue caught him", s.feed.some((f) => /Glue/.test(f.text)));
const before = s.laid;
await page.evaluate(() => {
  const e = window.__homeAlone;
  const p = e.debug().placed.find((p) => p.kind === "clock");
  e.teleport(p.x, p.y, p.z, 0);
  e.settle(0.2);
  e.act();
  e.settle(0.2);
});
check("a trap at your feet can be picked back up", (await snap()).laid === before - 1);

/* ---- 6. The quiet modes still finish ---------------------------------------- */
await load(102);
await page.evaluate(() => {
  const e = window.__homeAlone;
  for (let i = 0; i < 40 && e.snapshot().phase === "playing"; i++) {
    const s = e.snapshot();
    if (s.compass === null) break;
    // Walk the compass: stand at the next dark room's switch and press it.
    const t = e.compassTarget;
    e.teleport(t.x, t.y, t.z);
    e.settle(0.2);
    e.act();
    e.settle(0.3);
  }
});
s = await snap();
check("Somebody's Home can be won", s.phase === "won", `${s.done}/${s.total}`);

/* ---- 7. The nights do not run out ------------------------------------------- */
await load(8);
s = await snap();
check("night 8 exists", s.kind === "night" && s.intruders.length >= 8 && s.parts > 26, `${s.intruders.length} coming, ${s.parts} parts`);

if (errors.length) console.log(errors.join("\n"));
check("no page errors", errors.length === 0);
await close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
