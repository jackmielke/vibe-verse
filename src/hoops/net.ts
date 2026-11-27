/**
 * VIBE HOOPS — playing online.
 *
 * The same shape as Vibe Cup's rooms (`src/vibecup/net.ts`), because it is
 * the same problem: one person makes a room and referees, their tab runs
 * `step()` exactly as it does offline and broadcasts the whole state twelve
 * times a second, and everybody else sends their stick and buttons and draws
 * what the referee says, stepping the rules locally in between so their own
 * player answers the thumb at once. Up to three a side, each on one player.
 *
 * `?room=CODE` joins, `?net=local` swaps Supabase for a BroadcastChannel so
 * two tabs of one browser can play, and `src/test/hoopsNet.test.ts` plays a
 * room over an in-memory wire.
 */
import { ACTS, newGame, type Game, type GameEvent, type Input, type Phase, type TeamId } from "./game";

// ---------------------------------------------------------------- transport

export interface Transport {
  send(msg: Wire): void;
  receive(fn: (msg: Wire) => void): void;
  close(): void;
}

export type NetMode = "online" | "local";

// ---------------------------------------------------------------- wire

/** A compact copy of everything in a `Game` that moves. */
export interface Snap {
  t: number;
  ph: Phase;
  pt: number;
  pl: number;
  cl: number;
  sc: number;
  sd: boolean;
  s: [number, number];
  seed: number;
  nx: Game["next"];
  ls: Game["lastScore"];
  st: Game["stats"];
  sm: number;
  bz: boolean;
  /** Players: x, y, z, vx, vy, vz, face, act, actT, ax, ay, sx, sy, charge, cool, noCatch, stamina, call, pts. */
  p: number[][];
  /** Ball: x, y, z, vx, vy, vz, state, owner, lastTeam, lastPlayer, target, lob, age. */
  b: number[];
  sh: Game["ball"]["shot"];
}

export interface Member {
  id: string;
  name: string;
  side: TeamId;
}

export type Wire =
  | { t: "hi"; i: string; n: string }
  | { t: "lobby"; i: string; m: [string, string, TeamId][]; c: [string, string]; k: number; seed: number; r: string[]; live: boolean }
  | { t: "side"; i: string; s: TeamId }
  | { t: "in"; i: string; k: number; x: number; y: number; f: number; pa: number; pb: number }
  | { t: "st"; i: string; k: number; s: Snap; e: GameEvent[]; ack: Record<string, number> }
  | { t: "bye"; i: string }
  | { t: "ad"; i: string; n: string; c: number; live: boolean }
  | { t: "gone"; i: string };

const isWire = (m: unknown): m is Wire => !!m && typeof m === "object" && typeof (m as { t?: unknown }).t === "string" && typeof (m as { i?: unknown }).i === "string";

// ---------------------------------------------------------------- snapshots

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const STATES = ["held", "pass", "shot", "loose"] as const;

export function snapshot(g: Game): Snap {
  const b = g.ball;
  return {
    t: r3(g.t),
    ph: g.phase,
    pt: r3(g.phaseT),
    pl: r3(g.phaseLen),
    cl: r3(g.clock),
    sc: r3(g.shotClock),
    sd: g.sudden,
    s: [g.score[0], g.score[1]],
    seed: g.seed,
    nx: g.next,
    ls: g.lastScore,
    st: g.stats,
    sm: r3(g.slowmo),
    bz: g.buzzerShot,
    p: g.players.map((p) =>
      [p.x, p.y, p.z, p.vx, p.vy, p.vz, p.face, ACTS.indexOf(p.act), p.actT, p.ax, p.ay, p.sx, p.sy, p.charge, p.cool, p.noCatch, p.stamina, p.call, p.pts].map(r3),
    ),
    b: [b.x, b.y, b.z, b.vx, b.vy, b.vz, STATES.indexOf(b.state), b.owner, b.lastTeam, b.lastPlayer, b.target, +b.lob, b.age].map(r3),
    sh: b.shot,
  };
}

