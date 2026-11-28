/**
 * How to film each world: where to open it, what to press to get past its
 * menus, and what a "player" does during the take.
 *
 * Every take runs on a frozen clock (see `clock.js`), so `input(t, i)` is
 * called once per film frame with `i` counting from 0 (negative during the
 * preroll), and anything it does lands on exactly that frame. Hooks like
 * `__cityCam` are DEV-only, which is fine: the recorder always runs the dev
 * server.
 *
 * Adding a world: copy the closest plan, run
 * `node scripts/world-film.mjs <key> --keep`, look at the contact sheet it
 * prints, then add the key to `src/worlds/motion.ts`.
 */

export const DEFAULTS = {
  viewport: [640, 360],
  width: 480,
  fps: 24,
  seconds: 4,
  /** Real milliseconds to let the world boot before the clock stops. */
  warmup: 12000,
  /** Frozen-clock frames to run before recording, so cameras settle. */
  preroll: 24,
  /** Animation frames per film frame. >1 for worlds that clamp dt. */
  sub: 1,
  crf: 30,
};

const lerp = (a, b, k) => a + (b - a) * Math.min(1, Math.max(0, k));

export const PLANS = {
  /* Vibe City at sunset: jetpack up off the plaza, then run, camera swinging round. */
  city: {
    route: "/city?fresh=1&sky=sunset",
    warmup: 30000,
    preroll: 36,
    seconds: 5,
    async setup(t) {
      await t.page.waitForFunction(() => typeof window.__cityCam === "function", null, {
        timeout: 90000,
      });
      await t.eval(() => window.__citySky?.("sunset"));
      await t.click();
    },
    async input(t, i) {
      if (i === -36) await t.hold("w", "Shift");
      if (i === 0) await t.hold("w", "Shift", " ");
      if (i === 60) await t.hold("w", "Shift");
      const k = Math.max(0, i) / 120;
      await t.eval(
        ([d, p, y]) => window.__cityCam(d, p, y),
        [lerp(11, 24, k), lerp(0.22, 0.34, k), 0.4 + k * 1.6],
      );
    },
  },
  /* Vibe Hoops: CPU against CPU, the broadcast camera. */
  hoops: {
    route: "/hoops",
    warmup: 4000,
    preroll: 48,
    async setup(t) {
      await t.page.waitForFunction(() => window.__hoops?.state().ready, null, { timeout: 120000 });
      await t.eval(() => window.__hoops.start({ mode: "cpu", club: "volts", rival: "junkyard", difficulty: "normal" }));
      await t.page.waitForFunction(() => window.__hoops.state().screen === "playing", null, { timeout: 120000 });
      await t.eval(() => window.__hoops.auto(true));
      await t.eval(() => window.__hoops.settle?.(6));
    },
  },

  /* Zombie Tag: one player and six bots, a round already under way. */
  oni: {
    route: "/oni?go=1&bots=6&name=Jack&char=Pug",
    warmup: 6000,
    preroll: 24,
    async setup(t) {
      await t.page.waitForFunction(() => !!window.__oni, null, { timeout: 90000 });
      await t.eval(() => window.__oni.start());
      await t.wait(9000);
      await t.eval(() => window.__oni.settle?.(4));
    },
    async input(t, i) {
      if (i === -24) await t.hold("w");
      if (i === 30) await t.hold("w", "d");
      if (i === 50) await t.hold("w");
    },
  },

  /* The Magician: walk into the valley as it starts to snow, then aurora. */
  magician: {
    route: "/magician",
    warmup: 2000,
    preroll: 24,
    async setup(t) {
      await t.page.getByRole("button", { name: /enter (the valley|hoshimura)/i }).click({ timeout: 60000 });
      await t.page.waitForFunction(() => Boolean(window.__magician), null, { timeout: 60000 });
      await t.wait(6000);
      await t.eval(() => window.__magician.cast("make it sunset"));
      await t.eval(() => window.__magician.settle(8));
    },
    async input(t, i) {
      if (i === -24) await t.hold("w");
      if (i === 10) await t.eval(() => window.__magician.cast("make it snow"));
    },
  },

  kart: shot("/kart?shot=1", { hold: ["w"], warmup: 20000 }),
  /* Prism Skyway: the same kart attract mode on the rainbow road course. */
  "rainbow-road": shot("/kart?shot=1&track=prism", { hold: ["w"], warmup: 25000 }),
  /* VibeQuest: through its menus into Cloud Castles, running right and hopping. */
  vibequest: {
    route: "/vibequest",
    viewport: [1280, 720],
    warmup: 6000,
    async setup(t) {
      for (const label of ["PLAY NOW", "Classic Mode", "Witch Cat", "Confirm Witch Cat", "Cloud Castles"]) {
        if (!(await t.clickText(label, { timeout: 15000 }))) console.log(`    (no "${label}")`);
        await t.wait(4000);
      }
      await t.wait(2500);
    },
    async input(t, i) {
      const k = (i + 240) % 30;
      await t.hold(...(k < 12 ? ["ArrowRight", "ArrowUp"] : ["ArrowRight"]));
    },
  },
  /* Cannon Chase: Mort on your tail, a civilian car already in the air. */
  "cannon-run": {
    route: "/cannon-run?go&shot",
    warmup: 2000,
    async setup(t) {
      await t.page.waitForFunction(() => window.__chase, null, { timeout: 120000 });
      await t.eval(() => {
        const c = window.__chase;
        c.run(200);
        c.level(2, 26);
        c.run(30);
        c.gap(26);
        c.launchCar(true);
      });
    },
    async input(t, i) {
      if (i >= 0 && i % 24 === 0) await t.eval(() => { window.__chase.aim(); window.__chase.fire(); });
    },
  },
  /* Flight 209: from the cockpit on short final, Chicago and the approach lights ahead. */
  airplane: {
    route: "/airplane?shot=1",
    warmup: 15000,
    async setup(t) {
      await t.page.waitForFunction(() => window.__flight209?.ctx?.services, null, { timeout: 120000 });
      await t.eval(() => {
        const svc = window.__flight209.ctx.services;
        const V = svc.flight.state.position.constructor;
        const FT = 0.3048;
        svc.flight.place({ position: new V(-3900, 204.8 + 660 * FT, 0), heading: Math.PI / 2, ias: 75, flapIndex: 4, gearDown: true });
        svc.flight.state.flapAngle = 40;
        svc.camera.release();
        svc.camera.setMode("cockpit", { snap: true });
        // Lightning is random and turns whole frames white; keep it out.
        svc.sky.strike = () => {};
      });
    },
  },
  /* Mort's Maze: a fresh game on its own autopilot. (Its ?shot mode
     is a paused still, so it is no use here.) */
  "mort-maze": {
    route: "/mort-maze",
    warmup: 6000,
    /* The board is portrait in a landscape window: film big, keep the middle. */
    width: 640,
    crop: "320:200:160:84",
    outWidth: 480,
    async setup(t) {
      await t.page.waitForFunction(() => window.__mortmaze, null, { timeout: 60000 });
      await t.eval(() => { window.__mortmaze.start(); window.__mortmaze.autopilot(true); window.__mortmaze.settle(3); });
    },
  },
  /* Vibe Cup: a live match on autopilot, a few seconds after kickoff. */
  "vibe-cup": {
    route: "/vibe-cup",
    warmup: 4000,
    async setup(t) {
      await t.page.waitForFunction(() => window.__vibecup, null, { timeout: 60000 });
      await t.eval(() => { window.__vibecup.start({ seed: 7 }); window.__vibecup.auto(true); window.__vibecup.settle(6); });
    },
  },
  /* 8-Ball Club: the break, then the computer lines up its next shot. */
  pool: {
    route: "/pool",
    warmup: 4000,
    /* The table sits small in the middle of the page: zoom to it. */
    width: 640,
    crop: "384:240:124:83",
    outWidth: 480,
    async setup(t) {
      await t.page.waitForFunction(() => window.__pool, null, { timeout: 60000 });
      await t.eval(() => window.__pool.start("cpu", "normal"));
    },
    async input(t, i) {
      if (i === 4) await t.eval(() => window.__pool.shoot(0, 1));
    },
  },
  /* Fog City: in the car parked at the kerb, flat out down the street. */
  fogcity: {
    route: "/fogcity?go&shot",
    warmup: 12000,
    async setup(t) {
      await t.page.waitForFunction(() => window.__fog, null, { timeout: 90000 });
      await t.eval(() => {
        const f = window.__fog;
        f.run(30);
        f.teleport(-3 * 96 - 8.6, 0.72 * 72 - 1, Math.PI / 2);
        f.key("f", true); f.run(2); f.key("f", false);
        f.key("w", true); f.run(150);
      });
    },
  },
  /* Vibe Summit: skiing the main run through the trees, already at speed. */
  summit: {
    route: "/summit?go",
    warmup: 15000,
    async setup(t) {
      await t.page.waitForFunction(() => window.__summit, null, { timeout: 90000 });
      await t.eval(() => window.__summit.choose("ski"));
      await t.eval(() => window.__summit.settle(6));
      await t.eval(() => window.__summit.settle(14, ["w"]));
    },
    async input(t, i) {
      if (i === -24) await t.hold("w");
      if (i === 30) await t.hold("w", "a");
      if (i === 50) await t.hold("w", "d");
      if (i === 70) await t.hold("w");
    },
  },
  "trek": walk("/trek?shot"),
  deep: shot("/deep?shot", { hold: ["w"] }),
  golf: shot("/golf?shot"),
  coil: shot("/coil?shot"),
  blob: shot("/blob?shot"),
  "island-2": shot("/island-2?shot"),
  run: shot("/run?shot"),
  fnaf: shot("/fnaf?shot"),
  sf: shot("/sf?shot", { warmup: 40000 }),
  frisco: shot("/frisco?shot", { warmup: 30000 }),
  /* San Palmas: dropped 180 m over the city in a wingsuit. */
  "san-palmas": {
    route: "/san-palmas?shot",
    warmup: 20000,
    async setup(t) {
      await t.page.waitForFunction(() => window.__palmasReady === true, null, { timeout: 180000 });
      await t.eval(() => {
        const p = window.__palmas.ctx.services.player;
        const d = p.camera.getWorldDirection(p.position.clone());
        d.y = 0; d.normalize();
        p.teleport(p.position.clone().addScaledVector(d, -60).setY(p.position.y + 180));
        p.velocity.copy(d.multiplyScalar(45)).setY(-8);
      });
      await t.wait(400);
      await t.press("KeyF");
    },
  },
  "splash-royale": royale("/splash-royale?shot"),
  "drop-zero": royale("/drop-zero?shot"),
  "home-alone": shot("/house-rules?shot", { hold: ["w"] }),
  "agentocracy": walk("/agentocracy?shot"),
  "phangan": walk("/phangan?shot"),
  "beck-road": walk("/beck-road?shot"),
  dipsea: shot("/dipsea?shot", { hold: ["w"] }),
  "dunes": walk("/dunes?shot"),
  "goggles": walk("/goggles?shot"),
};

