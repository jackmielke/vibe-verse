/**
 * Flying it on a laptop.
 *
 * The report was "it's not intuitive at all… we need more basic controls".
 * What was actually there: throttle on W/S, yaw on A/D and *pitch on the arrow
 * keys* — two hands at opposite ends of the keyboard — with the pointer as a
 * rate stick that kept turning after you let go, and no deadzone at all, which
 * on a trackpad is a ship that yaws forever.
 *
 * So the tests below are mostly about what the default layout does NOT do:
 * A and D do not yaw, nothing you need is on the arrows, a resting finger does
 * not steer, and switching to the sim layout puts every one of those back.
 *
 * Each one was checked against the old behaviour by reverting the change in a
 * scratch tree; the assertions that would have passed either way are called
 * out where they survive at all.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import * as THREE from "three-ls";
import { Input, SCHEMES, DEFAULT_SCHEME, PREFS_KEY, FOOT_ALIAS } from "@/longsilence/core/Input.js";
import { Ship } from "@/longsilence/ship/Ship.js";

function mountUI() {
  document.body.innerHTML = `
    <div id="ls-root">
      <canvas id="scene"></canvas>
      <div id="touchUI">
        <div id="stickL" class="stick"><i></i></div>
        <div id="stickR" class="stick"><i></i></div>
        <div id="touchBtns"><button class="tb" data-act="use">USE</button></div>
        <div id="touchThr"><button class="tt" data-act="thrUp">+</button></div>
      </div>
    </div>`;
  return document.getElementById("scene") as HTMLCanvasElement;
}

const key = (code: string, down = true) =>
  window.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { code }));

let canvas: HTMLCanvasElement;
let input: Input;

beforeEach(() => {
  localStorage.clear();
  canvas = mountUI();
  input = new Input(canvas);
});
afterEach(() => {
  input.dispose();
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("the default layout", () => {
  it("is the simple one", () => {
    expect(DEFAULT_SCHEME).toBe("simple");
    expect(input.scheme).toBe("simple");
  });

  it("slides sideways on A and D instead of yawing", () => {
    key("KeyD");
    input.update(1 / 60);
    expect(input.state.strafeX).toBe(1);
    expect(input.state.yaw).toBeCloseTo(0, 6);
    key("KeyD", false);
    key("KeyA");
    input.update(1 / 60);
    expect(input.state.strafeX).toBe(-1);
    expect(input.state.yaw).toBeCloseTo(0, 6);
    key("KeyA", false);
  });

  it("keeps throttle on W and S", () => {
    key("KeyW");
    input.update(1 / 60);
    expect(input.state.throttleDelta).toBeGreaterThan(0);
    key("KeyW", false);
    key("KeyS");
    input.update(1 / 60);
    expect(input.state.throttleDelta).toBeLessThan(0);
    key("KeyS", false);
  });

  it("puts nothing on the arrow keys that is not also on the pointer", () => {
    /* The arrows still steer — a laptop with a dead trackpad has to be able to
       turn — but pitch and yaw are both on the pointer as well, so no arrow key
       is the only way to do anything. */
    key("ArrowUp");
    input.update(1 / 60);
    const byKey = input.state.pitch;
    key("ArrowUp", false);
    input.update(1 / 60);

    input.feedStick(0, -400);
    input.update(1 / 60);
    expect(byKey).toBeGreaterThan(0);
    expect(input.state.pitch).toBeGreaterThan(0);
  });

  it("yaws on the arrows even though A and D no longer do", () => {
    // ArrowLeft used to be the *same action* as A. It cannot be any more, or
    // strafing and turning could never be different keys.
    key("ArrowLeft");
    input.update(1 / 60);
    expect(input.state.yaw).toBeGreaterThan(0);
    expect(input.state.strafeX).toBe(0);
    key("ArrowLeft", false);
  });
});

