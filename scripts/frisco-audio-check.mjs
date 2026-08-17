#!/usr/bin/env node
/**
 * frisco-audio-check — prove the audio context is borrowed and given back.
 *
 *   node scripts/frisco-audio-check.mjs
 *
 * The unit tests in `src/test/friscoAudio.test.ts` check this against a fake
 * context, which catches the shape of the calls and nothing about whether a
 * real browser agrees. This drives the real thing in Chromium and answers the
 * three questions a fake cannot:
 *
 *   - Does an AudioContext exist before the user has touched anything?
 *     (It must not. Browsers refuse to start one, and a suspended context is
 *     silence that looks like working code.)
 *   - Does the graph grow while you play?
 *     (It must not. One-shots that are never stopped are a leak that presents
 *     as the audio going crunchy and then cutting out.)
 *   - Is it CLOSED when you leave the world?
 *     (It must be. Chrome caps live contexts per page, so a leak here means the
 *     *next* world the visitor opens is silent, with no error anywhere.)
 *
 * The last one is why this navigates by clicking a link rather than by loading
 * a URL: a full page load resets the counters and proves nothing at all. That
 * is the mistake this script was written to stop repeating.
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const PORT = Number(process.env.FRISCO_PORT ?? 8080);
const BASE = `http://127.0.0.1:${PORT}`;
const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: [
    "--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader",
    "--no-sandbox","--disable-dev-shm-usage",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("net::")) console.log("CONSOLE", m.text().slice(0,200));
});
// Count every AudioContext the page ever constructs, and every close.
await page.addInitScript(() => {
  const Real = window.AudioContext;
  window.__ac = { made: 0, closed: 0, live: [] };
  window.AudioContext = class extends Real {
    constructor(...a) {
      super(...a);
      window.__ac.made++;
      window.__ac.live.push(this);
    }
    close() {
      window.__ac.closed++;
      return super.close();
    }
  };
});
await page.goto(`${BASE}/frisco`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof window.__frisco?.player === "function", null, { timeout: 180000 });
await page.waitForTimeout(6000);
const pre = await page.evaluate(() => window.__ac);
check("nothing before a gesture", pre.made === 0, `made ${pre.made}`);

await page.keyboard.press("KeyW");
await page.waitForTimeout(2500);
const post = await page.evaluate(() => ({
  made: window.__ac.made,
  closed: window.__ac.closed,
  states: window.__ac.live.map((c) => c.state),
  running: window.__frisco?.audioRunning?.(),
}));
check("one context after a gesture", post.made === 1, `made ${post.made}`);
check("and it is running", post.running === true && post.states[0] === "running", post.states.join(","));

// Drive it: fly, collect, and check nothing throws and the graph does not grow.
await page.evaluate(() => window.__frisco.setPose(0, 60, 0, 2.3, -0.1));
await page.waitForTimeout(1500);
await page.evaluate(() => window.__frisco.startCourse());
await page.waitForTimeout(2500);
const played = await page.evaluate(() => ({
  made: window.__ac.made, closed: window.__ac.closed,
}));
check("no extra contexts while playing", played.made === 1, `made ${played.made}`);

// Leave the world WITHOUT a page load — a client-side route change, which is
// the only way the counters survive to be read. A full reload resets them and
// proves nothing.
await page.evaluate(() => {
  const a = [...document.querySelectorAll("a")].find((x) => x.getAttribute("href") === "/worlds");
  a?.click();
});
await page.waitForTimeout(3000);
const left = await page.evaluate(() => ({
  made: window.__ac.made, closed: window.__ac.closed,
  states: window.__ac.live.map((c) => c.state),
}));
check("closed on leaving the world", left.closed === 1 && left.states[0] === "closed",
  `closed ${left.closed}, state ${left.states.join(",")}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
