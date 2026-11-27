import { describe, expect, it } from "vitest";
import { autopilot, setInput, step, type Game } from "@/vibecup/game";
import { applySnap, cleanCode, CupRoom, RoomBoard, matchGame, memoryHub, roomCode, snapshot, type MatchSetup, type Wire } from "@/vibecup/net";

function room(hub: ReturnType<typeof memoryHub>, clock: { t: number }, host: boolean, name: string, id: string) {
  return new CupRoom({ transport: hub.open(), code: "GOAL-ABC", host, name, id, now: () => clock.t });
}

describe("Vibe Cup online", () => {
  it("makes codes people can read aloud, and tidies typed ones", () => {
    const c = roomCode(() => 0.3);
    expect(c).toMatch(/^[A-Z]+-[2-9A-Z]{3}$/);
    expect(cleanCode(" nutmeg 4b2 ")).toBe("NUTMEG-4B2");
  });

  it("a snapshot puts a second game exactly where the first one is", () => {
    const a = matchGame({ seed: 9, clubs: ["volts", "comets"], sides: [0, 1] });
    for (let i = 0; i < 400; i++) {
      a.ctrls.forEach((_, n) => setInput(a, n, autopilot(a, n)));
      step(a, 1 / 60);
    }
    const b = matchGame({ seed: 9, clubs: ["volts", "comets"], sides: [0, 1] });
    applySnap(b, JSON.parse(JSON.stringify(snapshot(a))));
    expect(b.players[4].x).toBeCloseTo(a.players[4].x, 2);
    expect(b.ball.owner).toBe(a.ball.owner);
    expect(b.clock).toBeCloseTo(a.clock, 2);
    expect(b.ctrls[1].active).toBe(a.ctrls[1].active);
    // And then they keep playing the same match.
    for (let i = 0; i < 30; i++) {
      for (const g of [a, b]) {
        g.ctrls.forEach((_, n) => setInput(g, n, { mx: 1, my: 0, a: false, b: false, sprint: false }));
        step(g, 1 / 60);
      }
    }
    // Rounded to a millimetre on the wire, so they drift a little: the next state corrects it.
    expect(Math.abs(b.players[4].x - a.players[4].x)).toBeLessThan(1);
  });

  it("guests join a room, get put on the smaller side, and can swap", () => {
    const hub = memoryHub();
    const clock = { t: 1000 };
    const host = room(hub, clock, true, "Jack", "a");
    const g1 = room(hub, clock, false, "Maya", "b");
    const g2 = room(hub, clock, false, "Sam", "c");
    hub.flush();
    clock.t += 1100;
    host.tick();
    hub.flush();
    expect(host.members.map((m) => [m.name, m.side])).toEqual([
      ["Jack", 0],
      ["Maya", 1],
      ["Sam", 0],
    ]);
    expect(g1.members.length).toBe(3);
    expect(g1.hostId).toBe("a");
    g2.setSide("c", 1);
    hub.flush();
    hub.flush();
    expect(host.members.find((m) => m.id === "c")!.side).toBe(1);
    expect(g1.members.find((m) => m.id === "c")!.side).toBe(1);
    // A third on one side is refused.
    host.setSide("a", 1);
    expect(host.members.find((m) => m.id === "a")!.side).toBe(0);
  });

  it("plays a match: the referee moves the guest's player and the guest sees it", () => {
    const hub = memoryHub();
    const clock = { t: 5000 };
    const host = room(hub, clock, true, "Jack", "a");
    const guest = room(hub, clock, false, "Maya", "b");
    hub.flush();
    let started: MatchSetup | null = null;
    const seen: Array<Extract<Wire, { t: "st" }>> = [];
    guest.onStart = (m) => (started = m);
    guest.onState = (m) => seen.push(m);
    const setup = host.startMatch(77);
    hub.flush();
    expect(started).not.toBeNull();
    expect(started!.roster).toEqual(["a", "b"]);
    expect(guest.myCtrl).toBe(1);

    const hg: Game = matchGame(setup);
    const gg: Game = matchGame(started!);
    const startX = hg.players[hg.ctrls[1].active].x;
    // The guest holds the stick towards its own goal (+x) for two seconds.
    for (let f = 0; f < 120; f++) {
      clock.t += 1000 / 60;
      guest.sendInput({ mx: 1, my: 0, a: false, b: false, sprint: false });
      hub.flush();
      setInput(hg, 0, { mx: 0, my: 0, a: false, b: false, sprint: false });
      const r = host.remoteInput("b");
      if (r) setInput(hg, 1, r);
      step(hg, 1 / 60);
      host.sendState(hg, hg.events.splice(0));
      host.tick();
      hub.flush();
    }
    expect(hg.players[hg.ctrls[1].active].x - startX).toBeGreaterThan(3);
    expect(seen.length).toBeGreaterThan(15);
    expect(seen.length).toBeLessThan(30);
    applySnap(gg, seen[seen.length - 1].s);
    expect(gg.players[gg.ctrls[1].active].x).toBeCloseTo(hg.players[hg.ctrls[1].active].x, 0);
    // The kickoff whistle travelled with the first state.
    expect(seen.flatMap((s) => s.e).some((e) => e.type === "whistle")).toBe(true);
  });

  it("a tap shorter than a packet still reaches the referee", () => {
    const hub = memoryHub();
    const clock = { t: 0 };
    const host = room(hub, clock, true, "Jack", "a");
    const guest = room(hub, clock, false, "Maya", "b");
    hub.flush();
    host.startMatch(3);
    hub.flush();
    guest.sendInput({ mx: 0, my: 0, a: true, b: false, sprint: false });
    clock.t += 5;
    guest.sendInput({ mx: 0, my: 0, a: false, b: false, sprint: false });
    hub.flush();
    expect(host.remoteInput("b")!.a).toBe(true);
    expect(host.remoteInput("b")!.a).toBe(false);
  });

  it("guests notice when the referee leaves, and the referee drops a guest that goes quiet", () => {
    const hub = memoryHub();
    const clock = { t: 0 };
    const host = room(hub, clock, true, "Jack", "a");
    const guest = room(hub, clock, false, "Maya", "b");
    hub.flush();
    expect(host.members.length).toBe(2);
    clock.t += 7000;
    host.tick();
    expect(host.members.length).toBe(1);
    guest.tick();
    hub.flush();
    host.leave();
    hub.flush();
    expect(guest.hostLost).toBe(true);
  });

  it("two people on a side never drive the same player", () => {
    const g = matchGame({ seed: 21, clubs: ["volts", "rovers"], sides: [0, 1, 0, 1] });
    let goals = 0;
    for (let i = 0; i < 60 * 90; i++) {
      g.ctrls.forEach((_, n) => setInput(g, n, autopilot(g, n)));
      step(g, 1 / 60);
      goals += g.events.filter((e) => e.type === "goal").length;
      g.events.length = 0;
      expect(g.ctrls[0].active).not.toBe(g.ctrls[2].active);
      expect(g.ctrls[1].active).not.toBe(g.ctrls[3].active);
    }
    expect(goals).toBeGreaterThan(0);
  });

  it("a player left off the screen hands control to a team-mate near the ball", () => {
    const g = matchGame({ seed: 4, clubs: ["volts", "rovers"], sides: [0] });
    for (let i = 0; i < 120; i++) step(g, 1 / 60);
    const c = g.ctrls[0];
    // Strand our person in the far corner, with the ball at the other end.
    const me = g.players[c.active];
    g.ball.owner = -1;
    Object.assign(g.ball, { x: 14, y: 0, vx: 0, vy: 0 });
    Object.assign(me, { x: -22, y: 13, vx: 0, vy: 0 });
    g.phase = "play";
    const was = c.active;
    for (let i = 0; i < 40; i++) {
      setInput(g, 0, { mx: 0, my: 0, a: false, b: false, sprint: false });
      step(g, 1 / 60);
    }
    expect(c.active).not.toBe(was);
    const now = g.players[c.active];
    expect(Math.hypot(now.x - g.ball.x, now.y - g.ball.y)).toBeLessThan(Math.hypot(me.x - g.ball.x, me.y - g.ball.y));
  });

  it("open rooms are listed on the board, and drop off when they close or go quiet", () => {
    const hub = memoryHub();
    const clock = { t: 0 };
    const menu = new RoomBoard(hub.open(), () => clock.t);
    const maker = new RoomBoard(hub.open(), () => clock.t);
    maker.advertise("GOAL-ABC", "Jack", 1, false);
    maker.advertise("CHIP-XYZ", "Maya", 4, true);
    hub.flush();
    expect(menu.list().map((r) => [r.code, r.host, r.players])).toEqual([
      ["GOAL-ABC", "Jack", 1],
      ["CHIP-XYZ", "Maya", 4],
    ]);
    maker.withdraw("GOAL-ABC");
    hub.flush();
    expect(menu.list().map((r) => r.code)).toEqual(["CHIP-XYZ"]);
    clock.t += 8000;
    expect(menu.list()).toEqual([]);
  });
});
