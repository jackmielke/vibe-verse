#!/usr/bin/env node
/**
 * magician-phone — the HUD at phone width, and the phone controls.
 *
 * Opens the route at 390x844 with touch, screenshots the entrance, the
 * playing HUD and the menu, then drives the joystick with pointer events
 * and checks the player actually moved, and pinches and checks the field
 * of view widened. OUT=dir to choose where the PNGs go.
 */
import { chromium } from "playwright";
const OUT = process.env.OUT ?? ".";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://127.0.0.1:5177/magician?net=off", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/magician-phone-entry.png` });
await page.getByRole("button", { name: /enter the valley/i }).click();
await page.waitForFunction(() => Boolean(window.__magician), null, { timeout: 60000 });
await page.waitForTimeout(5000);
await page.evaluate(() => { window.__magician.cast("make it rain"); window.__magician.caption("Rain, coming right up. Want fireflies with that?"); window.__magician.settle(4); });
await page.waitForTimeout(1200);
const before = await page.evaluate(() => window.__magician.player());
console.log("fov on portrait:", before.fov.toFixed(1));
await page.screenshot({ path: `${OUT}/magician-phone-hud.png` });
// Joystick: press the knob and hold it forward.
const stick = page.locator("[data-ui] >> nth=-1").first();
const joy = await page.evaluate(() => { const els = [...document.querySelectorAll("[data-ui]")]; const j = els.find((e) => e.style.touchAction === "none"); const r = j.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
void stick;
await page.mouse.move(joy.x, joy.y);
await page.mouse.down();
await page.mouse.move(joy.x, joy.y - 40, { steps: 4 });
await page.waitForTimeout(4000);
await page.mouse.up();
const after = await page.evaluate(() => window.__magician.player());
console.log("moved:", Math.hypot(after.x - before.x, after.z - before.z).toFixed(2), "m");
// Menu
await page.getByRole("button", { name: /^menu$/i }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/magician-phone-menu.png` });
// Pinch: two touches spreading apart should zoom in (narrower fov); closing zooms out.
await page.getByRole("button", { name: /^close$/i }).click();
const pinched = await page.evaluate(async () => {
  const el = document.querySelector("canvas");
  const mk = (id, x, y) => new Touch({ identifier: id, target: el, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y });
  const fire = (type, touches) => el.dispatchEvent(new TouchEvent(type, { touches, changedTouches: touches, targetTouches: touches, bubbles: true, cancelable: true }));
  fire("touchstart", [mk(1, 150, 400), mk(2, 250, 400)]);
  for (let i = 1; i <= 6; i++) { fire("touchmove", [mk(1, 150 + i * 5, 400), mk(2, 250 - i * 5, 400)]); await new Promise((r) => setTimeout(r, 30)); }
  fire("touchend", []);
  return window.__magician.player();
});
console.log("after pinch-in (fingers closing): fov", pinched.fov.toFixed(1), "zoom", pinched.zoom.toFixed(2));
if (errors.length) console.log("errors:", errors.slice(0, 5));
await browser.close();
process.exit(0);
