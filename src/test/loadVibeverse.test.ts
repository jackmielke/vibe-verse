/**
 * The mapping between Supabase rows and what the archive terminal draws.
 *
 * This is the layer that cannot be verified where it was written: the sandbox
 * that built it has no route to the database, so the first time real rows meet
 * these panels is in production. What *can* be pinned is the transformation —
 * fed the row shapes actually observed in the Vibe project, including the
 * awkward ones (null titles, bios carrying a scrape artefact, agents with no
 * colour, balances keyed by bare uuid).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** Rows each table returns, swapped per test. */
const tables: Record<string, unknown[]> = {};
/** Tables that should reject rather than return, for the degradation tests. */
const failing = new Set<string>();

vi.mock("@/integrations/supabase/client", () => {
  /* The real client is a chainable builder that is finally awaited. Every
     modifier returns `this`; awaiting yields { data }. */
  const builder = (name: string) => {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "not", "neq", "order", "limit", "in", "eq"]) {
      self[m] = () => self;
    }
    self.then = (res: (v: unknown) => void, rej: (e: unknown) => void) => {
      if (failing.has(name)) return Promise.reject(new Error("boom")).then(res, rej);
      return Promise.resolve({ data: tables[name] ?? [] }).then(res);
    };
    return self;
  };
  return { supabase: { from: (name: string) => builder(name) } };
});

const { loadVibeverse } = await import("@/lib/loadVibeverse");

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  failing.clear();
  // Images never resolve in jsdom; loadImage's own timeout returns null, which
  // is the same path a CORS-refusing CDN takes.
  vi.stubGlobal("Image", class {
    crossOrigin = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_v: string) { setTimeout(() => this.onerror?.(), 0); }
  });
});

