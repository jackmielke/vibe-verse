#!/usr/bin/env node
/**
 * cannonrun-check: boot /cannon-run in a real browser, play it through its
 * debug hook, and write frames.
 *
 *   node scripts/cannonrun-check.mjs <outdir> [solo|duo|net]
 *
 *  - solo: shoot him, swerve, a car launched into the air (and the bang when
 *    it lands), a car tipped onto its side, then knock the truck out and
 *    watch Mort walk up and take the cannon back.
 *  - duo: two trucks on one screen, both firing, one knocked out and
 *    respawning, then both out.
 *  - net: a host and a guest over the `local` transport, in ONE browser
 *    context (BroadcastChannel does not cross contexts). The guest drives
 *    and fires; the host must see its truck move and its balls fly.
 *
 * Needs a dev server on 5178 (`npx vite --port 5178`). There is no GPU in the
 * sandbox, so the game is stepped with `__chase.run(n)` rather than by waiting.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

const out = process.argv[2] ?? "shots";
const which = process.argv[3] ?? "solo";
mkdirSync(out, { recursive: true });
const BASE = `http://127.0.0.1:${process.env.PORT ?? 5178}`;
const exe = [process.env.SF_CHROME, "/opt/pw-browsers/chromium"].filter(Boolean).find((p) => existsSync(p));
const browser = await chromium.launch({
  ...(exe ? { executablePath: exe } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const problems = [];
const open = async (path, tag) => {
  const page = await context.newPage();
  page.on("pageerror", (e) => problems.push(`${tag} pageerror: ${e.message}`));
  page.on("console", (m) => { if ((m.type() === "error" || /THREE\.WebGL/.test(m.text())) && !/net::|Failed to load resource|WebSocket/.test(m.text())) problems.push(`${tag}: ${m.text().slice(0, 600)}`); });
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  return page;
};
const ready = (page) => page.waitForFunction(() => window.__chase, null, { timeout: 120000 });
const api = (page) => ({
  st: () => page.evaluate(() => window.__chase.state()),
  c: (fn, ...args) => page.evaluate(([f, a]) => window.__chase[f](...a), [fn, args]),
  shot: async (name) => {
    const url = await page.evaluate(() => window.__chase.snapshot());
    writeFileSync(`${out}/${name}.jpg`, Buffer.from(url.split(",")[1], "base64"));
  },
});
const brief = (s) => JSON.stringify({ phase: s.phase, riders: s.riders.map((r) => `${r.label}:${r.hull}/${r.max}${r.out ? " OUT" : ""}`), foe: `${s.foeHp}/${s.foeMax}`, gap: s.gap, hits: s.hits, cash: s.cash, traffic: s.traffic, tb: s.tb?.phase, seated: s.seated, disarmed: s.disarmed });

async function takeback(a, prefix) {
  const seen = new Set();
  for (let k = 0; k < 120; k++) {
    await a.c("run", 30);
    const s = await a.st();
    const key = `${s.phase}-${s.tb.phase}`;
    if (!seen.has(key)) { seen.add(key); console.log("  takeback", key, "carrying", s.tb.carrying, "disarmed", s.disarmed.join(",")); await a.shot(`${prefix}-${key}`); }
    if (s.phase === "takeback" && s.tb.phase === 2 && s.tb.carrying && !seen.has("lift")) { seen.add("lift"); await a.shot(`${prefix}-lift`); }
    if (s.phase === "takeback" && s.tb.phase === 3 && !seen.has("carry")) { await a.c("run", 40); seen.add("carry"); await a.shot(`${prefix}-carry`); }
    if (s.phase === "over") break;
  }
  return a.st();
}

if (which === "solo") {
  const page = await open(`/cannon-run?go${process.env.HUD ? "" : "&shot"}`, "solo");
  await ready(page);
  await page.waitForTimeout(2000);
  const a = api(page);
  await a.c("run", 40);
  await a.shot("01-intro");
  await a.c("run", 160);
  console.log("after intro", brief(await a.st()));
  await a.shot("02-chase");
  for (let k = 0; k < 6; k++) { await a.c("aim"); await a.c("fire"); await a.c("run", 6); await a.c("run", 50); }
  console.log("fired", brief(await a.st()));
  await a.c("key", "d", true); await a.c("run", 60); await a.c("key", "d", false);
  console.log("swerved lat", (await a.st()).lat.toFixed(2));
  // a car into the air in front of him
  await a.c("gap", 26);
  await a.c("launchCar", true);
  await a.c("run", 12); await a.shot("03-car-flying");
  for (let k = 0; k < 8; k++) { await a.c("run", 10); const s = await a.st(); if (s.traffic.some((t) => t.mode === 3)) { console.log("landed and blew", JSON.stringify(s.traffic)); break; } }
  await a.c("run", 4); await a.shot("04-car-boom");
  await a.c("run", 40); await a.shot("05-car-burning");
  await a.c("launchCar", false);
  await a.c("run", 25); await a.shot("06-car-tipped");
  console.log("traffic", JSON.stringify((await a.st()).traffic));
  // damaged: smoke
  await a.c("hull", 25);
  await a.c("run", 60); await a.shot("07-smoking");
  // monster pickup close, for Mort's body in the cab
  await a.c("level", 3, 16);
  await a.c("run", 40); await a.shot("08-monster");
  // out, and the takeback
  await a.c("hull", 0);
  const end = await takeback(a, "09-takeback");
  console.log("end", brief(end));
  if (end.phase !== "over" || !end.disarmed[0]) problems.push("takeback did not finish with the cannon taken");
}

if (which === "backup") {
  const page = await open(`/cannon-run?go${process.env.HUD ? "" : "&shot"}`, "backup");
  await ready(page);
  await page.waitForTimeout(2000);
  const a = api(page);
  await a.c("run", 200);
  await a.c("level", 2, 30);
  await a.c("run", 30);
  await a.c("backup");
  await a.c("run", 20);
  console.log("backup", JSON.stringify(await a.c("hench")), (await a.st()).alert);
  await a.shot("01-backup-out");
  if (!(await a.c("hench")).length) problems.push("no henchmen came");
  for (let k = 0; k < 30; k++) { await a.c("run", 20); const h = await a.c("hench"); if (h.some((x) => x.state === 2)) break; }
  console.log("clinging", JSON.stringify(await a.c("hench")), "hull", (await a.st()).riders[0].hull);
  await a.c("run", 60);
  await a.shot("02-on-tailgate");
  console.log("after whacks hull", (await a.st()).riders[0].hull);
  await a.c("key", "d", true); await a.c("run", 40); await a.c("key", "d", false); await a.c("key", "a", true); await a.c("run", 40); await a.c("key", "a", false);
  console.log("after swerving", JSON.stringify(await a.c("hench")), (await a.st()).toast);
  // the roof gun
  await a.c("upgrade", { auto: 3, punch: 3, engine: 2 });
  await a.c("backup");
  await a.c("run", 240);
  await a.shot("03-auto-cannon");
  console.log("auto cannon", brief(await a.st()), JSON.stringify(await a.c("hench")));
  // a can at a civilian
  let swerved = 0;
  for (let k = 0; k < 6; k++) { await a.c("throwAtCar"); await a.c("run", 50); const st = await a.st(); if (st.swerves.some((x) => x > 0)) swerved++; }
  console.log("civilian throws that landed", swerved, "of 6");
  await a.shot("04-civilian");
  await a.c("level", 5, 18);
  await a.c("run", 40);
  await a.shot("05-train");
  console.log("train", (await a.st()).ride);
}

if (which === "duo") {
  const page = await open(`/cannon-run?duo${process.env.HUD ? "" : "&shot"}`, "duo");
  await ready(page);
  await page.waitForTimeout(2000);
  const a = api(page);
  await a.c("run", 200);
  console.log("duo start", brief(await a.st()));
  await a.shot("01-duo");
  for (let k = 0; k < 4; k++) { await a.c("fire", 0); await a.c("fire", 1); await a.c("run", 55); }
  await a.shot("02-duo-fired");
  console.log("duo fired", brief(await a.st()));
  await a.c("key", "ArrowRight", true); await a.c("run", 50); await a.c("key", "ArrowRight", false);
  const s = await a.st();
  console.log("P2 swerved", s.riderLat.map((x) => x.toFixed(2)).join(","));
  await a.c("hull", 0, 1);
  await a.c("run", 30);
  console.log("P2 out", brief(await a.st()));
  await a.shot("03-p2-out");
  await a.c("run", 660);
  const back = await a.st();
  console.log("P2 back?", brief(back));
  if (back.riders[1].out) problems.push("P2 did not respawn");
  await a.c("hull", 0, 0);
  await a.c("hull", 0, 1);
  const end = await takeback(a, "04-duo-takeback");
  console.log("duo end", brief(end));
}

if (which === "net") {
  const host = await open(`/cannon-run?host=TEST&net=local${process.env.HUD ? "" : "&shot"}`, "host");
  await host.waitForTimeout(1500);
  const guest = await open(`/cannon-run?room=TEST&net=local${process.env.HUD ? "" : "&shot"}`, "guest");
  await Promise.all([ready(host), ready(guest)]);
  const H = api(host);
  const Gu = api(guest);
  // real time has to pass for the wire, so run in small steps with waits
  const both = async (n) => { for (let k = 0; k < n; k++) { await H.c("run", 4); await Gu.c("run", 4); await host.waitForTimeout(20); } };
  await both(50);
  console.log("host", brief(await H.st()));
  console.log("guest", brief(await Gu.st()), "linda on guest", JSON.stringify((await Gu.st()).linda), "on host", JSON.stringify((await H.st()).linda));
  if (!(await Gu.st()).linda) problems.push("the guest has no Linda");
  await Gu.c("key", "d", true); await both(15); await Gu.c("key", "d", false);
  const hs = await H.st();
  const gs = await Gu.st();
  console.log("guest lat on guest", gs.riderLat[1].toFixed(2), "on host", hs.riderLat[1].toFixed(2), "s", gs.riderS[1].toFixed(1), hs.riderS[1].toFixed(1));
  if (Math.abs(gs.riderLat[1] - hs.riderLat[1]) > 1.5) problems.push("host does not see the guest where the guest is");
  const hits0 = hs.hits;
  for (let k = 0; k < 5; k++) { await Gu.c("fire", 1); await both(12); }
  const h2 = await H.st();
  console.log("after guest fire: host hits", hits0, "->", h2.hits, "foe", h2.foeHp, "/", h2.foeMax);
  await H.shot("01-host-view");
  await Gu.shot("02-guest-view");
  if (h2.hits === hits0 && h2.foeHp === h2.foeMax) problems.push("the guest's cannon never reached the host");
  // knock both out on the host, watch the guest see the takeback
  await H.c("hull", 0, 1);
  await H.c("hull", 0, 0);
  for (let k = 0; k < 60; k++) {
    await both(10);
    const g = await Gu.st();
    if (g.phase === "takeback" && g.tb.phase === 2) { await Gu.shot("03-guest-sees-takeback"); }
    if (g.phase === "over") { console.log("guest saw it end", brief(g)); break; }
  }
  const gEnd = await Gu.st();
  if (gEnd.phase !== "over") problems.push("the guest never saw the run end");
}

console.log(problems.length ? `PROBLEMS:\n${problems.join("\n")}` : "no console errors");
await browser.close();
process.exit(problems.length ? 1 : 0);
