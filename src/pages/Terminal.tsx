/**
 * /terminal — THE TERMINAL, the Vibeverse's front door.
 */
import { Suspense, lazy } from "react";
import { useWorldStamp } from "@/hooks/use-world-stamp";

const TerminalScene = lazy(() => import("@/terminal/TerminalScene"));

function Loader() {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#5fa8e8] text-white">
      <div className="text-center">
        <div className="text-[11px] font-bold uppercase tracking-[0.42em] text-white/70">
          Every builder grows the universe
        </div>
        <h1 className="mt-2 text-5xl font-black tracking-tight drop-shadow-lg sm:text-7xl">
          VIBEVERSE
        </h1>
      </div>
    </div>
  );
}

export default function Terminal() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/terminal", "The Terminal");

  return (
    <Suspense fallback={<Loader />}>
      <TerminalScene />
    </Suspense>
  );
}
