#!/usr/bin/env node
/**
 * dz-shot — the Drop Zero capture harness.
 *
 * `route-shot.mjs` is the blunt version: boot a route, wait, grab the frame.
 * That is not enough for a 3 km island, because the one frame it can get is
 * the spawn frame, and the spawn frame is never the picture you want. This
 * one boots `/drop-zero?shot=1`, waits for the engine to appear on `window`,
 * then poses the camera at a series of named vantage points and captures each
 * one — so a visual critic gets the skyline, a street, the storm and the HUD
 * rather than one lucky angle.
 *
 * Usage:
 *   node scripts/dz-shot.mjs                     # every shot, into shots/
 *   node scripts/dz-shot.mjs town street         # only those two
 *   DZ_OUT=/tmp/x node scripts/dz-shot.mjs       # elsewhere
 *
 * Exits non-zero if the page threw, so a loop can tell "ugly" from "broken".
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.DZ_PORT ?? 5178);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.DZ_OUT ?? "shots";
const WAIT = Number(process.env.DZ_WAIT ?? 30000);
/**
 * How long to let the world rebuild itself after each pose.
 *
 * This was 2.5 s and that was measurably wrong. Under SwiftSHADER the engine
 * runs at roughly one frame per second, so 2.5 s is two or three frames —
 * and camera-driven streaming (grass, tree cells, terrain LOD) needs dozens
 * to refill after the camera teleports across the island. The first capture
 * runs photographed a world that had planted about a thousand instances of a
 * possible seven thousand, and I read that as "vegetation is broken".
 *
 * It is not enough for the frame to be rendered; the frame has to be FINISHED.
 */
const SETTLE = Number(process.env.DZ_SETTLE ?? 25000);
/** Force the tier a real visitor gets. See the note in DropZero.tsx. */
const QUALITY = process.env.DZ_QUALITY ?? "high";
/**
 * Which game to boot. `/drop-zero` is SPLASH ROYALE (the default there),
 * `/drop-zero?mode=classic` is Drop Zero, `/better-fortnite` is BETTER
 * FORTNITE. A route rather than a mode flag, because the route is what a
 * player has and the page is what turns it into a mode.
 */
const ROUTE = process.env.DZ_ROUTE ?? "/drop-zero";
const PRIME = process.env.DZ_PRIME ?? "";

/**
 * Vantage points. `pose` runs in the page with the live engine, so a shot can
 * put the camera anywhere and read the world's own state to aim itself.
 * Keep each one describing a DIFFERENT quality question:
 *   - does the island read as designed from the air?
 *   - do the buildings hold up close?
 *   - does the ground detail survive at eye height?
 *   - do the signature effects (storm, loot, build) look expensive?
 */
const V = (e, x, y, z) => new (e.ctx.camera.position.constructor)(x, y, z);
/** Yaw/pitch aiming from a point at a target, in the engine's convention. */
const aim = (from, to) => ({
  yaw: Math.atan2(-(to.x - from.x), -(to.z - from.z)),
  pitch: Math.atan2(to.y - from.y, Math.hypot(to.x - from.x, to.z - from.z)),
});

