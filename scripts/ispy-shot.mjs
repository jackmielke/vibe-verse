#!/usr/bin/env node
/**
 * ispy-shot — real frames out of I Spy.
 *
 * `route-shot.mjs` can only photograph the spawn point, and the spawn point of
 * this level is eleven seconds of empty floor. This one boots the route with
 * `?shot`, teleports the attract bot into each of the six movements, and
 * photographs it playing.
 *
 * Usage:
 *   node scripts/ispy-shot.mjs                     # contact sheet to /tmp
 *   node scripts/ispy-shot.mjs 340 out.jpg         # one frame at block 340
   node scripts/ispy-shot.mjs --run               # …and play it through
   node scripts/ispy-shot.mjs --spire             # …and climb the other realm
   node scripts/ispy-shot.mjs --phone             # …and shoot it on a phone
 */
import { chromium, devices } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const PORT = Number(process.env.ISPY_PORT ?? 5178);
const BASE = `http://127.0.0.1:${PORT}`;
const OUTDIR = process.env.ISPY_OUT ?? "/tmp/ispy";

/**
 * [block, label] — one per movement, plus the title screen.
 *
 * Every block here is a spot with clear ground: a seek drops the player where
 * you ask, and asking for a block with a spike on it photographs a death and
 * an attract-mode restart rather than the section you wanted.
 */
const SHOTS = [
  [null, "00-title"],
  [26, "01-quiet"],
  [134, "02-ispy"],
  [244, "03-mirror"],
  [344, "04-strobe"],
  [438, "05-green"],
  [534, "06-everything"],
];

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
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") logs.push(`error: ${m.text()}`);
});

await page.goto(`${BASE}/i-spy?shot=1`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForFunction(() => !!window.__ispy, null, { timeout: 30000 });
// The global way-home chip is right in every world and wrong in a world card.
// Hide it for the shot rather than teaching a shared component about capture.
await page.addStyleTag({ content: '[class*="z-[45]"] { display: none !important; }' });
// Shoot at full lighting. Headless Chromium has no GPU, so the renderer's
// self-tuning budget would correctly strip the reflection and the bloom —
// and then the card art would be a picture of a slow machine rather than a
// picture of the game. The frame-rate probe below unpins it again.
await page.evaluate(() => window.__ispy.debugQuality(1));
await page.waitForTimeout(1200);

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const single = args[0] ? Number(args[0]) : null;
const shots = single === null ? SHOTS : [[single, "single"]];
const out = args[1];
mkdirSync(OUTDIR, { recursive: true });

for (const [block, label] of shots) {
  if (block !== null) {
    await page.evaluate((x) => window.__ispy.debugSeek(x), block);
    // Let the bot fly a moment so the frame has motion in it.
    await page.waitForTimeout(700);
    // …but not so long that a death restarted the attract loop back at the
    // start, which would silently photograph the wrong section.
    const at = await page.evaluate(
      () => (window.__ispy.status().percent / 100) * window.__ispy.level.length,
    );
    if (Math.abs(at - block) > 20) {
      console.warn(`  ! seek to ${block} landed at ${at.toFixed(0)} — retrying`);
      await page.evaluate((x) => window.__ispy.debugSeek(x), block);
      await page.waitForTimeout(250);
    }
    // Hold the frame. Encoding takes seconds; the level would run on without it.
    await page.evaluate(() => window.__ispy.debugPause(true));
  }
  const png = await page.screenshot();
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
    return c.toDataURL("image/jpeg", 0.88);
  }, png.toString("base64"));
  const where = await page.evaluate(() => {
    const at = (window.__ispy.status().percent / 100) * window.__ispy.level.length;
    window.__ispy.debugPause(false);
    return at;
  });
  const path = out && single !== null ? out : `${OUTDIR}/${label}.jpg`;
  console.log(`  block ${where.toFixed(0)} →`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(jpeg.split(",")[1], "base64"));
  console.log(`wrote ${path}`);
}

