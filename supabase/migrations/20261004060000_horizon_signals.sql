-- Horizon Garden signals: dated evidence that moves a station's timeline.
-- The daily digest files them each morning (as postgres, via the Supabase MCP);
-- Jack edits, hides or adds them in place from the world's Edit mode. Each one
-- grows a flower at its station, so the garden fills in as the year goes.
create table if not exists public.horizon_signals (
  id uuid primary key default gen_random_uuid(),
  station_key text not null,
  day date not null default current_date,
  headline text not null,
  why text not null default '',
  era text not null default 'y5' check (era in ('now','y5','y10','y50')),
  direction text not null default 'confirms' check (direction in ('sooner','later','confirms')),
  url text,
  source text not null default 'digest',
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  unique (station_key, day, headline)
);
create index if not exists horizon_signals_station_day on public.horizon_signals (station_key, day desc);
alter table public.horizon_signals enable row level security;

create policy "horizon_signals visible to everyone unless hidden"
  on public.horizon_signals for select to anon, authenticated
  using (not hidden or public.is_admin());
create policy "horizon_signals insert by admins"
  on public.horizon_signals for insert to authenticated with check (public.is_admin());
create policy "horizon_signals update by admins"
  on public.horizon_signals for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "horizon_signals delete by admins"
  on public.horizon_signals for delete to authenticated using (public.is_admin());

grant select on public.horizon_signals to anon, authenticated;
grant insert, update, delete on public.horizon_signals to authenticated;
