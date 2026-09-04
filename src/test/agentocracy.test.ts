/**
 * Agentocracy is a state machine, so it can be played a few hundred times
 * here. What is checked: fifty agents with real personalities, an honest
 * deck, every run of twelve rounds ends, the treasury never goes negative,
 * every proposal can come up, the three endings are reachable by the three
 * obvious policies, and the agent actually learns from an override.
 */
import { describe, expect, it } from "vitest";
import {
  PERSONALITIES,
  PROPOSALS,
  ROUNDS,
  STARTING_TREASURY,
  TRAITS,
  agentLine,
  agentVote,
  createVillage,
  decide,
  endCard,
  ending,
  idleLine,
  makeAgents,
  makeRng,
  openRound,
  playThrough,
  tokens,
  wheel,
  type Choice,
} from "@/agentocracy/village";
import { COW_SPOTS, DISTRICTS, SIGNS, onIsland } from "@/agentocracy/layout";

const EM_DASH = "\u2014";

describe("the agents", () => {
  it("are fifty, with unique names and every personality represented", () => {
    const agents = makeAgents(1);
    expect(agents).toHaveLength(50);
    expect(new Set(agents.map((a) => a.name)).size).toBe(50);
    for (const p of PERSONALITIES) expect(agents.some((a) => a.personality === p), p).toBe(true);
    const districts = new Set(DISTRICTS.map((d) => d.key));
    for (const a of agents) expect(districts.has(a.home), a.home).toBe(true);
  });

  it("include the real crowd, first names only", () => {
    const names = makeAgents(1).map((a) => a.name);
    for (const n of ["Janine", "Mariella", "Noah", "Brennan", "Mitra", "Colton", "Lucy", "Telamon", "Devon", "Sol", "Taylor", "Josh", "Atin", "Murph"]) {
      expect(names).toContain(n);
    }
  });

  it("speak in filled-in sentences with no stray placeholders and no em dashes", () => {
    const agents = makeAgents(3);
    for (const p of PROPOSALS) {
      for (const a of agents) {
        for (const stance of [1, -1]) {
          const line = agentLine(a, p, stance, makeRng(a.id * 31 + stance));
          expect(line.length).toBeGreaterThan(8);
          expect(line).not.toContain("{");
          expect(line).not.toContain(EM_DASH);
        }
        const idle = idleLine(a, makeRng(a.id));
        expect(idle).not.toContain("{");
        expect(idle).not.toContain(EM_DASH);
      }
    }
  });
});

describe("the deck", () => {
  it("has about twenty unique proposals, priced at or above nothing, with two clauses each", () => {
    expect(PROPOSALS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(PROPOSALS.map((p) => p.id)).size).toBe(PROPOSALS.length);
    for (const p of PROPOSALS) {
      expect(p.cost).toBeGreaterThanOrEqual(0);
      expect(p.clauseYes.length).toBeGreaterThan(10);
      expect(p.clauseNo.length).toBeGreaterThan(10);
      expect(p.pitch).not.toContain(EM_DASH);
      expect(p.clauseYes).not.toContain(EM_DASH);
      expect(p.clauseNo).not.toContain(EM_DASH);
      for (const t of Object.keys(p.traits)) expect(TRAITS).toContain(t);
    }
  });

  it("carries the human-in-the-loop clause", () => {
    const p = PROPOSALS.find((x) => x.id === "human-loop");
    expect(p?.cost).toBe(0);
    expect(p?.clauseYes).toMatch(/human/);
  });

  it("counts three Snack Bay tokens to the money", () => {
    expect(tokens(1)).toBe(3);
    expect(tokens(STARTING_TREASURY)).toBe(60000);
  });

  it("is reachable: every proposal comes up in some seed", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 200 && seen.size < PROPOSALS.length; seed++) {
      for (const p of createVillage(seed).deck) seen.add(p.id);
    }
    expect([...seen].sort()).toEqual(PROPOSALS.map((p) => p.id).sort());
  });
});

