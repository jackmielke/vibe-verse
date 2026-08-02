#!/usr/bin/env node
/**
 * trek-check — play the whole campaign headless and report what happened.
 *
 * A screenshot proves the world *draws*. It proves nothing about whether the
 * torpedoes hit, whether the Romulan ever decloaks, or whether episode four is
 * winnable at all — and those are the failures that actually matter, because
 * they are invisible until somebody sits down to play and gets stuck.
 *
 * So this boots the route, flies a crude autopilot (turn toward the target,
 * hold phasers on, fire a torpedo whenever the tube is loaded) and steps each
 * episode for a simulated wall-clock budget. It reports the outcome, the
 * damage traded, and any uncaught error. Rendering is off: the whole campaign
 * runs in about a minute of CPU because nothing is drawn.
 *
 *   node scripts/trek-check.mjs            # all five
 *   node scripts/trek-check.mjs --only 3   # just The Doomsday Machine
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const only = flag("only", null);
const budget = Number(flag("seconds", 260));
const gunner = args.includes("--gunner");
/*
 * A third captain: shoots until the other ship stops shooting, then talks.
 *
 * Balance of Terror has two endings and the gunner can only ever find one of
 * them. This one holds fire once the target is crippled and hails instead,
 * which is the only way the mercy branch is ever executed by anything.
 */
const merciful = args.includes("--merciful");
/*
 * A fourth captain, who gives no orders at all.
 *
 * The quiet-watch banter only speaks after thirty-two seconds in which nobody
 * said anything that mattered, so any captain who presses a key every couple of
 * seconds suppresses it by construction — which is correct behaviour and makes
 * the other three useless for testing it. This one just holds course.
 */
const idle = args.includes("--idle");
const PORT = Number(process.env.TREK_PORT ?? 5179);
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
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  // The dev server drops the HMR socket when the harness tears the page down,
  // which shows up as a resource error every single run. Counting it made the
  // script exit non-zero on a completely clean campaign, which is the fastest
  // way to teach everyone to ignore the exit code.
  const t = m.text();
  if (t.includes("ERR_CONNECTION_RESET") || t.includes("Failed to load resource")) return;
  errors.push(`error: ${t}`);
});

await page.goto(`${BASE}/trek?shot=1&q=low`, { waitUntil: "domcontentloaded", timeout: 120000 });
try {
  await page.waitForFunction(() => window.__trekReady === true, null, { timeout: 300000 });
} catch (err) {
  console.error("boot never completed:", err.message);
  for (const l of errors.slice(0, 20)) console.error(l);
  await browser.close();
  server?.kill();
  process.exit(3);
}
await page.evaluate(() => window.__trek.stop());

/**
 * One episode, played by a very stupid captain.
 *
 * Deliberately stupid: if a mission is only winnable by a player who already
 * knows the trick, an autopilot that turns toward the nearest hostile and
 * holds the trigger will fail it — and that failure is the signal. Episode
 * four in particular *should* be unwinnable this way until the maw opens,
 * which is exactly what makes the reported hull number interesting.
 */
