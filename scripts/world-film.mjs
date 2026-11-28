#!/usr/bin/env node
/**
 * world-film — film a few seconds of a world being played, as a small MP4 loop
 * for its card.
 *
 *   node scripts/world-film.mjs city              # one world, by plan key
 *   node scripts/world-film.mjs city kart hoops   # several
 *   node scripts/world-film.mjs --all             # every plan in film/plans.mjs
 *   node scripts/world-film.mjs city --keep       # also keep the JPEG frames
 *   node scripts/world-film.mjs city --big --keep --out /tmp/x   # 960 px frames for card art
 *
 * The older `route-gif.mjs` records in real time, so on this container's
 * software renderer a heavy world gets two frames a second and the recording
 * is rejected. This one stops the world's clock instead (`film/clock.js`):
 * `performance.now`, `Date.now` and `requestAnimationFrame` all wait for us,
 * and each frame is rendered, grabbed off the canvas and only then is time
 * moved on by exactly 1/FPS. A frame can take four seconds to draw and the
 * film is still smooth. It also means a world does not have to play itself:
 * each plan holds keys and drags the mouse like a player would.
 *
 * Output goes to `src/assets/worlds/<key>.mp4` (H.264, no audio, faststart),
 * which `src/worlds/motion.ts` picks up. A contact sheet of the clip goes next
 * to the frames in the scratch dir so a broken take is obvious without
 * opening a video player.
 *
 * Exit code 2 means a take came out too still (fewer than MIN_DISTINCT
 * different frames) or black, and nothing was written for it.
 */
import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { PLANS, DEFAULTS } from "./film/plans.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const keys = args.filter((a, i) => !a.startsWith("--") && !["--out", "--seconds"].includes(args[i - 1]));
const KEEP = args.includes("--keep");
const ALL = args.includes("--all");
const OUTDIR = (() => {
  const i = args.indexOf("--out");
  return i >= 0 ? resolve(args[i + 1]) : resolve("src/assets/worlds");
})();

const list = ALL ? Object.keys(PLANS) : keys;
if (!list.length) {
  console.error("usage: node scripts/world-film.mjs <plan key> [...] | --all");
  console.error("plans: " + Object.keys(PLANS).join(", "));
  process.exit(1);
}
for (const k of list) {
  if (!PLANS[k]) {
    console.error(`no plan called ${k} in scripts/film/plans.mjs`);
    process.exit(1);
  }
}

const PORT = Number(process.env.SF_PORT ?? 5177);
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

const server = (await up(BASE, 1500))
  ? null
  : spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, BROWSER: "none" },
      // Its own process group, so killing it takes vite down too and not just
      // npx: an orphaned vite holds stdout open and the run never "ends".
      detached: true,
    });
if (server && !(await up(BASE, 120000))) {
  console.error("dev server never came up");
  process.exit(1);
}

