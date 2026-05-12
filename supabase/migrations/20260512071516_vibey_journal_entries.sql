-- vibey_journal_entries
--
-- Stream-of-consciousness journal Vibey writes for himself while
-- visitors hang out in /space. One entry every ~10 minutes, sourced
-- from the Telegram messages flowing into Vibey's community plus a
-- count of new photos / events / members since the last entry.
--
-- Reads are public (anyone can watch the show); inserts are
-- service-role only (the vibey-journal edge function is the only
-- thing that can write).

create table if not exists public.vibey_journal_entries (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null,
  body text not null,
  mood text,                       -- "Angry" | "Surprised" | "Sad" | null
  source_summary text,             -- short human note, e.g. "3 new msgs, 1 photo"
  reflection_seed jsonb,           -- snapshot of what shaped this entry
  message_count integer default 0, -- how many telegram msgs fed this entry
  created_at timestamptz not null default now()
);

create index if not exists vibey_journal_entries_community_created_idx
  on public.vibey_journal_entries (community_id, created_at desc);

-- RLS: world-readable; only service role can insert.
alter table public.vibey_journal_entries enable row level security;

drop policy if exists "Vibey journal: anyone can read"
  on public.vibey_journal_entries;
create policy "Vibey journal: anyone can read"
  on public.vibey_journal_entries
  for select
  using (true);

drop policy if exists "Vibey journal: service role inserts"
  on public.vibey_journal_entries;
create policy "Vibey journal: service role inserts"
  on public.vibey_journal_entries
  for insert
  with check (auth.role() = 'service_role');

-- Enable realtime so /space watchers see new entries land live.
alter publication supabase_realtime add table public.vibey_journal_entries;
