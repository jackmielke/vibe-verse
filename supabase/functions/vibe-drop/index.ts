// vibe-drop — the first thing in the vibeverse that spends real money.
//
//   POST { action: "status" }             -> is it armed, what is in the till
//   POST { action: "claim", address }     -> sends the drop, once, ever
//
// ## Read this before touching anything below
//
// Every other function in this project moves numbers in Postgres. This one
// signs an Ethereum transaction with a private key and broadcasts it to Base.
// A bug here does not corrupt a balance we can fix with an UPDATE; it sends
// somebody else's money to a stranger and there is no appeal. So it is built
// with the assumption that it will be attacked and that it will crash halfway.
//
// Five things hold it together, in the order they run:
//
//  1. **It only pays addresses that were proved.** The address must already
//     exist in `users.wallet_address`, which `link-wallet` only writes after
//     verifying a signature over a sentence. You cannot be paid at an address
//     you have not demonstrated you control. This is what stops the endpoint
//     from being a "send $VIBE to any address I name" API.
//
//  2. **One per address, forever.** Enforced by the PRIMARY KEY on
//     `vibe_drops.address`, not by a SELECT-then-INSERT. Two tabs racing the
//     same claim means one INSERT fails.
//
//  3. **Claim before send.** The row goes in FIRST, then the key signs. If the
//     broadcast times out, the claim is already there and a retry is refused.
//     A stuck claim is the safe failure — it withholds a drop that may have
//     landed. The other ordering turns every timeout into a double-send.
//
//  4. **A daily ceiling and a treasury floor.** The amount is a server
//     constant the client cannot name; DROPS_PER_DAY bounds the blast radius
//     of anything that gets past 1 and 2; and the treasury refuses to go below
//     TREASURY_FLOOR so a runaway cannot empty it.
//
//  5. **It refuses to work until it is deliberately armed.** With no
//     `VIBE_TREASURY_PRIVATE_KEY` set it answers `armed: false` and sends
//     nothing. Deploying this file does not switch anything on.
//
// ## What is deliberately NOT here
//
// Variable amounts, recipient lists, an admin override, a "resend" action.
// Every one of those is a hole, and none of them is needed to prove a drop
// works — which is the entire job of this function.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseUnits,
  formatUnits,
} from "npm:viem@2";
import { privateKeyToAccount } from "npm:viem@2/accounts";
import { base } from "npm:viem@2/chains";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VIBE_TOKEN = "0x7255ecf1020a95fed5323dd4feb23a54ab1aa7d1" as const;
const VIBE_DECIMALS = 18;

/**
 * How much one drop is.
 *
 * A server constant, never a request field. At roughly $0.00015 a token this
 * is somewhere around fifteen cents — deliberately small: the point of a test
 * drop is to prove the pipe works end to end and put a real transaction in
 * somebody's wallet, not to be worth farming.
 */
const DROP_TOKENS = 1000;

/** Blast radius if rules 1 and 2 are ever both wrong at once. */
const DROPS_PER_DAY = 50;

/** The treasury will not spend below this. */
const TREASURY_FLOOR = 10_000;

const ERC20 = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const rpc = Deno.env.get("BASE_RPC_URL") || undefined;
const publicClient = createPublicClient({ chain: base, transport: http(rpc) });

/** The treasury account, or null when the function has not been armed. */
function treasury() {
  const key = Deno.env.get("VIBE_TREASURY_PRIVATE_KEY");
  if (!key) return null;
  const hex = (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) return null;
  try {
    return privateKeyToAccount(hex);
  } catch {
    return null;
  }
}

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

type Supa = ReturnType<typeof createClient>;

async function treasuryBalances(address: `0x${string}`) {
  const [vibe, eth] = await Promise.all([
    publicClient
      .readContract({
        address: VIBE_TOKEN,
        abi: ERC20,
        functionName: "balanceOf",
        args: [address],
      })
      .then((r) => Number(formatUnits(r as bigint, VIBE_DECIMALS)))
      .catch(() => null),
    publicClient
      .getBalance({ address })
      .then((r) => Number(formatUnits(r, 18)))
      .catch(() => null),
  ]);
  return { vibe, eth };
}

/**
 * What the page needs to draw an honest button: whether it can work at all,
 * what one drop is, and whether this address has already had one.
 */