const SHOTS = {
  /** High over the island — reads the whole map's silhouette and layout. */
  aerial: {
    settle: SETTLE,
    pose: (e) => {
      const pos = V(e, -520, 400, 540);
      return { pos, ...aim(pos, V(e, 60, 40, -60)) };
    },
  },
  /** Approach on the marquee POI. Silhouette + roof identity. */
  town: {
    settle: SETTLE,
    pose: (e) => {
      const list = e.ctx.services.pois ?? [];
      const t = list.find((x) => x.tier === "landmark") ?? list[0];
      if (!t) {
        const pos = V(e, 0, 120, 220);
        return { pos, ...aim(pos, V(e, 0, 20, 0)) };
      }
      const r = Math.max(t.radius, 60);
      const pos = V(e, t.center.x - r * 1.2, t.center.y + r * 0.7, t.center.z + r * 1.2);
      return { pos, ...aim(pos, V(e, t.center.x, t.center.y + 8, t.center.z)) };
    },
  },
  /**
   * The lido from the air. It is the one POI that is a place rather than a
   * street, so the vantage that reads it is the one that shows the slide
   * tower against the wave pool with the lazy river wrapping both.
   */
  lido: {
    settle: SETTLE,
    pose: (e) => {
      const l = e.ctx.services.lido;
      if (!l) {
        const pos = V(e, 0, 120, 220);
        return { pos, ...aim(pos, V(e, 0, 20, 0)) };
      }
      const r = Math.max(l.radius, 70);
      const pos = V(e, l.center.x - r * 0.95, l.decks.main + r * 0.62, l.center.z + r * 1.05);
      return { pos, ...aim(pos, V(e, l.center.x, l.decks.main + 6, l.center.z)) };
    },
  },
  /**
   * Standing on the lido's main deck. Same argument as `street`: pose the
   * PLAYER's feet on the deck — a metre of clearance is a metre of permanent
   * falling, and the engine derives the camera from the player anyway.
   */
  lidodeck: {
    settle: SETTLE,
    pose: (e) => {
      const l = e.ctx.services.lido;
      if (!l) {
        const pos = V(e, 0, 2, 40);
        return { pos, ...aim(pos, V(e, 0, 2, 0)) };
      }
      // Out towards the edge of the deck, looking back across the water, so
      // the frame carries pool in the middle and structure behind it.
      const r = Math.max(l.radius, 40) * 0.6;
      const a = 2.3;
      const gx = l.center.x + Math.cos(a) * r;
      const gz = l.center.z + Math.sin(a) * r;
      const pos = V(e, gx, l.decks.main + 0.06, gz);
      return { pos, ...aim(pos, V(e, l.center.x, pos.y + 2.2, l.center.z)) };
    },
  },
  /**
   * Standing at the long edge of the biggest pool, looking across it.
   *
   * The hard test for the water specifically: it puts the far coping near the
   * horizon, so the frame carries the whole Fresnel range at once — floor
   * showing through at your feet, sky reflecting off the far end. A vantage
   * looking straight DOWN at water shows only one half of that and will
   * happily photograph a flat sheet of paint as fine.
   */
  lidopool: {
    settle: SETTLE,
    pose: (e) => {
      const l = e.ctx.services.lido;
      // The wave pool by NAME, not the biggest by area. Sorting by area picked
      // a splash basin whose extent runs under the slide tower, and aiming
      // across it framed the tower's footings with no water in the shot at all.
      const pool = l?.pools?.find((x) => x.id === "wave") ?? l?.pools?.[0];
      if (!l || !pool) {
        const pos = V(e, 0, 2, 40);
        return { pos, ...aim(pos, V(e, 0, 2, 0)) };
      }
      /*
       * Height comes from the POOL's own waterline, not from `decks.main`.
       * The biggest pool is not necessarily on the main terrace, and standing
       * a park-wide deck height above a pool on the lower one buried the
       * camera in the slab: the first frame of this vantage was a full-screen
       * close-up of paving grain.
       *
       * And eight metres back, not two. The engine puts the camera about four
       * metres behind the player, so a pose that stands ON the coping puts the
       * CAMERA inside the pool wall.
       */
      /*
       * Standing IN the pool, at its centre, looking along it.
       *
       * Four attempts at photographing this from the deck landed inside
       * geometry — the slab twice, and a poolside pavilion once — because the
       * park is dense and nothing in the pool record says what is built around
       * it. The middle of a body of water is the one place in a water park
       * guaranteed to be open in every direction, and the boom behind the
       * player stays inside it as long as the pool is more than four metres
       * long, which every pool here is.
       *
       * Aimed slightly UP, like every other working ground vantage in this
       * file: the engine hangs the camera about four metres BEHIND the player
       * along the view direction, so a downward pitch swings that boom into
       * the floor. Aiming at the waterline — the intuitive way to photograph a
       * pool — produced a full-screen close-up of paving grain, twice.
       *
       */
      const pos = V(e, pool.center.x, pool.center.y + 0.05, pool.center.z);
      return { pos, ...aim(pos, V(e, pool.center.x, pos.y + 1.6, pool.center.z + pool.hz * 3)) };
    },
  },
  /**
   * Eye height in the plaza. Materials, trim, shadows — the hard test.
   *
   * `pos` is the PLAYER's feet, not the camera: the engine derives the camera
   * from the player, over the shoulder and about four metres back, and that is
   * the view the game is actually played from. So plant them on the ground —
   * a metre of clearance only makes them fall between pins — and aim at head
   * height across the POI rather than up at 5 m, which filled the frame with
   * sky and was half of why this vantage read as an aerial.
   */
  street: {
    settle: SETTLE,
    pose: (e) => {
      const list = e.ctx.services.pois ?? [];
      const t = list.find((x) => x.tier === "landmark") ?? list[0];
      const terrain = e.ctx.services.terrain;
      const cx = t ? t.center.x : 0;
      const cz = t ? t.center.z : 0;
      // Two thirds of the way out from the middle, looking back across it, so
      // there is town on both sides of the frame and more of it beyond.
      const r = t ? Math.max(t.radius, 40) * 0.62 : 46;
      const a = 2.3;
      const gx = cx + Math.cos(a) * r;
      const gz = cz + Math.sin(a) * r;
      const pos = V(e, gx, (terrain?.heightAt?.(gx, gz) ?? 0) + 0.06, gz);
      return { pos, ...aim(pos, V(e, cx, pos.y + 2.2, cz)) };
    },
  },
  /** Treeline at ground level: canopy shading, wind, grass, aerial haze. */
  nature: {
    settle: SETTLE,
    pose: (e) => {
      const terrain = e.ctx.services.terrain;
      const x = -300;
      const z = 340;
      // Planted, not floating: the pin re-teleports every 8 ms, so a metre of
      // clearance is a metre of permanent falling and the state reads `air`.
      const pos = V(e, x, (terrain?.heightAt?.(x, z) ?? 0) + 0.06, z);
      return { pos, ...aim(pos, V(e, 60, pos.y + 55, -260)) };
    },
  },
  /** The coast: water shading, foam, the shoreline gradient, the horizon. */
  coast: {
    settle: SETTLE,
    pose: (e) => {
      const terrain = e.ctx.services.terrain;
      const r = (terrain?.islandRadius ?? 1155) * 0.94;
      const a = 0.7;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const pos = V(e, x, (terrain?.heightAt?.(x, z) ?? 0) + 0.06, z);
      return { pos, ...aim(pos, V(e, Math.cos(a) * (r + 500), 0, Math.sin(a) * (r + 500))) };
    },
  },
  /**
   * The storm wall — the signature effect of the mode, shot from inside the
   * circle looking out at it.
   *
   * The fixed bearing this used to take stood the player wherever the circle
   * happened to be, which on the first live-match run was 900 m out to sea:
   * the frame came back as a beautiful underwater shot of the seabed with the
   * storm on the minimap and nowhere else. So search the circle for dry land
   * near the wall instead of assuming any exists at 0.6 radians.
   */
  storm: {
    settle: SETTLE,
    pose: (e) => {
      const s = e.ctx.services.storm;
      const terrain = e.ctx.services.terrain;
      if (!s) {
        const pos = V(e, 0, 60, 300);
        return { pos, ...aim(pos, V(e, 0, 40, 0)) };
      }
      const sea = terrain?.seaLevel ?? -1e9;
      const edge = Math.max(s.radius - 60, 30);
      // Sweep the compass; for each bearing walk inward from the wall until
      // the ground is dry. Keep the candidate that ends up nearest the wall,
      // because the wall is the subject.
      let best = null;
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        for (let r = edge; r > 25; r -= 20) {
          const x = s.center.x + Math.cos(a) * r;
          const z = s.center.z + Math.sin(a) * r;
          const y = terrain?.heightAt?.(x, z) ?? 0;
          if (y <= sea + 1.5) continue;
          if (!best || r > best.r) best = { a, r, x, z, y };
          break;
        }
      }
      if (!best) {
        // Wholly at sea: stand at the middle and look out anyway rather than
        // returning nothing, and let the ground-truth line say `swim`.
        const x = s.center.x;
        const z = s.center.z;
        best = { a: 0.6, r: edge, x, z, y: terrain?.heightAt?.(x, z) ?? 0 };
      }
      const pos = V(e, best.x, best.y + 0.06, best.z);
      const tx = s.center.x + Math.cos(best.a) * (best.r + 400);
      const tz = s.center.z + Math.sin(best.a) * (best.r + 400);
      // Aim up the face of the wall: it is hundreds of metres tall and a level
      // look reads as purple fog rather than as a wall.
      return { pos, ...aim(pos, V(e, tx, pos.y + 90, tz)) };
    },
  },
};

