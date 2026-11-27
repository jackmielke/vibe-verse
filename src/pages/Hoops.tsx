/**
 * VIBE HOOPS — the page.
 *
 * Three on three under the lights of the Vibe Dome, with people from all over
 * the Vibe Verse on the floor: Vibey, Mad Mort's junkyard crew, the samurai,
 * the pirates, and you, as whoever you picked in My Vibe.
 *
 * Plays like Vibe Cup: you are one player all game. Against the computer, two
 * people on one keyboard (versus or on the same team), or up to six online
 * with an invite link and a QR code, each on their own phone.
 *
 * Thin, like every world here: the rules are `src/hoops/game.ts` (pure,
 * tested in `src/test/hoops.test.ts`), the broadcast is `render.ts` with the
 * Dome in `arena.ts` and the bodies in `bodies.ts`, the noise is `audio.ts`,
 * the rooms are `net.ts`. This file owns the menus, the input and the loop.
 *
 * `window.__hoops` is the test hook: `state()`, `start(opts)`, `settle(s)`,
 * `auto(on)`, `input(ctrl, input)` and `snapshot()`, because SwiftShader draws
 * a frame a second and `page.screenshot()` cannot see a WebGL canvas there.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type PointerEvent as RPointerEvent } from "react";
import { Link } from "react-router-dom";
import { Copy, Pause, Play, Share2, Volume2, VolumeX } from "lucide-react";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import { useActiveCharacter } from "@/hooks/use-active-character";
import {
  clockLabel, distToHoop, drain, mvp, newGame, offence, setAuto, setInput, step, type Difficulty, type Game, type GameEvent, type Input, type TeamId,
} from "@/hoops/game";
import { CLUBS, clubById, type Club } from "@/hoops/teams";
import { HoopsView } from "@/hoops/render";
import { HoopsAudio } from "@/hoops/audio";
import { applySnap, BOARD, cleanCode, HoopsRoom, matchGame, MAX_PER_SIDE, openTransport, RoomBoard, roomCode, type Member, type NetMode, type OpenRoom, type Wire } from "@/hoops/net";
import { QrCode } from "@/oni/ui/QrCode";

const MUTE_KEY = "hoops.muted";
const PREFS_KEY = "hoops.prefs";
const RECORD_KEY = "hoops.record";
const NAME_KEY = "hoops.name";

type Screen = "title" | "setup" | "playing" | "paused" | "over" | "lobby";
type Mode = "cpu" | "versus" | "coop" | "online";

interface Prefs {
  club: string;
  rival: string;
  pick: string;
  pick2: string;
  difficulty: Difficulty;
}

const urlParam = (k: string) => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(k));
const netMode = (): NetMode => (urlParam("net") === "local" ? "local" : "online");
const inviteLink = (code: string) => {
  const u = new URL(window.location.origin + window.location.pathname);
  u.searchParams.set("room", code);
  if (netMode() === "local") u.searchParams.set("net", "local");
  return u.toString();
};
const defaultName = () => `Baller ${10 + Math.floor(Math.random() * 90)}`;

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
  shot: number;
  shout: string;
  sub: string;
  shoutKey: number;
  /** Context for the buttons: has the ball / our ball / their ball. */
  ctx: "has" | "off" | "def";
  cine: boolean;
  phase: Game["phase"];
  sudden: boolean;
}

interface NetUi {
  code: string;
  host: boolean;
  status: "connecting" | "ready" | "failed";
  members: Member[];
  me: string;
  hostName: string;
  clubs: [string, string];
}

interface Result {
  score: [number, number];
  winner: TeamId;
  stats: Game["stats"];
  mvp: { name: string; pts: number; team: TeamId };
  mine: TeamId[];
}

