/**
 * VIBE CUP — the page.
 *
 * Five-a-side arcade soccer in a cage: pass, shoot, slide, golden goal.
 * The Vibe Cup itself is a six-club tournament (`src/vibecup/cup.ts`): you
 * are one player for your club all Cup long, and every other match of the
 * round plays live beside yours, ready to watch.
 * One player against the computer, two people on one keyboard (or two
 * gamepads, or a pad and a keyboard), or up to four online, each on their own
 * device (`src/vibecup/net.ts`: the room maker referees, `?room=CODE` joins,
 * `?net=local` swaps Supabase for a BroadcastChannel so two tabs can play).
 * Phones get a thumb stick and two buttons.
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
import { Copy, Pause, Play, Share2, Volume2, VolumeX } from "lucide-react";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import {
  autopilot, clockLabel, CLUBS, clubById, newGame, setInput, step, type Difficulty, type Game, type GameEvent, type Input, type TeamId,
} from "@/vibecup/game";
import { drawFrame, feedFx, fitView, newFx, PAD_COLORS, screenToWorld, type Fx, type View } from "@/vibecup/render";
import { CupAudio } from "@/vibecup/audio";
import { applySnap, BOARD, cleanCode, CupRoom, matchGame, MAX_PER_SIDE, openTransport, RoomBoard, roomCode, type Member, type NetMode, type OpenRoom, type Wire } from "@/vibecup/net";
import { QrCode } from "@/oni/ui/QrCode";
import {
  advance, FINAL_ROUND, myFixture, newCup, record as recordCup, roundDone, roundFixtures, roundName, table, validCup, type Cup, type Fixture, type Position,
} from "@/vibecup/cup";

const MUTE_KEY = "vibecup.muted";
const PREFS_KEY = "vibecup.prefs";
const RECORD_KEY = "vibecup.record";
const NAME_KEY = "vibecup.name";
const CUP_KEY = "vibecup.cup";

type Mode = "cup" | "cpu" | "versus" | "online";
type Screen = "title" | "lobby" | "cup" | "playing" | "paused" | "over";

/** One match of a Cup round being played right now. */
interface LiveGame {
  f: Fixture;
  g: Game;
  fx: Fx;
  mine: boolean;
  done: boolean;
  scorers: string[];
}
interface LiveRound {
  round: number;
  games: Map<string, LiveGame>;
  focus: string | null;
}
/** What the scoreboards around the Cup show, copied out of the live round. */
interface Tick {
  id: string;
  home: string;
  away: string;
  score: [number, number];
  clock: string;
  done: boolean;
  mine: boolean;
}
const fixtureSeed = (cup: Cup, f: Fixture) => {
  let h = cup.seed;
  for (const ch of f.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h || 1;
};

/** What the lobby and the online screens show, copied out of the room on every change. */
interface NetUi {
  status: "connecting" | "ready" | "failed";
  code: string;
  host: boolean;
  me: string;
  hostName: string;
  members: Member[];
  clubs: [string, string];
  lost: boolean;
}

const urlParam = (k: string) => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(k));
const netMode = (): NetMode => (urlParam("net") === "local" ? "local" : "online");
const inviteLink = (code: string) => {
  const u = new URL(window.location.origin + window.location.pathname);
  u.searchParams.set("room", code);
  if (netMode() === "local") u.searchParams.set("net", "local");
  return u.toString();
};
const defaultName = () => `Player ${10 + Math.floor(Math.random() * 90)}`;
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

