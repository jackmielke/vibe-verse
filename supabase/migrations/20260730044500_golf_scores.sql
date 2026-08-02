-- golf_scores: the Vibe Golf leaderboard sink.
--
-- One row per *completed course round* submitted from the client. The board is
-- read-only public; anyone (anon or authenticated) may insert their own round,
-- and nobody may update or delete — an append-only score table is both the
-- simplest thing that works and the hardest to grief.
--
-- The game degrades silently to local-only play if this table is absent, so
-- applying this migration is optional for development and required only for
-- production leaderboards.
create table if not exists public.golf_scores (
  id uuid primary key default gen_random_uuid(),
  -- Course.id from src/golf/course/holes.ts (e.g. 'sunset-links').
  course_id text not null check (char_length(course_id) between 1 and 64),
  course_name text check (char_length(course_name) <= 64),
  -- Resolved vibeverse display name, or the guest name typed in-game.
  player_name text not null default 'Guest'
    check (char_length(player_name) between 1 and 32),
  -- Present only when the submitter was signed in; guests submit with null.
  auth_user_id uuid references auth.users(id) on delete set null,
  -- Stable per-device id so the client can highlight "you" without an account.
  client_id text check (char_length(client_id) <= 64),
  strokes integer not null check (strokes > 0 and strokes < 1000),
  par integer not null check (par > 0 and par < 1000),
  holes integer not null default 0 check (holes >= 0 and holes <= 64),
  stars integer not null default 0 check (stars >= 0 and stars <= 192),
  -- Compact ghost replay: { holeId, strokes, shots: int[] } — 5 ints per shot
  -- (x*100, y*100, angle*1000, power*1000, ballTypeIndex).
  ghost jsonb,
  created_at timestamptz not null default now()
);

alter table public.golf_scores enable row level security;

-- Public read: the leaderboard is meant to be seen by everyone, signed in or not.
drop policy if exists "golf scores are public" on public.golf_scores;
create policy "golf scores are public" on public.golf_scores
  for select to anon, authenticated using (true);

-- Insert only. A signed-in submitter must claim their own id; guests submit
-- with auth_user_id null.
drop policy if exists "anyone can submit a round" on public.golf_scores;
create policy "anyone can submit a round" on public.golf_scores
  for insert to anon, authenticated
  with check (auth_user_id is null or auth_user_id = auth.uid());

-- Deliberately NO update or delete policies: with RLS on, the absence of a
-- policy is the denial. Scores are immutable once posted.

-- The one query the client makes: best rounds for a course, ties broken by
-- who got there first.
create index if not exists golf_scores_course_strokes_idx
  on public.golf_scores (course_id, strokes asc, created_at asc);

create index if not exists golf_scores_created_at_idx
  on public.golf_scores (created_at desc);
