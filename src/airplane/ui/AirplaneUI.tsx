/**
 * Everything on top of the canvas.
 *
 * The rule this whole layer is written to: **the instruments are in the
 * cockpit, not up here.** A HUD showing airspeed and altitude would make the
 * game much easier and would delete the thing it is about, which is reading a
 * 1979 panel while somebody screams at you about a leaflet. So the overlay
 * carries only what the panel physically cannot: what somebody just said, what
 * the cabin needs, and how much nerve Striker has left.
 *
 * The one exception is the touch controls, which exist because a yoke is not a
 * thing a phone has.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Engine } from "../engine/core";
import type { GameService, Phase, Result } from "../play/game";
import type { CabinService } from "../play/cabin";
import type { AircraftService } from "../play/aircraft";
import type { InputService } from "../engine/input";
import { SPEAKER_COLORS, SPEAKER_NAMES } from "../play/script";
import { FLIGHT } from "../flight/airframe";

interface Props {
  engine: Engine;
  ready: boolean;
  progress: { stage: string; fraction: number };
}

/** One shared 12 Hz tick. Sixty React renders a second is a dropped frame. */
function usePoll(engine: Engine | null, hz = 12): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!engine) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000 / hz);
    return () => window.clearInterval(id);
  }, [engine, hz]);
  return 0;
}

