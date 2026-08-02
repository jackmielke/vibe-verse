/**
 * Everything on top of the canvas that is not the HUD: the hangar, the pause
 * card, the radio, the toasts and the ribbon of course progress.
 *
 * The hangar screen is doing more work than it looks like. Choosing an
 * aircraft in most flight games is choosing a skin; here it changes the mass,
 * the wing area, the thrust and six control-law constants, so the blurb for
 * each jet is a promise the flight model actually keeps. The Skyhawk really
 * does roll four times faster than the Phantom. Fat Albert really cannot pull
 * three G.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Engine } from "../engine/core";
import { HANGAR, type JetId } from "../flight/aircraft";
import type { FleetService } from "../play/fleet";
import type { CourseService } from "../play/courses";
import type { GameService, RadioMessage, Achievement } from "../play/game";
import type { InputService } from "../engine/input";
import type { EnvService } from "../world/sky";
import type { AssistLevel } from "../flight/dynamics";
import type { CameraMode } from "../types";
import { isShotMode } from "../engine/core";
import FlightHUD from "./FlightHUD";

type Screen = "hangar" | "flying" | "paused";

interface Props {
  engine: Engine;
  ready: boolean;
  progress: { stage: string; fraction: number };
}

const ASSIST_COPY: Record<AssistLevel, { name: string; blurb: string }> = {
  rookie: {
    name: "Rookie",
    blurb: "Wings level themselves, the wing will not stall, and the jet pulls up if you forget to.",
  },
  angel: {
    name: "Blue Angel",
    blurb: "Fly-by-wire like the real thing: G-command, coordinated rudder, an envelope you can push.",
  },
  ace: {
    name: "Ace",
    blurb: "Raw control law. It will stall, it will depart, and it will not save you.",
  },
};

const CAMERA_COPY: Record<CameraMode, string> = {
  chase: "Chase",
  cockpit: "Cockpit",
  wing: "Wing",
  tower: "Tower",
  cinematic: "Auto",
  free: "Free",
};

export default function AngelsUI({ engine, ready, progress }: Props) {
  // The screenshot harness drives the engine directly and wants the world, not
  // a menu sitting in front of it.
  const shot = isShotMode();
  const [screen, setScreen] = useState<Screen>(shot ? "flying" : "hangar");
  const [jet, setJet] = useState<JetId>("superhornet");
  const [assist, setAssist] = useState<AssistLevel>("angel");
  const [camera, setCamera] = useState<CameraMode>("chase");
  const [radio, setRadio] = useState<RadioMessage[]>([]);
  const [toast, setToast] = useState<Achievement | null>(null);
  const [courseId, setCourseId] = useState<string | null>(null);
  const [hoopProgress, setHoopProgress] = useState({ done: 0, total: 0 });
  const [runTime, setRunTime] = useState(0);
  const [score, setScore] = useState(0);
  const [demoCall, setDemoCall] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [timeOfDay, setTimeOfDay] = useState(0.31);
  const [showAchievements, setShowAchievements] = useState(false);
  const [invertPitch, setInvertPitch] = useState(false);
  const [tilt, setTilt] = useState(false);
  const [wingmen, setWingmen] = useState(5);

  const services = engine.ctx.services;
  const courses = services.courses as CourseService | undefined;
  const game = services.game as GameService | undefined;

  // Pick up whatever the input system restored from localStorage.
  useEffect(() => {
    const input = services.input as InputService | undefined;
    if (input) {
      setInvertPitch(input.settings.invertPitch);
      setTilt(input.settings.tiltRoll);
    }
    const audio = services.audio as { muted: boolean } | undefined;
    if (audio) setMuted(audio.muted);
  }, [services]);

  // Engine events → React state. Everything continuous stays out of here.
  useEffect(() => {
    const offs = [
      engine.on("angels:radio", () => {
        const g = engine.ctx.services.game as GameService | undefined;
        if (g) setRadio([...g.radio]);
      }),
      engine.on("angels:achievement", (a: Achievement) => {
        setToast(a);
        window.setTimeout(() => setToast((cur) => (cur === a ? null : cur)), 5200);
      }),
      engine.on("angels:hoop", (e: { index: number; total: number }) => {
        setHoopProgress({ done: e.index + 1, total: e.total });
      }),
      engine.on("angels:course", (id: string | null) => {
        setCourseId(id);
        const c = engine.ctx.services.courses as CourseService | undefined;
        setHoopProgress({ done: 0, total: id && c ? c.hoops.length : 0 });
      }),
      engine.on("angels:camera", (m: CameraMode) => setCamera(m)),
      engine.on("angels:jet", (id: JetId) => setJet(id)),
      engine.on("angels:assist", (a: AssistLevel) => setAssist(a)),
    ];
    return () => offs.forEach((o) => o());
  }, [engine]);

  // A slow sampler for the few numbers the chrome shows. Four times a second
  // is plenty for a clock and a score, and it keeps React out of the frame.
  useEffect(() => {
    const id = window.setInterval(() => {
      const g = engine.ctx.services.game as GameService | undefined;
      if (!g) return;
      setRunTime(g.runTime);
      setScore(g.score);
      const el = g.demoElement;
      setDemoCall(el ? el.name : null);
    }, 250);
    return () => window.clearInterval(id);
  }, [engine]);

  // Escape and the pause button both land here.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (engine.ctx.input.pausePressed) {
        setScreen((s) => (s === "flying" ? "paused" : s === "paused" ? "flying" : s));
        engine.ctx.input.pausePressed = false;
      }
    }, 60);
    return () => window.clearInterval(id);
  }, [engine]);

  const spec = useMemo(() => HANGAR.find((a) => a.id === jet) ?? HANGAR[0], [jet]);

  function launch(mode: "free" | "course" | "demo", course?: string) {
    const fleet = services.fleet as FleetService | undefined;
    const g = services.game as GameService | undefined;
    (services.audio as { unlock(): void } | undefined)?.unlock();
    fleet?.setJet(jet);
    fleet?.setAssist(assist);
    fleet?.setWingmanCount(wingmen);
    if (mode === "course" && course) {
      g?.setMode("course");
      courses?.load(course);
      fleet?.respawn("high");
    } else if (mode === "demo") {
      g?.setMode("demo");
    } else {
      g?.setMode("free");
      courses?.load(null);
      fleet?.respawn("show");
    }
    setScreen("flying");
  }

  const achievements = game?.achievements ?? [];
  const earned = achievements.filter((a) => a.earned).length;

  // ---- loading -------------------------------------------------------------
  if (!ready) {
    if (shot) return null;
    return (
      <div className="fixed inset-0 z-40 flex flex-col items-center justify-center bg-[#040a18]">
        <p className="text-[10px] uppercase tracking-[0.55em] text-sky-300/60">The Vibeverse presents</p>
        <h1 className="mt-3 bg-gradient-to-b from-amber-200 via-amber-300 to-amber-500 bg-clip-text text-center text-5xl font-black tracking-tight text-transparent drop-shadow-[0_2px_28px_rgba(251,191,36,0.35)] sm:text-7xl">
          BLUE ANGELS
        </h1>
        <p className="mt-1 text-xs uppercase tracking-[0.4em] text-sky-200/60">Seattle · Seafair</p>
        <div className="mt-10 w-64 sm:w-80">
          <div className="h-1 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-gradient-to-r from-sky-300 to-amber-300 transition-[width] duration-300"
              style={{ width: `${Math.round(progress.fraction * 100)}%` }}
            />
          </div>
          <p className="mt-2 text-center font-mono text-[11px] uppercase tracking-widest text-sky-200/50">
            {progress.stage}…
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <FlightHUD engine={engine} visible={screen === "flying"} />

      {/* ---- in-flight chrome ------------------------------------------- */}
      {screen === "flying" && (
        <>
          {/* Radio, top-left under the safe area. */}
          <div
            data-angels-hud="radio"
            className="pointer-events-none fixed left-0 top-0 z-30 max-w-[62vw] space-y-1 p-3"
            style={{ paddingTop: "max(12px, env(safe-area-inset-top))", paddingLeft: "max(12px, env(safe-area-inset-left))" }}
          >
            {radio.slice(0, 3).map((m, i) => (
              <div
                key={`${m.at}-${i}`}
                className="rounded border-l-2 bg-black/45 px-2 py-1 font-mono text-[10.5px] leading-tight backdrop-blur-sm sm:text-[11.5px]"
                style={{
                  borderColor: m.tone === "good" ? "#7dffb0" : m.tone === "warn" ? "#ff5555" : "#8fd0ff",
                  opacity: 1 - i * 0.3,
                }}
              >
                <span className="text-white/45">{m.from} · </span>
                <span className="text-white/90">{m.text}</span>
              </div>
            ))}
          </div>

          {/* Course / demo strip, top-centre. */}
          {(courseId || demoCall) && (
            <div
              data-angels-hud="course"
              className="pointer-events-none fixed left-1/2 z-30 -translate-x-1/2 rounded-full bg-black/50 px-4 py-1.5 backdrop-blur-sm"
              style={{ top: "max(74px, calc(env(safe-area-inset-top) + 70px))" }}
            >
              <span className="font-mono text-[11px] uppercase tracking-widest text-amber-200">
                {demoCall ? demoCall : `${hoopProgress.done}/${hoopProgress.total}`}
                <span className="mx-2 text-white/25">|</span>
                {runTime.toFixed(1)}s
                <span className="mx-2 text-white/25">|</span>
                {score}
              </span>
            </div>
          )}

          {/* Buttons, top-right. Kept clear of the touch throttle. */}
          <div
            data-angels-hud="buttons"
            className="fixed z-30 flex gap-1.5"
            style={{
              top: "max(12px, env(safe-area-inset-top))",
              right: "max(12px, env(safe-area-inset-right))",
            }}
          >
            <button
              onClick={() => {
                const cam = services.camera as { cycle(): CameraMode } | undefined;
                cam?.cycle();
              }}
              className="rounded-full bg-black/45 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-sky-200 backdrop-blur-sm transition hover:bg-black/65"
            >
              {CAMERA_COPY[camera]}
            </button>
            <button
              onClick={() => setScreen("paused")}
              className="rounded-full bg-black/45 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-sky-200 backdrop-blur-sm transition hover:bg-black/65"
            >
              Menu
            </button>
          </div>

          {toast && (
            <div
              data-angels-hud="toast"
              className="pointer-events-none fixed bottom-24 left-1/2 z-40 -translate-x-1/2 animate-in fade-in slide-in-from-bottom-4"
            >
              <div className="rounded-xl border border-amber-300/40 bg-gradient-to-b from-amber-500/25 to-black/70 px-5 py-3 text-center backdrop-blur-md">
                <p className="font-mono text-[9px] uppercase tracking-[0.35em] text-amber-200/70">Seafair</p>
                <p className="mt-0.5 text-lg font-black tracking-tight text-amber-100">{toast.name}</p>
              </div>
            </div>
          )}
        </>
      )}

      {/* ---- hangar ------------------------------------------------------ */}
      {screen === "hangar" && (
        <div className="fixed inset-0 z-40 overflow-y-auto bg-gradient-to-b from-[#040a18]/97 via-[#061225]/94 to-[#02060f]/97 backdrop-blur-sm">
          <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
            <header className="text-center">
              <p className="text-[10px] uppercase tracking-[0.5em] text-sky-300/60">
                US Navy Flight Demonstration Squadron
              </p>
              <h1 className="mt-2 bg-gradient-to-b from-amber-200 via-amber-300 to-amber-500 bg-clip-text text-4xl font-black tracking-tight text-transparent sm:text-6xl">
                BLUE ANGELS
              </h1>
              <p className="mt-2 text-sm text-sky-100/70">
                Seafair over Lake Washington. You are number 1 — the other five fly your wing.
              </p>
            </header>

            {/* jets */}
            <section className="mt-8">
              <h2 className="mb-2 font-mono text-[10px] uppercase tracking-[0.35em] text-sky-300/50">
                Choose your jet
              </h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {HANGAR.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setJet(a.id)}
                    className={`rounded-xl border p-3 text-left transition ${
                      jet === a.id
                        ? "border-amber-300/70 bg-amber-400/15 shadow-[0_0_28px_rgba(251,191,36,0.18)]"
                        : "border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.07]"
                    }`}
                  >
                    <p className="font-mono text-[9px] uppercase tracking-widest text-sky-300/50">{a.era}</p>
                    <p className="mt-0.5 text-[13px] font-bold leading-tight text-white">{a.name}</p>
                    <p className="mt-0.5 text-[10.5px] text-sky-100/50">{a.character}</p>
                  </button>
                ))}
              </div>
              <p className="mt-3 min-h-[2.5rem] text-[12.5px] leading-snug text-sky-100/65">{spec.blurb}</p>
              <div className="mt-2 grid grid-cols-2 gap-x-5 gap-y-1 font-mono text-[10.5px] text-sky-200/45 sm:grid-cols-4">
                <span>SPAN {spec.wingspan.toFixed(1)} m</span>
                <span>MASS {(spec.mass / 1000).toFixed(1)} t</span>
                <span>
                  THRUST {((spec.thrustAB || spec.thrustMil) / 1000).toFixed(0)} kN
                  {spec.thrustAB > 0 ? " AB" : ""}
                </span>
                <span>ROLL {Math.round((spec.feel.rollRate * 180) / Math.PI)}°/s</span>
              </div>
            </section>

            {/* difficulty */}
            <section className="mt-7">
              <h2 className="mb-2 font-mono text-[10px] uppercase tracking-[0.35em] text-sky-300/50">
                How much flies itself
              </h2>
              <div className="grid grid-cols-3 gap-2">
                {(Object.keys(ASSIST_COPY) as AssistLevel[]).map((level) => (
                  <button
                    key={level}
                    onClick={() => setAssist(level)}
                    className={`rounded-xl border px-3 py-2 text-left transition ${
                      assist === level
                        ? "border-sky-300/70 bg-sky-400/15"
                        : "border-white/10 bg-white/[0.03] hover:border-white/25"
                    }`}
                  >
                    <p className="text-[12.5px] font-bold text-white">{ASSIST_COPY[level].name}</p>
                  </button>
                ))}
              </div>
              <p className="mt-2 min-h-[2.2rem] text-[12px] leading-snug text-sky-100/55">
                {ASSIST_COPY[assist].blurb}
              </p>
            </section>

            {/* wingmen */}
            <section className="mt-5 flex items-center gap-3">
              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-sky-300/50">Wingmen</span>
              <input
                type="range"
                min={0}
                max={5}
                value={wingmen}
                onChange={(e) => setWingmen(Number(e.target.value))}
                className="h-1 flex-1 accent-amber-400"
              />
              <span className="w-6 font-mono text-xs text-amber-200">{wingmen}</span>
            </section>

            {/* modes */}
            <section className="mt-8 grid gap-2 sm:grid-cols-2">
              <button
                onClick={() => launch("free")}
                className="rounded-2xl bg-gradient-to-b from-amber-300 to-amber-500 px-6 py-4 text-left transition hover:brightness-110"
              >
                <p className="text-lg font-black tracking-tight text-slate-900">Free Flight</p>
                <p className="text-[12px] leading-snug text-slate-900/70">
                  Seattle, a jet, and nobody keeping score. Start over the lake at 1,500 feet.
                </p>
              </button>
              <button
                onClick={() => launch("demo")}
                className="rounded-2xl border border-sky-300/40 bg-sky-400/10 px-6 py-4 text-left transition hover:bg-sky-400/20"
              >
                <p className="text-lg font-black tracking-tight text-sky-100">Fly the Demo</p>
                <p className="text-[12px] leading-snug text-sky-100/60">
                  Nine called manoeuvres down the show line, scored on whether you actually flew them.
                </p>
              </button>
            </section>

            <section className="mt-4">
              <h2 className="mb-2 font-mono text-[10px] uppercase tracking-[0.35em] text-sky-300/50">
                Ring courses
              </h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {(courses?.courses ?? []).map((c) => (
                  <button
                    key={c.id}
                    onClick={() => launch("course", c.id)}
                    className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left transition hover:border-white/30 hover:bg-white/[0.07]"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-[13.5px] font-bold text-white">{c.name}</p>
                      <span className="font-mono text-[10px] text-sky-200/40">
                        {game?.bestTimes?.[c.id] ? `${game.bestTimes[c.id].toFixed(1)}s` : `par ${c.par}s`}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11.5px] leading-snug text-sky-100/50">{c.blurb}</p>
                  </button>
                ))}
              </div>
            </section>

            <section className="mt-6 flex flex-wrap items-center justify-between gap-3">
              <button
                onClick={() => setShowAchievements((v) => !v)}
                className="font-mono text-[11px] uppercase tracking-widest text-amber-200/70 transition hover:text-amber-200"
              >
                Easter eggs · {earned}/{achievements.length}
              </button>
              <Link
                to="/"
                className="font-mono text-[11px] uppercase tracking-[0.3em] text-white/30 transition hover:text-white/60"
              >
                ← back to the vibeverse
              </Link>
            </section>

            {showAchievements && (
              <div className="mt-3 grid gap-1 sm:grid-cols-2">
                {achievements.map((a) => (
                  <div
                    key={a.id}
                    className={`rounded-lg border px-3 py-2 ${
                      a.earned ? "border-amber-300/40 bg-amber-400/10" : "border-white/[0.07] bg-white/[0.02]"
                    }`}
                  >
                    <p className={`text-[12px] font-bold ${a.earned ? "text-amber-100" : "text-white/45"}`}>
                      {a.earned ? a.name : "???"}
                    </p>
                    <p className="text-[11px] leading-snug text-sky-100/45">{a.hint}</p>
                  </div>
                ))}
              </div>
            )}

            <p className="mt-8 text-center font-mono text-[10px] leading-relaxed text-white/25">
              Desktop: W/S pitch · A/D roll · Q/E rudder · Shift/Z throttle · Space airbrake · G gear · X smoke ·
              C camera · R reset · Esc menu
              <br />
              Phone: left thumb flies, right thumb is the throttle. Landscape or portrait, both work.
            </p>
          </div>
        </div>
      )}

      {/* ---- pause ------------------------------------------------------- */}
      {screen === "paused" && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4 backdrop-blur-md">
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#050c1a]/95 p-5">
            <h2 className="text-center text-2xl font-black tracking-tight text-amber-200">Paused</h2>

            <div className="mt-5 space-y-3">
              <Row label="Time of day">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={timeOfDay}
                  onChange={(e) => {
                    const t = Number(e.target.value);
                    setTimeOfDay(t);
                    (services.env as EnvService | undefined)?.setTimeOfDay(t);
                  }}
                  className="h-1 w-40 accent-amber-400"
                />
              </Row>

              <Row label="Assist">
                <div className="flex gap-1">
                  {(Object.keys(ASSIST_COPY) as AssistLevel[]).map((l) => (
                    <button
                      key={l}
                      onClick={() => {
                        setAssist(l);
                        (services.fleet as FleetService | undefined)?.setAssist(l);
                      }}
                      className={`rounded px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition ${
                        assist === l ? "bg-sky-400/25 text-sky-100" : "text-white/40 hover:text-white/70"
                      }`}
                    >
                      {ASSIST_COPY[l].name}
                    </button>
                  ))}
                </div>
              </Row>

              <Row label="Pitch">
                <Toggle
                  on={invertPitch}
                  onLabel="Pull back to climb"
                  offLabel="Push up to climb"
                  onChange={(v) => {
                    setInvertPitch(v);
                    (services.input as InputService | undefined)?.setSetting("invertPitch", v);
                  }}
                />
              </Row>

              <Row label="Tilt to roll">
                <Toggle
                  on={tilt}
                  onLabel="On"
                  offLabel="Off"
                  onChange={(v) => {
                    setTilt(v);
                    (services.input as InputService | undefined)?.setSetting("tiltRoll", v);
                  }}
                />
              </Row>

              <Row label="Sound">
                <Toggle
                  on={!muted}
                  onLabel="On"
                  offLabel="Muted"
                  onChange={(v) => {
                    setMuted(!v);
                    (services.audio as { setMuted(m: boolean): void } | undefined)?.setMuted(!v);
                  }}
                />
              </Row>
            </div>

            <div className="mt-6 grid grid-cols-2 gap-2">
              <button
                onClick={() => setScreen("flying")}
                className="rounded-xl bg-amber-400 px-4 py-2.5 text-sm font-bold uppercase tracking-widest text-slate-900 transition hover:bg-amber-300"
              >
                Resume
              </button>
              <button
                onClick={() => {
                  (services.fleet as FleetService | undefined)?.respawn("show");
                  setScreen("flying");
                }}
                className="rounded-xl border border-white/15 px-4 py-2.5 text-sm font-bold uppercase tracking-widest text-white/70 transition hover:bg-white/10"
              >
                Reset
              </button>
            </div>

            <div className="mt-3 flex items-center justify-between">
              <button
                onClick={() => setScreen("hangar")}
                className="font-mono text-[11px] uppercase tracking-widest text-sky-200/60 transition hover:text-sky-200"
              >
                ← Hangar
              </button>
              <Link
                to="/"
                className="font-mono text-[11px] uppercase tracking-[0.28em] text-white/30 transition hover:text-white/60"
              >
                Leave
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-sky-300/50">{label}</span>
      {children}
    </div>
  );
}

function Toggle({
  on,
  onLabel,
  offLabel,
  onChange,
}: {
  on: boolean;
  onLabel: string;
  offLabel: string;
  onChange(v: boolean): void;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-wider transition ${
        on ? "bg-sky-400/25 text-sky-100" : "bg-white/[0.06] text-white/45"
      }`}
    >
      {on ? onLabel : offLabel}
    </button>
  );
}
