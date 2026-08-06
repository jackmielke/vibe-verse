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
 *  2. "point & fly" does what it says: put the ring above the horizon and the
 *     jet climbs, put it to the right and the jet banks right and comes round;
 *  3. it settles rather than hunting — a pursuit law that oscillates is worse
 *     than no pursuit law at all;
 *  4. Space rolls an inverted diving jet upright and stops it going down;
 *  5. the direct-stick scheme still works, with neutral at the middle of the
 *     screen and no lurch when a menu closes;
 *  6. W and S move the throttle rather than the nose;
 *  7. H reopens the card and Escape closes it without also pausing;
 *  8. the keyboard scheme puts pitch back on W.
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
    const fleet = window.__angels.ctx.services.fleet;
    const s = fleet.player.state;
    const svc = window.__angels.ctx.services.input;
    const i = window.__angels.ctx.input;
    return {
      bank: (s.bank * 180) / Math.PI,
      attitude: (s.pitchAttitude * 180) / Math.PI,
      climb: s.climb,
      alt: s.position.y,
      gamma: (s.gamma * 180) / Math.PI,
      heading: (s.heading * 180) / Math.PI,
      roll: i.roll,
      pitch: i.pitch,
      throttle: i.throttle,
      stick: { x: st_(svc).x, y: st_(svc).y, active: st_(svc).active, cx: st_(svc).cx, cy: st_(svc).cy },
      aim: { x: svc.aim.x, y: svc.aim.y, active: svc.aim.active },
      levelling: fleet.levelling,
    };
    function st_(v) {
      return v.stick;
    }
  });

/** Put the flight somewhere clean and predictable before a manoeuvre. */
const reset = (scheme) =>
  page.evaluate((sc) => {
    const e = window.__angels;
    e.ctx.services.input.setSetting("controlScheme", sc);
    e.ctx.services.fleet.respawn("high");
    for (let i = 0; i < 60; i++) e.step(1 / 120, false);
  }, scheme);

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
await step(4);
check("Got it dismisses the card", true);

// Under the default scheme the ring is keyboard-driven and starts in the
// middle, so there is nothing to disarm — it just means "carry on".
const handback = await state();
check(
  "control comes back centred, not wherever the button was",
  Math.abs(handback.aim.x) < 0.02 && Math.abs(handback.aim.y) < 0.02,
  `ring at ${handback.aim.x.toFixed(2)},${handback.aim.y.toFixed(2)}`,
);

// The mouse schemes *are* disarmed until the mouse is deliberately moved: a
// menu closes with the cursor on whatever button was clicked, which is never
// where the pilot meant to be pointing.
await page.evaluate(() => {
  window.__angels.ctx.services.input.setSetting("controlScheme", "pursuit");
  window.__angels.ctx.services.input.setMenuOpen(true);
  window.__angels.ctx.services.input.setMenuOpen(false);
});
await step(4);
const mouseHandback = await state();
check(
  "and the mouse schemes wait to be picked up",
  !mouseHandback.aim.active,
  mouseHandback.aim.active ? "already live" : "disarmed",
);

// ---- 3. the easy scheme: left turns left, and letting go flies level -------
// The complaint this answers is that in a real aeroplane left does not turn
// left, it rolls — and a beginner who presses left, watches the nose drop and
// concludes the controls are broken is not wrong about what they saw.
await reset("easy");
const easy = await page.evaluate(async () => {
  const e = window.__angels;
  const s = e.ctx.services.fleet.player.state;
  const deg = (r) => (r * 180) / Math.PI;
  const hdg0 = (deg(s.heading) + 360) % 360;
  const press = (code, key, down) =>
    window.dispatchEvent(
      new KeyboardEvent(down ? "keydown" : "keyup", { code, key, bubbles: true }),
    );

  press("ArrowLeft", "ArrowLeft", true);
  for (let i = 0; i < 120 * 3; i++) e.step(1 / 120, false);
  const turning = { bank: deg(s.bank), hdg: (deg(s.heading) + 360) % 360 };
  press("ArrowLeft", "ArrowLeft", false);
  // Eight seconds, because levelling off is an aeroplane bleeding a climb with
  // slightly less than one G, not a bunt. Pushing hard enough to do it in five
  // would be the controls fighting the pilot every time they let go.
  for (let i = 0; i < 120 * 8; i++) e.step(1 / 120, false);
  const letGo = { bank: deg(s.bank), gamma: deg(s.gamma), climb: s.climb };

  press("ArrowUp", "ArrowUp", true);
  for (let i = 0; i < 120 * 3; i++) e.step(1 / 120, false);
  const climbing = { gamma: deg(s.gamma), climb: s.climb };
  press("ArrowUp", "ArrowUp", false);
  return { hdg0, turning, letGo, climbing };
});
const swung = ((easy.turning.hdg - easy.hdg0 + 540) % 360) - 180;
check(
  "the left arrow turns the jet left",
  swung < -12 && easy.turning.bank < -20,
  `${swung.toFixed(0)}° of heading, ${easy.turning.bank.toFixed(0)}° of bank`,
);
check(
  "and does not knife-edge to do it",
  easy.turning.bank > -62,
  `${easy.turning.bank.toFixed(0)}° of bank`,
);
check(
  "letting go flies straight and level",
  Math.abs(easy.letGo.bank) < 6 && Math.abs(easy.letGo.climb) < 12,
  `${easy.letGo.bank.toFixed(0)}° of bank, ${easy.letGo.climb.toFixed(0)} m/s`,
);
check(
  "the up arrow climbs",
  easy.climbing.gamma > 8 && easy.climbing.climb > 25,
  `flight path ${easy.climbing.gamma.toFixed(0)}°, ${easy.climbing.climb.toFixed(0)} m/s`,
);

