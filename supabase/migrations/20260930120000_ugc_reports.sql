-- Reports and blocks from players (App Store Guideline 1.2).
-- Written only by the ugc-report edge function with the service role; RLS on,
-- no policies, so nothing in a browser can read or write it directly.
create table if not exists public.ugc_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('report', 'block')),
  reason text,
  world text,
  path text,
  target_name text,
  target_id text,
  content text,
  reporter_device text,
  reporter_user uuid,
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  notes text
);
alter table public.ugc_reports enable row level security;
create index if not exists ugc_reports_open_idx on public.ugc_reports (created_at desc) where status = 'open';
