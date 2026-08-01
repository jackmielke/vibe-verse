/**
 * The archive terminal's paging.
 *
 * Most of this exists because of one defect found by capturing the panels with
 * the hub unreachable: every query came back empty but *successful*, `loaded`
 * went true, and the terminal cycled six pages of "— no balances —". The rule
 * that a page must have content to be in the rotation is easy to regress and
 * invisible until somebody is offline, so it is pinned here.
 */
import { describe, it, expect } from "vitest";
import { VibeverseData, PAGES } from "@/longsilence/net/vibeverse.js";

const photo = { title: "t", caption: "c", residency: "r", img: null };
const msg = { speaker: "Vibey", body: "hello", kind: "chat", when: "5d" };

describe("archive terminal paging", () => {
  it("has nothing to show before anything is adopted", () => {
    const v = new VibeverseData();
    expect(v.loaded).toBe(false);
    expect(v.hasContent).toBe(false);
  });

  it("treats an all-empty payload as nothing to show", () => {
    const v = new VibeverseData();
    // Exactly what a blocked or signed-out fetch returns: successful and empty.
    v.adopt({ photos: [], crew: [], agents: [], messages: [], profiles: [],
      treasury: { mine: null, supply: 0, holders: [], ledger: [] }, counts: {} });
    expect(v.loaded).toBe(true);
    expect(v.hasContent).toBe(false);
  });

  it("rotates only the pages that have something on them", () => {
    const v = new VibeverseData();
    v.adopt({ photos: [photo], messages: [msg] });
    expect(v.pages).toEqual(["gallery", "band"]);
    expect(v.pageId).toBe("gallery");
    v.step(1);
    expect(v.pageId).toBe("band");
    v.step(1);
    expect(v.pageId).toBe("gallery");     // wraps within the live pages
  });

  it("keeps the passport in the rotation with no network at all", () => {
    const v = new VibeverseData();
    v.adopt({ passport: [{ route: "/golf", name: "Vibe Golf", count: 1, visited: true }] });
    expect(v.hasContent).toBe(true);
    expect(v.pages).toEqual(["passport"]);
    expect(v.pageId).toBe("passport");
  });

  it("counts a signed-in zero balance as a treasury worth showing", () => {
    const v = new VibeverseData();
    v.adopt({ treasury: { mine: 0, supply: 0, holders: [], ledger: [] } });
    expect(v.pages).toContain("coin");
  });

  it("shows every page when everything is populated", () => {
    const v = new VibeverseData();
    v.adopt({
      photos: [photo], messages: [msg],
      profiles: [{ name: "A", headline: "", bio: "b", interests: "", resident: false, img: null }],
      crew: [{ name: "B", detail: "", resident: false }],
      agents: [{ name: "C", status: "idle", color: "#8fe4ff", seen: "1d" }],
      treasury: { mine: 5, supply: 5, holders: [{ name: "B", kind: "user", balance: 5, mine: true }], ledger: [] },
      passport: [{ route: "/golf", name: "Vibe Golf", count: 1, visited: true }],
    });
    expect(v.pages).toEqual(PAGES);
  });

  it("steps backwards without going out of range", () => {
    const v = new VibeverseData();
    v.adopt({ photos: [photo], messages: [msg] });
    v.step(-1);
    expect(v.pages).toContain(v.pageId);
    expect(v.page).toBeGreaterThanOrEqual(0);
  });

  it("survives adopting nothing, or junk", () => {
    const v = new VibeverseData();
    expect(() => v.adopt(null)).not.toThrow();
    expect(() => v.adopt({})).not.toThrow();
    expect(() => v.adopt({ photos: "not an array", treasury: null })).not.toThrow();
    expect(v.photos).toEqual([]);
  });

  it("never throws while updating, watched or not", () => {
    const v = new VibeverseData();
    v.adopt({ photos: [photo, { ...photo, title: "two" }] });
    for (let i = 0; i < 200; i++) expect(() => v.update(1 / 60, i % 2 === 0)).not.toThrow();
  });

  it("cycles photographs only while somebody is watching", () => {
    const v = new VibeverseData();
    v.adopt({ photos: [photo, { ...photo, title: "two" }] });

    for (let i = 0; i < 400; i++) v.update(1 / 60, false);   // nobody there
    expect(v.photoIdx).toBe(0);

    /* Count transitions rather than the final index. With two photographs and
       six seconds of watching it cycles twice and lands back on zero, so
       asserting a non-zero index tests the arithmetic of the loop rather than
       the behaviour — and fails while the behaviour is correct. */
    let changes = 0;
    let last = v.photoIdx;
    for (let i = 0; i < 400; i++) {
      v.update(1 / 60, true);
      if (v.photoIdx !== last) { changes++; last = v.photoIdx; }
    }
    expect(changes).toBeGreaterThan(0);
    expect(v.photoIdx).toBeLessThan(v.photos.length);
  });

  it("scrolls the band without ever indexing off the end", () => {
    const v = new VibeverseData();
    v.adopt({ messages: [msg, { ...msg, body: "two" }, { ...msg, body: "three" }] });
    for (let i = 0; i < 500; i++) {
      v.update(1 / 30, true);
      for (const row of v.bandRows(9)) expect(row).toBeDefined();
    }
  });

  it("reports an empty band rather than undefined rows", () => {
    const v = new VibeverseData();
    v.adopt({ messages: [] });
    expect(v.bandRows(9)).toEqual([]);
  });
});
