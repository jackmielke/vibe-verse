/**
 * MORT'S MAZE — the page.
 *
 * A maze chase on Vibe Island at night. Vibey rolls round the hedges eating
 * Vibey Coins while Mad Mort and his junkyard crew hunt it down; a water
 * balloon soaks the lot of them for a few seconds and then they are the ones
 * running.
 *
 * Thin, like every world here: the rules are `src/mortmaze/game.ts` (pure,
 * tested in `src/test/mortMaze.test.ts`), the drawing is `render.ts`, and the
 * noises are `audio.ts`. This file owns the menus, the input and the loop.
 *
 * Input is a swipe anywhere on the screen (it turns as soon as the finger has
 * moved far enough, without waiting for it to lift), or arrows / WASD.
 * A turn is buffered, so swiping a little early at a junction still takes it.
 *
 * `window.__mortmaze` is the test hook: `state()`, `settle(seconds)`,
 * `steer(dir)` and `start()`, because SwiftShader draws a frame a second and
 * nothing can be played at that speed.
 */
import { reportArcadeScore } from "@/arcade/report";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import {
  autopilot, CREW, newGame, run, SNACKS, steer, type Dir, type Game,
} from "@/mortmaze/game";
import { MAZES } from "@/mortmaze/mazes";
import { drawChaser, drawFrame, drawVibey, fitView, type View } from "@/mortmaze/render";
import { MazeAudio } from "@/mortmaze/audio";

const BEST_KEY = "mortmaze.best";
const MUTE_KEY = "mortmaze.muted";

const readBest = (): number => {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
};
const writeBest = (n: number) => {
  try { localStorage.setItem(BEST_KEY, String(n)); } catch { /* private mode */ }
};
const readMuted = (): boolean => {
  try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; }
};

const KEY_DIRS: Record<string, Dir> = {
  ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3,
  w: 0, d: 1, s: 2, a: 3, W: 0, D: 1, S: 2, A: 3,
};

const isShot = (): boolean =>
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

type Screen = "title" | "playing" | "paused" | "over";

interface Hud {
  score: number;
  lives: number;
  level: number;
  maze: string;
}

