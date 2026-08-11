-- Sign in with a wallet: the nonce ledger.
--
-- A signature over a fixed sentence is a bearer token. Whoever holds it can
-- replay it forever, so "I signed something that mentions my address" is not a
-- login — it is a login *once*, and only if the server picked the sentence.
--
-- So the server writes the message. `wallet-auth nonce` mints a random nonce,
-- stores the exact bytes it wants signed, and hands them to the browser. At
-- verify time it does not parse anything back out of what the client returned;
-- it looks the nonce up and verifies the signature against the message it
-- issued. A client that edits so much as a space is verifying a message the
-- row does not contain, and fails.
--
-- `used_at` is what makes it once. Consumption is a single conditional UPDATE
-- (`used_at is null` in the WHERE), so two browsers racing the same nonce
-- produce one winner and one 401 rather than two sessions.
create table if not exists public.vibe_wallet_nonces (
  nonce       text primary key,
  -- Lowercased. The signature is checked against this address and no other,
  -- so a nonce minted for one wallet cannot be spent by another.
  address     text        not null,
  -- The exact bytes handed to the wallet. Verified against, never re-derived.
  message     text        not null,
  -- Which site asked. Recorded because it is baked into the message the human
  -- reads: a phishing page can request a nonce, but it cannot request one that
  -- says our domain while showing theirs.
  origin      text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

-- The sweep in the edge function deletes by expiry on every mint; without this
-- that is a sequential scan over every nonce ever issued.
create index if not exists vibe_wallet_nonces_expires_idx
  on public.vibe_wallet_nonces (expires_at);

-- RLS on with no policies at all: this table is reachable only by the service
-- role, which bypasses RLS. Nothing anon or authenticated can read a pending
-- nonce, which is the point — a readable nonce table is a login queue anybody
-- can watch.
alter table public.vibe_wallet_nonces enable row level security;

-- The address a wallet login resolves to. Already unique in practice; making
-- it so means two concurrent first-time logins from one wallet cannot create
-- two accounts.
--
-- On `lower()`, not the raw column: everything writes lowercase today, but a
-- checksummed 0xAbC and its lowercase twin are the same wallet and a plain
-- index would happily store both. Partial, because most rows (email signups,
-- Telegram imports) have no wallet — and null is not a duplicate of null
-- anyway, so the predicate is about index size rather than correctness.
create unique index if not exists users_wallet_address_key
  on public.users (lower(wallet_address))
  where wallet_address is not null;
