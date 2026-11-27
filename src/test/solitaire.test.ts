/**
 * Solitaire's rules, played in node. The page renders whatever these return
 * and never decides a move itself, so this is where "it just works" lives.
 */
import { describe, expect, it } from "vitest";
import { freshDeck, shuffled, type Card } from "@/solitaire/cards";
import { accepts, dealKlondike, drawStock, Klondike, type KlondikeState } from "@/solitaire/klondike";
import { dealFreeCell, FreeCell, maxRun } from "@/solitaire/freecell";
import { layoutTable } from "@/solitaire/layout";
import { THEMES } from "@/solitaire/themes";

const count = (s: { piles: Record<string, Card[]> }) => Object.values(s.piles).reduce((n, p) => n + p.length, 0);
const ids = (s: { piles: Record<string, Card[]> }) => Object.values(s.piles).flat().map((c) => c.id).sort((a, b) => a - b);
const c = (rank: number, suit: Card["suit"], up = true): Card => ({ id: suit * 13 + rank - 1, rank, suit, up });

describe("deck", () => {
  it("shuffles the same way for the same seed, and keeps every card", () => {
    const a = shuffled(freshDeck(), 42).map((x) => x.id);
    const b = shuffled(freshDeck(), 42).map((x) => x.id);
    expect(a).toEqual(b);
    expect(a).not.toEqual(shuffled(freshDeck(), 43).map((x) => x.id));
    expect([...a].sort((x, y) => x - y)).toEqual(Array.from({ length: 52 }, (_, i) => i));
  });
});

describe("klondike deal", () => {
  it("lays 1..7 cards with only the last face up, the rest in the stock", () => {
    const s = dealKlondike(7);
    for (let i = 0; i < 7; i++) {
      const col = s.piles[`t${i}`];
      expect(col).toHaveLength(i + 1);
      expect(col.filter((x) => x.up)).toHaveLength(1);
      expect(col[col.length - 1].up).toBe(true);
    }
    expect(s.piles.stock).toHaveLength(24);
    expect(ids(s)).toEqual(Array.from({ length: 52 }, (_, i) => i));
  });
});

describe("klondike moves", () => {
  const base = (): KlondikeState => {
    const s = dealKlondike(1);
    const piles: Record<string, Card[]> = {};
    for (const k of Object.keys(s.piles)) piles[k] = [];
    return { ...s, piles };
  };

  it("builds foundations up by suit from the ace", () => {
    const s = base();
    expect(accepts(s, "f0", c(1, 0))).toBe(true);
    expect(accepts(s, "f0", c(2, 0))).toBe(false);
    s.piles.f0 = [c(1, 0)];
    expect(accepts(s, "f0", c(2, 0))).toBe(true);
    expect(accepts(s, "f0", c(2, 1))).toBe(false);
  });

  it("builds tableau down in alternating colours, kings on empty columns", () => {
    const s = base();
    expect(accepts(s, "t0", c(13, 1))).toBe(true);
    expect(accepts(s, "t0", c(12, 1))).toBe(false);
    s.piles.t0 = [c(9, 0)];
    expect(accepts(s, "t0", c(8, 1))).toBe(true);
    expect(accepts(s, "t0", c(8, 3))).toBe(false);
    expect(accepts(s, "t0", c(7, 1))).toBe(false);
  });

  it("turns over the card left behind, and scores it", () => {
    const s = base();
    s.piles.t0 = [c(5, 0, false), c(8, 1)];
    s.piles.t1 = [c(9, 3)];
    const n = Klondike.tryMove(s, "t0", 1, "t1")!;
    expect(n.piles.t0[0].up).toBe(true);
    expect(n.piles.t1.map((x) => x.rank)).toEqual([9, 8]);
    expect(n.score).toBe(5);
    expect(n.moves).toBe(1);
    // and the old state is untouched, which is what undo relies on
    expect(s.piles.t0[0].up).toBe(false);
  });

  it("moves runs but never a face-down card", () => {
    const s = base();
    s.piles.t0 = [c(4, 2, false), c(10, 0), c(9, 1), c(8, 3)];
    s.piles.t1 = [c(11, 2)];
    expect(Klondike.canPickUp(s, "t0", 0)).toBe(false);
    expect(Klondike.canPickUp(s, "t0", 1)).toBe(true);
    const n = Klondike.tryMove(s, "t0", 1, "t1")!;
    expect(n.piles.t1.map((x) => x.rank)).toEqual([11, 10, 9, 8]);
  });

  it("draws one or three, and turns the waste back over", () => {
    let s = dealKlondike(3, 3);
    s = drawStock(s)!;
    expect(s.piles.waste).toHaveLength(3);
    expect(s.piles.stock).toHaveLength(21);
    for (let i = 0; i < 7; i++) s = drawStock(s)!;
    expect(s.piles.stock).toHaveLength(0);
    const before = s.piles.waste.map((x) => x.id);
    s = drawStock(s)!;
    expect(s.piles.waste).toHaveLength(0);
    expect(s.piles.stock.every((x) => !x.up)).toBe(true);
    s = drawStock(s)!;
    // the same order comes round again
    expect(s.piles.waste.map((x) => x.id)).toEqual(before.slice(0, 3));
    expect(count(s)).toBe(52);
  });

  it("taps an ace straight home", () => {
    const s = base();
    s.piles.t3 = [c(1, 2)];
    expect(Klondike.smartTarget(s, "t3", 0)).toBe("f0");
  });

  it("does not shuffle a bottom king between empty columns", () => {
    const s = base();
    s.piles.t0 = [c(13, 0)];
    expect(Klondike.smartTarget(s, "t0", 0)).toBe(null);
  });

  it("finishes itself once everything is face up", () => {
    let s = base();
    for (let suit = 0; suit < 4; suit++) {
      for (let r = 1; r <= 11; r++) s.piles[`f${suit}`].push(c(r, suit as Card["suit"]));
      s.piles[`t${suit}`] = [c(13, suit as Card["suit"]), c(12, suit as Card["suit"])];
    }
    expect(Klondike.canAutoFinish(s)).toBe(true);
    let steps = 0;
    while (!Klondike.isWon(s) && steps < 100) {
      s = Klondike.autoStep(s)!;
      steps++;
    }
    expect(Klondike.isWon(s)).toBe(true);
    expect(steps).toBe(8);
  });

  it("plays a hundred deals by hint without ever losing or duplicating a card", () => {
    let wins = 0;
    for (let seed = 1; seed <= 100; seed++) {
      let s = dealKlondike(seed, 1);
      let draws = 0;
      for (let i = 0; i < 600 && !Klondike.isWon(s); i++) {
        if (Klondike.canAutoFinish(s)) {
          s = Klondike.autoStep(s)!;
          continue;
        }
        const h = Klondike.hint(s);
        if (!h || (h === "draw" && draws > 80)) break;
        if (h === "draw") {
          s = drawStock(s)!;
          draws++;
        } else {
          s = Klondike.tryMove(s, h.from, h.index, h.to)!;
          draws = 0;
          expect(s).not.toBeNull();
        }
        expect(count(s)).toBe(52);
      }
      expect(ids(s)).toEqual(Array.from({ length: 52 }, (_, i) => i));
      if (Klondike.isWon(s)) wins++;
    }
    // A greedy hint player wins some deals; zero would mean the hint is broken.
    expect(wins).toBeGreaterThan(3);
  });
});

