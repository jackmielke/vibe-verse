/**
 * The overlay: status, captions, title cards, and the controls.
 *
 * It is deliberately sparse, and the reason is that the bridge *is* the HUD.
 * The room already tells you the alert state (the lights go red), that
 * somebody is talking (they turn round), and that you have been hit (a console
 * blows up next to you). Anything the set already says, the DOM must not say
 * again — every panel added here is a panel between the player and the room
 * they are supposed to be sitting in.
 *
 * What survived that test: four shield facings and a hull bar, because "aft
 * shields are gone" has to be readable in half a second; the weapons state,
 * because a torpedo count is a resource and resources need numbers; the
 * caption, because the browser's speech synthesiser is not reliable enough to
 * be the only channel; and the objective, because a player who does not know
 * what the episode wants is not playing it.
 *
 * State is sampled at 12 Hz off a rAF loop rather than pushed from the engine.
 * React re-rendering at 60 fps next to a WebGL canvas is a frame-rate problem
 * you get to have exactly once before you go and write this instead.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Engine } from "../engine/core";
import type { AlertLevel, CameraMode, CrewLine } from "../types";
import { MISSIONS } from "../play/missions";

interface Props {
  engine: Engine;
  ready: boolean;
  progress: { stage: string; fraction: number };
}

const DEPT_COLOUR: Record<string, string> = {
  CAPTAIN: "#f4e9d8",
  SPOCK: "#7fb8e8",
  SULU: "#ffcf5c",
  CHEKOV: "#ffcf5c",
  UHURA: "#ff8a7a",
  SCOTT: "#ff8a7a",
  MCCOY: "#7fe8c8",
  COMPUTER: "#8fe4ff",
  COMMAND: "#f4e9d8",
  KLINGON: "#8dff6a",
  ROMULAN: "#6effc8",
};

interface Snapshot {
  alert: AlertLevel;
  status: string;
  objective: string;
  missionTitle: string;
  stardate: string;
  missionIndex: number;
  hull: number;
  shields: number[];
  shieldsUp: boolean;
  torpedoes: number;
  charge: number;
  power: { engines: number; shields: number; weapons: number };
  systems: Record<string, number>;
  throttle: number;
  speed: number;
  camera: CameraMode;
  magnification: number;
  target: { name: string; range: number; hull: number; shields: number; cloaked: boolean } | null;
  evasive: boolean;
}

const EMPTY: Snapshot = {
  alert: "normal",
  status: "briefing",
  objective: "",
  missionTitle: "",
  stardate: "",
  missionIndex: 0,
  hull: 1,
  shields: [1, 1, 1, 1],
  shieldsUp: false,
  torpedoes: 0,
  charge: 1,
  power: { engines: 0.34, shields: 0.33, weapons: 0.33 },
  systems: {},
  throttle: 0,
  speed: 0,
  camera: "viewscreen",
  magnification: 1,
  target: null,
  evasive: false,
};

export default function BridgeUI({ engine, ready, progress }: Props) {
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [caption, setCaption] = useState<CrewLine | null>(null);
  const [muted, setMuted] = useState(false);
  const [voices, setVoices] = useState(true);
  const [showKeys, setShowKeys] = useState(false);
  const captionTimer = useRef<number>(0);

  // -- Sampling -------------------------------------------------------------
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 84) return;
      last = t;
      const s = engine.ctx.services;
      const game = s.game;
      const player = s.fleet?.player;
      if (!game || !player) return;
      const target = game.targetId != null ? s.fleet?.byId(game.targetId) : undefined;
      setSnap({
        alert: game.alert,
        status: game.status,
        objective: game.objective,
        missionTitle: game.missionTitle,
        stardate: game.stardate,
        missionIndex: game.mission,
        hull: player.hull_,
        shields: [...player.shields],
        shieldsUp: player.shieldsUp,
        torpedoes: player.torpedoes,
        charge: player.phaserCharge,
        power: { ...game.power },
        systems: { ...player.systems },
        throttle: player.throttle,
        speed: player.velocity.length(),
        camera: s.camera?.mode ?? "viewscreen",
        magnification: s.camera?.magnification ?? 1,
        evasive: engine.ctx.elapsed < game.evasiveUntil,
        target: target
          ? {
              name: target.name,
              range: target.position.distanceTo(player.position),
              hull: target.hull_,
              shields: avg(target.shields),
              cloaked: target.cloakLevel > 0.5,
            }
          : null,
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  // -- Captions -------------------------------------------------------------
  useEffect(() => {
    const off = engine.ctx.on("trek:line", (payload: never) => {
      const line = payload as unknown as CrewLine;
      setCaption(line);
      window.clearTimeout(captionTimer.current);
      captionTimer.current = window.setTimeout(() => setCaption(null), line.hold * 1000 + 600);
    });
    return () => {
      off();
      window.clearTimeout(captionTimer.current);
    };
  }, [engine]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    engine.ctx.services.audio?.setMuted(next);
  }, [engine, muted]);

  const toggleVoices = useCallback(() => {
    const next = !voices;
    setVoices(next);
    engine.ctx.services.audio?.setVoices(next);
  }, [engine, voices]);

  const order = useCallback(
    (key: keyof typeof engine.ctx.input, value: unknown = true) => {
      (engine.ctx.input as unknown as Record<string, unknown>)[key] = value;
      engine.ctx.services.audio?.unlock();
    },
    [engine],
  );

  const mission = MISSIONS[snap.missionIndex] ?? MISSIONS[0];
  const carded = snap.status !== "playing";
  const red = snap.alert === "red";

  if (!ready) {
    return (
      <div className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center bg-black">
        <p className="font-mono text-[11px] uppercase tracking-[0.6em] text-amber-300/60">Starfleet Command</p>
        <h1 className="mt-4 text-center font-black tracking-[0.22em] text-4xl text-amber-200 sm:text-6xl">
          THE FINAL FRONTIER
        </h1>
        <div className="mt-10 w-72">
          <div className="h-[3px] overflow-hidden rounded-full bg-amber-200/15">
            <div
              className="h-full rounded-full bg-amber-300 transition-[width] duration-300"
              style={{ width: `${Math.round(progress.fraction * 100)}%` }}
            />
          </div>
          <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-[0.35em] text-amber-200/50">
            {progress.stage}…
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* ---- Red alert wash. The room already went red; this is the edge of
           the frame going with it, which is what a klaxon looks like. ---- */}
      {red && !carded && (
        <div
          className="pointer-events-none absolute inset-0 z-10 animate-pulse"
          style={{ boxShadow: "inset 0 0 220px 40px rgba(255,40,20,0.34)" }}
        />
      )}

      {/* ---- Top left: who and where ---- */}
      {!carded && (
        <div className="pointer-events-none absolute left-4 top-4 z-20 font-mono text-[10px] uppercase leading-relaxed tracking-[0.24em] text-amber-200/70 sm:text-[11px]">
          <div className="text-amber-100">U.S.S. VIBEVERSE · NCC-1701-V</div>
          <div className="text-amber-200/45">
            STARDATE {snap.stardate} · {snap.missionTitle}
          </div>
        </div>
      )}

      {/* ---- Top right: alert + view ---- */}
      {!carded && (
        <div className="pointer-events-auto absolute right-3 top-3 z-20 flex items-center gap-2">
          <button
            onClick={toggleVoices}
            className="rounded border border-amber-300/25 bg-black/50 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-amber-200/70 transition hover:border-amber-300/60 hover:text-amber-100"
            title="Crew voices"
          >
            {voices ? "VOX ON" : "VOX OFF"}
          </button>
          <button
            onClick={toggleMute}
            className="rounded border border-amber-300/25 bg-black/50 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-amber-200/70 transition hover:border-amber-300/60 hover:text-amber-100"
          >
            {muted ? "MUTED" : "AUDIO"}
          </button>
          <div
            className={`rounded px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.22em] ${
              red
                ? "animate-pulse bg-red-600/85 text-white"
                : snap.alert === "yellow"
                  ? "bg-amber-400/80 text-black"
                  : "border border-white/15 bg-black/50 text-white/45"
            }`}
          >
            {red ? "RED ALERT" : snap.alert === "yellow" ? "YELLOW ALERT" : "CONDITION GREEN"}
          </div>
        </div>
      )}

      {/* ---- Objective ---- */}
      {!carded && snap.objective && (
        <div className="pointer-events-none absolute left-1/2 top-4 z-20 w-[min(560px,86vw)] -translate-x-1/2 text-center">
          <div className="inline-block rounded border border-amber-300/20 bg-black/55 px-4 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-amber-100/85 backdrop-blur-sm sm:text-[11px]">
            {snap.objective}
          </div>
        </div>
      )}

      {/* ---- Caption ---- */}
      {caption && !carded && (
        <div className="pointer-events-none absolute bottom-[132px] left-1/2 z-30 w-[min(760px,92vw)] -translate-x-1/2 text-center sm:bottom-[124px]">
          <div className="inline-block max-w-full rounded-md border border-white/10 bg-black/72 px-4 py-2.5 backdrop-blur-sm">
            <span
              className="mr-2 font-mono text-[10px] font-bold uppercase tracking-[0.24em]"
              style={{ color: DEPT_COLOUR[caption.who.toUpperCase()] ?? "#f4e9d8" }}
            >
              {caption.who}
            </span>
            <span className="text-[13px] leading-snug text-white/90 sm:text-[15px]">{caption.text}</span>
          </div>
        </div>
      )}

      {/* ---- Status strip ---- */}
      {!carded && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-end justify-between gap-3 px-3 pb-3 sm:px-5 sm:pb-4">
          {/* Shields and hull */}
          <div className="rounded-lg border border-amber-300/15 bg-black/60 p-2.5 backdrop-blur-sm">
            <ShieldRose shields={snap.shields} up={snap.shieldsUp} />
            <Bar label="HULL" value={snap.hull} colour={snap.hull > 0.5 ? "#7fe8a8" : snap.hull > 0.22 ? "#ffcf5c" : "#ff5a4a"} />
            <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[8.5px] uppercase tracking-[0.1em]">
              {Object.entries(snap.systems)
                .filter(([, v]) => v < 0.92)
                .slice(0, 4)
                .map(([k, v]) => (
                  <span key={k} style={{ color: v < 0.3 ? "#ff5a4a" : "#ffcf5c" }}>
                    {SYSTEM_LABEL[k] ?? k} {Math.round(v * 100)}%
                  </span>
                ))}
            </div>
          </div>

          {/* Power triangle */}
          <div className="hidden rounded-lg border border-amber-300/15 bg-black/60 p-2.5 backdrop-blur-sm sm:block">
            <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.24em] text-amber-200/50">Power</div>
            <PowerBar label="ENGINES" value={snap.power.engines} hint="1" colour="#8fe4ff" />
            <PowerBar label="SHIELDS" value={snap.power.shields} hint="2" colour="#7fe8a8" />
            <PowerBar label="WEAPONS" value={snap.power.weapons} hint="3" colour="#ffb648" />
            <div className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-amber-200/45">
              IMPULSE {Math.round(snap.throttle * 100)}% · {Math.round(snap.speed)} m/s
              {snap.evasive && <span className="ml-2 text-amber-300">EVASIVE</span>}
            </div>
          </div>

          {/* Target and weapons */}
          <div className="rounded-lg border border-amber-300/15 bg-black/60 p-2.5 text-right backdrop-blur-sm">
            <div className="font-mono text-[9px] uppercase tracking-[0.24em] text-amber-200/50">Target</div>
            {snap.target ? (
              <>
                <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-red-300">{snap.target.name}</div>
                <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-amber-200/60">
                  RANGE {(snap.target.range / 1000).toFixed(1)} km
                  {snap.target.cloaked && <span className="ml-2 text-sky-300">CLOAKED</span>}
                </div>
                <div className="mt-1 w-32">
                  <Bar label="SCR" value={snap.target.shields} colour="#7fb8e8" compact />
                  <Bar label="HUL" value={snap.target.hull} colour="#ff8a7a" compact />
                </div>
              </>
            ) : (
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">No lock — press R</div>
            )}
            <div className="mt-2 w-32 font-mono text-[9px] uppercase tracking-[0.14em] text-amber-200/70">
              <div className="flex justify-between">
                <span>PHASERS</span>
                <span style={{ color: snap.charge > 0.3 ? "#ffb648" : "#ff5a4a" }}>{Math.round(snap.charge * 100)}%</span>
              </div>
              <div className="flex justify-between">
                <span>PHOTONS</span>
                <span style={{ color: snap.torpedoes > 3 ? "#ffb648" : "#ff5a4a" }}>{snap.torpedoes}</span>
              </div>
              <div className="flex justify-between text-amber-200/40">
                <span>VIEW</span>
                <span>
                  {snap.camera.toUpperCase()}
                  {snap.camera === "viewscreen" && snap.magnification > 1 ? ` ×${snap.magnification}` : ""}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---- Touch orders. Phones cannot press T. ---- */}
      {!carded && (
        <div className="pointer-events-auto absolute bottom-[92px] right-3 z-30 flex flex-col gap-1.5 sm:hidden">
          <TouchKey label="FIRE" onDown={() => order("firePhasers", true)} onUp={() => order("firePhasers", false)} />
          <TouchKey label="TORP" onDown={() => order("fireTorpedo")} />
          <TouchKey label="LOCK" onDown={() => order("nextTarget")} />
          {/* Scan and hail are on the phone too. One episode cannot be
              finished without them, and a world that is playable on a phone
              only if you never meet the creature is not playable on a phone. */}
          <TouchKey label="SCAN" onDown={() => order("scan")} />
          <TouchKey label="HAIL" onDown={() => order("hail")} />
          <TouchKey label="ALERT" onDown={() => order("toggleAlert")} />
          <TouchKey label="EVADE" onDown={() => order("evasive")} />
        </div>
      )}
      {!carded && <TouchStick engine={engine} />}

      {/* ---- Controls ---- */}
      {!carded && (
        <button
          onClick={() => setShowKeys((v) => !v)}
          className="pointer-events-auto absolute bottom-3 left-1/2 z-20 hidden -translate-x-1/2 rounded border border-amber-300/20 bg-black/55 px-3 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-amber-200/60 transition hover:text-amber-100 sm:block"
        >
          {showKeys ? "hide orders" : "orders"}
        </button>
      )}
      {showKeys && !carded && (
        <div className="pointer-events-none absolute bottom-12 left-1/2 z-30 w-[min(680px,92vw)] -translate-x-1/2 rounded-lg border border-amber-300/20 bg-black/85 p-4 backdrop-blur">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-amber-100/70 sm:grid-cols-3">
            {KEYS.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <span className="text-amber-300">{k}</span>
                <span className="text-right text-white/55">{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- Mission cards ---- */}
      {carded && (
        <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-gradient-to-b from-black via-[#05060c] to-black px-6">
          <div className="w-full max-w-2xl text-center">
            {snap.status === "briefing" && (
              <>
                {/* Only before the first episode. It is an overture, not a
                    loading screen — reading it six times would make it wallpaper. */}
                {snap.missionIndex === 0 && (
                  <p className="mx-auto mb-9 max-w-2xl text-[13px] italic leading-relaxed text-amber-100/45 sm:text-[15px]">
                    {MONOLOGUE}
                  </p>
                )}
                <p className="font-mono text-[10px] uppercase tracking-[0.6em] text-amber-300/55">
                  Episode {snap.missionIndex + 1} of {MISSIONS.length}
                </p>
                <h2 className="mt-4 text-3xl font-black tracking-[0.16em] text-amber-200 sm:text-5xl">{mission.title}</h2>
                <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.32em] text-amber-200/45">
                  Stardate {mission.stardate}
                </p>
                <p className="mx-auto mt-6 max-w-xl text-[15px] leading-relaxed text-white/70">{mission.teaser}</p>
                <ul className="mx-auto mt-6 max-w-lg space-y-1.5 text-left">
                  {mission.briefing.map((b) => (
                    <li key={b} className="flex gap-2.5 font-mono text-[11px] leading-relaxed text-amber-100/60">
                      <span className="text-amber-400">▸</span>
                      {b}
                    </li>
                  ))}
                </ul>
                <button
                  onClick={() => {
                    engine.ctx.services.audio?.unlock();
                    engine.ctx.services.audio?.cue("fanfare");
                    engine.ctx.services.game?.advance();
                  }}
                  className="mt-9 rounded-full bg-amber-400 px-10 py-3 text-sm font-bold uppercase tracking-[0.24em] text-black shadow-[0_0_50px_rgba(251,191,36,0.35)] transition hover:bg-amber-300"
                >
                  Assume command
                </button>
                <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/25">
                  Mouse to look around the bridge · full orders under ORDERS
                </p>
              </>
            )}

            {snap.status === "won" && (
              <>
                <p className="font-mono text-[10px] uppercase tracking-[0.6em] text-emerald-300/70">Mission complete</p>
                <h2 className="mt-4 text-3xl font-black tracking-[0.14em] text-emerald-200 sm:text-4xl">{mission.title}</h2>
                <p className="mx-auto mt-6 max-w-xl text-[15px] leading-relaxed text-white/70">{mission.victory}</p>
                <button
                  onClick={() => engine.ctx.services.game?.advance()}
                  className="mt-9 rounded-full bg-emerald-400 px-10 py-3 text-sm font-bold uppercase tracking-[0.24em] text-black transition hover:bg-emerald-300"
                >
                  {snap.missionIndex >= MISSIONS.length - 1 ? "Return to Earth" : "Warp to the next heading"}
                </button>
              </>
            )}

            {snap.status === "lost" && (
              <>
                <p className="font-mono text-[10px] uppercase tracking-[0.6em] text-red-400/70">
                  {mission.id === "kobayashi" ? "Simulation terminated" : "The Vibeverse is lost"}
                </p>
                <h2 className="mt-4 text-3xl font-black tracking-[0.14em] text-red-300 sm:text-4xl">{mission.title}</h2>
                <p className="mx-auto mt-6 max-w-xl text-[15px] leading-relaxed text-white/70">{mission.defeat}</p>
                {/* The Kobayashi Maru is supposed to end this way, so losing it
                    moves you on rather than back to the start. */}
                <div className="mt-9 flex flex-wrap justify-center gap-3">
                  <button
                    onClick={() => engine.ctx.services.game?.advance()}
                    className="rounded-full border border-white/25 px-8 py-3 text-sm font-bold uppercase tracking-[0.2em] text-white/80 transition hover:border-white/60 hover:text-white"
                  >
                    Run it again
                  </button>
                  {mission.id === "kobayashi" && (
                    <button
                      onClick={() => {
                        const g = engine.ctx.services.game;
                        if (!g) return;
                        g.mission = 0;
                        // Losing the no-win scenario is the pass condition.
                        (g as unknown as { status: string }).status = "won";
                        g.advance();
                      }}
                      className="rounded-full bg-amber-400 px-8 py-3 text-sm font-bold uppercase tracking-[0.2em] text-black transition hover:bg-amber-300"
                    >
                      Accept the grade → next episode
                    </button>
                  )}
                </div>
              </>
            )}

            {snap.status === "complete" && (
              <>
                <p className="font-mono text-[10px] uppercase tracking-[0.6em] text-amber-300/60">
                  Captain's log, final entry
                </p>
                <h2 className="mt-5 text-3xl font-black tracking-[0.14em] text-amber-200 sm:text-5xl">
                  THE FINAL FRONTIER
                </h2>
                <p className="mx-auto mt-7 max-w-xl text-[15px] leading-relaxed text-white/70">
                  Five headings, five ways to be outmatched, and a ship that came back from all of them. The
                  Vibeverse is ordered home for refit. Whatever is out past the last chart is still out there, and
                  it will still be there when she is ready.
                </p>
                <button
                  onClick={() => engine.ctx.services.game?.advance()}
                  className="mt-9 rounded-full bg-amber-400 px-10 py-3 text-sm font-bold uppercase tracking-[0.24em] text-black transition hover:bg-amber-300"
                >
                  Take her out again
                </button>
              </>
            )}

            {/* The way back to the hub, only ever shown between episodes. */}
            <Link
              to="/"
              className="mt-10 block font-mono text-[10px] uppercase tracking-[0.34em] text-white/25 transition hover:text-white/60"
            >
              ← back to the vibeverse
            </Link>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

const SYSTEM_LABEL: Record<string, string> = {
  warp: "WARP",
  impulse: "IMPULSE",
  phasers: "PHASERS",
  torpedoes: "TUBES",
  sensors: "SENSORS",
  shields: "DEFLECTORS",
  lifeSupport: "LIFE SUP",
};

const KEYS: [string, string][] = [
  ["W / S", "pitch"],
  ["A / D", "yaw"],
  ["Q / E", "roll"],
  ["SHIFT / CTRL", "impulse power"],
  ["X", "all stop"],
  ["SPACE / LMB", "fire phasers"],
  ["T", "photon torpedo"],
  ["R", "next target"],
  ["C", "science station: scan"],
  ["H", "hailing frequencies"],
  ["Y", "red alert"],
  ["F", "evasive"],
  ["1 / 2 / 3", "power: engines / shields / weapons"],
  ["Z", "magnification"],
  ["TAB", "change view"],
  ["MOUSE", "look around the bridge"],
];

/**
 * The opening.
 *
 * Written rather than quoted — the famous one is somebody's property, and in
 * any case the point is not to recite it but to set the register: this is a
 * ship whose job is to find things out, and only incidentally to shoot. Two
 * sentences, and the player knows what kind of story they are in before they
 * have pressed anything.
 */
const MONOLOGUE =
  "Space. Still the last frontier, and still very nearly empty of us. " +
  "These are the voyages of the starship Vibeverse: to make the unknown a little smaller, to find out who else is out here, " +
  "and to go — carefully first, and then boldly — a very long way past the edge of the chart.";

function avg(v: number[]): number {
  return (v[0] + v[1] + v[2] + v[3]) / 4;
}

/**
 * The four shields as a rose rather than four bars.
 *
 * A bar chart tells you a number; the rose tells you *which way to point*,
 * which is the only thing you actually do with the information.
 */
function ShieldRose({ shields, up }: { shields: number[]; up: boolean }) {
  const seg = (v: number, i: number) => {
    const colour = !up ? "#3a3a44" : v > 0.55 ? "#7fb8e8" : v > 0.22 ? "#ffcf5c" : v > 0.03 ? "#ff8a4a" : "#ff3a2a";
    const alpha = !up ? 0.35 : 0.35 + v * 0.65;
    const rot = [0, 180, 270, 90][i];
    return (
      <div
        key={i}
        className="absolute inset-0"
        style={{ transform: `rotate(${rot}deg)` }}
      >
        <div
          className="absolute left-1/2 top-0 h-[13px] w-[30px] -translate-x-1/2 rounded-t-full"
          style={{ background: colour, opacity: alpha }}
        />
      </div>
    );
  };
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative h-[58px] w-[58px]">
        {shields.map((v, i) => seg(v, i))}
        <div className="absolute inset-[15px] rounded-full border border-amber-200/30 bg-black/60" />
        <div className="absolute inset-0 flex items-center justify-center font-mono text-[8px] uppercase tracking-[0.1em] text-amber-200/70">
          {up ? "UP" : "DOWN"}
        </div>
      </div>
      <div className="font-mono text-[8.5px] uppercase leading-[1.5] tracking-[0.1em] text-amber-200/55">
        <div>FWD {Math.round(shields[0] * 100)}</div>
        <div>AFT {Math.round(shields[1] * 100)}</div>
        <div>PRT {Math.round(shields[2] * 100)}</div>
        <div>STB {Math.round(shields[3] * 100)}</div>
      </div>
    </div>
  );
}

function Bar({ label, value, colour, compact }: { label: string; value: number; colour: string; compact?: boolean }) {
  return (
    <div className={compact ? "mt-0.5" : "mt-2 w-[152px]"}>
      <div className="flex justify-between font-mono text-[8.5px] uppercase tracking-[0.14em] text-amber-200/55">
        <span>{label}</span>
        <span>{Math.round(value * 100)}%</span>
      </div>
      <div className="mt-0.5 h-[3px] overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${Math.max(0, value) * 100}%`, background: colour }} />
      </div>
    </div>
  );
}

function PowerBar({ label, value, hint, colour }: { label: string; value: number; hint: string; colour: string }) {
  return (
    <div className="mt-1 w-[132px]">
      <div className="flex justify-between font-mono text-[8.5px] uppercase tracking-[0.14em] text-amber-200/55">
        <span>
          <span className="mr-1 text-amber-400/70">{hint}</span>
          {label}
        </span>
        <span>{Math.round(value * 100)}</span>
      </div>
      <div className="mt-0.5 h-[3px] overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${value * 100}%`, background: colour }} />
      </div>
    </div>
  );
}

function TouchKey({ label, onDown, onUp }: { label: string; onDown: () => void; onUp?: () => void }) {
  return (
    <button
      onPointerDown={(e) => {
        e.preventDefault();
        onDown();
      }}
      onPointerUp={(e) => {
        e.preventDefault();
        onUp?.();
      }}
      onPointerLeave={() => onUp?.()}
      className="h-11 w-[68px] select-none rounded border border-amber-300/40 bg-black/65 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-amber-200 active:bg-amber-400 active:text-black"
    >
      {label}
    </button>
  );
}

/**
 * The helm, for a thumb.
 *
 * Writes into the same `touchAxes` object the keyboard folds in, so nothing
 * downstream of the input system ever learns which one it was.
 */
function TouchStick({ engine }: { engine: Engine }) {
  const ref = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const active = useRef(false);

  const axes = () =>
    (engine.ctx.services as Record<string, unknown>).touchAxes as { yaw: number; pitch: number; throttle: number };

  const set = (x: number, y: number) => {
    setKnob({ x, y });
    const a = axes();
    if (a) {
      a.yaw = x;
      a.pitch = -y;
    }
  };

  const move = (e: React.PointerEvent) => {
    if (!active.current || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width - 0.5) * 2;
    const y = ((e.clientY - r.top) / r.height - 0.5) * 2;
    const m = Math.max(1, Math.hypot(x, y));
    set(x / m, y / m);
  };

  return (
    <div
      ref={ref}
      onPointerDown={(e) => {
        active.current = true;
        engine.ctx.input.touch = true;
        move(e);
      }}
      onPointerMove={move}
      onPointerUp={() => {
        active.current = false;
        set(0, 0);
      }}
      onPointerLeave={() => {
        active.current = false;
        set(0, 0);
      }}
      className="pointer-events-auto absolute bottom-[92px] left-3 z-30 h-[112px] w-[112px] touch-none rounded-full border border-amber-300/30 bg-black/45 sm:hidden"
    >
      <div
        className="absolute left-1/2 top-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full border border-amber-300/50 bg-amber-300/25"
        style={{ transform: `translate(calc(-50% + ${knob.x * 32}px), calc(-50% + ${knob.y * 32}px))` }}
      />
    </div>
  );
}
