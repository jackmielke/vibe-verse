/**
 * /sf — SAN FRANCISCO: FREE FALL
 *
 * The Vibeverse's open-world shooter. Grapple, wingsuit and shoot your way
 * across a real-geometry San Francisco, from the Golden Gate to the Bay Bridge.
 */
import { Suspense, lazy, useEffect } from "react";
import { useSearchParams } from "react-router-dom";

const SanFranciscoGame = lazy(() => import("@/sf/SanFranciscoGame"));

function Loader() {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#05070c] text-white">
      <div className="text-[11px] uppercase tracking-[0.42em] text-white/40">Vibeverse</div>
      <h1 className="mt-3 text-center font-black uppercase leading-[0.92] tracking-tight text-4xl sm:text-6xl">
        San Francisco
        <span className="block text-[#ff6a2b]">Free Fall</span>
      </h1>
      <div className="mt-8 h-[2px] w-56 overflow-hidden rounded-full bg-white/10">
        <div className="h-full w-1/3 animate-[sfsweep_1.4s_ease-in-out_infinite] rounded-full bg-[#ff6a2b]" />
      </div>
      <p className="mt-5 text-xs tracking-wide text-white/35">Streaming the city…</p>
      <style>{`@keyframes sfsweep{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}`}</style>
    </div>
  );
}

export default function SanFrancisco() {
  const [params] = useSearchParams();
  const spawn = params.get("spawn") ?? "coit";

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <Suspense fallback={<Loader />}>
      <SanFranciscoGame spawn={spawn} />
    </Suspense>
  );
}
