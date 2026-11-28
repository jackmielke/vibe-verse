import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const applyLocalDelta = vi.fn();
const coinPickup = vi.fn(async (_world: string, _count: number) => null);
vi.mock("@/lib/vibecoin", () => ({ applyLocalDelta, coinPickup }));

const { PICKUP_DAILY, PICKUP_DAILY_TOTAL, flushVibeyPickups, pickUpVibeyCoin, pickupsLeftToday } = await import(
  "@/lib/vibeyPickup"
);

describe("floating Vibey Coins", () => {
  beforeEach(() => {
    localStorage.clear();
    applyLocalDelta.mockClear();
    coinPickup.mockClear();
  });

  it("moves the chip at once and batches the server call", () => {
    expect(pickUpVibeyCoin("frisco")).toBe(1);
    expect(pickUpVibeyCoin("frisco")).toBe(1);
    expect(applyLocalDelta).toHaveBeenCalledTimes(2);
    expect(coinPickup).not.toHaveBeenCalled();
    flushVibeyPickups();
    expect(coinPickup).toHaveBeenCalledWith("frisco", 2);
  });

  it("stops paying at the world's daily ceiling", () => {
    expect(pickUpVibeyCoin("kart", 1000)).toBe(PICKUP_DAILY.kart);
    expect(pickupsLeftToday("kart")).toBe(0);
    expect(pickUpVibeyCoin("kart")).toBe(0);
    flushVibeyPickups();
    const sent = coinPickup.mock.calls.reduce((t, c) => t + (c[1] as number), 0);
    expect(sent).toBe(PICKUP_DAILY.kart);
  });

  it("agrees with the server's ceilings", () => {
    const fn = readFileSync("supabase/functions/vibe-economy/index.ts", "utf8");
    for (const [world, cap] of Object.entries(PICKUP_DAILY)) {
      expect(fn).toMatch(new RegExp(`\\b${world}: ${cap},`));
    }
    expect(fn).toContain(`const PICKUP_DAILY_CAP = ${PICKUP_DAILY_TOTAL};`);
  });
});
