#!/usr/bin/env node
/**
 * blob-mp-check — two real browser tabs playing one room of BLOB.
 *
 *     node scripts/blob-mp-check.mjs
 *
 * `blobNet.test.ts` proves the protocol against two sims over a loopback, and
 * `blob-check.mjs` proves the world renders and plays. Neither can tell you the
 * bit in between: that the room UI, the engine wiring and the session actually
 * come together in a browser — that clicking "play with friends" produces a
 * code, that a second tab arriving on `?room=CODE` is seated, that exactly one
 * of them ends up running the bots, and that a bite crossing the wire kills the
 * victim on the victim's own screen.
 *
 * The *only* thing stubbed is the transport module, intercepted at the dev
 * server and swapped for a BroadcastChannel — same origin, no network, and the
 * same "senders do not hear themselves" behaviour as the real channel. That
 * matters because Supabase's WebSocket is unreachable from CI and from some
 * corporate networks, and a check you cannot run is a check nobody runs.
 * Everything above the transport is the shipping code.
 *
 * What this does NOT cover: Supabase itself. `net/supabase.ts` is three lines
 * of channel setup in the same shape as Vibe City, Vibe Kart and Soaked.
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const OUT = process.env.BLOB_MP_OUT ?? "/tmp";
const PORT = Number(process.env.SF_PORT ?? 5177);
const BASE = `http://127.0.0.1:${PORT}`;
const STUB = `
export async function connectRoom(room) {
  const ch = new BroadcastChannel("blob-" + room);
  let handler = null;
  ch.onmessage = (e) => { if (handler) handler(e.data); };
  return {
    send: (m) => ch.postMessage(m),
    receive: (fn) => { handler = fn; },
    close: () => { handler = null; ch.close(); },
  };
}
`;

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const errors = [];
const mkPage = async () => {
  const p = await ctx.newPage();
  await p.route("**/blob/net/supabase.ts*", (r) =>
    r.fulfill({ status: 200, contentType: "application/javascript", body: STUB }),
  );
  p.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  p.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("fonts.googleapis")) {
      errors.push(`console: ${m.text().slice(0, 140)}`);
    }
  });
  return p;
};

const a = await mkPage();
const b = await mkPage();

await a.goto(`${BASE}/blob?probe`, { waitUntil: "domcontentloaded" });
await a.waitForSelector("canvas");
await a.waitForTimeout(2000);
await a.getByLabel("your name").fill("Ana");
await a.getByRole("button", { name: /play with friends/i }).click();
await a.waitForTimeout(1500);
const code = await a.evaluate(() => new URL(location.href).searchParams.get("room"));

await b.goto(`${BASE}/blob?probe&room=${code}`, { waitUntil: "domcontentloaded" });
await b.waitForSelector("canvas");
await b.waitForTimeout(2500);
await b.getByLabel("your name").fill("Bo");
await b.waitForTimeout(500);

await a.screenshot({ path: `${OUT}/mp-a-lobby.jpg`, type: "jpeg", quality: 84 });

await a.getByRole("button", { name: /^play$/i }).click();
await b.getByRole("button", { name: /^play$/i }).click();
await a.waitForTimeout(800);

const read = async (p) =>
  p.evaluate(() => {
    const e = window.__blob;
    const me = e ? e.probe() : null;
    const chip = [...document.querySelectorAll("div")].find((d) =>
      /^[A-Z]+-[A-Z0-9]{3} · \d+$/.test(d.textContent?.trim() ?? ""),
    );
    // TypeScript `private` is compile-time only, so a check script can reach
    // into the sim. Nothing in the app does this.
    const sim = e?.sim;
    const humans = sim
      ? sim.players
          .filter((pl) => pl.peerId)
          .map((pl) => ({
            name: pl.name,
            cells: pl.cells.length,
            mass: Math.round(sim.massOf(pl)),
            x: Math.round(sim.centroid(pl).x),
            y: Math.round(sim.centroid(pl).y),
          }))
      : [];
    const bots = sim ? sim.players.filter((pl) => pl.isBot) : [];
    return {
      chip: chip?.textContent?.trim() ?? null,
      mass: me ? Math.round(me.mass) : null,
      x: me ? me.x : null,
      y: me ? me.y : null,
      alive: me ? me.cells > 0 : false,
      humans,
      botsRemote: bots.length ? bots.every((pl) => pl.remote) : null,
    };
  });

/* Park both blobs before measuring. On a desktop the aim is the cursor
   re-projected through a camera that follows you, so a stationary mouse still
   means "keep going" — the only way to stand still is to point at yourself. */
const park = async (p) => p.mouse.move(640, 430);
await park(a);
await park(b);
await a.waitForTimeout(1200);

const ra = await read(a);
const rb = await read(b);
await a.screenshot({ path: `${OUT}/mp-a.jpg`, type: "jpeg", quality: 84 });
await b.screenshot({ path: `${OUT}/mp-b.jpg`, type: "jpeg", quality: 84 });

const bOnA = ra.humans.find((h) => h.name === "Bo");
const aOnB = rb.humans.find((h) => h.name === "Ana");
const gap = (mine, theirs) =>
  mine && theirs ? Math.round(Math.hypot(mine.x - theirs.x, mine.y - theirs.y)) : null;

/* The bite that has to cross the wire: make Ana big enough to swallow Bo, put
   her on him, and see whether Bo's own client agrees that Bo is gone.
   Deliberately a modest 600 rather than a whale — a blob teleported across the
   dish at 150x its mass is a stress test of this script, not of the game, and
   the interesting question is only whether the kill crosses. */
const boBefore = rb.mass;
await a.evaluate(() => {
  const sim = window.__blob.sim;
  const bo = sim.players.find((p) => p.name === "Bo");
  const me = sim.you.cells[0];
  me.mass = 600;
  me.r = Math.sqrt(600) * 4;
  if (bo && bo.cells.length) {
    me.x = bo.cells[0].x;
    me.y = bo.cells[0].y;
    me.px = me.x;
    me.py = me.y;
  }
  sim.setAim(0, me.x, me.y);
});
await a.waitForTimeout(1200);
const afterA = await read(a);
const afterB = await read(b);

console.log(
  JSON.stringify(
    {
      code,
      bothInTheRoom: { a: ra.chip, b: rb.chip },
      // false means "these bots are mine to run" — exactly one client says that.
      botsAreRemote: { a: ra.botsRemote, b: rb.botsRemote },
      aSeesBo: bOnA && { cells: bOnA.cells, mass: bOnA.mass, offBy: gap(bOnA, rb) },
      bSeesAna: aOnB && { cells: aOnB.cells, mass: aOnB.mass, offBy: gap(aOnB, ra) },
      theBite: {
        boWas: boBefore,
        anaAfter: afterA.mass,
        anaSurvivedTheStunt: afterA.alive,
        boCellsOnAnasScreen: afterA.humans.find((h) => h.name === "Bo")?.cells ?? null,
        boAliveOnBosOwnScreen: afterB.alive,
      },
      errors,
    },
    null,
    1,
  ),
);
await browser.close();
