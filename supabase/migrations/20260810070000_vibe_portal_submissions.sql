-- The submission desk: how a game gets into the portal without knowing Jack.
--
-- `20260809080000_vibe_portal.sql` built the fence — four budgets, a sandboxed
-- frame, a session id that never crosses it — and left one line in a comment:
--
--     "It is on, because today the only way in is a migration; flip this when
--      the submit form lands."
--
-- This is the submit form landing. The fence does not change. What changes is
-- who is allowed to walk up to it, and that turns out to be everybody, because
-- the fence was the hard part and it was already built.
--
-- ---------------------------------------------------------------------------
-- Two doors, one field
-- ---------------------------------------------------------------------------
--
-- Somebody pastes a link. It is one of two things and we work out which:
--
--   * **hosted** — `https://their-game.lovable.app`. Their server, their
--     uptime, their deploys. We store the URL and the origin and frame it.
--     Nothing is copied. If they ship a change, the change is live, because
--     there was never a copy to go stale.
--
--   * **github** — `https://github.com/owner/repo`. There is no server, so we
--     become one: the static files are copied out of the repo at one exact
--     commit and served from our storage bucket. That copy is what gets
--     framed.
--
-- The github door is the interesting one, and the reason it is worth the extra
-- machinery is that it is the only door an eight-year-old can walk through. A
-- kid with a repo full of HTML has no deploy, no domain and no hosting bill.
-- Pasting the repo link is a thing they can actually do.
--
-- ---------------------------------------------------------------------------
-- Why a pinned commit and a copy, rather than just proxying the repo
-- ---------------------------------------------------------------------------
--
-- Three reasons, in the order they will bite:
--
--   1. **A commit is a thing you can approve.** "This repo" is not reviewable
--      — it changes under you. `owner/repo@3f9a1c2` is a fixed set of bytes
--      that a person looked at. A new commit is a new decision, made by
--      `resync`, not something that happens to the arcade overnight.
--   2. **Raw GitHub will not serve a game.** `raw.githubusercontent.com` sends
--      `text/plain` for everything, so the browser renders the HTML as source.
--      Somebody has to serve real content types, and that somebody is us.
--   3. **The repo can vanish.** Deleted, renamed, made private, force-pushed.
--      A copy keeps a game that people play from disappearing because its
--      author tidied up.
--
-- The copy lives in a public bucket, which means every mirrored game is served
-- from `<project>.supabase.co` — one origin, shared by all of them. Said
-- plainly, because a security note that overclaims is worse than none:
--
--   * That origin is NOT ours. Our app runs somewhere else, and the Supabase
--     session lives in localStorage on the app's origin, not on this one. A
--     mirrored game gets no token, no session, no wallet — the same nothing a
--     game on `itch.io` gets. The wall in `src/portal/host.ts` is intact.
--   * Mirrored games do, however, share that origin with *each other*. Game A
--     can read the localStorage game B wrote. What is in there is high scores.
--     The fix if that ever matters is a bucket per game on its own subdomain,
--     and it is not worth it for high scores today.
--   * The bucket is public read and service-role write. A submitter never
--     touches storage; the edge function copies bytes on their behalf, from an
--     allowlist of extensions, under a size cap.
--
-- ---------------------------------------------------------------------------
-- Why there is still a human in the loop
-- ---------------------------------------------------------------------------
--
-- The budgets answer "what is the most this game can cost us today". They do
-- not answer "is this a game". Nothing in a daily coin ceiling stops somebody
-- framing a hate site in the arcade, so approval stays, and it stays a person.
--
-- What changed is that approving is now one click on a game you have already
-- played, because the copy happens at submit time. By the time a row reaches
-- the queue the files are mirrored, the entry point is known, and there is a
-- URL an admin can open. Approval is a status flip and four numbers — no
-- network, no build, no deploy.

-- ---------------------------------------------------------------------------
-- The submissions
-- ---------------------------------------------------------------------------

