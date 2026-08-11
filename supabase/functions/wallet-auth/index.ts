// wallet-auth — Supabase Edge Function
//
// "Continue with MetaMask", all the way to a real Supabase session.
//
// ## How this differs from `link-wallet`, which looks similar
//
// `link-wallet` answers *where do we send this person's tokens*. It writes a
// `wallet_address` onto a `users` row and hands back nothing you can log in
// with. This function answers *who is this*, and its output is a session: from
// here on the visitor is `auth.uid()`, RLS applies to them, and every other
// part of the app that already reads `supabase.auth` sees them without
// knowing a wallet was involved.
//
// ## Two calls
//
//   POST { action: "nonce",  address }
//     → { nonce, message, expiresAt }
//
//   POST { action: "verify", nonce, signature }
//     → { token_hash, address, isNewAccount }
//
// The browser signs `message` verbatim, posts the signature back, and trades
// the returned `token_hash` for a session with
// `supabase.auth.verifyOtp({ token_hash, type: "magiclink" })`.
//
// ## Why a token_hash and not a password
//
// The obvious shortcut is to give every wallet a deterministic password and
// call `signInWithPassword`. It works, and it means a permanent credential
// derived from a server secret sits on 89 accounts forever — leak the secret
// and every wallet account is open, with nothing to rotate. `generateLink`
// mints a single-use token that expires in minutes and is never stored
// anywhere. Same one round trip, nothing left behind.
//
// ## Why the server writes the message
//
// A signature over a sentence is a bearer token, so the sentence has to be
// ours and it has to be spendable once. The nonce row holds the exact bytes we
// issued; verification runs against those bytes, never against a string the
// client sent us. See the migration for the rest of that argument.
//
// Deploy:
//   supabase functions deploy wallet-auth --no-verify-jwt
//
// --no-verify-jwt because the whole point is that the caller has no session
// yet. The signature is the credential.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createPublicClient, getAddress, http, isAddress } from "npm:viem@2";
import { base } from "npm:viem@2/chains";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Long enough to read the prompt and find your hardware wallet; short enough
 *  that a nonce lifted off a screen is dead by the time it is used. */
const NONCE_TTL_MS = 10 * 60 * 1000;

/**
 * The domain half of the address a wallet account gets.
 *
 * Supabase keys users by email and a wallet has none, so every wallet account
 * carries a synthetic one: `0x<address>@wallet.vibeverse.id`. It is
 * deterministic (the same wallet always resolves to the same account), it is
 * never mailed, and `.id` is a real TLD we do not own — which is deliberate.
 * A synthetic address under a domain somebody else controls would let them
 * receive a password reset for one of our accounts.
 */
const WALLET_EMAIL_DOMAIN = "wallet.vibeverse.id";

/* Base mainnet, read-only. This function never sends a transaction and holds
 * no key — it reads the chain only to ask a smart-contract wallet whether it
 * recognises a signature as its own. */
const publicClient = createPublicClient({
  chain: base,
  transport: http(Deno.env.get("BASE_RPC_URL") || undefined),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json({ error: "Edge function is missing Supabase env." }, 500);
  }
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  try {
    if (body.action === "nonce") return await handleNonce(sb, req, body);
    if (body.action === "verify") return await handleVerify(sb, body);
    return json({ error: "action must be 'nonce' or 'verify'" }, 400);
  } catch (e) {
    console.error("wallet-auth failed", e);
    return json({ error: (e as Error)?.message ?? "unexpected error" }, 500);
  }
});

// ---------------------------------------------------------------------------
// 1. Mint a nonce and the message to sign
// ---------------------------------------------------------------------------

async function handleNonce(
  sb: ReturnType<typeof createClient>,
  req: Request,
  body: Record<string, unknown>,
): Promise<Response> {
  const raw = typeof body.address === "string" ? body.address : "";
  if (!isAddress(raw.toLowerCase())) {
    return json({ error: "a wallet address is required" }, 400);
  }
  const address = getAddress(raw.toLowerCase());

  /* Housekeeping, on the cheap path rather than a cron: expired nonces are
     worthless the moment they lapse and there is no audit value in keeping
     them. Failure here is not the caller's problem. */
  await sb
    .from("vibe_wallet_nonces")
    .delete()
    .lt("expires_at", new Date(Date.now() - NONCE_TTL_MS).toISOString());

  const nonce = crypto.randomUUID().replace(/-/g, "");
  const origin = originOf(req);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);
  const message = buildSignInMessage({ address, origin, nonce, issuedAt });

  const { error } = await sb.from("vibe_wallet_nonces").insert({
    nonce,
    address: address.toLowerCase(),
    message,
    origin,
    expires_at: expiresAt.toISOString(),
  });
  if (error) return json({ error: error.message }, 500);

  return json({ nonce, message, expiresAt: expiresAt.toISOString() });
}