/** A tiny canvas portrait for the title screen. */
function Portrait({ kind, size = 44 }: { kind: "vibey" | (typeof CREW)[number]["id"]; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const draw = (now: number) => {
      const t = now / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      if (kind === "vibey") {
        drawVibey(ctx, size / 2, size * 0.58, size * 0.32, 2, (Math.sin(t * 8) + 1) / 2, t);
      } else {
        drawChaser(ctx, { id: kind, mode: "active", dir: 2 }, size / 2, size * 0.6, size * 0.3, t, 9);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [kind, size]);
  return <canvas ref={ref} style={{ width: size, height: size }} aria-hidden />;
}

export default function MortsMaze() {
  useWorldStamp("/mort-maze", "Mort's Maze");

  const wrapRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game>(newGame(Date.now() & 0xffff));
  const viewRef = useRef<View>({ cell: 20, dpr: 1, width: 380, height: 420 });
  const audioRef = useRef<MazeAudio>(new MazeAudio());
  const screenRef = useRef<Screen>("title");
  const autoRef = useRef(false);

  const [screen, setScreenState] = useState<Screen>("title");
  const [hud, setHud] = useState<Hud>({ score: 0, lives: 3, level: 1, maze: MAZES[0].name });
  const [best, setBest] = useState<number>(readBest);
  const [muted, setMuted] = useState<boolean>(readMuted);
  const bestRef = useRef(best);

  const setScreen = useCallback((s: Screen) => {
    screenRef.current = s;
    setScreenState(s);
  }, []);

  const start = useCallback(() => {
    audioRef.current.unlock();
    gameRef.current = newGame((Date.now() & 0xffff) + 1);
    setScreen("playing");
  }, [setScreen]);

  const togglePause = useCallback(() => {
    const s = screenRef.current;
    if (s === "playing") setScreen("paused");
    else if (s === "paused") setScreen("playing");
  }, [setScreen]);

  // Mute is remembered.
  useEffect(() => {
    audioRef.current.setMuted(muted);
    try { localStorage.setItem(MUTE_KEY, muted ? "1" : "0"); } catch { /* fine */ }
  }, [muted]);

  // Sizing: the board fills whatever space the HUD leaves.
  useEffect(() => {
    const board = boardRef.current;
    const canvas = canvasRef.current;
    if (!board || !canvas) return;
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const v = fitView(board.clientWidth, board.clientHeight, dpr);
      viewRef.current = v;
      canvas.width = Math.round(v.width * dpr);
      canvas.height = Math.round(v.height * dpr);
      canvas.style.width = `${v.width}px`;
      canvas.style.height = `${v.height}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(board);
    return () => ro.disconnect();
  }, []);

  // The loop. Always draws; only simulates while playing.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let raf = 0;
    let last = performance.now();
    let shown: Hud = { score: -1, lives: -1, level: -1, maze: "" };

    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const g = gameRef.current;
      if (screenRef.current === "playing") {
        if (autoRef.current) steer(g, autopilot(g));
        run(g, dt);
      }
      // Sound and haptics.
      for (const e of g.events) {
        audioRef.current.play(e);
        if ((e.type === "die" || e.type === "bonk") && navigator.vibrate) {
          try { navigator.vibrate(e.type === "die" ? [60, 40, 120] : 30); } catch { /* fine */ }
        }
      }
      g.events.length = 0;

      if (g.score > bestRef.current && !isShot()) {
        bestRef.current = g.score;
        writeBest(g.score);
        setBest(g.score);
      }
      if (g.phase === "over" && screenRef.current === "playing") {
        setScreen("over");
        reportArcadeScore("mortmaze", g.score);
      }

      if (shown.score !== g.score || shown.lives !== g.lives || shown.level !== g.level) {
        shown = { score: g.score, lives: g.lives, level: g.level, maze: g.maze.def.name };
        setHud(shown);
      }
      drawFrame(ctx, g, viewRef.current);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [setScreen]);

  // Keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = KEY_DIRS[e.key];
      if (d !== undefined) {
        e.preventDefault();
        if (screenRef.current === "playing") steer(gameRef.current, d);
        return;
      }
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (screenRef.current === "title" || screenRef.current === "over") start();
        else togglePause();
      } else if (e.key === "p" || e.key === "P" || e.key === "Escape") {
        togglePause();
      } else if (e.key === "m" || e.key === "M") {
        setMuted((m) => !m);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [start, togglePause]);

  // Swipes, anywhere on the page.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let ox = 0;
    let oy = 0;
    let down = false;
    const onDown = (e: PointerEvent) => {
      audioRef.current.unlock();
      down = true;
      ox = e.clientX;
      oy = e.clientY;
    };
    const onMove = (e: PointerEvent) => {
      if (!down || screenRef.current !== "playing") return;
      const dx = e.clientX - ox;
      const dy = e.clientY - oy;
      if (Math.hypot(dx, dy) < 18) return;
      const d: Dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
      steer(gameRef.current, d);
      // Re-anchor, so one long drag can make several turns.
      ox = e.clientX;
      oy = e.clientY;
    };
    const onUp = () => { down = false; };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  // Leaving the tab pauses.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden && screenRef.current === "playing") setScreen("paused");
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [setScreen]);

  // Teardown: close the audio context.
  useEffect(() => {
    const audio = audioRef.current;
    return () => audio.close();
  }, []);

  // Card art: a game a few seconds in, crew out, a balloon just popped.
  useEffect(() => {
    if (!isShot()) return;
    const g = newGame(42);
    run(g, 2.3);
    for (let i = 0; i < 60 * 9; i++) {
      steer(g, autopilot(g));
      run(g, 1 / 60);
      if (g.phase !== "play" && g.phase !== "snack") break;
    }
    g.lives = Math.max(g.lives, 3);
    g.events.length = 0;
    gameRef.current = g;
    setScreen("paused");
    screenRef.current = "paused";
    // Paused draws no overlay in shot mode; see below.
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
          lives: g.lives,
          level: g.level,
          maze: g.maze.def.name,
          coinsLeft: g.coinsLeft,
          powerT: g.powerT,
          player: { x: g.player.x, y: g.player.y, dir: g.player.dir },
          crew: g.chasers.map((c) => ({ id: c.id, mode: c.mode, x: c.x, y: c.y })),
        };
      },
      start,
      /** Jump straight to a level, to look at a maze without clearing the last. */
      level: (n: number) => {
        gameRef.current = newGame(7, n);
        setScreen("playing");
        return hook.state();
      },
      steer: (d: Dir) => steer(gameRef.current, d),
      autopilot: (on: boolean) => { autoRef.current = on; },
      settle: (seconds: number) => {
        const g = gameRef.current;
        for (let t = 0; t < seconds; t += 1 / 60) {
          if (autoRef.current) steer(g, autopilot(g));
          run(g, 1 / 60);
        }
        return hook.state();
      },
    };
    (window as unknown as { __mortmaze?: typeof hook }).__mortmaze = hook;
    return () => { delete (window as unknown as { __mortmaze?: typeof hook }).__mortmaze; };
  }, [start, setScreen]);

  const shot = isShot();
  const snack = SNACKS[Math.min(SNACKS.length - 1, hud.level - 1)];

  return (
    <div
      ref={wrapRef}
      className="fixed inset-0 flex select-none flex-col overflow-hidden text-white"
      style={{
        background: "radial-gradient(120% 80% at 50% 0%, #10284d 0%, #050b18 60%, #02060e 100%)",
        touchAction: "none",
        fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
      }}
    >
      {/* Top bar */}
      <div className="flex items-center gap-2 px-3 pt-[max(env(safe-area-inset-top),10px)] pb-1">
        {/* The global HOME button sits in this corner on every fullscreen
            world, so this is just room for it. */}
        <div className="w-[104px] shrink-0" />
        <div className="flex flex-1 justify-center gap-5 text-center">
          <div>
            <div className="text-[10px] font-bold tracking-[0.2em] text-cyan-300/80">SCORE</div>
            <div className="text-xl font-black tabular-nums leading-tight">{hud.score.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-[10px] font-bold tracking-[0.2em] text-amber-300/80">BEST</div>
            <div className="text-xl font-black tabular-nums leading-tight">{best.toLocaleString()}</div>
          </div>
        </div>
        <div className="flex w-[104px] shrink-0 justify-end gap-1">
          <button
            type="button"
            onClick={() => setMuted((m) => !m)}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
            aria-label={muted ? "Sound on" : "Sound off"}
          >
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          {(screen === "playing" || screen === "paused") && !shot && (
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
      </div>

      {/* Board */}
      <div ref={boardRef} className="relative mx-2 flex min-h-0 flex-1 items-center justify-center">
        <canvas ref={canvasRef} className="block rounded-xl" />

        {screen === "title" && (
          <div className="absolute inset-0 flex items-center justify-center p-3">
            <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#071226]/90 p-5 text-center shadow-2xl backdrop-blur">
              <div className="flex justify-center"><Portrait kind="vibey" size={64} /></div>
              <h1 className="mt-1 text-4xl font-black tracking-tight" style={{ color: "#ffd23f", textShadow: "0 0 18px #ffb80088" }}>
                MORT'S MAZE
              </h1>
              <p className="mt-2 text-sm leading-snug text-white/80">
                Mad Mort's crew wants every Vibey Coin on the island. Grab them first.
                Pop a 🎈 water balloon to soak the crew, then splash them back to the junkyard.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2 text-left">
                {CREW.map((c) => (
                  <div key={c.id} className="flex items-center gap-2 rounded-xl bg-white/5 px-2 py-1.5">
                    <Portrait kind={c.id} size={36} />
                    <div className="min-w-0">
                      <div className="truncate text-xs font-extrabold" style={{ color: c.color }}>{c.name}</div>
                      <div className="text-[10px] leading-tight text-white/60">{c.bio}</div>
                    </div>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={start}
                className="mt-5 w-full rounded-2xl py-3 text-lg font-black text-[#1a1200] shadow-lg active:scale-[0.98]"
                style={{ background: "linear-gradient(180deg,#ffe066,#ffb800)" }}
              >
                Play
              </button>
              <p className="mt-3 text-xs text-white/50">
                Swipe anywhere to steer. On a keyboard, arrows or WASD. Space pauses.
              </p>
            </div>
          </div>
        )}

        {screen === "paused" && !shot && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <div className="rounded-3xl bg-[#071226]/95 px-8 py-6 text-center">
              <div className="text-2xl font-black">Paused</div>
              <button
                type="button"
                onClick={togglePause}
                className="mt-4 w-full rounded-2xl bg-cyan-400 px-6 py-2.5 font-black text-[#001820]"
              >
                Keep going
              </button>
            </div>
          </div>
        )}

        {screen === "over" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 p-3">
            <div className="w-full max-w-xs rounded-3xl border border-white/10 bg-[#071226]/95 p-6 text-center">
              <div className="flex justify-center"><Portrait kind="mort" size={56} /></div>
              <div className="mt-1 text-3xl font-black" style={{ color: "#ff4d5e" }}>Caught!</div>
              <p className="mt-1 text-sm text-white/70">Mad Mort got you on {hud.maze}, level {hud.level}.</p>
              <div className="mt-3 text-4xl font-black tabular-nums">{hud.score.toLocaleString()}</div>
              {hud.score > 0 && hud.score >= best && (
                <div className="mt-1 text-sm font-bold text-amber-300">New best!</div>
              )}
              <button
                type="button"
                onClick={start}
                className="mt-5 w-full rounded-2xl py-3 text-lg font-black text-[#1a1200]"
                style={{ background: "linear-gradient(180deg,#ffe066,#ffb800)" }}
              >
                Play again
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-between px-4 pt-1 pb-[max(env(safe-area-inset-bottom),10px)] text-sm">
        <div className="flex items-center gap-1" aria-label={`${hud.lives} lives`}>
          {Array.from({ length: Math.min(6, Math.max(0, hud.lives - (screen === "playing" ? 1 : 0))) }).map((_, i) => (
            <span key={i} className="inline-block h-4 w-4 rounded-full border-2 border-sky-300 bg-white" />
          ))}
        </div>
        <div className="font-semibold text-white/70">
          {hud.maze} · Level {hud.level}
        </div>
        <div className="text-lg" title={`Bonus snack: ${snack.name}`}>{snack.emoji}</div>
      </div>
    </div>
  );
}
