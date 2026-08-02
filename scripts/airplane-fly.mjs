#!/usr/bin/env node
/**
 * airplane-fly — play Flight 209 headless, all the way to a stop.
 *
 * The screenshot harness proves the world *draws*. This proves it *plays*: it
 * boots the route, presses the button, flies the whole ILS approach with Otto,
 * takes over and flares at fifty feet, brakes to a stop, and reads the result
 * screen's numbers back out.
 *
 * Which is a different and more valuable thing to know, because almost none of
 * the failures that matter in a game like this are visible in a still. A phase
 * that never advances, a crisis deck that empties and throws, an autopilot
 * that flies a beautiful approach into the ground because nobody flares, a
 * result screen that says you landed when you are in a field — all of those
 * photograph perfectly.
 *
 * It renders nothing at all, so it runs in about ten seconds.
 *
 * Usage:
 *   node scripts/airplane-fly.mjs
 *   node scripts/airplane-fly.mjs --full     (the whole flight, not just the approach)
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const full = args.includes("--full");
const verbose = args.includes("--verbose");
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
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});

const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

await page.goto(`${BASE}/airplane?shot=1`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => window.__flight209Ready === true, { timeout: 180000 });
await page.evaluate(() => window.__flight209.stop());

/**
 * Fly.
 *
 * All of this runs inside the page in one call, because a round trip per
 * simulated frame would take an hour. It returns a log of what happened.
 */