describe("the sim layout, kept whole", () => {
  beforeEach(() => input.setScheme("sim"));

  it("yaws on A and D and strafes on neither", () => {
    key("KeyA");
    input.update(1 / 60);
    expect(input.state.yaw).toBeGreaterThan(0);
    expect(input.state.strafeX).toBe(0);
    key("KeyA", false);
  });

  it("still pitches on the arrows and rolls on Q and E", () => {
    key("ArrowDown");
    key("KeyE");
    input.update(1 / 60);
    expect(input.state.pitch).toBeLessThan(0);
    expect(input.state.roll).toBeLessThan(0);
    key("ArrowDown", false);
    key("KeyE", false);
  });

  it("restores the original stick feel exactly", () => {
    expect(input.sensitivity).toBe(0.0022);
    expect(input.autoCenter).toBe(0.85);
    expect(input.deadzone).toBe(0);
  });

  it("rolls on Q and E under the simple layout too", () => {
    input.setScheme("simple");
    key("KeyQ");
    input.update(1 / 60);
    expect(input.state.roll).toBeGreaterThan(0);
    key("KeyQ", false);
  });
});

describe("walking, which shares the same four keys", () => {
  it("still resolves the foot names under either layout", () => {
    /* A and D changed meaning for the flight model and must not have changed
       meaning for the crew controller — Player walks on `held('walkL')`, which
       resolves through FOOT_ALIAS to the *ship* action A is bound to. Break
       this and the simple layout is a game you cannot walk around in. */
    expect(FOOT_ALIAS.walkL).toBe("yawL");
    for (const scheme of ["simple", "sim"]) {
      input.setScheme(scheme);
      key("KeyA");
      expect(input.held("walkL")).toBe(true);
      key("KeyA", false);
      key("KeyW");
      expect(input.held("walkF")).toBe(true);
      key("KeyW", false);
    }
  });
});

describe("the trackpad", () => {
  it("ignores a resting finger", () => {
    /* Two pixels a second is what a trackpad emits with a finger on it and no
       intent behind it. Under the old zero-deadzone stick that was a permanent
       slow yaw with nothing on screen to explain it. */
    input.feedStick(2, 0);
    input.update(1 / 60);
    expect(input.state.yaw).toBeCloseTo(0, 6);
    expect(input.stick.x).toBeGreaterThan(0);   // ...and the stick did move
  });

  it("still reaches full deflection at the top of the throw", () => {
    // Rescaling, not subtracting: a plain deadzone would cap the rate at
    // 1 - deadzone, so the ship would never turn at its full rate again.
    input.feedStick(100000, 0);
    expect(input.stickAxes({ x: 0, y: 0 }).x).toBeCloseTo(1, 6);
    // and just past the edge of the deadzone it is still near zero, not a jump
    input.stick.set(input.deadzone + 0.01, 0);
    expect(input.stickAxes({ x: 0, y: 0 }).x).toBeLessThan(0.02);
  });

  it("gets further per pixel than the sim layout does", () => {
    input.feedStick(200, 0);
    const simple = input.stick.x;
    input.setScheme("sim");
    input.feedStick(200, 0);
    expect(input.stick.x).toBeLessThan(simple);
  });

  it("springs back quickly enough that letting go stops the turn", () => {
    input.feedStick(200, 0);
    const before = input.stick.x;
    for (let i = 0; i < 30; i++) input.update(1 / 60);   // half a second
    expect(Math.abs(input.stick.x)).toBeLessThan(before * 0.35);
  });
});

