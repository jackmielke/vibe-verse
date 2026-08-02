/**
 * Moving and looking on foot.
 *
 * The same controller runs in the ship's corridor and on a planet, and the
 * mouse means two different things depending on whether anybody is in the seat.
 * Every test below is a claim about one of those seams, and every one of them
 * was false before the change that added it:
 *
 *   - the pilot's head lean stayed welded on once you stood up, so you walked
 *     at an angle to where you were aiming;
 *   - walking asked for 'thrUp' and 'yawL', which are throttle and rudder;
 *   - a planet was crossed at corridor pace, and then at a pace the eye's
 *     terrain follow could not keep up with;
 *   - one stray finger on a touchscreen laptop killed pointer lock for good;
 *   - the stick kept a turn across a sit-down — and then, briefly, a fix for
 *     that killed exterior-view steering, which is why "leaves the ship's stick
 *     alone" below is as load-bearing as the zeroing tests next to it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as THREE from "three-ls";
import { Input, FOOT_ALIAS } from "@/longsilence/core/Input.js";
import { Player } from "@/longsilence/ship/Player.js";

/** The bits of the page Input goes looking for. */
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

/** A corridor wide enough that nothing in these tests touches a wall. */
function stubInterior() {
  return {
    volumes: [[-40, 40, -40, 40]],
    blockers: [],
    stations: [],
  };
}

function key(code: string, down = true) {
  window.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { code }));
}

/** Run the controller for `secs` of 60 Hz frames. */
function run(p: Player, input: Input, secs: number, uiOpen = false) {
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(secs / dt); i++) p.update(dt, input, uiOpen);
}

let canvas: HTMLCanvasElement;
let input: Input;
let player: Player;

