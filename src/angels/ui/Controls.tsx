/**
 * The card that tells you how to fly it.
 *
 * This is not documentation, it is part of the game. The first version shipped
 * with the key bindings buried in an options panel on the hangar screen, which
 * meant that pressing FLY dropped you into a jet over Lake Washington with no
 * idea which key did anything. You can work out a first-person shooter by
 * pressing W. You cannot work out an aeroplane.
 *
 * So it opens by itself the first time, stays until you dismiss it, and is one
 * key or one button away for ever after. It also shows the bindings for the
 * scheme you are *actually* using rather than listing both, because a control
 * card that lists controls you do not have is worse than none.
 */
import type { ControlScheme } from "../engine/input";
import type { SpawnPoint } from "../play/fleet";

export const HELP_SEEN_KEY = "angels.helpSeen";

interface Binding {
  keys: string;
  what: string;
  /** The two or three that matter before anything else. */
  primary?: boolean;
}

export function bindingsFor(scheme: ControlScheme, touch: boolean): Binding[] {
  if (touch) {
    return [
      { keys: "Left thumb", what: "Fly — drag anywhere on the left half", primary: true },
      { keys: "Right thumb", what: "Throttle — the orange strip", primary: true },
      { keys: "LEVEL", what: "Lost? This rolls you upright and finds the horizon" },
      { keys: "BRK", what: "Airbrake, and the wheel brakes on the ground" },
      { keys: "SMOKE", what: "Smoke on and off" },
      { keys: "VIEW", what: "Change camera" },
      { keys: "GEAR", what: "Landing gear" },
      { keys: "◀ ▶", what: "Rudder" },
    ];
  }
  if (scheme === "easy") {
    return [
      { keys: "← →", what: "Turn left and right. The jet banks and pulls for you.", primary: true },
      { keys: "↑ ↓", what: "Climb and dive", primary: true },
      { keys: "Space", what: "Lost? Rolls you upright and finds the horizon", primary: true },
      { keys: "W A S D", what: "The same four, if you would rather" },
      { keys: "Shift  Z", what: "Faster and slower. The throttle is automatic otherwise." },
      { keys: "Q  E", what: "Rudder" },
      { keys: "B", what: "Brakes: airbrake in the air, wheels on the ground" },
      { keys: "G", what: "Landing gear" },
      { keys: "X", what: "Smoke" },
      { keys: "C", what: "Change camera" },
      { keys: "R", what: "Put me back at the start" },
      { keys: "Right-drag", what: "Look around" },
      { keys: "H", what: "Show this card" },
      { keys: "Esc", what: "Menu" },
    ];
  }
  if (scheme === "pursuit") {
    return [
      { keys: "Move mouse", what: "Put the ring where you want to go. The jet flies to it.", primary: true },
      { keys: "W  S", what: "Throttle up and down", primary: true },
      { keys: "Space", what: "Lost? Rolls you upright and finds the horizon", primary: true },
      { keys: "A  D", what: "Roll by hand — this is how you do a barrel roll" },
      { keys: "Q  E", what: "Rudder" },
      { keys: "B", what: "Brakes: airbrake in the air, wheels on the ground" },
      { keys: "1 – 0", what: "Throttle gate: 1 idle, 0 full burner" },
      { keys: "G", what: "Landing gear" },
      { keys: "X", what: "Smoke" },
      { keys: "C", what: "Change camera" },
      { keys: "R", what: "Put me back at the start" },
      { keys: "Right-drag", what: "Look around" },
      { keys: "H", what: "Show this card" },
      { keys: "Esc", what: "Menu" },
    ];
  }
  if (scheme === "stick") {
    return [
      { keys: "Move mouse", what: "Fly. The cursor is the stick; the middle of the screen is neutral.", primary: true },
      { keys: "W  S", what: "Throttle up and down", primary: true },
      { keys: "Space", what: "Lost? Rolls you upright and finds the horizon", primary: true },
      { keys: "Q  E", what: "Rudder" },
      { keys: "A  D", what: "Fine roll trim, for formation work" },
      { keys: "B", what: "Brakes: airbrake in the air, wheels on the ground" },
      { keys: "1 – 0", what: "Throttle gate: 1 idle, 0 full burner" },
      { keys: "G", what: "Landing gear" },
      { keys: "X", what: "Smoke" },
      { keys: "C", what: "Change camera" },
      { keys: "R", what: "Put me back at the start" },
      { keys: "Right-drag", what: "Look around" },
      { keys: "H", what: "Show this card" },
      { keys: "Esc", what: "Menu" },
    ];
  }
  return [
    { keys: "W  S", what: "Climb and dive", primary: true },
    { keys: "A  D", what: "Roll left and right", primary: true },
    { keys: "Space", what: "Lost? Rolls you upright and finds the horizon", primary: true },
    { keys: "Shift  Z", what: "Throttle up and down" },
    { keys: "Q  E", what: "Rudder" },
    { keys: "B", what: "Brakes: airbrake in the air, wheels on the ground" },
    { keys: "1 – 0", what: "Throttle gate: 1 idle, 0 full burner" },
    { keys: "G", what: "Landing gear" },
    { keys: "X", what: "Smoke" },
    { keys: "C", what: "Change camera" },
    { keys: "R", what: "Put me back at the start" },
    { keys: "Right-drag", what: "Look around" },
    { keys: "H", what: "Show this card" },
    { keys: "Esc", what: "Menu" },
  ];
}