describe("the settings a player can reach", () => {
  it("cycles the layout on O and says so", () => {
    const rev = input.settingsRev;
    key("KeyO");
    input.update(1 / 60);
    expect(input.scheme).toBe("sim");
    expect(input.settingsRev).toBeGreaterThan(rev);
    expect(input.settingsMsg).toContain(SCHEMES.sim.label);
    key("KeyO", false);
    key("KeyO");
    input.update(1 / 60);
    expect(input.scheme).toBe("simple");
    key("KeyO", false);
  });

  it("moves steering sensitivity on the brackets", () => {
    const base = input.flySens;
    key("BracketRight");
    input.update(1 / 60);
    expect(input.flySens).toBeGreaterThan(base);
    key("BracketRight", false);
    key("BracketLeft");
    input.update(1 / 60);
    expect(input.flySens).toBeCloseTo(base, 5);
    key("BracketLeft", false);
  });

  it("scales the stick by that sensitivity", () => {
    input.setFlySens(2);
    input.feedStick(100, 0);
    const fast = input.stick.x;
    input.stick.set(0, 0);
    input.setFlySens(1);
    input.feedStick(100, 0);
    expect(fast).toBeCloseTo(input.stick.x * 2, 6);
  });

  it("clamps sensitivity to something still flyable", () => {
    input.setFlySens(99);
    expect(input.flySens).toBe(3);
    input.setFlySens(0);
    expect(input.flySens).toBe(0.35);
  });

  it("toggles flight assist on Z and carries it to the flight model", () => {
    expect(input.assist).toBe(true);
    key("KeyZ");
    input.update(1 / 60);
    expect(input.assist).toBe(false);
    expect(input.state.assist).toBe(false);
    key("KeyZ", false);
  });

  it("leaves the settings keys alone while a panel owns the screen", () => {
    input.uiOpen = true;
    key("KeyO");
    input.update(1 / 60);
    expect(input.scheme).toBe("simple");
    key("KeyO", false);
  });

  it("remembers all of it for the next visit", () => {
    input.setScheme("sim");
    input.setFlySens(1.5);
    input.setAssist(false);
    expect(localStorage.getItem(PREFS_KEY)).toBeTruthy();

    const second = new Input(canvas);
    expect(second.scheme).toBe("sim");
    expect(second.flySens).toBeCloseTo(1.5, 6);
    expect(second.assist).toBe(false);
    // ...and restoring is not a change the player just made, so it stays quiet.
    expect(second.settingsRev).toBe(0);
    second.dispose();
  });

  it("survives a corrupt or hostile stored preference", () => {
    localStorage.setItem(PREFS_KEY, '{"scheme":"barrel-roll","flySens":"lots"}');
    const second = new Input(canvas);
    expect(second.scheme).toBe(DEFAULT_SCHEME);
    expect(second.flySens).toBe(1);
    second.dispose();
  });

  it("drops the stick when the layout changes under it", () => {
    // A half-deflected stick means a different rate under a different deadzone
    // and a different gain — carrying it across is a ship that turns by itself.
    input.feedStick(200, 120);
    input.setScheme("sim");
    expect(input.stick.length()).toBe(0);
  });
});

describe("the throttle", () => {
  it("steps the same distance per wheel notch at any frame rate", () => {
    /* Game integrates throttleDelta as a rate — `throttle += delta * dt * 0.9`
       — so a flat per-notch number moved the throttle by however long the frame
       happened to be: six times as far on a 60 Hz frame as on a 360 Hz one. */
    const notch = (dt: number) => {
      canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      input.update(dt);
      return input.state.throttleDelta * dt * 0.9;
    };
    const slow = notch(1 / 60);
    const fast = notch(1 / 240);
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeCloseTo(slow, 6);
  });

  it("reaches full throttle quicker under the simple layout", () => {
    key("KeyW");
    input.update(1 / 60);
    const simple = input.state.throttleDelta;
    input.setScheme("sim");
    input.update(1 / 60);
    expect(input.state.throttleDelta).toBeLessThan(simple);
    key("KeyW", false);
  });
});

describe("the other two ways in", () => {
  it("still steers off the touch stick", () => {
    input.touch = true;
    input.touchL.set(0.5, -0.5);
    input.update(1 / 60);
    expect(input.state.yaw).toBeCloseTo(-0.5, 5);
    expect(input.state.pitch).toBeCloseTo(0.5, 5);
  });

  it("still steers off a gamepad", () => {
    const pad = { axes: [0.6, -0.4, 0.3, -0.5], buttons: [] as unknown[] };
    const real = navigator.getGamepads;
    (navigator as unknown as { getGamepads: () => unknown[] }).getGamepads = () => [pad];
    try {
      input.update(1 / 60);
      expect(input.state.yaw).toBeLessThan(0);
      expect(input.state.pitch).toBeGreaterThan(0);
      expect(input.state.roll).toBeGreaterThan(0);
      expect(input.state.throttleDelta).toBeGreaterThan(0);
    } finally {
      (navigator as unknown as { getGamepads: typeof real }).getGamepads = real;
    }
  });
});

/* ------------------------------------------------------------------ assist */

const ZERO = { pitch: 0, yaw: 0, roll: 0, strafeX: 0, strafeY: 0 };
const env = { time: 0, foldCeiling: 1000 };

/** Fly `secs` of it, a sixtieth at a time. */
function fly(ship: Ship, inp: Record<string, unknown>, secs: number) {
  for (let i = 0; i < Math.round(secs * 60); i++) ship.update(1 / 60, inp, env);
}