create table if not exists public.vibe_portal_submissions (
  id                uuid primary key default gen_random_uuid(),

  -- Exactly what was pasted, before we interpreted it. Kept verbatim so a
  -- failed resolution can be debugged against the thing the human typed
  -- rather than against our guess at what they meant.
  submitted_url     text not null,
  kind              text not null check (kind in ('github', 'hosted')),

  -- Who. Sign-in is required to submit: attribution is half the point, and an
  -- anonymous submit form is a spam funnel that also cannot be rate limited.
  submitter_id      uuid references public.users(id) on delete set null,
  -- What they want to be called on the card, if not their account name.
  submitter_label   text,

  -- ---- what we resolved -------------------------------------------------
  -- All nullable: a submission that failed to resolve is still a row, because
  -- "we could not find an index.html in that repo" is a thing the submitter
  -- needs to be told, and a row is how they get told.
  slug              text,
  title             text,
  tagline           text,
  author            text,
  author_url        text,

  -- ---- github only ------------------------------------------------------
  repo              text,   -- owner/name, as GitHub spells it
  repo_ref          text,   -- the branch we track for `resync`
  repo_sha          text,   -- the commit these bytes came from
  entry_path        text,   -- 'index.html', 'docs/index.html', …
  license           text,   -- SPDX id from GitHub, or null
  file_count        integer,
  total_bytes       bigint,

  -- ---- both -------------------------------------------------------------
  -- Where the frame will point. For github this is the mirrored copy; for
  -- hosted it is their own URL.
  embed_url         text,
  origin            text,

  -- Does any HTML in there reference our SDK? Not a gate — a game with no
  -- `vibeverse.js` is welcome, it simply cannot pay anybody, and saying so on
  -- the card is better than a player wondering why the counter never moves.
  uses_sdk          boolean not null default false,

  status            text not null default 'pending'
                      check (status in ('pending', 'approved', 'rejected', 'failed')),
  -- Why it failed, or why it was turned down. Shown to the submitter, so it
  -- is written for them and not for us.
  status_note       text,

  -- The four ceilings an admin picked. Null until reviewed; the review path
  -- fills them in and copies them onto the game row.
  -- Same ranges as `vibe_portal_games`, so review never picks a number the
  -- games table will refuse. "This game cannot pay" is said by `uses_sdk`,
  -- not by a zero.
  max_award         integer check (max_award      between 1 and 500),
  session_budget    integer check (session_budget between 1 and 2000),
  player_daily      integer check (player_daily   between 1 and 5000),
  daily_budget      integer check (daily_budget   between 1 and 100000),

  reviewed_by       uuid references public.users(id) on delete set null,
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists vibe_portal_submissions_status_idx
  on public.vibe_portal_submissions (status, created_at desc);
create index if not exists vibe_portal_submissions_submitter_idx
  on public.vibe_portal_submissions (submitter_id, created_at desc);

alter table public.vibe_portal_submissions enable row level security;

grant select on public.vibe_portal_submissions to authenticated;
grant all    on public.vibe_portal_submissions to service_role;

-- Read your own, always — including the failures, which are the ones you most
-- need to see.
drop policy if exists "submitters read own portal submissions"
  on public.vibe_portal_submissions;
create policy "submitters read own portal submissions"
  on public.vibe_portal_submissions for select
  to authenticated
  using (submitter_id = public.get_user_id_from_auth(auth.uid()));

drop policy if exists "admins read all portal submissions"
  on public.vibe_portal_submissions;
create policy "admins read all portal submissions"
  on public.vibe_portal_submissions for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

-- No insert, update or delete policy, deliberately — the same shape as
-- `vibe_portal_games`. Submitting goes through `vibe-portal-submit`, which
-- holds the service-role key, because resolving a repo means talking to
-- GitHub and copying bytes, and neither is something a browser should be
-- trusted to report the result of. A submitter who could INSERT could write
-- their own `embed_url` and `origin`, which is the whole approval decision.

comment on table public.vibe_portal_submissions is
  'Games people have offered to the portal. Written only by vibe-portal-submit; readable by the submitter and by admins.';
comment on column public.vibe_portal_submissions.repo_sha is
  'The exact commit the mirrored bytes came from. A new commit needs an explicit resync — the arcade does not change under a player.';
comment on column public.vibe_portal_submissions.uses_sdk is
  'Whether any mirrored HTML references vibeverse.js. Informational: a game without it is playable and simply cannot pay.';

-- ---------------------------------------------------------------------------
-- What a game remembers about where it came from
-- ---------------------------------------------------------------------------

alter table public.vibe_portal_games
  add column if not exists source_kind   text not null default 'manual'
    check (source_kind in ('manual', 'hosted', 'github')),
  add column if not exists submission_id uuid references public.vibe_portal_submissions(id) on delete set null,
  add column if not exists repo          text,
  add column if not exists repo_ref      text,
  add column if not exists repo_sha      text,
  add column if not exists entry_path    text,
  -- `<slug>/<sha>/` inside the bucket. Kept rather than recomputed so a
  -- resync can delete exactly what it replaced.
  add column if not exists mirror_prefix text,
  add column if not exists mirrored_at   timestamptz,
  add column if not exists uses_sdk      boolean not null default false;

comment on column public.vibe_portal_games.source_kind is
  'manual = added by a migration; hosted = a URL somebody submitted; github = a commit we mirrored.';
comment on column public.vibe_portal_games.mirror_prefix is
  'Path prefix inside the portal-games bucket for a mirrored game, `<slug>/<sha>/`. Null for hosted and manual games.';

-- The line the original migration asked for. A game arriving through the form
-- is off until somebody says otherwise; the review path turns it on in the
-- same statement that sets its budgets. Rows written by a migration — there is
-- one, Coin Drop — set `active` explicitly and are unaffected.
alter table public.vibe_portal_games alter column active set default false;

comment on column public.vibe_portal_games.active is
  'Off by default: anybody can submit, so nothing is live until a person turns it on. Set explicitly by the review path and by migrations.';

-- `uses_sdk` defaults to false, which is the right default for a column that
-- exists to answer "did we find vibeverse.js in there" — and the wrong answer
-- for the one row that predates the question. Coin Drop is built on the SDK;
-- without this it would be labelled "just for fun" on its own play page.
update public.vibe_portal_games set uses_sdk = true where slug = 'coin-drop';

-- ---------------------------------------------------------------------------
-- Where mirrored games live
-- ---------------------------------------------------------------------------
--
-- Public read, service-role write. `file_size_limit` is the per-object
-- backstop under the caps the function already applies; it is here as well
-- because a limit enforced only in application code is a limit that lasts
-- until the next refactor.
insert into storage.buckets (id, name, public, file_size_limit)
values ('portal-games', 'portal-games', true, 8388608)
on conflict (id) do update
  set public = true, file_size_limit = 8388608;
