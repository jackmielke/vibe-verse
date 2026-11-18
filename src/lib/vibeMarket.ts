/**
 * What Vibecoin is worth, live.
 *
 * `$VIBE` is a real ERC-20 on Base with a real price, and until now the only
 * place in the vibeverse that knew it was the wallet page. A number that moves
 * is the cheapest possible proof that the token half of this is not a
 * metaphor, so it belongs on the front door.
 *
 * ## Where the number comes from
 *
 * GeckoTerminal's pool endpoint, via the `vibe-holdings` edge function. Not
 * fetched from the browser directly, even though it would be one hop fewer:
 * the function is already deployed, already has the pool address, already
 * fails over, and — the part that matters — is a URL we control, so a change
 * of data source later is a redeploy rather than a release.
 *
 * ## Why it appears instantly
 *
 * The last figure is cached in `localStorage` and rendered on the next visit
 * before any request goes out; the fetch then quietly corrects it. A price
 * ticker that spends two seconds as a dash on every page load is worse than
 * one that is thirty seconds stale, because the dash is what people remember.
 * The cache carries its own timestamp, so a genuinely old number can be shown
 * as old rather than as current.
 *
 * ## Market cap
 *
 * Supply is fixed at one billion and always has been, so market cap is price
 * times 1e9 with nothing to look up. Strictly this is fully-diluted value; with
 * a fixed supply and no vesting the two are the same number, and "market cap"
 * is the phrase people actually use.
 */
import { supabase } from "@/integrations/supabase/client";

/** Fixed at launch. See the token contract on Base. */
export const VIBE_SUPPLY = 1_000_000_000;

export const VIBE_CONTRACT = "0x7255ecf1020a95fed5323dd4feb23a54ab1aa7d1";

/** Where somebody goes to check any of this for themselves. */
export const VIBE_LINKS = {
  chart:
    "https://www.geckoterminal.com/base/pools/0xc3ad498815597f1e6f71d3cb1166856e947efb46",
  basescan: `https://basescan.org/token/${VIBE_CONTRACT}`,
  /** The post that launched it. */
  announcement: "https://x.com/VibeResidency/status/1985422002828542403",
} as const;

export interface VibeMarket {
  /** USD per VIBE. Null until the first successful read, ever. */
  usd: number | null;
  /** Percent, 24h. Null when the pool has not traded enough to have one. */
  change24h: number | null;
  /** Epoch ms of the reading, not of the render. */
  at: number;
  /** True while a request is in flight and we are showing a cached figure. */
  loading: boolean;
}

const KEY = "vibe.market.v1";
/** Older than this and the chip says so rather than implying it is live. */
export const STALE_AFTER_MS = 10 * 60_000;
/** Do not re-ask more often than this, however many components mount. */
const MIN_GAP_MS = 60_000;

let state: VibeMarket = { usd: null, change24h: null, at: 0, loading: false };
const listeners = new Set<(m: VibeMarket) => void>();
let lastFetch = 0;
let inFlight: Promise<VibeMarket> | null = null;

function readCache(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const c = JSON.parse(raw) as { usd: number; change24h: number | null; at: number };
    if (typeof c?.usd === "number" && Number.isFinite(c.usd)) {
      state = { usd: c.usd, change24h: c.change24h ?? null, at: c.at || 0, loading: false };
    }
  } catch {
    /* Somebody else's key or a half-written value. Start blank. */
  }
}
readCache();

function set(patch: Partial<VibeMarket>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}

export const getVibeMarket = (): VibeMarket => state;

