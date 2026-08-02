#!/usr/bin/env node
/**
 * angels-desktop — proves the desktop controls do what the card says.
 *
 * The complaint that produced this file was "we're confused with how to
 * navigate once we're in the game on desktop", and the answer was two things:
 * a controls card that opens by itself, and the cursor becoming the stick.
 * Both are the sort of change that typechecks perfectly and does nothing, so:
 *
 *  1. pressing FLY puts the controls card up, once, and never again;
 *  2. dismissing it hands control back *without* snapping the stick to
 *     wherever the button you just clicked happened to be — neutral is
 *     re-anchored under the cursor, which is the whole point;
 *  3. moving the cursor right rolls the jet right;
 *  4. moving it up pitches the nose up;
 *  5. W and S move the throttle rather than the nose;
 *  6. H reopens the card and Escape closes it without also pausing;
 *  7. the keyboard scheme puts pitch back on W and S.
 *
 * Unlike the other harnesses this one starts on the *real* page, menus and
 * all, because what is being tested is the path from a DOM event through React
 * to the flight model. It takes the wheel once it is flying: SwiftShader draws
 * this world about three times a second, and a check that waits on wall-clock
 * for the jet to bank is a check that fails on the build machine and passes on
 * yours. Everything after the hand-back is driven by explicit `step()` calls.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = Number(process.env.SF_PORT ?? 5179);
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
    await new Promise((r) => setTimeout(r, 400));
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
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

// No `?shot=1`: this is the real page. `?q=low` only because SwiftShader draws
// the ultra city about once a minute and none of this is on the GPU.
//
// The `undefined` is not decoration — waitForFunction's second positional is
// the *argument* to the page function, so options passed there are silently
// ignored and you get the 30 s default instead of the timeout you asked for.
await page.goto(`${BASE}/blue-angels?q=low`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => window.__angelsReady === true, undefined, { timeout: 240000 });

const card = page.locator('[data-angels-hud="help"]');

/** Advance the engine by `n` fixed steps without drawing. */
const step = (n) =>
  page.evaluate((k) => {
    for (let i = 0; i < k; i++) window.__angels.step(1 / 120, false);
  }, n);

const state = () =>
  page.evaluate(() => {
    const s = window.__angels.ctx.services.fleet.player.state;
    const st = window.__angels.ctx.services.input.stick;
    const i = window.__angels.ctx.input;
    return {
      bank: (s.bank * 180) / Math.PI,
      attitude: (s.pitchAttitude * 180) / Math.PI,
      roll: i.roll,
      pitch: i.pitch,
      throttle: i.throttle,
      stick: { x: st.x, y: st.y, active: st.active, cx: st.cx, cy: st.cy },
    };
  });

const FLY = { name: "FLY", exact: true };

// ---- 1. FLY opens the card -------------------------------------------------
await page.evaluate(() => localStorage.removeItem("angels.helpSeen"));
await page.getByRole("button", FLY).click();
await card.waitFor({ state: "visible", timeout: 10000 });
check("pressing FLY opens the controls card", true);

const gotIt = page.getByRole("button", { name: "Got it" });
const btn = await gotIt.boundingBox();
const btnY = btn.y + btn.height / 2;
check("the Got it button sits well below centre", btnY > 380, `y=${Math.round(btnY)} of 720`);

// ---- 2. dismissing it hands control back, gently ---------------------------
await gotIt.click();
await card.waitFor({ state: "hidden", timeout: 10000 });
await page.evaluate(() => window.__angels.stop());
await step(4); // enough for the input system to see the menu close
const back = await state();
check("Got it dismisses the card", true);
check(
  "the mouse stick is live once the card is gone",
  back.stick.active,
  `stick ${back.stick.active ? "live" : "not live"}`,
);
check(
  "neutral is re-anchored under the cursor, not at the screen centre",
  Math.abs(back.stick.cy - btnY) < 40 && Math.abs(back.stick.cy - 360) > 100,
  `neutral y=${Math.round(back.stick.cy)}, button was at ${Math.round(btnY)}`,
);
check(
  "so the jet is not bunted the instant the card closes",
  Math.abs(back.stick.y) < 0.05 && Math.abs(back.pitch) < 0.02,
  `stick.y=${back.stick.y.toFixed(3)}, pitch cmd=${back.pitch.toFixed(3)}`,
);

