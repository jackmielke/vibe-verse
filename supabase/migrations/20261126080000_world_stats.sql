-- Scores and playtime for every world, kept anonymous by construction.
--
-- There is no per-player or per-session table. A browser keeps its own
-- running count in memory, adds it to the world's totals once a minute, and
-- forgets it. "Players" is a tally, bumped once per device per world from a
-- flag the device keeps for itself; nothing on this side can say who that was.
-- Ratings work the same way: three running sums and three counts per world.

create table if not exists public.world_stats (
  world_key     text primary key check (world_key ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  play_seconds  bigint not null default 0,
  players       integer not null default 0,
  sessions      integer not null default 0,
  fps_sum       double precision not null default 0,
  fps_n         integer not null default 0,
  lore_sum      integer not null default 0,
  lore_n        integer not null default 0,
  fun_sum       integer not null default 0,
  fun_n         integer not null default 0,
  smooth_sum    integer not null default 0,
  smooth_n      integer not null default 0,
  updated_at    timestamptz not null default now()
);

alter table public.world_stats enable row level security;

-- Totals are public. Nobody writes the table directly; the two functions below
-- are the only way in, and they only ever add to a sum.
drop policy if exists "world_stats readable" on public.world_stats;
create policy "world_stats readable" on public.world_stats for select using (true);
grant select on public.world_stats to anon, authenticated;

create or replace function public.world_stats_add_play(
  p_world text,
  p_seconds integer,
  p_new_player boolean default false,
  p_new_session boolean default false,
  p_fps real default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  secs integer := greatest(0, least(coalesce(p_seconds, 0), 120));
  fps  real := case when p_fps between 1 and 360 then p_fps else null end;
begin
  if p_world is null or p_world !~ '^[a-z0-9][a-z0-9-]{0,47}$' then return; end if;
  if secs = 0 and not coalesce(p_new_player, false) and not coalesce(p_new_session, false) then return; end if;
  insert into public.world_stats as s (world_key, play_seconds, players, sessions, fps_sum, fps_n)
  values (p_world, secs, case when p_new_player then 1 else 0 end, case when p_new_session then 1 else 0 end,
          coalesce(fps, 0), case when fps is null then 0 else 1 end)
  on conflict (world_key) do update set
    play_seconds = s.play_seconds + excluded.play_seconds,
    players      = s.players + excluded.players,
    sessions     = s.sessions + excluded.sessions,
    fps_sum      = s.fps_sum + excluded.fps_sum,
    fps_n        = s.fps_n + excluded.fps_n,
    updated_at   = now();
end $$;

create or replace function public.world_stats_rate(
  p_world text,
  p_lore smallint default null,
  p_fun smallint default null,
  p_smooth smallint default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l smallint := case when p_lore between 1 and 5 then p_lore end;
  f smallint := case when p_fun between 1 and 5 then p_fun end;
  m smallint := case when p_smooth between 1 and 5 then p_smooth end;
begin
  if p_world is null or p_world !~ '^[a-z0-9][a-z0-9-]{0,47}$' then return; end if;
  if l is null and f is null and m is null then return; end if;
  insert into public.world_stats as s (world_key, lore_sum, lore_n, fun_sum, fun_n, smooth_sum, smooth_n)
  values (p_world, coalesce(l, 0), (l is not null)::int, coalesce(f, 0), (f is not null)::int,
          coalesce(m, 0), (m is not null)::int)
  on conflict (world_key) do update set
    lore_sum   = s.lore_sum + excluded.lore_sum,
    lore_n     = s.lore_n + excluded.lore_n,
    fun_sum    = s.fun_sum + excluded.fun_sum,
    fun_n      = s.fun_n + excluded.fun_n,
    smooth_sum = s.smooth_sum + excluded.smooth_sum,
    smooth_n   = s.smooth_n + excluded.smooth_n,
    updated_at = now();
end $$;

revoke all on function public.world_stats_add_play(text, integer, boolean, boolean, real) from public;
revoke all on function public.world_stats_rate(text, smallint, smallint, smallint) from public;
grant execute on function public.world_stats_add_play(text, integer, boolean, boolean, real) to anon, authenticated;
grant execute on function public.world_stats_rate(text, smallint, smallint, smallint) to anon, authenticated;