const report = await page.evaluate(async (opts) => {
  const eng = window.__flight209;
  const svc = eng.ctx.services;
  const game = svc.game;
  const air = svc.flight;
  const log = [];
  const seen = new Set();

  const note = (m) => log.push(m);
  const HZ = 60;
  const DT = 1 / HZ;

  if (opts.full) game.begin();
  else game.beginAtApproach();

  let flared = false;
  let maxG = 0;
  let minMargin = 1;
  let crisesAnswered = 0;

  for (let i = 0; i < HZ * 60 * 18; i++) {
    const s = air.state;

    if (!seen.has(game.phase)) {
      seen.add(game.phase);
      note(
        `t=${(i / HZ).toFixed(0)}s  phase → ${game.phase}   ` +
          `${Math.round(s.altitude / 0.3048)} ft, ${Math.round(s.ias / 0.514444)} kt`,
      );
    }

    // Answer the radio whenever it asks, and the cabin whenever it appears —
    // always taking the first option, so this is a *mediocre* pilot's run and
    // the outcome is not flattered by perfect cabin play.
    if (game.radio.active?.reply) game.radio.answer();
    const cabin = svc.crises;
    if (cabin?.active && cabin.active.chosen < 0 && cabin.active.remaining < 6) {
      cabin.choose(0);
      crisesAnswered++;
    }

    // Otto flies the approach, which is what he is for.
    if (game.phase !== "menu" && game.phase !== "over") {
      if (!air.ap.state.engaged && !air.ap.failed && s.radarAltitude > 200) {
        air.ap.engage(s);
      }
      // Keep him inflated: this script is testing the *approach*, not Otto's
      // leak, and a flat Otto here would only ever measure how well a robot
      // that is not flying flies.
      air.ap.state.inflation = 1;
      air.ap.state.approachMode = true;
      // Only override the speed on short final. Everywhere else the *game's*
      // own phase targets should be what is being tested — a harness that
      // rewrites them every frame is testing the harness.
      if (game.phase === "final") air.ap.state.targetIas = air.vref() + 1.5;

      // Configure on schedule, the way the checklist says.
      const d = air.ils.distance;
      if (air.ils.valid) {
        if (d < 20000 && s.flapIndex < 2) s.flapIndex = 2;
        if (d < 14000 && s.flapIndex < 3) s.flapIndex = 3;
        if (d < 11000 && !s.gear.down) s.gear.down = true;
        if (d < 8000 && s.flapIndex < 4) s.flapIndex = 4;
      }

      // The flare. A coupled ILS flies the beam into the ground — the beam
      // ends at the touchdown zone and does not curve. Somebody has to raise
      // the nose and close the throttles, and that somebody is the reason this
      // game exists.
      if (!flared && s.radarAltitude < 14 && !s.onGround) {
        flared = true;
        air.ap.disengage();
        air.playerHasControls = true;
        note(`flare at ${Math.round(s.radarAltitude / 0.3048)} ft, ${Math.round(s.ias / 0.514444)} kt`);
      }
      // Drive the *input service*, not the raw input object. The input system
      // rewrites every axis from the keyboard each frame, so anything written
      // straight into ctx.input is gone before the flight model reads it.
      if (flared && !s.onGround) {
        // Hold a landing attitude, which is what a flare actually is: raise
        // the nose to about five degrees and let the aeroplane settle onto the
        // wheels as the speed decays. Chasing a sink rate instead balloons at
        // any speed above Vref and then stalls it on from twenty feet.
        // Five degrees, gently.
        //
        // The arithmetic is worth doing rather than guessing at: arresting
        // three and a half metres a second over the fourteen metres available
        // needs about a tenth of a g of extra lift, which is a two-degree
        // change of attitude. Pulling to seven and a half instead floats the
        // aeroplane the length of the touchdown zone and then stalls it on.
        // Six and a half degrees. The approach attitude is already four, so a
        // target of five is not a flare at all — it commands *less* than the
        // autopilot was holding, the nose drops as Otto lets go, and the
        // aeroplane arrives at twice the glideslope's sink rate. Pulling to
        // seven and a half instead only works at Vref; at Vref+8 it floats the
        // length of the touchdown zone and stalls on. This is the middle.
        const err = 0.115 - s.pitchAngle;
        svc.input.setAxis(
          "pitch",
          Math.max(-0.2, Math.min(0.5, err * 3.5 - s.omega.x * 2.5)),
        );
        // Wings level, actively, plus a little bank into the drift. Eight
        // seconds of flare in a gusting crosswind with nobody on the wheel is
        // enough to put an outboard pod on the runway — and to blow the
        // aeroplane forty metres off the centreline, which is the whole reason
        // a real crosswind landing needs a wing down and top rudder.
        // Bank into the drift, but only a little: a 707's outboard engine pods
        // hang low enough that nine degrees at touchdown is a pod strike, and
        // the model checks for exactly that.
        const drift = Math.max(-0.06, Math.min(0.06, s.velocity.z * 0.018 + s.position.z * 0.0016));
        svc.input.setAxis(
          "roll",
          Math.max(-0.9, Math.min(0.9, (drift - s.bankAngle) * 6.0 + s.omega.z * 2.4)),
        );
        svc.input.setAxis("yaw", Math.max(-0.5, Math.min(0.5, -s.beta * 3.0)));
        // Close the levers *in* the flare, not at the top of it: a four-second
        // spool-down started at forty feet takes the thrust away while the
        // aeroplane still needs it.
        svc.input.setAxis("throttle", s.radarAltitude < 7 ? 0 : 0.14);
      }
      if (s.onGround && s.groundSpeed > 2) {
        svc.input.setAxis("pitch", 0);
        svc.input.setAxis("throttle", 0);
        // Wings level with aileron, all the way to a stop. Not optional and not
        // cosmetic: at sixty metres a second the wing is still carrying most of
        // the weight, so the oleos have very little load to damp a roll with,
        // and letting go of the wheel after touchdown puts a wingtip on the
        // tarmac inside two seconds. Every jet transport is flown this way.
        svc.input.setAxis(
          "roll",
          Math.max(-1, Math.min(1, -s.bankAngle * 6.0 + s.omega.z * 2.5)),
        );
        // Nose-wheel steering back onto the centreline, and full brakes.
        // Gently. Full rudder on a wet runway at ninety knots is how you find
        // out what a ground loop feels like.
        svc.input.setAxis(
          "yaw",
          Math.max(-0.5, Math.min(0.5, -s.position.z * 0.006 - s.velocity.z * 0.12)),
        );
        eng.ctx.input.wheelBrake = 1;
        eng.ctx.input.speedbrake = 1;
      }
    }

    if (i % (10 * HZ) === 0 && game.phase !== "menu") {
      note(
        `  t=${(i / HZ).toFixed(0).padStart(3)}s x=${s.position.x.toFixed(0).padStart(6)} ` +
          `z=${s.position.z.toFixed(0).padStart(5)} agl=${(s.radarAltitude / 0.3048).toFixed(0).padStart(5)}ft ` +
          `ias=${(s.ias / 0.514444).toFixed(0)}kt vs=${((s.vs / 0.3048) * 60).toFixed(0).padStart(6)}fpm ` +
          `gs=${air.ils.gsNeedle.toFixed(2)} loc=${air.ils.locNeedle.toFixed(2)} ` +
          `pitch=${((s.pitchAngle * 180) / Math.PI).toFixed(1)}° n1=${(s.n1[0] * 100).toFixed(0)}% ` +
          `nerve=${(game.nerve * 100).toFixed(0)}%`,
      );
    }

    maxG = Math.max(maxG, s.g);
    minMargin = Math.min(minMargin, s.stallMargin);

    eng.step(DT, false);

    // After the step, not before: a crash and the phase change it triggers
    // happen inside the same step, and the loop breaks on the phase change —
    // so a check at the top of the next iteration never runs.
    if (s.crashed && !seen.has("crash")) {
      seen.add("crash");
      note(
        `CRASH "${s.crashReason}" at t=${(i / HZ).toFixed(1)}s x=${s.position.x.toFixed(0)} ` +
          `z=${s.position.z.toFixed(0)} agl=${s.radarAltitude.toFixed(2)}m ` +
          `pitch=${((s.pitchAngle * 180) / Math.PI).toFixed(1)}° bank=${((s.bankAngle * 180) / Math.PI).toFixed(1)}° ` +
          `gs=${s.groundSpeed.toFixed(1)}`,
      );
    }
    if (game.phase === "over") break;
  }

  const s = air.state;
  return {
    log,
    phase: game.phase,
    result: game.result,
    crisesAnswered,
    maxG,
    minMargin,
    finalAltitude: s.altitude,
    finalSpeed: s.groundSpeed,
    onGround: s.onGround,
    positionX: s.position.x,
    positionZ: s.position.z,
  };
}, { full });

