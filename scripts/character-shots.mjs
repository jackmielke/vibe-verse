#!/usr/bin/env node
/**
 * character-shots — photograph every shop character as the game builds it.
 *
 *   node scripts/character-shots.mjs            # everything on the shelf
 *   node scripts/character-shots.mjs space-rex  # just one
 *
 * Writes transparent PNGs to `src/assets/characters/<id>.png`, which is what
 * the arcade card and the shop grid draw. Re-run it after touching
 * `PILOT_DESIGNS` — the portraits are the only place a design change is
 * invisible until somebody looks, because everything else about a character
 * is computed at runtime and these are not.
 *
 * It drives the real dev server rather than rendering headless, so the module
 * it photographs is the same one the game imports. Same reasoning as
 * `route-shot.mjs`, one level down.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(process.cwd(), "src/assets/characters");

/** The shelf, read from the shop table so this cannot drift from what is sold. */
async function shelfIds() {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(resolve(process.cwd(), "src/lib/characterShop.ts"), "utf8"),
  );
  const ids = [...src.matchAll(/^\s*id:\s*"([\w-]+)",/gm)].map((m) => m[1]);
  if (!ids.length) throw new Error("no ids found in src/lib/characterShop.ts");
  return ids;
}

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

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const ids = only.length ? only : await shelfIds();

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
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

// Any route will do — all this needs is a document the dev server has
// transformed, so a bare dynamic import of a .ts path resolves.
await page.goto(`${BASE}/build`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.evaluate(async () => {
  await import("/src/dev/characterShot.ts");
});

mkdirSync(OUT_DIR, { recursive: true });

for (const id of ids) {
  const url = await page.evaluate((designId) => window.__shootCharacter(designId), id);
  const b64 = url.split(",")[1];
  if (!b64 || b64.length < 2000) {
    console.error(`  ${id}: render came back empty — skipped`);
    continue;
  }
  const buf = Buffer.from(b64, "base64");
  const file = resolve(OUT_DIR, `${id}.png`);
  writeFileSync(file, buf);
  console.log(`wrote ${file} (${Math.round(buf.length / 1024)} kB)`);
}

await browser.close();
if (server) server.kill();
