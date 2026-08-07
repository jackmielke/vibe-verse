-- Real $VIBE sent from the vibeverse treasury to a player's own wallet.
--
-- This is the first table in the project that records something irreversible.
-- Everything else — vibe_balances, vibe_inventory — is a number we can edit.
-- A row here means a transaction went to Base and is not coming back, so the
-- table is shaped around making a double-send structurally impossible rather
-- than merely unlikely.
--
-- The primary key IS the lock. `vibe-drop` inserts the row BEFORE it signs
-- anything, so two tabs racing the same claim have one of them lose on a
-- primary-key violation while no money has moved. The alternative ordering —
-- send, then record — turns every timeout into a possible double-spend.
create table if not exists public.vibe_drops (
  -- Lowercased. One drop per address, forever; that is the whole point of it
  -- being the key rather than a column with an index bolted on later.
  address      text primary key,
  amount_wei   numeric not null,
  -- Set once the transaction is broadcast. NULL means the row was claimed and
  -- the send did not complete — a stuck claim, which is the safe failure: it
  -- blocks a retry rather than allowing a second send.
  tx_hash      text,
  status       text not null default 'claimed'
                 check (status in ('claimed', 'sent', 'failed')),
  error        text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);

alter table public.vibe_drops enable row level security;

-- Readable so a player can see their own drop landed and check it on Basescan.
-- Writable by nobody: only the edge function's service role touches this.
drop policy if exists "drops readable by all" on public.vibe_drops;
create policy "drops readable by all"
  on public.vibe_drops for select
  using (true);

-- The daily-cap query counts today's rows; without this it is a seq scan on a
-- table that only ever grows.
create index if not exists vibe_drops_created_at_idx
  on public.vibe_drops (created_at desc);

comment on table public.vibe_drops is
  'Real on-chain $VIBE sent by the treasury. One row per address, ever. Written only by the vibe-drop edge function; the primary key is the anti-double-send lock.';