// ---- 4. point & fly: the ring above the horizon makes it climb -------------
await reset("pursuit");
const CX = 640;
const CY = 360;
await page.mouse.move(CX, CY);
await step(20);
await page.mouse.move(CX, CY - 250); // ring well above the horizon
await step(360);
const climb = await state();
check(
  "putting the ring above the horizon makes the jet climb",
  climb.aim.active && climb.gamma > 12 && climb.climb > 35,
  `flight path ${climb.gamma.toFixed(1)}° up, ${climb.climb.toFixed(0)} m/s`,
);
check(
  "and it does it by pulling, not by pointing the nose and mushing",
  climb.attitude > 8,
  `attitude ${climb.attitude.toFixed(1)}°`,
);

// ---- 4. the ring to the right makes it bank and turn ------------------------
await reset("pursuit");
await page.mouse.move(CX, CY);
await step(20);
const hdg0 = (await state()).heading;
await page.mouse.move(CX + 320, CY);
await step(360);
const turning = await state();
const turned = ((turning.heading - hdg0 + 540) % 360) - 180;
check(
  "the ring to the right banks the jet right and brings it round",
  turning.bank > 25 && turned > 12,
  `bank ${turning.bank.toFixed(0)}°, turned ${turned.toFixed(0)}° right`,
);

// ---- 5. and it settles instead of hunting ----------------------------------
// A pursuit law that oscillates is worse than none: the jet feels like it is
// fighting you. Bring the ring back to the middle, let it converge, then watch
// the bank for a couple of seconds.
await page.mouse.move(CX, CY);
await step(700);
const swing = await page.evaluate(() => {
  const e = window.__angels;
  const s = e.ctx.services.fleet.player.state;
  let lo = 999;
  let hi = -999;
  for (let k = 0; k < 60; k++) {
    for (let i = 0; i < 4; i++) e.step(1 / 120, false);
    const b = (s.bank * 180) / Math.PI;
    lo = Math.min(lo, b);
    hi = Math.max(hi, b);
  }
  return { lo, hi, swing: hi - lo };
});
check(
  "with the ring centred the jet settles rather than hunting",
  swing.swing < 12 && Math.abs(swing.hi) < 20,
  `bank ${swing.lo.toFixed(1)}°..${swing.hi.toFixed(1)}° over two seconds`,
);

// ---- 6. Space is the way out of trouble ------------------------------------
// Inverted and going down, which is the exact situation the complaint was
// about — and the one where "which way do I push?" has no obvious answer.
const rolledOut = await page.evaluate(() => {
  const e = window.__angels;
  const fleet = e.ctx.services.fleet;
  fleet.respawn("high");
  const s = fleet.player.state;
  s.orientation.set(0, 0, 1, 0); // 180° roll about the nose axis
  s.velocity.set(0, -90, -180);
  for (let i = 0; i < 30; i++) e.step(1 / 120, false);
  // The pursuit ring is still armed from the last check; stand it down so what
  // is being measured is the recovery and not the recovery plus a ring.
  e.ctx.services.input.aim.active = false;
  fleet.levelOut();
  for (let i = 0; i < 120 * 2.8; i++) e.step(1 / 120, false);
  return {
    bank: Math.abs((s.bank * 180) / Math.PI),
    gamma: (s.gamma * 180) / Math.PI,
    wrecked: fleet.wreck.active,
  };
});
check(
  "Space rolls an inverted diving jet upright",
  !rolledOut.wrecked && rolledOut.bank < 25,
  rolledOut.wrecked ? "hit the ground first" : `${rolledOut.bank.toFixed(0)}° of bank left`,
);
check(
  "and pulls the flight path back toward level",
  !rolledOut.wrecked && rolledOut.gamma > -14,
  `flight path ${rolledOut.gamma.toFixed(0)}°, was -27°`,
);

