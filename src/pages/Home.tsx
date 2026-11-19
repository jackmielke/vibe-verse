/**
 * `/` — the front door, in whichever of the three cover-art looks you prefer.
 *
 * Postcard is the default and the only look on a phone, where a switcher would
 * be one more control between a visitor and the worlds. On a wider screen a
 * small switcher in the corner leads with Postcard, then Arcade and Sky, and
 * the choice is remembered on this device. With nothing saved, the page opens
 * on Postcard; a stored pick still wins. `?look=sky` previews one without
 * saving it, which is what a link to somebody else should do.
 *
 * The App Store edition keeps the flat grid (`Game`): it hides the currency
 * and the paper, and these pages are built around both.
 */
import { Suspense, useEffect, useState } from "react";

import Game from "@/pages/Game";
import { IOS_APP } from "@/lib/iosApp";
import { DEFAULT_DIRECTION, DIRECTIONS, type DirectionId } from "@/redesign/directions";

const KEY = "vibe.home.direction";
const WIDE = "(min-width: 768px)";

const isDirection = (v: string | null): v is DirectionId => DIRECTIONS.some((d) => d.id === v);

function readSaved(): DirectionId {
  try {
    const v = localStorage.getItem(KEY);
    return isDirection(v) ? v : DEFAULT_DIRECTION;
  } catch {
    return DEFAULT_DIRECTION;
  }
}

function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

export default function Home() {
  return IOS_APP ? <Game /> : <Front />;
}

function Front() {
  const wide = useWide();
  const [preview, setPreview] = useState(() => {
    const v = new URLSearchParams(window.location.search).get("look");
    return isDirection(v) ? v : null;
  });
  const [saved, setSaved] = useState<DirectionId>(readSaved);
  const look: DirectionId = preview ?? (wide ? saved : DEFAULT_DIRECTION);
  const Page = DIRECTIONS.find((d) => d.id === look)!.Component;

  const choose = (id: DirectionId) => {
    setSaved(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* Private browsing: the pick lasts for this visit. */
    }
    /* The query is a preview, not a choice. Drop it in state as well as the
       URL, or the click saves and the page keeps showing the link's look. */
    if (preview) {
      setPreview(null);
      window.history.replaceState(null, "", window.location.pathname);
    }
  };

  return (
    <>
      {/* Postcard's paper, so a first visit does not flash Arcade blue. */}
      <Suspense fallback={<div className="min-h-[100dvh] w-full" style={{ background: "#f6f0e4" }} />}>
        <Page />
      </Suspense>
      {wide && (
        <div
          role="radiogroup"
          aria-label="Front page look"
          className="fixed bottom-4 right-4 z-[60] flex items-center gap-0.5 rounded-full bg-[#0b1526]/85 p-1 text-white shadow-xl ring-1 ring-white/10 backdrop-blur-xl"
        >
          <span className="px-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/50">Look</span>
          {DIRECTIONS.map((d) => (
            <button
              key={d.id}
              type="button"
              role="radio"
              aria-checked={d.id === look}
              title={d.note}
              onClick={() => choose(d.id)}
              className={`rounded-full px-3 py-1.5 text-[12.5px] font-bold transition-colors ${
                d.id === look ? "bg-white text-[#0b1526]" : "text-white/70 hover:text-white"
              }`}
            >
              {d.name}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
