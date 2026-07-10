-- client_errors: the "loop learns from users" sink. The app forwards
-- captured client errors (render crashes, unhandled rejections, global
-- runtime errors) here so the autonomous build loop can read + triage
-- real user crashes. Write-only for clients (insert, no select).
create table if not exists public.client_errors (
  id uuid primary key default gen_random_uuid(),
  kind text,
  message text,
  stack text,
  extra text,
  url text,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table public.client_errors enable row level security;

drop policy if exists "clients can log errors" on public.client_errors;
create policy "clients can log errors" on public.client_errors
  for insert to anon, authenticated with check (true);

create index if not exists client_errors_created_at_idx
  on public.client_errors (created_at desc);