/**
 * Pose by driving the PLAYER, not the camera.
 *
 * This is the third design of this function and the first correct one, and
 * the history is worth keeping because it cost four wrong diagnoses.
 *
 * v1 set `camera.position` directly. The player system rewrites the camera in
 * `lateUpdate`, so every shot came back identical — the battle bus, six times.
 *
 * v2 posed inside `renderOverride`, which the engine calls last. The camera
 * then pointed where we asked, but ONLY at draw time: every system that reads
 * the camera during `update`/`lateUpdate` — terrain LOD and culling, grass
 * streaming, the shadow cascade's focus — still saw the player's camera,
 * somewhere else entirely. That produced an island whose 121 terrain chunks
 * all culled themselves (read as "the terrain is white"), a world that looked
 * unplanted, and a frame with no shadows in it. Three bugs that were not bugs.
 *
 * v3: move the player and let the engine derive the camera the way it does in
 * a real match. Everything then agrees, because there is only one camera and
 * one source for it. We pin the player on a fast interval so gravity never
 * accumulates and the pose holds for the whole settle window.
 *
 * v4 kept v3's teleport pin but stopped trusting it blindly. `teleport` only
 * moves the player in the states where the player owns their own position —
 * on the bus, in the dive and under canopy the position is *derived* every
 * fixed step, so the pin was writing 120 times a second into a value that was
 * recomputed from the bus route immediately afterward. Every pose held for
 * zero frames and every shot came back as a view from the battle bus. The fix
 * is upstream, in `match.skipToLive()`: get the match onto the ground first,
 * and only then is a teleport pin a meaningful thing to do.
 *
 * The pin also holds health up. A capture run is over an hour of wall clock,
 * which under the dt clamp is several minutes of match time — long enough for
 * the storm to close over a vantage that is deliberately standing outside it
 * and kill the player mid-shoot, which flips the match to the spectate camera
 * and quietly ruins every remaining frame.
 *
 * The lesson generalises: a capture harness that bypasses the engine measures
 * the harness, not the game.
 */
