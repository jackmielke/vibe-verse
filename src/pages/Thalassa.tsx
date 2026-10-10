/**
 * /thalassa — a sunlit harbour town on a turquoise bay, a temple on a cliff
 * island, and galleys under striped sails. Walk it, swim it, or put on a
 * headset. The world lives in src/thalassa; this page is the door and the HUD.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import { Joystick } from "@/magician/ui/Joystick";
import type { ThalassaWorld } from "@/thalassa/engine";

const PLACES: Array<{ id: string; name: string }> = [
  { id: "quay", name: "Quay" },
  { id: "market", name: "Market" },
  { id: "acropolis", name: "Upper Town" },
  { id: "lighthouse", name: "Lighthouse" },
  { id: "bridge", name: "Bridge" },
  { id: "temple", name: "Temple" },
  { id: "overlook", name: "Overlook" },
];

type Phase = "splash" | "loading" | "playing" | "failed";

export default function Thalassa() {
  useWorldStamp("/thalassa", "Thalassa");
  const mountRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<ThalassaWorld | null>(null);
  const vrRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>(() => (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("go") ? "loading" : "splash"));
  const [place, setPlace] = useState("");
  const [placeShown, setPlaceShown] = useState(false);
  const [muted, setMuted] = useState(false);
  const [menu, setMenu] = useState(false);
  const [hint, setHint] = useState(true);
  const [phone] = useState(() => typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches ?? false));
  const [vrOk, setVrOk] = useState(false);

  useEffect(() => {
    const xr = (navigator as Navigator & { xr?: { isSessionSupported(m: string): Promise<boolean> } }).xr;
    void xr?.isSessionSupported("immersive-vr").then(setVrOk).catch(() => undefined);
  }, []);

  // Build the world once the loader has painted: building it takes a moment
  // and would otherwise freeze the button under the player's finger.
  useEffect(() => {
    if (phase !== "loading") return;
    let world: ThalassaWorld | null = null;
    let cancelled = false;
    const t = window.setTimeout(() => {
      void import("@/thalassa/engine").then(({ createThalassa }) => {
        if (cancelled || !mountRef.current) return;
        try {
          world = createThalassa(mountRef.current, {
            intro: true,
            onPlace: (name) => { setPlace(name); setPlaceShown(true); },
            onReady: () => setPhase("playing"),
          });
          worldRef.current = world;
          world.wake();
        } catch (e) {
          console.error(e);
          setPhase("failed");
        }
      }).catch((e) => { console.error(e); setPhase("failed"); });
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      world?.dispose();
      worldRef.current = null;
    };
    // Mount once; the phase only moves forward from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase === "loading" || phase === "playing"]);

  useEffect(() => {
    if (!placeShown) return;
    const t = window.setTimeout(() => setPlaceShown(false), 3200);
    return () => window.clearTimeout(t);
  }, [placeShown, place]);

  useEffect(() => {
    if (phase !== "playing") return;
    const t = window.setTimeout(() => setHint(false), 12000);
    // The headset button, three's own, in our HUD.
    if (vrOk && vrRef.current && worldRef.current && !vrRef.current.firstChild) {
      const b = worldRef.current.vrButton();
      b.style.position = "static";
      b.style.padding = "10px 14px";
      b.style.font = "600 11px/1 system-ui, sans-serif";
      b.style.letterSpacing = "0.16em";
      b.style.borderRadius = "12px";
      b.style.background = "rgba(20,40,70,0.55)";
      b.style.border = "1px solid rgba(255,255,255,0.3)";
      b.style.width = "auto";
      b.style.opacity = "1";
      vrRef.current.appendChild(b);
    }
    return () => window.clearTimeout(t);
  }, [phase, vrOk]);

  useEffect(() => { worldRef.current?.setMuted(muted); }, [muted]);

  const enter = useCallback(() => setPhase("loading"), []);
  const wake = useCallback(() => worldRef.current?.wake(), []);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#cfe6f3] text-white" onPointerDown={wake}>
      <div ref={mountRef} className="absolute inset-0" />

      {phase === "splash" && <Splash onEnter={enter} vr={vrOk} phone={phone} />}

      {phase === "loading" && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-gradient-to-b from-[#2f7fd8] via-[#7cc6e8] to-[#e9dcb8]">
          <div className="text-[11px] uppercase tracking-[0.5em] text-white/80">Vibeverse</div>
          <h1 className="mt-3 font-serif text-5xl tracking-[0.18em] text-white drop-shadow sm:text-7xl">THALASSA</h1>
          <div className="mt-8 h-[2px] w-56 overflow-hidden rounded-full bg-white/30">
            <div className="h-full w-1/3 animate-[thsweep_1.4s_ease-in-out_infinite] rounded-full bg-white" />
          </div>
          <p className="mt-5 text-xs tracking-wide text-white/85">Raising the walls, filling the bay…</p>
          <style>{"@keyframes thsweep{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}"}</style>
        </div>
      )}

      {phase === "failed" && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-[#123] p-6 text-center">
          <p className="max-w-sm text-sm text-white/80">This harbour needs WebGL, and this browser would not give us any. Try another browser or device.</p>
          <Link to="/worlds" className="rounded-xl bg-white/15 px-4 py-3 text-xs uppercase tracking-[0.2em] ring-1 ring-white/30">Back to the worlds</Link>
        </div>
      )}

      {phase === "playing" && (
        <div className="pointer-events-none absolute inset-0 z-10 select-none" style={{ padding: "max(env(safe-area-inset-top), 12px) max(env(safe-area-inset-right), 12px) max(env(safe-area-inset-bottom), 12px) max(env(safe-area-inset-left), 12px)" }}>
          <div className="flex items-start justify-between gap-2">
            <Link to="/worlds" data-ui="1" className="pointer-events-auto inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#0e2a44]/45 px-3.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/90 ring-1 ring-white/25 backdrop-blur-sm">← Worlds</Link>
            <div className="flex items-center gap-2" data-ui="1">
              <div ref={vrRef} className="pointer-events-auto" />
              <button data-ui="1" onClick={() => setMuted((m) => !m)} className="pointer-events-auto min-h-[44px] rounded-xl bg-[#0e2a44]/45 px-3.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/90 ring-1 ring-white/25 backdrop-blur-sm">{muted ? "🔇" : "🔊"}</button>
              <button data-ui="1" onClick={() => setMenu((m) => !m)} className="pointer-events-auto min-h-[44px] rounded-xl bg-[#0e2a44]/45 px-3.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/90 ring-1 ring-white/25 backdrop-blur-sm">Go to</button>
            </div>
          </div>

          {menu && (
            <div data-ui="1" className="pointer-events-auto absolute right-3 top-16 w-56 rounded-2xl bg-[#0e2a44]/80 p-2 ring-1 ring-white/20 backdrop-blur-md">
              {PLACES.map((p) => (
                <button key={p.id} data-ui="1" onClick={() => { worldRef.current?.goTo(p.id); setMenu(false); }} className="block w-full rounded-xl px-3 py-2.5 text-left text-sm text-white/90 hover:bg-white/10">
                  {p.name}
                </button>
              ))}
            </div>
          )}

          <div className={`absolute left-1/2 top-[18%] -translate-x-1/2 text-center transition-opacity duration-700 ${placeShown ? "opacity-100" : "opacity-0"}`}>
            <div className="font-serif text-3xl tracking-[0.2em] text-white drop-shadow-[0_2px_8px_rgba(0,40,80,0.55)] sm:text-4xl">{place.toUpperCase()}</div>
          </div>

          {hint && !phone && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-[#0e2a44]/45 px-4 py-2 text-[11px] tracking-wide text-white/90 ring-1 ring-white/20 backdrop-blur-sm">
              Click to look · WASD to walk · Shift to run · Space to jump · Esc for the cursor
            </div>
          )}

          {phone && (
            <>
              <div className="pointer-events-auto absolute bottom-10 left-5" data-ui="1">
                <Joystick onMove={(x, y) => worldRef.current?.setStick(x, y)} />
              </div>
              <button
                data-ui="1"
                onPointerDown={(e) => { e.preventDefault(); worldRef.current?.jump(); }}
                className="pointer-events-auto absolute bottom-14 right-6 h-16 w-16 rounded-full bg-[#0e2a44]/45 text-[10px] uppercase tracking-[0.15em] text-white/90 ring-1 ring-white/30 backdrop-blur-sm"
              >
                jump
              </button>
              {hint && <div className="absolute bottom-36 left-1/2 -translate-x-1/2 rounded-full bg-[#0e2a44]/45 px-3 py-1.5 text-[11px] text-white/90">Stick to walk · drag to look</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Splash({ onEnter, vr, phone }: { onEnter(): void; vr: boolean; phone: boolean }) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center overflow-hidden bg-gradient-to-b from-[#2f7fd8] via-[#6cc3e6] to-[#f1e3bf] px-6 text-center">
      {/* A painted horizon: sea, a headland, a temple on its rock. */}
      <svg className="pointer-events-none absolute inset-x-0 bottom-0 h-[46%] w-full" viewBox="0 0 1200 400" preserveAspectRatio="xMidYMax slice" aria-hidden>
        <rect x="0" y="170" width="1200" height="230" fill="#1aa6c4" />
        <rect x="0" y="170" width="1200" height="40" fill="#5fd6d8" opacity="0.6" />
        <path d="M0 210 C120 150 260 140 380 175 C470 200 520 215 600 230 L600 400 L0 400 Z" fill="#8cbc3e" />
        <path d="M0 250 C140 230 300 240 470 260 L520 400 L0 400 Z" fill="#6fa236" />
        <path d="M60 230 h170 v-22 h-170z M90 208 h120 l-60 -26z" fill="#e7cf9f" />
        <path d="M90 208 l60 -26 l60 26z" fill="#c8572e" />
        <path d="M820 230 C840 150 860 120 930 112 C990 118 1010 160 1030 232 Z" fill="#cfc4ae" />
        <rect x="878" y="96" width="104" height="10" fill="#f3ecdc" />
        {[0, 1, 2, 3, 4, 5].map((i) => <rect key={i} x={884 + i * 17} y="70" width="6" height="26" fill="#f3ecdc" />)}
        <path d="M872 70 l58 -20 l58 20z" fill="#c95a30" />
        <path d="M640 250 q40 -10 80 0 l-8 12 h-64z" fill="#6b4429" />
        <rect x="678" y="186" width="3" height="64" fill="#7b5a3a" />
        <path d="M660 192 h40 v40 q-20 6 -40 0z" fill="#efe3c8" />
        <path d="M670 192 h6 v40 h-6z M688 192 h6 v40 h-6z" fill="#9b5a34" />
      </svg>
      <div className="relative z-10 text-[11px] uppercase tracking-[0.5em] text-white/85">Vibeverse</div>
      <h1 className="relative z-10 mt-3 font-serif text-6xl tracking-[0.18em] text-white drop-shadow-[0_3px_12px_rgba(0,40,90,0.45)] sm:text-8xl">THALASSA</h1>
      <p className="relative z-10 mt-4 max-w-md text-sm leading-relaxed text-white/95 drop-shadow">
        A walled harbour on a turquoise bay. Wander the market, climb to the temple on the cliff island, swim out to the galleys.
      </p>
      <button
        onClick={onEnter}
        className="relative z-10 mt-8 min-h-[52px] rounded-2xl bg-white px-8 text-sm font-semibold uppercase tracking-[0.22em] text-[#0e4a7a] shadow-[0_10px_30px_rgba(0,50,100,0.3)] transition active:scale-95"
      >
        Enter the harbour
      </button>
      <p className="relative z-10 mt-4 text-[11px] tracking-wide text-white/85">
        {phone ? "Left stick walks, drag to look." : "Mouse to look, WASD to walk."}{vr ? " Headset ready: press VR once inside." : ""}
      </p>
      <Link to="/worlds" className="relative z-10 mt-6 text-[11px] uppercase tracking-[0.25em] text-white/80 underline-offset-4 hover:underline">← all worlds</Link>
    </div>
  );
}
