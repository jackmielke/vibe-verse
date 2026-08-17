#!/usr/bin/env node
/**
 * frisco-challenges — fly every course and the grand tour, and say whether
 * they can actually be finished.
 *
 *   node scripts/frisco-challenges.mjs
 *
 * This exists because of a failure that is invisible in every other way. The
 * Hill Climb had three of its ten rings placed inside Nob Hill apartment
 * blocks: you could see them through the wall, the collision pushed you out
 * every time you got close, and the course simply never advanced past ring
 * four. It looks completely fine from the air, it looks completely fine in a
 * screenshot, and nothing about the geometry is wrong — the ring is where the
 * maths said to put it. The only way to find it is to fly the thing.
 *
 * So: teleport ring to ring, and check the course reports itself finished.
 * Then hold a pose over each of the twelve landmarks in turn and check the
 * tour closes out.
 *
 * It waits on *state* rather than on a timer, and that matters more than it
 * sounds. On the software renderer this runs under, the world manages one or
 * two frames a second, so "wait 800 ms and move on" is sometimes zero frames —
 * and the result is a harness that reports eleven landmarks on one run and six
 * on the next, which reads as a flaky world rather than a flaky test.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const OUT = process.env.FRISCO_OUT ?? "/tmp/frisco-challenges";
mkdirSync(OUT, { recursive: true });
const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--disable-dev-shm-usage"],
});
let failures = 0;
const page = await browser.newPage({ viewport: { width: 1000, height: 620 } });
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0,250)));
const PORT = Number(process.env.FRISCO_PORT ?? 8080);
await page.goto(`http://127.0.0.1:${PORT}/frisco`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof window.__frisco?.startCourse === "function", null, { timeout: 180000 });
await page.waitForTimeout(7000);
await page.evaluate(() => localStorage.removeItem("frisco.logbook"));

for (const key of ["market", "waterfront", "hills"]) {
  await page.evaluate((k) => window.__frisco.startCourse(k), key);
  await page.waitForTimeout(400);
  // Fly the whole thing by teleporting ring to ring.
  let steps = 0;
  let ok = false;
  for (let i = 0; i < 40; i++) {
    const st = await page.evaluate(() => {
      const w = window.__frisco;
      const r = w.nextRing();
      if (r) w.setPose(r.x, r.y, r.z, 2.4, -0.05);
      return w.playState();
    });
    if (i === 1) writeFileSync(`${OUT}/${key}.png`, await page.screenshot());
    if (st.running === null) { ok = true; steps = i; break; }
    await page.waitForTimeout(650);
  }
  const st = await page.evaluate(() => window.__frisco.playState());
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${key.padEnd(11)} ${ok ? `finished in ${steps} rings` : `STALLED at ring ${st.ring + 1}/${st.totalRings}`}`,
  );
}

// The grand tour: touch every landmark.
await page.evaluate(() => window.__frisco.startCourse("tour"));
const marks = await page.evaluate(() => window.__frisco.landmarks());
for (const m of marks) {
  // Hold the pose until the tour actually registers it. At one frame a second
  // on a software renderer, "wait 800 ms" is sometimes zero frames, and the
  // result is a flaky harness reporting a flaky world.
  const before = (await page.evaluate(() => window.__frisco.playState())).touched;
  for (let i = 0; i < 14; i++) {
    await page.evaluate(([x, y, z]) => window.__frisco.setPose(x, y, z, 2.4, -0.2),
      [m.x, m.ground + m.height + 25, m.z]);
    await page.waitForTimeout(320);
    const now = await page.evaluate(() => window.__frisco.playState());
    if (now.touched > before || now.running === null) break;
  }
}
const fin = await page.evaluate(() => window.__frisco.playState());
if (fin.running === null && fin.best.tour !== undefined) {
  console.log(`ok   tour        finished, best ${fin.best.tour.toFixed(1)}s`);
} else {
  const missed = marks.map((m) => m.key).filter((k) => !fin.touchedKeys.includes(k));
  failures++;
  console.log(`FAIL tour        stalled at ${fin.touched}/${marks.length}, missed: ${missed.join(",")}`);
}
await browser.close();
process.exit(failures === 0 ? 0 : 1);
