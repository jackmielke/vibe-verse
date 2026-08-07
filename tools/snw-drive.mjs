#!/usr/bin/env node
/**
 * snw-drive — fly STRANGE NEW WORLDS through its whole loop in a real browser.
 *
 * `npm run build` proves the world compiles. It proves nothing about whether
 * the planet shader links, whether the away team is facing the person they
 * came to meet, or whether the transporter puts them inside a mountain — and
 * those are the failures that stay invisible until somebody sits down to play.
 *
 * So this drives the actual route: title → orbit → scan → chart → warp →
 * orbit → beam down → walk → talk → beam up, then one frame per system. It
 * writes a screenshot at every stage, prints the conversation it got back, and
 * reports every console error.
 *
 * Usage:
 *   node tools/snw-drive.mjs [outDir] [--systems all]
 *
 * The reply it prints comes from the local bank rather than the model unless
 * the machine can reach Supabase. That is the point of the local bank, and
 * exercising it is worth doing on purpose.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const OUT = args.find((a) => !a.startsWith("--")) ?? "shots/snw";
const ALL = args.includes("--systems") && args[args.indexOf("--systems") + 1] === "all";
const PORT = Number(process.env.SNW_PORT ?? 5179);
const BASE = `http://127.0.0.1:${PORT}`;

mkdirSync(OUT, { recursive: true });

async function up(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const server = (await up(BASE, 1200))
  ? null
  : spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
      stdio: ["ignore", "ignore", "inherit"],
    });
if (server && !(await up(BASE, 60000))) {
  console.error("vite never came up");
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: process.env.SNW_CHROMIUM || undefined,
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--no-sandbox",
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });

const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 240)));
page.on("pageerror", (e) => errors.push("PAGEERROR " + String(e).slice(0, 240)));

await page.goto(`${BASE}/strange-new-worlds`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__snw, null, { timeout: 40000 });
await page.waitForTimeout(1500);

const shot = async (n) => {
  await page.screenshot({ path: `${OUT}/${n}.png` });
  console.log("   ", n);
};
/* Wait on state, never on a stopwatch. The fixed-step loop runs slower than
   real time on a software rasteriser, so a six-second warp can take fifteen. */
const idle = () =>
  page.waitForFunction(() => window.__snw.state.phase === "idle", null, { timeout: 120000 });
const stats = () =>
  page.evaluate(() => {
    const s = window.__snw.state;
    return `${s.system.key}/${s.mode}${s.orbiting ? "/orbit" : ""} alt ${s.altitude}km near=${s.near?.key ?? "-"}`;
  });

console.log("title card");
await shot("00-title");
await page.click("#snw-root .title .go");
await page.waitForTimeout(2500);
console.log("orbit:", await stats());
await shot("01-orbit");

await page.evaluate(() => window.__snw.scan());
await page.waitForTimeout(800);
await shot("02-scan");

await page.keyboard.press("m");
await page.waitForTimeout(700);
await shot("03-chart");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

console.log("warp to Vulcan");
await page.evaluate(() => window.__snw.setCourse("vulcan"));
await page.waitForTimeout(2600);
await shot("04-warp");
await idle();
await page.waitForTimeout(900);
console.log("arrived:", await stats());
await shot("05-arrival");

console.log("beam down");
await page.evaluate(() => window.__snw.beamDown());
await page.waitForTimeout(1500);
await shot("06-transport");
await idle();
await page.waitForTimeout(700);
console.log("surface:", await stats());
await shot("07-surface");

await page.evaluate(() => window.__snw.input.down.add("w"));
await page.waitForTimeout(2600);
await page.evaluate(() => window.__snw.input.down.delete("w"));
await page.waitForTimeout(500);
const walked = await stats();
console.log("walked: ", walked);
await shot("08-walked");
if (walked.includes("near=-")) console.log("    ! nobody in range after walking forward");

await page.evaluate(() => window.__snw.hail(window.__snw.state.system.character));
await page.waitForTimeout(800);
const prompt = await page.$("#snw-root .comms-prompts button");
if (prompt) {
  await prompt.click();
  await page.waitForTimeout(15000);
}
await shot("09-comms");
for (const line of await page.$$eval("#snw-root .msg", (ns) => ns.map((n) => n.textContent))) {
  console.log("    »", line);
}

await page.evaluate(() => {
  window.__snw.closeChannel();
  window.__snw.beamUp();
});
await idle();
await page.waitForTimeout(700);
console.log("aboard: ", await stats());
await shot("10-aboard");

const tour = ALL
  ? await page.evaluate(() => window.__snw.state.visited && undefined) ||
    ["qonos", "bajor", "ferenginar", "risa", "andoria", "cardassia", "romulus", "trill", "talos", "ceti-alpha", "wolf359"]
  : ["qonos", "risa", "andoria", "wolf359"];
for (const key of tour) {
  await page.evaluate((k) => window.__snw.setCourse(k), key);
  await page.waitForTimeout(1200);
  await idle();
  await page.waitForTimeout(900);
  console.log("system: ", await stats());
  await shot(`11-${key}`);
}

console.log(`\nconsole errors: ${errors.length}`);
errors.slice(0, 10).forEach((e) => console.log("  !", e));

await browser.close();
server?.kill();
