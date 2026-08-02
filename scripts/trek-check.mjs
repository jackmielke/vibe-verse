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
  if (m.type() === "error") errors.push(`error: ${m.text()}`);
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
    async ([idx, seconds]) => {
      const e = window.__trek;
      const s = e.ctx.services;
      const game = s.game;
      const fleet = s.fleet;

      // Jump straight to the episode under test. `goto` rather than writing
      // `game.mission`, which is a mirror of a private counter and moves
      // nothing — that is how this harness silently skipped episode one.
      game.goto(idx);
      if (game.status === "briefing") game.advance();

      const title = game.missionTitle;
      let torpedoesFired = 0;
      let redAlert = false;
      const dt = 1 / 30;
      const steps = Math.round(seconds / dt);
      let decloaks = 0;
      const offDecloak = e.ctx.on("trek:decloak", () => decloaks++);

      for (let i = 0; i < steps && game.status === "playing"; i++) {
        const p = fleet.player;
        if (!redAlert) {
          e.ctx.input.toggleAlert = true;
          redAlert = true;
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
          e.ctx.input.firePhasers = true;
          if (p.torpedoCooldown <= 0 && p.torpedoes > 0) {
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

      const p = fleet.player;
      return {
        title,
        status: game.status,
        hull: Math.round(p.hull_ * 100),
        shields: p.shields.map((v) => Math.round(v * 100)),
        torpedoesFired,
        torpedoesLeft: p.torpedoes,
        decloaks,
        alive: fleet.ships.filter((t) => t.alive && t !== p).map((t) => `${t.name} ${Math.round(t.hull_ * 100)}%`),
      };
    },
    [index, budget],
  );
}

const indices = only != null ? [Number(only)] : [0, 1, 2, 3, 4];
let bad = 0;
for (const i of indices) {
  const r = await play(i);
  const verdict =
    r.status === "won" ? "WON " : r.status === "lost" ? "LOST" : "OPEN"; // OPEN = ran out of budget
  // "OPEN" is the only genuinely suspicious outcome: it means the episode
  // neither resolved nor killed you inside four minutes of hard fighting.
  if (r.status === "playing") bad++;
  console.log(
    `${verdict}  ${i + 1}. ${r.title}\n` +
      `        hull ${r.hull}%  shields [${r.shields}]  torpedoes ${r.torpedoesFired} fired / ${r.torpedoesLeft} left` +
      (r.decloaks ? `  decloaks ${r.decloaks}` : "") +
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