export function applySnap(g: Game, s: Snap) {
  g.t = s.t;
  g.phase = s.ph;
  g.phaseT = s.pt;
  g.phaseLen = s.pl;
  g.clock = s.cl;
  g.shotClock = s.sc;
  g.sudden = s.sd;
  g.score = [s.s[0], s.s[1]];
  g.seed = s.seed;
  g.next = s.nx;
  g.lastScore = s.ls;
  g.stats = s.st;
  g.slowmo = s.sm;
  g.buzzerShot = s.bz;
  s.p.forEach((v, n) => {
    const p = g.players[n];
    if (!p) return;
    [p.x, p.y, p.z, p.vx, p.vy, p.vz, p.face] = v;
    p.act = ACTS[v[7]] ?? "none";
    [, , , , , , , , p.actT, p.ax, p.ay, p.sx, p.sy, p.charge, p.cool, p.noCatch, p.stamina, p.call, p.pts] = v;
  });
  const b = g.ball;
  const v = s.b;
  [b.x, b.y, b.z, b.vx, b.vy, b.vz] = v;
  b.state = STATES[v[6]] ?? "loose";
  b.owner = v[7];
  b.lastTeam = (v[8] as TeamId) ?? 0;
  b.lastPlayer = v[9];
  b.target = v[10];
  b.lob = !!v[11];
  b.age = v[12];
  b.shot = s.sh ? { ...s.sh } : null;
}

/** The game a match id describes: the same on every device. */
export function matchGame(setup: { seed: number; clubs: [string, string]; sides: TeamId[] }): Game {
  return newGame({ seed: setup.seed, clubs: setup.clubs, humans: setup.sides.map((team) => ({ team })), difficulty: "normal" });
}

// ---------------------------------------------------------------- room codes

const CODE_WORDS = ["DUNK", "SWISH", "HOOPS", "BUCKET", "SPLASH", "ALLEY", "BLOCK", "RIM", "JUMPER", "BANK"];
const CODE_ALPHABET = "2346789ABCDEFGHJKLMNPQRTUVWXYZ";

export function roomCode(rng: () => number = Math.random): string {
  const w = CODE_WORDS[Math.floor(rng() * CODE_WORDS.length) % CODE_WORDS.length];
  let tail = "";
  for (let i = 0; i < 3; i++) tail += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  return `${w}-${tail}`;
}

/** What somebody typed into "join with a code", tidied: "swish 4b2" → "SWISH-4B2". */
export function cleanCode(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
}

// ---------------------------------------------------------------- the room

export const MAX_PER_SIDE = 3;
const SEND_HZ = 12;
const HELLO_MS = 1200;
const LOBBY_MS = 1000;
const TIMEOUT_MS = 6000;

export interface MatchSetup {
  k: number;
  seed: number;
  clubs: [string, string];
  /** Peer id driving each controller, in controller order. */
  roster: string[];
  sides: TeamId[];
}

interface Remote {
  inp: Input;
  pa: number;
  pb: number;
  seenA: number;
  seenB: number;
  stamp: number;
  heard: number;
}

export interface RoomOpts {
  transport: Transport;
  code: string;
  host: boolean;
  name: string;
  id?: string;
  now?: () => number;
}

export class HoopsRoom {
  readonly id: string;
  readonly code: string;
  readonly isHost: boolean;
  name: string;
  members: Member[] = [];
  hostId = "";
  clubs: [string, string] = ["volts", "junkyard"];
  /** The match being played, or null in the lobby. */
  match: MatchSetup | null = null;
  /** True while a match (or its full-time screen) is on. */
  live = false;
  /** Round trip to the referee, ms, smoothed. Guests only. */
  rtt = 120;
  /** Ms since anything was heard from the referee. */
  lastHeard = 0;

  onChange?: () => void;
  onStart?: (m: MatchSetup) => void;
  onState?: (msg: Extract<Wire, { t: "st" }>) => void;

  private tx: Transport;
  private now: () => number;
  private remotes = new Map<string, Remote>();
  private nextHello = 0;
  private nextLobby = 0;
  private nextSend = 0;
  private pending: GameEvent[] = [];
  private seq = 0;
  private presses = { a: 0, b: 0 };
  private lastF = -1;
  private closed = false;

  constructor(o: RoomOpts) {
    this.tx = o.transport;
    this.code = o.code;
    this.isHost = o.host;
    this.name = o.name;
    this.now = o.now ?? (() => Date.now());
    this.id = o.id ?? Math.random().toString(36).slice(2, 10);
    this.lastHeard = this.now();
    if (this.isHost) {
      this.hostId = this.id;
      this.members = [{ id: this.id, name: this.name, side: 0 }];
    }
    this.tx.receive((m) => {
      if (isWire(m) && m.i !== this.id) this.handle(m);
    });
    this.tick();
  }

