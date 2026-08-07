-- Staked rounds, and the invite codes that fund people to enter them.
--
-- RLS here is NOT the usual "readable by all" the rest of the vibe_* family
-- uses, and the difference matters:
--
--   * vibe_invites / vibe_invite_claims have NO select policy at all. An invite
--     code is a bearer secret — if the table were world-readable, anyone with
--     the anon key could list every outstanding code and claim the lot. Only
--     the edge function (service role, which bypasses RLS) can read them.
--   * vibe_rounds has no select policy either, because it holds the SEED. Every
--     player in a round faces the same gate layout, so knowing the seed before
--     you stake lets you practise the exact run you are about to bet on. The
--     edge function hands the seed out only after you have entered.
--   * vibe_round_entries IS public: a leaderboard is the point, and it carries
--     no seed.

create table if not exists public.vibe_rounds (
  id          uuid primary key default gen_random_uuid(),
  game        text not null default 'orbit',
  title       text not null default 'Open round',
  -- The shared challenge. Same seed, same gates, for everyone in the round.
  seed        text not null,
  stake       numeric not null default 25,
  status      text not null default 'open' check (status in ('open','settled','void')),
  opens_at    timestamptz not null default now(),
  closes_at   timestamptz not null,
  winner_ref  text,
  payout      numeric,
  settled_at  timestamptz
);

create table if not exists public.vibe_round_entries (
  round_id     uuid not null references public.vibe_rounds(id) on delete cascade,
  owner_kind   text not null default 'user',
  owner_ref    text not null,
  display_name text,
  best_score   integer not null default 0,
  plays        integer not null default 0,
  staked       numeric not null default 0,
  entered_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (round_id, owner_ref)
);

create index if not exists vibe_round_entries_board
  on public.vibe_round_entries (round_id, best_score desc);

create table if not exists public.vibe_invites (
  code          text primary key,
  grant_amount  numeric not null default 100,
  max_claims    integer not null default 1,
  claims        integer not null default 0,
  note          text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz
);

create table if not exists public.vibe_invite_claims (
  code       text not null references public.vibe_invites(code) on delete cascade,
  owner_ref  text not null,
  amount     numeric not null default 0,
  claimed_at timestamptz not null default now(),
  primary key (code, owner_ref)
);

alter table public.vibe_rounds        enable row level security;
alter table public.vibe_round_entries enable row level security;
alter table public.vibe_invites       enable row level security;
alter table public.vibe_invite_claims enable row level security;

-- The only public read in here. Scores are meant to be seen.
drop policy if exists "round entries readable by all" on public.vibe_round_entries;
create policy "round entries readable by all"
  on public.vibe_round_entries for select
  using (true);

comment on column public.vibe_rounds.seed is
  'Shared gate layout. Never exposed to a client that has not entered the round.';
comment on table public.vibe_invites is
  'Bearer codes. Deliberately has no select policy — see the migration header.';
