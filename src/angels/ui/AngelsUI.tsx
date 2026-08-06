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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Engine } from "../engine/core";
import { HANGAR, type JetId } from "../flight/aircraft";
import type { FleetService, SpawnPoint } from "../play/fleet";
import type { CourseService } from "../play/courses";
import type { GameService, RadioMessage, Achievement } from "../play/game";
import type { InputService, ControlScheme } from "../engine/input";
import type { EnvService } from "../world/sky";
import type { AssistLevel } from "../flight/dynamics";
import type { CameraMode } from "../types";
import { isShotMode } from "../engine/core";
import FlightHUD from "./FlightHUD";
import ControlsCard, { HELP_SEEN_KEY } from "./Controls";

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
const START_POINTS: Array<{ id: SpawnPoint; name: string; blurb: string }> = [
  {
    id: "needle",
    name: "The Space Needle",
    blurb: "Two miles out and pointed straight at it. Thirteen seconds to the saucer.",
  },
  { id: "show", name: "The show line", blurb: "Airborne over Lake Washington, running in from the north." },
  { id: "runway", name: "Boeing Field", blurb: "Stopped on 14R. Throttle up and fly it off yourself." },
  { id: "high", name: "High over the city", blurb: "14,000 feet with the whole Sound in front of you." },
];

/**
 * The three ways to fly it, in the order they should be tried.
 *
 * "Point & fly" leads because it is the one that needs no explanation: you put
 * a ring where you want to go and the jet works out the bank and the pull. The
 * other two ask you to think about a control surface first and a destination
 * second, which is the right way round for someone who already flies and the
 * wrong way round for everyone else.
 */
const SCHEME_COPY: Record<ControlScheme, { name: string; blurb: string }> = {
  easy: {
    name: "Arrow keys",
    blurb:
      "Left and right turn — properly, with the bank and the pull worked out for you. Up and down climb and dive. Let go and it flies straight and level, and the throttle looks after itself.",
  },
  pursuit: {
    name: "Point & fly",
    blurb:
      "Move the mouse and a ring follows it. The jet banks and pulls to fly through the ring, so climbing is just putting it above the horizon. W and S are the throttle.",
  },
  stick: {
    name: "Direct stick",
    blurb:
      "The cursor is the stick and the middle of the screen is neutral: up climbs, left rolls left. More control, more to think about.",
  },
  keyboard: {
    name: "Keyboard",
    blurb: "W and S climb and dive, A and D roll, Shift and Z are the throttle. No mouse at all.",
  },
};

/** The one line worth having on screen while you are actually flying. */
const HINT: Record<ControlScheme | "touch", string> = {
  easy: "← → turn · ↑ ↓ climb and dive · Space if you get lost",
  pursuit: "The jet flies to the ring — move the mouse · Space if you get lost",
  stick: "The cursor is the stick, middle of the screen is neutral · Space if you get lost",
  keyboard: "W S climb and dive · A D roll · Space if you get lost",
  touch: "Left thumb flies · right thumb is the throttle · LEVEL if you get lost",
};

