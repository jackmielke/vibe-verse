// link-wallet — Supabase Edge Function
//
// Verifies a SIWE-style signature proving the caller controls a Base
// wallet address, then upserts the wallet into a public `users` row.
//
// Request body:
//   {
//     "address":      "0x...",            // EIP-55 or lowercase
//     "message":      "<exact message that was signed>",
//     "signature":    "0x...",            // 65-byte personal_sign
//     "community_id": "<uuid>",           // optional, defaults below
//     "display_name": "Alex",             // optional, used if creating new
//     "avatar_url":   "https://..."       // optional
//   }
//
// On success returns the (sanitized) users row.
//
// Deploy:
//   supabase functions deploy link-wallet --no-verify-jwt
//
// We use --no-verify-jwt because the wallet signature IS the auth —
// we don't require a Supabase session at all.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { verifyMessage, getAddress, isAddress } from "npm:viem@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_COMMUNITY = "4202857f-13fd-4407-8906-3f8ffe63e510";

// Don't accept signatures older than this — protects against
// replay-after-leak. Signatures must be issued within the last hour.
const MAX_AGE_MS = 60 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }
  if (req.method !== "POST") {
    return json({ error: "POST only" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json({ error: "Edge function is missing Supabase env." }, 500);
  }

  let body: {
    address?: unknown;
    message?: unknown;
    signature?: unknown;
    community_id?: unknown;
    display_name?: unknown;
    avatar_url?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const addressIn = typeof body.address === "string" ? body.address : "";
  const message = typeof body.message === "string" ? body.message : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  if (!isAddress(addressIn) || !message || !signature.startsWith("0x")) {
    return json({ error: "address, message, and signature are required" }, 400);
  }
  const address = getAddress(addressIn);

  // The message must mention the address — defends against signing
  // an unrelated message and claiming a different wallet.
  if (!message.toLowerCase().includes(address.toLowerCase())) {
    return json({ error: "message does not reference address" }, 400);
  }

  // Extract Issued At from the message body and reject stale sigs.
  const issuedMatch = message.match(/Issued At:\s*(\S+)/);
  if (issuedMatch) {
    const issuedAt = Date.parse(issuedMatch[1]);
    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > MAX_AGE_MS) {
      return json({ error: "signature too old, please re-sign" }, 400);
    }
  }

  // Verify the signature cryptographically. viem's verifyMessage
  // handles both EOA personal_sign and ERC-1271 smart-wallet sigs.
  let ok = false;
  try {
    ok = await verifyMessage({
      address,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    ok = false;
  }
  if (!ok) {
    return json({ error: "signature did not verify" }, 401);
  }

  // All verified. Upsert into `users` by wallet_address.
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const displayName = typeof body.display_name === "string" ? body.display_name.slice(0, 80) : null;
  const avatarUrl = typeof body.avatar_url === "string" ? body.avatar_url.slice(0, 500) : null;

  // Find existing user by wallet_address first.
  const { data: existing } = await sb
    .from("users")
    .select("id, name, avatar_url, username, telegram_username")
    .eq("wallet_address", address.toLowerCase())
    .maybeSingle();

  let row;
  if (existing) {
    // Touch the connection timestamp. Only patch name/avatar if
    // the user explicitly sent them this round AND we don't already
    // have a value (so we never clobber a Telegram-set name).
    const patch: Record<string, unknown> = {
      wallet_connected_at: new Date().toISOString(),
      wallet_provider: "eip1193",
    };
    if (displayName && !existing.name) patch.name = displayName;
    if (avatarUrl && !existing.avatar_url) patch.avatar_url = avatarUrl;
    const upd = await sb
      .from("users")
      .update(patch)
      .eq("id", existing.id)
      .select("id, name, username, avatar_url, wallet_address, wallet_connected_at")
      .single();
    if (upd.error) return json({ error: upd.error.message }, 500);
    row = upd.data;
  } else {
    const ins = await sb
      .from("users")
      .insert({
        wallet_address: address.toLowerCase(),
        wallet_provider: "eip1193",
        wallet_connected_at: new Date().toISOString(),
        name: displayName,
        avatar_url: avatarUrl,
        is_claimed: true,
      })
      .select("id, name, username, avatar_url, wallet_address, wallet_connected_at")
      .single();
    if (ins.error) return json({ error: ins.error.message }, 500);
    row = ins.data;
  }

  return json({ ok: true, user: row });
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