async function status(supabase: Supa, addressIn: unknown) {
  const account = treasury();
  const address =
    typeof addressIn === "string" && /^0x[0-9a-fA-F]{40}$/.test(addressIn)
      ? addressIn.toLowerCase()
      : null;

  let claimed = false;
  let txHash: string | null = null;
  if (address) {
    const { data } = await supabase
      .from("vibe_drops")
      .select("status, tx_hash")
      .eq("address", address)
      .maybeSingle();
    claimed = !!data;
    txHash = (data?.tx_hash as string) ?? null;
  }

  if (!account) {
    return {
      armed: false,
      reason: "no treasury key set — nothing can be sent yet",
      dropTokens: DROP_TOKENS,
      claimed,
      txHash,
    };
  }

  const bal = await treasuryBalances(account.address);
  const { count } = await supabase
    .from("vibe_drops")
    .select("address", { count: "exact", head: true })
    .gte("created_at", utcMidnight());

  return {
    armed: true,
    treasury: account.address,
    dropTokens: DROP_TOKENS,
    treasuryVibe: bal.vibe,
    treasuryEth: bal.eth,
    // Both have to be true or the send fails on chain rather than here, and
    // the page should say which one is missing before somebody taps.
    fundedForDrops: (bal.vibe ?? 0) >= DROP_TOKENS + TREASURY_FLOOR,
    fundedForGas: (bal.eth ?? 0) >= 0.00002,
    dropsToday: count ?? 0,
    dropsPerDay: DROPS_PER_DAY,
    claimed,
    txHash,
  };
}

function utcMidnight(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

async function claim(supabase: Supa, addressIn: unknown) {
  const account = treasury();
  if (!account) throw new Error("drops are not switched on yet");

  if (typeof addressIn !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(addressIn)) {
    throw new Error("a wallet address is required");
  }
  const to = getAddress(addressIn);
  const key = to.toLowerCase();

  // RULE 1 — only an address that proved itself. `link-wallet` writes this row
  // and only after verifying a signature, so this is what stops the function
  // being a "send $VIBE anywhere" endpoint.
  const { data: proved } = await supabase
    .from("users")
    .select("id")
    .ilike("wallet_address", key)
    .limit(1)
    .maybeSingle();
  if (!proved) {
    throw new Error("link that wallet first — a drop only goes to a proved address");
  }

  // RULE 4a — the daily ceiling, checked before the claim so a burst cannot
  // leave a trail of stuck rows behind it.
  const { count } = await supabase
    .from("vibe_drops")
    .select("address", { count: "exact", head: true })
    .gte("created_at", utcMidnight());
  if ((count ?? 0) >= DROPS_PER_DAY) {
    throw new Error("the treasury has done its drops for today — try tomorrow");
  }

  // RULE 4b — the treasury floor, and enough gas to actually broadcast.
  const bal = await treasuryBalances(account.address);
  if ((bal.vibe ?? 0) < DROP_TOKENS + TREASURY_FLOOR) {
    throw new Error("the treasury is out of $VIBE");
  }
  if ((bal.eth ?? 0) < 0.00002) {
    throw new Error("the treasury has no ETH for gas");
  }

  const amountWei = parseUnits(String(DROP_TOKENS), VIBE_DECIMALS);

  // RULES 2 and 3 — claim first. This INSERT is the lock; if it fails, either
  // this address already had its drop or two tabs raced and one lost. Either
  // way no key has been touched yet.
  const { error: taken } = await supabase.from("vibe_drops").insert({
    address: key,
    amount_wei: amountWei.toString(),
    status: "claimed",
  });
  if (taken) throw new Error("that wallet has already had its drop");

  try {
    const wallet = createWalletClient({ account, chain: base, transport: http(rpc) });
    const hash = await wallet.sendTransaction({
      to: VIBE_TOKEN,
      data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to, amountWei] }),
    });
    await supabase
      .from("vibe_drops")
      .update({ status: "sent", tx_hash: hash, sent_at: new Date().toISOString() })
      .eq("address", key);
    return { txHash: hash, amount: DROP_TOKENS, to };
  } catch (e) {
    /* The claim STAYS. It is tempting to delete it so the player can retry,
       and that is exactly the bug: a send that threw may still have been
       broadcast, and a retry would then pay twice. Record why and stop. */
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    await supabase.from("vibe_drops").update({ status: "failed", error: msg }).eq("address", key);
    throw new Error(`the send did not go through: ${msg}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const body = await req.json().catch(() => ({}));
    switch (body?.action) {
      case "status":
        return json({ ok: true, data: await status(supabase, body.address) });
      case "claim":
        return json({ ok: true, data: await claim(supabase, body.address) });
      default:
        return json({ ok: false, error: `unknown action: ${body?.action}` }, 400);
    }
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
