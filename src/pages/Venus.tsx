/**
 * Venus Rising — `/venus`.
 *
 * Everybody raced to the Moon, then to Mars. Nobody looked at Venus, because
 * everybody pictured the surface. Fifty-four kilometres up it is 30 °C and
 * half a bar, the gravity is 0.9 g, and breathable air is a lifting gas: so
 * the houses are the balloons. Build a floating city, keep it in the band,
 * and quietly become the utopia nobody saw coming.
 *
 * Inspired by Atin, whose main life goal is to colonise Venus.
 *
 * A thin page: it owns the menus and the overlays. Everything that moves is
 * under `src/venus/`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { createVenus, type Caption, type EntryState, type Phase, type VenusWorld } from "@/venus/world/Venus";
import { clearSave, loadSave, type ActiveEvent, type SimFx, type Tile } from "@/venus/sim";
import { Hud } from "@/venus/ui/Hud";
import { useWorldStamp } from "@/hooks/use-world-stamp";

interface Toast { id: number; title?: string; text: string; tone: "good" | "warn" | "bad" | "milestone" }

const glass = "rounded-2xl border border-[#f6d28b]/25 bg-[#1b0f0a]/55 backdrop-blur-md shadow-[0_8px_40px_rgba(0,0,0,0.35)]";

export default function Venus() {
  useWorldStamp("/venus", "Venus Rising");
  const hostRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<VenusWorld | null>(null);
  const [phase, setPhase] = useState<Phase>("title");
  const [, setTick] = useState(0);
  const [caption, setCaption] = useState<Caption | null>(null);
  const [entry, setEntry] = useState<EntryState | null>(null);
  const [selected, setSelected] = useState<Tile | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [muted, setMuted] = useState(false);
  const [fired, setFired] = useState(false);
  const [flash, setFlash] = useState(0);
  const [hasSave] = useState(() => !!loadSave());
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.innerWidth < 760);
  const [ended, setEnded] = useState<"fallen" | "won" | null>(null);
  const [wonSeen, setWonSeen] = useState(false);
  const toastId = useRef(0);

  useEffect(() => {
    const on = () => setCompact(window.innerWidth < 760);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&display=swap";
    document.head.appendChild(link);
    return () => link.remove();
  }, []);

  const pushToast = useCallback((t: Omit<Toast, "id">) => {
    const id = ++toastId.current;
    setToasts((xs) => [...xs.slice(-1), { ...t, id }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), t.tone === "milestone" ? 9000 : 5000);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const params = new URLSearchParams(location.search);
    const world = createVenus({
      container: host,
      save: params.has("fresh") ? null : loadSave(),
      muted: false,
      onPhase: (p) => {
        setPhase(p);
        if (p === "entry") setFlash((f) => f + 1);
        if (p !== "entry") setEntry(null);
      },
      onTick: () => setTick((n) => n + 1),
      onCaption: setCaption,
      onEntry: setEntry,
      onSelect: setSelected,
      onFire: () => setFired(true),
      onFx: (f: SimFx) => {
        if (f.kind === "milestone") pushToast({ title: f.title, text: f.text, tone: "milestone" });
        else if (f.kind === "toast") pushToast({ text: f.text, tone: f.tone ?? "good" });
        else if (f.kind === "fallen") setTimeout(() => setEnded("fallen"), 4200);
        else if (f.kind === "won") setEnded("won");
        else if (f.kind === "dawn") pushToast({ text: "Sunrise. The canopies wake up.", tone: "good" });
        else if (f.kind === "dusk") pushToast({ text: "Sunset. Half a lap of night: the batteries have to carry you.", tone: "warn" });
      },
    });
    worldRef.current = world;
    if (params.has("play")) world.skipIntro();
    return () => {
      world.dispose();
      worldRef.current = null;
    };
  }, [pushToast]);

  useEffect(() => { worldRef.current?.setMuted(muted); }, [muted]);

  const world = worldRef.current;
  const event: ActiveEvent | null = world?.sim.event ?? null;

  return (
    <div className="relative h-[100dvh] w-full select-none overflow-hidden bg-[#1a0d08] text-[#f3e3c8]">
      <style>{`
        .font-venus { font-family: 'Cormorant Garamond', ui-serif, Georgia, serif; }
        @keyframes venusfade { 0% { opacity: 0; transform: translateY(4px) } 8% { opacity: 1; transform: none } 92% { opacity: 1 } 100% { opacity: 0 } }
        @keyframes venusrise { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: none } }
        @keyframes venuswhite { from { opacity: 1 } to { opacity: 0 } }
        @keyframes venuspulse { 0%,100% { box-shadow: 0 0 0 0 rgba(255,220,150,0.7) } 50% { box-shadow: 0 0 0 14px rgba(255,220,150,0) } }
      `}</style>
      <div ref={hostRef} className="absolute inset-0" />

      {/* White-out: through the ceiling. */}
      {flash > 0 && <div key={flash} className="pointer-events-none absolute inset-0 z-30 bg-[#fff6e6]" style={{ animation: "venuswhite 3.2s ease-out forwards" }} />}

      {/* ------------------------------------------------------ title */}
      {phase === "title" && (
        <div className="absolute inset-0 z-20 flex flex-col justify-between bg-gradient-to-b from-[#1a0d08]/10 via-transparent to-[#1a0d08]/75 p-6 sm:p-10">
          {/* The app's own Home pill sits top-left on every chromeless route. */}
          <div />
          <div className="max-w-2xl" style={{ animation: "venusrise 1.4s ease-out" }}>
            <div className="text-[11px] uppercase tracking-[0.45em] text-[#ffe0a8]">Venus · 2061 · fifty-four kilometres up</div>
            <h1 className="font-venus mt-3 text-[64px] font-medium leading-[0.9] text-[#fff6e6] drop-shadow-[0_2px_24px_rgba(90,30,0,0.45)] sm:text-[104px]">
              Venus Rising
            </h1>
            <p className="font-venus mt-4 max-w-xl text-[21px] italic leading-snug text-[#fff1da] drop-shadow-[0_1px_10px_rgba(60,20,0,0.6)] sm:text-[25px]">
              Everyone raced to the Moon. Then to Mars. Nobody looked at Venus, because everybody pictured the surface.
            </p>
            <p className="mt-4 max-w-lg text-[13.5px] leading-relaxed text-[#fff1da]/85 drop-shadow-[0_1px_8px_rgba(0,0,0,0.6)]">
              Build a city that floats on the clouds of Venus. Breathable air is a lifting gas here, so your houses are your balloons. Everything heavy pulls you down into the heat; everything full of air holds you up. Keep it in the band, and quietly build the utopia nobody saw coming.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <button
                onClick={() => world?.begin()}
                className="rounded-full bg-[#fff1da] px-7 py-3 text-[12px] font-bold uppercase tracking-[0.25em] text-[#3a1a0a] shadow-[0_10px_40px_rgba(255,200,120,0.35)] transition hover:bg-white"
              >
                {hasSave ? "Watch the way there" : "Begin"}
              </button>
              <button
                onClick={() => world?.skipIntro()}
                className="rounded-full border border-[#fff1da]/60 bg-[#1b0f0a]/30 px-6 py-3 text-[12px] font-semibold uppercase tracking-[0.22em] text-[#fff1da] backdrop-blur transition hover:bg-[#fff1da]/15"
              >
                {hasSave ? "Continue your city" : "Skip to the clouds"}
              </button>
            </div>
            <p className="mt-6 text-[11px] tracking-wide text-[#fff1da]/60">
              For Atin, whose main life goal is to colonise Venus. · Drag to look, scroll to zoom.
            </p>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------ prologue */}
      {(phase === "moon" || phase === "transfer" || phase === "entry") && (
        <button
          onClick={() => world?.skipIntro()}
          className="absolute right-4 top-4 z-30 rounded-full border border-white/30 bg-black/30 px-4 py-1.5 text-[10px] uppercase tracking-[0.25em] text-white/80 backdrop-blur hover:text-white"
        >
          Skip →
        </button>
      )}
      {caption && phase !== "play" && phase !== "title" && (
        <div key={caption.text} className="pointer-events-none absolute bottom-10 left-6 z-20 max-w-xl sm:left-12" style={{ animation: "venusrise 0.9s ease-out" }}>
          {caption.kicker && <div className="text-[11px] uppercase tracking-[0.4em] text-[#ffd79a]">{caption.kicker}</div>}
          <div className="font-venus mt-2 text-[34px] leading-tight text-white drop-shadow-[0_2px_16px_rgba(0,0,0,0.8)] sm:text-[46px]">{caption.text}</div>
          {caption.sub && <div className="mt-2 max-w-lg text-[14px] leading-relaxed text-white/80 drop-shadow-[0_1px_8px_rgba(0,0,0,0.9)]">{caption.sub}</div>}
        </div>
      )}
      {phase === "moon" && !fired && (
        <div className="absolute inset-x-0 bottom-[34%] z-20 flex justify-center">
          <button
            onClick={() => world?.fire()}
            className="rounded-full border border-[#9ff4ff]/70 bg-[#06141a]/60 px-8 py-3 text-[12px] font-bold uppercase tracking-[0.3em] text-[#c8faff] backdrop-blur"
            style={{ animation: "venuspulse 1.6s infinite" }}
          >
            Fire the mass driver
          </button>
        </div>
      )}

      {phase === "entry" && entry && (
        <div className="absolute right-6 top-1/2 z-20 w-[220px] -translate-y-1/2 sm:right-12">
          <div className={`${glass} p-4`}>
            <div className="text-[10px] uppercase tracking-[0.3em] text-[#f6d28b]/70">Altitude</div>
            <div className="font-venus text-[52px] leading-none tabular-nums text-white">{entry.alt.toFixed(1)}<span className="ml-1 text-[16px] text-[#f6d28b]">km</span></div>
            <div className="mt-2 grid grid-cols-2 text-[13px] tabular-nums">
              <div><span className="text-[#f6d28b]/60">T </span>{entry.tempC.toFixed(0)} °C</div>
              <div><span className="text-[#f6d28b]/60">P </span>{entry.pressure.toFixed(2)} bar</div>
            </div>
            {!entry.deployed ? (
              <button
                onClick={() => world?.deploy()}
                className={`mt-4 w-full rounded-xl py-3 text-[12px] font-bold uppercase tracking-[0.25em] transition ${entry.window ? "bg-[#9fffc8] text-[#0d2a1a]" : "bg-white/15 text-white/70"}`}
                style={entry.window ? { animation: "venuspulse 1s infinite" } : undefined}
              >
                {entry.window ? "Deploy now" : entry.alt > 58.5 ? "Too cold · wait" : "Deploy!"}
              </button>
            ) : (
              <div className="mt-4 text-[13px] text-[#9fffc8]">{entry.rating}</div>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------ play */}
      {phase === "play" && world && (
        <>
          <Hud world={world} selected={selected} compact={compact} muted={muted} onMute={() => setMuted((m) => !m)} />

          {/* toasts */}
          <div className={`pointer-events-none absolute z-20 flex flex-col gap-2 ${compact ? "left-2 right-2 top-[200px]" : "left-3 top-[330px] w-[260px]"}`}>
            {toasts.map((t) => (
              <div key={t.id} className={`${glass} px-3 py-2`} style={{ animation: "venusrise 0.5s ease-out" }}>
                {t.title && <div className="font-venus text-[19px] leading-tight text-[#ffe8bf]">✦ {t.title}</div>}
                <div className={`text-[12px] leading-snug ${t.tone === "warn" ? "text-[#ffcf9a]" : t.tone === "bad" ? "text-[#ff9a7a]" : "text-[#f3e3c8]/85"}`}>{t.text}</div>
              </div>
            ))}
          </div>

          {/* the post */}
          {event && !ended && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#1a0d08]/35 p-4">
              <div className={`${glass} w-full max-w-md p-5`} style={{ animation: "venusrise 0.5s ease-out" }}>
                <div className="text-[10px] uppercase tracking-[0.3em] text-[#f6d28b]/70">{event.from}</div>
                <div className="font-venus mt-1 text-[30px] leading-tight text-[#fff1da]">{event.title}</div>
                <p className="mt-2 text-[13.5px] leading-relaxed text-[#f3e3c8]/85">{event.body}</p>
                {event.outcome ? (
                  <>
                    <p className="mt-4 border-l-2 border-[#f6d28b]/60 pl-3 text-[13.5px] italic leading-relaxed text-[#ffe9c6]">{event.outcome}</p>
                    <button onClick={() => world.dismiss()} className="mt-4 w-full rounded-xl bg-[#f6d28b] py-2.5 text-[12px] font-bold uppercase tracking-[0.2em] text-[#2a160c]">
                      Carry on
                    </button>
                  </>
                ) : (
                  <div className="mt-4 flex flex-col gap-2">
                    {event.choices.map((c, i) => (
                      <button
                        key={i}
                        onClick={() => world.choose(i)}
                        disabled={c.disabled}
                        className="rounded-xl border border-[#f6d28b]/40 px-3 py-2 text-left text-[13px] text-[#fff1da] transition hover:border-[#f6d28b] hover:bg-[#f6d28b]/10 disabled:opacity-35"
                      >
                        {c.label}
                        {c.hint && <span className="ml-2 text-[11px] text-[#f6d28b]/70">{c.hint}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {ended === "fallen" && (
            <div className="absolute inset-0 z-40 flex items-center justify-center bg-gradient-to-b from-[#3a0e04]/70 to-[#120402]/90 p-6">
              <div className="max-w-lg text-center" style={{ animation: "venusrise 1.2s ease-out" }}>
                <div className="text-[11px] uppercase tracking-[0.4em] text-[#ff9a6a]">462 °C · 92 bar</div>
                <h2 className="font-venus mt-3 text-[54px] leading-none text-[#fff1da]">The planet cleaned up.</h2>
                <p className="mt-4 text-[14px] leading-relaxed text-[#f3e3c8]/80">
                  {world.sim.s.cityName} couldn't hold itself up, and fell fifty kilometres into an oven. Instant sterilisation: nothing survives down there. That is the thing about Venus. It is the safest place in the solar system to get something wrong, because the mess never stays.
                </p>
                <p className="mt-3 text-[13px] text-[#f3e3c8]/60">
                  Like a Burning Man shade structure: if it can't stay up, it wasn't built strong enough. Build lighter, or build more lift.
                </p>
                <div className="mt-7 flex justify-center gap-3">
                  <button onClick={() => { setEnded(null); clearSave(); world.restart(); }} className="rounded-full bg-[#fff1da] px-6 py-3 text-[12px] font-bold uppercase tracking-[0.22em] text-[#3a1a0a]">
                    Found a new city
                  </button>
                  <Link to="/" className="rounded-full border border-[#fff1da]/50 px-6 py-3 text-[12px] font-semibold uppercase tracking-[0.22em] text-[#fff1da]">
                    Hub
                  </Link>
                </div>
              </div>
            </div>
          )}

          {ended === "won" && !wonSeen && (
            <div className="absolute inset-0 z-40 flex items-center justify-center bg-gradient-to-b from-transparent to-[#1a0d08]/80 p-6">
              <div className={`${glass} max-w-xl p-7 text-center`} style={{ animation: "venusrise 1.2s ease-out" }}>
                <div className="text-[11px] uppercase tracking-[0.4em] text-[#ffd79a]">Utopia</div>
                <h2 className="font-venus mt-3 text-[50px] leading-none text-[#fff6e6]">Little did they know.</h2>
                <p className="mt-4 text-[14px] leading-relaxed text-[#f3e3c8]/85">
                  The Moon has a railgun. Mars has a tent with a For Rent sign on it. And {world.sim.s.cityName} has {Math.round(world.sim.s.pop).toLocaleString()} people, a jazz scene, a Habsburg season and a sunset every nine days, riding the wind at a hundred kilometres an hour in perfect calm. Everybody looked at the surface. You looked up.
                </p>
                <div className="mt-6 flex justify-center gap-3">
                  <button onClick={() => setWonSeen(true)} className="rounded-full bg-[#fff1da] px-6 py-3 text-[12px] font-bold uppercase tracking-[0.22em] text-[#3a1a0a]">
                    Keep building
                  </button>
                  <Link to="/" className="rounded-full border border-[#fff1da]/50 px-6 py-3 text-[12px] font-semibold uppercase tracking-[0.22em] text-[#fff1da]">
                    Hub
                  </Link>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