function installPose(fn) {
  return `(() => {
    const e = window.__dz;
    if (!e) return;
    // The pose bodies close over these in Node; they must exist in the page too.
    const V = ${V.toString()};
    const aim = ${aim.toString()};
    const pose = ${fn.toString()};
    if (e.__dzPin) clearInterval(e.__dzPin);
    const apply = () => {
      const p = e.ctx.services.player;
      if (!p) return;
      const want = pose(e);
      if (!want) return;
      // Teleport rather than assign, so the system can clear its own state
      // (grounded flags, fall damage accumulators) as it sees fit.
      p.teleport(want.pos);
      p.velocity.set(0, 0, 0);
      if (typeof want.yaw === "number") p.yaw = want.yaw;
      if (typeof want.pitch === "number") p.pitch = want.pitch;
      // Outlive the storm. See the note above.
      p.health = p.maxHealth;
      p.shield = p.maxShield;
    };
    apply();
    e.__dzPin = setInterval(apply, 8);
  })()`;
}

/**
 * Read the ground truth out of the live engine: is this actually a frame of a
 * live match at ground level, or is it the bus again?
 *
 * Called before every screenshot, because "the pose was applied" and "the
 * engine agrees the player is standing in a town" are different claims and
 * this project has already paid for confusing them six times.
 */