beforeEach(() => {
  canvas = mountUI();
  input = new Input(canvas);
  player = new Player(stubInterior());
});
afterEach(() => {
  input.dispose();
  key("KeyW", false); key("KeyS", false); key("KeyA", false);
  key("KeyD", false); key("ShiftLeft", false);
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("the rate stick, and whose hand is on it", () => {
  const seat = () => ({ station: null, eye: { x: 0, y: 1.16, z: -5.28 }, baseYaw: 0 });

  /* Game's order within one frame, which is the whole reason these tests have
     to be written this way: input.update reads the stick at the top of the
     frame, the pointer is fed to it in the middle, and player.update runs at
     the bottom. Anything player.update clears is therefore destroyed before it
     is ever read. */
  const gameFrame = (px: number) => {
    input.feedStick(px, 0);                        // Game.js, the else of the look branch
    player.update(1 / 60, input, false);           // Game.js, "crew position"
    input.update(1 / 60);                          // the next frame's read
  };

  it("is held at zero while you are standing on a planet", () => {
    input.feedStick(600, -600);            // a hard turn, mouse still moving
    expect(input.stick.length()).toBeGreaterThan(0.5);

    player.mode = "ground";
    player.update(1 / 60, input, false);
    expect(input.stick.length()).toBe(0);

    input.update(1 / 60);
    expect(input.state.pitch).toBe(0);
    expect(input.state.yaw).toBe(0);
  });

  it("still lets a seated pilot fly with it", () => {
    player.mode = "seated";
    player.seatedAt = seat();
    player.freeLook = true;                // no auto-centre to the seat's forward
    input.feedStick(600, 0);
    const before = Math.abs(input.stick.x);
    player.update(1 / 60, input, false);
    expect(Math.abs(input.stick.x)).toBeCloseTo(before);
  });

  it("leaves the ship's stick alone while the mouse is still flying it", () => {
    /* Exterior view: V from the cabin, which Game supports on foot and counts
       as `flying`. The player's mode is 'walk' and yet the mouse is the ship's
       only stick — nothing else feeds it. Zeroing on "not seated" deleted
       exterior steering entirely, and silently, because the zero happened
       after the feed and before the read. */
    player.mode = "walk";
    gameFrame(600);
    expect(Math.abs(input.state.yaw)).toBeGreaterThan(0.5);
  });

  it("does not hand a turn back across a sit-down", () => {
    /* The one artefact `autoCenter` really did leave: stand up mid-turn, cross
       the cabin, sit back down. The stick decays at 0.85/s, so a 1.2 s round
       trip returns about a third of the turn to a pilot whose hand has been off
       the mouse the whole time. Cleared during the transition, where the head
       is already on rails and the mouse is doing nothing. */
    player.mode = "moving";
    player._target = "seated";
    player.seatedAt = seat();
    gameFrame(600);
    expect(input.stick.length()).toBe(0);
    expect(input.state.yaw).toBe(0);
  });
});

describe("you walk where you are looking", () => {
  it("does not carry the pilot's head lean out of the seat", () => {
    /* The lean is the head answering the ship's angular velocity. Standing up
       used to freeze it: `yaw` drove the legs, `yaw + headYawOff` drove the
       camera and the rifle, and the two disagreed by up to nine degrees. */
    player.mode = "seated";
    player.seatedAt = { station: null, eye: { x: 0, y: 1.16, z: -5.28 }, baseYaw: 0 };
    player.autoHead = { x: 0, y: 1, z: 0 };     // hard yaw rate
    player.freeLook = true;
    run(player, input, 1.0);
    expect(Math.abs(player.headYawOff)).toBeGreaterThan(0.05);

    player.autoHead = null;
    player.mode = "ground";
    player.yaw = 0.7;
    key("KeyW");
    run(player, input, 0.5);
    key("KeyW", false);

    // Where the camera — and therefore the shot, which Game fires down
    // `player.quat` — is actually pointing.
    const look = new THREE.Vector3(0, 0, -1).applyQuaternion(player.quat);
    // ...against where the legs went.
    const walk = new THREE.Vector3(player.vel.x, 0, player.vel.z);
    expect(walk.length()).toBeGreaterThan(0.5);
    walk.normalize();
    const dot = walk.x * look.x + walk.z * look.z;
    expect(dot).toBeCloseTo(1, 4);
  });

  it("turns the walk basis with the head, both axes", () => {
    /* Direction only. Asserting a raw m/s here would make the test pass or fail
       on GROUND_WALK, which is not what it is about. */
    const dir = () => {
      const d = new THREE.Vector3(player.vel.x, 0, player.vel.z);
      expect(d.length()).toBeGreaterThan(0.5);      // it did move
      return d.normalize();
    };

    player.mode = "ground";
    player.yaw = Math.PI / 2;               // facing -X
    key("KeyW");
    run(player, input, 0.6);
    key("KeyW", false);
    expect(dir().x).toBeCloseTo(-1, 3);

    // Strafing right from yaw 0 is +X.
    player.vel.set(0, 0, 0);
    player.yaw = 0;
    key("KeyD");
    run(player, input, 0.6);
    key("KeyD", false);
    expect(dir().x).toBeCloseTo(1, 3);
  });

  it("keeps the eye with the ground at a sprint", () => {
    /* The eye chases the height field rather than snapping to it, so it always
       trails — the question is by how much *ground*, because what the chase is
       there to reject is a ripple a metre or two across. A fixed rate turns
       into a fixed distance only at a fixed speed, and the planet's sprint is
       nearly four times the deck's walk. The bar is the deck's own run, which
       trails 0.29 m and is the design point the damping was chosen at; the flat
       rate put a planet sprint at 0.72 m, and it is now 0.21 m. */
    const SLOPE = 0.2;
    const p = new Player(stubInterior());
    p.mode = "ground";
    p.yaw = -Math.PI / 2;                   // walk toward +X, up the ramp
    p.groundHeight = (x: number) => x * SLOPE;
    key("ShiftLeft"); key("KeyW");
    run(p, input, 6);                       // well past the settling time
    key("KeyW", false); key("ShiftLeft", false);

    expect(p.vel.x).toBeGreaterThan(4);     // actually sprinting
    const trueH = p.groundHeight(p.pos.x, p.pos.z);
    const lagMetres = (trueH - p.groundY) / SLOPE;
    expect(lagMetres).toBeGreaterThan(0);   // it does trail; this is not a snap
    expect(lagMetres).toBeLessThan(0.4);
  });
});

describe("on-foot action names", () => {
  it("answers to walk names as well as to the ship's", () => {
    key("KeyW");
    expect(input.held("walkF")).toBe(true);
    expect(input.held("thrUp")).toBe(true);      // flight is untouched
    key("KeyW", false);
    expect(input.held("walkF")).toBe(false);

    key("KeyA");
    expect(input.held("walkL")).toBe(true);
    expect(input.held("walkR")).toBe(false);
    key("KeyA", false);

    key("ShiftLeft");
    expect(input.held("sprint")).toBe(true);
    expect(input.held("boost")).toBe(true);
    key("ShiftLeft", false);
  });

  it("resolves a touch button through the same alias", () => {
    input.touchBtn.add("thrUp");
    expect(input.held("walkF")).toBe(true);
    input.touchBtn.delete("thrUp");
  });

  it("keeps every foot name pointing at a real ship action", () => {
    for (const ship of Object.values(FOOT_ALIAS)) {
      expect(typeof ship).toBe("string");
    }
    expect(FOOT_ALIAS.walkF).toBe("thrUp");
    expect(FOOT_ALIAS.walkL).toBe("yawL");
  });
});

describe("speeds", () => {
  const top = (mode: string, sprint: boolean) => {
    const p = new Player(stubInterior());
    p.mode = mode;
    if (sprint) key("ShiftLeft");
    key("KeyW");
    run(p, input, 3);
    key("KeyW", false);
    if (sprint) key("ShiftLeft", false);
    return Math.hypot(p.vel.x, p.vel.z);
  };

  it("crosses a planet faster than it crosses the corridor", () => {
    const deck = top("walk", false);
    const ground = top("ground", false);
    expect(deck).toBeCloseTo(1.75, 1);
    expect(ground).toBeGreaterThan(deck * 1.8);
  });

  it("sprints on shift, in both places", () => {
    expect(top("walk", true)).toBeGreaterThan(top("walk", false) * 1.5);
    expect(top("ground", true)).toBeGreaterThan(top("ground", false) * 1.5);
  });

  it("normalises the diagonal, and survives the touch stick on top of it", () => {
    const p = new Player(stubInterior());
    p.mode = "ground";
    key("KeyW"); key("KeyD");
    input.touch = true;
    input.touchL.set(1, -1);               // thumb hard into the same corner
    run(p, input, 3);
    key("KeyW", false); key("KeyD", false);
    const straight = top("ground", false);
    expect(Math.hypot(p.vel.x, p.vel.z)).toBeLessThanOrEqual(straight + 1e-6);
  });

  it("stands still while a panel is open", () => {
    player.mode = "ground";
    key("KeyW");
    run(player, input, 1, true);
    key("KeyW", false);
    expect(Math.hypot(player.vel.x, player.vel.z)).toBeCloseTo(0, 3);
  });
});

describe("looking", () => {
  it("lets you look at your feet and at the sky, without going over the top", () => {
    player.mode = "ground";
    player.look(0, -100000, 1);
    expect(player.pitch).toBeGreaterThan(1.5);
    expect(player.pitch).toBeLessThan(Math.PI / 2);
    player.look(0, 200000, 1);
    expect(player.pitch).toBeLessThan(-1.5);
    expect(player.pitch).toBeGreaterThan(-Math.PI / 2);
  });

  it("turns quicker on a planet than in the cabin, for the same hand movement", () => {
    const turn = (mode: string) => {
      const p = new Player(stubInterior());
      p.mode = mode;
      p.look(1000, 0, 1);
      return Math.abs(p.yaw);
    };
    expect(turn("ground")).toBeGreaterThan(turn("walk") * 1.2);
  });

  it("is a pure displacement — it stops when the pointer stops", () => {
    player.mode = "ground";
    player.look(400, 0, 1);
    const settled = player.yaw;
    run(player, input, 2);                 // two seconds of nobody touching anything
    expect(player.yaw).toBe(settled);
  });

  it("pins the recoil kick Game fires through the same path", () => {
    /* Game's rifle kicks the muzzle with `player.look(0, -13, 1)` — in pixels,
       because look() is the pointer path — so the on-foot look gain is also the
       recoil angle. Splitting LOOK_GROUND off LOOK_DECK moved it from 1.79° to
       2.53° as a side effect. Pinned here, in degrees, so the next gain change
       has to come and decide what the rifle does instead of moving it by
       accident. If this fails, Game.js's number needs looking at too. */
    player.mode = "ground";
    player.pitch = 0;
    player.look(0, -13, 1);
    expect(THREE.MathUtils.radToDeg(player.pitch)).toBeCloseTo(2.53, 2);
  });
});

describe("pointer lock", () => {
  it("takes the lock on the first click and fires on the next", () => {
    const req = vi.fn();
    canvas.requestPointerLock = req;

    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    expect(req).toHaveBeenCalledTimes(1);
    expect(input.tapped("fire")).toBe(false);   // the capturing click is not a shot
    expect(input.lmb).toBeFalsy();

    input.locked = true;
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    expect(req).toHaveBeenCalledTimes(1);
    expect(input.tapped("fire")).toBe(true);
    expect(input.lmb).toBe(true);
  });

  it("gives the pointer back to a mouse after a stray touch, without taking the touch UI away", () => {
    /* A laptop with a touchscreen is a mouse machine somebody poked once. The
       `touch` latch used to make that permanent: no pointer lock could ever be
       requested again, so the view was dead for the rest of the visit.

       The gate is narrower than the latch, and it has to be. `touch` is read
       far outside this file — Game picks the look branch off it, and the walk
       and the throttle read the on-screen sticks off it — so clearing it from a
       mouse click would take the movement stick off a Surface or an iPad with a
       trackpad, mid-session, on one stray tap of the pad. */
    vi.useFakeTimers();
    const req = vi.fn();
    canvas.requestPointerLock = req;

    const touchStart = () => {
      const t = new Event("touchstart", { bubbles: true });
      Object.defineProperty(t, "changedTouches", {
        value: [{ identifier: 1, clientX: 10, clientY: 10 }],
      });
      canvas.dispatchEvent(t);
    };

    touchStart();
    expect(input.touch).toBe(true);

    // The compatibility click the browser synthesises from that tap is not a
    // mouse and must not ask for the pointer.
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    expect(req).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    expect(req).toHaveBeenCalledTimes(1);   // a real mouse gets the pointer
    expect(input.touch).toBe(true);         // and the thumb keeps its sticks
  });

  it("still walks off the on-screen stick after the mouse has been used", () => {
    // The other half of the above, from the side that would actually break.
    vi.useFakeTimers();
    canvas.requestPointerLock = vi.fn();
    input.touch = true;
    vi.advanceTimersByTime(5000);
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));

    player.mode = "ground";
    input.touchL.set(0, -1);               // thumb pushed forward
    run(player, input, 1);
    expect(Math.hypot(player.vel.x, player.vel.z)).toBeGreaterThan(1);
  });

  it("does not ask for the lock while a panel is open", () => {
    const req = vi.fn();
    canvas.requestPointerLock = req;
    input.uiOpen = true;
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    expect(req).not.toHaveBeenCalled();
  });

  it("handles a refused request instead of rejecting into the console", () => {
    /* Chrome refuses for about a second after the player left the lock with
       Esc, and since 113 it refuses by *rejecting a promise* rather than firing
       an event. Ignoring the return value turns a perfectly normal "Esc, then
       click back in" into a red unhandled rejection. */
    let handled = false;
    const thenable = { catch: (fn: unknown) => { handled = typeof fn === "function"; return thenable; } };
    canvas.requestPointerLock = () => thenable as unknown as Promise<void>;

    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    expect(handled).toBe(true);
    expect(input.locked).toBe(false);      // so the next click simply tries again
  });

  it("lets go of the canvas when the route does", () => {
    /* A disposed Input still holding the canvas's mousedown never sees another
       pointerlockchange, so its `locked` is false forever and every click it
       handles is spent asking for a lock the live Input already has. */
    const req = vi.fn();
    canvas.requestPointerLock = req;
    input.dispose();
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    expect(req).not.toHaveBeenCalled();
  });

  it("stops firing when the window goes away", () => {
    // No mouseup ever arrives for a button released in another window.
    input.locked = true;
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    expect(input.lmb).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(input.lmb).toBe(false);
    expect(input.stick.length()).toBe(0);
  });
});
