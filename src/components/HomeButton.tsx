/**
 * The way home, from inside any world.
 *
 * Thirty worlds, each its own engine, and the only thing they all agreed on
 * was that there was no way out of them. Fullscreen worlds hide the global nav
 * on purpose — it would sit on a crosshair — so the exit was whatever that
 * world's author happened to build, if anything. On a phone, where there is no
 * address bar to retype into, several of them were simply a dead end.
 *
 * This is that one thing, in the same corner, in every one of them.
 *
 * Three rules keep it from becoming the problem it solves:
 *
 * 1. **It disappears while you are playing.** Pointer lock is the signal, and
 *    it is the right one because it is engine-agnostic: every world that grabs
 *    the mouse to look around sets it, and none of them had to be modified to
 *    say so. SF's own chrome established this rule first — an exit affordance
 *    on screen during a firefight competes with the HUD and is one mis-click
 *    from ending the session.
 * 2. **It says what it is, then gets out of the way.** Wide with a label for
 *    the first few seconds after you arrive, which is exactly when a new
 *    visitor wants to know they can leave; a quiet puck after that, until it
 *    is hovered or focused.
 * 3. **It reserves its corner.** `--vv-home-clear` in index.css is the width
 *    it occupies, and the three worlds with their own top-left HUD (San
 *    Francisco's minimap, Vibe Kart's item slot, the Final Frontier's status
 *    block) offset by it. A global button that lands on top of a minimap is
 *    not unification, it is a second bug.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

/**
 * The vibeverse's mark: a ringed world, the same one on the app icon.
 *
 * Exported because the global nav's own corner button uses it too — the way
 * home should look like the same thing whether the nav is there or not.
 */
export function VibeMark({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="5" fill="none" stroke="#7dffd4" strokeWidth="1.3" />
      <ellipse
        cx="8"
        cy="8"
        rx="7.1"
        ry="2.7"
        fill="none"
        stroke="#8fe4ff"
        strokeWidth="1.1"
        opacity="0.85"
        transform="rotate(-24 8 8)"
      />
      <circle cx="8" cy="8" r="1.7" fill="#7dffd4" />
    </svg>
  );
}

export default function HomeButton() {
  const [locked, setLocked] = useState(false);
  const [hint, setHint] = useState(true);

  useEffect(() => {
    const onChange = () => setLocked(Boolean(document.pointerLockElement));
    onChange();
    document.addEventListener("pointerlockchange", onChange);
    return () => document.removeEventListener("pointerlockchange", onChange);
  }, []);

  // The welcome window. Long enough to read, short enough not to sit on a HUD.
  useEffect(() => {
    const id = window.setTimeout(() => setHint(false), 5000);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <div
      className="pointer-events-none fixed left-3 top-3 z-[45] transition-all duration-300"
      style={{
        opacity: locked ? 0 : 1,
        transform: locked ? "translateY(-8px)" : "translateY(0)",
      }}
    >
      <Link
        to="/"
        aria-label="Back to the VibeVerse home"
        title="Back to the VibeVerse — every world and game"
        className={`pointer-events-auto group flex h-10 items-center gap-2 rounded-full border border-white/20 pl-1.5 text-white/90 backdrop-blur-xl transition-all duration-300 hover:border-white/35 hover:text-white ${
          hint ? "pr-3.5" : "pr-1.5 hover:pr-3.5 focus-visible:pr-3.5"
        }`}
        style={{
          background: "rgba(8, 18, 34, 0.52)",
          boxShadow: "0 6px 24px rgba(2, 10, 24, 0.45), inset 0 1px 0 rgba(255,255,255,0.12)",
          WebkitTapHighlightColor: "transparent",
          pointerEvents: locked ? "none" : "auto",
        }}
      >
        {/* The ringed world off the app icon, so the button reads as "the
            VibeVerse" and not as some game's own back arrow. */}
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/10">
          <VibeMark />
        </span>
        <span
          className={`overflow-hidden whitespace-nowrap font-heading text-[10.5px] font-bold uppercase leading-none tracking-[0.2em] transition-all duration-300 ${
            hint
              ? "max-w-[8rem] opacity-100"
              : "max-w-0 opacity-0 group-hover:max-w-[8rem] group-hover:opacity-100 group-focus-visible:max-w-[8rem] group-focus-visible:opacity-100"
          }`}
        >
          Home
        </span>
      </Link>
    </div>
  );
}