// Frame rate under the attract bot, which is the most expensive thing the
// page ever does: it searches 1.3 seconds of futures twenty times a second.
const survived = await page.evaluate(async () => {
  const measure = (ms) =>
    new Promise((resolve) => {
      const t0 = performance.now();
      let frames = 0;
      const tick = () => {
        frames++;
        const dt = performance.now() - t0;
        if (dt > ms) resolve(Math.round((frames / dt) * 1000));
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

  window.__ispy.debugSeek(0);
  window.__ispy.debugQuality(1);
  await measure(800);
  const full = await measure(3000);
  window.__ispy.debugQuality(0);
  await measure(500);
  const bare = await measure(3000);
  // …and then let the budget find its own level, which is what a player gets.
  window.__ispy.debugQuality(null);
  await measure(2500);
  const auto = await measure(3000);
  return { full, bare, auto, q: window.__ispy.renderQuality, pct: window.__ispy.status().percent };
});
// Three numbers, because one would lie. `full` is every effect on, `bare` is
// the floor the budget can fall back to, and `auto` is what a player on this
// machine actually gets — a low lighting number with a good frame rate is the
// renderer correctly deciding this machine cannot afford the reflection,
// which is the entire reason the budget exists.
console.log(
  `attract mode: ${survived.auto} fps at lighting ${survived.q.toFixed(2)} ` +
    `(${survived.full} fps all-on, ${survived.bare} fps bare), ` +
    `reached ${survived.pct.toFixed(0)}%`,
);

// `--run` plays the level through for real. vitest proves the level is
// possible; this proves the *page* is — the playing phase, the finish screen,
// and the title button that gets you there.
if (process.argv.includes("--run")) {
  const chrome = await chromium.launch({
    ...(existsSync(exe) ? { executablePath: exe } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const p2 = await chrome.newPage({ viewport: { width: 1280, height: 720 } });
  await p2.goto(`${BASE}/i-spy`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await p2.getByRole("button", { name: /attempt/i }).click({ timeout: 30000 });
  await p2.waitForSelector("text=/attempt 1/i", { timeout: 15000 });
  console.log("title button starts a run: yes");
  await chrome.close();

  await page.evaluate(() => {
    window.__ispy.play();
    window.__ispy.debugAutopilot(true);
  });
  // Ten seconds in, with the score actually playing, grab a frame: the
  // background of this level is its own spectrum and a silent screenshot
  // cannot show whether that works.
  await page.waitForTimeout(10000);
  await page.evaluate(() => window.__ispy.debugPause(true));
  writeFileSync(`${OUTDIR}/live-audio.png`, await page.screenshot());
  await page.evaluate(() => window.__ispy.debugPause(false));
  console.log(`wrote ${OUTDIR}/live-audio.png (spectrum, with the score running)`);

  const won = await page
    .waitForFunction(() => window.__ispy.status().phase === "won", null, {
      timeout: 120000,
      polling: 500,
    })
    .then(() => true)
    .catch(() => false);
  const st = await page.evaluate(() => window.__ispy.status());
  console.log(
    `full autopilot run: ${won ? "finished" : "FAILED"} at ${st.percent.toFixed(0)}% ` +
      `after ${st.attempts} attempt(s)`,
  );
  await page.evaluate(() => window.__ispy.debugAutopilot(false));
}

// `--checkpoints` proves the thing you cannot see in a screenshot: that dying
// after a checkpoint in *practice* puts you back at it, and that a normal
// attempt gets no such thing.
if (process.argv.includes("--checkpoints")) {
  const r = await page.evaluate(async () => {
    const e = window.__ispy;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const pctToBlocks = (p) => (p / 100) * e.level.length;

    e.setPractice(true);
    e.play();
    e.debugAutopilot(true);
    for (let i = 0; i < 200 && e.status().banked < 3; i++) await wait(100);
    const banked = e.status().banked;
    const atDeath = pctToBlocks(e.status().percent);
    const marks = e.checkpointPercents.map((p) => (p / 100) * e.level.length);
    const lastPassed = marks.filter((x) => x <= atDeath).pop() ?? 0;
    e.debugKill();
    await wait(1400);
    const resumed = pctToBlocks(e.status().percent);
    const resumedPhase = e.status().phase;

    // …and that a normal attempt does the opposite: it stays dead where it
    // died, and the restart it eventually gets is from the very start.
    e.setPractice(false);
    e.play();
    for (let i = 0; i < 120 && e.status().banked < 2; i++) await wait(100);
    e.debugKill();
    await wait(1400);
    const normalPhase = e.status().phase;
    const normalHeld = pctToBlocks(e.status().percent);
    e.play();
    await wait(120);
    const normalRestart = pctToBlocks(e.status().percent);
    e.debugAutopilot(false);
    return {
      banked, atDeath, resumed, resumedPhase, lastPassed,
      normalPhase, normalHeld, normalRestart,
    };
  });
  // Resuming puts you back at the last checkpoint you passed, and then the
  // autopilot runs on for the second and a half we waited — which can carry
  // it past the spot it died at, if it died just after a checkpoint. So the
  // bar is: alive again, at or past that checkpoint, and not back at zero.
  const ok = r.resumedPhase === "playing" && r.resumed >= r.lastPassed - 1 && r.lastPassed > 0;
  console.log(
    `checkpoints: banked ${r.banked}, died at block ${r.atDeath.toFixed(0)}, ` +
      `resumed ${r.resumedPhase} at ${r.resumed.toFixed(0)} ` +
      `(last checkpoint ${r.lastPassed.toFixed(0)}) — ` +
      `${ok ? "OK" : "FAILED"}`,
  );
  console.log(
    `normal mode: still "${r.normalPhase}" at block ${r.normalHeld.toFixed(0)} with no ` +
      `auto-resume, and a restart goes to ${r.normalRestart.toFixed(0)} — ` +
      `${r.normalPhase === "dead" && r.normalRestart < 5 ? "OK" : "FAILED"}`,
  );
}

// `--audio` walks the score through all six movements. A synthesised track is
// a lot of scheduling code that a screenshot cannot see, and a thrown
// exception inside the scheduler is silent — the music simply stops.
if (process.argv.includes("--audio")) {
  const r = await page.evaluate(async () => {
    const e = window.__ispy;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const errors = [];
    window.addEventListener("error", (ev) => errors.push(String(ev.message)));
    await e.audio.start();
    e.audio.restart();
    const phases = [];
    for (let m = 0; m < 6; m++) {
      e.audio.setMovement(m);
      await wait(600);
      phases.push(e.audio.beatPhase());
    }
    // A checkpoint resume should move the score, not restart it.
    e.audio.seekToMovement(5);
    await wait(300);
    const afterSeek = e.audio.beatPhase();
    const moving = new Set(phases.map((p) => p.toFixed(3))).size > 1;
    return { moving, afterSeek, errors };
  });
  console.log(
    `score: six movements played, clock ${r.moving ? "advancing" : "STUCK"}, ` +
      `${r.errors.length} scheduler error(s)`,
  );
}

// `--modes` walks the difficulties in the real engine. The unit tests prove
// the physics of chill; this proves the wiring — that picking a mode reaches
// the player, the clock and the tempo.
if (process.argv.includes("--modes")) {
  const r = await page.evaluate(async () => {
    const e = window.__ispy;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const out = [];
    for (const d of ["chill", "easy", "normal"]) {
      e.setDifficulty(d);
      e.play();
      // No input at all. On chill that has to be survivable.
      await wait(4000);
      const s = e.status();
      out.push({
        d,
        phase: s.phase,
        pct: s.percent,
        pings: Number.isFinite(s.pings) ? s.pings : "inf",
      });
    }
    e.setDifficulty("normal");
    return out;
  });
  for (const m of r) {
    const expected = m.d === "chill" ? "playing" : "any";
    const ok = m.d !== "chill" || m.phase === "playing";
    console.log(
      `${m.d}: after 4s of no input — ${m.phase} at ${m.pct.toFixed(0)}%, ` +
        `${m.pings} pings — ${ok ? "OK" : `FAILED (wanted ${expected})`}`,
    );
  }
  // Does the clock actually scale? Comparing chill's progress against
  // normal's is meaningless — normal dies at 3% and its percentage freezes
  // there — so compare chill against the distance its own rate predicts:
  // four seconds at 0.8 x 10 blocks/second is 32 blocks of a 600-block level.
  const chill = r.find((m) => m.d === "chill");
  const predicted = ((4 * 0.8 * 10) / 600) * 100;
  const drift = Math.abs(chill.pct - predicted);
  console.log(
    `clock: chill covered ${chill.pct.toFixed(1)}% in 4s, 0.8x predicts ` +
      `${predicted.toFixed(1)}% — ${drift < 1.2 ? "OK" : `FAILED (off by ${drift.toFixed(1)})`}`,
  );
}

// `--spire` walks the other realm. The climb is eleven engines in a row with
// three lives shared between them, which is exactly the kind of thing that
// works in the head and not in the browser: a life that does not decrement, a
// floor that boots and never plays, a record banked from the wrong run.
if (process.argv.includes("--spire")) {
  const chrome = await chromium.launch({
    ...(existsSync(exe) ? { executablePath: exe } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const p2 = await chrome.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  p2.on("pageerror", (e) => errs.push(e.message));
  await p2.goto(`${BASE}/i-spy/spire?debug=1`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await p2.waitForFunction(() => !!window.__ispy, null, { timeout: 30000 });
  const titled = await p2.getByRole("heading", { name: "THE SPIRE" }).isVisible();
  await p2.getByRole("button", { name: /^climb$/i }).click({ timeout: 30000 });
  await p2.waitForSelector("text=/floor 1\\/11/i", { timeout: 20000 });
  // Every floor opens with its name on screen for a beat and a half. Killing
  // during that is killing nobody — wait for the floor to actually be playing.
  const playing = () =>
    p2.waitForFunction(() => window.__ispy.status().phase === "playing", null, {
      timeout: 20000,
      polling: 100,
    });
  await playing();
  console.log(`spire: /i-spy/spire titles itself and starts — ${titled ? "OK" : "FAILED"}`);

  // A death costs a life off the whole climb and puts you back on the same
  // floor, not on the street.
  const hearts = async () =>
    (await p2.locator('[aria-label*="lives left"]').first().getAttribute("aria-label")) ?? "";
  const before = await hearts();
  await p2.evaluate(() => window.__ispy.debugKill());
  await p2.waitForTimeout(1800);
  const after = await hearts();
  const stillFloorOne = await p2.locator("text=/floor 1\\/11/i").isVisible();
  console.log(
    `spire: died — lives "${before}" → "${after}", still on floor 1: ${stillFloorOne} — ` +
      `${before.startsWith("3") && after.startsWith("2") && stillFloorOne ? "OK" : "FAILED"}`,
  );

  // Clearing a floor moves the building up one and swaps the world under you.
  await playing();
  await p2.evaluate(() => {
    const e = window.__ispy;
    e.debugSeek(e.level.length - 3);
  });
  await p2.waitForTimeout(4000);
  const onTwo = await p2.locator("text=/floor 2\\/11/i").isVisible();
  const swapped = await p2.evaluate(() => window.__ispy.status().levelId);
  console.log(
    `spire: cleared floor 1 → floor 2 showing: ${onTwo}, engine now "${swapped}" — ` +
      `${onTwo && swapped !== "i-spy" ? "OK" : "FAILED"}`,
  );

  // …and spending the last two lives ends the climb with the floors kept.
  for (let i = 0; i < 2; i++) {
    await playing().catch(() => {});
    await p2.evaluate(() => window.__ispy.debugKill());
    await p2.waitForTimeout(1800);
  }
  const over = await p2.locator("text=/the climb ends here/i").isVisible();
  const kept = await p2.evaluate(() => JSON.parse(localStorage.getItem("ispy:spire") ?? "null"));
  console.log(
    `spire: out of lives — end card: ${over}, banked ${JSON.stringify(kept)} — ` +
      `${over && kept?.cleared === 1 ? "OK" : "FAILED"}`,
  );
  if (errs.length) console.log(`spire page errors: ${errs.slice(0, 3).join(" | ")}`);
  await chrome.close();
}

// `--phone` is not decoration. A portrait viewport is where this game breaks:
// fifteen blocks of height on a 0.46-aspect screen leaves four blocks of
// warning, and only a real phone frame shows you that.
if (process.argv.includes("--phone")) {
  const chrome = await chromium.launch({
    ...(existsSync(exe) ? { executablePath: exe } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await chrome.newContext({ ...devices["iPhone 13"] });
  const p2 = await ctx.newPage();
  await p2.goto(`${BASE}/i-spy`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await p2.waitForTimeout(2500);
  await p2.screenshot({ path: `${OUTDIR}/phone-title.png` });
  await p2.getByRole("button", { name: /attempt/i }).click();
  await p2.waitForTimeout(1600);
  await p2.touchscreen.tap(200, 400);
  await p2.waitForTimeout(1200);
  await p2.screenshot({ path: `${OUTDIR}/phone-play.png` });
  console.log(`wrote ${OUTDIR}/phone-title.png and ${OUTDIR}/phone-play.png`);
  await chrome.close();
}

if (logs.length) console.log("page errors:\n" + logs.slice(-12).join("\n"));

await browser.close();
if (server) server.kill();
