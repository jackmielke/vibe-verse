#!/usr/bin/env node
/**
 * club-shot — photograph THE BASEMENT.
 *
 *   node scripts/club-shot.mjs
 *
 * A room is the kind of thing that is either believable or not, and no
 * assertion decides which. What this is really checking is the list of ways an
 * interior assembled from numbers goes wrong: a wall in the wrong place, a
 * crowd standing inside the DJ booth, beams pointing at the floor, a ceiling
 * you can see the sky through, a player who spawns outside their own room.
 *
 * Writes `.dance-shots/club-*.png` — the arrival, the floor from the door, the
 * DJ end, and an overhead with the roof still on (which is what tells you
 * whether the crowd is spread like people or stacked on a lattice).
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.SF_PORT ?? 5179);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(process.cwd(), ".dance-shots");
// Must track `CLUB_X/Y/Z` in City.tsx. An earlier version hardcoded y = 0.3
// here, so after the club moved underground every warp in this script put the
// player in the ocean directly above it and the harness reported an empty
// room that was in fact full.
const CLUB = { x: -420, y: -300, z: 420 };

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
if (server && !(await up(BASE, 120000))) {
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
    "--ignore-gpu-blocklist",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

console.log("· booting /city?spawn=club (software GL, this is slow)");
await page.goto(`${BASE}/city?fresh=1&spawn=club`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForSelector("canvas", { timeout: 180000 });
await page.waitForTimeout(34000);
await page.waitForFunction(() => typeof window.__cityWarp === "function", null, { timeout: 60000 });

mkdirSync(OUT_DIR, { recursive: true });

// Did ?spawn=club actually land inside the room?
const where = await page.evaluate(() => window.__cityDebug?.player?.() ?? null);
console.log("· spawned at:", JSON.stringify(where));

await page.evaluate(() => window.__cityCam(5, 0.18, 0));
await page.waitForTimeout(5000);
await page.screenshot({ path: resolve(OUT_DIR, "club-0-arrival.png") });

// Onto the floor, looking at the DJ.
await page.evaluate(([x, y, z]) => window.__cityWarp(x, y + 0.3, z + 7), [CLUB.x, CLUB.y, CLUB.z]);
await page.waitForTimeout(3000);
await page.evaluate(() => window.__cityCam(5, 0.16, 0));
await page.waitForTimeout(5000);
await page.screenshot({ path: resolve(OUT_DIR, "club-1-floor.png") });

// Dance in it.
await page.keyboard.press("KeyT");
await page.waitForTimeout(9000);
await page.screenshot({ path: resolve(OUT_DIR, "club-2-dancing.png") });
const crowd = await page.evaluate(() => {
  const el = [...document.querySelectorAll("span")].find((s) => /dancing/.test(s.textContent ?? ""));
  return el?.textContent?.trim() ?? "(no crowd HUD)";
});
console.log(`· ${crowd}`);

/* Not an overhead — there is a ceiling, and a camera above it sees the top of
   a box. From the back of the room looking in answers the same question: is
   the crowd spread like people, or stacked on a lattice?

   z + 6, not z + 10. The exit pad sits at z + 10.6 with a 1.9m trigger, so an
   earlier version of this line parked the harness on the way out and the
   "back of the room" shot came back as an aerial photograph of the plaza. */
await page.evaluate(([x, y, z]) => window.__cityWarp(x, y + 0.3, z + 6), [CLUB.x, CLUB.y, CLUB.z]);
await page.waitForTimeout(2500);
await page.evaluate(() => window.__cityCam(5, 0.5, 0));
await page.waitForTimeout(5000);
await page.screenshot({ path: resolve(OUT_DIR, "club-3-room.png"), timeout: 120000 });

/* Both doors, explicitly. They are a teleport pair and the failure mode is not
   subtle: get it wrong and you either cannot leave or you bounce between two
   worlds several times a second.

   Stairs first, exit second, and with long waits. The doors share a 2.5s
   cooldown measured in *simulated* time, and the frame loop clamps dt — so on
   this container's one-frame-a-second software renderer that cooldown takes
   the better part of a minute of wall clock. Testing the exit first left the
   cooldown running and reported the stairs as broken when they were fine. */
await page.screenshot({ path: resolve(OUT_DIR, "club-4-room.png"), timeout: 120000 });

await page.evaluate(([x, y, z]) => window.__cityWarp(x, y + 0.3, z + 10.6), [CLUB.x, CLUB.y, CLUB.z]);
await page.waitForFunction(() => (window.__cityDebug?.player?.()[1] ?? -999) > -50, null, {
  timeout: 120000,
});
const after = await page.evaluate(() => window.__cityDebug?.player?.() ?? null);
console.log(
  after && after[1] > -50
    ? `· the exit works — back in the plaza at ${JSON.stringify(after)}`
    : `· FAIL: still in the club at ${JSON.stringify(after)}`,
);

/* Now back down — but only once the cooldown has actually expired. It is
   counted in simulated seconds and this renderer delivers about fifteen
   milliseconds of those per wall-clock second, so waiting a fixed minute is
   not waiting at all. */
await page.waitForFunction(() => (window.__cityDebug?.clubDoor?.().cool ?? 1) <= 0, null, {
  timeout: 300000,
});
await page.evaluate(() => window.__cityWarp(22.5, 0.3, 4));
await page.waitForFunction(() => (window.__cityDebug?.player?.()[1] ?? 0) < -50, null, {
  timeout: 120000,
}).catch(() => {});
const back = await page.evaluate(() => window.__cityDebug?.player?.() ?? null);
console.log("· door probe:", JSON.stringify(await page.evaluate(() => window.__cityDebug?.clubDoor?.() ?? null)));
console.log(
  back && back[1] < -50
    ? `· the stairs work — down in the club at ${JSON.stringify(back)}`
    : `· FAIL: the stairs did not take — ${JSON.stringify(back)}`,
);

console.log(`wrote ${OUT_DIR}/club-*.png`);
await browser.close();
if (server) server.kill();
