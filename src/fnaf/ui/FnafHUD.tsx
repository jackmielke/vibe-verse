/**
 * Everything drawn on top of the canvas: the clock, the battery, the buttons
 * you can actually hit with a thumb, and the monitor.
 *
 * The monitor is deliberately *not* a second render target. The canvas
 * underneath is already showing the security camera's view of the room; this
 * layer is the tape hiss, the scanlines, the bezel and the map on top of it.
 * Which is what a CCTV monitor is.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { FnafSnapshot, FnafEngine, Side } from "../engine";
import { CAMERA_ORDER, MAP_POINTS, ROOMS, type RoomId } from "../rooms";

const HOURS = ["12 AM", "1 AM", "2 AM", "3 AM", "4 AM", "5 AM", "6 AM"];

/** One small tile of white noise, reused as a CSS background everywhere. */
function useNoiseUrl() {
  return useMemo(() => {
    if (typeof document === "undefined") return "";
    const el = document.createElement("canvas");
    el.width = el.height = 128;
    const c = el.getContext("2d")!;
    const img = c.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 26 + Math.random() * 60;
    }
    c.putImageData(img, 0, 0);
    return el.toDataURL();
  }, []);
}

export default function FnafHUD({
  engine,
  state,
  onRetry,
  onNext,
}: {
  engine: FnafEngine;
  state: FnafSnapshot;
  onRetry: () => void;
  onNext: () => void;
}) {
  const noise = useNoiseUrl();
  const [jitter, setJitter] = useState(0);

  // The static has to actually move or the eye stops believing it.
  useEffect(() => {
    if (!state.monitorUp && state.phase !== "dead") return;
    let raf = 0;
    const tick = () => {
      setJitter(Math.random());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state.monitorUp, state.phase]);

  const playing = state.phase === "playing";
  const bars = Math.min(5, state.usage);
  const low = state.power <= 20;
  // The monitor takes six seconds to come back after you drop it. Looking is
  // free; looking *again straight away* is what costs you.
  const cooling = !state.monitorUp && state.camCooldown > 0;
  // A thirty-second limit you cannot see is a trap, so the monitor wears its
  // own countdown. Amber at ten, red at five.
  const left = state.camUptime;
  const uptimeTone = left <= 5 ? "bg-red-500" : left <= 10 ? "bg-amber-400" : "bg-emerald-400";

  // Power is only ever spent at the moment you press something, so the press
  // has to show its price — otherwise the meter drops for no visible reason.
  const [charge, setCharge] = useState<{ amount: number; label: string } | null>(null);
  const spendAt = state.lastSpend?.at ?? null;
  useEffect(() => {
    if (!state.lastSpend) {
      setCharge(null);
      return;
    }
    setCharge({ amount: state.lastSpend.amount, label: state.lastSpend.label });
    const id = window.setTimeout(() => setCharge(null), 1100);
    return () => window.clearTimeout(id);
  }, [spendAt, state.lastSpend]);

  const doorBtn = (side: Side) => (
    <button
      onClick={() => engine.toggleDoor(side)}
      disabled={!playing || state.monitorUp || state.blackout}
      className={`pointer-events-auto flex h-16 w-16 flex-col items-center justify-center rounded-md border text-[9px] font-bold uppercase tracking-[0.14em] transition ${
        state.doors[side]
          ? "border-red-400/80 bg-red-600/70 text-white shadow-[0_0_26px_rgba(248,113,113,0.55)]"
          : "border-white/20 bg-black/55 text-white/55 hover:border-white/40 hover:text-white/80"
      } disabled:opacity-25`}
    >
      <span className="text-lg leading-none">▤</span>
      <span className="mt-1">Door</span>
    </button>
  );

  const lightBtn = (side: Side) => (
    <button
      onClick={() => engine.toggleLight(side)}
      disabled={!playing || state.monitorUp || state.blackout}
      className={`pointer-events-auto flex h-16 w-16 flex-col items-center justify-center rounded-md border text-[9px] font-bold uppercase tracking-[0.14em] transition ${
        state.lights[side]
          ? "border-amber-200/80 bg-amber-300/80 text-slate-900 shadow-[0_0_26px_rgba(253,230,138,0.6)]"
          : "border-white/20 bg-black/55 text-white/55 hover:border-white/40 hover:text-white/80"
      } disabled:opacity-25`}
    >
      <span className="text-lg leading-none">☀</span>
      <span className="mt-1">Light</span>
    </button>
  );

  return (
    <div className="pointer-events-none absolute inset-0 select-none font-mono">
      {/* ---------------------------------------------------- camera monitor */}
      {state.monitorUp && (
        <div className="absolute inset-0">
          {/* Tape hiss over the live feed. */}
          <div
            className="absolute inset-0 opacity-[0.35] mix-blend-screen"
            style={{
              backgroundImage: `url(${noise})`,
              backgroundPosition: `${jitter * 128}px ${jitter * 77}px`,
            }}
          />
          {/* Scanlines + the tube's vignette. */}
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                "repeating-linear-gradient(to bottom, rgba(0,0,0,0.32) 0px, rgba(0,0,0,0.32) 1px, transparent 2px, transparent 4px)",
            }}
          />
          <div
            className="absolute inset-0"
            style={{ boxShadow: "inset 0 0 220px 60px rgba(0,0,0,0.85)" }}
          />
          {/* One rolling bright bar, drifting down the screen. */}
          <div
            className="absolute inset-x-0 h-24 bg-white/[0.045]"
            style={{ top: `${((Date.now() / 24) % 130) - 15}%` }}
          />

          <div className="absolute left-6 top-24 text-emerald-300/80">
            <div className="text-[11px] tracking-[0.35em]">CAM {ROOMS[state.camera].code}</div>
            <div className="mt-1 text-xl font-bold tracking-wide text-emerald-100/90">
              {ROOMS[state.camera].name.toUpperCase()}
            </div>
          </div>
          {/* Uptime. The tablet gives you thirty seconds and then falls over. */}
          <div className="absolute inset-x-0 top-0 h-1 bg-black/50">
            <div
              className={`h-full origin-left transition-[transform,background-color] duration-200 ${uptimeTone}`}
              style={{ transform: `scaleX(${Math.max(0, left / 30)})` }}
            />
          </div>
          <div className="absolute right-6 top-6 flex items-center gap-3">
            <span
              className={`text-[11px] font-bold tracking-[0.25em] ${
                left <= 5 ? "animate-pulse text-red-400" : left <= 10 ? "text-amber-300" : "text-emerald-300/70"
              }`}
            >
              {Math.ceil(left)}s
            </span>
            <span className="flex items-center gap-2 text-red-400/90">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
              <span className="text-[11px] tracking-[0.3em]">REC</span>
            </span>
          </div>

          {ROOMS[state.camera].camBroken && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div
                className="absolute inset-0 bg-black/95"
                style={{ backgroundImage: `url(${noise})`, backgroundPosition: `${jitter * 200}px 0` }}
              />
              <div className="relative text-center">
                <div className="text-3xl font-black tracking-[0.3em] text-emerald-200/80">AUDIO ONLY</div>
                <div className="mt-2 text-[11px] tracking-[0.25em] text-emerald-300/50">
                  VIDEO FEED UNAVAILABLE — CAMERA 6
                </div>
              </div>
            </div>
          )}

          {/* The map. Rooms you can switch to, and where they are. */}
          <div className="pointer-events-auto absolute bottom-6 right-6 w-[min(38vw,290px)] rounded border border-emerald-400/30 bg-black/92 p-3">
            <div className="mb-2 text-[9px] tracking-[0.3em] text-emerald-300/50">CAMERA MAP</div>
            <div className="relative aspect-[4/5] w-full rounded-sm border border-emerald-400/15 bg-emerald-950/60">
              {/* The office, marked so you always know where you are. */}
              <div
                className="absolute -translate-x-1/2 -translate-y-1/2 rounded-sm border border-amber-300/60 bg-amber-300/15 px-2 py-1 text-[8px] tracking-[0.2em] text-amber-200/90"
                style={{ left: `${MAP_POINTS.office.x * 100}%`, top: `${MAP_POINTS.office.y * 100}%` }}
              >
                YOU
              </div>
              {CAMERA_ORDER.map((id, i) => {
                const p = MAP_POINTS[id];
                const active = state.camera === id;
                const here = state.occupancy[id]?.length;
                return (
                  <button
                    key={id}
                    onClick={() => engine.selectCamera(id)}
                    className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-sm border px-1.5 py-1 text-[8px] font-bold tracking-[0.12em] transition ${
                      active
                        ? "border-emerald-300 bg-emerald-400/80 text-black"
                        : "border-emerald-400/40 bg-black/70 text-emerald-200/80 hover:border-emerald-300 hover:text-emerald-100"
                    }`}
                    style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
                    title={`${ROOMS[id].name} — press ${"1234567890-"[i]}`}
                  >
                    {ROOMS[id].code}
                    {/* No names, no dots for who is where. You have to look. */}
                    {here && active ? <span className="ml-1 text-red-500">●</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* The fault. Same reboot as dropping the monitor yourself — but this one
          was not your idea, so it says so out loud. */}
      {state.camFault && state.camCooldown > 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className="absolute inset-0 opacity-25 mix-blend-screen"
            style={{ backgroundImage: `url(${noise})`, backgroundPosition: `${jitter * 220}px ${jitter * 90}px` }}
          />
          <div className="relative border border-red-500/40 bg-black/80 px-7 py-5 text-center backdrop-blur-sm">
            <div className="text-[10px] tracking-[0.45em] text-red-400/70">CAMERA SYSTEM</div>
            <div className="mt-1.5 text-2xl font-black tracking-[0.18em] text-red-500">ERROR</div>
            <div className="mt-3 text-[11px] tracking-[0.28em] text-white/50">
              REBOOTING — {Math.ceil(state.camCooldown)}s
            </div>
          </div>
        </div>
      )}

      {/* --------------------------------------------------------- office HUD */}
      {!state.monitorUp && !state.blackout && playing && (
        <>
          <div className="absolute left-4 top-1/2 flex -translate-y-1/2 flex-col gap-3 sm:left-8">
            {doorBtn("left")}
            {lightBtn("left")}
          </div>
          <div className="absolute right-4 top-1/2 flex -translate-y-1/2 flex-col gap-3 sm:right-8">
            {doorBtn("right")}
            {lightBtn("right")}
          </div>
        </>
      )}

      {/* ------------------------------------------------------- clock + power */}
      {state.phase !== "dead" && (
        <>
        <div className="absolute right-6 top-5 text-right text-white/90">
          <div className="text-3xl font-black tracking-tight sm:text-4xl">{HOURS[Math.min(6, state.hour)]}</div>
          <div className="text-[10px] tracking-[0.3em] text-white/45">NIGHT {state.night}</div>
        </div>

        <div className="absolute left-6 top-5">
          <div className={`text-[11px] tracking-[0.25em] ${low ? "text-red-400" : "text-white/60"}`}>
            POWER LEFT: <span className="font-bold">{Math.ceil(state.power)}%</span>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <span className="mr-1 text-[10px] tracking-[0.2em] text-white/40">IN USE</span>
            {[1, 2, 3, 4, 5].map((i) => (
              <span
                key={i}
                className={`h-3.5 w-2.5 rounded-[1px] ${
                  i <= bars
                    ? i >= 4
                      ? "bg-red-500"
                      : i === 3
                        ? "bg-amber-400"
                        : "bg-emerald-400"
                    : "bg-white/12"
                }`}
              />
            ))}
          </div>
          <div className="mt-2 h-1 w-40 overflow-hidden rounded-full bg-white/10">
            <div
              className={`h-full transition-[width] duration-300 ${low ? "bg-red-500" : "bg-emerald-400"}`}
              style={{ width: `${state.power}%` }}
            />
          </div>
          {/* Power now only ever moves on a press, so the press has to name its
              own price — otherwise the meter drops for no visible reason. */}
          <div className="mt-1.5 h-3">
            {charge ? (
              <span className="text-[10px] font-bold tracking-[0.2em] text-red-400">
                −{charge.amount}% {charge.label.toUpperCase()}
              </span>
            ) : null}
          </div>
        </div>

        </>
      )}

      {/* ------------------------------------------------------- monitor pull */}
      {playing && !state.blackout && (
        <button
          onClick={() => engine.toggleMonitor()}
          disabled={cooling}
          className={`pointer-events-auto absolute bottom-0 left-1/2 w-[min(70vw,520px)] -translate-x-1/2 overflow-hidden rounded-t-xl border border-b-0 px-6 pb-3 pt-2 text-center backdrop-blur transition ${
            cooling
              ? "cursor-not-allowed border-white/10 bg-black/85"
              : "border-white/15 bg-black/75 hover:bg-black/90"
          }`}
        >
          {/* The cooldown drains left to right across the tab itself, so the
              wait is a thing you watch rather than a number you read. */}
          {cooling && (
            <span
              className="absolute inset-0 origin-left bg-white/[0.07]"
              style={{ transform: `scaleX(${state.camCooldown / 6})` }}
              aria-hidden
            />
          )}
          <span className="relative block">
            <span className="mx-auto mb-1.5 block h-1 w-16 rounded-full bg-white/30" />
            <span
              className={`block text-[11px] font-bold tracking-[0.4em] ${
                state.camFault && cooling ? "text-red-400/70" : cooling ? "text-white/35" : "text-white/70"
              }`}
            >
              {state.monitorUp
                ? "CLOSE MONITOR"
                : cooling
                  ? `${state.camFault ? "ERROR — " : ""}REBOOTING ${Math.ceil(state.camCooldown)}s`
                  : "CAMERAS"}
            </span>
          </span>
        </button>
      )}

      {/* ----------------------------------------------------------- messages */}
      {state.toast && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 rounded border border-white/10 bg-black/75 px-4 py-2 text-center text-[11px] tracking-widest text-white/70">
          {state.toast}
        </div>
      )}

      {state.blackout && state.phase === "playing" && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70">
          <div className="text-center">
            <div className="text-[11px] tracking-[0.5em] text-white/25">POWER OUT</div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- endings */}
      {state.phase === "dead" && state.killer !== "vibey" && (
        <>
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${noise})`,
              backgroundPosition: `${jitter * 300}px ${jitter * 300}px`,
              opacity: 0.25 + state.scare * 0.45,
              mixBlendMode: "screen",
            }}
          />
          <div
            className="absolute inset-0 bg-red-900"
            style={{ opacity: state.scare * 0.22 }}
          />
          {state.scare > 0.98 && <DeathCard night={state.night} onRetry={onRetry} />}
        </>
      )}

      {/* Vibey found you. No static, no red, no screech — a party. */}
      {state.phase === "dead" && state.killer === "vibey" && (
        <PartyCard night={state.night} onRetry={onRetry} />
      )}

      {state.phase === "won" && <SunriseCard night={state.night} onNext={onNext} />}

      {/* Getting out. Only offered when nothing is chasing you. */}
      {(state.phase === "won" || state.phase === "dead") && (
        <Link
          to="/"
          className="pointer-events-auto absolute bottom-5 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-[0.35em] text-white/30 transition hover:text-white/70"
        >
          ← back to the vibeverse
        </Link>
      )}
    </div>
  );
}

