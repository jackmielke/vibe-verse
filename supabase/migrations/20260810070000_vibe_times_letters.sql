-- Letters to the editor.
--
-- The graffiti wall opened in July and had not a single line on it by
-- August, which the paper kept reporting, issue after issue, because it was
-- true and funny. It was also a diagnosis: the one place a visitor can write
-- into this world is a plywood board you have to walk up to inside a 3D
-- world. Most people who read the paper never stand in front of it.
--
-- So the paper takes letters. You write a line on /times, it lands here, and
-- the next morning's edition can print it under your name — and the same
-- line goes up on the wall in the plaza, so the thing you wrote exists in
-- the world as well as in the paper.
--
-- One table, because letters need three things the wall does not: an ip
-- hash to rate-limit by, a record of which issue printed them so no letter
-- runs twice, and a status so a letter can be dropped without deleting it.
create table if not exists public.vibe_times_letters (
  id           bigint generated always as identity primary key,
  author       text not null,
  body         text not null,
  -- Salted hash, never the address itself. It exists to answer "has this
  -- writer posted three times in the last minute", and nothing else.
  ip_hash      text,
  status       text not null default 'new'
                 check (status in ('new', 'printed', 'dropped')),
  printed_in   integer references public.vibe_times_issues (issue),
  created_at   timestamptz not null default now()
);

create index if not exists vibe_times_letters_unprinted_idx
  on public.vibe_times_letters (created_at desc)
  where status = 'new';

create index if not exists vibe_times_letters_throttle_idx
  on public.vibe_times_letters (ip_hash, created_at desc);

alter table public.vibe_times_letters enable row level security;

-- No policies at all, deliberately. Letters are written by the vibe-times
-- edge function with the service role, which bypasses RLS, and they are
-- read back by the same function when it writes an issue. Nothing about a
-- letter needs to be readable by the anon key before it is printed: the
-- unprinted pile is the one place an abusive line could sit in public view,
-- and the paper is what publishes, not the table.
