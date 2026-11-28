-- The Vibe Arcade's high score wall (src/arcade/board.ts).
--
-- A game, three letters and a number. Deliberately nothing else: no user id,
-- no device id, the same rule `world_stats` follows. The wall can say that
-- somebody called "JCM" scored 18,400 at Mort Maze and cannot say who that was.
--
-- Additive only: a new table and two functions; nothing existing is touched.

create table if not exists public.arcade_scores (
  id          bigserial primary key,
  game        text not null check (game ~ '^[a-z0-9-]{1,24}$'),
  initials    text not null check (initials ~ '^[A-Z0-9]{3}$'),
  score       integer not null check (score >= 0),
  created_at  timestamptz not null default now()
);

create index if not exists arcade_scores_game_score on public.arcade_scores (game, score desc);
create index if not exists arcade_scores_created on public.arcade_scores (created_at desc);

alter table public.arcade_scores enable row level security;

drop policy if exists "arcade_scores readable" on public.arcade_scores;
create policy "arcade_scores readable" on public.arcade_scores for select using (true);
grant select on public.arcade_scores to anon, authenticated;

-- Which way each game's score runs, and the most it will take. Solitaire is a
-- time, so smaller is better.
create or replace function public.arcade_game_rule(p_game text, out asc_order boolean, out max_score integer)
language sql immutable as $$
  select
    p_game = 'solitaire',
    case p_game
      when 'mortmaze'  then 5000000
      when '2048'      then 10000000
      when 'coil'      then 1000000
      when 'boxing'    then 100000
      when 'hoops'     then 1000
      when 'pool'      then 10000
      when 'vibecup'   then 100000
      when 'solitaire' then 36000
      else null
    end
$$;

-- Sign the wall. The only way in: validates the game, the letters and the
-- score, and refuses when the whole arcade has signed more than sixty times in
-- a minute (there is nobody to rate-limit per person, by design).
create or replace function public.arcade_submit_score(p_game text, p_initials text, p_score integer)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  r record;
begin
  select * into r from public.arcade_game_rule(p_game);
  if r.max_score is null then return false; end if;
  if p_initials is null or p_initials !~ '^[A-Z0-9]{3}$' then return false; end if;
  if p_score is null or p_score < 0 or p_score > r.max_score then return false; end if;
  if p_game = 'solitaire' and p_score < 20 then return false; end if;
  if (select count(*) from public.arcade_scores where created_at > now() - interval '1 minute') >= 60 then
    return false;
  end if;
  insert into public.arcade_scores (game, initials, score) values (p_game, p_initials, p_score);
  return true;
end
$$;

-- The whole wall in one call: each game's top ten of all time, plus its best
-- three from the last day and a half so the page can pick today's champ in its
-- own time zone.
create or replace function public.arcade_board()
returns table (game text, initials text, score integer, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  with ranked as (
    select s.game, s.initials, s.score, s.created_at,
      row_number() over (partition by s.game order by
        case when s.game = 'solitaire' then s.score else -s.score end, s.created_at) as n
    from public.arcade_scores s
  ),
  recent as (
    select s.game, s.initials, s.score, s.created_at,
      row_number() over (partition by s.game order by
        case when s.game = 'solitaire' then s.score else -s.score end, s.created_at) as n
    from public.arcade_scores s
    where s.created_at > now() - interval '36 hours'
  )
  select ranked.game, ranked.initials, ranked.score, ranked.created_at from ranked where n <= 10
  union
  select recent.game, recent.initials, recent.score, recent.created_at from recent where n <= 3
$$;

revoke all on function public.arcade_submit_score(text, text, integer) from public;
grant execute on function public.arcade_submit_score(text, text, integer) to anon, authenticated;
grant execute on function public.arcade_board() to anon, authenticated;
