-- One row per guest wallet that has been absorbed into an account.
--
-- The guest ref is the PRIMARY KEY, which is the whole point: "this wallet has
-- already been claimed" becomes a uniqueness violation on insert rather than a
-- select-then-insert, and two tabs racing the same merge cannot both win.
--
-- It is not a ledger row because a claim is not a transfer — and because
-- vibe_ledger CHECKs amount > 0, so an empty guest wallet (the common case:
-- someone signs in before they play) could not be recorded there at all.
create table if not exists public.vibe_guest_claims (
  guest_ref   text primary key,
  account_ref text not null,
  amount      numeric not null default 0,
  items_moved integer not null default 0,
  claimed_at  timestamptz not null default now()
);

alter table public.vibe_guest_claims enable row level security;

drop policy if exists "guest claims readable by all" on public.vibe_guest_claims;
create policy "guest claims readable by all"
  on public.vibe_guest_claims for select
  using (true);

comment on table public.vibe_guest_claims is
  'Guest wallets already merged into an account. Written only by vibe-economy.';
