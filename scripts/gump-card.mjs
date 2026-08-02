#!/usr/bin/env node
/**
 * gump-card — the world-card art for RUN, VIBEY, RUN.
 *
 * The house rule is that card art is a real capture from the running world,
 * never key art, so this drives the finale until the crowd has assembled
 * behind you, hides the HUD, and grabs the frame. It is the same picture the
 * player gets thirty seconds in.
 *
 * Usage: node scripts/gump-card.mjs [outPath] [chapter] [progress]
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const OUT = process.argv[2] ?? "src/assets/worlds/run-vibey-run.jpg";
const CHAPTER = Number(process.argv[3] ?? 5);
const UNTIL = Number(process.argv[4] ?? 0.3);
const PORT = Number(process.env.GUMP_PORT ?? 5187);
const BASE = `http://127.0.0.1:${PORT}`;

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
      env: { ...process.env, BROWSER: "none" },
    });
if (server && !(await up(BASE, 180000))) {
  console.error("dev server never came up");
  process.exit(1);
}

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));

await page.goto(`${BASE}/run?shot=1&chapter=${CHAPTER}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__gumpReady === true, { timeout: 40000 });
await page.evaluate(() => {
  window.__gump.timeScale = 7;
  window.__gump.debug.immortal = true;
});

// Steer gently rather than thrashing: a card wants a clean line down the road,
// not the frame where he is bouncing off a cactus.
const t0 = Date.now();
while (Date.now() - t0 < 180000) {
  await page.keyboard.press("Space");
  await page.waitForTimeout(600);
  const s = await page.evaluate(() => window.__gump.snapshot());
  if (s.hud.progress >= UNTIL || s.phase !== "playing") break;
}

// Hide every scrap of DOM. The card is the world, not the interface.
await page.addStyleTag({ content: "body > #root > div > *:not(canvas) { display: none !important; }" });
// Back to real time for the capture itself. At seven times speed the world
// steps five metres a frame and obstacles tunnel — the first attempt at this
// card came out with a sedan parked on the lens.
await page.evaluate(() => (window.__gump.timeScale = 1));
await page.waitForTimeout(1200);

/* Several candidates a second apart. Whether a given frame has a cactus
   filling it is not something a script can judge, so it takes six and a human
   picks. */
for (let i = 0; i < 6; i++) {
  const png = await page.screenshot();
  const b64 = png.toString("base64");
  const jpeg = await page.evaluate(async (d) => {
    const img = new Image();
    img.src = "data:image/png;base64," + d;
    await img.decode();
    const W = 960;
    const H = Math.round((img.height / img.width) * W);
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    c.getContext("2d").drawImage(img, 0, 0, W, H);
    return c.toDataURL("image/jpeg", 0.86);
  }, b64);
  const path = OUT.replace(/\.jpg$/, `-${i}.jpg`);
  writeFileSync(path, Buffer.from(jpeg.split(",")[1], "base64"));
  console.log(`wrote ${path}`);
  await page.waitForTimeout(1400);
}

await browser.close();
server?.kill();
