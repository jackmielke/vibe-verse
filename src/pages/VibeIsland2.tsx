/**
 * /island-2 — VIBE ISLAND II
 *
 * The Vibeverse's floating archipelago, rebuilt. Same canon as the original —
 * the Plaza, THE PALACE, SnackFe, the Arch, the Graffiti Wall, the zeppelin —
 * at an entirely different level of craft.
 */
import { Suspense, lazy, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

const IslandGame = lazy(() => import("@/island2/IslandGame"));

function Loader() {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#0a0d14] text-white">
      <div className="text-[11px] uppercase tracking-[0.42em] text-white/40">Vibeverse</div>
      <h1 className="mt-3 text-center font-black uppercase leading-[0.9] tracking-tight text-4xl sm:text-6xl">
        Vibe Island
        <span className="block bg-gradient-to-r from-[#ffb347] to-[#ff6a8b] bg-clip-text text-transparent">
          Part II
        </span>
      </h1>
      <div className="mt-8 h-[2px] w-56 overflow-hidden rounded-full bg-white/10">
        <div className="h-full w-1/3 animate-[ivsweep_1.5s_ease-in-out_infinite] rounded-full bg-[#ffb347]" />
      </div>
      <p className="mt-5 text-xs tracking-wide text-white/35">Lifting the island…</p>
      <style>{`@keyframes ivsweep{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}`}</style>
    </div>
  );
}

function Overlay() {
  const [hint, setHint] = useState(true);
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    setTouch(window.matchMedia("(hover: none), (pointer: coarse)").matches);
    const t = window.setTimeout(() => setHint(false), 9000);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div
      className="pointer-events-none fixed inset-0 z-10 select-none"
      style={{
        paddingTop: "max(env(safe-area-inset-top), 12px)",
        paddingLeft: "max(env(safe-area-inset-left), 12px)",
        paddingRight: "max(env(safe-area-inset-right), 12px)",
        paddingBottom: "max(env(safe-area-inset-bottom), 12px)",
      }}
    >
      <Link
        to="/worlds"
        className="pointer-events-auto inline-flex min-h-[44px] items-center gap-2 rounded-xl
                   bg-black/40 px-3.5 text-[11px] font-semibold uppercase tracking-[0.18em]
                   text-white/80 backdrop-blur-sm ring-1 ring-white/15 transition
                   active:scale-95 hover:text-white"
        style={{ WebkitTapHighlightColor: "transparent" }}
      >
        ← Worlds
      </Link>
      <div
        className={`absolute inset-x-0 bottom-0 flex justify-center transition-opacity duration-700 ${
          hint ? "opacity-100" : "opacity-0"
        }`}
        style={{ paddingBottom: "max(env(safe-area-inset-bottom), 18px)" }}
      >
        <p className="mx-4 rounded-full bg-black/45 px-4 py-2 text-center text-[11px] leading-relaxed text-white/70 backdrop-blur-sm ring-1 ring-white/10">
          {touch
            ? "Left thumb to move · right thumb to look · fly under the island"
            : "Click to capture the mouse · WASD to fly · Shift to boost · Space / C for altitude"}
        </p>
      </div>
    </div>
  );
}

export default function VibeIsland2() {
  const [params] = useSearchParams();
  const spawn = params.get("spawn") ?? "plaza";
  const capturing = params.has("shot");

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <Suspense fallback={<Loader />}>
      <IslandGame spawn={spawn} />
      {capturing ? null : <Overlay />}
    </Suspense>
  );
}
