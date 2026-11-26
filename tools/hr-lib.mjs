/**
 * Shared browser bring-up for the House Rules harnesses.
 *
 * Starts (or reuses) a dev server, opens the route with `?shot=1` so the menu
 * is skipped, and hands back the page. Everything interesting is then done
 * through `window.__homeAlone`, which is the engine.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = Number(process.env.HA_PORT ?? 5186);
export const BASE = `http://127.0.0.1:${PORT}`;

async function up(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

export async function open({ width = 360, height = 220 } = {}) {
  const server = (await up(BASE, 1200))
    ? null
    : spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
        stdio: ["ignore", "ignore", "inherit"],
        env: { ...process.env, BROWSER: "none" },
      });
  if (server && !(await up(BASE, 120000))) throw new Error("dev server never came up");

  const exe = ["/opt/pw-browsers/chromium", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) =>
    existsSync(p),
  );
  const browser = await chromium.launch({
    ...(exe ? { executablePath: exe } : {}),
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  // Tiny viewport by default: on SwiftShader fragment cost dominates.
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/ERR_CONNECTION_RESET|favicon|Failed to load resource/.test(m.text()))
      errors.push(`console: ${m.text()}`);
  });

  /** Load a level and wait until the engine has begun it. */
  async function load(level) {
    await page.goto(`${BASE}/house-rules?shot=1&level=${level}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => window.__homeAloneReady, null, { timeout: 90000 });
    await page.evaluate(() => {
      window.__homeAlone.spectator = true;
    });
  }

  /** Lay a trap at a spot, facing `yaw`, by standing just behind it. */
  const lay = (kind, x, y, z, yaw = 0) =>
    page.evaluate(
      ([kind, x, y, z, yaw]) => {
        const e = window.__homeAlone;
        e.teleport(x - Math.sin(yaw) * 1.25, y, z - Math.cos(yaw) * 1.25, yaw);
        e.settle(0.1);
        e.selectKit(null);
        e.selectKit(kind);
        const ok = e.place();
        const why = ok ? null : e.snapshot().placeHint;
        e.selectKit(null);
        return { ok, why };
      },
      [kind, x, y, z, yaw],
    );

  const close = async () => {
    await browser.close();
    server?.kill();
  };
  return { page, errors, load, lay, close };
}