  get me(): Member | undefined {
    return this.members.find((m) => m.id === this.id);
  }

  /** Did the referee go quiet? */
  get hostLost(): boolean {
    return !this.isHost && this.now() - this.lastHeard > TIMEOUT_MS;
  }

  /** Controller index this device drives in the current match, or -1 to watch. */
  get myCtrl(): number {
    return this.match ? this.match.roster.indexOf(this.id) : -1;
  }

  rename(n: string) {
    this.name = n;
    if (this.isHost) {
      const me = this.me;
      if (me) me.name = n;
      this.broadcastLobby();
    } else this.tx.send({ t: "hi", i: this.id, n });
  }

  /** Heartbeats and timeouts. Call every frame; it does nothing most frames. */
  tick() {
    if (this.closed) return;
    const now = this.now();
    if (this.isHost) {
      let changed = false;
      for (const [id, r] of this.remotes) {
        if (now - r.heard > TIMEOUT_MS) {
          this.remotes.delete(id);
          this.members = this.members.filter((m) => m.id !== id);
          changed = true;
        }
      }
      if (changed) this.onChange?.();
      if (changed || now >= this.nextLobby) this.broadcastLobby();
    } else if (now >= this.nextHello && !this.live) {
      this.nextHello = now + HELLO_MS;
      this.tx.send({ t: "hi", i: this.id, n: this.name });
    }
  }

  // ---- host

  setClubs(c: [string, string]) {
    this.clubs = c;
    this.broadcastLobby();
  }

  setSide(id: string, side: TeamId) {
    if (!this.isHost) {
      if (id === this.id) this.tx.send({ t: "side", i: this.id, s: side });
      return;
    }
    const m = this.members.find((x) => x.id === id);
    if (!m || m.side === side) return;
    if (this.members.filter((x) => x.side === side).length >= MAX_PER_SIDE) return;
    m.side = side;
    this.broadcastLobby();
    this.onChange?.();
  }

  /** The referee kicks off a match with everybody in the room. */
  startMatch(seed: number): MatchSetup {
    const players = this.members.slice(0, MAX_PER_SIDE * 2);
    const setup: MatchSetup = {
      k: (this.match?.k ?? 0) + 1,
      seed,
      clubs: this.clubs,
      roster: players.map((m) => m.id),
      sides: players.map((m) => m.side),
    };
    this.match = setup;
    this.live = true;
    this.pending.length = 0;
    this.broadcastLobby();
    this.onChange?.();
    return setup;
  }

  /** Back to the lobby (k stays, so a late packet from the old match is ignored). */
  endMatch() {
    this.live = false;
    this.broadcastLobby();
    this.onChange?.();
  }

  /** A guest's latest controls, or null if they have gone quiet. Taps since the last call are held for this one frame. */
  remoteInput(id: string): Input | null {
    const r = this.remotes.get(id);
    if (!r || this.now() - r.heard > 2500) return null;
    const a = r.inp.a || r.pa > r.seenA;
    const b = r.inp.b || r.pb > r.seenB;
    r.seenA = r.pa;
    r.seenB = r.pb;
    return { ...r.inp, a, b };
  }

  /** Called by the referee every frame with that frame's events; sends at SEND_HZ. */
  sendState(g: Game, events: GameEvent[]) {
    if (!this.isHost || !this.match) return;
    for (const e of events) this.pending.push(e);
    const now = this.now();
    if (now < this.nextSend) return;
    this.nextSend = now + 1000 / SEND_HZ;
    const ack: Record<string, number> = {};
    for (const [id, r] of this.remotes) ack[id] = r.stamp;
    this.tx.send({ t: "st", i: this.id, k: this.match.k, s: snapshot(g), e: this.pending.splice(0), ack });
  }

  // ---- guest

  /** Send this device's controls: on any button change at once, otherwise at SEND_HZ. */
  sendInput(inp: Input) {
    if (this.isHost) return;
    if (inp.a && !this.prevA) this.presses.a++;
    if (inp.b && !this.prevB) this.presses.b++;
    this.prevA = inp.a;
    this.prevB = inp.b;
    const q = (v: number) => Math.round(v * 20) / 20;
    const f = (inp.a ? 1 : 0) | (inp.b ? 2 : 0) | (inp.sprint ? 4 : 0);
    const now = this.now();
    if (f === this.lastF && now < this.nextSend) return;
    this.nextSend = now + 1000 / SEND_HZ;
    this.lastF = f;
    this.tx.send({ t: "in", i: this.id, k: now, x: q(inp.mx), y: q(inp.my), f, pa: this.presses.a, pb: this.presses.b });
  }
  private prevA = false;
  private prevB = false;

