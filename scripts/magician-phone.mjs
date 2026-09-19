#!/usr/bin/env node
/**
 * magician-phone — the HUD at phone width. The canvas is white in software
 * WebGL, so this is only about the DOM: does the HUD fit, does the caption
 * show, does nothing overlap the talk button. OUT=dir to choose where.
 */
import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await page.goto("http://127.0.0.1:5177/magician", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
await page.screenshot({ path: (process.env.OUT ?? ".") + "/magician-phone-entry.png" });
await page.getByRole("button", { name: /enter the valley/i }).click();
await page.waitForFunction(() => Boolean(window.__magician), null, { timeout: 60000 });
await page.waitForTimeout(4000);
await page.evaluate(() => { window.__magician.cast("make it rain"); window.__magician.caption("Rain, coming right up. Want fireflies with that?"); });
await page.waitForTimeout(1500);
await page.screenshot({ path: (process.env.OUT ?? ".") + "/magician-phone-hud.png" });
await browser.close();
process.exit(0);
