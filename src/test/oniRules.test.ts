import { describe, expect, it } from "vitest";
import { createMatch, type Match } from "@/oni/match";
import type { OniRoom, OniWire, Peer } from "@/oni/net";
import {
  ARENA_R, COUNTDOWN_MS, INTERMISSION_MS, LOBBY_MS, OBSTACLES, ROUND_MS, addTag, firstOniCount, isOni, laterRound, makeRound,
  phaseOf, presenceHz, referee, resultOf, roundEndsAt, solve, spawnFor, type Round, type Tag,
} from "@/oni/rules";

const round = (over: Partial<Round> = {}): Round => ({ id: "r1", start: 1000, end: 1000 + ROUND_MS, first: ["a"], ...over });

describe("oni rules", () => {
  it("starts more oni in a bigger room, never everybody", () => {
    expect(firstOniCount(1)).toBe(0);
    expect(firstOniCount(2)).toBe(1);
    expect(firstOniCount(8)).toBe(2);
    expect(firstOniCount(20)).toBe(3);
    const r = makeRound(0, ["a", "b"], () => 0.3);
    expect(r.first).toHaveLength(1);
    expect(r.start).toBe(COUNTDOWN_MS);
    expect(r.end - r.start).toBe(ROUND_MS);
  });

  it("agrees on one round when two are announced, whatever order they arrive in", () => {
    const a = round({ id: "x", start: 5000 });
    const b = round({ id: "y", start: 6000 });
    expect(laterRound(laterRound(null, a), b)).toBe(b);
    expect(laterRound(laterRound(null, b), a)).toBe(b);
    const c = round({ id: "z", start: 5000 });
    expect(laterRound(a, c).id).toBe(laterRound(c, a).id);
  });

  it("keeps the earliest tag for a victim and never tags a first oni", () => {
    const r = round();
    const tags = new Map<string, Tag>();
    expect(addTag(tags, { victim: "b", by: "a", at: 3000 }, r)).toBe(true);
    expect(addTag(tags, { victim: "b", by: "?", at: 4000 }, r)).toBe(false);
    expect(tags.get("b")!.by).toBe("a");
    expect(addTag(tags, { victim: "b", by: "a", at: 2000 }, r)).toBe(true);
    expect(tags.get("b")!.at).toBe(2000);
    expect(addTag(tags, { victim: "a", by: "b", at: 2500 }, r)).toBe(false);
    expect(isOni("a", r, tags) && isOni("b", r, tags)).toBe(true);
  });

  it("ends when the last runner is caught, and names them", () => {
    const r = round({ first: ["a"] });
    const tags = new Map<string, Tag>();
    const players = ["a", "b", "c"];
    expect(phaseOf(500, r, tags, players)).toBe("countdown");
    expect(phaseOf(2000, r, tags, players)).toBe("play");
    addTag(tags, { victim: "b", by: "a", at: 5000 }, r);
    expect(phaseOf(6000, r, tags, players)).toBe("play");
    addTag(tags, { victim: "c", by: "b", at: 9000 }, r);
    expect(roundEndsAt(r, tags, players)).toBe(9000);
    expect(phaseOf(9001, r, tags, players)).toBe("over");
    const res = resultOf(r, tags, players);
    expect(res.lastStanding).toEqual({ id: "c", survived: 8000 });
    expect(res.survivors).toEqual([]);
    expect(res.topOni).toEqual({ id: "a", count: 1 });
  });

  it("gives the win to everybody still free when the clock runs out", () => {
    const r = round({ first: ["a"] });
    const tags = new Map<string, Tag>();
    addTag(tags, { victim: "b", by: "a", at: 5000 }, r);
    const players = ["a", "b", "c", "d"];
    expect(phaseOf(r.end + 1, r, tags, players)).toBe("over");
    expect(resultOf(r, tags, players).survivors).toEqual(["c", "d"]);
  });

  it("picks the same referee on every device", () => {
    expect(referee(["m", "c", "x"])).toBe("c");
    expect(referee(["x", "m", "c"])).toBe("c");
    // Practice bots sort after every real id.
    expect(referee(["~bot1", "zz9"])).toBe("zz9");
  });

  it("keeps everybody inside the square and outside the tower", () => {
    for (let i = 0; i < 200; i++) {
      const p = solve((Math.random() - 0.5) * 80, (Math.random() - 0.5) * 80);
      expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(ARENA_R + 1e-6);
      for (const o of OBSTACLES) expect(Math.hypot(p.x - o.x, p.z - o.z)).toBeGreaterThan(o.r + 0.3);
    }
  });

  it("spawns runners out by the edge and the oni by the tower", () => {
    const r = round({ first: ["oni"] });
    const s = spawnFor("oni", r);
    expect(Math.hypot(s.x, s.z)).toBeLessThan(8);
    for (const id of ["a", "b", "c", "d", "e"]) expect(Math.hypot(spawnFor(id, r).x, spawnFor(id, r).z)).toBeGreaterThan(12);
  });

  it("slows presence down as the room fills, to stay under the message rate", () => {
    expect(presenceHz(2)).toBe(10);
    expect(presenceHz(20)).toBeLessThan(4);
    expect(presenceHz(200)).toBe(3);
    for (const n of [2, 5, 10, 20, 24]) expect(n * presenceHz(n)).toBeLessThanOrEqual(Math.max(72, n * 3) + 1e-9);
  });
});