  leave() {
    if (this.closed) return;
    this.tx.send({ t: "bye", i: this.id });
    this.closed = true;
    this.tx.close();
  }

  // ---- inbound

  private broadcastLobby() {
    if (!this.isHost || this.closed) return;
    this.nextLobby = this.now() + LOBBY_MS;
    this.tx.send({
      t: "lobby",
      i: this.id,
      m: this.members.map((m) => [m.id, m.name, m.side]),
      c: this.clubs,
      k: this.match?.k ?? 0,
      seed: this.match?.seed ?? 0,
      r: this.match?.roster ?? [],
      live: this.live,
    });
  }

  private remote(id: string): Remote {
    let r = this.remotes.get(id);
    if (!r) {
      r = { inp: { mx: 0, my: 0, a: false, b: false, sprint: false }, pa: 0, pb: 0, seenA: 0, seenB: 0, stamp: 0, heard: this.now() };
      this.remotes.set(id, r);
    }
    return r;
  }

  private handle(m: Wire) {
    const now = this.now();
    if (this.isHost) {
      if (m.t === "hi") {
        const r = this.remote(m.i);
        r.heard = now;
        const known = this.members.find((x) => x.id === m.i);
        const name = (m.n || "Player").slice(0, 16);
        if (!known) {
          const left = this.members.filter((x) => x.side === 0).length;
          const right = this.members.filter((x) => x.side === 1).length;
          this.members.push({ id: m.i, name, side: right < left ? 1 : 0 });
          this.broadcastLobby();
          this.onChange?.();
        } else if (known.name !== name) {
          known.name = name;
          this.broadcastLobby();
          this.onChange?.();
        }
      } else if (m.t === "side") {
        this.remote(m.i).heard = now;
        this.setSide(m.i, m.s);
      } else if (m.t === "in") {
        if (!this.members.some((x) => x.id === m.i)) return;
        const r = this.remote(m.i);
        r.heard = now;
        r.stamp = m.k;
        r.inp = { mx: m.x, my: m.y, a: !!(m.f & 1), b: !!(m.f & 2), sprint: !!(m.f & 4) };
        r.pa = Math.max(r.pa, m.pa);
        r.pb = Math.max(r.pb, m.pb);
      } else if (m.t === "bye") {
        this.remotes.delete(m.i);
        this.members = this.members.filter((x) => x.id !== m.i);
        this.broadcastLobby();
        this.onChange?.();
      }
      return;
    }
    // Guest.
    if (m.t === "lobby") {
      this.lastHeard = now;
      this.hostId = m.i;
      this.members = m.m.map(([id, name, side]) => ({ id, name, side }));
      this.clubs = m.c;
      const wasLive = this.live;
      this.live = m.live;
      if (m.k > 0 && m.live && (!this.match || this.match.k !== m.k)) {
        const sides = m.r.map((id) => this.members.find((x) => x.id === id)?.side ?? 0);
        this.match = { k: m.k, seed: m.seed, clubs: m.c, roster: m.r, sides };
        this.onStart?.(this.match);
      }
      if (wasLive !== this.live || !this.me) this.nextHello = 0;
      this.onChange?.();
    } else if (m.t === "st") {
      this.lastHeard = now;
      if (!this.match || m.k !== this.match.k) return;
      const stamp = m.ack[this.id];
      if (stamp) this.rtt += (Math.max(0, now - stamp) - this.rtt) * 0.2;
      this.onState?.(m);
    } else if (m.t === "bye" && m.i === this.hostId) {
      this.lastHeard = -Infinity;
      this.onChange?.();
    }
  }
}

// ---------------------------------------------------------------- the board

export interface OpenRoom {
  code: string;
  host: string;
  players: number;
  live: boolean;
  seen: number;
}

/** The channel every Vibe Hoops menu listens on. */
export const BOARD = "open-rooms";
const AD_TTL_MS = 7000;

/**
 * "Open rooms": every room maker shouts its code on one shared channel every
 * couple of seconds, and every menu lists what it heard lately. So joining a
 * friend is a tap, and the code is only needed when the list cannot help.
 */
