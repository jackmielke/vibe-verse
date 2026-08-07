-- Rock-paper-scissors against the house, on the Vibe Island plaza.
--
-- ## Why this table looks like this
--
-- Betting against a house only works if the house cannot see your throw and
-- then pick a winner. So a hand is TWO round trips with a commitment in
-- between: the server picks its throw and a nonce, stores both, and publishes
-- only `commit_hash = sha256(throw:nonce)`. You throw *after* seeing that hash.
-- On settle the server reveals throw and nonce and the browser re-hashes them
-- itself. A house that swapped its throw would publish a hash that no longer
-- matches, and every player could see it.
--
-- That is why `house_throw` and `nonce` are columns rather than something
-- derived: they have to exist, unread, before the player commits.
--
-- No select policy at all. A world-readable table would hand any player the
-- house's throw before they moved, which is the whole game.
create table if not exists public.vibe_rps_rounds (
  id           uuid primary key default gen_random_uuid(),
  owner_kind   text not null default 'user',
  owner_ref    text not null,

  -- Published at open. The player has this before they throw.
  commit_hash  text not null,
  -- Secret until settled.
  house_throw  text not null check (house_throw in ('rock','paper','scissors')),
  nonce        text not null,

  player_throw text check (player_throw in ('rock','paper','scissors')),
  outcome      text check (outcome in ('win','lose','push')),

  stake        numeric not null,
  payout       numeric not null default 0,

  -- The audit trail. Ledger Vibecoin is play money today, but the intent is
  -- that a real distribution could one day be computed from this history — so
  -- every hand records what $VIBE was worth at the moment it was played, and
  -- where the player would want a drop sent. Reconstructing that later from
  -- a chart is not possible; recording it now costs two columns.
  vibe_price_usd numeric,
  payout_address text,

  opened_at    timestamptz not null default now(),
  settled_at   timestamptz
);

-- One hand at a time, per player. This is the lock that makes the money safe:
-- `rps_open` inserts first and debits second, so a double-tapped button loses
-- on the unique index before a single coin moves. It also means an abandoned
-- hand is resumed rather than silently forfeited — you come back to the table
-- and your stake is still on it.
create unique index if not exists vibe_rps_one_open_hand
  on public.vibe_rps_rounds (owner_ref)
  where settled_at is null;

create index if not exists vibe_rps_recent
  on public.vibe_rps_rounds (owner_ref, opened_at desc);

alter table public.vibe_rps_rounds enable row level security;

comment on table public.vibe_rps_rounds is
  'Rock-paper-scissors vs the house. No select policy: house_throw and nonce are secret until the hand settles. Written only by the vibe-rounds edge function.';

-- The live $VIBE price, cached so a hand does not wait on GeckoTerminal and a
-- busy table does not hammer it. Read by the edge function only.
create table if not exists public.vibe_price_cache (
  symbol     text primary key,
  price_usd  numeric not null,
  fetched_at timestamptz not null default now()
);

alter table public.vibe_price_cache enable row level security;

drop policy if exists "price readable by all" on public.vibe_price_cache;
create policy "price readable by all"
  on public.vibe_price_cache for select
  using (true);
