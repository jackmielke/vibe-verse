-- vibe_visits — the first server-side record of where somebody has actually been.
--
-- The passport has existed for months and has never left the browser. That was
-- the right call when it was only a book of stamps: a visit is not worth a
-- round trip, and `localStorage` is exactly the scope of "the vibeverse".
--
-- Two things changed it.
--
--   * A passport in `localStorage` dies with the browser. Somebody who has been
--     to eighteen worlds on their laptop arrives on their phone as a stranger,
--     and the one record of a real relationship with the place is the one thing
--     that does not follow them.
--   * Nothing can PAY for a stamp the server cannot see. And walking into a
--     world is the only thing the numbers say people actually do: of 495
--     wallets, 491 sit at exactly the 100 they were given, one has ever gone
--     past it, and the richest holds 116. Every way to earn was buried inside
--     a world nobody reached, so the currency had a faucet and no pipe.
--
-- So this table is what makes exploring payable. It is deliberately the same
-- shape as `vibe_inventory`: the PRIMARY KEY is the anti-farm lock, not a
-- check-then-insert, because "have you been paid for this world" asked in the
-- application layer is a race and a race that pays twice is the bad kind.
create table if not exists public.vibe_visits (
  owner_kind text not null,
  owner_ref  text not null,
  -- The registry KEY, never the route. Routes move — `/hub` has already been
  -- three different places — and a payout keyed on one would pay again the day
  -- somebody renames a path.
  world_key  text not null,
  -- Stored so a stamp still reads as something after a world is renamed, the
  -- same reason the client-side stamp keeps one.
  name       text,
  first_seen timestamptz not null default now(),
  -- What this visit actually paid, once, ever. Kept per row rather than
  -- recomputed so the record survives a change to the payout constant: what
  -- somebody earned in August stays what they earned in August.
  paid       integer not null default 0,
  primary key (owner_kind, owner_ref, world_key)
);

-- "How many worlds has this wallet been paid for" is the question the milestone
-- arithmetic asks on every single visit, so it gets an index rather than a scan.
create index if not exists vibe_visits_owner_idx
  on public.vibe_visits (owner_kind, owner_ref);

alter table public.vibe_visits enable row level security;

-- Readable by anyone, writable by nobody — the same posture as vibe_balances
-- and vibe_inventory. Only the service role inside `vibe-economy` inserts here,
-- which is what stops a browser from stamping itself rich.
drop policy if exists "visits readable by all" on public.vibe_visits;
create policy "visits readable by all"
  on public.vibe_visits for select using (true);
