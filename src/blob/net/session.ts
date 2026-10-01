/**
 * BLOB — multiplayer.
 *
 * The house pattern, which Vibe City has been running in production for months
 * and Vibe Kart and Soaked both copy: one channel per room, a throttled
 * broadcast, **sender authority**, and no server anywhere. What is new here is
 * that BLOB has a second thing to keep in step besides the people — the bots —
 * and the answer to that is the only real design decision in this file.
 *
 * ## Who owns what
 *
 * - **Your blob is yours.** You simulate it, you broadcast it, and nobody else
 *   ever moves it.
 * - **A bite belongs to the eater.** Both clients compute the same rule from
 *   slightly different positions, so if both applied it you would get two
 *   screens that disagree about who survived. Only the eater resolves a bite,
 *   and it tells the victim, who removes the cells it named. The worst case is
 *   that you die a fifth of a second after you thought you were clear, which is
 *   what every online game feels like and is at least *consistent*.
 * - **The bots belong to the host**, who is simply whoever has the lowest peer
 *   id in the room. Simulated independently they diverge within seconds — same
 *   seed, but a split lands on a different tick and everything after it differs
 *   — and then you watch a friend get eaten by a blob that, on your screen, is
 *   forty metres away. One client runs them and the rest read the wire. Because
 *   the host is *derived* rather than elected, it survives the host leaving: the
 *   next-lowest peer notices it is now first and starts simulating.
 * - **Pellets are nobody's.** They are the one thing allowed to drift. Each
 *   client eats its own, so two players may see slightly different crumbs on the
 *   table; nothing about that changes who is bigger, and syncing three thousand
 *   pellets to fix a cosmetic difference would cost more bandwidth than the rest
 *   of the protocol put together.
 *
 * ## Why the transport is an interface
 *
 * So this file can be tested. `blobNet.test.ts` wires two sessions together
 * through an in-process loopback and plays a match between them — slot claiming,
 * cell replication, a kill, a host handover — with no socket, no Supabase and no
 * network. The Supabase implementation lives next door in `supabase.ts` and is
 * loaded dynamically, so a build that never joins a room never pays for it.
 */
import type { BlobSim } from "../sim";
import { isBlocked, setSafetyPeers } from "@/safety/safety";

/** The name drawn for a peer: "Player" once blocked (App Store 1.2). Display only — the sim never reads it. */
const shown = (name: string, peerId: string): string => (isBlocked(name, peerId) ? "Player" : name);

// ---------------------------------------------------------------- transport

/** The shape of "somewhere to shout". Supabase is one; a loopback is another. */
export interface NetTransport {
  /** Broadcast to everybody else in the room. Never echoes back to the sender. */
  send(msg: Wire): void;
  /** Register the inbound handler. Called once, immediately after construction. */
  receive(fn: (msg: Wire) => void): void;
  close(): void;
}

// ---------------------------------------------------------------- wire

/** A cell on the wire: id, position, mass. Four numbers, no names, no colours. */
export type WireCell = [number, number, number, number];

export type Wire =
  /** Somebody's own blob, plus who they are. Doubles as the heartbeat. */
  | { t: "s"; i: string; n: string; h: number; c: WireCell[] }
  /** The host's bots: the same, but with the player id in front. */
  | { t: "b"; i: string; r: [number, ...WireCell][] }
  /** "I ate these cells of yours." `o` addresses the victim — see `addr`. */
  | { t: "k"; i: string; o: string; c: number[] }
  /** "A virus burst on me." Everybody drops it so the board agrees. */
  | { t: "x"; i: string; v: number }
  /** The host restocking viruses. */
  | { t: "v"; i: string; r: [number, number, number][] }
  /** Leaving cleanly, rather than making everybody wait out the timeout. */
  | { t: "q"; i: string };

/**
 * How a player is named on the wire.
 *
 * Bots are `b<playerId>`: every client builds its roster from the same seed, so
 * bot ids line up everywhere without being negotiated. People are `p<peerId>`,
 * because their local player ids are assigned in arrival order and will not.
 */
export const addrOfBot = (playerId: number): string => `b${playerId}`;
export const addrOfPeer = (peerId: string): string => `p${peerId}`;

// ---------------------------------------------------------------- tuning

