/**
 * Capture every character in the arcade shop, one frame each.
 *
 * Six new designs built out of a table of knobs is exactly the change where
 * "the tests pass" tells you nothing worth knowing — a character can be
 * type-correct, priced correctly, and render as a black smear. So this walks
 * the shelf and writes a PNG per character, plus one of the stage itself.
 *
 * Not committed to the repo's test run: it wants a dev server and a GPU-ish
 * browser, and it is a thing you look at rather than a thing that passes.
 *
 *   node scripts/shot-characters.mjs http://127.0.0.1:5199 /tmp/shots
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:5199";
const out = process.argv[3] ?? "/tmp/character-shots";
mkdirSync(out, { recursive: true });

/* The repo pins a newer @playwright/test than the browser bundle on this
   machine, so the default headless-shell path does not exist. Point at the
   real chromium when one is provisioned and let playwright resolve otherwise. */
const executablePath = process.env.CHROMIUM_PATH || undefined;

const browser = await chromium.launch({
  executablePath,
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(`${base}/arcade/characters`, { waitUntil: "networkidle" });
// The preview builds its model in an effect after the canvas mounts; give the
// mixer a couple of seconds of real animation so the pose is mid-stride
// rather than the T-ish first frame.
await page.waitForSelector("canvas", { timeout: 30_000 });
await page.waitForTimeout(2500);

await page.screenshot({ path: `${out}/00-stage.png` });

const names = await page.$$eval("button[aria-label], .grid button", () => []);
void names;

for (let i = 0; i < 6; i++) {
  const label = await page.$eval("h2", (el) => el.textContent?.trim() ?? "?");
  await page.screenshot({
    path: `${out}/${String(i + 1).padStart(2, "0")}-${label.replace(/\W+/g, "-")}.png`,
    clip: { x: 40, y: 250, width: 820, height: 560 },
  });
  console.log(`shot ${i + 1}: ${label}`);
  await page.click('button[aria-label="Next character"]');
  await page.waitForTimeout(2200);
}

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no console errors");
await browser.close();
