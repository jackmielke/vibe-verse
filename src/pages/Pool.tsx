/**
 * 8-BALL CLUB: the page.
 *
 * Thin, like every world here. The physics is `src/pool/physics.ts`, the rules
 * are `rules.ts`, the computer is `ai.ts` (all pure and tested in
 * `src/test/pool.test.ts`), the drawing is `render.ts`, the noises `audio.ts`
 * and the wire `net.ts`. This file owns the menus, the input and the loop.
 *
 * Controls, the same on a phone and a laptop:
 *  - Drag on the table to aim. The cue points from the cue ball at your finger.
 *  - Fine aim: the ribbed strip. Drag along it for tiny turns.
 *  - Power: pull the cue back. Either press near the cue ball and drag back
 *    away from the shot, or drag down on the power bar. Let go to shoot.
 *  - Spin: the little cue ball button. Put the dot where the tip should hit.
 *  - Keys: arrows aim (Shift for fine), hold Space for power, release to shoot.
 *
 * `window.__pool` is the test hook, because a browser without a GPU draws a
 * frame every so often and a shot needs about four hundred of them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Menu, Share2, Volume2, VolumeX, X } from "lucide-react";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import {
  type Ball, type ShotRecord, type Strike, DT, MAX_SPEED, MIN_SPEED, POCKETS, R, canPlace, cloneBalls,
  emptyRecord, nearestFree, powerToSpeed, record, simulate, step, strike as applyStrike, type SimEvent,
} from "@/pool/physics";
import {
  type Group, type PoolState, cloneState, groupOf, newGame, onEight, remaining, resolveShot,
} from "@/pool/rules";
import { type Level, type Plan, planNow, think } from "@/pool/ai";
import {
  type Drop, type View, aimGuide, clearSprites, drawFrame, drawTable, fitView, toScreen, toTable,
} from "@/pool/render";
import { BALL_COLORS, THEMES, themeById, type PoolTheme } from "@/pool/themes";
import { PoolAudio } from "@/pool/audio";
import { type NetMode, type Transport, type Wire, openTransport, roomCode } from "@/pool/net";

type Mode = "cpu" | "local" | "online";
type Screen = "menu" | "lobby" | "play";

const THEME_KEY = "pool.theme";
const MUTE_KEY = "pool.muted";
const LEVEL_KEY = "pool.level";
const STATS_KEY = "pool.stats";

const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

interface Stats { [level: string]: { w: number; l: number } }
const readStats = (): Stats => { try { return JSON.parse(read(STATS_KEY) ?? "{}") as Stats; } catch { return {}; } };

const params = (): URLSearchParams =>
  typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
const isShot = (): boolean => params().has("shot");

const LEVEL_NAMES: Record<Level, string> = { easy: "Easy", normal: "Normal", hard: "Hard" };

const speedToPower = (v: number): number =>
  Math.pow(Math.max(0, Math.min(1, (v - MIN_SPEED) / (MAX_SPEED - MIN_SPEED))), 1 / 1.6);

const angleLerp = (a: number, b: number, t: number): number => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

interface Sim {
  balls: Ball[];
  before: PoolState;
  rec: ShotRecord;
  acc: number;
  /** The shooter's result is the truth online; the watcher waits for it. */
  mine: boolean;
  done: boolean;
}

interface AiJob {
  stage: "wait" | "think" | "place" | "aim" | "pull" | "go";
  t: number;
  gen?: Generator<void, Plan, void>;
  plan?: Plan;
  fromAim: number;
  fromCue?: { x: number; y: number };
}

interface Hud {
  turn: 0 | 1;
  groups: [Group | null, Group | null];
  left: [number[], number[]];
  message: string;
  phase: string;
  winner: 0 | 1 | null;
  ballInHand: boolean;
  eight: [boolean, boolean];
  seq: number;
  isBreak: boolean;
}

function hudOf(s: PoolState): Hud {
  const left = (g: Group | null): number[] =>
    g === null ? [] : s.balls.filter((b) => b.id !== 0 && groupOf(b.id) === g).map((b) => (b.on ? b.id : -b.id));
  return {
    turn: s.turn,
    groups: [s.groups[0], s.groups[1]],
    left: [left(s.groups[0]), left(s.groups[1])],
    message: s.message,
    phase: s.phase,
    winner: s.winner,
    ballInHand: s.ballInHand,
    eight: [onEight(s, 0), onEight(s, 1)],
    seq: s.seq,
    isBreak: s.isBreak,
  };
}

/** A ball in the HUD, drawn with CSS. */
function MiniBall({ id, size = 15, dim = false }: { id: number; size?: number; dim?: boolean }) {
  const col = BALL_COLORS[id];
  const stripe = id >= 9;
  const bg = stripe
    ? `radial-gradient(circle at 35% 30%, rgba(255,255,255,0.55), transparent 45%), linear-gradient(180deg, #f7f4ea 0 24%, ${col} 24% 76%, #f7f4ea 76%)`
    : `radial-gradient(circle at 35% 30%, rgba(255,255,255,0.5), transparent 45%), ${col}`;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center rounded-full"
      style={{
        width: size, height: size, background: bg, opacity: dim ? 0.22 : 1,
        boxShadow: dim ? "none" : "inset -2px -2px 3px rgba(0,0,0,0.35), 0 1px 2px rgba(0,0,0,0.4)",
      }}
    >
      {id !== 0 && (
        <span
          className="flex items-center justify-center rounded-full bg-[#f7f4ea] font-black text-[#111]"
          style={{ width: size * 0.56, height: size * 0.56, fontSize: size * 0.36, lineHeight: 1 }}
        >
          {id}
        </span>
      )}
    </span>
  );
}

function PlayerCard({
  name, active, group, left, eight, theme, align, sub,
}: {
  name: string; active: boolean; group: Group | null; left: number[]; eight: boolean; theme: PoolTheme;
  align: "left" | "right"; sub?: string;
}) {
  return (
    <div
      className={`min-w-0 flex-1 rounded-2xl px-2.5 py-1.5 transition-all ${align === "right" ? "text-right" : ""}`}
      style={{
        background: theme.panel,
        boxShadow: active ? `0 0 0 2px ${theme.accent}, 0 0 18px ${theme.accent}55` : "0 0 0 1px rgba(255,255,255,0.08)",
        opacity: active ? 1 : 0.78,
      }}
    >
      <div className={`flex items-center gap-1.5 ${align === "right" ? "flex-row-reverse" : ""}`}>
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: active ? theme.accent : "rgba(255,255,255,0.2)", boxShadow: active ? `0 0 8px ${theme.accent}` : "none" }}
        />
        <span className="truncate text-[13px] font-extrabold" style={{ color: theme.ink }}>{name}</span>
        {sub && <span className="truncate text-[10px] font-semibold" style={{ color: theme.inkSoft }}>{sub}</span>}
      </div>
      <div className={`mt-1 flex min-h-[15px] flex-wrap items-center gap-[3px] ${align === "right" ? "justify-end" : ""}`}>
        {group === null ? (
          <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: theme.inkSoft }}>Open table</span>
        ) : eight ? (
          <>
            <MiniBall id={8} />
            <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: theme.accent }}>on the 8</span>
          </>
        ) : (
          left.map((id) => <MiniBall key={Math.abs(id)} id={Math.abs(id)} dim={id < 0} />)
        )}
      </div>
    </div>
  );
}

