/**
 * BLOB — multiplayer, played out in a single process.
 *
 * Supabase is not reachable from CI (or from the container this was written
 * in), and waiting on a real socket would make these tests slow and flaky even
 * where it is. So the transport is an interface, and this file implements it
 * with two arrays and a `deliver()` call.
 *
 * That is not a weaker test than a socket would give. Everything that can
 * actually be wrong here is protocol: who is the host, who may resolve a bite,
 * what happens to the loser's cells, whether a peer that stops talking is
 * cleaned up, and whether a room lays the same dish out on both screens. All of
 * that is exercised below against two real sims. What it does *not* cover is
 * Supabase itself — that `channel.send` reaches the other tab — which is the
 * one part that is somebody else's code and the same three lines as the four
 * other worlds in this building that use it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { EAT_RATIO, TICK, radiusOf } from "@/blob/config";
import { think } from "@/blob/ai";
import { BlobSim } from "@/blob/sim";
import {
  BlobNet,
  generateRoomCode,
  normalizeRoomCode,
  seedForRoom,
  type NetTransport,
  type Wire,
} from "@/blob/net/session";

/** A room everybody can shout into, with delivery under the test's control. */
class Loopback {
  private readonly ends: { id: string; handler: ((m: Wire) => void) | null }[] = [];
  private queue: { from: string; msg: Wire }[] = [];

  endpoint(id: string): NetTransport {
    const end = { id, handler: null as ((m: Wire) => void) | null };
    this.ends.push(end);
    return {
      send: (msg) => this.queue.push({ from: id, msg }),
      receive: (fn) => {
        end.handler = fn;
      },
      close: () => {
        end.handler = null;
      },
    };
  }

  /** Flush everything in flight. Senders never hear themselves, same as the
   *  real channel's `broadcast: { self: false }`. */
  deliver(): void {
    const batch = this.queue;
    this.queue = [];
    for (const { from, msg } of batch) {
      for (const end of this.ends) {
        if (end.id === from || !end.handler) continue;
        end.handler(msg);
      }
    }
  }

  get pending(): number {
    return this.queue.length;
  }
}

/** One client: a sim, a session, and a clock the test drives. */
class Client {
  readonly sim: BlobSim;
  readonly net: BlobNet;
  clock = 0;

  constructor(wire: Loopback, peerId: string, name: string, room: string) {
    this.sim = new BlobSim({ seed: seedForRoom(room), skill: "chill", name });
    this.net = new BlobNet({
      transport: wire.endpoint(peerId),
      room,
      peerId,
      identity: () => ({ name, hue: this.sim.you.hue }),
      now: () => this.clock,
    });
    this.sim.respawnYou();
  }

  /** Step the sim and the session by one frame. */
  frame(ms = 100): void {
    this.clock += ms;
    this.sim.step(TICK, think);
    this.net.pump(this.sim, 0);
    this.sim.events.length = 0;
  }
}

const ROOM = "GLOOP-4B2";

describe("room codes", () => {
  it("reads the same however it was typed", () => {
    expect(normalizeRoomCode("gloop 4b2")).toBe("GLOOP-4B2");
    expect(normalizeRoomCode("  GLOOP--4B2  ")).toBe("GLOOP-4B2");
    expect(normalizeRoomCode("")).toBe("");
  });

  it("generates codes out of the read-aloud alphabet", () => {
    let rnd = 0;
    const code = generateRoomCode(() => ((rnd = (rnd + 0.37) % 1), rnd));
    expect(code).toMatch(/^[A-Z]+-[A-Z2-9]{3}$/);
    // No 0/O/1/I/5/S in the suffix: these get read out over voice chat.
    expect(code.split("-")[1]).not.toMatch(/[01IO5S]/);
  });

  it("lays the same dish out for everybody in the room", () => {
    const a = new BlobSim({ seed: seedForRoom(ROOM), skill: "chill" });
    const b = new BlobSim({ seed: seedForRoom(ROOM), skill: "chill" });
    expect(a.viruses.map((v) => [v.id, Math.round(v.x)])).toEqual(
      b.viruses.map((v) => [v.id, Math.round(v.x)]),
    );
    expect(a.food.length).toBe(b.food.length);
    expect(a.food[10].x).toBeCloseTo(b.food[10].x, 6);
  });

  it("gives different rooms different dishes", () => {
    expect(seedForRoom("GLOOP-4B2")).not.toBe(seedForRoom("GLOOP-4B3"));
  });
});