describe("flight assist", () => {
  /* One hull for the whole block. `new Ship()` builds the greebled model and
     costs the better part of two seconds under jsdom — eight of them ran the
     file past vitest's per-test deadline whenever the suite was busy, which
     showed up as a test that failed only in a full run. Nothing here needs a
     fresh hull; it needs a fresh *attitude*, which is four fields. */
  let ship: Ship;
  beforeAll(() => { ship = new Ship(); });
  beforeEach(() => {
    ship.quat.identity();
    ship.angVel.set(0, 0, 0);
    ship.vel.set(0, 0, 0);
    ship.absPos.set(0, 0, 0);
    ship.foldMode = false;
    ship.assist = true;
    ship.throttle = 0;
  });

  it("rolls a banked ship back level on its own", () => {
    ship.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7);
    expect(Math.abs(ship._bankError())).toBeCloseTo(0.7, 3);
    fly(ship, { ...ZERO, assist: true }, 6);
    expect(Math.abs(ship._bankError())).toBeLessThan(0.05);
  });

  it("leaves the ship where the pilot put it when the assist is off", () => {
    ship.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7);
    fly(ship, { ...ZERO, assist: false }, 6);
    expect(Math.abs(ship._bankError())).toBeCloseTo(0.7, 2);
  });

  it("does not argue with a pilot who is rolling", () => {
    /* Held half over, the ship must keep rolling — an assist without the input
       threshold on it instead finds an equilibrium where its own correction
       cancels the pilot's stick, and the roll simply stops part way round with
       nothing to say why. The rate at the end is what separates the two. */
    fly(ship, { ...ZERO, assist: true, roll: 0.5 }, 4);
    expect(Math.abs(ship.angVel.z)).toBeGreaterThan(0.2);
  });

  it("lets go when there is no horizon to hold", () => {
    // Nose within three degrees of straight up, and banked. `forward × up` is
    // nearly zero there and the angle it yields is noise, so the assist has to
    // stop rather than chase it.
    ship.quat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2 - 0.05);
    ship.quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7));
    expect(ship._bankError()).toBe(0);
    fly(ship, { ...ZERO, assist: true }, 2);
    expect(Math.abs(ship.angVel.z)).toBeLessThan(1e-3);
  });

  it("stops the ship tumbling sooner than the bare model does", () => {
    const spin = (assist: boolean) => {
      ship.quat.identity();
      ship.angVel.set(0, 0, 0);
      fly(ship, { ...ZERO, assist, yaw: 1 }, 2);
      fly(ship, { ...ZERO, assist }, 0.5);
      return Math.abs(ship.angVel.y);
    };
    expect(spin(true)).toBeLessThan(spin(false) * 0.6);
  });

  it("does not cost the ship any of its turn rate to do it", () => {
    /* The steady rate is input × turnAccel ÷ damp. Damping the tumble out
       without raising authority to match takes a third off how fast the ship
       can turn at all — which trades one bad feel for another, and is the
       version of this that was written first. */
    const rate = (assist: boolean) => {
      ship.quat.identity();
      ship.angVel.set(0, 0, 0);
      fly(ship, { ...ZERO, assist, yaw: 1 }, 4);
      return Math.abs(ship.angVel.y);
    };
    expect(rate(true)).toBeCloseTo(rate(false), 2);
  });

  it("takes the switch from the input and not from the autopilot", () => {
    /* Game hands Ship.update either the player's own state object or a fresh
       one synthesised by the autopilot, and the synthesised one has no opinion
       on flight assist. Reading it blindly would switch the assist off every
       frame the autopilot steered, and back on the frame it stopped. */
    ship.update(1 / 60, { ...ZERO, assist: false }, env);
    expect(ship.assist).toBe(false);
    ship.update(1 / 60, { ...ZERO }, env);
    expect(ship.assist).toBe(false);
  });

  it("keeps its hands off during a fold", () => {
    ship.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7);
    ship.foldMode = true;
    fly(ship, { ...ZERO, assist: true }, 3);
    // Not "mostly still banked" — untouched. Three seconds of a fold with the
    // assist left running takes a third of the bank out of it.
    expect(Math.abs(ship._bankError())).toBeCloseTo(0.7, 2);
  });
});
