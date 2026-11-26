/**
 * What's New is read by players, and build mode writes into it unattended, so
 * the rules are checked here: real dates, unique ids, newest first, no em
 * dashes, routes that point inside the site, and a malformed build-mode file
 * is dropped instead of breaking the page.
 */
import { describe, expect, it } from "vitest";
import { ENTRIES } from "@/whatsnew/entries";
import { WHATS_NEW, byDay, fromAuto, mergeEntries } from "@/whatsnew";

describe("What's New", () => {
  it("has well-formed entries", () => {
    const ids = new Set<string>();
    for (const e of WHATS_NEW) {
      expect(e.date, e.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(new Date(e.date).getTime()), e.id).toBe(false);
      expect(e.title.trim().length, e.id).toBeGreaterThan(0);
      expect(ids.has(e.id), `duplicate id ${e.id}`).toBe(false);
      ids.add(e.id);
      if (e.route) expect(e.route.startsWith("/"), e.id).toBe(true);
    }
  });

  it("never uses an em dash in the hand-written copy", () => {
    for (const e of ENTRIES) {
      expect(`${e.title} ${e.body}`, e.id).not.toMatch(/—/);
    }
  });

  it("is newest first", () => {
    for (let i = 1; i < WHATS_NEW.length; i++) {
      expect(WHATS_NEW[i - 1].date >= WHATS_NEW[i].date).toBe(true);
    }
  });

  it("folds build-mode files in by date and drops broken ones", () => {
    const ok = fromAuto("./auto/2026-12-01-0930-abcd1234.json", {
      date: "2026-12-01",
      title: "Added a slide",
      body: "  There is a slide.  ",
    });
    expect(ok).toMatchObject({ id: "2026-12-01-0930-abcd1234", auto: true, body: "There is a slide.", tag: "update" });
    expect(fromAuto("./auto/x.json", { title: "No date" })).toBeNull();
    expect(fromAuto("./auto/y.json", { date: "2026-12-01" })).toBeNull();

    const merged = mergeEntries(ENTRIES, [ok!]);
    expect(merged[0].id).toBe(ok!.id);
    expect(merged.length).toBe(ENTRIES.length + 1);
  });

  it("groups by day", () => {
    const days = byDay();
    expect(days.reduce((n, d) => n + d.entries.length, 0)).toBe(WHATS_NEW.length);
    expect(new Set(days.map((d) => d.date)).size).toBe(days.length);
  });
});
