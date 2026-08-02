/**
 * Everything on top of the canvas that is not the HUD: the hangar, the pause
 * card, the radio, the toasts and the ribbon of course progress.
 *
 * ## The hangar is one screen with one button
 *
 * The first version put the aircraft, the difficulty, the wingman count, the
 * start point, two game modes and six ring courses on a single scrolling page,
 * and the result was a wall of choices in front of someone who just wanted to
 * fly. Worse, on a phone it was unusable outright — the touch overlay is
 * mounted on `document.body`, outside the React root, so its joystick zone sat
 * on top of the entire menu and swallowed every tap. There was no way in.
 *
 * So: pick an aeroplane, look at it, press FLY. Everything else is behind one
 * of four quiet links and none of it is required to start. Choosing an
 * aircraft is the only decision worth making up front, because in this world
 * it changes the mass, the wing area, the thrust and six control-law constants
 * — the blurb on each card is a promise the flight model keeps. The Skyhawk
 * really does roll four times faster than the Phantom, and the pictures are
 * real renders of the same meshes you fly.
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

import superhornetArt from "@/assets/angels/jets/superhornet.jpg";
import hornetArt from "@/assets/angels/jets/hornet.jpg";
import skyhawkArt from "@/assets/angels/jets/skyhawk.jpg";
import phantomArt from "@/assets/angels/jets/phantom.jpg";
import tigerArt from "@/assets/angels/jets/tiger.jpg";
import pantherArt from "@/assets/angels/jets/panther.jpg";
import albertArt from "@/assets/angels/jets/albert.jpg";

/** Real renders of the same meshes you fly, straight from the shot harness. */
const JET_ART: Record<JetId, string> = {
  superhornet: superhornetArt,
  hornet: hornetArt,
  skyhawk: skyhawkArt,
  phantom: phantomArt,
  tiger: tigerArt,
  panther: pantherArt,
  albert: albertArt,
};

type Screen = "hangar" | "flying" | "paused";
type Panel = null | "courses" | "options" | "eggs";

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

/**
 * The runway start is the one that turns this from a game into a flight sim.
 * You are stopped, cold, on Boeing Field 14R with the gear down and the
 * throttle at idle, and nothing happens until you push it up.
 */