export class RoomBoard {
  private rooms = new Map<string, OpenRoom>();
  onChange?: () => void;
  constructor(
    private tx: Transport,
    private now: () => number = () => Date.now(),
  ) {
    tx.receive((m) => {
      if (m.t === "ad") {
        this.rooms.set(m.i, { code: m.i, host: (m.n || "Player").slice(0, 16), players: Math.max(0, Math.min(MAX_PER_SIDE * 2, m.c | 0)), live: !!m.live, seen: this.now() });
        this.onChange?.();
      } else if (m.t === "gone") {
        if (this.rooms.delete(m.i)) this.onChange?.();
      }
    });
  }
  advertise(code: string, host: string, players: number, live: boolean) {
    this.tx.send({ t: "ad", i: code, n: host, c: players, live });
  }
  withdraw(code: string) {
    this.tx.send({ t: "gone", i: code });
  }
  /** Rooms heard from lately, ones with space first, then the newest. */
  list(except?: string): OpenRoom[] {
    const now = this.now();
    for (const [k, r] of this.rooms) if (now - r.seen > AD_TTL_MS) this.rooms.delete(k);
    return [...this.rooms.values()]
      .filter((r) => r.code !== except)
      .sort((a, z) => +(a.players >= MAX_PER_SIDE * 2) - +(z.players >= MAX_PER_SIDE * 2) || z.seen - a.seen);
  }
  close() {
    this.tx.close();
  }
}

// ---------------------------------------------------------------- transports

const CONNECT_TIMEOUT_MS = 8000;
const TOPIC = "m";

export async function openTransport(mode: NetMode, room: string): Promise<Transport | null> {
  try {
    return mode === "local" ? openLocal(room) : await openOnline(room);
  } catch {
    return null;
  }
}

function openLocal(room: string): Transport | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const ch = new BroadcastChannel(`vibehoops-${room}`);
  let handler: ((msg: Wire) => void) | null = null;
  ch.onmessage = (ev: MessageEvent) => {
    if (handler && isWire(ev.data)) handler(ev.data);
  };
  return {
    send: (msg) => {
      try {
        ch.postMessage(msg);
      } catch {
        /* closed */
      }
    },
    receive: (fn) => {
      handler = fn;
    },
    close: () => {
      handler = null;
      try {
        ch.close();
      } catch {
        /* closed */
      }
    },
  };
}

async function openOnline(room: string): Promise<Transport | null> {
  const { supabase } = await import("@/integrations/supabase/client");
  const channel = supabase.channel(`vibehoops-${room}`, { config: { broadcast: { self: false, ack: false } } });
  let handler: ((msg: Wire) => void) | null = null;
  channel.on("broadcast", { event: TOPIC }, ({ payload }: { payload: unknown }) => {
    if (handler && isWire(payload)) handler(payload);
  });
  const ok = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (v: boolean) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const timer = window.setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
    channel.subscribe((status: string) => {
      if (status === "SUBSCRIBED") {
        window.clearTimeout(timer);
        finish(true);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        window.clearTimeout(timer);
        finish(false);
      }
    });
  });
  if (!ok) {
    try {
      await supabase.removeChannel(channel);
    } catch {
      /* nothing */
    }
    return null;
  }
  return {
    send: (msg) => {
      void channel.send({ type: "broadcast", event: TOPIC, payload: msg });
    },
    receive: (fn) => {
      handler = fn;
    },
    close: () => {
      handler = null;
      try {
        void supabase.removeChannel(channel);
      } catch {
        /* already gone */
      }
    },
  };
}

/** An in-memory wire for tests: every room on it hears every other. */
export function memoryHub() {
  const ends = new Set<(m: Wire) => void>();
  const queue: Array<[(m: Wire) => void, Wire]> = [];
  return {
    open(): Transport {
      let fn: ((m: Wire) => void) | null = null;
      const me = (m: Wire) => fn?.(m);
      ends.add(me);
      return {
        send: (m) => {
          const copy = JSON.parse(JSON.stringify(m)) as Wire;
          for (const e of ends) if (e !== me) queue.push([e, copy]);
        },
        receive: (f) => {
          fn = f;
        },
        close: () => {
          ends.delete(me);
          fn = null;
        },
      };
    },
    /** Deliver everything sent so far. */
    flush() {
      while (queue.length) {
        const [e, m] = queue.shift()!;
        e(m);
      }
    },
  };
}
