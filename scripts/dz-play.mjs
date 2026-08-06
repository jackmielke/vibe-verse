#!/usr/bin/env node
/**
 * dz-play — play Drop Zero and write down everything that breaks.
 *
 * `dz-shot` proves the world RENDERS. It says nothing about whether the game
 * PLAYS, because it poses a frozen player and takes a picture. Every system
 * below the scenery — building, weapons, harvesting, loot, bots, the storm,
 * the match phases — had never once been exercised when this file was
 * written. They were compiled, reasoned about, and never run.
 *
 * So this drives the actual game through real input events and asserts on the
 * engine's own state after each step. It is a smoke test with a camera: each
 * beat says what it expects, checks whether it happened, screenshots when it
 * fails, and keeps going so one broken system does not hide the other nine.
 *
 * Design notes, learned the hard way on this project:
 *  - Drive INPUT, not state. Calling `build.place()` directly proves the
 *    function runs; pressing Z proves the game does. Nine wrong diagnoses in
 *    this project came from harnesses that bypassed the engine.
 *  - Never assert on a single frame. Under SwiftSHADER the engine runs near
 *    1 fps, so every beat waits on a CONDITION with a timeout, and reports the
 *    engine's frame count so a timeout can be told apart from a real failure.
 *  - Uncaught page errors are collected globally and attributed to whichever
 *    beat was running, because a console throw is usually the actual bug.
 *
 * Usage:
 *   node scripts/dz-play.mjs                  # full match
 *   DZ_PLAY_KEEP=1 node scripts/dz-play.mjs   # keep the browser open on fail
 * Exit code is the number of failed beats, so CI can gate on it.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.DZ_PORT ?? 5179);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.DZ_PLAY_OUT ?? "shots/play";
/**
 * Gameplay logic is quality-tier independent — tiers change shader paths and
 * instance counts, not physics or rules. So the playtest runs small and cheap
 * on purpose: every frame we do not spend rasterising is simulation we do get,
 * and the simulation is the thing under test. Rendering quality is dz-shot's
 * job, not this file's.
 */
const QUALITY = process.env.DZ_QUALITY ?? "low";

async function up(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

mkdirSync(OUT, { recursive: true });

const server = (await up(BASE, 1200))
  ? null
  : spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, BROWSER: "none" },
    });
if (server && !(await up(BASE, 180000))) {
  console.error("dev server never came up");
  process.exit(1);
}

const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  ...(existsSync(exe) ? { executablePath: exe } : {}),
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--js-flags=--max-old-space-size=4096",
  ],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });

/** Page errors, attributed to whatever beat was running when they landed. */
let beat = "boot";
const errors = [];
const seen = new Set();
const note = (kind, text) => {
  const key = `${kind}:${text.slice(0, 160)}`;
  if (seen.has(key)) return;
  seen.add(key);
  errors.push({ beat, kind, text: text.slice(0, 400) });
};
page.on("pageerror", (e) => note("pageerror", e.message));
page.on("console", (m) => {
  if (m.type() === "error") note("console.error", m.text());
  if (m.type() === "warning" && /drop zero/i.test(m.text())) note("warn", m.text());
});

await page.goto(`${BASE}/drop-zero?shot=1&q=${QUALITY}`, {
  waitUntil: "domcontentloaded",
  timeout: 120000,
});
await page.waitForFunction("window.__dzReady === true", null, { timeout: 180000 });