const NEUTRAL = { x: back.stick.cx, y: back.stick.cy };

// ---- 3. cursor right rolls right -------------------------------------------
await page.mouse.move(NEUTRAL.x + 170, NEUTRAL.y);
// Three quarters of a second. Any longer and it has rolled past the vertical
// and the sign of `bank` stops meaning what the check thinks it means — the
// first version of this ran for five seconds, went round three times, and
// reported a *left* bank from a right command.
await step(90);
const rolled = await state();
check(
  "moving the cursor right rolls the jet right",
  rolled.roll > 0.3 && rolled.bank > 10 && rolled.bank < 170,
  `roll cmd ${rolled.roll.toFixed(2)}, bank ${rolled.bank.toFixed(1)}°`,
);

// ---- 4. cursor up pitches up ------------------------------------------------
await page.mouse.move(NEUTRAL.x, NEUTRAL.y);
await step(900); // wings back level
await page.mouse.move(NEUTRAL.x, NEUTRAL.y - 170);
await step(500);
const climbed = await state();
check(
  "moving the cursor up pitches the nose up",
  climbed.pitch > 0.3 && climbed.attitude > 5,
  `pitch cmd ${climbed.pitch.toFixed(2)}, attitude ${climbed.attitude.toFixed(1)}°`,
);

// ---- 5. W and S are the throttle in the mouse scheme ------------------------
await page.mouse.move(NEUTRAL.x, NEUTRAL.y);
await step(30);
const before = (await state()).throttle;
await page.keyboard.down("s");
await step(120);
await page.keyboard.up("s");
const afterS = await state();
check(
  "S pulls the throttle back rather than the nose down",
  afterS.throttle < before - 0.1 && Math.abs(afterS.pitch) < 0.05,
  `throttle ${before.toFixed(2)} → ${afterS.throttle.toFixed(2)}, pitch cmd ${afterS.pitch.toFixed(2)}`,
);
await page.keyboard.down("w");
await step(120);
await page.keyboard.up("w");
const afterW = (await state()).throttle;
check(
  "and W pushes it back up",
  afterW > afterS.throttle + 0.1,
  `throttle ${afterS.throttle.toFixed(2)} → ${afterW.toFixed(2)}`,
);

// ---- 6. H reopens, Escape closes -------------------------------------------
await page.keyboard.press("h");
await step(2); // the edge flag is announced as the frame is consumed
await card.waitFor({ state: "visible", timeout: 10000 });
check("H reopens the card", true);
await page.keyboard.press("Escape");
await step(2);
await card.waitFor({ state: "hidden", timeout: 10000 });
check(
  "Escape closes the card without also opening the pause menu",
  !(await page.getByText("Paused").isVisible()),
);

// and it does not open itself a second time
await page.keyboard.press("Escape");
await step(2);
await page.getByRole("button", { name: "← Hangar" }).click();
await page.getByRole("button", FLY).click();
await page.waitForTimeout(500);
check("the card does not reopen on the second flight", !(await card.isVisible()));

// ---- 7. the keyboard scheme puts pitch back on W and S ----------------------
await page.evaluate(() => window.__angels.stop());
await page.keyboard.press("h");
await step(2);
await card.waitFor({ state: "visible", timeout: 10000 });
await page.getByRole("button", { name: /^Keyboard/ }).click();
await page.getByRole("button", { name: "Got it" }).click();
await card.waitFor({ state: "hidden", timeout: 10000 });
await page.keyboard.down("w");
await step(120);
const kb = await state();
await page.keyboard.up("w");
check(
  "the keyboard scheme puts pitch back on W",
  kb.pitch > 0.3 && !kb.stick.active,
  `pitch cmd ${kb.pitch.toFixed(2)}, mouse stick ${kb.stick.active ? "still live" : "stood down"}`,
);

if (pageErrors.length) {
  check("no uncaught page errors", false, pageErrors.slice(0, 3).join(" | "));
}

await browser.close();
if (server) server.kill();

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall desktop control checks passed");