const GROUND_TRUTH = `(() => {
  const e = window.__dz;
  const p = e?.ctx?.services?.player;
  const m = e?.ctx?.services?.match;
  const t = e?.ctx?.services?.terrain;
  if (!p || !m) return { ok: false, why: "no services" };
  const gy = t?.heightAt ? t.heightAt(p.position.x, p.position.z) : 0;
  const pois = e.ctx.services.pois ?? [];
  let where = "open ground";
  let best = Infinity;
  for (const poi of pois) {
    const d = Math.hypot(poi.center.x - p.position.x, poi.center.z - p.position.z);
    if (d < Math.max(poi.radius, 40) * 1.4 && d < best) { best = d; where = poi.name; }
  }
  /* The camera and the skin, because a frame that looks "too close" can be
     a bigger character or a shorter boom, and the picture cannot say which. */
  const cam = e.ctx.camera.position;
  const camDist = Math.round(Math.hypot(cam.x - p.position.x, cam.y - p.position.y, cam.z - p.position.z) * 100) / 100;
  const skinObj = e.ctx.scene.getObjectByName("dz-skin");
  let skin = null;
  if (skinObj && skinObj.children.length) {
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9], n = 0;
    skinObj.updateWorldMatrix(true, true);
    skinObj.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      n++;
      /* A skinned mesh's geometry box is the BIND pose, centred wherever the
         modeller left it — for the Quaternius rigs that read as a character
         half its size standing forty centimetres underground. SkinnedMesh
         keeps a box of the posed vertices; that is the one the loader fits
         from and the one to measure. */
      let b;
      if (o.isSkinnedMesh) {
        o.skeleton && o.skeleton.update();
        o.computeBoundingBox();
        b = o.boundingBox;
      } else {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        b = o.geometry.boundingBox;
      }
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
        const w = o.localToWorld(new (p.position.constructor)(x, y, z));
        mn = [Math.min(mn[0], w.x), Math.min(mn[1], w.y), Math.min(mn[2], w.z)];
        mx = [Math.max(mx[0], w.x), Math.max(mx[1], w.y), Math.max(mx[2], w.z)];
      }
    });
    skin = n ? { meshes: n, size: mx.map((v, i) => Math.round((v - mn[i]) * 100) / 100), feetY: Math.round(mn[1] * 100) / 100 } : { meshes: 0 };
  }
  /* Where the third-person weapon actually is, and where the hand it should
     be in is — relative to the player's feet, so "in the hand" is a number. */
  const rel = (o) => {
    if (!o) return null;
    o.updateWorldMatrix(true, false);
    const w = new (p.position.constructor)().setFromMatrixPosition(o.matrixWorld);
    return [w.x - p.position.x, w.y - p.position.y, w.z - p.position.z].map((v) => Math.round(v * 100) / 100);
  };
  const tpRoot = e.ctx.scene.getObjectByName("dz-weapon-tp");
  const hand = e.ctx.scene.getObjectByName("dz-hand-r");
  const weapon = tpRoot ? { visible: tpRoot.visible, at: rel(tpRoot) } : null;
  const handAt = rel(hand);
  return {
    ok: m.phase === "live" && p.state !== "bus" && p.state !== "skydive" && p.state !== "glide",
    phase: m.phase,
    state: p.state,
    camDist,
    skin,
    weapon,
    hand: handAt,
    altitude: Math.round((p.position.y - gy) * 100) / 100,
    where,
    x: Math.round(p.position.x),
    z: Math.round(p.position.z),
    health: Math.round(p.health),
  };
})()`;


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

const wanted = process.argv.slice(2).filter((a) => SHOTS[a]);
const names = wanted.length ? wanted : Object.keys(SHOTS);
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
    // SwiftSHADER is the only renderer available in this container. It is a
    // software rasteriser, so it is slow but pixel-honest: what it draws is
    // what a real GPU draws, just at two frames a minute.
    "--js-flags=--max-old-space-size=4096",
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

/**
 * Deafen Vite's hot-module client before any page script runs.
 *
 * A full run is over an hour of wall clock on a single dev server, and this
 * repo is edited while captures are in flight. One save of a file this route
 * imports and HMR tears the engine down and rebuilds it *mid-screenshot* — or,
 * if the save was momentarily unparseable, replaces the world with a white
 * canvas and leaves the HUD showing stale state from the engine that no longer
 * exists. That is exactly what the first run of this version photographed:
 * `drawCalls: 0`, a blank frame, and a "SPACE DROP" prompt from a match that
 * had already gone live. The frame is not evidence of anything about the game.
 *
 * The socket is stubbed rather than the client module blocked, because Vite's
 * client reloads the whole page when it *reconnects* after a dropped
 * connection — pointing it at a dead port would be worse than leaving it on.
 */