/**
 * A player walking and looking around: W held, the mouse dragged slowly to one
 * side so the camera pans instead of marching into the first wall.
 */
function walk(route, { warmup = 15000, keys = ["w"], turn = 4 } = {}) {
  return {
    route,
    warmup,
    async setup(t) {
      await t.click();
    },
    async input(t, i) {
      if (i === -DEFAULTS.preroll) await t.hold(...keys);
      if (i >= -DEFAULTS.preroll) await t.look(turn, 0, true);
    },
  };
}

/**
 * Drop Zero and Splash Royale: their ?shot mode is the island from the bus.
 * Skip to the live match, take the pointer (input is gated on it), then run
 * and turn, firing now and then.
 */
function royale(route) {
  return {
    route,
    warmup: 15000,
    async setup(t) {
      await t.page.waitForFunction(() => window.__dzReady === true, null, { timeout: 180000 });
      await t.eval(() => window.__dz.ctx.services.match.skipToLive());
      await t.page.waitForFunction(() => {
        const s = window.__dz.ctx.services;
        return s.match.phase === "live" && s.player.state === "ground";
      }, null, { timeout: 240000 });
      await t.eval(() => {
        const c = document.querySelector("canvas");
        c?.addEventListener("click", () => c.requestPointerLock?.(), { once: true });
      });
      await t.click();
      await t.page.waitForFunction(() => window.__dz.ctx.input.locked === true, null, { timeout: 20000 }).catch(() => {});
    },
    async input(t, i) {
      if (i === -DEFAULTS.preroll) await t.hold("w", "Shift");
      await t.look(5, 0, false);
      if (i > 0 && i % 30 === 0) await t.page.mouse.down();
      if (i > 0 && i % 30 === 12) await t.page.mouse.up();
    },
  };
}

/**
 * The common case: a world with a `?shot` mode (menus hidden, something
 * already happening), optionally with keys held the whole take, as if
 * somebody were driving.
 */
function shot(route, { hold = [], warmup = 12000, click = true } = {}) {
  return {
    route,
    warmup,
    async setup(t) {
      if (click) await t.click();
    },
    async input(t, i) {
      if (i === -DEFAULTS.preroll && hold.length) await t.hold(...hold);
    },
  };
}
