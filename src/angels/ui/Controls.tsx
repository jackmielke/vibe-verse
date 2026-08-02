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
      { keys: "BRK", what: "Airbrake, and the wheel brakes on the ground" },
      { keys: "SMOKE", what: "Smoke on and off" },
      { keys: "VIEW", what: "Change camera" },
      { keys: "GEAR", what: "Landing gear" },
      { keys: "◀ ▶", what: "Rudder" },
    ];
  }
  if (scheme === "mouse") {
    return [
      { keys: "Move mouse", what: "Fly. The cursor is the stick.", primary: true },
      { keys: "W  S", what: "Throttle up and down", primary: true },
      { keys: "Q  E", what: "Rudder" },
      { keys: "A  D", what: "Fine roll trim, for formation work" },
      { keys: "Space", what: "Airbrake" },
      { keys: "1 – 0", what: "Throttle gate: 1 idle, 0 full burner" },
      { keys: "G", what: "Landing gear" },
      { keys: "X", what: "Smoke" },
      { keys: "C", what: "Change camera" },
      { keys: "R", what: "Put me back over the lake" },
      { keys: "Right-drag", what: "Look around" },
      { keys: "H", what: "Show this card" },
      { keys: "Esc", what: "Menu" },
    ];
  }
  return [
    { keys: "W  S", what: "Climb and dive", primary: true },
    { keys: "A  D", what: "Roll left and right", primary: true },
    { keys: "Shift  Z", what: "Throttle up and down", primary: true },
    { keys: "Q  E", what: "Rudder" },
    { keys: "Space", what: "Airbrake" },
    { keys: "1 – 0", what: "Throttle gate: 1 idle, 0 full burner" },
    { keys: "G", what: "Landing gear" },
    { keys: "X", what: "Smoke" },
    { keys: "C", what: "Change camera" },
    { keys: "R", what: "Put me back over the lake" },
    { keys: "Right-drag", what: "Look around" },
    { keys: "H", what: "Show this card" },
    { keys: "Esc", what: "Menu" },
  ];
}

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
      className="fixed inset-0 z-40 flex items-center justify-center p-4"
      style={{ background: "rgba(2,6,15,0.62)", backdropFilter: "blur(3px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl border border-white/12"
        style={{ background: "rgba(5,12,26,0.97)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-4">
          <p className="font-mono text-[9.5px] uppercase tracking-[0.4em] text-sky-300/50">
            How to fly it
          </p>

          {!touch && (
            <div className="mt-2.5 flex gap-1.5">
              {(["mouse", "keyboard"] as ControlScheme[]).map((s) => (
                <button
                  key={s}
                  onClick={() => onScheme(s)}
                  className={`flex-1 rounded-lg px-3 py-2 text-left transition ${
                    scheme === s
                      ? "bg-amber-400/20 ring-1 ring-amber-300/60"
                      : "bg-white/[0.05] hover:bg-white/[0.1]"
                  }`}
                >
                  <p
                    className={`text-[12.5px] font-bold ${
                      scheme === s ? "text-amber-100" : "text-white/60"
                    }`}
                  >
                    {s === "mouse" ? "Mouse" : "Keyboard"}
                  </p>
                  <p className="text-[10.5px] leading-snug text-sky-100/45">
                    {s === "mouse" ? "The cursor is the stick" : "W A S D only"}
                  </p>
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