await page.addInitScript(() => {
  const Real = window.WebSocket;
  class DeafSocket extends EventTarget {
    constructor() {
      super();
      this.readyState = 1;
      this.url = "";
      this.protocol = "vite-hmr";
    }
    send() {}
    close() {
      this.readyState = 3;
    }
  }
  DeafSocket.CONNECTING = 0;
  DeafSocket.OPEN = 1;
  DeafSocket.CLOSING = 2;
  DeafSocket.CLOSED = 3;
  Object.assign(DeafSocket.prototype, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = new Proxy(Real, {
    construct(target, args) {
      const p = args[1];
      const hmr = Array.isArray(p) ? p.includes("vite-hmr") : p === "vite-hmr";
      if (hmr) return new DeafSocket();
      return new target(...args);
    },
  });
});

/**
 * DZ_LOCAL: JSON of localStorage entries to seed before any page script runs.
 * The character you play as is read at boot from `lobby.character`, so a
 * capture of a skin has to plant the pick before the world comes up —
 * DZ_PRIME is too late, the rig is already built by then.
 *
 *   DZ_LOCAL='{"lobby.character":"Wizard"}'
 */
if (process.env.DZ_LOCAL) {
  const seed = JSON.parse(process.env.DZ_LOCAL);
  await page.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, String(v));
  }, seed);
}

const errors = [];
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error") errors.push(`console.error: ${t}`);
  if (t.includes("failed to boot")) errors.push(t);
});

await page.goto(`${BASE}${ROUTE}${ROUTE.includes("?") ? "&" : "?"}shot=1&q=${QUALITY}`, { waitUntil: "domcontentloaded", timeout: 120000 });

let booted = true;
try {
  await page.waitForFunction("window.__dzReady === true", null, { timeout: WAIT });
} catch {
  booted = false;
  errors.push(`engine never signalled ready within ${WAIT}ms`);
}

/**
 * Skip the drop and put the match on the ground.
 *
 * Every shot in the first three runs was taken during the bus phase, which is
 * the one phase where the player is deliberately OUTSIDE the safe zone — so
 * the storm veil was full-screen in all six, and the island underneath was
 * judged through a purple filter that no real player ever sees for more than
 * thirty seconds. Nothing below the bus had ever been looked at.
 *
 * The previous attempt at this drove the player's own controls: wait for
 * `player.state === "bus"`, then call `match.jump()`. It logged "left bus in
 * state air after 0" and moved on, which looked like success and was not. Two
 * things were wrong with it, and both are worth writing down because they are
 * the same mistake in different clothes.
 *
 *  1. **It waited on the wrong signal.** `player.state` is only `"bus"` once
 *     `match.phase` has reached `bus`, and the match holds the whole phase
 *     machine at the title card until `ctx.input.locked` — which a headless
 *     capture never sets, because nothing ever clicks the canvas to request
 *     pointer lock. So the phase sat in `warmup` forever, the player state was
 *     `air` at the first poll, the loop exited immediately having called
 *     `jump()` zero times, and the match stayed exactly where it was.
 *  2. **It drove the simulation through the player.** Every step of that
 *     handshake — reach the bus, jump, dive, deploy, land — is a thing the
 *     game does over ninety seconds for reasons that have nothing to do with
 *     taking a photograph.
 *
 * `match.skipToLive()` replaces the whole handshake: one call, phase machine
 * started and moved to `live`, player placed on the ground, drop UI gone. It
 * is a real documented API on the match service rather than a harness hack —
 * see the comment on it — because "put me in a live match on the ground" is
 * what you want for debugging any late-game system, not just for captures.
 */
