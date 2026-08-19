import { chromium } from "playwright";
const BASE = "http://127.0.0.1:5177";
const b = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox", "--disable-dev-shm-usage"],
});
const p = await b.newPage({ viewport: { width: 1280, height: 760 } });
p.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await p.goto(`${BASE}/empyrean`, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(9000);
try { await p.getByRole("button", { name: /arrive/i }).click({ timeout: 9000 }); } catch { console.log("no Arrive"); }
await p.waitForTimeout(20000);

const shots = [
  { name: "over-ring", at: [154, 700, 154], look: [Math.PI / 4, 0.62], dist: 26 },
  { name: "high", at: [430, 1010, 430], look: [Math.PI / 4, 0.36], dist: 22 },
];
for (const s of shots) {
  const r = await p.evaluate(({ at, look, dist }) => {
    const w = window.__empyrean;
    if (!w) return "no hook";
    w.warp(at[0], at[1], at[2]);
    w.look(look[0], look[1]);
    w.dist(dist);
    return "ok";
  }, s).catch((e) => "eval failed " + e);
  console.log(s.name, r);
  await p.waitForTimeout(6000);
  await p.screenshot({ path: `.shots/tram-${s.name}.jpg`, type: "jpeg", quality: 88 });
  const st = await p.evaluate(() => window.__empyrean?.counts?.()).catch(() => null);
  console.log(s.name, JSON.stringify(st));
}
await b.close();
