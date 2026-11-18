/**
 * The $VIBE chip read "—" for most first-time visitors, because the edge
 * function was the only source and a first visit has no cached figure. These
 * pin the fallback order: edge function, then GeckoTerminal, then DexScreener.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } },
}));

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);

async function fresh() {
  vi.resetModules();
  localStorage.clear();
  return import("@/lib/vibeMarket");
}

describe("vibeMarket sources", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.unstubAllGlobals();
  });

  it("uses the edge function when it has a price", async () => {
    invoke.mockResolvedValue({ data: { data: { price: { usd: 0.00007, change24h: 2 } } } });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const m = await fresh();
    const r = await m.refreshVibeMarket(true);
    expect(r.usd).toBe(0.00007);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to GeckoTerminal when the function answers with no price", async () => {
    invoke.mockResolvedValue({ data: { ok: true, data: { price: null, holdings: {} } } });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.includes("geckoterminal")
          ? ok({ data: { attributes: { base_token_price_usd: "0.0000712", price_change_percentage: { h24: "-3.4" } } } })
          : ok(null),
      ),
    );
    const m = await fresh();
    const r = await m.refreshVibeMarket(true);
    expect(r.usd).toBeCloseTo(0.0000712);
    expect(r.change24h).toBeCloseTo(-3.4);
  });

  it("falls back to the deepest Base pair on DexScreener last", async () => {
    invoke.mockRejectedValue(new Error("preflight"));
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.includes("dexscreener")
          ? ok({
              pairs: [
                { chainId: "base", priceUsd: "0.9", liquidity: { usd: 3 } },
                { chainId: "base", priceUsd: "0.00007", liquidity: { usd: 40000 }, priceChange: { h24: 1.5 } },
              ],
            })
          : Promise.resolve({ ok: false } as Response),
      ),
    );
    const m = await fresh();
    const r = await m.refreshVibeMarket(true);
    expect(r.usd).toBe(0.00007);
    expect(r.change24h).toBe(1.5);
  });

  it("keeps the cached figure when every source fails", async () => {
    invoke.mockResolvedValue({ data: null, error: { message: "down" } });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    vi.resetModules();
    localStorage.setItem("vibe.market.v1", JSON.stringify({ usd: 0.00005, change24h: null, at: 1 }));
    const m = await import("@/lib/vibeMarket");
    const r = await m.refreshVibeMarket(true);
    expect(r.usd).toBe(0.00005);
  });
});