describe("a room with two people in it", () => {
  let wire: Loopback;
  let a: Client;
  let b: Client;

  beforeEach(() => {
    wire = new Loopback();
    // "aaa" sorts below "bbb", so A is the host. That is the whole election.
    a = new Client(wire, "aaa", "Ana", ROOM);
    b = new Client(wire, "bbb", "Bo", ROOM);
  });

  const tick = (n = 1, ms = 100) => {
    for (let i = 0; i < n; i++) {
      a.frame(ms);
      b.frame(ms);
      wire.deliver();
    }
  };

  it("elects the lowest peer id as host, with no handshake", () => {
    tick(2);
    expect(a.net.isHost).toBe(true);
    expect(b.net.isHost).toBe(false);
  });

  it("hands the bots to the host and takes them off everyone else", () => {
    tick(3);
    const hostBots = a.sim.players.filter((p) => p.isBot);
    const clientBots = b.sim.players.filter((p) => p.isBot);
    expect(hostBots.every((p) => !p.remote)).toBe(true);
    expect(clientBots.every((p) => p.remote)).toBe(true);
  });

  it("seats each player in the other's dish, by name", () => {
    tick(3);
    const bInA = a.sim.playerByPeer("bbb");
    const aInB = b.sim.playerByPeer("aaa");
    expect(bInA?.name).toBe("Bo");
    expect(aInB?.name).toBe("Ana");
    expect(bInA?.remote).toBe(true);
    expect(aInB?.remote).toBe(true);
    expect(a.net.size).toBe(2);
  });

  it("replicates a blob's position and mass across the wire", () => {
    tick(4);
    const bInA = a.sim.playerByPeer("bbb")!;
    const real = b.sim.you.cells[0];
    // Positions ease towards the wire rather than snapping, so allow the lag.
    expect(bInA.cells.length).toBe(1);
    expect(Math.hypot(bInA.cells[0].x - real.x, bInA.cells[0].y - real.y)).toBeLessThan(60);
    expect(bInA.cells[0].mass).toBeCloseTo(real.mass, 0);
  });

  it("puts the visitor on the host's leaderboard", () => {
    tick(4);
    const names = a.sim.standings(40).map((s) => s.name);
    expect(names).toContain("Bo");
  });

  it("replicates the host's bots to the client rather than simulating them", () => {
    tick(6);
    const bot = a.sim.players.find((p) => p.isBot && p.cells.length)!;
    const mirrored = b.sim.players[bot.id];
    expect(mirrored.cells.length).toBe(bot.cells.length);
    expect(Math.hypot(mirrored.cells[0].x - bot.cells[0].x, mirrored.cells[0].y - bot.cells[0].y))
      .toBeLessThan(120);
    // And the ids line up, which is what lets a kill name a cell.
    expect(mirrored.cells[0].id).toBe(bot.cells[0].id);
  });
});

describe("who is allowed to eat whom", () => {
  let wire: Loopback;
  let a: Client;
  let b: Client;

  /** Park A's blob on top of B's, with A far bigger. */
  const collide = () => {
    const big = a.sim.you.cells[0];
    big.mass = 900;
    big.r = radiusOf(900);
    big.x = 2600;
    big.y = 2600;
    big.px = big.x;
    big.py = big.y;
    a.sim.setAim(0, big.x, big.y);

    const small = b.sim.you.cells[0];
    small.x = 2600;
    small.y = 2600;
    small.px = small.x;
    small.py = small.y;
    b.sim.setAim(0, small.x, small.y);
  };

  beforeEach(() => {
    wire = new Loopback();
    a = new Client(wire, "aaa", "Ana", ROOM);
    b = new Client(wire, "bbb", "Bo", ROOM);
    // Let them find each other first.
    for (let i = 0; i < 3; i++) {
      a.frame();
      b.frame();
      wire.deliver();
    }
  });

  it("lets the bigger player eat the smaller one, on both screens", () => {
    collide();
    for (let i = 0; i < 4; i++) {
      a.frame();
      b.frame();
      wire.deliver();
    }
    // A resolved the bite locally...
    const bInA = a.sim.playerByPeer("bbb")!;
    expect(bInA.cells.length).toBe(0);
    expect(a.sim.massOf(a.sim.you)).toBeGreaterThan(900);
    // ...and B agrees, because A said so.
    expect(b.sim.you.cells.length).toBe(0);
    expect(b.sim.you.alive).toBe(false);
  });

  it("never lets the victim's own client resolve the bite against it", () => {
    collide();
    // Deliver nothing: B is on its own with a whale sitting on it.
    b.frame();
    b.frame();
    expect(b.sim.you.alive).toBe(true);
    expect(b.sim.you.cells.length).toBe(1);
  });

  it("does not resurrect a cell with a packet that was already in flight", () => {
    collide();
    a.frame();
    b.frame();
    // B's state packet, describing a cell A has just eaten, lands after the
    // kill. The tombstone is what stops it coming back.
    wire.deliver();
    a.frame();
    wire.deliver();
    a.frame();
    expect(a.sim.playerByPeer("bbb")!.cells.length).toBe(0);
  });

  it("keeps a client from eating a bot without telling the host", () => {
    // Put B's blob on top of one of the host's bots.
    const bot = a.sim.players.find((p) => p.isBot && p.cells.length)!;
    for (let i = 0; i < 4; i++) {
      a.frame();
      b.frame();
      wire.deliver();
    }
    const mirrored = b.sim.players[bot.id];
    expect(mirrored.cells.length).toBeGreaterThan(0);

    const prey = mirrored.cells[0];
    const mine = b.sim.you.cells[0];
    mine.mass = prey.mass * EAT_RATIO * 4;
    mine.r = radiusOf(mine.mass);
    mine.x = prey.x;
    mine.y = prey.y;
    mine.px = mine.x;
    mine.py = mine.y;
    b.sim.setAim(0, mine.x, mine.y);
    const eatenId = prey.id;

    for (let i = 0; i < 4; i++) {
      b.frame();
      wire.deliver();
      a.frame();
      wire.deliver();
    }
    // The host removed the cell the client named, so it stops broadcasting it.
    expect(a.sim.players[bot.id].cells.some((c) => c.id === eatenId)).toBe(false);
  });
});