/** Every body's position in one flat list, for easing out a guest's corrections. */
function bodies(g: Game): number[] {
  const out: number[] = [];
  for (const p of g.players) out.push(p.x, p.y);
  out.push(g.ball.x, g.ball.y, g.ball.z);
  return out;
}
function shift(g: Game, off: number[], sign: 1 | -1) {
  if (!off.length) return;
  g.players.forEach((p, n) => {
    p.x += (off[n * 2] ?? 0) * sign;
    p.y += (off[n * 2 + 1] ?? 0) * sign;
  });
  const k = g.players.length * 2;
  g.ball.x += (off[k] ?? 0) * sign;
  g.ball.y += (off[k + 1] ?? 0) * sign;
  g.ball.z += (off[k + 2] ?? 0) * sign;
}

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
  /** The online room, when there is one. */
  const roomRef = useRef<CupRoom | null>(null);
  /** Guest side of a match: states not yet applied, and how far each body was pulled by the last correction. */
  const netRef = useRef<{ inbox: Array<Extract<Wire, { t: "st" }>>; off: number[]; labels: string[]; ended: number }>({ inbox: [], off: [], labels: [], ended: 0 });

  const [screen, setScreenState] = useState<Screen>("title");
  const [prefs, setPrefsState] = useState<Prefs>(prefsRef.current);
  const [hud, setHud] = useState<Hud>({ score: [0, 0], clock: "0'", has: false });
  const [muted, setMuted] = useState<boolean>(() => read(MUTE_KEY, { m: false }).m);
  const [record, setRecord] = useState<Record3>(() => read<Record3>(RECORD_KEY, { w: 0, d: 0, l: 0 }));
  const [touchUi] = useState(coarse);
  const [result, setResult] = useState<{ score: [number, number]; winner: TeamId | null; stats: Game["stats"] } | null>(null);
  const [net, setNet] = useState<NetUi | null>(null);
  const [name, setNameState] = useState<string>(() => read(NAME_KEY, { n: "" }).n || defaultName());
  const [openRooms, setOpenRooms] = useState<OpenRoom[]>([]);
  // The tournament.
  const cupRef = useRef<Cup | null>(null);
  const [cup, setCupState] = useState<Cup | null>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(CUP_KEY) ?? "null");
      return validCup(v) ? v : null;
    } catch {
      return null;
    }
  });
  cupRef.current = cup;
  const liveRef = useRef<LiveRound | null>(null);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [focusMine, setFocusMine] = useState(false);

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
      liveRef.current = null;
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

  /** Copy the room into React state for the lobby. */
  const syncNet = useCallback(() => {
    const r = roomRef.current;
    if (!r) return;
    const host = r.members.find((m) => m.id === r.hostId);
    setNet((n) => ({
      status: n?.status ?? "ready",
      code: r.code,
      host: r.isHost,
      me: r.id,
      hostName: host?.name ?? "the host",
      members: r.members.map((m) => ({ ...m })),
      clubs: [...r.clubs] as [string, string],
      lost: r.hostLost,
    }));
  }, []);

  /** Begin (or restart) the online match: the referee's half. */
  const startOnline = useCallback(() => {
    const r = roomRef.current;
    if (!r || !r.isHost) return;
    audioRef.current.unlock();
    r.setClubs([prefsRef.current.club, prefsRef.current.rival]);
    const setup = r.startMatch((Date.now() & 0xffff) + 1);
    beginMatch(setup);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Both halves: build the match everybody agreed on. */
  const beginMatch = (setup: { roster: string[]; seed: number; clubs: [string, string]; sides: TeamId[] }) => {
    const r = roomRef.current;
    const g = matchGame(setup);
    gameRef.current = g;
    fxRef.current = newFx(g.clubs);
    netRef.current = {
      inbox: [],
      off: [],
      ended: 0,
      labels: setup.roster.map((id) => (id === r?.id ? "YOU" : (r?.members.find((m) => m.id === id)?.name ?? "?").slice(0, 10).toUpperCase())),
    };
    setResult(null);
    setScreen("playing");
  };

  const openRoom = useCallback(
    async (host: boolean, code: string) => {
      roomRef.current?.leave();
      roomRef.current = null;
      liveRef.current = null;
      setNet({ status: "connecting", code, host, me: "", hostName: "", members: [], clubs: [prefsRef.current.club, prefsRef.current.rival], lost: false });
      setScreen("lobby");
      const u = new URL(window.location.href);
      u.searchParams.set("room", code);
      window.history.replaceState(null, "", u.toString());
      const tx = await openTransport(netMode(), code);
      if (!tx) {
        setNet((n) => (n ? { ...n, status: "failed" } : n));
        return;
      }
      const r = new CupRoom({ transport: tx, code, host, name: read(NAME_KEY, { n: "" }).n || name });
      roomRef.current = r;
      if (host) r.setClubs([prefsRef.current.club, prefsRef.current.rival]);
      r.onChange = () => {
        syncNet();
        if (!r.isHost && !r.live && (screenRef.current === "playing" || screenRef.current === "over")) setScreen("lobby");
      };
      r.onStart = (m) => {
        audioRef.current.unlock();
        beginMatch(m);
      };
      r.onState = (m) => netRef.current.inbox.push(m);
      setNet((n) => (n ? { ...n, status: "ready" } : n));
      syncNet();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [name, setScreen, syncNet],
  );

  const leaveRoom = useCallback(() => {
    if (roomRef.current?.isHost) withdrawRoom(roomRef.current.code);
    roomRef.current?.leave();
    roomRef.current = null;
    setNet(null);
    const u = new URL(window.location.href);
    u.searchParams.delete("room");
    window.history.replaceState(null, "", u.toString());
    gameRef.current = newGame({ seed: 5, clubs: [prefsRef.current.club, prefsRef.current.rival], humans: [] });
    fxRef.current = newFx(gameRef.current.clubs);
    setScreen("title");
  }, [setScreen]);

  const setName = (n: string) => {
    const v = n.slice(0, 16);
    setNameState(v);
    write(NAME_KEY, { n: v });
    roomRef.current?.rename(v.trim() || "Player");
    syncNet();
  };

  // The open-rooms board: listened to from the Online menu, shouted on by a room maker.
  const boardWanted = (screen === "title" && prefs.mode === "online") || (!!net?.host && net.status === "ready");
  useEffect(() => {
    if (!boardWanted || isShot()) return;
    let board: RoomBoard | null = null;
    let dead = false;
    let advertised = "";
    const refresh = () => setOpenRooms(board ? board.list(roomRef.current?.code) : []);
    const beat = () => {
      const r = roomRef.current;
      if (board && r?.isHost) {
        const host = r.members.find((m) => m.id === r.id)?.name ?? "Player";
        board.advertise(r.code, host, r.members.length, r.live);
        advertised = r.code;
      }
      refresh();
    };
    void openTransport(netMode(), BOARD).then((tx) => {
      if (!tx) return;
      if (dead) {
        tx.close();
        return;
      }
      board = new RoomBoard(tx);
      board.onChange = refresh;
      beat();
    });
    const timer = window.setInterval(beat, 2000);
    return () => {
      dead = true;
      window.clearInterval(timer);
      if (board && advertised && !roomRef.current?.isHost) board.withdraw(advertised);
      board?.close();
    };
  }, [boardWanted]);
  // A room maker who leaves takes their room off the board.
  const withdrawRoom = (code: string) => {
    void openTransport(netMode(), BOARD).then((tx) => {
      if (!tx) return;
      tx.send({ t: "gone", i: code });
      window.setTimeout(() => tx.close(), 500);
    });
  };

  // Opened from an invite link: straight into the room.
  useEffect(() => {
    const code = urlParam("room");
    if (code && !isShot()) void openRoom(false, cleanCode(code));
    const bye = () => roomRef.current?.leave();
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      roomRef.current?.leave();
      roomRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- The Cup

  const saveCup = useCallback((c: Cup | null) => {
    cupRef.current = c;
    setCupState(c);
    try {
      if (c) localStorage.setItem(CUP_KEY, JSON.stringify(c));
      else localStorage.removeItem(CUP_KEY);
    } catch {
      /* private mode: the Cup lasts as long as the tab */
    }
  }, []);

  const startCup = useCallback(
    (me: string | null, position: Position) => {
      audioRef.current.unlock();
      liveRef.current = null;
      setTicks([]);
      saveCup(newCup(me, position));
      setScreen("cup");
    },
    [saveCup, setScreen],
  );

  /** Point the camera (and the controls, if it is ours) at one match of the round. */
  const watch = useCallback(
    (id: string) => {
      const live = liveRef.current;
      const L = live?.games.get(id);
      if (!live || !L) return;
      audioRef.current.unlock();
      live.focus = id;
      gameRef.current = L.g;
      fxRef.current = L.fx;
      setFocusMine(L.mine);
      setResult(null);
      setScreen("playing");
    },
    [setScreen],
  );

  /** Everybody kicks off: your match, and the computer's matches alongside it. */
  const kickoffRound = useCallback(() => {
    const c = cupRef.current;
    if (!c || c.champion) return;
    const games = new Map<string, LiveGame>();
    for (const f of roundFixtures(c)) {
      if (f.score) continue;
      const side = f.home === c.me ? 0 : f.away === c.me ? 1 : -1;
      const g = newGame({
        seed: fixtureSeed(c, f),
        clubs: [f.home, f.away],
        difficulty: prefsRef.current.difficulty,
        humans: side >= 0 ? [side as TeamId] : [],
        lockRole: side >= 0 ? c.position : undefined,
      });
      games.set(f.id, { f, g, fx: newFx(g.clubs), mine: side >= 0, done: false, scorers: [] });
    }
    if (!games.size) return;
    liveRef.current = { round: c.round, games, focus: null };
    const mine = [...games.values()].find((x) => x.mine);
    watch(mine ? mine.f.id : games.keys().next().value!);
  }, [watch]);

  /** Play out the computer's matches in an instant. */
  const skipBots = useCallback(() => {
    const live = liveRef.current;
    if (!live) return;
    let c = cupRef.current!;
    for (const L of live.games.values()) {
      if (L.done || L.mine) continue;
      while (L.g.phase !== "over") {
        step(L.g, 1 / 30);
        for (const e of L.g.events) if (e.type === "goal") L.scorers.push(e.own ? `${e.name} (own goal)` : e.name);
        L.g.events.length = 0;
      }
      L.done = true;
      c = recordCup(c, L.f.id, [...L.g.score] as [number, number], L.g.golden, L.scorers);
    }
    saveCup(c);
  }, [saveCup]);

  const nextRound = useCallback(() => {
    const c = cupRef.current;
    if (!c || !roundDone(c)) return;
    liveRef.current = null;
    setTicks([]);
    saveCup(advance(c));
    setScreen("cup");
  }, [saveCup, setScreen]);

  const togglePause = useCallback(() => {
    if (roomRef.current) return; // nobody pauses an online match
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
    if (versus && !roomRef.current) {
      return [merge(merge(fromKeys(P1_KEYS), fromPad(pads[0])), fromTouch), merge(fromKeys(P2_KEYS), fromPad(pads[1]))];
    }
    let inp = merge(fromKeys(SOLO_KEYS), fromTouch);
    for (const p of pads) inp = merge(inp, fromPad(p));
    return [inp];
  }, []);

  // The loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let raf = 0;
    let last = performance.now();
    let shown = "";
    let lostShown = false;
    let tickKey = "";
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const g = gameRef.current;
      const room = roomRef.current;
      const online = !!room && !!room.match && (screenRef.current === "playing" || screenRef.current === "over");
      let evs: GameEvent[] = g.events;
      if (online && room.isHost) {
        // The referee: everybody's controls in, the match forward, the state out.
        const mine = room.myCtrl;
        if (screenRef.current === "playing" && mine >= 0) setInput(g, mine, autoRef.current ? autopilot(g, mine) : gather(g)[0]);
        room.match!.roster.forEach((id, n) => {
          if (n !== mine) setInput(g, n, room.remoteInput(id) ?? autopilot(g, n));
        });
        step(g, dt / 2);
        step(g, dt / 2);
        room.sendState(g, g.events);
      } else if (online) {
        // A guest: send the controls, take the referee's word, and fill the gaps by playing the same rules.
        const mine = room.myCtrl;
        const live = screenRef.current === "playing" ? (autoRef.current && mine >= 0 ? autopilot(g, mine) : gather(g)[0]) : null;
        if (live && mine >= 0) room.sendInput(live);
        const steer = () => {
          if (live && mine >= 0) setInput(g, mine, { mx: live.mx, my: live.my, sprint: live.sprint });
        };
        const nr = netRef.current;
        const inbox = nr.inbox.splice(0);
        evs = inbox.flatMap((m) => m.e);
        const latest = inbox[inbox.length - 1];
        if (latest) {
          const before = bodies(g);
          applySnap(g, latest.s);
          steer();
          const lag = Math.min(0.15, room.rtt / 2000);
          for (let t = 0; t < lag; t += 1 / 60) step(g, Math.min(1 / 60, lag - t));
          const after = bodies(g);
          before.forEach((v, n) => {
            let o = (nr.off[n] ?? 0) + v - after[n];
            if (Math.abs(o) > 4) o = 0; // a reset to kickoff is a jump, not a correction
            nr.off[n] = o;
          });
        } else {
          steer();
          step(g, dt / 2);
          step(g, dt / 2);
        }
        g.events.length = 0;
        const k = Math.exp(-dt * 12);
        for (let n = 0; n < nr.off.length; n++) nr.off[n] *= k;
        // A lost full-time packet must not leave anybody on the pitch for ever.
        if (g.phase === "over" && nr.ended !== room.match!.k && !evs.some((e) => e.type === "fulltime")) {
          evs = [...evs, { type: "fulltime", winner: g.score[0] > g.score[1] ? 0 : g.score[1] > g.score[0] ? 1 : null }];
        }
      } else if (liveRef.current) {
        // A Cup round: every match of it moves on at once, except ours, which waits while we look elsewhere.
        const live = liveRef.current;
        const onPitch = screenRef.current === "playing";
        let changed = false;
        for (const [id, L] of live.games) {
          if (L.done) continue;
          const focused = live.focus === id;
          if (L.mine) {
            if (!(focused && onPitch)) continue;
            setInput(L.g, 0, autoRef.current ? autopilot(L.g, 0) : gather(L.g)[0]);
          }
          step(L.g, dt / 2);
          step(L.g, dt / 2);
          const es = L.g.events;
          if (focused && onPitch) for (const e of es) audioRef.current.play(e);
          feedFx(L.fx, L.g, es);
          for (const e of es) if (e.type === "goal") L.scorers.push(e.own ? `${e.name} (own goal)` : e.name);
          if (es.some((e) => e.type === "fulltime")) {
            L.done = true;
            changed = true;
            saveCup(recordCup(cupRef.current!, id, [...L.g.score] as [number, number], L.g.golden, L.scorers));
            if (focused) {
              const g0 = L.g;
              window.setTimeout(() => {
                if (gameRef.current === g0 && screenRef.current === "playing") setScreen("cup");
              }, 3000);
            }
          }
          L.g.events.length = 0;
        }
        evs = [];
        const tk = [...live.games.values()].map((L) => `${L.f.id}:${L.g.score.join("-")}:${clockLabel(L.g)}:${L.done}`).join("|");
        if (changed || tk !== tickKey) {
          tickKey = tk;
          setTicks(
            [...live.games.values()].map((L) => ({
              id: L.f.id,
              home: L.f.home,
              away: L.f.away,
              score: [...L.g.score] as [number, number],
              clock: L.g.phase === "over" ? "FT" : clockLabel(L.g),
              done: L.done,
              mine: L.mine,
            })),
          );
        }
      } else {
        const playing = screenRef.current === "playing" || ((screenRef.current === "title" || screenRef.current === "lobby" || screenRef.current === "cup") && !isShot());
        if (playing) {
          if (screenRef.current === "playing") {
            gather(g).forEach((inp, i) => setInput(g, i, inp));
            if (autoRef.current) g.ctrls.forEach((_, i) => setInput(g, i, autopilot(g, i)));
          }
          // Two half-steps: smoother for fast balls on a slow frame.
          step(g, dt / 2);
          step(g, dt / 2);
        }
      }
      room?.tick();
      if (room && !room.isHost && room.hostLost && !lostShown) {
        lostShown = true;
        syncNet();
      }
      if (screenRef.current === "playing") for (const e of evs) audioRef.current.play(e);
      feedFx(fxRef.current, g, evs);
      const ended = evs.find((e) => e.type === "fulltime");
      if (ended && room?.match) netRef.current.ended = room.match.k;
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
      const c0 = g.ctrls[room?.match ? Math.max(0, room.myCtrl) : 0];
      const has = !!c0 && g.ball.owner === c0.active && (!room?.match || room.myCtrl >= 0);
      const key = `${g.score[0]}-${g.score[1]}-${clockLabel(g)}-${has}`;
      if (key !== shown) {
        shown = key;
        setHud({ score: [...g.score] as [number, number], clock: clockLabel(g), has });
      }
      if (online && !room.isHost) {
        // Draw where the bodies were heading, easing out the referee's corrections.
        const off = netRef.current.off;
        shift(g, off, 1);
        drawFrame(ctx, g, viewRef.current, fxRef.current, dt, netRef.current.labels);
        shift(g, off, -1);
      } else {
        const labels = online ? netRef.current.labels : g.ctrls.length > 1 ? ["P1", "P2"] : ["YOU"];
        const lock = g.ctrls.length === 1 && g.ctrls[0].lock >= 0 ? g.ctrls[0].lock : -1;
        drawFrame(ctx, g, viewRef.current, fxRef.current, dt, labels, lock);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [gather, setScreen, syncNet, saveCup]);

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
      else if (e.code === "Enter" && !roomRef.current && prefsRef.current.mode !== "online" && (screenRef.current === "title" || screenRef.current === "over")) start();
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
      if (document.hidden && screenRef.current === "playing" && !roomRef.current) setScreen("paused");
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
          net: roomRef.current
            ? {
                code: roomRef.current.code,
                host: roomRef.current.isHost,
                members: roomRef.current.members.map((m) => ({ ...m })),
                myCtrl: roomRef.current.myCtrl,
                k: roomRef.current.match?.k ?? 0,
                rtt: Math.round(roomRef.current.rtt),
                lost: roomRef.current.hostLost,
              }
            : null,
          me: (() => {
            const r = roomRef.current;
            const c = g.ctrls[r?.match ? r.myCtrl : 0];
            const p = c ? g.players[c.active] : null;
            return p ? { i: p.i, x: p.x, y: p.y } : null;
          })(),
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
      cup: {
        state: () => {
          const c = cupRef.current;
          const live = liveRef.current;
          return c
            ? {
                round: c.round,
                me: c.me,
                champion: c.champion,
                played: c.fixtures.filter((f) => f.score).length,
                table: table(c).map((r) => [r.club, r.p, r.pts]),
                live: live ? [...live.games.values()].map((L) => ({ id: L.f.id, mine: L.mine, done: L.done, score: L.g.score, clock: clockLabel(L.g), lock: L.g.ctrls[0]?.lock ?? -1, active: L.g.ctrls[0]?.active ?? -1 })) : null,
                focus: live?.focus ?? null,
              }
            : null;
        },
        start: (me: string | null, pos: Position = "fw") => startCup(me, pos),
        kickoff: () => kickoffRound(),
        watch: (id: string) => watch(id),
        skip: () => skipBots(),
        next: () => nextRound(),
        /** Run every live match of the round on for `seconds` (ours on autopilot), as if time passed. */
        settle: (seconds: number) => {
          const live = liveRef.current;
          if (!live) return;
          let c = cupRef.current!;
          for (const L of live.games.values()) {
            for (let t = 0; t < seconds && !L.done; t += 1 / 30) {
              if (L.mine) setInput(L.g, 0, autopilot(L.g, 0));
              step(L.g, 1 / 30);
              for (const e of L.g.events) if (e.type === "goal") L.scorers.push(e.name);
              if (L.g.events.some((e) => e.type === "fulltime")) {
                L.done = true;
                c = recordCup(c, L.f.id, [...L.g.score] as [number, number], L.g.golden, L.scorers);
              }
              L.g.events.length = 0;
            }
          }
          saveCup(c);
        },
      },
    };
    (window as unknown as { __vibecup?: typeof hook }).__vibecup = hook;
    return () => {
      delete (window as unknown as { __vibecup?: typeof hook }).__vibecup;
    };
  }, [start, startCup, kickoffRound, watch, skipBots, nextRound, saveCup]);

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
          <div className="flex items-center whitespace-nowrap px-3 font-mono text-xl tabular-nums" data-testid="vibecup-score">
            {hud.score[0]}–{hud.score[1]}
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1.5" style={{ background: c1.shirt, color: c1.ink }}>
            <span className="hidden sm:inline">{c1.short}</span>
            <span>{c1.emoji}</span>
          </div>
          <div className="flex max-w-[5.5rem] items-center bg-white/10 px-2.5 text-center font-mono text-xs leading-tight tabular-nums text-amber-200">{hud.clock}</div>
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
        {playingUi && !shot && !net && (
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
      {touchUi && screen === "playing" && (!liveRef.current || focusMine) && <TouchPad touch={touch} has={hud.has} locked={!!liveRef.current} />}

      {/* The Cup, mid-round: every other match's score, tap one to watch it. */}
      {liveRef.current && screen === "playing" && !shot && (
        <CupTicker
          ticks={ticks}
          focus={liveRef.current.focus}
          onWatch={watch}
          onHub={() => setScreen("cup")}
        />
      )}

      {screen === "cup" && cup && (
        <CupHub
          cup={cup}
          ticks={ticks}
          live={!!liveRef.current && liveRef.current.round === cup.round}
          onKickoff={kickoffRound}
          onWatch={watch}
          onSkip={skipBots}
          onNext={nextRound}
          onNew={() => {
            liveRef.current = null;
            saveCup(null);
            setPrefs({ mode: "cup" });
            setScreen("title");
          }}
          onMenu={() => {
            liveRef.current = null;
            setScreen("title");
          }}
        />
      )}

      {/* Keyboard hint */}
      {!touchUi && screen === "playing" && (!liveRef.current || focusMine) && (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-black/45 px-2.5 py-1.5 text-[11px] leading-snug text-white/75">
          {versus && !net ? (
            <>
              <span style={{ color: PAD_COLORS[0] }}>P1</span> WASD · F pass · G shoot · L-Shift sprint
              <br />
              <span style={{ color: PAD_COLORS[1] }}>P2</span> Arrows · K pass · L shoot · R-Shift sprint
            </>
          ) : (
            <>
              Move: arrows or WASD · {liveRef.current ? "Pass, or call for it: J or X" : "Pass/switch: J or X"} · Shoot/slide: K, Z or Space (hold to power up) · Sprint: Shift
            </>
          )}
        </div>
      )}

      {screen === "title" && (
        <TitleCard
          prefs={prefs}
          setPrefs={setPrefs}
          onStart={() => start()}
          onHost={() => void openRoom(true, roomCode())}
          onJoin={(code) => void openRoom(false, cleanCode(code))}
          openRooms={openRooms}
          cup={cup}
          onCupContinue={() => setScreen("cup")}
          onCupStart={startCup}
          record={record}
          touchUi={touchUi}
        />
      )}

      {screen === "lobby" && net && (
        <Lobby
          net={net}
          name={name}
          setName={setName}
          prefs={prefs}
          setPrefs={(p) => {
            setPrefs(p);
            const r = roomRef.current;
            if (r?.isHost) r.setClubs([prefsRef.current.club, prefsRef.current.rival]);
          }}
          onSide={(side) => {
            const r = roomRef.current;
            if (r) r.setSide(r.id, side);
            syncNet();
          }}
          onKickoff={startOnline}
          onLeave={leaveRoom}
          onRetry={() => void openRoom(net.host, net.code)}
        />
      )}

      {/* Online, mid-match: a way out (under the sound button), and word if the referee vanished. */}
      {net && playingUi && !shot && (
        <button
          type="button"
          onClick={leaveRoom}
          className="absolute right-3 top-[calc(max(env(safe-area-inset-top),10px)+44px)] rounded-full bg-black/45 px-3 py-1 text-[11px] font-bold text-white/70"
        >
          Leave
        </button>
      )}
      {net?.lost && screen !== "title" && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 p-3">
          <div className="w-full max-w-sm rounded-3xl bg-[#0b1726]/95 p-6 text-center">
            <div className="text-2xl font-black">The host left</div>
            <p className="mt-2 text-sm text-white/70">{net.hostName} closed the room or lost their connection.</p>
            <button type="button" onClick={leaveRoom} className="mt-4 w-full rounded-2xl bg-emerald-400 py-2.5 font-black text-[#002016]">
              Back to the menu
            </button>
          </div>
        </div>
      )}

      {screen === "paused" && !shot && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
          <div className="rounded-3xl bg-[#0b1726]/95 px-8 py-6 text-center">
            <div className="text-2xl font-black">Paused</div>
            <button type="button" onClick={togglePause} className="mt-4 w-full rounded-2xl bg-emerald-400 px-6 py-2.5 font-black text-[#002016]">
              Back to the match
            </button>
            {liveRef.current && (
              <button type="button" onClick={() => setScreen("cup")} className="mt-2 w-full rounded-2xl bg-white/10 px-6 py-2 text-sm font-bold">
                Back to the Cup
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                liveRef.current = null;
                setScreen("title");
              }}
              className="mt-2 w-full rounded-2xl bg-white/10 px-6 py-2 text-sm font-bold"
            >
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
                : net
                  ? onlineWinLine(net, result.winner, g.clubs[result.winner].name)
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
            {!versus && !net && (
              <div className="mt-3 text-xs text-white/60">
                Your record: {record.w} won · {record.d} drawn · {record.l} lost
              </div>
            )}
            {net && !net.host ? (
              <>
                <div className="mt-5 rounded-2xl bg-white/10 py-3 text-sm font-bold text-white/75">Waiting for {net.hostName} to start the rematch</div>
                <button type="button" onClick={leaveRoom} className="mt-2 w-full rounded-2xl bg-white/10 py-2 text-sm font-bold">
                  Leave the room
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => (net ? startOnline() : start())}
                  data-testid="vibecup-rematch"
                  className="mt-5 w-full rounded-2xl py-3 text-lg font-black text-[#002016] shadow-lg active:scale-[0.98]"
                  style={{ background: "linear-gradient(180deg,#6ff7d2,#1fd1b0)" }}
                >
                  Rematch
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (net) {
                      roomRef.current?.endMatch();
                      setScreen("lobby");
                    } else setScreen("title");
                  }}
                  className="mt-2 w-full rounded-2xl bg-white/10 py-2 text-sm font-bold"
                >
                  {net ? "Back to the room" : "Change teams"}
                </button>
              </>
            )}
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

function onlineWinLine(net: NetUi, winner: TeamId, club: string) {
  const side = net.members.filter((m) => m.side === winner);
  if (side.some((m) => m.id === net.me)) return `You win it with ${club}! 🏆`;
  const names = side.map((m) => m.name);
  return names.length ? `${names.join(" and ")} ${names.length > 1 ? "win" : "wins"} it with ${club}! 🏆` : `${club} win it`;
}

function ClubPick({ value, other, onPick, label, locked }: { value: string; other: string; onPick: (id: string) => void; label: string; locked?: boolean }) {
  return (
    <div>
      <div className="mb-1 text-left text-[10px] font-bold tracking-[0.2em] text-white/55">{label}</div>
      <div className="flex gap-1.5">
        {CLUBS.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={c.id === other || locked}
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
}

function TitleCard({
  prefs,
  setPrefs,
  onStart,
  onHost,
  onJoin,
  openRooms,
  cup,
  onCupContinue,
  onCupStart,
  record,
  touchUi,
}: {
  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void;
  onStart: () => void;
  onHost: () => void;
  onJoin: (code: string) => void;
  openRooms: OpenRoom[];
  cup: Cup | null;
  onCupContinue: () => void;
  onCupStart: (me: string | null, position: Position) => void;
  record: Record3;
  touchUi: boolean;
}) {
  const [code, setCode] = useState("");
  const [cupClub, setCupClub] = useState<string | null>(prefs.club);
  const [position, setPosition] = useState<Position>("fw");
  const running = cup && !cup.champion ? cup : null;
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
              ["cup", "🏆 The Vibe Cup", "Six clubs, a league and a final"],
              ["cpu", "Quick match", "You against the computer"],
              ["versus", "2 players", touchUi ? "Two pads on one screen" : "One keyboard, or two pads"],
              ["online", "Online", "Friends on their own phones"],
            ] as const
          ).map(([m, t, sub]) => (
            <button
              key={m}
              type="button"
              onClick={() => setPrefs({ mode: m })}
              data-testid={`vibecup-mode-${m}`}
              className={`rounded-2xl px-3 py-2.5 text-left transition ${prefs.mode === m ? "bg-emerald-400 text-[#002016]" : "bg-white/8 hover:bg-white/15"}`}
              style={prefs.mode === m ? undefined : { background: "rgba(255,255,255,0.08)" }}
            >
              <div className="font-black">{t}</div>
              <div className={`text-[11px] leading-tight ${prefs.mode === m ? "text-[#002016]/80" : "text-white/60"}`}>{sub}</div>
            </button>
          ))}
        </div>

        {prefs.mode === "cup" ? (
          <div className="mt-4 space-y-3 text-left">
            {running && (
              <button
                type="button"
                onClick={onCupContinue}
                data-testid="vibecup-cup-continue"
                className="w-full rounded-2xl py-3 text-center text-lg font-black text-[#002016] shadow-lg active:scale-[0.98]"
                style={{ background: "linear-gradient(180deg,#ffe27a,#f5b800)" }}
              >
                Carry on the Cup: {roundName(running.round)}
                <div className="text-xs font-bold text-[#002016]/70">{running.me ? `with ${clubById(running.me).name}` : "watching"}</div>
              </button>
            )}
            <div className="text-[10px] font-bold tracking-[0.2em] text-white/55">{running ? "OR START A NEW CUP" : "PICK YOUR CLUB"}</div>
            <div className="grid grid-cols-7 gap-1.5">
              {CLUBS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCupClub(c.id)}
                  title={c.name}
                  data-testid={`vibecup-cup-club-${c.id}`}
                  className={`flex h-11 items-center justify-center rounded-xl text-lg transition ${cupClub === c.id ? "ring-2 ring-white" : "opacity-70 hover:opacity-100"}`}
                  style={{ background: c.shirt }}
                >
                  {c.emoji}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setCupClub(null)}
                title="Just watch"
                data-testid="vibecup-cup-watch"
                className={`flex h-11 items-center justify-center rounded-xl bg-white/10 text-lg transition ${cupClub === null ? "ring-2 ring-white" : "opacity-70 hover:opacity-100"}`}
              >
                👀
              </button>
            </div>
            <div className="text-xs font-bold" style={{ color: cupClub ? clubById(cupClub).shirt : "#fff" }}>
              {cupClub ? clubById(cupClub).name : "Just watch: the computer plays every match"}
            </div>
            {cupClub && (
              <div>
                <div className="mb-1 text-[10px] font-bold tracking-[0.2em] text-white/55">YOU PLAY AS (ALL CUP LONG)</div>
                <div className="flex gap-1.5">
                  {(
                    [
                      ["fw", "Striker"],
                      ["mf", "Midfield"],
                      ["df", "Defender"],
                    ] as const
                  ).map(([k, t]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setPosition(k)}
                      className={`flex-1 rounded-xl py-1.5 text-sm font-bold ${position === k ? "bg-amber-300 text-black" : "text-white/70"}`}
                      style={position === k ? undefined : { background: "rgba(255,255,255,0.08)" }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => onCupStart(cupClub, position)}
              data-testid="vibecup-cup-start"
              className="w-full rounded-2xl py-3 text-lg font-black text-[#002016] shadow-lg active:scale-[0.98]"
              style={{ background: "linear-gradient(180deg,#6ff7d2,#1fd1b0)" }}
            >
              {running ? "Start a new Cup" : "Start the Cup"}
            </button>
            <p className="text-xs leading-relaxed text-white/55">
              Everybody plays everybody once, then the top two meet in the final. You are one player the whole way: press pass without the ball to call for it. Every other match plays live at the same time, and you can watch any of them.
            </p>
          </div>
        ) : prefs.mode === "online" ? (
          <div className="mt-4 space-y-3 text-left">
            <button
              type="button"
              onClick={onHost}
              data-testid="vibecup-host"
              className="w-full rounded-2xl py-3 text-lg font-black text-[#002016] shadow-lg active:scale-[0.98]"
              style={{ background: "linear-gradient(180deg,#6ff7d2,#1fd1b0)" }}
            >
              Make a room
            </button>
            <div>
              <div className="mb-1 text-[10px] font-bold tracking-[0.2em] text-white/55">OPEN ROOMS</div>
              {openRooms.length ? (
                <div className="space-y-1.5" data-testid="vibecup-open-rooms">
                  {openRooms.slice(0, 5).map((r) => {
                    const full = r.players >= MAX_PER_SIDE * 2;
                    return (
                      <button
                        key={r.code}
                        type="button"
                        onClick={() => onJoin(r.code)}
                        className="flex w-full items-center gap-2 rounded-2xl bg-white/10 px-3 py-2 text-left hover:bg-white/15"
                        data-testid="vibecup-open-room"
                      >
                        <span className="text-lg">⚽</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-black">{r.host}'s room</span>
                          <span className="block text-[11px] text-white/55">
                            {r.players} of {MAX_PER_SIDE * 2} in{r.live ? " · match on, you can watch and join the next" : ""}
                          </span>
                        </span>
                        <span className={`rounded-xl px-3 py-1 text-xs font-black ${full ? "bg-white/10 text-white/60" : "bg-emerald-400 text-[#002016]"}`}>{full ? "Watch" : "Join"}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-2xl bg-white/5 px-3 py-2.5 text-xs text-white/50">No open rooms right now. Make one and send your friends the link.</div>
              )}
            </div>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (cleanCode(code).length >= 4) onJoin(code);
              }}
            >
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Got a code? NUTMEG-4B2"
                className="min-w-0 flex-1 rounded-2xl border border-white/15 bg-white/5 px-3 py-2.5 font-mono text-sm uppercase text-white placeholder:normal-case placeholder:text-white/35"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" className="rounded-2xl bg-white/15 px-4 font-black">
                Join
              </button>
            </form>
            <p className="text-xs leading-relaxed text-white/55">
              Make a room and send the link. Up to four of you, two a side, each on your own phone or laptop. The computer plays the rest of both teams.
            </p>
          </div>
        ) : (
        <>
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
        </>
        )}
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

/** The online room: the invite, who is in, which side, and the referee's kick off. */
function Lobby({
  net,
  name,
  setName,
  prefs,
  setPrefs,
  onSide,
  onKickoff,
  onLeave,
  onRetry,
}: {
  net: NetUi;
  name: string;
  setName: (n: string) => void;
  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void;
  onSide: (s: TeamId) => void;
  onKickoff: () => void;
  onLeave: () => void;
  onRetry: () => void;
}) {
  const link = inviteLink(net.code);
  const [copied, setCopied] = useState(false);
  const share = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: "Vibe Cup", text: "Come and play soccer with me in Vibe Cup", url: link });
        return;
      }
    } catch {
      /* cancelled, fall through to copy */
    }
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* no clipboard: the link is on screen */
    }
  };
  const clubs = net.host ? ([prefs.club, prefs.rival] as [string, string]) : net.clubs;
  const mySide = net.members.find((m) => m.id === net.me)?.side;
  const enough = net.members.length >= 2;
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto bg-black/45 p-3">
      <div className="my-auto w-full max-w-md rounded-3xl border border-white/10 bg-[#0b1726]/95 p-5 text-center shadow-2xl backdrop-blur" data-testid="vibecup-lobby">
        <div className="text-[10px] font-bold tracking-[0.3em] text-white/55">ONLINE ROOM</div>
        <div className="mt-1 font-mono text-3xl font-black tracking-wider text-[#6ff7d2]" data-testid="vibecup-code">
          {net.code}
        </div>

        {net.status === "connecting" && <p className="mt-4 text-sm text-white/70">Opening the room…</p>}
        {net.status === "failed" && (
          <div className="mt-4">
            <p className="text-sm text-rose-300">Could not reach the room. Check the connection and try again.</p>
            <button type="button" onClick={onRetry} className="mt-3 w-full rounded-2xl bg-emerald-400 py-2.5 font-black text-[#002016]">
              Try again
            </button>
          </div>
        )}

        {net.status === "ready" && (
          <>
            <div className="mt-3 flex items-center gap-2">
              <button type="button" onClick={share} className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-white/15 py-2.5 text-sm font-black" data-testid="vibecup-share">
                {navigator.share ? <Share2 size={15} /> : <Copy size={15} />}
                {copied ? "Link copied" : "Invite friends"}
              </button>
            </div>
            <div className="mt-3 hidden items-center gap-3 text-left sm:flex">
              <QrCode text={link} size={96} />
              <p className="text-xs leading-relaxed text-white/60">Scan with a phone to join, or send the link. Anybody with the code can join from the Online menu.</p>
            </div>

            <label className="mt-4 block text-left text-[10px] font-bold tracking-[0.2em] text-white/55">
              YOUR NAME
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={16}
                className="mt-1 w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm font-bold tracking-normal text-white"
                data-testid="vibecup-name"
              />
            </label>

            <div className="mt-4 grid grid-cols-2 gap-2">
              {([0, 1] as TeamId[]).map((side) => {
                const club = clubById(clubs[side]);
                const here = net.members.filter((m) => m.side === side);
                const full = here.length >= MAX_PER_SIDE;
                return (
                  <div key={side} className="rounded-2xl border border-white/10 p-2" style={{ background: `${club.shirt}22` }}>
                    <div className="flex items-center justify-center gap-1.5 rounded-xl py-1.5 text-sm font-black" style={{ background: club.shirt, color: club.ink }}>
                      <span>{club.emoji}</span>
                      <span className="truncate">{club.short}</span>
                    </div>
                    <div className="mt-2 min-h-[52px] space-y-1">
                      {here.map((m) => (
                        <div key={m.id} className={`truncate rounded-lg px-2 py-1 text-sm font-bold ${m.id === net.me ? "bg-white/20" : "bg-white/5"}`}>
                          {m.name}
                          {m.id === net.me ? " (you)" : ""}
                        </div>
                      ))}
                    </div>
                    {mySide !== side && !full && (
                      <button type="button" onClick={() => onSide(side)} className="mt-1 w-full rounded-lg bg-white/10 py-1 text-xs font-bold" data-testid={`vibecup-side-${side}`}>
                        Play for {club.short}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {net.host && (
              <div className="mt-4 space-y-3">
                <ClubPick label="LEFT" value={prefs.club} other={prefs.rival} onPick={(id) => setPrefs({ club: id })} />
                <ClubPick label="RIGHT" value={prefs.rival} other={prefs.club} onPick={(id) => setPrefs({ rival: id })} />
              </div>
            )}

            {net.host ? (
              <button
                type="button"
                onClick={onKickoff}
                disabled={!enough}
                data-testid="vibecup-online-kickoff"
                className="mt-5 w-full rounded-2xl py-3 text-lg font-black text-[#002016] shadow-lg active:scale-[0.98] disabled:opacity-40"
                style={{ background: "linear-gradient(180deg,#6ff7d2,#1fd1b0)" }}
              >
                {enough ? "Kick off" : "Waiting for a friend to join…"}
              </button>
            ) : (
              <div className="mt-5 rounded-2xl bg-white/10 py-3 text-sm font-bold text-white/75">
                {net.members.length ? `Waiting for ${net.hostName} to kick off` : "Looking for the room…"}
              </div>
            )}
          </>
        )}
        <button type="button" onClick={onLeave} className="mt-2 w-full rounded-2xl bg-white/5 py-2 text-sm font-bold text-white/70">
          Leave
        </button>
      </div>
    </div>
  );
}

/** Mid-round: a chip per match of the round, live, and a way back to the Cup. */
function CupTicker({ ticks, focus, onWatch, onHub }: { ticks: Tick[]; focus: string | null; onWatch: (id: string) => void; onHub: () => void }) {
  return (
    <div className="absolute left-1/2 top-[calc(max(env(safe-area-inset-top),10px)+46px)] flex max-w-[calc(100vw-24px)] -translate-x-1/2 gap-1 overflow-x-auto" data-testid="vibecup-ticker">
      {ticks.map((t) => {
        const h = clubById(t.home);
        const a = clubById(t.away);
        const on = t.id === focus;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onWatch(t.id)}
            className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-black tabular-nums ${on ? "bg-white text-black" : "bg-black/55 text-white"}`}
            title={t.mine ? "Your match" : "Watch this match"}
          >
            <span>{h.emoji}</span>
            <span>
              {t.score[0]}-{t.score[1]}
            </span>
            <span>{a.emoji}</span>
            <span className={on ? "text-black/55" : "text-white/55"}>{t.mine ? "YOU" : t.clock}</span>
          </button>
        );
      })}
      <button type="button" onClick={onHub} className="shrink-0 rounded-full bg-amber-300 px-2.5 py-0.5 text-[11px] font-black text-black">
        🏆 Cup
      </button>
    </div>
  );
}

/** The Cup between matches: this round's fixtures (live or played), the table, and what to do next. */
function CupHub({
  cup,
  ticks,
  live,
  onKickoff,
  onWatch,
  onSkip,
  onNext,
  onNew,
  onMenu,
}: {
  cup: Cup;
  ticks: Tick[];
  live: boolean;
  onKickoff: () => void;
  onWatch: (id: string) => void;
  onSkip: () => void;
  onNext: () => void;
  onNew: () => void;
  onMenu: () => void;
}) {
  const rows = table(cup);
  const fixtures = roundFixtures(cup);
  const mine = myFixture(cup);
  const done = roundDone(cup);
  const botsLeft = live && ticks.some((t) => !t.done && !t.mine);
  const myLive = live && ticks.some((t) => t.mine && !t.done);
  const champ = cup.champion ? clubById(cup.champion) : null;
  const tick = (id: string) => ticks.find((t) => t.id === id);
  const past = cup.fixtures.filter((f) => f.score && f.round < cup.round).reverse();
  return (
    <div className="absolute inset-0 overflow-y-auto bg-black/55 p-3" data-testid="vibecup-hub">
      <div className="mx-auto my-6 w-full max-w-lg rounded-3xl border border-white/10 bg-[#0b1726]/95 p-5 shadow-2xl backdrop-blur">
        <div className="text-center">
          <div className="text-[10px] font-bold tracking-[0.3em] text-white/55">THE VIBE CUP</div>
          <h2 className="mt-1 text-3xl font-black italic text-amber-300">{champ ? "Champions!" : roundName(cup.round)}</h2>
          <div className="mt-1 text-xs text-white/60">
            {cup.me ? (
              <>
                You play for <b style={{ color: clubById(cup.me).shirt }}>{clubById(cup.me).name}</b> as their{" "}
                {cup.position === "fw" ? "striker" : cup.position === "mf" ? "midfielder" : "defender"}
              </>
            ) : (
              "You are watching. The computer plays every match."
            )}
          </div>
        </div>

        {champ && (
          <div className="mt-4 rounded-2xl p-4 text-center" style={{ background: `${champ.shirt}33` }} data-testid="vibecup-champion">
            <div className="text-5xl">🏆</div>
            <div className="mt-1 text-2xl font-black" style={{ color: champ.shirt }}>
              {champ.emoji} {champ.name}
            </div>
            <div className="text-sm text-white/75">{cup.champion === cup.me ? "You won the Vibe Cup!" : "win the Vibe Cup"}</div>
          </div>
        )}

        {!champ && (
          <div className="mt-4 space-y-1.5" data-testid="vibecup-fixtures">
            {fixtures.map((f) => {
              const h = clubById(f.home);
              const a = clubById(f.away);
              const t = tick(f.id);
              const isMine = f.home === cup.me || f.away === cup.me;
              const score = f.score ?? (t ? t.score : null);
              return (
                <div key={f.id} className={`flex items-center gap-1.5 rounded-2xl px-2.5 py-2 ${isMine ? "bg-white/15" : "bg-white/5"}`}>
                  <span className="flex min-w-0 flex-1 items-center justify-end gap-1 truncate text-right text-xs font-bold sm:text-sm">
                    <span className="truncate">{h.short}</span>
                    <span>{h.emoji}</span>
                  </span>
                  <span className="w-11 shrink-0 text-center font-mono text-base font-black tabular-nums sm:w-14 sm:text-lg">{score ? `${score[0]}-${score[1]}` : "v"}</span>
                  <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-xs font-bold sm:text-sm">
                    <span>{a.emoji}</span>
                    <span className="truncate">{a.short}</span>
                  </span>
                  <span className="w-[4.5rem] shrink-0 text-right">
                    {f.score ? (
                      <span className="text-[11px] font-bold text-white/50">{f.golden ? "FT, GG" : "FT"}</span>
                    ) : t && !t.done ? (
                      <button type="button" onClick={() => onWatch(f.id)} className="rounded-xl bg-emerald-400 px-2.5 py-1 text-xs font-black text-[#002016]" data-testid="vibecup-watch">
                        {isMine ? "Play" : `Watch`}
                      </button>
                    ) : (
                      <span className="text-[11px] text-white/40">{isMine ? "You" : ""}</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-4 space-y-2">
          {champ ? (
            <button type="button" onClick={onNew} className="w-full rounded-2xl bg-emerald-400 py-3 text-lg font-black text-[#002016]" data-testid="vibecup-cup-new">
              Play another Cup
            </button>
          ) : done ? (
            <button type="button" onClick={onNext} className="w-full rounded-2xl bg-amber-300 py-3 text-lg font-black text-black" data-testid="vibecup-cup-next">
              {cup.round >= FINAL_ROUND - 1 ? "On to the final" : "Next round"}
            </button>
          ) : !live ? (
            <button type="button" onClick={onKickoff} className="w-full rounded-2xl py-3 text-lg font-black text-[#002016]" style={{ background: "linear-gradient(180deg,#6ff7d2,#1fd1b0)" }} data-testid="vibecup-cup-kickoff">
              {mine ? `Kick off: ${clubById(mine.home).short} v ${clubById(mine.away).short}` : cup.round >= FINAL_ROUND ? "Watch the final" : "Kick off the round"}
            </button>
          ) : (
            <>
              {myLive && mine && (
                <button type="button" onClick={() => onWatch(mine.id)} className="w-full rounded-2xl bg-emerald-400 py-3 text-lg font-black text-[#002016]">
                  Back to your match
                </button>
              )}
              {botsLeft && (
                <button type="button" onClick={onSkip} className="w-full rounded-2xl bg-white/10 py-2 text-sm font-bold" data-testid="vibecup-cup-skip">
                  Skip to the computer's results
                </button>
              )}
            </>
          )}
        </div>

        <div className="mt-5">
          <div className="mb-1 text-[10px] font-bold tracking-[0.2em] text-white/55">TABLE</div>
          <table className="w-full text-xs tabular-nums" data-testid="vibecup-table">
            <thead className="text-white/45">
              <tr>
                <th className="w-5 text-left font-bold">#</th>
                <th className="text-left font-bold">Club</th>
                <th className="w-6 font-bold">P</th>
                <th className="w-6 font-bold">W</th>
                <th className="w-6 font-bold">D</th>
                <th className="w-6 font-bold">L</th>
                <th className="w-9 font-bold">GD</th>
                <th className="w-8 font-bold">Pts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const c = clubById(r.club);
                return (
                  <tr key={r.club} className={r.club === cup.me ? "bg-white/10 font-black" : ""}>
                    <td className={`py-1 ${i < 2 ? "text-amber-300" : "text-white/50"}`}>{i + 1}</td>
                    <td className="truncate py-1">
                      {c.emoji} {c.name}
                    </td>
                    <td className="text-center">{r.p}</td>
                    <td className="text-center">{r.w}</td>
                    <td className="text-center">{r.d}</td>
                    <td className="text-center">{r.l}</td>
                    <td className="text-center">{r.gf - r.ga > 0 ? `+${r.gf - r.ga}` : r.gf - r.ga}</td>
                    <td className="text-center font-black">{r.pts}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-1 text-[10px] text-white/40">Top two after five rounds play the final. GG means a golden goal settled it.</div>
        </div>

        {past.length > 0 && (
          <div className="mt-4">
            <div className="mb-1 text-[10px] font-bold tracking-[0.2em] text-white/55">RESULTS</div>
            <div className="space-y-1 text-xs">
              {past.map((f) => (
                <div key={f.id} className="flex gap-2 text-white/70">
                  <span className="w-10 text-white/40">{f.stage === "final" ? "Final" : `R${f.round}`}</span>
                  <span className="flex-1 truncate">
                    {clubById(f.home).emoji} {clubById(f.home).short} {f.score![0]}-{f.score![1]} {clubById(f.away).short} {clubById(f.away).emoji}
                    {f.scorers && f.scorers.length > 0 && <span className="text-white/40"> · {f.scorers.join(", ")}</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <button type="button" onClick={onMenu} className="mt-4 w-full rounded-2xl bg-white/5 py-2 text-sm font-bold text-white/70">
          Main menu{live && !done ? " (this round's unfinished matches start again)" : ""}
        </button>
      </div>
    </div>
  );
}

/** A floating thumb stick on the left half, two buttons on the right. */
function TouchPad({ touch, has, locked }: { touch: MutableRefObject<{ mx: number; my: number; a: boolean; b: boolean; on: boolean; tapA: boolean; tapB: boolean }>; has: boolean; locked?: boolean }) {
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
            ["a", has ? "PASS" : locked ? "CALL" : "SWITCH", "#38bdf8", 64],
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
