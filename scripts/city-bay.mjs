#!/usr/bin/env node
/**
 * city-bay: photograph the Vibe Gate Bridge and The Rock, then walk up the
 * bridge ramp from the city street and report where the walker ends up
 * (y about 11 is the deck). Dev server on 5184.
 *
 *     node scripts/city-bay.mjs <outDir>
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const OUT = process.argv[2] ?? "/tmp/city-bay";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ ...(existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {}), args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(300000);
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 400)));
await page.goto("http://127.0.0.1:5184/city?spawn=hub&sky=sunset", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__cityBay && !!window.__cityDebug?.snapshot, null, { polling: 1000 });
await page.waitForTimeout(8000);
const snap = async (name) => { const url = await page.evaluate(() => window.__cityDebug.snapshot()); writeFileSync(`${OUT}/${name}.png`, Buffer.from(url.split(",")[1], "base64")); console.log("→", name); };
const shot = (eye, look, fov = 60) => page.evaluate(([eye, look, fov]) => window.__cityLandmarks.shot({ eye, look, fov }), [eye, look, fov]);
await shot([-160, 30, -40], [-400, 20, -150], 60); await page.waitForTimeout(2500); await snap("bridge-from-city");
await shot([-330, 25, -40], [-470, 5, -140], 60); await page.waitForTimeout(2500); await snap("rock");
await page.evaluate(() => window.__citySky("night"));
await shot([-330, 25, -40], [-470, 5, -140], 60); await page.waitForTimeout(2500); await snap("rock-night");
await page.evaluate(() => { window.__cityLandmarks.shot(null); window.__citySky("sunset"); });
await page.evaluate(() => window.__cityWarp(-170, 0.3, -140));
await page.evaluate(() => window.__cityCam(8, 0.3, Math.PI / 2));
await page.waitForTimeout(1500);
await page.evaluate(() => window.__cityCrash.render(false));
await page.keyboard.down("KeyW");
await page.waitForTimeout(9000);
await page.keyboard.up("KeyW");
await page.evaluate(() => window.__cityCrash.render(true));
console.log("walk", JSON.stringify(await page.evaluate(() => window.__cityPos())));
await page.waitForTimeout(1500);
await snap("on-bridge");
await page.evaluate(() => window.__cityDrive(-172, 0.2, -140, -Math.PI / 2, 8, 0.7));
await page.evaluate(() => window.__cityCrash.render(false));
await page.waitForTimeout(12000);
await page.evaluate(() => window.__cityCrash.render(true));
console.log("drive", JSON.stringify(await page.evaluate(() => window.__cityPos())));
await page.waitForTimeout(1500);
await snap("drive-bridge");
await browser.close();