console.log(`\n  Trans American 209 — ${full ? "the whole flight" : "the approach"}\n`);
for (const l of report.log) console.log("   " + l);

const r = report.result;
console.log("");
if (!r) {
  console.log(`   NO RESULT. Stuck in phase "${report.phase}" at ${report.finalAltitude.toFixed(0)} m.`);
} else {
  console.log(`   ${r.grade}  —  ${r.score}/100`);
  for (const n of r.notes) console.log("     · " + n);
  console.log(
    `\n   touchdown ${r.touchdownX.toFixed(0)} m in, ${r.touchdownOffset.toFixed(1)} m off centre, ` +
      `${r.touchdownFpm.toFixed(0)} fpm`,
  );
}
console.log(
  `   peak ${report.maxG.toFixed(2)} g · closest to the stall ${(report.minMargin * 100).toFixed(0)}% margin · ` +
    `${report.crisesAnswered} cabin situations`,
);

if (errors.length) {
  console.log("\n   --- page errors ---");
  for (const e of errors.slice(0, 20)) console.log("   " + e);
}

await browser.close();
server?.kill();

// The flight has to actually finish, and it has to finish on the runway.
const ok = !!r && r.landed && !r.crashed;
if (verbose) console.log(JSON.stringify(report, null, 2));
console.log(ok ? "\n   PASS\n" : "\n   FAIL\n");
process.exit(ok && errors.length === 0 ? 0 : 1);