describe("a run", () => {
  const policies: Record<string, (i: number) => Choice> = {
    delegate: () => "delegate",
    override: (i) => ({ override: i % 2 === 0 }),
    abstain: () => "abstain",
    random: (i) => (i % 3 === 0 ? "delegate" : i % 3 === 1 ? { override: i % 2 === 0 } : "abstain"),
  };

  it("always ends after twelve rounds, for every policy and many seeds", () => {
    for (const [name, policy] of Object.entries(policies)) {
      for (let seed = 1; seed <= 60; seed++) {
        const v = playThrough(seed, (vv) => policy(vv.round));
        expect(v.phase, `${name} seed ${seed}`).toBe("over");
        expect(v.round).toBe(ROUNDS);
        expect(v.history).toHaveLength(ROUNDS);
        expect(v.constitution).toHaveLength(ROUNDS + 1);
      }
    }
  });

  it("never lets the treasury go negative, even when everything passes", () => {
    for (let seed = 1; seed <= 120; seed++) {
      const v = playThrough(seed, () => ({ override: true }));
      expect(v.treasury).toBeGreaterThanOrEqual(0);
      const spent = v.history.reduce((s, r) => s + r.spent, 0);
      expect(spent).toBe(STARTING_TREASURY - v.treasury);
      for (const r of v.history) if (r.unfunded) expect(r.spent).toBe(0);
    }
  });

  it("refuses to decide with no round open, and to open one twice", () => {
    const v = createVillage(5);
    expect(() => decide(v, "delegate")).toThrow();
    openRound(v);
    expect(() => openRound(v)).toThrow();
  });

  it("lets three or four agents speak, from both sides when the room is split", () => {
    const v = createVillage(9);
    const r = openRound(v);
    expect(r.speakers.length).toBeGreaterThanOrEqual(3);
    expect(r.speakers.length).toBeLessThanOrEqual(4);
    expect(new Set(r.speakers.map((s) => s.agentId)).size).toBe(r.speakers.length);
    for (const s of r.speakers) expect(s.line).not.toContain("{");
  });
});

describe("the wheel", () => {
  it("pure delegation ends with Jesus taking the wheel", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const v = playThrough(seed, () => "delegate");
      expect(wheel(v)).toBe(1);
      expect(ending(v)).toBe("wheel");
      expect(endCard(v).title).toMatch(/wheel/);
    }
  });

  it("pure override ends as the only human in the loop", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const v = playThrough(seed, (vv) => ({ override: vv.round % 2 === 0 }));
      expect(wheel(v)).toBe(0);
      expect(ending(v)).toBe("human");
      expect(endCard(v).title).toMatch(/only human/);
    }
  });

  it("a mixed run ends with most participants feeling represented", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const v = playThrough(seed, (vv) => (vv.round % 2 === 0 ? "delegate" : { override: true }));
      expect(wheel(v)).toBeCloseTo(0.5);
      expect(ending(v)).toBe("represented");
      expect(endCard(v).title).toMatch(/accurately represented/);
    }
  });

  it("reads the end card without em dashes and with the treasury's fate", () => {
    const v = playThrough(3, () => "delegate");
    const card = endCard(v);
    expect(card.body).not.toContain(EM_DASH);
    expect(card.treasury).toMatch(/\$[\d,]+ left/);
    expect(card.treasury).toMatch(/tokens/);
  });
});

describe("the agent's model of you", () => {
  it("goes with the room when it knows nothing, and learns from an override", () => {
    const v = createVillage(11);
    const r = openRound(v);
    expect(agentVote(v, r).reason).toMatch(/no model of you/);
    decide(v, "abstain");
    // Teach it: you like safe things.
    const safe = PROPOSALS.find((p) => p.id === "slide-safety")!;
    v.deck[v.round] = safe;
    openRound(v);
    decide(v, { override: true });
    expect(v.model.safety).toBeGreaterThan(0);
    // Now the hitting fines, which are a safety thing too.
    v.deck[v.round] = PROPOSALS.find((p) => p.id === "hitting-fines")!;
    const r3 = openRound(v);
    const av = agentVote(v, r3);
    expect(av.yes).toBe(true);
    expect(av.reason).toMatch(/safe things/);
  });

  it("counts a delegated, overridden and abstained round each once", () => {
    const v = createVillage(2);
    openRound(v);
    decide(v, "delegate");
    openRound(v);
    decide(v, { override: false });
    openRound(v);
    decide(v, "abstain");
    expect([v.delegated, v.overridden, v.abstained]).toEqual([1, 1, 1]);
    expect(v.history[0].choice).toBe("delegate");
    expect(v.history[0].reason).toBeTruthy();
    expect(v.history[1].playerVote).toBe(false);
    expect(v.history[2].playerVote).toBeNull();
  });
});

describe("the island", () => {
  it("has twenty invisible cows, each on dry cardboard, each somewhere different", () => {
    expect(COW_SPOTS).toHaveLength(20);
    const keys = new Set(COW_SPOTS.map((c) => `${c.x},${c.z}`));
    expect(keys.size).toBe(20);
    for (const c of COW_SPOTS) {
      expect(onIsland(c.x, c.z), c.placard).toBe(true);
      expect(c.placard).toMatch(/COW/);
      expect(c.placard).not.toContain(EM_DASH);
    }
  });

  it("keeps every district and sign on the island and the harbour wet", () => {
    for (const d of DISTRICTS) expect(onIsland(d.x, d.z), d.name).toBe(true);
    for (const s of SIGNS) {
      expect(onIsland(s.x, s.z), s.label).toBe(true);
      expect(s.text).not.toContain(EM_DASH);
    }
    expect(onIsland(40, 0)).toBe(false);
    expect(onIsland(120, 0)).toBe(false);
  });
});