const exe = "/opt/pw-browsers/chromium";
const browser = await chromium.launch({
  ...(existsSync(exe) && statSync(exe).isFile() ? { executablePath: exe } : {}),
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const clockSrc = readFileSync(join(here, "film/clock.js"), "utf8");

const results = [];

async function film(key) {
  const plan = { ...DEFAULTS, ...PLANS[key] };
  // `--seconds 1.5` for a quick probe take.
  const si = args.indexOf("--seconds");
  if (si >= 0) plan.seconds = Number(args[si + 1]);
  // `--big` films at 960x540 for picking card art from the kept frames
  // (use with --keep and --out so the card clip is not replaced).
  if (args.includes("--big") && !plan.crop) Object.assign(plan, { viewport: [960, 540], width: 960, outWidth: 960 });
  const scratch = join(tmpdir(), `world-film-${key}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });

  const ctx = await browser.newContext({
    viewport: { width: plan.viewport[0], height: plan.viewport[1] },
    deviceScaleFactor: 1,
  });
  await ctx.addInitScript(clockSrc);
  if (plan.storage) {
    await ctx.addInitScript((s) => {
      for (const [k, v] of Object.entries(s)) {
        try {
          localStorage.setItem(k, v);
        } catch {
          /* private mode */
        }
      }
    }, plan.storage);
  }
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`  [${key}] PAGEERROR: ${e.message}`));

  const url = BASE + plan.route;
  console.log(`\n=== ${key}: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(plan.warmup);
  const center = { x: plan.viewport[0] / 2, y: plan.viewport[1] / 2 };
  const tools = makeTools(page, center);
  if (plan.setup) await plan.setup(tools);

  const n = await page.evaluate(() => window.__film.canvasCount());
  if (!n) {
    console.error(`  no canvas on ${plan.route}, nothing to film`);
    await ctx.close();
    return { key, status: "no-canvas" };
  }

  await page.evaluate(() => window.__film.freeze());
  const dt = 1 / plan.fps;
  // Settle on the frozen clock: lets easing and cameras land before the take.
  for (let i = 0; i < plan.preroll; i++) {
    if (plan.input) await plan.input(tools, i - plan.preroll);
    await page.evaluate(([d, s]) => window.__film.step(d, 0, 0.9, s), [dt, plan.sub]);
  }

  const total = Math.round(plan.seconds * plan.fps);
  const hashes = new Set();
  let dark = 0;
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    if (plan.input) await plan.input(tools, i);
    const shot = await page.evaluate(
      ([d, w, s]) => window.__film.step(d, w, 0.9, s),
      [dt, plan.width, plan.sub],
    );
    const buf = Buffer.from(shot.url.split(",")[1], "base64");
    hashes.add(createHash("md5").update(buf).digest("hex"));
    if (buf.length < 4000) dark++;
    writeFileSync(join(scratch, `f${String(i).padStart(4, "0")}.jpg`), buf);
    if (i % 10 === 0) {
      const per = ((Date.now() - t0) / (i + 1) / 1000).toFixed(1);
      process.stdout.write(`\r  frame ${i + 1}/${total} (${per}s each)   `);
    }
  }
  process.stdout.write("\n");
  await ctx.close();

  const minDistinct = Math.round(total * 0.5);
  if (hashes.size < minDistinct || dark > total * 0.5) {
    console.error(`  too still or dark: ${hashes.size}/${total} distinct, ${dark} near-empty. Not written.`);
    return { key, status: "still", distinct: hashes.size, total };
  }

  mkdirSync(OUTDIR, { recursive: true });
  const out = join(OUTDIR, `${plan.out ?? key}.mp4`);
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y", "-loglevel", "error",
      "-framerate", String(plan.fps),
      "-i", join(scratch, "f%04d.jpg"),
      // `crop` (w:h:x:y in grabbed pixels) zooms in on a small board that sits
      // in the middle of a wide screen; `outWidth` is the delivered size.
      "-vf", `${plan.crop ? `crop=${plan.crop},` : ""}scale=${plan.outWidth ?? plan.width}:-2:flags=lanczos,format=yuv420p`,
      "-c:v", "libx264", "-preset", "slow", "-crf", String(plan.crf),
      "-profile:v", "high", "-movflags", "+faststart", "-an",
      out,
    ],
    { stdio: "inherit" },
  );
  if (ff.status !== 0) return { key, status: "ffmpeg-failed" };
  // Contact sheet: 8 frames spread across the take.
  spawnSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", out,
    "-vf", `select='not(mod(n\\,${Math.max(1, Math.floor(total / 8))}))',scale=320:-2,tile=4x2`,
    "-frames:v", "1", join(scratch, "sheet.jpg"),
  ]);
  if (!KEEP) {
    for (let i = 0; i < total; i++) rmSync(join(scratch, `f${String(i).padStart(4, "0")}.jpg`), { force: true });
  }
  const kb = Math.round(statSync(out).size / 1024);
  console.log(`  wrote ${out} (${kb} KB, ${hashes.size}/${total} distinct). Sheet: ${join(scratch, "sheet.jpg")}`);
  return { key, status: "ok", kb, out, sheet: join(scratch, "sheet.jpg") };
}

/** What a plan gets to drive the page with. */
function makeTools(page, center) {
  const held = new Set();
  let mouse = { ...center };
  let dragging = false;
  return {
    page,
    center,
    wait: (ms) => page.waitForTimeout(ms),
    eval: (fn, arg) => page.evaluate(fn, arg),
    click: async (x = center.x, y = center.y) => {
      await page.mouse.click(x, y);
    },
    clickText: async (text, opts = {}) => {
      const loc = page.getByText(text, { exact: false }).first();
      try {
        await loc.click({ timeout: opts.timeout ?? 5000, force: true });
        return true;
      } catch {
        return false;
      }
    },
    press: (k) => page.keyboard.press(k),
    /** Hold exactly this set of keys from now on. */
    hold: async (...ks) => {
      const want = new Set(ks);
      for (const k of held) if (!want.has(k)) { await page.keyboard.up(k); held.delete(k); }
      for (const k of want) if (!held.has(k)) { await page.keyboard.down(k); held.add(k); }
    },
    /** Move the mouse by (dx, dy), with the left button down when `drag`. */
    look: async (dx, dy = 0, drag = false) => {
      if (drag && !dragging) { await page.mouse.move(mouse.x, mouse.y); await page.mouse.down(); dragging = true; }
      if (!drag && dragging) { await page.mouse.up(); dragging = false; }
      mouse = { x: mouse.x + dx, y: mouse.y + dy };
      await page.mouse.move(mouse.x, mouse.y, { steps: 1 });
    },
    resetMouse: async () => {
      if (dragging) { await page.mouse.up(); dragging = false; }
      mouse = { ...center };
      await page.mouse.move(mouse.x, mouse.y);
    },
  };
}

for (const k of list) {
  try {
    results.push(await film(k));
  } catch (e) {
    console.error(`  ${k} failed: ${e.message}`);
    results.push({ key: k, status: "error" });
  }
}
await browser.close();
if (server) {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill();
  }
}

console.log("\n────────── result ──────────");
for (const r of results) console.log(`${r.key.padEnd(16)} ${r.status}${r.kb ? ` ${r.kb} KB` : ""}`);
const bad = results.some((r) => r.status !== "ok");
process.exit(bad ? 2 : 0);