export default function Pool() {
  useWorldStamp("/pool", "8-Ball Club");

  const wrapRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View>({ width: 300, height: 500, dpr: 1, s: 200, cx: 150, cy: 250, portrait: true });
  const tableRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<PoolAudio>(new PoolAudio());

  const stRef = useRef<PoolState>(newGame(Date.now() & 0xffff));
  const simRef = useRef<Sim | null>(null);
  const pendingRestRef = useRef<PoolState | null>(null);
  const dropsRef = useRef<Drop[]>([]);
  const aimRef = useRef<number>(0);
  const pullRef = useRef<number>(0);
  const spinRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const calledManualRef = useRef(false);
  const aiRef = useRef<AiJob | null>(null);
  const modeRef = useRef<Mode>("cpu");
  const levelRef = useRef<Level>((read(LEVEL_KEY) as Level) || "normal");
  const meRef = useRef<0 | 1>(0);
  const netRef = useRef<Transport | null>(null);
  const screenRef = useRef<Screen>("menu");
  const breakerRef = useRef<0 | 1>(0);
  const lastAimSent = useRef(0);
  const themeRef = useRef<PoolTheme>(themeById(read(THEME_KEY)));
  const namesRef = useRef<[string, string]>(["You", "Computer"]);
  const timeRef = useRef(0);

  const [screen, setScreenState] = useState<Screen>("menu");
  const [theme, setThemeState] = useState<PoolTheme>(themeRef.current);
  const [muted, setMuted] = useState<boolean>(read(MUTE_KEY) === "1");
  const [level, setLevelState] = useState<Level>(levelRef.current);
  const [mode, setModeState] = useState<Mode>("cpu");
  const [hud, setHud] = useState<Hud>(() => hudOf(stRef.current));
  const [names, setNames] = useState<[string, string]>(namesRef.current);
  const [menuOpen, setMenuOpen] = useState(false);
  const [spinOpen, setSpinOpen] = useState(false);
  const [spin, setSpin] = useState({ x: 0, y: 0 });
  const [power, setPower] = useState(0);
  const [thinking, setThinking] = useState(false);
  const [lobby, setLobby] = useState<{ code: string; host: boolean; status: "connecting" | "waiting" | "failed" } | null>(null);
  const [copied, setCopied] = useState(false);
  const [stats, setStats] = useState<Stats>(readStats);
  const [portrait, setPortrait] = useState(true);

  const setScreen = useCallback((s: Screen) => {
    screenRef.current = s;
    setScreenState(s);
  }, []);

  const setTheme = useCallback((t: PoolTheme) => {
    themeRef.current = t;
    setThemeState(t);
    write(THEME_KEY, t.id);
    tableRef.current = null;
  }, []);

  useEffect(() => {
    audioRef.current.setMuted(muted);
    write(MUTE_KEY, muted ? "1" : "0");
  }, [muted]);

  /* ------------------------------------------------------------ control */

  const iControl = useCallback((): boolean => {
    const s = stRef.current;
    if (screenRef.current !== "play" || s.phase !== "aim" || simRef.current) return false;
    if (modeRef.current === "local") return true;
    if (modeRef.current === "cpu") return s.turn === 0;
    return s.turn === meRef.current;
  }, []);

  const resetShotControls = useCallback(() => {
    pullRef.current = 0;
    setPower(0);
    spinRef.current = { x: 0, y: 0 };
    setSpin({ x: 0, y: 0 });
    calledManualRef.current = false;
  }, []);

  /** Point the cue somewhere sensible at the start of a turn. */
  const aimAtSomething = useCallback(() => {
    const s = stRef.current;
    const cue = s.balls[0];
    const targets = s.balls.filter((b) => b.on && b.id !== 0);
    const g = s.groups[s.turn];
    const pref = targets.filter((b) => (onEight(s) ? b.id === 8 : g ? groupOf(b.id) === g : true));
    const pool = pref.length ? pref : targets;
    let best = pool[0];
    let bd = Infinity;
    for (const b of pool) {
      const d = Math.hypot(b.x - cue.x, b.y - cue.y);
      if (d < bd) { bd = d; best = b; }
    }
    if (best) aimRef.current = Math.atan2(best.y - cue.y, best.x - cue.x);
  }, []);

  const send = useCallback((m: Wire) => {
    if (modeRef.current === "online") netRef.current?.send(m);
  }, []);

  const startSim = useCallback((from: PoolState, k: Strike, mine: boolean) => {
    const before = cloneState(from);
    const balls = cloneBalls(before.balls);
    applyStrike(balls[0], k);
    simRef.current = { balls, before, rec: emptyRecord(), acc: 0, mine, done: false };
    stRef.current = cloneState(before);
    stRef.current.phase = "moving";
    audioRef.current.cue(k.speed);
    pullRef.current = 0;
    setPower(0);
  }, []);

  const shoot = useCallback((k: Strike) => {
    const s = stRef.current;
    if (s.phase !== "aim" || simRef.current) return;
    const from = cloneState(s);
    startSim(from, k, true);
    send({ t: "shot", from, k });
  }, [send, startSim]);

  const shootNow = useCallback(() => {
    if (!iControl()) return;
    const p = pullRef.current;
    if (p < 0.02) { pullRef.current = 0; setPower(0); return; }
    shoot({ angle: aimRef.current, speed: powerToSpeed(p), spinX: spinRef.current.x, spinY: spinRef.current.y });
  }, [iControl, shoot]);

  const adopt = useCallback((s: PoolState) => {
    const prev = stRef.current;
    stRef.current = cloneState(s);
    simRef.current = null;
    pendingRestRef.current = null;
    if (prev.turn !== s.turn || prev.seq !== s.seq) {
      resetShotControls();
      aimAtSomething();
    }
  }, [aimAtSomething, resetShotControls]);

  const finishShot = useCallback((sim: Sim) => {
    const { state, outcome } = resolveShot(sim.before, sim.balls, sim.rec);
    stRef.current = state;
    simRef.current = null;
    const a = audioRef.current;
    if (state.winner !== null) {
      const human =
        modeRef.current === "local" ? true : modeRef.current === "cpu" ? state.winner === 0 : state.winner === meRef.current;
      if (human) a.win(); else a.lose();
      if (modeRef.current === "cpu" && !isShot()) {
        const st = readStats();
        const lv = levelRef.current;
        const row = st[lv] ?? { w: 0, l: 0 };
        if (state.winner === 0) row.w++; else row.l++;
        st[lv] = row;
        write(STATS_KEY, JSON.stringify(st));
        setStats(st);
      }
    } else if (outcome.foul) a.foul();
    else if (outcome.again) a.good();
    resetShotControls();
    aimAtSomething();
    if (sim.mine) send({ t: "rest", st: state });
  }, [aimAtSomething, resetShotControls, send]);

  /* --------------------------------------------------------- new games */

  const begin = useCallback((m: Mode, lv?: Level) => {
    audioRef.current.unlock();
    modeRef.current = m;
    setModeState(m);
    if (lv) { levelRef.current = lv; setLevelState(lv); write(LEVEL_KEY, lv); }
    if (m !== "online") {
      netRef.current?.close();
      netRef.current = null;
      meRef.current = 0;
    }
    const n: [string, string] =
      m === "cpu" ? ["You", `Computer`] : m === "local" ? ["Player 1", "Player 2"] : meRef.current === 0 ? ["You", "Friend"] : ["Friend", "You"];
    namesRef.current = n;
    setNames(n);
    breakerRef.current = 0;
    stRef.current = newGame((Date.now() ^ (Math.random() * 1e9)) & 0x7fffffff, 0);
    simRef.current = null;
    aiRef.current = null;
    dropsRef.current = [];
    resetShotControls();
    aimRef.current = 0;
    setMenuOpen(false);
    setScreen("play");
    if (m === "online") send({ t: "start", st: stRef.current, names: ["Friend", "You"] });
  }, [resetShotControls, send, setScreen]);

  const rematch = useCallback(() => {
    breakerRef.current = breakerRef.current === 0 ? 1 : 0;
    stRef.current = newGame((Date.now() ^ (Math.random() * 1e9)) & 0x7fffffff, breakerRef.current);
    simRef.current = null;
    aiRef.current = null;
    dropsRef.current = [];
    resetShotControls();
    aimRef.current = breakerRef.current === 0 ? 0 : 0;
    setMenuOpen(false);
    send({ t: "again", st: stRef.current });
  }, [resetShotControls, send]);

  const toMenu = useCallback(() => {
    if (modeRef.current === "online") {
      send({ t: "bye" });
      netRef.current?.close();
      netRef.current = null;
      setLobby(null);
    }
    simRef.current = null;
    aiRef.current = null;
    setMenuOpen(false);
    stRef.current = newGame(5);
    setScreen("menu");
  }, [send, setScreen]);

  /* ----------------------------------------------------------- online */

  const onWire = useCallback((m: Wire) => {
    if (m.t === "hi") {
      if (meRef.current !== 0) return;
      if (screenRef.current === "lobby") {
        setLobby(null);
        begin("online");
      } else if (screenRef.current === "play" && modeRef.current === "online") {
        netRef.current?.send({ t: "start", st: stRef.current, names: ["Friend", "You"] });
      }
    } else if (m.t === "start" || m.t === "again") {
      if (meRef.current !== 1) return;
      modeRef.current = "online";
      setModeState("online");
      namesRef.current = ["Friend", "You"];
      setNames(["Friend", "You"]);
      setLobby(null);
      simRef.current = null;
      dropsRef.current = [];
      stRef.current = cloneState(m.st);
      resetShotControls();
      aimAtSomething();
      setMenuOpen(false);
      setScreen("play");
    } else if (m.t === "aim") {
      const s = stRef.current;
      if (s.turn === meRef.current || simRef.current) return;
      aimRef.current = m.a;
      pullRef.current = m.p;
      spinRef.current = { x: m.sx, y: m.sy };
      if (s.ballInHand) { s.balls[0].x = m.cx; s.balls[0].y = m.cy; }
      s.called = m.called;
    } else if (m.t === "shot") {
      if (stRef.current.turn === meRef.current && !simRef.current) return;
      aimRef.current = m.k.angle;
      startSim(m.from, m.k, false);
    } else if (m.t === "rest") {
      if (simRef.current && !simRef.current.done) pendingRestRef.current = m.st;
      else adopt(m.st);
    } else if (m.t === "bye") {
      stRef.current.message = "Your friend left the table.";
    }
    // A host answers its own rematch too: nothing else to do.
  }, [adopt, aimAtSomething, begin, resetShotControls, setScreen, startSim]);

  const connect = useCallback(async (code: string, host: boolean) => {
    const net: NetMode = params().get("net") === "local" ? "local" : "online";
    setLobby({ code, host, status: "connecting" });
    setScreen("lobby");
    netRef.current?.close();
    const t = await openTransport(net, code);
    if (!t) { setLobby({ code, host, status: "failed" }); return; }
    netRef.current = t;
    meRef.current = host ? 0 : 1;
    t.receive((m) => onWire(m));
    setLobby({ code, host, status: "waiting" });
    if (!host) {
      // Keep saying hello until the host deals us in.
      const hello = () => {
        if (screenRef.current === "lobby" && netRef.current === t) {
          t.send({ t: "hi", name: "Friend" });
          window.setTimeout(hello, 1200);
        }
      };
      hello();
    }
  }, [onWire, setScreen]);

  const host = useCallback(() => {
    audioRef.current.unlock();
    void connect(roomCode(), true);
  }, [connect]);

  // A shared link joins straight away.
  useEffect(() => {
    const room = params().get("room");
    if (room && /^[A-Za-z]{4}$/.test(room)) void connect(room.toUpperCase(), false);
    return () => { netRef.current?.close(); netRef.current = null; };
  }, [connect]);

  const shareUrl = useMemo(() => {
    if (!lobby) return "";
    const u = new URL(window.location.href);
    u.search = "";
    u.searchParams.set("room", lobby.code);
    if (params().get("net") === "local") u.searchParams.set("net", "local");
    return u.toString();
  }, [lobby]);

  /* ------------------------------------------------------------ sizing */

  useEffect(() => {
    const board = boardRef.current;
    const canvas = canvasRef.current;
    if (!board || !canvas) return;
    const fit = () => {
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      const w = board.clientWidth;
      const h = board.clientHeight;
      const v = fitView(w, h, dpr);
      viewRef.current = v;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      tableRef.current = null;
      clearSprites();
      setPortrait(v.portrait);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(board);
    return () => ro.disconnect();
  }, []);

  /* -------------------------------------------------------------- loop */

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let raf = 0;
    let last = performance.now();
    let shownSig = "";
    const events: SimEvent[] = [];

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      timeRef.current += dt;
      const a = audioRef.current;
      a.frame();
      const s = stRef.current;

      // Physics.
      const sim = simRef.current;
      if (sim && !sim.done) {
        sim.acc += dt;
        let n = Math.floor(sim.acc / DT);
        sim.acc -= n * DT;
        n = Math.min(n, 60);
        let live = true;
        for (let i = 0; i < n && live; i++) {
          const prev = sim.balls.map((b) => ({ x: b.x, y: b.y }));
          events.length = 0;
          live = step(sim.balls, events, true);
          record(sim.rec, events);
          for (const e of events) {
            if (e.type === "hit") a.click(e.speed);
            else if (e.type === "rail") a.rail(e.speed);
            else if (e.type === "pot") {
              a.pot(e.speed);
              dropsRef.current.push({ id: e.ball, x: prev[e.ball].x, y: prev[e.ball].y, pocket: e.pocket, t: 0 });
              if (navigator.vibrate) { try { navigator.vibrate(18); } catch { /* fine */ } }
            }
          }
        }
        stRef.current.balls = sim.balls;
        if (!live) {
          sim.done = true;
          if (sim.mine || modeRef.current !== "online") finishShot(sim);
          else if (pendingRestRef.current) adopt(pendingRestRef.current);
        }
      } else if (sim && sim.done && pendingRestRef.current) {
        adopt(pendingRestRef.current);
      }
      for (const d of dropsRef.current) d.t += dt;
      dropsRef.current = dropsRef.current.filter((d) => d.t < 0.3);

      // The computer.
      if (screenRef.current === "play" && modeRef.current === "cpu" && s.turn === 1 && s.phase === "aim" && !simRef.current && !isShot()) {
        let job = aiRef.current;
        if (!job) {
          job = { stage: "wait", t: 0, fromAim: aimRef.current };
          aiRef.current = job;
          setThinking(true);
        }
        job.t += dt;
        if (job.stage === "wait" && job.t > 0.5) {
          job.gen = think(cloneState(s), levelRef.current);
          job.stage = "think";
          job.t = 0;
        } else if (job.stage === "think" && job.gen) {
          const t0 = performance.now();
          while (performance.now() - t0 < 12) {
            const r = job.gen.next();
            if (r.done) {
              job.plan = r.value;
              job.stage = job.plan.place ? "place" : "aim";
              job.fromCue = { x: s.balls[0].x, y: s.balls[0].y };
              job.fromAim = aimRef.current;
              job.t = 0;
              break;
            }
          }
        } else if (job.stage === "place" && job.plan?.place && job.fromCue) {
          const k = ease(Math.min(1, job.t / 0.6));
          s.balls[0].x = job.fromCue.x + (job.plan.place.x - job.fromCue.x) * k;
          s.balls[0].y = job.fromCue.y + (job.plan.place.y - job.fromCue.y) * k;
          if (job.t >= 0.6) { job.stage = "aim"; job.t = 0; job.fromAim = aimRef.current; }
        } else if (job.stage === "aim" && job.plan) {
          const k = ease(Math.min(1, job.t / 0.8));
          aimRef.current = angleLerp(job.fromAim, job.plan.angle, k);
          spinRef.current = { x: job.plan.spinX, y: job.plan.spinY };
          s.called = job.plan.called;
          if (job.t >= 0.9) { job.stage = "pull"; job.t = 0; }
        } else if (job.stage === "pull" && job.plan) {
          const target = speedToPower(job.plan.speed);
          pullRef.current = target * ease(Math.min(1, job.t / 0.55));
          if (job.t >= 0.75) {
            const plan = job.plan;
            aiRef.current = null;
            setThinking(false);
            aimRef.current = plan.angle;
            shoot({ angle: plan.angle, speed: plan.speed, spinX: plan.spinX, spinY: plan.spinY });
          }
        }
      } else if (aiRef.current && (s.turn !== 1 || modeRef.current !== "cpu" || screenRef.current !== "play")) {
        aiRef.current = null;
        setThinking(false);
      }

      // Call the 8's pocket from the aim, unless the shooter tapped one.
      const mine = iControl();
      if (mine && onEight(s) && !calledManualRef.current) {
        const g = aimGuide(s.balls, aimRef.current);
        if (g.hit === 8 && g.obj) {
          const b8 = s.balls[8];
          let best = 0;
          let bd = -Infinity;
          POCKETS.forEach((p, i) => {
            const dx = p.mx - b8.x;
            const dy = p.my - b8.y;
            const d = Math.hypot(dx, dy) || 1;
            const v = (dx * g.obj!.x + dy * g.obj!.y) / d;
            if (v > bd) { bd = v; best = i; }
          });
          s.called = best;
        }
      }

      // Tell the other side where the cue is pointing.
      if (mine && modeRef.current === "online" && now - lastAimSent.current > 100) {
        lastAimSent.current = now;
        netRef.current?.send({
          t: "aim", a: aimRef.current, p: pullRef.current, sx: spinRef.current.x, sy: spinRef.current.y,
          cx: s.balls[0].x, cy: s.balls[0].y, called: s.called,
        });
      }

      // HUD.
      const cur = stRef.current;
      const sig = `${cur.seq}|${cur.turn}|${cur.phase}|${cur.message}|${cur.groups.join()}|${cur.balls.filter((b) => b.on).length}`;
      if (sig !== shownSig) {
        shownSig = sig;
        setHud(hudOf(cur));
      }

      // Draw.
      const v = viewRef.current;
      const th = themeRef.current;
      if (!tableRef.current) tableRef.current = drawTable(v, th);
      const showAim = cur.phase === "aim" && screenRef.current === "play" && cur.winner === null;
      drawFrame(ctx, v, th, tableRef.current, cur.balls, dropsRef.current, {
        aim: showAim ? aimRef.current : null,
        pull: pullRef.current,
        guide: showAim,
        guideLen: 0.32,
        ballInHand: cur.ballInHand && showAim,
        kitchen: cur.kitchen,
        called: onEight(cur) && showAim ? cur.called : null,
        calling: mine && onEight(cur) && showAim,
        time: timeRef.current,
        spinX: spinRef.current.x,
        spinY: spinRef.current.y,
      });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [adopt, finishShot, iControl, shoot]);

  /* ----------------------------------------------------------- pointer */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    type Drag = { kind: "aim" | "pull" | "place" | "pocket" | "ball"; id: number; sx: number; sy: number; pocket?: number; moved: boolean };
    let drag: Drag | null = null;

    const local = (e: PointerEvent): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    const down = (e: PointerEvent) => {
      audioRef.current.unlock();
      if (!iControl() || drag) return;
      const v = viewRef.current;
      const [X, Y] = local(e);
      const [tx, ty] = toTable(v, X, Y);
      const s = stRef.current;
      const cue = s.balls[0];
      const dCue = Math.hypot(tx - cue.x, ty - cue.y);
      canvas.setPointerCapture(e.pointerId);
      // Calling the 8.
      if (onEight(s)) {
        const pi = POCKETS.findIndex((p) => Math.hypot(tx - p.mx, ty - p.my) < 0.075);
        if (pi >= 0) { drag = { kind: "pocket", id: e.pointerId, sx: X, sy: Y, pocket: pi, moved: false }; return; }
      }
      // With ball in hand, a drag that starts on the cue ball is either a
      // move or a pull: the first few pixels decide (straight back = pull).
      const touchR = Math.max(R * 2.2, 26 / v.s);
      if (s.ballInHand && dCue < touchR) {
        drag = { kind: "ball", id: e.pointerId, sx: X, sy: Y, moved: false };
        return;
      }
      const pullR = Math.max(R * 6, 54 / v.s);
      if (dCue < pullR) {
        drag = { kind: "pull", id: e.pointerId, sx: X, sy: Y, moved: false };
        return;
      }
      drag = { kind: "aim", id: e.pointerId, sx: X, sy: Y, moved: false };
      aimRef.current = Math.atan2(ty - cue.y, tx - cue.x);
    };

    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!iControl()) { drag = null; return; }
      const v = viewRef.current;
      const [X, Y] = local(e);
      if (Math.hypot(X - drag.sx, Y - drag.sy) > 6) drag.moved = true;
      const [tx, ty] = toTable(v, X, Y);
      const s = stRef.current;
      const cue = s.balls[0];
      if (drag.kind === "ball") {
        if (Math.hypot(X - drag.sx, Y - drag.sy) < 9) return;
        const [ax, ay] = toScreen(v, cue.x, cue.y);
        const [bx, by] = toScreen(v, cue.x + Math.cos(aimRef.current), cue.y + Math.sin(aimRef.current));
        const ux = bx - ax;
        const uy = by - ay;
        const n = Math.hypot(ux, uy) || 1;
        const mx = X - drag.sx;
        const my = Y - drag.sy;
        const cos = -(mx * ux + my * uy) / (n * Math.hypot(mx, my));
        drag.kind = cos > 0.82 ? "pull" : "place";
      }
      if (drag.kind === "aim") {
        if (Math.hypot(tx - cue.x, ty - cue.y) > R * 1.5) aimRef.current = Math.atan2(ty - cue.y, tx - cue.x);
      } else if (drag.kind === "place") {
        const spot = canPlace(s.balls, tx, ty, s.kitchen) ? { x: tx, y: ty } : nearestFree(s.balls, tx, ty, s.kitchen);
        cue.x = spot.x;
        cue.y = spot.y;
      } else if (drag.kind === "pull") {
        // How far the finger has come back, against the shot.
        const [ax, ay] = toScreen(v, cue.x, cue.y);
        const [bx, by] = toScreen(v, cue.x + Math.cos(aimRef.current), cue.y + Math.sin(aimRef.current));
        const ux = bx - ax;
        const uy = by - ay;
        const n = Math.hypot(ux, uy) || 1;
        const back = -((X - drag.sx) * ux + (Y - drag.sy) * uy) / n;
        const p = Math.max(0, Math.min(1, back / Math.max(110, 0.42 * v.s)));
        pullRef.current = p;
        setPower(p);
      }
    };

    const up = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      if (!iControl()) return;
      if (d.kind === "pocket" && !d.moved && d.pocket !== undefined) {
        stRef.current.called = d.pocket;
        calledManualRef.current = true;
        audioRef.current.rail(0.4);
      } else if (d.kind === "pocket" && d.moved) {
        // A drag that began on a pocket was an aim.
      } else if (d.kind === "pull") {
        if (!d.moved) {
          // A tap near the cue ball aims at it, which is nothing: ignore.
          pullRef.current = 0;
          setPower(0);
        } else shootNow();
      }
    };

    const cancel = (e: PointerEvent) => {
      if (drag && e.pointerId === drag.id) {
        if (drag.kind === "pull") { pullRef.current = 0; setPower(0); }
        drag = null;
      }
    };

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
    };
  }, [iControl, shootNow]);

  /* -------------------------------------------------------------- keys */

  useEffect(() => {
    let charging = false;
    let chargeT = 0;
    let timer = 0;
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "m" || e.key === "M") { setMuted((m) => !m); return; }
      if (!iControl()) return;
      const step = e.shiftKey ? 0.0009 : 0.012;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); aimRef.current += step; }
      else if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); aimRef.current -= step; }
      else if (e.key === " " && !charging && !e.repeat) {
        e.preventDefault();
        charging = true;
        chargeT = performance.now();
        const tick = () => {
          if (!charging) return;
          // Up and back down, so holding too long is not a blast.
          const t = ((performance.now() - chargeT) / 1300) % 2;
          const p = t <= 1 ? t : 2 - t;
          pullRef.current = p;
          setPower(p);
          timer = requestAnimationFrame(tick);
        };
        tick();
      } else if (e.key === "Escape" && charging) {
        charging = false;
        cancelAnimationFrame(timer);
        pullRef.current = 0;
        setPower(0);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === " " && charging) {
        e.preventDefault();
        charging = false;
        cancelAnimationFrame(timer);
        shootNow();
      }
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      cancelAnimationFrame(timer);
    };
  }, [iControl, shootNow]);

  /* ------------------------------------------------------ power, fine */

  const powerDrag = useRef<{ id: number; y: number; h: number } | null>(null);
  const onPowerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    audioRef.current.unlock();
    if (!iControl()) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    powerDrag.current = { id: e.pointerId, y: e.clientY, h: e.currentTarget.clientHeight };
  };
  const onPowerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = powerDrag.current;
    if (!d || d.id !== e.pointerId) return;
    const p = Math.max(0, Math.min(1, (e.clientY - d.y) / (d.h * 0.85)));
    pullRef.current = p;
    setPower(p);
  };
  const onPowerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = powerDrag.current;
    if (!d || d.id !== e.pointerId) return;
    powerDrag.current = null;
    shootNow();
  };

  const fineDrag = useRef<{ id: number; last: number } | null>(null);
  const [fineOffset, setFineOffset] = useState(0);
  const onFineDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!iControl()) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    fineDrag.current = { id: e.pointerId, last: portrait ? e.clientX : e.clientY };
  };
  const onFineMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = fineDrag.current;
    if (!d || d.id !== e.pointerId || !iControl()) return;
    const at = portrait ? e.clientX : e.clientY;
    const delta = at - d.last;
    d.last = at;
    aimRef.current += delta * 0.0007 * (portrait ? -1 : 1);
    setFineOffset((o) => (o + delta) % 24);
  };
  const onFineUp = () => { fineDrag.current = null; };

  /* -------------------------------------------------------------- spin */

  const spinPadRef = useRef<HTMLDivElement>(null);
  const setSpinFrom = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = spinPadRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let x = ((e.clientX - r.left) / r.width) * 2 - 1;
    let y = -(((e.clientY - r.top) / r.height) * 2 - 1);
    const n = Math.hypot(x, y);
    if (n > 0.85) { x *= 0.85 / n; y *= 0.85 / n; }
    const v = { x: x / 0.85, y: y / 0.85 };
    spinRef.current = v;
    setSpin(v);
  };

  /* ------------------------------------------------------------- misc */

  // Leaving: close the audio.
  useEffect(() => {
    const a = audioRef.current;
    return () => a.close();
  }, []);

  // Card art: a few shots into a game, the cue lined up on a pot.
  useEffect(() => {
    if (!isShot()) return;
    const seed = Number(params().get("seed") ?? 11);
    let s = newGame(seed);
    const rnd = (() => { let a = seed; return () => ((a = (a * 16807) % 2147483647) / 2147483647); })();
    for (let i = 0; i < 4 && s.phase !== "over"; i++) {
      const p = planNow(s, "hard", rnd);
      const before = cloneState(s);
      before.called = p.called;
      if (p.place) { before.balls[0].x = p.place.x; before.balls[0].y = p.place.y; }
      const balls = cloneBalls(before.balls);
      applyStrike(balls[0], p);
      const rec = simulate(balls, 30, true);
      s = resolveShot(before, balls, rec).state;
    }
    const p = planNow(s, "hard", rnd);
    if (p.place) { s.balls[0].x = p.place.x; s.balls[0].y = p.place.y; }
    s.ballInHand = false;
    aimRef.current = p.angle;
    pullRef.current = 0.45;
    stRef.current = s;
    modeRef.current = "local";
    setModeState("local");
    namesRef.current = ["Player 1", "Player 2"];
    setNames(namesRef.current);
    setScreen("play");
  }, [setScreen]);

  // Test hook.
  useEffect(() => {
    const hook = {
      state: () => {
        const s = stRef.current;
        return {
          screen: screenRef.current, mode: modeRef.current, me: meRef.current,
          turn: s.turn, phase: s.phase, groups: s.groups, winner: s.winner, message: s.message,
          ballInHand: s.ballInHand, isBreak: s.isBreak, called: s.called, seq: s.seq,
          moving: !!simRef.current, aim: aimRef.current, power: pullRef.current,
          balls: s.balls.map((b) => ({ id: b.id, x: +b.x.toFixed(4), y: +b.y.toFixed(4), on: b.on })),
          view: viewRef.current,
        };
      },
      start: (m: Mode = "cpu", lv: Level = "normal") => { begin(m, lv); return hook.state(); },
      aim: (a: number) => { aimRef.current = a; },
      place: (x: number, y: number) => {
        const s = stRef.current;
        if (!s.ballInHand) return false;
        const spot = nearestFree(s.balls, x, y, s.kitchen);
        s.balls[0].x = spot.x;
        s.balls[0].y = spot.y;
        return true;
      },
      shoot: (angle: number, pw: number, sx = 0, sy = 0) => {
        if (!iControl()) return false;
        aimRef.current = angle;
        shoot({ angle, speed: powerToSpeed(pw), spinX: sx, spinY: sy });
        return true;
      },
      /** Run the moving balls to rest without waiting for frames. */
      settle: () => {
        const sim = simRef.current;
        if (!sim || sim.done) return hook.state();
        const ev: SimEvent[] = [];
        for (let i = 0; i < 40000; i++) {
          ev.length = 0;
          const live = step(sim.balls, ev, true);
          record(sim.rec, ev);
          if (!live) break;
        }
        sim.acc = 0;
        return hook.state();
      },
      plan: () => planNow(stRef.current, levelRef.current),
      theme: (id: string) => setTheme(themeById(id)),
      host: () => host(),
      lobby: () => lobby,
    };
    (window as unknown as { __pool?: typeof hook }).__pool = hook;
    return () => { delete (window as unknown as { __pool?: typeof hook }).__pool; };
  }, [begin, host, iControl, lobby, setTheme, shoot]);

  /* ------------------------------------------------------------ render */

  const shot = isShot();
  const turnName = names[hud.turn];
  const myTurn = mode === "online" ? hud.turn === meRef.current : mode === "cpu" ? hud.turn === 0 : true;
  const statusLine =
    hud.winner !== null ? "" :
    thinking ? "Computer is lining up…" :
    mode === "online" && !myTurn ? `${turnName}'s shot` :
    mode === "local" ? `${turnName} to shoot` :
    mode === "cpu" && hud.turn === 1 ? "Computer's shot" :
    hud.ballInHand ? (hud.isBreak ? "" : "Drag the cue ball anywhere.") :
    myTurn && hud.eight[hud.turn] ? "On the 8. Tap a pocket to call it." : "";

  const youWon =
    hud.winner === null ? false : mode === "cpu" ? hud.winner === 0 : mode === "online" ? hud.winner === meRef.current : true;
  const rec = stats[level];

  return (
    <div
      ref={wrapRef}
      className="fixed inset-0 flex select-none flex-col overflow-hidden"
      style={{ background: theme.room, color: theme.ink, touchAction: "none", fontFamily: `"Nunito", ui-rounded, system-ui, -apple-system, "Segoe UI", sans-serif` }}
    >
      {/* Top: what just happened and whose go, then the two players. */}
      <div className="flex items-center gap-2 px-2 pt-[max(env(safe-area-inset-top),8px)]">
        <div className="w-[108px] shrink-0" />
        <div className="flex min-h-[36px] min-w-0 flex-1 flex-col items-center justify-center text-center text-[12px] font-bold leading-tight sm:text-[13px]" style={{ visibility: screen === "play" && !shot ? "visible" : "hidden" }}>
          <span style={{ color: theme.ink }}>{hud.winner === null ? hud.message : ""}</span>
          {statusLine && <span style={{ color: theme.accent }}>{statusLine}</span>}
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button" onClick={() => setMuted((m) => !m)} aria-label={muted ? "Sound on" : "Sound off"}
            className="flex h-9 w-9 items-center justify-center rounded-full" style={{ background: theme.panel }}
          >
            {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
          <button
            type="button" onClick={() => setMenuOpen(true)} aria-label="Menu"
            className="flex h-9 w-9 items-center justify-center rounded-full"
            style={{ background: theme.panel, visibility: screen === "play" && !shot ? "visible" : "hidden" }}
          >
            <Menu size={15} />
          </button>
        </div>
      </div>
      <div className="flex gap-2 px-2 pt-1.5 pb-1" style={{ visibility: screen === "play" && !shot ? "visible" : "hidden" }}>
        <PlayerCard
          name={names[0]} active={hud.turn === 0 && hud.winner === null} group={hud.groups[0]} left={hud.left[0]}
          eight={hud.eight[0]} theme={theme} align="left"
        />
        <PlayerCard
          name={names[1]} active={hud.turn === 1 && hud.winner === null} group={hud.groups[1]} left={hud.left[1]}
          eight={hud.eight[1]} theme={theme} align="right" sub={mode === "cpu" ? LEVEL_NAMES[level] : undefined}
        />
      </div>

      {/* Table, with the fine aim and the power bar either side. */}
      <div className="relative flex min-h-0 flex-1 items-stretch gap-1.5 px-1.5">
        {!portrait && screen === "play" && !shot && (
          <div
            className="relative my-auto h-[62%] w-9 shrink-0 cursor-ns-resize overflow-hidden rounded-full"
            style={{ background: theme.panel, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1)" }}
            onPointerDown={onFineDown} onPointerMove={onFineMove} onPointerUp={onFineUp} onPointerCancel={onFineUp}
            aria-label="Fine aim"
          >
            <div
              className="absolute inset-x-2 inset-y-0"
              style={{
                backgroundImage: "repeating-linear-gradient(180deg, rgba(255,255,255,0.35) 0 2px, transparent 2px 12px)",
                backgroundPositionY: `${fineOffset}px`,
              }}
            />
            <div className="absolute inset-x-0 bottom-2 text-center text-[8px] font-black uppercase tracking-wider" style={{ color: theme.inkSoft }}>fine</div>
          </div>
        )}
        <div ref={boardRef} className="relative min-w-0 flex-1">
          <canvas ref={canvasRef} className="absolute inset-0 block" style={{ touchAction: "none" }} />
        </div>
        {screen === "play" && !shot && (
          <div className="my-auto flex h-[70%] max-h-[420px] w-11 shrink-0 flex-col items-center gap-1">
            <div className="text-[9px] font-black uppercase tracking-wider" style={{ color: theme.inkSoft }}>Power</div>
            <div
              className="relative w-full flex-1 cursor-ns-resize overflow-hidden rounded-2xl"
              style={{ background: theme.panel, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.12)", opacity: myTurn && hud.phase === "aim" ? 1 : 0.45 }}
              onPointerDown={onPowerDown} onPointerMove={onPowerMove} onPointerUp={onPowerUp} onPointerCancel={onPowerUp}
              aria-label="Power: drag down and let go"
            >
              <div
                className="absolute inset-x-0 top-0"
                style={{
                  height: `${power * 100}%`,
                  background: `linear-gradient(180deg, #3ee07a, #ffd84a ${60}%, #ff4d4d)`,
                  backgroundSize: "100% 100%",
                  opacity: 0.9,
                }}
              />
              {/* The cue, sliding down as you pull. */}
              <div
                className="absolute left-1/2 w-[7px] -translate-x-1/2 rounded-full"
                style={{
                  top: `${6 + power * 48}%`, height: "60%",
                  background: `linear-gradient(180deg, #3a7bd5 0 2%, #f4f1e8 2% 5%, ${theme.cue.shaft} 5% 62%, ${theme.cue.ring} 62% 64%, ${theme.cue.butt} 64%)`,
                  boxShadow: "0 2px 6px rgba(0,0,0,0.5)",
                }}
              />
              {power === 0 && (
                <div className="absolute inset-x-0 bottom-2 text-center text-[16px]" style={{ color: theme.inkSoft }}>↓</div>
              )}
            </div>
            <div className="h-4 text-[10px] font-black tabular-nums" style={{ color: theme.ink }}>{power > 0 ? `${Math.round(power * 100)}%` : ""}</div>
          </div>
        )}

        {/* Menus over the table. */}
        {screen === "menu" && !shot && (
          <div className="absolute inset-0 z-10 flex items-center justify-center overflow-y-auto p-3">
            <div className="my-auto w-full max-w-sm rounded-3xl p-5 text-center shadow-2xl backdrop-blur" style={{ background: theme.panel, boxShadow: "0 20px 60px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.1)" }}>
              <div className="flex items-center justify-center gap-1">
                {[1, 9, 8, 3, 14].map((id, i) => <MiniBall key={id} id={id} size={i === 2 ? 38 : 26} />)}
              </div>
              <h1 className="mt-2 text-4xl font-black tracking-tight" style={{ color: theme.accent, textShadow: `0 0 18px ${theme.accent}66` }}>8-BALL CLUB</h1>
              <p className="mt-1 text-sm leading-snug" style={{ color: theme.inkSoft }}>
                Solids or stripes, then the 8. Real spin, real cushions.
              </p>
              <div className="mt-4 rounded-2xl p-2" style={{ background: "rgba(255,255,255,0.06)" }}>
                <div className="flex gap-1">
                  {(["easy", "normal", "hard"] as Level[]).map((lv) => (
                    <button
                      key={lv} type="button" onClick={() => { levelRef.current = lv; setLevelState(lv); write(LEVEL_KEY, lv); }}
                      className="flex-1 rounded-xl py-1.5 text-xs font-extrabold"
                      style={{ background: level === lv ? theme.accent : "transparent", color: level === lv ? "#111" : theme.ink }}
                    >
                      {LEVEL_NAMES[lv]}
                    </button>
                  ))}
                </div>
                <button
                  type="button" onClick={() => begin("cpu", level)}
                  className="mt-2 w-full rounded-xl py-3 text-lg font-black shadow-lg active:scale-[0.98]"
                  style={{ background: theme.accent, color: "#111" }}
                >
                  Play the computer
                </button>
                {rec && (rec.w > 0 || rec.l > 0) && (
                  <div className="mt-1 text-[11px] font-bold" style={{ color: theme.inkSoft }}>
                    {LEVEL_NAMES[level]}: {rec.w} won, {rec.l} lost
                  </div>
                )}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button
                  type="button" onClick={() => begin("local")}
                  className="rounded-xl py-2.5 text-sm font-extrabold" style={{ background: "rgba(255,255,255,0.1)", color: theme.ink }}
                >
                  👥 Two players<br /><span className="text-[10px] font-bold opacity-70">pass this device</span>
                </button>
                <button
                  type="button" onClick={host}
                  className="rounded-xl py-2.5 text-sm font-extrabold" style={{ background: "rgba(255,255,255,0.1)", color: theme.ink }}
                >
                  🔗 Play a friend<br /><span className="text-[10px] font-bold opacity-70">send them a link</span>
                </button>
              </div>
              <div className="mt-4 text-[10px] font-black uppercase tracking-[0.2em]" style={{ color: theme.inkSoft }}>Table</div>
              <div className="mt-1 flex justify-center gap-1.5">
                {THEMES.map((t) => (
                  <button
                    key={t.id} type="button" onClick={() => setTheme(t)} title={t.name} aria-label={t.name}
                    className="flex h-10 w-10 items-center justify-center rounded-xl text-lg"
                    style={{
                      background: `radial-gradient(circle, ${t.clothLight}, ${t.cloth} 60%, ${t.rail[1]} 62%)`,
                      boxShadow: theme.id === t.id ? `0 0 0 2px ${theme.accent}` : "0 0 0 1px rgba(255,255,255,0.15)",
                    }}
                  >
                    {t.emoji}
                  </button>
                ))}
              </div>
              <div className="mt-1 text-[11px] font-bold" style={{ color: theme.ink }}>{theme.name}</div>
              <p className="mt-3 text-[11px] leading-snug" style={{ color: theme.inkSoft }}>
                Drag on the table to aim. Pull the cue back from the cue ball, or drag the power bar down, and let go to shoot.
                The little cue ball sets spin. Keys: arrows aim, hold Space to shoot.
              </p>
            </div>
          </div>
        )}

        {screen === "lobby" && lobby && (
          <div className="absolute inset-0 z-10 flex items-center justify-center p-3">
            <div className="w-full max-w-sm rounded-3xl p-5 text-center" style={{ background: theme.panel, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}>
              {lobby.status === "failed" ? (
                <>
                  <div className="text-2xl font-black">Could not reach the room</div>
                  <p className="mt-2 text-sm" style={{ color: theme.inkSoft }}>The online table did not answer. Check the connection and try again, or play on this device.</p>
                  <div className="mt-4 flex gap-2">
                    <button type="button" onClick={() => void connect(lobby.code, lobby.host)} className="flex-1 rounded-xl py-2.5 font-black" style={{ background: theme.accent, color: "#111" }}>Try again</button>
                    <button type="button" onClick={toMenu} className="flex-1 rounded-xl py-2.5 font-black" style={{ background: "rgba(255,255,255,0.1)" }}>Menu</button>
                  </div>
                </>
              ) : lobby.host ? (
                <>
                  <div className="text-[10px] font-black uppercase tracking-[0.2em]" style={{ color: theme.inkSoft }}>Room</div>
                  <div className="text-5xl font-black tracking-[0.15em]" style={{ color: theme.accent }}>{lobby.code}</div>
                  <p className="mt-2 text-sm" style={{ color: theme.inkSoft }}>Send your friend this link. You break as soon as they open it.</p>
                  <div className="mt-3 truncate rounded-xl px-3 py-2 text-xs font-bold" style={{ background: "rgba(255,255,255,0.08)" }}>{shareUrl}</div>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => { void navigator.clipboard?.writeText(shareUrl).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 font-black" style={{ background: theme.accent, color: "#111" }}
                    >
                      <Copy size={15} /> {copied ? "Copied" : "Copy link"}
                    </button>
                    {typeof navigator !== "undefined" && "share" in navigator && (
                      <button
                        type="button"
                        onClick={() => { void navigator.share({ title: "8-Ball Club", text: "Rack 'em. Join my pool table:", url: shareUrl }).catch(() => {}); }}
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 font-black" style={{ background: "rgba(255,255,255,0.12)" }}
                      >
                        <Share2 size={15} /> Share
                      </button>
                    )}
                  </div>
                  <div className="mt-4 flex items-center justify-center gap-2 text-sm font-bold" style={{ color: theme.inkSoft }}>
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full" style={{ background: theme.accent }} />
                    {lobby.status === "connecting" ? "Opening the room…" : "Waiting for your friend…"}
                  </div>
                  <button type="button" onClick={toMenu} className="mt-4 text-xs font-bold underline" style={{ color: theme.inkSoft }}>Cancel</button>
                </>
              ) : (
                <>
                  <div className="text-2xl font-black">Joining {lobby.code}</div>
                  <div className="mt-3 flex items-center justify-center gap-2 text-sm font-bold" style={{ color: theme.inkSoft }}>
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full" style={{ background: theme.accent }} />
                    {lobby.status === "connecting" ? "Finding the table…" : "Waiting for the host to rack up…"}
                  </div>
                  <button type="button" onClick={toMenu} className="mt-4 text-xs font-bold underline" style={{ color: theme.inkSoft }}>Play on my own instead</button>
                </>
              )}
            </div>
          </div>
        )}

        {screen === "play" && hud.winner !== null && !shot && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 p-3">
            <div className="w-full max-w-xs rounded-3xl p-6 text-center" style={{ background: theme.panel, boxShadow: "0 20px 60px rgba(0,0,0,0.6)" }}>
              <MiniBall id={8} size={54} />
              <div className="mt-2 text-3xl font-black" style={{ color: youWon ? theme.accent : theme.ink }}>
                {mode === "local" ? `${names[hud.winner]} wins!` : youWon ? "You win!" : mode === "cpu" ? "The computer wins" : "Your friend wins"}
              </div>
              <p className="mt-1 text-sm" style={{ color: theme.inkSoft }}>{hud.message}</p>
              <button type="button" onClick={rematch} className="mt-5 w-full rounded-2xl py-3 text-lg font-black" style={{ background: theme.accent, color: "#111" }}>
                Rack 'em again
              </button>
              <button type="button" onClick={toMenu} className="mt-2 w-full rounded-2xl py-2 text-sm font-bold" style={{ background: "rgba(255,255,255,0.1)" }}>
                Menu
              </button>
            </div>
          </div>
        )}

        {menuOpen && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 p-3" onClick={() => setMenuOpen(false)}>
            <div className="w-full max-w-xs rounded-3xl p-5" style={{ background: theme.panel }} onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <div className="text-lg font-black">Table</div>
                <button type="button" onClick={() => setMenuOpen(false)} aria-label="Close"><X size={18} /></button>
              </div>
              <div className="mt-2 grid grid-cols-5 gap-1.5">
                {THEMES.map((t) => (
                  <button
                    key={t.id} type="button" onClick={() => setTheme(t)} title={t.name} aria-label={t.name}
                    className="flex aspect-square items-center justify-center rounded-xl text-lg"
                    style={{
                      background: `radial-gradient(circle, ${t.clothLight}, ${t.cloth} 60%, ${t.rail[1]} 62%)`,
                      boxShadow: theme.id === t.id ? `0 0 0 2px ${theme.accent}` : "0 0 0 1px rgba(255,255,255,0.15)",
                    }}
                  >
                    {t.emoji}
                  </button>
                ))}
              </div>
              <div className="mt-1 text-center text-xs font-bold" style={{ color: theme.inkSoft }}>{theme.name}</div>
              <div className="mt-4 text-xs leading-snug" style={{ color: theme.inkSoft }}>
                Pot all of yours, then the 8 in the pocket you call. A scratch, missing everything, hitting the wrong ball first, or no cushion after contact is a foul and hands over ball in hand. The 8 early or on a foul loses.
              </div>
              {mode !== "online" && (
                <button type="button" onClick={rematch} className="mt-4 w-full rounded-xl py-2.5 font-black" style={{ background: theme.accent, color: "#111" }}>
                  New rack
                </button>
              )}
              <button type="button" onClick={toMenu} className="mt-2 w-full rounded-xl py-2.5 font-bold" style={{ background: "rgba(255,255,255,0.1)" }}>
                {mode === "online" ? "Leave the table" : "Main menu"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Bottom: spin, and the fine aim on a phone. */}
      <div
        className="flex items-center gap-2 px-3 pt-1.5 pb-[max(env(safe-area-inset-bottom),8px)]"
        style={{ visibility: screen === "play" && !shot ? "visible" : "hidden" }}
      >
        <div className="relative">
          <button
            type="button" onClick={() => setSpinOpen((o) => !o)} aria-label="Spin"
            className="flex h-12 w-12 items-center justify-center rounded-full"
            style={{ background: theme.panel, boxShadow: spinOpen ? `0 0 0 2px ${theme.accent}` : "inset 0 0 0 1px rgba(255,255,255,0.12)" }}
          >
            <span className="relative block h-9 w-9 rounded-full" style={{ background: "radial-gradient(circle at 35% 30%, #fff, #e8e4d8 60%, #b9b4a6)" }}>
              <span
                className="absolute h-2.5 w-2.5 rounded-full"
                style={{ background: "#d62634", left: `calc(50% + ${spin.x * 38}% - 5px)`, top: `calc(50% - ${spin.y * 38}% - 5px)` }}
              />
            </span>
          </button>
          {spinOpen && (
            <div className="absolute bottom-14 left-0 z-30 w-48 rounded-3xl p-3 text-center" style={{ background: theme.panel, boxShadow: "0 12px 40px rgba(0,0,0,0.6)" }}>
              <div className="text-[10px] font-black uppercase tracking-[0.2em]" style={{ color: theme.inkSoft }}>Where to hit it</div>
              <div
                ref={spinPadRef}
                className="relative mx-auto mt-2 h-36 w-36 cursor-crosshair rounded-full"
                style={{ background: "radial-gradient(circle at 35% 30%, #fff, #ebe7db 55%, #a9a496)", touchAction: "none", boxShadow: "inset -6px -8px 18px rgba(0,0,0,0.25)" }}
                onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setSpinFrom(e); }}
                onPointerMove={(e) => { if (e.buttons || e.pointerType === "touch") setSpinFrom(e); }}
              >
                <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-black/10" />
                <div className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-black/10" />
                <span
                  className="absolute h-5 w-5 rounded-full border-2 border-white"
                  style={{ background: "#d62634", left: `calc(50% + ${spin.x * 42.5}% - 10px)`, top: `calc(50% - ${spin.y * 42.5}% - 10px)`, boxShadow: "0 1px 4px rgba(0,0,0,0.5)" }}
                />
              </div>
              <div className="mt-1 h-4 text-[11px] font-bold" style={{ color: theme.ink }}>
                {spin.y > 0.25 ? "Follow" : spin.y < -0.25 ? "Draw" : Math.abs(spin.x) > 0.25 ? "" : "Centre ball"}
                {Math.abs(spin.x) > 0.25 ? `${Math.abs(spin.y) > 0.25 ? ", " : ""}${spin.x > 0 ? "right" : "left"} english` : ""}
              </div>
              <button
                type="button" onClick={() => { spinRef.current = { x: 0, y: 0 }; setSpin({ x: 0, y: 0 }); }}
                className="mt-1 w-full rounded-xl py-1.5 text-xs font-black" style={{ background: "rgba(255,255,255,0.1)" }}
              >
                Centre
              </button>
            </div>
          )}
        </div>
        {portrait ? (
          <div
            className="relative h-10 flex-1 cursor-ew-resize overflow-hidden rounded-full"
            style={{ background: theme.panel, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1)", touchAction: "none" }}
            onPointerDown={onFineDown} onPointerMove={onFineMove} onPointerUp={onFineUp} onPointerCancel={onFineUp}
            aria-label="Fine aim"
          >
            <div
              className="absolute inset-y-2 inset-x-0"
              style={{
                backgroundImage: "repeating-linear-gradient(90deg, rgba(255,255,255,0.35) 0 2px, transparent 2px 12px)",
                backgroundPositionX: `${fineOffset}px`,
              }}
            />
            <div className="absolute inset-0 flex items-center justify-center text-[10px] font-black uppercase tracking-[0.25em]" style={{ color: theme.inkSoft }}>
              ◀ fine aim ▶
            </div>
          </div>
        ) : (
          <div className="flex-1 text-center text-[11px] font-semibold" style={{ color: theme.inkSoft }}>
            Drag the table to aim · pull back from the cue ball or drag the power bar · arrows and Space work too
          </div>
        )}
        <div className="w-12 shrink-0" />
      </div>
    </div>
  );
}