/** State broadcasts per second. 12 is smooth once interpolated, and cheap. */
const SEND_HZ = 12;
/** Drop a peer that has said nothing for this long (ms). */
const PEER_TIMEOUT = 6000;
/** How long a killed cell stays on the "do not resurrect" list (ms). A packet
 *  already in flight when we ate something would otherwise put it back. */
const TOMBSTONE_MS = 1500;

// ---------------------------------------------------------------- codes

/** Room-code words. Read aloud over voice chat, so the alphabet below drops
 *  0/O/1/I/5/S — "BLOB-0B1" is a support ticket waiting to happen. */
const CODE_WORDS = [
  "BLOB",
  "DISH",
  "GLOOP",
  "SPLIT",
  "OOZE",
  "SLURP",
  "CHOMP",
  "BUBBLE",
  "PETRI",
  "NUCLEUS",
] as const;
const CODE_ALPHABET = "2346789ABCDEFGHJKLMNPQRTUVWXYZ";

/** A fresh shareable room code, e.g. "GLOOP-4B2". */
export function generateRoomCode(rng: () => number = Math.random): string {
  const word = CODE_WORDS[Math.floor(rng() * CODE_WORDS.length) % CODE_WORDS.length];
  let tail = "";
  for (let i = 0; i < 3; i++) {
    tail += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  }
  return `${word}-${tail}`;
}

/** Case, spaces and stray punctuation must not split a room in two — "gloop 4b2"
 *  and "GLOOP-4B2" are the same dish. */
