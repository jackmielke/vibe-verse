import { describe, expect, it } from "vitest";
import { worldForLocation, overall, formatHours, type WorldStatsRow } from "@/lib/worldStats";
import { PLAYABLE } from "@/worlds/registry";

const row = (o: Partial<WorldStatsRow>): WorldStatsRow => ({
  world_key: "x", play_seconds: 0, players: 0, sessions: 0, fps_sum: 0, fps_n: 0,
  lore_sum: 0, lore_n: 0, fun_sum: 0, fun_n: 0, smooth_sum: 0, smooth_n: 0, ...o,
});

describe("worldStats", () => {
  it("resolves every playable world from its own route", () => {
    for (const w of PLAYABLE) {
      const [path, q] = w.route.split("?");
      expect(worldForLocation(path, q ? `?${q}` : "")?.key, w.route).toBe(w.key);
    }
  });
  it("does not count the app's own pages", () => {
    for (const p of ["/", "/scores", "/auth/callback", "/admin/games"]) expect(worldForLocation(p)).toBeUndefined();
  });
  it("keys are valid for the database check", () => {
    for (const w of PLAYABLE) expect(w.key).toMatch(/^[a-z0-9][a-z0-9-]{0,47}$/);
  });
  it("averages only the criteria with votes", () => {
    expect(overall(row({}))).toBeNull();
    expect(overall(row({ fun_sum: 8, fun_n: 2 }))).toBe(4);
    expect(overall(row({ fun_sum: 8, fun_n: 2, lore_sum: 2, lore_n: 1 }))).toBe(3);
  });
  it("formats hours", () => {
    expect(formatHours(0)).toBe("0");
    expect(formatHours(90)).toBe("2m");
    expect(formatHours(5400)).toBe("1.5h");
  });
});
