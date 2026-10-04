-- Horizon Garden: Jack's edits to the station text, layered over the defaults
-- baked into public/worlds/horizon/index.html. One row per station key; `fields`
-- holds only the fields that were changed (tagline, now, y5, y10, y50, insight,
-- move, notes). Anyone can read; only admins (public.is_admin()) can write.
create table if not exists public.horizon_stations (
  key text primary key,
  fields jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table public.horizon_stations enable row level security;

create policy "horizon_stations readable by everyone"
  on public.horizon_stations for select
  to anon, authenticated
  using (true);

create policy "horizon_stations insert by admins"
  on public.horizon_stations for insert
  to authenticated
  with check (public.is_admin());

create policy "horizon_stations update by admins"
  on public.horizon_stations for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select on public.horizon_stations to anon, authenticated;
grant insert, update on public.horizon_stations to authenticated;