const START_POINTS: Array<{ id: "show" | "runway" | "high"; name: string; blurb: string }> = [
  { id: "show", name: "The show line", blurb: "Airborne over Lake Washington, running in from the north." },
  { id: "runway", name: "Boeing Field", blurb: "Stopped on 14R. Throttle up and fly it off yourself." },
  { id: "high", name: "High over the city", blurb: "14,000 feet with the whole Sound in front of you." },
];

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
  const [panel, setPanel] = useState<Panel>(null);
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
  const [invertPitch, setInvertPitch] = useState(false);
  const [tilt, setTilt] = useState(false);
  const [wingmen, setWingmen] = useState(5);
  const [start, setStart] = useState<"show" | "runway" | "high">("show");

  const services = engine.ctx.services;
  const courses = services.courses as CourseService | undefined;
  const game = services.game as GameService | undefined;

  // The touch overlay lives on document.body, outside the React root, so it
  // cannot be layered under a menu with z-index alone — the root is its own
  // stacking context. Hide it outright whenever a menu is up. Without this the
  // joystick zone covers the hangar on a phone and there is no way in at all.
  useEffect(() => {
    const input = services.input as InputService | undefined;
    input?.setTouchVisible(screen === "flying" ? null : false);
  }, [services, screen]);

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
      setDemoCall(g.demoElement ? g.demoElement.name : null);
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

  function applyInvert(v: boolean) {
    setInvertPitch(v);
    (services.input as InputService | undefined)?.setSetting("invertPitch", v);
  }
  function applyTilt(v: boolean) {
    setTilt(v);
    (services.input as InputService | undefined)?.setSetting("tiltRoll", v);
  }
  function applyMuted(v: boolean) {
    setMuted(v);
    (services.audio as { setMuted(m: boolean): void } | undefined)?.setMuted(v);
  }

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
      fleet?.respawn(start);
    }
    setPanel(null);
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
          <div
            data-angels-hud="radio"
            className="pointer-events-none fixed left-0 top-0 z-30 max-w-[62vw] space-y-1 p-3"
            style={{
              paddingTop: "max(12px, env(safe-area-inset-top))",
              paddingLeft: "max(12px, env(safe-area-inset-left))",
            }}
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

          <div
            data-angels-hud="buttons"
            className="fixed z-30 flex gap-1.5"
            style={{
              top: "max(12px, env(safe-area-inset-top))",
              right: "max(12px, env(safe-area-inset-right))",
            }}
          >
            <button
              onClick={() => (services.camera as { cycle(): CameraMode } | undefined)?.cycle()}
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
        <div
          className="fixed inset-0 z-40 overflow-y-auto overscroll-contain"
          // Inline rather than a Tailwind gradient: the arbitrary-colour form
          // with an opacity modifier silently produced a near-transparent
          // panel, and the live world showing through the copy made the whole
          // screen unreadable. This is one place where being explicit is worth
          // more than being idiomatic.
          style={{
            background:
              "linear-gradient(180deg, rgba(4,10,24,0.96) 0%, rgba(6,18,37,0.94) 45%, rgba(2,6,15,0.97) 100%)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
          }}
        >
          <div
            className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-4"
            style={{
              paddingTop: "max(22px, env(safe-area-inset-top))",
              paddingBottom: "max(22px, env(safe-area-inset-bottom))",
            }}
          >
            <header className="text-center">
              <p className="text-[9px] uppercase tracking-[0.45em] text-sky-300/50">
                US Navy Flight Demonstration Squadron
              </p>
              <h1 className="mt-1 bg-gradient-to-b from-amber-200 via-amber-300 to-amber-500 bg-clip-text text-4xl font-black tracking-tight text-transparent sm:text-5xl">
                BLUE ANGELS
              </h1>
              <p className="mt-1 text-[12.5px] text-sky-100/60">
                Seafair over Lake Washington. You fly number 1.
              </p>
            </header>

            {/* the aeroplane, big */}
            <div className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-black/30">
              {/* Capped by viewport height as well as aspect: on a 720p
                  laptop an uncapped 16:9 hero pushed the FLY button below the
                  fold, which is the one thing this screen must never do. */}
              <img
                src={JET_ART[spec.id]}
                alt={spec.name}
                className="block max-h-[34vh] w-full object-cover"
                style={{ aspectRatio: "16 / 9" }}
              />
              <div className="p-3.5">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-[17px] font-black leading-tight text-white">{spec.name}</h2>
                  <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-widest text-sky-300/50">
                    {spec.era}
                  </span>
                </div>
                <p className="mt-1 text-[12.5px] leading-snug text-sky-100/65">{spec.blurb}</p>
                <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[10.5px] text-sky-200/45 sm:grid-cols-4">
                  <span>SPAN {spec.wingspan.toFixed(1)} m</span>
                  <span>MASS {(spec.mass / 1000).toFixed(1)} t</span>
                  <span>
                    {((spec.thrustAB || spec.thrustMil) / 1000).toFixed(0)} kN
                    {spec.thrustAB > 0 ? " AB" : ""}
                  </span>
                  <span>ROLL {Math.round((spec.feel.rollRate * 180) / Math.PI)}°/s</span>
                </div>
              </div>
            </div>

            {/* the rest of the hangar, as a thumb strip */}
            <div className="mt-2.5 flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {HANGAR.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setJet(a.id)}
                  aria-label={a.name}
                  aria-pressed={jet === a.id}
                  className={`relative shrink-0 overflow-hidden rounded-xl border transition ${
                    jet === a.id
                      ? "border-amber-300/80 shadow-[0_0_18px_rgba(251,191,36,0.28)]"
                      : "border-white/10 opacity-60 hover:opacity-100"
                  }`}
                >
                  <img src={JET_ART[a.id]} alt="" className="block h-16 w-28 object-cover" />
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-1.5 pb-1 pt-3 text-left font-mono text-[8.5px] uppercase tracking-wider text-white/85">
                    {a.character}
                  </span>
                </button>
              ))}
            </div>

            {/* the one button that matters */}
            <button
              onClick={() => launch("free")}
              className="mt-4 w-full rounded-2xl bg-gradient-to-b from-amber-300 to-amber-500 py-4 text-2xl font-black tracking-[0.28em] text-slate-900 shadow-[0_0_36px_rgba(251,191,36,0.28)] transition hover:brightness-110 active:scale-[0.99]"
            >
              FLY
            </button>
            <p className="mt-1.5 text-center font-mono text-[10px] uppercase tracking-widest text-sky-200/35">
              {START_POINTS.find((s) => s.id === start)?.name} · {ASSIST_COPY[assist].name} · {wingmen}{" "}
              wingmen
            </p>

            {/* everything else, out of the way */}
            <nav className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
              <PanelLink
                active={panel === "courses"}
                onClick={() => setPanel(panel === "courses" ? null : "courses")}
              >
                Ring courses
              </PanelLink>
              <PanelLink onClick={() => launch("demo")}>Fly the demo</PanelLink>
              <PanelLink
                active={panel === "options"}
                onClick={() => setPanel(panel === "options" ? null : "options")}
              >
                Options
              </PanelLink>
              <PanelLink
                active={panel === "eggs"}
                onClick={() => setPanel(panel === "eggs" ? null : "eggs")}
              >
                Easter eggs {earned}/{achievements.length}
              </PanelLink>
            </nav>

            {panel === "courses" && (
              <section className="mt-3 grid gap-2 sm:grid-cols-2">
                {(courses?.courses ?? []).map((c) => (
                  <button
                    key={c.id}
                    onClick={() => launch("course", c.id)}
                    className="rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-left transition hover:border-white/30 hover:bg-white/[0.07]"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-[13px] font-bold text-white">{c.name}</p>
                      <span className="shrink-0 font-mono text-[9.5px] text-sky-200/40">
                        {game?.bestTimes?.[c.id] ? `${game.bestTimes[c.id].toFixed(1)}s` : `par ${c.par}s`}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11.5px] leading-snug text-sky-100/50">{c.blurb}</p>
                  </button>
                ))}
              </section>
            )}

            {panel === "options" && (
              <section className="mt-3 space-y-4 rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <Group label="How much flies itself" note={ASSIST_COPY[assist].blurb}>
                  {(Object.keys(ASSIST_COPY) as AssistLevel[]).map((l) => (
                    <Chip key={l} on={assist === l} onClick={() => setAssist(l)}>
                      {ASSIST_COPY[l].name}
                    </Chip>
                  ))}
                </Group>

                <Group label="Where you start" note={START_POINTS.find((s) => s.id === start)?.blurb ?? ""}>
                  {START_POINTS.map((s) => (
                    <Chip key={s.id} on={start === s.id} onClick={() => setStart(s.id)}>
                      {s.name}
                    </Chip>
                  ))}
                </Group>

                <div className="flex items-center gap-3">
                  <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-sky-300/50">
                    Wingmen
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={5}
                    value={wingmen}
                    onChange={(e) => setWingmen(Number(e.target.value))}
                    className="h-1 flex-1 accent-amber-400"
                  />
                  <span className="w-4 font-mono text-xs text-amber-200">{wingmen}</span>
                </div>

                <Group label="Pitch" note="">
                  <Chip on={!invertPitch} onClick={() => applyInvert(false)}>
                    Push up to climb
                  </Chip>
                  <Chip on={invertPitch} onClick={() => applyInvert(true)}>
                    Pull back to climb
                  </Chip>
                </Group>

                <Group label="Tilt to roll" note="">
                  <Chip on={!tilt} onClick={() => applyTilt(false)}>
                    Off
                  </Chip>
                  <Chip on={tilt} onClick={() => applyTilt(true)}>
                    On
                  </Chip>
                </Group>

                <Group label="Sound" note="">
                  <Chip on={!muted} onClick={() => applyMuted(false)}>
                    On
                  </Chip>
                  <Chip on={muted} onClick={() => applyMuted(true)}>
                    Muted
                  </Chip>
                </Group>

                <p className="pt-1 font-mono text-[10px] leading-relaxed text-white/25">
                  Desktop: W/S pitch · A/D roll · Q/E rudder · Shift/Z throttle · Space airbrake · G gear ·
                  X smoke · C camera · R reset · Esc menu
                  <br />
                  Phone: left thumb flies, right thumb is the throttle. Landscape or portrait.
                </p>
              </section>
            )}

            {panel === "eggs" && (
              <section className="mt-3 grid gap-1 sm:grid-cols-2">
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
              </section>
            )}

            <div className="min-h-[18px] flex-1" />
            <Link
              to="/"
              className="mt-5 text-center font-mono text-[10.5px] uppercase tracking-[0.3em] text-white/25 transition hover:text-white/60"
            >
              ← back to the vibeverse
            </Link>
          </div>
        </div>
      )}

      {/* ---- pause ------------------------------------------------------- */}
      {screen === "paused" && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4 backdrop-blur-md">
          <div
            className="w-full max-w-md rounded-2xl border border-white/10 p-5"
            style={{ background: "rgba(5,12,26,0.96)" }}
          >
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
                    <Chip
                      key={l}
                      on={assist === l}
                      onClick={() => {
                        setAssist(l);
                        (services.fleet as FleetService | undefined)?.setAssist(l);
                      }}
                    >
                      {ASSIST_COPY[l].name}
                    </Chip>
                  ))}
                </div>
              </Row>

              <Row label="Pitch">
                <Chip on={invertPitch} onClick={() => applyInvert(!invertPitch)}>
                  {invertPitch ? "Pull back to climb" : "Push up to climb"}
                </Chip>
              </Row>

              <Row label="Tilt to roll">
                <Chip on={tilt} onClick={() => applyTilt(!tilt)}>
                  {tilt ? "On" : "Off"}
                </Chip>
              </Row>

              <Row label="Sound">
                <Chip on={!muted} onClick={() => applyMuted(!muted)}>
                  {muted ? "Muted" : "On"}
                </Chip>
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
                  (services.fleet as FleetService | undefined)?.respawn(start);
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

function PanelLink({
  children,
  onClick,
  active,
}: {
  children: React.ReactNode;
  onClick(): void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`font-mono text-[11px] uppercase tracking-[0.16em] transition ${
        active ? "text-amber-200" : "text-sky-200/55 hover:text-sky-100"
      }`}
    >
      {children}
    </button>
  );
}

function Group({ label, note, children }: { label: string; note: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-sky-300/50">{label}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
      {note && <p className="mt-1.5 text-[11.5px] leading-snug text-sky-100/45">{note}</p>}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-wider transition ${
        on ? "bg-sky-400/25 text-sky-100" : "bg-white/[0.06] text-white/45 hover:text-white/75"
      }`}
    >
      {children}
    </button>
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
