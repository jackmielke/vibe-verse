/**
 * VIBE CUP — the page.
 *
 * Five-a-side arcade soccer in a cage: pass, shoot, slide, golden goal.
 * One player against the computer or two people on one keyboard (or two
 * gamepads, or a pad and a keyboard). Phones get a thumb stick and two
 * buttons.
 *
 * Thin, like every world here: the rules are `src/vibecup/game.ts` (pure,
 * tested in `src/test/vibeCup.test.ts`), the drawing is `render.ts`, the
 * noise is `audio.ts`. This file owns the menus, the input and the loop.
 *
 * `window.__vibecup` is the test hook: `state()`, `start(opts)`,
 * `settle(seconds)`, `auto(on)` and `input(ctrl, input)`, because SwiftShader
 * draws a frame a second and nothing can be played at that speed.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type PointerEvent as RPointerEvent } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import {
  autopilot, clockLabel, CLUBS, clubById, newGame, setInput, step, type Difficulty, type Game, type Input, type TeamId,
} from "@/vibecup/game";
import { drawFrame, feedFx, fitView, newFx, PAD_COLORS, screenToWorld, type Fx, type View } from "@/vibecup/render";
import { CupAudio } from "@/vibecup/audio";

const MUTE_KEY = "vibecup.muted";
const PREFS_KEY = "vibecup.prefs";
const RECORD_KEY = "vibecup.record";

type Mode = "cpu" | "versus";
type Screen = "title" | "playing" | "paused" | "over";
interface Prefs {
  mode: Mode;
  club: string;
  rival: string;
  difficulty: Difficulty;
}
interface Record3 {
  w: number;
  d: number;
  l: number;
}

const read = <T,>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode */
  }
};

const isShot = () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");
const coarse = () => typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches ?? false);

/** Keyboard layouts. In one-player mode both sets drive player one. */
const P1_KEYS = { up: ["KeyW"], down: ["KeyS"], left: ["KeyA"], right: ["KeyD"], a: ["KeyF"], b: ["KeyG"], sprint: ["ShiftLeft"] };
const P2_KEYS = { up: ["ArrowUp"], down: ["ArrowDown"], left: ["ArrowLeft"], right: ["ArrowRight"], a: ["KeyK", "Comma"], b: ["KeyL", "Period"], sprint: ["ShiftRight", "KeyO"] };
const SOLO_KEYS = {
  up: ["KeyW", "ArrowUp"],
  down: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  a: ["KeyJ", "KeyX", "KeyF"],
  b: ["KeyK", "KeyZ", "Space", "KeyG"],
  sprint: ["ShiftLeft", "ShiftRight", "KeyL"],
};
type KeyMap = typeof P1_KEYS;

interface Hud {
  score: [number, number];
  clock: string;
  has: boolean;
}

