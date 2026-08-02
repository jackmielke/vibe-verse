/**
 * The coach card as a thing on a page.
 *
 * `coachStep` decides what to say and is tested on its own; this is the other
 * half — that a card actually appears, that it is built once however many HUDs
 * the route mounts, that it goes away again, and that `?` opens the reference.
 * All four are the sort of thing a pure-function test cannot see and a player
 * notices immediately.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HUD } from "@/longsilence/ui/HUD.js";

/** The ids HUD looks up, straight out of VibeverseExplorer.tsx. */
function mountPage() {
  document.body.innerHTML = `
    <div id="ls-root">
      <div id="hud" class="hidden">
        <div id="reticle"><svg><path id="rArc" d=""/></svg></div>
        <div id="markers"></div>
        <div id="log"></div>
        <div id="prompt" class="hidden"><b id="promptKey">E</b>
          <span id="promptLabel"></span><em id="promptHint"></em></div>
        <div id="narrText"></div>
        <div id="hints"></div>
        <div id="combat"></div>
        <div id="foldOverlay"><div id="foldSub"></div></div>
      </div>
      <div id="perf"></div>
      <div id="touchUI" class="hidden"></div>
    </div>`;
}

/** Only what _updateCoach reaches for. */
function stubGame(over: Record<string, unknown> = {}) {
  const pressed = new Set<string>();
  return {
    input: {
      hasTouch: false, touch: false, locked: true, scheme: "simple",
      state: { pitch: 0, yaw: 0 },
      assist: true, flySens: 1,
      schemeDef: { label: "SIMPLE" },
      settingsRev: 0, settingsMsg: "",
      _pressed: pressed,
      tappedCode(code: string) { return pressed.delete(code); },
    },
    ship: { throttle: 0.5, foldMode: false },
    landed: null, transition: null, battle: null,
    director: { active: false },
    target: null,
    ...over,
  };
}

const CTX = { piloting: true, uiOpen: false, canLand: false, landVerb: "land" };

let hud: HUD;
let game: ReturnType<typeof stubGame>;

beforeEach(() => {
  localStorage.clear();
  mountPage();
  game = stubGame();
  hud = new HUD(game);
});
afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("the coach card on the page", () => {
  const card = () => document.getElementById("lsCoach")!;

  it("exists as soon as the HUD does", () => {
    expect(card()).toBeTruthy();
    expect(document.getElementById("lsKeys")).toBeTruthy();
    // ...and inside #hud, so it fades in with the instruments and #hud.cine
    // hides it during a landing sequence rather than pasting a lesson over one.
    expect(card().parentElement?.id).toBe("hud");
  });

  it("is not built twice when a second HUD takes the same markup", () => {
    // React's StrictMode double mount does exactly this. Two cards is worse
    // than none: they stack, and the dead one never updates again.
    const second = new HUD(stubGame());
    expect(document.querySelectorAll("#lsCoach").length).toBe(1);
    expect(document.querySelectorAll("#lsCoachCss").length).toBe(1);
    expect(second).toBeTruthy();
  });

  it("shows the line the step asked for", () => {
    game.input.locked = false;
    hud._updateCoach(0.016, CTX);
    expect(card().classList.contains("on")).toBe(true);
    expect(card().querySelector("b")!.textContent).toMatch(/CLICK TO STEER/);
  });

  it("holds a lesson for nine seconds and then stops nagging", () => {
    game.ship.throttle = 0;                       // -> the throttle lesson
    hud._updateCoach(0.016, CTX);
    expect(card().classList.contains("on")).toBe(true);
    for (let i = 0; i < 10; i++) hud._updateCoach(1, CTX);
    expect(card().classList.contains("on")).toBe(false);
  });

  it("keeps the dead-pointer notice up for as long as the pointer is dead", () => {
    // Sticky, because it is a state and not a lesson: the player may take a
    // minute to look up, and the mouse is doing nothing the whole time.
    game.input.locked = false;
    for (let i = 0; i < 40; i++) hud._updateCoach(1, CTX);
    expect(card().classList.contains("on")).toBe(true);
    game.input.locked = true;
    hud._updateCoach(0.016, CTX);
    expect(card().querySelector("b")!.textContent).not.toMatch(/CLICK/);
  });

  it("says nothing at all on the ground", () => {
    game.input.locked = false;
    hud._updateCoach(0.016, CTX);
    expect(card().classList.contains("on")).toBe(true);
    game.landed = { onFoot: true };
    hud._updateCoach(0.016, CTX);
    expect(card().classList.contains("on")).toBe(false);
  });

  it("retires itself once the player has folded, and remembers", () => {
    game.ship.throttle = 0;
    hud._updateCoach(0.016, CTX);
    expect(card().classList.contains("on")).toBe(true);

    game.ship.foldMode = true;
    hud._updateCoach(0.016, CTX);
    game.ship.foldMode = false;
    hud._updateCoach(0.016, CTX);
    expect(card().classList.contains("on")).toBe(false);

    // ...and a HUD built fresh next visit does not start the lesson over
    const next = new HUD(stubGame({ ship: { throttle: 0, foldMode: false } }));
    next._updateCoach(0.016, CTX);
    expect(card().classList.contains("on")).toBe(false);
  });

  it("opens and closes the reference on ?", () => {
    const keys = document.getElementById("lsKeys")!;
    game.input._pressed.add("Slash");
    hud._updateCoach(0.016, CTX);
    expect(keys.classList.contains("on")).toBe(true);
    expect(keys.textContent).toMatch(/layout — now SIMPLE/);
    game.input._pressed.add("Slash");
    hud._updateCoach(0.016, CTX);
    expect(keys.classList.contains("on")).toBe(false);
  });

  it("leaves the reference alone while a panel owns the screen", () => {
    game.input._pressed.add("Slash");
    hud._updateCoach(0.016, { ...CTX, uiOpen: true });
    expect(document.getElementById("lsKeys")!.classList.contains("on")).toBe(false);
  });

  it("logs a settings change where the player is already looking", () => {
    game.input.settingsRev = 1;
    game.input.settingsMsg = "CONTROLS · SIM · 6DOF";
    hud._updateCoach(0.016, CTX);
    expect(document.getElementById("log")!.textContent).toMatch(/SIM · 6DOF/);
  });
});