describe("people coming and going", () => {
  it("drops a peer that says goodbye, and frees its blob", () => {
    const wire = new Loopback();
    const a = new Client(wire, "aaa", "Ana", ROOM);
    const b = new Client(wire, "bbb", "Bo", ROOM);
    for (let i = 0; i < 3; i++) {
      a.frame();
      b.frame();
      wire.deliver();
    }
    expect(a.sim.playerByPeer("bbb")!.alive).toBe(true);

    b.net.dispose();
    wire.deliver();
    a.frame();
    expect(a.net.size).toBe(1);
    expect(a.sim.players.some((p) => p.peerId === "bbb")).toBe(false);
  });

  it("reaps a peer that just stops talking", () => {
    const wire = new Loopback();
    const a = new Client(wire, "aaa", "Ana", ROOM);
    const b = new Client(wire, "bbb", "Bo", ROOM);
    for (let i = 0; i < 3; i++) {
      a.frame();
      b.frame();
      wire.deliver();
    }
    expect(a.net.size).toBe(2);
    // B's laptop lid closes. A keeps playing for seven seconds.
    for (let i = 0; i < 70; i++) {
      a.frame();
      wire.deliver();
    }
    expect(a.net.size).toBe(1);
  });

  it("promotes the next peer when the host leaves, with no handover message", () => {
    const wire = new Loopback();
    const a = new Client(wire, "aaa", "Ana", ROOM);
    const b = new Client(wire, "bbb", "Bo", ROOM);
    for (let i = 0; i < 3; i++) {
      a.frame();
      b.frame();
      wire.deliver();
    }
    expect(b.net.isHost).toBe(false);
    expect(b.sim.players.find((p) => p.isBot)!.remote).toBe(true);

    a.net.dispose();
    wire.deliver();
    b.frame();
    expect(b.net.isHost).toBe(true);
    // ...and B picks the bots straight back up.
    expect(b.sim.players.find((p) => p.isBot)!.remote).toBe(false);
  });

  it("survives a third player joining a match already under way", () => {
    const wire = new Loopback();
    const a = new Client(wire, "aaa", "Ana", ROOM);
    const b = new Client(wire, "bbb", "Bo", ROOM);
    for (let i = 0; i < 5; i++) {
      a.frame();
      b.frame();
      wire.deliver();
    }
    const c = new Client(wire, "ccc", "Cy", ROOM);
    for (let i = 0; i < 5; i++) {
      a.frame();
      b.frame();
      c.frame();
      wire.deliver();
    }
    expect(a.net.size).toBe(3);
    expect(c.net.size).toBe(3);
    expect(c.net.isHost).toBe(false);
    expect(c.sim.playerByPeer("aaa")?.name).toBe("Ana");
    expect(c.sim.playerByPeer("bbb")?.name).toBe("Bo");
    // The newcomer is reading the host's bots, not running its own.
    expect(c.sim.players.filter((p) => p.isBot).every((p) => p.remote)).toBe(true);
  });
});

describe("the board everybody shares", () => {
  it("drops a popped virus on every client", () => {
    const wire = new Loopback();
    const a = new Client(wire, "aaa", "Ana", ROOM);
    const b = new Client(wire, "bbb", "Bo", ROOM);
    for (let i = 0; i < 3; i++) {
      a.frame();
      b.frame();
      wire.deliver();
    }
    const virus = a.sim.viruses[0];
    expect(b.sim.viruses.some((v) => v.id === virus.id)).toBe(true);

    a.net.reportPop(virus.id);
    wire.deliver();
    b.frame();
    expect(b.sim.viruses.some((v) => v.id === virus.id)).toBe(false);
  });

  it("only lets the host invent new viruses", () => {
    const wire = new Loopback();
    const a = new Client(wire, "aaa", "Ana", ROOM);
    const b = new Client(wire, "bbb", "Bo", ROOM);
    for (let i = 0; i < 3; i++) {
      a.frame();
      b.frame();
      wire.deliver();
    }
    expect(a.sim.virusesFromWire).toBe(false);
    expect(b.sim.virusesFromWire).toBe(true);
  });
});

describe("playing alone", () => {
  it("leaves the sim exactly as it was when there is no room", () => {
    const solo = new BlobSim({ seed: 3, skill: "chill" });
    solo.respawnYou();
    for (let i = 0; i < 120; i++) solo.step(TICK, think);
    // Nobody is remote, the bots still think, and the dish still restocks.
    expect(solo.players.every((p) => !p.remote)).toBe(true);
    expect(solo.players.filter((p) => p.isBot && p.alive).length).toBeGreaterThan(4);
    expect(solo.virusesFromWire).toBe(false);
  });
});