/**
 * The one sentence that answers the question everybody actually asks.
 *
 * "It is very unclear how we are supposed to pull up" is not a request for a
 * longer key list — it is a sign that the key list was the wrong answer. Every
 * scheme gets a plain-English statement of how to climb, in bigger type than
 * anything else on this card, because that is the thing a first-time pilot
 * needs and everything else can wait until they are in the air.
 */
const HOW_TO_CLIMB: Record<ControlScheme | "touch", string> = {
  easy: "To pull up: hold the up arrow. Left and right turn. Let go and it flies level.",
  pursuit: "To pull up: move the ring above the horizon. That is the whole control.",
  stick: "To pull up: move the mouse toward the top of the screen.",
  keyboard: "To pull up: hold W.",
  touch: "To pull up: slide your left thumb up the screen.",
};

const SCHEMES: Array<{ id: ControlScheme; name: string; blurb: string }> = [
  { id: "easy", name: "Arrow keys", blurb: "Left turns left. Auto-levels." },
  {
    id: "pursuit",
    name: "Point & fly",
    blurb: "Aim the ring, the jet goes there",
  },
  { id: "stick", name: "Direct stick", blurb: "The cursor is the stick" },
  { id: "keyboard", name: "Keyboard", blurb: "W A S D only" },
];

/** One line of advice that is worth more than the whole key list. */
const TIPS: Record<SpawnPoint, string> = {
  needle:
    "The Space Needle is dead ahead, thirteen seconds away. Go over the top of it, " +
    "then put the nose down into downtown — and try not to hit anything, because " +
    "the landmarks here are solid.",
  show:
    "You are already flying, southbound down the show line at 1,500 feet. " +
    "Ease the nose over and see how low you dare take it past the boats.",
  runway:
    "You are stopped on Boeing Field. Throttle to full, hold it straight with the rudder, " +
    "and pull back once the speed tape passes 130. Gear up with G.",
  high:
    "Fourteen thousand feet over the Sound. Point the nose down, let it run, " +
    "and see what the Space Needle looks like from a hundred feet.",
};

interface Props {
  scheme: ControlScheme;
  touch: boolean;
  start: SpawnPoint;
  onScheme(next: ControlScheme): void;
  onClose(): void;
}

export default function ControlsCard({ scheme, touch, start, onScheme, onClose }: Props) {
  const bindings = bindingsFor(scheme, touch);
  const primary = bindings.filter((b) => b.primary);
  const rest = bindings.filter((b) => !b.primary);

  return (
    <div
      data-angels-hud="help"
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto p-4"
      style={{ background: "rgba(2,6,15,0.62)", backdropFilter: "blur(3px)" }}
      onClick={onClose}
    >
      <div
        // `my-auto` rather than centring the flex item, so that on a short
        // laptop window the card scrolls instead of having its top and its
        // "Got it" button both clipped off the screen at once.
        className="my-auto w-full max-w-md overflow-hidden rounded-2xl border border-white/12"
        style={{ background: "rgba(5,12,26,0.97)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-4">
          <p className="font-mono text-[9.5px] uppercase tracking-[0.4em] text-sky-300/50">
            How to fly it
          </p>

          <p className="mt-2 text-[15px] font-bold leading-snug text-amber-200">
            {HOW_TO_CLIMB[touch ? "touch" : scheme]}
          </p>

          {!touch && (
            <div className="mt-3 flex gap-1.5">
              {SCHEMES.map((o) => (
                <button
                  key={o.id}
                  onClick={() => onScheme(o.id)}
                  className={`flex-1 rounded-lg px-2.5 py-2 text-left transition ${
                    scheme === o.id
                      ? "bg-amber-400/20 ring-1 ring-amber-300/60"
                      : "bg-white/[0.05] hover:bg-white/[0.1]"
                  }`}
                >
                  <p
                    className={`text-[12px] font-bold ${
                      scheme === o.id ? "text-amber-100" : "text-white/60"
                    }`}
                  >
                    {o.name}
                  </p>
                  <p className="text-[10px] leading-snug text-sky-100/45">{o.blurb}</p>
                </button>
              ))}
            </div>
          )}

          <div className="mt-3.5 space-y-1.5">
            {primary.map((b) => (
              <div key={b.keys} className="flex items-baseline gap-3">
                <span className="w-[92px] shrink-0 rounded bg-amber-400/15 px-2 py-1 text-center font-mono text-[10.5px] font-bold uppercase tracking-wider text-amber-200">
                  {b.keys}
                </span>
                <span className="text-[12.5px] leading-snug text-white/85">{b.what}</span>
              </div>
            ))}
          </div>

          <div className="mt-3 grid grid-cols-1 gap-x-5 gap-y-1 sm:grid-cols-2">
            {rest.map((b) => (
              <div key={b.keys} className="flex items-baseline gap-2">
                <span className="w-[74px] shrink-0 text-right font-mono text-[10px] uppercase tracking-wider text-sky-300/60">
                  {b.keys}
                </span>
                <span className="text-[11px] leading-snug text-white/50">{b.what}</span>
              </div>
            ))}
          </div>

          <p className="mt-3.5 rounded-lg bg-sky-400/[0.08] px-3 py-2 text-[12px] leading-snug text-sky-100/75">
            {TIPS[start]}
          </p>
        </div>

        <button
          onClick={onClose}
          className="mt-4 w-full bg-gradient-to-b from-amber-300 to-amber-500 py-3 text-sm font-black uppercase tracking-[0.24em] text-slate-900 transition hover:brightness-110"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