export default function AirplaneUI({ engine, ready, progress }: Props) {
  usePoll(engine);
  const svc = engine.ctx.services;
  const game = svc.game as GameService | undefined;
  const cabin = svc.crises as CabinService | undefined;
  const air = svc.flight as AircraftService | undefined;
  const input = svc.input as InputService | undefined;

  const phase: Phase = game?.phase ?? "menu";
  const [muted, setMuted] = useState(false);
  const [touch, setTouch] = useState(false);

  useEffect(() => {
    const onTouch = () => setTouch(true);
    window.addEventListener("touchstart", onTouch, { once: true, passive: true });
    return () => window.removeEventListener("touchstart", onTouch);
  }, []);

  // The audio context cannot start until the player has done something. Any
  // gesture will do, and the menu button is the first one there is.
  const unlock = () => {
    (svc.audio as { unlock?: () => void } | undefined)?.unlock?.();
  };

  if (!ready) return <LoadingScreen progress={progress} />;

  return (
    <div data-209-ui className="pointer-events-none absolute inset-0 select-none">
      {phase === "menu" && (
        <Menu
          onStart={() => {
            unlock();
            game?.begin();
          }}
          onApproach={() => {
            unlock();
            game?.beginAtApproach();
          }}
        />
      )}

      {phase !== "menu" && phase !== "over" && (
        <>
          <TopBar game={game} air={air} muted={muted} onMute={() => {
            const next = !muted;
            setMuted(next);
            (svc.audio as { setMuted?: (m: boolean) => void } | undefined)?.setMuted?.(next);
          }} />
          <NerveMeter game={game} />
          <Subtitle game={game} />
          <CabinPanel cabin={cabin} />
          {game?.inFlashback && <FlashbackWash />}
          {touch && <TouchControls input={input} air={air} />}
          {!touch && <KeyHints phase={phase} />}
        </>
      )}

      {phase === "over" && game?.result && (
        <ResultsScreen result={game.result} onAgain={() => game.restart()} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function LoadingScreen({ progress }: { progress: { stage: string; fraction: number } }) {
  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-[#07080c] px-8 text-center">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.5em] text-amber-500/70">
        Trans American
      </div>
      <h1 className="text-4xl font-black tracking-tight text-white sm:text-6xl">FLIGHT 209</h1>
      <p className="mt-2 max-w-md text-sm text-white/50">
        Los Angeles to Chicago. The crew had the fish.
      </p>
      <div className="mt-8 h-[3px] w-64 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full bg-amber-400 transition-[width] duration-300"
          style={{ width: `${Math.round(progress.fraction * 100)}%` }}
        />
      </div>
      <div className="mt-3 font-mono text-[11px] text-white/40">{progress.stage}…</div>
    </div>
  );
}

function Menu({ onStart, onApproach }: { onStart: () => void; onApproach: () => void }) {
  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex flex-col items-center justify-center bg-gradient-to-b from-[#07080c]/95 via-[#0b0a10]/90 to-[#07080c]/95 px-6 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.5em] text-amber-500/70">
        Trans American
      </div>
      <h1 className="mt-1 text-5xl font-black tracking-tight text-white sm:text-7xl">
        FLIGHT 209
      </h1>
      <p className="mt-3 max-w-lg text-sm leading-relaxed text-white/60">
        A Boeing 707 out of Los Angeles, a thunderstorm over Chicago, and{" "}
        {FLIGHT.souls} people behind you. The captain, the first officer and the
        flight engineer all had the fish.
      </p>
      <p className="mt-2 max-w-lg text-sm text-white/40">You did not. You are in the left seat.</p>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <button
          onClick={onStart}
          className="rounded-sm border border-amber-400/70 bg-amber-400/10 px-8 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-amber-200 transition hover:bg-amber-400/25"
        >
          Take the seat
        </button>
        <button
          onClick={onApproach}
          className="rounded-sm border border-white/20 px-8 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-white/70 transition hover:bg-white/10"
        >
          Skip to the approach
        </button>
      </div>

      <div className="mt-10 grid max-w-xl grid-cols-2 gap-x-8 gap-y-1.5 text-left font-mono text-[11px] text-white/45 sm:grid-cols-3">
        <span>
          <b className="text-white/70">W S</b> yoke
        </span>
        <span>
          <b className="text-white/70">A D</b> wheel
        </span>
        <span>
          <b className="text-white/70">Q E</b> rudder
        </span>
        <span>
          <b className="text-white/70">Shift Ctrl</b> thrust
        </span>
        <span>
          <b className="text-white/70">G</b> gear
        </span>
        <span>
          <b className="text-white/70">F R</b> flaps
        </span>
        <span>
          <b className="text-white/70">[ ]</b> trim
        </span>
        <span>
          <b className="text-white/70">B</b> brakes
        </span>
        <span>
          <b className="text-white/70">O</b> autopilot
        </span>
        <span>
          <b className="text-white/70">1–4</b> answer the cabin
        </span>
        <span>
          <b className="text-white/70">Space</b> answer the radio
        </span>
        <span>
          <b className="text-white/70">C</b> camera
        </span>
      </div>

      <p className="mt-6 max-w-lg text-[11px] leading-relaxed text-white/30">
        Everything you need to fly is on the panel: attitude in the middle,
        airspeed left, altitude right. Hold the right mouse button to look
        around the flight deck.
      </p>

      <Link
        to="/"
        className="pointer-events-auto mt-8 font-mono text-[10px] uppercase tracking-[0.35em] text-white/30 transition hover:text-white/60"
      >
        ← the vibeverse
      </Link>
    </div>
  );
}

function TopBar({
  game,
  air,
  muted,
  onMute,
}: {
  game?: GameService;
  air?: AircraftService;
  muted: boolean;
  onMute: () => void;
}) {
  const s = air?.state;
  return (
    <div className="absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3 sm:p-4">
      <div className="rounded-sm border border-white/10 bg-black/40 px-3 py-1.5 backdrop-blur-sm">
        <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-amber-400/80">
          TA 209 · ORD
        </div>
        {game?.objective && (
          <div className="mt-0.5 text-[12px] font-medium text-white/85 sm:text-sm">
            {game.objective}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* Not instruments — states. The numbers stay on the panel. */}
        {s && (
          <div className="hidden rounded-sm border border-white/10 bg-black/40 px-2.5 py-1.5 font-mono text-[10px] text-white/55 backdrop-blur-sm sm:block">
            <span className={s.gear.position > 0.98 ? "text-emerald-400" : s.gear.position > 0.01 ? "text-amber-400" : ""}>
              GEAR {s.gear.position > 0.98 ? "DN" : s.gear.position > 0.01 ? "···" : "UP"}
            </span>
            <span className="mx-2 text-white/20">|</span>
            <span>FLAP {Math.round(s.flapAngle)}°</span>
            <span className="mx-2 text-white/20">|</span>
            <span className={air?.ap.state.engaged ? "text-sky-400" : ""}>
              OTTO {air?.ap.state.engaged ? "ON" : air && air.ap.failed ? "FLAT" : "OFF"}
            </span>
          </div>
        )}
        <button
          onClick={onMute}
          className="pointer-events-auto rounded-sm border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest text-white/50 backdrop-blur-sm transition hover:text-white"
        >
          {muted ? "🔇" : "🔊"}
        </button>
        <Link
          to="/"
          className="pointer-events-auto rounded-sm border border-white/10 bg-black/40 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-white/50 backdrop-blur-sm transition hover:text-white"
        >
          exit
        </Link>
      </div>
    </div>
  );
}

/**
 * Nerve.
 *
 * Deliberately not a bar with a number on it. It is a thin strip that you only
 * notice when it is going, and below a third it starts to breathe — because
 * the moment you should be feeling is "something is wrong with me", not
 * "resource at 28%".
 */
function NerveMeter({ game }: { game?: GameService }) {
  if (!game) return null;
  const n = game.nerve;
  const low = n < 0.34;
  return (
    <div className="absolute left-3 top-1/2 z-20 -translate-y-1/2 sm:left-5">
      <div
        className="relative h-40 w-[5px] overflow-hidden rounded-full bg-white/10 sm:h-52"
        style={{ opacity: n > 0.85 ? 0.35 : 1, transition: "opacity 600ms" }}
      >
        <div
          className="absolute bottom-0 w-full rounded-full transition-[height,background-color] duration-300"
          style={{
            height: `${n * 100}%`,
            background: low ? "#ff4d4d" : n < 0.6 ? "#ffb020" : "#7dffb0",
            animation: low ? "pulse 1.1s ease-in-out infinite" : undefined,
          }}
        />
      </div>
      <div
        className="mt-2 -rotate-90 whitespace-nowrap font-mono text-[8px] uppercase tracking-[0.3em]"
        style={{ color: low ? "#ff8080" : "rgba(255,255,255,0.35)" }}
      >
        nerve
      </div>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}`}</style>
    </div>
  );
}

function Subtitle({ game }: { game?: GameService }) {
  const line = game?.radio.active;
  const audio = useRef<string>("");
  useEffect(() => {
    if (!line) return;
    audio.current = line.text;
  }, [line]);
  if (!line) return null;

  const name = SPEAKER_NAMES[line.who];
  const color = SPEAKER_COLORS[line.who];
  return (
    <div className="absolute inset-x-0 bottom-[19%] z-20 flex justify-center px-4 sm:bottom-[16%]">
      <div
        className="max-w-2xl rounded-sm border-l-2 bg-black/60 px-4 py-2.5 backdrop-blur-sm"
        style={{ borderColor: color }}
      >
        {name && (
          <div
            className="font-mono text-[9px] uppercase tracking-[0.3em]"
            style={{ color }}
          >
            {name}
            {line.radio && <span className="ml-2 text-white/30">· radio</span>}
          </div>
        )}
        <p
          className={`mt-0.5 text-[13px] leading-snug sm:text-[15px] ${
            line.who === "SYSTEM" ? "italic text-white/65" : "text-white/95"
          }`}
        >
          {line.text}
        </p>
        {line.reply && !line.answered && (
          <div className="mt-1.5 animate-pulse font-mono text-[10px] uppercase tracking-[0.2em] text-amber-300">
            press space — {line.reply}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The cabin.
 *
 * Bottom-right, deliberately away from the panel's basic T, so that answering
 * it genuinely costs you a look away from the attitude indicator. Putting it
 * in the middle of the screen would be kinder and would remove the mechanic.
 */
function CabinPanel({ cabin }: { cabin?: CabinService }) {
  const active = cabin?.active;
  if (!cabin || !active) return null;
  const { crisis, remaining, chosen } = active;
  const frac = Math.max(0, remaining / crisis.timeout);

  return (
    <div className="pointer-events-auto absolute bottom-3 right-3 z-30 w-[min(92vw,23rem)] sm:bottom-5 sm:right-5">
      <div className="overflow-hidden rounded-sm border border-amber-400/30 bg-black/75 backdrop-blur-md">
        <div className="h-[2px] w-full bg-white/10">
          <div
            className="h-full bg-amber-400 transition-[width] duration-200 ease-linear"
            style={{ width: `${frac * 100}%` }}
          />
        </div>
        <div className="p-3">
          <div
            className="font-mono text-[9px] uppercase tracking-[0.3em]"
            style={{ color: SPEAKER_COLORS[crisis.who] }}
          >
            {SPEAKER_NAMES[crisis.who] || "the cabin"}
          </div>
          <p className="mt-1 text-[13px] leading-snug text-white/90">{crisis.prompt}</p>

          {chosen < 0 ? (
            <div className="mt-2.5 flex flex-col gap-1.5">
              {crisis.choices.map((c, i) => (
                <button
                  key={c.label}
                  onClick={() => cabin.choose(i)}
                  className="group flex items-start gap-2 rounded-sm border border-white/10 px-2.5 py-1.5 text-left text-[12px] text-white/80 transition hover:border-amber-400/50 hover:bg-amber-400/10 hover:text-white"
                >
                  <span className="mt-[1px] font-mono text-[10px] text-amber-400/70 group-hover:text-amber-300">
                    {i + 1}
                  </span>
                  <span>{c.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.25em] text-emerald-400/80">
              {crisis.choices[chosen]?.best ? "handled" : "…handled"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The screen going soft while Striker is somewhere else. */
function FlashbackWash() {
  return (
    <div
      className="absolute inset-0 z-10"
      style={{
        background:
          "radial-gradient(ellipse at center, rgba(255,235,200,0.06) 0%, rgba(120,60,20,0.30) 55%, rgba(20,8,0,0.62) 100%)",
        animation: "flashbackIn 700ms ease-out",
      }}
    >
      <style>{`@keyframes flashbackIn{from{opacity:0}to{opacity:1}}`}</style>
    </div>
  );
}

function KeyHints({ phase }: { phase: Phase }) {
  const hint =
    phase === "approach"
      ? "F flaps · G gear · Shift/Ctrl thrust"
      : phase === "final"
        ? "W/S yoke · A/D wheel · fly the magenta bars"
        : phase === "rollout"
          ? "B brakes"
          : "1–4 answer the cabin · Space answer the radio";
  return (
    <div className="absolute inset-x-0 bottom-2 z-10 hidden justify-center font-mono text-[10px] tracking-widest text-white/25 sm:flex">
      {hint}
    </div>
  );
}

/**
 * Touch controls.
 *
 * A yoke on the left as a free-drag pad, thrust on the right as a vertical
 * slider, and the four things you press. Deliberately large: this aeroplane
 * needs *small* control inputs held steadily, which is much harder with a
 * thumb than a big input made briefly, so the pad is scaled so that a full
 * thumb sweep is a full yoke deflection and most of the pad is the useful
 * middle.
 */
function TouchControls({ input, air }: { input?: InputService; air?: AircraftService }) {
  const yokeRef = useRef<HTMLDivElement>(null);
  const [yoke, setYoke] = useState({ x: 0, y: 0 });
  const [thrust, setThrust] = useState(0.7);

  const onYoke = (e: React.PointerEvent) => {
    const el = yokeRef.current;
    if (!el || !input) return;
    const r = el.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
    const x = Math.max(-1, Math.min(1, nx));
    const y = Math.max(-1, Math.min(1, ny));
    setYoke({ x, y });
    input.setAxis("roll", x);
    // Screen down is nose down, which is what a yoke does.
    input.setAxis("pitch", -y);
  };

  const releaseYoke = () => {
    setYoke({ x: 0, y: 0 });
    input?.setAxis("roll", 0);
    input?.setAxis("pitch", 0);
  };

  const btn =
    "pointer-events-auto rounded-sm border border-white/20 bg-black/50 px-3 py-2 font-mono text-[11px] uppercase tracking-widest text-white/80 backdrop-blur-sm active:bg-white/20";

  return (
    <>
      <div
        ref={yokeRef}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          onYoke(e);
        }}
        onPointerMove={(e) => e.buttons && onYoke(e)}
        onPointerUp={releaseYoke}
        onPointerCancel={releaseYoke}
        className="pointer-events-auto absolute bottom-4 left-4 z-30 h-32 w-32 touch-none rounded-full border border-white/15 bg-black/30 backdrop-blur-sm"
      >
        <div
          className="absolute h-9 w-9 rounded-full border border-amber-300/60 bg-amber-300/20"
          style={{
            left: `calc(50% + ${yoke.x * 44}px - 18px)`,
            top: `calc(50% + ${yoke.y * 44}px - 18px)`,
          }}
        />
      </div>

      <div className="pointer-events-auto absolute bottom-4 right-4 z-30 flex flex-col items-end gap-2">
        <div className="flex gap-1.5">
          <button className={btn} onClick={() => input?.press("gear")}>
            gear
          </button>
          <button className={btn} onClick={() => input?.press("flapsDown")}>
            flap ▼
          </button>
          <button className={btn} onClick={() => input?.press("flapsUp")}>
            flap ▲
          </button>
        </div>
        <div className="flex items-end gap-1.5">
          <button
            className={btn}
            onPointerDown={() => input?.setAxis("yaw", -1)}
            onPointerUp={() => input?.setAxis("yaw", 0)}
          >
            ◀
          </button>
          <button
            className={btn}
            onPointerDown={() => input?.setAxis("yaw", 1)}
            onPointerUp={() => input?.setAxis("yaw", 0)}
          >
            ▶
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={thrust}
            onChange={(e) => {
              const v = Number(e.target.value);
              setThrust(v);
              input?.setAxis("throttle", v);
            }}
            className="h-32 w-8 touch-none accent-amber-400"
            style={{ writingMode: "vertical-lr", direction: "rtl" }}
            aria-label="thrust levers"
          />
        </div>
        <div className="font-mono text-[9px] uppercase tracking-widest text-white/40">
          N1 {Math.round((air?.state.n1[0] ?? 0) * 100)}%
        </div>
      </div>
    </>
  );
}

function ResultsScreen({ result, onAgain }: { result: Result; onAgain: () => void }) {
  const headline = result.crashed
    ? "Trans American 209 did not make it."
    : result.landed
      ? "Trans American 209 is down."
      : "The flight ended.";

  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-black/80 px-5 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-sm border border-white/15 bg-[#0a0b0f]/95 p-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.4em] text-amber-400/70">
          Chicago O'Hare · runway 09
        </div>
        <h2 className="mt-1 text-2xl font-bold text-white sm:text-3xl">{headline}</h2>
        <div
          className={`mt-1 font-mono text-[11px] uppercase tracking-[0.2em] ${
            result.crashed ? "text-red-400" : "text-emerald-400"
          }`}
        >
          {result.grade}
        </div>

        <div className="my-5 flex items-end gap-4">
          <div className="text-5xl font-black tabular-nums text-white">{result.score}</div>
          <div className="pb-1.5 font-mono text-[10px] uppercase tracking-widest text-white/40">
            out of 100
          </div>
        </div>

        <ul className="space-y-1 text-[13px] leading-relaxed text-white/70">
          {result.notes.map((n) => (
            <li key={n} className="flex gap-2">
              <span className="text-white/25">·</span>
              <span>{n}</span>
            </li>
          ))}
        </ul>

        <div className="mt-4 grid grid-cols-3 gap-2 border-t border-white/10 pt-4 font-mono text-[10px] uppercase tracking-widest text-white/40">
          <div>
            <div className="text-lg font-bold tabular-nums text-white/85">
              {result.soulsCalm}
            </div>
            calm of {FLIGHT.souls}
          </div>
          <div>
            <div className="text-lg font-bold tabular-nums text-white/85">
              {Math.round(result.nerve * 100)}%
            </div>
            nerve left
          </div>
          <div>
            <div className="text-lg font-bold tabular-nums text-white/85">
              {result.flashbacks}
            </div>
            flashbacks
          </div>
        </div>

        <div className="mt-6 flex gap-3">
          <button
            onClick={onAgain}
            className="rounded-sm border border-amber-400/70 bg-amber-400/10 px-6 py-2.5 text-sm font-semibold uppercase tracking-[0.2em] text-amber-200 transition hover:bg-amber-400/25"
          >
            Fly it again
          </button>
          <Link
            to="/"
            className="rounded-sm border border-white/20 px-6 py-2.5 text-sm font-semibold uppercase tracking-[0.2em] text-white/70 transition hover:bg-white/10"
          >
            The vibeverse
          </Link>
        </div>
      </div>
    </div>
  );
}
