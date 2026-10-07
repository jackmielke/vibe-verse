-- Horizon Garden goes social: who has walked where, and notes left at each monument.
-- Visitors are anonymous device ids (localStorage), optionally with a name they
-- typed. Anyone can read and add; only admins (public.is_admin()) can hide or
-- delete. Live positions are not stored at all: they ride a Realtime broadcast.
create table if not exists public.horizon_visits (
  visitor text not null check (length(visitor) between 8 and 64),
  station_key text not null check (station_key ~ '^[a-z]{2,24}$'),
  day date not null default current_date,
  name text check (name is null or length(name) <= 40),
  created_at timestamptz not null default now(),
  primary key (visitor, station_key, day)
);
create index if not exists horizon_visits_day on public.horizon_visits (day desc);
alter table public.horizon_visits enable row level security;
create policy "horizon_visits readable by everyone" on public.horizon_visits for select to anon, authenticated using (true);
create policy "horizon_visits anyone can log a visit" on public.horizon_visits for insert to anon, authenticated with check (day = current_date);
create policy "horizon_visits delete by admins" on public.horizon_visits for delete to authenticated using (public.is_admin());
grant select, insert on public.horizon_visits to anon, authenticated;
grant delete on public.horizon_visits to authenticated;

create table if not exists public.horizon_comments (
  id uuid primary key default gen_random_uuid(),
  station_key text not null check (station_key ~ '^[a-z]{2,24}$'),
  visitor text not null check (length(visitor) between 8 and 64),
  name text not null check (length(name) between 1 and 40),
  body text not null check (length(body) between 1 and 500),
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists horizon_comments_station on public.horizon_comments (station_key, created_at desc);
alter table public.horizon_comments enable row level security;
create policy "horizon_comments visible unless hidden" on public.horizon_comments for select to anon, authenticated using (not hidden or public.is_admin());
create policy "horizon_comments anyone can leave a note" on public.horizon_comments for insert to anon, authenticated with check (hidden = false);
create policy "horizon_comments update by admins" on public.horizon_comments for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "horizon_comments delete by admins" on public.horizon_comments for delete to authenticated using (public.is_admin());
grant select, insert on public.horizon_comments to anon, authenticated;
grant update, delete on public.horizon_comments to authenticated;
