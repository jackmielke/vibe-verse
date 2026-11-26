-- Build mode: one row per prompt somebody typed into the world to change it.
--
-- The row is a ledger, not the source of truth for what happened: the GitHub
-- Actions run is. `vibe-build` refreshes status from GitHub whenever somebody
-- looks, so nothing here has to be written by the runner and the runner holds
-- no Supabase credentials at all.
--
-- RLS on, no policies: every read and write goes through the edge function
-- under the service role, after it has checked the caller is an admin.
create table if not exists public.vibe_builds (
  id uuid primary key default gen_random_uuid(),
  scope text not null default 'island',
  prompt text not null check (char_length(prompt) between 3 and 4000),
  route text,
  ship boolean not null default true,
  -- fast: Sonnet, fewer turns. smart: Opus, more room to think and check.
  mode text not null default 'fast' check (mode in ('fast', 'smart')),
  -- queued | running | shipped | ready | held | failed | nochange | merged | discarded
  status text not null default 'queued',
  branch text not null,
  run_id bigint,
  run_url text,
  summary text,
  head_sha text,
  requested_by uuid,
  requester_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vibe_builds_created_idx on public.vibe_builds (created_at desc);

alter table public.vibe_builds enable row level security;
