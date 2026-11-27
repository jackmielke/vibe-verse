#!/usr/bin/env node
/**
 * vibecup-online: two people in one Vibe Cup room, the way they would play it.
 * A laptop makes the room, a phone opens the invite link, the laptop kicks
 * off, the phone runs with its keys, and both play to full time.
 *
 *     node scripts/vibecup-online.mjs <outDir> [port]
 *
 * Both pages use `?net=local` (a BroadcastChannel) and live in ONE browser
 * context, because Realtime is blocked in the sandbox and two contexts never
 * hear each other. Everything else is the code that runs online.
 */
import { chromium, devices } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "/tmp/vibecup-online";
const PORT = process.argv[3] ?? "5184";
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {});
const ctx = await browser.newContext({ viewport: { width: 1180, height: 720 } });
const errors = [];
const watch = (p, who) => {
  p.on("pageerror", (e) => (errors.push(`${who}: ${e}`), console.log("pageerror", who, String(e).slice(0, 300))));
  p.on("console", (m) => m.type() === "error" && console.log("console", who, m.text().slice(0, 200)));
};
const state = (p) => p.evaluate(() => window.__vibecup.state());
const until = async (p, fn, arg, ms = 30000) => p.waitForFunction(fn, arg, { timeout: ms, polling: 250 });
const shot = async (p, name) => {
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log("→", name);
};

const host = await ctx.newPage();
watch(host, "host");
await host.goto(`${BASE}/vibe-cup?net=local`, { waitUntil: "domcontentloaded" });
await until(host, () => !!window.__vibecup);
await host.click('[data-testid="vibecup-mode-online"]');
await host.click('[data-testid="vibecup-host"]');
await until(host, () => window.__vibecup.state().net?.members?.length === 1);
const code = (await state(host)).net.code;
console.log("room", code);

// The phone: its own page in the same context (iPhone-sized, touch).
const phone = await ctx.newPage();
await phone.setViewportSize(devices["iPhone 13"].viewport);
watch(phone, "phone");
await phone.goto(`${BASE}/vibe-cup?room=${code}&net=local`, { waitUntil: "domcontentloaded" });
await until(host, () => window.__vibecup.state().net?.members?.length === 2);
await until(phone, () => window.__vibecup.state().net?.members?.length === 2);
await phone.fill('[data-testid="vibecup-name"]', "Maya");
await host.fill('[data-testid="vibecup-name"]', "Jack");
await host.waitForTimeout(1500);
console.log("host sees", JSON.stringify((await state(host)).net.members));
console.log("phone sees", JSON.stringify((await state(phone)).net.members));
await shot(host, "1-host-lobby");
await shot(phone, "1-phone-lobby");

await host.click('[data-testid="vibecup-online-kickoff"]');
await until(phone, () => window.__vibecup.state().screen === "playing");
const p0 = await state(phone);
console.log("phone ctrl", p0.net.myCtrl, "rtt", p0.net.rtt);

// The phone runs towards the goal it attacks (team 1 attacks -x: left on a landscape screen; in portrait it is rotated, so use the hook's world input via keys mapped through the view).
await phone.waitForTimeout(1500);
const before = (await state(host)).me && (await host.evaluate((c) => {
  const s = window.__vibecup.state();
  return s;
}, null));
const hostView = async () =>
  host.evaluate((ctrl) => {
    const s = window.__vibecup.state();
    return { ctrl: s.ctrls[ctrl], phase: s.phase, ball: s.ball };
  }, p0.net.myCtrl);
const a0 = await phone.evaluate(() => window.__vibecup.state().me);
await phone.keyboard.down("ArrowUp"); // portrait: up on screen is -x in the world
await phone.waitForTimeout(2000);
const mid = await phone.evaluate(() => window.__vibecup.state().me);
await phone.keyboard.up("ArrowUp");
await phone.waitForTimeout(600);
const hostSeesPhone = await host.evaluate((ctrl) => {
  const s = window.__vibecup.state();
  return s.ctrls[ctrl];
}, p0.net.myCtrl);
console.log("phone player moved on phone:", a0, "→", mid, "| host ctrl", JSON.stringify(hostSeesPhone), "phase", (await hostView()).phase);
void before;
await shot(phone, "2-phone-running");
await shot(host, "2-host-running");

// Let both play themselves to full time.
await host.evaluate(() => window.__vibecup.auto(true));
await phone.evaluate(() => window.__vibecup.auto(true));
await host.waitForTimeout(12000);
const midH = await state(host);
const midP = await state(phone);
console.log("mid host", midH.score, midH.clock, "phone", midP.score, midP.clock, "rtt", midP.net.rtt);
await shot(phone, "3-phone-match");
await shot(host, "3-host-match");
await host.evaluate(() => window.__vibecup.clock(148));
await until(host, () => window.__vibecup.state().screen === "over", null, 120000);
await until(phone, () => window.__vibecup.state().screen === "over", null, 30000);
const endH = await state(host);
const endP = await state(phone);
console.log("full time host", endH.score, "phone", endP.score);
await shot(host, "4-host-over");
await shot(phone, "4-phone-over");

// Rematch from the host carries the phone with it.
await host.click('[data-testid="vibecup-rematch"]');
await until(phone, () => window.__vibecup.state().screen === "playing" && window.__vibecup.state().net.k === 2);
console.log("rematch k", (await state(phone)).net.k);

// The host leaves: the phone is told.
await host.close();
await until(phone, () => window.__vibecup.state().net?.lost === true, null, 15000);
await shot(phone, "5-phone-host-left");
console.log("errors:", errors.length);
await browser.close();
process.exit(errors.length ? 1 : 0);