/**
 * The sentence the human actually reads in the wallet prompt.
 *
 * Modelled on EIP-4361 (Sign-In with Ethereum) without claiming to be it: the
 * lines that matter to a person deciding whether to sign are the domain, the
 * address, and the promise that this is not a transaction. The two middle
 * lines exist because "sign this opaque hash" is how people get robbed, and a
 * wallet prompt is the last place anybody reads anything.
 */
function buildSignInMessage(opts: {
  address: string;
  origin: string;
  nonce: string;
  issuedAt: Date;
}): string {
  return [
    `${opts.origin} wants you to sign in with your Ethereum account:`,
    opts.address,
    "",
    "Welcome to the Vibeverse. Signing this proves you hold this wallet and",
    "signs you in. It is a signature, not a transaction — nothing moves out of",
    "your wallet and there is no fee.",
    "",
    "Chain: Base (8453)",
    `Nonce: ${opts.nonce}`,
    `Issued At: ${opts.issuedAt.toISOString()}`,
  ].join("\n");
}

/** Host of whoever asked, for the first line of the message. */
function originOf(req: Request): string {
  const header = req.headers.get("origin") ?? "";
  try {
    return new URL(header).host || "the Vibeverse";
  } catch {
    return "the Vibeverse";
  }
}

// ---------------------------------------------------------------------------
// 2. Verify the signature, hand back a session token
// ---------------------------------------------------------------------------

async function handleVerify(
  sb: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
): Promise<Response> {
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  if (!nonce || !signature.startsWith("0x")) {
    return json({ error: "nonce and signature are required" }, 400);
  }

  const { data: row } = await sb
    .from("vibe_wallet_nonces")
    .select("nonce, address, message, expires_at, used_at")
    .eq("nonce", nonce)
    .maybeSingle();

  if (!row || row.used_at || new Date(row.expires_at as string) < new Date()) {
    return json({ error: "that sign-in request expired — try again" }, 401);
  }

  const address = getAddress(row.address as string);

  /* Verify through the *client*, never viem's bare `verifyMessage` utility.
   *
   * The utility is plain ecrecover, which is only ever true for an EOA. A
   * Coinbase Smart Wallet or any other ERC-4337 account signs via ERC-1271
   * once deployed and ERC-6492 while still counterfactual, and ecrecover
   * rejects both — every passkey wallet would be turned away at the door.
   * `publicClient.verifyMessage` tries recovery first and falls back to asking
   * the chain, so one path covers MetaMask, Rabby and a smart account that has
   * never transacted. It costs one RPC round trip, which is the right price.
   *
   * Note it verifies against `row.message` — the bytes we issued — and not
   * against anything in this request body. */
  let ok = false;
  try {
    ok = await publicClient.verifyMessage({
      address,
      message: row.message as string,
      signature: signature as `0x${string}`,
    });
  } catch {
    ok = false;
  }
  if (!ok) return json({ error: "that signature did not verify" }, 401);

  /* Spend the nonce. One conditional UPDATE, so two tabs racing the same
     signature produce one winner — checking `used_at` in JS above and writing
     it here would be a read-modify-write with a network round trip in the
     middle, which is a race with a comfortable window. */
  const { data: spent } = await sb
    .from("vibe_wallet_nonces")
    .update({ used_at: new Date().toISOString() })
    .eq("nonce", nonce)
    .is("used_at", null)
    .select("nonce")
    .maybeSingle();
  if (!spent) return json({ error: "that sign-in request was already used" }, 401);

  const { authUserId, email, isNewAccount } = await resolveAccount(sb, address);

  /* The session, as a single-use token. `generateLink` does not send mail —
     it only mints — which is what makes it usable for an address that could
     never receive any. */
  const { data: link, error: linkErr } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr || !link?.properties?.hashed_token) {
    return json(
      { error: linkErr?.message ?? "could not start a session for that wallet" },
      500,
    );
  }

  return json({
    token_hash: link.properties.hashed_token,
    address,
    isNewAccount,
    authUserId,
  });
}

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