const HINT_SEEN_KEY = "angels.hintSeen";

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
  const [start, setStart] = useState<SpawnPoint>("needle");
  const [help, setHelp] = useState(false);
  const [scheme, setScheme] = useState<ControlScheme>("easy");
  const [thumbs, setThumbs] = useState(false);
  const [wreck, setWreck] = useState<{ cause: string; speed: number } | null>(null);
  const [hint, setHint] = useState(false);

  const services = engine.ctx.services;
  const courses = services.courses as CourseService | undefined;
  const game = services.game as GameService | undefined;

  // One statement, both problems.
  //
  // The touch overlay lives on document.body, outside the React root, so it
  // cannot be layered under a menu with z-index alone — the root is its own
  // stacking context, and the joystick zone covered the hangar on a phone with
  // no way in at all. And on a desktop the cursor *is* the stick, so any card
  // in front of you would otherwise have the jet rolling while you tried to
  // click a button on it. Telling the input layer "a menu is up" fixes both,
  // and it re-anchors neutral under the cursor on the way back out.
  useEffect(() => {
    const input = services.input as InputService | undefined;
    // A wreck counts: there is no jet to fly, so the thumb overlay comes down
    // (in portrait it sat on top of the FLY AGAIN button) and the mouse stops
    // being a stick.
    input?.setMenuOpen(screen !== "flying" || help || !!wreck);
  }, [services, screen, help, wreck]);

  // Pick up whatever the input system restored from localStorage.
  useEffect(() => {
    const input = services.input as InputService | undefined;
    if (input) {
      setInvertPitch(input.settings.invertPitch);
      setTilt(input.settings.tiltRoll);
      setScheme(input.settings.controlScheme);
    }
    const audio = services.audio as { muted: boolean } | undefined;
    if (audio) setMuted(audio.muted);
    if (typeof window !== "undefined") {
      setThumbs(!!window.matchMedia?.("(pointer: coarse)").matches);
    }
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
      engine.on("angels:crash", (e: { cause: string; speed: number }) => setWreck(e)),
      engine.on("angels:respawn", () => setWreck(null)),
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
      // A tablet with a keyboard is a coarse pointer that might still be flown
      // with keys, so the card follows whatever was touched last rather than
      // whatever the media query guessed at load.
      if (engine.ctx.input.source === "touch") setThumbs(true);
    }, 250);
    return () => window.clearInterval(id);
  }, [engine]);

  // Escape, the pad's start button and the pause button all land here; H opens
  // the controls card. Both arrive as engine events rather than a poll — see
  // the note in core.ts about why polling an edge flag loses the race.
  const helpOpen = useRef(false);
  helpOpen.current = help;

  const dismissHint = useCallback(() => {
    setHint(false);
    try {
      localStorage?.setItem(HINT_SEEN_KEY, "1");
    } catch {
      /* private mode; it comes back next time, which is harmless */
    }
  }, []);

  const closeHelp = useCallback(() => {
    setHelp(false);
    try {
      localStorage?.setItem(HELP_SEEN_KEY, "1");
    } catch {
      /* private mode. Worst case it opens once more next time. */
    }
  }, []);

  useEffect(() => {
    const offs = [
      engine.on("angels:pause", () => {
        // Escape with the card up means "close the card", not "also pause".
        if (helpOpen.current) {
          closeHelp();
          return;
        }
        setScreen((s) => (s === "flying" ? "paused" : s === "paused" ? "flying" : s));
      }),
      engine.on("angels:help", () => (helpOpen.current ? closeHelp() : setHelp(true))),
    ];
    return () => offs.forEach((o) => o());
  }, [engine, closeHelp]);

  const spec = useMemo(() => HANGAR.find((a) => a.id === jet) ?? HANGAR[0], [jet]);

  // The countdown bar and the white flash are both "start at one, transition to
  // zero" — two renders and CSS does the rest. Driving either from the 4 Hz
  // sampler would make the bar step in visible chunks and would miss the flash
  // entirely, since the whole flash is shorter than one sample.
  const [wreckBar, setWreckBar] = useState(1);
  const [flash, setFlash] = useState(0);
  const wreckSeconds = (services.fleet as FleetService | undefined)?.wreck.duration ?? 3.6;
  useEffect(() => {
    if (!wreck) return;
    setWreckBar(1);
    setFlash(1);
    const id = requestAnimationFrame(() => {
      setWreckBar(0);
      setFlash(0);
    });
    return () => cancelAnimationFrame(id);
  }, [wreck]);

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
  function applyScheme(v: ControlScheme) {
    setScheme(v);
    (services.input as InputService | undefined)?.setSetting("controlScheme", v);
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

    // The first flight opens the controls card by itself. Pressing FLY and
    // arriving in a jet over Lake Washington with no idea which key does
    // anything was the whole of the complaint; you can work out a shooter by
    // pressing W, but you cannot work out an aeroplane. After that it is on H
    // and on the ? button, and it stays out of the way.
    let seen = false;
    try {
      seen = localStorage?.getItem(HELP_SEEN_KEY) === "1";
    } catch {
      /* private mode counts as never seen, which is the safe way round */
    }
    if (!seen) setHelp(true);

    let hintSeen = false;
    try {
      hintSeen = localStorage?.getItem(HINT_SEEN_KEY) === "1";
    } catch {
      /* see above */
    }
    if (!hintSeen) {
      setHint(true);
      window.setTimeout(() => setHint(false), 60000);
    }
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
      {/* The HUD stays up behind the controls card — dimmed by its backdrop,
          but there, so dismissing it does not feel like the instruments
          rebooting. It goes away entirely for a crash: a velocity vector and a
          G reading laid over your own fireball is the game insisting the jet
          is still flying. */}
      <FlightHUD engine={engine} visible={screen === "flying" && !wreck} />

      {/* ---- the first-flight strip -------------------------------------- */}
      {/* Three keys, on screen, for the first minute. The controls card
          answers "how do I fly this" once and then goes away; this answers
          "which key was it again" while you are actually flying, which is when
          the question is actually asked. It goes for good once dismissed. */}
      {screen === "flying" && !wreck && !help && hint && (
        <div
          data-angels-hud="hint"
          className="pointer-events-none fixed inset-x-0 z-30 flex justify-center px-4"
          style={{ bottom: "max(18px, calc(env(safe-area-inset-bottom) + 14px))" }}
        >
          <div
            className="pointer-events-auto flex items-center gap-3 rounded-full border border-white/10 px-4 py-2"
            style={{ background: "rgba(4,10,24,0.72)", backdropFilter: "blur(6px)" }}
          >
            <span className="text-[12.5px] leading-none text-white/85">{HINT[thumbs ? "touch" : scheme]}</span>
            <button
              onClick={dismissHint}
              className="rounded-full bg-white/10 px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-widest text-white/60 transition hover:bg-white/20 hover:text-white"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* ---- the smoking hole -------------------------------------------- */}
      {wreck && (
        <>
          {/* One frame of white, then out. This is what makes the fireball
              read as something that happened *to you* rather than something
              you are watching from across the lake. */}
          <div
            data-angels-hud="flash"
            className="pointer-events-none fixed inset-0 z-40"
            style={{
              background: "#fff8ec",
              opacity: flash,
              transition: "opacity 900ms cubic-bezier(0.15,0,0.35,1)",
            }}
          />
          <div
            data-angels-hud="wreck"
            className="pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4"
            style={{ bottom: "max(28px, calc(env(safe-area-inset-bottom) + 22px))" }}
          >
            <div
              className="pointer-events-auto w-full max-w-sm overflow-hidden rounded-2xl border border-red-400/30"
              style={{ background: "rgba(14,4,4,0.86)", backdropFilter: "blur(4px)" }}
            >
              <div className="px-4 pb-3 pt-3">
                <p className="font-mono text-[9.5px] uppercase tracking-[0.42em] text-red-300/70">
                  Scratch one
                </p>
                <p className="mt-1 text-[15px] font-black leading-tight text-white">
                  You flew into {wreck.cause}
                  <span className="ml-1.5 font-mono text-[11.5px] font-normal text-red-200/60">
                    at {Math.round(wreck.speed * 1.94384)} knots
                  </span>
                </p>
              </div>
              <div className="h-[3px] w-full bg-white/10">
                <div
                  className="h-full bg-gradient-to-r from-amber-300 to-red-400"
                  style={{
                    width: `${wreckBar * 100}%`,
                    transition: `width ${wreckSeconds}s linear`,
                  }}
                />
              </div>
              <button
                onClick={() => (services.fleet as FleetService | undefined)?.restart()}
                className="w-full bg-gradient-to-b from-amber-300 to-amber-500 py-2.5 text-[13px] font-black uppercase tracking-[0.24em] text-slate-900 transition hover:brightness-110"
              >
                Fly again
              </button>
            </div>
          </div>
        </>
      )}

      {help && (
        <ControlsCard
          scheme={scheme}
          touch={thumbs}
          start={start}
          onScheme={applyScheme}
          onClose={closeHelp}
        />
      )}

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
              onClick={() => (services.fleet as FleetService | undefined)?.levelOut()}
              aria-label="Level out"
              className="rounded-full bg-amber-400/85 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-slate-900 backdrop-blur-sm transition hover:bg-amber-300"
            >
              Level
            </button>
            <button
              onClick={() => setHelp(true)}
              aria-label="Controls"
              className="rounded-full bg-black/45 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-amber-200 backdrop-blur-sm transition hover:bg-black/65"
            >
              {thumbs ? "?" : "? Keys"}
            </button>
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
              className="pointer-events-none fixed left-1/2 z-40 -translate-x-1/2 animate-in fade-in slide-in-from-bottom-4"
              // Out of the crash card's way when there is one. An achievement
              // and a "you are dead" notice arriving together is exactly what
              // happens when you fly into the Space Needle.
              style={{ bottom: wreck ? 188 : 96 }}
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
            {/* The one line someone needs before they press the button. The
                full card opens by itself on the first flight; this is so the
                second visit does not have to wait for it. */}
            <p className="mt-1 text-center text-[11.5px] text-sky-100/45">
              {thumbs
                ? "Left thumb flies · right thumb is the throttle · LEVEL if you get lost"
                : scheme === "easy"
                  ? "Arrow keys fly it — left turns left, up climbs · Space if you get lost"
                  : scheme === "pursuit"
                    ? "Move the mouse where you want to go · W and S for the throttle · Space if you get lost"
                    : scheme === "stick"
                      ? "The cursor is the stick · W and S for the throttle · Space if you get lost"
                      : "W S climb and dive · A D roll · Shift and Z for the throttle · Space if you get lost"}
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

                <Group label="How you fly it" note={SCHEME_COPY[scheme].blurb}>
                  {(Object.keys(SCHEME_COPY) as ControlScheme[]).map((k) => (
                    <Chip key={k} on={scheme === k} onClick={() => applyScheme(k)}>
                      {SCHEME_COPY[k].name}
                    </Chip>
                  ))}
                </Group>

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

                <button
                  onClick={() => setHelp(true)}
                  className="w-full rounded-lg bg-white/[0.06] py-2 font-mono text-[10.5px] uppercase tracking-[0.2em] text-sky-200/70 transition hover:bg-white/[0.12] hover:text-sky-100"
                >
                  Show the full control list
                </button>
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

              {!thumbs && (
                <Row label="Controls">
                  <div className="flex gap-1">
                    {(Object.keys(SCHEME_COPY) as ControlScheme[]).map((k) => (
                      <Chip key={k} on={scheme === k} onClick={() => applyScheme(k)}>
                        {SCHEME_COPY[k].name}
                      </Chip>
                    ))}
                  </div>
                </Row>
              )}

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

            <button
              onClick={() => setHelp(true)}
              className="mt-2 w-full rounded-xl border border-white/10 py-2 font-mono text-[11px] uppercase tracking-widest text-sky-200/60 transition hover:bg-white/[0.07] hover:text-sky-100"
            >
              Controls
            </button>

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