/**
 * The other ending.
 *
 * Being caught by Vibey still costs you the night, but nothing about this
 * screen is a punishment: confetti, a warm wash instead of red static, and a
 * hello-then-goodbye that arrives in the same order the audio does. The whole
 * reason he is in the building is that one of the five should be a delight to
 * meet.
 */
function PartyCard({ night, onRetry }: { night: number; onRetry: () => void }) {
  const [stage, setStage] = useState<"hi" | "party" | "bye">("hi");
  useEffect(() => {
    const a = window.setTimeout(() => setStage("party"), 700);
    const b = window.setTimeout(() => setStage("bye"), 2600);
    return () => {
      window.clearTimeout(a);
      window.clearTimeout(b);
    };
  }, []);

  const confetti = useMemo(
    () =>
      Array.from({ length: 54 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 2.2,
        dur: 2.4 + Math.random() * 2.2,
        size: 6 + Math.random() * 9,
        tilt: Math.random() * 360,
        color: ["#ffd23f", "#ff70a6", "#59d2fe", "#7bf1a8", "#c084fc", "#ff9f45"][i % 6],
      })),
    [],
  );

  return (
    <div className="pointer-events-none absolute inset-0">
      <style>{`@keyframes fnaf-confetti {
        0% { transform: translateY(-12vh) rotate(0deg); opacity: 0; }
        8% { opacity: 1; }
        100% { transform: translateY(112vh) rotate(720deg); opacity: 0.9; }
      }`}</style>
      <div className="absolute inset-0 bg-gradient-to-b from-sky-300/10 via-fuchsia-300/5 to-amber-200/10" />
      {confetti.map((c, i) => (
        <span
          key={i}
          className="absolute top-0 block rounded-[2px]"
          style={{
            left: `${c.left}%`,
            width: c.size,
            height: c.size * 0.6,
            background: c.color,
            transform: `rotate(${c.tilt}deg)`,
            animation: `fnaf-confetti ${c.dur}s linear ${c.delay}s infinite`,
          }}
        />
      ))}

      <div className="absolute inset-x-0 bottom-0 top-0 flex flex-col items-center justify-end pb-16">
        <div className="rounded-2xl border border-white/15 bg-black/55 px-8 py-5 text-center backdrop-blur-md">
          <div className="text-4xl font-black tracking-tight text-white drop-shadow sm:text-5xl">
            {stage === "hi" ? "hi!" : stage === "party" ? "🎉" : "bye!"}
          </div>
          <p className="mt-2 text-[11px] tracking-[0.28em] text-white/70">VIBEY FOUND YOU</p>
          {stage === "bye" && (
            <>
              <p className="mt-3 max-w-xs text-xs leading-relaxed text-white/45">
                He only wanted to say hello. Your shift is over anyway — night {night}
                {" "}ends here.
              </p>
              <button
                onClick={onRetry}
                className="pointer-events-auto mt-5 rounded-full border border-white/25 bg-white/15 px-9 py-2.5 text-[11px] font-bold uppercase tracking-[0.28em] text-white transition hover:bg-white/25"
              >
                Another night
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DeathCard({ night, onRetry }: { night: number; onRetry: () => void }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setShow(true), 1400);
    return () => window.clearTimeout(id);
  }, []);
  if (!show) return null;
  return (
    <div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center bg-black/92">
      <div className="text-[10px] tracking-[0.5em] text-red-500/70">SHIFT TERMINATED</div>
      <h2 className="mt-3 text-5xl font-black tracking-tight text-red-500">NIGHT {night}</h2>
      <p className="mt-4 max-w-sm text-center text-xs leading-relaxed tracking-wide text-white/40">
        They found the suit. They always find the suit.
      </p>
      <button
        onClick={onRetry}
        className="mt-8 rounded-full border border-red-500/40 bg-red-600/20 px-10 py-3 text-[11px] font-bold uppercase tracking-[0.3em] text-red-200 transition hover:bg-red-600/40"
      >
        Try again
      </button>
    </div>
  );
}

function SunriseCard({ night, onNext }: { night: number; onNext: () => void }) {
  return (
    <div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-amber-200/10 via-black/90 to-black/95">
      <div className="text-[10px] tracking-[0.5em] text-amber-300/70">6 AM</div>
      <h2 className="mt-3 text-6xl font-black tracking-tight text-amber-200">YOU MADE IT</h2>
      <p className="mt-4 text-xs tracking-[0.25em] text-white/40">NIGHT {night} COMPLETE</p>
      <button
        onClick={onNext}
        className="mt-8 rounded-full border border-amber-300/40 bg-amber-300/15 px-10 py-3 text-[11px] font-bold uppercase tracking-[0.3em] text-amber-100 transition hover:bg-amber-300/30"
      >
        Next night
      </button>
    </div>
  );
}

/** Room ids the monitor knows about — exported for the page's night summary. */
export type { RoomId };
