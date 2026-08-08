-- The Vibe Times, printed nightly instead of by hand.
--
-- The paper used to live in two static files in public/. That made it as
-- frequent as somebody remembering to write it, which is how issue №1 sat
-- on the front door from July into August. This table is the presses: the
-- `vibe-times` edge function writes one row per edition, a pg_cron job
-- pokes it every morning, and the site reads the latest row (falling back
-- to the static files if the network is having a day).
--
-- One row per calendar day, enforced by the unique constraint on
-- edition_date. That constraint is also the lock: the function claims the
-- day by inserting a 'writing' row BEFORE it calls the model, so two
-- simultaneous pokes cannot both pay for one.
create table if not exists public.vibe_times_issues (
  id           bigint generated always as identity primary key,
  issue        integer not null unique,
  edition_date date    not null unique,
  status       text    not null default 'writing'
                 check (status in ('writing', 'published', 'failed')),
  -- The issue itself, in the shape the /times page renders.
  payload      jsonb   not null default '{}'::jsonb,
  -- What the issue was written from: headlines fetched, feeds read,
  -- scores looked up. Kept so any claim in the paper can be traced back.
  sources      jsonb   not null default '[]'::jsonb,
  model        text,
  note         text,
  created_at   timestamptz not null default now(),
  published_at timestamptz
);

create index if not exists vibe_times_issues_date_idx
  on public.vibe_times_issues (edition_date desc);

alter table public.vibe_times_issues enable row level security;

-- A newspaper is meant to be read. Published issues are public; drafts
-- and failures are not, and nothing here is writable except by the
-- service role (which bypasses RLS), i.e. only by the edge function.
drop policy if exists "published issues are public" on public.vibe_times_issues;
create policy "published issues are public"
  on public.vibe_times_issues
  for select
  using (status = 'published');

-- The morning edition: 13:00 UTC, which is breakfast on the west coast.
-- No key in the header because the function does not need one — a POST
-- with today's issue already written is a no-op, so the worst a stranger
-- can do by calling it is nothing at all.
select cron.schedule(
  'vibe-times-daily',
  '0 13 * * *',
  $cron$
  select net.http_post(
    url := 'https://efdqqnubowgwsnwvlalp.supabase.co/functions/v1/vibe-times',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"trigger": "cron"}'::jsonb,
    timeout_milliseconds := 170000
  );
  $cron$
);