if (booted) {
  const drop = await page
    .evaluate(`(() => {
      const e = window.__dz;
      const m = e?.ctx?.services?.match;
      if (!m) return { ok: false, why: "no match service" };
      if (typeof m.skipToLive !== "function") {
        return { ok: false, why: "match.skipToLive is missing — harness and engine disagree" };
      }
      try {
        const at = m.skipToLive();
        return { ok: true, x: Math.round(at.x), y: Math.round(at.y), z: Math.round(at.z) };
      } catch (err) {
        return { ok: false, why: "skipToLive threw: " + err.message };
      }
    })()`)
    .catch((err) => ({ ok: false, why: `evaluate threw: ${err.message}` }));
  if (!drop.ok) {
    // Loud, and fatal to the run: without this every frame below is a lie.
    errors.push(`skipToLive: ${drop.why}`);
    console.error(`skipToLive FAILED: ${drop.why}`);
  } else {
    console.log(`skipToLive: placed at ${drop.x},${drop.y},${drop.z}`);
  }

  /**
   * `skipToLive` is synchronous, so the state it promises is true the instant
   * it returns — but the engine still has to run a fixed step before the
   * player's own machine has agreed, and under SwiftSHADER a step is a second
   * away. Poll for the agreement with a real timeout rather than sleeping and
   * hoping; it normally passes on the first look.
   */
  const live = await page
    .waitForFunction(
      `(() => {
        const e = window.__dz;
        const p = e?.ctx?.services?.player;
        const m = e?.ctx?.services?.match;
        if (!p || !m) return false;
        return m.phase === "live" && p.state !== "bus" && p.state !== "skydive" && p.state !== "glide";
      })()`,
      null,
      // Poll on a timer, not on rAF: under SwiftShader a heavy world can go
      // a minute between frames and a rAF poll never fires at all.
      { timeout: 60000, polling: 500 },
    )
    .then(() => true)
    .catch(() => false);
  if (!live) {
    const state = await page.evaluate(GROUND_TRUTH).catch(() => null);
    errors.push(`never reached a live ground match: ${JSON.stringify(state)}`);
    console.error(`ground handshake FAILED: ${JSON.stringify(state)}`);
  } else {
    console.log(`ground: ${JSON.stringify(await page.evaluate(GROUND_TRUTH))}`);
  }
}

// Let the first frames land: shadows, LOD selection, grass population and any
// lazily-compiled shader all resolve over the first second or two of running.
await page.waitForTimeout(booted ? 6000 : 2000);

const written = [];
for (const name of names) {
  const shot = SHOTS[name];
  if (booted) {
    try {
      await page.evaluate(installPose(shot.pose));
    } catch (err) {
      errors.push(`pose "${name}" threw: ${err.message}`);
    }
    await page.waitForTimeout(shot.settle);
    /*
     * DZ_PRIME: a JavaScript expression evaluated in the page after the pose
     * has settled and before the frame is taken, with `e` (the engine) and `s`
     * (its services) in scope. It exists for state the world only reaches on
     * its own clock — an augment hand, an island event, the second-wind
     * countdown — which at SwiftSHADER's rate is minutes of wall time away.
     * The frame is still composed exactly as it ships; only the game state is
     * moved, through the same debug entry points the playtest uses.
     *
     *   DZ_PRIME='s.augments.offerNow(); s.events.trigger("supply-storm")'
     */
    if (PRIME) {
      try {
        await page.evaluate(`(() => { const e = window.__dz; const s = e.ctx.services; ${PRIME} })()`);
        await page.waitForTimeout(Number(process.env.DZ_PRIME_SETTLE ?? 4000));
      } catch (err) {
        errors.push(`prime threw: ${err.message}`);
      }
    }
    // Ask the engine what it thinks this frame is, immediately before taking
    // it. A shot whose telemetry says "phase: bus" is not evidence of
    // anything, and printing that next to the filename is the only reason the
    // last three review rounds were not another four.
    const truth = await page.evaluate(GROUND_TRUTH).catch((err) => ({ ok: false, why: err.message }));
    console.log(`ground-truth ${name}: ${JSON.stringify(truth)}`);
    if (!truth.ok) errors.push(`shot "${name}" is not a live ground frame: ${JSON.stringify(truth)}`);
  }
  const file = `${OUT}/${name}.png`;
  // Playwright's 30s default is not enough here. Compositing a 1600x900 frame
  // of a 3 km island through a software rasteriser on the full-quality shader
  // path takes minutes, and a timeout here throws away the whole run.
  await page.screenshot({ path: file, timeout: 600000, animations: "disabled" });
  written.push(file);
  console.log(`wrote ${file}`);
}

// Frame telemetry, so a critic can tell "looks cheap" from "cannot afford it".
if (booted) {
  const stats = await page.evaluate("JSON.stringify(window.__dz.stats)").catch(() => null);
  if (stats) console.log(`stats ${stats}`);
}

await browser.close();
if (server) server.kill();

if (errors.length) {
  console.log("\npage errors:\n" + [...new Set(errors)].slice(0, 20).join("\n"));
}
console.log(`\n${written.length} shots in ${OUT}`);
process.exit(booted && !errors.length ? 0 : 1);