export function subscribeVibeMarket(fn: (m: VibeMarket) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Fetch, unless we asked recently.
 *
 * Resolves either way and never rejects: every caller of this is a decoration
 * on a page that has to render regardless, and a price ticker is not worth an
 * error boundary. A failed read leaves the cached figure exactly where it was.
 */
export async function refreshVibeMarket(force = false): Promise<VibeMarket> {
  if (inFlight) return inFlight;
  if (!force && Date.now() - lastFetch < MIN_GAP_MS) return state;
  lastFetch = Date.now();
  set({ loading: true });

  inFlight = (async () => {
    try {
      const got = (await priceFromEdge()) ?? (await priceFromPool()) ?? (await priceFromScreener());
      if (!got) throw new Error("no price");
      const next: VibeMarket = { ...got, at: Date.now(), loading: false };
      set(next);
      try {
        localStorage.setItem(
          KEY,
          JSON.stringify({ usd: next.usd, change24h: next.change24h, at: next.at }),
        );
      } catch {
        /* Private browsing. The number is still on screen for this visit. */
      }
      return next;
    } catch {
      set({ loading: false });
      return state;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/* -------------------------------------------------------------------------- */
/* Sources, tried in order                                                     */
/*                                                                            */
/* The edge function was the only source, and for most first-time visitors     */
/* the chip read "$VIBE —" and stayed that way: a first visit has no cached     */
/* figure, so any miss on the one request (the function's own upstream read     */
/* coming back null, a preflight that never turns into a POST, a slow cold      */
/* start) was the whole story. Both public APIs below send                       */
/* `Access-Control-Allow-Origin: *`, so the browser asks them itself, from its  */
/* own IP, whenever the server-side read comes back empty.                      */
/* -------------------------------------------------------------------------- */

type Reading = { usd: number; change24h: number | null };

/** Walk third-party JSON without trusting its shape. */
function at(o: unknown, ...path: string[]): unknown {
  let v: unknown = o;
  for (const k of path) {
    if (v == null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

const POOL_ADDRESS = "0xc3ad498815597f1e6f71d3cb1166856e947efb46";

const finite = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const reading = (usd: unknown, change: unknown): Reading | null => {
  const u = finite(usd);
  return u != null && u > 0 ? { usd: u, change24h: finite(change) } : null;
};

/** A fetch that gives up, so one slow source cannot hold the next one back. */
async function getJson(url: string, ms = 5000): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
    return res.ok ? await res.json() : null;
  } finally {
    clearTimeout(t);
  }
}

async function priceFromEdge(): Promise<Reading | null> {
  try {
    const { data, error } = await supabase.functions.invoke("vibe-holdings", {
      // No addresses: this is the price-only call. The function answers it
      // without touching the chain at all, which is why it is quick.
      body: { addresses: [] },
    });
    if (error) return null;
    return reading(data?.data?.price?.usd, data?.data?.price?.change24h);
  } catch {
    return null;
  }
}

async function priceFromPool(): Promise<Reading | null> {
  try {
    const j = await getJson(
      `https://api.geckoterminal.com/api/v2/networks/base/pools/${POOL_ADDRESS}`,
    );
    return reading(
      at(j, "data", "attributes", "base_token_price_usd"),
      at(j, "data", "attributes", "price_change_percentage", "h24"),
    );
  } catch {
    return null;
  }
}

async function priceFromScreener(): Promise<Reading | null> {
  try {
    const j = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${VIBE_CONTRACT}`);
    const pairs = at(j, "pairs");
    if (!Array.isArray(pairs)) return null;
    /* The deepest pool is the honest price; a dust pair can be anywhere. */
    const pair = pairs
      .filter((p) => at(p, "chainId") === "base")
      .sort((a, b) => (finite(at(b, "liquidity", "usd")) ?? 0) - (finite(at(a, "liquidity", "usd")) ?? 0))[0];
    return pair ? reading(at(pair, "priceUsd"), at(pair, "priceChange", "h24")) : null;
  } catch {
    return null;
  }
}

export const marketCap = (usd: number | null): number | null =>
  usd == null ? null : usd * VIBE_SUPPLY;

/**
 * `$70.78K`, `$1.24M`, `$980`.
 *
 * Compact on purpose: this sits in a pill on a phone, and a market cap written
 * out in full is nine characters of which two carry information.
 */
export function formatUsdCompact(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}

/**
 * A price with as many decimals as it needs and no more.
 *
 * At a fraction of a cent, `toFixed(2)` is `$0.00` — which is not a rounding
 * error, it is the wrong answer. Significant figures rather than decimal
 * places.
 */
export function formatPrice(usd: number | null): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toPrecision(3)}`;
}

/** How many VIBE a dollar buys, for the explainer's worked example. */
export const vibePerUsd = (usd: number | null): number | null =>
  usd == null || usd <= 0 ? null : 1 / usd;
