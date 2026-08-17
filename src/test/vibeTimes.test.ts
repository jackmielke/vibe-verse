/**
 * How the paper is fetched, and what happens when it cannot be.
 *
 * The three surfaces that print The Vibe Times — the page, the front-door
 * strip, the newsstand in the plaza — all go through `loadPaper`, and its
 * whole job is to prefer the live edition and never, under any circumstance,
 * leave a surface with nothing. That behaviour is invisible in normal use
 * and only shows up on the worst day, which is exactly the kind of thing
 * worth pinning down here rather than discovering in production.
 *
 * The letterbox is tested for the same reason from the other direction: a
 * reader's line must either be accepted or come back with something the page
 * can say out loud. It must never throw into a click handler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadPaper, loadCurrentIssue, sendLetter, printedAt } from "@/lib/vibeTimes";

/** The minimum shape `looksLikeIssue` will accept. */
function issue(n: number, extra: Record<string, unknown> = {}) {
  return {
    issue: n,
    date: "2026-08-17",
    motto: "all the news that fits the sky",
    headlines: [{ emoji: "📰", headline: `HEADLINE ${n}`, body: "body" }],
    gossip: "",
    weather: "",
    quote: { text: "", author: "" },
    stats: {},
    ...extra,
  };
}

/** Route each URL the loader might ask for to a canned answer. */
function serve(routes: Record<string, { ok?: boolean; body?: unknown; throws?: boolean }>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const route = key ? routes[key] : undefined;
    if (!route || route.throws) throw new Error("network down");
    return {
      ok: route.ok ?? true,
      json: async () => route.body,
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loadPaper", () => {
  it("prints the live edition when the presses answer", async () => {
    serve({
      "functions/v1/vibe-times": { body: { current: issue(12), archive: [issue(11)] } },
    });
    const paper = await loadPaper();
    expect(paper.live).toBe(true);
    expect(paper.current?.issue).toBe(12);
    expect(paper.archive).toHaveLength(1);
  });

  it("falls back to the committed copy when the presses are unreachable", async () => {
    serve({
      "functions/v1/vibe-times": { throws: true },
      "/vibe-times.json": { body: issue(2) },
      "/vibe-times-archive.json": { body: [issue(1)] },
    });
    const paper = await loadPaper();
    expect(paper.live).toBe(false);
    expect(paper.current?.issue).toBe(2);
    expect(paper.archive.map((a) => a.issue)).toEqual([1]);
  });

  it("falls back when the presses answer with something that is not an issue", async () => {
    // A 200 with an error body, a half-written row, an empty table: all the
    // same to a reader, and all must reach the static copy rather than
    // rendering a page with no paper on it.
    serve({
      "functions/v1/vibe-times": { body: { current: null, archive: [] } },
      "/vibe-times.json": { body: issue(2) },
      "/vibe-times-archive.json": { body: [] },
    });
    const paper = await loadPaper();
    expect(paper.live).toBe(false);
    expect(paper.current?.issue).toBe(2);
  });

  it("drops malformed back issues instead of rendering them", async () => {
    serve({
      "functions/v1/vibe-times": {
        body: { current: issue(12), archive: [issue(11), { issue: 10 }, null, { headlines: [] }] },
      },
    });
    const paper = await loadPaper();
    expect(paper.archive.map((a) => a.issue)).toEqual([11]);
  });

  it("survives both sources being down, with no paper rather than a crash", async () => {
    serve({});
    const paper = await loadPaper();
    expect(paper.current).toBeNull();
    expect(paper.archive).toEqual([]);
  });

  it("asks for one issue when only the front page is wanted", async () => {
    const fetchMock = serve({
      "functions/v1/vibe-times": { body: { current: issue(12), archive: [] } },
    });
    const current = await loadCurrentIssue();
    expect(current?.issue).toBe(12);
    expect(String(fetchMock.mock.calls[0][0])).toContain("limit=1");
  });
});

describe("sendLetter", () => {
  it("posts the line as a letter", async () => {
    const fetchMock = serve({ "functions/v1/vibe-times": { body: { ok: true } } });
    const result = await sendLetter("Jack", "the moon is landable again");
    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      action: "letter",
      author: "Jack",
      body: "the moon is landable again",
    });
  });

  it("hands back the editor's own words when the postbag refuses", async () => {
    serve({
      "functions/v1/vibe-times": {
        ok: false,
        body: { error: "the editor has plenty from you already. try again shortly." },
      },
    });
    const result = await sendLetter("Jack", "again");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/plenty from you/);
  });

  it("never throws into the click handler", async () => {
    serve({});
    await expect(sendLetter("Jack", "hello")).resolves.toEqual({
      ok: false,
      error: "couldn't reach the letterbox",
    });
  });
});

describe("printedAt", () => {
  beforeEach(() => {
    // A fixed zone, or this asserts the sandbox's clock rather than the code.
    process.env.TZ = "UTC";
  });

  it("reads the press time on the reader's own clock", () => {
    expect(printedAt("2026-08-17T13:00:49Z")).toBe("1:00 pm");
  });

  it("says nothing for the issues that were written by hand", () => {
    expect(printedAt(undefined)).toBeNull();
    expect(printedAt("")).toBeNull();
    expect(printedAt("not a date")).toBeNull();
  });
});
