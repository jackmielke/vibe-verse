#!/usr/bin/env node
/**
 * city-folk: check Vibe City's ten pedestrians and the plaza pigeons.
 * Warps next to Rosa, checks she is in reach, opens the chat with T, says
 * hello, and photographs it. Dev server on 5184.
 *
 *     node scripts/city-folk.mjs <outDir>
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const OUT = process.argv[2] ?? "/tmp/city-folk";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ ...(existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {}), args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(300000);
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 400)));
await page.goto("http://127.0.0.1:5184/city?spawn=hub&sky=sunset", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__cityFolk && !!window.__cityDebug?.snapshot, null, { polling: 1000 });
await page.waitForTimeout(8000);
const snap = async (name) => { const url = await page.evaluate(() => window.__cityDebug.snapshot()); writeFileSync(`${OUT}/${name}.png`, Buffer.from(url.split(",")[1], "base64")); console.log("→", name); };
console.log("folk", JSON.stringify(await page.evaluate(() => window.__cityFolk.where())));
console.log("pigeons up at spawn", await page.evaluate(() => window.__cityFolk.pigeons()));
const rosa = (await page.evaluate(() => window.__cityFolk.where())).find((p) => p.id === "rosa");
await page.evaluate(([x, z]) => window.__cityWarp(x - 2, 0.3, z - 2), [rosa.x, rosa.z]);
await page.waitForTimeout(3000);
console.log("near", await page.evaluate(() => window.__cityFolk.near()));
await page.evaluate(() => window.__cityCam(6, 0.25, Math.PI * 1.25));
await page.keyboard.press("KeyT");
await page.waitForTimeout(1500);
await page.keyboard.type("hi rosa, what's good here?");
await page.keyboard.press("Enter");
await page.waitForTimeout(12000);
const chat = await page.evaluate(() => [...document.querySelectorAll("form")].map((f) => f.parentElement?.innerText).join("\n---\n"));
console.log("chat panel:", chat.slice(0, 600));
await snap("rosa-chat");
await browser.close();