// The promise is not "the numbers improve", it is "you do not die". Forty
// degrees nose down through two thousand three hundred feet, which is a
// smoking hole in five seconds if nobody does anything.
const saved = await page.evaluate(() => {
  const e = window.__angels;
  const fleet = e.ctx.services.fleet;

  const dive = (useLevel) => {
    fleet.respawn("high");
    const s = fleet.player.state;
    s.position.y = 700;
    // Pitch the nose 45° down about the *body* right axis: setting x/w on a
    // fresh quaternion and post-multiplying is a rotation in the body frame,
    // which is the only way to do this from page context without THREE in
    // scope. Then put the velocity straight down the nose, so the jet is
    // genuinely diving rather than mushing at a fictional angle of attack.
    const a = -Math.PI / 4.5;
    const q = s.orientation.clone();
    q.set(Math.sin(a / 2), 0, 0, Math.cos(a / 2));
    s.orientation.multiply(q);
    s.velocity.set(0, 0, -1).applyQuaternion(s.orientation).multiplyScalar(200);
    s.angular.set(0, 0, 0);
    // Raw controls for both runs. Under the default scheme the pursuit law is
    // always flying — with the ring centred it settles the jet back to level
    // all by itself, so an "untouched" dive is not untouched at all and there
    // is no fatal control case left to compare against.
    e.ctx.services.input.setSetting("controlScheme", "keyboard");
    e.ctx.input.pitch = 0;
    e.ctx.input.roll = 0;
    for (let i = 0; i < 12; i++) e.step(1 / 120, false);
    if (useLevel) fleet.levelOut();
    let lowest = s.position.y;
    let atRecovery = null;
    for (let i = 0; i < 120 * 9; i++) {
      e.step(1 / 120, false);
      lowest = Math.min(lowest, s.radarAltitude);
      if (useLevel && atRecovery === null && fleet.levelling === 0 && i > 60) {
        atRecovery = Math.round(s.climb);
      }
      if (fleet.wreck.active) break;
    }
    const out = {
      wrecked: fleet.wreck.active,
      alt: Math.round(s.position.y),
      climb: Math.round(s.climb),
      lowest: Math.round(lowest),
      atRecovery,
    };
    if (fleet.wreck.active) fleet.restart();
    return out;
  };

  const without = dive(false);
  const with_ = dive(true);
  return { without, with_ };
});
check(
  "and a dive at the ground that would otherwise kill you does not",
  saved.without.wrecked && !saved.with_.wrecked && saved.with_.atRecovery > -12,
  `hands off: ${saved.without.wrecked ? "crashed" : `survived at ${saved.without.alt} m`} · ` +
    `LEVEL: ${
      saved.with_.wrecked
        ? "crashed"
        : `bottomed out ${saved.with_.lowest} m over the ground, ${saved.with_.atRecovery} m/s at hand-back`
    }`,
);

// ---- 7. the direct-stick scheme, with neutral in the middle ----------------
await reset("stick");
await page.mouse.move(CX + 30, CY + 30);
await step(10);
await page.mouse.move(CX, CY);
await step(90);
const centred = await state();
check(
  "direct stick puts neutral at the middle of the screen",
  centred.stick.active &&
    Math.abs(centred.stick.cx - CX) < 2 &&
    Math.abs(centred.stick.cy - CY) < 2 &&
    Math.abs(centred.pitch) < 0.02,
  `neutral at ${Math.round(centred.stick.cx)},${Math.round(centred.stick.cy)}`,
);
await page.mouse.move(CX + 170, CY);
await step(90);
const stickRoll = await state();
check(
  "and the cursor to the right still rolls it right",
  stickRoll.roll > 0.3 && stickRoll.bank > 10 && stickRoll.bank < 170,
  `roll cmd ${stickRoll.roll.toFixed(2)}, bank ${stickRoll.bank.toFixed(1)}°`,
);

// ---- 8. W and S are the throttle whenever the mouse is flying ---------------
await page.mouse.move(CX, CY);
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
