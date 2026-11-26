#!/usr/bin/env node
/**
 * homealone-shot: lay a few traps in the hall and take a real frame.
 *
 *   node tools/homealone-shot.mjs out.png [level] [seconds-into-raid]
 *
 * The HUD is in the picture, because the HUD is half of what there is to
 * check. With a third argument the doors are opened and the simulation is
 * stepped that many seconds first, so the frame has people in it.
 */
import { open } from "./hr-lib.mjs";

const out = process.argv[2] ?? "house-rules.png";
const level = Number(process.argv[3] ?? 2);
const into = Number(process.argv[4] ?? 0);

const { page, errors, load, lay, close } = await open({ width: 1280, height: 720 });
await load(level);
await lay("marbles", 0.4, 0, 3.4);
await lay("tripwire", 0.4, 0, 1.6);
await lay("glue", 2.2, 0, 3.4);
await page.evaluate((into) => {
  const e = window.__homeAlone;
  e.teleport(0.4, 0, 0.2, 0);
  e.look(0, 0.22);
  if (into > 0) {
    e.ready();
    e.settle(into);
  } else {
    e.selectKit("marbles");
    e.settle(0.2);
  }
}, into);
const f0 = await page.evaluate(() => window.__homeAlone.frames);
await page.waitForFunction((f) => window.__homeAlone.frames >= f, f0 + 2, { timeout: 180000 });
await page.screenshot({ path: out });
console.log(`wrote ${out}`);
if (errors.length) console.log(errors.join("\n"));
await close();
process.exit(errors.length ? 1 : 0);
