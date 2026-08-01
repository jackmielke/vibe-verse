/**
 * Swipe to look.
 *
 * The right stick used to be the camera and a stick is a *rate* — hold it over
 * and the view keeps going. A swipe is a displacement: move your thumb an inch,
 * the world turns an inch. Everything below is about the two ways that can go
 * wrong on a real phone, neither of which shows up on a desktop:
 *
 *   - the left thumb. A touch that starts on the movement stick must never also
 *     turn the camera, and a touch that starts on open sky must keep turning it
 *     even when it wanders over the stick.
 *   - the second mount. React can hand the same canvas to a second Game, and
 *     two live handlers on one canvas is a camera that turns twice as far as
 *     your thumb — which reads as a broken game, not as a leak.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Input } from "@/longsilence/core/Input.js";

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

/** jsdom has no TouchEvent constructor worth using; the handlers only read
 *  `changedTouches`, `identifier`, `clientX/Y` and `cancelable`. */
function touch(
  el: Element,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  points: { id: number; x: number; y: number }[],
) {
  const e = new Event(type, { bubbles: true, cancelable: type === "touchmove" });
  Object.defineProperty(e, "changedTouches", {
    value: points.map((p) => ({ identifier: p.id, clientX: p.x, clientY: p.y })),
  });
  el.dispatchEvent(e);
  return e;
}

let canvas: HTMLCanvasElement;
let input: Input;

beforeEach(() => {
  canvas = mountUI();
  input = new Input(canvas);
});
afterEach(() => {
  input.dispose();
  document.body.innerHTML = "";
});