export function normalizeRoomCode(raw: string): string {
  return (raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

/**
 * The seed a room shares.
 *
 * Derived from the code rather than negotiated, so everybody lays out the same
 * pellets and the same viruses before anybody has said a word. Two clients that
 * disagreed about where the viruses are would be two clients playing different
 * games.
 */
export function seedForRoom(code: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A stable id for this tab. Two tabs on one machine are two players. */
export function makePeerId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------- session

export interface NetPeer {
  peerId: string;
  name: string;
  hue: number;
  /** Which player id this peer drives in *our* sim. */
  playerId: number;
  lastSeen: number;
}

export interface BlobNetOptions {
  transport: NetTransport;
  room: string;
  peerId: string;
  /** Read fresh on every send, because the title screen can rename you. */
  identity: () => { name: string; hue: number };
  /** Wall clock, injectable so the tests do not have to sleep. */
  now?: () => number;
}

export class BlobNet {
  readonly room: string;
  readonly peerId: string;
  private readonly transport: NetTransport;
  private readonly identity: BlobNetOptions["identity"];
  private readonly now: () => number;

  private readonly peers = new Map<string, NetPeer>();
  private inbox: Wire[] = [];
  private lastSend = 0;
  /** Cells we have eaten, so a packet in flight cannot resurrect them. */
  private tombstones = new Map<number, number>();
  private closed = false;
  /** Roster changed since the Safety sheet last heard about it. */
  private safetyDirty = false;

  constructor(o: BlobNetOptions) {
    this.transport = o.transport;
    this.room = o.room;
    this.peerId = o.peerId;
    this.identity = o.identity;
    this.now = o.now ?? (() => Date.now());
    this.transport.receive((msg) => {
      // Queued rather than applied: a packet landing halfway through a tick
      // would write cell positions the collision pass has already read.
      if (!this.closed && msg && msg.i !== this.peerId) this.inbox.push(msg);
    });
  }

  /**
   * Whether we are the one running the bots.
   *
   * Lowest peer id in the room, counting ourselves. Derived, not elected: there
   * is no handover message to lose, and a room whose host closes their laptop
   * simply has a new host on the next frame.
   */
  get isHost(): boolean {
    for (const id of this.peers.keys()) if (id < this.peerId) return false;
    return true;
  }

  roster(): NetPeer[] {
    return [...this.peers.values()].sort((a, b) => a.peerId.localeCompare(b.peerId));
  }

  /** People in the room, including you. */
  get size(): number {
    return this.peers.size + 1;
  }

  /**
   * One frame of networking: apply what arrived, then say what happened.
   *
   * Called after the sim has stepped and before the engine drains events, so
   * the kills it reads are this frame's.
   */
  pump(sim: BlobSim, youId = 0): void {
    if (this.closed) return;
    const t = this.now();
    this.applyInbox(sim);
    this.reapPeers(sim, t);
    if (this.safetyDirty) {
      this.safetyDirty = false;
      setSafetyPeers("blob", this.roster().map((p) => ({ name: p.name, id: p.peerId })));
    }
    this.reportKills(sim, youId);
    if (t - this.lastSend >= 1000 / SEND_HZ) {
      this.lastSend = t;
      this.sendState(sim, youId);
      if (this.isHost) this.sendBots(sim);
    }
    for (const [id, at] of this.tombstones) {
      if (t - at > TOMBSTONE_MS) this.tombstones.delete(id);
    }
    // Being host is a running state, not an event: claim or release the bots
    // every frame so a host that arrives or leaves is handled by the same line.
    sim.setBotsRemote(!this.isHost);
    sim.virusesFromWire = !this.isHost;
  }

  /** A virus burst under one of our cells. Everybody has to drop it. */
  reportPop(virusId: number): void {
    if (this.closed) return;
    this.transport.send({ t: "x", i: this.peerId, v: virusId });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.transport.send({ t: "q", i: this.peerId });
    } catch {
      /* the socket may already be gone; leaving is best-effort */
    }
    this.transport.close();
    this.peers.clear();
  }

  // ------------------------------------------------------------- inbound

  private applyInbox(sim: BlobSim): void {
    if (!this.inbox.length) return;
    const batch = this.inbox;
    this.inbox = [];
    const t = this.now();
    for (const msg of batch) {
      switch (msg.t) {
        case "s": {
          const peer = this.seat(sim, msg.i, msg.n, msg.h);
          peer.lastSeen = t;
          if (peer.name !== msg.n) this.safetyDirty = true;
          peer.name = msg.n;
          // Re-checked every packet, so a block takes effect within a tick.
          sim.players[peer.playerId].name = shown(msg.n, msg.i);
          sim.writeCells(peer.playerId, this.live(msg.c));
          break;
        }
        case "b": {
          const peer = this.peers.get(msg.i);
          if (peer) peer.lastSeen = t;
          // Only the host's word counts, and only when it is not us. A stale
          // packet from a demoted host must not overwrite our own bots.
          if (this.isHost || !this.isLowest(msg.i)) break;
          this.writeBots(sim, msg.r);
          break;
        }
        case "k": {
          const target = this.resolve(sim, msg.o);
          if (target === null) break;
          // Only apply a kill against something we are not the authority for if
          // it is ours — a peer telling us a *third* party died is not its call.
          sim.killCells(target, msg.c);
          for (const id of msg.c) this.tombstones.set(id, t);
          break;
        }
        case "x":
          sim.removeVirus(msg.v);
          break;
        case "v":
          if (!this.isHost) for (const [id, x, y] of msg.r) sim.addVirusAt(id, x, y);
          break;
        case "q": {
          const peer = this.peers.get(msg.i);
          if (peer) {
            sim.dropPlayer(peer.playerId);
            this.peers.delete(msg.i);
            this.safetyDirty = true;
          }
          break;
        }
      }
    }
  }

  /** Is `id` the lowest peer id we know of, including ourselves? */
  private isLowest(id: string): boolean {
    if (id > this.peerId) return false;
    for (const other of this.peers.keys()) if (other < id) return false;
    return true;
  }

  /** Strip cells we have already eaten out of an inbound update. */
  private live(cells: WireCell[]): { id: number; x: number; y: number; mass: number }[] {
    const out: { id: number; x: number; y: number; mass: number }[] = [];
    for (const [id, x, y, mass] of cells) {
      if (this.tombstones.has(id)) continue;
      out.push({ id, x, y, mass });
    }
    return out;
  }

  /** Find or create the sim player a peer drives. */
  private seat(sim: BlobSim, peerId: string, name: string, hue: number): NetPeer {
    const had = this.peers.get(peerId);
    if (had) return had;
    const playerId = sim.addRemotePlayer(peerId, shown(name, peerId), hue);
    const peer: NetPeer = { peerId, name, hue, playerId, lastSeen: this.now() };
    this.peers.set(peerId, peer);
    this.safetyDirty = true;
    return peer;
  }

  /** Turn a wire address back into one of our player ids. */
  private resolve(sim: BlobSim, addr: string): number | null {
    if (addr.startsWith("p")) {
      const peerId = addr.slice(1);
      if (peerId === this.peerId) return 0;
      const peer = this.peers.get(peerId);
      return peer ? peer.playerId : null;
    }
    if (addr.startsWith("b")) {
      const id = Number(addr.slice(1));
      const p = sim.players[id];
      // Only act on a bot kill when the bots are ours to keep books on.
      return p && p.isBot && this.isHost ? id : null;
    }
    return null;
  }

  private writeBots(sim: BlobSim, rows: [number, ...WireCell][]): void {
    const byPlayer = new Map<number, { id: number; x: number; y: number; mass: number }[]>();
    for (const [playerId, id, x, y, mass] of rows) {
      if (this.tombstones.has(id)) continue;
      let list = byPlayer.get(playerId);
      if (!list) byPlayer.set(playerId, (list = []));
      list.push({ id, x, y, mass });
    }
    for (const p of sim.players) {
      if (!p.isBot) continue;
      sim.writeCells(p.id, byPlayer.get(p.id) ?? []);
    }
  }

  // ------------------------------------------------------------- outbound

  private sendState(sim: BlobSim, youId: number): void {
    const you = sim.players[youId];
    if (!you) return;
    const id = this.identity();
    this.transport.send({
      t: "s",
      i: this.peerId,
      n: id.name,
      h: id.hue,
      c: you.cells.map((c) => [c.id, Math.round(c.x), Math.round(c.y), Math.round(c.mass)]),
    });
  }

  private sendBots(sim: BlobSim): void {
    const rows: [number, ...WireCell][] = [];
    for (const p of sim.players) {
      if (!p.isBot) continue;
      for (const c of p.cells) {
        rows.push([p.id, c.id, Math.round(c.x), Math.round(c.y), Math.round(c.mass)]);
      }
    }
    this.transport.send({ t: "b", i: this.peerId, r: rows });
    const spawned = sim.takeSpawnedViruses();
    if (spawned.length) this.transport.send({ t: "v", i: this.peerId, r: spawned });
  }

  /**
   * Tell the victims about the bites we took this frame.
   *
   * Read out of the sim's own event list rather than tracked separately, so
   * there is exactly one place that decides a cell was eaten and the wire is
   * downstream of it.
   */
  private reportKills(sim: BlobSim, youId: number): void {
    const byTarget = new Map<string, number[]>();
    const t = this.now();
    for (const e of sim.events) {
      if (e.type !== "eat" || e.victim === undefined || e.cell === undefined) continue;
      // Only bites *we* were the authority for travel: ours, plus the bots' if
      // we are the host. A client reporting one bot eating another is not its
      // business and the host would be right to ignore it.
      const mine = e.by === youId;
      const asHost = this.isHost && !!sim.players[e.by]?.isBot;
      if (!mine && !asHost) continue;
      const victim = sim.players[e.victim];
      if (!victim) continue;
      /* Tombstone what we just swallowed, *including* when we are the one who
         swallowed it. The victim's last state packet is already in flight and
         describes a cell that no longer exists; without this it lands a frame
         later and puts the blob we just ate back on the table until the next
         update removes it again. It showed up as a flicker, and it was the one
         bug in here that a loopback test caught and a code read did not. */
      this.tombstones.set(e.cell, t);
      /* A bot we ate is news for the host, who keeps the bots' books — without
         it the host keeps broadcasting a blob we have already swallowed and it
         comes back to life the moment the tombstone expires. When we *are* the
         host there is nobody to tell: we applied it, and the next bot broadcast
         carries the result. */
      if (victim.isBot && this.isHost) continue;
      const addr = victim.isBot
        ? addrOfBot(victim.id)
        : victim.peerId
          ? addrOfPeer(victim.peerId)
          : addrOfPeer(this.peerId);
      let list = byTarget.get(addr);
      if (!list) byTarget.set(addr, (list = []));
      list.push(e.cell);
    }
    for (const [addr, cells] of byTarget) {
      this.transport.send({ t: "k", i: this.peerId, o: addr, c: cells });
    }
  }

  private reapPeers(sim: BlobSim, t: number): void {
    for (const [id, peer] of this.peers) {
      if (t - peer.lastSeen < PEER_TIMEOUT) continue;
      sim.dropPlayer(peer.playerId);
      this.peers.delete(id);
      this.safetyDirty = true;
    }
  }
}
