#!/usr/bin/env node
/**
 * dance-shots — photograph every dance, on both kinds of rig.
 *
 *   node scripts/dance-shots.mjs                       # all dances, two characters
 *   node scripts/dance-shots.mjs floss robot           # just these
 *   node scripts/dance-shots.mjs --char=Wizard         # a specific character
 *
 * Writes one PNG strip per dance to `.dance-shots/` (git-ignored). A dance is
 * the one change that passes typecheck, build and smoke while the character
 * on screen folds its arms through its own ribcage — so this exists to be
 * looked at before pushing, and nothing else in the repo does that job.
 *
 * Drives the real dev server for the same reason `character-shots.mjs` does:
 * the module it photographs is the one the game imports.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.SF_PORT ?? 5179);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(process.cwd(), ".dance-shots");

const args = process.argv.slice(2);
const charArgs = args.filter((a) => a.startsWith("--char=")).map((a) => a.slice(7));
const only = args.filter((a) => !a.startsWith("-"));
// One of each family by default: a Quaternius skeleton through the bind-pose
// conjugation, and a code-built pilot writing its joints direct.
const chars = charArgs.length ? charArgs : ["BlueSoldier_Male", "flux"];

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
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
page.on("console", (m) => {
  if (m.type() === "warning" || m.type() === "error") console.log("  console:", m.text());
});

await page.goto(`${BASE}/build`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.evaluate(async () => {
  await import("/src/dev/danceShot.ts");
});

const ids = only.length
  ? only
  : await page.evaluate(async () => {
      const m = await import("/src/components/city/dances.ts");
      return m.DANCES.map((d) => d.id);
    });

mkdirSync(OUT_DIR, { recursive: true });

for (const char of chars) {
  for (const id of ids) {
    const url = await page.evaluate(
      ([danceId, character]) => window.__shootDance(danceId, { character, frames: 9, beats: 2 }),
      [id, char],
    );
    const b64 = url.split(",")[1];
    if (!b64 || b64.length < 2000) {
      console.error(`  ${char}/${id}: render came back empty — skipped`);
      continue;
    }
    const file = resolve(OUT_DIR, `${char}-${id}.png`);
    writeFileSync(file, Buffer.from(b64, "base64"));
    console.log(`wrote ${file}`);
  }
}

await browser.close();
if (server) server.kill();