describe("loadVibeverse", () => {
  it("returns an empty, well-formed payload when every table is empty", async () => {
    const out = await loadVibeverse();
    expect(out.photos).toEqual([]);
    expect(out.profiles).toEqual([]);
    expect(out.treasury.holders).toEqual([]);
    expect(out.treasury.mine).toBeNull();          // signed out is not zero
    expect(out.treasury.supply).toBe(0);
  });

  it("strips the [Photo: prefix a scrape left on imported bios", async () => {
    tables.users = [{
      name: "Kristina", headline: null, bio: "[Photo: Hi, I'm Kristina, citizen of the world]",
      interests_skills: null, avatar_url: "http://x/a.jpg", is_vibe_resident: false,
    }];
    const out = await loadVibeverse();
    expect(out.profiles[0].bio.startsWith("[Photo:")).toBe(false);
    expect(out.profiles[0].bio).toContain("Kristina");
  });

  it("falls back through title, residency, then UNTITLED for a photo", async () => {
    tables.gallery_photos = [
      { title: null, description: null, residency_name: "Edge Esmeralda", image_url: "http://x/1.jpg" },
      { title: null, description: null, residency_name: null, image_url: "http://x/2.jpg" },
    ];
    const out = await loadVibeverse();
    expect(out.photos[0].title).toBe("Edge Esmeralda");
    expect(out.photos[1].title).toBe("UNTITLED");
    // The CDN refused; the caption card carries the page instead.
    expect(out.photos[0].img).toBeNull();
  });

  /* Agent colours go straight into a canvas fillStyle. Anything that is not a
     plain six-digit hex is refused rather than passed through. */
  it("refuses an agent colour that is not a plain hex", async () => {
    tables.world_agents = [
      { name: "Vibey", status: "wandering", color: "#38bdf8", last_seen_at: null },
      { name: "Bad", status: "idle", color: "red", last_seen_at: null },
      { name: "Worse", status: "idle", color: "javascript:alert(1)", last_seen_at: null },
      { name: "Null", status: "idle", color: null, last_seen_at: null },
    ];
    const out = await loadVibeverse();
    expect(out.agents[0].color).toBe("#38bdf8");
    for (const a of out.agents.slice(1)) expect(a.color).toBe("#8fe4ff");
  });

  it("marks your own balance and totals the supply", async () => {
    tables.vibe_balances = [
      { owner_kind: "user", owner_ref: "me", balance: 116 },
      { owner_kind: "user", owner_ref: "them", balance: 100 },
      { owner_kind: "agent", owner_ref: "bot", balance: 50 },
    ];
    tables.users = [{ id: "me", name: "Jack" }, { id: "them", name: "Deca" }];
    tables.world_agents = [{ id: "bot", name: "Glitch" }];
    const out = await loadVibeverse("me");
    expect(out.treasury.mine).toBe(116);
    expect(out.treasury.supply).toBe(266);
    expect(out.treasury.holders.filter((h) => h.mine)).toHaveLength(1);
  });

  it("reports zero rather than null for a signed-in holder of nothing", async () => {
    tables.vibe_balances = [{ owner_kind: "user", owner_ref: "someone", balance: 5 }];
    const out = await loadVibeverse("me-with-no-balance");
    expect(out.treasury.mine).toBe(0);
  });

  it("labels the treasury and shortens an id it cannot resolve", async () => {
    tables.vibe_ledger = [
      { from_kind: "system", from_ref: "treasury", to_kind: "user", to_ref: "abcdef123456",
        amount: 16, reason: "game_reward", memo: "shrine-dive · score 16", created_at: null },
    ];
    const out = await loadVibeverse();
    expect(out.treasury.ledger[0].from).toBe("TREASURY");
    expect(out.treasury.ledger[0].to).toMatch(/^abcdef…?$/);
    expect(out.treasury.ledger[0].reason).toBe("shrine-dive · score 16");
  });

  it("keeps the other three tables when one rejects", async () => {
    failing.add("gallery_photos");
    tables.world_messages = [{ speaker: "Vibey", body: "hello", kind: "chat", created_at: null }];
    const out = await loadVibeverse();
    expect(out.photos).toEqual([]);
    expect(out.messages).toHaveLength(1);
    expect(out.error).toBeUndefined();       // one failure is not "no link"
  });

  it("drops rows with no body or no name rather than drawing blanks", async () => {
    tables.world_messages = [
      { speaker: "Vibey", body: "real", kind: "chat", created_at: null },
      { speaker: "Ghost", body: null, kind: "chat", created_at: null },
    ];
    tables.users = [{ name: null, bio: "x", avatar_url: "http://x/a.jpg" }];
    const out = await loadVibeverse();
    expect(out.messages).toHaveLength(1);
    expect(out.profiles).toHaveLength(0);
  });

  it("truncates anything long enough to overrun the panel", async () => {
    tables.world_messages = [{ speaker: "V".repeat(80), body: "b".repeat(400), kind: "chat", created_at: null }];
    const out = await loadVibeverse();
    expect(out.messages[0].speaker.length).toBeLessThanOrEqual(18);
    expect(out.messages[0].body.length).toBeLessThanOrEqual(96);
    expect(out.messages[0].body.endsWith("…")).toBe(true);
  });

  it("formats how long ago something happened", async () => {
    const now = Date.now();
    tables.world_agents = [
      { name: "A", status: "idle", color: null, last_seen_at: new Date(now - 5 * 60_000).toISOString() },
      { name: "B", status: "idle", color: null, last_seen_at: new Date(now - 3 * 3_600_000).toISOString() },
      { name: "C", status: "idle", color: null, last_seen_at: new Date(now - 4 * 86_400_000).toISOString() },
      { name: "D", status: "idle", color: null, last_seen_at: null },
    ];
    const out = await loadVibeverse();
    expect(out.agents[0].seen).toBe("5m");
    expect(out.agents[1].seen).toBe("3h");
    expect(out.agents[2].seen).toBe("4d");
    expect(out.agents[3].seen).toBe("");
  });
});
