/**
 * GlobalNav — 🌐 Worlds pill (top-left) + wallet/Vibe Profile pill (top-right).
 *
 * The old center chip row of primary destinations is gone: it was a permanent
 * banner across the top of every world. The Worlds pill goes to /game and the
 * WorldPicker still covers the full list.
 */
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Search } from "lucide-react";
import WorldPicker from "@/components/WorldPicker";
import LogInWithVibe from "@/components/vibe-auth/LogInWithVibe";
import VibeCoinChip from "@/components/VibeCoinChip";
import { VibeMark } from "@/components/HomeButton";
import { shouldOpenSearch } from "@/lib/searchHotkey";


export default function GlobalNav() {
  const location = useLocation();
  const [pickerOpen, setPickerOpen] = useState(false);

  // /start is the first sixty seconds of the VibeVerse — Vibey hosts it
  // full-bleed, so the world chips and profile pill stay out of frame.
  const onboarding = location.pathname === "/start";
  // Globetrotter is a full-bleed game — chrome floating over the
  // satellite view breaks the immersion, and the game carries its own
  // exit affordance in the HUD.
  const fullBleedGame = ["/globetrotter", "/geo"].includes(location.pathname);
  // ?embed=1 — another site is framing us as a broadcast (the studio's
  // VIBE TV tunes into /live). Pure picture, no chrome.
  const embedded = new URLSearchParams(location.search).get("embed") === "1";

  // Collapse the picker on any navigation.
  useEffect(() => {
    setPickerOpen(false);
  }, [location.pathname, location.search]);

  /* "/" opens the search, the way it does everywhere else on the web. What it
     must not do — steal a keystroke from a field, or land on somebody mid-game
     — is `shouldOpenSearch`, which is a pure function so it can be tested. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const ok = shouldOpenSearch(e, {
        pointerLocked: !!document.pointerLockElement,
        active: el ? { tagName: el.tagName, isContentEditable: el.isContentEditable } : null,
      });
      if (!ok) return;
      e.preventDefault();
      setPickerOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const chipClass = (active: boolean) =>
    `group relative flex items-center gap-1.5 rounded-full px-2 sm:px-2.5 py-1.5 transition-all ${
      active
        ? "bg-primary/25 text-primary shadow-[0_0_18px_hsl(var(--primary)/0.35)]"
        : "text-foreground/75 hover:text-foreground hover:bg-muted/50"
    }`;

  const labelClass =
    "text-[10.5px] font-heading font-semibold tracking-wider uppercase leading-none hidden sm:inline";


  if (onboarding || embedded || fullBleedGame) return null;

  return (
    <>
      {/* World selector — own pill, top-left, mirrors the Vibe Profile pill. */}
      <div className="fixed top-3 left-3 z-40 pointer-events-auto">
        <div
          className="glass-panel rounded-full border border-border/60 px-1.5 py-1 flex items-center"
          style={{
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
          }}
        >
          {/* Points at /game, not at "/". The hub is beautiful and slow; this
              chip is the one people press when they want to *see what's here*,
              and that deserves the flat index that loads in a frame. */}
          <Link
            to="/game"
            className={chipClass(location.pathname === "/game")}
            title="Every world and game, on one page"
            aria-current={location.pathname === "/game" ? "page" : undefined}
          >
            {/* Same mark as the home button that stands in for this pill
                inside fullscreen worlds — one corner, one thing, everywhere. */}
            <VibeMark size={14} />
            <span className={labelClass}>Worlds</span>
          </Link>

          {/* Universal search — the same overlay, from anywhere.
              `WorldPicker` has had an autofocused search field over every world
              in the registry for a long time, and nothing in the app could open
              it: this component held the state and only ever set it to `false`.
              A finished feature nobody could reach.

              It goes next to the Worlds pill rather than in the opposite corner
              because it is the same question asked in a hurry — that list, but
              you already know the name. */}
          <span className="mx-0.5 h-4 w-px bg-border/60" aria-hidden />
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className={chipClass(false)}
            title="Search every world (press /)"
            aria-label="Search every world"
          >
            <Search className="h-3.5 w-3.5" aria-hidden />
            <span className={labelClass}>Search</span>
          </button>
        </div>
      </div>

      {/* The world chip row used to live here. It was a permanent banner
          across the top of every world; the 🌐 Worlds pill (left) and the
          full picker cover the same ground without covering the view. */}
      <WorldPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />


      {/* Wallet + Vibe Profile — one pill, top-right, height-matched to the
          nav row. The balance shares the profile's pill rather than taking a
          fourth corner: on a phone there are only two free corners at the top,
          and the currency belongs next to the identity that holds it. */}
      <div className="fixed top-3 right-3 z-40 pointer-events-auto">
        <div
          className="glass-panel rounded-full border border-border/60 px-1.5 py-1 flex items-center gap-1"
          style={{
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
          }}
        >
          <VibeCoinChip />
          <span className="h-4 w-px bg-border/60" aria-hidden />
          <LogInWithVibe />
        </div>
      </div>
    </>
  );
}