/** Read a snapshot of everything the game will admit to. */
const state = () =>
  page.evaluate(`(() => {
    const e = window.__dz;
    const s = e?.ctx?.services ?? {};
    const p = s.player, inv = s.inventory, b = s.build, m = s.match, st = s.storm;
    const n = (x, d) => (typeof x === "number" ? +x.toFixed(d ?? 2) : null);
    return {
      frame: e?.stats ? +e.stats.fps.toFixed(1) : null,
      elapsed: n(e?.ctx?.elapsed, 1),
      phase: m?.phase ?? null,
      alive: m?.alive ?? null,
      elims: m?.eliminations ?? null,
      pstate: p?.state ?? null,
      pos: p ? [n(p.position.x, 1), n(p.position.y, 1), n(p.position.z, 1)] : null,
      hp: n(p?.health, 1),
      shield: n(p?.shield, 1),
      wood: inv?.wood ?? null, stone: inv?.stone ?? null, metal: inv?.metal ?? null,
      slot: inv?.activeSlot ?? null,
      active: inv?.active ? (inv.active.name ?? inv.active.def) : null,
      slots: inv?.slots ? inv.slots.map((x) => (x ? (x.def ?? x.name) : null)) : null,
      pieces: b?.pieceCount ?? null,
      buildKind: b?.selected ?? null,
      circle: st?.circle ?? null,
      stormR: n(st?.radius, 0),
      safe: st && p ? st.isSafe(p.position) : null,
      drawCalls: e?.stats?.drawCalls ?? null,
    };
  })()`);

const shot = async (name) => {
  try {
    await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 600000, animations: "disabled" });
    return `${OUT}/${name}.png`;
  } catch (err) {
    return `screenshot failed: ${err.message}`;
  }
};