async function play(index) {
  return page.evaluate(
    async ([idx, seconds, gunner, merciful, idle]) => {
      const e = window.__trek;
      const s = e.ctx.services;
      const game = s.game;
      const fleet = s.fleet;

      // Jump straight to the episode under test. `goto` rather than writing
      // `game.mission`, which is a mirror of a private counter and moves
      // nothing — that is how this harness silently skipped episode one.
      game.goto(idx);
      // Every held input, cleared. The engine only clears the edge-triggered
      // ones each frame, so a trigger left down by the previous episode's
      // captain carries into this one — which is a real bug the game now fixes
      // at beginMission, and which the harness should not be able to reproduce
      // by accident either.
      Object.assign(e.ctx.input, { firePhasers: false, yaw: 0, pitch: 0, roll: 0, throttle: 0.25 });
      if (game.status === "briefing") game.advance();

      const title = game.missionTitle;
      let torpedoesFired = 0;
      let redAlert = false;
      const dt = 1 / 30;
      const steps = Math.round(seconds / dt);
      let decloaks = 0;
      const offDecloak = e.ctx.on("trek:decloak", () => decloaks++);
      // Quiet-watch banter is priority 2 and nothing else is. Counting it is
      // the only way to know the system ever actually fires.
      let banter = 0;
      const offLine = e.ctx.on("trek:line", (l) => {
        if (l.priority === 2) banter++;
      });

      /*
       * The pacifist.
       *
       * One episode cannot be finished by anything that shoots, so the gunner
       * autopilot below can only ever prove it is *losable*. This second,
       * equally stupid captain closes to scanning range and then alternates
       * scan and hail — which is exactly the loop the episode is built on, and
       * the only way the win path gets tested at all.
       */
      // `--gunner` forces the shooting captain everywhere, which is how the
      // *lose* path of the pacifist episode gets tested: opening fire on the
      // creature has to end the episode, and an assertion nobody ever runs is
      // not an assertion.
      const diplomat = title.includes("DEVIL") && !gunner;
      let verb = 0;

      for (let i = 0; i < steps && game.status === "playing"; i++) {
        const p = fleet.player;
        if (idle) {
          e.ctx.input.throttle = 0.2;
          e.step(dt, false);
          continue;
        }
        if (!redAlert && !diplomat) {
          e.ctx.input.toggleAlert = true;
          redAlert = true;
        }

        if (diplomat) {
          const contact = fleet.ships.find((t) => t.alive && t !== p && t.allegiance === "creature");
          if (contact) {
            if (game.targetId !== contact.id) game.targetId = contact.id;
            const dir = contact.position.clone().sub(p.position).normalize();
            const local = dir.clone().applyQuaternion(p.quaternion.clone().invert());
            e.ctx.input.yaw = Math.max(-1, Math.min(1, -Math.atan2(local.x, -local.z) * 2));
            e.ctx.input.pitch = Math.max(-1, Math.min(1, Math.asin(Math.max(-1, Math.min(1, local.y))) * 2));
            const range = p.position.distanceTo(contact.position);
            // Hold a band rather than closing to zero. Flying straight at it
            // ends in a collision, which is a thing a real player would also
            // do — and the episode now survives it, but the harness should be
            // testing the intended loop rather than the recovery from it.
            e.ctx.input.throttle = range > 3200 ? 0.8 : range < 2000 ? 0 : 0.15;
            // Alternate the two orders every two seconds, close in only.
            if (range < 3800 && i % 60 === 0) {
              if (verb++ % 2 === 0) e.ctx.input.scan = true;
              else e.ctx.input.hail = true;
            }
          }
          e.step(dt, false);
          continue;
        }
        // Acquire, point at it, and hold the trigger down.
        const hostiles = fleet.ships.filter(
          (t) => t.alive && t !== p && t.allegiance !== "starfleet" && t.allegiance !== "neutral" && t.cloakLevel < 0.5,
        );
        if (hostiles.length) {
          const target = hostiles[0];
          if (game.targetId !== target.id) game.targetId = target.id;
          // Crude helm: face the target directly.
          const dir = target.position.clone().sub(p.position).normalize();
          const q = p.quaternion.clone().invert();
          const local = dir.clone().applyQuaternion(q);
          e.ctx.input.yaw = Math.max(-1, Math.min(1, -Math.atan2(local.x, -local.z) * 2));
          e.ctx.input.pitch = Math.max(-1, Math.min(1, Math.asin(Math.max(-1, Math.min(1, local.y))) * 2));
          e.ctx.input.throttle = p.position.distanceTo(target.position) > 3000 ? 0.9 : 0.25;
          const spare = merciful && target.hull_ < 0.26;
          e.ctx.input.firePhasers = !spare;
          if (spare) {
            if (i % 60 === 0) e.ctx.input.hail = true;
          } else if (p.torpedoCooldown <= 0 && p.torpedoes > 0) {
            e.ctx.input.fireTorpedo = true;
            torpedoesFired++;
          }
        } else {
          e.ctx.input.firePhasers = false;
          e.ctx.input.throttle = 0.4;
        }
        e.step(dt, false);
      }
      offDecloak();
      offLine();

      const p = fleet.player;
      return {
        title,
        status: game.status,
        hull: Math.round(p.hull_ * 100),
        shields: p.shields.map((v) => Math.round(v * 100)),
        torpedoesFired,
        torpedoesLeft: p.torpedoes,
        decloaks,
        banter,
        alive: fleet.ships.filter((t) => t.alive && t !== p).map((t) => `${t.name} ${Math.round(t.hull_ * 100)}%`),
      };
    },
    [index, budget, gunner, merciful, idle],
  );
}

const episodeCount = await page.evaluate(() => window.__trek.ctx.services.game.missionCount);
const indices = only != null ? [Number(only)] : [...Array(episodeCount).keys()];
let bad = 0;
for (const i of indices) {
  const r = await play(i);
  const verdict =
    r.status === "won" ? "WON " : r.status === "lost" ? "LOST" : "OPEN"; // OPEN = ran out of budget
  // "OPEN" is the only genuinely suspicious outcome: it means the episode
  // neither resolved nor killed you inside four minutes of hard fighting.
  // An idle captain never finishes anything, so OPEN is the expected result
  // there rather than a failure.
  if (r.status === "playing" && !idle) bad++;
  console.log(
    `${verdict}  ${i + 1}. ${r.title}\n` +
      `        hull ${r.hull}%  shields [${r.shields}]  torpedoes ${r.torpedoesFired} fired / ${r.torpedoesLeft} left` +
      (r.decloaks ? `  decloaks ${r.decloaks}` : "") +
      (r.banter ? `  banter ${r.banter}` : "") +
      (r.alive.length ? `\n        still out there: ${r.alive.join(", ")}` : ""),
  );
}

if (errors.length) {
  console.log("\n--- errors ---");
  for (const l of errors.slice(0, 20)) console.log(l);
  bad += errors.length;
}

await browser.close();
server?.kill();
process.exit(bad ? 1 : 0);