// ---------------------------------------------------------------------------
// Two devices, one wire
// ---------------------------------------------------------------------------

function wire(ids: string[], clock: { t: number }) {
  const matches = new Map<string, Match>();
  const peersOf = (me: string): Peer[] => ids.filter((i) => i !== me).map((id) => ({ id, name: id, char: "flux", x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, oni: false, round: "", at: 0 }));
  const sent: OniWire[] = [];
  for (const id of ids) {
    const room: OniRoom = {
      id, connected: true,
      send(msg) { sent.push(msg); for (const [other, m] of matches) if (other !== id) m.handle(msg); },
      setPresence() {}, flush() {}, peers: () => peersOf(id), close() {},
    };
    matches.set(id, createMatch({ me: id, room: () => room, peers: () => peersOf(id), now: () => clock.t }));
  }
  return { matches, sent };
}

describe("oni match", () => {
  it("the referee starts a round after the lobby wait and everybody plays the same one", () => {
    const clock = { t: 0 };
    const { matches } = wire(["a", "b", "c"], clock);
    for (const m of matches.values()) m.update();
    clock.t = LOBBY_MS - 1;
    for (const m of matches.values()) m.update();
    expect(matches.get("a")!.round()).toBeNull();
    clock.t = LOBBY_MS;
    for (const m of matches.values()) m.update();
    const ids = [...matches.values()].map((m) => m.round()?.id);
    expect(ids[0]).toBeTruthy();
    expect(new Set(ids).size).toBe(1);
  });

  it("a tag claimed on one device is a tag everywhere, and the next round follows the intermission", () => {
    const clock = { t: 0 };
    const { matches } = wire(["a", "b"], clock);
    const a = matches.get("a")!, b = matches.get("b")!;
    a.update(); b.update();
    a.announce();
    const r = b.round()!;
    expect(r.id).toBe(a.round()!.id);
    const oni = r.first[0], runner = oni === "a" ? "b" : "a";
    clock.t = r.start + 3000;
    matches.get(runner)!.claim(runner, oni);
    expect(a.isOni(runner) && b.isOni(runner)).toBe(true);
    a.update(); b.update();
    expect(a.phase()).toBe("over");
    expect(b.result()!.lastStanding!.id).toBe(runner);
    clock.t += INTERMISSION_MS + 1;
    a.update(); b.update();
    expect(a.round()!.id).not.toBe(r.id);
    expect(b.round()!.id).toBe(a.round()!.id);
  });

  it("a newcomer mid-round is told the round and who already has horns", () => {
    const clock = { t: 0 };
    const { matches } = wire(["a", "b", "c"], clock);
    const a = matches.get("a")!;
    a.announce();
    const r = a.round()!;
    clock.t = r.start + 1000;
    const runner = ["a", "b", "c"].find((x) => !r.first.includes(x))!;
    a.claim(runner, r.first[0]);
    // A fourth device joins and says hello; the referee ("a") answers.
    const late = createMatch({ me: "d", room: () => null, peers: () => [], now: () => clock.t });
    const answers: OniWire[] = [];
    const refRoom = { send: (m: OniWire) => answers.push(m) } as unknown as OniRoom;
    const ref = createMatch({ me: "a", room: () => refRoom, peers: () => [], now: () => clock.t });
    ref.handle({ t: "round", id: "a", round: r });
    ref.handle({ t: "tag", id: "a", r: r.id, v: runner, by: r.first[0], at: clock.t });
    ref.handle({ t: "hi", id: "d" });
    for (const m of answers) late.handle(m);
    expect(late.round()!.id).toBe(r.id);
    expect(late.isOni(runner)).toBe(true);
  });

  it("a presence packet saying 'I have horns' heals a lost tag", () => {
    const clock = { t: 0 };
    const m = createMatch({ me: "a", room: () => null, peers: () => [], now: () => clock.t });
    const r = round({ first: ["a"], start: 0, end: ROUND_MS });
    m.handle({ t: "round", id: "a", round: r });
    clock.t = 2000;
    m.handle({ t: "p", id: "b", n: "b", c: "flux", x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, o: 1, r: r.id });
    expect(m.isOni("b")).toBe(true);
  });
});
