/**
 * VIBE CUP — playing online.
 *
 * One person makes a room and is the referee: their tab runs the match with
 * `step()`, exactly as it does offline, and broadcasts the whole state twelve
 * times a second. Everybody else sends their stick and buttons and draws what
 * the referee says, stepping the same rules locally in between so their own
 * player answers the thumb at once rather than a round trip later.
 *
 * Why a host and not rollback like Vibe Kart: a soccer match is ten bodies and
 * a ball that all touch each other, and the computer half of every team reads
 * where the people are. Rolled-back inputs would replay the whole pitch. A
 * referee is simpler, it is what the BLOB bots do, and the cost (your kick
 * lands a round trip late) is small at this pace.
 *
 * Nothing here touches the DOM beyond the transports at the bottom, so
 * `src/test/vibeCupNet.test.ts` plays a whole room over an in-memory wire.
 */
import { newGame, type Game, type GameEvent, type Input, type Phase, type TeamId } from "./game";

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
  cl: number;
  gd: boolean;
  sc: [number, number];
  ko: TeamId;
  sd: number;
  sh: number;
  lg: Game["lastGoal"];
  st: Game["stats"];
  /** Players: x, y, vx, vy, face, stun, slide, cool, kick, stamina, hold. */
  p: number[][];
  /** Ball: x, y, z, vx, vy, vz, spin, owner, lastTeam, lastPlayer, fire, target. */
  b: number[];
  /** Controllers: active, mx, my, a, b, sprint, prevA, prevB, holdA, holdB, charge, aim (NaN = none), aimAge. */
  c: number[][];
}

export interface Member {
  id: string;
  name: string;
  side: TeamId;
}

export type Wire =
  /** A guest saying hello, and its heartbeat while not playing. */
  | { t: "hi"; i: string; n: string }
  /** The referee's room: who is in it, on which side, and the match being played (k = 0: none). */
  | { t: "lobby"; i: string; m: [string, string, TeamId][]; c: [string, string]; k: number; seed: number; r: string[]; live: boolean }
  /** A guest asking to change sides. */
  | { t: "side"; i: string; s: TeamId }
  /** A guest's controls. `pa`/`pb` count presses, so a tap between two packets is never lost. */
  | { t: "in"; i: string; k: number; x: number; y: number; f: number; pa: number; pb: number }
  /** The referee's match state, the events since the last one, and when each guest's last input arrived. */
  | { t: "st"; i: string; k: number; s: Snap; e: GameEvent[]; ack: Record<string, number> }
  | { t: "bye"; i: string };

const isWire = (m: unknown): m is Wire => !!m && typeof m === "object" && typeof (m as { t?: unknown }).t === "string" && typeof (m as { i?: unknown }).i === "string";

// ---------------------------------------------------------------- snapshots

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function snapshot(g: Game): Snap {
  return {
    t: r3(g.t),
    ph: g.phase,
    pt: r3(g.phaseT),
    cl: r3(g.clock),
    gd: g.golden,
    sc: [g.score[0], g.score[1]],
    ko: g.kickoffTeam,
    sd: g.seed,
    sh: r3(g.shake),
    lg: g.lastGoal,
    st: g.stats,
    p: g.players.map((p) => [p.x, p.y, p.vx, p.vy, p.face, p.stun, p.slide, p.cool, p.kick, p.stamina, p.hold].map(r3)),
    b: [g.ball.x, g.ball.y, g.ball.z, g.ball.vx, g.ball.vy, g.ball.vz, g.ball.spin, g.ball.owner, g.ball.lastTeam, g.ball.lastPlayer, g.ball.fire, g.ball.target].map(r3),
    c: g.ctrls.map((c) =>
      [c.active, c.input.mx, c.input.my, +c.input.a, +c.input.b, +c.input.sprint, +c.prevA, +c.prevB, c.holdA, c.holdB, c.charge, c.aim ?? NaN, c.aimAge].map((v) =>
        Number.isNaN(v) ? -99 : r3(v),
      ),
    ),
  };
}

export function applySnap(g: Game, s: Snap) {
  g.t = s.t;
  g.phase = s.ph;
  g.phaseT = s.pt;
  g.clock = s.cl;
  g.golden = s.gd;
  g.score = [s.sc[0], s.sc[1]];
  g.kickoffTeam = s.ko;
  g.seed = s.sd;
  g.shake = s.sh;
  g.lastGoal = s.lg;
  g.stats = s.st;
  s.p.forEach((v, n) => {
    const p = g.players[n];
    if (!p) return;
    [p.x, p.y, p.vx, p.vy, p.face, p.stun, p.slide, p.cool, p.kick, p.stamina, p.hold] = v;
  });
  const b = g.ball;
  let lt: number;
  [b.x, b.y, b.z, b.vx, b.vy, b.vz, b.spin, b.owner, lt, b.lastPlayer, b.fire, b.target] = s.b;
  b.lastTeam = lt === 1 ? 1 : 0;
  s.c.forEach((v, n) => {
    const c = g.ctrls[n];
    if (!c) return;
    c.active = v[0];
    c.input = { mx: v[1], my: v[2], a: !!v[3], b: !!v[4], sprint: !!v[5] };
    c.prevA = !!v[6];
    c.prevB = !!v[7];
    c.holdA = v[8];
    c.holdB = v[9];
    c.charge = v[10];
    c.aim = v[11] === -99 ? null : v[11];
    c.aimAge = v[12];
  });
}

/** The game a match id describes: the same on every device. */
export function matchGame(setup: { seed: number; clubs: [string, string]; sides: TeamId[] }): Game {
  return newGame({ seed: setup.seed, clubs: setup.clubs, humans: setup.sides, difficulty: "normal" });
}

// ---------------------------------------------------------------- room codes

const CODE_WORDS = ["GOAL", "VOLLEY", "CHIP", "NUTMEG", "HEADER", "CROSS", "CURL", "TOPBIN", "KICK", "DERBY"];
const CODE_ALPHABET = "2346789ABCDEFGHJKLMNPQRTUVWXYZ";

export function roomCode(rng: () => number = Math.random): string {
  const w = CODE_WORDS[Math.floor(rng() * CODE_WORDS.length) % CODE_WORDS.length];
  let tail = "";
  for (let i = 0; i < 3; i++) tail += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  return `${w}-${tail}`;
}

/** What somebody typed into "join with a code", tidied: "nutmeg 4b2" → "NUTMEG-4B2". */
export function cleanCode(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
}

// ---------------------------------------------------------------- the room

export const MAX_PER_SIDE = 2;
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

export class CupRoom {
  readonly id: string;
  readonly code: string;
  readonly isHost: boolean;
  name: string;
  members: Member[] = [];
  hostId = "";
  clubs: [string, string] = ["volts", "rovers"];
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
  const ch = new BroadcastChannel(`vibecup-${room}`);
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
  const channel = supabase.channel(`vibecup-${room}`, { config: { broadcast: { self: false, ack: false } } });
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