describe("freecell", () => {
  it("deals all 52 face up, 7 and 6 to a column", () => {
    const s = dealFreeCell(11);
    expect(count(s)).toBe(52);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => s.piles[`t${i}`].length)).toEqual([7, 7, 7, 7, 6, 6, 6, 6]);
    expect(Object.values(s.piles).flat().every((x) => x.up)).toBe(true);
  });

  it("limits runs by free cells and empty columns", () => {
    const s = dealFreeCell(1);
    for (const k of Object.keys(s.piles)) s.piles[k] = [];
    expect(maxRun(s, "t0")).toBe(5 * 2 ** 7);
    s.piles.c0 = [c(2, 0)];
    s.piles.c1 = [c(3, 0)];
    s.piles.c2 = [c(4, 0)];
    s.piles.c3 = [c(5, 0)];
    for (let i = 1; i < 8; i++) s.piles[`t${i}`] = [c(13, (i % 4) as Card["suit"])];
    expect(maxRun(s, "t0")).toBe(1);
  });

  it("parks a lone card in a free cell when nothing else takes it", () => {
    const s = dealFreeCell(5);
    const t = s.piles.t0;
    const to = FreeCell.smartTarget(s, "t0", t.length - 1);
    expect(to).not.toBeNull();
  });
});

describe("layout", () => {
  it("fits seven columns on a small phone without overlapping", () => {
    const s = dealKlondike(9);
    const L = layoutTable("klondike", s, 360, 560);
    expect(L.cw).toBeGreaterThanOrEqual(40);
    expect(L.slots.t6.x + L.cw).toBeLessThanOrEqual(360);
    expect(L.slots.t1.x - L.slots.t0.x).toBeGreaterThan(L.cw);
  });

  it("squeezes a long column to stay on the table", () => {
    const s = dealKlondike(9);
    for (const k of Object.keys(s.piles)) s.piles[k] = [];
    s.piles.t0 = Array.from({ length: 19 }, (_, i) => c(13 - (i % 13), (i % 2) as Card["suit"], i > 5));
    const L = layoutTable("klondike", s, 390, 600);
    const last = L.positions.get(s.piles.t0[s.piles.t0.length - 1].id)!;
    expect(last.y + L.ch).toBeLessThanOrEqual(600);
  });
});

describe("themes", () => {
  it("has a few looks, each complete", () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(4);
    for (const t of THEMES) {
      for (const v of Object.values(t)) expect(v).toBeTruthy();
    }
  });
});