/**
 * Find the account this wallet signs into, creating one the first time.
 *
 * Three cases, in the order they are tried:
 *
 *  1. **The wallet is already on an account.** Somebody who linked MetaMask to
 *     their email account on `/wallet` can now sign in with it, and lands in
 *     that same account rather than a second empty one. This is the case worth
 *     getting right — the alternative silently forks a person in two.
 *  2. **There is a `users` row for the wallet but no auth account**, because
 *     `link-wallet` writes rows for wallets that never signed in. That row
 *     holds their name and their Vibecoin, so the new auth account *adopts* it
 *     rather than orphaning it. `handle_new_user` already knows how: pass
 *     `invited_user_id` and its trigger claims the existing row instead of
 *     inserting one.
 *  3. **Nobody has seen this wallet.** Make an account; the trigger makes the
 *     profile.
 */
async function resolveAccount(
  sb: ReturnType<typeof createClient>,
  address: string,
): Promise<{ authUserId: string; email: string; isNewAccount: boolean }> {
  const lower = address.toLowerCase();
  const walletEmail = `${lower}@${WALLET_EMAIL_DOMAIN}`;

  const { data: existing } = await sb
    .from("users")
    .select("id, auth_user_id, name")
    .eq("wallet_address", lower)
    .maybeSingle();

  // Case 1 — already an account. Use whatever email that account really has,
  // which for somebody who signed up by email is their actual address.
  if (existing?.auth_user_id) {
    const { data: got } = await sb.auth.admin.getUserById(
      existing.auth_user_id as string,
    );
    if (got?.user?.email) {
      await touchWallet(sb, existing.id as string, lower);
      return {
        authUserId: got.user.id,
        email: got.user.email,
        isNewAccount: false,
      };
    }
    /* An auth user with no email cannot be sent a magic link. That should not
       happen, but falling through to "make a fresh account" would be worse
       than saying so. */
    throw new Error("that wallet is on an account with no email address");
  }

  // Cases 2 and 3 — no auth account yet.
  const created = await sb.auth.admin.createUser({
    email: walletEmail,
    email_confirm: true,
    user_metadata: {
      wallet_address: lower,
      name: walletDisplayName(address),
      // Case 2: hand the trigger the row to claim. Undefined in case 3, and
      // the trigger treats missing and empty the same way.
      invited_user_id: existing?.id ?? undefined,
    },
  });

  if (created.data?.user) {
    const profileId =
      (existing?.id as string | undefined) ??
      (await profileIdFor(sb, created.data.user.id));
    if (profileId) await touchWallet(sb, profileId, lower);
    return { authUserId: created.data.user.id, email: walletEmail, isNewAccount: true };
  }

  /* Already registered — two first-time logins raced, or a previous attempt
     created the auth user and then failed before writing the wallet back.
     Either way the account exists under the synthetic address; find it by the
     email the trigger copied onto the profile. */
  const { data: byEmail } = await sb
    .from("users")
    .select("id, auth_user_id")
    .eq("email", walletEmail)
    .not("auth_user_id", "is", null)
    .maybeSingle();
  if (byEmail?.auth_user_id) {
    await touchWallet(sb, byEmail.id as string, lower);
    return {
      authUserId: byEmail.auth_user_id as string,
      email: walletEmail,
      isNewAccount: false,
    };
  }

  throw new Error(created.error?.message ?? "could not create an account for that wallet");
}

/** The profile row `handle_new_user` just made for a brand new auth user. */
async function profileIdFor(
  sb: ReturnType<typeof createClient>,
  authUserId: string,
): Promise<string | null> {
  const { data } = await sb
    .from("users")
    .select("id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/** Record the wallet on the profile. Idempotent; safe to run every sign-in. */
async function touchWallet(
  sb: ReturnType<typeof createClient>,
  profileId: string,
  lowerAddress: string,
): Promise<void> {
  await sb
    .from("users")
    .update({
      wallet_address: lowerAddress,
      wallet_provider: "eip1193",
      wallet_connected_at: new Date().toISOString(),
      is_claimed: true,
    })
    .eq("id", profileId);
}

/** "Vibe 0x7255…a7d1" — a name a person can recognise in a leaderboard. */
function walletDisplayName(address: string): string {
  return `Vibe ${address.slice(0, 6)}…${address.slice(-4)}`;
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