describe("swipe to look", () => {
  it("turns a drag on the canvas into a look delta", () => {
    touch(canvas, "touchstart", [{ id: 1, x: 200, y: 300 }]);
    touch(canvas, "touchmove", [{ id: 1, x: 260, y: 320 }]);
    const d = input.consumeMouse();
    // 60 px right and 20 px down, times the touch sensitivity.
    expect(d.x).toBeCloseTo(60 * input.touchLookSens);
    expect(d.y).toBeCloseTo(20 * input.touchLookSens);
  });

  it("accumulates across a whole swipe and reports it once", () => {
    touch(canvas, "touchstart", [{ id: 1, x: 0, y: 0 }]);
    for (let i = 1; i <= 10; i++) touch(canvas, "touchmove", [{ id: 1, x: i * 5, y: 0 }]);
    const d = input.consumeMouse();
    expect(d.x).toBeCloseTo(50 * input.touchLookSens);
    // and the meter is reset by reading it
    expect(input.consumeMouse().x).toBe(0);
  });

  it("marks the session as touch, so the ship stops steering with the swipe", () => {
    expect(input.touch).toBe(false);
    touch(canvas, "touchstart", [{ id: 1, x: 10, y: 10 }]);
    expect(input.touch).toBe(true);
  });

  it("ignores a thumb on the movement stick", () => {
    /* The single most important line in this file. Touch events stay with the
       element they started on, so a touch beginning on #stickL never reaches
       the canvas — walking forward must not also spin the camera. */
    const stick = document.getElementById("stickL")!;
    touch(stick, "touchstart", [{ id: 1, x: 60, y: 700 }]);
    touch(stick, "touchmove", [{ id: 1, x: 120, y: 640 }]);
    expect(input.consumeMouse()).toEqual({ x: 0, y: 0 });
    // ...and the stick itself moved, which is the whole point of it.
    expect(input.touchL.x).not.toBe(0);
  });

  it("keeps following a swipe that wanders over the stick", () => {
    touch(canvas, "touchstart", [{ id: 1, x: 700, y: 400 }]);
    touch(canvas, "touchmove", [{ id: 1, x: 300, y: 600 }]);   // over the stick's corner
    expect(input.consumeMouse().x).toBeCloseTo(-400 * input.touchLookSens);
  });

  it("follows one finger, not whichever moved last", () => {
    touch(canvas, "touchstart", [{ id: 1, x: 100, y: 100 }]);
    touch(canvas, "touchstart", [{ id: 2, x: 900, y: 100 }]);   // a second thumb
    touch(canvas, "touchmove", [{ id: 2, x: 500, y: 100 }]);    // ...moving a long way
    expect(input.consumeMouse().x).toBe(0);
    touch(canvas, "touchmove", [{ id: 1, x: 130, y: 100 }]);
    expect(input.consumeMouse().x).toBeCloseTo(30 * input.touchLookSens);
  });

  it("lets go, and picks up the next swipe from where it starts", () => {
    touch(canvas, "touchstart", [{ id: 1, x: 100, y: 100 }]);
    touch(canvas, "touchmove", [{ id: 1, x: 150, y: 100 }]);
    touch(canvas, "touchend", [{ id: 1, x: 150, y: 100 }]);
    input.consumeMouse();
    // A new swipe starting somewhere else must not jump by the gap between them.
    touch(canvas, "touchstart", [{ id: 2, x: 900, y: 100 }]);
    touch(canvas, "touchmove", [{ id: 2, x: 910, y: 100 }]);
    expect(input.consumeMouse().x).toBeCloseTo(10 * input.touchLookSens);
  });

  it("does nothing at all while a panel is open", () => {
    input.uiOpen = true;
    touch(canvas, "touchstart", [{ id: 1, x: 100, y: 100 }]);
    touch(canvas, "touchmove", [{ id: 1, x: 400, y: 100 }]);
    expect(input.consumeMouse()).toEqual({ x: 0, y: 0 });
  });

  it("respects inverted Y", () => {
    input.invertY = true;
    touch(canvas, "touchstart", [{ id: 1, x: 0, y: 0 }]);
    touch(canvas, "touchmove", [{ id: 1, x: 0, y: 50 }]);
    expect(input.consumeMouse().y).toBeCloseTo(-50 * input.touchLookSens);
  });

  it("cancels cleanly when the browser takes the touch away", () => {
    touch(canvas, "touchstart", [{ id: 1, x: 0, y: 0 }]);
    touch(canvas, "touchcancel", [{ id: 1, x: 0, y: 0 }]);
    touch(canvas, "touchmove", [{ id: 1, x: 400, y: 0 }]);
    expect(input.consumeMouse()).toEqual({ x: 0, y: 0 });
  });

  it("claims the move so the page cannot scroll under the ship", () => {
    touch(canvas, "touchstart", [{ id: 1, x: 0, y: 0 }]);
    const e = touch(canvas, "touchmove", [{ id: 1, x: 0, y: 90 }]);
    expect(e.defaultPrevented).toBe(true);
  });

  it("does not swallow the touch that starts the gesture", () => {
    /* touchstart is how the pointer-lock click and the cabin's own taps
       arrive. Only the move belongs to the camera. */
    const e = touch(canvas, "touchstart", [{ id: 1, x: 0, y: 0 }]);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("letting go of the canvas", () => {
  it("stops listening once the route is torn down", () => {
    /* These are the only listeners this class puts on the canvas rather than on
       window, and the file's standing assumption is that canvas listeners die
       with the canvas. React breaks that: a StrictMode double mount hands the
       same node to a second Game, and a disposed Input still bound to it goes
       on calling preventDefault on every touchmove — a dead route quietly
       eating the live one's gestures.

       Note this is *not* a doubling bug. Two Inputs keep separate delta
       counters, so a leaked handler does not make the camera turn twice as far;
       it makes a corpse swallow scrolling. Worth being precise about, because
       the obvious test — spin up a second Input and check the delta — passes
       whether or not dispose() does its job. */
    input.dispose();
    touch(canvas, "touchstart", [{ id: 1, x: 0, y: 0 }]);
    const e = touch(canvas, "touchmove", [{ id: 1, x: 100, y: 40 }]);
    expect(input.consumeMouse()).toEqual({ x: 0, y: 0 });
    expect(e.defaultPrevented).toBe(false);
  });

  it("leaves a freshly mounted Input in sole charge", () => {
    const second = new Input(canvas);
    input.dispose();
    touch(canvas, "touchstart", [{ id: 1, x: 0, y: 0 }]);
    touch(canvas, "touchmove", [{ id: 1, x: 100, y: 0 }]);
    expect(second.consumeMouse().x).toBeCloseTo(100 * second.touchLookSens);
    second.dispose();
  });
});
