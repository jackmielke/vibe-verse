#!/usr/bin/env node
/**
 * rig-audit — which characters the pose system can actually pose.
 *
 *     node scripts/rig-audit.mjs [count]
 *
 * Dances and swimming are both SOLVED onto the rig rather than played back,
 * which works beautifully right up until a character's bones are named
 * something the binder does not recognise. Then the joints it missed keep
 * playing whatever clip is underneath while the rest of the body does the
 * solved pose — a swimmer pitched face-down with arms running a standing idle,
 * which reads as "the animation is glitchy" and is per-character, silent, and
 * invisible on whichever character you happen to be testing with.
 *
 * So: load each one and ask what bound.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const LIMIT = Number(process.argv[2] ?? 99);
const PORT = Number(process.env.CITY_PORT ?? 5188);
const BASE = `http://127.0.0.1:${PORT}`;

async function up(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch { /* not yet */ }
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
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 500, height: 500 } });
page.on("pageerror", (e) => console.log(`PAGEERROR ${e}`));

await page.goto(`${BASE}/city?fresh=1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 120000 });
await page.waitForTimeout(22000);
await page.waitForFunction(() => typeof window.__cityRig === "function", null, { timeout: 90000 });

// Only the ones with a model file. The code-built cast (Flux and friends)
// has no GLB to bind and is animated by its own solver, so it is not what this
// is auditing.
const names = await page.evaluate(async () => {
  const m = await import("/src/lib/characters.ts");
  return m.CHARACTERS.filter((c) => c.url).map((c) => c.id);
});
console.log(`· ${names.length} characters in the catalogue\n`);

const rows = [];
for (const name of names.slice(0, LIMIT)) {
  await page.evaluate((n) => window.__cityChar(n), name);
  // The model is fetched; poll until the binder has answered for THIS one.
  let rig = null;
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(500);
    rig = await page.evaluate(() => window.__cityRig());
    if (rig.bound > 0) break;
  }
  const arms = rig.armL[0] && rig.armR[0];
  const legs = rig.legL[0] && rig.legR[0];
  rows.push({ name, bound: rig.bound, hips: rig.hips, torso: rig.torso, head: rig.head, arms, legs });
  const bad = !arms || !legs || !rig.head;
  console.log(
    `${bad ? "!!" : "ok"}  ${name.padEnd(26)} bound ${String(rig.bound).padStart(2)}  ` +
      `hips ${rig.hips ? "y" : "-"} torso ${rig.torso ? "y" : "-"} head ${rig.head ? "y" : "-"} ` +
      `arms ${arms ? "y" : "-"} legs ${legs ? "y" : "-"}`,
  );
}

const broken = rows.filter((r) => !r.arms || !r.legs || !r.head);
console.log(`\n${broken.length} of ${rows.length} characters are missing a limb the pose system needs.`);

await browser.close();
server?.kill();
