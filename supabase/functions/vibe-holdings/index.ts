// vibe-holdings — what a set of addresses actually holds, and what it is worth.
//
// POST { addresses: ["0x…", …] }
//   -> { price: { usd, change24h, fetchedAt }, holdings: { "0x…": { vibe, eth } } }
//
// ## Why this is a server function and not three lines of viem in the browser
//
// It was three lines of viem in the browser, and every balance on /wallet read
// as a dash. The public Base endpoint (`mainnet.base.org`) is rate-limited per
// IP and shared with every other tab on the visitor's machine; from a page it
// fails often enough that "your wallet is empty" became the normal state, which
// is the single worst thing a wallet screen can be wrong about. From here it is
// one server, one IP, one cacheable answer, and it can be tested — which the
// browser path could not be, from a container with no route to Base at all.
//
// The price rides along for the same reason: the alternative is the page making
// a second cross-origin request to GeckoTerminal to turn a token count into a
// dollar figure, and a dollar figure that arrives separately from the balance
// flickers.
//
// ## What it does not do
//
// Hold a key, sign anything, or move a token. Two reads and a public price.
// Sending lives in `vibe-drop`, which is a different function precisely so
// that the thing everyone calls is the thing that cannot spend anything.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VIBE_TOKEN = "0x7255ecf1020a95fed5323dd4feb23a54ab1aa7d1";
const VIBE_DECIMALS = 18;
const POOL =
  "https://api.geckoterminal.com/api/v2/networks/base/pools/0xc3ad498815597f1e6f71d3cb1166856e947efb46";

/** `balanceOf(address)`. */
const BALANCE_OF = "0x70a08231";

/** More than this and somebody is using the endpoint as a block explorer. */
const MAX_ADDRESSES = 12;

const RPCS = [
  Deno.env.get("BASE_RPC_URL"),
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
].filter(Boolean) as string[];

const isAddress = (s: unknown): s is string =>
  typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

/** wei (hex) → a JS number of whole tokens. */
function fromWei(hex: string | undefined, decimals: number): number | null {
  if (!hex || hex === "0x") return null;
  try {
    return Number(BigInt(hex)) / 10 ** decimals;
  } catch {
    return null;
  }
}

/**
 * One batched JSON-RPC round trip for every read, with endpoint failover.
 *
 * Batching matters more than it looks: a dozen addresses is 24 reads, and 24
 * separate requests to a shared public endpoint is exactly the pattern that
 * gets rate-limited. One array is one request.
 */
async function rpcBatch(calls: unknown[]): Promise<Record<number, string>> {
  let lastError: unknown = null;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(calls),
      });
      if (!res.ok) throw new Error(`${url} → ${res.status}`);
      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error(`${url} did not batch`);
      const out: Record<number, string> = {};
      for (const r of rows) {
        if (r && typeof r.id === "number" && typeof r.result === "string") {
          out[r.id] = r.result;
        }
      }
      return out;
    } catch (e) {
      // Try the next endpoint rather than failing the page. A wallet screen
      // showing dashes because one public RPC was busy is the bug this
      // function exists to fix; repeating it here would be absurd.
      lastError = e;
    }
  }
  throw new Error(`no Base RPC answered: ${String(lastError)}`);
}

async function fetchPrice() {
  try {
    const res = await fetch(POOL, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const a = (await res.json())?.data?.attributes ?? {};
    const usd = Number(a.base_token_price_usd);
    if (!Number.isFinite(usd)) return null;
    return {
      usd,
      change24h: Number(a.price_change_percentage?.h24 ?? NaN) || null,
      fetchedAt: Date.now(),
    };
  } catch {
    // A balance with no dollar figure beside it is still a balance.
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const raw = Array.isArray(body?.addresses) ? body.addresses : [];
    const addresses = [
      ...new Set(raw.filter(isAddress).map((a: string) => a.toLowerCase())),
    ].slice(0, MAX_ADDRESSES);

    // The price is worth answering even with no addresses — the coin page and
    // the shop both want it, and an empty book still shows a market.
    const price = await fetchPrice();
    if (addresses.length === 0) {
      return json({ ok: true, data: { price, holdings: {} } });
    }

    const calls: unknown[] = [];
    addresses.forEach((addr, i) => {
      calls.push({
        jsonrpc: "2.0",
        id: i * 2,
        method: "eth_call",
        params: [
          { to: VIBE_TOKEN, data: BALANCE_OF + addr.slice(2).padStart(64, "0") },
          "latest",
        ],
      });
      calls.push({
        jsonrpc: "2.0",
        id: i * 2 + 1,
        method: "eth_getBalance",
        params: [addr, "latest"],
      });
    });

    const results = await rpcBatch(calls);
    const holdings: Record<string, { vibe: number | null; eth: number | null }> = {};
    addresses.forEach((addr, i) => {
      holdings[addr] = {
        vibe: fromWei(results[i * 2], VIBE_DECIMALS),
        eth: fromWei(results[i * 2 + 1], 18),
      };
    });

    return json({ ok: true, data: { price, holdings } });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
