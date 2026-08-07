/**
 * The Vibe Kart lobby is the bit of the racer with no single player in charge.
 *
 * Every client derives the same three answers from the same presence roster —
 * who is seated, who announces the countdown, and whether it is time — and if
 * two clients ever disagree the room either starts twice or never starts at
 * all. Both failures look like "multiplayer is broken" and neither shows up in
 * a build, so the derivation lives in pure functions and is checked here.
 *
 * The bug that motivated the tests: the original lobby made whoever clicked
 * "Start race" the authority, so two friends had to press it within a second
 * of each other. See `src/kart/net/lobby.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  LOBBY_MAX,
  allReady,
  hostOf,
  normalizeRoomCode,
  randomRoomCode,
  rosterWithSelf,
  seatOrder,
  type LobbyMember,
} from "@/kart/net/lobby";

const member = (over: Partial<LobbyMember> & { peerId: string }): LobbyMember => ({
  name: over.peerId,
  characterId: null,
  ready: false,
  racing: false,
  joinedAt: 0,
  ...over,
});

describe("the lobby roster", () => {
  it("orders the same way whatever order the entries arrive in", () => {
    /* Presence hands each client its own object, key order included. If the
       sort is not total, two clients can disagree about who is first — and
       who is first is who announces the countdown. */
    const a = member({ peerId: "aaa", joinedAt: 100 });
    const b = member({ peerId: "bbb", joinedAt: 100 });
    const c = member({ peerId: "ccc", joinedAt: 50 });

    const one = [a, b, c].slice().sort(seatOrder).map((m) => m.peerId);
    const two = [c, b, a].slice().sort(seatOrder).map((m) => m.peerId);
    const three = [b, a, c].slice().sort(seatOrder).map((m) => m.peerId);

    expect(one).toEqual(["ccc", "aaa", "bbb"]);
    expect(two).toEqual(one);
    expect(three).toEqual(one);
  });

  it("always puts you on your own grid, even before presence echoes back", () => {
    /* The first second of every room, and the whole of a room the browser
       cannot reach: the server's roster does not contain you. An empty lobby
       with a dead Ready button is the worst possible reading of that. */
    const me = member({ peerId: "me", joinedAt: 10 });
    expect(rosterWithSelf([], me).map((m) => m.peerId)).toEqual(["me"]);
  });

  it("does not seat you twice once presence catches up", () => {
    const me = member({ peerId: "me", joinedAt: 10, ready: false });
    const echoed = member({ peerId: "me", joinedAt: 10, ready: true });
    const roster = rosterWithSelf([echoed, member({ peerId: "you", joinedAt: 20 })], me);
    expect(roster.filter((m) => m.peerId === "me")).toHaveLength(1);
    // The wire wins for the echoed entry — one source of truth per racer.
    expect(roster.find((m) => m.peerId === "me")?.ready).toBe(true);
  });

  it("seats six and leaves the seventh on the fence", () => {
    const crowd = Array.from({ length: 8 }, (_, i) =>
      member({ peerId: `p${i}`, joinedAt: i }),
    );
    const seats = crowd.sort(seatOrder).slice(0, LOBBY_MAX);
    expect(seats).toHaveLength(6);
    expect(seats.some((m) => m.peerId === "p6")).toBe(false);
  });
});

describe("who announces the countdown", () => {
  it("is the earliest arrival", () => {
    const seats = [
      member({ peerId: "first", joinedAt: 1 }),
      member({ peerId: "second", joinedAt: 2 }),
    ];
    expect(hostOf(seats)).toBe("first");
  });

  it("moves down the list when the earliest arrival is out on track", () => {
    /* The failure this encodes: A races, B is left in the lobby. If A stays
       host, B readies up and waits forever, because the only client that ever
       announces is the one that is not looking at the roster. */
    const seats = [
      member({ peerId: "first", joinedAt: 1, racing: true }),
      member({ peerId: "second", joinedAt: 2 }),
    ];
    expect(hostOf(seats)).toBe("second");
  });

  it("is nobody when the whole room is racing", () => {
    const seats = [member({ peerId: "first", joinedAt: 1, racing: true })];
    expect(hostOf(seats)).toBeNull();
  });
});

describe("when the flag drops", () => {
  it("waits for every racer still in the lobby", () => {
    expect(
      allReady([
        member({ peerId: "a", ready: true }),
        member({ peerId: "b", ready: false }),
      ]),
    ).toBe(false);
  });

  it("goes as soon as they have all said so", () => {
    expect(
      allReady([
        member({ peerId: "a", ready: true }),
        member({ peerId: "b", ready: true }),
      ]),
    ).toBe(true);
  });

  it("ignores whoever is already racing", () => {
    /* A late arrival readying up must not be held hostage by the people who
       are three laps into the previous race and will never un-ready. */
    expect(
      allReady([
        member({ peerId: "onTrack", racing: true, ready: false }),
        member({ peerId: "waiting", ready: true }),
      ]),
    ).toBe(true);
  });

  it("never starts an empty lobby", () => {
    expect(allReady([])).toBe(false);
    expect(allReady([member({ peerId: "a", racing: true, ready: true })])).toBe(false);
  });

  it("lets one racer start alone against the CPU field", () => {
    expect(allReady([member({ peerId: "solo", ready: true })])).toBe(true);
  });
});

describe("room codes", () => {
  it("reads the code however it was typed or pasted", () => {
    expect(normalizeRoomCode(" ab-cd ")).toBe("ABCD");
    expect(normalizeRoomCode("abcdefghij")).toBe("ABCDEF");
  });

  it("never generates the two characters people misread over voice", () => {
    /* I/O against 1/0 is the whole reason for a restricted alphabet — a room
       code is read aloud far more often than it is copied. */
    for (let i = 0; i < 400; i++) {
      const code = randomRoomCode();
      expect(code).toHaveLength(4);
      expect(code).toMatch(/^[A-HJ-NP-Z]{4}$/);
    }
  });
});