export default function Hoops() {
  useWorldStamp("/hoops", "Vibe Hoops");
  const { character } = useActiveCharacter();
  const meRef = useRef(character);
  meRef.current = character;

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const meterFill = useRef<HTMLDivElement>(null);
  const prefsRef = useRef<Prefs>(read<Prefs>(PREFS_KEY, { club: "volts", rival: "junkyard", pick: "vibey", pick2: "mort", difficulty: "normal" }));
  const gameRef = useRef<Game>(newGame({ seed: 3, clubs: [prefsRef.current.club, prefsRef.current.rival], skipIntro: true }));
  const viewRef = useRef<HoopsView | null>(null);
  const audioRef = useRef<HoopsAudio>(new HoopsAudio());
  const screenRef = useRef<Screen>("title");
  const modeRef = useRef<Mode>("cpu");
  const autoRef = useRef(false);
  const keys = useRef(new Set<string>());
  const tapped = useRef(new Set<string>());
  const touch = useRef({ mx: 0, my: 0, a: false, b: false, tapA: false, tapB: false });
  const roomRef = useRef<HoopsRoom | null>(null);
  const boardRef = useRef<RoomBoard | null>(null);
  const netRef = useRef<{ inbox: Array<Extract<Wire, { t: "st" }>>; ended: number }>({ inbox: [], ended: 0 });
  const overAt = useRef(0);
  const readyAt = useRef(0);

  const [screen, setScreenState] = useState<Screen>("title");
  const [mode, setModeState] = useState<Mode>("cpu");
  const [prefs, setPrefsState] = useState<Prefs>(prefsRef.current);
  const [hud, setHud] = useState<Hud>({ score: [0, 0], clock: "3:00", shot: 14, shout: "", sub: "", shoutKey: 0, ctx: "def", cine: false, phase: "intro", sudden: false });
  const [muted, setMuted] = useState<boolean>(() => read(MUTE_KEY, { m: false }).m);
  const [record, setRecord] = useState(() => read(RECORD_KEY, { w: 0, l: 0 }));
  const [touchUi] = useState(coarse);
  const [result, setResult] = useState<Result | null>(null);
  const [net, setNet] = useState<NetUi | null>(null);
  const [name, setNameState] = useState<string>(() => read(NAME_KEY, { n: "" }).n || defaultName());
  const [openRooms, setOpenRooms] = useState<OpenRoom[]>([]);
  const [loading, setLoading] = useState(false);

  const setScreen = useCallback((s: Screen) => {
    screenRef.current = s;
    setScreenState(s);
  }, []);
  const setMode = useCallback((m: Mode) => {
    modeRef.current = m;
    setModeState(m);
  }, []);
  const setPrefs = useCallback((p: Partial<Prefs>) => {
    const next = { ...prefsRef.current, ...p };
    if (next.club === next.rival) next.rival = CLUBS.find((c) => c.id !== next.club)!.id;
    prefsRef.current = next;
    setPrefsState(next);
    write(PREFS_KEY, next);
  }, []);
  const setName = useCallback((n: string) => {
    setNameState(n);
    write(NAME_KEY, { n });
    roomRef.current?.rename(n.trim() || "Player");
  }, []);

  useEffect(() => {
    audioRef.current.setMuted(muted);
    write(MUTE_KEY, { m: muted });
  }, [muted]);

  // ---- the view

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const lq = urlParam("lq") !== null || (coarse() && Math.min(window.screen.width, window.screen.height) < 400);
    let view: HoopsView;
    try {
      view = new HoopsView(canvas, lq ? "low" : "high");
    } catch {
      return;
    }
    viewRef.current = view;
    view.onDribble = () => {
      if (screenRef.current === "playing") audioRef.current.dribble(0.6);
    };
    const fit = () => view.resize(wrap.clientWidth, wrap.clientHeight);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    void view.load(gameRef.current, meRef.current);
    return () => {
      ro.disconnect();
      view.dispose();
      viewRef.current = null;
    };
  }, []);

  // ---- starting a game

  const begin = useCallback(
    (g: Game) => {
      gameRef.current = g;
      const view = viewRef.current;
      overAt.current = 0;
      setResult(null);
      readyAt.current = performance.now() + 6000;
      if (view) {
        view.ready = false;
        // Online, the camera sits behind this device's own player, not the host's.
        const r = roomRef.current;
        const mine = r?.match ? r.myCtrl : 0;
        const c = g.ctrls[mine >= 0 ? mine : 0];
        view.homeTeam = (c ? g.players[c.player].team : 0) as TeamId;
        setLoading(true);
        void view.load(g, meRef.current).then(() => setLoading(false));
      }
      setScreen("playing");
    },
    [setScreen],
  );

  const start = useCallback(() => {
    const p = prefsRef.current;
    const m = modeRef.current;
    audioRef.current.unlock();
    const humans: Array<{ team: TeamId; pick?: string | null }> =
      m === "cpu" ? [{ team: 0, pick: p.pick }] : m === "versus" ? [{ team: 0, pick: p.pick }, { team: 1, pick: p.pick2 }] : [{ team: 0, pick: p.pick }, { team: 0, pick: p.pick2 }];
    begin(newGame({ seed: (Math.random() * 1e9) | 0, clubs: [p.club, p.rival], difficulty: p.difficulty, humans }));
  }, [begin]);

  const toTitle = useCallback(() => {
    roomRef.current?.leave();
    roomRef.current = null;
    setNet(null);
    const p = prefsRef.current;
    gameRef.current = newGame({ seed: (Math.random() * 1e9) | 0, clubs: [p.club, p.rival], skipIntro: true });
    const v = viewRef.current;
    if (v) void v.load(gameRef.current, meRef.current);
    setResult(null);
    setScreen("title");
  }, [setScreen]);

  // ---- input

  const gather = useCallback((g: Game): Input[] => {
    const view = viewRef.current;
    const toCourt = (sx: number, sy: number): [number, number] => (view ? view.stickToCourt(sx, sy) : [sx, sy]);
    const couch = g.ctrls.length > 1 && !roomRef.current;
    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? Array.from(navigator.getGamepads()).filter((p): p is Gamepad => !!p) : [];
    const k = keys.current;
    const tap = tapped.current;
    const held = (list: string[]) => list.some((c) => k.has(c) || tap.has(c));
    const none: Input = { mx: 0, my: 0, a: false, b: false, sprint: false };
    const fromKeys = (m: KeyMap): Input => {
      const sx = (held(m.right) ? 1 : 0) - (held(m.left) ? 1 : 0);
      const sy = (held(m.down) ? 1 : 0) - (held(m.up) ? 1 : 0);
      const l = Math.hypot(sx, sy) || 1;
      const [mx, my] = toCourt(sx / l, sy / l);
      return { mx, my, a: held(m.a), b: held(m.b), sprint: held(m.sprint) };
    };
    const merge = (a: Input, b: Input): Input => {
      const big = Math.hypot(b.mx, b.my) > Math.hypot(a.mx, a.my) ? b : a;
      return { mx: big.mx, my: big.my, a: a.a || b.a, b: a.b || b.b, sprint: a.sprint || b.sprint };
    };
    const fromPad = (p: Gamepad | undefined): Input => {
      if (!p) return none;
      let sx = p.axes[0] ?? 0;
      let sy = p.axes[1] ?? 0;
      if (Math.hypot(sx, sy) < 0.2) {
        sx = (p.buttons[15]?.pressed ? 1 : 0) - (p.buttons[14]?.pressed ? 1 : 0);
        sy = (p.buttons[13]?.pressed ? 1 : 0) - (p.buttons[12]?.pressed ? 1 : 0);
      }
      const [mx, my] = toCourt(sx, sy);
      const btn = (i: number) => !!p.buttons[i]?.pressed;
      return { mx, my, a: btn(0), b: btn(1) || btn(2), sprint: btn(5) || btn(7) || btn(4) || btn(6) };
    };
    const t = touch.current;
    const [tx, ty] = toCourt(t.mx, t.my);
    const fromTouch: Input = { mx: tx, my: ty, a: t.a || t.tapA, b: t.b || t.tapB, sprint: Math.hypot(t.mx, t.my) > 0.85 };
    t.tapA = t.tapB = false;
    tap.clear();
    if (couch) return [merge(merge(fromKeys(P1_KEYS), fromPad(pads[0])), fromTouch), merge(fromKeys(P2_KEYS), fromPad(pads[1]))];
    let inp = merge(fromKeys(SOLO_KEYS), fromTouch);
    for (const p of pads) inp = merge(inp, fromPad(p));
    return [inp];
  }, []);

  // ---- online

  const syncNet = useCallback(() => {
    const r = roomRef.current;
    if (!r) return;
    setNet((n) => ({
      code: r.code,
      host: r.isHost,
      status: n?.status ?? "connecting",
      members: [...r.members],
      me: r.id,
      hostName: r.members.find((m) => m.id === r.hostId)?.name ?? "the host",
      clubs: r.clubs,
    }));
  }, []);

  const openRoom = useCallback(
    async (code: string, host: boolean) => {
      roomRef.current?.leave();
      roomRef.current = null;
      setMode("online");
      setNet({ code, host, status: "connecting", members: [], me: "", hostName: "", clubs: [prefsRef.current.club, prefsRef.current.rival] });
      setScreen("lobby");
      const tx = await openTransport(netMode(), code);
      if (!tx) {
        setNet((n) => (n ? { ...n, status: "failed" } : n));
        return;
      }
      const room = new HoopsRoom({ transport: tx, code, host, name: name.trim() || "Player" });
      roomRef.current = room;
      if (host) room.setClubs([prefsRef.current.club, prefsRef.current.rival]);
      room.onChange = syncNet;
      room.onStart = (m) => {
        netRef.current = { inbox: [], ended: 0 };
        begin(matchGame(m));
      };
      room.onState = (msg) => netRef.current.inbox.push(msg);
      setNet((n) => (n ? { ...n, status: "ready" } : n));
      syncNet();
    },
    [begin, name, setMode, setScreen, syncNet],
  );

  // The open-rooms board, while a menu is up.
  useEffect(() => {
    if (screen !== "title" && screen !== "lobby") return;
    let alive = true;
    let board: RoomBoard | null = null;
    void openTransport(netMode(), BOARD).then((tx) => {
      if (!tx || !alive) return tx?.close();
      board = new RoomBoard(tx);
      boardRef.current = board;
      board.onChange = () => setOpenRooms(board!.list(roomRef.current?.code));
    });
    const iv = window.setInterval(() => {
      const r = roomRef.current;
      if (board && r && r.isHost) board.advertise(r.code, r.name, r.members.length, r.live);
      if (board) setOpenRooms(board.list(r?.code));
    }, 2000);
    return () => {
      alive = false;
      window.clearInterval(iv);
      const r = roomRef.current;
      if (board && r?.isHost && screenRef.current !== "playing") board.withdraw(r.code);
      board?.close();
      boardRef.current = null;
    };
  }, [screen]);

  // Arriving with ?room=CODE joins it.
  useEffect(() => {
    const code = urlParam("room");
    if (code) void openRoom(cleanCode(code), false);
    return () => roomRef.current?.leave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- the loop

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let hudT = 0;
    let shoutSeen = "";
    let shoutKey = 0;
    let chantT = 0;
    const frame = (now: number) => {
      // The first rAF stamp can be earlier than the performance.now() above,
      // and a negative step blows the code-built characters' eyes up to 30 m.
      const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
      last = now;
      const g = gameRef.current;
      const view = viewRef.current;
      const scr = screenRef.current;
      const room = roomRef.current;
      const online = !!room && !!room.match && (scr === "playing" || scr === "over");
      let evs: GameEvent[] = [];
      const ready = !view || view.ready || now > readyAt.current;

      if (scr === "title" || scr === "setup" || scr === "lobby") {
        // The attract mode: the computer plays itself behind the menus.
        if (g.phase === "over") {
          const p = prefsRef.current;
          gameRef.current = newGame({ seed: (Math.random() * 1e9) | 0, clubs: [p.club, p.rival], skipIntro: true });
          if (view) void view.load(gameRef.current, meRef.current);
        } else {
          step(gameRef.current, dt);
          evs = drain(gameRef.current);
        }
      } else if (online && room.isHost) {
        const mine = room.myCtrl;
        if (scr === "playing" && mine >= 0) {
          setAuto(g, mine, autoRef.current);
          setInput(g, mine, gather(g)[0]);
        }
        room.match!.roster.forEach((id, n) => {
          if (n === mine) return;
          const ri = room.remoteInput(id);
          setAuto(g, n, !ri);
          if (ri) setInput(g, n, ri);
        });
        if (ready) {
          step(g, dt / 2);
          step(g, dt / 2);
        }
        evs = drain(g);
        room.sendState(g, evs);
      } else if (online) {
        const mine = room.myCtrl;
        const live = scr === "playing" ? gather(g)[0] : null;
        if (live && mine >= 0) room.sendInput(live);
        const nr = netRef.current;
        const inbox = nr.inbox.splice(0);
        evs = inbox.flatMap((m) => m.e);
        const latest = inbox[inbox.length - 1];
        if (live && mine >= 0) setInput(g, mine, { mx: live.mx, my: live.my, sprint: live.sprint });
        if (latest) applySnap(g, latest.s);
        else {
          step(g, dt / 2);
          step(g, dt / 2);
        }
        drain(g);
        if (g.phase === "over" && nr.ended !== room.match!.k && !evs.some((e) => e.type === "final")) {
          evs = [...evs, { type: "final", winner: g.score[0] > g.score[1] ? 0 : 1 }];
        }
      } else if (scr === "playing" && ready) {
        const ins = gather(g);
        g.ctrls.forEach((_, n) => {
          setAuto(g, n, autoRef.current);
          setInput(g, n, ins[n] ?? ins[0]);
        });
        // Slow motion for a dunk, when nobody else is waiting on us.
        const slow = g.slowmo > 0 ? 0.38 : 1;
        step(g, (dt * slow) / 2);
        step(g, (dt * slow) / 2);
        evs = drain(g);
      } else if (scr === "over") {
        step(g, dt);
        evs = drain(g);
      }

      const audio = audioRef.current;
      const playing = scr === "playing" || scr === "over";
      if (playing) for (const e of evs) audio.play(e);
      if (view) {
        view.events(g, evs);
        view.frame(g, dt, playing ? "game" : "attract");
      }

      // "De-fense!": the home crowd, while the other lot have it.
      chantT -= dt;
      if (playing && chantT <= 0 && g.phase === "play" && g.ctrls.length && offence(g) !== null && offence(g) !== g.players[g.ctrls[0].player].team) {
        chantT = 1.2;
        audio.chant();
      }

      // Full time.
      const fin = evs.find((e) => e.type === "final");
      if (fin && fin.type === "final" && scr === "playing") {
        overAt.current = now + 3800;
        const mineTeams = g.ctrls.map((c) => g.players[c.player].team);
        const best = mvp(g);
        setResult({ score: [g.score[0], g.score[1]], winner: fin.winner, stats: g.stats, mvp: { name: best.who.id === "me" ? meRef.current.label : best.who.name, pts: best.pts, team: best.team }, mine: mineTeams });
        if (room) netRef.current.ended = room.match?.k ?? 0;
        if (modeRef.current === "cpu") {
          const won = mineTeams[0] === fin.winner;
          setRecord((r) => {
            const nr = { w: r.w + (won ? 1 : 0), l: r.l + (won ? 0 : 1) };
            write(RECORD_KEY, nr);
            return nr;
          });
        }
      }
      if (overAt.current && now > overAt.current && screenRef.current === "playing") {
        overAt.current = 0;
        if (room?.isHost) room.endMatch();
        setScreen("over");
      }

      // The shot meter over your player.
      const meter = meterRef.current;
      if (meter && view) {
        const c = g.ctrls[room?.myCtrl ?? 0] ?? g.ctrls[0];
        const p = c ? g.players[c.player] : null;
        if (p && p.act === "shoot" && g.ball.owner === p.i && playing) {
          const s = view.project(p.i);
          meter.style.display = "block";
          meter.style.transform = `translate(${s.x - 9}px, ${s.y - 70}px)`;
          if (meterFill.current) meterFill.current.style.height = `${Math.min(100, (p.charge / 1.12) * 100)}%`;
        } else meter.style.display = "none";
      }

      hudT -= dt;
      if (hudT <= 0 && playing) {
        hudT = 0.1;
        const c = g.ctrls[room?.myCtrl ?? 0] ?? g.ctrls[0];
        const p = c ? g.players[c.player] : null;
        const off = offence(g);
        const ctx: Hud["ctx"] = p && g.ball.owner === p.i ? "has" : p && off === p.team ? "off" : "def";
        if (view && view.shout.text && view.shout.text + view.shout.sub !== shoutSeen) {
          shoutSeen = view.shout.text + view.shout.sub;
          shoutKey++;
        }
        if (view && !view.shout.text) shoutSeen = "";
        setHud({
          score: [g.score[0], g.score[1]],
          clock: clockLabel(g),
          shot: g.shotClock,
          shout: view?.shout.text ?? "",
          sub: view?.shout.sub ?? "",
          shoutKey,
          ctx,
          cine: !!view && (view.replaying || g.slowmo > 0),
          phase: g.phase,
          sudden: g.sudden,
        });
        void distToHoop;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [gather, setScreen]);

  // ---- keys, pause, leaving

  const togglePause = useCallback(() => {
    if (roomRef.current) return;
    const s = screenRef.current;
    if (s === "playing") setScreen("paused");
    else if (s === "paused") setScreen("playing");
  }, [setScreen]);

  useEffect(() => {
    const gameKeys = new Set(["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
    const down = (e: KeyboardEvent) => {
      if (screenRef.current === "playing" && gameKeys.has(e.code)) e.preventDefault();
      keys.current.add(e.code);
      tapped.current.add(e.code);
      audioRef.current.unlock();
      if (e.code === "Escape" || e.code === "KeyP") togglePause();
      else if (e.code === "KeyM") setMuted((m) => !m);
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
  }, [togglePause]);

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

  // ---- the test hook, and card art

  useEffect(() => {
    const hook = {
      state: () => {
        const g = gameRef.current;
        return {
          screen: screenRef.current,
          phase: g.phase,
          score: g.score,
          clock: g.clock,
          ready: viewRef.current?.ready ?? false,
          ball: { ...g.ball, shot: g.ball.shot ? { ...g.ball.shot } : null },
          players: g.players.map((p) => ({ i: p.i, team: p.team, name: p.who.name, x: p.x, y: p.y, z: p.z, act: p.act, ctrl: p.ctrl })),
          ctrls: g.ctrls.map((c) => c.player),
          stats: g.stats,
        };
      },
      start: (o: { mode?: Mode; club?: string; rival?: string; pick?: string; pick2?: string; difficulty?: Difficulty } = {}) => {
        setPrefs({ ...(o.club ? { club: o.club } : {}), ...(o.rival ? { rival: o.rival } : {}), ...(o.pick ? { pick: o.pick } : {}), ...(o.pick2 ? { pick2: o.pick2 } : {}), ...(o.difficulty ? { difficulty: o.difficulty } : {}) });
        setMode(o.mode ?? "cpu");
        start();
      },
      settle: (s: number) => {
        const g = gameRef.current;
        const all: GameEvent[] = [];
        for (let t = 0; t < s; t += 1 / 60) {
          step(g, 1 / 60);
          const e = drain(g);
          viewRef.current?.events(g, e);
          all.push(...e);
          if (g.phase === "over") break;
        }
        return all.map((e) => e.type);
      },
      /** Step until an event of this type happens (or `max` seconds), then `after` more seconds. */
      until: (type: string, max = 120, after = 0) => {
        const g = gameRef.current;
        let hit = false;
        for (let t = 0; t < max; t += 1 / 60) {
          step(g, 1 / 60);
          const e = drain(g);
          viewRef.current?.events(g, e);
          viewRef.current?.frame(g, 1 / 60, "game", false);
          if (e.some((x) => x.type === type)) {
            hit = true;
            break;
          }
        }
        for (let t = 0; t < after; t += 1 / 60) {
          step(g, 1 / 60);
          const e = drain(g);
          viewRef.current?.events(g, e);
          viewRef.current?.frame(g, 1 / 60, "game", false);
        }
        return hit;
      },
      auto: (on: boolean) => {
        autoRef.current = on;
      },
      input: (ctrl: number, inp: Partial<Input>) => setInput(gameRef.current, ctrl, inp),
      frame: (dt = 1 / 30, cinema: "game" | "attract" = "game") => viewRef.current?.frame(gameRef.current, dt, cinema),
      snapshot: () => viewRef.current?.snapshot() ?? "",
      screen: (s: Screen) => setScreen(s),
      /** The renderer itself, for poking at the scene from a script. */
      view: () => viewRef.current,
    };
    (window as unknown as { __hoops?: typeof hook }).__hoops = hook;
    return () => {
      delete (window as unknown as { __hoops?: unknown }).__hoops;
    };
  }, [setMode, setPrefs, setScreen, start]);

  // ---- render

  const g = gameRef.current;
  const [c0, c1] = g.clubs;
  const cine = hud.cine;
  const showUi = !isShot();

  return (
    <div ref={wrapRef} className="fixed inset-0 select-none overflow-hidden bg-[#05040a] text-white" style={{ touchAction: "none" }}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" data-testid="hoops-canvas" />

      {/* Letterbox for the cinematic moments. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 bg-black transition-all duration-500" style={{ height: cine && screen === "playing" ? "9vh" : 0 }} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black transition-all duration-500" style={{ height: cine && screen === "playing" ? "9vh" : 0 }} />

      {showUi && (screen === "playing" || screen === "paused") && (
        <>
          <ScoreBug c0={c0} c1={c1} hud={hud} />
          {hud.shout && (
            <div key={hud.shoutKey} className="pointer-events-none absolute inset-x-0 top-[26%] text-center" style={{ animation: "hoopsShout 2.6s ease-out forwards" }}>
              <div className="text-5xl font-black italic tracking-tight drop-shadow-[0_6px_0_rgba(0,0,0,0.6)] sm:text-7xl" style={{ color: "#fde68a", WebkitTextStroke: "2px #7c2d12" }}>
                {hud.shout}
              </div>
              {hud.sub && <div className="mt-1 text-sm font-black tracking-[0.2em] text-white drop-shadow sm:text-lg">{hud.sub}</div>}
            </div>
          )}
          {loading && hud.phase === "intro" && <div className="pointer-events-none absolute inset-x-0 bottom-24 text-center text-xs font-bold tracking-[0.3em] text-white/60">THE TEAMS ARE WALKING OUT…</div>}
          {cine && <div className="pointer-events-none absolute left-4 top-[calc(9vh+8px)] rounded bg-rose-500 px-2 py-0.5 text-xs font-black tracking-widest">{viewRef.current?.replaying ? "REPLAY" : "SLOW-MO"}</div>}
          <div ref={meterRef} className="pointer-events-none absolute left-0 top-0 hidden h-16 w-[18px] overflow-hidden rounded-full border-2 border-white/80 bg-black/60">
            <div className="absolute inset-x-0 bg-emerald-400/50" style={{ bottom: `${(0.79 / 1.12) * 100}%`, height: `${(0.13 / 1.12) * 100}%` }} />
            <div ref={meterFill} className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-amber-400 to-orange-500" />
          </div>
          <div className="absolute right-3 top-[max(env(safe-area-inset-top),10px)] flex gap-2">
            <button type="button" onClick={() => setMuted((m) => !m)} className="rounded-full bg-black/50 p-2" aria-label="Sound">
              {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
            {!roomRef.current && (
              <button type="button" onClick={togglePause} className="rounded-full bg-black/50 p-2" aria-label="Pause" data-testid="hoops-pause">
                {screen === "paused" ? <Play size={16} /> : <Pause size={16} />}
              </button>
            )}
          </div>
          {touchUi && screen === "playing" && <TouchPad touch={touch} ctx={hud.ctx} />}
          {!touchUi && screen === "playing" && hud.phase === "intro" && (
            <div className="pointer-events-none absolute inset-x-0 bottom-6 text-center text-xs font-bold text-white/70">
              {g.ctrls.length > 1 ? "P1: WASD move · F pass · G shoot · Shift turbo    P2: arrows · K pass · L shoot · O turbo" : "Move WASD or arrows · J pass (hold to lob) · K or Space shoot (let go at the top) · Shift turbo · Gamepads work too"}
            </div>
          )}
        </>
      )}

      {showUi && screen === "paused" && (
        <Panel>
          <div className="text-3xl font-black">Timeout</div>
          <button type="button" onClick={togglePause} className="mt-5 w-full rounded-2xl bg-amber-400 py-3 text-lg font-black text-black">
            Back on the floor
          </button>
          <button type="button" onClick={toTitle} className="mt-2 w-full rounded-2xl bg-white/10 py-2.5 font-bold">
            Quit to the menu
          </button>
        </Panel>
      )}

      {showUi && screen === "title" && (
        <Title
          record={record}
          openRooms={openRooms}
          touchUi={touchUi}
          onMode={(m) => {
            setMode(m);
            audioRef.current.unlock();
            setScreen("setup");
          }}
          onHost={() => void openRoom(roomCode(), true)}
          onJoin={(code) => void openRoom(cleanCode(code), false)}
        />
      )}

      {showUi && screen === "setup" && (
        <Setup mode={mode} prefs={prefs} setPrefs={setPrefs} setMode={setMode} meLabel={character.label} onStart={start} onBack={() => setScreen("title")} touchUi={touchUi} />
      )}

      {showUi && screen === "lobby" && net && (
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
          onSide={(s) => roomRef.current?.setSide(roomRef.current.id, s)}
          onTip={() => {
            const r = roomRef.current;
            if (!r?.isHost) return;
            // The host referees, so it builds the same game every guest is about to.
            netRef.current = { inbox: [], ended: 0 };
            begin(matchGame(r.startMatch((Math.random() * 1e9) | 0)));
          }}
          onLeave={toTitle}
          onRetry={() => void openRoom(net.code, net.host)}
        />
      )}

      {showUi && screen === "over" && result && (
        <Panel wide>
          <div className="text-[10px] font-black tracking-[0.35em] text-white/60">FINAL · THE VIBE DOME</div>
          <div className="mt-3 flex items-center justify-center gap-4">
            <TeamScore club={c0} score={result.score[0]} win={result.winner === 0} />
            <div className="text-xl font-black text-white/40">–</div>
            <TeamScore club={c1} score={result.score[1]} win={result.winner === 1} />
          </div>
          <div className="mt-3 text-lg font-black">
            {result.mine.length === 0 ? `${g.clubs[result.winner].name} win` : result.mine.includes(result.winner) && !(result.mine.includes(0) && result.mine.includes(1)) ? "You win! 🏆" : result.mine.includes(0) && result.mine.includes(1) ? `${g.clubs[result.winner].short} take it` : "So close."}
          </div>
          <div className="mt-2 rounded-2xl bg-white/5 px-3 py-2 text-sm">
            <span className="font-black text-amber-300">MVP</span> {result.mvp.name}, {result.mvp.pts} points
          </div>
          <table className="mt-3 w-full text-sm">
            <tbody>
              {(
                [
                  ["Field goals", (k: 0 | 1) => `${result.stats.fg[k]}/${result.stats.fga[k]}`],
                  ["Threes", (k: 0 | 1) => String(result.stats.threes[k])],
                  ["Dunks", (k: 0 | 1) => String(result.stats.dunks[k])],
                  ["Steals", (k: 0 | 1) => String(result.stats.steals[k])],
                  ["Blocks", (k: 0 | 1) => String(result.stats.blocks[k])],
                ] as const
              ).map(([label, f]) => (
                <tr key={label} className="border-t border-white/5">
                  <td className="py-1 text-left font-bold">{f(0)}</td>
                  <td className="py-1 text-center text-xs text-white/55">{label}</td>
                  <td className="py-1 text-right font-bold">{f(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!roomRef.current ? (
            <>
              <button type="button" onClick={start} className="mt-4 w-full rounded-2xl bg-amber-400 py-3 text-lg font-black text-black" data-testid="hoops-again">
                Run it back
              </button>
              <button type="button" onClick={() => setScreen("setup")} className="mt-2 w-full rounded-2xl bg-white/10 py-2.5 font-bold">
                Change teams
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setScreen("lobby")} className="mt-4 w-full rounded-2xl bg-amber-400 py-3 text-lg font-black text-black">
              Back to the room
            </button>
          )}
          <button type="button" onClick={toTitle} className="mt-2 w-full rounded-2xl bg-white/5 py-2 text-sm font-bold text-white/70">
            Menu
          </button>
        </Panel>
      )}

      {showUi && (screen === "title" || screen === "over" || screen === "paused" || screen === "setup") && (
        <Link to="/" className="absolute left-3 top-[max(env(safe-area-inset-top),10px)] rounded-full bg-black/55 px-3 py-1.5 text-xs font-bold text-white/85 backdrop-blur">
          ← Vibe Verse
        </Link>
      )}

      <style>{`
        @keyframes hoopsShout {
          0% { transform: scale(0.4); opacity: 0; }
          12% { transform: scale(1.12); opacity: 1; }
          22% { transform: scale(1); }
          80% { opacity: 1; }
          100% { transform: scale(1.04); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------- pieces

function Panel({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto bg-black/45 p-3">
      <div className={`my-auto w-full ${wide ? "max-w-md" : "max-w-sm"} rounded-3xl border border-white/10 bg-[#0d0a1c]/92 p-5 text-center shadow-2xl backdrop-blur`}>{children}</div>
    </div>
  );
}

function TeamScore({ club, score, win }: { club: Club; score: number; win: boolean }) {
  return (
    <div className={`rounded-2xl px-4 py-2 ${win ? "ring-2 ring-amber-300" : "opacity-80"}`} style={{ background: club.color, color: club.ink }}>
      <div className="text-xs font-black">
        {club.emoji} {club.short}
      </div>
      <div className="text-4xl font-black tabular-nums">{score}</div>
    </div>
  );
}

function ScoreBug({ c0, c1, hud }: { c0: Club; c1: Club; hud: Hud }) {
  const shotLow = hud.shot <= 5 && hud.phase === "play";
  return (
    <div className="pointer-events-none absolute left-1/2 top-[max(env(safe-area-inset-top),10px)] flex -translate-x-1/2 items-stretch overflow-hidden rounded-xl border border-white/15 bg-black/75 text-sm shadow-xl backdrop-blur" data-testid="hoops-score">
      <div className="flex items-center gap-1.5 px-2.5 py-1 font-black" style={{ background: c0.color, color: c0.ink }}>
        <span>{c0.emoji}</span>
        <span className="hidden sm:inline">{c0.short}</span>
        <span className="ml-1 text-lg tabular-nums">{hud.score[0]}</span>
      </div>
      <div className="flex min-w-[78px] flex-col items-center justify-center px-2 leading-none">
        <div className={`font-mono text-base font-black tabular-nums ${hud.sudden ? "text-amber-300" : ""}`}>{hud.clock}</div>
        <div className={`mt-0.5 font-mono text-[10px] font-bold ${shotLow ? "text-rose-400" : "text-white/50"}`}>{Math.max(0, Math.ceil(hud.shot))}</div>
      </div>
      <div className="flex items-center gap-1.5 px-2.5 py-1 font-black" style={{ background: c1.color, color: c1.ink }}>
        <span className="mr-1 text-lg tabular-nums">{hud.score[1]}</span>
        <span className="hidden sm:inline">{c1.short}</span>
        <span>{c1.emoji}</span>
      </div>
    </div>
  );
}

function Title({
  record,
  openRooms,
  touchUi,
  onMode,
  onHost,
  onJoin,
}: {
  record: { w: number; l: number };
  openRooms: OpenRoom[];
  touchUi: boolean;
  onMode: (m: Mode) => void;
  onHost: () => void;
  onJoin: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const [online, setOnline] = useState(false);
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-end overflow-y-auto bg-gradient-to-t from-black/85 via-black/30 to-transparent p-4 pb-[max(env(safe-area-inset-bottom),20px)]" data-testid="hoops-title">
      <div className="text-center">
        <div className="text-[10px] font-black tracking-[0.45em] text-amber-300/90">LIVE FROM THE VIBE DOME</div>
        <h1 className="mt-1 text-6xl font-black italic leading-none tracking-tight sm:text-8xl" style={{ background: "linear-gradient(180deg,#fff7ae,#f59e0b 60%,#ea580c)", WebkitBackgroundClip: "text", color: "transparent", filter: "drop-shadow(0 6px 0 rgba(0,0,0,0.55))" }}>
          VIBE HOOPS
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-white/75">Three on three with the whole Vibe Verse on the floor. Dunk on Mad Mort. Block Vibey. Hit the buzzer beater.</p>
        {record.w + record.l > 0 && <div className="mt-1 text-xs font-bold text-white/50">Your record: {record.w} W, {record.l} L</div>}
      </div>
      <div className="mt-5 w-full max-w-sm space-y-2">
        {!online ? (
          <>
            <button type="button" onClick={() => onMode("cpu")} className="w-full rounded-2xl bg-amber-400 py-3.5 text-lg font-black text-black shadow-lg active:scale-[0.98]" data-testid="hoops-cpu">
              🏀 Play the computer
            </button>
            {!touchUi && (
              <button type="button" onClick={() => onMode("versus")} className="w-full rounded-2xl bg-white/15 py-3 font-black" data-testid="hoops-couch">
                👥 Two players, one screen
              </button>
            )}
            <button type="button" onClick={() => setOnline(true)} className="w-full rounded-2xl bg-white/15 py-3 font-black" data-testid="hoops-online">
              🌐 Online with friends
            </button>
          </>
        ) : (
          <div className="rounded-3xl border border-white/10 bg-black/60 p-3 backdrop-blur">
            <button type="button" onClick={onHost} className="w-full rounded-2xl bg-amber-400 py-3 font-black text-black" data-testid="hoops-host">
              Make a room
            </button>
            <div className="mt-2 flex gap-2">
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Room code" className="min-w-0 flex-1 rounded-xl border border-white/15 bg-white/5 px-3 py-2 font-mono text-sm font-bold uppercase" />
              <button type="button" disabled={!code.trim()} onClick={() => onJoin(code)} className="rounded-xl bg-white/15 px-4 font-black disabled:opacity-40">
                Join
              </button>
            </div>
            {openRooms.length > 0 && (
              <div className="mt-3 space-y-1 text-left">
                <div className="text-[10px] font-black tracking-[0.25em] text-white/50">OPEN ROOMS</div>
                {openRooms.slice(0, 4).map((r) => (
                  <button key={r.code} type="button" onClick={() => onJoin(r.code)} className="flex w-full items-center justify-between rounded-xl bg-white/5 px-3 py-2 text-sm">
                    <span className="font-bold">{r.host}</span>
                    <span className="text-xs text-white/60">
                      {r.players}/{MAX_PER_SIDE * 2} {r.live ? "· playing" : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <button type="button" onClick={() => setOnline(false)} className="mt-2 w-full py-1 text-xs font-bold text-white/60">
              Back
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ClubRow({ value, other, onPick, label }: { value: string; other: string; onPick: (id: string) => void; label: string }) {
  return (
    <div>
      <div className="text-left text-[10px] font-black tracking-[0.25em] text-white/55">{label}</div>
      <div className="mt-1 flex gap-1.5 overflow-x-auto pb-1">
        {CLUBS.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={c.id === other}
            onClick={() => onPick(c.id)}
            className={`shrink-0 rounded-xl px-2.5 py-1.5 text-xs font-black disabled:opacity-25 ${c.id === value ? "ring-2 ring-white" : "opacity-75"}`}
            style={{ background: c.color, color: c.ink }}
          >
            {c.emoji} {c.short}
          </button>
        ))}
      </div>
    </div>
  );
}

function PickRow({ club, value, onPick, meLabel, label }: { club: Club; value: string; onPick: (id: string) => void; meLabel: string; label: string }) {
  const options = [...club.roster.map((p) => ({ id: p.id, name: p.name })), { id: "me", name: `You (${meLabel})` }];
  return (
    <div>
      <div className="text-left text-[10px] font-black tracking-[0.25em] text-white/55">{label}</div>
      <div className="mt-1 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => onPick(o.id)}
            className={`truncate rounded-xl px-2 py-2 text-xs font-bold ${o.id === value ? "bg-white text-black" : "bg-white/10"}`}
            data-testid={`hoops-pick-${o.id}`}
          >
            {o.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function Setup({
  mode,
  prefs,
  setPrefs,
  setMode,
  meLabel,
  onStart,
  onBack,
  touchUi,
}: {
  mode: Mode;
  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void;
  setMode: (m: Mode) => void;
  meLabel: string;
  onStart: () => void;
  onBack: () => void;
  touchUi: boolean;
}) {
  const club = clubById(prefs.club);
  const rival = clubById(prefs.rival);
  const pick = club.roster.some((p) => p.id === prefs.pick) || prefs.pick === "me" ? prefs.pick : club.roster[0].id;
  const p2Club = mode === "versus" ? rival : club;
  const pick2 = p2Club.roster.some((p) => p.id === prefs.pick2) || prefs.pick2 === "me" ? prefs.pick2 : p2Club.roster[mode === "coop" ? 1 : 0].id;
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto bg-black/55 p-3">
      <div className="my-auto w-full max-w-lg space-y-3 rounded-3xl border border-white/10 bg-[#0d0a1c]/95 p-4 shadow-2xl backdrop-blur" data-testid="hoops-setup">
        <div className="flex items-center justify-between">
          <div className="text-lg font-black">{mode === "cpu" ? "Against the computer" : "Two players"}</div>
          {mode !== "cpu" && !touchUi && (
            <div className="flex rounded-xl bg-white/10 p-0.5 text-xs font-black">
              {(["versus", "coop"] as const).map((m) => (
                <button key={m} type="button" onClick={() => setMode(m)} className={`rounded-lg px-2.5 py-1 ${mode === m ? "bg-white text-black" : ""}`}>
                  {m === "versus" ? "Versus" : "Same team"}
                </button>
              ))}
            </div>
          )}
        </div>
        <ClubRow label="YOUR CLUB" value={prefs.club} other={prefs.rival} onPick={(id) => setPrefs({ club: id })} />
        <PickRow label={mode === "cpu" ? "YOU PLAY AS" : "PLAYER 1 PLAYS AS"} club={club} value={pick} onPick={(id) => setPrefs({ pick: id })} meLabel={meLabel} />
        <ClubRow label={mode === "versus" ? "PLAYER 2'S CLUB" : "THE OTHER LOT"} value={prefs.rival} other={prefs.club} onPick={(id) => setPrefs({ rival: id })} />
        {mode !== "cpu" && <PickRow label="PLAYER 2 PLAYS AS" club={p2Club} value={pick2 === pick && mode === "coop" ? "" : pick2} onPick={(id) => setPrefs({ pick2: id })} meLabel={meLabel} />}
        {mode === "cpu" && (
          <div className="flex gap-1.5">
            {(["easy", "normal", "hard"] as Difficulty[]).map((d) => (
              <button key={d} type="button" onClick={() => setPrefs({ difficulty: d })} className={`flex-1 rounded-xl py-2 text-xs font-black capitalize ${prefs.difficulty === d ? "bg-white text-black" : "bg-white/10"}`}>
                {d === "easy" ? "Rookie" : d === "normal" ? "Pro" : "Legend"}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => {
            setPrefs({ pick, pick2 });
            onStart();
          }}
          className="w-full rounded-2xl bg-amber-400 py-3.5 text-lg font-black text-black shadow-lg active:scale-[0.98]"
          data-testid="hoops-tip"
        >
          Tip off
        </button>
        <button type="button" onClick={onBack} className="w-full py-1 text-xs font-bold text-white/60">
          Back
        </button>
      </div>
    </div>
  );
}

function Lobby({
  net,
  name,
  setName,
  prefs,
  setPrefs,
  onSide,
  onTip,
  onLeave,
  onRetry,
}: {
  net: NetUi;
  name: string;
  setName: (n: string) => void;
  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void;
  onSide: (s: TeamId) => void;
  onTip: () => void;
  onLeave: () => void;
  onRetry: () => void;
}) {
  const link = inviteLink(net.code);
  const [copied, setCopied] = useState(false);
  const share = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: "Vibe Hoops", text: "Come and play basketball with me in the Vibe Dome", url: link });
        return;
      }
    } catch {
      /* cancelled */
    }
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* no clipboard */
    }
  };
  const clubs = net.host ? ([prefs.club, prefs.rival] as [string, string]) : net.clubs;
  const mySide = net.members.find((m) => m.id === net.me)?.side;
  const enough = net.members.length >= 2;
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto bg-black/50 p-3">
      <div className="my-auto w-full max-w-md rounded-3xl border border-white/10 bg-[#0d0a1c]/95 p-5 text-center shadow-2xl backdrop-blur" data-testid="hoops-lobby">
        <div className="text-[10px] font-bold tracking-[0.3em] text-white/55">ONLINE ROOM</div>
        <div className="mt-1 font-mono text-3xl font-black tracking-wider text-amber-300" data-testid="hoops-code">
          {net.code}
        </div>
        {net.status === "connecting" && <p className="mt-4 text-sm text-white/70">Opening the room…</p>}
        {net.status === "failed" && (
          <div className="mt-4">
            <p className="text-sm text-rose-300">Could not reach the room. Check the connection and try again.</p>
            <button type="button" onClick={onRetry} className="mt-3 w-full rounded-2xl bg-amber-400 py-2.5 font-black text-black">
              Try again
            </button>
          </div>
        )}
        {net.status === "ready" && (
          <>
            <button type="button" onClick={share} className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-white/15 py-2.5 text-sm font-black" data-testid="hoops-share">
              {typeof navigator !== "undefined" && "share" in navigator ? <Share2 size={15} /> : <Copy size={15} />}
              {copied ? "Link copied" : "Invite friends"}
            </button>
            <div className="mt-3 flex items-center gap-3 text-left">
              <QrCode text={link} size={96} />
              <p className="text-xs leading-relaxed text-white/60">Scan with a phone to join, or send the link. Up to three a side, each person plays one player and the computer plays the rest.</p>
            </div>
            <label className="mt-4 block text-left text-[10px] font-bold tracking-[0.2em] text-white/55">
              YOUR NAME
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={16} className="mt-1 w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm font-bold tracking-normal text-white" />
            </label>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {([0, 1] as TeamId[]).map((side) => {
                const club = clubById(clubs[side]);
                const here = net.members.filter((m) => m.side === side);
                const full = here.length >= MAX_PER_SIDE;
                return (
                  <div key={side} className="rounded-2xl border border-white/10 p-2" style={{ background: `${club.color}22` }}>
                    <div className="truncate rounded-xl py-1.5 text-sm font-black" style={{ background: club.color, color: club.ink }}>
                      {club.emoji} {club.short}
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
                      <button type="button" onClick={() => onSide(side)} className="mt-1 w-full rounded-lg bg-white/10 py-1 text-xs font-bold">
                        Play for {club.short}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {net.host && (
              <div className="mt-4 space-y-3">
                <ClubRow label="LEFT" value={prefs.club} other={prefs.rival} onPick={(id) => setPrefs({ club: id })} />
                <ClubRow label="RIGHT" value={prefs.rival} other={prefs.club} onPick={(id) => setPrefs({ rival: id })} />
              </div>
            )}
            {net.host ? (
              <button type="button" onClick={onTip} disabled={!enough} className="mt-5 w-full rounded-2xl bg-amber-400 py-3 text-lg font-black text-black disabled:opacity-40" data-testid="hoops-online-tip">
                {enough ? "Tip off" : "Waiting for a friend to join…"}
              </button>
            ) : (
              <div className="mt-5 rounded-2xl bg-white/10 py-3 text-sm font-bold text-white/75">{net.members.length ? `Waiting for ${net.hostName} to tip off` : "Looking for the room…"}</div>
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

function TouchPad({ touch, ctx }: { touch: MutableRefObject<{ mx: number; my: number; a: boolean; b: boolean; tapA: boolean; tapB: boolean }>; ctx: Hud["ctx"] }) {
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
  const labels = ctx === "has" ? ["PASS", "SHOOT"] : ctx === "off" ? ["CALL", "JUMP"] : ["STEAL", "BLOCK"];
  return (
    <>
      <div className="absolute bottom-0 left-0 top-16 w-1/2" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} data-testid="hoops-stick">
        {stick ? (
          <>
            <div className="pointer-events-none absolute rounded-full border-2 border-white/30 bg-white/10" style={{ left: stick.ox - R, top: stick.oy - R, width: R * 2, height: R * 2 }} />
            <div className="pointer-events-none absolute h-14 w-14 rounded-full bg-white/60" style={{ left: stick.x - 28, top: stick.y - 28 }} />
          </>
        ) : (
          <div className="pointer-events-none absolute bottom-10 left-8 flex h-28 w-28 items-center justify-center rounded-full border-2 border-white/20 text-[10px] font-bold text-white/40">RUN · PUSH FOR TURBO</div>
        )}
      </div>
      <div className="absolute bottom-[max(env(safe-area-inset-bottom),18px)] right-4 flex items-end gap-3">
        {(
          [
            ["a", labels[0], "#38bdf8", 64],
            ["b", labels[1], "#fb923c", 82],
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
            data-testid={`hoops-${k}`}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );
}