export default function VibeCup() {
  useWorldStamp("/vibe-cup", "Vibe Cup");

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const prefsRef = useRef<Prefs>(read<Prefs>(PREFS_KEY, { mode: "cpu", club: "volts", rival: "rovers", difficulty: "normal" }));
  const gameRef = useRef<Game>(newGame({ seed: 1, clubs: [prefsRef.current.club, prefsRef.current.rival], humans: [] }));
  const fxRef = useRef<Fx>(newFx(gameRef.current.clubs));
  const viewRef = useRef<View>({ w: 800, h: 500, dpr: 1, portrait: false, s: 20, camX: 0, camY: 0 });
  const audioRef = useRef<CupAudio>(new CupAudio());
  const screenRef = useRef<Screen>("title");
  const autoRef = useRef(false);
  const keys = useRef(new Set<string>());
  /** Keys pressed since the last frame: a tap quicker than a frame still counts as one frame held. */
  const tapped = useRef(new Set<string>());
  const touch = useRef({ mx: 0, my: 0, a: false, b: false, on: false, tapA: false, tapB: false });

  const [screen, setScreenState] = useState<Screen>("title");
  const [prefs, setPrefsState] = useState<Prefs>(prefsRef.current);
  const [hud, setHud] = useState<Hud>({ score: [0, 0], clock: "0'", has: false });
  const [muted, setMuted] = useState<boolean>(() => read(MUTE_KEY, { m: false }).m);
  const [record, setRecord] = useState<Record3>(() => read<Record3>(RECORD_KEY, { w: 0, d: 0, l: 0 }));
  const [touchUi] = useState(coarse);
  const [result, setResult] = useState<{ score: [number, number]; winner: TeamId | null; stats: Game["stats"] } | null>(null);

  const setScreen = useCallback((s: Screen) => {
    screenRef.current = s;
    setScreenState(s);
  }, []);
  const setPrefs = (p: Partial<Prefs>) => {
    const next = { ...prefsRef.current, ...p };
    if (next.rival === next.club) next.rival = CLUBS.find((c) => c.id !== next.club)!.id;
    prefsRef.current = next;
    setPrefsState(next);
    write(PREFS_KEY, next);
  };

  const start = useCallback(
    (over?: Partial<Prefs> & { seed?: number }) => {
      audioRef.current.unlock();
      const p = { ...prefsRef.current, ...over };
      const g = newGame({
        seed: over?.seed ?? (Date.now() & 0xffff) + 1,
        clubs: [p.club, p.rival],
        difficulty: p.difficulty,
        humans: p.mode === "versus" ? [0, 1] : [0],
      });
      gameRef.current = g;
      fxRef.current = newFx(g.clubs);
      setResult(null);
      setScreen("playing");
    },
    [setScreen],
  );

  const togglePause = useCallback(() => {
    const s = screenRef.current;
    if (s === "playing") setScreen("paused");
    else if (s === "paused") setScreen("playing");
  }, [setScreen]);

  useEffect(() => {
    audioRef.current.setMuted(muted);
    write(MUTE_KEY, { m: muted });
  }, [muted]);

  // Sizing.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const v = fitView(wrap.clientWidth, wrap.clientHeight, dpr, viewRef.current);
      viewRef.current = v;
      canvas.width = Math.round(v.w * dpr);
      canvas.height = Math.round(v.h * dpr);
      canvas.style.width = `${v.w}px`;
      canvas.style.height = `${v.h}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  /** Everything a person is pressing, turned into one Input per controller. */
  const gather = useCallback((g: Game) => {
    const v = viewRef.current;
    const versus = g.ctrls.length > 1;
    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? Array.from(navigator.getGamepads()).filter((p): p is Gamepad => !!p) : [];
    const k = keys.current;
    const tap = tapped.current;
    const held = (list: string[]) => list.some((c) => k.has(c) || tap.has(c));
    const fromKeys = (m: KeyMap): Input => {
      const sx = (held(m.right) ? 1 : 0) - (held(m.left) ? 1 : 0);
      const sy = (held(m.down) ? 1 : 0) - (held(m.up) ? 1 : 0);
      const l = Math.hypot(sx, sy) || 1;
      const w = screenToWorld(v, sx / l, sy / l);
      return { mx: w.x, my: w.y, a: held(m.a), b: held(m.b), sprint: held(m.sprint) };
    };
    const merge = (a: Input, b: Input): Input => {
      const big = Math.hypot(b.mx, b.my) > Math.hypot(a.mx, a.my) ? b : a;
      return { mx: big.mx, my: big.my, a: a.a || b.a, b: a.b || b.b, sprint: a.sprint || b.sprint };
    };
    const fromPad = (p: Gamepad | undefined): Input => {
      if (!p) return { mx: 0, my: 0, a: false, b: false, sprint: false };
      let sx = p.axes[0] ?? 0;
      let sy = p.axes[1] ?? 0;
      if (Math.hypot(sx, sy) < 0.2) {
        sx = (p.buttons[15]?.pressed ? 1 : 0) - (p.buttons[14]?.pressed ? 1 : 0);
        sy = (p.buttons[13]?.pressed ? 1 : 0) - (p.buttons[12]?.pressed ? 1 : 0);
      }
      const w = screenToWorld(v, sx, sy);
      const btn = (i: number) => !!p.buttons[i]?.pressed;
      return { mx: w.x, my: w.y, a: btn(0), b: btn(1) || btn(2), sprint: btn(5) || btn(7) || btn(4) || btn(6) };
    };
    const t = touch.current;
    const tw = screenToWorld(v, t.mx, t.my);
    const fromTouch: Input = { mx: tw.x, my: tw.y, a: t.a || t.tapA, b: t.b || t.tapB, sprint: Math.hypot(t.mx, t.my) > 0.85 };
    t.tapA = t.tapB = false;
    tap.clear();
    if (versus) {
      setInput(g, 0, merge(merge(fromKeys(P1_KEYS), fromPad(pads[0])), fromTouch));
      setInput(g, 1, merge(fromKeys(P2_KEYS), fromPad(pads[1])));
    } else {
      let inp = merge(fromKeys(SOLO_KEYS), fromTouch);
      for (const p of pads) inp = merge(inp, fromPad(p));
      setInput(g, 0, inp);
    }
  }, []);

  // The loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let raf = 0;
    let last = performance.now();
    let shown = "";
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const g = gameRef.current;
      const playing = screenRef.current === "playing" || (screenRef.current === "title" && !isShot());
      if (playing) {
        if (screenRef.current === "playing") {
          gather(g);
          if (autoRef.current) g.ctrls.forEach((_, i) => setInput(g, i, autopilot(g, i)));
        }
        // Two half-steps: smoother for fast balls on a slow frame.
        step(g, dt / 2);
        step(g, dt / 2);
      }
      if (screenRef.current === "playing") for (const e of g.events) audioRef.current.play(e);
      feedFx(fxRef.current, g, g.events);
      const ended = g.events.find((e) => e.type === "fulltime");
      g.events.length = 0;
      // The title screen plays a computer match behind the menu; start a new one when it ends.
      if (screenRef.current === "title" && g.phase === "over" && g.phaseT > 4) {
        gameRef.current = newGame({ seed: (now & 0xffff) + 3, clubs: [prefsRef.current.club, prefsRef.current.rival], humans: [] });
        fxRef.current = newFx(gameRef.current.clubs);
      }
      if (ended && ended.type === "fulltime" && screenRef.current === "playing") {
        const res = { score: [...g.score] as [number, number], winner: ended.winner, stats: g.stats };
        if (g.ctrls.length === 1 && !isShot()) {
          setRecord((r) => {
            const n = { ...r };
            if (ended.winner === 0) n.w++;
            else if (ended.winner === null) n.d++;
            else n.l++;
            write(RECORD_KEY, n);
            return n;
          });
        }
        window.setTimeout(() => {
          if (gameRef.current === g) {
            setResult(res);
            setScreen("over");
          }
        }, 2600);
      }
      const c0 = g.ctrls[0];
      const has = !!c0 && g.ball.owner === c0.active;
      const key = `${g.score[0]}-${g.score[1]}-${clockLabel(g)}-${has}`;
      if (key !== shown) {
        shown = key;
        setHud({ score: [...g.score] as [number, number], clock: clockLabel(g), has });
      }
      const labels = g.ctrls.length > 1 ? ["P1", "P2"] : ["YOU"];
      drawFrame(ctx, g, viewRef.current, fxRef.current, dt, labels);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [gather, setScreen]);

  // Keys.
  useEffect(() => {
    const game = new Set(["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
    const down = (e: KeyboardEvent) => {
      if (screenRef.current === "playing" && game.has(e.code)) e.preventDefault();
      keys.current.add(e.code);
      tapped.current.add(e.code);
      audioRef.current.unlock();
      if (e.code === "Escape" || e.code === "KeyP") togglePause();
      else if (e.code === "KeyM") setMuted((m) => !m);
      else if (e.code === "Enter" && (screenRef.current === "title" || screenRef.current === "over")) start();
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.code);
    const blur = () => keys.current.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [start, togglePause]);

  // Leaving the tab pauses.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden && screenRef.current === "playing") setScreen("paused");
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [setScreen]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => audio.close();
  }, []);

  // Card art: a match a few seconds in, our forward bearing down on goal.
  useEffect(() => {
    if (!isShot()) return;
    const g = newGame({ seed: 12, clubs: ["volts", "rovers"], humans: [0] });
    for (let t = 0; t < 3; t += 1 / 60) {
      step(g, 1 / 60);
      g.events.length = 0;
    }
    // Our number 9 bearing down on goal with a full bar, two Rovers closing in.
    const place = (i: number, x: number, y: number, face: number) => Object.assign(g.players[i], { x, y, face, vx: Math.cos(face) * 5, vy: Math.sin(face) * 5, stun: 0, slide: 0 });
    place(4, 15, 2.2, -0.12);
    place(3, 9, -6, 0.3);
    place(1, 2, -9, 0);
    place(2, 4, 8, 0);
    place(5, 24.4, 0.6, Math.PI);
    place(6, 18.5, 4.5, Math.PI + 0.5);
    place(7, 18, -1.5, Math.PI - 0.3);
    place(8, 12, 6, -0.4);
    place(9, 6, -2, 0);
    g.ball.owner = 4;
    Object.assign(g.ball, { x: 15.8, y: 2.1, z: 0.22, vx: 5, vy: 0 });
    viewRef.current.camX = 17;
    g.phase = "play";
    g.clock = 81;
    g.score = [2, 2];
    g.ctrls[0].active = 4;
    g.ctrls[0].charge = 1;
    gameRef.current = g;
    fxRef.current = newFx(g.clubs);
    setScreen("paused");
  }, [setScreen]);

  // Test hook.
  useEffect(() => {
    const hook = {
      state: () => {
        const g = gameRef.current;
        return {
          screen: screenRef.current,
          phase: g.phase,
          score: g.score,
          clock: clockLabel(g),
          golden: g.golden,
          owner: g.ball.owner,
          ball: [g.ball.x, g.ball.y, g.ball.z],
          ctrls: g.ctrls.map((c) => ({ team: c.team, active: c.active, charge: c.charge })),
          stats: g.stats,
          view: { portrait: viewRef.current.portrait, s: viewRef.current.s },
        };
      },
      start: (o?: Partial<Prefs> & { seed?: number }) => {
        start(o);
        return hook.state();
      },
      auto: (on: boolean) => {
        autoRef.current = on;
      },
      input: (ctrl: number, inp: Partial<Input>) => setInput(gameRef.current, ctrl, inp),
      settle: (seconds: number) => {
        const g = gameRef.current;
        for (let t = 0; t < seconds; t += 1 / 60) {
          if (autoRef.current) g.ctrls.forEach((_, i) => setInput(g, i, autopilot(g, i)));
          step(g, 1 / 60);
          feedFx(fxRef.current, g, g.events.filter((e) => e.type !== "fulltime"));
          // The full-time whistle is left for the page's loop, which shows the result.
          g.events.splice(0, g.events.length, ...g.events.filter((e) => e.type === "fulltime"));
        }
        return hook.state();
      },
      clock: (s: number) => {
        gameRef.current.clock = s;
      },
    };
    (window as unknown as { __vibecup?: typeof hook }).__vibecup = hook;
    return () => {
      delete (window as unknown as { __vibecup?: typeof hook }).__vibecup;
    };
  }, [start]);

  const shot = isShot();
  const g = gameRef.current;
  const [c0, c1] = g.clubs;
  const playingUi = screen === "playing" || screen === "paused";
  const versus = g.ctrls.length > 1;

  return (
    <div
      ref={wrapRef}
      className="fixed inset-0 select-none overflow-hidden text-white"
      style={{ background: "#13202e", touchAction: "none", fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif" }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 block" />

      {/* Scoreboard */}
      {(playingUi || screen === "over") && !shot && (
        <div className="pointer-events-none absolute left-1/2 top-[max(env(safe-area-inset-top),10px)] flex -translate-x-1/2 items-stretch overflow-hidden rounded-xl border border-white/15 bg-black/70 text-sm font-black shadow-xl backdrop-blur">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5" style={{ background: c0.shirt, color: c0.ink }}>
            <span>{c0.emoji}</span>
            <span className="hidden sm:inline">{c0.short}</span>
          </div>
          <div className="flex items-center px-3 font-mono text-xl tabular-nums" data-testid="vibecup-score">
            {hud.score[0]}–{hud.score[1]}
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1.5" style={{ background: c1.shirt, color: c1.ink }}>
            <span className="hidden sm:inline">{c1.short}</span>
            <span>{c1.emoji}</span>
          </div>
          <div className="flex items-center bg-white/10 px-2.5 font-mono text-xs tabular-nums text-amber-200">{hud.clock}</div>
        </div>
      )}

      {/* Corner buttons. The global HOME button owns the top left. */}
      <div className="absolute right-3 top-[max(env(safe-area-inset-top),10px)] flex gap-1">
        <button
          type="button"
          onClick={() => setMuted((m) => !m)}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
          aria-label={muted ? "Sound on" : "Sound off"}
        >
          {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
        {playingUi && !shot && (
          <button
            type="button"
            onClick={togglePause}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
            aria-label={screen === "paused" ? "Resume" : "Pause"}
          >
            {screen === "paused" ? <Play size={16} /> : <Pause size={16} />}
          </button>
        )}
      </div>

      {/* Touch controls */}
      {touchUi && screen === "playing" && <TouchPad touch={touch} has={hud.has} />}

      {/* Keyboard hint */}
      {!touchUi && screen === "playing" && (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-black/45 px-2.5 py-1.5 text-[11px] leading-snug text-white/75">
          {versus ? (
            <>
              <span style={{ color: PAD_COLORS[0] }}>P1</span> WASD · F pass · G shoot · L-Shift sprint
              <br />
              <span style={{ color: PAD_COLORS[1] }}>P2</span> Arrows · K pass · L shoot · R-Shift sprint
            </>
          ) : (
            <>Move: arrows or WASD · Pass/switch: J or X · Shoot/slide: K, Z or Space (hold to power up) · Sprint: Shift</>
          )}
        </div>
      )}

      {screen === "title" && <TitleCard prefs={prefs} setPrefs={setPrefs} onStart={() => start()} record={record} touchUi={touchUi} />}

      {screen === "paused" && !shot && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
          <div className="rounded-3xl bg-[#0b1726]/95 px-8 py-6 text-center">
            <div className="text-2xl font-black">Paused</div>
            <button type="button" onClick={togglePause} className="mt-4 w-full rounded-2xl bg-emerald-400 px-6 py-2.5 font-black text-[#002016]">
              Back to the match
            </button>
            <button type="button" onClick={() => setScreen("title")} className="mt-2 w-full rounded-2xl bg-white/10 px-6 py-2 text-sm font-bold">
              Quit to menu
            </button>
          </div>
        </div>
      )}

      {screen === "over" && result && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/55 p-3">
          <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#0b1726]/95 p-6 text-center">
            <div className="text-xs font-bold tracking-[0.3em] text-white/60">FULL TIME</div>
            <div className="mt-2 flex items-center justify-center gap-3 text-4xl font-black tabular-nums">
              <span style={{ color: c0.shirt }}>{c0.emoji}</span>
              <span>
                {result.score[0]} – {result.score[1]}
              </span>
              <span style={{ color: c1.shirt }}>{c1.emoji}</span>
            </div>
            <div className="mt-2 text-lg font-black" style={{ color: result.winner === null ? "#fff" : g.clubs[result.winner].shirt }}>
              {result.winner === null
                ? "Honours even"
                : !versus
                  ? result.winner === 0
                    ? "You win the Vibe Cup! 🏆"
                    : `${g.clubs[1].name} win it`
                  : `${result.winner === 0 ? "P1" : "P2"} wins with ${g.clubs[result.winner].name}! 🏆`}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-1 text-xs text-white/70">
              <div />
              <div className="font-bold">{c0.short}</div>
              <div className="font-bold">{c1.short}</div>
              {(["shots", "saves", "tackles"] as const).map((k) => (
                <Row key={k} label={k} a={result.stats[k][0]} b={result.stats[k][1]} />
              ))}
            </div>
            {!versus && (
              <div className="mt-3 text-xs text-white/60">
                Your record: {record.w} won · {record.d} drawn · {record.l} lost
              </div>
            )}
            <button
              type="button"
              onClick={() => start()}
              className="mt-5 w-full rounded-2xl py-3 text-lg font-black text-[#002016] shadow-lg active:scale-[0.98]"
              style={{ background: "linear-gradient(180deg,#6ff7d2,#1fd1b0)" }}
            >
              Rematch
            </button>
            <button type="button" onClick={() => setScreen("title")} className="mt-2 w-full rounded-2xl bg-white/10 py-2 text-sm font-bold">
              Change teams
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, a, b }: { label: string; a: number; b: number }) {
  return (
    <>
      <div className="text-left capitalize">{label}</div>
      <div className="font-mono tabular-nums">{a}</div>
      <div className="font-mono tabular-nums">{b}</div>
    </>
  );
}

function TitleCard({
  prefs,
  setPrefs,
  onStart,
  record,
  touchUi,
}: {
  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void;
  onStart: () => void;
  record: Record3;
  touchUi: boolean;
}) {
  const ClubPick = ({ value, other, onPick, label }: { value: string; other: string; onPick: (id: string) => void; label: string }) => (
    <div>
      <div className="mb-1 text-left text-[10px] font-bold tracking-[0.2em] text-white/55">{label}</div>
      <div className="flex gap-1.5">
        {CLUBS.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={c.id === other}
            onClick={() => onPick(c.id)}
            title={c.name}
            className={`flex h-11 flex-1 items-center justify-center rounded-xl text-lg transition ${c.id === value ? "ring-2 ring-white" : "opacity-70 hover:opacity-100"} disabled:opacity-20`}
            style={{ background: c.shirt }}
          >
            {c.emoji}
          </button>
        ))}
      </div>
      <div className="mt-1 text-left text-xs font-bold" style={{ color: clubById(value).shirt }}>
        {clubById(value).name}
      </div>
    </div>
  );
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto bg-black/35 p-3">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[#0b1726]/92 p-5 text-center shadow-2xl backdrop-blur">
        <div className="text-4xl">⚽</div>
        <h1 className="mt-1 text-4xl font-black italic tracking-tight" style={{ color: "#6ff7d2", textShadow: "0 0 18px #1fd1b088" }}>
          VIBE CUP
        </h1>
        <p className="mt-1 text-sm text-white/75">Five-a-side in the cage. Pass it about, slide in, and hold shoot for a SUPER SHOT.</p>

        <div className="mt-4 grid grid-cols-2 gap-2">
          {(
            [
              ["cpu", "1 player", "You against the computer"],
              ["versus", "2 players", touchUi ? "Plug in two pads or share a keyboard" : "One keyboard, or two pads"],
            ] as const
          ).map(([m, t, sub]) => (
            <button
              key={m}
              type="button"
              onClick={() => setPrefs({ mode: m })}
              className={`rounded-2xl px-3 py-2.5 text-left transition ${prefs.mode === m ? "bg-emerald-400 text-[#002016]" : "bg-white/8 hover:bg-white/15"}`}
              style={prefs.mode === m ? undefined : { background: "rgba(255,255,255,0.08)" }}
            >
              <div className="font-black">{t}</div>
              <div className={`text-[11px] leading-tight ${prefs.mode === m ? "text-[#002016]/80" : "text-white/60"}`}>{sub}</div>
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-3">
          <ClubPick label={prefs.mode === "versus" ? "PLAYER 1" : "YOUR CLUB"} value={prefs.club} other={prefs.rival} onPick={(id) => setPrefs({ club: id })} />
          <ClubPick label={prefs.mode === "versus" ? "PLAYER 2" : "OPPONENTS"} value={prefs.rival} other={prefs.club} onPick={(id) => setPrefs({ rival: id })} />
        </div>

        {prefs.mode === "cpu" && (
          <div className="mt-4 flex gap-1.5">
            {(["easy", "normal", "hard"] as Difficulty[]).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setPrefs({ difficulty: d })}
                className={`flex-1 rounded-xl py-1.5 text-sm font-bold capitalize ${prefs.difficulty === d ? "bg-amber-300 text-black" : "text-white/70"}`}
                style={prefs.difficulty === d ? undefined : { background: "rgba(255,255,255,0.08)" }}
              >
                {d}
              </button>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={onStart}
          data-testid="vibecup-kickoff"
          className="mt-5 w-full rounded-2xl py-3 text-lg font-black text-[#002016] shadow-lg active:scale-[0.98]"
          style={{ background: "linear-gradient(180deg,#6ff7d2,#1fd1b0)" }}
        >
          Kick off
        </button>
        <p className="mt-3 text-xs leading-relaxed text-white/55">
          {touchUi
            ? "Left thumb runs (push to the edge to sprint). PASS passes, or switches player when you are defending. SHOOT shoots (hold it to power up), or slide tackles."
            : "Arrows or WASD to run, Shift to sprint. J passes (hold for a lob) or switches player. K or Space shoots (hold to power up) or slide tackles. Gamepads work too."}
        </p>
        {record.w + record.d + record.l > 0 && (
          <p className="mt-2 text-xs text-white/45">
            Record: {record.w}W {record.d}D {record.l}L
          </p>
        )}
      </div>
    </div>
  );
}

/** A floating thumb stick on the left half, two buttons on the right. */
function TouchPad({ touch, has }: { touch: MutableRefObject<{ mx: number; my: number; a: boolean; b: boolean; on: boolean; tapA: boolean; tapB: boolean }>; has: boolean }) {
  const [stick, setStick] = useState<{ ox: number; oy: number; x: number; y: number } | null>(null);
  const id = useRef<number | null>(null);
  const R = 56;
  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (id.current !== null) return;
    id.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    setStick({ ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY });
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    if (id.current !== e.pointerId || !stick) return;
    let dx = e.clientX - stick.ox;
    let dy = e.clientY - stick.oy;
    const l = Math.hypot(dx, dy);
    if (l > R) {
      dx = (dx / l) * R;
      dy = (dy / l) * R;
    }
    touch.current.mx = dx / R;
    touch.current.my = dy / R;
    setStick({ ...stick, x: stick.ox + dx, y: stick.oy + dy });
  };
  const up = (e: RPointerEvent<HTMLDivElement>) => {
    if (id.current !== e.pointerId) return;
    id.current = null;
    touch.current.mx = touch.current.my = 0;
    setStick(null);
  };
  const btn = (which: "a" | "b", on: boolean) => () => {
    touch.current[which] = on;
    if (on) touch.current[which === "a" ? "tapA" : "tapB"] = true;
  };
  return (
    <>
      <div className="absolute bottom-0 left-0 top-16 w-1/2" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} data-testid="vibecup-stick">
        {stick ? (
          <>
            <div className="pointer-events-none absolute rounded-full border-2 border-white/30 bg-white/10" style={{ left: stick.ox - R, top: stick.oy - R, width: R * 2, height: R * 2 }} />
            <div className="pointer-events-none absolute h-14 w-14 rounded-full bg-white/60" style={{ left: stick.x - 28, top: stick.y - 28 }} />
          </>
        ) : (
          <div className="pointer-events-none absolute bottom-10 left-8 flex h-28 w-28 items-center justify-center rounded-full border-2 border-white/20 text-xs font-bold text-white/40">
            RUN
          </div>
        )}
      </div>
      <div className="absolute bottom-[max(env(safe-area-inset-bottom),18px)] right-4 flex items-end gap-3">
        {(
          [
            ["a", has ? "PASS" : "SWITCH", "#38bdf8", 64],
            ["b", has ? "SHOOT" : "SLIDE", "#fb7185", 78],
          ] as const
        ).map(([k, label, col, size]) => (
          <button
            key={k}
            type="button"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              btn(k, true)();
            }}
            onPointerUp={btn(k, false)}
            onPointerCancel={btn(k, false)}
            onContextMenu={(e) => e.preventDefault()}
            className="flex items-center justify-center rounded-full border-2 border-white/40 text-xs font-black shadow-lg active:scale-95"
            style={{ width: size, height: size, background: `${col}cc`, marginBottom: k === "a" ? 0 : 22 }}
            data-testid={`vibecup-${k}`}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );
}
