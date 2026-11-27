import { describe, expect, it } from "vitest";
import { setAuto, setInput, step, type Game } from "@/hoops/game";
import { applySnap, cleanCode, HoopsRoom, RoomBoard, matchGame, memoryHub, roomCode, snapshot, type Wire } from "@/hoops/net";

function room(hub: ReturnType<typeof memoryHub>, clock: { t: number }, host: boolean, name: string, id: string) {
  return new HoopsRoom({ transport: hub.open(), code: "DUNK-ABC", host, name, id, now: () => clock.t });
}

const still = { mx: 0, my: 0, a: false, b: false, sprint: false };

describe("Vibe Hoops online", () => {
  it("makes codes people can read aloud, and tidies typed ones", () => {
    expect(roomCode(() => 0.3)).toMatch(/^[A-Z]+-[2-9A-Z]{3}$/);
    expect(cleanCode(" swish 4b2 ")).toBe("SWISH-4B2");
  });

  it("a snapshot puts a second game exactly where the first one is", () => {
    const a = matchGame({ seed: 9, clubs: ["volts", "junkyard"], sides: [0, 1] });
    a.ctrls.forEach((_, n) => setAuto(a, n, true));
    for (let i = 0; i < 900; i++) step(a, 1 / 60);
    const b = matchGame({ seed: 9, clubs: ["volts", "junkyard"], sides: [0, 1] });
    applySnap(b, JSON.parse(JSON.stringify(snapshot(a))));
    for (const k of [0, 3, 5]) expect(b.players[k].x).toBeCloseTo(a.players[k].x, 1);
    expect(b.ball.owner).toBe(a.ball.owner);
    expect(b.score).toEqual(a.score);
    expect(b.clock).toBeCloseTo(a.clock, 1);
  });

  it("guests join and get put on the smaller side, three a side at most", () => {
    const hub = memoryHub();
    const clock = { t: 1000 };
    const host = room(hub, clock, true, "Jack", "a");
    const g1 = room(hub, clock, false, "Maya", "b");
    room(hub, clock, false, "Sam", "c");
    hub.flush();
    clock.t += 1100;
    host.tick();
    hub.flush();
    expect(host.members.map((m) => m.side)).toEqual([0, 1, 0]);
    expect(g1.members.length).toBe(3);
    expect(g1.hostId).toBe("a");
  });

  it("plays a game: the host moves the guest's player and the guest sees it", () => {
    const hub = memoryHub();
    const clock = { t: 5000 };
    const host = room(hub, clock, true, "Jack", "a");
    const guest = room(hub, clock, false, "Maya", "b");
    hub.flush();
    let started: ReturnType<HoopsRoom["startMatch"]> | null = null;
    const seen: Array<Extract<Wire, { t: "st" }>> = [];
    guest.onStart = (m) => (started = m);
    guest.onState = (m) => seen.push(m);
    const setup = host.startMatch(77);
    hub.flush();
    expect(started).not.toBeNull();
    expect(guest.myCtrl).toBe(1);
    const hg: Game = matchGame(setup);
    const gg: Game = matchGame(started!);
    // Past the walk-out and the tip.
    for (let f = 0; f < 60 * 8; f++) step(hg, 1 / 60);
    const me = hg.ctrls[1].player;
    const startY = hg.players[me].y;
    for (let f = 0; f < 90; f++) {
      clock.t += 1000 / 60;
      guest.sendInput({ ...still, my: startY > 0 ? -1 : 1 });
      hub.flush();
      setInput(hg, 0, still);
      const r = host.remoteInput("b");
      if (r) setInput(hg, 1, r);
      step(hg, 1 / 60);
      host.sendState(hg, hg.events.splice(0));
      host.tick();
      hub.flush();
    }
    expect(Math.abs(hg.players[me].y - startY)).toBeGreaterThan(1);
    expect(seen.length).toBeGreaterThan(8);
    applySnap(gg, seen[seen.length - 1].s);
    expect(gg.players[me].y).toBeCloseTo(hg.players[me].y, 0);
  });

  it("guests notice when the host leaves", () => {
    const hub = memoryHub();
    const clock = { t: 0 };
    const host = room(hub, clock, true, "Jack", "a");
    const guest = room(hub, clock, false, "Maya", "b");
    hub.flush();
    expect(host.members.length).toBe(2);
    host.leave();
    hub.flush();
    clock.t += 7000;
    expect(guest.hostLost).toBe(true);
  });

  it("open rooms are listed on the board and drop off when they close", () => {
    const hub = memoryHub();
    const clock = { t: 0 };
    const menu = new RoomBoard(hub.open(), () => clock.t);
    const maker = new RoomBoard(hub.open(), () => clock.t);
    maker.advertise("DUNK-ABC", "Jack", 1, false);
    hub.flush();
    expect(menu.list().map((r) => r.code)).toEqual(["DUNK-ABC"]);
    maker.withdraw("DUNK-ABC");
    hub.flush();
    expect(menu.list()).toEqual([]);
  });
});