/** Wait until `fn` (evaluated in the page) is truthy, or give up. */
async function until(label, fn, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let ok = false;
    try {
      ok = await page.evaluate(`(() => { const e = window.__dz; const s = e.ctx.services; return !!(${fn}); })()`);
    } catch (err) {
      note("evaluate", `${label}: ${err.message}`);
    }
    if (ok) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

const results = [];
async function step(name, description, run) {
  beat = name;
  const before = await state();
  let ok = false;
  let detail = "";
  try {
    const r = await run(before);
    ok = r?.ok ?? false;
    detail = r?.detail ?? "";
  } catch (err) {
    detail = `threw: ${err.message}`;
  }
  const after = await state();
  const line = { name, description, ok, detail, before, after };
  if (!ok) line.shot = await shot(`fail-${name}`);
  results.push(line);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name.padEnd(16)} ${detail}` +
      (ok ? "" : `\n        before ${JSON.stringify(before)}\n        after  ${JSON.stringify(after)}`),
  );
  return ok;
}

// Keys go through the canvas so pointer-lock-gated handlers see them the same
// way they would from a player.
const canvas = await page.$("canvas");
/**
 * Hold a key for a duration measured in SIMULATED seconds, not wall seconds.
 *
 * This distinction is the whole reason the first honest playtest reported
 * walk, jump, harvest and building as broken when they were not. `core.ts`
 * clamps dt to 1/15 and runs at most six fixed steps per frame, so at
 * SwiftSHADER's fraction of a frame per second the simulation advances about
 * 400x slower than the clock on the wall. Holding W for four real seconds
 * bought roughly a centimetre of movement.
 *
 * So: hold until the engine itself says enough time has passed.
 */
const simNow = () => page.evaluate("window.__dz?.ctx?.elapsed ?? 0");
async function holdSim(key, simSeconds, capMs = 240000) {
  const t0 = await simNow();
  const w0 = Date.now();
  if (key) await page.keyboard.down(key);
  try {
    while ((await simNow()) - t0 < simSeconds && Date.now() - w0 < capMs) {
      await page.waitForTimeout(500);
    }
  } finally {
    if (key) await page.keyboard.up(key);
  }
  return (await simNow()) - t0;
}
/** Let `simSeconds` of simulation pass with no input. */
const waitSim = (simSeconds, capMs) => holdSim(null, simSeconds, capMs);

const press = async (key, ms = 90) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
};
const click = async (ms = 120) => {
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
};
/** Click and hold for a simulated duration — a pickaxe swing needs sim time. */
async function clickSim(simSeconds) {
  const t0 = await simNow();
  await page.mouse.down();
  try {
    while ((await simNow()) - t0 < simSeconds) await page.waitForTimeout(400);
  } finally {
    await page.mouse.up();
  }
}

/**
 * Point the crosshair somewhere the game will actually let you build.
 *
 * The eleventh harness artifact on this project. The build beats used to click
 * with the camera left dead level from the beat before, and `aimPoint` puts the
 * ghost at the full 10.5 m build range when the look ray hits nothing — which,
 * at eye height in the middle of a POI, is inside somebody's concrete wall.
 * `validate()` returned "blocked", every click was correctly refused, and the
 * beat reported a working builder as broken. Traced by instrumenting
 * `collision.overlapBox`: the box refusing the wall was a real concrete slab
 * genuinely intersecting the cell, and stubbing that one overlap out placed the
 * piece and charged the wood. The builder was never the problem; the aim was.
 *
 * A player aims at the floor in front of them. So: pitch down about 30°, then
 * sweep — turn, nod, look again — until the engine's own preview says the spot
 * is legal, and only then hand the beat back so it can CLICK. Nothing here
 * places anything; `build.place()` is never called. The assertion is still that
 * a real mouse button produces a real piece.
 */
let aimX = 320;
let aimY = 180;
async function aimBy(dx, dy) {
  aimX += dx;
  aimY += dy;
  await page.mouse.move(aimX, aimY, { steps: 3 });
}
async function aimAtBuildableGround(rounds = 2, samples = 8) {
  const legal = () => page.evaluate("window.__dz.ctx.services.build?.canPlace === true");
  for (let round = 0; round < rounds; round++) {
    if (round > 0) {
      // Still nothing. A ramp wants a clear four-metre cube and a POI street
      // does not have one; a player backs out into the open and looks again,
      // so do that rather than clicking at the same refused cell forever.
      await holdSim("KeyS", 1.2);
      await waitSim(0.2);
    }
    await page.mouse.move(320, 180, { steps: 2 });
    aimX = 320;
    aimY = 180;
    // Overshoot to the pitch clamp, then come back up: that lands the crosshair
    // on the ground a couple of metres ahead regardless of where it started.
    await aimBy(0, 900);
    await waitSim(0.15);
    await aimBy(0, -450);
    await waitSim(0.15);
    for (let i = 0; i < samples; i++) {
      if (await legal()) return true;
      await aimBy(240, i % 2 === 0 ? -70 : 70);
      await waitSim(0.18);
    }
  }
  return await legal();
}

// ---------------------------------------------------------------- the match

await step("boot", "engine boots and reaches a phase", async () => {
  const s = await state();
  return { ok: s.phase !== null, detail: `phase=${s.phase} fps=${s.frame} draws=${s.drawCalls}` };
});

await step("drop", "skipToLive puts the player on the ground, alive, in a POI", async () => {
  const r = await page.evaluate(`(() => {
    const s = window.__dz.ctx.services;
    if (!s.match?.skipToLive) return "no skipToLive";
    try { s.match.skipToLive(); return "called"; } catch (err) { return "threw: " + err.message; }
  })()`);
  const landed = await until("live+ground", `s.match.phase === "live" && s.player.state === "ground"`, 120000);
  const s = await state();
  return {
    ok: landed && s.hp > 0,
    detail: `${r} -> phase=${s.phase} state=${s.pstate} hp=${s.hp} pos=${JSON.stringify(s.pos)}`,
  };
});

await step("lock", "the pointer locks, which is what ungates all input", async () => {
  /**
   * Nothing in `?shot=1` ever asks for the pointer.
   *
   * `player.controllable` is false whenever `ctx.input.locked` is false, and
   * `input.locked` is only set by the pointerlockchange handler. The only
   * thing that calls `requestPointerLock()` is the "Drop in" button on the
   * entry veil — which shot mode deliberately does not render. So the first
   * run of this harness reported that look, walk, jump and harvest were all
   * broken, when in fact the game was correctly ignoring a player who had
   * never picked up the controller.
   *
   * requestPointerLock needs a trusted gesture, so arm a one-shot listener
   * and let Playwright's real click fire it.
   */
  await page.evaluate(`(() => {
    const c = document.querySelector("canvas");
    if (!c) return;
    c.addEventListener("click", () => { c.requestPointerLock?.(); }, { once: true });
  })()`);
  await canvas.click({ position: { x: 320, y: 180 } }).catch(() => {});
  const locked = await until("locked", `e.ctx.input.locked === true`, 20000);
  const controllable = await page.evaluate(
    "window.__dz.ctx.services.player?.controllable ?? null",
  );
  return { ok: locked && controllable === true, detail: `locked=${locked} controllable=${controllable}` };
});

await step("look", "mouse look changes yaw", async () => {
  const y0 = await page.evaluate("window.__dz.ctx.services.player.yaw");
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(320 + i * 8, 180, { steps: 2 });
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(1500);
  const y1 = await page.evaluate("window.__dz.ctx.services.player.yaw");
  return { ok: Math.abs(y1 - y0) > 0.001, detail: `yaw ${(+y0).toFixed(3)} -> ${(+y1).toFixed(3)}` };
});

await step("walk", "W moves the player across the ground", async () => {
  const a = (await state()).pos;
  const simmed = await holdSim("KeyW", 2.0);
  await waitSim(0.3);
  const b = (await state()).pos;
  const d = Math.hypot(b[0] - a[0], b[2] - a[2]);
  return {
    ok: d > 1.0,
    detail: `moved ${d.toFixed(2)}m over ${simmed.toFixed(2)}s sim ${JSON.stringify(a)} -> ${JSON.stringify(b)}`,
  };
});

await step("jump", "Space leaves the ground and lands again", async () => {
  const y0 = (await state()).pos[1];
  await press("Space", 120);
  // The arc is ~0.8s of simulation; at 400x dilation that is minutes of wall.
  const rose = await until("airborne", `s.player.position.y > ${y0 + 0.3} || s.player.state === "air"`, 180000);
  await waitSim(1.4);
  const back = await until("grounded", `s.player.state === "ground"`, 180000);
  return { ok: rose && back, detail: `rose=${rose} landed=${back}` };
});

await step("harvest", "swinging the pickaxe at a harvestable surface yields materials", async () => {
  /**
   * THE PICKAXE HAS A 3.4 m REACH, AND THE FIRST VERSION OF THIS BEAT NEVER
   * USED IT.
   *
   * It stood exactly where `skipToLive` dropped the player, swept the view a
   * few degrees, and swung six times. It reported 0/0/0 and building.ts was
   * blamed for it. Instrumenting the swing ray showed the swing firing every
   * time, the raycast running every time, and every single cast returning
   * *null*: at the drop point (472, 36, -631) a 48-direction probe at 3.4 m
   * found nothing at all, and `collision.query(pos, 12)` found two colliders
   * in a twelve-metre sphere. The nearest harvestable was 30 m away. The beat
   * was swinging at air and calling it a bug.
   *
   * So: find something harvestable, close the distance, THEN swing. The swing
   * itself is still real input — mouse down, `input.fire`, `swingPickaxe`,
   * `collision.raycast`, `inventory.addMaterial` — and the assertion is
   * unchanged and un-weakened: the material counters must go up on their own.
   * All that is added is standing where a player would have walked to, which
   * is the same licence the storm and loot beats already take.
   */
  const before = await state();
  const gainOf = (a) => a.wood - before.wood + (a.stone - before.stone) + (a.metal - before.metal);

  // Where we started, so the rest of the match is not fought from wherever
  // the nearest tree happened to be.
  const home = await page.evaluate(
    "window.__dz.ctx.services.player.position.toArray()",
  );

  // Pass 1: swing in place. If the drop point really does have something in
  // reach, that is the most honest test there is and it costs nothing.
  for (let sweep = 0; sweep < 6; sweep++) {
    await page.mouse.move(320 + sweep * 25, 210, { steps: 2 });
    await clickSim(0.9);
    await waitSim(0.25);
  }
  await waitSim(0.4);
  let after = await state();
  let how = "in reach at the drop point";

  if (gainOf(after) <= 0) {
    /**
     * Pass 2: go to the material. Probe the aim ray out to 90 m; if the
     * crosshair is not already on something harvestable, turn with the MOUSE
     * (small steps, re-probing each one) until it is, then stand 2.2 m short
     * of the hit along that same aim ray and swing again.
     */
    const probe = () =>
      page.evaluate(`(() => {
        const ctx = window.__dz.ctx, s = ctx.services, p = s.player;
        const V = ctx.camera.position.constructor;
        const h = s.collision.raycast(p.eye(new V()), p.look(new V()), 90);
        return h && h.harvest ? { kind: h.harvest, dist: +h.distance.toFixed(1) } : null;
      })()`);

    let found = await probe();
    let mx = 320 + 5 * 25;
    for (let turn = 0; turn < 48 && !found; turn++) {
      mx += 30; // ~0.06 rad of yaw per step at the default sensitivity
      await page.mouse.move(mx, 205, { steps: 2 });
      await page.waitForTimeout(60);
      found = await probe();
    }

    if (found) {
      // Close to arm's reach along the *current* aim ray, so no second turn is
      // needed — the ray that found it is the ray the swing will cast.
      const moved = await page.evaluate(`(() => {
        const ctx = window.__dz.ctx, s = ctx.services, p = s.player, t = s.terrain;
        const V = ctx.camera.position.constructor;
        const eye = p.eye(new V()), look = p.look(new V());
        const h = s.collision.raycast(eye, look, 90);
        if (!h) return null;
        const stand = h.point.clone().addScaledVector(look, -2.2);
        const gy = t?.heightAt ? t.heightAt(stand.x, stand.z) : stand.y;
        p.teleport(new V(stand.x, gy + 0.15, stand.z));
        return [+stand.x.toFixed(0), +stand.z.toFixed(0)];
      })()`);
      await waitSim(0.6);
      for (let i = 0; i < 3; i++) {
        await clickSim(1.0);
        await waitSim(0.3);
      }
      await waitSim(0.4);
      after = await state();
      how = `walked to ${found.kind} at ${found.dist}m, stood at ${JSON.stringify(moved)}`;
    } else {
      how = "no harvestable surface within 90m of the drop point in any direction";
    }
  }

  // Hand the player back where the drop left them; later beats assume it.
  await page.evaluate(`(() => {
    const ctx = window.__dz.ctx, p = ctx.services.player;
    const V = ctx.camera.position.constructor;
    p.teleport(new V(${home[0]}, ${home[1]}, ${home[2]}));
  })()`);
  await waitSim(0.3);

  return {
    ok: gainOf(after) > 0,
    detail:
      `${how}; materials ${before.wood}/${before.stone}/${before.metal}` +
      ` -> ${after.wood}/${after.stone}/${after.metal}`,
  };
});

await step("build-select", "Z selects a wall", async () => {
  await press("KeyZ");
  await page.waitForTimeout(2500);
  const s = await state();
  return { ok: s.buildKind === "wall", detail: `buildKind=${s.buildKind}` };
});

await step("build-place", "clicking in build mode places a piece", async () => {
  // Give the player materials if harvesting could not find anything, so this
  // beat tests PLACEMENT rather than re-testing harvest.
  await page.evaluate(`(() => {
    const inv = window.__dz.ctx.services.inventory;
    if (inv && inv.wood < 100) inv.addMaterial("wood", 500);
  })()`);
  const legal = await aimAtBuildableGround();
  const before = (await state()).pieces;
  let after = before;
  for (let i = 0; i < 4 && after === before; i++) {
    await clickSim(0.35);
    await waitSim(0.35);
    after = (await state()).pieces;
  }
  const s = await state();
  return {
    ok: after > before,
    detail: `legalAim=${legal} wood=${s.wood} pieces ${before} -> ${after}`,
  };
});

await step("build-ramp", "C selects a ramp and it places", async () => {
  await press("KeyC");
  await page.waitForTimeout(1500);
  const kind = (await state()).buildKind;
  // The wall from the last beat is standing in the old spot, so find a fresh
  // one rather than clicking at an occupied cell four times.
  //
  // This one still fails, and `legalAim=false` is the finding, not the excuse:
  // asked at eight IDENTICAL crosshairs around the drop POI, the build service
  // reported wall placeable at six of them and ramp and floor at NONE. Wall is
  // 4 x 0.3 m on a grid line; ramp and floor claim the whole 4 x 4 m cell. So
  // either a POI street genuinely never has a clear cell — in which case the
  // beat needs to walk out of town first — or `validate()` is wrong about the
  // footprint pieces. That is building.ts's question; this beat's job is to
  // keep asking it loudly.
  const legal = await aimAtBuildableGround();
  const before = (await state()).pieces;
  let after = before;
  for (let i = 0; i < 3 && after === before; i++) {
    await clickSim(0.35);
    await waitSim(0.35);
    after = (await state()).pieces;
  }
  return {
    ok: kind === "ramp" && after > before,
    detail: `kind=${kind} legalAim=${legal} pieces ${before} -> ${after}`,
  };
});

await step("loot", "a weapon can be acquired and selected", async () => {
  // Ask the loot system for something nearby; if nothing is in reach, spawn a
  // rifle at the player's feet, because this beat is about EQUIPPING, and the
  // "is there loot on the map" question is its own beat below.
  const r = await page.evaluate(`(async () => {
    const s = window.__dz.ctx.services;
    const p = s.player, loot = s.loot, inv = s.inventory;
    if (!loot || !inv) return "no loot/inventory service";
    // Deliberately NOT taking whatever is nearest: the first run picked up
    // Heavy Ammo, which correctly goes to the ammo pool and never occupies a
    // slot, and the beat read that as "loot is broken". Spawn a gun.
    try {
      loot.spawn({ id: "probe-ar", kind: "weapon", def: "ar", name: "Assault Rifle", rarity: "rare", ammo: 30 }, p.position.clone());
      return "spawned a rifle at the player";
    } catch (e) { return "spawn threw: " + e.message; }
  })()`);
  await waitSim(0.4);
  await page.keyboard.down("KeyE");
  await waitSim(0.9);
  await page.keyboard.up("KeyE");
  await waitSim(0.4);
  await press("Digit2");
  await waitSim(0.5);
  const s = await state();
  const hasWeapon = (s.slots ?? []).slice(1).some(Boolean);
  return { ok: hasWeapon, detail: `${r}; slots=${JSON.stringify(s.slots)} active=${s.active}` };
});

await step("loot-exists", "the map actually has loot on it", async () => {
  const n = await page.evaluate(`(() => {
    let count = 0;
    window.__dz.ctx.scene.traverse((o) => {
      const n = (o.name || "").toLowerCase();
      if (n.includes("chest") || n.includes("loot") || n.includes("pickup")) count++;
    });
    return count;
  })()`);
  return { ok: n > 0, detail: `${n} chest/loot objects in the scene graph` };
});

await step("shoot", "firing a weapon consumes ammo", async () => {
  const before = await page.evaluate(`(() => {
    const a = window.__dz.ctx.services.inventory?.active;
    return a ? (a.ammo ?? null) : null;
  })()`);
  await page.mouse.move(320, 170, { steps: 2 });
  await clickSim(1.2);
  await waitSim(0.5);
  const after = await page.evaluate(`(() => {
    const a = window.__dz.ctx.services.inventory?.active;
    return a ? (a.ammo ?? null) : null;
  })()`);
  return {
    ok: before === null ? false : after !== null && after < before,
    detail: `ammo ${before} -> ${after}`,
  };
});

await step("bots", "there are living opponents in the world", async () => {
  const r = await page.evaluate(`(() => {
    const s = window.__dz.ctx.services;
    const targets = s.combat?.queryTargets ? s.combat.queryTargets(s.player.position, 4000) : null;
    return { targets: targets ? targets.length : null, alive: s.match?.alive ?? null };
  })()`);
  return {
    ok: (r.targets ?? 0) > 0,
    detail: `combat targets within 4km=${r.targets}, match alive=${r.alive}`,
  };
});

await step("storm-damage", "standing outside the circle costs health", async () => {
  /**
   * Circle 1 has a 1250 m radius and the island's land radius is 1155, so
   * there IS no dry ground outside the first circle — the previous run
   * searched all 48 bearings, found only sea, and reported a storm bug that
   * was really a geometry fact. Shrink the circle first, then step out.
   */
  const r = await page.evaluate(`(() => {
    const s = window.__dz.ctx.services;
    const st = s.storm, p = s.player, t = s.terrain;
    if (!st || !p) return "no storm/player";
    const V = window.__dz.ctx.camera.position.constructor;
    // Pull the safe zone in around the player's neighbourhood so that dry
    // land outside it actually exists.
    st.center.set(p.position.x, p.position.y, p.position.z);
    st.radius = 60;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const rr = 140;
      const x = st.center.x + Math.cos(a) * rr;
      const z = st.center.z + Math.sin(a) * rr;
      if (t && t.isWater && t.isWater(x, z)) continue;
      const y = t?.heightAt ? t.heightAt(x, z) : 0;
      p.teleport(new V(x, y + 0.5, z));
      return "shrank zone to r=60, stood at " + [x.toFixed(0), z.toFixed(0)].join(",");
    }
    return "no dry ground even at r=140";
  })()`);
  const hp0 = (await state()).hp;
  // Circle 1 is ~1 dps, so this needs seconds of SIMULATION, not wall clock.
  await waitSim(4.0, 300000);
  const hurt = await until("hp drops", `s.player.health < ${hp0 - 0.5}`, 120000);
  const s = await state();
  return { ok: hurt, detail: `${r}; safe=${s.safe} hp ${hp0} -> ${s.hp}` };
});

await step("survive", "returning inside the circle stops the damage", async () => {
  await page.evaluate(`(() => {
    const s = window.__dz.ctx.services;
    const st = s.storm, p = s.player, t = s.terrain;
    const y = t?.heightAt ? t.heightAt(st.center.x, st.center.z) : 0;
    p.teleport(new (window.__dz.ctx.camera.position.constructor)(st.center.x, y + 0.5, st.center.z));
    p.heal ? p.heal(100, 0) : null;
  })()`);
  await waitSim(0.5);
  const hp0 = (await state()).hp;
  await waitSim(2.5);
  const s = await state();
  return { ok: s.hp >= hp0 - 0.5, detail: `safe=${s.safe} hp ${hp0} -> ${s.hp}` };
});

await step("clock", "the match clock actually advances", async () => {
  const a = await page.evaluate("window.__dz.ctx.services.storm?.timer ?? null");
  await waitSim(1.0);
  const b = await page.evaluate("window.__dz.ctx.services.storm?.timer ?? null");
  return { ok: a !== null && b !== null && b !== a, detail: `storm timer ${a} -> ${b}` };
});

await step("teardown", "disposing the engine releases the context cleanly", async () => {
  const r = await page.evaluate(`(() => {
    try {
      const e = window.__dz;
      if (e.__dzPin) clearInterval(e.__dzPin);
      e.dispose();
      return "disposed";
    } catch (err) { return "threw: " + err.message; }
  })()`);
  await page.waitForTimeout(3000);
  return { ok: r === "disposed", detail: r };
});

// ---------------------------------------------------------------- report

const failed = results.filter((r) => !r.ok);
const report = { when: new Date().toISOString(), results, errors };
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));

console.log(`\n${results.length - failed.length}/${results.length} beats passed`);
if (failed.length) console.log("failed: " + failed.map((f) => f.name).join(", "));
if (errors.length) {
  console.log(`\n${errors.length} distinct page errors:`);
  for (const e of errors.slice(0, 25)) console.log(`  [${e.beat}] ${e.kind}: ${e.text}`);
}

if (!process.env.DZ_PLAY_KEEP) {
  await browser.close();
  if (server) server.kill();
}
process.exit(failed.length);
